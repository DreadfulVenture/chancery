import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import plugin, {
  FrontmatterError,
  loadAgentDefinition,
  loadCommandDefinition,
  loadSkillDefinition,
  parseFrontmatter,
} from "../director.ts";
import { readFileSync } from "node:fs";

// The director module as OpenCode hosts it: setup() registers tools through a
// ToolEditor and subscribes to the event stream; the tools run against the
// session domain, and the pump files one report per turn end into
// ctx.storage and wakes the director with a fixed synthetic notice — the
// bodies come back only through report_read.
// The host runs one activation per location, so the fake can carry several
// activations over one shared session store, event stream, and kv table
// (what ctx.storage sits on), and each
// fake event is fanned out to every activation, as the host's plugin event
// stream is (it is not filtered by location). This fake hosts those
// domains only — the module has no
// daemon leg, so the memory tests' fake-daemon harness stays untouched.

type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

type SessionRow = {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  metadata?: Record<string, unknown>;
  permissions?: Array<{
    action: string;
    resource: string;
    effect: "allow" | "deny" | "ask";
  }>;
  location?: { directory: string };
  outcome?: "succeeded" | "failed" | "interrupted";
  time?: { created: number; updated: number; busy?: number; idle?: number };
};

const settleOnce = () => new Promise((resolve) => setTimeout(resolve, 2));

async function waitFor(probe: () => boolean, limit = 200): Promise<void> {
  for (let i = 0; i < limit && !probe(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!probe()) throw new Error("waitFor: condition never held");
}

type FakeEvent = { id: string; type: string; data: unknown };
type Mail = {
  sessionID: string;
  text: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

// Every delivery claims a key in the module's process-global claim set.
// Event ids are unique across the process, like the host's, so keys from
// one test never collide with another's.
let eventSeq = 0;
const claimsHeld = () =>
  (globalThis as Record<symbol, Map<string, number> | undefined>)[
    Symbol.for("chancery.director.claims")
  ] ?? new Map<string, number>();

// What every activation of one host shares: the session store, the
// director inboxes, the event stream, and the kv table ctx.storage sits
// on (the host's SQLite kv; the fake is an in-memory map).
function fakeHost() {
  const sessions = new Map<string, SessionRow>();
  const kv = new Map<string, unknown>();
  const mails: Mail[] = [];
  const listeners = new Set<{ queue: FakeEvent[]; wake?: () => void }>();
  let sessionSeq = 0;
  // An explicit id re-sends an event a subscriber already saw.
  const emit = async (type: string, data: unknown, id?: string) => {
    eventSeq += 1;
    const event = { id: id ?? `evt_${eventSeq}`, type, data };
    for (const listener of listeners) {
      listener.queue.push(event);
      listener.wake?.();
    }
    await settleOnce();
    return event.id;
  };
  return {
    sessions,
    kv,
    mails,
    listeners,
    emit,
    nextSessionID: () => `ses-worker-${(sessionSeq += 1)}`,
  };
}

// The default location is where most tests dispatch their worker, so a
// single activation is also the worker's own location activation.
function fakeContext(
  listRows: SessionRow[] = [],
  options: {
    host?: ReturnType<typeof fakeHost>;
    directory?: string;
    pluginOptions?: Record<string, unknown>;
  } = {},
) {
  const host = options.host ?? fakeHost();
  const directory = options.directory ?? "/tmp/worktree-a";
  const { sessions, mails, emit, kv } = host;
  const created: Array<Record<string, any>> = [];
  const prompts: Array<{ sessionID: string; text: string; delivery?: string }> =
    [];
  const switched: Array<{
    sessionID: string;
    model: { providerID: string; id: string };
  }> = [];
  const switchedAgents: Array<{ sessionID: string; agent: string }> = [];
  // The registration domains, shaped like the host's. The agent editor
  // upserts from the same default Info the host starts a missing agent
  // from, so a test asserts the exact fields the module sets on top of it.
  const agents = new Map<string, Record<string, any>>();
  const defaultAgent = (id: string): Record<string, any> => ({
    id,
    name: id,
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ],
    request: { settings: {}, headers: {}, body: {} },
  });
  const skills: Array<{
    id: string;
    name: string;
    description?: string;
    path: string;
    content: string;
  }> = [];
  const commands: Array<{
    name: string;
    description?: string;
    execute: (invocation: {
      sessionID: string;
      prompt?: { text?: unknown };
      delivery?: string;
    }) => Promise<void>;
  }> = [];
  // The call log across the session domain, so a test can assert the order
  // the dispatch tool fires legs in (create, switchModel, prompt).
  const order: string[] = [];
  const tools = new Map<string, ToolDef>();

  const ctx: any = {
    location: {
      directory,
      project: { directory },
    },
    options: options.pluginOptions,
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
    session: {
      create: async (input: {
        title?: string;
        agent?: string;
        metadata?: Record<string, unknown>;
        permissions?: SessionRow["permissions"];
        location?: { directory: string };
      }) => {
        order.push("create");
        created.push(input);
        const row: SessionRow = {
          id: host.nextSessionID(),
          title: input.title,
          agent: input.agent,
          metadata: structuredClone(input.metadata ?? {}),
          // The host projects the permission stamp onto the durable session
          // row before any turn runs; the fake mirrors that.
          permissions: input.permissions
            ? structuredClone(input.permissions)
            : undefined,
          location: { directory: input.location?.directory ?? "/nowhere" },
        };
        sessions.set(row.id, row);
        return structuredClone(row);
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.get(sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        return structuredClone(row);
      },
      switchModel: async (input: {
        sessionID: string;
        model: { providerID: string; id: string };
      }) => {
        order.push("switchModel");
        switched.push(structuredClone(input));
        const row = sessions.get(input.sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        row.model = structuredClone(input.model);
        return undefined;
      },
      list: async (_input?: unknown) => ({
        data: structuredClone(listRows),
        cursor: {},
      }),
      prompt: async (input: {
        sessionID: string;
        text: string;
        delivery?: string;
      }) => {
        order.push("prompt");
        prompts.push(structuredClone(input));
        return { id: `msg-${prompts.length}`, sessionID: input.sessionID };
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        switchedAgents.push(structuredClone(input));
        return undefined;
      },
      synthetic: async (input: Mail) => {
        mails.push(structuredClone(input));
      },
    },
    agent: {
      transform: async (
        fn: (editor: {
          update: (
            id: string,
            update: (agent: Record<string, any>) => void,
          ) => void;
        }) => void,
      ) => {
        fn({
          update: (id, update) => {
            const current = agents.get(id) ?? defaultAgent(id);
            agents.set(id, current);
            update(current);
          },
        });
        return undefined;
      },
    },
    skill: {
      transform: async (
        fn: (editor: {
          add: (skill: {
            id: string;
            name: string;
            description?: string;
            path: string;
            content: string;
          }) => void;
        }) => void,
      ) => {
        fn({
          add: (skill) => {
            skills.push(skill);
          },
        });
        return undefined;
      },
    },
    command: {
      transform: async (
        fn: (editor: {
          add: (definition: {
            name: string;
            description?: string;
            execute: (invocation: {
              sessionID: string;
              prompt?: { text?: unknown };
              delivery?: string;
            }) => Promise<void>;
          }) => void;
        }) => void,
      ) => {
        fn({
          add: (definition) => {
            commands.push(definition);
          },
        });
        return undefined;
      },
    },
    storage: {
      get: async (key: string) =>
        kv.has(key) ? structuredClone(kv.get(key)) : undefined,
      set: async (key: string, value: unknown) => {
        kv.set(key, structuredClone(value));
      },
      remove: async (key: string) => {
        kv.delete(key);
      },
      scan: async (options: {
        prefix: string;
        after?: string;
        limit?: number;
      }) => {
        // The host's kv.scan: sorted keys, after-cursor, and a limit+1
        // peek whose overflow names the next cursor.
        const limit = Math.min(
          Math.max(Math.floor(options.limit ?? 100), 1),
          1000,
        );
        const keys = [...kv.keys()]
          .filter(
            (key) =>
              key.startsWith(options.prefix) &&
              (options.after === undefined || key > options.after),
          )
          .sort();
        const peeked = keys.slice(0, limit + 1);
        const entries = peeked
          .slice(0, limit)
          .map((key) => ({ key, value: structuredClone(kv.get(key)) }));
        return peeked.length > limit
          ? { entries, next: entries[entries.length - 1].key }
          : { entries };
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        const listener: { queue: FakeEvent[]; wake?: () => void } = {
          queue: [],
        };
        host.listeners.add(listener);
        try {
          while (!signal.aborted) {
            while (listener.queue.length) yield listener.queue.shift()!;
            await new Promise<void>((resolve) => {
              listener.wake = resolve;
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
        } finally {
          host.listeners.delete(listener);
        }
      },
    },
  };

  return {
    ctx,
    tools,
    sessions,
    kv,
    created,
    prompts,
    switched,
    switchedAgents,
    agents,
    skills,
    commands,
    mails,
    emit,
    order,
  };
}

async function dispatchWorker(
  fixture: ReturnType<typeof fakeContext>,
  input: Record<string, unknown>,
  director = "ses-director",
) {
  const dispatch = fixture.tools.get("director_dispatch")!;
  const result = await dispatch.execute(input, { sessionID: director });
  return JSON.parse(result.content);
}

// The pull half of the flow: run report_read as the calling director and
// parse the page.
async function readReports(
  fixture: ReturnType<typeof fakeContext>,
  caller: string,
  input: Record<string, unknown> = {},
) {
  const tool = fixture.tools.get("report_read")!;
  const result = await tool.execute(input, { sessionID: caller });
  return JSON.parse(result.content);
}

// The stored rows under the report/ prefix of a host's kv, oldest key
// first. A fixture and its host share the same kv map, so either works.
function storedRows(shared: { kv: Map<string, unknown> }) {
  return [...shared.kv.entries()]
    .filter(([key]) => key.startsWith("report/"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, row: value as Record<string, any> }));
}

test("setup registers exactly the director tool family", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  await cleanup?.();
  assert.deepEqual([...fixture.tools.keys()].sort(), [
    "director_dispatch",
    "director_sessions",
    "director_steer",
    "director_worker_status",
    "manifest_drop",
    "manifest_read",
    "manifest_write",
    "report_read",
    "worktree_add",
    "worktree_list",
    "worktree_remove",
  ]);
});

test("dispatch creates the worker in the directory, stamps the coordinator, and queues the brief", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const result = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
      title: "slice a",
      agent: "build",
    });

    assert.equal(result.ok, true);
    assert.equal(result.agent, "build");
    assert.equal(
      result.delivery,
      "waking prompt queued; the turn end files a report and wakes this session — call report_read",
    );
    assert.equal(fixture.created[0].agent, "build");
    assert.equal(fixture.created[0].title, "slice a");
    assert.equal(fixture.created[0].location.directory, "/tmp/worktree-a");
    assert.equal(
      fixture.created[0].metadata.chancery.coordinatedBy,
      "ses-director",
    );
    assert.equal(fixture.prompts[0].sessionID, result.sessionID);
    assert.equal(fixture.prompts[0].text, "do the slice work");
    assert.equal(fixture.mails.length, 0);
  } finally {
    await cleanup?.();
  }
});

test("dispatch stamps the unattended permission policy before the waking prompt", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    // The policy rides the create call, so a permission ask can never park
    // turn one: create (with the stamp) precedes the waking prompt, with no
    // separate permission write between them.
    assert.deepEqual(fixture.order, ["create", "prompt"]);
    assert.deepEqual(fixture.created[0].permissions, [
      { action: "*", resource: "*", effect: "allow" },
    ]);
    // The host projects the stamp onto the durable session row before any
    // turn runs, so the waking prompt's tool calls evaluate against allow.
    const row = fixture.sessions.get(dispatched.sessionID);
    assert.deepEqual(row?.permissions, [
      { action: "*", resource: "*", effect: "allow" },
    ]);
  } finally {
    await cleanup?.();
  }
});

test("dispatch derives the title from the brief and defaults the agent to build", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    await dispatchWorker(fixture, {
      directory: "/tmp/worktree-b",
      brief: "prj-3xx slice\n\nrest of the brief",
    });
    assert.equal(fixture.created[0].agent, "build");
    assert.equal(fixture.created[0].title, "prj-3xx slice");
  } finally {
    await cleanup?.();
  }
});

test("a turn end stores the report and wakes the director; report_read returns the body once, only to its director", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;

    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "The slice landed.\n\nSTATUS: done",
    });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "One open question: none. BLOCKED: no",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });

    await waitFor(() => fixture.mails.length === 1);
    const notice = fixture.mails[0];
    assert.equal(notice.sessionID, "ses-director");
    // The "◈ Notice" row's description and metadata.source; the notice
    // rides plain text, not the <system-reminder> wrapper the deployed
    // provider reads as an empty note and replaces with ".".
    assert.equal(
      notice.description,
      "Director module: worker report ready to read",
    );
    assert.deepEqual(notice.metadata, { source: "director" });
    assert.ok(!notice.text.startsWith("<system-reminder>"));
    // Fixed text: the worker session and the count, never worker text.
    assert.ok(notice.text.includes(`session ${worker}`));
    assert.ok(notice.text.includes("1 report unread"));
    assert.ok(notice.text.includes("report_read"));
    assert.ok(!notice.text.includes("The slice landed"));
    assert.ok(!notice.text.includes("STATUS: done"));
    assert.ok(!notice.text.includes("BLOCKED: no"));
    // Exactly one stored row behind it, addressed to the stamp.
    assert.equal(storedRows(fixture).length, 1);
    assert.equal(storedRows(fixture)[0].row.to, "ses-director");
    assert.equal(storedRows(fixture)[0].row.worker, worker);
    assert.equal(storedRows(fixture)[0].row.read, false);

    // The pull: the worker's own surfaces ride verbatim, as a tool result.
    const first = await readReports(fixture, "ses-director");
    assert.equal(first.returned, 1);
    assert.equal(first.unreadRemaining, 0);
    const report = first.reports[0];
    assert.equal(report.worker, worker);
    assert.equal(report.kind, "report");
    assert.ok(report.body.includes("The slice landed."));
    assert.ok(report.body.includes("STATUS: done"));
    assert.ok(report.body.includes("BLOCKED: no"));

    // Reading marks it read: a second pull returns nothing, and no other
    // director can pull this one's mail.
    const second = await readReports(fixture, "ses-director");
    assert.equal(second.returned, 0);
    const other = await readReports(fixture, "ses-other-director");
    assert.equal(other.returned, 0);
    assert.equal(storedRows(fixture)[0].row.read, true);

    // A duplicate terminal for the same turn re-stores and re-wakes
    // nothing.
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await settleOnce();
    assert.equal(fixture.mails.length, 1);
    assert.equal(storedRows(fixture).length, 1);

    // A new turn stores again and wakes again — and having read the first
    // report, the notice counts only what is unread now.
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "second turn",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 2);
    assert.ok(fixture.mails[1].text.includes("1 report unread"));
    const third = await readReports(fixture, "ses-director");
    assert.equal(third.reports[0].body.includes("second turn"), true);
    assert.ok(!third.reports[0].body.includes("The slice landed"));
  } finally {
    await cleanup?.();
  }
});

test("a turn report delivered twice under the same key enqueues exactly one message", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;

    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "the slice landed",
    });
    const terminal = await fixture.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await waitFor(() => fixture.mails.length === 1);
    // The claim is held before the same event arrives again, so the skip
    // is not a race the test wins by luck.
    assert.ok(claimsHeld().has(`${worker}:${terminal}`));

    // The same terminal event seen again, with a turn marker and text
    // ahead of it, delivers nothing the coordinator does not already hold.
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "the slice landed",
    });
    await fixture.emit(
      "session.execution.succeeded",
      { sessionID: worker },
      terminal,
    );
    await settleOnce();
    assert.equal(fixture.mails.length, 1);
  } finally {
    await cleanup?.();
  }
});

test("a different turn end is not swallowed: another worker's, and the same worker's next turn", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;

    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "first report",
    });
    const terminal = await fixture.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await waitFor(() => fixture.mails.length === 1);
    assert.ok(claimsHeld().has(`${worker}:${terminal}`));

    // The key is the worker session plus the terminal event's id: a second
    // worker's turn end delivers its own report.
    const next = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work again",
    });
    await fixture.emit("session.text.ended", {
      sessionID: next.sessionID,
      text: "a different worker's report",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: next.sessionID,
    });
    await waitFor(() => fixture.mails.length === 2);

    // And the first worker's next turn is not swallowed by its earlier
    // report either.
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "second report",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 3);
    // Three unread reports, coalesced into the last notice's count.
    assert.ok(fixture.mails[2].text.includes("3 reports unread"));
    assert.ok(!fixture.mails[2].text.includes("second report"));
    // The pull returns them oldest first, each body intact.
    const pulled = await readReports(fixture, "ses-director");
    assert.equal(pulled.returned, 3);
    assert.ok(pulled.reports[0].body.includes("first report"));
    assert.ok(pulled.reports[1].body.includes("a different worker's report"));
    assert.ok(pulled.reports[2].body.includes("second report"));
  } finally {
    await cleanup?.();
  }
});

test("a claimed terminal event stays claimed for a fresh activation in the same process", async () => {
  // One host, two activations: the shape of an old and a new activation
  // overlapping a location reload.
  const host = fakeHost();
  const first = fakeContext([], { host });
  const firstCleanup = await plugin.setup(first.ctx);
  let worker = "";
  let terminal = "";
  try {
    const dispatched = await dispatchWorker(first, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    worker = dispatched.sessionID;
    await first.emit("session.text.ended", {
      sessionID: worker,
      text: "the slice landed",
    });
    terminal = await first.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await waitFor(() => first.mails.length === 1);
  } finally {
    await firstCleanup?.();
  }

  // A fresh activation that reaches the same terminal event later: the
  // key was claimed, so it neither stores nor wakes.
  const reloaded = fakeContext([], { host });
  const reloadedCleanup = await plugin.setup(reloaded.ctx);
  try {
    await reloaded.emit(
      "session.execution.succeeded",
      { sessionID: worker },
      terminal,
    );
    await settleOnce();
    assert.equal(host.mails.length, 1);
    assert.equal(storedRows(host).length, 1);
  } finally {
    await reloadedCleanup?.();
  }
});

test("delivery claims are pruned after a day", async () => {
  const day = 24 * 60 * 60 * 1000;
  const realNow = Date.now;
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    const first = await fixture.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await waitFor(() => fixture.mails.length === 1);
    assert.ok(claimsHeld().has(`${worker}:${first}`));

    // A day later, the next claim folds the old one away.
    const later = realNow() + day + 1;
    Date.now = () => later;
    await fixture.emit("session.execution.started", { sessionID: worker });
    const second = await fixture.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await waitFor(() => fixture.mails.length === 2);
    assert.equal(claimsHeld().has(`${worker}:${first}`), false);
    assert.equal(claimsHeld().has(`${worker}:${second}`), true);
  } finally {
    Date.now = realNow;
    await cleanup?.();
  }
});

async function activations(
  host: ReturnType<typeof fakeHost>,
  directories: string[],
) {
  const fixtures = directories.map((directory) =>
    fakeContext([], { host, directory }),
  );
  const cleanups = await Promise.all(
    fixtures.map((fixture) => plugin.setup(fixture.ctx)),
  );
  return {
    fixtures,
    cleanup: async () => {
      for (const cleanup of cleanups) await cleanup?.();
    },
  };
}

// One worker turn per terminal kind; the interrupted turn carries no
// text. Every terminal files exactly one row and sends exactly one
// notice, no matter how many activations share the stream.
async function runEachTerminal(
  host: ReturnType<typeof fakeHost>,
  worker: string,
) {
  const terminals: Array<[string, Record<string, unknown>, boolean, string]> = [
    ["session.execution.succeeded", {}, true, "report"],
    [
      "session.execution.failed",
      { error: { type: "ProviderError", message: "502" } },
      true,
      "failed",
    ],
    // No reason field: not the host's shutdown shape, so it files as a
    // failed turn whose reason says the interrupt.
    ["session.execution.interrupted", {}, false, "failed"],
  ];
  for (const [index, [type, extra, withText, kind]] of terminals.entries()) {
    await host.emit("session.execution.started", { sessionID: worker });
    if (withText) {
      await host.emit("session.text.ended", {
        sessionID: worker,
        assistantMessageID: `msg-turn-${index}`,
        text: `turn ${index}`,
      });
    }
    await host.emit(type, { sessionID: worker, ...extra });
    await waitFor(() => host.mails.length >= index + 1);
    await settleOnce();
    await settleOnce();
    assert.equal(host.mails.length, index + 1, `${type} delivered once`);
    assert.equal(host.mails[index].sessionID, "ses-director");
    assert.equal(storedRows(host).length, index + 1, `${type} stored once`);
    assert.equal(
      storedRows(host)[index].row.kind,
      kind,
      `${type} filed as ${kind}`,
    );
    assert.equal(storedRows(host)[index].row.to, "ses-director");
  }
}

test("three activations on one event stream deliver each terminal event exactly once", async () => {
  const host = fakeHost();
  const { fixtures, cleanup } = await activations(host, [
    "/loc/director",
    "/tmp/worktree-a",
    "/loc/other",
  ]);
  try {
    // The director's activation dispatches into another location, and the
    // created event reaches every activation, as it would on a host that
    // does not route events by location.
    const dispatched = await dispatchWorker(fixtures[0], {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    await host.emit("session.created", {
      sessionID: worker,
      title: "do the slice work",
      metadata: host.sessions.get(worker)!.metadata,
      location: { directory: "/tmp/worktree-a" },
    });
    await runEachTerminal(host, worker);
  } finally {
    await cleanup();
  }
});

test("activations sharing one location claim each terminal event once", async () => {
  const host = fakeHost();
  // Three activations for the worker's own location: the shape a plugin
  // reload that leaves an old activation running would produce.
  const { fixtures, cleanup } = await activations(host, [
    "/tmp/worktree-a",
    "/tmp/worktree-a",
    "/tmp/worktree-a",
  ]);
  try {
    const dispatched = await dispatchWorker(fixtures[0], {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    await host.emit("session.created", {
      sessionID: worker,
      title: "do the slice work",
      metadata: host.sessions.get(worker)!.metadata,
      location: { directory: "/tmp/worktree-a" },
    });
    await runEachTerminal(host, worker);
  } finally {
    await cleanup();
  }
});

test("the worker's own location delivers after the dispatching director's activation is gone", async () => {
  const host = fakeHost();
  const director = fakeContext([], { host, directory: "/loc/director" });
  const directorCleanup = await plugin.setup(director.ctx);
  const dispatched = await dispatchWorker(director, {
    directory: "/tmp/worktree-a",
    brief: "do the slice work",
  });
  // The director's location is evicted (or its plugins reload) before the
  // worker's turn ends; the worker's location activation starts after it.
  await directorCleanup?.();
  const workerFixture = fakeContext([], {
    host,
    directory: "/tmp/worktree-a",
  });
  const workerCleanup = await plugin.setup(workerFixture.ctx);
  try {
    await host.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      assistantMessageID: "msg-evicted",
      text: "landed while the director's location slept",
    });
    await host.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => host.mails.length === 1);
    assert.equal(host.mails[0].sessionID, "ses-director");
    // The late activation still pulls the full buffered text back.
    const pulled = await readReports(workerFixture, "ses-director");
    assert.ok(
      pulled.reports[0].body.includes(
        "landed while the director's location slept",
      ),
    );
  } finally {
    await workerCleanup?.();
  }
});

// One turn's text through the whole pull path: file the report, wake,
// then read it back as the director. Returns the parsed page and the
// first report's body.
async function pullText(
  text: string,
  terminal = "session.execution.succeeded",
) {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.execution.started", {
      sessionID: dispatched.sessionID,
    });
    await fixture.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      text,
    });
    await fixture.emit(terminal, {
      sessionID: dispatched.sessionID,
      error: { type: "ProviderError", message: "502" },
    });
    await waitFor(() => fixture.mails.length === 1);
    const page = await readReports(fixture, "ses-director");
    return { page, body: page.reports[0].body, worker: dispatched.sessionID };
  } finally {
    await cleanup?.();
  }
}

test("a long report is cut to its head with STATUS, BLOCKED and a pointer kept", async () => {
  const filler = Array.from({ length: 200 }, (_, i) => `detail line ${i}`).join(
    "\n",
  );
  const text = [
    "Summary of the slice.",
    filler,
    "",
    "BLOCKED: which branch should this land on?",
    "Recommend main.",
    "",
    `STATUS: blocked ${"x".repeat(400)}`,
  ].join("\n");
  const { body, worker } = await pullText(text);
  assert.ok(body.includes("Summary of the slice."));
  assert.ok(!body.includes("detail line 199"));
  assert.ok(
    body.includes(
      "BLOCKED: which branch should this land on?\nRecommend main.",
    ),
  );
  assert.ok(body.includes(`STATUS: blocked ${"x".repeat(284)}`));
  assert.ok(!body.includes(`STATUS: blocked ${"x".repeat(285)}`));
  assert.ok(body.includes(`opencode session export ${worker}`));
  assert.ok(body.includes("/tmp/worktree-a"));
  assert.ok(body.length < 3200, `body is ${body.length} characters`);
});

test("a short report is delivered whole, with no pointer", async () => {
  const text = "Did the thing.\n\nSTATUS: done — branch fix/x at abc123";
  const { body } = await pullText(text);
  assert.ok(body.includes(text));
  assert.ok(!body.includes("opencode session export"));
});

test("a failed turn's report cuts its partial text the same way", async () => {
  const text = `STATUS: working\n${"partial ".repeat(400)}`;
  const { body, worker } = await pullText(text, "session.execution.failed");
  assert.ok(body.includes("turn-not-completed"));
  // STATUS sits inside the head, so it is not repeated ahead of it.
  assert.equal(body.split("STATUS: working").length, 2);
  assert.ok(body.includes(`opencode session export ${worker}`));
  assert.ok(body.length < 2600, `body is ${body.length} characters`);
});

test("the cut keeps the last BLOCKED and an indented STATUS, splits no surrogate pair, and counts exactly", async () => {
  // 1,199 ASCII characters, then an emoji whose two halves straddle the
  // 1,200-character mark.
  const lead = "a".repeat(1199);
  const text = [
    `${lead}😀 tail`,
    "",
    "BLOCKED: an earlier question, since answered",
    "",
    "BLOCKED: the open question",
    "Recommend yes.",
    "",
    "  STATUS: blocked on the open question",
  ].join("\n");
  const { body, worker } = await pullText(text);
  assert.ok(body.includes("BLOCKED: the open question\nRecommend yes."));
  assert.ok(!body.includes("an earlier question"));
  assert.ok(body.includes("  STATUS: blocked on the open question"));
  // The head stops before the emoji's high surrogate, not between halves.
  assert.ok(body.includes(`${lead}\n`));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(body));
  // The count excludes the BLOCKED paragraph and STATUS line shown above
  // the head.
  const shownSeparately =
    "BLOCKED: the open question\nRecommend yes.".length +
    "  STATUS: blocked on the open question".length;
  assert.ok(
    body.includes(
      `[… ${text.length - 1199 - shownSeparately} more UTF-16 code units not shown.`,
    ),
  );
  assert.ok(!body.includes("(run in"));
  assert.ok(
    body.includes(
      `Full text: opencode session export ${worker}. The work itself is in /tmp/worktree-a.`,
    ),
  );
});

test("an early STATUS inside the head does not stand in for the final one past the cut", async () => {
  const text = [
    "STATUS: done with part 1",
    "x".repeat(1500),
    "STATUS: done",
  ].join("\n");
  const { body } = await pullText(text);
  // The final STATUS is shown ahead of the head, and counted as shown.
  assert.ok(body.includes("STATUS: done\n\nSTATUS: done with part 1"));
  const head = 1200;
  assert.ok(
    body.includes(
      `[… ${text.length - head - "STATUS: done".length} more UTF-16 code units not shown.`,
    ),
  );
});

test("a STATUS line inside the BLOCKED paragraph is shown once", async () => {
  const text = [
    "y".repeat(1500),
    "",
    "BLOCKED: need a ruling on the branch",
    "STATUS: blocked",
  ].join("\n");
  const { body } = await pullText(text);
  assert.equal(body.split("STATUS: blocked").length, 2);
  assert.ok(
    body.includes("BLOCKED: need a ruling on the branch\nSTATUS: blocked"),
  );
});

test("a BLOCKED paragraph that starts in the head and runs past it is not shown twice", async () => {
  // 1,500 characters, no blank lines: the paragraph's 800-unit cut ends
  // inside the 1,200-unit head, so it is already shown there.
  const text = `BLOCKED: ${"q".repeat(1491)}`;
  assert.equal(text.length, 1500);
  const { body } = await pullText(text);
  assert.equal(body.split("BLOCKED:").length, 2);
  assert.ok(body.includes("[… 300 more UTF-16 code units not shown."));
});

test("a report stored by an activation that joined mid-turn is labeled partial", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    // Adopted on a text block: the turn's start was never seen here.
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "the tail of a turn",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 1);
    // The notice stays fixed; the PARTIAL label lives in the pulled body.
    assert.ok(!fixture.mails[0].text.includes("PARTIAL"));
    const first = await readReports(fixture, "ses-director");
    assert.ok(first.reports[0].partial);
    assert.ok(first.reports[0].body.includes("PARTIAL: this report began"));
    assert.ok(
      first.reports[0].body.includes(`opencode session export ${worker}`),
    );

    // The next turn is seen from its start, so it is whole.
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "a whole turn",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 2);
    const second = await readReports(fixture, "ses-director");
    assert.ok(!second.reports[0].body.includes("PARTIAL"));
  } finally {
    await cleanup?.();
  }
});

test("a subagent child carrying its parent's stamp and location sends no mail", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const parent = fixture.sessions.get(dispatched.sessionID)!;
    fixture.sessions.set("ses-subagent", {
      ...structuredClone(parent),
      id: "ses-subagent",
      parentID: dispatched.sessionID,
    });
    await fixture.emit("session.execution.started", {
      sessionID: "ses-subagent",
    });
    await fixture.emit("session.text.ended", {
      sessionID: "ses-subagent",
      text: "subagent findings",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: "ses-subagent",
    });
    await settleOnce();
    await settleOnce();
    assert.equal(fixture.mails.length, 0);
    assert.equal(storedRows(fixture).length, 0);

    // The parent's own turn still reports.
    await fixture.emit("session.execution.started", {
      sessionID: dispatched.sessionID,
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);
  } finally {
    await cleanup?.();
  }
});

test("a shutdown interrupt files an interrupted report and wakes the director, and the resumed turn reports too", async () => {
  const host = fakeHost();
  const before = fakeContext([], { host });
  const beforeCleanup = await plugin.setup(before.ctx);
  let worker = "";
  try {
    const dispatched = await dispatchWorker(before, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    worker = dispatched.sessionID;
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", {
      sessionID: worker,
      text: "halfway",
    });
    const interrupted = await host.emit("session.execution.interrupted", {
      sessionID: worker,
      reason: "shutdown",
    });
    await waitFor(() => host.mails.length === 1);
    // The wake stays fixed; the distinct interrupted wording lives in the
    // pulled report, not in the notice.
    const notice = host.mails[0].text;
    assert.ok(notice.includes(`session ${worker}`));
    assert.ok(notice.includes("report_read"));
    assert.ok(!notice.includes("halfway"));
    assert.ok(!notice.includes("NOT COMPLETED"));
    // Keyed on the terminal event id like every other report.
    assert.ok(claimsHeld().has(`${worker}:${interrupted}`));
    assert.equal(storedRows(host).length, 1);
    const pulled = await readReports(before, "ses-director");
    const report = pulled.reports[0];
    assert.equal(report.kind, "interrupted");
    assert.ok(
      report.body.includes(
        "interrupted with no recorded reason, as a host shutdown is",
      ),
    );
    assert.ok(!report.body.includes("NOT COMPLETED"));
    assert.ok(report.body.includes("may resume it after a restart"));
    assert.ok(report.body.includes("may never report"));
    assert.ok(report.body.includes("director_worker_status"));
    assert.ok(report.body.includes(`opencode session export ${worker}`));
    assert.ok(report.body.includes("halfway"));
  } finally {
    await beforeCleanup?.();
  }

  // After the restart the host resumes the claimed turn.
  const after = fakeContext([], { host });
  const afterCleanup = await plugin.setup(after.ctx);
  try {
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", { sessionID: worker, text: "done" });
    await host.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => host.mails.length === 2);
    await settleOnce();
    assert.equal(host.mails.length, 2);
    const resumed = await readReports(after, "ses-director");
    assert.equal(resumed.reports[0].kind, "report");
    assert.ok(resumed.reports[0].body.includes("done"));

    // A deliberate interrupt is a turn end too, filed as a failure that
    // says why.
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.execution.interrupted", {
      sessionID: worker,
      reason: "user",
    });
    await waitFor(() => host.mails.length === 3);
    const deliberate = await readReports(after, "ses-director");
    assert.equal(deliberate.reports[0].kind, "failed");
    assert.ok(deliberate.reports[0].body.includes("NOT COMPLETED"));
    assert.ok(deliberate.reports[0].body.includes("(user)"));
  } finally {
    await afterCleanup?.();
  }
});

test("a resume-exhausted Failed at boot, with no started before it, still files and wakes once", async () => {
  const host = fakeHost();
  // A restarted host: the stamped worker exists, and the first event this
  // fresh activation sees for it is the boot-time Failed.
  const fixture = fakeContext([], { host });
  host.sessions.set("ses-resumed", {
    id: "ses-resumed",
    title: "resumed slice",
    agent: "build",
    metadata: { chancery: { coordinatedBy: "ses-director" } },
    location: { directory: "/tmp/worktree-a" },
  });
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    await host.emit("session.execution.failed", {
      sessionID: "ses-resumed",
      error: { type: "ResumeExhausted", message: "resume budget spent" },
    });
    await waitFor(() => host.mails.length === 1);
    await settleOnce();
    assert.equal(host.mails.length, 1);
    assert.ok(host.mails[0].text.includes("session ses-resumed"));
    assert.ok(host.mails[0].text.includes("report_read"));
    assert.equal(storedRows(host).length, 1);
    const pulled = await readReports(fixture, "ses-director");
    assert.equal(pulled.reports[0].kind, "failed");
    assert.ok(pulled.reports[0].body.includes("NOT COMPLETED"));
    assert.ok(pulled.reports[0].body.includes("resume budget spent"));
    // Adopted at the terminal, it missed no text it could have held.
    assert.ok(!pulled.reports[0].body.includes("PARTIAL"));
  } finally {
    await cleanup?.();
  }
});

test("a turn's start clears text left over from a turn that never mailed", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "stale text from a turn whose terminal never arrived",
    });
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "this turn's text",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 1);
    const pulled = await readReports(fixture, "ses-director");
    assert.ok(pulled.reports[0].body.includes("this turn's text"));
    assert.ok(!pulled.reports[0].body.includes("stale text"));
  } finally {
    await cleanup?.();
  }
});

test("claims are shared across a re-import of the module, as a plugin reload does", async () => {
  // A cache-busted import evaluates the module again, as the host's loader
  // does on reload; the claims ride globalThis, not module state.
  const { default: reimported } = await import(
    `../director.ts?reimport=${Date.now()}`
  );
  assert.notEqual(reimported, plugin);
  const host = fakeHost();
  const oldFixture = fakeContext([], { host });
  const oldCleanup = await plugin.setup(oldFixture.ctx);
  const newCleanup = await reimported.setup(fakeContext([], { host }).ctx);
  try {
    const dispatched = await dispatchWorker(oldFixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await host.emit("session.execution.started", {
      sessionID: dispatched.sessionID,
    });
    await host.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => host.mails.length >= 1);
    await settleOnce();
    await settleOnce();
    assert.equal(host.mails.length, 1);
  } finally {
    await newCleanup?.();
    await oldCleanup?.();
  }
});

test("overlapping activations holding different buffers send one mail per terminal event", async () => {
  const host = fakeHost();
  const old = fakeContext([], { host });
  const oldCleanup = await plugin.setup(old.ctx);
  let newCleanup: (() => Promise<void>) | void = undefined;
  try {
    const dispatched = await dispatchWorker(old, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", {
      sessionID: worker,
      assistantMessageID: "msg-block-1",
      text: "first block",
    });
    // A location reload starts the new activation mid-turn while the old
    // one is still subscribed: their buffers (and the message ids in them)
    // differ for this turn.
    newCleanup = await plugin.setup(fakeContext([], { host }).ctx);
    await host.emit("session.text.ended", {
      sessionID: worker,
      assistantMessageID: "msg-block-2",
      text: "second block",
    });
    await host.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => host.mails.length >= 1);
    await settleOnce();
    await settleOnce();
    assert.equal(host.mails.length, 1);
  } finally {
    await newCleanup?.();
    await oldCleanup?.();
  }
});

test("a failed wake keeps the report stored and claim-safe; the next notice coalesces it", async () => {
  const originalError = console.error;
  console.error = () => {};
  const host = fakeHost();
  const failing = fakeContext([], { host });
  failing.ctx.session.synthetic = async () => {
    throw new Error("inbox unavailable");
  };
  const failingCleanup = await plugin.setup(failing.ctx);
  let worker = "";
  let terminal = "";
  try {
    const dispatched = await dispatchWorker(failing, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    worker = dispatched.sessionID;
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", { sessionID: worker, text: "done" });
    terminal = await host.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await settleOnce();
    await settleOnce();
    // The notice never went out, but the report is stored and its claim
    // is held: a sibling activation re-noticing the same terminal event
    // would overwrite the row with its own buffer's text.
    assert.equal(host.mails.length, 0);
    assert.equal(storedRows(host).length, 1);
    assert.ok(claimsHeld().has(`${worker}:${terminal}`));
  } finally {
    await failingCleanup?.();
    console.error = originalError;
  }

  // The next terminal event's notice counts the stranded report too —
  // that coalesced wake is the recovery path.
  const healthy = fakeContext([], { host });
  const healthyCleanup = await plugin.setup(healthy.ctx);
  try {
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", {
      sessionID: worker,
      text: "next turn",
    });
    await host.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => host.mails.length === 1);
    assert.ok(host.mails[0].text.includes("2 reports unread"));
    const pulled = await readReports(healthy, "ses-director");
    assert.equal(pulled.returned, 2);
    assert.ok(pulled.reports[0].body.includes("done"));
    assert.ok(pulled.reports[1].body.includes("next turn"));
  } finally {
    await healthyCleanup?.();
  }
});

test("a failed store is no claim: nothing is stored, nobody is woken, and a sibling activation can try", async () => {
  const originalError = console.error;
  console.error = () => {};
  const host = fakeHost();
  const broken = fakeContext([], { host });
  broken.ctx.storage.set = async () => {
    throw new Error("kv unavailable");
  };
  const brokenCleanup = await plugin.setup(broken.ctx);
  let worker = "";
  let terminal = "";
  try {
    const dispatched = await dispatchWorker(broken, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    worker = dispatched.sessionID;
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", { sessionID: worker, text: "done" });
    terminal = await host.emit("session.execution.succeeded", {
      sessionID: worker,
    });
    await settleOnce();
    await settleOnce();
    assert.equal(host.mails.length, 0);
    assert.equal(storedRows(host).length, 0);
    // No row was stored, so the claim is given back.
    assert.equal(claimsHeld().has(`${worker}:${terminal}`), false);
  } finally {
    await brokenCleanup?.();
    console.error = originalError;
  }

  // A healthy activation over the same stream delivers the whole flow.
  const healthy = fakeContext([], { host });
  const healthyCleanup = await plugin.setup(healthy.ctx);
  try {
    await host.emit("session.execution.started", { sessionID: worker });
    await host.emit("session.text.ended", { sessionID: worker, text: "done" });
    await host.emit(
      "session.execution.succeeded",
      { sessionID: worker },
      terminal,
    );
    await waitFor(() => host.mails.length === 1);
    assert.equal(storedRows(host).length, 1);
    const pulled = await readReports(healthy, "ses-director");
    assert.equal(pulled.returned, 1);
    assert.ok(pulled.reports[0].body.includes("done"));
  } finally {
    await healthyCleanup?.();
  }
});

test("report_read pages by limit and character budget, oldest first", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const workers: string[] = [];
    for (const text of ["report one", "report two", "report three"]) {
      const dispatched = await dispatchWorker(fixture, {
        directory: "/tmp/worktree-a",
        brief: "do the slice work",
      });
      workers.push(dispatched.sessionID);
      await fixture.emit("session.execution.started", {
        sessionID: dispatched.sessionID,
      });
      await fixture.emit("session.text.ended", {
        sessionID: dispatched.sessionID,
        text,
      });
      await fixture.emit("session.execution.succeeded", {
        sessionID: dispatched.sessionID,
      });
      await waitFor(() => fixture.mails.length === workers.length);
    }

    // The limit caps the page; the rest stay unread and counted.
    const first = await readReports(fixture, "ses-director", { limit: 2 });
    assert.equal(first.returned, 2);
    assert.equal(first.unreadRemaining, 1);
    assert.ok(first.reports[0].body.includes("report one"));
    assert.ok(first.reports[1].body.includes("report two"));
    assert.equal(first.note, "more reports are unread; call report_read again");

    // The character budget stops after what fits; the first unread report
    // is always taken, so a page below one body still makes progress.
    const second = await readReports(fixture, "ses-director", {
      maxChars: 400,
    });
    assert.equal(second.returned, 1);
    assert.equal(second.unreadRemaining, 0);
    assert.ok(second.reports[0].body.includes("report three"));

    // Defaults when no budgets are passed: five reports at most.
    for (let i = 0; i < 6; i += 1) {
      const dispatched = await dispatchWorker(fixture, {
        directory: "/tmp/worktree-a",
        brief: `slice ${i}`,
      });
      await fixture.emit("session.execution.succeeded", {
        sessionID: dispatched.sessionID,
      });
      await waitFor(() => fixture.mails.length === workers.length + i + 1);
    }
    const defaulted = await readReports(fixture, "ses-director");
    assert.equal(defaulted.returned, 5);
    assert.equal(defaulted.unreadRemaining, 1);
  } finally {
    await cleanup?.();
  }
});

test("stored reports survive a reload: a fresh activation over the same kv pulls what an earlier one filed", async () => {
  const host = fakeHost();
  const before = fakeContext([], { host });
  const beforeCleanup = await plugin.setup(before.ctx);
  let worker = "";
  try {
    const dispatched = await dispatchWorker(before, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    worker = dispatched.sessionID;
    await host.emit("session.text.ended", {
      sessionID: worker,
      text: "filed before the reload",
    });
    await host.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => host.mails.length === 1);
    // The row sits unread in the kv table.
    assert.equal(storedRows(host).length, 1);
    assert.equal(storedRows(host)[0].row.read, false);
  } finally {
    await beforeCleanup?.();
  }

  // A plugin reload (or a host restart) makes a new activation over the
  // same kv table; the reports are its inbox, not its process state.
  const after = fakeContext([], { host });
  const afterCleanup = await plugin.setup(after.ctx);
  try {
    const pulled = await readReports(after, "ses-director");
    assert.equal(pulled.returned, 1);
    assert.ok(pulled.reports[0].body.includes("filed before the reload"));
    assert.equal(pulled.reports[0].worker, worker);
  } finally {
    await afterCleanup?.();
  }
});

test("worker_status counts unread reports, from the worker and in total", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const first = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const second = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the other slice",
    });
    for (const worker of [first.sessionID, second.sessionID]) {
      await fixture.emit("session.execution.succeeded", { sessionID: worker });
      await waitFor(() => fixture.mails.length >= 1);
    }
    await settleOnce();
    const status = fixture.tools.get("director_worker_status")!;
    const row = JSON.parse(
      (
        await status.execute(
          { sessionID: first.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(row.unreadReportsFromWorker, 1);
    assert.equal(row.unreadReportsTotal, 2);

    // Pulled mail drains the counts.
    await readReports(fixture, "ses-director");
    const drained = JSON.parse(
      (
        await status.execute(
          { sessionID: first.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(drained.unreadReportsFromWorker, 0);
    assert.equal(drained.unreadReportsTotal, 0);
  } finally {
    await cleanup?.();
  }
});

test("a concurrent drain between store and count never reads as zero reports in the notice", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    // The store's prune scan is the first scan of the flow; every scan
    // after it sees an empty store, as a report_read running between the
    // store and the count would.
    let scanCalls = 0;
    const originalScan = fixture.ctx.storage.scan;
    fixture.ctx.storage.scan = async (options: {
      prefix: string;
      after?: string;
      limit?: number;
    }) => {
      scanCalls += 1;
      if (scanCalls >= 2) return { entries: [] };
      return originalScan(options);
    };
    await fixture.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      text: "the slice landed",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);
    // The row is stored, so the notice never says zero.
    assert.equal(storedRows(fixture).length, 1);
    assert.ok(fixture.mails[0].text.includes("1 report unread"));
    assert.ok(!fixture.mails[0].text.includes("0 reports unread"));
  } finally {
    await cleanup?.();
  }
});

test("a failed mark-read delivers the bodies and strands nothing", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const workers: string[] = [];
  try {
    console.error = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));
    for (const text of ["report one", "report two"]) {
      const dispatched = await dispatchWorker(fixture, {
        directory: "/tmp/worktree-a",
        brief: "do the slice work",
      });
      workers.push(dispatched.sessionID);
      await fixture.emit("session.execution.started", {
        sessionID: dispatched.sessionID,
      });
      await fixture.emit("session.text.ended", {
        sessionID: dispatched.sessionID,
        text,
      });
      await fixture.emit("session.execution.succeeded", {
        sessionID: dispatched.sessionID,
      });
      await waitFor(() => fixture.mails.length === workers.length);
    }

    // Every mark-read write fails: the page must still come back, and
    // the rows must still read as unread.
    const originalSet = fixture.ctx.storage.set;
    fixture.ctx.storage.set = async (key: string, value: unknown) => {
      if ((value as { read?: boolean })?.read === true)
        throw new Error("kv write refused");
      return originalSet(key, value);
    };
    const failed = await readReports(fixture, "ses-director");
    assert.equal(failed.returned, 2);
    assert.equal(failed.unmarked, 2);
    assert.equal(failed.unreadRemaining, 2);
    assert.ok(failed.reports[0].body.includes("report one"));
    assert.ok(failed.reports[1].body.includes("report two"));
    assert.ok(logs.some((line) => line.includes("mark-read failed")));
    for (const row of storedRows(fixture)) assert.equal(row.row.read, false);

    // With marking healthy again, the same rows come back — they were
    // never stranded as read-but-undelivered.
    fixture.ctx.storage.set = originalSet;
    const retry = await readReports(fixture, "ses-director");
    assert.equal(retry.returned, 2);
    assert.equal(retry.unreadRemaining, 0);
    assert.ok(retry.reports[0].body.includes("report one"));
  } finally {
    console.error = originalError;
    await cleanup?.();
  }
});

test("the report scan's page cap surfaces as a truncation signal in report_read", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      text: "the slice landed",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);
    // A scan that always claims a cursor keeps the walk at its page cap:
    // one real page, then empty pages that never run out of cursor.
    let scanCalls = 0;
    const originalScan = fixture.ctx.storage.scan;
    fixture.ctx.storage.scan = async (options: {
      prefix: string;
      after?: string;
      limit?: number;
    }) => {
      scanCalls += 1;
      if (scanCalls === 1) {
        const page = await originalScan(options);
        return { entries: page.entries, next: "cursor-never-ends" };
      }
      return { entries: [], next: "cursor-never-ends" };
    };
    const page = await readReports(fixture, "ses-director");
    assert.equal(page.truncated, true);
    assert.match(page.note, /page cap/);
    assert.equal(page.returned, 1);
    assert.equal(page.unreadRemaining, 0);
  } finally {
    await cleanup?.();
  }
});

test("the read-row prune drops stale read rows (readAt or created), never unread mail, and caps a director's rows", async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    // Seeded rows for ses-director: two stale read rows (one with readAt,
    // one falling back to created), a fresh read row, and two unread rows
    // of different ages.
    const seed = (id: string, extra: Record<string, unknown>) =>
      fixture.ctx.storage.set(`report/ses-director/ses-seeded/${id}`, {
        to: "ses-director",
        worker: "ses-seeded",
        kind: "report",
        title: "seeded",
        directory: "/tmp/worktree-a",
        agent: "build",
        reason: null,
        partial: false,
        text: `seeded ${id}`,
        created: now - 8 * day,
        read: false,
        ...extra,
      });
    await seed("evt-a", { read: true, readAt: now - 8 * day });
    await seed("evt-b", { read: true });
    await seed("evt-c", {
      read: true,
      readAt: now - 1 * day,
      created: now - 1 * day,
    });
    // evt-d is the oldest row in the store: the cap's eviction test.
    await seed("evt-d", {});
    await seed("evt-e", { created: now - 6 * day });
    // Ninety-seven more unread rows round the store past the cap.
    for (let i = 0; i < 97; i += 1) {
      await seed(`evt-bulk-${i}`, { created: now - 5 * day + i });
    }

    // A store for the same director runs the prune.
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      text: "the slice landed",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);

    const keys = storedRows(fixture).map((row) => row.key);
    const has = (id: string) =>
      keys.includes(`report/ses-director/ses-seeded/${id}`);
    // Stale read rows go — via readAt and via the created fallback.
    assert.equal(has("evt-a"), false);
    assert.equal(has("evt-b"), false);
    // Fresh read rows stay.
    assert.equal(has("evt-c"), true);
    // The cap evicts exactly the oldest row, unread included.
    assert.equal(has("evt-d"), false);
    assert.equal(has("evt-e"), true);
    assert.equal(keys.length, 100);
    for (let i = 0; i < 97; i += 1) assert.equal(has(`evt-bulk-${i}`), true);
    // The row that triggered the prune is kept — it is the newest.
    assert.ok(
      keys.some((key) =>
        key.startsWith(`report/ses-director/${dispatched.sessionID}/`),
      ),
      "the newest row survives the cap",
    );
  } finally {
    await cleanup?.();
  }
});

// PRJ-342: the read-only discovery tool. The fake's list rows are the
// Session.Info shape the host serves to both session.list and session.get,
// so what the tool reads here is what a live host hands it.

test("director_sessions enumerates the host's sessions with state, last turn end, and recent-first order", async () => {
  const fixture = fakeContext([
    {
      id: "ses-idle",
      agent: "explore",
      location: { directory: "/tmp/worktree-idle" },
      time: { created: 1, updated: 30, busy: 50, idle: 80 },
    },
    {
      // busy outruns idle by the comparison stateOf uses; while the turn
      // runs, idle holds the previous turn's end.
      id: "ses-running",
      agent: "build",
      location: { directory: "/tmp/worktree-run" },
      time: { created: 1, updated: 40, busy: 100, idle: 90 },
    },
    {
      id: "ses-fresh",
      agent: "build",
      location: { directory: "/tmp/worktree-fresh" },
    },
  ]);
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const tool = fixture.tools.get("director_sessions")!;
    const result = JSON.parse(
      (await tool.execute({}, { sessionID: "ses-director" })).content,
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 0);
    assert.equal("truncated" in result, false);
    assert.deepEqual(result.sessions, [
      {
        sessionID: "ses-running",
        directory: "/tmp/worktree-run",
        agent: "build",
        state: "busy",
        lastTurnEnd: 90,
      },
      {
        sessionID: "ses-idle",
        directory: "/tmp/worktree-idle",
        agent: "explore",
        state: "idle",
        lastTurnEnd: 80,
      },
      {
        sessionID: "ses-fresh",
        directory: "/tmp/worktree-fresh",
        agent: "build",
        state: "idle",
        lastTurnEnd: null,
      },
    ]);
  } finally {
    await cleanup?.();
  }
});

test("director_sessions carries no message text: fixture strings planted on the row stay out of the output", async () => {
  const fixture = fakeContext([
    {
      id: "ses-worker",
      title: "FIXTURE-TITLE-q8x",
      agent: "build",
      location: { directory: "/tmp/worktree-secret" },
      time: { created: 1, updated: 9 },
      metadata: {
        chancery: { coordinatedBy: "ses-director" },
        note: "FIXTURE-MESSAGE-BODY-7f3a",
      },
    },
  ]);
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const tool = fixture.tools.get("director_sessions")!;
    const raw = (await tool.execute({}, { sessionID: "ses-director" })).content;
    assert.ok(!raw.includes("FIXTURE-MESSAGE-BODY-7f3a"));
    assert.ok(!raw.includes("FIXTURE-TITLE-q8x"));
    // The full payload is the five fields and nothing else.
    assert.deepEqual(JSON.parse(raw), {
      ok: true,
      sessions: [
        {
          sessionID: "ses-worker",
          directory: "/tmp/worktree-secret",
          agent: "build",
          state: "idle",
          lastTurnEnd: null,
        },
      ],
      skipped: 0,
    });
  } finally {
    await cleanup?.();
  }
});

test("unparseable session rows are skipped and logged, never thrown or silently dropped", async () => {
  const fixture = fakeContext([
    null,
    "a bare string",
    { directory: "/no-id" },
    { id: "   " },
    {
      id: "ses-good",
      agent: "build",
      location: { directory: "/tmp/worktree-good" },
      time: { created: 1, updated: 5, idle: 7 },
    },
  ]);
  const logs: string[] = [];
  const originalError = console.error;
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    // Installed after setup returns, inside the try the finally restores
    // from: a throw in setup strands nothing.
    console.error = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));
    const tool = fixture.tools.get("director_sessions")!;
    const result = JSON.parse(
      (await tool.execute({}, { sessionID: "ses-director" })).content,
    );
    assert.deepEqual(result.sessions, [
      {
        sessionID: "ses-good",
        directory: "/tmp/worktree-good",
        agent: "build",
        state: "idle",
        lastTurnEnd: 7,
      },
    ]);
    assert.equal(result.skipped, 4);
    // Each skip names the row's place (the count) and why it skipped: a
    // silent drop is a shipped-invariant violation this repo paid for.
    const skipLines = logs.filter((line) =>
      line.includes("[director] director_sessions: skipped session row"),
    );
    assert.equal(skipLines.length, 4);
    assert.ok(
      skipLines.some(
        (line) =>
          line.includes("row 1 of 5") && line.includes("not a session object"),
      ),
    );
    assert.ok(
      skipLines.some(
        (line) =>
          line.includes("row 2 of 5") && line.includes("not a session object"),
      ),
    );
    assert.ok(
      skipLines.some(
        (line) => line.includes("row 3 of 5") && line.includes("no usable id"),
      ),
    );
    assert.ok(
      skipLines.some(
        (line) => line.includes("row 4 of 5") && line.includes("no usable id"),
      ),
    );
  } finally {
    console.error = originalError;
    await cleanup?.();
  }
});

test("a client surface without session.list fails with a named error, not a fallback", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const tool = fixture.tools.get("director_sessions")!;
    delete fixture.ctx.session.list;
    await assert.rejects(
      tool.execute({}, { sessionID: "ses-director" }),
      (error: Error) => {
        assert.match(error.message, /^director_sessions: /);
        assert.match(error.message, /lacks session\.list/);
        return true;
      },
    );
  } finally {
    await cleanup?.();
  }
});

test("a paged session.list is walked through its cursor", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    fixture.ctx.session.list = async (input?: { cursor?: string }) => {
      const page = input?.cursor === "page-2" ? 1 : 0;
      return {
        data: [
          {
            id: page === 0 ? "ses-first-page" : "ses-second-page",
            agent: "build",
            location: {
              directory: `/tmp/worktree-page-${page + 1}`,
            },
            time: { created: 1, updated: page, idle: page === 0 ? 50 : 10 },
          },
        ],
        cursor: page === 0 ? { next: "page-2" } : {},
      };
    };
    const tool = fixture.tools.get("director_sessions")!;
    const result = JSON.parse(
      (await tool.execute({}, { sessionID: "ses-director" })).content,
    );
    assert.deepEqual(result.sessions, [
      {
        sessionID: "ses-first-page",
        directory: "/tmp/worktree-page-1",
        agent: "build",
        state: "idle",
        lastTurnEnd: 50,
      },
      {
        sessionID: "ses-second-page",
        directory: "/tmp/worktree-page-2",
        agent: "build",
        state: "idle",
        lastTurnEnd: 10,
      },
    ]);
    assert.equal("truncated" in result, false);
  } finally {
    await cleanup?.();
  }
});

test("enumeration past the page cap stops and says it truncated", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    fixture.ctx.session.list = async (input?: { cursor?: string }) => {
      const page = input?.cursor === undefined ? 0 : Number(input.cursor);
      return {
        data: [
          {
            id: `ses-page-${page}`,
            agent: "build",
            location: { directory: `/tmp/worktree-p${page}` },
            time: { created: 1, updated: page, idle: page },
          },
        ],
        cursor: { next: String(page + 1) },
      };
    };
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));
    try {
      const tool = fixture.tools.get("director_sessions")!;
      const result = JSON.parse(
        (await tool.execute({}, { sessionID: "ses-director" })).content,
      );
      assert.equal(result.truncated, true);
      assert.equal(result.sessions.length, 10);
      assert.equal(result.sessions[0].sessionID, "ses-page-9");
      assert.ok(
        logs.some((line) =>
          line.includes("director_sessions: stopped at the 10-page cap"),
        ),
      );
    } finally {
      console.error = originalError;
    }
  } finally {
    await cleanup?.();
  }
});

test("a session object without time.idle enumerates as never having ended a turn", async () => {
  // The pinned opencode shape (2.2.5): the session mapper renders a row's
  // null time_idle as undefined, so a session that has never ended a turn
  // omits time.idle entirely, while created and updated ride along.
  const fixture = fakeContext([
    {
      id: "ses-never-ended",
      agent: "build",
      location: { directory: "/tmp/worktree-never" },
      time: { created: 1734067200000, updated: 1734067201000 },
    },
  ]);
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const tool = fixture.tools.get("director_sessions")!;
    const raw = (await tool.execute({}, { sessionID: "ses-director" })).content;
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.sessions, [
      {
        sessionID: "ses-never-ended",
        directory: "/tmp/worktree-never",
        agent: "build",
        state: "idle",
        lastTurnEnd: null,
      },
    ]);
    // Absence renders as the field present and null — not 1970, not an
    // invented epoch, not a dropped key the caller has to guess around.
    assert.ok(raw.includes('"lastTurnEnd":null'));
    assert.ok(!raw.includes('"lastTurnEnd":0'));
  } finally {
    await cleanup?.();
  }
});

test("a session id listed on two pages of the walk enumerates exactly once", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    fixture.ctx.session.list = async (input?: { cursor?: string }) => {
      const page = input?.cursor === "page-2" ? 1 : 0;
      const listedAgain = {
        id: "ses-dup",
        agent: "build",
        location: { directory: "/tmp/worktree-dup" },
        time: { created: 1, updated: page, idle: page === 0 ? 50 : 10 },
      };
      return {
        data:
          page === 0
            ? [listedAgain]
            : [
                listedAgain,
                {
                  id: "ses-single",
                  agent: "explore",
                  location: { directory: "/tmp/worktree-single" },
                  time: { created: 1, updated: 1, idle: 4 },
                },
              ],
        cursor: page === 0 ? { next: "page-2" } : {},
      };
    };
    const tool = fixture.tools.get("director_sessions")!;
    const result = JSON.parse(
      (await tool.execute({}, { sessionID: "ses-director" })).content,
    );
    // The first sighting stands: the page-2 replay of ses-dup contributes
    // nothing (its newer idle included), and ses-single enumerates beside it.
    assert.deepEqual(result.sessions, [
      {
        sessionID: "ses-dup",
        directory: "/tmp/worktree-dup",
        agent: "build",
        state: "idle",
        lastTurnEnd: 50,
      },
      {
        sessionID: "ses-single",
        directory: "/tmp/worktree-single",
        agent: "explore",
        state: "idle",
        lastTurnEnd: 4,
      },
    ]);
    assert.equal(result.skipped, 0);
  } finally {
    await cleanup?.();
  }
});

test("a provider or turn failure files a turn-not-completed report with the reason and partial text", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;

    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "half an answer",
    });
    await fixture.emit("session.execution.failed", {
      sessionID: worker,
      error: {
        type: "ProviderError",
        message: "the provider route returned 502",
      },
    });

    await waitFor(() => fixture.mails.length === 1);
    // The notice stays fixed; the failure is said in the pulled report.
    assert.ok(fixture.mails[0].text.includes(`session ${worker}`));
    assert.ok(!fixture.mails[0].text.includes("NOT COMPLETED"));
    const pulled = await readReports(fixture, "ses-director");
    const body = pulled.reports[0].body;
    assert.equal(pulled.reports[0].kind, "failed");
    assert.ok(body.includes("turn-not-completed"));
    assert.ok(
      body.includes("reason: ProviderError: the provider route returned 502"),
    );
    assert.ok(body.includes("Treat its outputs as unverified"));
    assert.ok(
      body.includes("half an answer"),
      "the partial text rides the failure report",
    );
    // Failure is never dressed as a success report.
    assert.ok(!body.includes("Worker turn report\n"));
  } finally {
    await cleanup?.();
  }
});

test("an interrupt with no shutdown reason files as turn-not-completed", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.execution.interrupted", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);
    const pulled = await readReports(fixture, "ses-director");
    assert.equal(pulled.reports[0].kind, "failed");
    assert.ok(pulled.reports[0].body.includes("turn-not-completed"));
    assert.ok(
      pulled.reports[0].body.includes("interrupted before it completed"),
    );
  } finally {
    await cleanup?.();
  }
});

test("a turn that ends with no text still answers the director", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await waitFor(() => fixture.mails.length === 1);
    const pulled = await readReports(fixture, "ses-director");
    assert.ok(
      pulled.reports[0].body.includes(
        "(no final text from this turn reached the report)",
      ),
    );
  } finally {
    await cleanup?.();
  }
});

test("steer re-prompts a dispatched worker and reports where mail flows", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const steer = fixture.tools.get("director_steer")!;
    const steered = JSON.parse(
      (
        await steer.execute(
          {
            sessionID: dispatched.sessionID,
            instruction: "check the worktree",
          },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(steered.ok, true);
    assert.equal(steered.turnMail, "ses-director");
    assert.equal(fixture.prompts.at(-1)!.sessionID, dispatched.sessionID);
    assert.equal(fixture.prompts.at(-1)!.text, "check the worktree");

    // An un-stamped session still takes the waking prompt; the result says
    // no mail will flow for it.
    fixture.sessions.set("ses-handmade", {
      id: "ses-handmade",
      title: "somewhere else",
    });
    const foreign = JSON.parse(
      (
        await steer.execute(
          { sessionID: "ses-handmade", instruction: "carry on" },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(foreign.ok, true);
    assert.equal(foreign.turnMail, null);
    assert.match(foreign.note, /no turn report/);

    // A dead target is refused at the tool, not discovered by silence.
    await assert.rejects(
      steer.execute(
        { sessionID: "ses-missing", instruction: "hello?" },
        { sessionID: "ses-director" },
      ),
      /No live session with id ses-missing/,
    );
  } finally {
    await cleanup?.();
  }
});

test("worker_status reads the live session record and names the dispatch stamp", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const status = fixture.tools.get("director_worker_status")!;
    const busy = JSON.parse(
      (
        await status.execute(
          { sessionID: dispatched.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(busy.state, "idle");
    assert.equal(busy.watched, true);
    assert.equal(busy.dispatchedBy, "ses-director");
    assert.equal(busy.directory, "/tmp/worktree-a");

    fixture.sessions.set(dispatched.sessionID, {
      ...dispatched,
      time: { created: 1, updated: 3, busy: 100, idle: 90 },
      outcome: "succeeded",
    });
    const midTurn = JSON.parse(
      (
        await status.execute(
          { sessionID: dispatched.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(midTurn.state, "busy");

    fixture.sessions.set(dispatched.sessionID, {
      ...dispatched,
      time: { created: 1, updated: 3, busy: 100, idle: 110 },
      outcome: "succeeded",
    });
    const idle = JSON.parse(
      (
        await status.execute(
          { sessionID: dispatched.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(idle.state, "idle");
    assert.equal(idle.outcome, "succeeded");

    await assert.rejects(
      status.execute(
        { sessionID: "ses-missing" },
        { sessionID: "ses-director" },
      ),
      /No live session/,
    );
  } finally {
    await cleanup?.();
  }
});

test("a fresh activation adopts stamped workers in its own location lazily, from the stamp", async () => {
  const fixture = fakeContext([], { directory: "/tmp/worktree-old" });
  // Sessions that predate this activation: no dispatch, no created event,
  // and no session.list walk, only the rows session.get serves.
  fixture.sessions.set("ses-pre-existing", {
    id: "ses-pre-existing",
    title: "old slice",
    agent: "build",
    metadata: {
      chancery: { coordinatedBy: "ses-director-reload", slice: "old slice" },
    },
    location: { directory: "/tmp/worktree-old" },
  });
  fixture.sessions.set("ses-elsewhere", {
    id: "ses-elsewhere",
    title: "other location's slice",
    metadata: { chancery: { coordinatedBy: "ses-director-other" } },
    location: { directory: "/tmp/worktree-other" },
  });
  fixture.sessions.set("ses-plain", {
    id: "ses-plain",
    title: "no stamp",
    location: { directory: "/tmp/worktree-old" },
  });
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    await fixture.emit("session.execution.succeeded", {
      sessionID: "ses-pre-existing",
    });
    await waitFor(() => fixture.mails.length === 1);
    assert.equal(fixture.mails[0].sessionID, "ses-director-reload");
    assert.ok(fixture.mails[0].text.includes("session ses-pre-existing"));

    // Another location's worker is that location's activation to deliver,
    // and a session with no stamp is nobody's child.
    await fixture.emit("session.execution.succeeded", {
      sessionID: "ses-elsewhere",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: "ses-plain",
    });
    await settleOnce();
    await settleOnce();
    assert.equal(fixture.mails.length, 1);
  } finally {
    await cleanup?.();
  }
});

test("a deleted session stops delivering mail", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    await fixture.emit("session.deleted", { sessionID: dispatched.sessionID });
    await fixture.emit("session.text.ended", {
      sessionID: dispatched.sessionID,
      text: "late text",
    });
    await fixture.emit("session.execution.succeeded", {
      sessionID: dispatched.sessionID,
    });
    await settleOnce();
    assert.equal(fixture.mails.length, 0);
    assert.equal(storedRows(fixture).length, 0);
  } finally {
    await cleanup?.();
  }
});

test("a throw inside one event handler does not stop later deliveries", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    // Installed after setup returns, inside the try the finally restores
    // from: a throw in setup strands nothing.
    console.error = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));
    const dispatched = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    const worker = dispatched.sessionID;

    // A poisoned payload makes the failed-turn handler itself blow up while
    // reading `error` off the event. Per-event isolation answers with a
    // logged failure and a pump that keeps running.
    await fixture.emit("session.execution.failed", {
      sessionID: worker,
      get error(): unknown {
        throw new Error("payload poisoned");
      },
    });
    await waitFor(() =>
      logs.some((line) => line.includes("event handler failed")),
    );
    assert.equal(fixture.mails.length, 0);

    // The pump survived the dead handler: the next turn's report lands.
    await fixture.emit("session.execution.started", { sessionID: worker });
    await fixture.emit("session.text.ended", {
      sessionID: worker,
      text: "next turn",
    });
    await fixture.emit("session.execution.succeeded", { sessionID: worker });
    await waitFor(() => fixture.mails.length === 1);
    const pulled = await readReports(fixture, "ses-director");
    assert.ok(pulled.reports[0].body.includes("next turn"));
    assert.ok(logs.some((line) => line.includes("session.execution.failed")));
  } finally {
    console.error = originalError;
    await cleanup?.();
  }
});

test("a dispatch failure names the steps it completed and any session it created", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    // The fake host answers create requests only for directories it knows;
    // anything else throws beneath the tool, which must wrap the failure
    // with what it reached.
    fixture.ctx.session.create = async (input: {
      location?: { directory: string };
    }) => {
      if (input.location?.directory !== "known-directory") {
        throw new Error("Location not found");
      }
      const row: SessionRow = {
        id: "ses-known",
        location: { directory: "known-directory" },
      };
      fixture.sessions.set(row.id, row);
      return row;
    };
    fixture.ctx.session.prompt = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses-known") {
        throw new Error("prompt refused");
      }
      fixture.prompts.push(input);
      return { id: "msg" };
    };
    const dispatch = fixture.tools.get("director_dispatch")!;

    await assert.rejects(
      dispatch.execute(
        { directory: "unknown-directory", brief: "brief text" },
        { sessionID: "ses-director" },
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /director_dispatch failed: Location not found\. Completed steps: none\./,
        );
        assert.match(error.message, /No session was created/);
        return true;
      },
    );

    await assert.rejects(
      dispatch.execute(
        { directory: "known-directory", brief: "brief text" },
        { sessionID: "ses-director" },
      ),
      (error: Error) => {
        assert.match(error.message, /director_dispatch failed: prompt refused/);
        assert.match(
          error.message,
          /created session ses-known in known-directory \(agent build\)/,
        );
        assert.match(
          error.message,
          /The session ses-known exists and is watched/,
        );
        return true;
      },
    );
  } finally {
    await cleanup?.();
  }
});

test("a pinned dispatch switches the model between create and the waking prompt", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const result = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
      model: "example-proxy/auto/example-model",
    });
    assert.equal(result.ok, true);
    assert.equal(result.model, "example-proxy/auto/example-model");
    // The pin lands as a parsed provider/model ref, after the create+stamp
    // and before the waking prompt.
    assert.deepEqual(fixture.order, ["create", "switchModel", "prompt"]);
    assert.equal(fixture.switched[0].sessionID, result.sessionID);
    assert.deepEqual(fixture.switched[0].model, {
      providerID: "example-proxy",
      id: "auto/example-model",
    });
    // The dispatch stamp carries the pin exactly as given.
    assert.equal(
      fixture.created[0].metadata.chancery.model,
      "example-proxy/auto/example-model",
    );
  } finally {
    await cleanup?.();
  }
});

test("a malformed model pin is refused at the tool boundary, creating nothing", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const dispatch = fixture.tools.get("director_dispatch")!;
    // Empty/whitespace and no-provider-prefix inputs are refused outright;
    // the empty-variant, double-variant, and variant-in-provider cases are
    // the schema grammar's own rejects, mirrored.
    for (const model of [
      "no-separator",
      "example-proxy/",
      "/example-model",
      "example-proxy/example-model#",
      "example-proxy/example-model#high#extra",
      "llm#high/example-model",
      "",
      "   ",
    ]) {
      await assert.rejects(
        dispatch.execute(
          { directory: "/tmp/worktree-a", brief: "do the slice work", model },
          { sessionID: "ses-director" },
        ),
        (error: Error) => {
          assert.ok(error.message, "the refusal carries a message");
          assert.match(error.message, /^director_dispatch: model /);
          assert.match(error.message, /must be an opencode model reference/);
          assert.match(error.message, /may carry slashes and colons/);
          assert.match(
            error.message,
            /"example-proxy\/auto\/example-model", "kilo\/baidu\/ernie-5\.5-preview:free"/,
          );
          return true;
        },
      );
    }
    assert.equal(fixture.created.length, 0);
    assert.equal(fixture.switched.length, 0);
    assert.equal(fixture.prompts.length, 0);
  } finally {
    await cleanup?.();
  }
});

test("a failing model switch surfaces as a dispatch failure with no waking prompt", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    fixture.ctx.session.switchModel = async () => {
      throw new Error("model not available");
    };
    const dispatch = fixture.tools.get("director_dispatch")!;
    await assert.rejects(
      dispatch.execute(
        {
          directory: "/tmp/worktree-a",
          brief: "do the slice work",
          model: "example-proxy/auto/example-model",
        },
        { sessionID: "ses-director" },
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /^director_dispatch failed: model not available\./,
        );
        assert.match(error.message, /created session ses-worker-1 /);
        assert.match(
          error.message,
          /The session ses-worker-1 exists and is watched/,
        );
        assert.match(
          error.message,
          /The model pin "example-proxy\/auto\/example-model" did not resolve; the waking prompt was not delivered\./,
        );
        return true;
      },
    );
    // The brief never fires on an unresolved pin — that is the accident
    // the pin exists to prevent.
    assert.equal(fixture.prompts.length, 0);
  } finally {
    await cleanup?.();
  }
});

test("a dispatch without model keeps exactly today's shape", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const result = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
    });
    assert.equal(fixture.switched.length, 0);
    assert.deepEqual(fixture.order, ["create", "prompt"]);
    // No pin anywhere: not in the result, not in the stamp.
    assert.equal("model" in result, false);
    assert.equal("model" in fixture.created[0].metadata.chancery, false);
    assert.equal(fixture.prompts[0].text, "do the slice work");
  } finally {
    await cleanup?.();
  }
});

test("a shaped model id parses cleanly: multi-slash provider chains and colon ids", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const result = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
      model: "kilo/baidu/ernie-5.5-preview:free",
    });
    assert.equal(result.ok, true);
    // Everything after the first "/" is the model id, exactly as
    // Model.Ref.parse reads it.
    assert.deepEqual(fixture.switched[0].model, {
      providerID: "kilo",
      id: "baidu/ernie-5.5-preview:free",
    });
    assert.equal(fixture.switched[0].sessionID, result.sessionID);
    assert.equal(result.model, "kilo/baidu/ernie-5.5-preview:free");
    assert.equal(
      fixture.created[0].metadata.chancery.model,
      "kilo/baidu/ernie-5.5-preview:free",
    );
  } finally {
    await cleanup?.();
  }
});

test("a variant pin parses and pins through switchModel with the variant", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const result = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
      model: "example-proxy/auto/example-model#high",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.order, ["create", "switchModel", "prompt"]);
    assert.deepEqual(fixture.switched[0].model, {
      providerID: "example-proxy",
      id: "auto/example-model",
      variant: "high",
    });
    // Pin, stamp, and status all speak the full reference.
    assert.equal(result.model, "example-proxy/auto/example-model#high");
    assert.equal(
      fixture.created[0].metadata.chancery.model,
      "example-proxy/auto/example-model#high",
    );
    const status = fixture.tools.get("director_worker_status")!;
    const row = JSON.parse(
      (
        await status.execute(
          { sessionID: result.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(row.model, "example-proxy/auto/example-model#high");
  } finally {
    await cleanup?.();
  }
});

test("worker_status records the dispatched pin, and a re-adopted worker's pin rides the stamp", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const pinned = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-a",
      brief: "do the slice work",
      model: "example-proxy/auto/example-model",
    });
    const plain = await dispatchWorker(fixture, {
      directory: "/tmp/worktree-b",
      brief: "plain slice",
    });
    const status = fixture.tools.get("director_worker_status")!;
    const pinnedRow = JSON.parse(
      (
        await status.execute(
          { sessionID: pinned.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(pinnedRow.model, "example-proxy/auto/example-model");
    const plainRow = JSON.parse(
      (
        await status.execute(
          { sessionID: plain.sessionID },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(plainRow.model, null);
  } finally {
    await cleanup?.();
  }

  // Re-adoption legibility: the stamp carries the pin, so a session this
  // activation never dispatched reports it even though the host row
  // carries no model.
  const reloaded = fakeContext();
  reloaded.sessions.set("ses-stamped", {
    id: "ses-stamped",
    title: "earlier slice",
    agent: "build",
    metadata: {
      chancery: {
        coordinatedBy: "ses-director",
        model: "example-proxy/auto/example-model",
      },
    },
    location: { directory: "/tmp/worktree-old" },
  });
  const reloadedClean = await plugin.setup(reloaded.ctx);
  try {
    const status = reloaded.tools.get("director_worker_status")!;
    const row = JSON.parse(
      (
        await status.execute(
          { sessionID: "ses-stamped" },
          { sessionID: "ses-director" },
        )
      ).content,
    );
    assert.equal(row.model, "example-proxy/auto/example-model");
  } finally {
    await reloadedClean?.();
  }
});

// PRJ-444: worktree lifecycle. The tools run real `git worktree` against
// real repositories, so this section seeds throwaway repos under the OS
// tmpdir — init, config, one commit on main — and drives the three tools
// through their round-trips and refusals over the same fake host the module
// suite uses above. The imports these tests need ride the file's header.

const execFile = promisify(execFileCallback);

async function gitIn(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new Error(
      `git ${args.join(" ")} in ${cwd}: ${
        failure.stderr?.trim() || failure.message
      }`,
    );
  }
}

// A throwaway repository with one commit on main, nested inside its own
// per-test root: the worktrees the tests add live BESIDE the repo (the
// module's worktree_add refuses a path inside a repo), so the root is the
// per-test dir and the siblings are unique per test and per run — a
// leftover from yesterday's run cannot collide with today's. The roots
// go away whole when the file's tests end.
const repoRoots: string[] = [];
after(() => {
  for (const root of repoRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});
async function seedRepo(): Promise<string> {
  // The root is spelled as the filesystem really spells it (realpath):
  // git normalizes symlinked components (/var/folders → /private/var/folders
  // on darwin), so the rows the tools record and the paths the tests
  // assert against must agree in spelling with git's own answers.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "director-worktree-")));
  repoRoots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  await gitIn(repo, ["init", "-q", "-b", "main", "."]);
  await gitIn(repo, ["config", "user.email", "test@example.com"]);
  await gitIn(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "file.txt"), "one\n");
  await gitIn(repo, ["add", "."]);
  await gitIn(repo, ["commit", "-qm", "one"]);
  return repo;
}

// Worktrees live beside their repo, not inside it; the repo is nested
// inside its per-test root, so the sibling lands in the root — unique
// per test and per run, and removed with it.
const sibling = (repo: string, name: string) => join(repo, "..", name);

function trackedWorktrees(shared: { kv: Map<string, unknown> }) {
  return [...shared.kv.entries()]
    .filter(([key]) => key.startsWith("worktree/"))
    .map(([key, value]) => ({ key, row: value as Record<string, any> }));
}

async function runTool(
  fixture: ReturnType<typeof fakeContext>,
  name: string,
  input: Record<string, unknown>,
  caller = "ses-director",
) {
  const tool = fixture.tools.get(name)!;
  return JSON.parse((await tool.execute(input, { sessionID: caller })).content);
}

test("worktree_add creates the worktree on a new branch at the base and tracks it", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-a");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      const head = await gitIn(repo, ["rev-parse", "HEAD"]);
      const added = await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/x",
        base: "main",
      });
      assert.equal(added.ok, true);
      assert.equal(added.branch, "feat/x");
      assert.equal(added.head, head);
      assert.equal(added.base, "main");
      assert.equal(added.repo, repo);
      // The worktree really exists, on the branch, at the base.
      assert.equal(
        await gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "feat/x",
      );
      assert.equal(await gitIn(path, ["rev-parse", "HEAD"]), head);
      // The row carries the module's claims.
      const rows = trackedWorktrees(fixture);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].row.path, path);
      assert.equal(rows[0].row.repo, repo);
      assert.equal(rows[0].row.owner, "ses-director");
      assert.equal(rows[0].row.session, null);
      assert.equal(rows[0].row.baseCommit, head);
      assert.equal(typeof rows[0].row.createdAt, "number");
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_add checks out an existing branch, and a named base must be exactly its tip", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-e");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await gitIn(repo, ["branch", "feat/e", "main"]);
      const head = await gitIn(repo, ["rev-parse", "HEAD"]);
      // The branch exists: it is checked out, base omitted.
      const added = await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/e",
      });
      assert.equal(added.branch, "feat/e");
      assert.equal(added.head, head);
      assert.equal(
        await gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "feat/e",
      );

      // main moves on; a fresh existing branch sits exactly at its tip:
      // base matches and the add goes through.
      writeFileSync(join(repo, "file.txt"), "two\n");
      await gitIn(repo, ["add", "."]);
      await gitIn(repo, ["commit", "-qm", "two"]);
      await gitIn(repo, ["branch", "feat/e2", "main"]);
      const path2 = sibling(repo, "wt-e2");
      const matched = await runTool(fixture, "worktree_add", {
        path: path2,
        branch: "feat/e2",
        base: "main",
      });
      assert.equal(matched.ok, true);

      // main moves on again: the same call now refuses, naming both
      // sides — feat/e2 is one commit behind main.
      writeFileSync(join(repo, "file.txt"), "three\n");
      await gitIn(repo, ["add", "."]);
      await gitIn(repo, ["commit", "-qm", "three"]);
      const staleHead = await gitIn(repo, ["rev-parse", "feat/e2"]);
      const mainHead = await gitIn(repo, ["rev-parse", "HEAD"]);
      const path3 = sibling(repo, "wt-e3");
      await assert.rejects(
        runTool(fixture, "worktree_add", {
          path: path3,
          branch: "feat/e2",
          base: "main",
        }),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(
              `worktree_add failed: branch feat\\/e2 is at ${staleHead}, not at main \\(${mainHead}\\)`,
            ),
          );
          assert.match(
            error.message,
            /Completed steps: resolved the repository at .+; branch feat\/e2 exists; checking it out\./,
          );
          return true;
        },
      );
      assert.equal(trackedWorktrees(fixture).length, 2);
      assert.ok(!existsSync(path3));
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_add failures are named with the steps completed, and track nothing", async () => {
  const repo = await seedRepo();
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      // A base that does not resolve refuses before anything runs.
      await assert.rejects(
        runTool(fixture, "worktree_add", {
          path: sibling(repo, "wt-f"),
          branch: "feat/f",
          base: "nosuch-ref",
        }),
        (error: Error) => {
          assert.match(
            error.message,
            /worktree_add failed: git rev-parse --verify nosuch-ref\^\{commit\} in/,
          );
          assert.match(error.message, /fatal:/);
          assert.match(
            error.message,
            /Completed steps: resolved the repository at/,
          );
          return true;
        },
      );
      assert.equal(trackedWorktrees(fixture).length, 0);

      // No repo input falls to the session's directory, which is not a
      // repository here: the failure names what ran.
      const empty = mkdtempSync(join(tmpdir(), "director-empty-"));
      try {
        const emptyFixture = fakeContext([], { directory: empty });
        const emptyCleanup = await plugin.setup(emptyFixture.ctx);
        try {
          await assert.rejects(
            runTool(emptyFixture, "worktree_add", {
              path: sibling(repo, "wt-g"),
              branch: "feat/g",
            }),
            (error: Error) => {
              assert.match(
                error.message,
                /worktree_add failed: git rev-parse --git-dir/,
              );
              assert.match(error.message, /not a git repository/);
              assert.match(error.message, /Completed steps: none\./);
              return true;
            },
          );
        } finally {
          await emptyCleanup?.();
        }
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_list reports the live state: fresh, then behind main, then carrying its own work", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-b");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/y",
        base: "main",
      });
      const fresh = await runTool(fixture, "worktree_list", {});
      assert.equal(fresh.ok, true);
      assert.equal(fresh.count, 1);
      const row = fresh.worktrees[0];
      assert.equal(row.state, "live");
      assert.equal(row.branch, "feat/y");
      assert.equal(row.upToDate, true);
      assert.equal(row.dirty, false);
      // The branch sits exactly at main: merged in the ancestor sense.
      assert.equal(row.merged, true);
      assert.equal(row.stale, false);
      assert.equal(row.owner, "ses-director");
      assert.equal(row.session, null);

      // main moves on: the worktree's head falls behind the base —
      // stale, and its landed branch is merged.
      writeFileSync(join(repo, "file.txt"), "two\n");
      await gitIn(repo, ["add", "."]);
      await gitIn(repo, ["commit", "-qm", "two"]);
      const behind = await runTool(fixture, "worktree_list", {});
      assert.equal(behind.worktrees[0].upToDate, false);
      assert.equal(behind.worktrees[0].stale, true);
      assert.equal(behind.worktrees[0].merged, true);

      // The branch grows unlanded work: neither at the base nor merged.
      writeFileSync(join(path, "feature.txt"), "work\n");
      await gitIn(path, ["add", "."]);
      await gitIn(path, ["commit", "-qm", "feature work"]);
      const ahead = await runTool(fixture, "worktree_list", {});
      assert.equal(ahead.worktrees[0].upToDate, false);
      assert.equal(ahead.worktrees[0].stale, false);
      assert.equal(ahead.worktrees[0].merged, false);
      // Committed, so the tree is clean again.
      assert.equal(ahead.worktrees[0].dirty, false);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_list carries dirty, missing, and baseless rows honestly", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-c");
  const bare = sibling(repo, "wt-c2");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      // A baseless add: the lifecycle questions a base grounds stay null.
      await runTool(fixture, "worktree_add", { path, branch: "feat/c" });
      // A dirty tree.
      await runTool(fixture, "worktree_add", {
        path: bare,
        branch: "feat/c2",
        base: "main",
      });
      writeFileSync(join(bare, "uncommitted.txt"), "dirty\n");
      const listed = await runTool(fixture, "worktree_list", {});
      assert.equal(listed.count, 2);
      const baseless = listed.worktrees.find(
        (row: { path: string }) => row.path === path,
      );
      assert.equal(baseless.base, null);
      assert.equal(baseless.upToDate, null);
      assert.equal(baseless.merged, null);
      assert.equal(baseless.stale, null);
      assert.equal(baseless.dirty, false);
      const dirty = listed.worktrees.find(
        (row: { path: string }) => row.path === bare,
      );
      assert.equal(dirty.dirty, true);
      assert.equal(dirty.upToDate, true);

      // The repo disappears from under a row: the row renders missing
      // with an error named, and the read does not fail wholesale.
      const vanish = sibling(repo, "wt-c3");
      await runTool(fixture, "worktree_add", {
        path: vanish,
        branch: "feat/c3",
        base: "main",
      });
      const rows = trackedWorktrees(fixture);
      const vanishRow = rows.find((found) => found.row.path === vanish)!;
      vanishRow.row.repo = join(repo, "gone");
      await fixture.ctx.storage.set(vanishRow.key, vanishRow.row);
      const after = await runTool(fixture, "worktree_list", {});
      const missing = after.worktrees.find(
        (row: { path: string }) => row.path === vanish,
      );
      assert.equal(missing.state, "missing");
      assert.equal(missing.head, null);
      assert.match(
        missing.error,
        /no worktree at|cannot change to|not a git repository|ENOENT/,
      );
      // The other rows still render.
      assert.equal(after.count, 3);
      assert.equal(
        after.worktrees.filter((row: { state: string }) => row.state === "live")
          .length,
        2,
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove takes a clean tracked worktree down and drops its row", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-d");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/z",
        base: "main",
      });
      const removed = await runTool(fixture, "worktree_remove", { path });
      assert.equal(removed.ok, true);
      assert.equal(removed.removed, path);
      assert.equal(removed.branch, "feat/z");
      assert.equal(removed.liveSessionCheck, "list");
      // The worktree is gone from disk and from the tracked set; the
      // branch survives in the repo.
      assert.ok(!existsSync(path));
      assert.equal((await runTool(fixture, "worktree_list", {})).count, 0);
      assert.equal(trackedWorktrees(fixture).length, 0);
      assert.ok(
        (await gitIn(repo, ["branch", "--list", "feat/z"])).includes("feat/z"),
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove refuses uncommitted work named, and the row survives", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-h");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/h",
        base: "main",
      });
      writeFileSync(join(path, "dirty.txt"), "uncommitted\n");
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path }),
        (error: Error) => {
          assert.match(error.message, /carries uncommitted work/);
          assert.match(error.message, /removal never discards silently/);
          return true;
        },
      );
      assert.equal(trackedWorktrees(fixture).length, 1);
      assert.ok(existsSync(path));

      // Committed: the same call now removes.
      await gitIn(path, ["add", "."]);
      await gitIn(path, ["commit", "-qm", "the dirty work"]);
      const removed = await runTool(fixture, "worktree_remove", { path });
      assert.equal(removed.ok, true);
      assert.equal(trackedWorktrees(fixture).length, 0);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove refuses a live owning session, and lets go once its turn has ended", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-i");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/i",
        base: "main",
      });
      // The dispatch binds the worker session to the row and validates
      // the worktree at the call.
      const dispatched = await dispatchWorker(fixture, {
        directory: path,
        brief: "do the slice work",
        base: "main",
      });
      // The host's session.list serves the same rows session.get does:
      // the fake mirrors that from the sessions map, so the check sees
      // the dispatched worker.
      fixture.ctx.session.list = async () => ({
        data: [...fixture.sessions.values()].map((row) => structuredClone(row)),
        cursor: {},
      });
      // A fresh dispatch has ended no turn: removal refuses, naming the
      // session and the waiting-on-first-turn state.
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path }),
        (error: Error) => {
          assert.match(error.message, /live session/);
          assert.match(
            error.message,
            new RegExp(
              `${dispatched.sessionID} \\(idle, never ended a turn\\)`,
            ),
          );
          assert.match(error.message, /never drops a worktree out from under/);
          return true;
        },
      );
      assert.equal(trackedWorktrees(fixture).length, 1);

      // The turn ends: the same call removes.
      fixture.sessions.set(dispatched.sessionID, {
        ...fixture.sessions.get(dispatched.sessionID)!,
        time: { created: 1, updated: 5, busy: 100, idle: 110 },
      });
      const removed = await runTool(fixture, "worktree_remove", { path });
      assert.equal(removed.ok, true);
      assert.equal(removed.liveSessionCheck, "list");
      assert.equal(trackedWorktrees(fixture).length, 0);

      // A session merely idling in the path does not block, but a busy
      // one does: the check is over every session the host lists.
      const late = await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/i",
        base: "main",
      });
      assert.equal(late.ok, true);
      fixture.sessions.set("ses-loiterer", {
        id: "ses-loiterer",
        agent: "build",
        location: { directory: path },
        time: { created: 1, updated: 5, busy: 90, idle: 100 },
      });
      fixture.sessions.set("ses-sprinter", {
        id: "ses-sprinter",
        agent: "build",
        location: { directory: path },
        time: { created: 1, updated: 9, busy: 120, idle: 110 },
      });
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path }),
        (error: Error) => {
          assert.match(error.message, /ses-sprinter \(busy\)/);
          assert.ok(!error.message.includes("ses-loiterer"));
          return true;
        },
      );
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove without a session.list checks the tracked session instead, and says so", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-j");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/j",
        base: "main",
      });
      const dispatched = await dispatchWorker(fixture, {
        directory: path,
        brief: "do the slice work",
        base: "main",
      });
      // No enumeration surface on this host: the check falls back to the
      // row's tracked session.
      delete fixture.ctx.session.list;
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path }),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(
              `${dispatched.sessionID} \\(idle, never ended a turn\\)`,
            ),
          );
          return true;
        },
      );
      fixture.sessions.set(dispatched.sessionID, {
        ...fixture.sessions.get(dispatched.sessionID)!,
        time: { created: 1, updated: 5, busy: 100, idle: 110 },
      });
      const removed = await runTool(fixture, "worktree_remove", { path });
      assert.equal(removed.ok, true);
      assert.equal(removed.liveSessionCheck, "tracked");
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove refuses when the live-session walk truncates: a partial check is no check", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-t");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/t",
        base: "main",
      });
      // A list that always serves a cursor: the walk hits its cap with
      // sessions unseen, and removal refuses named — nothing was removed.
      fixture.ctx.session.list = async () => ({
        data: [],
        cursor: { next: "cursor-never-ends" },
      });
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path }),
        (error: Error) => {
          assert.match(error.message, /live-session walk hit its 10-page cap/);
          assert.match(error.message, /check is incomplete/);
          return true;
        },
      );
      assert.equal(trackedWorktrees(fixture).length, 1);
      assert.ok(existsSync(path));
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree_remove refuses an untracked path, and prunes a row whose worktree is already gone", async () => {
  const repo = await seedRepo();
  const raw = sibling(repo, "wt-raw");
  const path = sibling(repo, "wt-k");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      // A worktree the module did not create or adopt: refused, the claims
      // it would need do not exist.
      await gitIn(repo, ["worktree", "add", "--detach", raw, "main"]);
      await assert.rejects(
        runTool(fixture, "worktree_remove", { path: raw }),
        (error: Error) => {
          assert.match(error.message, /no tracked worktree at/);
          assert.match(error.message, /removes only what it tracks/);
          return true;
        },
      );

      // A tracked worktree removed behind the module's back: the row prunes
      // instead of removing.
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/k",
        base: "main",
      });
      await gitIn(repo, ["worktree", "remove", path]);
      const pruned = await runTool(fixture, "worktree_remove", { path });
      assert.equal(pruned.ok, true);
      assert.equal(pruned.pruned, path);
      assert.match(pruned.note, /stale tracking row was dropped/);
      assert.equal(trackedWorktrees(fixture).length, 0);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a dispatch naming a base passes when the worktree is on a branch at that base, and records the worker", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-l");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/l",
        base: "main",
      });
      const head = await gitIn(repo, ["rev-parse", "HEAD"]);
      const dispatched = await dispatchWorker(fixture, {
        directory: path,
        brief: "do the slice work",
        base: "main",
      });
      // The dispatch record carries the worktree it validated.
      assert.equal(dispatched.worktree.path, path);
      assert.equal(dispatched.worktree.branch, "feat/l");
      assert.equal(dispatched.worktree.head, head);
      assert.equal(dispatched.worktree.base, "main");
      assert.equal(dispatched.worktree.baseCommit, head);
      // The store answers which session owns the worktree.
      const rows = trackedWorktrees(fixture);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].row.session, dispatched.sessionID);
      assert.equal(rows[0].row.owner, "ses-director");
      // The brief went out as usual.
      assert.equal(fixture.prompts[0].text, "do the slice work");
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a stale HEAD refuses the dispatch at the call with both commits named, and creates nothing", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-m");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/m",
        base: "main",
      });
      // main moves on; the worktree stays behind.
      writeFileSync(join(repo, "file.txt"), "two\n");
      await gitIn(repo, ["add", "."]);
      await gitIn(repo, ["commit", "-qm", "two"]);
      const staleHead = await gitIn(path, ["rev-parse", "HEAD"]);
      const mainHead = await gitIn(repo, ["rev-parse", "HEAD"]);
      await assert.rejects(
        dispatchWorker(fixture, {
          directory: path,
          brief: "do the slice work",
          base: "main",
        }),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(
              `worktree ${path.replace(/\//g, "\\/")} \\(branch feat\\/m\\) HEAD ${staleHead} is not at main \\(${mainHead}\\)`,
            ),
          );
          return true;
        },
      );
      // Nothing was created and the brief never went out.
      assert.equal(fixture.created.length, 0);
      assert.equal(fixture.prompts.length, 0);
      // The row is untouched by the refused dispatch.
      const rows = trackedWorktrees(fixture);
      assert.equal(rows[0].row.session, null);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a detached HEAD refuses the dispatch named, even when it sits exactly at the base", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-n");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/n",
        base: "main",
      });
      // Detach at the base commit itself: still a refusal, because
      // dispatches land on a branch.
      await gitIn(path, ["checkout", "-q", "--detach", "HEAD"]);
      const detachedHead = await gitIn(path, ["rev-parse", "HEAD"]);
      await assert.rejects(
        dispatchWorker(fixture, {
          directory: path,
          brief: "do the slice work",
          base: "main",
        }),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(
              `worktree ${path.replace(/\//g, "\\/")} has a detached HEAD at ${detachedHead}`,
            ),
          );
          assert.match(error.message, /dispatches land on a branch/);
          return true;
        },
      );
      assert.equal(fixture.created.length, 0);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unresolvable base, a non-git directory, and an omitted base each behave as named", async () => {
  const repo = await seedRepo();
  const path = sibling(repo, "wt-o");
  try {
    const fixture = fakeContext([], { directory: repo });
    const cleanup = await plugin.setup(fixture.ctx);
    try {
      await runTool(fixture, "worktree_add", {
        path,
        branch: "feat/o",
        base: "main",
      });
      // A base that does not resolve in the worktree's repo refuses
      // named, nothing created.
      await assert.rejects(
        dispatchWorker(fixture, {
          directory: path,
          brief: "do the slice work",
          base: "nosuch-ref",
        }),
        (error: Error) => {
          assert.match(error.message, /base nosuch-ref does not resolve in/);
          return true;
        },
      );
      assert.equal(fixture.created.length, 0);

      // A directory that is not a readable git worktree refuses at the
      // call, before any session exists.
      const notARepo = join(repo, "nonexistent");
      await assert.rejects(
        dispatchWorker(fixture, {
          directory: notARepo,
          brief: "do the slice work",
          base: "main",
        }),
        (error: Error) => {
          assert.match(error.message, /cannot validate the worktree at/);
          assert.match(error.message, /against base main/);
          return true;
        },
      );
      assert.equal(fixture.created.length, 0);

      // An empty-string base is refused outright.
      await assert.rejects(
        dispatchWorker(fixture, {
          directory: path,
          brief: "do the slice work",
          base: "   ",
        }),
        /base, when given, must be a ref or a sha/,
      );

      // Omitted base: today's shape — no validation, no tracking row,
      // no worktree record in the result.
      const plain = await dispatchWorker(fixture, {
        directory: path,
        brief: "do the slice work",
      });
      assert.equal("worktree" in plain, false);
      assert.equal(fixture.created.length, 1);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The guidance registration: the plugin reads its agent definition, the
// three orchestration skills, and the two commands from the files that
// ride the package beside the module. It registers them through the
// host's agent, skill, and command domains at setup. The files below
// resolve beside the module, exactly as setup resolves them, so these
// tests read the shipped bytes.

test("setup registers the director agent from the shipped definition file", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const agent = fixture.agents.get("director");
    assert.ok(agent, "the director agent was registered");
    // The file's own fields, mapped onto the host's Agent.Info shape.
    assert.equal(
      agent.description,
      "Project coordinator: drives the orchestration loop for objectives handed to this session",
    );
    assert.equal(agent.mode, "primary");
    assert.equal(agent.request.body.temperature, 0.2);
    assert.ok(
      agent.system.includes("You are the user's director"),
      "the file's body rides as the system prompt",
    );
    // The permission map, migrated action names included: task is the v2
    // subagent action and bash is shell.
    const rules = agent.permissions;
    const find = (action: string, resource: string) =>
      rules.find(
        (rule: { action: string; resource: string }) =>
          rule.action === action && rule.resource === resource,
      );
    assert.equal(find("subagent", "*")?.effect, "deny");
    assert.equal(find("subagent", "implementer")?.effect, "allow");
    assert.equal(find("edit", "*")?.effect, "deny");
    assert.equal(find("edit", "*.md")?.effect, "allow");
    assert.equal(find("opencode_session_move", "*")?.effect, "deny");
    assert.equal(find("shell", "*")?.effect, "ask");
    assert.equal(find("shell", "git status*")?.effect, "allow");
    // The host's default rules ride ahead of the shipped ones; the
    // last-match rule evaluation gives the shipped ones precedence.
    assert.deepEqual(rules[0], {
      action: "*",
      resource: "*",
      effect: "allow",
    });
  } finally {
    await cleanup?.();
  }
});

test("setup registers exactly the three orchestration skills from the shipped files", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    assert.deepEqual(
      fixture.skills.map((skill: { id: string }) => skill.id).sort(),
      ["dispatch-worker", "orchestrate", "steer-worker"],
    );
    const orchestrate = fixture.skills.find(
      (skill: { id: string }) => skill.id === "orchestrate",
    );
    assert.equal(orchestrate.name, "orchestrate");
    // The folded description reads as one continuous string, the way the
    // host's own YAML fold renders it.
    assert.ok(
      orchestrate.description.startsWith("The coordinator's operating loop"),
    );
    assert.ok(!orchestrate.description!.includes("\n"));
    // The content is the body only: no frontmatter, no client marker.
    assert.ok(orchestrate.content.startsWith("# Orchestrate"));
    assert.ok(!orchestrate.content.includes("@clientBlock@"));
    assert.ok(
      orchestrate.path.endsWith(join("skills", "orchestrate", "SKILL.md")),
    );
    for (const skill of fixture.skills) {
      assert.ok(
        skill.path.startsWith("/"),
        `skill path is absolute: ${skill.path}`,
      );
      assert.ok(skill.content.length > 0, `${skill.id} carries content`);
    }
  } finally {
    await cleanup?.();
  }
});

test("setup registers the two commands; drive-project retargets the session at the director", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    assert.deepEqual(
      fixture.commands.map((command: { name: string }) => command.name).sort(),
      ["drive-project", "status-report"],
    );
    const drive = fixture.commands.find(
      (command: { name: string }) => command.name === "drive-project",
    )!;
    assert.equal(
      drive.description,
      "Re-wake the director session and continue via its orchestration loop",
    );
    await drive.execute({
      sessionID: "ses-caller",
      prompt: { text: "finish the export feature" },
      delivery: "queue",
    });
    // The frontmatter's agent field first, then the template with every
    // $ARGUMENTS placeholder filled.
    assert.deepEqual(fixture.switchedAgents, [
      { sessionID: "ses-caller", agent: "director" },
    ]);
    assert.equal(fixture.prompts.length, 1);
    assert.equal(fixture.prompts[0].sessionID, "ses-caller");
    assert.equal(fixture.prompts[0].delivery, "queue");
    assert.ok(
      fixture.prompts[0].text.startsWith("Re-wake or continue the director"),
    );
    assert.ok(fixture.prompts[0].text.includes("finish the export feature"));
    assert.ok(!fixture.prompts[0].text.includes("$ARGUMENTS"));

    // status-report carries no agent field: no switch, a plain prompt.
    const report = fixture.commands.find(
      (command: { name: string }) => command.name === "status-report",
    )!;
    assert.ok(report.description!.startsWith("Produce a lane status report"));
    await report.execute({
      sessionID: "ses-caller",
      prompt: { text: "" },
    });
    assert.equal(fixture.switchedAgents.length, 1);
    assert.equal(fixture.prompts.length, 2);
    assert.ok(fixture.prompts[1].text.startsWith("Produce a self-contained"));
    assert.ok(fixture.prompts[1].text.includes("Arguments:"));
    // A missing delivery rides as its absence, not as an invented value.
    assert.equal("delivery" in fixture.prompts[1], false);
  } finally {
    await cleanup?.();
  }
});

test("the debug switch rides the plugin options, not the environment", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    const fixture = fakeContext([], { pluginOptions: { logLevel: "debug" } });
    const cleanup = await plugin.setup(fixture.ctx);
    await cleanup?.();
    assert.ok(
      lines.some((line) => line.includes("op=agent.registered")),
      `the debug log carries the registration spans: ${lines.join("\n")}`,
    );

    // Without options (the discovered plugin's shape) the same setup is
    // silent.
    lines.length = 0;
    const quiet = fakeContext();
    const quietCleanup = await plugin.setup(quiet.ctx);
    await quietCleanup?.();
    assert.deepEqual(lines, []);
  } finally {
    console.error = originalError;
  }
});

test("the frontmatter parser and the loaders reject malformed files named", () => {
  const readShipped = (...parts: string[]) =>
    readFileSync(join(import.meta.dirname, "..", ...parts), "utf8");

  // The shipped files parse, so the strict grammar below is the one they
  // actually use.
  const agent = loadAgentDefinition(readShipped("agent", "director.md"));
  assert.equal(agent.mode, "primary");
  const skill = loadSkillDefinition(
    readShipped("skills", "steer-worker", "SKILL.md"),
  );
  assert.equal(skill.name, "steer-worker");

  assert.throws(() => parseFrontmatter("no fence here\n"), FrontmatterError);
  assert.throws(() => parseFrontmatter("---\nkey: value\n"), FrontmatterError);
  assert.throws(
    () => loadAgentDefinition("---\ndescription: x\nsurprise: 1\n---\nbody"),
    /unknown agent frontmatter fields: surprise/,
  );
  assert.throws(
    () => loadAgentDefinition("---\ndescription: 4\n---\nbody"),
    /description must be a string/,
  );
  assert.throws(
    () => loadAgentDefinition("---\nmode: 42\n---\nbody"),
    /mode must be a string/,
  );
  assert.throws(
    () => loadAgentDefinition("---\nmode: sideways\n---\nbody"),
    /unknown agent mode/,
  );
  assert.throws(
    () =>
      loadAgentDefinition(
        '---\npermission:\n  task:\n    "*": sideways\n---\nbody',
      ),
    /unknown permission effect/,
  );
  assert.throws(
    () => loadSkillDefinition("---\nname: x\nextra: y\n---\nbody"),
    /unknown skill frontmatter fields: extra/,
  );
  assert.throws(
    () => loadSkillDefinition("---\nname: x\ndescription: 4\n---\nbody"),
    /description must be a string/,
  );
  assert.throws(
    () => loadCommandDefinition("x.md", "---\nagent: 42\n---\nbody"),
    /x\.md: agent must be a string/,
  );
  assert.throws(
    () =>
      loadCommandDefinition("x.md", "---\ndescription: y\nextra: 1\n---\nbody"),
    /unknown command frontmatter fields in x\.md: extra/,
  );
});

test("command arguments ride verbatim: the $$ and $& replacement patterns are not interpreted", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    const drive = fixture.commands.find(
      (command: { name: string }) => command.name === "drive-project",
    )!;
    await drive.execute({
      sessionID: "ses-caller",
      prompt: { text: "check the $$out and $& escaping" },
    });
    assert.equal(fixture.prompts.length, 1);
    assert.ok(
      fixture.prompts[0].text.includes("check the $$out and $& escaping"),
      "the arguments reach the director exactly as typed",
    );
    assert.ok(!fixture.prompts[0].text.includes("$ARGUMENTS"));
  } finally {
    await cleanup?.();
  }
});

test("a failed agent switch fails the command named instead of prompting as the wrong agent", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    fixture.ctx.session.switchAgent = async () => {
      throw new Error("switch refused");
    };
    const drive = fixture.commands.find(
      (command: { name: string }) => command.name === "drive-project",
    )!;
    await assert.rejects(
      drive.execute({ sessionID: "ses-caller", prompt: { text: "x" } }),
      /switch refused/,
    );
    assert.equal(fixture.prompts.length, 0);

    // The absent domain stays the documented degrade: no switch, prompt
    // fires anyway.
    const plain = fakeContext();
    plain.ctx.session.switchAgent = undefined;
    const plainCleanup = await plugin.setup(plain.ctx);
    try {
      const drive2 = plain.commands.find(
        (command: { name: string }) => command.name === "drive-project",
      )!;
      await drive2.execute({ sessionID: "ses-caller", prompt: { text: "x" } });
      assert.equal(plain.prompts.length, 1);
    } finally {
      await plainCleanup?.();
    }
  } finally {
    await cleanup?.();
  }
});
