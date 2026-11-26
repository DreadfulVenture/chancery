import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boot as harnessBoot } from "./watcher-harness.ts";

// The PR-state projection (PRJ-406) as the watcher's poll pass writes it:
// per watched repo, the pass walks the open-PR list to its empty page,
// reads the reviews per open PR and the commit statuses per head sha, and
// mirrors them into a local SQLite file through zod — wholesale, with
// every row stamped by its syncedAt. The reads ride the Forgejo REST API
// (the fake here serves the same routes on a loopback port); a PR the
// list does not name gets a direct pull-request read before its row
// closes or leaves — the list's silence is never a removal's license.
// Every URL is example.invalid or loopback; no real host name appears
// here.

type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

type ReviewSpec = {
  id: number;
  reviewer: string;
  state: string;
  body?: string;
  submittedAt: string;
  url?: string;
};

// `flavor` picks the field name the status leaf carries its state in —
// `status` on the gitea-shaped leaf, `state` on the combined-status
// flavor — so both spellings get a leg.
type StatusSpec = {
  context: string;
  state: string;
  description?: string;
  flavor?: "state" | "status";
};

type PrSpec = {
  index: number;
  title: string;
  state: string;
  draft?: boolean;
  headSha: string;
  baseRef: string;
  reviews: ReviewSpec[];
  statuses: StatusSpec[];
};

// The direct pull-request read's override for one PR — what the sweep's
// live word says when it differs from the list. `notFound` makes the
// route answer 404.
type RecordOverride = {
  notFound?: boolean;
  state?: string;
  merged?: boolean;
  mergedAt?: string | null;
  closedAt?: string | null;
};

type FakeState = {
  repos: Map<string, PrSpec[]>;
  // When set, the PR list read answers this raw value instead of the
  // fixture rows — a shape the projection must refuse.
  listAnswer?: unknown;
  listFails?: boolean;
  // Pages of the PR list walk whose read fails (1-based).
  listPagesFails?: Set<number>;
  reviewsFails?: Set<number>;
  statusesFails?: Set<string>;
  // The sweep's direct reads answer these per PR; absent, the record
  // derives from the list's spec.
  records: Map<number, RecordOverride>;
  calls: Array<{ method: string; path: string; query: Record<string, string> }>;
};

type SessionRow = { id: string; metadata?: Record<string, unknown> };

async function waitFor(probe: () => boolean, limit = 1200): Promise<void> {
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

function settleOnce() {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

// The fake host: sessions, tools, and the entry options the watcher's
// setup reads. The mcp domain is gone from the watcher's surface — the
// reads ride the REST client the options carry.
function fakeContext(listRows: SessionRow[] = [], options: unknown = {}) {
  const sessions = new Map<
    string,
    SessionRow & { metadata?: Record<string, unknown> }
  >();
  for (const row of listRows) sessions.set(row.id, structuredClone(row));
  const tools = new Map<string, ToolDef>();
  const mails: Array<{ sessionID: string; text: string }> = [];
  const ctx: any = {
    options,
    tool: {
      transform: async (
        fn: (editor: { add: (tool: ToolDef) => void }) => void,
      ) => {
        fn({
          add: (tool: ToolDef) => {
            tools.set(tool.name, tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
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
    event: { subscribe: async function* () {} },
  };
  return { ctx, tools, sessions, mails };
}

// The fake forge: a REST server on loopback answering the routes the
// watcher reads, with the fixtures' paging honored — a page shorter than
// the limit asked is the tail, an empty page the end.
function mcpState(): FakeState {
  return {
    repos: new Map(),
    listAnswer: undefined,
    listFails: false,
    listPagesFails: new Set<number>(),
    reviewsFails: new Set<number>(),
    statusesFails: new Set<string>(),
    records: new Map(),
    calls: [],
  };
}

async function startForge(state: FakeState) {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://x");
    const fail = (code: number, text: string) => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(text);
    };
    const answer = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    state.calls.push({
      method: req.method ?? "",
      path: route.pathname,
      query: Object.fromEntries(route.searchParams.entries()),
    });
    const match = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(
      route.pathname,
    );
    if (!match) {
      fail(404, "no such route");
      return;
    }
    const [, owner, name, rest] = match;
    const rows = state.repos.get(`${owner}/${name}`) ?? [];
    const limit = Math.max(1, Number(route.searchParams.get("limit") ?? 50));
    const page = Math.max(1, Number(route.searchParams.get("page") ?? 1));
    const window = <T>(rowsIn: T[]): T[] =>
      rowsIn.slice((page - 1) * limit, page * limit);
    if (rest === "pulls") {
      if (state.listFails || state.listPagesFails?.has(page)) {
        fail(500, "the repo's pull-request list could not be read");
        return;
      }
      if (state.listAnswer !== undefined) {
        answer(state.listAnswer);
        return;
      }
      answer(
        window(rows).map((pr) => ({
          index: pr.index,
          title: pr.title,
          state: pr.state,
          draft: pr.draft === true,
          head: { ref: `refs/pull/${pr.index}/head`, sha: pr.headSha },
          base: { ref: pr.baseRef, sha: "0".repeat(40) },
          merged: false,
          merged_at: null,
          closed_at: null,
        })),
      );
      return;
    }
    const pull = /^pulls\/(\d+)(\/reviews)?$/.exec(rest);
    if (pull) {
      const index = Number(pull[1]);
      const pr = rows.find((row) => row.index === index);
      if (pull[2] === "/reviews") {
        if (!pr || state.reviewsFails?.has(index)) {
          fail(500, "the pull request's reviews could not be read");
          return;
        }
        answer(
          window(pr.reviews).map((review) => ({
            id: review.id,
            user: { login: review.reviewer },
            state: review.state,
            ...(review.body !== undefined ? { body: review.body } : {}),
            submitted_at: review.submittedAt,
            ...(review.url ? { html_url: review.url } : {}),
          })),
        );
        return;
      }
      const override = state.records.get(index);
      if (override?.notFound) {
        fail(404, "the pull request does not exist");
        return;
      }
      if (override) {
        answer({
          index,
          state: override.state ?? "open",
          merged: override.merged ?? false,
          merged_at: override.mergedAt ?? null,
          closed_at: override.closedAt ?? null,
          head: { sha: pr?.headSha ?? `s${index}` },
          base: { ref: pr?.baseRef ?? "main" },
        });
        return;
      }
      if (!pr) {
        fail(404, "the pull request does not exist");
        return;
      }
      answer({
        index,
        state: pr.state,
        merged: false,
        merged_at: null,
        closed_at: null,
        head: { sha: pr.headSha },
        base: { ref: pr.baseRef },
      });
      return;
    }
    const statuses = /^commits\/([^/]+)\/statuses$/.exec(rest);
    if (statuses) {
      const sha = decodeURIComponent(statuses[1]);
      const pr = rows.find((row) => row.headSha === sha);
      if (!pr || state.statusesFails?.has(sha)) {
        fail(500, "the commit's statuses could not be read");
        return;
      }
      answer(
        window(pr.statuses).map((leaf) => ({
          context: leaf.context,
          [leaf.flavor ?? "status"]: leaf.state,
          ...(leaf.description !== undefined
            ? { description: leaf.description }
            : {}),
        })),
      );
      return;
    }
    fail(404, "no such route");
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

const fixtureOptions = (dbPath: string, url: string) => ({
  watcher: {
    forgeUrl: url,
    forgeToken: "fake-token",
    pollSeconds: 0.05,
    dbPath,
  },
});

async function boot(fixture: ReturnType<typeof fakeContext>) {
  const cleanup = await harnessBoot(fixture.ctx);
  return cleanup;
}

const makePr = (over: Partial<PrSpec> & { index: number }): PrSpec => ({
  title: `pr ${over.index} change`,
  state: "open",
  headSha: `sha-${over.index}-${"a".repeat(32)}`,
  baseRef: "main",
  reviews: [],
  statuses: [],
  ...over,
});

const newDb = () =>
  join(mkdtempSync(join(tmpdir(), "forgejo-projection-")), "pr-state.db");

// node:sqlite answers rows with null prototypes; the deepEquals compare
// plain literals.
const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows));

// A second connection over the projection file for the assertions; the
// projection file does not exist until the first sync creates it, and a
// query against it before that says so — both read as "nothing yet", so
// a waitFor keeps polling instead of tripping.
function openReader(dbPath: string) {
  const rows = (sql: string, ...params: unknown[]) => {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch {
      return [];
    }
    try {
      return db.prepare(sql).all(...(params as never[]));
    } catch (error) {
      if (String(error).includes("no such table")) return [];
      throw error;
    } finally {
      db.close();
    }
  };
  return { rows };
}

const captureErrors = async (fn: () => Promise<void>) => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
};

const callsOf = (state: FakeState, fragment: string) =>
  state.calls.filter((call) => call.path.includes(fragment)).length;

// The list read's own path, matched whole: a fragment match would also
// count the per-PR direct reads the sweep makes.
const listCalls = (state: FakeState, owner: string, name: string) =>
  state.calls.filter(
    (call) => call.path === `/api/v1/repos/${owner}/${name}/pulls`,
  ).length;

test("a pass mirrors the forge's open pull requests, their reviews, and their head statuses", async () => {
  const state = mcpState();
  const sha43 = `s43${"3".repeat(36)}`;
  const sha44 = `s44${"4".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 43,
      title: "first change",
      headSha: sha43,
      reviews: [
        {
          id: 163,
          reviewer: "zenigata",
          state: "APPROVED",
          body: "looks right",
          submittedAt: "2026-11-18T01:00:00Z",
        },
      ],
      statuses: [
        { context: "ci/test", state: "success" },
        { context: "ci/lint", state: "success", description: "clean" },
      ],
    }),
    makePr({
      index: 44,
      title: "second change",
      headSha: sha44,
      draft: true,
      statuses: [{ context: "ci/test", state: "failure", flavor: "state" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 2,
      );
      const prs = plain(
        reader.rows(
          "select repo, pr, head_sha, base_ref, title, state, draft, merged_at, closed_at, synced_at from pr_state order by pr",
        ),
      );
      assert.deepEqual(prs, [
        {
          repo: "acme/widgets",
          pr: 43,
          head_sha: sha43,
          base_ref: "main",
          title: "first change",
          state: "open",
          draft: 0,
          merged_at: null,
          closed_at: null,
          synced_at: (prs[0] as any).synced_at,
        },
        {
          repo: "acme/widgets",
          pr: 44,
          head_sha: sha44,
          base_ref: "main",
          title: "second change",
          state: "open",
          draft: 1,
          merged_at: null,
          closed_at: null,
          synced_at: (prs[1] as any).synced_at,
        },
      ]);
      const reviews = plain(
        reader.rows(
          "select repo, pr, review_id, reviewer, state, body, submitted_at from review_log",
        ),
      );
      assert.equal(reviews.length, 1);
      assert.deepEqual(reviews[0], {
        repo: "acme/widgets",
        pr: 43,
        review_id: 163,
        reviewer: "zenigata",
        state: "APPROVED",
        body: "looks right",
        submitted_at: "2026-11-18T01:00:00Z",
      });
      // Both status-leaf flavors — `status` and `state` — map to the
      // same column, each keyed by its context on the sha.
      const ci = plain(
        reader.rows(
          "select sha, context, state, description, logged_at from ci_log order by sha, context",
        ),
      );
      assert.deepEqual(
        ci.map((row: any) => ({
          sha: row.sha,
          context: row.context,
          state: row.state,
          description: row.description,
        })),
        [
          {
            sha: sha43,
            context: "ci/lint",
            state: "success",
            description: "clean",
          },
          {
            sha: sha43,
            context: "ci/test",
            state: "success",
            description: null,
          },
          {
            sha: sha44,
            context: "ci/test",
            state: "failure",
            description: null,
          },
        ],
      );
      // A merged pull request closes in place on the sweep's direct
      // word: pr 44 merges on the forge, pr 45 opens, pr 43's title
      // changes. The list stops naming 44; the direct read closes it.
      state.repos.set("acme/widgets", [
        makePr({
          index: 43,
          title: "retitled change",
          headSha: sha43,
          reviews: [
            {
              id: 163,
              reviewer: "zenigata",
              state: "APPROVED",
              body: "looks right",
              submittedAt: "2026-11-18T01:00:00Z",
            },
          ],
          statuses: [
            { context: "ci/test", state: "success" },
            { context: "ci/lint", state: "success", description: "clean" },
          ],
        }),
        makePr({
          index: 45,
          title: "third change",
          headSha: sha44,
          reviews: [
            {
              id: 171,
              reviewer: "example-user",
              state: "COMMENT",
              submittedAt: "2026-11-18T02:00:00Z",
            },
          ],
          statuses: [{ context: "ci/test", state: "success" }],
        }),
      ]);
      state.records.set(44, {
        state: "closed",
        merged: true,
        mergedAt: "2026-11-18T05:00:00Z",
        closedAt: "2026-11-18T05:00:00Z",
      });
      await waitFor(
        () =>
          reader.rows("select title from pr_state where pr = 43")[0]?.title ===
          "retitled change",
      );
      await waitFor(
        () =>
          (reader.rows("select state from pr_state where pr = 44")[0] as any)
            ?.state === "closed",
      );
      assert.deepEqual(
        plain(reader.rows("select pr, state from pr_state order by pr")),
        [
          { pr: 43, state: "open" },
          { pr: 44, state: "closed" },
          { pr: 45, state: "open" },
        ],
      );
      // The merged row carries its terminal timestamps.
      const merged = plain(
        reader.rows(
          "select merged_at, closed_at from pr_state where pr = 44",
        )[0],
      );
      assert.deepEqual(merged, {
        merged_at: "2026-11-18T05:00:00Z",
        closed_at: "2026-11-18T05:00:00Z",
      });
      // pr 44's review rows retired with its close; its sha keeps its
      // statuses because pr 45's head now carries them.
      assert.equal(
        reader.rows("select count(*) as n from review_log where pr = 44")[0].n,
        0,
      );
      assert.deepEqual(
        reader
          .rows("select pr from review_log order by pr")
          .map((r: any) => r.pr),
        [43, 45],
      );
      assert.deepEqual(
        plain(reader.rows("select count(*) as n from ci_log"))[0],
        { n: 3 },
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("every row is stamped: a re-read row's syncedAt advances and its first logged_at keeps", async () => {
  const state = mcpState();
  const sha = `s43${"3".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 43,
      headSha: sha,
      statuses: [{ context: "ci/test", state: "success" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      const start = Date.now();
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 1,
      );
      const first = reader.rows("select synced_at from pr_state")[0] as any;
      const firstCi = reader.rows(
        "select logged_at, synced_at from ci_log",
      )[0] as any;
      // The stamp is an ISO moment the pass wrote it in.
      const stamped = Date.parse(first.synced_at);
      assert.ok(
        !Number.isNaN(stamped) &&
          stamped >= start - 1_000 &&
          stamped <= Date.now(),
      );
      // The re-read re-stamps wholesale: the same row carries a later
      // synced_at, while its logged_at keeps the first pass's moment.
      await new Promise((resolve) => setTimeout(resolve, 30));
      state.repos.set("acme/widgets", [
        makePr({
          index: 43,
          title: "titled again",
          headSha: sha,
          statuses: [{ context: "ci/test", state: "success" }],
        }),
      ]);
      await waitFor(
        () =>
          (reader.rows("select title from pr_state")[0] as any)?.title ===
          "titled again",
      );
      const second = reader.rows("select synced_at from pr_state")[0] as any;
      assert.ok(Date.parse(second.synced_at) > Date.parse(first.synced_at));
      const secondCi = reader.rows(
        "select logged_at, synced_at from ci_log",
      )[0] as any;
      assert.equal(secondCi.logged_at, firstCi.logged_at);
      assert.ok(Date.parse(secondCi.synced_at) > Date.parse(firstCi.synced_at));
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("the wake and the projection share the pass's reads: one reviews read serves both", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [
    makePr({ index: 43 }),
    makePr({ index: 44 }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      // The watch registers against a reviewless pr: its baseline read
      // spends an empty page, so the wake itself happens on a later pass
      // — its read then rides the same memo the projection reads from.
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const listReads = () => listCalls(state, "acme", "widgets");
      const reviews43 = () => callsOf(state, "/pulls/43/reviews");
      const reviews44 = () => callsOf(state, "/pulls/44/reviews");
      const atBaseline = {
        list: listReads(),
        r43: reviews43(),
        r44: reviews44(),
      };
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 2,
      );
      // A review arrives; the wake fires once and the projection's
      // review_log row lands from the same shared read.
      state.repos.set("acme/widgets", [
        makePr({
          index: 43,
          reviews: [
            {
              id: 163,
              reviewer: "zenigata",
              state: "APPROVED",
              submittedAt: "2026-11-18T01:00:00Z",
            },
          ],
        }),
        makePr({ index: 44 }),
      ]);
      await waitFor(() => fixture.mails.length === 1);
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 1,
      );
      // Every pass read each open pr's reviews exactly once — the wake's
      // read served the projection too, never doubled — and the list
      // walk's reads (its pages plus the empty end-proof) never fall
      // below one per pass.
      const deltas = {
        list: listReads() - atBaseline.list,
        r43: reviews43() - atBaseline.r43,
        r44: reviews44() - atBaseline.r44,
      };
      assert.equal(deltas.r43, deltas.r44);
      assert.ok(deltas.r43 >= 1, String(deltas.r43));
      assert.ok(deltas.list >= deltas.r43, JSON.stringify(deltas));
      assert.ok(fixture.mails.length === 1);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("unwatched repos project nothing", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [makePr({ index: 43 })]);
  state.repos.set("acme/other", [makePr({ index: 7 })]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 1,
      );
      assert.equal(
        reader.rows(
          "select count(*) as n from pr_state where repo = 'acme/other'",
        )[0].n,
        0,
      );
      assert.equal(
        reader.rows(
          "select count(*) as n from review_log where repo = 'acme/other'",
        )[0].n,
        0,
      );
      assert.equal(
        reader.rows(
          "select count(*) as n from ci_log where repo = 'acme/other'",
        )[0].n,
        0,
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a response zod refuses never touches the projection; a failed read keeps the rows it would replace", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [makePr({ index: 43, title: "the truth" })]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 1,
      );
      // The list answer drifts into a non-array: the sync refuses it
      // before the projection sees it, says so once (the reason holds),
      // and the rows keep theirs — stale, never invented.
      const logged = await captureErrors(async () => {
        state.listAnswer = { not: "a list" };
        await settle(60);
      });
      assert.equal(
        (reader.rows("select title from pr_state")[0] as any)?.title,
        "the truth",
      );
      const refusals = logged.filter((line) =>
        line.includes("did not parse as a pull-request list"),
      );
      assert.equal(refusals.length, 1, logged.join("\n"));
      // A failed list read keeps the rows too, with its own reason.
      state.listAnswer = undefined;
      state.listFails = true;
      const kept = await captureErrors(async () => {
        await settle(60);
      });
      assert.equal(
        (reader.rows("select title from pr_state")[0] as any)?.title,
        "the truth",
      );
      assert.equal(
        kept.filter((line) => line.includes("the open-pr list read failed"))
          .length,
        1,
        kept.join("\n"),
      );
      // The read recovers: the mirror lands the forge's current answer.
      state.listFails = false;
      state.repos.set("acme/widgets", [
        makePr({ index: 43, title: "the newer truth" }),
      ]);
      await waitFor(
        () =>
          (reader.rows("select title from pr_state")[0] as any)?.title ===
          "the newer truth",
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("forge_state serves the board in one call and says what staleness means", async () => {
  const state = mcpState();
  const sha = `s43${"3".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 43,
      headSha: sha,
      reviews: [
        {
          id: 163,
          reviewer: "zenigata",
          state: "APPROVED",
          submittedAt: "2026-11-18T01:00:00Z",
        },
      ],
      statuses: [{ context: "ci/test", state: "success" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      const stateTool = fixture.tools.get("forge_state")!;
      // Before any pass: an empty board, still a good answer.
      const empty = JSON.parse(
        (await stateTool.execute({}, { sessionID: "ses-1" })).content,
      );
      assert.deepEqual(empty, { ok: true, prs: [], reviews: [], ci: [] });
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 1,
      );
      const whole = JSON.parse(
        (await stateTool.execute({}, { sessionID: "ses-1" })).content,
      );
      assert.equal(whole.ok, true);
      assert.equal(whole.prs.length, 1);
      assert.equal(whole.reviews.length, 1);
      assert.equal(whole.ci.length, 1);
      // The rows are the projection's own field names, stamps included.
      assert.deepEqual(
        Object.keys(whole.prs[0]).sort(),
        [
          "baseRef",
          "closedAt",
          "draft",
          "headSha",
          "mergedAt",
          "pr",
          "repo",
          "state",
          "syncedAt",
          "title",
        ].sort(),
      );
      assert.ok(typeof whole.prs[0].syncedAt === "string");
      // One repo's board, by name.
      const one = JSON.parse(
        (
          await stateTool.execute(
            { repo: "acme/widgets" },
            { sessionID: "ses-1" },
          )
        ).content,
      );
      assert.equal(one.ok, true);
      assert.equal(one.repo, "acme/widgets");
      assert.equal(one.prs.length, 1);
      // A repo the projection holds nothing for answers an empty board.
      const none = JSON.parse(
        (
          await stateTool.execute(
            { repo: "acme/other" },
            { sessionID: "ses-1" },
          )
        ).content,
      );
      assert.deepEqual(none, {
        ok: true,
        repo: "acme/other",
        prs: [],
        reviews: [],
        ci: [],
      });
      // The tool's description says the staleness contract plainly.
      assert.ok(stateTool.description.includes("syncedAt"));
      assert.ok(stateTool.description.includes("live forge read"));
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("an unopenable projection file costs the sync and the tool, never the watches", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [makePr({ index: 43 })]);
  const forge = await startForge(state);
  try {
    // A directory's path that is already a file: the projection's parent
    // mkdir fails immediately (ENOTDIR), on every host.
    const blocker = join(
      mkdtempSync(join(tmpdir(), "forgejo-projection-")),
      "not-a-dir",
    );
    writeFileSync(blocker, "");
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(join(blocker, "pr-state.db"), forge.url),
    );
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = await boot(fixture);
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      // The watch still wakes: the projection's failure is its own.
      state.repos.set("acme/widgets", [
        makePr({
          index: 43,
          reviews: [
            {
              id: 163,
              reviewer: "zenigata",
              state: "APPROVED",
              submittedAt: "2026-11-18T01:00:00Z",
            },
          ],
        }),
      ]);
      await waitFor(() => fixture.mails.length === 1);
      const answer = JSON.parse(
        (
          await fixture.tools
            .get("forge_state")!
            .execute({}, { sessionID: "ses-1" })
        ).content,
      );
      assert.equal(answer.ok, false);
      assert.ok(answer.error.includes("unavailable"));
      // The failing pass says its reason once; the wake's mail may have
      // resolved the waitFor mid-pass, so the line waits too.
      await waitFor(() =>
        logged.some((line) =>
          line.includes("the pr-state projection for acme/widgets"),
        ),
      );
      const lines = logged.filter((line) =>
        line.includes("the pr-state projection for acme/widgets"),
      );
      assert.equal(lines.length, 1, logged.join("\n"));
    } finally {
      console.error = original;
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a review read that fails leaves its rows; a status read that fails leaves its rows", async () => {
  const state = mcpState();
  const sha = `s43${"3".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 43,
      headSha: sha,
      reviews: [
        {
          id: 163,
          reviewer: "zenigata",
          state: "APPROVED",
          submittedAt: "2026-11-18T01:00:00Z",
        },
      ],
      statuses: [{ context: "ci/test", state: "success" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 1,
      );
      // The forge drops the review and the CI goes red, but both reads
      // fail this pass: the projection keeps the last truth it read and
      // says why, once per reason.
      state.repos.set("acme/widgets", [
        makePr({
          index: 43,
          headSha: sha,
          reviews: [],
          statuses: [{ context: "ci/test", state: "failure" }],
        }),
      ]);
      state.reviewsFails = new Set([43]);
      state.statusesFails = new Set([sha]);
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      assert.deepEqual(
        reader.rows("select state from review_log").map((r: any) => r.state),
        ["APPROVED"],
      );
      assert.deepEqual(
        reader.rows("select state from ci_log").map((r: any) => r.state),
        ["success"],
      );
      assert.equal(
        logged.filter((line) =>
          line.includes("the reviews read for acme/widgets#43 failed"),
        ).length,
        1,
        logged.join("\n"),
      );
      assert.equal(
        logged.filter((line) =>
          line.includes(`the commit-status read for ${sha} failed`),
        ).length,
        1,
        logged.join("\n"),
      );
      // The reads recover: the mirror catches up — the review the forge
      // no longer carries leaves, and the status turns red.
      state.reviewsFails = new Set();
      state.statusesFails = new Set();
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 0,
      );
      await waitFor(
        () =>
          (reader.rows("select state from ci_log")[0] as any)?.state ===
          "failure",
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("open prs sitting past a filled first page survive the sync", async () => {
  const state = mcpState();
  // Fifty-five open prs: the list's first page fills at fifty, and the
  // five beyond it are the ones a page applied as the whole open set
  // would delete.
  const many = Array.from({ length: 55 }, (_, i) =>
    makePr({ index: i + 1, title: `pr ${i + 1}` }),
  );
  state.repos.set("acme/widgets", many);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "1" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 55,
      );
      // The walk brought page 2's rows in: the prs past the filled page
      // are projected, not deleted.
      assert.deepEqual(
        plain(reader.rows("select pr from pr_state where pr > 50 order by pr")),
        [{ pr: 51 }, { pr: 52 }, { pr: 53 }, { pr: 54 }, { pr: 55 }],
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a walk that cannot finish keeps the repo's rows and says why", async () => {
  const state = mcpState();
  const many = Array.from({ length: 55 }, (_, i) =>
    makePr({ index: i + 1, title: `pr ${i + 1}` }),
  );
  state.repos.set("acme/widgets", many);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "1" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 55,
      );
      // Page 2's read breaks: the walk refuses, the board keeps its
      // 55 rows, and the reason lands once.
      state.listPagesFails = new Set([2]);
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      assert.equal(reader.rows("select count(*) as n from pr_state")[0].n, 55);
      const refusals = logged.filter((line) =>
        line.includes("the open-pr list read failed on page 2"),
      );
      assert.equal(refusals.length, 1, logged.join("\n"));
      // The walk recovers: the mirror lands the forge's current answer.
      state.listPagesFails = new Set();
      state.repos.set(
        "acme/widgets",
        many.map((pr) =>
          pr.index === 1 ? makePr({ index: 1, title: "titled later" }) : pr,
        ),
      );
      await waitFor(
        () =>
          (reader.rows("select title from pr_state where pr = 1")[0] as any)
            ?.title === "titled later",
      );
      assert.equal(reader.rows("select count(*) as n from pr_state")[0].n, 55);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("two open prs sharing a head keep that head's status rows once, named by the first pr", async () => {
  const state = mcpState();
  const shared = `shared${"5".repeat(34)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 46,
      headSha: shared,
      statuses: [
        { context: "ci/one", state: "success" },
        { context: "ci/two", state: "failure" },
      ],
    }),
    makePr({ index: 47, headSha: shared }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "46" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 2,
      );
      assert.deepEqual(
        plain(
          reader.rows(
            "select pr, sha, context, state from ci_log order by context",
          ),
        ),
        [
          { pr: 46, sha: shared, context: "ci/one", state: "success" },
          { pr: 46, sha: shared, context: "ci/two", state: "failure" },
        ],
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a reviews page that fills its limit refuses that pr's write", async () => {
  const state = mcpState();
  const review = (id: number): ReviewSpec => ({
    id,
    reviewer: `reviewer ${id}`,
    state: "APPROVED",
    submittedAt: "2026-11-18T01:00:00Z",
  });
  state.repos.set("acme/widgets", [
    makePr({
      index: 48,
      reviews: [review(1), review(2), review(3)],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "48" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 3,
      );
      // The pr grows past the page: the read answers a full page of 50,
      // the write refuses (older pages may follow that the wake's
      // one-read budget never chases), and the pr's rows keep theirs.
      state.repos.set("acme/widgets", [
        makePr({
          index: 48,
          reviews: Array.from({ length: 51 }, (_, i) => review(i + 1)),
        }),
      ]);
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      assert.equal(reader.rows("select count(*) as n from review_log")[0].n, 3);
      const refusals = logged.filter((line) =>
        line.includes(
          "the reviews answer for acme/widgets#48 filled its page of 50",
        ),
      );
      assert.equal(refusals.length, 1, logged.join("\n"));
      // The pr shrinks back under the page: the write replaces again.
      state.repos.set("acme/widgets", [
        makePr({ index: 48, reviews: [review(1), review(2), review(3)] }),
      ]);
      await settle(60);
      assert.equal(reader.rows("select count(*) as n from review_log")[0].n, 3);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a status page that fills its limit refuses that sha's write", async () => {
  const state = mcpState();
  const leaf = (i: number) => ({ context: `ctx-${i}`, state: "success" });
  const sha = `s49${"9".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({ index: 49, headSha: sha, statuses: [leaf(1), leaf(2)] }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "49" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from ci_log")[0]?.n === 2,
      );
      // The sha grows past the page: the write refuses and the sha's
      // rows keep theirs.
      state.repos.set("acme/widgets", [
        makePr({
          index: 49,
          headSha: sha,
          statuses: Array.from({ length: 51 }, (_, i) => leaf(i + 1)),
        }),
      ]);
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      assert.equal(reader.rows("select count(*) as n from ci_log")[0].n, 2);
      const refusals = logged.filter((line) =>
        line.includes(
          `the commit-status answer for ${sha} filled its page of 50`,
        ),
      );
      assert.equal(refusals.length, 1, logged.join("\n"));
      // Under the page again: the write replaces.
      state.repos.set("acme/widgets", [
        makePr({ index: 49, headSha: sha, statuses: [leaf(1), leaf(2)] }),
      ]);
      await settle(60);
      assert.equal(reader.rows("select count(*) as n from ci_log")[0].n, 2);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a pr the list drops but the forge calls open keeps its row with a fresh stamp", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [
    makePr({ index: 43 }),
    makePr({ index: 44, title: "still open" }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 2,
      );
      const stampedAt = (
        reader.rows("select synced_at from pr_state where pr = 44")[0] as any
      ).synced_at;
      // The list stops naming 44 while the direct read still says open —
      // an API race, a paging artifact: the row keeps, freshly stamped,
      // and the pass says so.
      state.repos.set("acme/widgets", [makePr({ index: 43 })]);
      state.records.set(44, { state: "open" });
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      const kept = plain(
        reader.rows(
          "select pr, state, synced_at from pr_state where pr = 44",
        )[0],
      ) as any;
      assert.equal(kept.pr, 44);
      assert.equal(kept.state, "open");
      assert.ok(Date.parse(kept.synced_at) > Date.parse(stampedAt));
      // Each pass that re-observes the artifact says so; at least the
      // first one landed.
      assert.ok(
        logged.filter((line) =>
          line.includes(
            "does not name pr 44, but the direct read says it is open",
          ),
        ).length >= 1,
        logged.join("\n"),
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a pr the direct read finds merged closes in the projection with its mergedAt set", async () => {
  const state = mcpState();
  state.repos.set("acme/widgets", [
    makePr({ index: 43 }),
    makePr({ index: 44, title: "to merge" }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from pr_state")[0]?.n === 2,
      );
      // The list stops naming 44; the direct read says merged: the row
      // closes in place, carrying the terminal state and timestamps.
      state.repos.set("acme/widgets", [makePr({ index: 43 })]);
      state.records.set(44, {
        state: "closed",
        merged: true,
        mergedAt: "2026-11-18T06:00:00Z",
        closedAt: "2026-11-18T06:00:00Z",
      });
      await waitFor(
        () =>
          (reader.rows("select state from pr_state where pr = 44")[0] as any)
            ?.state === "closed",
      );
      const closed = plain(
        reader.rows(
          "select pr, state, merged_at, closed_at, synced_at from pr_state where pr = 44",
        )[0],
      ) as any;
      assert.equal(closed.pr, 44);
      assert.equal(closed.state, "closed");
      assert.equal(closed.merged_at, "2026-11-18T06:00:00Z");
      assert.equal(closed.closed_at, "2026-11-18T06:00:00Z");
      // Closed is final: the sweep never re-sweeps it, and no further
      // direct read for the pr follows.
      const directReads = callsOf(state, "/pulls/44");
      await settle(60);
      assert.equal(callsOf(state, "/pulls/44"), directReads);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a pr the direct read finds gone is removed with its rows", async () => {
  const state = mcpState();
  const sha = `s44${"4".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({ index: 43 }),
    makePr({
      index: 44,
      headSha: sha,
      reviews: [
        {
          id: 170,
          reviewer: "zenigata",
          state: "APPROVED",
          submittedAt: "2026-11-18T01:00:00Z",
        },
      ],
      statuses: [{ context: "ci/test", state: "success" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 1,
      );
      // The list stops naming 44 and the direct read 404s: the pr is
      // gone from the forge, and every row of it leaves.
      state.repos.set("acme/widgets", [makePr({ index: 43 })]);
      state.records.set(44, { notFound: true });
      await waitFor(
        () =>
          reader.rows("select count(*) as n from pr_state where pr = 44")[0]
            ?.n === 0,
      );
      assert.equal(
        reader.rows("select count(*) as n from review_log where pr = 44")[0].n,
        0,
      );
      assert.equal(
        reader.rows("select count(*) as n from ci_log where sha = ?", sha)[0].n,
        0,
      );
      assert.equal(reader.rows("select count(*) as n from pr_state")[0].n, 1);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});

test("a repo whose walk refuses keeps its review rows and reads no PR directly", async () => {
  const state = mcpState();
  const sha = `s43${"3".repeat(36)}`;
  state.repos.set("acme/widgets", [
    makePr({
      index: 43,
      headSha: sha,
      reviews: [
        {
          id: 163,
          reviewer: "zenigata",
          state: "APPROVED",
          submittedAt: "2026-11-18T01:00:00Z",
        },
      ],
      statuses: [{ context: "ci/test", state: "success" }],
    }),
  ]);
  const forge = await startForge(state);
  const dbPath = newDb();
  try {
    const fixture = fakeContext(
      [{ id: "ses-1", metadata: {} }],
      fixtureOptions(dbPath, forge.url),
    );
    const cleanup = await boot(fixture);
    try {
      await fixture.tools
        .get("watcher_register")!
        .execute(
          { kind: "pr-reviews", repo: "acme/widgets", ref: "43" },
          { sessionID: "ses-1" },
        );
      const reader = openReader(dbPath);
      await waitFor(
        () => reader.rows("select count(*) as n from review_log")[0]?.n === 1,
      );
      // The wire carried the open filter (verified live by the
      // operator: the deployed route's x-total-count answers the open
      // set, not every PR ever).
      assert.ok(
        state.calls.some(
          (call) =>
            call.path === "/api/v1/repos/acme/widgets/pulls" &&
            call.query.state === "open",
        ),
        JSON.stringify(state.calls.slice(0, 3)),
      );
      // The walk refuses (the repo's route answers wrong — deleted,
      // renamed, token scope lost): the sweep skips, nothing retires,
      // and no direct read fires — the per-PR reads would only pile up
      // against an unreadable repo.
      state.listFails = true;
      const directReads = () =>
        state.calls.filter((call) => /\/pulls\/\d+$/.test(call.path)).length;
      const before = {
        reviews: plain(reader.rows("select count(*) as n from review_log"))[0]
          .n,
        direct: directReads(),
      };
      const logged = await captureErrors(async () => {
        await settle(60);
      });
      assert.equal(
        plain(reader.rows("select count(*) as n from review_log"))[0].n,
        before.reviews,
        "the review rows keep theirs",
      );
      assert.equal(
        plain(reader.rows("select count(*) as n from pr_state"))[0].n,
        1,
      );
      assert.equal(directReads(), before.direct, "no direct read ran");
      assert.equal(
        logged.filter((line) => line.includes("the open-pr list read failed"))
          .length,
        1,
        logged.join("\n"),
      );
      // The walk recovers: the mirror catches up.
      state.listFails = false;
      await waitFor(
        () =>
          (reader.rows("select title from pr_state")[0] as any)?.title ===
          "pr 43 change",
      );
      assert.equal(reader.rows("select count(*) as n from review_log")[0].n, 1);
    } finally {
      await cleanup?.();
    }
  } finally {
    await forge.close();
  }
});
