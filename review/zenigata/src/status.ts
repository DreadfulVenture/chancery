/**
 * The read-only status surface's model. /status's JSON and the human
 * page at / render one projection built from the three sources the
 * process has, in this order of authority: the intake's in-process live
 * state (truth while the boot that made it runs), the status db (truth
 * across restarts; one sqlite projection the pipeline writes through
 * to), and the journal (the durability record, walked once at boot and
 * never again — no request reads it).
 */

import { z } from "zod";
import type { Clock, Logger, StageTracker } from "./ctx.js";
import type { ForgeEvent } from "./contracts/forge.js";
import type { Config } from "./config.js";
import type { JournalLine, ReviewStartRecord } from "./journal.js";
import type { StatusDb } from "./status-db.js";
import { redactSecrets } from "./redact.js";
import type {
  DroppedStartView,
  SessionStartView,
  SessionView,
  StatusData,
} from "./ui.js";

type ReviewRequestedEvent = Extract<ForgeEvent, { kind: "review_requested" }>;

// ---------------------------------------------------------------------------
// The live session model
// ---------------------------------------------------------------------------

/**
 * The status surface's stage sink and live list. One row per review event
 * this boot accepted and has not settled. The row carries the journaled
 * start record — the journal's own truth for repo, pull request, event
 * kind, comment, and accepted moment, composed once and shared with the
 * journal append — plus the fields the journal does not carry: the
 * requester, the pipeline's live stage, the last-activity moment, and
 * the moment the run left the queue (the first stage entry's stamp, a
 * page-render field the JSON contract never serializes). A settled run
 * leaves the list; the status db row is then its truth.
 */
export class LiveSessions implements StageTracker {
  private readonly rows = new Map<string, LiveSessionRow>();

  constructor(private readonly clock: Clock) {}

  /**
   * Register the accepted event: its journaled start record and the
   * accept moment, which the record's ts already is (the caller stamps
   * both from one `clock.now()` call).
   */
  accept(
    event: ReviewRequestedEvent,
    start: ReviewStartRecord,
    acceptedAtMs: number,
  ): void {
    this.rows.set(event.eventId, {
      start,
      requester: event.requesterLogin,
      stage: "queued",
      lastActivityAtMs: acceptedAtMs,
      startedAtMs: undefined,
    });
  }

  /**
   * The pipeline entered a stage: the row's live position follows it and
   * the last-activity moment moves. The first entry also stamps the
   * moment the run left the queue; later entries never move that stamp.
   */
  markStage(eventId: string, stage: string): void {
    const row = this.rows.get(eventId);
    if (row === undefined) {
      return;
    }
    const now = this.clock.now();
    row.stage = stage;
    row.lastActivityAtMs = now;
    if (row.startedAtMs === undefined) {
      row.startedAtMs = now;
    }
  }

  /** The run settled; the status db row is the run's truth now. */
  release(eventId: string): void {
    this.rows.delete(eventId);
  }

  /** The live rows /status serializes — the machine contract's views. */
  views(): SessionView[] {
    return [...this.rows.values()].map((row) => this.viewOf(row));
  }

  /**
   * The live rows the human page renders: the machine contract's views
   * each extended with the row's started stamp — the page derives the
   * running duration from it. Server-internal render data, passed to
   * renderStatusPage and never serialized into /status (the
   * SessionStartView extension).
   */
  viewsWithStartedAt(): SessionStartView[] {
    return [...this.rows.values()].map((row) => ({
      ...this.viewOf(row),
      startedAtMs: row.startedAtMs,
    }));
  }

  /** One row's machine-contract view: the pinned key set exactly. */
  private viewOf(row: LiveSessionRow): SessionView {
    return {
      eventId: row.start.eventId,
      repo: row.start.repo,
      pr: row.start.pr,
      eventKind: row.start.eventKind,
      requester: row.requester,
      commentId: row.start.commentId,
      stage: row.stage,
      acceptedAt: row.start.ts,
      lastActivityAt: new Date(row.lastActivityAtMs).toISOString(),
    };
  }
}

interface LiveSessionRow {
  /** The record the journal carries; its ts is the accepted moment. */
  start: ReviewStartRecord;
  /** The requesting login — the one start-record field the journal lacks. */
  requester: string;
  stage: string;
  lastActivityAtMs: number;
  /**
   * The moment the first stage entry reported — the transition out of
   * "queued" — stamped once and never moved by later stage changes.
   * Undefined while the row is parked.
   */
  startedAtMs: number | undefined;
}

// ---------------------------------------------------------------------------
// The boot walk's projection
// ---------------------------------------------------------------------------

/**
 * The starts and settle record the boot walk yields: the restart-dropped
 * view's material, derived once per boot — the journal's only status
 * purposes left. Each walked start record passes the shape check (a
 * failing one skips with one log line carrying its line number, the
 * walk's tolerance invariant) and every review record contributes the
 * event ids a terminal record settled.
 */
interface BootProjection {
  /** Every journaled start, by event id (a later start row overwrites). */
  starts: Map<string, DroppedStartView>;
  /** Event ids a terminal review record recorded. */
  terminal: Set<string>;
}

const classify = (lines: JournalLine[], log: Logger): BootProjection => {
  const starts = new Map<string, DroppedStartView>();
  const terminal = new Set<string>();
  for (const entry of lines) {
    const probe = entry.value as {
      type?: unknown;
      eventId?: unknown;
    };
    if (probe?.type === "review-start") {
      const start = ZBootStart.safeParse(entry.value);
      if (!start.success) {
        const issue = start.error.issues[0];
        log.info(
          `${entry.label} skipped: review start record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`,
        );
        continue;
      }
      starts.set(start.data.eventId, {
        eventId: start.data.eventId,
        repo: start.data.repo,
        pr: start.data.pr,
        eventKind: start.data.eventKind,
        acceptedAt: start.data.ts,
      });
      continue;
    }
    if (probe?.type !== "review") {
      // Reply records and anything else are legitimate journal lines
      // this projection does not consume.
      continue;
    }
    if (typeof probe.eventId === "string") {
      terminal.add(probe.eventId);
    }
  }
  return { starts, terminal };
};

const ZBootStart = z.looseObject({
  ts: z.string(),
  eventId: z.string(),
  repo: z.string(),
  pr: z.number(),
  eventKind: z.string(),
});

// ---------------------------------------------------------------------------
// The status source
// ---------------------------------------------------------------------------

export interface StatusSource {
  /** The snapshot /status serializes and the human page at / renders. */
  snapshot(): Promise<StatusData>;
}

/**
 * Build the status source. The boot walk's output arrives once — the same
 * read that built the posted-comment index — and only feeds the
 * restart-dropped view. `acceptedThisBoot` answers for the intake's
 * accepted-event map: an event this boot accepted is live or
 * just-settled, and its start row is not a restart-dropped one even while
 * its terminal record's projection write is in flight.
 */
export function createStatusSource(deps: {
  config: Config;
  clock: Clock;
  logger: Logger;
  /** The port the listen call actually bound. */
  port: number;
  /** The process start; the uptime line anchors here. */
  startedAtMs: number;
  live: LiveSessions;
  acceptedThisBoot: (eventId: string) => boolean;
  statusDb: StatusDb;
  bootLines: JournalLine[];
}): StatusSource {
  const { config, clock, logger, port, startedAtMs, live, statusDb } = deps;
  const boot = classify(deps.bootLines, logger);
  // Starts the boot walk already settled are permanent runs, never
  // restart-dropped ones: they drop out of the dropped-start view now,
  // and only unresolved starts carry its memory forward.
  for (const eventId of boot.terminal) {
    boot.starts.delete(eventId);
  }
  // The dropped-start rows freeze per boot: any start record appended
  // after the boot walk belongs to an event this boot accepted, and the
  // accepted-event filter below already names it live. What stays
  // dynamic is the filter — an event accepted this boot leaves the view
  // at its intake (a re-delivered old start is running again), whether
  // or not it settled yet.
  const droppedCandidates = [...boot.starts.values()];

  const snapshot = async (): Promise<StatusData> => {
    const dropped = droppedCandidates.filter(
      (start) => !deps.acceptedThisBoot(start.eventId),
    );
    return {
      uptime: {
        startedAt: new Date(startedAtMs).toISOString(),
        uptimeSeconds: Math.max(
          0,
          Math.floor((clock.now() - startedAtMs) / 1000),
        ),
        listenPort: port,
        adapterUrl: redactSecrets(config.adapterUrl),
      },
      sessions: [...live.views()],
      droppedStarts: { count: dropped.length, starts: dropped },
      runs: statusDb.recentRuns(),
      config: {
        listenPort: config.listenPort,
        allowedLogins: config.allowedLogins.length,
        allowedRepos: config.allowedRepos.length,
        retryPolicy: config.retryPolicy,
        reviewTimeoutSeconds: config.reviewTimeoutSeconds,
        turnPollSeconds: config.turnPollSeconds,
        turnBudgetSeconds: config.turnBudgetSeconds,
        agent: config.agent,
      },
    };
  };

  return { snapshot };
}
