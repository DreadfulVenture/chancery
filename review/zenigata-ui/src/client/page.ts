/**
 * The page: the shell the panels assemble into, in the order an
 * operator reads at 2am — health line, what is running, recent runs,
 * dropped starts, the bot's own narration, config echo — with the
 * footer's notifications control.
 */

import { html, type TemplateResult } from "lit";
import type { PageData } from "../page-feed.js";
import { configEchoPanel } from "./config-echo-panel.js";
import { droppedPanel } from "./dropped-panel.js";
import { healthPanel } from "./health-panel.js";
import { narrationPanel } from "./narration-panel.js";
import { runsPanel } from "./runs-panel.js";
import { sessionsPanel } from "./sessions-panel.js";

/** The footer's notifications control, in its three states. */
export const notifyControl = (
  state: "on" | "off" | "unsupported",
  onEnable: () => void,
): TemplateResult => {
  if (state === "unsupported") {
    return html`<span class="muted"
      >notifications not available in this browser</span
    >`;
  }
  if (state === "on") {
    return html`<span class="muted">notifications on</span>`;
  }
  return html`<button type="button" @click=${onEnable}>
    notifications off — turn on
  </button>`;
};

export const pageTemplate = (
  page: PageData,
  notifyState: "on" | "off" | "unsupported",
  onEnable: () => void,
): TemplateResult => html`
  <header>
    <div>
      <h1>zenigata</h1>
      <p class="muted">review bot · pull-request reviews and thread answers</p>
    </div>
    <p class="muted">refreshed ${page.renderedAt}</p>
  </header>
  ${healthPanel(page)} ${sessionsPanel(page)} ${runsPanel(page)}
  ${droppedPanel(page)} ${narrationPanel(page)} ${configEchoPanel(page)}
  <footer>
    <span class="muted" id="notify-control">
      ${notifyControl(notifyState, onEnable)}
    </span>
    <span>
      the same projection as a machine feed: <a href="/status">GET /status</a>
    </span>
  </footer>
`;
