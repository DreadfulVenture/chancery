/**
 * The context every pipeline function receives: configuration, the three
 * injected dependencies, and the process-wide services (persona text,
 * metrics, logging, clock, the posted-comment index).
 */

import type { Config } from "./config.js";
import type { ForgeAdapter } from "./contracts/forge.js";
import type { MemoryGateway } from "./contracts/memory.js";
import type { SessionDriver } from "./contracts/session.js";
import type { ReviewIndex } from "./journal.js";
import type { LogRing } from "./log-ring.js";
import type { Metrics } from "./metrics.js";
import type { StatusDb } from "./status-db.js";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface Clock {
  now(): number;
}

/**
 * The status surface's stage sink: the review pipeline reports the stage
 * it just entered, and the live session model keeps it — the running
 * stage exists here and nowhere else until the journal carries the
 * settled record. server.ts builds the one implementation, so every Ctx
 * carries a tracker and the pipeline reports unconditionally.
 */
export interface StageTracker {
  markStage(eventId: string, stage: string): void;
  /**
   * The pipeline recorded the reviewer session it just created for the
   * event (PRJ-538): the live row carries the id so the status page can
   * read the session's turn-by-turn log through the driver while the
   * run runs. A no-op on a row the tracker does not hold, like
   * markStage.
   */
  markSession(eventId: string, sessionId: string): void;
}

export interface Ctx {
  config: Config;
  forge: ForgeAdapter;
  sessions: SessionDriver;
  memory: MemoryGateway;
  /** The persona text injected into every prompt; data, never code. */
  persona: string;
  metrics: Metrics;
  logger: Logger;
  clock: Clock;
  /** In-memory index of the bot's posted comments, built from the journal. */
  index: ReviewIndex;
  /** The pipeline's stage sink, wired to the status surface's live model. */
  tracker: StageTracker;
  /**
   * The status projection: the pipeline's settled runs write through here
   * at the journal's append points, and /status reads from it instead of
   * the journal. Writes log and move on when they fail, never throwing.
   */
  statusDb: StatusDb;
}

/** The prefix every sink renders a narration message with. */
export const NARRATION_PREFIX = "zenigata: ";

/**
 * The line one narration message becomes at emission — the exact form
 * the console sink writes (the unit's journald collects it) and the
 * ring stores (the status page's log tail renders it).
 */
export const narrationLine = (message: string): string =>
  `${NARRATION_PREFIX}${message}`;

export const consoleLogger: Logger = {
  // The production logger: plain stdout/stderr lines, prefixed "zenigata:",
  // for the unit's journald to capture. The bot writes no log file of its
  // own — the only file the pipeline appends is the journal (run records,
  // state) — and every logged error is composed through `redactSecrets` at
  // its composition site, so redaction stays ahead of the console too.
  info: (message) => console.log(narrationLine(message)),
  error: (message) => console.error(narrationLine(message)),
};

/**
 * One write path, two sinks (PRJ-461): every narration message composes
 * its emitted line once; the sink below writes it to stdout/stderr for
 * journald, and the ring stores the same line for the status page's log
 * tail. The ring is the bot's voice only — the reviewer session's turns
 * ride the session driver and never pass through here.
 */
export const narratingLogger = (ring: LogRing, sink: Logger): Logger => ({
  info: (message) => {
    ring.push(narrationLine(message));
    sink.info(message);
  },
  error: (message) => {
    ring.push(narrationLine(message));
    sink.error(message);
  },
});

export const systemClock: Clock = { now: () => Date.now() };
