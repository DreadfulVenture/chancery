/**
 * The opencode session driver against a loopback fake of the 2.3.x HTTP
 * surface (127.0.0.1 only). The fake serves the routes the driver calls —
 * create, prompt, message list, the experimental job list, interrupt,
 * remove — and records every hit, so the turn-barrier behavior is judged
 * from real requests: prompt fires the prompt endpoint and settles through
 * short state reads, never the experimental wait.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  createServer,
  type AddressInfo,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { opencodeSessionDriver, turnOpen } from "../src/adapters/opencode.js";
import type { SessionDriver } from "../src/contracts/session.js";

type ListPage = {
  data: Array<{
    type: string;
    time: { created: number };
    content?: Array<{
      type: string;
      text: string;
      name?: string;
      state?: unknown;
      time?: { created: number };
    }>;
    /** The real 2.3.0 User record's top-level prompt field. */
    text?: string;
  }>;
};
/** One stage per poll: a page, or a status code to fail the read with. */
type Stage = number | ((userMs: number) => ListPage);

/** One stage per job-list poll: a job list, or a status code to fail with
 * (404 answers the real serve's bare absent-route form, an empty body;
 * any other number answers a JSON error), or an explicit answer with a
 * body of the harness's choosing. */
interface JobAnswer {
  status: number;
  body?: unknown;
  contentType?: string;
}
type JobStage =
  | number
  | JobAnswer
  | ((userMs: number) => Array<Record<string, unknown>>);

interface FakeOpencode {
  url: string;
  hits: Array<{ method: string; path: string }>;
  /** The parsed request body of every create call, in request order. */
  createBodies: Array<Record<string, unknown>>;
  interrupted: number;
  /** The user item time of the latest prompt, per session. */
  userMs(): number;
  setStages(sessionKey: string, stages: Stage[]): void;
  setJobs(sessionKey: string, stages: JobStage[]): void;
  close(): Promise<void>;
}

const BASE_MS = 1_000_000;

/** The request body of one JSON POST, parsed for assertions. */
const readJsonBody = (
  request: IncomingMessage,
): Promise<Record<string, unknown>> =>
  new Promise((resolveBody) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolveBody({});
      }
    });
  });

async function fakeOpencode(
  options: { promptStatus?: number } = {},
): Promise<FakeOpencode> {
  const hits: Array<{ method: string; path: string }> = [];
  const createBodies: Array<Record<string, unknown>> = [];
  const stages = new Map<string, Stage[]>();
  const jobStages = new Map<string, JobStage[]>();
  const jobCursors = new Map<string, number>();
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
        createBodies.push(await readJsonBody(request));
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
      if (
        request.method === "GET" &&
        url.pathname === "/api/experimental/job"
      ) {
        // The body shape is the v2.3.0 route's own envelope:
        // `GET /api/experimental/job` answers `{ data: Array<Job.Info> }`
        // with no cursor (packages/protocol/src/groups/job.ts), and the
        // client SDK unwraps `.data` — so the wire tests exercise the
        // endpoint's real shape, and a wrong-shaped fake turns red under
        // the failed-read rule.
        const sessionKey = url.searchParams.get("sessionID") ?? "ses-fake-1";
        const list = jobStages.get(sessionKey);
        if (list === undefined) {
          // No scripted job stages: the serve answers the healthy empty
          // list the 2.3.x endpoint returns between background work.
          respondJson(response, { data: [] });
          return;
        }
        const cursor = jobCursors.get(sessionKey) ?? 0;
        jobCursors.set(sessionKey, Math.min(cursor + 1, list.length));
        const stage = list[Math.min(cursor, list.length - 1)];
        if (stage === undefined) {
          respondJson(response, { data: [] });
          return;
        }
        if (typeof stage === "number") {
          if (stage === 404) {
            // The real absent-route answer, verified against the packaged
            // v2.3.0 serve: a bare 404 with an empty body.
            response.writeHead(404);
            response.end();
            return;
          }
          respondJson(response, { error: "forced" }, stage);
          return;
        }
        if (!("data" in stage) && typeof stage !== "function") {
          // An explicit JobAnswer: the status and body (content type
          // included) the test scripts, e.g. an undecodable HTML error
          // page from a middlebox.
          const answer = stage as JobAnswer;
          const contentType = answer.contentType ?? "application/json";
          response.writeHead(answer.status, { "content-type": contentType });
          response.end(
            typeof answer.body === "string"
              ? answer.body
              : JSON.stringify(answer.body ?? null),
          );
          return;
        }
        respondJson(response, { data: stage(userCounter * 10_000 + BASE_MS) });
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
    createBodies,
    get interrupted() {
      return interrupted;
    },
    userMs: () => BASE_MS + userCounter * 10_000,
    setStages: (sessionKey, list) => stages.set(sessionKey, list),
    setJobs: (sessionKey, list) => {
      jobCursors.delete(sessionKey);
      jobStages.set(sessionKey, list);
    },
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

/** One 2.3.x-shaped subagent job, as GET /api/experimental/job returns it
 * (inside the route's `data` envelope). */
const jobList = (status: string) => (): Array<Record<string, unknown>> => [
  {
    kind: "subagent",
    id: "job-1",
    sessionID: "ses-fake-1",
    status,
    time: {
      started: BASE_MS + 5,
      completed: status === "running" ? undefined : BASE_MS + 9,
    },
    childSessionID: "ses-child-1",
    agent: "reviewer-child",
    description: "the blind pass",
  },
];

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
  it("declares the runtime's origin in the create call's metadata", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [idlePage]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    expect(sessionId).toBe("ses-fake-1");

    expect(fake.createBodies).toHaveLength(1);
    const body = fake.createBodies[0];
    // The accepted contract (review 589, count 18597): the create always
    // carries the record — initiator "program", parent null, the
    // parentless-program declaration. The consumer's originRecordOf now
    // parses the explicit null (the rejection side — a missing parent
    // key, a blank parent, a foreign initiator word — stays on the human
    // default, pinned in the memory client's suites, which the origin
    // contract test ties to this shape mechanically).
    expect(body?.metadata).toEqual({
      chancery_origin: { initiator: "program", parent: null },
    });
    expect(body?.agent).toBe("reviewer");
    expect(body?.location).toEqual({ directory: "/work/tree" });
  });

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

  it("a failed job read never settles; the tick retries until the list answers", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [500, 500, () => []]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(
      driver.prompt(sessionId, "review this"),
    ).resolves.toBeUndefined();
    // The turn settled only on the third job read, after two failures:
    // silence from a failed read is never "empty".
    const jobCalls = fake.hits.filter(
      (h) => h.path === "/api/experimental/job",
    ).length;
    expect(jobCalls).toBe(3);
    const listCalls = fake.hits.filter(
      (h) => h.path === "/api/session/ses-fake-1/message",
    ).length;
    expect(listCalls).toBe(3);
  });

  it("settles only on a job list the serve answered empty after the settled page", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    // The first job read answers a completed-but-unconsumed job (the
    // report-delivery race), the second answers empty: only that read
    // settles the turn, and it is the tick's last read.
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [jobList("completed"), () => []]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(
      driver.prompt(sessionId, "review this"),
    ).resolves.toBeUndefined();
    const tail = fake.hits.slice(-2).map((h) => h.path);
    expect(tail[0]).toMatch(/\/session\/ses-fake-1\/message$/);
    expect(tail[1]).toBe("/api/experimental/job");
    const jobCalls = fake.hits.filter(
      (h) => h.path === "/api/experimental/job",
    ).length;
    expect(jobCalls).toBe(2);
  });

  it("an absent job endpoint (the bare 404) retries to the budget with the may-be-broken diagnosis", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, { budgetSeconds: 0.05 });
    // The real serve's absent route answers a bare 404 with an empty
    // body; the SDK loses the status there, so the driver cannot pin the
    // pairing break and the absence retries like any undecodable read —
    // the budget error carries the diagnosis instead.
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [404]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /background-job read kept failing \(client error \(UnsupportedContentType\)\) — the pairing may be broken/,
    );
  });

  it("a 5xx job endpoint retries to the budget, whose failure carries the diagnosis", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, { budgetSeconds: 0.05 });
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [503]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /background-job read kept failing \(HTTP 503\) — the pairing may be broken/,
    );
    expect(fake.interrupted).toBe(1);
  });

  it("a non-404 job answer (an HTML 502) retries to the budget and never carries the pairing message", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, { budgetSeconds: 0.05 });
    // An HTML error page from something between driver and serve.
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [
      {
        status: 502,
        body: "<html><body>502 Bad Gateway</body></html>",
        contentType: "text/html",
      },
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    const thrown = await driver.prompt(sessionId, "review this").then(
      () => "",
      (error: Error) => String(error.message),
    );
    expect(thrown).toMatch(
      /background-job read kept failing \(HTTP 502\) — the pairing may be broken/,
    );
    // The non-404 status never earns the pairing epitaph.
    expect(thrown).not.toContain("the pairing is broken");
  });

  it("the budget failure carries the last open reason: a stuck running job says so", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake, { budgetSeconds: 0.05 });
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [jobList("running")]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /last observed: background work outstanding \(subagent:running\)/,
    );
  });

  it("a session removed mid-turn fails named through the job route's typed session-gone answer", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [idlePage]);
    fake.setJobs("ses-fake-1", [
      {
        status: 404,
        body: {
          _tag: "SessionNotFoundError",
          sessionID: "ses-fake-1",
          message: "Session not found: ses-fake-1",
        },
      },
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.prompt(sessionId, "review this")).rejects.toThrow(
      /session ses-fake-1 disappeared while waiting for the turn/,
    );
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

describe("turnOpen", () => {
  const userMs = 1000;

  /** A 2.3.x-shaped subagent job, as the schema's Job.Subagent carries it. */
  const subagentJob = (status: string, childMs: number) => ({
    kind: "subagent",
    id: `job-${childMs}`,
    sessionID: "ses-fake-1",
    status,
    time: {
      started: childMs,
      completed: status === "running" ? undefined : childMs + 100,
    },
    childSessionID: "ses-child-1",
    agent: "reviewer-child",
    description: "the blind pass",
  });

  it("settles on the idle marker after the user item with no outstanding work", () => {
    expect(
      turnOpen(
        [
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [],
        userMs,
      ),
    ).toBeNull();
  });

  it("stays open while the turn runs and on a scheduled retry", () => {
    expect(
      turnOpen(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 100 },
            finish: "tool-calls",
          },
        ],
        [],
        userMs,
      ),
    ).not.toBeNull();
    expect(
      turnOpen(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 200 },
            finish: "error",
            retry: { attempt: 2 },
          },
        ],
        [],
        userMs,
      ),
    ).not.toBeNull();
  });

  it("a terminal-error assistant stands in for the idle marker", () => {
    expect(
      turnOpen(
        [
          {
            type: "assistant",
            time: { created: userMs + 5000, completed: 200 },
            error: { message: "boom" },
          },
        ],
        [],
        userMs,
      ),
    ).toBeNull();
  });

  it("a listed job keeps the turn open even with an idle marker present", () => {
    // The launch turn idled while the child is still out — the 2.3.x
    // early-settle shape.
    expect(
      turnOpen(
        [
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [subagentJob("running", userMs + 8000)],
        userMs,
      ),
    ).toMatch(/background work outstanding/);
  });

  it("a completed-but-unconsumed job keeps the turn open through the report race", () => {
    expect(
      turnOpen(
        [
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [subagentJob("completed", userMs + 8000)],
        userMs,
      ),
    ).toMatch(/background work outstanding/);
    expect(
      turnOpen(
        [
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [subagentJob("error", userMs + 8000)],
        userMs,
      ),
    ).toMatch(/background work outstanding/);
  });

  it("a delivered report newer than the newest idle keeps the turn open", () => {
    // The wake execution the report starts is still running.
    expect(
      turnOpen(
        [
          { type: "synthetic", time: { created: userMs + 9500 } },
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [],
        userMs,
      ),
    ).toMatch(/wake execution/);
  });

  it("settles once the wake's idle lands after the delivered report", () => {
    expect(
      turnOpen(
        [
          { type: "idle", time: { created: userMs + 12000 } },
          { type: "synthetic", time: { created: userMs + 9500 } },
          { type: "idle", time: { created: userMs + 9000 } },
          { type: "user", time: { created: userMs } },
        ],
        [],
        userMs,
      ),
    ).toBeNull();
  });

  it("ignores markers from before the queued user item", () => {
    expect(
      turnOpen([{ type: "idle", time: { created: userMs - 10 } }], [], userMs),
    ).toMatch(/no idle marker/);
  });
});

describe("opencode transcript read", () => {
  it("maps the session's records into oldest-first turns of the new shape", async () => {
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
            // The real 2.3.0 User record: the prompt rides a top-level
            // text field, not content parts.
            type: "user",
            time: { created: userMs },
            text: "review this diff",
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", at: 1_000_000, text: "review this diff" },
      { role: "assistant", at: 1_006_000, text: "the review says no" },
    ]);
  });

  it("the user record's prompt rides the top-level text field, content parts as the fallback", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          {
            // An older wire shape, defensively read.
            type: "user",
            time: { created: userMs + 1000 },
            content: [{ type: "text", text: "the fallback shape" }],
          },
          {
            type: "user",
            time: { created: userMs },
            text: "the real shape",
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", at: 1_000_000, text: "the real shape" },
      { role: "user", at: 1_001_000, text: "the fallback shape" },
    ]);
  });

  it("an assistant record's tool parts render as tool turns after the reply text", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          {
            type: "assistant",
            time: { created: userMs + 6000 },
            content: [
              { type: "text", text: "checking the head" },
              {
                type: "tool",
                name: "bash",
                id: "tool-1",
                state: {
                  status: "completed",
                  input: { command: "git log -1" },
                  content: [{ type: "text", text: "abc the head" }],
                },
                time: { created: userMs + 6100 },
              },
              {
                type: "tool",
                name: "read",
                id: "tool-2",
                state: {
                  status: "error",
                  input: { path: "src/x.ts" },
                  error: { message: "file not found" },
                },
                time: { created: userMs + 6200 },
              },
            ],
          },
          {
            type: "user",
            time: { created: userMs },
            text: "review this diff",
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", at: 1_000_000, text: "review this diff" },
      { role: "assistant", at: 1_006_000, text: "checking the head" },
      {
        role: "tool",
        at: 1_006_100,
        name: "bash",
        status: "completed",
        input: '{"command":"git log -1"}',
        output: "abc the head",
      },
      {
        role: "tool",
        at: 1_006_200,
        name: "read",
        status: "error",
        input: '{"path":"src/x.ts"}',
        output: "",
        error: "file not found",
      },
    ]);
  });

  it("a delivered subagent report renders as a report turn", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          {
            type: "assistant",
            time: { created: userMs + 9000 },
            content: [{ type: "text", text: "posted the review" }],
          },
          {
            type: "synthetic",
            time: { created: userMs + 8000 },
            text: "the blind pass found nothing",
          },
          {
            type: "user",
            time: { created: userMs },
            text: "review this diff",
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", at: 1_000_000, text: "review this diff" },
      { role: "report", at: 1_008_000, text: "the blind pass found nothing" },
      { role: "assistant", at: 1_009_000, text: "posted the review" },
    ]);
  });

  it("an assistant record with no text parts renders only its tool turns", async () => {
    const fake = await fakeOpencode();
    fakes.push(fake);
    const { driver } = await harnessDriver(fake);
    fake.setStages("ses-fake-1", [
      (userMs) => ({
        data: [
          {
            type: "assistant",
            time: { created: userMs + 6000 },
            content: [
              {
                type: "tool",
                name: "grep",
                id: "tool-1",
                state: { status: "running", input: { pattern: "todo" } },
                time: { created: userMs + 6100 },
              },
            ],
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      {
        role: "tool",
        at: 1_006_100,
        name: "grep",
        status: "running",
        input: '{"pattern":"todo"}',
        output: "",
      },
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
            text: "prompt",
          },
        ],
      }),
    ]);
    const sessionId = await driver.createSession("/work/tree", "reviewer");
    await expect(driver.transcript(sessionId)).resolves.toEqual([
      { role: "user", at: 1_000_000, text: "prompt" },
      { role: "assistant", at: 1_006_000, text: "part one\npart two" },
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
