/**
 * The opencode session driver against a loopback fake of the 2.2.5 HTTP
 * surface (127.0.0.1 only). The fake serves the routes the driver calls —
 * create, prompt, message list, interrupt, remove — and records every hit,
 * so the turn-barrier behavior is judged from real requests: prompt fires
 * the prompt endpoint and settles through short state reads, never the
 * experimental wait.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  createServer,
  type AddressInfo,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  opencodeSessionDriver,
  turnSettled,
} from "../src/adapters/opencode.js";
import type { SessionDriver } from "../src/contracts/session.js";

type ListPage = {
  data: Array<{
    type: string;
    time: { created: number };
    content?: Array<{ type: string; text: string }>;
  }>;
};
/** One stage per poll: a page, or a status code to fail the read with. */
type Stage = number | ((userMs: number) => ListPage);

interface FakeOpencode {
  url: string;
  hits: Array<{ method: string; path: string }>;
  interrupted: number;
  /** The user item time of the latest prompt, per session. */
  userMs(): number;
  setStages(sessionKey: string, stages: Stage[]): void;
  close(): Promise<void>;
}

const BASE_MS = 1_000_000;

async function fakeOpencode(
  options: { promptStatus?: number } = {},
): Promise<FakeOpencode> {
  const hits: Array<{ method: string; path: string }> = [];
  const stages = new Map<string, Stage[]>();
  const cursors = new Map<string, number>();
  let userCounter = 0;
  let interrupted = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.push({ method: request.method ?? "", path: url.pathname });
      const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(
        url.pathname,
      );
      const listMatch = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
      const interruptMatch = /^\/api\/session\/([^/]+)\/interrupt$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && url.pathname === "/api/session") {
        respondJson(response, { data: { id: "ses-fake-1" } });
        return;
      }
      if (request.method === "POST" && promptMatch) {
        const status = options.promptStatus ?? 200;
        if (status !== 200) {
          respondJson(response, { error: "forced" }, status);
          return;
        }
        userCounter += 1;
        respondJson(response, {
          data: {
            id: `msg-user-${userCounter}`,
            sessionID: promptMatch[1],
            time: { created: BASE_MS + userCounter * 10_000 },
            type: "user",
          },
        });
        cursors.set(promptMatch[1], 0);
        return;
      }
      if (request.method === "GET" && listMatch) {
        const sessionKey = listMatch[1];
        const list = stages.get(sessionKey) ?? [];
        const cursor = cursors.get(sessionKey) ?? 0;
        cursors.set(sessionKey, Math.min(cursor + 1, list.length));
        // Past the stage list the last stage repeats, so settle tests do
        // not depend on the poll count.
        const stage = list[Math.min(cursor, list.length - 1)];
        if (stage === undefined) {
          respondJson(response, { data: [], cursor: {} }, 404);
          return;
        }
        if (typeof stage === "number") {
          // A 404 read answers the tagged session error like the service
          // would; other forced statuses answer a bare body.
          respondJson(
            response,
            stage === 404
              ? { _tag: "SessionNotFoundError", message: "session not found" }
              : { error: "forced" },
            stage,
          );
          return;
        }
        respondJson(response, stage(userCounter * 10_000 + BASE_MS));
        return;
      }
      if (request.method === "POST" && interruptMatch) {
        interrupted += 1;
        respondJson(response, null, 204);
        return;
      }
      if (
        request.method === "DELETE" &&
        /^\/api\/session\//.test(url.pathname)
      ) {
        respondJson(response, null, 204);
        return;
      }
      // The 2.2.5 generated error shape: the service's tagged error body,
      // surfaced by the promise client's declared-status path as the
      // error's name.
      respondJson(
        response,
        { _tag: "SessionNotFoundError", message: "session not found" },
        404,
      );
    })().catch(() => {
      if (!response.headersSent) {
        respondJson(response, { error: "handler failed" }, 500);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    get interrupted() {
      return interrupted;
    },
    userMs: () => BASE_MS + userCounter * 10_000,
    setStages: (sessionKey, list) => stages.set(sessionKey, list),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function respondJson(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const busyPage = (userMs: number): ListPage => ({
  data: [
    { type: "assistant", time: { created: userMs + 5000 } },
    { type: "user", time: { created: userMs } },
  ],
});

const idlePage = (userMs: number): ListPage => ({
  data: [
    { type: "idle", time: { created: userMs + 9000 } },
    { type: "user", time: { created: userMs } },
  ],
});

/** A driver on virtual time: each poll tick advances the clock deterministically. */
async function harnessDriver(
  fake: FakeOpencode,
  over: {
    pollSeconds?: number;
    budgetSeconds?: number;
  } = {},
): Promise<{ driver: SessionDriver }> {
  let vclock = BASE_MS;
  const driver = opencodeSessionDriver({
    baseUrl: fake.url,
    turnPollSeconds: over.pollSeconds ?? 0.01,
    turnBudgetSeconds: over.budgetSeconds ?? 60,
    clock: () => vclock,
    sleep: async (ms: number) => {
      vclock += ms;
    },
  });
  return { driver };
}

const fakes: FakeOpencode[] = [];

afterAll(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

describe("opencode session driver over the wire", () => {
  it("prompt fires the prompt endpoint and settles through state reads, with no wait call", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [idlePage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(
      driver.prompt(sessionId, "review this"),
    ).resolves.toBeUndefined();

    const paths = fake.hits.map((h) => h.path);
    expect(paths).toContain("/api/session");
    expect(paths).toContain("/api/session/ses-fake-1/prompt");
    expect(paths).toContain("/api/session/ses-fake-1/message");
    expect(paths.some((p) => p.endsWith("/wait"))).toBe(false);
  });

  it("the turn loop keeps polling while the session stays busy", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [busyPage, busyPage, idlePage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await driver.prompt(sessionId, "review this");
    const listCalls = fake.hits.filter(
      (h) => h.path === "/api/session/ses-fake-1/message",
    ).length;
    expect(listCalls).toBe(3);
  });

  it("a failed state read retries on the next tick", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    // One failed read, then a page carrying the turn's idle marker.
    fake.setStages("ses-fake-1", [500, 500, idlePage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(
      driver.prompt(sessionId, "review this"),
    ).resolves.toBeUndefined();
  });

  it("budget exhaustion interrupts the stuck turn and fails the prompt", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, {
      budgetSeconds: 0.05,
    });
    fake.setStages("ses-fake-1", [busyPage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /budget/,
    );
    expect(fake.interrupted).toBe(1);
  });

  it("transport death on the prompt stops the turn and surfaces the failure", async () => {
    const fake = await fakeOpencode({ promptStatus: 500 });
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow();
    expect(fake.interrupted).toBe(1);
  });

  it("a vanished session fails the prompt instead of polling out the budget", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, { budgetSeconds: 60 });
    fake.setStages("ses-fake-1", [404]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /disappeared/,
    );
    // Failed fast: one list call, no interrupt — there is no turn left.
    const listCalls = fake.hits.filter(
      (h) => h.path === "/api/session/ses-fake-1/message",
    ).length;
    expect(listCalls).toBe(1);
    expect(fake.interrupted).toBe(0);
  });

  it("turns on the same session settle per prompt, keyed on the queued user item", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    // Each turn's stages replay from its own queued item; the idle of an
    // earlier turn (created before the new user item) never settles the
    // next turn.
    fake.setStages("ses-fake-1", [busyPage, idlePage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await driver.prompt(sessionId, "first");
    await driver.prompt(sessionId, "second");
    const listCalls = fake.hits.filter(
      (h) => h.path === "/api/session/ses-fake-1/message",
    ).length;
    // Two polls per turn: each turn needed its own busy page first.
    expect(listCalls).toBe(4);
  });

  it("dispose removes the session through the delete endpoint", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await driver.dispose(sessionId);
    expect(fake.hits.some((h) => h.method === "DELETE")).toBe(true);
  });

  it("readOutput joins the newest assistant text and repeats as empty", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    fake.setStages("ses-fake-1", [
      () => ({
        data: [
          {
            type: "assistant",
            id: "msg-a-1",
            content: [
              { type: "text", text: "finding one" },
              { type: "text", text: "finding two" },
            ],
          },
        ],
      }),
    ]);
    const { driver } = await harnessDriver(fake);
    await expect(driver.readOutput("ses-fake-1")).resolves.toBe(
      "finding one\nfinding two",
    );
    await expect(driver.readOutput("ses-fake-1")).resolves.toBe("");
  });
});

describe("turnSettled", () => {
  const userMs = 1000;

  it("settles on the idle marker after the user item", () => {
    expect(
      turnSettled(
        [
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        userMs,
      ),
    ).toBe(true);
  });

  it("stays busy while the assistant streams and on a tool-call handoff", () => {
    expect(
      turnSettled(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 100 },
            finish: "tool-calls",
          },
        ],
        userMs,
      ),
    ).toBe(false);
    expect(
      turnSettled(
        [{ type: "assistant", time: { created: userMs + 5000 } }],
        userMs,
      ),
    ).toBe(false);
  });

  it("settles on the completed non-tool-call assistant fallback", () => {
    expect(
      turnSettled(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 200 },
            finish: "stop",
          },
        ],
        userMs,
      ),
    ).toBe(true);
  });

  it("stays busy on a scheduled retry and settles on a failed step", () => {
    expect(
      turnSettled(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 200 },
            finish: "error",
            retry: { attempt: 2 },
          },
        ],
        userMs,
      ),
    ).toBe(false);
    expect(
      turnSettled(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 200 },
            error: { message: "boom" },
          },
        ],
        userMs,
      ),
    ).toBe(true);
  });

  it("ignores markers from before the queued user item", () => {
    expect(
      turnSettled([{ type: "idle", time: { created: userMs - 10 } }], userMs),
    ).toBe(false);
  });
});

describe("opencode transcript read", () => {
  it("maps the session's user and assistant messages into oldest-first turns", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          {
            type: "assistant",
            time: { created: userMs + 6000 },
            content: [{ type: "text", text: "the review says no" }],
          },
          {
            type: "user",
            time: { created: userMs },
            content: [{ type: "text", text: "review this diff" }],
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", text: "review this diff" },
      { role: "assistant", text: "the review says no" },
    ]);
  });

  it("ignores the bookkeeping records and joins the text parts", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          { type: "idle", time: { created: userMs + 9000 } },
          {
            type: "assistant",
            time: { created: userMs + 6000 },
            content: [
              { type: "text", text: "part one" },
              { type: "other", text: "not text" },
              { type: "text", text: "part two" },
            ],
          },
          {
            type: "user",
            time: { created: userMs },
            content: [{ type: "text", text: "prompt" }],
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", text: "prompt" },
      { role: "assistant", text: "part one\npart two" },
    ]);
  });

  it("a read for a session the runtime no longer holds fails the read", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [404]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).rejects.toThrow(
      /session not found/i,
    );
  });
});
