/**
 * The configuration echo panel: the bot's own configured facts, shown
 * plainly — none of them a secret (the forge URL shows like the
 * adapter's URL on the health line).
 */

import { html, type TemplateResult } from "lit";
import type { StatusConfig } from "../bot-config-data.js";
import type { PageData } from "../page-feed.js";
import { duration } from "./format.js";

const configList = (config: StatusConfig, forgeUrl: string): TemplateResult => {
  const rows: Array<[string, string]> = [
    [
      "configured listen port",
      config.listenPort === 0
        ? "0 (the OS picks the port)"
        : String(config.listenPort),
    ],
    ["allowed logins", String(config.allowedLogins)],
    [
      "allowed repositories",
      config.allowedRepos === 0
        ? "no allowlist (every repository)"
        : String(config.allowedRepos),
    ],
    ["retry policy", config.retryPolicy],
    ["review timeout", duration(config.reviewTimeoutSeconds)],
    ["turn poll", `${config.turnPollSeconds}s`],
    ["turn budget", duration(config.turnBudgetSeconds)],
    ["agent", config.agent],
    ["forge", forgeUrl],
  ];
  return html`<dl class="grid">
    ${rows.map(
      ([label, value]) =>
        html`<dt>${label}</dt>
          <dd>${value}</dd>`,
    )}
  </dl>`;
};

export const configEchoPanel = (page: PageData): TemplateResult => html`
  <section class="panel">
    <h2>Configuration</h2>
    ${configList(page.config, page.forgeUrl)}
  </section>
`;
