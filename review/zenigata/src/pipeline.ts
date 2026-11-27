/**
 * The event pipeline: the fan-out the intake dispatches into. Reviews and
 * replies each run under a semaphore cap, deduplicated by an in-flight
 * key; every accepted event's settlement is tracked so the completion
 * signal (awaitSettled) and the status source's boot accounting can read
 * it. A run whose pipeline rejected before its own settlement record
 * lands is journaled here (journalFailedRun), the run's only ledger
 * entry in that case.
 */

import { randomUUID } from "node:crypto";
import type { ForgeEvent } from "./contracts/forge.js";
import {
  appendJournal,
  journalPath,
  type ReplyRecord,
  type ReviewRecord,
  type ReviewStartRecord,
} from "./journal.js";
import { redactSecrets } from "./redact.js";
import { skipReply } from "./replies.js";
import { skipReview } from "./review.js";
import type { Ctx, Logger } from "./ctx.js";
import type { LiveSessions } from "./status.js";
import { runReview } from "./review.js";
import { runReply } from "./replies.js";

export type ReviewRequestedEvent = Extract<
  ForgeEvent,
  { kind: "review_requested" }
>;
export type ReplyEvent = Extract<ForgeEvent, { kind: "reply" }>;

/** Cap on concurrent review runs; past it, further reviews queue. */
export const REVIEW_SLOTS = 3;

/** Cap on concurrent reply runs; past it, further replies queue. */
export const REPLY_SLOTS = 4;

/** Bound on the reply queue itself; past it, a reply skips. */
export const MAX_REPLY_WAITERS = 100;

/** Cap on the settled-event map; past it, the oldest entries are pruned. */
const MAX_SETTLED_ENTRIES = 500;

/**
 * Tiny counting semaphore: acquire waits in line once the limit is out,
 * release hands the slot to the next waiter. Queues, never rejects.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // The slot transfers without a decrement.
      next();
    } else {
      this.active -= 1;
    }
  }

  /** Run fn under a slot, queued when the limit is out. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.acquire()
      .then(fn)
      .finally(() => this.release());
  }

  /** How many callers are queued waiting for a slot. */
  get pending(): number {
    return this.waiters.length;
  }
}

/**
 * One pipeline instance per intake server: the fan-out the routes
 * dispatch into. The context carries the journal, the projection, the
 * metrics, the live-session ledger, and the logger; the run functions
 * are injectable test seams.
 */
export class EventPipeline {
  private readonly reviewLimiter = new Semaphore(REVIEW_SLOTS);
  private readonly replyLimiter = new Semaphore(REPLY_SLOTS);
  /** Reviews in flight by repo#pr; a duplicate intake is logged and skipped. */
  private readonly reviewsInFlight = new Set<string>();
  /** Replies in flight by repo#pr#inReplyTo; a replayed event is skipped. */
  private readonly repliesInFlight = new Set<string>();
  /** One promise per accepted event, for tests and shutdown bookkeeping. */
  private readonly settled = new Map<
    string,
    Promise<{ repo: string; pr: number }>
  >();
  /** Event ids whose promise has settled; pruning evicts these first. */
  private readonly settledIds = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly live: LiveSessions,
    private readonly logger: Logger,
    private readonly reviewPipeline: typeof runReview = runReview,
    private readonly replyPipeline: typeof runReply = runReply,
  ) {}

  /** Whether this boot accepted an event with this id (the status source's gate). */
  accepted(eventId: string): boolean {
    return this.settled.has(eventId);
  }

  /** Resolve when the accepted event's processing fully settles. */
  awaitSettled(eventId: string): Promise<{ repo: string; pr: number }> {
    const work = this.settled.get(eventId);
    if (work === undefined) {
      return Promise.reject(
        new Error(`no accepted event ${eventId} is in flight`),
      );
    }
    return work;
  }

  /**
   * Past the cap, evict settled entries oldest-first (insertion order);
   * pending entries are never evicted, because dropping one would lose
   * the completion signal for running work. The map can therefore sit
   * above the cap while work is in flight, and that excess is temporary —
   * the semaphores bound the in-flight work. A settled id is deleted
   * together with its entry, so the id set cannot outlive its map entry.
   */
  private pruneSettled(): void {
    for (const [eventId] of this.settled) {
      if (this.settled.size <= MAX_SETTLED_ENTRIES) {
        return;
      }
      if (this.settledIds.has(eventId)) {
        this.settled.delete(eventId);
        this.settledIds.delete(eventId);
      }
    }
  }

  private trackSettled(
    eventId: string,
    work: Promise<{ repo: string; pr: number }>,
  ): void {
    // Entries stay in the map after settling: a fast-settling event (a
    // skipped duplicate, say) must still be awaitable when the caller
    // gets around to it. Pruning past the cap above keeps the map bounded.
    this.settled.set(eventId, work);
    // Marking settled in both branches: the second handler swallows the
    // rejection for the marker only; awaitSettled still sees the original
    // promise's rejection.
    void work.then(
      () => {
        this.settledIds.add(eventId);
        this.pruneSettled();
      },
      () => {
        this.settledIds.add(eventId);
        this.pruneSettled();
      },
    );
    this.pruneSettled();
  }

  /**
   * The retry policy's gate: an event the journal already ran is refused
   * in the default configuration (`retryPolicy: "never"`), so a
   * redelivered failure cannot silently re-fire a paid review run.
   * `once` allows one automatic re-run, and only of a failed event. The
   * gate keys on the event's identity (the journal's forge delivery id),
   * so a re-request — a fresh delivery — always runs, and only a replay
   * of a spent delivery is gated.
   */
  private retryRefused(event: ReviewRequestedEvent): string | undefined {
    const counts = this.ctx.index.eventRuns(
      event.repo,
      event.pr,
      event.eventId,
    );
    if (this.ctx.config.retryPolicy === "never") {
      if (counts.runs > 0) {
        return `the event already ran (retry policy ${this.ctx.config.retryPolicy}); refusing the redelivery`;
      }
      return undefined;
    }
    // retryPolicy === "once": one automatic retry of a failed event.
    if (counts.posted > 0 || counts.aborted > 0 || counts.failed > 1) {
      return `the event already ran (retry policy ${this.ctx.config.retryPolicy}); refusing a further redelivery`;
    }
    return undefined;
  }

  /**
   * The accepted-start trail: the event was accepted and enqueued, so the
   * journal gains a start record now, before the run can go anywhere, and
   * the status surface's live row accepts the same record. The record is
   * deliberately the distinct `review-start` type, not a run outcome: the
   * redelivery-refusal gate counts only ran/settled records, and a start
   * a bot restart dropped must leave the event free to re-run
   * (nothing was spent).
   */
  private journalReviewStart(event: ReviewRequestedEvent): void {
    // One accept moment: the journal record and the live row share it.
    const acceptedAtMs = this.ctx.clock.now();
    const record: ReviewStartRecord = {
      ts: new Date(acceptedAtMs).toISOString(),
      type: "review-start",
      eventId: event.eventId,
      repo: event.repo,
      pr: event.pr,
      commentId: event.commentId,
      eventKind: event.kind,
    };
    this.live.accept(event, record, acceptedAtMs);
    // The projection row opens at the same lifecycle point the journal
    // line does — /status reads it, never the journal. The write logs and
    // moves on when it fails, never throwing.
    this.ctx.statusDb.apply(record, "the accepted-start record");
    void appendJournal(journalPath(this.ctx.config.stateDir), record).catch(
      (error) => {
        this.logger.error(
          `appending the accepted-start record failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }

  /**
   * The rejected-run surface for both chains. A chain rejection means
   * the pipeline never journaled its own settlement record, so this is
   * the run's only ledger entry: journal a failed record — `stage:
   * "dispatch"` is the intake's own position on the chain (dispatched to
   * the pipeline, before whatever phase it rejected in) — count the
   * failed run the way the run's own path would have (the retry gate
   * counts reviews only), increment the metric the run never reached,
   * and name the error loud on the redaction path. The original work
   * rejection still flows to awaitSettled; this surface must never add
   * an unhandled rejection of its own, so every failing step logs and
   * moves on, falling back to console.error.
   */
  private journalFailedRun(
    event: ReviewRequestedEvent | ReplyEvent,
    error: unknown,
  ): void {
    const chain = event.kind === "review_requested" ? "review" : "reply";
    void (async () => {
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      const base = {
        ts: new Date(this.ctx.clock.now()).toISOString(),
        repo: event.repo,
        pr: event.pr,
        outcome: "failed" as const,
        failure: { stage: "dispatch", message },
      };
      const record: ReviewRecord | ReplyRecord =
        event.kind === "review_requested"
          ? {
              ...base,
              type: "review",
              reviewId: randomUUID(),
              eventId: event.eventId,
              commentId: event.commentId,
              requester: event.requesterLogin,
              phases: [],
              inlineComments: 0,
              humanizer: { changed: false },
            }
          : {
              ...base,
              type: "reply",
              author: event.authorLogin,
              inReplyTo: event.inReplyTo,
            };
      this.logger.error(
        `${chain} run for ${event.repo}#${event.pr} failed before/at a pipeline phase: ${message}`,
      );
      try {
        if (event.kind === "review_requested") {
          // Counts for the retry gate exactly like a settled failed run;
          // replies participate in no gate.
          this.ctx.index.recordRun({
            repo: event.repo,
            pr: event.pr,
            eventId: event.eventId,
            outcome: "failed",
          });
        }
      } catch (countError) {
        this.logger.error(
          `counting the failed ${chain} run failed: ${
            countError instanceof Error
              ? countError.message
              : String(countError)
          }`,
        );
      }
      try {
        if (event.kind === "review_requested") {
          this.ctx.metrics.inc("zenigata_reviews_total", {
            repo: event.repo,
            status: "failed",
          });
        } else {
          this.ctx.metrics.inc("zenigata_replies_total", { repo: event.repo });
        }
      } catch (countError) {
        this.logger.error(
          `counting the failed ${chain} metric failed: ${
            countError instanceof Error
              ? countError.message
              : String(countError)
          }`,
        );
      }
      try {
        await appendJournal(journalPath(this.ctx.config.stateDir), record);
      } catch (writeError) {
        this.logger.error(
          `appending the failed ${chain} record failed: ${
            writeError instanceof Error
              ? writeError.message
              : String(writeError)
          }`,
        );
      }
      // The chain's failed run settles in the projection too; the write
      // carries its own log-and-move-on contract.
      this.ctx.statusDb.apply(record, `the failed-run ${chain} record`);
    })().catch((thrown) => {
      console.error(
        `zenigata: journaling the failed ${chain} run threw: ${redactSecrets(
          thrown instanceof Error ? thrown.message : String(thrown),
        )}`,
      );
    });
  }

  processReview(event: ReviewRequestedEvent): void {
    const key = `${event.repo}#${event.pr}`;
    if (this.reviewsInFlight.has(key)) {
      this.logger.info(
        `duplicate review for ${key} is already in flight; skipping ${event.eventId}`,
      );
      this.trackSettled(
        event.eventId,
        Promise.resolve({ repo: event.repo, pr: event.pr }),
      );
      return;
    }
    const refusal = this.retryRefused(event);
    if (refusal !== undefined) {
      this.trackSettled(
        event.eventId,
        skipReview(this.ctx, event, refusal).then(() => ({
          repo: event.repo,
          pr: event.pr,
        })),
      );
      return;
    }
    this.reviewsInFlight.add(key);
    this.journalReviewStart(event);
    const work = this.reviewLimiter
      .run(() => this.reviewPipeline(this.ctx, event))
      .then(() => ({ repo: event.repo, pr: event.pr }))
      .finally(() => {
        this.reviewsInFlight.delete(key);
        // The run settled; its journal record is the only truth now.
        this.live.release(event.eventId);
      });
    // The catch journals the failed run (the pipeline never reached its
    // own settlement record) and logs it loud; the rejection itself still
    // flows to the settled map, so awaitSettled sees it.
    work.catch((error) => {
      this.journalFailedRun(event, error);
    });
    this.trackSettled(event.eventId, work);
  }

  processReply(event: ReplyEvent): void {
    const key = `${event.repo}#${event.pr}#${event.inReplyTo}`;
    if (this.repliesInFlight.has(key)) {
      this.logger.info(
        `duplicate reply for ${key} is already in flight; skipping ${event.eventId}`,
      );
      this.trackSettled(
        event.eventId,
        Promise.resolve({ repo: event.repo, pr: event.pr }),
      );
      return;
    }
    if (this.replyLimiter.pending >= MAX_REPLY_WAITERS) {
      // The journal write settles the event promise, so a failed append
      // still settles (skipReply logs it instead of rejecting).
      this.trackSettled(
        event.eventId,
        skipReply(this.ctx, event, "the reply queue is full").then(() => ({
          repo: event.repo,
          pr: event.pr,
        })),
      );
      return;
    }
    this.repliesInFlight.add(key);
    const work = this.replyLimiter
      .run(() => this.replyPipeline(this.ctx, event))
      .then(() => ({ repo: event.repo, pr: event.pr }))
      .finally(() => {
        this.repliesInFlight.delete(key);
      });
    // The review chain's rejection surface, twin for replies. The
    // rejection itself still flows to the settled map.
    work.catch((error) => {
      this.journalFailedRun(event, error);
    });
    this.trackSettled(event.eventId, work);
  }
}
