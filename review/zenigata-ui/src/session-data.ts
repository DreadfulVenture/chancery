/**
 * The sessions domain's wire types: one live session row, the JSON
 * contract's session extended with the page-only fields the /page feed
 * carries (the started stamp, the reviewer session's id, and the log's
 * transcript view).
 */

import type { TranscriptView } from "./run-data.js";

/** One session row on the pinned /status contract. */
export interface SessionView {
  eventId: string;
  repo: string;
  pr: number;
  eventKind: string;
  requester: string;
  commentId: string;
  /** The pipeline stage the run last reported ("queued" before dispatch). */
  stage: string;
  /** The journaled start's moment — the accepted moment it carried, ISO 8601. */
  acceptedAt: string;
  /** The accept moment or the last stage report, ISO 8601. */
  lastActivityAt: string;
}

/** The live row's page-only extensions, on the /page contract. */
export interface SessionLiveView extends SessionView {
  /**
   * The first stage entry's stamp, epoch milliseconds. Undefined only
   * while the row has never left "queued" — the parked rows; a running
   * row carries it by the ledger's own rule.
   */
  startedAtMs: number | undefined;
  /**
   * The reviewer session's id, recorded by the pipeline the moment it
   * created the session — the key the page reads the live session log
   * through. Undefined while the run is parked and until the review
   * stage creates its session.
   */
  sessionId?: string;
  /** The live session log's view; undefined while the run has no session yet. */
  log?: TranscriptView;
}
