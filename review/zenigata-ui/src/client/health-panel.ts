/**
 * The health panel: the adapter's reachability chip, the uptime, and
 * the bound port, with the started moment and the adapter URL as the
 * fine print.
 */

import { html, type TemplateResult } from "lit";
import type { PageData } from "../page-feed.js";
import { chip, duration } from "./format.js";

export const healthPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Health</h2>
    <p class="health">
      ${page.adapterReachable
        ? chip("adapter reachable", "ok")
        : chip("adapter unreachable", "bad")}
      <span class="fact">up ${duration(page.uptime.uptimeSeconds)}</span>
      <span class="fact">listening on port ${page.uptime.listenPort}</span>
    </p>
    <p class="fine">
      started ${page.uptime.startedAt} · adapter ${page.uptime.adapterUrl}
    </p>
  </section>
`;
