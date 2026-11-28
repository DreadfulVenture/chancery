/**
 * The page: the shell the panels assemble into, in the order an
 * operator reads at 2am — health line, what is running, recent runs,
 * dropped starts, the bot's own narration, config echo — with the
 * footer's notifications control.
 */

import { html, type TemplateResult } from "lit";
import { render } from "lit";
import type { PageData } from "../page-feed.js";
import { configEchoPanel } from "./config-echo-panel.js";
import { droppedPanel } from "./dropped-panel.js";
import { healthPanel } from "./health-panel.js";
import { narrationPanel } from "./narration-panel.js";
import { runsPanel } from "./runs-panel.js";
import { sessionsPanel } from "./sessions-panel.js";
import { logBody } from "./session-log.js";

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

export const pageTemplate = (page: PageData): TemplateResult => html`
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
    <span class="muted notify-control"></span>
    <span>
      the same projection as a machine feed: <a href="/status">GET /status</a>
    </span>
  </footer>
`;

/**
 * The shell's app-managed refresh points, filled after the shell
 * renders: each live log block's body and the footer's notifications
 * control. Both are laid claim to only through `render()` — never as a
 * child part of the shell template — so every later `render()` call
 * replaces in place. A body the shell template had already rendered as
 * a child part makes the refresh's global `render()` append a second
 * copy instead of replacing, which is how the log box duplicated
 * itself (PRJ-568).
 */
export const hydratePage = (
  page: PageData,
  container: HTMLElement,
  notifyState: "on" | "off" | "unsupported",
  onEnable: () => void,
): void => {
  const logs = new Map(
    page.sessions.flatMap((session) =>
      session.sessionId !== undefined && session.log !== undefined
        ? [[session.sessionId, session.log] as const]
        : [],
    ),
  );
  for (const block of container.querySelectorAll<HTMLDetailsElement>(
    "details[data-log-session]",
  )) {
    const sessionId = block.getAttribute("data-log-session");
    const body = block.querySelector<HTMLElement>(".log-body");
    const log = sessionId === null ? undefined : logs.get(sessionId);
    if (body !== null && log !== undefined) {
      render(logBody(log), body);
    }
  }
  const control = container.querySelector<HTMLElement>(".notify-control");
  if (control !== null) {
    render(notifyControl(notifyState, onEnable), control);
  }
};
