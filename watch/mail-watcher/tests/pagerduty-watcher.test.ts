import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchStamps, readStamps } from "../index.ts";
import { boot as harnessBoot } from "./watcher-harness.ts";
import { PagerDutySource } from "../pagerduty.ts";

// The PagerDuty source (PRJ-426) as the forge watches' test file hosts
// its side: setup() reads the operator's config — the forge legs it
// already carried, plus the pagerduty block (token, optional api url,
// and the service-to-director mapping) — and polls the fake PagerDuty
// REST server here on 127.0.0.1. The fake serves /incidents the way the
// live route does: the service_ids[] filter is honored (each watched
// service's read answers that service's incidents alone), the page size
// clamps what the limit asked, and the `more` flag carries the walk's
// end. The statuses[] filter is deliberately NOT honored — the fake
// serves acknowledged and resolved rows beside triggered ones — so the
// source's post-read filter is exercised too. The forge legs the
// watcher always runs beside this source answer from a loopback fake of
// their own (startForgeFake), so no test in this file dials DNS: every
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
  repo?: string;
  ref?: string;
  note?: string;
  delivered?: Record<string, boolean>;
  markedAt?: Record<string, string>;
};

type SessionRow = {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type IncidentSpec = {
  id: string;
  number?: number;
  title?: string;
  status?: string;
  url?: string;
  createdAt?: string;
  service?: string;
};

type PdState = {
  incidents: IncidentSpec[];
  // The fake's own page-size clamp: the walk must page around it.
  pageSize: number;
  calls: Array<{ path: string; query: Record<string, string> }>;
  auth: string[];
  outage: boolean;
  // A status message the failures carry — the redaction test fills it.
  // It is the tripwire's channel (review 346's 16410): the client no
  // longer reads statusText, so the test's whole value is catching a
  // re-add, and the runtime is proven to surface a custom reason phrase
  // as response.statusText (the red run: re-adding statusText to the
  // client's error put this echo and the reflected credential into the
  // log and went red).
  echo: string;
  // A per-response delay for the incidents route, in ms: the leg-budget
  // test's slow upstream.
  delayMs?: number;
};

function pdState(): PdState {
  return {
    incidents: [],
    pageSize: 100,
    calls: [],
    auth: [],
    outage: false,
    echo: "",
  };
}

async function startPagerduty(state: PdState) {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://x");
    state.auth.push(String(req.headers.authorization ?? ""));
    const reject = (code: number, text: string) => {
      // The tripwire's channel (review 346's 16410): Node's fetch
      // surfaces a custom reason phrase as response.statusText — proven
      // once by re-adding statusText to the client's error, which put
      // both this echo and the reflected credential into a log line and
      // went red. The moment the client copies that channel back into
      // an error, the redaction test fails.
      const reason = state.echo ? `${text}${state.echo}` : text;
      const credential = String(req.headers.authorization ?? "").trim();
      res.writeHead(code, credential ? `${reason} ${credential}` : reason, {
        "content-type": "text/plain",
      });
      res.end(reason);
    };
    if (state.outage) {
      reject(500, "pagerduty outage");
      return;
    }
    const path = route.pathname;
    state.calls.push({
      path,
      query: Object.fromEntries(route.searchParams.entries()),
    });
    if (path !== "/incidents") {
      reject(404, "no such route");
      return;
    }
    const answer = () => {
      // The service_ids[] filter rides the wire, honored like the live
      // route; statuses[] is ignored so the watcher's post-read filter
      // never leans on the wire's answer alone.
      const service = route.searchParams.get("service_ids[]") ?? "";
      const limit = Math.max(
        1,
        Math.min(
          state.pageSize,
          Number(route.searchParams.get("limit") ?? 100),
        ),
      );
      const offset = Math.max(0, Number(route.searchParams.get("offset") ?? 0));
      const matches = state.incidents.filter(
        (row) => (row.service ?? "PIJ90N7") === service,
      );
      const windowed = matches.slice(offset, offset + limit);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          incidents: windowed.map((row) => ({
            id: row.id,
            ...(row.number !== undefined
              ? { incident_number: row.number }
              : {}),
            ...(row.title !== undefined ? { title: row.title } : {}),
            status: row.status ?? "triggered",
            ...(row.createdAt ? { created_at: row.createdAt } : {}),
            ...(row.url ? { html_url: row.url } : {}),
            service: {
              id: row.service ?? "PIJ90N7",
              type: "service_reference",
              summary: "watched service",
            },
          })),
          limit,
          offset,
          more: offset + limit < matches.length,
        }),
      );
    };
    if (state.delayMs) {
      setTimeout(answer, state.delayMs);
      return;
    }
    answer();
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
// beside the pagerduty one (the config throws without it), and every
// pass polls it before the pagerduty leg. The answer here is an empty
// JSON array for every /api/v1 route — an empty open-PR list for the
// projection's walk, an unnamable run record for a run watch — so no
// watch of these tests ever reaches a verdict, and every read the forge
// legs make stays on the loopback.
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

const TOKEN = "forge-token";
const PD_TOKEN = "pagerduty-token";
// The projection's default db path would land in the operator's real
// state home; a sandboxed db keeps the header's no-writes-outside-tmpdir
// claim true.
const DB_PATH = join(
  mkdtempSync(join(tmpdir(), "pagerduty-watcher-state-")),
  "pr-state.db",
);

// The watcher's plugins entry: the forge legs pointed at the loopback
// fake every test starts, plus the pagerduty block under test.
const optionsWith = (forgeUrl: string, pagerduty: unknown) => ({
  watcher: {
    forgeUrl,
    forgeToken: TOKEN,
    dbPath: DB_PATH,
    ...(pagerduty !== undefined ? { pagerduty } : {}),
  },
});

const ENV_KEYS = [
  "WATCHER_POLL_SECONDS",
  "FORGEJO_BASE_URL",
  "FORGEJO_TOKEN",
  "PAGERDUTY_TOKEN",
  "PAGERDUTY_API_URL",
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

const mkIncident = (over: Partial<IncidentSpec>): IncidentSpec => ({
  id: "PT4KHLK",
  number: 1234,
  title: "The server is on fire.",
  status: "triggered",
  url: "https://example.invalid/incidents/PT4KHLK",
  createdAt: "2026-11-19T00:00:00Z",
  service: "PIJ90N7",
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

const pagerdutyRow = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
  service: string,
): WatchRow | undefined =>
  stampedWatches(fixture, sessionID).find(
    (row) => row.kind === "pagerduty" && row.ref === service,
  );

const incidentCalls = (state: PdState) =>
  state.calls.filter((call) => call.path === "/incidents");

test("a triggered incident wakes its mapped target exactly once, with the claims row on the target's stamp", async () => {
  const state = pdState();
  state.incidents = [mkIncident({})];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-director", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [
        { service: "PIJ90N7", wake: "ses-director", note: "the matrix stack" },
      ],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => fixture.mails.length === 1);
        const mail = fixture.mails[0];
        assert.equal(mail.sessionID, "ses-director");
        assert.ok(mail.text.startsWith("<system-reminder>"));
        assert.ok(mail.text.endsWith("</system-reminder>"));
        assert.ok(mail.text.includes("PagerDuty mail — incident"));
        assert.ok(
          mail.text.includes(
            "watch pd-PIJ90N7 — pagerduty PIJ90N7 — the matrix stack",
          ),
        );
        assert.ok(mail.text.includes("incident PT4KHLK (#1234) — triggered"));
        assert.ok(mail.text.includes("title The server is on fire."));
        assert.ok(
          mail.text.includes("url https://example.invalid/incidents/PT4KHLK"),
        );
        assert.ok(mail.text.includes("triggered at 2026-11-19T00:00:00Z"));

        const row = pagerdutyRow(fixture, "ses-director", "PIJ90N7")!;
        assert.equal(row.id, "pd-PIJ90N7");
        assert.equal(row.session, "ses-director");
        assert.equal(row.note, "the matrix stack");
        assert.deepEqual(row.delivered, { PT4KHLK: true });

        // Every PagerDuty read rode the api key in the route's scheme.
        assert.ok(state.auth.length > 0);
        assert.deepEqual(
          [...new Set(state.auth.filter(Boolean))],
          [`Token token=${PD_TOKEN}`],
        );
        // The read asked for the watched service's triggered incidents,
        // under the read's own date window (the `since` pin: the
        // request bounds what the read can serve).
        assert.ok(incidentCalls(state).length > 0);
        for (const call of incidentCalls(state)) {
          assert.equal(call.query["statuses[]"], "triggered");
          assert.equal(call.query["service_ids[]"], "PIJ90N7");
          const windowMs = Date.now() - Date.parse(call.query.since);
          assert.ok(
            windowMs > 29 * 24 * 60 * 60 * 1000 &&
              windowMs < 31 * 24 * 60 * 60 * 1000,
            `since is the read window: ${call.query.since}`,
          );
        }

        // Delivered once, ever: further passes re-send nothing.
        await settle(60);
        assert.equal(fixture.mails.length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("an acknowledged or resolved incident wakes nothing; flipping to triggered wakes once", async () => {
  const state = pdState();
  state.incidents = [
    mkIncident({ id: "PT_OPEN" }),
    mkIncident({ id: "PT_ACK", status: "acknowledged" }),
    mkIncident({ id: "PT_RES", status: "resolved" }),
  ];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("incident PT_OPEN"));
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_OPEN: true,
        });
        await settle(60);
        assert.equal(
          fixture.mails.length,
          1,
          "an acknowledged or resolved incident wakes nothing",
        );

        // The acknowledged incident flips to triggered: the id was never
        // spent, so it wakes — once.
        state.incidents = state.incidents.map((row) =>
          row.id === "PT_ACK" ? { ...row, status: "triggered" } : row,
        );
        await waitFor(() => fixture.mails.length === 2);
        assert.ok(fixture.mails[1].text.includes("incident PT_ACK"));
        await settle(60);
        assert.equal(fixture.mails.length, 2);

        // The resolved one, same rule.
        state.incidents = state.incidents.map((row) =>
          row.id === "PT_RES" ? { ...row, status: "triggered" } : row,
        );
        await waitFor(() => fixture.mails.length === 3);
        assert.ok(fixture.mails[2].text.includes("incident PT_RES"));
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_OPEN: true,
          PT_ACK: true,
          PT_RES: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 3, "no wake repeats");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("a missing token disables the pagerduty source with its named line; the forge source still stands", async () => {
  const state = pdState();
  state.incidents = [mkIncident({})];
  const pd = await startPagerduty(state);
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
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // Setup resolves: the source is off, the plugin is not.
      const cleanup = await boot(fixture);
      try {
        assert.ok(
          logged.some((line) =>
            line.includes(
              "the pagerduty source is off: no api token — set options.watcher.pagerduty.token on the watcher's plugins entry, or PAGERDUTY_TOKEN in the host's environment",
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
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
        await settle(60);
        // The pagerduty source made no read and stamped no claims row.
        assert.equal(incidentCalls(state).length, 0);
        assert.equal(stampedWatches(fixture, "ses-1").length, 1);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await pd.close();
    await forge.close();
  }
});

test("the token never reaches a log line or an error", async () => {
  const state = pdState();
  state.outage = true;
  state.echo = " (upstream hunter2)";
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() =>
          logged.some((line) =>
            line.includes(
              "the pagerduty read for service PIJ90N7 keeps its pass",
            ),
          ),
        );
        await settle(30);
      } finally {
        await cleanup?.();
      }
    });
    const failure = logged.find((line) =>
      line.includes("the pagerduty read for service PIJ90N7 keeps its pass"),
    )!;
    assert.ok(failure.includes("GET /incidents"), failure);
    assert.ok(failure.includes("HTTP 500"), failure);
    for (const line of logged) {
      assert.ok(!line.includes(PD_TOKEN), line);
      assert.ok(!line.includes("hunter2"), line);
    }
  } finally {
    console.error = original;
    await pd.close();
    await forge.close();
  }
});

test("the incidents walk pages on the offset to the answer's end", async () => {
  const state = pdState();
  state.pageSize = 2;
  state.incidents = [
    mkIncident({ id: "PT_ONE", number: 1 }),
    mkIncident({ id: "PT_TWO", number: 2 }),
    mkIncident({ id: "PT_THREE", number: 3 }),
  ];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => fixture.mails.length === 3);
        const woken = fixture.mails
          .map((mail) => /incident (PT_\w+) /.exec(mail.text)?.[1])
          .sort();
        assert.deepEqual(woken, ["PT_ONE", "PT_THREE", "PT_TWO"]);
        // The walk read the offsets the fake's page size demanded, at
        // the route's own page size — advancing by what the answers
        // served, and stopping at the empty end.
        const offsets = [
          ...new Set(incidentCalls(state).map((call) => call.query.offset)),
        ].sort();
        assert.deepEqual(offsets, ["0", "2"]);
        for (const call of incidentCalls(state)) {
          assert.equal(call.query.limit, "100");
        }
        await settle(60);
        assert.equal(fixture.mails.length, 3, "no wake repeats");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("each watched service wakes the target its config names", async () => {
  const state = pdState();
  state.incidents = [
    mkIncident({ id: "PT_ON_A", service: "PIJ90N7" }),
    mkIncident({ id: "PT_ON_B", service: "PABC123" }),
  ];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([
      { id: "ses-1", metadata: {} },
      { id: "ses-2", metadata: {} },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [
        { service: "PIJ90N7", wake: "ses-1" },
        { service: "PABC123", wake: "ses-2" },
      ],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => fixture.mails.length === 2);
        const mailFor = (sessionID: string) =>
          fixture.mails.find((mail) => mail.sessionID === sessionID)!.text;
        assert.ok(mailFor("ses-1").includes("incident PT_ON_A"));
        assert.ok(mailFor("ses-1").includes("pagerduty PIJ90N7"));
        assert.ok(mailFor("ses-2").includes("incident PT_ON_B"));
        assert.ok(mailFor("ses-2").includes("pagerduty PABC123"));
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_ON_A: true,
        });
        assert.deepEqual(pagerdutyRow(fixture, "ses-2", "PABC123")!.delivered, {
          PT_ON_B: true,
        });
        // Each service was read for itself alone.
        const services = new Set(
          incidentCalls(state).map((call) => call.query["service_ids[]"]),
        );
        assert.deepEqual([...services].sort(), ["PABC123", "PIJ90N7"]);
        await settle(60);
        assert.equal(fixture.mails.length, 2);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("a reload finds the spent markers and wakes nobody; a new incident still wakes", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_FIRST" })];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const first = await boot(fixture);
      try {
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("incident PT_FIRST"));
      } finally {
        await first?.();
      }

      // The second instance reads the same stamp: the marker keeps the
      // incident to its one wake.
      const second = await boot(fixture);
      try {
        await settle(60);
        assert.equal(fixture.mails.length, 1);
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_FIRST: true,
        });

        // An incident that arrives after the reload wakes once.
        state.incidents.push(mkIncident({ id: "PT_SECOND", number: 2 }));
        await waitFor(() => fixture.mails.length === 2);
        assert.ok(fixture.mails[1].text.includes("incident PT_SECOND"));
        await settle(60);
        assert.equal(fixture.mails.length, 2);
      } finally {
        await second?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("unusable pagerduty config disables the source with its named line, entry by entry", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  const forge = await startForgeFake();
  try {
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // No pagerduty block at all: the source is off, silently.
      let fixture = fakeContext([], optionsWith(forge.url, undefined));
      let cleanup = await boot(fixture);
      await cleanup?.();
      assert.ok(
        logged.every((line) => !line.includes("pagerduty")),
        logged.join("\n"),
      );

      // A token that cannot serve: the named line, source off.
      fixture = fakeContext([], optionsWith(forge.url, { services: [] }));
      cleanup = await boot(fixture);
      await cleanup?.();
      assert.ok(
        logged.some((line) =>
          line.includes("the pagerduty source is off: no api token"),
        ),
        logged.join("\n"),
      );

      // An unusable url: the named line, source off.
      fixture = fakeContext(
        [],
        optionsWith(forge.url, {
          token: PD_TOKEN,
          url: "ftp://nope",
          services: [],
        }),
      );
      cleanup = await boot(fixture);
      await cleanup?.();
      assert.ok(
        logged.some((line) =>
          line.includes(
            "the pagerduty source is off: url must be the PagerDuty REST api's http(s) base",
          ),
        ),
        logged.join("\n"),
      );

      // Every entry unusable: the no-watchable-services line, source off.
      fixture = fakeContext(
        [],
        optionsWith(forge.url, {
          token: PD_TOKEN,
          services: [
            { service: "", wake: "ses-1" },
            { service: "PIJ90N7", wake: "" },
          ],
        }),
      );
      cleanup = await boot(fixture);
      await cleanup?.();
      assert.ok(
        logged.some((line) =>
          line.includes("a pagerduty services entry is dropped"),
        ),
        logged.join("\n"),
      );
      assert.ok(
        logged.some((line) =>
          line.includes(
            "the pagerduty source is off: no watchable services under options.watcher.pagerduty.services",
          ),
        ),
        logged.join("\n"),
      );
    });

    // A usable entry beside unusable ones runs; the duplicate is dropped.
    const state = pdState();
    state.incidents = [mkIncident({ id: "PT_SURVIVOR" })];
    const pd = await startPagerduty(state);
    try {
      const fixture = fakeContext([
        { id: "ses-1", metadata: {} },
        { id: "ses-2", metadata: {} },
      ]);
      fixture.ctx.options = optionsWith(forge.url, {
        token: PD_TOKEN,
        url: pd.url,
        services: [
          { service: "", wake: "ses-1" },
          { service: "PIJ90N7", wake: "ses-1" },
          { service: "PIJ90N7", wake: "ses-2" },
        ],
      });
      await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
        const cleanup = await boot(fixture);
        try {
          await waitFor(() => fixture.mails.length === 1);
          assert.equal(fixture.mails[0].sessionID, "ses-1");
          assert.ok(fixture.mails[0].text.includes("incident PT_SURVIVOR"));
          assert.ok(
            logged.some((line) =>
              line.includes(
                "the pagerduty service PIJ90N7 is watched twice; the later entry is dropped",
              ),
            ),
            logged.join("\n"),
          );
          assert.equal(pagerdutyRow(fixture, "ses-2", "PIJ90N7"), undefined);
        } finally {
          await cleanup?.();
        }
      });
    } finally {
      await pd.close();
    }
  } finally {
    console.error = original;
    await forge.close();
  }
});

test("the delivered map prunes what the read window can never bring back", async () => {
  const state = pdState();
  // The still-triggered fresh incident: its marker is young, so it
  // keeps the marker and does not re-wake.
  state.incidents = [mkIncident({ id: "PT_FRESH" })];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([
      {
        id: "ses-1",
        metadata: {
          chancery: {
            watches: [
              {
                id: "pd-PIJ90N7",
                session: "ses-1",
                kind: "pagerduty",
                ref: "PIJ90N7",
                delivered: { PT_STALE: true, PT_FRESH: true },
                markedAt: {
                  // Past the window's age limit: no read of the route's
                  // date window can bring the id back, so the marker is
                  // prunable.
                  PT_STALE: new Date(
                    Date.now() - 40 * 24 * 60 * 60 * 1000,
                  ).toISOString(),
                  // One day old: inside the window, kept.
                  PT_FRESH: new Date(
                    Date.now() - 24 * 60 * 60 * 1000,
                  ).toISOString(),
                },
              },
            ],
          },
        },
      },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => {
          const row = pagerdutyRow(fixture, "ses-1", "PIJ90N7");
          return !!row && !("PT_STALE" in (row.delivered ?? {}));
        });
        const row = pagerdutyRow(fixture, "ses-1", "PIJ90N7")!;
        // The stale marker is gone; the fresh one survives with its age.
        assert.deepEqual(row.delivered, { PT_FRESH: true });
        assert.equal(typeof row.markedAt?.PT_FRESH, "string");
        // The still-triggered fresh incident does not re-wake, and the
        // stale id — which no read can serve — wakes nothing either.
        await settle(60);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("a failed prune write defers the pass and keeps what the stamp owns", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_FRESH" })];
  const pd = await startPagerduty(state);
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
                id: "pd-PIJ90N7",
                session: "ses-1",
                kind: "pagerduty",
                ref: "PIJ90N7",
                delivered: { PT_STALE: true, PT_FRESH: true },
                markedAt: {
                  PT_STALE: new Date(
                    Date.now() - 40 * 24 * 60 * 60 * 1000,
                  ).toISOString(),
                  PT_FRESH: new Date(
                    Date.now() - 24 * 60 * 60 * 1000,
                  ).toISOString(),
                },
              },
            ],
          },
        },
      },
    ]);
    const realUpdate = fixture.ctx.session.update;
    let failOn = 0;
    let updateCalls = 0;
    fixture.ctx.session.update = async (input: {
      sessionID: string;
      metadata: Record<string, unknown>;
    }) => {
      updateCalls += 1;
      if (updateCalls === failOn) throw new Error("stamp write exploded");
      return realUpdate(input);
    };
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // Pass 1: the row is found, the prune's write fails, and the pass
      // ends there — no incidents read, no markers dropped from the
      // caller's view, no mail.
      failOn = 1;
      const cleanup = await boot(fixture);
      try {
        await waitFor(() =>
          logged.some((line) => line.includes("stamp write to ses-1 failed")),
        );
        assert.equal(
          incidentCalls(state).length,
          0,
          "a failed prune write costs the pass its read",
        );
        assert.equal(fixture.mails.length, 0);
        // The next pass's prune commits: the stale marker leaves the
        // stamp, the fresh one stays, and nothing wakes either way.
        await waitFor(() => {
          const row = pagerdutyRow(fixture, "ses-1", "PIJ90N7");
          return !!row && !("PT_STALE" in (row.delivered ?? {}));
        });
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_FRESH: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    await pd.close();
    await forge.close();
  }
});

test("the leg's pass budget stops the walk, and everything it read still wakes — once", async () => {
  const state = pdState();
  state.pageSize = 1;
  state.delayMs = 25;
  state.incidents = Array.from({ length: 10 }, (_, index) =>
    mkIncident({ id: `PT_BUDGET_${index}` }),
  );
  const pd = await startPagerduty(state);
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const source = (legBudgetMs: number) =>
      new PagerDutySource({
        config: {
          token: PD_TOKEN,
          url: pd.url,
          services: [{ service: "PIJ90N7", wake: "ses-1" }],
        },
        ctx: fixture.ctx,
        debug: () => {},
        patchStamps,
        readStamps,
        isStopped: () => false,
        failedWrites: new Set(),
        legBudgetMs,
      });
    // One incident per ~25ms page against an 80ms budget: a few pages
    // read, the rest wait for a later pass.
    await source(80).poll();
    const woken = fixture.mails.map(
      (mail) => /incident (PT_BUDGET_\d+)/.exec(mail.text)![1],
    );
    assert.ok(woken.length >= 1, "the budget let the first pages read");
    assert.ok(woken.length < 10, "the budget stopped the walk before its end");
    assert.equal(
      new Set(woken).size,
      woken.length,
      "no double wake under the bound",
    );

    // A later pass with room to spare reads the rest: every incident
    // wakes exactly once — the bound deferred the walk, it never
    // dropped or duplicated a wake.
    await source(10_000).poll();
    const all = fixture.mails.map(
      (mail) => /incident (PT_BUDGET_\d+)/.exec(mail.text)![1],
    );
    assert.equal(new Set(all).size, 10);
    assert.equal(all.length, 10);
    const row = pagerdutyRow(fixture, "ses-1", "PIJ90N7")!;
    assert.equal(Object.keys(row.delivered ?? {}).length, 10);
  } finally {
    await pd.close();
  }
});

test("a stamp write that reports failure after applying owes its mail, and the next pass delivers it once", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_OWNED" })];
  const pd = await startPagerduty(state);
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
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // Pass 1: the ensure write lands, the settle's mark write applies
      // then reports failed — the marker is spent, the mail is owed,
      // and nothing is delivered this pass.
      failOn = 2;
      const cleanup = await boot(fixture);
      try {
        await waitFor(() => {
          const row = pagerdutyRow(fixture, "ses-1", "PIJ90N7");
          return !!row && !!(row.delivered ?? {}).PT_OWNED;
        });
        assert.equal(fixture.mails.length, 0, "a failed write mails nothing");
        // The next pass finds the spent marker under a failed write and
        // delivers the owed mail — once.
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("incident PT_OWNED"));
        await settle(60);
        assert.equal(fixture.mails.length, 1, "no double wake");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("a stamp write that fails without applying retries the wake without doubling it", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_RETRIED" })];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const realUpdate = fixture.ctx.session.update;
    let failOn = 0;
    let updateCalls = 0;
    fixture.ctx.session.update = async (input: {
      sessionID: string;
      metadata: Record<string, unknown>;
    }) => {
      updateCalls += 1;
      if (updateCalls === failOn) throw new Error("stamp write exploded");
      return realUpdate(input);
    };
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      // Pass 1: the ensure write lands, the settle's mark write fails
      // before applying — no marker, no mail, the attempt is owed.
      failOn = 2;
      const cleanup = await boot(fixture);
      try {
        // The retry re-marks and mails on a later pass: one wake.
        await waitFor(() => fixture.mails.length === 1);
        assert.ok(fixture.mails[0].text.includes("incident PT_RETRIED"));
        assert.deepEqual(pagerdutyRow(fixture, "ses-1", "PIJ90N7")!.delivered, {
          PT_RETRIED: true,
        });
        await settle(60);
        assert.equal(fixture.mails.length, 1, "no double wake");
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("the passes leave stamp rows the registry does not own exactly as their owner wrote them", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_HYGIENE" })];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  try {
    const mystery = {
      id: "mystery-row",
      kind: "vendor-thing",
      ref: "whatever",
      note: "not the watcher's",
      delivered: { Q1: true },
    };
    const fixture = fakeContext([
      {
        id: "ses-1",
        metadata: {
          chancery: {
            watches: [
              mystery,
              {
                id: "pd-PIJ90N7",
                session: "ses-1",
                kind: "pagerduty",
                ref: "PIJ90N7",
                delivered: { PT_HYGIENE: true },
              },
            ],
          },
        },
      },
    ]);
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      const cleanup = await boot(fixture);
      try {
        // The claims row re-ensured from the config keeps the marker it
        // was stamped with: the still-triggered incident it already
        // delivered does not re-wake.
        await settle(60);
        assert.equal(fixture.mails.length, 0);
        // A register and a forget ride the same stamp: neither resets
        // nor drops the rows whose kinds the registry never polls.
        const reply = JSON.parse(
          (
            await tool(fixture, "watcher_register").execute(
              { kind: "run", repo: "acme/widgets", ref: "18197" },
              { sessionID: "ses-1" },
            )
          ).content,
        );
        assert.equal(reply.ok, true);
        await settle(30);
        await tool(fixture, "watcher_forget").execute(
          { id: reply.id },
          { sessionID: "ses-1" },
        );
        await settle(30);
        const rows = stampedWatches(fixture, "ses-1");
        const kept = rows.find((row) => row.id === "mystery-row");
        assert.ok(kept, "the row outside WATCH_KINDS survives every pass");
        assert.equal(kept!.kind, "vendor-thing");
        assert.deepEqual(kept!.delivered, { Q1: true });
        assert.ok(
          rows.some((row) => row.kind === "pagerduty" && row.ref === "PIJ90N7"),
          "the claims row keeps its place beside it",
        );
        assert.equal(fixture.mails.length, 0);
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    await pd.close();
    await forge.close();
  }
});

test("a failed delivery logs its failure and never a delivered line", async () => {
  const state = pdState();
  state.incidents = [mkIncident({ id: "PT_MAILFAIL" })];
  const pd = await startPagerduty(state);
  const forge = await startForgeFake();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  const previousSpan = process.env.MEMORY_SPAN_LOG;
  process.env.MEMORY_SPAN_LOG = "debug";
  try {
    const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
    const realSynthetic = fixture.ctx.session.synthetic;
    let failNext = false;
    fixture.ctx.session.synthetic = async (input: {
      sessionID: string;
      text: string;
    }) => {
      if (failNext) {
        failNext = false;
        throw new Error("mail leg exploded");
      }
      return realSynthetic(input);
    };
    fixture.ctx.options = optionsWith(forge.url, {
      token: PD_TOKEN,
      url: pd.url,
      services: [{ service: "PIJ90N7", wake: "ses-1" }],
    });
    await withEnv({ WATCHER_POLL_SECONDS: "0.05" }, async () => {
      failNext = true;
      const cleanup = await boot(fixture);
      try {
        // The delivery throws once: the failure is said — its own
        // console.error and its own debug op — and no delivered op
        // names the incident, on this pass or any later one (the
        // marker was spent first; the lost mail is the accepted trade).
        await waitFor(() =>
          logged.some((line) => line.includes("incident.undelivered")),
        );
        assert.ok(
          logged.some((line) => line.includes("mail delivery to ses-1 failed")),
          logged.join("\n"),
        );
        await settle(60);
        assert.ok(
          logged.every((line) => !line.includes("incident.delivered")),
          logged.join("\n"),
        );
      } finally {
        await cleanup?.();
      }
    });
  } finally {
    console.error = original;
    if (previousSpan === undefined) delete process.env.MEMORY_SPAN_LOG;
    else process.env.MEMORY_SPAN_LOG = previousSpan;
    await pd.close();
    await forge.close();
  }
});
