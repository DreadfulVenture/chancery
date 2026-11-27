/**
 * The intake server's composition root: load the boot world (journals,
 * persona, projection, metrics, the live-session ledger, the sweeper),
 * wire the pipeline and the HTTP routes, and start the hono server.
 *
 * The endpoints' auth and exposure contract lives in the canonical table
 * at the top of docs/deployment.md: the bearer-token POST /v1/events
 * intake (202 + background processing), the /metrics and /healthz
 * probes, and the read-only status surface — /status as JSON (the pinned
 * machine contract), / as the human page, both rendered from
 * src/status.ts's one projection.
 *
 * The completion-signal hook: the pipeline stores one promise per
 * accepted event and exposes awaitSettled(eventId) through the handle. A
 * processed event resolves after the pipeline's journal record and
 * metrics are written; a skipped duplicate resolves immediately and
 * writes no journal record. Tests drive an event through
 * ForgeEventSource.postToIntake and await that promise.
 */

import { mkdir } from "node:fs/promises";
import {
  narratingLogger,
  consoleLogger,
  systemClock,
  type Ctx,
} from "./ctx.js";
import { LogRing } from "./log-ring.js";
import { Metrics } from "./metrics.js";
import { loadPersona } from "./persona.js";
import {
  appendJournal,
  indexFromJournal,
  journalPath,
  walkJournal,
} from "./journal.js";
import { createStatusSource, LiveSessions } from "./status.js";
import { StatusDb, statusDbPath } from "./status-db.js";
import {
  SWEEP_INTERVAL_MS,
  createSweeper,
  type SweepSummary,
} from "./sweep.js";
import { EventPipeline } from "./pipeline.js";
import { IntakeServer } from "./http/app.js";
import { SurfaceRoute } from "./http/surface.js";
import type { Server } from "node:http";
import type { Config } from "./config.js";
import type { MemoryGateway } from "./contracts/memory.js";
import type { ForgeAdapter } from "./contracts/forge.js";
import type { Clock, Logger } from "./ctx.js";
import type { SessionDriver } from "./contracts/session.js";
import { runReview } from "./review.js";
import { runReply } from "./replies.js";

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
  /**
   * The narration ring the human page's log tail renders from (PRJ-461).
   * Production callers leave it unset and the server owns one; index.ts
   * passes the same ring the memory gateway's logger feeds, so a
   * narration line emitted outside the server still reaches the page.
   * Every line pushed through it is redacted at capture.
   */
  logRing?: LogRing;
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

export async function startServer(
  config: Config,
  deps: ServerDeps,
): Promise<ServerHandle> {
  // One write path, two sinks (PRJ-461): every narration line the bot
  // logs goes to the console sink (stdout/stderr, journald's source) and
  // into the ring, redacted at capture, for the human page's log tail.
  const logRing = deps.logRing ?? new LogRing();
  const logger = narratingLogger(logRing, deps.logger ?? consoleLogger);
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

  const pipeline = new EventPipeline(
    ctx,
    liveSessions,
    logger,
    deps.runReview,
    deps.runReply,
  );

  const surface = new SurfaceRoute({
    statusDb,
    live: liveSessions,
    sessions: deps.sessions,
    metrics,
    logRing,
    forgeUrl: config.forgeUrl,
    adapterUrl: config.adapterUrl,
  });

  // The retention sweeper (PRJ-382): retired work, its window compare on
  // the injected-or-system clock. The boot pass reuses this boot's walk —
  // the walked lines are the pre-restart candidates — and the hourly
  // timer re-scans the file.
  const sweeper = createSweeper({
    config,
    sessions: deps.sessions,
    logger,
    clock: deps.sweepClock ?? systemClock,
    // The transcript cache's invalidation hand: the sweep reporting a
    // session gone is the one moment the composed view can change, so
    // the entry drops and the next page view re-reads (the gone note
    // lands instead of a stale transcript).
    onSessionGone: (sessionId) => {
      surface.invalidateTranscript(sessionId);
    },
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

  const server = new IntakeServer({ config, pipeline, surface, logger });

  const port = await server.listen(config.listenPort);
  const status = createStatusSource({
    config,
    clock: systemClock,
    logger,
    port,
    startedAtMs,
    live: liveSessions,
    acceptedThisBoot: (eventId) => pipeline.accepted(eventId),
    statusDb,
    bootLines,
  });
  surface.assignStatus(status);
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
    server: server.http,
    port,
    awaitSettled: (eventId) => pipeline.awaitSettled(eventId),
    sweep: () => sweeper.sweepOnce(),
    close: async () => {
      clearInterval(sweepTimer);
      try {
        await server.close();
      } finally {
        // The projection's file handle goes with the server, even on a
        // failed server close: reads and writes after this log instead of
        // touching a closed database.
        statusDb.close();
      }
    },
  };
}
