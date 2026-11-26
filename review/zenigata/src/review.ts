/**
 * The review pipeline: guards, a per-PR git worktree (kept past the run
 * for the retention sweep, PRJ-382), one prompt through the SessionDriver,
 * status bookkeeping, and the failure/abort paths. The reviewer session
 * runs its own skill flow — review-pr, then humanizer — and posts the
 * review itself with the forge tools the deployment passes it (review
 * 665); the pipeline dispatches and records. runReview is exported pure
 * enough to drive from tests; startServer wires it into the intake.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Ctx } from "./ctx.js";
import { TimedOutError } from "./errors.js";
import {
  addReviewWorktree,
  ensureCanonicalClone,
  fetchCanonicalClone,
  pruneCanonicalWorktrees,
  removeReviewWorktree,
  canonicalCloneDir,
} from "./canonical-clone.js";
import { redactSecrets } from "./redact.js";
import { withTimeout } from "./with-timeout.js";
import type {
  ForgeEvent,
  InlineComment,
  PostedReview,
  Verdict,
} from "./contracts/forge.js";
import {
  appendJournal,
  journalPath,
  type PhaseTiming,
  type ReviewRecord,
} from "./journal.js";
import { outputHead } from "./review/validate.js";

const execFileAsync = promisify(execFile);

/** Bounds so a finally block and the bookkeeping never await unbounded work. */
const CLEANUP_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 30_000;

export interface RunSummary {
  outcome: ReviewRecord["outcome"];
  verdict?: Verdict;
  inlineComments: number;
  headSha?: string;
  phases: PhaseTiming[];
  failure?: { stage: string; message: string };
}

/** Guard failure: no session, no review, outcome skipped. */
class GuardSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardSkip";
  }
}

type ReviewRequestedEvent = Extract<ForgeEvent, { kind: "review_requested" }>;

// ---------------------------------------------------------------------------
// Git helpers — execFile with argv arrays only; repo-controlled strings are
// never passed through a shell.
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    const detail = err.stderr?.trim() ?? err.message;
    // The args carry the adapter's credentialed cloneUrl and git's stderr
    // echoes it; redact before truncating or the slice can cut a URL
    // mid-userinfo, where no pattern matches any more.
    throw new Error(
      redactSecrets(`git ${args.join(" ")} failed: ${detail}`).slice(0, 500),
    );
  }
}

const slugifyRepo = (repo: string): string => repo.replace(/\//g, "-");

/**
 * Worktree directory name for one review: the slug plus a hash of the raw
 * repo string. Slugging collapses "acme/widget" and a repo literally named
 * "acme-widget" to the same name; the hash keeps them on distinct paths.
 */
export function worktreeDirName(repo: string, pr: number): string {
  const hash = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  return `${slugifyRepo(repo)}-${pr}-${hash}`;
}

/** Schemes a clone URL may use; anything else is refused. */
const CLONE_SCHEMES = new Set(["https", "http", "ssh", "git", "file"]);

// `file` stays on the list because the test fixtures clone from bare
// file:// URLs; the adapter contract composes credentials for https/ssh.

/**
 * Parse and allowlist the clone URL. `ext::` and other transports run
 * arbitrary local commands, so only the schemes above get through.
 */
function parseCloneUrl(cloneUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    // The raw cloneUrl may itself be credentialed; redact before the
    // message reaches the journal record, the logs, and any error reply.
    throw new Error(
      redactSecrets(`cloneUrl ${cloneUrl} is not an absolute URL`),
    );
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (!CLONE_SCHEMES.has(scheme)) {
    throw new Error(`cloneUrl scheme ${parsed.protocol} is not allowed`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The prompt and the status contract
// ---------------------------------------------------------------------------

/**
 * The one driving prompt: the ask, the material the harness holds, and
 * the status contract. The session runs its own skill flow — review-pr,
 * then humanizer — computes the diff in the worktree it sits in, reads
 * what else it needs with the forge tools the deployment passes it, and
 * posts the review itself (review 665). The pipeline stages nothing
 * beyond this.
 */
function reviewPrompt(input: {
  persona: string;
  repo: string;
  pr: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  title: string;
  body: string;
  recalls: Array<{ content: string; source: string }>;
}): string {
  const recalled =
    input.recalls.length === 0
      ? "(no stored corrections)"
      : input.recalls.map((r) => `- [${r.source}] ${r.content}`).join("\n");
  return `${input.persona}

Review pull request ${input.repo}#${input.pr} and post the review
yourself, with the forge tools you have. Head ${input.headRef} @ ${input.headSha}, base ${input.baseRef}.

Title: ${input.title}
Body:
${input.body}

Corrections previously stored for this repository:
${recalled}

End your final reply with exactly one status line and nothing after it —
"review-status: posted" once the review is on the pull request,
"review-status: failed" if it is not.`;
}

/**
 * The status contract's read side: the final reply's last non-empty line
 * is the run's outcome for the runs table. Anything else — no line, a
 * reworded one — leaves the outcome unrecorded, and the run fails with
 * the reply's head in the failure record; a re-prompt would re-run the
 * whole review, so none is sent.
 */
function parseStatusReply(reply: string): "posted" | "failed" | undefined {
  const lines = reply.split("\n").reverse();
  const last = lines.find((l) => l.trim() !== "");
  const line = last?.trim() ?? "";
  if (line === "review-status: posted") return "posted";
  if (line === "review-status: failed") return "failed";
  return undefined;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

interface RunState {
  phases: PhaseTiming[];
  sessionId?: string;
  worktreeDir?: string;
  verdict?: Verdict;
  inlineComments: number;
  outcome: ReviewRecord["outcome"];
  failure?: { stage: string; message: string };
  headSha?: string;
  /** What the session posted, filled by the bookkeeping lookup. */
  body?: string;
  comments?: InlineComment[];
  posted?: PostedReview;
}

// The pipeline's trigger lives on the contract: runReview takes a forge
// review re-request, the whole trigger surface.
export async function runReview(
  ctx: Ctx,
  event: ReviewRequestedEvent,
): Promise<RunSummary> {
  const { config, forge, sessions, memory, logger, clock, metrics, persona } =
    ctx;
  const state: RunState = {
    phases: [],
    inlineComments: 0,
    outcome: "failed",
  };
  let currentStage = "intake";

  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = clock.now();
    currentStage = name;
    ctx.tracker.markStage(event.eventId, name);
    try {
      return await fn();
    } finally {
      const durationMs = clock.now() - started;
      state.phases.push({ phase: name, durationMs });
      // A cancelled run already settled elsewhere: the abandoned body's
      // phase durations would distort the histogram, so only the journal
      // record keeps them (via the phases push above).
      if (!cancelled) {
        metrics.observe(
          "zenigata_review_phase_seconds",
          { phase: name },
          durationMs / 1000,
        );
      }
    }
  };

  const startedAt = clock.now();
  const deadline = startedAt + config.reviewTimeoutSeconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  // Set the moment the deadline fires. The race abandons the body but
  // does not stop it, so every stage after intake checks this flag at its
  // entry: a timed-out run creates no clone, no session, and no prompt.
  // A failed or timed-out run records itself and reaches for nothing —
  // the journal is the failure surface, and the review the session may
  // have posted is on the forge regardless.
  let cancelled = false;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        cancelled = true;
        controller.abort();
        reject(new TimedOutError(currentStage));
      },
      Math.max(1, deadline - clock.now()),
    );
  });

  /**
   * Bookkeeping's one read: ask the adapter what the session posted for
   * this (repo, pr, head). The runs table and the reply index want the
   * review's landed shape — verdict, comment refs, body — and the
   * adapter is the read surface for what actually landed. Bounded twice
   * — the signal aborts the fetch at 30s and the race gives up at 30s —
   * so a hung adapter cannot wedge the run. A lookup that fails or finds
   * nothing leaves the record thin (outcome stands as the status line
   * said it; the reply index goes unfilled for that review).
   */
  const lookupPostedReview = async (): Promise<boolean> => {
    try {
      const found = await withTimeout(
        forge.getPostedReview(event.repo, event.pr, state.headSha ?? "", {
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        }),
        LOOKUP_TIMEOUT_MS,
      );
      if (found === null) {
        return false;
      }
      state.posted = {
        reviewCommentId: found.reviewCommentId,
        commentRefs: found.commentRefs,
      };
      state.body = found.body;
      state.comments = found.comments;
      state.verdict = found.verdict;
      state.inlineComments = found.comments.length;
      return true;
    } catch (error) {
      logger.error(
        `the bookkeeping lookup for ${event.repo}#${event.pr} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };

  const body = async (): Promise<void> => {
    // Guards.
    const shape = await stage("intake", async () => {
      if (
        !config.allowedLogins.some(
          (login) => login.toLowerCase() === event.requesterLogin.toLowerCase(),
        )
      ) {
        throw new GuardSkip(
          `requester ${event.requesterLogin} is not in the allowed logins`,
        );
      }
      const fetched = await forge.getPullRequest(event.repo, event.pr);
      if (fetched.isFork) {
        throw new GuardSkip(`PR ${event.repo}#${event.pr} is from a fork`);
      }
      if (
        config.allowedRepos.length > 0 &&
        !config.allowedRepos.includes(event.repo)
      ) {
        throw new GuardSkip(
          `repository ${event.repo} is not in the allowed repos`,
        );
      }
      state.headSha = fetched.headSha;
      return fetched;
    });

    // Git stage: ensure the persistent canonical clone, fetch the requested
    // refs into it, and build a disposable per-PR worktree at the head SHA.
    // Every ref-controlled value is validated before git runs: the argv must
    // never gain an option.
    const { dir } = await stage("git", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      if (shape.headRef.startsWith("-") || shape.baseRef.startsWith("-")) {
        throw new Error(
          `ref name looks like a git option (head ${shape.headRef}, base ${shape.baseRef})`,
        );
      }
      if (!/^[0-9a-fA-F]{40}$/.test(shape.headSha)) {
        throw new Error(`head SHA ${shape.headSha} is not a 40-hex commit id`);
      }
      // Validation only: the URL itself reaches git, not this parsed value.
      parseCloneUrl(shape.cloneUrl);
      const worktreeDir = `${config.worktreesDir}/${worktreeDirName(event.repo, event.pr)}`;
      state.worktreeDir = worktreeDir;
      await mkdir(config.worktreesDir, { recursive: true });
      await rm(worktreeDir, { recursive: true, force: true });
      const cloneDir = await ensureCanonicalClone({
        stateDir: config.stateDir,
        repo: event.repo,
        cloneUrl: shape.cloneUrl,
      });
      // The "--" ends option parsing: a ref name can never become an
      // option again. Fetch with the credentialed URL so the canonical clone
      // stays current without relying on a persisted remote URL.
      await fetchCanonicalClone({
        dir: cloneDir,
        cloneUrl: shape.cloneUrl,
        refs: [shape.headRef, shape.baseRef],
      });
      // A registration for this path can survive the rm above: a run
      // that died between add and cleanup, a failed install, or a manual
      // state-dir tidy leaves the clone holding an entry whose directory
      // is gone, and `worktree add` then refuses the path. Prune first so
      // the stale case needs no recovery attempt; if the add still fails,
      // deregister through the cleanup helper and retry the add exactly
      // once. A failure after that surfaces as any stage failure does.
      await pruneCanonicalWorktrees({ canonicalCloneDir: cloneDir });
      try {
        await addReviewWorktree({
          canonicalCloneDir: cloneDir,
          worktreeDir,
          sha: shape.headSha,
        });
      } catch (error) {
        logger.info(
          `the review worktree add for ${event.repo}#${event.pr} failed; deregistering and retrying once: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await removeReviewWorktree({
          worktreesDir: config.worktreesDir,
          worktreeDir,
          canonicalCloneDir: cloneDir,
        });
        await addReviewWorktree({
          canonicalCloneDir: cloneDir,
          worktreeDir,
          sha: shape.headSha,
        });
      }
      const checkedOut = (
        await git(["rev-parse", "HEAD"], { cwd: worktreeDir })
      ).trim();
      if (checkedOut !== shape.headSha) {
        throw new Error(
          `checked-out SHA ${checkedOut} does not match requested ${shape.headSha}`,
        );
      }
      return { dir: worktreeDir };
    });

    // Review stage: one prompt, the session's own skill flow, and its
    // posting. The session ends its reply with the status line the
    // bookkeeping stage records.
    let finalReply: string | undefined;
    await stage("review", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      state.sessionId = await sessions.createSession(dir, config.agent, {
        signal: controller.signal,
      });
      // The live row carries the session id from here on (PRJ-538): the
      // status page reads the session's turn-by-turn log through the
      // driver with it while the run runs.
      ctx.tracker.markSession(event.eventId, state.sessionId);
      // Recall is advisory: stored corrections improve the review, and a
      // memory outage must not fail it. Scope by cwd (the review's
      // worktree checkout) so read and write resolve the same workspace
      // through the daemon's resolver.
      const recalls = await memory
        .recall("review corrections", { cwd: dir })
        .catch((error: unknown) => {
          logger.error(
            `memory recall failed, continuing without stored corrections: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        });
      await sessions.prompt(
        state.sessionId,
        reviewPrompt({
          persona,
          repo: event.repo,
          pr: event.pr,
          headRef: shape.headRef,
          baseRef: shape.baseRef,
          headSha: shape.headSha,
          title: shape.title,
          body: shape.body,
          recalls,
        }),
        { signal: controller.signal },
      );
      finalReply = await sessions.readOutput(state.sessionId, {
        signal: controller.signal,
      });
    });

    // Bookkeeping stage: the status line is the run's outcome; the
    // adapter lookup fills the record with what actually landed, so the
    // runs table and the reply index keep their shape.
    await stage("bookkeeping", async () => {
      if (finalReply === undefined) {
        throw new Error("the session produced no reply");
      }
      const status = parseStatusReply(finalReply);
      if (status === undefined) {
        throw new Error(
          `the final reply carried no review-status line: ${JSON.stringify(outputHead(finalReply))}`,
        );
      }
      if (status === "posted") {
        const found = await lookupPostedReview();
        state.outcome = "posted";
        if (!found) {
          logger.info(
            `bookkeeping for ${event.repo}#${event.pr}: the session reported posted and no landed review matched (repo, pr, head); the record stays thin and the reply index goes unfilled`,
          );
        }
        return;
      }
      throw new Error("the session reported the review failed");
    });
  };

  try {
    // The race abandons the body on timeout, but the body keeps running.
    // Attach a no-op catch as a second handler so the abandoned body's
    // eventual rejection (the bookkeeping stage's refusal, a late error)
    // never surfaces as an unhandled rejection and crashes the process;
    // the race below still sees the body's rejection while it is live,
    // and the surviving failure path has already journaled the run.
    const bodyPromise = body();
    bodyPromise.catch(() => {});
    try {
      await Promise.race([bodyPromise, timeout]);
    } catch (error) {
      if (error instanceof GuardSkip) {
        state.outcome = "skipped";
        logger.info(`skipped ${event.repo}#${event.pr}: ${error.message}`);
      } else {
        const stageName =
          error instanceof TimedOutError ? error.stage : currentStage;
        const message = error instanceof Error ? error.message : String(error);
        state.outcome = "failed";
        state.failure = { stage: stageName, message };
        logger.error(
          `review failed for ${event.repo}#${event.pr} in ${stageName}: ${message}`,
        );
        // A failed run records itself and reaches for nothing: the
        // journal (with the stage and the failure message) is the
        // operator surface, and the review the session may have posted
        // is on the forge regardless.
        logger.info(
          `failed run for ${event.repo}#${event.pr}; the journal record is the record`,
        );
      }
    }

    const record = reviewRecord(
      event,
      state,
      startedAt,
      config.retentionWindowSeconds > 0,
      clock.now(),
    );
    // The retry policy's run counter must see this run whether it settled
    // in this process or after a restart: the live index counts it here
    // (under the event's identity), and loadIndex counts it from the
    // journal at the next boot.
    ctx.index.recordRun({
      repo: event.repo,
      pr: event.pr,
      eventId: event.eventId,
      outcome: state.outcome,
    });
    // Keep the reply index current before the journal append: a reply may
    // target this review's comments moments after the forge post, and the
    // index must already know them. Everything here is settlement
    // bookkeeping: a failure (an index or journal write the disk refuses,
    // a metrics family typo) must settle the run, not crash the process.
    if (
      state.outcome === "posted" &&
      state.posted !== undefined &&
      state.comments !== undefined
    ) {
      try {
        ctx.index.addPosted({
          repo: event.repo,
          pr: event.pr,
          reviewId: record.reviewId,
          body: state.body ?? "",
          comments: state.comments,
          posted: state.posted,
        });
      } catch (error) {
        logger.error(
          `indexing the posted review failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      await appendJournal(journalPath(config.stateDir), record);
    } catch (error) {
      logger.error(
        `appending the review record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The projection row follows the journal line at the same lifecycle
    // point; the write logs and moves on when it fails.
    ctx.statusDb.apply(record, "the review record");
    try {
      metrics.inc("zenigata_reviews_total", {
        repo: event.repo,
        status: state.outcome,
      });
    } catch (error) {
      logger.error(
        `counting the review failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      outcome: state.outcome,
      verdict: state.verdict,
      inlineComments: state.inlineComments,
      headSha: state.headSha,
      phases: state.phases,
      failure: state.failure,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // PRJ-382: with the retention window on, the run leaves its session
    // and worktree standing and hands them to the sweep through the
    // journal record (it carries their ids and the finished stamp), which
    // retires them once they are older than the window. At window 0,
    // today's immediate teardown applies: neither cleanup step may await
    // unbounded work, so each races a 15s timeout and logs-and-moves-on
    // when it fires. The abandoned promise's eventual rejection is
    // handled by the race above.
    if (config.retentionWindowSeconds === 0) {
      if (state.sessionId !== undefined) {
        try {
          await withTimeout(
            sessions.dispose(state.sessionId),
            CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          logger.error(
            `disposing the review session failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (state.worktreeDir !== undefined) {
        try {
          await withTimeout(
            removeReviewWorktree({
              worktreesDir: config.worktreesDir,
              worktreeDir: state.worktreeDir,
              canonicalCloneDir: canonicalCloneDir(config.stateDir, event.repo),
            }),
            CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          logger.error(
            `removing the worktree failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

function reviewRecord(
  event: ReviewRequestedEvent,
  state: RunState,
  startedAt: number,
  /** True when the retention window keeps the run's work past settle. */
  retain: boolean,
  finishedAtMs: number,
): ReviewRecord {
  const record: ReviewRecord = {
    ts: new Date(startedAt).toISOString(),
    type: "review",
    reviewId: randomUUID(),
    repo: event.repo,
    pr: event.pr,
    eventId: event.eventId,
    commentId: event.commentId,
    headSha: state.headSha,
    requester: event.requesterLogin,
    // A copy, not the live array: an abandoned body keeps pushing phase
    // timings after the record is built, and the recorded phases must
    // stay frozen at record time.
    phases: [...state.phases],
    verdict: state.verdict,
    inlineComments: state.inlineComments,
    outcome: state.outcome,
    failure: state.failure,
    body: state.body,
    comments: state.comments,
    posted: state.posted,
  };
  if (retain) {
    // PRJ-382: the retained work is the sweep's input, the stamp is its
    // clock compare. A run that never created a session or worktree
    // (a guard skip, a failure before the git stage) leaves its fields
    // unset; JSON drops them and the record never becomes a candidate.
    record.sessionId = state.sessionId;
    record.worktreeDir = state.worktreeDir;
    record.finishedAt = new Date(finishedAtMs).toISOString();
  }
  return record;
}

/**
 * Settle a review event that never ran: journal a `skipped` record and
 * count it. Used when the retry policy refuses a redelivered event; the
 * refusal is not a run, and its record must not count as one (the
 * index's run counter ignores skipped outcomes).
 */
export async function skipReview(
  ctx: Ctx,
  event: ReviewRequestedEvent,
  reason: string,
): Promise<{ outcome: ReviewRecord["outcome"] }> {
  const { config, logger, clock, metrics } = ctx;
  logger.info(`skipped review for ${event.repo}#${event.pr}: ${reason}`);
  const record: ReviewRecord = {
    ts: new Date(clock.now()).toISOString(),
    type: "review",
    reviewId: randomUUID(),
    repo: event.repo,
    pr: event.pr,
    eventId: event.eventId,
    commentId: event.commentId,
    requester: event.requesterLogin,
    phases: [],
    inlineComments: 0,
    humanizer: { changed: false },
    outcome: "skipped",
    failure: { stage: "intake", message: reason },
  };
  try {
    await appendJournal(journalPath(config.stateDir), record);
  } catch (error) {
    logger.error(
      `appending the skipped review record failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  ctx.statusDb.apply(record, "the skipped review record");
  try {
    metrics.inc("zenigata_reviews_total", {
      repo: event.repo,
      status: "skipped",
    });
  } catch (error) {
    logger.error(
      `counting the skipped review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { outcome: "skipped" };
}
