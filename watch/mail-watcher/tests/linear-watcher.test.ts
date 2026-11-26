import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchStamps, readStamps } from "../index.ts";
import { boot as harnessBoot } from "./watcher-harness.ts";
import { LinearSource, classifyWakes } from "../linear.ts";

// The Linear source (PRJ-475) as the forge watches' test files host its
// side: setup() reads the operator's config — the forge legs it already
// carried, plus the linear block (token, optional api base, and the
// project-to-director mapping) — and polls the fake Linear GraphQL
// server here on 127.0.0.1. The fake serves /graphql the way the live
// endpoint does: the project filter rides the variables and is honored
// (each watched project's read answers that project's issues alone),
// the page size clamps what `first` asked, and pageInfo carries the
// walk's end. The temporal filter (updatedAt gte) is deliberately NOT
// honored — the fake serves old and new issues alike — so the source's
// post-read re-check against its own registration cursor is exercised
// too. The forge legs the watcher always runs beside this source answer
// from a loopback fake of their own (startForgeFake), so no test in
// this file dials DNS: every fixture url is loopback, and no test
// leaves the loopback fakes or writes outside tmpdir.

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
  ref?: string;
  note?: string;
  since?: string;
  delivered?: Record<string, boolean>;
  markedAt?: Record<string, string>;
};

type SessionRow = {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type CommentSpec = {
  id: string;
  createdAt: string;
  author?: string;
  // The body is the tripwire: it must never reach a mail line.
  body?: string;
};

type IssueSpec = {
  id: string;
  identifier: string;
  title?: string;
  url?: string;
  updatedAt: string;
  stateName?: string;
  comments?: CommentSpec[];
  project?: string;
};

type LnState = {
  issues: IssueSpec[];
  // The fake's own page-size clamp: the walk must page around it.
  pageSize: number;
  calls: Array<{ variables?: Record<string, unknown> }>;
  auth: string[];
  outage: boolean;
  // A query-level GraphQL error, when the test wants one.
  gqlError: boolean;
  // A status message the failures carry — the redaction test fills it.
  echo: string;
  // A per-response delay for the issues route, in ms: the leg-budget
  // test's slow upstream.
  delayMs?: number;
  // The drift the source must not read as a list end: the page claims
  // more without carrying a cursor to walk with.
  noEndCursor: boolean;
  // One node per page the boundary cannot name: served without an
  // identifier, dropped by the source's boundary.
  dropOne: boolean;
};

function lnState(): LnState {
  return {
    issues: [],
    pageSize: 50,
    calls: [],
    auth: [],
    outage: false,
    gqlError: false,
    echo: "",
    noEndCursor: false,
    dropOne: false,
  };
}

async function startLinear(state: LnState) {
  const server = http.createServer((req, res) => {
    const reject = (code: number, text: string) => {
      // The tripwire's channel: Node's fetch surfaces a custom reason
      // phrase as response.statusText — proven by the pagerduty red
      // run (review 346's 16410). The moment the client copies that
      // channel back into an error, the redaction test fails.
      const reason = state.echo ? `${text}${state.echo}` : text;
      const credential = String(req.headers.authorization ?? "").trim();
      res.writeHead(code, credential ? `${reason} ${credential}` : reason, {
        "content-type": "text/plain",
      });
      res.end(reason);
    };
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      state.auth.push(String(req.headers.authorization ?? ""));
      if (state.outage) {
        reject(500, "linear outage");
        return;
      }
      if (!new URL(req.url ?? "/", "http://x").pathname.endsWith("/graphql")) {
        reject(404, "no such route");
        return;
      }
      let body: { query?: string; variables?: Record<string, unknown> };
      try {
        body = JSON.parse(raw);
      } catch {
        reject(400, "unparseable body");
        return;
      }
      state.calls.push({ variables: body.variables });
      if (state.gqlError) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "query failed" }] }));
        return;
      }
      const variables = body.variables ?? {};
      const filter = (variables.filter ?? {}) as {
        project?: { id?: { eq?: string } };
        updatedAt?: { gte?: string };
      };
      // The project filter is honored like the live api; the temporal
      // filter is deliberately ignored (served old and new alike).
      const project = filter.project?.id?.eq ?? "";
      const limit = Math.max(1, Math.min(state.pageSize, 50));
      const after = typeof variables.after === "string" ? variables.after : "";
      const offset = after === "" ? 0 : Number(after.slice(5)) || 0;
      const matches = state.issues.filter(
        (issue) => (issue.project ?? PROJECT_ID) === project,
      );
      const windowed = matches.slice(offset, offset + limit);
      const nodes = windowed.map((issue, index) => {
        if (state.dropOne && index === 0) {
          // The node the boundary cannot name: no identifier, no id.
          return { updatedAt: issue.updatedAt };
        }
        return {
          id: issue.id,
          identifier: issue.identifier,
          ...(issue.title !== undefined ? { title: issue.title } : {}),
          ...(issue.url !== undefined ? { url: issue.url } : {}),
          updatedAt: issue.updatedAt,
          ...(issue.stateName !== undefined
            ? { state: { name: issue.stateName } }
            : {}),
          comments: {
            nodes: (issue.comments ?? []).map((comment) => ({
              id: comment.id,
              createdAt: comment.createdAt,
              ...(comment.body !== undefined ? { body: comment.body } : {}),
              ...(comment.author !== undefined
                ? { user: { name: comment.author } }
                : {}),
            })),
          },
        };
      });
      const answer = {
        data: {
          issues: {
            nodes,
            pageInfo: {
              hasNextPage: offset + limit < matches.length,
              ...(state.noEndCursor
                ? {}
                : { endCursor: `after${offset + limit}` }),
            },
          },
        },
      };
      const reply = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      };
      if (state.delayMs) {
        setTimeout(reply, state.delayMs);
        return;
      }
      reply();
    });
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

// The forge legs' loopback fake: the watcher always runs its forge side
// beside the linear one (the config throws without it), and every pass
// polls it before the linear leg. The answer here is an empty JSON
// array for every /api/v1 route — an empty open-PR list for the
// projection's walk — so nothing here ever reaches a forge verdict, and
// every read the forge legs make stays on the loopback.
async function startForgeFake() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

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
// settles through ctx.session.update, which the host applies as a
// whole-record replace — the fake does the same).
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
      subscribe: async function* (_input: { signal: AbortSignal }) {},
    },
  };

  return { ctx, tools, sessions, mails };
}

const TOKEN = "forge-token";
const LN_TOKEN = "linear-token";
const PROJECT_ID = "9f1b2c3d-0000-4000-8000-000000000001";
// The projection's default db path would land in the operator's real
// state home; a sandboxed db keeps the header's no-writes-outside-tmpdir
// claim true.
const DB_PATH = join(
  mkdtempSync(join(tmpdir(), "linear-watcher-state-")),
  "pr-state.db",
);

// The watcher's plugins entry: the forge legs pointed at the loopback
// fake every test starts, plus the linear block under test.
const optionsWith = (forgeUrl: string, linear: unknown) => ({
  watcher: {
    forgeUrl,
    forgeToken: TOKEN,
    dbPath: DB_PATH,
    ...(linear !== undefined ? { linear } : {}),
  },
});

const ENV_KEYS = [
  "WATCHER_POLL_SECONDS",
  "FORGEJO_BASE_URL",
  "FORGEJO_TOKEN",
  "LINEAR_TOKEN",
  "LINEAR_API_URL",
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

async function boot(fixture: ReturnType<typeof fakeContext>) {
  return harnessBoot(fixture.ctx);
}

const tool = (fixture: ReturnType<typeof fakeContext>, name: string): ToolDef =>
  fixture.tools.get(name)!;

const mkIssue = (over: Partial<IssueSpec>): IssueSpec => ({
  id: "9f1b2c3d-0000-4000-8000-000000000abc",
  identifier: "PRJ-475",
  title: "the linear watcher",
  url: "https://example.invalid/ticket/PRJ-475",
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  stateName: "Backlog",
  comments: [],
  project: PROJECT_ID,
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

const linearRow = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
  project: string,
): WatchRow | undefined =>
  stampedWatches(fixture, sessionID).find(
    (row) => row.kind === "linear" && row.ref === project,
  );

const issueCalls = (state: LnState) => state.calls;

const envelope = (text: string) => {
  assert.ok(text.startsWith("<system-reminder>"), text);
  assert.ok(text.endsWith("</system-reminder>"), text);
  return text;
};

test("a post-registration ticket change wakes its mapped target exactly once, with the claims row and its registration cursor on the target's stamp", async () => {
  const state = lnState();
  // The pre-registration history: an issue last changed a minute before
  // the watch comes into being. It must never wake, however often the
  // pass re-reads it.
  state.issues = [mkIssue({ identifier: "PRJ-100" })];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-director", metadata: {} }]);
    const bootAt = Date.now();
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [
        {
          project: PROJECT_ID,
          wake: "ses-director",
          note: "the chancery lane",
        },
      ],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The first pass registers the watch, reads the pre-registration
        // issue, and wakes nobody: the temporal filter spends nothing on
        // the backlog.
        await waitFor(() => issueCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");

        const row = linearRow(fixture, "ses-director", PROJECT_ID)!;
        assert.equal(row.id, `lin-${PROJECT_ID}`);
        assert.equal(row.session, "ses-director");
        assert.equal(row.note, "the chancery lane");
        assert.deepEqual(row.delivered, {});
        // The cursor is the registration moment: the whole window the
        // read can ever serve starts there.
        const registered = Date.parse(row.since!);
        assert.ok(
          Math.abs(registered - bootAt) < 5_000,
          `since is the registration moment: ${row.since}`,
        );

        // Every read rode the api key in the header, unadorned.
        assert.ok(state.auth.length > 0);
        assert.deepEqual([...new Set(state.auth.filter(Boolean))], [LN_TOKEN]);
        // Every read asked the wire for this project's issues at or
        // after the registration cursor.
        for (const call of issueCalls(state)) {
          const filter = call.variables?.filter as any;
          assert.equal(filter?.project?.id?.eq, PROJECT_ID);
          const since = Date.parse(filter?.updatedAt?.gte ?? "");
          assert.ok(
            Math.abs(since - registered) < 5_000,
            `the wire carried the cursor: ${filter?.updatedAt?.gte}`,
          );
        }

        // The ticket changes after registration: it wakes, once.
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) =>
          issue.identifier === "PRJ-100"
            ? { ...issue, updatedAt: now, stateName: "In Progress" }
            : issue,
        );
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-director");
        const text = envelope(mail.text);
        assert.ok(text.includes("Linear mail — ticket change"), text);
        assert.ok(
          text.includes(
            `watch lin-${PROJECT_ID} — linear ${PROJECT_ID} — the chancery lane`,
          ),
          text,
        );
        assert.ok(text.includes("PRJ-100 — changed"), text);
        assert.ok(text.includes("state In Progress"), text);
        assert.ok(text.includes(`updated at ${now}`), text);

        assert.deepEqual(
          linearRow(fixture, "ses-director", PROJECT_ID)!.delivered,
          {
            [`9f1b2c3d-0000-4000-8000-000000000abc:${now}`]: true,
          },
        );

        // Delivered once, ever: further passes re-send nothing.
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("a change whose timestamp predates the registration cursor wakes nothing, even served past the wire filter", async () => {
  const state = lnState();
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The watch registers; the fake serves the issues list with the
        // temporal filter ignored (the live api's answer is never leaned
        // on alone).
        await waitFor(() => issueCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        // The ticket "changes" now, but its updatedAt reads as a moment
        // before the registration cursor — a host-and-Linear clock
        // disagreement in the pre-registration past. The post-read
        // re-check drops it: no wake, no marker.
        state.issues = [
          mkIssue({
            identifier: "PRJ-200",
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
            stateName: "Todo",
          }),
        ];
        await settle(60);
        assert.equal(fixture.mails.length, 0, "an old stamp never wakes");
        assert.deepEqual(
          linearRow(fixture, "ses-1", PROJECT_ID)!.delivered,
          {},
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("a new comment wakes once by its own id, spends the bump's change marker, and the comment body never rides the mail", async () => {
  const state = lnState();
  const issueId = "9f1b2c3d-0000-4000-8000-000000000abc";
  const old = new Date(Date.now() - 60_000).toISOString();
  state.issues = [
    mkIssue({
      id: issueId,
      comments: [
        {
          id: "comment-old",
          createdAt: old,
          author: "Grace Hopper",
          body: "an old comment's body",
        },
      ],
    }),
  ];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => issueCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the old comment is the backlog");

        // The new comment: its createdAt lands after the registration
        // cursor, and it is the issue's bump.
        const createdAt = new Date().toISOString();
        const bumped = new Date(Date.parse(createdAt) + 1_000).toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: bumped,
          comments: [
            ...(issue.comments ?? []),
            {
              id: "comment-new",
              createdAt,
              author: "Ada Lovelace",
              body: "the body text the mail must never carry",
            },
          ],
        }));
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        const text = envelope(mail.text);
        assert.ok(text.includes("Linear mail — ticket comment"), text);
        assert.ok(text.includes("PRJ-475 — comment comment-new"), text);
        assert.ok(text.includes("by Ada Lovelace at"), text);
        assert.ok(
          text.includes("url https://example.invalid/ticket/PRJ-475"),
          text,
        );
        // The body never rides the mail — not the old one, not the new.
        assert.ok(!text.includes("body"), text);
        assert.ok(!text.includes("the body text"), text);

        // The comment wake spent its own id and the bump's change
        // marker, so the same bump never wakes twice.
        assert.deepEqual(linearRow(fixture, "ses-1", PROJECT_ID)!.delivered, {
          "comment-new": true,
          [`${issueId}:${bumped}`]: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("an already-spent comment's later bump wakes as the ticket's own change, not a second comment wake", async () => {
  const state = lnState();
  const issueId = "9f1b2c3d-0000-4000-8000-000000000abc";
  state.issues = [mkIssue({ id: issueId })];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => issueCalls(state).length > 0);
        await settle(40);

        // The comment arrives and wakes.
        const createdAt = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: createdAt,
          comments: [{ id: "comment-1", createdAt, author: "Ada", body: "hi" }],
        }));
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("ticket comment"));

        // The comment is edited: the issue bumps again, the comment's
        // createdAt does not. No second comment wake — the bump is the
        // ticket's own change, waking once with the new state.
        const edited = new Date(Date.parse(createdAt) + 2_000).toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: edited,
          stateName: "In Review",
        }));
        await waitFor(() => fixture.mails.length === 2);
        const text = envelope(fixture.mails[1].text);
        assert.ok(text.includes("Linear mail — ticket change"), text);
        assert.ok(text.includes("PRJ-475 — changed"), text);
        assert.ok(text.includes("state In Review"), text);
        await settle(60);
        assert.equal(fixture.mails.length, 2);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("the walk pages around the fake's clamp, and a complete read ratchets the cursor forward", async () => {
  const state = lnState();
  state.pageSize = 2;
  state.issues = [
    mkIssue({ identifier: "PRJ-1" }),
    mkIssue({
      id: "9f1b2c3d-0000-4000-8000-000000000002",
      identifier: "PRJ-2",
    }),
    mkIssue({
      id: "9f1b2c3d-0000-4000-8000-000000000003",
      identifier: "PRJ-3",
    }),
  ];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The watch registers; the fixture's changes then land, each
        // stamped after the registration cursor.
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        assert.equal(fixture.mails.length, 0);
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: now,
        }));
        // Three issues wake across three reads of the clamp's two-per-
        // page: the walk pages on the answer's own cursor.
        await waitFor(() => fixture.mails.length === 3);
        const identifiers = fixture.mails
          .map((mail) => mail.text)
          .map((text) => /PRJ-\d+/.exec(text)?.[0])
          .sort();
        assert.deepEqual(identifiers, ["PRJ-1", "PRJ-2", "PRJ-3"]);
        await settle(60);
        assert.equal(fixture.mails.length, 3);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("composed directly: the leg's pass budget stops the walk after its in-flight read; what it read still settles and the cursor holds", async () => {
  const state = lnState();
  state.pageSize = 1;
  state.delayMs = 80;
  const bootAt = Date.now();
  // The changes carry post-registration timestamps: the budget test's
  // subject is the walk's budget, not the temporal filter.
  const late = new Date(bootAt + 60_000).toISOString();
  state.issues = [
    mkIssue({ identifier: "PRJ-1", updatedAt: late }),
    mkIssue({
      id: "9f1b2c3d-0000-4000-8000-000000000002",
      identifier: "PRJ-2",
      updatedAt: late,
    }),
  ];
  const ln = await startLinear(state);
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const source = new LinearSource({
      config: {
        token: LN_TOKEN,
        url: ln.url,
        projects: [{ project: PROJECT_ID, wake: "ses-1" }],
      },
      ctx: fixture.ctx,
      debug: () => {},
      patchStamps,
      readStamps,
      isStopped: () => false,
      failedWrites: new Set(),
      legBudgetMs: 50,
    });
    await source.poll();
    // The first page's read started inside the budget and landed after
    // it: its issue wakes. The walk then stopped before the second
    // page, so PRJ-2 never read.
    await waitFor(() => fixture.mails.length === 1);
    assert.ok(fixture.mails[0].text.includes("PRJ-1"), fixture.mails[0].text);

    // The cursor holds at the registration moment: an incomplete read
    // advances nothing, so nothing the budget left unread is lost.
    const row = linearRow(fixture, "ses-1", PROJECT_ID)!;
    const registered = Date.parse(row.since!);
    assert.ok(
      Math.abs(registered - bootAt) < 5_000,
      `the cursor holds: ${row.since}`,
    );
    await settle(30);
    assert.equal(fixture.mails.length, 1);
  } finally {
    await ln.close();
  }
});

test("composed directly: a complete read ratchets the cursor forward, and the overlap re-serving wakes nothing twice", async () => {
  const state = lnState();
  const bootAt = Date.now();
  // The change carries a post-registration timestamp: this test's
  // subject is the cursor's ratchet, not the temporal filter.
  const late = new Date(bootAt + 60_000).toISOString();
  state.issues = [mkIssue({ identifier: "PRJ-1", updatedAt: late })];
  const ln = await startLinear(state);
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const bootAt = Date.now();
    const source = new LinearSource({
      config: {
        token: LN_TOKEN,
        url: ln.url,
        projects: [{ project: PROJECT_ID, wake: "ses-1" }],
      },
      ctx: fixture.ctx,
      debug: () => {},
      patchStamps,
      readStamps,
      isStopped: () => false,
      failedWrites: new Set(),
      // A zero skew margin: each complete read ratchets the cursor to
      // its own start moment, instead of holding it at the
      // registration floor for the margin's span.
      skewMs: 0,
    });
    await source.poll();
    await waitFor(() => fixture.mails.length === 1);
    await settle(10);
    // The next read ratchets the cursor to a moment past the first
    // read's start: the ratchet only climbs.
    await source.poll();
    await settle(10);
    const row = linearRow(fixture, "ses-1", PROJECT_ID)!;
    const advanced = Date.parse(row.since!);
    assert.ok(advanced > bootAt, `the cursor ratcheted forward: ${row.since}`);

    // The overlap: the issue's change re-serves inside no future
    // window (its updatedAt now sits behind the ratcheted cursor), and
    // even where a window would carry it the marker holds. No second
    // wake, and the cursor never moves back.
    await source.poll();
    await settle(30);
    assert.equal(fixture.mails.length, 1);
    const after = linearRow(fixture, "ses-1", PROJECT_ID)!;
    assert.ok(Date.parse(after.since!) >= advanced, after.since);
  } finally {
    await ln.close();
  }
});

test("composed directly: classifyWakes applies the temporal re-check, the taxonomy, and the overflow fallback", async () => {
  const now = Date.now();
  const freshUpdatedAt = new Date(now).toISOString();
  const fresh: any = mkIssue({
    id: "i-1",
    identifier: "PRJ-1",
    updatedAt: freshUpdatedAt,
    comments: [
      {
        id: "c-1",
        createdAt: new Date(now - 1_000).toISOString(),
        author: "A",
      },
    ],
  });
  const stale: any = mkIssue({
    id: "i-2",
    identifier: "PRJ-9",
    updatedAt: new Date(now - 60_000).toISOString(),
    comments: [
      {
        id: "c-2",
        createdAt: new Date(now - 61_000).toISOString(),
        author: "B",
      },
    ],
  });
  // A fresh issue with a fresh comment carries the comment candidate
  // (the bump's change marker riding in alsoMark) and the ticket's own
  // change candidate behind it; a stale issue carries nothing. The
  // candidates carry no delivered-marker filter — the settle loop owns
  // at-most-once, and a spent id must stay a candidate for the
  // failed-write recovery to find.
  const first = classifyWakes([fresh, stale], now - 5_000);
  assert.deepEqual(
    first.map((wake) => [wake.kind, wake.id, wake.alsoMark]),
    [
      ["comment", "c-1", [`i-1:${freshUpdatedAt}`]],
      ["change", `i-1:${freshUpdatedAt}`, []],
    ],
  );
  // The same spent id is still a candidate on the next pass.
  const again = classifyWakes([fresh], now - 5_000);
  assert.deepEqual(
    again.map((wake) => wake.id),
    ["c-1", `i-1:${freshUpdatedAt}`],
  );
  // A window full of fresh comments falls back to the ticket's change
  // wake, carrying every fresh id in alsoMark.
  const burst: any = mkIssue({
    id: "i-3",
    identifier: "PRJ-3",
    updatedAt: freshUpdatedAt,
    comments: [1, 2, 3, 4, 5].map((n) => ({
      id: `b-${n}`,
      createdAt: new Date(now - 500).toISOString(),
      author: "B",
    })),
  });
  const fallback = classifyWakes([burst], now - 5_000);
  assert.deepEqual(
    fallback.map((wake) => [wake.kind, wake.id, wake.alsoMark]),
    [["change", `i-3:${freshUpdatedAt}`, ["b-1", "b-2", "b-3", "b-4", "b-5"]]],
  );
});

test("a query-level api error or an outage keeps its pass, names the route, and leaks no credential", async () => {
  for (const flavor of ["gql", "outage"] as const) {
    const state = lnState();
    if (flavor === "outage") {
      state.outage = true;
      state.echo = " (upstream hunter2)";
    } else {
      state.gqlError = true;
    }
    state.issues = [mkIssue({ updatedAt: new Date().toISOString() })];
    const ln = await startLinear(state);
    const forge = await startForgeFake();
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
      fixture.ctx.options = optionsWith(forge.url, {
        token: LN_TOKEN,
        url: ln.url,
        projects: [{ project: PROJECT_ID, wake: "ses-1" }],
      });
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        const cleanup = await boot(fixture);
        try {
          await waitFor(() =>
            logged.some((line) =>
              line.includes(
                `the linear read for project ${PROJECT_ID} keeps its pass`,
              ),
            ),
          );
          await settle(30);
        } finally {
          await cleanup?.();
        }
      });
      const failure = logged.find((line) =>
        line.includes(
          `the linear read for project ${PROJECT_ID} keeps its pass`,
        ),
      )!;
      if (flavor === "outage") {
        assert.ok(failure.includes("POST /graphql"), failure);
        assert.ok(failure.includes("HTTP 500"), failure);
      } else {
        assert.ok(failure.includes("did not parse as an issues page"), failure);
      }
      for (const line of logged) {
        assert.ok(!line.includes(LN_TOKEN), line);
        assert.ok(!line.includes("hunter2"), line);
      }
      assert.equal(fixture.mails.length, 0);
      assert.deepEqual(linearRow(fixture, "ses-1", PROJECT_ID)!.delivered, {});
    } finally {
      console.error = original;
      await ln.close();
      await forge.close();
    }
  }
});

test("a missing token disables the linear source with its named line; the forge source still stands", async () => {
  const state = lnState();
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: undefined,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        assert.ok(
          logged.some((line) =>
            line.includes(
              "the linear source is off: no api token — set options.watcher.linear.token on the watcher's plugins entry, or LINEAR_TOKEN in the host's environment",
            ),
          ),
          logged.join("\n"),
        );
        // The forge source stands: its tools are registered and a watch
        // registers against them.
        assert.ok(tool(fixture, "watcher_register"));
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        await settle(60);
        // The linear source made no read and stamped no claims row.
        assert.equal(issueCalls(state).length, 0);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("readConfig drops malformed and duplicate project entries and keeps the survivors", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const ctx = {
      options: {
        watcher: {
          linear: {
            token: LN_TOKEN,
            projects: [
              { project: PROJECT_ID, wake: "ses-1", note: "kept" },
              { project: "", wake: "ses-1" },
              { project: "second-id", wake: "" },
              { project: PROJECT_ID, wake: "ses-9" },
            ],
          },
        },
      },
    };
    const config = LinearSource.readConfig(ctx)!;
    assert.deepEqual(config.projects, [
      { project: PROJECT_ID, wake: "ses-1", note: "kept" },
    ]);
    assert.ok(
      logged.some((line) =>
        line.includes("a linear projects entry is dropped"),
      ),
      logged.join("\n"),
    );
    assert.ok(
      logged.some((line) =>
        line.includes(`the linear project ${PROJECT_ID} is watched twice`),
      ),
      logged.join("\n"),
    );

    // No block at all: the source is opt-in, and the absence is silent.
    assert.equal(LinearSource.readConfig({ options: { watcher: {} } }), null);
    assert.deepEqual(LinearSource.readConfig({}), null);
  } finally {
    console.error = original;
  }
});

test("a window wider than the page cap: the served set wakes once, the cursor holds, and the tail waits for a later pass", async () => {
  const state = lnState();
  const bootAt = Date.now();
  state.issues = Array.from({ length: 501 }, (_, index) =>
    mkIssue({
      id: `9f1b2c3d-0000-4000-8000-${String(index).padStart(12, "0")}`,
      identifier: index === 500 ? "PRJ-TAIL" : `PRJ-${index}`,
    }),
  );
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The watch registers; the whole backlog then changes at once,
        // stamped after the registration cursor.
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        assert.equal(fixture.mails.length, 0);
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: now,
        }));
        // The walk reads ten pages of fifty and stops at its cap: the
        // five hundred it served wake — once each — and the tail
        // (the 501st change) waits for the window to shrink.
        await waitFor(() => fixture.mails.length === 500, 6000);
        const woken = new Set(
          fixture.mails
            .map((mail) => /PRJ-(\d+|TAIL)/.exec(mail.text)?.[0])
            .filter(Boolean),
        );
        assert.equal(woken.size, 500);
        assert.ok(!woken.has("PRJ-TAIL"), [...woken].join(","));
        // The trade, said on its line: the cap, the hold, the re-read.
        assert.ok(
          logged.some((line) =>
            line.includes(
              `the changed issues ran past ${10} pages of ${50}; the window is re-read whole next pass`,
            ),
          ),
          logged.join("\n"),
        );
        // The cursor holds at the registration moment: the api's
        // ordering direction is not documented, so the pass never
        // assumes the served set precedes the tail it never reached.
        const row = linearRow(fixture, "ses-1", PROJECT_ID)!;
        const registered = Date.parse(row.since!);
        assert.ok(
          Math.abs(registered - bootAt) < 5_000,
          `the cursor holds: ${row.since}`,
        );
        // Further passes re-read the same window: the markers keep it
        // to once, and the tail stays unread.
        await settle(80);
        assert.equal(fixture.mails.length, 500);
        assert.ok(!woken.has("PRJ-TAIL"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a bump whose comment window is full of fresh comments falls back to the ticket's change wake, spending every fresh id", async () => {
  const state = lnState();
  const issueId = "9f1b2c3d-0000-4000-8000-000000000abc";
  state.issues = [mkIssue({ id: issueId })];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        // Five fresh comments land in one bump — the read's whole
        // comment window, and possibly more behind them.
        const createdAt = new Date().toISOString();
        const bumped = new Date(Date.parse(createdAt) + 1_000).toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: bumped,
          comments: [1, 2, 3, 4, 5].map((n) => ({
            id: `comment-${n}`,
            createdAt,
            author: `Author ${n}`,
            body: `body ${n}`,
          })),
        }));
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        // One wake, the ticket's own change — not five comment mails.
        assert.ok(text.includes("Linear mail — ticket change"), text);
        assert.ok(text.includes("PRJ-475 — changed"), text);
        assert.ok(!text.includes("comment comment-"), text);
        // The change marker and every fresh id spent beside it.
        assert.deepEqual(linearRow(fixture, "ses-1", PROJECT_ID)!.delivered, {
          [`${issueId}:${bumped}`]: true,
          "comment-1": true,
          "comment-2": true,
          "comment-3": true,
          "comment-4": true,
          "comment-5": true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("a stamp write that reports failure after applying owes its mail, and the next pass delivers it once", async () => {
  const state = lnState();
  const issueId = "9f1b2c3d-0000-4000-8000-000000000abc";
  state.issues = [mkIssue({ id: issueId })];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const realUpdate = fixture.ctx.session.update;
    let failOn = 0;
    let updateCalls = 0;
    // The apply-then-throw shape: the write lands on the host's record
    // and only then reports failure — patchStamps answers false while
    // the marker it wrote is already spent.
    fixture.ctx.session.update = async (input: {
      sessionID: string;
      metadata: Record<string, unknown>;
    }) => {
      updateCalls += 1;
      if (updateCalls === failOn) {
        await realUpdate(input);
        throw new Error("stamp write exploded");
      }
      return realUpdate(input);
    };
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // The writes: the ensure's create, then the settle's mark. The
      // mark is the one that applies and then reports failure.
      failOn = 2;
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        // The change lands; the settle's mark write applies then
        // reports failed — the marker is spent, the mail is owed, and
        // nothing is delivered this pass.
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: now,
        }));
        await waitFor(() => {
          const row = linearRow(fixture, "ses-1", PROJECT_ID);
          return !!row && !!(row.delivered ?? {})[`${issueId}:${now}`];
        });
        // The next pass finds the spent marker under a failed write and
        // delivers the owed mail — once. (The failed pass and the
        // recovery pass can interleave with this wait, so the proof is
        // the mail's single arrival over three writes: the ensure, the
        // settle that applied then reported failure, and the recovery.)
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(updateCalls >= 3, `update calls: ${updateCalls}`);
        assert.ok(
          fixture.mails[0].text.includes("PRJ-475 — changed"),
          fixture.mails[0].text,
        );
        await settle(60);
        assert.equal(fixture.mails.length, 1, "no double wake");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await ln.close();
    await forge.close();
  }
});

test("a gone wake target is said once, reads nothing, and stamps nothing", async () => {
  const state = lnState();
  state.issues = [mkIssue({ updatedAt: new Date().toISOString() })];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // No session at all: the wake target is not a live session.
    const fixture = fakeContext([]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-gone" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() =>
          logged.some((line) =>
            line.includes(
              "the linear wake target ses-gone for project " +
                `${PROJECT_ID} is not a live session; nothing is delivered to it while it is gone`,
            ),
          ),
        );
        await settle(60);
        // Said once per state change, not once per pass.
        const goneLines = logged.filter((line) =>
          line.includes("is not a live session"),
        );
        assert.equal(goneLines.length, 1);
        // The pass read nothing and stamped nothing: the claims row
        // never existed anywhere.
        assert.equal(issueCalls(state).length, 0);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a page that claims more without a cursor to walk with keeps its pass and holds its window", async () => {
  const state = lnState();
  state.pageSize = 1;
  state.noEndCursor = true;
  state.issues = [
    mkIssue({ identifier: "PRJ-1", updatedAt: new Date().toISOString() }),
    mkIssue({
      id: "9f1b2c3d-0000-4000-8000-000000000002",
      identifier: "PRJ-2",
      updatedAt: new Date().toISOString(),
    }),
  ];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const bootAt = Date.now();
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The issues carry post-registration stamps only after the
        // watch registers (the walk's first pass may predate them).
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: now,
        }));
        await waitFor(() =>
          logged.some((line) =>
            line.includes("the issues answer did not parse as an issues page"),
          ),
        );
        await settle(60);
        assert.equal(fixture.mails.length, 0);
        assert.deepEqual(
          linearRow(fixture, "ses-1", PROJECT_ID)!.delivered,
          {},
        );
        const registered = Date.parse(
          linearRow(fixture, "ses-1", PROJECT_ID)!.since!,
        );
        assert.ok(
          Math.abs(registered - bootAt) < 5_000,
          `the cursor holds: ${registered}`,
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a node the boundary cannot name holds the window, and the set it did name still wakes", async () => {
  const state = lnState();
  state.dropOne = true;
  state.issues = [
    mkIssue({ identifier: "PRJ-BROKEN", updatedAt: new Date().toISOString() }),
    mkIssue({
      id: "9f1b2c3d-0000-4000-8000-000000000002",
      identifier: "PRJ-GOOD",
      updatedAt: new Date().toISOString(),
    }),
  ];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const bootAt = Date.now();
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => issueCalls(state).length > 0);
        await settle(20);
        const now = new Date().toISOString();
        state.issues = state.issues.map((issue) => ({
          ...issue,
          updatedAt: now,
        }));
        // The named node wakes; the window holds for the drop, said on
        // its line.
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("PRJ-GOOD"));
        await waitFor(() =>
          logged.some((line) =>
            line.includes("left 1 nodes it could not name"),
          ),
        );
        const registered = Date.parse(
          linearRow(fixture, "ses-1", PROJECT_ID)!.since!,
        );
        assert.ok(
          Math.abs(registered - bootAt) < 5_000,
          `the cursor holds: ${registered}`,
        );
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a claims row whose cursor does not parse keeps its pass, said once, and heals when the cursor is repaired", async () => {
  const state = lnState();
  state.issues = [mkIssue({})];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([
      {
        id: "ses-1",
        metadata: {
          chancery: {
            watches: [
              {
                id: `lin-${PROJECT_ID}`,
                session: "ses-1",
                kind: "linear",
                ref: PROJECT_ID,
                since: "not-a-date",
                delivered: {},
                markedAt: {},
              },
            ],
          },
        },
      },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The fault is named, once, and the pass reads nothing.
        await waitFor(() =>
          logged.some((line) => line.includes("does not parse as a timestamp")),
        );
        await settle(60);
        const faultLines = logged.filter((line) =>
          line.includes("does not parse as a timestamp"),
        );
        assert.equal(faultLines.length, 1, logged.join("\n"));
        assert.equal(issueCalls(state).length, 0);
        assert.equal(fixture.mails.length, 0);

        // The cursor is repaired: the pass reads again. The fixture's
        // change predates the repaired-by-hand cursor, so nothing
        // wakes — but the read is live.
        const healed = new Date().toISOString();
        const row = (
          fixture.sessions.get("ses-1")!.metadata as Record<string, any>
        ).chancery.watches.find((r: any) => r.kind === "linear");
        row.since = healed;
        await waitFor(() => issueCalls(state).length > 0);
        await settle(60);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a claims row without a cursor re-bases to the read moment, said on its line, and the re-base persists", async () => {
  const state = lnState();
  state.issues = [mkIssue({})];
  const ln = await startLinear(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([
      {
        id: "ses-1",
        metadata: {
          chancery: {
            watches: [
              {
                id: `lin-${PROJECT_ID}`,
                session: "ses-1",
                kind: "linear",
                ref: PROJECT_ID,
                delivered: {},
                markedAt: {},
              },
            ],
          },
        },
      },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: LN_TOKEN,
      url: ln.url,
      projects: [{ project: PROJECT_ID, wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() =>
          logged.some((line) =>
            line.includes("carries no cursor; it re-bases to the read moment"),
          ),
        );
        // The re-base persisted on the stamp: the row now carries a
        // readable cursor at the re-base moment.
        await waitFor(() => {
          const row = linearRow(fixture, "ses-1", PROJECT_ID);
          return !!row && Number.isFinite(Date.parse(row.since ?? ""));
        });
        // The read is live again; the fixture's change predates the
        // re-base, so nothing wakes — the policy's documented cost.
        await waitFor(() => issueCalls(state).length > 0);
        await settle(60);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await ln.close();
    await forge.close();
  }
});

test("a config url carrying a query or a fragment turns the source off, said on its line", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const config = LinearSource.readConfig({
      options: {
        watcher: {
          linear: {
            token: LN_TOKEN,
            url: "https://api.example.com/graphql?key=hunter2",
            projects: [{ project: PROJECT_ID, wake: "ses-1" }],
          },
        },
      },
    });
    assert.equal(config, null);
    assert.ok(
      logged.some((line) =>
        line.includes(
          "the linear source is off: url must be the Linear api's http(s) base without a query or a fragment",
        ),
      ),
      logged.join("\n"),
    );
    // No credential reaches the line.
    for (const line of logged) {
      assert.ok(!line.includes("hunter2"), line);
    }
  } finally {
    console.error = original;
  }
});
