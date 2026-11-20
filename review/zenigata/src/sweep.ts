/**
 * The retention sweep (PRJ-382): review and reply work a run left
 * standing — its opencode session and the per-PR review worktree — is
 * retired here once the journal record's finished stamp is older than
 * the retention window. The journal is the source of truth for both the
 * candidates and their age, so pre-restart records are covered for free;
 * scanning the file at each pass, with no index, is the whole mechanism.
 * Every step is bounded by the cleanup timeout shape the run's old
 * finally block used and idempotent — work already gone is a logged
 * no-op — and one step's failure never stops the pass.
 */

import { stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { canonicalCloneDir, removeReviewWorktree } from "./canonical-clone.js";
import type { Clock, Logger } from "./ctx.js";
import type { SessionDriver } from "./contracts/session.js";
import { journalPath, walkJournal, type JournalLine } from "./journal.js";
import { withTimeout } from "./with-timeout.js";

/**
 * Per-step bound, the same shape the settled run's cleanup used: a sweep
 * step abandons a hung session or worktree operation at this bound and
 * moves on to the next candidate.
 */
export const SWEEP_STEP_TIMEOUT_MS = 15_000;

/** The sweep timer's cadence: one pass an hour, plus one at boot. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SweepSummary {
  /** Sessions the pass disposed. */
  disposed: number;
  /** Worktree directories the pass removed. */
  removed: number;
  /** Candidates still inside the window. */
  kept: number;
  /** Steps that found the work already gone: the idempotent no-op. */
  noops: number;
  /** Steps that failed past their bound; each carries its log line. */
  failed: number;
}

export interface Sweeper {
  /**
   * One pass over the journal. The boot pass is fed the server's own
   * boot walk (`lines`) so the boot pays for one read; later passes
   * re-scan the file.
   */
  sweepOnce(lines?: JournalLine[]): Promise<SweepSummary>;
}

/**
 * opencode answers `session.remove` for an already-removed session with
 * the protocol's SessionNotFoundError ("Session not found: <id>"); the
 * client may carry it as that message or as the 404 status, per
 * @opencode/protocol. A second pass over a swept record is exactly that
 * case: the logged no-op the sweep's idempotency contract asks for, not
 * a failure. A driver whose error surfaces neither signal (an SDK that
 * drops the body, say) degrades safely into a logged failure — the work
 * is still gone, and the next pass repeats it.
 *
 * The status page's transcript view (PRJ-461's transcript scope) reads
 * through the same driver and classifies its read failures with the
 * same answer: a session the sweep disposed reads as the swept note,
 * not a failure. Exported for that caller.
 */
export const isSessionAlreadyGone = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /session not found/i.test(message);
};

export function createSweeper(deps: {
  config: Config;
  sessions: SessionDriver;
  logger: Logger;
  clock: Clock;
  /**
   * Called when a pass's session step reports the session gone —
   * disposed here, or found already gone. The status page's transcript
   * cache (server.ts) binds this: the disposal is the one moment the
   * composed view can change, so the entry drops and the next page
   * view re-reads.
   */
  onSessionGone?: (sessionId: string) => void;
}): Sweeper {
  const { config, sessions, logger, clock, onSessionGone } = deps;

  const disposeSession = async (
    sessionId: string,
    repo: string,
    pr: number,
  ): Promise<"done" | "noop" | "failed"> => {
    try {
      await withTimeout(sessions.dispose(sessionId), SWEEP_STEP_TIMEOUT_MS);
      logger.info(
        `retention sweep: disposed the expired session ${sessionId} (${repo}#${pr})`,
      );
      onSessionGone?.(sessionId);
      return "done";
    } catch (error) {
      if (isSessionAlreadyGone(error)) {
        logger.info(
          `retention sweep: session ${sessionId} (${repo}#${pr}) is already gone; skipping`,
        );
        onSessionGone?.(sessionId);
        return "noop";
      }
      logger.error(
        `retention sweep: disposing the expired session ${sessionId} (${repo}#${pr}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "failed";
    }
  };

  const removeWorktree = async (
    worktreeDir: string,
    repo: string,
    pr: number,
  ): Promise<"done" | "noop" | "failed"> => {
    // An absent directory is the logged no-op: a second pass over a
    // swept record finds nothing to do. The presence check also keeps
    // the pass's count honest (nothing was removed twice).
    const present = await stat(worktreeDir).then(
      () => true,
      () => false,
    );
    if (!present) {
      logger.info(
        `retention sweep: worktree ${worktreeDir} (${repo}#${pr}) is already gone; skipping`,
      );
      return "noop";
    }
    try {
      await withTimeout(
        removeReviewWorktree({
          worktreesDir: config.worktreesDir,
          worktreeDir,
          canonicalCloneDir: canonicalCloneDir(config.stateDir, repo),
        }),
        SWEEP_STEP_TIMEOUT_MS,
      );
      logger.info(
        `retention sweep: removed the expired review worktree for ${repo}#${pr} (${worktreeDir})`,
      );
      return "done";
    } catch (error) {
      logger.error(
        `retention sweep: removing the expired worktree for ${repo}#${pr} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "failed";
    }
  };

  return {
    async sweepOnce(lines?: JournalLine[]): Promise<SweepSummary> {
      const summary: SweepSummary = {
        disposed: 0,
        removed: 0,
        kept: 0,
        noops: 0,
        failed: 0,
      };
      const walked =
        lines ?? (await walkJournal(journalPath(config.stateDir), logger));
      const now = clock.now();
      for (const { label, value } of walked) {
        const probe = value as {
          type?: unknown;
          repo?: unknown;
          pr?: unknown;
          sessionId?: unknown;
          worktreeDir?: unknown;
          finishedAt?: unknown;
        };
        const sessionId =
          typeof probe.sessionId === "string" ? probe.sessionId : undefined;
        const worktreeDir =
          typeof probe.worktreeDir === "string" ? probe.worktreeDir : undefined;
        if (sessionId === undefined && worktreeDir === undefined) {
          // Starts, refusals, window-0 records, and anything written
          // before this retention carried no work past the run; the
          // projection and the index consume some of those lines and
          // the sweep passes all of them untouched.
          continue;
        }
        const finishedAtMs =
          typeof probe.finishedAt === "string"
            ? Date.parse(probe.finishedAt)
            : Number.NaN;
        if (Number.isNaN(finishedAtMs)) {
          // A record naming work but carrying no comparable settle
          // moment cannot be clocked against the window; say so and
          // leave it standing rather than guessing an age for it.
          logger.error(
            `${label} skipped: a retained-work record carries no finished stamp`,
          );
          summary.failed += 1;
          continue;
        }
        if (typeof probe.repo !== "string" || typeof probe.pr !== "number") {
          // Every record the runs write for retained work names the
          // repo#pr the log line and the canonical clone need; a line
          // without them would be a corrupted record, not a candidate.
          logger.error(
            `${label} skipped: a retained-work record carries no repo#pr`,
          );
          summary.failed += 1;
          continue;
        }
        const repo = probe.repo as string;
        const pr = probe.pr as number;
        if (now - finishedAtMs < config.retentionWindowSeconds * 1000) {
          summary.kept += 1;
          continue;
        }
        if (sessionId !== undefined) {
          const step = await disposeSession(sessionId, repo, pr);
          if (step === "done") {
            summary.disposed += 1;
          } else if (step === "noop") {
            summary.noops += 1;
          } else {
            summary.failed += 1;
          }
        }
        if (worktreeDir !== undefined) {
          const step = await removeWorktree(worktreeDir, repo, pr);
          if (step === "done") {
            summary.removed += 1;
          } else if (step === "noop") {
            summary.noops += 1;
          } else {
            // The directory may still stand; the next pass retries it.
            summary.failed += 1;
          }
        }
      }
      return summary;
    },
  };
}
