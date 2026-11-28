/**
 * The page's rendering: the forge links, the escaped leaves, the failed
 * report blocks, the live rows' states, and the PRJ-547 full-width log
 * blocks. The same templates the browser bundle carries are the ones
 * these tests render, in happy-dom.
 */

import { describe, expect, it } from "vitest";
import { render } from "lit";
import { forgePullUrl } from "../src/client/forge-link.js";
import {
  logBody,
  liveLogUnder,
  transcriptStateNote,
} from "../src/client/session-log.js";
import { hydratePage, pageTemplate } from "../src/client/page.js";
import type { PageData } from "../src/page-feed.js";

const mount = (template: ReturnType<typeof pageTemplate>): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(template, container);
  return container;
};

const page = (over: Partial<PageData> = {}): PageData => ({
  renderedAt: "2026-11-16T11:00:00.000Z",
  uptime: {
    startedAt: "2026-11-16T09:00:00.000Z",
    uptimeSeconds: 7200,
    listenPort: 8471,
    adapterUrl: "http://adapter.invalid",
  },
  adapterReachable: true,
  forgeUrl: "https://forge.invalid",
  log: [],
  sessions: [],
  droppedStarts: { count: 0, starts: [] },
  runs: [],
  config: {
    listenPort: 0,
    allowedLogins: 1,
    allowedRepos: 0,
    retryPolicy: "never",
    reviewTimeoutSeconds: 1800,
    turnPollSeconds: 3,
    turnBudgetSeconds: 900,
    agent: "zenigata-reviewer",
  },
  ...over,
});

const liveSession = (
  over: Partial<Parameters<typeof liveLogUnder>[0]> = {},
): PageData["sessions"][number] => ({
  eventId: "evt-live",
  repo: "acme/widget",
  pr: 1,
  eventKind: "review_requested",
  requester: "example-user",
  commentId: "c-1",
  stage: "review",
  acceptedAt: "2026-11-16T10:00:00.000Z",
  lastActivityAt: "2026-11-16T10:00:05.000Z",
  startedAtMs: 1_000,
  sessionId: "sess-live",
  log: {
    state: "found",
    text: "[10:00:01] user: review this\n\n[10:00:02] reviewer: on it",
    truncated: false,
    latest: "[10:00:02] reviewer: on it",
  },
  ...over,
});

describe("the forge links", () => {
  it("a well-formed repo maps to the forge's pull page", () => {
    expect(forgePullUrl("acme/widget", 7, "https://forge.invalid")).toBe(
      "https://forge.invalid/acme/widget/pulls/7",
    );
  });

  it("a trailing-slash base loses it, and each path segment is encoded", () => {
    expect(forgePullUrl("acme/space repo", 1, "https://forge.invalid/")).toBe(
      "https://forge.invalid/acme/space%20repo/pulls/1",
    );
  });

  it("a bare name, dot segments, or empty segments have no PR page", () => {
    expect(
      forgePullUrl("justname", 1, "https://forge.invalid"),
    ).toBeUndefined();
    expect(
      forgePullUrl("../escape", 1, "https://forge.invalid"),
    ).toBeUndefined();
    expect(
      forgePullUrl("/leading", 1, "https://forge.invalid"),
    ).toBeUndefined();
  });

  it("a live session's PR cell links into the forge and offers the re-request", () => {
    const container = mount(pageTemplate(page({ sessions: [liveSession()] })));
    const links = container.querySelectorAll<HTMLAnchorElement>(
      'td a[href="https://forge.invalid/acme/widget/pulls/1"]',
    );
    // One link on the identity, one on the affordance.
    expect(links).toHaveLength(2);
    expect(links[1]?.textContent).toBe("request review again");
  });

  it("a settled run links without the affordance", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            {
              ts: "2026-11-16T11:00:00.000Z",
              repo: "acme/widget",
              pr: 2,
              outcome: "posted",
              verdict: "APPROVE",
              phases: [],
              wallSeconds: 300,
            },
          ],
        }),
      ),
    );
    const links = container.querySelectorAll<HTMLAnchorElement>("td a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://forge.invalid/acme/widget/pulls/2",
    );
  });
});

describe("the live rows' rendering", () => {
  it("a running row's chip names the state and its age from the ledger's stamp", () => {
    const container = mount(pageTemplate(page({ sessions: [liveSession()] })));
    const chip = container.querySelector("tbody .chip.ok");
    expect(chip?.textContent).toMatch(/^running /);
  });

  it("a queued row reads parked and names what it is waiting for", () => {
    const container = mount(
      pageTemplate(
        page({
          sessions: [liveSession({ stage: "queued", startedAtMs: undefined })],
        }),
      ),
    );
    expect(container.querySelector(".chip.warn")?.textContent).toBe("parked");
    expect(container.textContent).toContain("waiting for a free review slot");
  });

  it("a row with no session yet renders the placeholder, and no log block", () => {
    const container = mount(
      pageTemplate(
        page({
          sessions: [liveSession({ sessionId: undefined, log: undefined })],
        }),
      ),
    );
    expect(container.textContent).toContain("no session yet");
    expect(
      container.querySelectorAll("details[data-log-session]"),
    ).toHaveLength(0);
  });

  it("a parked session with an empty log says so instead of implying a log", () => {
    const container = mount(
      pageTemplate(
        page({
          sessions: [
            liveSession({
              log: { state: "found", text: "", truncated: false },
            }),
          ],
        }),
      ),
    );
    expect(container.textContent).toContain(
      "the session stands, but has recorded nothing yet",
    );
  });
});

describe("the PRJ-547 full-width log block", () => {
  it("the expanded block renders full-width beneath its row, keyed to the session, with the pin control", () => {
    const block = liveLogUnder(liveSession());
    expect(block).not.toBeNull();
    const container = mount(pageTemplate(page({ sessions: [liveSession()] })));
    const details = container.querySelector("details[data-log-session]");
    expect(details?.getAttribute("data-log-session")).toBe("sess-live");
    // The under-row spans every column.
    const under = container.querySelector("tr.row-log td");
    expect(under?.getAttribute("colspan")).toBe("6");
    // The pin control rides the block; the body is the refresh point.
    expect(details?.querySelector(".log-pin-box")).toBeTruthy();
    expect(details?.querySelector(".log-body")).toBeTruthy();
    // The glance stays in the cell: the newest activity's first line,
    // in the log column (the table's last).
    expect(
      container.querySelector("tr:not(.row-log) td:last-child .muted.small")
        ?.textContent,
    ).toBe("[10:00:02] reviewer: on it");
  });

  it("the capped log labels the cut", () => {
    const container = mount(
      logBody({
        state: "found",
        text: "the turns",
        truncated: true,
      }),
    );
    expect(container.textContent).toContain(
      "the log is capped at the page's 64KiB; its oldest turns are cut",
    );
    // The formatted log box rides the note; the text is inside it.
    expect(container.querySelector(".transcript-body")?.textContent).toContain(
      "the turns",
    );
  });

  it("the gone and unreadable states name the fact without the sweeper", () => {
    expect(renderToText(transcriptStateNote({ state: "swept" }))).toContain(
      "the session is gone — the log is not available",
    );
    expect(
      renderToText(transcriptStateNote({ state: "unavailable" })),
    ).toContain("the log could not be read right now");
  });

  it("a live row with nothing to expand renders no second row", () => {
    const container = mount(
      pageTemplate(
        page({
          sessions: [liveSession({ sessionId: undefined, log: undefined })],
        }),
      ),
    );
    expect(container.querySelectorAll("tr.row-log")).toHaveLength(0);
  });
});

const renderToText = (template: unknown): string => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(template as never, container);
  return container.textContent ?? "";
};

describe("the failed report", () => {
  const failedRun = (
    over: Partial<PageData["runs"][number]> = {},
  ): PageData["runs"][number] => ({
    ts: "2026-11-16T10:00:00.000Z",
    repo: "acme/widget",
    pr: 7,
    outcome: "failed",
    verdict: null,
    phases: [{ phase: "context", durationMs: 40 }],
    wallSeconds: 120,
    failure: {
      stage: "context",
      message: "context draft failed validation twice",
    },
    ...over,
  });

  it("a seeded failed run renders each draft's stage, attempt, refusal, and escaped reply", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            failedRun({
              failedDrafts: [
                {
                  stage: "context",
                  attempt: 0,
                  reply: '{"verdict":',
                  parseError: "unexpected token <end> at position 12",
                  truncated: false,
                },
                {
                  stage: "humanize",
                  attempt: 1,
                  reply:
                    '<script>alert("draft")</script> https://user:hunter2-draft@forge.invalid/x',
                  truncated: false,
                },
              ],
            }),
          ],
        }),
      ),
    );
    expect(container.textContent).toContain(
      "context draft failed validation twice",
    );
    const heads = container.querySelectorAll(".draft .chip.mute");
    expect([...heads].map((chip) => chip.textContent)).toEqual([
      "context",
      "humanize",
    ]);
    expect(container.textContent).toContain("attempt 0");
    expect(container.textContent).toContain("attempt 1");
    // The parse refusal renders, escaped.
    expect(container.textContent).toContain(
      "unexpected token <end> at position 12",
    );
    // The draft is model output: markup renders as text — never executes.
    expect(container.querySelector(".draft-reply")?.innerHTML).not.toContain(
      "<script>alert",
    );
    expect(container.textContent).toContain(
      '<script>alert("draft")</script> https://user:hunter2-draft@forge.invalid/x',
    );
    // Exactly the failed run's two drafts; a clean run contributed none.
    expect(container.querySelectorAll(".draft")).toHaveLength(2);
  });

  it("a truncated draft renders the capped text with the chip labeled", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            failedRun({
              failedDrafts: [
                {
                  stage: "context",
                  attempt: 0,
                  reply: `${"z".repeat(64)}[truncated by the draft cap]`,
                  truncated: true,
                },
              ],
            }),
          ],
        }),
      ),
    );
    const warn = [...container.querySelectorAll(".chip.warn")];
    expect(warn.map((chip) => chip.textContent)).toEqual(["truncated"]);
  });

  it("a failed run's frozen transcript renders beneath the row, without pin or refresh key", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            failedRun({
              sessionId: "sess-frozen",
              transcript: {
                state: "found",
                text: "user: review this",
                truncated: false,
              },
            }),
          ],
        }),
      ),
    );
    expect(container.textContent).toContain("reviewer session log");
    // No session key and no pin: the frozen log never changes.
    expect(
      container.querySelectorAll("details[data-log-session]"),
    ).toHaveLength(0);
    expect(container.querySelectorAll(".log-pin-box")).toHaveLength(0);
  });

  it("a swept failed session's note names the fact without the sweeper", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [failedRun({ transcript: { state: "swept" } })],
        }),
      ),
    );
    expect(container.textContent).toContain(
      "the session is gone — the log is not available",
    );
    expect(container.querySelectorAll("details")).toHaveLength(0);
  });

  it("a clean run renders its verdict chip and no failure", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            {
              ts: "2026-11-16T11:00:00.000Z",
              repo: "acme/widget",
              pr: 1,
              outcome: "posted",
              verdict: "APPROVE",
              phases: [],
              wallSeconds: 300,
            },
          ],
        }),
      ),
    );
    expect(container.querySelector("tbody .chip.ok")?.textContent).toBe(
      "APPROVE",
    );
    expect(container.querySelectorAll(".draft")).toHaveLength(0);
  });
});

describe("the page's panels", () => {
  it("the read arrives in order: health, running, runs, dropped, narration, config", () => {
    const container = mount(pageTemplate(page()));
    const positions = [
      "Health",
      "Running now",
      "Recent review runs",
      "Review starts a restart dropped",
      "Bot narration",
      "Configuration",
    ].map((marker) => container.textContent?.indexOf(marker) ?? -1);
    expect(positions).not.toContain(-1);
    for (let n = 1; n < positions.length; n++) {
      expect(positions[n]).toBeGreaterThan(positions[n - 1] ?? 0);
    }
  });

  it("the honest empty states on a fresh boot", () => {
    const container = mount(pageTemplate(page()));
    expect(container.textContent).toContain("Nothing running right now.");
    expect(container.textContent).toContain("No runs yet.");
    expect(container.textContent).toContain(
      "None. Every start the journal holds, settled.",
    );
    expect(container.textContent).toContain("Nothing said yet this boot.");
  });

  it("the health line reads the adapter's reachability", () => {
    const up = mount(pageTemplate(page({ adapterReachable: true })));
    expect(up.textContent).toContain("adapter reachable");
    expect(up.textContent).not.toContain("adapter unreachable");
    const down = mount(pageTemplate(page({ adapterReachable: false })));
    expect(down.textContent).toContain("adapter unreachable");
  });

  it("the dropped starts' copy names the free re-request", () => {
    const container = mount(
      pageTemplate(
        page({
          droppedStarts: {
            count: 1,
            starts: [
              {
                eventId: "evt-dropped",
                repo: "acme/widget",
                pr: 9,
                eventKind: "review_requested",
                acceptedAt: "2026-11-16T09:00:00.000Z",
              },
            ],
          },
        }),
      ),
    );
    expect(container.textContent).toContain("A re-request re-runs them free");
  });

  it("the wall time renders the human form each run's seconds make", () => {
    const container = mount(
      pageTemplate(
        page({
          runs: [
            {
              ts: "2026-11-16T11:00:00.000Z",
              repo: "acme/widget",
              pr: 1,
              outcome: "posted",
              verdict: "APPROVE",
              phases: [],
              wallSeconds: 14400,
            },
            {
              ts: "2026-11-16T11:00:00.000Z",
              repo: "acme/widget",
              pr: 2,
              outcome: "posted",
              verdict: null,
              phases: [],
              wallSeconds: 330,
            },
            {
              ts: "2026-11-16T11:00:00.000Z",
              repo: "acme/widget",
              pr: 3,
              outcome: "failed",
              verdict: null,
              phases: [],
              wallSeconds: 0,
            },
          ],
        }),
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("4h");
    expect(text).toContain("5m 30s");
    expect(text).toContain("<1s");
  });

  it("the narration tail renders the bot's lines oldest first, as text", () => {
    const container = mount(
      pageTemplate(
        page({
          log: [
            "zenigata: intake listening on port 8471",
            "<script>alert('log')</script>",
          ],
        }),
      ),
    );
    expect(container.querySelector(".log-tail")?.innerHTML).not.toContain(
      "<script>alert",
    );
    expect(container.textContent).toContain(
      "zenigata: intake listening on port 8471",
    );
  });

  it("the config echo lists the configured values, with the 0-port and no-allowlist wordings", () => {
    const container = mount(pageTemplate(page()));
    const text = container.textContent ?? "";
    expect(text).toContain("0 (the OS picks the port)");
    expect(text).toContain("no allowlist (every repository)");
    expect(text).toContain("zenigata-reviewer");
    expect(text).toContain("https://forge.invalid");
  });
});

describe("the footer's notifications control", () => {
  /** The footer control is the app's refresh point: shell, then hydrate. */
  const mountHydrated = (
    notifyState: "on" | "off" | "unsupported",
  ): HTMLElement => {
    const p = page();
    const container = mount(pageTemplate(p));
    hydratePage(p, container, notifyState, () => {});
    return container;
  };

  it("off offers the turn-on control; on reads quiet; unsupported names the browser", () => {
    const off = mountHydrated("off");
    expect(off.querySelector("footer button")?.textContent).toContain(
      "notifications off — turn on",
    );
    const on = mountHydrated("on");
    expect(on.textContent).toContain("notifications on");
    expect(on.querySelector("footer button")).toBeNull();
    const unsupported = mountHydrated("unsupported");
    expect(unsupported.textContent).toContain(
      "notifications not available in this browser",
    );
  });

  it("the control renders exactly one state — never a second copy beside the first", () => {
    const off = mountHydrated("off");
    const control = off.querySelector(".notify-control")!;
    expect(control.querySelectorAll("button")).toHaveLength(1);
    // The app's enable path re-renders into the same span; the ownership
    // rule (one renderer, render() alone) keeps it a replacement.
    hydratePage(page(), off, "on", () => {});
    expect(control.querySelectorAll("button")).toHaveLength(0);
    expect(control.children).toHaveLength(1);
    expect(control.textContent).toContain("notifications on");
  });
});
