// The composer: the watcher's composition glue — the config read, the
// REST client and the reads built over it, the forge source, the
// projection's afterPass, the kernel with the legacy legs, the tool
// registration, and the cleanup — everything setup() did, in the same
// order. The plugin entry (index.ts) is the composer's caller.
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
} from "./kernel.ts";
import { forgeClient } from "./forge-client.ts";
import { debugOf, forgejoReady } from "./config.ts";
import { ForgejoSource } from "./forgejo-source.ts";
// The Slack source: the watcher's fourth source, and the first to
// register through the kernel's source contract rather than riding a
// legacy leg (the forge source's shape): a session subscribes to a
// channel by watcher_register (kind "slack-channel"), each watch's
// delivered markers — keyed by message ts — are its cursor, and every
// message that arrives on the channel after the watch wakes the
// subscriber once, content, sender, and timestamp in the wake.
import {
  readConfig as readSlackConfig,
  slackReads,
  SlackSource,
} from "./slack.ts";
// The GitHub source: the watcher's second source on the kernel contract
// (github.ts) — tool-registered kinds (github-pr, github-issue) whose
// watches ride the registering session's stamp, the forge source's
// registration shape.
import { GitHubSource } from "./github.ts";
import { createProjectionSync } from "./projection-sync.ts";
import { createTools } from "./tools.ts";
import { PagerDutySource } from "./pagerduty.ts";
import { LinearSource } from "./linear.ts";

// The job-log read's byte budget: the client tails the lines it keeps
// locally besides.
const LOG_TAIL_BYTES = 2048;

export const compose = async (ctx) => {
  // The forge source's config first: a missing base url or token, or a
  // bad poll cadence, disables the plugin at init — setup throws,
  // OpenCode logs it and runs the other plugins without this one. (The
  // source's ready says the same without throwing; the plugin-level
  // throw is today's behavior and keeps the forge source's failure
  // loud.)
  const watcherOptions =
    ctx?.options && isRecord(ctx.options) && isRecord(ctx.options.watcher)
      ? ctx.options.watcher
      : {};
  const ready = forgejoReady(watcherOptions);
  if (!ready.ok) throw new Error(ready.reason);
  const config = ready.config;
  const debug = debugOf();
  debug("plugin.start", {
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

  // The GitHub source: built beside the forge source when the operator
  // configured its block (options.watcher.github — the source is opt-in;
  // the absence is silent, linear's rule). A block the config read
  // cannot serve — no token, an unusable url — is said once by the
  // kernel's ready gate on the source's named line and the other sources
  // carry on alone; a watcher without the block never sees the source at
  // all.
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

  // The family's tool surface, over the kernel and the projection's db
  // holder.
  const { registerTool, listTool, forgetTool, stateTool } = createTools({
    ctx,
    kernel,
    debug,
    projectionDb: projectionSync.projectionDb,
  });
  // Strict plain-JSON-schema objects pass through the host's tool
  // converter untouched, so argument mistakes surface as tool errors
  // instead of crashes on undefined fields later.
  const registration = await ctx.tool.transform((editor) => {
    editor.add(registerTool);
    editor.add(listTool);
    editor.add(forgetTool);
    editor.add(stateTool);
  });

  // OpenCode awaits the returned cleanup (packages/plugin/src/promise/
  // adapter.ts, v2.0.29). The kernel's steps run first (timer, event
  // subscription, the poll-pass wait, stopped), each even when the one
  // before throws; then this file's own steps.
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[forgejo-watcher] cleanup: ${name} failed: ${error}`);
    }
  };
  return async () => {
    await kernel.cleanup();
    await step("tool registration", () => registration?.dispose?.());
    await step("projection", () => projectionSync.close());
  };
};
