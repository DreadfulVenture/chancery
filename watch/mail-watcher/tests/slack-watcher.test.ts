import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";
import {
  classifyMessages,
  floorOf,
  parseHistoryPage,
  readConfig,
  SlackSource,
  tsValue,
} from "../slack.ts";

// The Slack source as the forge watches' test files host its side:
// setup() reads the operator's config — the forge legs it always
// carries, plus the slack block (token, optional api base) — and polls
// the fake Slack Web API here on 127.0.0.1. The fake serves
// /api/conversations.history and /api/users.info the way the live
// endpoints do: the channel filter and the temporal bound (ts strictly
// after oldest) are honored, the newest message comes first, and the
// page size clamps what `limit` asked. The forge legs the watcher
// always runs beside this source answer from a loopback fake of their
// own (startForgeFake), so no test in this file dials DNS: every
// fixture url is loopback, and no test leaves the loopback fakes or
// writes outside tmpdir.

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
  baseline?: string;
  delivered?: Record<string, boolean>;
};

type SessionRow = {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type MessageSpec = {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  hidden?: boolean;
  channel?: string;
};

type SlackState = {
  messages: MessageSpec[];
  // The fake's own page clamp: the read takes what the limit asks and
  // no more, and has_more says whether rows were left unserved.
  pageSize: number;
  // The temporal bound is honored like the live api (ts strictly after
  // `oldest`) unless a test turns it off — the source's post-read
  // re-check must hold either way.
  honorOldest: boolean;
  calls: Array<{ path: string; query: URLSearchParams }>;
  auth: string[];
  outage: boolean;
  // An api-level failure (HTTP 200, ok:false) when set.
  apiError?: string;
  // A status phrase the failures carry — the redaction tripwire fills it.
  echo: string;
  // user id → display name, served by users.info.
  users: Record<string, string | null>;
};

function slackState(): SlackState {
  return {
    messages: [],
    pageSize: 200,
    honorOldest: true,
    calls: [],
    auth: [],
    outage: false,
    echo: "",
    users: {},
  };
}

async function startSlack(state: SlackState) {
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
    const url = new URL(req.url ?? "/", "http://x");
    state.auth.push(String(req.headers.authorization ?? ""));
    if (state.outage) {
      reject(500, "slack outage");
      return;
    }
    if (url.pathname.endsWith("/conversations.history")) {
      state.calls.push({
        path: "conversations.history",
        query: url.searchParams,
      });
      const asked = Number(url.searchParams.get("limit") ?? "") || 200;
      const limit = Math.max(1, Math.min(state.pageSize, asked));
      const oldest = url.searchParams.has("oldest")
        ? Number(url.searchParams.get("oldest") ?? "")
        : null;
      const latest = url.searchParams.has("latest")
        ? Number(url.searchParams.get("latest") ?? "")
        : null;
      let rows = state.messages.filter(
        (row) =>
          (row.channel ?? CHANNEL_ID) ===
          (url.searchParams.get("channel") ?? ""),
      );
      if (state.honorOldest && oldest !== null && Number.isFinite(oldest)) {
        rows = rows.filter((row) => Number.parseFloat(row.ts) > oldest);
      }
      if (latest !== null && Number.isFinite(latest)) {
        rows = rows.filter((row) => Number.parseFloat(row.ts) < latest);
      }
      // Newest first, like the live api.
      rows.sort((a, b) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts));
      const answer = {
        ok: true,
        messages: rows.slice(0, limit).map((row) => ({
          type: "message",
          ts: row.ts,
          ...(row.text !== undefined ? { text: row.text } : {}),
          ...(row.user !== undefined ? { user: row.user } : {}),
          ...(row.username !== undefined ? { username: row.username } : {}),
          ...(row.bot_id !== undefined ? { bot_id: row.bot_id } : {}),
          ...(row.subtype !== undefined ? { subtype: row.subtype } : {}),
          ...(row.hidden !== undefined ? { hidden: row.hidden } : {}),
        })),
        has_more: rows.length > limit,
      };
      if (state.apiError) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: state.apiError }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    if (url.pathname.endsWith("/users.info")) {
      state.calls.push({ path: "users.info", query: url.searchParams });
      const userId = url.searchParams.get("user") ?? "";
      if (!(userId in state.users)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "user_not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          user: {
            id: userId,
            name: userId,
            profile: { display_name: state.users[userId], real_name: null },
          },
        }),
      );
      return;
    }
    reject(404, "no such route");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as { port: number };
  return {
    state,
    url: `http://127.0.0.1:${address.port}/api`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

// The forge legs' loopback fake: the watcher always runs its forge side
// beside the slack one (the config throws without it), and every pass
// polls it before the slack source. The answer here is an empty JSON
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
const SLACK_TOKEN = "slack-token";
const CHANNEL_ID = "C0123456789";
// The projection's default db path would land in the operator's real
// state home; a sandboxed db keeps the header's no-writes-outside-tmpdir
// claim true.
const DB_PATH = join(
  mkdtempSync(join(tmpdir(), "slack-watcher-state-")),
  "pr-state.db",
);

// The watcher's plugins entry: the forge legs pointed at the loopback
// fake every test starts, plus the slack block under test.
const optionsWith = (forgeUrl: string, slack: unknown) => ({
  watcher: {
    forgeUrl,
    forgeToken: TOKEN,
    dbPath: DB_PATH,
    ...(slack !== undefined ? { slack } : {}),
  },
});

const ENV_KEYS = [
  "WATCHER_POLL_SECONDS",
  "FORGEJO_BASE_URL",
  "FORGEJO_TOKEN",
  "SLACK_TOKEN",
  "SLACK_API_URL",
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

// Slack ts's: whole seconds off a base an hour back, microsecond field
// fixed — distinct ts's sort by their second part.
const BASE_S = Math.floor(Date.now() / 1000) - 3600;
const tsAt = (n: number) => `${BASE_S + n}.000001`;

const stampedWatches = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
): WatchRow[] => {
  const metadata = fixture.sessions.get(sessionID)?.metadata ?? {};
  const rows = (metadata as Record<string, any>).chancery?.watches;
  return Array.isArray(rows) ? rows : [];
};

const slackRow = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
): WatchRow | undefined =>
  stampedWatches(fixture, sessionID).find(
    (row) => row.kind === "slack-channel",
  );

const historyCalls = (state: SlackState) =>
  state.calls.filter((call) => call.path === "conversations.history");

const envelope = (text: string) => {
  assert.ok(text.startsWith("<system-reminder>"), text);
  assert.ok(text.endsWith("</system-reminder>"), text);
  return text;
};

test("a message that arrives after the watch wakes its subscriber exactly once, with content, sender, and timestamp in the wake", async () => {
  const state = slackState();
  // The pre-registration history: a message posted an hour before the
  // watch comes into being. It must never wake, however often the pass
  // re-reads it.
  state.messages = [{ ts: tsAt(1), text: "the pre-watch history", user: "U1" }];
  state.users = { U1: "Ada Lovelace" };
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The register: the baseline read spends the pre-watch page.
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              {
                kind: "slack-channel",
                repo: "slack",
                ref: CHANNEL_ID,
                note: "the lane",
              },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        assert.equal(reply.existing, false);
        await waitFor(() => historyCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");

        // The watch row rides the registering session's stamp, the
        // channel's id as the ref, and the baseline spend as its
        // delivered markers.
        const row = slackRow(fixture, "ses-1")!;
        assert.equal(row.id, reply.id);
        assert.equal(row.session, "ses-1");
        assert.equal(row.repo, "slack");
        assert.equal(row.ref, CHANNEL_ID);
        assert.equal(row.note, "the lane");
        assert.deepEqual(row.delivered, { [tsAt(1)]: true });

        // Re-registering is idempotent per session.
        const again = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(again.existing, true);
        assert.equal(again.id, reply.id);

        // Every read rode the token in the header, in the api's scheme.
        assert.ok(state.auth.length > 0);
        assert.deepEqual(
          [...new Set(state.auth.filter(Boolean))],
          [`Bearer ${SLACK_TOKEN}`],
        );
        // The poll reads since the cursor: the baseline spend's newest
        // ts is the floor the wire carried.
        assert.ok(
          historyCalls(state).some(
            (call) => call.query.get("oldest") === tsAt(1),
          ),
          JSON.stringify(
            historyCalls(state).map((call) => call.query.toString()),
          ),
        );

        // The message arrives: content, sender, timestamp — once.
        state.messages.push({
          ts: tsAt(500),
          text: "the wake body\nsecond line",
          user: "U1",
        });
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-1");
        const text = envelope(mail.text);
        assert.ok(text.includes("Slack mail — channel message"), text);
        assert.ok(
          text.includes(
            `watch ${reply.id} — slack-channel ${CHANNEL_ID} on slack — the lane`,
          ),
          text,
        );
        assert.ok(
          text.includes(`message ${tsAt(500)} from Ada Lovelace`),
          text,
        );
        assert.ok(text.includes("  the wake body"), text);
        assert.ok(text.includes("  second line"), text);

        assert.deepEqual(slackRow(fixture, "ses-1")!.delivered, {
          [tsAt(1)]: true,
          [tsAt(500)]: true,
        });

        // Delivered once, ever: further passes re-send nothing, and the
        // message's edit (same ts) wakes nothing — the marker eats it.
        state.messages = state.messages.map((row) =>
          row.ts === tsAt(500) ? { ...row, text: "the edited body" } : row,
        );
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await slack.close();
    await forge.close();
  }
});

test("a register whose baseline read could not run leaves the backlog to the first pass, spent whole", async () => {
  const state = slackState();
  state.outage = true;
  state.messages = [{ ts: tsAt(1), text: "the pre-watch history" }];
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The register goes through; its baseline read cannot (the
        // outage), so the row is stamped baseline-pending.
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        await waitFor(() => slackRow(fixture, "ses-1") !== undefined);
        assert.equal(slackRow(fixture, "ses-1")!.baseline, "pending");

        // The outage heals: the first pass spends the page — the
        // backlog never wakes — and the pending flag clears.
        state.outage = false;
        await waitFor(() => historyCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0, "the backlog never wakes");
        const row = slackRow(fixture, "ses-1")!;
        assert.equal(row.baseline, undefined);
        assert.deepEqual(row.delivered, { [tsAt(1)]: true });

        // A message that arrives after the watch wakes normally.
        state.messages.push({ ts: tsAt(500), text: "the wake body" });
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(
          envelope(fixture.mails[0].text).includes(`message ${tsAt(500)}`),
          fixture.mails[0].text,
        );
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await slack.close();
    await forge.close();
  }
});

test("two sessions subscribed to one channel each wake exactly once per message", async () => {
  const state = slackState();
  state.messages = [{ ts: tsAt(1), text: "the pre-watch history" }];
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([
      { id: "ses-1", metadata: {} },
      { id: "ses-2", metadata: {} },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        for (const session of ["ses-1", "ses-2"]) {
          const reply = JSON.parse(
            (
              await tool(fixture, "watcher_register").execute(
                { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
                { sessionID: session },
              )
            ).content,
          );
          assert.equal(reply.ok, true);
          assert.equal(reply.existing, false);
        }
        await waitFor(() => historyCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
        assert.equal(stampedWatches(fixture, "ses-2").length, 1);

        // One message, two watches: each subscriber wakes exactly once.
        state.messages.push({
          ts: tsAt(500),
          text: "one message, two subscribers",
        });
        await waitFor(() => fixture.mails.length === 2);
        const sessions = fixture.mails.map((mail) => mail.sessionID).sort();
        assert.deepEqual(sessions, ["ses-1", "ses-2"]);
        assert.deepEqual(slackRow(fixture, "ses-1")!.delivered, {
          [tsAt(1)]: true,
          [tsAt(500)]: true,
        });
        assert.deepEqual(slackRow(fixture, "ses-2")!.delivered, {
          [tsAt(1)]: true,
          [tsAt(500)]: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 2);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await slack.close();
    await forge.close();
  }
});

test("subtype and hidden rows never wake, and a bot message wakes with its username", async () => {
  const state = slackState();
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
          { sessionID: "ses-1" },
        );
        await waitFor(() => historyCalls(state).length > 0);
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        // A tombstone row, a hidden row, and one real message from a
        // bot (username carried, no user id): only the bot's message
        // wakes.
        state.messages.push(
          { ts: tsAt(500), subtype: "message_deleted", text: "gone" },
          { ts: tsAt(501), hidden: true, text: "hidden row" },
          {
            ts: tsAt(502),
            bot_id: "B1",
            username: "the bot",
            text: "beep",
          },
        );
        await waitFor(() => fixture.mails.length === 1);
        const text = envelope(fixture.mails[0].text);
        assert.ok(text.includes(`message ${tsAt(502)} from the bot`), text);
        assert.ok(text.includes("  beep"), text);
        assert.deepEqual(slackRow(fixture, "ses-1")!.delivered, {
          [tsAt(502)]: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await slack.close();
    await forge.close();
  }
});

test("a sender the directory cannot name rides the raw id, and the directory read is memoized per pass", async () => {
  const state = slackState();
  // U9 is deliberately absent from the directory: users.info answers
  // user_not_found and the wake falls back to the raw id.
  state.users = { U1: "Ada Lovelace" };
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await tool(fixture, "watcher_register").execute(
          { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
          { sessionID: "ses-1" },
        );
        await waitFor(() => historyCalls(state).length > 0);
        await settle(40);

        state.messages.push(
          { ts: tsAt(500), text: "from an unknown user", user: "U9" },
          { ts: tsAt(501), text: "from a known user", user: "U1" },
          { ts: tsAt(502), text: "another from the unknown user", user: "U9" },
        );
        await waitFor(() => fixture.mails.length === 3);
        const texts = fixture.mails.map((mail) => envelope(mail.text));
        assert.ok(
          texts.some((text) => text.includes(`message ${tsAt(500)} from U9`)),
          texts.join("\n---\n"),
        );
        assert.ok(
          texts.some((text) =>
            text.includes(`message ${tsAt(501)} from Ada Lovelace`),
          ),
          texts.join("\n---\n"),
        );
        assert.ok(
          texts.some((text) => text.includes(`message ${tsAt(502)} from U9`)),
          texts.join("\n---\n"),
        );
        // The failed lookup memoized: U9's directory read ran once for
        // its two messages.
        const userCalls = state.calls.filter(
          (call) =>
            call.path === "users.info" && call.query.get("user") === "U9",
        );
        assert.equal(userCalls.length, 1, String(userCalls.length));
        await settle(60);
        assert.equal(fixture.mails.length, 3);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await slack.close();
    await forge.close();
  }
});

test("an api error or an outage keeps its pass, names the method, and leaks no credential", async () => {
  for (const flavor of ["api", "outage"] as const) {
    const state = slackState();
    if (flavor === "api") {
      state.apiError = "invalid_auth";
    } else {
      state.outage = true;
      state.echo = " (upstream hunter2)";
    }
    const slack = await startSlack(state);
    const forge = await startForgeFake();
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
      fixture.ctx.options = optionsWith(forge.url, {
        token: SLACK_TOKEN,
        url: slack.url,
      });
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        const cleanup = await boot(fixture);
        try {
          await tool(fixture, "watcher_register").execute(
            { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
            { sessionID: "ses-1" },
          );
          await waitFor(() =>
            logged.some((line) =>
              line.includes(
                `the slack read for channel ${CHANNEL_ID} keeps its pass`,
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
          `the slack read for channel ${CHANNEL_ID} keeps its pass`,
        ),
      )!;
      if (flavor === "api") {
        assert.ok(
          failure.includes(
            "GET /conversations.history → the api said invalid_auth",
          ),
          failure,
        );
      } else {
        assert.ok(
          failure.includes("GET /conversations.history → HTTP 500"),
          failure,
        );
      }
      for (const line of logged) {
        assert.ok(!line.includes(SLACK_TOKEN), line);
        assert.ok(!line.includes("hunter2"), line);
      }
      assert.equal(fixture.mails.length, 0);
    } finally {
      console.error = original;
      await slack.close();
      await forge.close();
    }
  }
});

test("a slack block without a token disables the slack source with its named line; the forge source still stands", async () => {
  const state = slackState();
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, { url: slack.url });
    await withEnv(
      { WATCHER_POLL_SECONDS: "0.05", SLACK_TOKEN: undefined },
      async () => {
        const cleanup = await boot(fixture);
        try {
          assert.ok(
            logged.some((line) =>
              line.includes(
                "the slack source is off: no api token — set options.watcher.slack.token on the watcher's plugins entry, or SLACK_TOKEN in the host's environment",
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
          // The slack kind has no source standing: the register says so.
          await assert.rejects(
            tool(fixture, "watcher_register").execute(
              { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
              { sessionID: "ses-1" },
            ),
            /kind must be one of run, pr, branch, pr-reviews \(got "slack-channel"\)/,
          );
          await settle(60);
          // The slack source made no read and stamped no watch row.
          assert.equal(state.calls.length, 0);
          assert.equal(stampedWatches(fixture, "ses-1").length, 1);
        } finally {
          await cleanup?.();
        }
      },
    );
  } finally {
    console.error = original;
    await slack.close();
    await forge.close();
  }
});

test("readConfig: an absent block is silent, a present one carries token and url, an unusable one names its line", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // No block at all: the source is opt-in, and the absence is silent.
    assert.equal(readConfig({}), null);
    assert.equal(readConfig(undefined), null);
    assert.deepEqual(logged, []);

    // The block's token wins; the url defaults to the public api base.
    assert.deepEqual(readConfig({ slack: { token: SLACK_TOKEN } }), {
      token: SLACK_TOKEN,
      url: "https://slack.com/api",
    });

    await withEnv(
      { SLACK_TOKEN: "env-token", SLACK_API_URL: "http://127.0.0.1:9/api" },
      async () => {
        // The env fallbacks ride under an empty block and a bare token.
        assert.deepEqual(readConfig({ slack: {} }), {
          token: "env-token",
          url: "http://127.0.0.1:9/api",
        });
        // The block's own keys win per key.
        assert.deepEqual(
          readConfig({
            slack: { token: SLACK_TOKEN, url: "http://127.0.0.1:8/api" },
          }),
          { token: SLACK_TOKEN, url: "http://127.0.0.1:8/api" },
        );
        // No token anywhere: the named line, the source off.
        await withEnv({ SLACK_TOKEN: undefined }, async () => {
          assert.equal(readConfig({ slack: {} }), null);
          assert.ok(
            logged.some((line) =>
              line.includes(
                "the slack source is off: no api token — set options.watcher.slack.token on the watcher's plugins entry, or SLACK_TOKEN in the host's environment",
              ),
            ),
            logged.join("\n"),
          );
        });
      },
    );

    // An unusable url: not http(s), or carrying a query — each its line.
    assert.equal(
      readConfig({ slack: { token: SLACK_TOKEN, url: "ftp://x/api" } }),
      null,
    );
    assert.ok(
      logged.some((line) =>
        line.includes("url must be the Slack api's http(s) base"),
      ),
      logged.join("\n"),
    );
    assert.equal(
      readConfig({
        slack: { token: SLACK_TOKEN, url: "https://slack.com/api?x=1" },
      }),
      null,
    );
    assert.ok(
      logged.some((line) => line.includes("without a query or a fragment")),
      logged.join("\n"),
    );
  } finally {
    console.error = original;
  }
});

test("a burst wider than the page wakes what it served and says the tail's loss on its line", async () => {
  const state = slackState();
  const slack = await startSlack(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: SLACK_TOKEN,
      url: slack.url,
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The channel is empty at register: the baseline spends nothing.
        await tool(fixture, "watcher_register").execute(
          { kind: "slack-channel", repo: "slack", ref: CHANNEL_ID },
          { sessionID: "ses-1" },
        );
        await settle(40);
        assert.equal(fixture.mails.length, 0);

        // A burst wider than the 200-row page: the newest 200 wake —
        // once each — and the five oldest are the tail the page left
        // unserved.
        for (let n = 1; n <= 205; n += 1) {
          state.messages.push({ ts: tsAt(n), text: `burst ${n}` });
        }
        await waitFor(() => fixture.mails.length === 200, 6000);
        const row = slackRow(fixture, "ses-1")!;
        assert.equal(Object.keys(row.delivered ?? {}).length, 200);
        // The trade, said on its line — once, not once per pass.
        const why =
          "the history page came back full (200 messages) and claims more";
        assert.ok(
          logged.some((line) => line.includes(why)),
          logged.join("\n"),
        );
        await settle(80);
        assert.equal(fixture.mails.length, 200);
        const said = logged.filter((line) => line.includes(why));
        assert.equal(said.length, 1, logged.join("\n"));
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await slack.close();
    await forge.close();
  }
});

test("the boundary and the cursor math, composed directly: parseHistoryPage, classifyMessages, floorOf, tsValue", () => {
  // tsValue: the numeric side only; junk and zero are not messages.
  assert.equal(tsValue("1411764713.000001"), 1411764713.000001);
  assert.equal(tsValue("junk"), null);
  assert.equal(tsValue("0"), null);

  // parseHistoryPage: the rows the boundary can name survive; subtype,
  // hidden, and unnameable rows are dropped and counted.
  const page = parseHistoryPage({
    ok: true,
    has_more: true,
    messages: [
      { type: "message", ts: tsAt(3), text: "kept" },
      { type: "message", ts: tsAt(2), subtype: "message_deleted" },
      { type: "message", ts: tsAt(4), hidden: true },
      { type: "message", text: "no ts" },
      "not a record",
    ],
  });
  assert.deepEqual(page && page.rows.map((row) => row.ts), [tsAt(3)]);
  assert.equal(page && page.served, 5);
  assert.equal(page && page.dropped, 4);
  assert.equal(page && page.more, true);
  // A shape that drifts parses to null — the pass is skipped.
  assert.equal(parseHistoryPage({ ok: true }), null);
  assert.equal(parseHistoryPage("not an answer"), null);

  // floorOf: the newest spent ts; junk keys ignored; empty is -Infinity.
  assert.equal(floorOf({}), Number.NEGATIVE_INFINITY);
  assert.equal(
    floorOf({ [tsAt(1)]: true, [tsAt(5)]: true, toString: true }),
    tsValue(tsAt(5)),
  );

  // classifyMessages: the floor's re-check and the markers' — the wire
  // filter is never leaned on alone.
  const rows: any[] = [
    { ts: tsAt(1), tsMs: tsValue(tsAt(1))! },
    { ts: tsAt(5), tsMs: tsValue(tsAt(5))! },
    { ts: tsAt(9), tsMs: tsValue(tsAt(9))! },
  ];
  const delivered = { [tsAt(5)]: true };
  assert.deepEqual(
    classifyMessages(rows, tsValue(tsAt(1))!, delivered).map((row) => row.ts),
    [tsAt(9)],
  );
  // The floor at zero with empty markers: everything above wakes.
  assert.deepEqual(
    classifyMessages(rows, 0, {}).map((row) => row.ts),
    [tsAt(1), tsAt(5), tsAt(9)],
  );
});

test("ready(): the kernel's gate answers honestly when the config would not serve", () => {
  const source = new SlackSource({
    reads: {
      historyOf: async () => ({}),
      usersInfo: async () => ({}),
    },
    debug: () => {},
  });
  const off = source.ready({});
  assert.deepEqual(off, {
    ok: false,
    reason:
      "its config block is absent or unusable (its own line above said which)",
  });
  const on = source.ready({ slack: { token: SLACK_TOKEN } });
  assert.equal(on.ok, true);
  assert.deepEqual(on.ok && on.config, {
    token: SLACK_TOKEN,
    url: "https://slack.com/api",
  });
});
