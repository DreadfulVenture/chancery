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

export const consoleLogger: Logger = {
  // The production logger: plain stdout/stderr lines, prefixed "zenigata:",
  // for the unit's journald to capture. The bot writes no log file of its
  // own — the only file the pipeline appends is the journal (run records,
  // state) — and every logged error is composed through `redactSecrets` at
  // its composition site, so redaction stays ahead of the console too.
  info: (message) => console.log(`zenigata: ${message}`),
  error: (message) => console.error(`zenigata: ${message}`),
};

export const systemClock: Clock = { now: () => Date.now() };
