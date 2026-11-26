import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot as harnessBoot } from "./watcher-harness.ts";

// The watcher as OpenCode 2 hosts it, reading the Forgejo REST API
// directly (the operator's ruling on #89): setup() reads the operator's
// config — the forge's base url and token (the adapter's own environment
// names), the poll cadence, the projection's db path — registers the
// watch tools through a ToolEditor, and polls the fake REST server here
// on 127.0.0.1. The fake serves the routes the poller reads with fixture
// responses: the pull-request records, their reviews, the commit-status
// leaves, the branch listing, and the Actions run/job/log reads. There
// is no MCP layer anymore and none is faked: no tools/list, no
// handshake, no session — the transport tests died with the MCP client.
// The projection's own routes are deliberately absent (the pulls list
// answers 404), so this file exercises the watches alone; the
// projection's surfaces live in mail-watcher-projection.test.ts.
// Every fixture URL is example.invalid or loopback; no test leaves the
// loopback fake or writes outside tmpdir.

type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

type WatchRow = {
  id: string;
  session: string;
  kind: string;
  repo: string;
  ref: string;
  claimedBy?: string;
  note?: string;
  delivered?: Record<string, boolean>;
};

type SessionRow = {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type RunSpec = {
  id: number;
  index_in_repo: number;
  status: string;
  commit_sha: string;
  html_url: string;
  title: string;
  event: string;
  duration: string;
};

type JobSpec = { id: number; name: string; status: string };

// The review record a reviews read answers, in the fields the live
// surface carries.
type ReviewSpec = {
  id: number;
  reviewer: string;
  state: string;
  url?: string;
};

// The pull request's own state fields a test wants the PR read to carry;
// absent ones answer as an open, unmerged pull request.
type PullState = {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
};

async function settleOnce() {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

async function waitFor(probe: () => boolean, limit = 800): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    let held = false;
    try {
      held = probe();
    } catch {
      held = false;
    }
    if (held) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("waitFor: condition never held");
}

async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await settleOnce();
}

// The fake host: sessions, tools, mails, the stamp writes (the watcher
// registers and settles through ctx.session.update, which the host applies
// as a whole-record replace — the fake does the same). The mcp domain is
// gone from the watcher's surface and from the fake.
function fakeContext(listRows: SessionRow[] = [], options: unknown = {}) {
  const sessions = new Map<
    string,
    SessionRow & { metadata?: Record<string, unknown> }
  >();
  for (const row of listRows) {
    sessions.set(row.id, structuredClone(row));
  }
  const tools = new Map<string, ToolDef>();
  const mails: Array<{ sessionID: string; text: string }> = [];
  const queue: Array<{ type: string; data: unknown }> = [];
  let push: (() => void) | undefined;

  const ctx: any = {
    options,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.get(sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        return structuredClone(row);
      },
      list: async (_input?: unknown) => ({
        data: structuredClone(listRows),
        cursor: {},
      }),
      update: async (input: {
        sessionID: string;
        metadata: Record<string, unknown>;
      }) => {
        const row = sessions.get(input.sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        row.metadata = structuredClone(input.metadata);
        return { id: row.id };
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        mails.push(structuredClone(input));
      },
    },
    tool: {
      transform: async (
        fn: (editor: { add: (tool: ToolDef) => void }) => void,
      ) => {
        const added: ToolDef[] = [];
        fn({
          add: (tool: ToolDef) => {
            added.push(tool);
            tools.set(tool.name, tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            push = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    },
  };

  const emit = async (type: string, data: unknown) => {
    queue.push({ type, data });
    push?.();
    await settleOnce();
  };

  return { ctx, tools, sessions, mails, emit };
}

// The fake forge: one loopback REST server answering /api/v1 routes from
// the fixtures below. Every request is recorded (route and query); a
// route whose gate is held waits; an outage fails everything.
type ForgeState = {
  runs: Map<number, RunSpec>;
  jobs: Map<number, JobSpec[]>;
  logs: Map<number, string>;
  prHeads: Map<string, string>;
  prStates: Map<string, PullState>;
  branches: Array<{ name: string; sha: string }>;
  reviews: Map<string, ReviewSpec[]>;
  calls: Array<{ method: string; path: string; query: Record<string, string> }>;
  auth: string[];
  outage: boolean;
  // A route's answer waits on its gate (matched by a path fragment).
  gates: Map<string, Promise<void>>;
  held: string[];
  // The status text the failures carry — a body a redaction test fills.
  echo: string;
};

function forgeState(): ForgeState {
  return {
    runs: new Map(),
    jobs: new Map(),
    logs: new Map(),
    prHeads: new Map(),
    prStates: new Map(),
    branches: [],
    reviews: new Map(),
    calls: [],
    auth: [],
    outage: false,
    gates: new Map(),
    held: [],
    echo: "",
  };
}

async function startForge(state: ForgeState) {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://x");
    state.auth.push(String(req.headers.authorization ?? ""));
    const reject = (code: number, text: string) => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(state.echo ? `${text}${state.echo}` : text);
    };
    if (state.outage) {
      reject(500, "forge outage");
      return;
    }
    const path = route.pathname;
    state.calls.push({
      method: req.method ?? "",
      path,
      query: Object.fromEntries(route.searchParams.entries()),
    });
    const gateKey = state.gates.size
      ? [...state.gates.keys()].find((fragment) => path.includes(fragment))
      : undefined;
    const answerJson = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const answerText = (text: string) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(state.echo ? `${text}${state.echo}` : text);
    };
    const respond = () => {
      const limit = Math.max(1, Number(route.searchParams.get("limit") ?? 30));
      const page = Math.max(1, Number(route.searchParams.get("page") ?? 1));
      const window = <T>(rows: T[]): T[] =>
        rows.slice((page - 1) * limit, page * limit);

      // /repos/{owner}/{repo}/… for the one repo the fixtures carry.
      const repoMatch = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
      if (!repoMatch) {
        reject(404, "no such route");
        return;
      }
      const [, , , rest] = repoMatch;
      if (rest === "pulls") {
        // The projection's list route: deliberately absent in this
        // file's fake — the watches alone are exercised here.
        reject(404, "the pulls list is not served here");
        return;
      }
      const pull = /^pulls\/(\d+)(\/reviews)?$/.exec(rest);
      if (pull) {
        const index = pull[1];
        const head = state.prHeads.get(index);
        const reviews = pull[2] === "/reviews";
        if (reviews) {
          const rows = state.reviews.get(index) ?? [];
          answerJson(
            window(rows).map((review) => ({
              id: review.id,
              user: { login: review.reviewer },
              state: review.state,
              ...(review.url ? { html_url: review.url } : {}),
            })),
          );
          return;
        }
        if (!head) {
          reject(404, "get pull request err: The target couldn't be found.");
          return;
        }
        const own = state.prStates.get(index) ?? {};
        answerJson({
          number: Number(index),
          state: own.state ?? "open",
          merged: own.merged ?? false,
          merged_at: own.merged_at ?? null,
          closed_at: own.closed_at ?? null,
          head: { ref: `refs/pull/${index}/head`, sha: head },
        });
        return;
      }
      if (rest === "branches") {
        answerJson(
          window(state.branches).map((branch) => ({
            name: branch.name,
            commit: { id: branch.sha },
          })),
        );
        return;
      }
      const runs = rest === "actions/runs";
      const oneRun = /^actions\/runs\/(\d+)$/.exec(rest);
      const runJobs = /^actions\/runs\/(\d+)\/jobs$/.exec(rest);
      const jobLogs = /^actions\/runs\/(\d+)\/jobs\/(\d+)\/logs$/.exec(rest);
      if (runs) {
        const sha = route.searchParams.get("head_sha") ?? "";
        const matches = [...state.runs.values()]
          .filter((run) => run.commit_sha === sha)
          .sort((left, right) => left.id - right.id);
        answerJson({ workflow_runs: window(matches).map(runRow) });
        return;
      }
      if (oneRun) {
        const run = state.runs.get(Number(oneRun[1]));
        if (!run) {
          reject(
            404,
            `failed to get workflow run: run with id ${oneRun[1]}: resource does not exist`,
          );
          return;
        }
        answerJson(runRow(run));
        return;
      }
      if (runJobs) {
        const jobs = state.jobs.get(Number(runJobs[1])) ?? [];
        answerJson(jobs);
        return;
      }
      if (jobLogs) {
        const log = state.logs.get(Number(jobLogs[2]));
        if (log === undefined) {
          reject(404, "the job's log could not be found");
          return;
        }
        answerText(log);
        return;
      }
      reject(404, "no such route");
    };

    const gate = gateKey ? state.gates.get(gateKey) : undefined;
    if (gate) {
      state.held.push(gateKey!);
      void gate.then(() => {
        respond();
      });
      return;
    }
    respond();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as { port: number };
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

// The fixture run as the REST row the API answers.
const runRow = (run: RunSpec) => ({
  id: run.id,
  title: run.title,
  status: run.status,
  run_number: run.index_in_repo,
  head_sha: run.commit_sha,
  html_url: run.html_url,
  duration: run.duration,
});

const gated = () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open() };
};

const TOKEN = "forge-token";
// The projection's default db path would land in the operator's real
// state home: this file's syncs open it even when the walk refuses (the
// sweep's stale read). A sandboxed db keeps the header's
// no-writes-outside-tmpdir claim true.
const DB_PATH = join(
  mkdtempSync(join(tmpdir(), "mail-watcher-state-")),
  "pr-state.db",
);
const serverOptions = (url: string) => ({
  watcher: { forgeUrl: url, forgeToken: TOKEN, dbPath: DB_PATH },
});

// The watcher's plugins entry with just the environment legs overridden
// per test.
const NAMED = (url: string) => serverOptions(url);

const ENV_KEYS = [
  "WATCHER_POLL_SECONDS",
  "FORGEJO_BASE_URL",
  "FORGEJO_TOKEN",
] as const;

async function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
) {
  const previous = new Map(
    ENV_KEYS.map((key) => [key, process.env[key] ?? undefined]),
  );
  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Setup as the host runs it: inside the plugin batch, then the batch
// ends and the host's next read of its mcp state rebuilds it.
async function boot(fixture: ReturnType<typeof fakeContext>) {
  const cleanup = await harnessBoot(fixture.ctx);
  return cleanup;
}

const tool = (fixture: ReturnType<typeof fakeContext>, name: string): ToolDef =>
  fixture.tools.get(name)!;

const makeRun = (over: Partial<RunSpec>): RunSpec => ({
  id: 18197,
  index_in_repo: 62,
  status: "success",
  commit_sha: "8945c5b991e63715f176ab7d29b451627a577f92",
  html_url: "https://example.invalid/acme/widgets/actions/runs/62",
  title: "watched change",
  event: "pull_request",
  duration: "24s",
  ...over,
});

const stampedWatches = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
): WatchRow[] => {
  const metadata = fixture.sessions.get(sessionID)?.metadata ?? {};
  const rows = (metadata as Record<string, any>).chancery?.watches;
  return Array.isArray(rows) ? rows : [];
};

const routeCount = (state: ForgeState, pattern: RegExp): number =>
  state.calls.filter((call) => pattern.test(call.path)).length;

// The pr watch's per-pass lifecycle read.
const prReadCount = (state: ForgeState): number =>
  routeCount(state, /\/pulls\/\d+$/);

test("setup validates the watcher options; the forge config rides options or the adapter's environment", async () => {
  await withEnv({}, async () => {
    // No base url, no token: each disables the watcher at setup.
    await assert.rejects(
      harnessBoot(fakeContext([], {}).ctx),
      /no forge base url — set options\.watcher\.forgeUrl.*FORGEJO_BASE_URL/,
    );
    await assert.rejects(
      harnessBoot(
        fakeContext([], { watcher: { forgeUrl: "https://example.invalid" } })
          .ctx,
      ),
      /no forge token — set options\.watcher\.forgeToken.*FORGEJO_TOKEN/,
    );
    // A bad poll cadence still disables the plugin at setup.
    await assert.rejects(
      harnessBoot(
        fakeContext([], {
          watcher: {
            forgeUrl: "https://example.invalid",
            forgeToken: TOKEN,
            pollSeconds: 0,
          },
        }).ctx,
      ),
      /watcher pollSeconds must be a positive number/,
    );
    // A wrong-typed or wrong-scheme url.
    await assert.rejects(
      harnessBoot(
        fakeContext([], {
          watcher: { forgeUrl: "ftp://nope", forgeToken: TOKEN },
        }).ctx,
      ),
      /must be the forge's http\(s\) base url/,
    );
    // The environment legs carry the config when the options do not.
    const state = forgeState();
    state.runs.set(18197, makeRun({ id: 18197, status: "success" }));
    const forge = await startForge(state);
    try {
      const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
      await withEnv(
        {
          FORGEJO_BASE_URL: forge.url,
          FORGEJO_TOKEN: TOKEN,
          WATCHER_POLL_SECONDS: "0.05",
        },
        async () => {
          const cleanup = await boot(fixture);
          try {
            await tool(fixture, "watcher_register").execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            );
            await waitFor(() => fixture.mails.length === 1);
            assert.ok(
              fixture.mails[0].text.includes("run 18197 (#62) — success"),
            );
            // The token rode every request as the adapter's scheme.
            assert.deepEqual(
              [...new Set(state.auth.filter(Boolean))],
              [`token ${TOKEN}`],
            );
          } finally {
            await cleanup?.();
          }
        },
      );
    } finally {
      await forge.close();
    }
  });
});

test("register stamps the requesting session and watcher_list reads it back", async () => {
  const forge = await startForge(forgeState());
  try {
    const fixture = fakeContext(
      [
        { id: "ses-1", metadata: {} },
        { id: "ses-2", metadata: {} },
      ],
      NAMED(forge.url),
    );
    await withEnv({}, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const reply = JSON.parse(
          (
            await register.execute(
              {
                kind: "pr",
                repo: "acme/widgets",
                ref: "43",
                note: "waiting on the review",
              },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        assert.equal(reply.existing, false);
        assert.match(reply.id, /^w-[0-9a-f]{8}$/);
        assert.equal(
          reply.delivery,
          "watching pr 43 on acme/widgets; the verdict rides mail",
        );

        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.equal(row.id, reply.id);
        assert.equal(row.session, "ses-1");
        assert.equal(row.kind, "pr");
        assert.equal(row.repo, "acme/widgets");
        assert.equal(row.ref, "43");
        assert.equal(row.claimedBy, "ses-1");
        assert.equal(row.note, "waiting on the review");
        assert.deepEqual(row.delivered, {});
        assert.deepEqual(stampedWatches(fixture, "ses-2"), []);

        const list = JSON.parse(
          (
            await tool(fixture, "watcher_list").execute(
              {},
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.deepEqual(list.watches, [
          {
            id: reply.id,
            kind: "pr",
            repo: "acme/widgets",
            ref: "43",
            note: "waiting on the review",
            delivered: [],
          },
        ]);
        const other = JSON.parse(
          (
            await tool(fixture, "watcher_list").execute(
              {},
              { sessionID: "ses-2" },
            )
          ).content,
        );
        assert.deepEqual(other.watches, []);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a second register for a claimed pr returns the claim instead of a second owner", async () => {
  const forge = await startForge(forgeState());
  try {
    const fixture = fakeContext(
      [
        { id: "ses-1", metadata: {} },
        { id: "ses-2", metadata: {} },
      ],
      NAMED(forge.url),
    );
    await withEnv({}, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const first = JSON.parse(
          (
            await register.execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        const second = JSON.parse(
          (
            await register.execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-2" },
            )
          ).content,
        );
        assert.equal(second.existing, true);
        assert.equal(second.id, first.id);
        assert.equal(second.claimedBy, "ses-1");
        assert.equal(
          second.delivery,
          `the watch is claimed: its verdict rides mail to ses-1`,
        );
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
        assert.deepEqual(stampedWatches(fixture, "ses-2"), []);

        // The owner re-registering its own watch is idempotent too.
        const again = JSON.parse(
          (
            await register.execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(again.existing, true);
        assert.equal(again.id, first.id);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("register validates kind, repo, and ref shape; a run watch is idempotent per session", async () => {
  const forge = await startForge(forgeState());
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({}, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const run = JSON.parse(
          (
            await register.execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        const again = JSON.parse(
          (
            await register.execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(again.existing, true);
        assert.equal(again.id, run.id);

        await assert.rejects(
          register.execute(
            { kind: "merge", repo: "acme/widgets", ref: "43" },
            { sessionID: "ses-1" },
          ),
          /kind must be one of run, pr, branch/,
        );
        await assert.rejects(
          register.execute(
            { kind: "pr", repo: "acme/widgets", ref: "not-a-number" },
            { sessionID: "ses-1" },
          ),
          /numeric pr index/,
        );
        await assert.rejects(
          register.execute(
            { kind: "run", repo: "widgets-only", ref: "18197" },
            { sessionID: "ses-1" },
          ),
          /repo must be owner\/name/,
        );
        await assert.rejects(
          register.execute(
            { kind: "branch", repo: "acme/widgets", ref: "" },
            { sessionID: "ses-1" },
          ),
          /ref must be a branch name/,
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("forget removes the caller's watch; a foreign claimed watch is its owner's to forget", async () => {
  const forge = await startForge(forgeState());
  try {
    const fixture = fakeContext(
      [
        { id: "ses-1", metadata: {} },
        { id: "ses-2", metadata: {} },
      ],
      NAMED(forge.url),
    );
    await withEnv({}, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const forget = tool(fixture, "watcher_forget");
        const created = JSON.parse(
          (
            await register.execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-1" },
            )
          ).content,
        );

        await assert.rejects(
          forget.execute({ id: created.id }, { sessionID: "ses-2" }),
          new RegExp(`claimed by ses-1`),
        );
        await assert.rejects(
          forget.execute({ id: "w-doesnotexist" }, { sessionID: "ses-2" }),
          /no such watch/,
        );

        const reply = JSON.parse(
          (await forget.execute({ id: created.id }, { sessionID: "ses-1" }))
            .content,
        );
        assert.equal(reply.ok, true);
        assert.deepEqual(stampedWatches(fixture, "ses-1"), []);
        await assert.rejects(
          forget.execute({ id: created.id }, { sessionID: "ses-1" }),
          /no such watch/,
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a terminal run delivers its verdict mail once and marks the stamp", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.runs.set(
      18197,
      makeRun({ id: 18197, index_in_repo: 62, status: "success" }),
    );
    state.jobs.set(18197, [
      { id: 108411, name: "changes", status: "success" },
      { id: 108412, name: "pre-commit", status: "skipped" },
    ]);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const reply = JSON.parse(
          (
            await register.execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            )
          ).content,
        );

        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        assert.ok(mail.text.startsWith("<system-reminder>"));
        assert.ok(mail.text.endsWith("</system-reminder>"));
        assert.ok(mail.text.includes("Forgejo mail — watch verdict"));
        assert.ok(
          mail.text.includes(`watch ${reply.id} — run 18197 on acme/widgets`),
        );
        assert.ok(mail.text.includes("run 18197 (#62) — success"));
        assert.ok(
          mail.text.includes(
            "url https://example.invalid/acme/widgets/actions/runs/62",
          ),
        );
        assert.ok(
          mail.text.includes("sha 8945c5b991e63715f176ab7d29b451627a577f92"),
        );
        assert.ok(mail.text.includes("duration 24s"));
        assert.ok(
          mail.text.includes("jobs: changes success, pre-commit skipped"),
        );
        assert.ok(
          !mail.text.includes("last lines of job"),
          "a success verdict skips log extraction",
        );

        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.deepEqual(row.delivered, { 18197: true });

        // The token rode every request, and the verdict was read through
        // the run record's route.
        assert.deepEqual(
          [...new Set(state.auth.filter(Boolean))],
          [`token ${TOKEN}`],
        );
        assert.ok(
          state.calls.some((call) => /\/actions\/runs\/18197$/.test(call.path)),
        );

        // Delivered once, ever: further ticks re-send nothing.
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a failure verdict carries per-job states and the failing job's byte-tail log lines", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    // A log larger than one tail window: the mail may only show lines from
    // the last bytes of the log, with the timestamp envelope unwrapped.
    const filler =
      "2026-11-16T05:04:00.000000Z step running with plenty of output padding\n";
    const early =
      filler.repeat(48) +
      "2026-11-16T05:04:01.000000Z early-line-must-not-appear\n" +
      filler.repeat(40);
    const late = [
      "2026-11-16T05:04:06.5325314Z   ✅  Success - Post actions/checkout@3d3c42e5",
      "2026-11-16T05:04:07.1015753Z \x1b[31merror: prettier found differences\x1b[0m",
      "2026-11-16T05:04:07.2015753Z Job 'pre-commit' failed",
      "2026-11-16T05:04:07.3015753Z 🏁  Job failed",
    ].join("\n");
    const failingJobs = [
      { id: 108411, name: "changes", status: "success" },
      { id: 108412, name: "pre-commit", status: "failure" },
      { id: 108413, name: "test", status: "skipped" },
    ];
    state.runs.set(
      18196,
      makeRun({ id: 18196, index_in_repo: 61, status: "failure" }),
    );
    state.jobs.set(18196, failingJobs);
    state.logs.set(108412, early + late);

    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18196" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0].text;

        assert.ok(mail.includes("run 18196 (#61) — failure"));
        assert.ok(
          mail.includes(
            "jobs: changes success, pre-commit failure, test skipped",
          ),
        );
        assert.ok(mail.includes('last lines of job "pre-commit":'));
        // The envelope comes off: no ISO timestamps, no ANSI codes.
        assert.ok(!/2026-11-16T05:04/.test(mail));
        assert.ok(!/\x1b\[/.test(mail));
        assert.ok(mail.includes("error: prettier found differences"));
        assert.ok(mail.includes("Job 'pre-commit' failed"));
        assert.ok(
          !mail.includes("early-line-must-not-appear"),
          "the mail shows the byte-tail of the log, not the head",
        );
        // The tail read rode the log route, bounded by max_bytes.
        assert.ok(
          state.calls.some(
            (call) =>
              /\/jobs\/108412\/logs$/.test(call.path) &&
              call.query.max_bytes === "2048",
          ),
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a non-terminal or unfamiliar run never delivers; a later terminal state does", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const run = makeRun({ id: 18197, index_in_repo: 62, status: "running" });
    state.runs.set(18197, run);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18197" },
          { sessionID: "ses-1" },
        );
        await settle(60);
        assert.equal(fixture.mails.length, 0);

        run.status = "galloping"; // a status this watcher does not know
        await settle(60);
        assert.equal(fixture.mails.length, 0);

        run.status = "failure";
        state.jobs.set(18197, [
          { id: 108412, name: "pre-commit", status: "failure" },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("— failure"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a pr watch follows its head across pushes; every run of the head delivers once", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA_ONE = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    const SHA_TWO = "879fe5e67e4dbcdb277b5372abd39c7c5ceae1de";
    state.prHeads.set("43", SHA_ONE);
    state.runs.set(
      18197,
      makeRun({
        id: 18197,
        index_in_repo: 62,
        status: "success",
        commit_sha: SHA_ONE,
      }),
    );
    state.runs.set(
      18198,
      makeRun({
        id: 18198,
        index_in_repo: 63,
        status: "failure",
        commit_sha: SHA_ONE,
        html_url: "https://example.invalid/acme/widgets/actions/runs/63",
      }),
    );
    state.jobs.set(18198, [
      { id: 108412, name: "pre-commit", status: "failure" },
    ]);
    state.logs.set(
      108412,
      "2026-11-16T05:04:07.1015753Z Job 'pre-commit' failed",
    );

    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        const headListed = () =>
          state.calls.some(
            (call) =>
              /\/actions\/runs$/.test(call.path) &&
              call.query.head_sha === SHA_ONE,
          );
        await waitFor(headListed);
        await waitFor(() => fixture.mails.length === 2);
        const runIds = fixture.mails
          .map((mail) => /run (1819[78]) /.exec(mail.text)?.[1])
          .sort();
        assert.deepEqual(runIds, ["18197", "18198"]);
        assert.ok(
          fixture.mails.some((mail) =>
            mail.text.includes("Job 'pre-commit' failed"),
          ),
        );
        assert.ok(reply.id);

        // A later push on the same head: new runs of the same watch.
        state.prHeads.set("43", SHA_TWO);
        state.runs.set(
          18199,
          makeRun({
            id: 18199,
            index_in_repo: 64,
            status: "success",
            commit_sha: SHA_TWO,
          }),
        );
        await waitFor(() => fixture.mails.length === 3);
        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.deepEqual(row.delivered, {
          18197: true,
          18198: true,
          18199: true,
        });
        assert.equal(row.id, reply.id);
        // The head rides as the full sha the pull request resolved to;
        // the live server matches nothing for a short one.
        const listedShas = new Set(
          state.calls
            .filter((call) => /\/actions\/runs$/.test(call.path))
            .map((call) => call.query.head_sha),
        );
        assert.deepEqual([...listedShas].sort(), [SHA_ONE, SHA_TWO].sort());
        for (const sha of listedShas) {
          assert.match(String(sha), /^[0-9a-f]{40}$/);
        }

        await settle(60);
        assert.equal(fixture.mails.length, 3, "no verdict repeats");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a pr watch follows its pull request to the close: one terminal event, then the polling stops", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    state.prHeads.set("43", SHA);
    state.runs.set(
      18197,
      makeRun({
        id: 18197,
        index_in_repo: 62,
        status: "running",
        commit_sha: SHA,
      }),
    );
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "pr", repo: "acme/widgets", ref: "43" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        await waitFor(() => prReadCount(state) >= 2);
        const openReads = prReadCount(state);
        assert.equal(
          fixture.mails.length,
          0,
          "an open pull request says nothing",
        );
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);

        state.prStates.set("43", {
          state: "closed",
          merged: true,
          merged_at: "2026-11-16T05:55:41.922675Z",
        });
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        assert.ok(mail.text.startsWith("<system-reminder>"));
        assert.ok(mail.text.endsWith("</system-reminder>"));
        assert.ok(mail.text.includes("Forgejo mail — watch closed"));
        assert.ok(
          mail.text.includes(`watch ${reply.id} — pr 43 on acme/widgets`),
        );
        assert.ok(
          mail.text.includes(
            "PR acme/widgets#43 closed: merged at 2026-11-16T05:55:41.922675Z",
          ),
        );

        // Dissolved: the stamp holds no watch, and no read follows the
        // close — not the pull request's, not one run's.
        await waitFor(() => stampedWatches(fixture, "ses-1").length === 0);
        const closedReads = prReadCount(state);
        const runReads = () => routeCount(state, /\/actions\/runs/);
        const runsAtClose = runReads();
        await settle(60);
        assert.equal(prReadCount(state), closedReads);
        assert.equal(runReads(), runsAtClose);
        assert.equal(
          fixture.mails.length,
          1,
          "the terminal event delivers once",
        );
        assert.ok(closedReads > openReads);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("registered on a pull request that is already closed: one terminal event, dissolved at the first pass", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA = "6ee1211ada380e55f6a580c7cc20ec673b7b320b";
    state.prHeads.set("43", SHA);
    state.prStates.set("43", {
      state: "closed",
      merged: false,
      closed_at: "2026-11-16T04:15:18Z",
    });
    state.runs.set(18197, makeRun({ status: "success", commit_sha: SHA }));
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes("Forgejo mail — watch closed"),
        );
        assert.ok(
          fixture.mails[0].text.includes(
            "PR acme/widgets#43 closed: closed unmerged at 2026-11-16T04:15:18Z",
          ),
        );
        await waitFor(() => stampedWatches(fixture, "ses-1").length === 0);
        // No forget was needed, and nothing reads further: the first pass
        // was the watch's last.
        await settle(60);
        assert.equal(fixture.mails.length, 1);
        assert.ok(
          !state.calls.some((call) => /\/actions\/runs$/.test(call.path)),
          "the closed pull request never had a run read",
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a pull request that never closes keeps the CI deliveries flowing with no lifecycle event", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA_ONE = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    const SHA_TWO = "879fe5e67e4dbcdb277b5372abd39c7c5ceae1de";
    state.prHeads.set("43", SHA_ONE);
    state.runs.set(
      18197,
      makeRun({
        id: 18197,
        index_in_repo: 62,
        status: "success",
        commit_sha: SHA_ONE,
      }),
    );
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes("Forgejo mail — watch verdict"),
          "the mail is a CI verdict",
        );
        const readsAtFirst = prReadCount(state);

        // Pushes ride on; the watch never reads its pull request's close.
        state.prHeads.set("43", SHA_TWO);
        state.runs.set(
          18199,
          makeRun({
            id: 18199,
            index_in_repo: 64,
            status: "success",
            commit_sha: SHA_TWO,
          }),
        );
        await waitFor(() => fixture.mails.length === 2);
        assert.ok(
          fixture.mails.every((mail) => !mail.text.includes("watch closed")),
          "no lifecycle event",
        );
        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.deepEqual(row.delivered, { 18197: true, 18199: true });
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
        await settle(60);
        assert.equal(fixture.mails.length, 2);
        assert.ok(prReadCount(state) > readsAtFirst, "the PR read goes on");

        // A state the parser does not know reads open, never an end.
        state.prStates.set("43", { state: "galloping" });
        await settle(60);
        assert.equal(fixture.mails.length, 2);
        assert.ok(prReadCount(state) > readsAtFirst + 2);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a lifecycle event says the state alone when the server answer carries no timestamp", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    state.prHeads.set("43", SHA);
    state.prStates.set("43", { state: "closed", merged: true });
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0].text;
        assert.ok(mail.includes("PR acme/widgets#43 closed: merged"));
        assert.ok(
          !mail.includes("closed: merged at"),
          "no timestamp is invented where the server gave none",
        );
        await waitFor(() => stampedWatches(fixture, "ses-1").length === 0);
        await settle(40);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a pr watch's lifecycle stamp write that throws after it was applied still mails the close once", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    state.prHeads.set("43", SHA);
    state.prStates.set("43", {
      state: "closed",
      merged: true,
      merged_at: "2026-11-16T05:55:41.922675Z",
    });
    state.runs.set(18197, makeRun({ status: "running", commit_sha: SHA }));
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    const update = fixture.ctx.session.update;
    let writes = 0;
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        fixture.ctx.session.update = async (input: any) => {
          writes += 1;
          const result = await update(input);
          if (writes === 2) throw new Error("the response was lost");
          return result;
        };
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes("Forgejo mail — watch closed"),
        );
        await waitFor(() => stampedWatches(fixture, "ses-1").length === 0);
        await settle(60);
        assert.equal(fixture.mails.length, 1, "the close delivers once");
      } finally {
        await cleanup?.();
      }
    });
    assert.deepEqual(stampedWatches(fixture, "ses-1"), []);
  } finally {
    await forge.close();
  }
});

test("a branch watch resolves the branch commit; a deleted branch never expires the watch", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA = "6ee1211ada380e55f6a580c7cc20ec673b7b320b";
    state.branches = [{ name: "main", sha: SHA }];
    state.runs.set(18197, makeRun({ commit_sha: SHA }));
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "branch", repo: "acme/widgets", ref: "main" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("run 18197 (#62) — success"));
        // The branch listing rode its route with the page and limit.
        assert.ok(
          state.calls.some(
            (call) =>
              /\/branches$/.test(call.path) &&
              call.query.page === "1" &&
              call.query.limit === "100",
          ),
        );

        // The branch vanishes: the passes just find nothing and the
        // watch stays registered — no expiry, no error escaping.
        state.branches = [];
        await settle(60);
        assert.equal(fixture.mails.length, 1);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a pr-reviews watch wakes once per new review, the next pass re-delivers nothing, and a second review wakes again", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        assert.equal(reply.existing, false);

        // A review arrives after the watch: it wakes, exactly once —
        // whoever wrote it, the registering session's own reviewer
        // identity included, because the agent asked to know.
        state.reviews.set("83", [
          {
            id: 163,
            reviewer: "zenigata",
            state: "REQUEST_CHANGES",
            url: "https://example.invalid/acme/widgets/pulls/83#issuecomment-15302",
          },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        assert.ok(mail.text.startsWith("<system-reminder>"));
        assert.ok(mail.text.endsWith("</system-reminder>"));
        assert.ok(mail.text.includes("Forgejo mail — watch review"));
        assert.ok(
          mail.text.includes(
            `watch ${reply.id} — pr-reviews 83 on acme/widgets`,
          ),
        );
        assert.ok(
          mail.text.includes(
            "review 163 by zenigata — REQUEST_CHANGES on acme/widgets#83",
          ),
        );
        assert.ok(
          mail.text.includes(
            "url https://example.invalid/acme/widgets/pulls/83#issuecomment-15302",
          ),
        );

        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.deepEqual(row.delivered, { 163: true });
        assert.equal(row.claimedBy, undefined);

        // The poll budget rode as one read: the tool's largest page, and
        // never a page walk.
        assert.ok(routeCount(state, /\/pulls\/83\/reviews$/) >= 1);
        for (const read of state.calls.filter((call) =>
          /\/pulls\/83\/reviews$/.test(call.path),
        )) {
          assert.deepEqual(read.query, { limit: "50" });
        }

        // Delivered once, ever: further passes re-send nothing.
        await settle(60);
        assert.equal(fixture.mails.length, 1);

        // A second review — a new id, by the registering session's own
        // reviewer identity — wakes again, once.
        state.reviews.set("83", [
          {
            id: 163,
            reviewer: "zenigata",
            state: "REQUEST_CHANGES",
            url: "https://example.invalid/acme/widgets/pulls/83#issuecomment-15302",
          },
          {
            id: 165,
            reviewer: "example-user",
            state: "COMMENT",
          },
        ]);
        await waitFor(() => fixture.mails.length === 2);
        assert.ok(
          fixture.mails[1].text.includes(
            "review 165 by example-user — COMMENT on acme/widgets#83",
          ),
        );
        assert.ok(
          !fixture.mails[1].text.includes("url "),
          "no url is invented where the server gave none",
        );
        assert.deepEqual(stampedWatches(fixture, "ses-1").at(0)!.delivered, {
          163: true,
          165: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 2, "no wake repeats");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a PENDING review never wakes; submitting it later wakes its verdict", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => routeCount(state, /\/pulls\/83\/reviews$/) > 0);
        await settle(30);
        assert.equal(
          fixture.mails.length,
          0,
          "an empty pull request says nothing",
        );

        // A draft and a verdict ride the same page: the draft (PENDING)
        // never wakes, the verdict does.
        state.reviews.set("83", [
          { id: 180, reviewer: "zenigata", state: "PENDING" },
          { id: 181, reviewer: "zenigata", state: "APPROVED" },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes(
            "review 181 by zenigata — APPROVED on acme/widgets#83",
          ),
        );
        assert.ok(
          !fixture.mails[0].text.includes("review 180"),
          "the draft is not named in any mail",
        );
        assert.deepEqual(stampedWatches(fixture, "ses-1").at(0)!.delivered, {
          181: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);

        // Submitting the draft flips its state; the id was never spent,
        // so the verdict wakes.
        state.reviews.set("83", [
          { id: 180, reviewer: "zenigata", state: "APPROVED" },
          { id: 181, reviewer: "zenigata", state: "APPROVED" },
        ]);
        await waitFor(() => fixture.mails.length === 2);
        assert.ok(
          fixture.mails[1].text.includes(
            "review 180 by zenigata — APPROVED on acme/widgets#83",
          ),
        );
        assert.deepEqual(stampedWatches(fixture, "ses-1").at(0)!.delivered, {
          180: true,
          181: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 2, "no wake repeats");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("register spends the backlog: a PR already carrying reviews wakes nobody until a new id arrives", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.reviews.set("83", [
      {
        id: 163,
        reviewer: "zenigata",
        state: "REQUEST_CHANGES",
        url: "https://example.invalid/acme/widgets/pulls/83#issuecomment-15302",
      },
      { id: 165, reviewer: "example-user", state: "COMMENT" },
    ]);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
          { sessionID: "ses-1" },
        );
        // The register path's own baseline read: one read, the tool's
        // largest page, and the page's ids ride the watch's stamp as
        // spent markers at creation.
        const reads = state.calls.filter((call) =>
          /\/pulls\/83\/reviews$/.test(call.path),
        );
        assert.equal(reads.length, 1);
        assert.deepEqual(reads[0].query, { limit: "50" });
        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.deepEqual(row.delivered, { 163: true, 165: true });
        assert.equal(row.baseline, undefined);
        assert.equal(fixture.mails.length, 0);

        // The poll passes read the same page and wake nobody: both ids
        // are idempotent-spent.
        await settle(60);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);

        // A review that arrives after the register wakes once.
        state.reviews.set("83", [
          {
            id: 163,
            reviewer: "zenigata",
            state: "REQUEST_CHANGES",
            url: "https://example.invalid/acme/widgets/pulls/83#issuecomment-15302",
          },
          { id: 165, reviewer: "example-user", state: "COMMENT" },
          { id: 171, reviewer: "zenigata", state: "APPROVED" },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes(
            "review 171 by zenigata — APPROVED on acme/widgets#83",
          ),
        );
        assert.deepEqual(stampedWatches(fixture, "ses-1").at(0)!.delivered, {
          163: true,
          165: true,
          171: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a register whose baseline read cannot run stamps baseline-pending; the first pass spends the page and wakes nobody", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.reviews.set("83", [
      { id: 163, reviewer: "zenigata", state: "REQUEST_CHANGES" },
      { id: 165, reviewer: "example-user", state: "COMMENT" },
    ]);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The forge is down at register: the baseline read fails, and
        // the watch still stands — stamped baseline-pending.
        state.outage = true;
        await tool(fixture, "watcher_register").execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
          { sessionID: "ses-1" },
        );
        const row = stampedWatches(fixture, "ses-1").at(0)!;
        assert.equal(row.baseline, "pending");
        assert.deepEqual(row.delivered, {});

        // Recovery: the first pass takes the baseline instead — the page
        // as it stands is the backlog, spent whole, waking nobody.
        state.outage = false;
        await waitFor(() => {
          const current = stampedWatches(fixture, "ses-1").at(0)!;
          return current.baseline === undefined;
        });
        assert.deepEqual(stampedWatches(fixture, "ses-1").at(0)!.delivered, {
          163: true,
          165: true,
        });
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");
        await settle(60);
        assert.equal(fixture.mails.length, 0);

        // A review that arrives after the register wakes once.
        state.reviews.set("83", [
          { id: 163, reviewer: "zenigata", state: "REQUEST_CHANGES" },
          { id: 165, reviewer: "example-user", state: "COMMENT" },
          { id: 171, reviewer: "zenigata", state: "APPROVED" },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes(
            "review 171 by zenigata — APPROVED on acme/widgets#83",
          ),
        );
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("the pr-reviews kind validates at register and is idempotent per session; another session owns its own watch", async () => {
  const forge = await startForge(forgeState());
  try {
    const fixture = fakeContext(
      [
        { id: "ses-1", metadata: {} },
        { id: "ses-2", metadata: {} },
      ],
      NAMED(forge.url),
    );
    await withEnv({}, async () => {
      const cleanup = await boot(fixture);
      try {
        const register = tool(fixture, "watcher_register");
        const first = JSON.parse(
          (
            await register.execute(
              { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(first.ok, true);
        assert.equal(first.existing, false);

        // Idempotent per session, like the existing kinds.
        const again = JSON.parse(
          (
            await register.execute(
              { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(again.existing, true);
        assert.equal(again.id, first.id);
        assert.equal(
          again.delivery,
          "already watching (this session owns the watch)",
        );
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);

        // A review watch is not claimed across sessions: the second
        // session's register mints its own watch, stamped on its own
        // session, so both wake.
        const other = JSON.parse(
          (
            await register.execute(
              { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
              { sessionID: "ses-2" },
            )
          ).content,
        );
        assert.equal(other.ok, true);
        assert.equal(other.existing, false);
        assert.notEqual(other.id, first.id);
        assert.equal(stampedWatches(fixture, "ses-2").length, 1);

        await assert.rejects(
          register.execute(
            { kind: "pr-review", repo: "acme/widgets", ref: "83" },
            { sessionID: "ses-1" },
          ),
          /kind must be one of run, pr, branch, pr-reviews/,
        );
        await assert.rejects(
          register.execute(
            { kind: "pr-reviews", repo: "acme/widgets", ref: "eighty-three" },
            { sessionID: "ses-1" },
          ),
          /numeric pr-reviews index/,
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a forge outage waits on a pr-reviews watch too; the next pass still delivers", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "83" },
          { sessionID: "ses-1" },
        );
        // The outage begins mid-life: the passes now skip and say, and
        // nothing delivers until the server recovers.
        state.outage = true;
        state.reviews.set("83", [
          { id: 163, reviewer: "zenigata", state: "APPROVED" },
        ]);
        await settle(60);
        assert.equal(fixture.mails.length, 0, "an outage delivers nothing");

        state.outage = false;
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes(
            "review 163 by zenigata — APPROVED on acme/widgets#83",
          ),
        );
        await settle(40);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("reviews on an unregistered pull request wake nobody", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    // Reviews sit on PR 44, which nobody watches; PR 43 carries none.
    state.reviews.set("44", [
      { id: 170, reviewer: "zenigata", state: "REQUEST_CHANGES" },
    ]);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        await settle(60);
        assert.equal(fixture.mails.length, 0);
        assert.ok(
          !state.calls.some((call) => /\/pulls\/44\/reviews$/.test(call.path)),
          "the watcher read only the registered pull request",
        );

        // A review on the registered pull request wakes.
        state.reviews.set("43", [
          { id: 171, reviewer: "example-user", state: "COMMENT" },
        ]);
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          fixture.mails[0].text.includes(
            "review 171 by example-user — COMMENT on acme/widgets#43",
          ),
        );

        // More reviews on the unregistered pull request stay silent.
        state.reviews.set("44", [
          { id: 170, reviewer: "zenigata", state: "REQUEST_CHANGES" },
          { id: 172, reviewer: "zenigata", state: "COMMENT" },
        ]);
        await settle(40);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a forge outage logs and waits; the next pass still delivers", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.runs.set(
      18197,
      makeRun({ id: 18197, index_in_repo: 62, status: "success" }),
    );
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18197" },
          { sessionID: "ses-1" },
        );
        // The outage begins mid-life: the passes now skip and say, and
        // nothing delivers until the server recovers.
        state.outage = true;
        await settle(60);
        assert.equal(fixture.mails.length, 0, "an outage delivers nothing");

        state.outage = false;
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("run 18197 (#62) — success"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a reload re-adopts stamped watches and spent verdicts stay spent", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const SHA_ONE = "49583ae5f3f234e83f61027992b56271acbf1ffa";
    const SHA_TWO = "879fe5e67e4dbcdb277b5372abd39c7c5ceae1de";
    state.prHeads.set("43", SHA_ONE);
    state.runs.set(
      18197,
      makeRun({
        id: 18197,
        index_in_repo: 62,
        status: "success",
        commit_sha: SHA_ONE,
      }),
    );
    state.runs.set(
      18199,
      makeRun({
        id: 18199,
        index_in_repo: 64,
        status: "success",
        commit_sha: SHA_TWO,
      }),
    );
    const preexisting = {
      id: "w-pre0000",
      session: "ses-old",
      kind: "pr",
      repo: "acme/widgets",
      ref: "43",
      claimedBy: "ses-old",
      note: "review pending",
      delivered: { 18197: true },
    };
    const fixture = fakeContext(
      [
        { id: "ses-old", metadata: { chancery: { watches: [preexisting] } } },
        { id: "ses-plain", metadata: {} },
      ],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The head carries SHA_ONE only so far: run 18197 was already
        // spent before the reload, so this pass must deliver nothing.
        await settle(60);
        assert.equal(
          fixture.mails.length,
          0,
          "a spent verdict never re-delivers",
        );

        state.prHeads.set("43", SHA_TWO);
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-old");
        assert.ok(mail.text.includes("run 18199 (#64) — success"));
        assert.ok(mail.text.includes("watch w-pre0000"));
        assert.ok(
          mail.text.includes("— pr 43 on acme/widgets — review pending"),
        );

        const row = stampedWatches(fixture, "ses-old").at(0)!;
        assert.deepEqual(row.delivered, { 18197: true, 18199: true });
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a deleted session stops delivering", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.prHeads.set("43", "6ee1211ada380e55f6a580c7cc20ec673b7b320b");
    state.runs.set(
      18197,
      makeRun({ id: 18197, index_in_repo: 62, status: "success" }),
    );
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "pr", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
        await fixture.emit("session.deleted", { sessionID: "ses-1" });
        await settle(60);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("a failing job beyond the read cap keeps its log tail out of the mail, and the cut is said", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const jobs = Array.from({ length: 1005 }, (_, index) => ({
      id: 120000 + index,
      name: `job-${index}`,
      status: "success",
    }));
    state.runs.set(18199, makeRun({ id: 18199, status: "success" }));
    state.jobs.set(18199, jobs);
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18199" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => fixture.mails.length === 1);
        assert.equal(routeCount(state, /\/jobs$/), 1);
        assert.ok(
          logged.some((line) =>
            line.includes(
              "run 18199 of acme/widgets lists 1005 jobs; its verdict reads the first 1000",
            ),
          ),
          logged.join("\n"),
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await forge.close();
  }
});

test("a missing run answers as a 404; the watch waits and delivers once the run exists", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18197" },
          { sessionID: "ses-1" },
        );
        await waitFor(() => routeCount(state, /\/actions\/runs\/18197$/) > 0);
        await settle(30);
        assert.equal(fixture.mails.length, 0, "a missing run delivers nothing");
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);

        state.runs.set(18197, makeRun({ id: 18197, status: "success" }));
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("run 18197 (#62) — success"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await forge.close();
  }
});

test("the forge's own error text never carries the token, and the log's route names no credential", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // An outage whose body echoes a secret-looking string: the watcher's
    // failures name the route and the status only.
    state.echo = " (upstream hunter2)";
    state.outage = true;
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18197" },
          { sessionID: "ses-1" },
        );
        await waitFor(() =>
          logged.some(
            (line) =>
              line.includes("watch 0x poll failed") ||
              line.includes("poll failed"),
          ),
        );
        await settle(20);
      } finally {
        await cleanup?.();
      }
    });
    const failure = logged.find((line) => line.includes("poll failed"))!;
    assert.ok(
      failure.includes("GET /repos/acme/widgets/actions/runs/18197"),
      failure,
    );
    assert.ok(!failure.includes("forge-token"), failure);
    assert.ok(!failure.includes("hunter2"), failure);
  } finally {
    console.error = original;
    await forge.close();
  }
});

test("cleanup waits for a poll pass in flight, and a pass that outlasts the wait writes nothing after", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    state.runs.set(18197, makeRun({ id: 18197, status: "success" }));
    const run = async (openAfterMs: number | null) => {
      const fixture = fakeContext(
        [{ id: "ses-1", metadata: {} }],
        NAMED(forge.url),
      );
      let writes = 0;
      const update = fixture.ctx.session.update;
      fixture.ctx.session.update = async (input: any) => {
        writes += 1;
        return update(input);
      };
      const read = gated();
      let after = { writes: 0, mails: 0 };
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        const cleanup = await boot(fixture);
        state.gates.set("/actions/runs/18197", read.gate);
        const reads = state.calls.length;
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18197" },
          { sessionID: "ses-1" },
        );
        const registered = writes;
        await waitFor(() =>
          state.calls
            .slice(reads)
            .some((call) => /\/actions\/runs\/18197$/.test(call.path)),
        );
        if (openAfterMs !== null) setTimeout(read.open, openAfterMs);
        await cleanup?.();
        after = { writes: writes - registered, mails: fixture.mails.length };
      });
      read.open();
      state.gates.delete("/actions/runs/18197");
      await settle(40);
      return { after, end: { writes, mails: fixture.mails.length }, fixture };
    };

    // The pass finishes inside the wait: its verdict lands before cleanup
    // resolves.
    const quick = await run(30);
    assert.deepEqual(quick.after, { writes: 1, mails: 1 });
    assert.equal(quick.end.mails, 1);

    // The pass outlasts the wait: nothing lands once cleanup has resolved.
    const slow = await run(null);
    assert.deepEqual(slow.after, { writes: 0, mails: 0 });
    assert.equal(slow.end.mails, 0, JSON.stringify({ slow, logged }));
    assert.equal(slow.end.writes, slow.after.writes + 1);
  } finally {
    console.error = original;
    await forge.close();
  }
});

test("a stamp write in flight at cleanup still sends its verdict's mail", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.runs.set(18201, makeRun({ id: 18201, status: "failure" }));
    state.jobs.set(18201, [{ id: 140001, name: "test", status: "failure" }]);
    state.logs.set(140001, "the failing line");
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      await tool(fixture, "watcher_register").execute(
        { kind: "run", repo: "acme/widgets", ref: "18201" },
        { sessionID: "ses-1" },
      );
      // The verdict's stamp write is held past cleanup's wait.
      const write = gated();
      let entered = false;
      const update = fixture.ctx.session.update;
      fixture.ctx.session.update = async (input: any) => {
        entered = true;
        await write.gate;
        return update(input);
      };
      try {
        await waitFor(() => entered);
      } finally {
        await cleanup?.();
      }
      assert.equal(fixture.mails.length, 0);
      write.open();
      await waitFor(() => fixture.mails.length === 1);
    });
    // The detail was read before the stamp, so the mail carries it.
    assert.ok(fixture.mails[0].text.includes("the failing line"));
    assert.deepEqual(stampedWatches(fixture, "ses-1")[0].delivered, {
      18201: true,
    });
  } finally {
    await forge.close();
  }
});

test("a verdict read still in flight at cleanup writes no stamp, leaving it for the next load", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.runs.set(18202, makeRun({ id: 18202, status: "failure" }));
    state.jobs.set(18202, [{ id: 140002, name: "test", status: "failure" }]);
    state.logs.set(140002, "the failing line");
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    const log = gated();
    // The debug line the stopped pass leaves is the signal it finished.
    const logged: string[] = [];
    const original = console.error;
    const level = process.env.MEMORY_SPAN_LOG;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    process.env.MEMORY_SPAN_LOG = "debug";
    try {
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        const cleanup = await boot(fixture);
        state.gates.set("/logs", log.gate);
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18202" },
          { sessionID: "ses-1" },
        );
        try {
          await waitFor(() => state.held.includes("/logs"));
        } finally {
          await cleanup?.();
        }
      });
      log.open();
      await waitFor(() =>
        logged.some((line) => /verdict\.unstamped id=\S+ run=18202/.test(line)),
      );
    } finally {
      console.error = original;
      if (level === undefined) delete process.env.MEMORY_SPAN_LOG;
      else process.env.MEMORY_SPAN_LOG = level;
    }
    assert.ok(routeCount(state, /\/logs$/) > 0);
    assert.equal(fixture.mails.length, 0);
    const delivered = stampedWatches(fixture, "ses-1")[0].delivered ?? {};
    assert.deepEqual(Object.keys(delivered), []);
  } finally {
    await forge.close();
  }
});

test("a stamp an old instance writes after a new one adopted keeps the verdict to one mail", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  try {
    state.runs.set(18203, makeRun({ id: 18203, status: "success" }));
    const listRows: SessionRow[] = [{ id: "ses-1", metadata: {} }];
    const fixture = fakeContext(listRows, NAMED(forge.url));
    const update = fixture.ctx.session.update;
    let writes = 0;
    const logged: string[] = [];
    const original = console.error;
    const level = process.env.MEMORY_SPAN_LOG;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    process.env.MEMORY_SPAN_LOG = "debug";
    try {
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        // The old instance registers, then its verdict's stamp write is
        // held past its cleanup.
        const oldCleanup = await boot(fixture);
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18203" },
          { sessionID: "ses-1" },
        );
        const write = gated();
        let entered = false;
        fixture.ctx.session.update = async (input: any) => {
          writes += 1;
          if (!entered) {
            entered = true;
            await write.gate;
          }
          return update(input);
        };
        try {
          await waitFor(() => entered);
        } finally {
          await oldCleanup?.();
        }

        // The new instance adopts the stamp as it reads before that write
        // lands, and its first run read is held.
        listRows[0].metadata = structuredClone(
          fixture.sessions.get("ses-1")!.metadata,
        );
        const read = gated();
        state.gates.set("/actions/runs/18203", read.gate);
        const newCleanup = await boot(fixture);
        try {
          await waitFor(() => state.held.includes("/actions/runs/18203"));

          // The old write lands and the old instance mails.
          write.open();
          await waitFor(() => fixture.mails.length === 1);

          read.open();
          state.gates.delete("/actions/runs/18203");
          const before = routeCount(state, /\/actions\/runs\/18203$/);
          await waitFor(
            () => routeCount(state, /\/actions\/runs\/18203$/) >= before + 3,
          );
        } finally {
          await newCleanup?.();
        }
      });
    } finally {
      console.error = original;
      if (level === undefined) delete process.env.MEMORY_SPAN_LOG;
      else process.env.MEMORY_SPAN_LOG = level;
    }
    assert.equal(fixture.mails.length, 1);
    // The old instance's stamp write is the only verdict write.
    assert.equal(writes, 1);
    // The new instance found the marker in the fresh stamp.
    assert.ok(
      logged.some((line) => /verdict\.already id=\S+ run=18203/.test(line)),
      logged.join("\n"),
    );
    assert.deepEqual(stampedWatches(fixture, "ses-1")[0].delivered, {
      18203: true,
    });
  } finally {
    await forge.close();
  }
});

test("a stamp write that throws after it was applied still mails the verdict once", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  const original = console.error;
  console.error = () => {};
  try {
    state.runs.set(18204, makeRun({ id: 18204, status: "success" }));
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      NAMED(forge.url),
    );
    const update = fixture.ctx.session.update;
    let writes = 0;
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "run", repo: "acme/widgets", ref: "18204" },
          { sessionID: "ses-1" },
        );
        fixture.ctx.session.update = async (input: any) => {
          writes += 1;
          const result = await update(input);
          if (writes === 1) throw new Error("the response was lost");
          return result;
        };
        await waitFor(() => fixture.mails.length === 1);
        const before = state.calls.length;
        await waitFor(() => state.calls.length >= before + 3);
      } finally {
        await cleanup?.();
      }
    });
    assert.equal(fixture.mails.length, 1);
    assert.deepEqual(stampedWatches(fixture, "ses-1")[0].delivered, {
      18204: true,
    });
  } finally {
    console.error = original;
    await forge.close();
  }
});

test("a registration dispose that throws still lets cleanup finish its steps", async () => {
  const state = forgeState();
  const forge = await startForge(state);
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([], NAMED(forge.url));
    fixture.ctx.tool.transform = async (fn: any) => {
      fn({ add: () => {} });
      return {
        dispose: () => {
          throw new Error("dispose broke");
        },
      };
    };
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      await settle(30);
      await cleanup?.();
    });
    assert.ok(
      logged.some((line) =>
        line.includes(
          "cleanup: tool registration failed: Error: dispose broke",
        ),
      ),
      logged.join("\n"),
    );
    assert.ok(
      logged.every((line) => !line.includes("cleanup: projection failed")),
      logged.join("\n"),
    );
  } finally {
    console.error = original;
    await forge.close();
  }
});
