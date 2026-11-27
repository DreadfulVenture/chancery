/**
 * The page-data model: everything the status UI renders from, carried by
 * GET /page as JSON. The pinned machine contract (/status's StatusData)
 * gains none of it — these are the page-only extensions the old HTML
 * render composed in-process (the RunWallView pattern): the live rows'
 * started stamps and reviewer-session ids, the runs' wall times, failed
 * drafts, and transcripts, the forge URL, the narration tail, and the
 * adapter-reachability probe. The UI package (review/zenigata-ui)
 * consumes /page over the intake's HTTP surface and renders it.
 */

import type {
  SessionView,
  DroppedStartView,
  StatusConfig,
  UptimeInfo,
} from "./status.js";

/**
 * The page's live-session row: the JSON contract's session extended with
 * the moment the run left the queue — the ledger's first stage-entry
 * stamp — from which the page derives the running duration.
 */
export interface SessionStartView extends SessionView {
  /**
   * The first stage entry's stamp, epoch milliseconds. Undefined only
   * while the row has never left "queued" — the parked rows; a running
   * row carries it by the ledger's own rule.
   */
  startedAtMs: number | undefined;
  /**
   * The reviewer session's id (PRJ-538), recorded by the pipeline the
   * moment it created the session — the key the page reads the live
   * session log through. Undefined while the run is parked and until
   * the review stage creates its session.
   */
  sessionId?: string;
}

/**
 * The page's live-session row, further extended with the live session
 * log's view, read through the session driver at each /page render — the
 * log changes while the run runs, so nothing here is cached.
 */
export interface SessionLiveView extends SessionStartView {
  /** The live session log's view; undefined while the run has no session yet. */
  log?: TranscriptView;
}

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
 * The page's run row: the JSON contract's run extended with the run's
 * wall time, derived at the projection read. Null only when a settled
 * row carries no finish stamp, or its stamps do not parse as time —
 * states the projection's settlement rules rule out; the read names
 * either on the log and the page renders no wall time for the run.
 */
export interface RunWallView extends RunView {
  /** Finished minus started, in seconds, on the row's own stamps. */
  wallSeconds: number | null;
}

/**
 * One failed attempt a failed run journaled (PRJ-381's FailedDraft),
 * read for the page's failed report (PRJ-423). The reply is the capped
 * raw model output exactly as the journal carried it — the 64KiB cap
 * and its truncation marker ride through unchanged — and `truncated`
 * says the marker is present, so the page labels the draft instead of
 * leaving the cap to be discovered.
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
 * The page's run row: the wall-time extension above, further extended
 * with the failed run's failed drafts, read from the projection row the
 * terminal record wrote. Undefined for every run that did not end
 * failed — failed attempts on runs that eventually posted or aborted
 * stay journal-only.
 */
export interface RunDraftsView extends RunWallView {
  failedDrafts?: FailedDraftView[];
  /**
   * The retained reviewer session's id (PRJ-382's journal field, read
   * from the row) — the key the page reads the transcript through.
   * Undefined for window-0 runs and runs that died before creating a
   * session.
   */
  sessionId?: string;
  /** The transcript view composed for the failed run. */
  transcript?: TranscriptView;
}

/**
 * One run's reviewer-session transcript view (PRJ-461's transcript
 * scope, rendered as the session's turn-by-turn log since PRJ-538), read
 * live through the session driver: `found` carries the session's
 * activity composed for the pre block — already redacted and byte-capped
 * by the composition — while the session stands, with `latest` holding
 * the newest turn's first rendered line (the live row's glance); `swept`
 * says the driver reported the session gone, the retention sweep being
 * the usual hand (the classification reads any not-found answer the
 * same, so the note names the fact without attributing the sweeper);
 * `unavailable` says the read failed for any other reason.
 */
export type TranscriptView =
  | { state: "found"; text: string; truncated: boolean; latest?: string }
  | { state: "swept" }
  | { state: "unavailable" };

/** GET /page's response: the full page data model as JSON. */
export interface PageData {
  /** The render moment, ISO 8601 — the page's rendered-at line. */
  renderedAt: string;
  uptime: UptimeInfo;
  /** The adapter reachability probe's answer for this render. */
  adapterReachable: boolean;
  /** The forge's base URL, composing the PR cells' links. */
  forgeUrl: string;
  /** The narration ring's lines since boot, the page's log tail. */
  log: string[];
  sessions: SessionLiveView[];
  droppedStarts: { count: number; starts: DroppedStartView[] };
  runs: RunDraftsView[];
  config: StatusConfig;
}
