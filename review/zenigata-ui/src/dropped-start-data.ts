/**
 * The dropped-starts domain's wire type: one review start a restart
 * dropped, whose review never landed and which a re-request re-runs
 * free.
 */

export interface DroppedStartView {
  eventId: string;
  repo: string;
  pr: number;
  eventKind: string;
  /** The journaled start's moment, ISO 8601. */
  acceptedAt: string;
}
