/**
 * The running-now panel: the sessions table — the PR cell with its
 * re-request affordance, the parked/running state chip, the requester,
 * the stamps, and the session log column whose expanded block renders
 * full-width beneath its row (PRJ-547).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { PageData } from "../page-feed.js";
import type { SessionLiveView } from "../session-data.js";
import { chip, duration, stamped, type Renderable } from "./format.js";
import { pullCell } from "./forge-link.js";
import { liveLogUnder, transcriptStateNote } from "./session-log.js";
import { table, type Column } from "./table.js";

/**
 * The running chip's word: the state, and the run's age — how long since
 * the row left the queue — when the ledger holds the stamp for it. With
 * no started stamp the chip names the state alone; nothing renders that
 * the ledger does not hold.
 */
const runningChip = (session: SessionLiveView, nowMs: number): string =>
  session.startedAtMs === undefined
    ? "running"
    : `running ${duration(Math.max(0, (nowMs - session.startedAtMs) / 1000))}`;

/** The state cell of a live session: parked behind the limiter, or running. */
const sessionState = (session: SessionLiveView, nowMs: number): Renderable =>
  session.stage === "queued"
    ? html`<span class="chip warn">parked</span>
        <span class="muted small">waiting for a free review slot</span>`
    : html`<span class="chip ok">${runningChip(session, nowMs)}</span>
        <span class="muted small">${session.stage}</span>`;

/**
 * One running row's session log cell (PRJ-538): the newest activity as
 * the glance; the expanded log renders full-width under the row. The
 * one-line states stay in the cell.
 */
const liveLogCell = (session: SessionLiveView): Renderable => {
  if (session.sessionId === undefined || session.log === undefined) {
    return html`<span class="muted small">no session yet</span>`;
  }
  const log = session.log;
  if (log.state !== "found" || log.text === "") {
    return transcriptStateNote(log);
  }
  return log.latest === undefined
    ? nothing
    : html`<span class="muted small">${log.latest}</span>`;
};

const sessionsTable = (page: PageData, now: number): TemplateResult => {
  const columns: Array<Column<SessionLiveView>> = [
    {
      label: "pull request",
      // Live rows carry the re-request affordance with the PR link.
      cell: (session) =>
        pullCell(
          session.repo,
          session.pr,
          page.forgeUrl,
          "request review again",
        ),
    },
    { label: "state", cell: (session) => sessionState(session, now) },
    { label: "requester", cell: (session) => html`${session.requester}` },
    {
      label: "accepted",
      cell: (session) => stamped(session.acceptedAt, now),
    },
    {
      label: "last activity",
      cell: (session) => stamped(session.lastActivityAt, now),
    },
    { label: "session log", cell: liveLogCell, under: liveLogUnder },
  ];
  return table(columns, page.sessions);
};

export const sessionsPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Running now</h2>
    ${page.sessions.length === 0
      ? html`<p class="empty">Nothing running right now.</p>`
      : sessionsTable(page, Date.parse(page.renderedAt))}
  </section>
`;
