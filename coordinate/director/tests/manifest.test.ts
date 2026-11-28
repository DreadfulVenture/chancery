import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../director.ts";

// The manifest surface (PRJ-393) rides only ctx.tool.transform and
// ctx.storage, so this fake hosts those two domains over one shared kv
// map — the host's SQLite kv. Two fixtures over the same map are the
// two-activations case, the way the host runs one plugin activation per
// location over one kv table; each fixture's setup registers the whole
// director module's tools, but only the manifest tools are exercised here. The event
// stream and session domain the module also touches are stubs: no events
// fire and no sessions are read, so the pump idles and the surface stays
// read-when-read.

type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

type Fixture = {
  ctx: any;
  tools: Map<string, ToolDef>;
};

function fakeManifestContext(kv: Map<string, unknown>): Fixture {
  const tools = new Map<string, ToolDef>();
  const ctx: any = {
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
      // No events ever fire; the pump idles here until cleanup aborts it.
      // The async generator is the subscribe interface the plugin pumps;
      // an intentionally empty event stream cannot yield, so the
      // require-yield flag is exempted inline.
      // oxlint-disable-next-line require-yield
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    },
  };
  return { ctx, tools };
}

async function withManifest(
  kv: Map<string, unknown>,
  run: (fixture: Fixture) => Promise<void>,
) {
  const fixture = fakeManifestContext(kv);
  const cleanup = await plugin.setup(fixture.ctx);
  try {
    await run(fixture);
  } finally {
    await cleanup?.();
  }
}

async function call(
  fixture: Fixture,
  name: string,
  input: Record<string, unknown> | undefined,
  sessionID: string,
) {
  const tool = fixture.tools.get(name)!;
  const result = await tool.execute(input, { sessionID });
  return JSON.parse(result.content);
}

const storedRows = (kv: Map<string, unknown>) =>
  [...kv.entries()]
    .filter(([key]) => key.startsWith("manifest/"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, row: value as Record<string, any> }));

test("manifest_write stores one whole row under the caller's own namespace", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const result = await call(
      fixture,
      "manifest_write",
      {
        key: "prj-393-slice",
        fact: "the worker is dispatched and pinned to the flash model",
      },
      "ses-a",
    );

    assert.equal(result.ok, true);
    assert.equal(result.key, "prj-393-slice");
    assert.equal(result.owner, "ses-a");
    assert.match(result.id, /^man-/);
    const rows = storedRows(kv);
    assert.equal(rows.length, 1);
    assert.match(rows[0].key, /^manifest\/ses-a\//);
    assert.equal(rows[0].row.key, "prj-393-slice");
    assert.equal(
      rows[0].row.fact,
      "the worker is dispatched and pinned to the flash model",
    );
    assert.equal(rows[0].row.owner, "ses-a");
    assert.equal(typeof rows[0].row.at, "number");
    assert.equal(rows[0].row.supersedes, undefined);
  });
});

test("manifest_write refuses a missing, empty, or overlong key or fact with a named error", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await assert.rejects(
      call(fixture, "manifest_write", { fact: "a fact" }, "ses-a"),
      /manifest_write: key is required/,
    );
    await assert.rejects(
      call(fixture, "manifest_write", { key: "k", fact: "" }, "ses-a"),
      /manifest_write: fact is required/,
    );
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        { key: "k".repeat(201), fact: "f" },
        "ses-a",
      ),
      /manifest_write: key is 201 characters, over the 200 cap/,
    );
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        { key: "k", fact: "f".repeat(501) },
        "ses-a",
      ),
      /manifest_write: fact is 501 characters, over the 500 cap/,
    );
    assert.equal(storedRows(kv).length, 0);
  });
});

test("manifest_write refuses a supersedes that names no stored row, and stores the lineage when it does", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        { key: "k", fact: "new fact", supersedes: "man-nowhere" },
        "ses-a",
      ),
      /manifest_write: supersedes names no stored row "man-nowhere"/,
    );
    const first = await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "first fact" },
      "ses-a",
    );
    const second = await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "second fact", supersedes: first.id },
      "ses-a",
    );
    assert.equal(second.supersedes, first.id);
    const rows = storedRows(kv);
    assert.equal(rows.length, 2);
    const storedSecond = rows.find((entry) => entry.row.id === second.id);
    assert.equal(storedSecond?.row.supersedes, first.id);
  });
});

test("two writes within one millisecond compose by write order, not by chance", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // Pin Date.now so both rows tie on `at`: only the id's monotonic
    // sequence can order them, and the second write must win.
    const originalNow = Date.now;
    Date.now = () => 1763376000000;
    try {
      await call(
        fixture,
        "manifest_write",
        { key: "k", fact: "first fact" },
        "ses-a",
      );
      await call(
        fixture,
        "manifest_write",
        { key: "k", fact: "second fact" },
        "ses-a",
      );
    } finally {
      Date.now = originalNow;
    }
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    assert.match(view.view, /second fact/);
    assert.ok(!view.view.includes("first fact"));
    assert.equal(view.facts, 1);
  });
});

test("manifest_read composes newest-per-key from storage, so a newer fact replaces an older one with no history in the view", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "first fact" },
      "ses-a",
    );
    const between = await call(fixture, "manifest_read", undefined, "ses-a");
    assert.match(between.view, /first fact/);
    await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "second fact" },
      "ses-a",
    );
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    // The view composes from storage at call time: the newer fact renders,
    // the older one is gone, and nothing in memory carried the first read.
    assert.match(view.view, /second fact/);
    assert.ok(!view.view.includes("first fact"));
    assert.equal(view.facts, 1);
    assert.equal(view.folded, 0);
  });
});

test("manifest_read folds a superseded row wherever it lives, even when it is the newest for its key", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const victim = await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "a wrong fact" },
      "ses-a",
    );
    // The superseding row is written by another session, so the fold has
    // to cross namespaces; the victim was the only row under its key, so
    // only the supersedes can keep it out of the view.
    await call(
      fixture,
      "manifest_write",
      { key: "other", fact: "b's fact", supersedes: victim.id },
      "ses-b",
    );
    const view = await call(fixture, "manifest_read", undefined, "ses-b");
    assert.ok(!view.view.includes("a wrong fact"));
    assert.equal(view.folded, 1);
    assert.equal(view.facts, 1);
    assert.match(view.view, /b's fact/);
    // The count line is the header's.
    assert.match(view.view, /\(1 superseded row folded\)/);
  });
});

test("the view renders rows newest first and names key, fact, owner, and row id", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await call(
      fixture,
      "manifest_write",
      { key: "older", fact: "older fact" },
      "ses-a",
    );
    // Guarantees both rows distinct `at` values even within one millisecond.
    await new Promise((resolve) => setTimeout(resolve, 3));
    await call(
      fixture,
      "manifest_write",
      { key: "newer", fact: "newer fact" },
      "ses-a",
    );
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    const lines = view.view.split("\n");
    assert.match(lines[0], /^manifest: 2 facts \(0 superseded rows folded\)$/);
    assert.match(lines[1], /^newer: newer fact \(owner ses-a, /);
    assert.match(lines[2], /^older: older fact \(owner ses-a, /);
    assert.match(lines[1], /row man-/);
  });
});

test("two sessions (two activations) share the view through the kv", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // A second fixture over the same kv map: another location's activation.
    const second = fakeManifestContext(kv);
    const cleanup = await plugin.setup(second.ctx);
    try {
      await call(
        fixture,
        "manifest_write",
        { key: "shared", fact: "written by a" },
        "ses-a",
      );
      const view = await call(second, "manifest_read", undefined, "ses-b");
      assert.match(view.view, /written by a/);
      assert.equal(view.facts, 1);
    } finally {
      await cleanup?.();
    }
  });
});

test("the view renders whole: past twenty keys every fact still renders in one call", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // Review 211's count: a cap at twenty current keys made the rest
    // unreachable, and the header advised a higher limit that could not
    // be given. The view composes uncapped; twenty-five keys all render.
    for (let i = 1; i <= 25; i += 1) {
      await call(
        fixture,
        "manifest_write",
        { key: `key-${String(i).padStart(2, "0")}`, fact: `fact number ${i}` },
        "ses-a",
      );
    }
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    assert.equal(view.facts, 25);
    assert.equal(view.notShown, undefined);
    assert.ok(!/not shown/.test(view.view));
    assert.match(view.view, /fact number 25/);
    const lines = view.view.split("\n");
    assert.equal(lines.length, 26);
  });
});

test("manifest_read refuses read arguments: the view is whole, there is nothing to cap or page", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await assert.rejects(
      call(fixture, "manifest_read", { limit: 2 }, "ses-a"),
      /manifest_read: takes no arguments/,
    );
    await assert.rejects(
      call(fixture, "manifest_read", { maxChars: 4000 }, "ses-a"),
      /manifest_read: takes no arguments/,
    );
  });
});

test("manifest_drop by key clears only the caller's own namespace", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    await call(
      fixture,
      "manifest_write",
      { key: "shared", fact: "a's fact" },
      "ses-a",
    );
    await call(
      fixture,
      "manifest_write",
      { key: "shared", fact: "b's fact" },
      "ses-b",
    );
    const result = await call(
      fixture,
      "manifest_drop",
      { key: "shared" },
      "ses-a",
    );
    assert.equal(result.dropped, 1);
    // b's row under the same key survives: the drop never leaves the
    // caller's own prefix.
    const view = await call(fixture, "manifest_read", undefined, "ses-b");
    assert.match(view.view, /b's fact/);
    assert.ok(!view.view.includes("a's fact"));
    assert.equal(view.facts, 1);
    const remaining = storedRows(kv);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].row.owner, "ses-b");
  });
});

test("manifest_drop by key clears the key's history too", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const first = await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "one" },
      "ses-a",
    );
    await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "two", supersedes: first.id },
      "ses-a",
    );
    const result = await call(fixture, "manifest_drop", { key: "k" }, "ses-a");
    assert.equal(result.dropped, 2);
    // The dropped superseding row's link survives as a tombstone row
    // (empty fact, the caller's namespace), so the retired fact can
    // never republish itself even though both of its key's rows are
    // gone.
    assert.equal(result.tombstones, 1);
    assert.deepEqual(result.keptFolded, [first.id]);
    assert.match(
      result.note,
      /1 supersedes link preserved as tombstone rows; the fact they retired stays out of the view/,
    );
    const remaining = storedRows(kv);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].row.fact, "");
    assert.equal(remaining[0].row.supersedes, first.id);
    assert.equal(remaining[0].row.owner, "ses-a");
    // A tombstone is not a fact: the view renders none.
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    assert.equal(view.facts, 0);
    assert.equal(view.folded, 0);
  });
});

test("manifest_drop by id drops one row; exactly one selector is required", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const only = await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "one" },
      "ses-a",
    );
    await call(fixture, "manifest_write", { key: "j", fact: "two" }, "ses-a");

    await assert.rejects(
      call(fixture, "manifest_drop", { key: "k", id: only.id }, "ses-a"),
      /manifest_drop: give exactly one of key or id/,
    );
    await assert.rejects(
      call(fixture, "manifest_drop", {}, "ses-a"),
      /manifest_drop: give exactly one of key or id/,
    );
    await assert.rejects(
      call(fixture, "manifest_drop", { key: "" }, "ses-a"),
      /manifest_drop: key, when given, must be non-empty/,
    );

    const result = await call(
      fixture,
      "manifest_drop",
      { id: only.id },
      "ses-a",
    );
    assert.equal(result.dropped, 1);
    assert.equal(storedRows(kv).length, 1);
    assert.equal(storedRows(kv)[0].row.key, "j");
  });
});

test("a drop that matches nothing — including a row owned by someone else — reports dropped: 0", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const foreign = await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "b's fact" },
      "ses-b",
    );
    const result = await call(
      fixture,
      "manifest_drop",
      { id: foreign.id },
      "ses-a",
    );
    assert.equal(result.dropped, 0);
    assert.match(
      result.note,
      /nothing under that id in your manifest namespace/,
    );
    // The foreign row is untouched.
    assert.equal(storedRows(kv).length, 1);
  });
});

test("dropping a superseding row keeps its victim retired, and the result says so", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const victim = await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "a wrong fact" },
      "ses-a",
    );
    await call(
      fixture,
      "manifest_write",
      { key: "other", fact: "b's fact", supersedes: victim.id },
      "ses-b",
    );
    // Dropping the superseding row by id must not republish the victim:
    // the wrong fact stays out of the shared view.
    const result = await call(
      fixture,
      "manifest_drop",
      {
        id: (storedRows(kv).find((r) => r.row.owner === "ses-b") as any).row.id,
      },
      "ses-b",
    );
    assert.equal(result.dropped, 1);
    assert.equal(result.tombstones, 1);
    assert.deepEqual(result.keptFolded, [victim.id]);
    assert.match(result.note, /the fact they retired stays out of the view/);
    const view = await call(fixture, "manifest_read", undefined, "ses-c");
    assert.ok(!view.view.includes("a wrong fact"));
    assert.ok(!view.view.includes("b's fact"));
    assert.equal(view.facts, 0);
    assert.equal(view.folded, 1);
    // The tombstone lives under the dropper's own namespace; the victim
    // row is still stored under its own, folded out of the view.
    const remaining = storedRows(kv);
    assert.equal(remaining.length, 2);
    const tombstone = remaining.find((r) => r.row.fact === "");
    assert.match(tombstone!.key, /^manifest\/ses-b\//);
    assert.equal(tombstone!.row.supersedes, victim.id);
    assert.equal(tombstone!.row.owner, "ses-b");
  });
});

test("a tombstone survives a later drop of its key by being rewritten, not lost", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const victim = await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "a wrong fact" },
      "ses-a",
    );
    await call(
      fixture,
      "manifest_write",
      { key: "other", fact: "b's fact", supersedes: victim.id },
      "ses-b",
    );
    await call(fixture, "manifest_drop", { key: "other" }, "ses-b");
    // A second drop of that key finds the tombstone under it and
    // rewrites the link before removing the old row: the victim stays
    // retired, and no tombstone chain grows.
    const result = await call(
      fixture,
      "manifest_drop",
      { key: "other" },
      "ses-b",
    );
    assert.equal(result.dropped, 1);
    assert.equal(result.tombstones, 1);
    // The victim row is still stored under ses-a, folded; the one
    // tombstone carries the rewritten link.
    const remaining = storedRows(kv);
    assert.equal(remaining.length, 2);
    const tombstone = remaining.find((r) => r.row.fact === "");
    assert.equal(tombstone!.row.supersedes, victim.id);
    assert.equal(tombstone!.row.fact, "");
    const view = await call(fixture, "manifest_read", undefined, "ses-c");
    assert.ok(!view.view.includes("a wrong fact"));
  });
});

test("a failed tombstone write removes nothing: the retired fact stays retired", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    const victim = await call(
      fixture,
      "manifest_write",
      { key: "slice", fact: "a wrong fact" },
      "ses-a",
    );
    const superseder = await call(
      fixture,
      "manifest_write",
      { key: "other", fact: "b's fact", supersedes: victim.id },
      "ses-b",
    );
    // Tombstones are written before any removal, so a failed write leaves
    // the superseding row in place and the victim still folded — never a
    // half-drop that republishes the retired fact.
    const originalSet = fixture.ctx.storage.set;
    let failed = false;
    fixture.ctx.storage.set = async (...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw new Error("storage write failed");
      }
      return originalSet(...(args as [string, unknown]));
    };
    await assert.rejects(
      call(fixture, "manifest_drop", { id: superseder.id }, "ses-b"),
      /storage write failed/,
    );
    const view = await call(fixture, "manifest_read", undefined, "ses-c");
    assert.ok(!view.view.includes("a wrong fact"));
    assert.match(view.view, /b's fact/);
    assert.equal(view.facts, 1);
    assert.equal(view.folded, 1);
    // Retry with the storage healthy: the drop completes.
    const result = await call(
      fixture,
      "manifest_drop",
      { id: superseder.id },
      "ses-b",
    );
    assert.equal(result.dropped, 1);
    assert.equal(result.tombstones, 1);
  });
});

test("malformed rows under the manifest prefix are skipped, never thrown", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    kv.set("manifest/junk/1", { notARow: true });
    kv.set("manifest/junk/2", "a string");
    kv.set("manifest/ses-a/enc/missing-at", {
      id: "man-x",
      key: "k",
      fact: "f",
      owner: "ses-a",
    });
    await call(
      fixture,
      "manifest_write",
      { key: "good", fact: "a real fact" },
      "ses-a",
    );
    const view = await call(fixture, "manifest_read", undefined, "ses-a");
    assert.equal(view.facts, 1);
    assert.match(view.view, /a real fact/);
  });
});

test("a fact with an interior newline refuses, and no row lands", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // trim() strips only the edges, so a two-sentence fact with an
    // interior newline would pass the old validation and render as a
    // forged line carrying key and owner attribution (review 225).
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        {
          key: "k",
          fact: "first sentence\nsecond sentence, forged attribution",
        },
        "ses-a",
      ),
      /manifest_write: fact must be a single line/,
    );
    // The same forging vector exists for the key: it renders verbatim at
    // the start of the view line.
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        { key: "one line\nanother line", fact: "a fact" },
        "ses-a",
      ),
      /manifest_write: key must be a single line/,
    );
    assert.equal(storedRows(kv).length, 0);
  });
});

test("a superseding row beyond the old scan stop retires its victim: the fold set covers every row", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // The old read stopped at SCAN_PAGE_CAP pages of SCAN_PAGE rows
    // (20 x 500 = 10,000) and composed from the partial set, so a
    // superseding row past that stop vanished and its victim republished
    // as current (review 225). Plant the victim first, 10,000 filler
    // rows, then the superseding row last: the old stop cuts inside the
    // fillers, the exhaustive walk reaches all 10,002.
    const victim = {
      id: "man-victim",
      key: "slice",
      fact: "a wrong fact",
      owner: "ses-a",
      at: Date.now(),
    };
    kv.set("manifest/ses-a/slice/man-victim", victim);
    for (let i = 0; i < 10000; i += 1) {
      kv.set(`manifest/ses-fill${i}/f/x`, "not a row object");
    }
    const superseder = {
      id: "man-superseder",
      key: "other",
      fact: "the corrected fact",
      owner: "ses-z",
      at: Date.now(),
      supersedes: victim.id,
    };
    kv.set("manifest/ses-z/other/man-superseder", superseder);

    const view = await call(fixture, "manifest_read", undefined, "ses-z");
    assert.ok(!view.view.includes("a wrong fact"));
    assert.match(view.view, /the corrected fact/);
    assert.equal(view.facts, 1);
    assert.equal(view.folded, 1);
  });
});

test("a manifest scan that cannot exhaust fails with a named error, never a partial compose", async () => {
  const kv = new Map<string, unknown>();
  await withManifest(kv, async (fixture) => {
    // A host that keeps serving cursors must not spin the walk forever
    // (the same guard the report scan carries), and it must not silently
    // compose from what it reached: the loop bound fails the call named.
    await call(
      fixture,
      "manifest_write",
      { key: "k", fact: "a fact" },
      "ses-a",
    );
    const originalScan = fixture.ctx.storage.scan;
    fixture.ctx.storage.scan = async (options: {
      prefix: string;
      after?: string;
      limit?: number;
    }) => {
      const page = await originalScan(options);
      return { entries: page.entries, next: "cursor-never-ends" };
    };
    await assert.rejects(
      call(fixture, "manifest_read", undefined, "ses-a"),
      /manifest scan under manifest\/ did not exhaust within the 10000-page cap/,
    );
    // The same invariant guards the write-side lookup and the drop.
    await assert.rejects(
      call(
        fixture,
        "manifest_write",
        { key: "k", fact: "another fact", supersedes: "man-nowhere" },
        "ses-a",
      ),
      /manifest scan under manifest\/ did not exhaust within the 10000-page cap/,
    );
    await assert.rejects(
      call(fixture, "manifest_drop", { key: "k" }, "ses-a"),
      /manifest scan under manifest\/ses-a\/ did not exhaust within the 10000-page cap/,
    );
  });
});
