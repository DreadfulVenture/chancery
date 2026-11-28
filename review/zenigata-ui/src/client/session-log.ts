/**
 * The session log's blocks (PRJ-547, PRJ-568): the transcript view
 * rendered as the app's formatted log box, the one-line states a slot
 * can carry instead of a log, and the two full-width block variants —
 * the live row's keyed, pinned block and the failed run's frozen one.
 *
 * The expanded block spans the table in a colspan-everything second
 * row; dense text never wraps inside a column again. The live block's
 * `.log-body` div is the app's refresh point, and it is left empty by
 * this template on purpose: the app is the body's only renderer,
 * filling it at boot and on every refresh with `render(logBody(…))`.
 * A body another render had touched — lit-managed child parts, or
 * content a global `render()` never laid claim to — would make that
 * global render append instead of replace, which is how the box came
 * to duplicate itself. The summary and the pin control outside the
 * body are never recreated, so the pin's checked state survives every
 * swap as natural DOM state.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { RunDraftsView, TranscriptView } from "../run-data.js";
import type { SessionLiveView } from "../session-data.js";
import type { Renderable } from "./format.js";
import { formattedLog } from "./transcript-format.js";

/** The capped log's note: the 64KiB cut labels itself. */
const cappedNote = (truncated: boolean): Renderable =>
  truncated
    ? html`<div class="transcript-note muted small">
        the log is capped at the page's 64KiB; its oldest turns are cut
      </div>`
    : nothing;

/** The log body a transcript block or refresh carries: note, then log box. */
export const logBody = (view: TranscriptView): Renderable =>
  view.state !== "found"
    ? nothing
    : html`${cappedNote(view.truncated)}${formattedLog(view)}`;

/** The one-line states a transcript slot can carry instead of a log. */
export const transcriptStateNote = (view: TranscriptView): Renderable => {
  if (view.state === "swept") {
    return html`<div class="transcript-note muted small">
      the session is gone — the log is not available
    </div>`;
  }
  if (view.state === "unavailable") {
    return html`<div class="transcript-note muted small">
      the log could not be read right now
    </div>`;
  }
  if (view.text === "") {
    return html`<div class="transcript-note muted small">
      the session stands, but has recorded nothing yet
    </div>`;
  }
  return nothing;
};

/**
 * The live log's block: keyed to the session so the app can refresh it
 * in place while it stands open, with the pin control riding it. Rows
 * with nothing to expand answer null and render no second row.
 */
export const liveLogUnder = (
  session: SessionLiveView,
): TemplateResult | null => {
  if (session.sessionId === undefined || session.log === undefined) {
    return null;
  }
  const log = session.log;
  if (log.state !== "found" || log.text === "") {
    return null;
  }
  return html`<details
    class="transcript"
    data-log-session="${session.sessionId}"
  >
    <summary class="muted small">session log</summary>
    <label class="log-pin muted small">
      <input type="checkbox" class="log-pin-box" checked /> pin to bottom
    </label>
    <div class="log-body"></div>
  </details>`;
};

/**
 * A failed run's transcript, full-width beneath the run's row: a frozen
 * session's log never changes, so the block carries no refresh key and
 * no pin control, both of which belong to the live log. Runs with
 * nothing to expand answer null.
 */
export const frozenTranscriptBlock = (
  run: RunDraftsView,
): TemplateResult | null => {
  const transcript = run.transcript;
  if (
    transcript === undefined ||
    transcript.state !== "found" ||
    transcript.text === ""
  ) {
    return null;
  }
  return html`<details class="transcript">
    <summary class="muted small">reviewer session log</summary>
    <div class="log-body">${logBody(transcript)}</div>
  </details>`;
};
