import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

// The GitHub source (github.ts) as the forge watches' test files host its
// side: setup() reads the operator's config — the forge legs it always
// carried, plus the github block (token, optional api base) — and polls
// the fake GitHub REST server here on 127.0.0.1. The fake serves the
// pulls/issues/reviews/comments routes the way the live api does: the
// review list is ordered ascending and walks Link headers (the source's
// tail-page read), the comment list honors direction=desc, and the
// statusText channel carries the redaction tripwire the pagerduty red
// run proven (review 346's 16410). Nothing reads the github api until a
// watch registers (tool-registered kinds poll through the registry), so
// every test registers through the real watcher_register tool first. The
// forge legs the watcher always runs beside this source answer from a
// loopback fake of their own (startForgeFake), so no test in this file
// dials DNS: every fixture url is loopback, and no test leaves the
// loopback fakes or writes outside tmpdir.

type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

type WatchRow = {
  id?: string;
  session?: string;
  kind?: string;
  repo?: string;
  ref?: string;
  note?: string;
  delivered?: Record<string, boolean>;
  [key: string]: unknown;
};

type SessionRow = {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type GhState = {
  pull: Record<string, unknown> | null;
  issue: Record<string, unknown> | null;
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  // When set, the reviews route's first page carries a Link header whose
  // rel="last" names this page — the tail the source must walk to.
  reviewsLinkLast?: number;
  outage: boolean;
  // A status message the failures carry — the redaction test fills it.
  echo: string;
  // When true, every read answers 403 with the rate-limit headers.
  rateLimit: boolean;
  rateLimitReset: number;
  calls: string[];
  auth: string[];
};

function ghState(): GhState {
  return {
    pull: null,
    issue: null,
    reviews: [],
    comments: [],
    outage: false,
    echo: "",
    rateLimit: false,
    rateLimitReset: 0,
    calls: [],
    auth: [],
  };
}

async function startGithub(state: GhState) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    state.calls.push(`${url.pathname}${url.search}`);
    state.auth.push(String(req.headers.authorization ?? ""));
    const reply = (
      code: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const reject = (code: number, text: string) => {
      // The tripwire's channel: Node's fetch surfaces a custom reason
      // phrase as response.statusText. The moment the client copies that
      // channel back into an error, the redaction test fails.
      const reason = state.echo ? `${text}${state.echo}` : text;
      const credential = String(req.headers.authorization ?? "").trim();
      res.writeHead(code, credential ? `${reason} ${credential}` : reason, {
        "content-type": "text/plain",
      });
      res.end(reason);
    };
    if (state.rateLimit) {
      res.writeHead(403, "rate limit exceeded", {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(state.rateLimitReset),
      });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
      return;
    }
    if (state.outage) {
      reject(500, "github outage");
      return;
    }
    const route =
      /^\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/(\d+)(\/(reviews|comments))?$/.exec(
        url.pathname,
      );
    if (!route) {
      reply(404, { message: "no such route" });
      return;
    }
    const [, kind, , , sub] = route;
    if (!sub) {
      const record = kind === "pulls" ? state.pull : state.issue;
      if (record === null) {
        reply(404, { message: "no such row" });
        return;
      }
      reply(200, record);
      return;
    }
    if (sub === "reviews") {
      const perPage = Math.max(
        1,
        Math.min(100, Number(url.searchParams.get("per_page") ?? 30)),
      );
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const slice = state.reviews.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (
        state.reviewsLinkLast !== undefined &&
        page === 1 &&
        state.reviews.length > perPage
      ) {
        const target = `http://${url.host}${url.pathname}?per_page=${perPage}&page=${state.reviewsLinkLast}`;
        headers.Link = `<${target}&after=next>; rel="next", <${target}>; rel="last"`;
      }
      reply(200, slice, headers);
      return;
    }
    // The comments route: newest-first when the wire asks for it — the
    // fake sorts by id desc, the stand-in for created desc.
    const perPage = Math.max(
      1,
      Math.min(50, Number(url.searchParams.get("per_page") ?? 30)),
    );
    const sorted = [...state.comments].sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    if (url.searchParams.get("direction") === "desc") sorted.reverse();
    reply(200, sorted.slice(0, perPage));
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
// beside the github one (the config throws without it), and the answer
// here is an empty JSON array for every /api/v1 route — an empty open-PR
// list for the projection's walk — so nothing here ever reaches a forge
// verdict, and every read the forge legs make stays on the loopback.
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
const GH_TOKEN = "gh-token";
// The projection's default db path would land in the operator's real
// state home; a sandboxed db keeps the header's no-writes-outside-tmpdir
// claim true.
const DB_PATH = join(
  mkdtempSync(join(tmpdir(), "github-watcher-state-")),
  "pr-state.db",
);

// The watcher's plugins entry: the forge legs pointed at the loopback
// fake every test starts, plus the github block under test.
const optionsWith = (forgeUrl: string, github: unknown) => ({
  watcher: {
    forgeUrl,
    forgeToken: TOKEN,
    dbPath: DB_PATH,
    ...(github !== undefined ? { github } : {}),
  },
});

const ENV_KEYS = [
  "WATCHER_POLL_SECONDS",
  "FORGEJO_BASE_URL",
  "FORGEJO_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_API_URL",
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
  return plugin.setup(fixture.ctx);
}

const tool = (fixture: ReturnType<typeof fakeContext>, name: string): ToolDef =>
  fixture.tools.get(name)!;

const REPO = "acme/widgets";
const PULL_URL = "https://github.example.invalid/acme/widgets/pull/12";
const ISSUE_URL = "https://github.example.invalid/acme/widgets/issues/7";

const mkPull = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  number: 12,
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  closed_at: null,
  updated_at: new Date(Date.now() - 60_000).toISOString(),
  html_url: PULL_URL,
  ...over,
});

const mkIssue = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  number: 7,
  state: "open",
  closed_at: null,
  updated_at: new Date(Date.now() - 60_000).toISOString(),
  html_url: ISSUE_URL,
  ...over,
});

const mkReview = (
  id: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  state: "APPROVED",
  submitted_at: new Date(Date.now() - 60_000).toISOString(),
  user: { login: "ada" },
  html_url: `${PULL_URL}#review-${id}`,
  ...over,
});

const mkComment = (
  id: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  user: { login: "grace" },
  html_url: `https://github.example.invalid/acme/widgets#comment-${id}`,
  body: "the body text the mail must never carry",
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

const ghRow = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
  kind: string,
): WatchRow | undefined =>
  stampedWatches(fixture, sessionID).find((row) => row.kind === kind);

const register = async (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
  input: Record<string, unknown>,
): Promise<Record<string, any>> =>
  JSON.parse(
    (
      await tool(fixture, "watcher_register").execute(input, {
        sessionID,
      })
    ).content,
  );

const envelope = (text: string) => {
  assert.ok(text.startsWith("<system-reminder>"), text);
  assert.ok(text.endsWith("</system-reminder>"), text);
  return text;
};

const githubOptions = (gh: { url: string }) => ({
  token: GH_TOKEN,
  url: gh.url,
});

test("a post-registration review wakes its registering session exactly once, with the watch row and its spent baseline on the session's stamp", async () => {
  const state = ghState();
  // The pre-registration history: one review and one comment the PR
  // already carries. They must never wake, however often the pass
  // re-reads them.
  state.pull = mkPull();
  state.reviews = [mkReview(101)];
  state.comments = [mkComment(501)];
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The register's own baseline read is the github api's first
        // read: it spends the backlog at creation.
        const reply = await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        assert.equal(reply.ok, true);
        assert.equal(reply.existing, false);
        assert.ok(state.calls.length > 0, "the baseline read the api");

        await settle(40);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");
        const row = ghRow(fixture, "ses-1", "github-pr")!;
        assert.equal(row.id, reply.id);
        assert.equal(row.repo, REPO);
        assert.equal(row.ref, "12");
        const bootUpdatedAt = state.pull.updated_at as string;
        assert.deepEqual(row.delivered, {
          r101: true,
          c501: true,
          [`chg@${bootUpdatedAt}`]: true,
        });

        // Every read rode the token in the header, in the api's scheme.
        assert.ok(state.auth.length > 0);
        assert.deepEqual(
          [...new Set(state.auth.filter(Boolean))],
          [`Bearer ${GH_TOKEN}`],
        );

        // A review arrives after registration: it wakes, once, carried
        // by reviewer, state, id, and url.
        state.reviews = [
          ...state.reviews,
          mkReview(102, {
            submitted_at: new Date().toISOString(),
          }),
        ];
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        const text = envelope(mail.text);
        assert.ok(text.includes("GitHub mail — PR review"), text);
        assert.ok(
          text.includes(`watch ${reply.id} — github-pr ${REPO}#12`),
          text,
        );
        assert.ok(
          text.includes("review 102 by ada — APPROVED on acme/widgets#12"),
          text,
        );
        assert.ok(
          text.includes(
            "url https://github.example.invalid/acme/widgets/pull/12#review-102",
          ),
          text,
        );
        assert.deepEqual(ghRow(fixture, "ses-1", "github-pr")!.delivered, {
          r101: true,
          c501: true,
          r102: true,
          [`chg@${bootUpdatedAt}`]: true,
        });

        // Delivered once, ever: further passes re-send nothing.
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a new comment wakes once by its own id, and the comment body never rides the mail", async () => {
  const state = ghState();
  state.pull = mkPull();
  state.comments = [mkComment(501)];
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the old comment is the backlog");

        state.comments = [
          ...state.comments,
          mkComment(502, { created_at: new Date().toISOString() }),
        ];
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        assert.ok(text.includes("GitHub mail — PR comment"), text);
        assert.ok(text.includes("acme/widgets#12 — comment 502"), text);
        assert.ok(text.includes("by grace"), text);
        assert.ok(
          text.includes(
            "url https://github.example.invalid/acme/widgets#comment-502",
          ),
          text,
        );
        // The body never rides the mail.
        assert.ok(!text.includes("body"), text);
        assert.ok(!text.includes("the body text"), text);
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a state change with no item wakes once as the record's change, carrying the state and the draft line", async () => {
  const state = ghState();
  state.pull = mkPull();
  state.reviews = [mkReview(101)];
  state.comments = [mkComment(501)];
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0);
        const bootUpdatedAt = state.pull.updated_at as string;

        // The record changes with no item to account for the bump: a
        // draft flip. The change wake fires once, carrying the state the
        // record names now.
        const changedAt = new Date().toISOString();
        state.pull = { ...state.pull, updated_at: changedAt, draft: true };
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        assert.ok(text.includes("GitHub mail — PR change"), text);
        assert.ok(text.includes("acme/widgets#12 — changed"), text);
        assert.ok(text.includes("state open"), text);
        assert.ok(text.includes("draft"), text);
        assert.ok(text.includes(`updated at ${changedAt}`), text);
        assert.ok(text.includes(`url ${PULL_URL}`), text);
        assert.deepEqual(ghRow(fixture, "ses-1", "github-pr")!.delivered, {
          r101: true,
          c501: true,
          [`chg@${bootUpdatedAt}`]: true,
          [`chg@${changedAt}`]: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a comment's arrival is the bump's one wake: no change wake beside it, and no second one on the next pass", async () => {
  const state = ghState();
  state.pull = mkPull();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        // The comment's arrival bumps the record at the same moment:
        // one mail — the comment's — and the change stays silent, this
        // pass and every later one (the item the page still carries is
        // the bump's account, the source's own stateless memory).
        const arrivedAt = new Date().toISOString();
        state.comments = [mkComment(502, { created_at: arrivedAt })];
        state.pull = { ...state.pull, updated_at: arrivedAt };
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("comment 502"));
        await settle(80);
        assert.equal(fixture.mails.length, 1, "the bump never wakes twice");

        // A later edit the record carries alone wakes as the change.
        const editedAt = new Date(Date.parse(arrivedAt) + 2_000).toISOString();
        state.pull = { ...state.pull, updated_at: editedAt, draft: true };
        await waitFor(() => fixture.mails.length === 2);
        const text = envelope(fixture.mails[1].text);
        assert.ok(text.includes("GitHub mail — PR change"), text);
        assert.ok(text.includes("state open"), text);
        await settle(60);
        assert.equal(fixture.mails.length, 2);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a closed pull request ends the watch: one terminal mail, the row dissolves, no forget needed", async () => {
  const state = ghState();
  state.pull = mkPull();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        const closedAt = new Date().toISOString();
        state.pull = {
          ...state.pull,
          state: "closed",
          merged: true,
          merged_at: closedAt,
          closed_at: closedAt,
          updated_at: closedAt,
        };
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        assert.ok(text.includes("GitHub mail — watch closed"), text);
        assert.ok(
          text.includes(`PR ${REPO}#12 closed: merged at ${closedAt}`),
          text,
        );
        // The watch dissolved itself: the row left the stamp.
        await waitFor(() => ghRow(fixture, "ses-1", "github-pr") === undefined);
        await settle(60);
        assert.equal(fixture.mails.length, 1, "no second terminal, no forget");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a watch registered on an already-closed pull request still delivers the close", async () => {
  const state = ghState();
  const closedAt = new Date(Date.now() - 60_000).toISOString();
  state.pull = mkPull({
    state: "closed",
    merged: false,
    merged_at: null,
    closed_at: closedAt,
    updated_at: closedAt,
  });
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        // The first-terminal rule: a watch created after a fast pipeline
        // reports the finished result — the close wakes, once.
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        assert.ok(
          text.includes(`PR ${REPO}#12 closed: closed unmerged at ${closedAt}`),
          text,
        );
        await waitFor(() => ghRow(fixture, "ses-1", "github-pr") === undefined);
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a github-issue watch follows state changes without ever dissolving", async () => {
  const state = ghState();
  state.issue = mkIssue();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-issue",
          repo: REPO,
          ref: "7",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        const closedAt = new Date().toISOString();
        state.issue = {
          ...state.issue,
          state: "closed",
          closed_at: closedAt,
          updated_at: closedAt,
        };
        await waitFor(() => fixture.mails.length === 1);
        const closedText = envelope(fixture.mails[0].text);
        assert.ok(
          closedText.includes("GitHub mail — issue change"),
          closedText,
        );
        assert.ok(closedText.includes("acme/widgets#7 — changed"), closedText);
        assert.ok(closedText.includes("state closed"), closedText);

        // The watch survives the close — an issue reopens casually.
        assert.ok(ghRow(fixture, "ses-1", "github-issue"), "the row stays");

        const reopenedAt = new Date(Date.parse(closedAt) + 2_000).toISOString();
        state.issue = {
          ...state.issue,
          state: "open",
          closed_at: null,
          updated_at: reopenedAt,
        };
        await waitFor(() => fixture.mails.length === 2);
        const reopenText = envelope(fixture.mails[1].text);
        assert.ok(reopenText.includes("state open"), reopenText);
        await settle(60);
        assert.equal(fixture.mails.length, 2);
        assert.ok(ghRow(fixture, "ses-1", "github-issue"), "the row stays");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("the reviews read walks to the Link header's last page, and a tail review wakes", async () => {
  const state = ghState();
  state.pull = mkPull();
  // 150 reviews: page 1 holds the oldest 100, the Link's last page holds
  // the newest 50 — the window the watch wakes on.
  state.reviews = Array.from({ length: 150 }, (_, index) =>
    mkReview(101 + index),
  );
  state.reviewsLinkLast = 2;
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the whole tail is the backlog");
        // The tail page's ids are spent — the register walked to the
        // Link's last page (r250 is a tail id page 1 never carries).
        assert.equal(
          (
            ghRow(fixture, "ses-1", "github-pr")!.delivered as Record<
              string,
              boolean
            >
          ).r250,
          true,
        );
        assert.ok(
          state.calls.filter(
            (call) => call.includes("/reviews") && call.includes("page=2"),
          ).length > 0,
          "the read walked to the last page",
        );

        // A review arrives on the tail page: it wakes, once.
        state.reviews = [
          ...state.reviews,
          mkReview(251, { submitted_at: new Date().toISOString() }),
        ];
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("review 251 by ada"));
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("an outage keeps its pass, names the route and the status, and leaks no credential", async () => {
  const state = ghState();
  state.pull = mkPull();
  state.outage = true;
  state.echo = " (upstream hunter2)";
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The register's baseline read fails: the row stamps
        // baseline-pending, and the pass's reads keep failing, said on
        // the kernel's per-watch line.
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await waitFor(
          () =>
            logged.some((line) =>
              line.includes("GET /repos/acme/widgets/pulls/12 → HTTP 500"),
            ),
          1200,
        );
        await settle(40);
        const row = ghRow(fixture, "ses-1", "github-pr")!;
        assert.equal(
          row.baseline,
          "pending",
          "the failed read left the row pending",
        );
      } finally {
        await cleanup?.();
      }
    });
    assert.ok(logged.length > 0);
    for (const line of logged) {
      assert.ok(!line.includes(GH_TOKEN), line);
      assert.ok(!line.includes("hunter2"), line);
    }
    assert.equal(fixture.mails.length, 0);
  } finally {
    console.error = original;
    await gh.close();
    await forge.close();
  }
});

test("the rate limit holds the reads until the reset, and the wake lands exactly once after it", async () => {
  const state = ghState();
  state.pull = mkPull();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        // The api starts refusing: the source says so once and holds
        // its reads until the reset the header named.
        state.rateLimit = true;
        state.rateLimitReset = Math.floor(Date.now() / 1000) + 1;
        const changedAt = new Date().toISOString();
        state.pull = { ...state.pull, updated_at: changedAt, draft: true };
        await waitFor(
          () =>
            logged.some((line) =>
              line.includes("the github source hit the api rate limit"),
            ),
          1200,
        );
        const callsAtHold = state.calls.length;
        await settle(40);
        assert.equal(
          state.calls.length,
          callsAtHold,
          "no reads ride the held backoff",
        );

        // After the reset the reads resume and the change wakes, once.
        state.rateLimit = false;
        await waitFor(() => fixture.mails.length === 1, 2000);
        const text = envelope(fixture.mails[0].text);
        assert.ok(text.includes("GitHub mail — PR change"), text);
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await gh.close();
    await forge.close();
  }
});

test("a missing token disables the github source with its named line; the forge source still stands; the absent block is silent", async () => {
  const state = ghState();
  state.pull = mkPull();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // A present block with no token: the source is off, said once on its
    // named line, and the forge tools still register a forge watch.
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, { url: gh.url });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        assert.ok(
          logged.some((line) =>
            line.includes(
              "the github source is off: no api token — set options.watcher.github.token on the watcher's plugins entry, or GITHUB_TOKEN in the host's environment",
            ),
          ),
          logged.join("\n"),
        );
        assert.ok(tool(fixture, "watcher_register"));
        await assert.rejects(
          register(fixture, "ses-1", {
            kind: "github-pr",
            repo: REPO,
            ref: "12",
          }),
          /kind must be one of run, pr, branch, pr-reviews/,
        );
        const forgeReply = await register(fixture, "ses-1", {
          kind: "run",
          repo: "acme/forge-side",
          ref: "18197",
        });
        assert.equal(forgeReply.ok, true);
        await settle(60);
        // The github source made no read.
        assert.equal(state.calls.length, 0);
      } finally {
        await cleanup?.();
      }
    });

    // An absent block: the source is opt-in, and the absence is silent.
    logged.length = 0;
    const silent = fakeContext([{ id: "ses-1", metadata: {} }]);
    silent.ctx.options = optionsWith(forge.url, undefined);
    const cleanup = await boot(silent);
    try {
      assert.ok(
        !logged.some((line) => line.includes("the github source is off")),
        logged.join("\n"),
      );
      await assert.rejects(
        register(silent, "ses-1", {
          kind: "github-issue",
          repo: REPO,
          ref: "7",
        }),
        /kind must be one of run, pr, branch, pr-reviews/,
      );
      await settle(40);
      assert.equal(state.calls.length, 0);
    } finally {
      await cleanup?.();
    }
  } finally {
    console.error = original;
    await gh.close();
    await forge.close();
  }
});

test("a row the boundary cannot name is dropped and the page's survivors still wake", async () => {
  const state = ghState();
  state.pull = mkPull();
  // One comment the boundary cannot name (no id) beside one it can.
  state.comments = [
    {
      created_at: new Date(Date.now() - 60_000).toISOString(),
      user: { login: "ghost" },
    },
    mkComment(502),
  ];
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");

        const arrivedAt = new Date().toISOString();
        state.comments = [
          { created_at: arrivedAt, user: { login: "ghost" } },
          mkComment(503, { created_at: arrivedAt }),
        ];
        state.pull = { ...state.pull, updated_at: arrivedAt };
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("comment 503"));
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});

test("a second register on the same repo and number returns the claimed watch; a github-issue watch claims nothing", async () => {
  const state = ghState();
  state.pull = mkPull();
  state.issue = mkIssue();
  const gh = await startGithub(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([
      { id: "ses-1", metadata: {} },
      { id: "ses-2", metadata: {} },
    ]);
    fixture.ctx.options = optionsWith(forge.url, githubOptions(gh));
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        const first = await register(fixture, "ses-1", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        const second = await register(fixture, "ses-2", {
          kind: "github-pr",
          repo: REPO,
          ref: "12",
        });
        assert.equal(second.ok, true);
        assert.equal(second.existing, true);
        assert.equal(second.id, first.id);
        assert.equal(second.claimedBy, "ses-1");

        // The issue kind claims nothing: another session's register is
        // its own watch, its own row.
        const issueA = await register(fixture, "ses-1", {
          kind: "github-issue",
          repo: REPO,
          ref: "7",
        });
        const issueB = await register(fixture, "ses-2", {
          kind: "github-issue",
          repo: REPO,
          ref: "7",
        });
        assert.equal(issueB.existing, false);
        assert.notEqual(issueB.id, issueA.id);
        assert.ok(ghRow(fixture, "ses-2", "github-issue"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await gh.close();
    await forge.close();
  }
});
