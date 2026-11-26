// The composition: the watcher's assembly, as the daemon runs it
// (PRJ-540) — the config read, the REST client and the reads built over
// it, the forge source, the projection's afterPass, the kernel with the
// legacy legs, and the cleanup. Everything the in-process composer did,
// minus the tool registration: the tools stay in the opencode plugin
// (the credential-free proxy) and reach this composition through the
// daemon's route, so no forge credential ever needs to be in an
// opencode process.
//
// The legacy legs ride here: the PagerDuty source (PRJ-426, pagerduty.ts)
// and the Linear source (PRJ-475, linear.ts) poll the same pass through
// the kernel's legacy legs — not yet migrated to the source contract
// (later slices) — writing their own row families through the kernel's
// stamp machinery, exactly as they did before the kernel existed.

import {
  createWatcherKernel,
  isRecord,
  patchStamps,
  readStamps,
} from "../kernel.ts";
import { forgeClient } from "../forge-client.ts";
import { debugOf, forgejoReady } from "../config.ts";
import { ForgejoSource } from "../forgejo-source.ts";
// The Slack source: the watcher's third source on the kernel's source
// contract (the forge source first, github second — the forge source's
// registration shape, not a legacy leg): a session subscribes to a
// channel by watcher_register (kind "slack-channel"), each watch's
// delivered markers — keyed by message ts — are its cursor, and every
// message that arrives on the channel after the watch wakes the
// subscriber once, content, sender, and timestamp in the wake.
import {
  readConfig as readSlackConfig,
  slackReads,
  SlackSource,
} from "../slack.ts";
// The GitHub source: the watcher's second source on the kernel contract
// (github.ts) — tool-registered kinds (github-pr, github-issue) whose
// watches ride the registering session's stamp, the forge source's
// registration shape.
import { GitHubSource } from "../github.ts";
import { createProjectionSync } from "../projection-sync.ts";
import { PagerDutySource } from "../pagerduty.ts";
import { LinearSource } from "../linear.ts";

// The job-log read's byte budget: the client tails the lines it keeps
// locally besides.
const LOG_TAIL_BYTES = 2048;

export const composeWatcher = async ({
  ctx,
  disposeTools,
}: {
  ctx: unknown;
  /**
   * The tool registration's dispose, when a caller (the test harness)
   * wants it inside the cleanup's step order: the kernel's steps run
   * first, then this step (named "tool registration" in the log), then
   * the projection's close — today's order, kept.
   */
  disposeTools?: () => unknown;
}) => {
  // The forge source's config first: a missing base url or token, or a
  // bad poll cadence, is fatal here — the daemon main exits named, the
  // unit says so, and the session-side tools answer that the daemon is
  // off. (The source's ready says the same without throwing; the
  // exit-on-misconfig is today's plugin-level throw, kept for the
  // daemon where the failure is loud in systemd.)
  const watcherOptions =
    ctx &&
    isRecord((ctx as Record<string, unknown>).options) &&
    isRecord((ctx as Record<string, unknown>).options.watcher)
      ? (ctx as Record<string, unknown>).options.watcher
      : {};
  const ready = forgejoReady(watcherOptions);
  if (!ready.ok) throw new Error(ready.reason);
  const config = ready.config;
  const debug = debugOf();
  debug("daemon.start", {
    pollMs: config.pollMs,
    forge: config.forge.url,
  });
  // The REST client is stateless and built once: no connection phase, no
  // session to hold or clean up — a read that fails says so through its
  // own site's discipline and the next pass retries.
  const forge = forgeClient(config.forge);

  // The REST reads, one per forge surface. Each answers through zod at
  // the boundary (parsePullList and the entities' schemas in the
  // projection's modules; parseRunRows here) and throws named on a
  // failure — the route and the status, never the credential.

  const prListPage = (owner, name, page, limit) =>
    forge.get(`/repos/${owner}/${name}/pulls`, {
      // The open set, verified live 2026-11-18 against the deployed
      // route (x-total-count answers the open set, not every PR ever):
      // the walk's budget scales with open PRs, not history.
      state: "open",
      page,
      limit,
    });

  const prRecord = (owner, name, index) =>
    forge.get(`/repos/${owner}/${name}/pulls/${index}`);

  const reviewsOf = (owner, name, index, limit) =>
    forge.get(`/repos/${owner}/${name}/pulls/${index}/reviews`, { limit });

  const commitStatuses = (owner, name, sha, limit) =>
    forge.get(`/repos/${owner}/${name}/commits/${sha}/statuses`, { limit });

  const branchesOf = (owner, name, page, limit) =>
    forge.get(`/repos/${owner}/${name}/branches`, { page, limit });

  const runsOfHead = (owner, name, headSha, limit) =>
    forge.get(`/repos/${owner}/${name}/actions/runs`, {
      head_sha: headSha,
      limit,
    });

  const runRecord = (owner, name, runId) =>
    forge.get(`/repos/${owner}/${name}/actions/runs/${runId}`);

  const runJobs = (owner, name, runId) =>
    forge.get(`/repos/${owner}/${name}/actions/runs/${runId}/jobs`);

  const jobLog = (owner, name, runId, jobId) =>
    forge.getLog(
      `/repos/${owner}/${name}/actions/runs/${runId}/jobs/${jobId}/logs`,
      { max_bytes: LOG_TAIL_BYTES },
    );

  // The source, over those reads.
  const source = new ForgejoSource(
    {
      prRecord,
      reviewsOf,
      runsOfHead,
      runRecord,
      runJobs,
      jobLog,
      branchesOf,
    },
    debug,
  );

  // The Slack source: built beside the forge source when the config's
  // slack block is present — the linear leg's opt-in pattern (an absent
  // block is silent; a block that cannot be served has said why on its
  // named line, and the other sources carry on alone). It registers
  // through the kernel's source contract, so its watches ride the same
  // registry and tool surface as the forge's.
  const slackConfig = readSlackConfig(watcherOptions);
  const slackSource = slackConfig
    ? new SlackSource({ reads: slackReads(slackConfig), debug })
    : null;

  // The GitHub source: built beside the forge source when the config's
  // github block is present (the source is opt-in; the absence is
  // silent, linear's rule). A block the config read cannot serve — no
  // token, an unusable url — is said once by the kernel's ready gate on
  // the source's named line and the other sources carry on alone; a
  // daemon without the block never sees the source at all.
  const githubSource = isRecord(watcherOptions.github)
    ? new GitHubSource({ debug })
    : null;

  // The projection sync: its own module holds the db holder, the
  // open-PR walk, and the per-repo sync; its afterPass stage rides the
  // kernel's pass below.
  const projectionSync = createProjectionSync({
    reads: { prListPage, prRecord, reviewsOf, commitStatuses },
    debug,
    dbPath: config.dbPath,
    getKernel: () => kernel,
  });
  // The kernel: the poll pass, the registry, the adoption walk, the
  // delivery discipline. The projection rides the pass's after-stage,
  // sharing the memo; the PagerDuty source rides as a legacy leg until
  // its migration onto the contract (a later slice).
  let pagerduty: PagerDutySource | null = null;
  let linear: LinearSource | null = null;
  const kernel = createWatcherKernel({
    ctx,
    debug,
    pollMs: config.pollMs,
    config: watcherOptions,
    sources: [
      source,
      ...(slackSource ? [slackSource] : []),
      ...(githubSource ? [githubSource] : []),
    ],
    legs: [
      {
        id: "pagerduty",
        poll: async () => {
          if (pagerduty) await pagerduty.poll();
        },
      },
      {
        id: "linear",
        poll: async () => {
          if (linear) await linear.poll();
        },
      },
    ],
    afterPass: projectionSync.afterPass,
  });
  // The PagerDuty source: built beside the forge client, polling the
  // same pass through the kernel's legacy leg. A config the source
  // cannot serve (no token, no watchable services, an unusable url)
  // reads null and the forge watches carry on alone; readConfig has
  // already said why on its named line. The stamp machinery is the
  // kernel's own, passed in, not forked.
  const pagerdutyConfig = PagerDutySource.readConfig(ctx);
  if (pagerdutyConfig) {
    pagerduty = new PagerDutySource({
      config: pagerdutyConfig,
      ctx,
      debug,
      patchStamps,
      readStamps,
      isStopped: kernel.isStopped,
      failedWrites: kernel.failedWrites,
    });
  }

  // The Linear source: built beside the PagerDuty leg, polling the same
  // pass through its kernel leg. A config the source cannot serve (no
  // token, no watchable projects, an unusable url) reads null and the
  // other sources carry on alone; readConfig has already said why on
  // its named line. The stamp machinery is the kernel's own, passed in,
  // not forked.
  const linearConfig = LinearSource.readConfig(ctx);
  if (linearConfig) {
    linear = new LinearSource({
      config: linearConfig,
      ctx,
      debug,
      patchStamps,
      readStamps,
      isStopped: kernel.isStopped,
      failedWrites: kernel.failedWrites,
    });
  }

  // OpenCode's plugin contract awaited the returned cleanup; the daemon
  // main awaits it on shutdown the same way. The kernel's steps run
  // first (timer, event subscription, the poll-pass wait, stopped),
  // each even when the one before throws; then the caller's tool
  // dispose when one was handed in; then this file's own steps.
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[forgejo-watcher] cleanup: ${name} failed: ${error}`);
    }
  };
  return {
    kernel,
    debug,
    projectionSync,
    cleanup: async () => {
      await kernel.cleanup();
      if (disposeTools) await step("tool registration", disposeTools);
      await step("projection", () => projectionSync.close());
    },
  };
};
