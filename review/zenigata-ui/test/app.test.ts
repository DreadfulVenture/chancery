/**
 * The status page app's behavior: the poll loop, the notification
 * consumption, and the live log's in-place refresh (PRJ-547) — the
 * 30s fragment cadence, the stale-drop epoch, and the pin's two scroll
 * modes — driven against fakes, the same modules the browser bundle
 * carries.
 */

import { describe, expect, it, vi } from "vitest";
import { StatusPageApp, type PageEnvironment } from "../src/client/app.js";
import {
  FinishNotifier,
  type FinishNotice,
  type NotificationSink,
  type SeenStore,
} from "../src/notifier.js";
import type { PageData, TranscriptView } from "../src/page-feed.js";

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

const liveSession = (over: Partial<PageData["sessions"][number]> = {}) => ({
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
    state: "found" as const,
    text: "old turns",
    truncated: false,
    latest: "old turns",
  },
  ...over,
});

const silentSink = (): NotificationSink => ({
  supported: () => true,
  permission: () => "granted",
  request: async () => "granted",
  deliver: () => true,
});

const noopStore = (): SeenStore => {
  const held = new Set<string>();
  return {
    read: () => [...held],
    write: (ids) => {
      held.clear();
      for (const id of ids) held.add(id);
    },
  };
};

const app = (
  container: HTMLElement,
  env: Partial<PageEnvironment> = {},
  pollMs = 30_000,
): StatusPageApp =>
  new StatusPageApp(
    container,
    {
      fetchPage: vi.fn().mockResolvedValue(page()),
      fetchLog: vi.fn().mockResolvedValue(null),
      notifier: new FinishNotifier(noopStore(), silentSink()),
      ...env,
    },
    pollMs,
  );

describe("the poll loop", () => {
  it("one poll renders the page and consumes the notifications", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const delivered: FinishNotice[] = [];
    const sink: NotificationSink = {
      ...silentSink(),
      deliver: (notice) => {
        delivered.push(notice);
        return true;
      },
    };
    const notifier = new FinishNotifier(noopStore(), sink);
    const env: PageEnvironment = {
      fetchPage: vi.fn().mockResolvedValue(
        page({
          runs: [
            {
              ts: "t",
              repo: "acme/widget",
              pr: 1,
              outcome: "posted",
              verdict: "APPROVE",
              phases: [],
              wallSeconds: 1,
            },
          ],
        }),
      ),
      fetchLog: vi.fn().mockResolvedValue(null),
      notifier,
    };
    const a = app(container, env);
    await a.poll();
    expect(env.fetchPage).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    // The page rendered: the settled run's verdict chip is in the table.
    expect(container.querySelector("tbody .chip.ok")?.textContent).toBe(
      "APPROVE",
    );
  });

  it("a failed fetch leaves the page as it is, and the next poll retries", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let fail = true;
    const env: PageEnvironment = {
      fetchPage: vi.fn(() =>
        fail
          ? Promise.reject(new Error("the intake is unreachable"))
          : Promise.resolve(page()),
      ),
      fetchLog: vi.fn().mockResolvedValue(null),
      notifier: new FinishNotifier(noopStore(), silentSink()),
    };
    const a = app(container, env);
    await a.poll();
    expect(container.textContent ?? "").toBe("");
    fail = false;
    await a.poll();
    expect(container.textContent).toContain("Nothing running right now.");
  });

  it("the polls never re-render the page: open and pinned state survive them", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const a = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
    });
    await a.poll();
    const block = container.querySelector("details[data-log-session]")!;
    block.open = true;
    const box = container.querySelector<HTMLInputElement>(".log-pin-box")!;
    box.checked = false;
    await a.poll();
    // The same element stands: open state and pin state are DOM state.
    expect(container.querySelector("details[data-log-session]")).toBe(block);
    expect(block.open).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>(".log-pin-box")!.checked,
    ).toBe(false);
  });
});

describe("the live log's refresh (PRJ-547)", () => {
  /** Boot the app with a live row, open its block, and return the handles. */
  const bootedWithOpenBlock = async (env: Partial<PageEnvironment> = {}) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const a = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      ...env,
    });
    await a.poll();
    const block = container.querySelector("details[data-log-session]")!;
    block.open = true;
    return { container, app: a, block };
  };

  it("an open block fetches its view on the poll cadence and swaps the body in place", async () => {
    const { container, block } = await bootedWithOpenBlock();
    const env = {
      fetchLog: vi.fn().mockResolvedValue({
        state: "found",
        text: "old turns\n\nnew turn",
        truncated: false,
      }),
    };
    // Rebuild with the fetching env: the boot poll already rendered.
    const b = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      fetchLog: env.fetchLog,
    });
    await b.poll();
    expect(env.fetchLog).toHaveBeenCalledWith("sess-live");
    const body = block.querySelector(".log-body")!;
    // The block's own shell survives the swap: summary and pin stay.
    expect(body.parentElement!.querySelector(".log-pin-box")).toBeTruthy();
    expect(body.textContent).toContain("new turn");
  });

  it("a not-found answer (settled or swept session) keeps the block as it is", async () => {
    const { container, block } = await bootedWithOpenBlock();
    const b = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      fetchLog: vi.fn().mockResolvedValue(null),
    });
    await b.poll();
    expect(block.querySelector(".log-body")?.textContent).toContain(
      "old turns",
    );
  });

  it("a stale fetch's answer never lands: the per-block epoch drops it", async () => {
    const { container } = await bootedWithOpenBlock();
    let lateResolve: ((view: TranscriptView | null) => void) | undefined;
    const lateAnswer = new Promise<TranscriptView | null>((resolve) => {
      lateResolve = resolve;
    });
    const fetchLog = vi
      .fn<(sessionId: string) => Promise<TranscriptView | null>>()
      .mockImplementationOnce(() => lateAnswer)
      .mockImplementationOnce(() =>
        Promise.resolve({
          state: "found",
          text: "fresh text",
          truncated: false,
        }),
      );
    const b = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      fetchLog,
    });
    // Two overlapping polls: the first fetch hangs; the second answers
    // and swaps; the late first answer must never land.
    const first = b.poll();
    await b.poll();
    lateResolve?.({ state: "found", text: "stale text", truncated: false });
    await first;
    expect(container.querySelector(".log-body")?.textContent).toContain(
      "fresh text",
    );
    expect(container.querySelector(".log-body")?.textContent).not.toContain(
      "stale text",
    );
  });

  it("pinned, the swap rides the tail; unpinned, the reading line carries over", async () => {
    const { container, block } = await bootedWithOpenBlock();
    const tailWrites: number[] = [];
    const pre = block.querySelector<HTMLElement>(".transcript-body")!;
    Object.defineProperty(pre, "scrollTop", {
      get: () => 0,
      set: (v: number) => tailWrites.push(v),
      configurable: true,
    });
    Object.defineProperty(pre, "scrollHeight", {
      get: () => 4242,
      configurable: true,
    });
    const b = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      fetchLog: vi.fn().mockResolvedValue({
        state: "found",
        text: "old turns\n\nnewer turn",
        truncated: false,
      }),
    });
    await b.poll();
    // Pinned (the rendered default): the fresh pre's scrollTop jumped
    // to its scrollHeight.
    expect(tailWrites).toContain(4242);

    // Unpin: the swap carries the old pre's scrollTop instead.
    const box = block.querySelector<HTMLInputElement>(".log-pin-box")!;
    box.checked = false;
    tailWrites.length = 0;
    await b.poll();
    expect(tailWrites).toEqual([0]);
  });

  it("re-checking the pin jumps to the tail at once", async () => {
    const { block } = await bootedWithOpenBlock();
    const pre = block.querySelector<HTMLElement>(".transcript-body")!;
    Object.defineProperty(pre, "scrollHeight", {
      get: () => 4242,
      configurable: true,
    });
    const box = block.querySelector<HTMLInputElement>(".log-pin-box")!;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(pre.scrollTop).toBe(4242);
  });

  it("a collapsed block stays as rendered", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const fetchLog = vi.fn().mockResolvedValue({
      state: "found",
      text: "fresh",
      truncated: false,
    });
    const a = app(container, {
      fetchPage: vi.fn().mockResolvedValue(page({ sessions: [liveSession()] })),
      fetchLog,
    });
    await a.poll();
    expect(fetchLog).not.toHaveBeenCalled();
  });
});
