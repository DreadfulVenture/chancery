/**
 * The recent-runs panel: the runs table — the stamps, the PR cell, the
 * verdict chip, the wall time, the stages, and the failure cell with
 * its failed report and the frozen transcript block beneath the row.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { FailedDraftView, RunDraftsView, RunView } from "../run-data.js";
import type { PageData } from "../page-feed.js";
import { chip, duration, phase, stamped, type Renderable } from "./format.js";
import { pullCell } from "./forge-link.js";
import { frozenTranscriptBlock, transcriptStateNote } from "./session-log.js";
import { table, type Column } from "./table.js";

/** The verdict chip a settled run earns. Color follows the outcome. */
const runResult = (run: RunView): TemplateResult => {
  switch (run.outcome) {
    case "posted":
      return chip(run.verdict ?? "posted", "ok");
    case "aborted":
      return chip("aborted", "warn");
    case "skipped":
      return chip("skipped", "mute");
    default:
      return chip("failed", "bad");
  }
};

/**
 * One failed attempt's readable block (PRJ-423): the stage, the attempt
 * number, the parse-boundary refusal when one exists, and the capped
 * raw reply as-is. The reply is model output — lit escapes every leaf,
 * so a draft carrying markup renders as text. The page acts on nothing
 * here: viewing only.
 */
const failedDraft = (draft: FailedDraftView): TemplateResult => html`
  <div class="draft">
    <div class="draft-head">
      ${chip(draft.stage, "mute")}
      <span class="muted small">attempt ${draft.attempt}</span>
      ${draft.truncated ? chip("truncated", "warn") : nothing}
    </div>
    ${draft.parseError === undefined
      ? nothing
      : html`<div class="draft-refusal">${draft.parseError}</div>`}
    <pre class="draft-reply">${draft.reply}</pre>
  </div>
`;

const failedReport = (run: RunDraftsView): Renderable =>
  run.failedDrafts === undefined
    ? nothing
    : html`${run.failedDrafts.map(failedDraft)}`;

/** The failed-run notes that stay in the failure cell. */
const transcriptNote = (run: RunDraftsView): Renderable =>
  run.transcript === undefined ? nothing : transcriptStateNote(run.transcript);

const runsTable = (page: PageData, now: number): TemplateResult => {
  const columns: Array<Column<RunDraftsView>> = [
    { label: "started", cell: (run) => stamped(run.ts, now) },
    {
      label: "pull request",
      cell: (run) => pullCell(run.repo, run.pr, page.forgeUrl),
    },
    { label: "result", cell: runResult },
    {
      label: "wall time",
      cell: (run) =>
        run.wallSeconds === null
          ? html`<span class="muted">—</span>`
          : html`<span class="muted">${duration(run.wallSeconds)}</span>`,
    },
    {
      label: "stages",
      cell: (run) =>
        run.phases.length === 0
          ? html`<span class="muted">—</span>`
          : html`<span class="muted small"
              >${run.phases.map(
                (item, index) =>
                  html`${item.phase}
                  ${phase(item.durationMs)}${index < run.phases.length - 1
                    ? " · "
                    : nothing}`,
              )}</span
            >`,
    },
    {
      label: "failure",
      cell: (run) =>
        run.failure === undefined
          ? html`<span class="muted">—</span>`
          : html`<span class="danger"
                >${run.failure.stage}: ${run.failure.message}</span
              >${failedReport(run)}${transcriptNote(run)}`,
      under: frozenTranscriptBlock,
    },
  ];
  return table(columns, page.runs);
};

export const runsPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Recent review runs</h2>
    ${page.runs.length === 0
      ? html`<p class="empty">No runs yet.</p>`
      : runsTable(page, Date.parse(page.renderedAt))}
  </section>
`;
