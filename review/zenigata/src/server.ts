/**
 * The intake server. The endpoints' auth and exposure contract lives in
 * the canonical table at the top of docs/deployment.md: the bearer-token
 * POST /v1/events intake (202 + background processing), the /metrics and
 * /healthz probes, and the read-only status surface — /status as JSON
 * (the pinned machine contract), / as the human page, both rendered from
 * src/status.ts's one projection. The human page adds four inputs the
 * JSON does not carry: each view probes the adapter (a plain, tokenless
 * fetch, bounded short) and renders the answer, the live sessions' rows
 * read with each run's started stamp (viewsWithStartedAt) — the ledger
 * data the running duration renders from, a page-only read /status never
 * serializes — the runs table reads its wall time from the settled rows'
 * stamps in the projection (recentRunsWithWallTime) — also a page-only
 * derivation — and the page renders that same projection's PR cells as
 * links into the forge, using the config's forge base URL: also page
 * rendering only, /status gains nothing.
 *
 * The completion-signal hook: startServer stores one promise per accepted
 * event and exposes awaitSettled(eventId). A processed event resolves
 * after the pipeline's journal record and metrics are written; a skipped
 * duplicate resolves immediately and writes no journal record. Tests
 * drive an event through ForgeEventSource.postToIntake and await that
 * promise.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeEvent } from "./contracts/forge.js";
import { ForgeEventSchema } from "./contracts/forge.js";
import {
  consoleLogger,
  systemClock,
  type Ctx,
  type Clock,
  type Logger,
} from "./ctx.js";
import {
  appendJournal,
  journalPath,
  indexFromJournal,
  walkJournal,
  type ReplyRecord,
  type ReviewRecord,
  type ReviewStartRecord,
} from "./journal.js";
import { Metrics } from "./metrics.js";
import { loadPersona } from "./persona.js";
import { redactSecrets } from "./redact.js";
import { runReply, skipReply } from "./replies.js";
import { runReview, skipReview } from "./review.js";
import { createStatusSource, LiveSessions } from "./status.js";
import { StatusDb, statusDbPath } from "./status-db.js";
import {
  SWEEP_INTERVAL_MS,
  createSweeper,
  type SweepSummary,
} from "./sweep.js";
import { renderStatusPage } from "./ui.js";
import type { Config } from "./config.js";
import type { MemoryGateway } from "./contracts/memory.js";
import type { ForgeAdapter } from "./contracts/forge.js";
import type { SessionDriver } from "./contracts/session.js";

type ReviewRequestedEvent = Extract<ForgeEvent, { kind: "review_requested" }>;
type ReplyEvent = Extract<ForgeEvent, { kind: "reply" }>;

/** Cap on the settled-event map; past it, the oldest entries are pruned. */
const MAX_SETTLED_ENTRIES = 500;

/** The intake refuses a body past this size with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** The body crossed MAX_BODY_BYTES and was not read to the end. */
class BodyTooLarge extends Error {}

/** How long the human page's adapter probe may wait for any HTTP answer. */
const ADAPTER_PROBE_TIMEOUT_MS = 1500;

/**
 * Whether the forge adapter answers at all: any HTTP response — even a
 * 404 — proves the service is reachable; DNS failure, refusal, TLS
 * failure, or a timeout answers no. The probe carries no Authorization
 * header of its own, is bounded short so a dead adapter costs the page
 * one bounded wait rather than a hung request, and never redirects off
 * the configured host.
 */
const probeAdapter = (adapterUrl: string): Promise<boolean> =>
  fetch(adapterUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(ADAPTER_PROBE_TIMEOUT_MS),
  })
    .then(() => true)
    .catch(() => false);

export interface ServerDeps {
  forge: ForgeAdapter;
  sessions: SessionDriver;
  memory: MemoryGateway;
  logger?: Logger;
  /**
   * Test seams for the two background chains: production callers leave
   * them unset and the imported pipelines run. A test forcing a pipeline
   * rejection exercises the intake's rejected-run surface — the
   * journaling catch on each chain — without staging a failure inside a
   * real pipeline run.
   */
  runReview?: typeof runReview;
  runReply?: typeof runReply;
  /**
   * Test seam for the retention sweep's window compare (PRJ-382):
   * production leaves it unset and the sweep reads the system clock. Only
   * the sweep binds to it — the run timing stays on the system clock — so
   * a frozen clock ahead of the runs' stamps ages finished work past the
   * window without moving anything else.
   */
  sweepClock?: Clock;
}

export interface ServerHandle {
  server: Server;
  /** The bound port (config.listenPort 0 resolves to the OS-assigned port). */
  port: number;
  /** Resolve when the accepted event's processing fully settles. */
  awaitSettled(eventId: string): Promise<{ repo: string; pr: number }>;
  /**
   * One retention-sweep pass over the journal on demand (the hourly timer
   * calls the same pass for the same sweeper); a test seam as much as a
   * handle surface.
   */
  sweep(): Promise<SweepSummary>;
  close(): Promise<void>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
}

function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare a dummy against itself to keep the branch timing flat.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      settle();
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming; the caller answers 413 first and drops the
        // socket only after the response is out.
        request.pause();
        finish(() => reject(new BodyTooLarge("body too large")));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      finish(() => resolve(Buffer.concat(chunks).toString("utf8"))),
    );
    request.on("error", (error) => finish(() => reject(error)));
    // A client that disconnects mid-body emits neither "end" nor "error":
    // only "close" fires, so the promise must settle there too or the
    // handler never responds.
    request.on("close", () =>
      finish(() =>
        reject(new Error("connection closed before the body was read")),
      ),
    );
  });
}

function respond(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

/** Cap on concurrent review runs; past it, further reviews queue. */
export const REVIEW_SLOTS = 3;

/**
 * Tiny counting semaphore: acquire waits in line once the limit is out,
 * release hands the slot to the next waiter. Queues, never rejects.
 */
class Semaphore {
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

export async function startServer(
  config: Config,
  deps: ServerDeps,
): Promise<ServerHandle> {
  const logger = deps.logger ?? consoleLogger;
  const reviewPipeline = deps.runReview ?? runReview;
  const replyPipeline = deps.runReply ?? runReply;
  /** Process start; the status surface's uptime anchors on this moment. */
  const startedAtMs = systemClock.now();

  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.worktreesDir, { recursive: true });
  const persona = await loadPersona(config);
  // One walk feeds both consumers of the boot journal: the posted-comment
  // index and the status surface's dropped-start view.
  const bootLines = await walkJournal(journalPath(config.stateDir), logger);
  const index = indexFromJournal(bootLines, logger);

  // The status projection opens before the server can accept an event, so
  // every write-through site finds it ready. An empty projection (a
  // missing or fresh status.db) syncs from the boot walk once; afterwards
  // the write-through keeps it current and the journal is audit only.
  const statusDb = new StatusDb({
    path: statusDbPath(config.stateDir),
    logger,
    clock: systemClock,
  });
  const backfilled = statusDb.backfill(bootLines);
  if (backfilled > 0) {
    logger.info(
      `the status db was empty; the boot backfill landed ${backfilled} rows from the journal`,
    );
  }

  const metrics = new Metrics();
  const liveSessions = new LiveSessions(systemClock);
  const ctx: Ctx = {
    config,
    forge: deps.forge,
    sessions: deps.sessions,
    memory: deps.memory,
    persona,
    metrics,
    logger,
    clock: systemClock,
    index,
    tracker: liveSessions,
    statusDb,
  };

  // The retention sweeper (PRJ-382): retired work, its window compare on
  // the injected-or-system clock. The boot pass reuses this boot's walk —
  // the walked lines are the pre-restart candidates — and the hourly
  // timer re-scans the file.
  const sweeper = createSweeper({
    config,
    sessions: deps.sessions,
    logger,
    clock: deps.sweepClock ?? systemClock,
  });
  const bootSweep = sweeper.sweepOnce(bootLines).catch((error) => {
    // The per-record work above never throws; only the walk can. The
    // empty summary keeps the boot's await trivially settled and the
    // hourly pass retries the whole file.
    logger.error(
      `the boot retention sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const empty: SweepSummary = {
      disposed: 0,
      removed: 0,
      kept: 0,
      noops: 0,
      failed: 0,
    };
    return empty;
  });

  /** Reviews in flight by repo#pr; a duplicate intake is logged and skipped. */
  const inFlight = new Set<string>();
  /** One promise per accepted event, for tests and shutdown bookkeeping. */
  const settled = new Map<string, Promise<{ repo: string; pr: number }>>();
  /** Event ids whose promise has settled; pruning evicts these first. */
  const settledIds = new Set<string>();

  /**
   * Past the cap, evict settled entries oldest-first (insertion order);
   * pending entries are never evicted, because dropping one would lose
   * the completion signal for running work. The map can therefore sit
   * above the cap while work is in flight, and that excess is temporary —
   * the semaphores bound the in-flight work. A settled id is deleted
   * together with its entry, so the id set cannot outlive its map entry.
   */
  const pruneSettled = (): void => {
    for (const [eventId] of settled) {
      if (settled.size <= MAX_SETTLED_ENTRIES) {
        return;
      }
      if (settledIds.has(eventId)) {
        settled.delete(eventId);
        settledIds.delete(eventId);
      }
    }
  };

  const trackSettled = (
    eventId: string,
    work: Promise<{ repo: string; pr: number }>,
  ): void => {
    // Entries stay in the map after settling: a fast-settling event (a
    // skipped duplicate, say) must still be awaitable when the caller
    // gets around to it. Pruning past the cap above keeps the map bounded.
    settled.set(eventId, work);
    // Marking settled in both branches: the second handler swallows the
    // rejection for the marker only; awaitSettled still sees the original
    // promise's rejection.
    void work.then(
      () => {
        settledIds.add(eventId);
        pruneSettled();
      },
      () => {
        settledIds.add(eventId);
        pruneSettled();
      },
    );
    pruneSettled();
  };

  /** Review fan-out is capped; extra reviews queue in arrival order. */
  const reviewLimiter = new Semaphore(REVIEW_SLOTS);

  /**
   * The retry policy's gate: an event the journal already ran is refused
   * in the default configuration (`retryPolicy: "never"`), so a
   * redelivered failure cannot silently re-fire a paid review run.
   * `once` allows one automatic re-run, and only of a failed event. The
   * gate keys on the event's identity (the journal's forge delivery id),
   * so a re-request or a fresh @review comment — each a fresh delivery —
   * always runs, and only a replay of a spent delivery is gated.
   */
  const retryRefused = (
    event: Extract<ForgeEvent, { kind: "review_requested" }>,
  ): string | undefined => {
    const counts = index.eventRuns(event.repo, event.pr, event.eventId);
    if (config.retryPolicy === "never") {
      if (counts.runs > 0) {
        return `the event already ran (retry policy ${config.retryPolicy}); refusing the redelivery`;
      }
      return undefined;
    }
    // retryPolicy === "once": one automatic retry of a failed event.
    if (counts.posted > 0 || counts.aborted > 0 || counts.failed > 1) {
      return `the event already ran (retry policy ${config.retryPolicy}); refusing a further redelivery`;
    }
    return undefined;
  };

  /**
   * The accepted-start trail: the event was accepted and enqueued, so the
   * journal gains a start record now, before the run can go anywhere, and
   * the status surface's live row accepts the same record. The record is
   * deliberately the distinct `review-start` type, not a run outcome: the
   * PRJ-330 redelivery-refusal gate counts only ran/settled records, and
   * a start a bot restart dropped must leave the event free to re-run
   * (nothing was spent).
   */
  const journalReviewStart = (event: ReviewRequestedEvent): void => {
    // One accept moment: the journal record and the live row share it.
    const acceptedAtMs = ctx.clock.now();
    const record: ReviewStartRecord = {
      ts: new Date(acceptedAtMs).toISOString(),
      type: "review-start",
      eventId: event.eventId,
      repo: event.repo,
      pr: event.pr,
      commentId: event.commentId,
      eventKind: event.kind,
    };
    liveSessions.accept(event, record, acceptedAtMs);
    // The projection row opens at the same lifecycle point the journal
    // line does — /status reads it, never the journal. The write logs and
    // moves on when it fails, never throwing.
    ctx.statusDb.apply(record, "the accepted-start record");
    void appendJournal(journalPath(ctx.config.stateDir), record).catch(
      (error) => {
        logger.error(
          `appending the accepted-start record failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  };

  /**
   * The rejected-run surface for both chains, replacing the empty catch
   * they used to swallow their rejections into. A chain rejection means
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
  const journalFailedRun = (
    event: ReviewRequestedEvent | ReplyEvent,
    error: unknown,
  ): void => {
    const chain = event.kind === "review_requested" ? "review" : "reply";
    void (async () => {
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      const base = {
        ts: new Date(ctx.clock.now()).toISOString(),
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
      logger.error(
        `${chain} run for ${event.repo}#${event.pr} failed before/at a pipeline phase: ${message}`,
      );
      try {
        if (event.kind === "review_requested") {
          // Counts for the retry gate exactly like a settled failed run;
          // replies participate in no gate.
          ctx.index.recordRun({
            repo: event.repo,
            pr: event.pr,
            eventId: event.eventId,
            outcome: "failed",
          });
        }
      } catch (countError) {
        logger.error(
          `counting the failed ${chain} run failed: ${
            countError instanceof Error
              ? countError.message
              : String(countError)
          }`,
        );
      }
      try {
        if (event.kind === "review_requested") {
          metrics.inc("zenigata_reviews_total", {
            repo: event.repo,
            status: "failed",
          });
        } else {
          metrics.inc("zenigata_replies_total", { repo: event.repo });
        }
      } catch (countError) {
        logger.error(
          `counting the failed ${chain} metric failed: ${
            countError instanceof Error
              ? countError.message
              : String(countError)
          }`,
        );
      }
      try {
        await appendJournal(journalPath(ctx.config.stateDir), record);
      } catch (writeError) {
        logger.error(
          `appending the failed ${chain} record failed: ${
            writeError instanceof Error
              ? writeError.message
              : String(writeError)
          }`,
        );
      }
      // The chain's failed run settles in the projection too; the write
      // carries its own log-and-move-on contract.
      ctx.statusDb.apply(record, `the failed-run ${chain} record`);
    })().catch((thrown) => {
      console.error(
        `zenigata: journaling the failed ${chain} run threw: ${redactSecrets(
          thrown instanceof Error ? thrown.message : String(thrown),
        )}`,
      );
    });
  };

  const processReview = (event: ReviewRequestedEvent): void => {
    const key = `${event.repo}#${event.pr}`;
    if (inFlight.has(key)) {
      logger.info(
        `duplicate review for ${key} is already in flight; skipping ${event.eventId}`,
      );
      trackSettled(
        event.eventId,
        Promise.resolve({ repo: event.repo, pr: event.pr }),
      );
      return;
    }
    const refusal = retryRefused(event);
    if (refusal !== undefined) {
      trackSettled(
        event.eventId,
        skipReview(ctx, event, refusal).then(() => ({
          repo: event.repo,
          pr: event.pr,
        })),
      );
      return;
    }
    inFlight.add(key);
    journalReviewStart(event);
    const work = reviewLimiter
      .run(() => reviewPipeline(ctx, event))
      .then(() => ({ repo: event.repo, pr: event.pr }))
      .finally(() => {
        inFlight.delete(key);
        // The run settled; its journal record is the only truth now.
        liveSessions.release(event.eventId);
      });
    // The catch journals the failed run (the pipeline never reached its
    // own settlement record) and logs it loud; the rejection itself still
    // flows to the settled map, so awaitSettled sees it.
    work.catch((error) => {
      journalFailedRun(event, error);
    });
    trackSettled(event.eventId, work);
  };

  /** Reply fan-out is capped; extra replies queue in arrival order. */
  const replyLimiter = new Semaphore(4);
  /** Bound on the reply queue itself; past it, a reply skips. */
  const MAX_REPLY_WAITERS = 100;
  /** Replies in flight by repo#pr#inReplyTo; a replayed event is skipped. */
  const replyInFlight = new Set<string>();

  const processReply = (event: ReplyEvent): void => {
    const key = `${event.repo}#${event.pr}#${event.inReplyTo}`;
    if (replyInFlight.has(key)) {
      logger.info(
        `duplicate reply for ${key} is already in flight; skipping ${event.eventId}`,
      );
      trackSettled(
        event.eventId,
        Promise.resolve({ repo: event.repo, pr: event.pr }),
      );
      return;
    }
    if (replyLimiter.pending >= MAX_REPLY_WAITERS) {
      // The journal write settles the event promise, so a failed append
      // still settles (skipReply logs it instead of rejecting).
      trackSettled(
        event.eventId,
        skipReply(ctx, event, "the reply queue is full").then(() => ({
          repo: event.repo,
          pr: event.pr,
        })),
      );
      return;
    }
    replyInFlight.add(key);
    const work = replyLimiter
      .run(() => replyPipeline(ctx, event))
      .then(() => ({ repo: event.repo, pr: event.pr }))
      .finally(() => {
        replyInFlight.delete(key);
      });
    // The review chain's rejection surface, twin for replies. The
    // rejection itself still flows to the settled map.
    work.catch((error) => {
      journalFailedRun(event, error);
    });
    trackSettled(event.eventId, work);
  };

  const handleIntake = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const token = bearerToken(request);
    if (token === undefined || !tokenEquals(token, config.eventToken)) {
      respond(response, 401, "unauthorized");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        // The 413 goes out first; the socket drops after the response has
        // flushed, or the client never sees the refusal.
        respond(response, 413, "body too large");
        response.on("finish", () => request.destroy());
        return;
      }
      respond(response, 400, "invalid event");
      return;
    }
    const event = ForgeEventSchema.safeParse(parsed);
    if (!event.success) {
      respond(response, 400, "invalid event");
      return;
    }
    respond(response, 202, "accepted");
    if (event.data.kind === "review_requested") {
      processReview(event.data);
    } else {
      processReply(event.data);
    }
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = request.url ?? "";
        if (
          request.method === "POST" &&
          (url === "/v1/events" || url.startsWith("/v1/events?"))
        ) {
          await handleIntake(request, response);
        } else if (
          request.method === "GET" &&
          (url === "/metrics" || url.startsWith("/metrics?"))
        ) {
          respond(
            response,
            200,
            metrics.render(),
            "text/plain; version=0.0.4; charset=utf-8",
          );
        } else if (
          request.method === "GET" &&
          (url === "/healthz" || url.startsWith("/healthz?"))
        ) {
          respond(response, 200, "ok");
        } else if (
          request.method === "GET" &&
          (url === "/status" || url.startsWith("/status?"))
        ) {
          respond(
            response,
            200,
            JSON.stringify(await status.snapshot()),
            "application/json; charset=utf-8",
          );
        } else if (
          request.method === "GET" &&
          (url === "/" || url.startsWith("/?"))
        ) {
          const [snapshot, adapterReachable] = await Promise.all([
            status.snapshot(),
            probeAdapter(config.adapterUrl),
          ]);
          respond(
            response,
            200,
            renderStatusPage(
              snapshot,
              adapterReachable,
              // The page's live rows, read from the ledger with each
              // run's started stamp: the running duration renders from
              // it, and /status's pinned shape gains nothing.
              liveSessions.viewsWithStartedAt(),
              // The page's run rows, read straight from the projection
              // with each settled run's wall time; /status never carries it.
              statusDb.recentRunsWithWallTime(),
              // The PR cells' links ride the same page-only rule: the
              // forge's base URL renders the links and the re-request
              // affordance; /status's pinned shape gains nothing.
              config.forgeUrl,
            ),
            "text/html; charset=utf-8",
          );
        } else {
          respond(response, 404, "not found");
        }
      } catch (error) {
        logger.error(
          `request handler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!response.headersSent) {
          respond(response, 500, "internal error");
        } else {
          response.end();
        }
      }
    })();
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : port;
        resolve(bound);
      });
    });

  const port = await listen(config.listenPort);
  const status = createStatusSource({
    config,
    clock: systemClock,
    logger,
    port,
    startedAtMs,
    live: liveSessions,
    acceptedThisBoot: (eventId) => settled.has(eventId),
    statusDb,
    bootLines,
  });
  // One boot pass settles before the handle is handed out: pre-restart
  // work is retired (or kept, inside the window) before the first intake
  // arrives. The hourly pass re-scans the journal; the timer rides the
  // server's lifetime and stops with close().
  await bootSweep;
  const sweepTimer = setInterval(() => {
    void sweeper
      .sweepOnce()
      .then((summary) => {
        if (summary.disposed > 0 || summary.removed > 0) {
          logger.info(
            `the retention sweep retired ${summary.disposed} session(s) and ${summary.removed} worktree(s)`,
          );
        }
      })
      .catch((error) => {
        logger.error(
          `the retention sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  logger.info(
    `intake listening on port ${port} (state dir ${config.stateDir})`,
  );

  return {
    server,
    port,
    awaitSettled: (eventId) => {
      const work = settled.get(eventId);
      if (work === undefined) {
        return Promise.reject(
          new Error(`no accepted event ${eventId} is in flight`),
        );
      }
      return work;
    },
    sweep: () => sweeper.sweepOnce(),
    close: async () => {
      clearInterval(sweepTimer);
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        // The projection's file handle goes with the server, even on a
        // failed server close: reads and writes after this log instead of
        // touching a closed database.
        statusDb.close();
      }
    },
  };
}
