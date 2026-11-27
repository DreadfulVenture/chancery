/**
 * The narration panel: the bot's own narration (PRJ-461), the lines the
 * logger emitted this boot, stored in the bounded in-memory ring and
 * rendered oldest first as one pre block. The note above it names the
 * store's contract — in memory since boot, written nowhere, emptied by
 * a restart — so the page never implies a log file exists. Lit escapes
 * the whole block, so a line carrying markup renders as text.
 */

import { html, type TemplateResult } from "lit";
import type { PageData } from "../page-feed.js";

export const narrationPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Bot narration</h2>
    <p class="fine">
      the bot's own narration — the same lines journald collects — held in
      memory since this boot, written nowhere; a restart empties it
    </p>
    ${page.log.length === 0
      ? html`<p class="empty">Nothing said yet this boot.</p>`
      : html`<pre class="log-tail">${page.log.join("\n")}</pre>`}
  </section>
`;
