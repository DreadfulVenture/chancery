/**
 * The dropped-starts panel: the starts a restart dropped, each with the
 * re-request affordance. The link opens the forge's PR page, whose own
 * re-request control re-fires the review through the webhook as a
 * fresh delivery — the run the restart dropped re-runs free (nothing
 * was spent).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { DroppedStartView } from "../dropped-start-data.js";
import type { PageData } from "../page-feed.js";
import { stamped } from "./format.js";
import { pullCell } from "./forge-link.js";
import { table, type Column } from "./table.js";

const droppedTable = (page: PageData, now: number): TemplateResult => {
  const columns: Array<Column<DroppedStartView>> = [
    {
      label: "pull request",
      cell: (start) =>
        pullCell(start.repo, start.pr, page.forgeUrl, "request review again"),
    },
    { label: "accepted", cell: (start) => stamped(start.acceptedAt, now) },
  ];
  return table(columns, page.droppedStarts.starts);
};

export const droppedPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Review starts a restart dropped</h2>
    ${page.droppedStarts.count === 0
      ? html`<p class="empty">None. Every start the journal holds, settled.</p>`
      : html`<p class="fine">
            <strong
              >${page.droppedStarts.count}
              start${page.droppedStarts.count === 1 ? nothing : "s"}</strong
            >
            this boot's journal holds with nothing settled behind them: their
            reviews never landed. A re-request re-runs them free: request review
            again on any row.
          </p>
          ${droppedTable(page, Date.parse(page.renderedAt))}`}
  </section>
`;
