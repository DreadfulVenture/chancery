import assert from "node:assert/strict";
import test from "node:test";
import {
  createWatcherKernel,
  type AdoptedWatch,
  type KernelContext,
  type WatchCursor,
  type WatchEvent,
  type WatchSource,
} from "../kernel.ts";

// The watcher kernel's contract tests, against a fake source: sole-writer
// semantics, adoption without re-delivery, baseline on register,
// per-source isolation, and the Field privacy shape — the family's
// shared contract, the one every source adapter must satisfy (the ADR at
// docs/adr/20261119-watcher-family.md). The fake host is the existing
// tests' shape: sessions with whole-record metadata replaces, synthetic
// mail, an event bus. Every write lands in this process; nothing leaves.

type SessionRow = { id: string; metadata?: Record<string, unknown> };

function fakeContext(listRows: SessionRow[] = []) {
  const sessions = new Map<
    string,
    SessionRow & { metadata?: Record<string, unknown> }
  >();
  for (const row of listRows) {
    sessions.set(row.id, structuredClone(row));
  }
  const mails: Array<{ sessionID: string; text: string }> = [];
  const trace: string[] = [];
  const queue: Array<{ type: string; data: unknown }> = [];
  let push: (() => void) | undefined;

  const ctx: KernelContext = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.get(sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        return structuredClone(row);
      },
      list: async () => ({
        data: structuredClone([...sessions.values()]),
        cursor: {},
      }),
      update: async (input: {
        sessionID: string;
        metadata: Record<string, unknown>;
      }) => {
        const row = sessions.get(input.sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        row.metadata = structuredClone(input.metadata);
        trace.push(`stamp-write ${input.sessionID}`);
        return { id: row.id };
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        mails.push(structuredClone(input));
        trace.push(`mail ${input.sessionID}`);
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
    await new Promise((resolve) => setTimeout(resolve, 2));
  };

  return { ctx, sessions, mails, trace, emit };
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

const stampedWatches = (
  fixture: ReturnType<typeof fakeContext>,
  sessionID: string,
): any[] => {
  const metadata = fixture.sessions.get(sessionID)?.metadata ?? {};
  const rows = (metadata as Record<string, any>).chancery?.watches;
  return Array.isArray(rows) ? rows : [];
};

// The pass cadence the tests run at: the timer drives the passes; the
// probes wait for the observable state.
const POLL_MS = 5;

const idField = (id: string): WatchEvent["fields"][number] => ({
  kind: "id",
  name: "thing",
  value: id,
});

const thingEvent = (
  id: string,
  over: Partial<WatchEvent> = {},
): WatchEvent => ({
  id,
  type: "thing",
  fields: [idField(id)],
  ...over,
});

// The fake source: the contract's members, with the poll's behavior (and
// everything else) specifiable per test.
type FakeSpec = {
  id?: string;
  kinds?: string[];
  ready?: { ok: false; reason: string };
  poll?: (watch: AdoptedWatch, cursor: WatchCursor) => WatchEvent[] | null;
  baseline?: (seed: unknown) => Promise<Record<string, boolean> | null>;
  prepare?: (watch: AdoptedWatch, event: WatchEvent) => Promise<unknown>;
};

const makeSource = (spec: FakeSpec = {}, trace?: string[]) => {
  const calls: Array<{ watch: string; cursor: WatchCursor; pass: unknown }> =
    [];
  const source: WatchSource = {
    id: spec.id ?? "fake",
    ready: (config) => (spec.ready ? { ...spec.ready } : { ok: true, config }),
    kinds: () => spec.kinds ?? ["thing"],
    claimGroupOf: () => null,
    normalize: (req) => ({
      kind: String(req.kind ?? "thing"),
      repo: String(req.repo ?? "acme/widgets"),
      ref: String(req.ref ?? "1"),
      note: typeof req.note === "string" && req.note ? req.note : null,
    }),
    ...(spec.baseline ? { baseline: spec.baseline } : {}),
    poll: async (watch, cursor, pass) => {
      calls.push({ watch: watch.id, cursor, pass });
      return spec.poll ? spec.poll(watch, cursor) : [];
    },
    ...(spec.prepare
      ? {
          prepare: async (watch: AdoptedWatch, event: WatchEvent) => {
            trace?.push(`prepare ${event.id}`);
            return spec.prepare(watch, event);
          },
        }
      : {}),
    render: (watch, event) => `fake mail — watch ${watch.id} event ${event.id}`,
  };
  return { source, calls };
};

const boot = async (
  fixture: ReturnType<typeof fakeContext>,
  specs: FakeSpec[],
) => {
  const made = specs.map((spec) => makeSource(spec, fixture.trace));
  const kernel = createWatcherKernel({
    ctx: fixture.ctx,
    debug: () => {},
    pollMs: POLL_MS,
    sources: made.map((entry) => entry.source),
  });
  return { kernel, sources: made, cleanup: () => kernel.cleanup() };
};

test("sole writer: register stamps one row through the kernel's machinery, and a row the registry does not own keeps its markers", async () => {
  const foreign = {
    id: "pd-FGN",
    session: "ses-1",
    kind: "pagerduty",
    ref: "PIJ90N7",
    delivered: { "INC-1": true },
    markedAt: { "INC-1": "2026-11-19T00:00:00.000Z" },
  };
  const fixture = fakeContext([
    { id: "ses-1", metadata: { chancery: { watches: [foreign] } } },
  ]);
  const { kernel, cleanup } = await boot(fixture, [
    { poll: () => [thingEvent("e1")] },
  ]);
  try {
    const outcome = await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    assert.equal(outcome.outcome, "registered");
    // One row appended, in today's stamp shape; the foreign row rode
    // along untouched, because the patch only appends its own.
    const rows = stampedWatches(fixture, "ses-1");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], foreign);
    assert.equal(rows[1].kind, "thing");
    assert.equal(rows[1].ref, "7");
    assert.deepEqual(rows[1].delivered, {});
    assert.equal(rows[1].session, "ses-1");

    // The pass settles the watch once; the foreign row's markers are
    // still exactly its owner's — nothing rebuilt, nothing re-waked.
    await waitFor(() => fixture.mails.length === 1);
    const after = stampedWatches(fixture, "ses-1");
    assert.deepEqual(after[0], foreign);
    assert.deepEqual(after[1].delivered, { e1: true });
  } finally {
    await cleanup();
  }
});

test("sole writer: the poll reads pure — the pass context carries a memo and no write path", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, sources, cleanup } = await boot(fixture, [{}]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    await waitFor(() => sources[0].calls.length > 0);
    const pass = sources[0].calls[0].pass as Record<string, unknown>;
    assert.deepEqual(Object.keys(pass), ["memo"]);
    assert.ok(pass.memo instanceof Map);
    // The cursor the poll read is the watch's progress, and nothing
    // else: no session surface, no stamp machinery reaches the source.
    assert.deepEqual(sources[0].calls[0].cursor.delivered, {});
    assert.equal(sources[0].calls[0].cursor.baselinePending, false);
  } finally {
    await cleanup();
  }
});

test("adoption: a reloaded watch re-delivers nothing; a new event does", async () => {
  const fixture = fakeContext([
    {
      id: "ses-1",
      metadata: {
        chancery: {
          watches: [
            {
              id: "w-seeded",
              session: "ses-1",
              kind: "thing",
              repo: "acme/widgets",
              ref: "7",
              delivered: { e1: true },
            },
          ],
        },
      },
    },
  ]);
  const { kernel, sources, cleanup } = await boot(fixture, [
    {
      poll: () => [thingEvent("e1"), thingEvent("e2")],
    },
  ]);
  try {
    await waitFor(() => sources[0].calls.length > 0);
    await waitFor(() => fixture.mails.length === 1);
    // e1 was spent before the reload: its marker keeps the wake to one.
    assert.ok(
      fixture.mails[0].text.includes("event e2"),
      fixture.mails[0].text,
    );
    const row = stampedWatches(fixture, "ses-1").find(
      (candidate) => candidate.id === "w-seeded",
    );
    assert.deepEqual(row.delivered, { e1: true, e2: true });
    assert.equal(kernel.watches().length, 1);
  } finally {
    await cleanup();
  }
});

test("adoption reads without writing: a watch adopted from a stamp is polled, and no pass rewrites the row it adopted", async () => {
  const fixture = fakeContext([
    {
      id: "ses-1",
      metadata: {
        chancery: {
          watches: [
            {
              id: "w-seeded",
              session: "ses-1",
              kind: "thing",
              repo: "acme/widgets",
              ref: "7",
              delivered: { e1: true },
            },
          ],
        },
      },
    },
  ]);
  const { kernel, sources, cleanup } = await boot(fixture, [
    { poll: () => [] },
  ]);
  try {
    // One pass, no events: the adoption itself and the pass write
    // nothing — the stamp keeps its row byte for byte.
    await waitFor(() => sources[0].calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.trace.length, 0);
    assert.equal(kernel.watches().length, 1);
    assert.deepEqual(stampedWatches(fixture, "ses-1")[0].delivered, {
      e1: true,
    });
  } finally {
    await cleanup();
  }
});

test("baseline on register: the read's ids are the spent backlog", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, cleanup } = await boot(fixture, [
    {
      baseline: async () => ({ r1: true, r2: true }),
      poll: () => [thingEvent("r2"), thingEvent("r3")],
    },
  ]);
  try {
    const outcome = await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    assert.equal(outcome.outcome, "registered");
    const row = stampedWatches(fixture, "ses-1")[0];
    // The backlog spent at creation; no baseline flag on the row.
    assert.deepEqual(row.delivered, { r1: true, r2: true });
    assert.equal(row.baseline, undefined);
    await waitFor(() => fixture.mails.length === 1);
    assert.ok(fixture.mails[0].text.includes("event r3"));
  } finally {
    await cleanup();
  }
});

test("baseline pending: the first pass spends the page and wakes nobody; a later event wakes", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  let spent = false;
  const { kernel, cleanup } = await boot(fixture, [
    {
      baseline: async () => null,
      poll: (watch, cursor) => {
        if (cursor.baselinePending) {
          return [
            thingEvent("b1", { baseline: true }),
            thingEvent("b2", { baseline: true }),
          ];
        }
        return spent
          ? [thingEvent("b1"), thingEvent("b2"), thingEvent("b3")]
          : [thingEvent("b3")];
      },
    },
  ]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    const row = () => stampedWatches(fixture, "ses-1")[0];
    // The first pass spends the page: no mail, markers taken, flag gone.
    await waitFor(() => row().delivered.b1 === true);
    await waitFor(() => row().baseline === undefined);
    assert.equal(fixture.mails.length, 0);
    assert.deepEqual(row().delivered, { b1: true, b2: true });
    spent = true;
    // A review that arrives after the watch wakes; the backlog never did.
    await waitFor(() => fixture.mails.length === 1);
    assert.ok(fixture.mails[0].text.includes("event b3"));
  } finally {
    await cleanup();
  }
});

test("baseline pending: register stamps the flag, before any pass could spend it", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  // A pass cadence no test tick reaches: the register's stamp is read
  // before any poll pass can run.
  const made = makeSource({ baseline: async () => null });
  const kernel = createWatcherKernel({
    ctx: fixture.ctx,
    debug: () => {},
    pollMs: 60_000,
    sources: [made.source],
  });
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    const row = stampedWatches(fixture, "ses-1")[0];
    assert.equal(row.baseline, "pending");
    assert.deepEqual(row.delivered, {});
  } finally {
    await kernel.cleanup();
  }
});

test("baseline pending: a read that gives nothing usable keeps the flag; a successful empty page spends it", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  let usable: WatchEvent[] | null = null;
  const { kernel, sources, cleanup } = await boot(fixture, [
    {
      baseline: async () => null,
      poll: () => usable,
    },
  ]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    const row = () => stampedWatches(fixture, "ses-1")[0];
    // The first pass reads nothing usable: the pass skips, the flag
    // keeps for the next pass, nothing wakes.
    await waitFor(() => sources[0].calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(row().baseline, "pending");
    assert.deepEqual(row().delivered, {});
    assert.equal(fixture.mails.length, 0);
    // A successful (empty) page: the flag is spent with nothing merged.
    usable = [];
    await waitFor(() => row().baseline === undefined);
    assert.deepEqual(row().delivered, {});
  } finally {
    await cleanup();
  }
});

test("per-source isolation: one source's read failure does not fail the pass", async () => {
  const fixture = fakeContext([
    { id: "ses-1", metadata: {} },
    { id: "ses-2", metadata: {} },
  ]);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { kernel, cleanup } = await boot(fixture, [
      {
        id: "dies",
        kinds: ["dies-thing"],
        poll: () => {
          throw new Error("the read exploded");
        },
      },
      {
        id: "lives",
        kinds: ["lives-thing"],
        poll: () => [thingEvent("ok-1")],
      },
    ]);
    try {
      await kernel.register(
        { kind: "dies-thing", repo: "acme/widgets", ref: "1" },
        "ses-1",
      );
      await kernel.register(
        { kind: "lives-thing", repo: "acme/widgets", ref: "2" },
        "ses-2",
      );
      await waitFor(() => fixture.mails.length === 1);
      // The living source's watch settled and marked; the failing
      // source's watch is said and kept for the next pass.
      assert.ok(fixture.mails[0].text.includes("event ok-1"));
      assert.ok(
        logged.some((line) => line.includes("poll failed")),
        logged.join("\n"),
      );
      assert.equal(kernel.watches().length, 2);
      const live = stampedWatches(fixture, "ses-2")[0];
      assert.equal(Object.keys(live.delivered).length, 1);
      const dead = stampedWatches(fixture, "ses-1")[0];
      assert.deepEqual(dead.delivered, {});
    } finally {
      await cleanup();
    }
  } finally {
    console.error = original;
  }
});

test("field privacy: an event carrying a field outside the union is refused — never marked, never delivered", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { kernel, cleanup } = await boot(fixture, [
      {
        poll: () => [
          {
            id: "sneaky",
            type: "thing",
            fields: [
              idField("sneaky"),
              // A comment body has nowhere to go: the kind is outside
              // the contract.
              {
                kind: "content",
                name: "body",
                value: "free text from the source",
              },
            ],
          } as unknown as WatchEvent,
          thingEvent("honest"),
        ],
      },
    ]);
    try {
      await kernel.register(
        { kind: "thing", repo: "acme/widgets", ref: "7" },
        "ses-1",
      );
      await waitFor(() => fixture.mails.length === 1);
      assert.ok(fixture.mails[0].text.includes("event honest"));
      assert.ok(
        logged.some(
          (line) =>
            line.includes("bad event") && line.includes("outside the contract"),
        ),
        logged.join("\n"),
      );
      const row = stampedWatches(fixture, "ses-1")[0];
      // The refused event was never marked: its id is free to return —
      // well-formed — on a later pass.
      assert.deepEqual(Object.keys(row.delivered), ["honest"]);
      assert.equal(fixture.mails.length, 1);
      assert.ok(!fixture.mails[0].text.includes("free text"));
    } finally {
      await cleanup();
    }
  } finally {
    console.error = original;
  }
});

test("field privacy: a non-string value is refused too", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, sources, cleanup } = await boot(fixture, [
    {
      poll: () => [
        {
          id: "shaped",
          type: "thing",
          fields: [{ kind: "status", name: "state", value: 42 }],
        } as unknown as WatchEvent,
      ],
    },
  ]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    // The pass ran; the event was refused; nothing was marked or mailed.
    await waitFor(() => sources[0].calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.mails.length, 0);
    const row = stampedWatches(fixture, "ses-1")[0];
    assert.deepEqual(row.delivered, {});
  } finally {
    await cleanup();
  }
});

test("ready: a source that cannot run disables itself, said once on its own line", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const made = makeSource({
      id: "lame",
      ready: { ok: false, reason: "no token — the source is off" },
    });
    const kernel = createWatcherKernel({
      ctx: fixture.ctx,
      debug: () => {},
      pollMs: POLL_MS,
      config: {},
      sources: [made.source],
    });
    try {
      assert.equal(kernel.watches().length, 0);
      const lines = logged.filter((line) =>
        line.includes("the lame source is off"),
      );
      assert.equal(lines.length, 1, logged.join("\n"));
      assert.ok(lines[0].includes("no token — the source is off"));
      // And a register for the disabled source's kind finds no source.
      await assert.rejects(
        kernel.register(
          { kind: "thing", repo: "acme/widgets", ref: "7" },
          "ses-1",
        ),
        /kind must be one of\s*\(got "thing"\)/,
      );
    } finally {
      await kernel.cleanup();
    }
  } finally {
    console.error = original;
  }
});

test("the detail reads run before the mark: nothing but the mail follows the write", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, cleanup } = await boot(fixture, [
    {
      prepare: async () => ({ jobsText: "build success", tail: null }),
      poll: () => [thingEvent("e9")],
    },
  ]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    await waitFor(() => fixture.mails.length === 1);
    // prepare's read, then the stamp write, then the mail — in that
    // order, with the register's own stamp write ahead of them all.
    assert.deepEqual(fixture.trace, [
      "stamp-write ses-1",
      "prepare e9",
      "stamp-write ses-1",
      "mail ses-1",
    ]);
  } finally {
    await cleanup();
  }
});

test("a terminal event whose dissolve write failed heals next pass: the removal rides the marked write", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, sources, cleanup } = await boot(fixture, [
    { poll: () => [thingEvent("closed", { terminal: true })] },
  ]);
  // The dissolve write (the pass's second stamp write after the
  // register's and the mark's) fails without applying: the row keeps
  // its place on the stamp and the registry keeps the watch.
  const realUpdate = fixture.ctx.session.update;
  let updates = 0;
  fixture.ctx.session.update = async (input: any) => {
    updates += 1;
    if (updates === 3) throw new Error("the dissolve write exploded");
    return realUpdate(input);
  };
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    // Pass 1: the mark commits, the mail goes, the dissolve fails.
    await waitFor(() => fixture.mails.length === 1);
    await waitFor(() => sources[0].calls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Pass 2: the pre-check does not spend the terminal event — the
    // settle re-reads the marker and the removal rides the write, the
    // old settleLifecycle's heal.
    assert.equal(fixture.mails.length, 1, "the close mails once, ever");
    const rows = stampedWatches(fixture, "ses-1");
    assert.equal(rows.length, 0, "the healed dissolve removed the row");
    assert.equal(kernel.watches().length, 0);
  } finally {
    await cleanup();
  }
});

test("the baseline spend passes the same field boundary: a bad event is refused, its id never spent", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { kernel, cleanup } = await boot(fixture, [
      {
        baseline: async () => null,
        poll: (watch, cursor) =>
          cursor.baselinePending
            ? [
                {
                  id: "sneaky",
                  type: "thing",
                  fields: [
                    idField("sneaky"),
                    {
                      kind: "content",
                      name: "body",
                      value: "free text from the source",
                    },
                  ],
                } as unknown as WatchEvent,
                thingEvent("b1", { baseline: true }),
              ]
            : [],
      },
    ]);
    try {
      await kernel.register(
        { kind: "thing", repo: "acme/widgets", ref: "7" },
        "ses-1",
      );
      await waitFor(
        () => stampedWatches(fixture, "ses-1")[0].delivered.b1 === true,
      );
      assert.ok(
        logged.some(
          (line) =>
            line.includes("bad event") && line.includes("outside the contract"),
        ),
        logged.join("\n"),
      );
      const row = stampedWatches(fixture, "ses-1")[0];
      // The refused event's id was never spent; the valid one was.
      assert.deepEqual(Object.keys(row.delivered), ["b1"]);
      assert.equal(row.baseline, undefined);
      assert.equal(fixture.mails.length, 0);
    } finally {
      await cleanup();
    }
  } finally {
    console.error = original;
  }
});

test("an event or field carrying keys outside the contract is refused like a bad kind", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { kernel, cleanup } = await boot(fixture, [
      {
        poll: () =>
          [
            // A payload smuggled in under an unnamed event key.
            {
              id: "extra",
              type: "thing",
              fields: [idField("extra")],
              body: "free text from the source",
            },
            // A payload smuggled in under an unnamed field key.
            {
              id: "fieldextra",
              type: "thing",
              fields: [
                { kind: "id", name: "t", value: "fieldextra", body: "text" },
              ],
            },
            thingEvent("honest"),
          ] as unknown as WatchEvent[],
      },
    ]);
    try {
      await kernel.register(
        { kind: "thing", repo: "acme/widgets", ref: "7" },
        "ses-1",
      );
      await waitFor(() => fixture.mails.length === 1);
      assert.ok(fixture.mails[0].text.includes("event honest"));
      const refusals = logged.filter((line) => line.includes("bad event"));
      assert.equal(refusals.length, 2, logged.join("\n"));
      // Both refusals name the smuggled key: the event's own and the
      // field's.
      assert.ok(refusals[0].includes('"body"'), refusals[0]);
      assert.ok(refusals[1].includes('"body"'), refusals[1]);
      const row = stampedWatches(fixture, "ses-1")[0];
      assert.deepEqual(Object.keys(row.delivered), ["honest"]);
      assert.ok(!fixture.mails[0].text.includes("free text"));
    } finally {
      await cleanup();
    }
  } finally {
    console.error = original;
  }
});

test("an event id that shadows a prototype member still delivers once — the delivered map reads its own keys only", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  const { kernel, sources, cleanup } = await boot(fixture, [
    { poll: () => [thingEvent("toString"), thingEvent("constructor")] },
  ]);
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    // Both ids deliver — an unguarded read would see Object.prototype's
    // members as spent markers and silently drop them.
    await waitFor(() => fixture.mails.length === 2);
    const row = stampedWatches(fixture, "ses-1")[0];
    assert.equal(
      Object.prototype.hasOwnProperty.call(row.delivered, "toString"),
      true,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(row.delivered, "constructor"),
      true,
    );
    // And the second pass re-delivers nothing: the markers are the
    // row's own keys now.
    await waitFor(() => sources[0].calls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.mails.length, 2);
  } finally {
    await cleanup();
  }
});

test("the owed mail: a stamp write that fails after applying delivers once on the next pass", async () => {
  const fixture = fakeContext([{ id: "ses-1", metadata: {} }]);
  // Pass 2's read waits on a gate, so the pass-one outcome is observed
  // deterministically before the heal runs.
  let openPass2: () => void = () => {};
  const pass2 = new Promise<void>((resolve) => {
    openPass2 = resolve;
  });
  let polls = 0;
  const { kernel, cleanup } = await boot(fixture, [
    {
      poll: async () => {
        polls += 1;
        if (polls >= 2) await pass2;
        return [thingEvent("e1")];
      },
    },
  ]);
  // The apply-then-throw shape on the marker write (the second stamp
  // write, after the register's): the marker lands on the host's record
  // and only then reports failure.
  const realUpdate = fixture.ctx.session.update;
  let updates = 0;
  fixture.ctx.session.update = async (input: any) => {
    updates += 1;
    if (updates === 2) {
      await realUpdate(input);
      throw new Error("stamp write exploded");
    }
    return realUpdate(input);
  };
  try {
    await kernel.register(
      { kind: "thing", repo: "acme/widgets", ref: "7" },
      "ses-1",
    );
    // Pass 1: the marker applied, the write reported failure — the mail
    // is owed, not lost and not doubled.
    await waitFor(() => polls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.mails.length, 0);
    assert.equal(
      stampedWatches(fixture, "ses-1")[0].delivered.e1,
      true,
      "the marker persisted under the failed-reported write",
    );
    // Pass 2: the fresh stamp's marker plus the failedWrites attempt —
    // the re-attempt commits and delivers the owed mail, once.
    openPass2();
    await waitFor(() => fixture.mails.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.mails.length, 1, "no double delivery on the heal");
    assert.equal(kernel.watches().length, 1);
    assert.deepEqual(stampedWatches(fixture, "ses-1")[0].delivered, {
      e1: true,
    });
  } finally {
    await cleanup();
  }
});
