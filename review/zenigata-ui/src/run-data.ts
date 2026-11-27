/**
 * The runs domain's wire types: the run rows the recent-runs panel
 * renders, with their page-only extensions (wall time, failed drafts,
 * the retained session's transcript view), and the transcript view the
 * session log's refresh serves.
 */

export interface RunView {
  ts: string;
  repo: string;
  pr: number;
  outcome: string;
  verdict: string | null;
  phases: Array<{ phase: string; durationMs: number }>;
  failure?: { stage: string; message: string };
}

/**
 * The run row's wall-time extension: finished minus started, in
 * seconds, on the row's own stamps. Null only when a settled row
 * carries no finish stamp, or its stamps do not parse as time — states
 * the projection's settlement rules rule out; the read names either on
 * the log and the page renders no wall time for the run.
 */
export interface RunWallView extends RunView {
  wallSeconds: number | null;
}

/**
 * One failed attempt a failed run journaled, read for the page's failed
 * report. The reply is the capped raw model output exactly as the
 * journal carried it — the 64KiB cap and its truncation marker ride
 * through unchanged — and `truncated` says the marker is present, so
 * the page labels the draft instead of leaving the cap to be
 * discovered.
 */
export interface FailedDraftView {
  /** The stage whose validation refused the attempt. */
  stage: string;
  /** Zero-based attempt number within the stage's own loop. */
  attempt: number;
  /** The parse-boundary refusal when validation died before the payload checks. */
  parseError?: string;
  /** The capped raw reply, as-is. */
  reply: string;
  /** True when the reply carries the journal's truncation marker. */
  truncated: boolean;
}

/**
 * The run row's failed-drafts extension: the failed run's failed
 * drafts, read from the projection row the terminal record wrote.
 * Undefined for every run that did not end failed — failed attempts on
 * runs that eventually posted or aborted stay journal-only.
 */
export interface RunDraftsView extends RunWallView {
  failedDrafts?: FailedDraftView[];
  /**
   * The retained reviewer session's id, read from the row — the key the
   * page reads the transcript through. Undefined for window-0 runs and
   * runs that died before creating a session.
   */
  sessionId?: string;
  /** The transcript view composed for the failed run. */
  transcript?: TranscriptView;
}

/**
 * One run's reviewer-session transcript view, read live through the
 * session driver: `found` carries the session's activity composed for
 * the pre block — already redacted and byte-capped by the composition —
 * while the session stands, with `latest` holding the newest turn's
 * first rendered line (the live row's glance); `swept` says the driver
 * reported the session gone, the retention sweep being the usual hand
 * (the classification reads any not-found answer the same, so the note
 * names the fact without attributing the sweeper); `unavailable` says
 * the read failed for any other reason.
 */
export type TranscriptView =
  | { state: "found"; text: string; truncated: boolean; latest?: string }
  | { state: "swept" }
  | { state: "unavailable" };
