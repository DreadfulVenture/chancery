/**
 * The SQLite projection the status surface's durable reads come from —
 * one `status.db` file per state dir, queried by /status and the human
 * page at /, written through synchronously at the journal's lifecycle
 * points (the append sites stay put; the projection rows follow the
 * journal lines).
 *
 * The three-part read contract this module serves:
 *   - while this boot runs, the in-process models (the live session list,
 *     the intake's own maps) are truth;
 *   - across restarts, this database is truth, backfilled once from the
 *     journal when the projection file starts empty;
 *   - the journal is the durable audit record (PRJ-337); it is no longer
 *     a read API for the status surface, so no request walks it.
 *
 * The write contract is the journal's own append-and-log pattern: a write
 * that fails logs and continues, never throws — the projection may miss
 * a write (it logs the miss), the run and the journal may not.
 *
 * Every row keys on the event's identity, so replays cannot double-count:
 * a start record opens one `running` row and the terminal record of the
 * same event settles it in place, carrying the later record's state. Three
 * rules keep settlements honest: a start never resets a row that already
 * settled (a replayed or re-accepted start is old news), a refused
 * replay's `skipped` record never overwrites a row that already carries a
 * real outcome (nothing was spent, nothing changes), and a real
 * settlement always updates — the retry policy's one re-run re-sets the
 * row it re-ran. Records written
 * before identities existed (and reply records, which carry none) key on
 * stable synthetic ids, so the idempotency contract holds for the whole
 * history the journal holds.
 */

import { and, count, desc, eq, isNull, ne, or, sql } from "drizzle-orm/sql";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock, Logger } from "./ctx.js";
import { FAILED_DRAFT_TRUNCATION_MARKER, type JournalLine } from "./journal.js";
import { redactSecrets } from "./redact.js";
import type { FailedDraftView, RunDraftsView, RunView } from "./ui.js";

/** The "recent runs" window, newest first. */
const MAX_RUNS = 10;

/** One `status.db` file per state dir; the durable projection's home. */
export function statusDbPath(stateDir: string): string {
  return `${stateDir}/status.db`;
}

// ---------------------------------------------------------------------------
// Journal record shapes the projection reads
// ---------------------------------------------------------------------------

/**
 * Only what the projection needs is validated; every object tolerates
 * unknown extra fields (z.looseObject), so a future record shape still
 * loads — the same house pattern the journal index's shapes use.
 */
const ZProjectionStart = z.looseObject({
  ts: z.string(),
  eventId: z.string(),
  repo: z.string(),
  pr: z.number(),
  commentId: z.string().optional(),
  eventKind: z.string(),
});

/**
 * One failed attempt's draft (PRJ-381's FailedDraft shape), validated at
 * the same tolerance grain as the record shapes around it — once for the
 * journal record's field at write, again for the stored column at read.
 */
const ZFailedDraft = z.looseObject({
  stage: z.string(),
  attempt: z.number(),
  reply: z.string(),
  parseError: z.string().optional(),
});

const ZFailedDrafts = z.array(ZFailedDraft);

const ZProjectionReview = z.looseObject({
  ts: z.string(),
  reviewId: z.string(),
  eventId: z.string().optional(),
  commentId: z.string().optional(),
  repo: z.string(),
  pr: z.number(),
  outcome: z.string(),
  verdict: z.string().optional(),
  // The record's `ts` is the run's start stamp; the real finish stamp rides
  // the record only when the retention window is on. Absent on records
  // written before the retention stamp existed (and window-0 records).
  finishedAt: z.string().optional(),
  phases: z
    .array(z.looseObject({ phase: z.string(), durationMs: z.number() }))
    .optional(),
  failure: z.looseObject({ stage: z.string(), message: z.string() }).optional(),
  // PRJ-423: the failed attempts' raw drafts a failed run journaled
  // (PRJ-381's FailedDraft shape); the page's failed report renders from
  // them. Consumed for failed outcomes only — see the write path below.
  failedDrafts: ZFailedDrafts.optional(),
});

const ZProjectionReply = z.looseObject({
  ts: z.string(),
  repo: z.string(),
  pr: z.number(),
  inReplyTo: z.string().optional(),
  author: z.string().optional(),
  outcome: z.string(),
  failure: z.looseObject({ stage: z.string(), message: z.string() }).optional(),
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  eventId        TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  pr             INTEGER NOT NULL,
  commentId      TEXT,
  eventKind      TEXT,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  verdict        TEXT,
  outcome        TEXT,
  startedAt      TEXT NOT NULL,
  finishedAt     TEXT,
  lastStage      TEXT,
  stages         TEXT,
  failureStage   TEXT,
  failureMessage TEXT,
  failedDrafts   TEXT,
  updatedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_window ON runs (kind, startedAt);
`;

/**
 * The runs table's additive columns a newer build writes that an older
 * table may lack: CREATE TABLE IF NOT EXISTS adds nothing to a table
 * that already exists, so the first write after an upgrade would refuse
 * with no-such-column. Every open checks the table's actual columns and
 * adds each missing one in place (see migrateColumns) — idempotent, so
 * every boot runs it. One entry per added column, name and type, in the
 * order the changes landed. The name states the scope: the PRAGMA probe
 * and the ALTER hardcode runs, and a second table that grows columns
 * gets its own list beside this one.
 */
const RUNS_ADDED_COLUMNS: Array<[name: string, type: string]> = [
  ["failedDrafts", "TEXT"],
];

/**
 * The typed mirror of the table the CREATE statement builds — same
 * columns, same nullability, same unique key on the event's identity.
 * Schema changes: an additive column migrates in place at open (see
 * RUNS_ADDED_COLUMNS), so a deployed state dir keeps its rows; any other
 * reshape deletes `status.db` and the boot backfill regenerates the
 * projection from the journal, so no migration tooling sits beside
 * drizzle to keep in step. The drizzle side and this file's DDL must
 * move together in one edit — and a new column joins RUNS_ADDED_COLUMNS
 * so an existing table gains it at open.
 */
const runs = sqliteTable(
  "runs",
  {
    eventId: text("eventId").primaryKey(),
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    commentId: text("commentId"),
    eventKind: text("eventKind"),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    verdict: text("verdict"),
    outcome: text("outcome"),
    startedAt: text("startedAt").notNull(),
    finishedAt: text("finishedAt"),
    lastStage: text("lastStage"),
    stages: text("stages"),
    failureStage: text("failureStage"),
    failureMessage: text("failureMessage"),
    failedDrafts: text("failedDrafts"),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [index("idx_runs_window").on(t.kind, t.startedAt)],
);

interface RunInsert {
  eventId: string;
  repo: string;
  pr: number;
  commentId: string | null;
  eventKind: string | null;
  kind: "review" | "reply";
  state: "running" | "done" | "failed";
  verdict: string | null;
  outcome: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastStage: string | null;
  stages: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  failedDrafts: string | null;
}

export class StatusDb {
  private drz: NodeSQLiteDatabase | null;
  /** The database file behind the drizzle wrapper; closed in `close`. */
  private file: DatabaseSync | null;

  constructor(deps: {
    /** Absolute path of the projection file; created when missing. */
    path: string;
    logger: Logger;
    clock: Clock;
  }) {
    this.logger = deps.logger;
    this.clock = deps.clock;
    this.file = new DatabaseSync(deps.path);
    this.file.exec(SCHEMA);
    this.migrateColumns(this.file);
    this.drz = drizzle({ client: this.file });
  }

  /**
   * The open-time additive migration: the runs table's actual columns
   * (pragma table_info) checked against RUNS_ADDED_COLUMNS, each missing
   * one added in place. The caller hands over the open file handle — the
   * parameter keeps the runs-before-drizzle ordering in the signature.
   * Every write path names every column, so this runs before the drizzle
   * wrapper exists and the pre-existing rows stay untouched.
   */
  private migrateColumns(file: DatabaseSync): void {
    const present = new Set(
      (
        file.prepare("PRAGMA table_info(runs)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const [name, type] of RUNS_ADDED_COLUMNS) {
      if (present.has(name)) {
        continue;
      }
      file.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      this.logger.info(`the status db migrated its runs table: added ${name}`);
    }
  }

  private readonly logger: Logger;
  private readonly clock: Clock;

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private log(message: string): void {
    this.logger.error(message);
  }

  /**
   * Upsert one row; the conflict target is the event's identity and the
   * WHERE clause carries the settlement rules. The guard's three conjuncts
   * are the settlement rules themselves: review rows only; the refusal's
   * own `skipped` marker never updates any row; and the settled branch
   * demands an incoming terminal (`excluded.finishedAt IS NOT NULL`), so
   * a start record only writes a row that has not settled — a replayed
   * or re-accepted start can never reset a settled row — while a real
   * terminal always updates (the retry policy's one re-run re-sets the
   * row it re-ran).
   */
  private upsert(row: RunInsert): void {
    this.drz
      ?.insert(runs)
      .values({ ...row, updatedAt: this.now() })
      .onConflictDoUpdate({
        target: runs.eventId,
        set: {
          commentId: sql`COALESCE(excluded.commentId, ${runs.commentId})`,
          eventKind: sql`COALESCE(excluded.eventKind, ${runs.eventKind})`,
          state: sql`excluded.state`,
          verdict: sql`excluded.verdict`,
          outcome: sql`excluded.outcome`,
          finishedAt: sql`excluded.finishedAt`,
          lastStage: sql`excluded.lastStage`,
          stages: sql`excluded.stages`,
          failureStage: sql`excluded.failureStage`,
          failureMessage: sql`excluded.failureMessage`,
          failedDrafts: sql`excluded.failedDrafts`,
          updatedAt: sql`excluded.updatedAt`,
        },
        setWhere: and(
          eq(runs.kind, "review"),
          sql`excluded.outcome IS NOT 'skipped'`,
          or(isNull(runs.finishedAt), sql`excluded.finishedAt IS NOT NULL`),
        ),
      })
      .run();
  }

  /**
   * Project one journal record — typed at the pipeline's write-through
   * sites, walked-and-parsed here at backfill. A record the shape check
   * refuses skips loudly (named with its label) and the projection moves
   * on, mirroring the walk's own tolerance on the far side; nothing here
   * throws, the projection's failures are its log.
   *
   * Returns null when the record wrote, and the skip reason when it did
   * not (a shape refusal, a closed db, or a write the storage refused).
   * The write-through sites ignore the return — their log-and-continue
   * contract is unaffected — and the boot backfill reads it: there a skip
   * rolls the whole walk back instead of passing.
   */
  apply(value: unknown, label: string): string | null {
    if (this.drz === null) {
      const reason = "the status db is closed, the projection write dropped";
      this.log(`${label} skipped: ${reason}`);
      return reason;
    }
    try {
      const probe = value as { type?: unknown };
      if (probe?.type === "review-start") {
        const start = ZProjectionStart.safeParse(value);
        if (!start.success) {
          const issue = start.error.issues[0];
          const reason = `review start record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`;
          this.log(`${label} skipped: ${reason}`);
          return reason;
        }
        // A start row settled by an earlier terminal record stays put: a
        // replayed (or out-of-order) start record is old news, and only
        // the live unsettled state takes the fresh `queued` row.
        this.upsert({
          eventId: start.data.eventId,
          repo: start.data.repo,
          pr: start.data.pr,
          commentId: start.data.commentId ?? null,
          eventKind: start.data.eventKind,
          kind: "review",
          state: "running",
          verdict: null,
          outcome: null,
          startedAt: start.data.ts,
          finishedAt: null,
          lastStage: "queued",
          stages: null,
          failureStage: null,
          failureMessage: null,
          failedDrafts: null,
        });
        return null;
      }
      if (probe?.type === "review") {
        const record = ZProjectionReview.safeParse(value);
        if (!record.success) {
          const issue = record.error.issues[0];
          const reason = `review record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`;
          this.log(`${label} skipped: ${reason}`);
          return reason;
        }
        const data = record.data;
        const phases = data.phases ?? [];
        const failure = data.failure;
        // PRJ-423: a failed run's failed drafts ride the row so the human
        // page can render why the run failed. The scope mirrors the
        // render exactly — the failure cell draws the drafts only under
        // a non-undefined failure, so a failed record without one stores
        // nothing the page would never read; every failed record the
        // composition sites write carries a failure, so the condition is
        // defensive alignment. A record whose run eventually posted or
        // aborted carries its failed attempts journal-only, and a later
        // settlement overwrites the drafts away with its own outcome.
        // The drafts store exactly as the journal carried them — the cap
        // and its marker untouched, no redaction: the composition sites
        // journal model output raw, and the page renders it escaped.
        // Un-redacted storage is an invariant of the listen surface:
        // server.ts binds 127.0.0.1 only, so the drafts are no more
        // exposed than the journal, which carries them raw for the same
        // reason — the diagnosis. If the binding ever leaves loopback,
        // redaction comes with it.
        const failedDrafts =
          data.outcome === "failed" &&
          data.failure !== undefined &&
          data.failedDrafts !== undefined &&
          data.failedDrafts.length > 0
            ? JSON.stringify(data.failedDrafts)
            : null;
        // With the event's identity the record settles the event's own
        // row; without one (records predating identities) the run's own
        // review id keys a row of its own.
        this.upsert({
          eventId: data.eventId ?? `run:${data.reviewId}`,
          repo: data.repo,
          pr: data.pr,
          commentId: data.commentId ?? null,
          eventKind: "review_requested",
          kind: "review",
          state: data.outcome === "failed" ? "failed" : "done",
          verdict: data.verdict ?? null,
          outcome: data.outcome,
          startedAt: data.ts,
          // The record's `ts` is the run's start stamp; its real finish
          // stamp rides `finishedAt` (retention-window records). The
          // fallback stamps the start over itself, honest for the
          // pre-retention records that carry no finish stamp.
          finishedAt: data.finishedAt ?? data.ts,
          lastStage: failure?.stage ?? phases.at(-1)?.phase ?? "queued",
          stages: JSON.stringify(phases),
          failureStage: failure?.stage ?? null,
          // The journal redacts at its composition sites; the projection
          // redacts again so the surface can never store a secret an
          // older record slipped through.
          failureMessage:
            failure === undefined ? null : redactSecrets(failure.message),
          failedDrafts,
        });
        return null;
      }
      if (probe?.type === "reply") {
        const reply = ZProjectionReply.safeParse(value);
        if (!reply.success) {
          const issue = reply.error.issues[0];
          const reason = `reply record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`;
          this.log(`${label} skipped: ${reason}`);
          return reason;
        }
        const data = reply.data;
        const failure = data.failure;
        // Replies carry no event identity; the record's own shape composes
        // the stable key an identical replay lands on.
        this.upsert({
          eventId: `reply:${data.ts}|${data.repo}#${data.pr}|${data.inReplyTo ?? data.author ?? ""}`,
          repo: data.repo,
          pr: data.pr,
          commentId: null,
          eventKind: "reply",
          kind: "reply",
          state: data.outcome === "failed" ? "failed" : "done",
          verdict: null,
          outcome: data.outcome,
          startedAt: data.ts,
          finishedAt: data.ts,
          lastStage: failure?.stage ?? "reply",
          stages: null,
          failureStage: failure?.stage ?? null,
          failureMessage:
            failure === undefined ? null : redactSecrets(failure.message),
          failedDrafts: null,
        });
        return null;
      }
      // Any other journal line is legitimate audit text this projection
      // does not consume; not a corruption signal, and not a skip the
      // backfill's atomicity would treat as a failure.
      return null;
    } catch (error) {
      // The projection's write contract: failures log, the run moves on.
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`${label}: the status db write failed: ${reason}`);
      return reason;
    }
  }

  /**
   * One boot-time walk's worth of history into an empty projection: the
   * journal stays the durability record, and only a projection file that
   * starts empty (a missing or fresh one) syncs from it.
   *
   * The walk commits atomically: the whole walk runs inside one
   * transaction, and any skip (a record the shape check refuses, a write
   * the storage refuses) or unexpected throw rolls every row of the walk
   * back, leaving the file empty. Backfill is the projection's only
   * repair path and runs behind the emptiness gate, so a half-filled
   * projection could never be repaired — after a rollback the next boot's
   * walk retries for free. On success the return is the rows the table
   * landed (an event's start and terminal are one row), not the lines the
   * walk was fed; on rollback it is 0.
   */
  backfill(lines: JournalLine[]): number {
    const file = this.file;
    const drz = this.drz;
    if (drz === null || file === null) {
      this.log("the status db is closed; the backfill synced nothing");
      return 0;
    }
    if (this.rowCount() !== 0) {
      // A projection that already holds rows never syncs again: a second
      // boot walk (or a re-walk) applies nothing.
      return 0;
    }
    let landed = 0;
    try {
      file.exec("BEGIN");
      for (const entry of lines) {
        const skipped = this.apply(entry.value, entry.label);
        if (skipped !== null) {
          this.rollbackBackfill(
            file,
            `stopped at ${entry.label} of ${lines.length}, reason: ${skipped}`,
          );
          return 0;
        }
        landed += 1;
      }
      file.exec("COMMIT");
      return this.rowCount();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.rollbackBackfill(
        file,
        `threw after ${landed} landed rows, reason: ${reason}`,
      );
      return 0;
    }
  }

  /**
   * The backfill's one rollback: undo every row the walk wrote, then say
   * so — what rolled back and why. A ROLLBACK the storage itself refuses
   * is logged and swallowed so the boot's log-and-continue contract holds.
   */
  private rollbackBackfill(file: DatabaseSync, why: string): void {
    try {
      file.exec("ROLLBACK");
    } catch (rollbackError) {
      this.log(
        `the status db backfill's rollback itself failed: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
      );
    }
    this.log(
      `the status db backfill rolled back every row of its walk (${why}); the projection stays empty and the next boot retries`,
    );
  }

  private rowCount(): number {
    if (this.drz === null) {
      return 0;
    }
    const row = this.drz.select({ n: count() }).from(runs).get();
    return row?.n ?? 0;
  }

  /**
   * The settled run rows the two read views map, newest first, SQL only:
   * review rows a terminal record settled. Null only when the db is
   * closed; the public reads log and return empty in that case.
   */
  private settledRunRows(
    limit: number,
  ): Array<typeof runs.$inferSelect> | null {
    if (this.drz === null) {
      return null;
    }
    return this.drz
      .select()
      .from(runs)
      .where(and(eq(runs.kind, "review"), ne(runs.state, "running")))
      .orderBy(desc(runs.startedAt), sql`rowid DESC`)
      .limit(limit)
      .all();
  }

  /**
   * One settled row's status columns, in the machine contract's run
   * row's exact key order: /status serves this mapping's output
   * verbatim, and the settled rows' ts is the run's own start moment —
   * a retry settlement updates the row in place, carrying the later
   * terminal's outcome over the same startedAt.
   */
  private runView(row: typeof runs.$inferSelect): RunView {
    let phases: Array<{ phase: string; durationMs: number }> = [];
    try {
      phases = JSON.parse(row.stages ?? "[]") as RunView["phases"];
    } catch (error) {
      this.log(
        `the status db read for ${row.eventId}: the stored stage list did not parse, rendering none: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      ts: row.startedAt,
      repo: row.repo,
      pr: row.pr,
      outcome: row.outcome ?? "",
      verdict: row.verdict,
      phases,
      failure:
        row.failureStage === null && row.failureMessage === null
          ? undefined
          : {
              stage: row.failureStage ?? "",
              message: row.failureMessage ?? "",
            },
    };
  }

  /** The run rows /status serializes — the machine contract's runs. */
  recentRuns(limit = MAX_RUNS): RunView[] {
    const rows = this.settledRunRows(limit);
    if (rows === null) {
      this.log("the status db is closed; the runs read returned nothing");
      return [];
    }
    return rows.map((row) => this.runView(row));
  }

  /**
   * One settled row's failed drafts, read for the human page only
   * (PRJ-423): the stored JSON parses back into the page's draft views,
   * each carrying its truncation flag — true when the capped reply ends
   * with the journal's truncation marker. Undefined when the row stores
   * no drafts (the runs that did not end failed). A stored value that
   * does not parse names itself on the log and renders none — the read's
   * log-and-move-on contract, like the stage list's.
   */
  private draftsOf(
    row: typeof runs.$inferSelect,
  ): FailedDraftView[] | undefined {
    if (row.failedDrafts === null) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.failedDrafts);
    } catch (error) {
      this.log(
        `the status db read for ${row.eventId}: the stored failed drafts did not parse, rendering none: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
    const drafts = ZFailedDrafts.safeParse(value);
    if (!drafts.success) {
      const issue = drafts.error.issues[0];
      this.log(
        `the status db read for ${row.eventId}: the stored failed drafts failed validation at ${
          issue?.path.join(".") || "record"
        }: ${issue?.message ?? "unknown"}, rendering none`,
      );
      return undefined;
    }
    return drafts.data.map((draft) => ({
      stage: draft.stage,
      attempt: draft.attempt,
      parseError: draft.parseError,
      reply: draft.reply,
      truncated: draft.reply.endsWith(FAILED_DRAFT_TRUNCATION_MARKER),
    }));
  }

  /**
   * The run rows the human page at / renders: the machine contract's
   * rows each extended with the run's wall time, derived from the row's
   * own stamps — finished minus started, in seconds — and with the
   * failed run's failed drafts, read from the row's own column (see
   * draftsOf). The filter keeps settled rows only, and the settlement
   * rules keep every settled row stamped: only a terminal record
   * settles a row, and every terminal record carries its finishedAt.
   * The null branches are the read naming a violation of that contract
   * instead of trusting it — the row renders without a wall time, and
   * nothing throws.
   */
  recentRunsWithWallTime(limit = MAX_RUNS): RunDraftsView[] {
    const rows = this.settledRunRows(limit);
    if (rows === null) {
      this.log(
        "the status db is closed; the page's runs read returned nothing",
      );
      return [];
    }
    return rows.map((row) => ({
      ...this.runView(row),
      wallSeconds: this.wallSecondsOf(row),
      failedDrafts: this.draftsOf(row),
    }));
  }

  /**
   * One settled row's wall time, the derivation recentRunsWithWallTime
   * carries: the stamps subtracted, and the two rule-violation states —
   * no finish stamp, stamps that do not parse as time — named on the
   * log and answered null instead of trusted.
   */
  private wallSecondsOf(row: typeof runs.$inferSelect): number | null {
    if (row.finishedAt === null) {
      this.log(
        `the status db read for ${row.eventId}: the settled row carries no finish stamp, rendering no wall time`,
      );
      return null;
    }
    const seconds =
      (Date.parse(row.finishedAt) - Date.parse(row.startedAt)) / 1000;
    if (!Number.isFinite(seconds)) {
      this.log(
        `the status db read for ${row.eventId}: the run's stamps do not parse as time, rendering no wall time`,
      );
      return null;
    }
    return seconds;
  }

  /**
   * Release the projection's file handle; writes and reads after this
   * log instead of touching a closed database. Safe to call once.
   */
  close(): void {
    const file = this.file;
    if (file === null) {
      return;
    }
    this.file = null;
    this.drz = null;
    try {
      file.close();
    } catch (error) {
      this.log(
        `closing the status db failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
