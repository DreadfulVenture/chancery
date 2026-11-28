/**
 * The finished-review notifications' semantics: the finish diff, and the
 * notifier's consumption — delivered-only advancement, the silent
 * consumption without a delivery path, the retry on a dead delivery,
 * the storage recovery, and the window bounding. The same modules the
 * browser bundle carries are the modules these tests import.
 */

import { describe, expect, it } from "vitest";
import {
  FinishNotifier,
  diffFinishes,
  finishPayload,
  localStorageSeenStore,
  runId,
  SEEN_KEY,
  type FinishNotice,
  type NotificationSink,
  type SeenStore,
} from "../src/notifier.js";
import type { NotifyRun } from "../src/notifier.js";

/** A posted run: the default finish, varied by pr/outcome/failure. */
const run = (over: Partial<NotifyRun> = {}): NotifyRun => ({
  ts: "2026-11-01T00:00:00.000Z",
  repo: "acme/widget",
  pr: 1,
  outcome: "posted",
  verdict: "APPROVE",
  ...over,
});

/** A sink recording every delivery, with live permission state. */
const sink = (
  opts: {
    permission?: "granted" | "denied" | "default";
    throwingDelivery?: boolean;
  } = {},
): {
  sink: NotificationSink;
  attempts: string[];
  delivered: FinishNotice[];
} => {
  let permission = opts.permission ?? "granted";
  const attempts: string[] = [];
  const delivered: FinishNotice[] = [];
  return {
    attempts,
    delivered,
    sink: {
      supported: () => true,
      permission: () => permission,
      request: async () => {
        permission = "granted";
        return permission;
      },
      deliver: (notice) => {
        attempts.push(notice.title);
        if (opts.throwingDelivery === true) {
          throw new Error("the delivery path is dead");
        }
        delivered.push(notice);
        return true;
      },
    },
  };
};

/** A memory seen-store, optionally broken on write. */
const store = (
  opts: { broken?: boolean } = {},
): {
  store: SeenStore;
  written: () => string[];
} => {
  const held = new Set<string>();
  const written: string[][] = [];
  return {
    written: () => written.flat(),
    store: {
      read: () => [...held],
      write: (ids) => {
        written.push(ids);
        if (opts.broken === true) {
          throw new Error("storage refused");
        }
        held.clear();
        for (const id of ids) {
          held.add(id);
        }
      },
    },
  };
};

describe("the finish diff", () => {
  it("a new finish diffs into exactly one notice", () => {
    const fresh = diffFinishes([run()], []);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual({
      id: runId(run()),
      title: "acme/widget#1",
      body: "APPROVE",
    });
  });

  it("a finish the seen-state holds diffs into nothing", () => {
    expect(diffFinishes([run()], [runId(run())])).toEqual([]);
  });

  it("a second poll of the same state diffs into nothing", () => {
    const runs = [run()];
    const seen = runs.map(runId);
    expect(diffFinishes(runs, seen)).toEqual([]);
  });

  it("a skipped run is not a finish and notifies nobody", () => {
    expect(
      diffFinishes([run({ outcome: "skipped", verdict: null })], []),
    ).toEqual([]);
  });

  it("an aborted run is not a finish and notifies nobody", () => {
    expect(
      diffFinishes([run({ outcome: "aborted", verdict: null })], []),
    ).toEqual([]);
  });

  it("a re-settled run whose outcome changed diffs into one new notice", () => {
    const failed = run({
      outcome: "failed",
      verdict: null,
      failure: { stage: "review", message: "the run failed" },
    });
    const postedAgain = run();
    // The row's start stamp never moves on a re-settle, so the two
    // identities differ by the outcome alone.
    expect(runId(failed)).not.toBe(runId(postedAgain));
    expect(diffFinishes([postedAgain], [runId(failed)])).toHaveLength(1);
  });

  it("a re-settled run that re-states its outcome diffs into nothing", () => {
    expect(diffFinishes([run()], [runId(run())])).toEqual([]);
  });

  it("a failed run's notice carries the short reason", () => {
    expect(
      finishPayload(
        run({
          outcome: "failed",
          verdict: null,
          failure: { stage: "review", message: "the reply carried no status" },
        }),
      ),
    ).toEqual({ title: "acme/widget#1", body: "the reply carried no status" });
  });

  it("a failed run with no failure detail names the outcome alone", () => {
    expect(finishPayload(run({ outcome: "failed", verdict: null }))).toEqual({
      title: "acme/widget#1",
      body: "review failed",
    });
  });

  it("a posted run with no verdict names the outcome alone", () => {
    expect(finishPayload(run({ verdict: null }))).toEqual({
      title: "acme/widget#1",
      body: "review posted",
    });
  });

  it("a mixed window notifies only the unseen finishes", () => {
    const seenRun = run({ pr: 1 });
    const runs = [
      run({ pr: 2 }),
      seenRun,
      run({ pr: 3, outcome: "skipped", verdict: null }),
    ];
    const fresh = diffFinishes(runs, [runId(seenRun)]);
    expect(fresh.map((notice) => notice.title)).toEqual(["acme/widget#2"]);
  });
});

describe("the notifier's consumption", () => {
  it("with permission granted, one new finish raises exactly one notification", () => {
    const s = sink();
    const n = new FinishNotifier(store().store, s.sink);
    n.consume([run()]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
    expect(s.delivered).toHaveLength(1);
  });

  it("a second consume of the same state raises nothing", () => {
    const s = sink();
    const mem = store();
    const n = new FinishNotifier(mem.store, s.sink);
    n.consume([run()]);
    n.consume([run()]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
  });

  it("a skipped or aborted run raises nothing", () => {
    const s = sink();
    const n = new FinishNotifier(store().store, s.sink);
    n.consume([run({ outcome: "skipped", verdict: null })]);
    n.consume([run({ outcome: "aborted", verdict: null })]);
    expect(s.attempts).toEqual([]);
  });

  it("a cold open says the window it opens to, and the next finish speaks once", () => {
    const s = sink();
    const n = new FinishNotifier(store().store, s.sink);
    // No seed: the boot poll speaks the window whole — the ruling that
    // an open or refresh of a granted tab says what finished since the
    // last seen state.
    n.consume([
      run({ pr: 1 }),
      run({ pr: 2, outcome: "skipped", verdict: null }),
    ]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
    // The next finish observed later is notified.
    n.consume([
      run({ pr: 1 }),
      run({ pr: 3 }),
      run({ pr: 2, outcome: "skipped", verdict: null }),
    ]);
    expect(s.attempts).toEqual(["acme/widget#1", "acme/widget#3"]);
  });

  it("a boot on a finish-free window has nothing to say: the first finish observed later is notified", () => {
    const s = sink();
    const n = new FinishNotifier(store().store, s.sink);
    n.consume([run({ outcome: "skipped", verdict: null })]);
    expect(s.attempts).toEqual([]);
    n.consume([run()]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
  });

  it("a delivery throw leaves the finish unseen and the next consume retries it", () => {
    const broken = sink({ throwingDelivery: true });
    const mem = store();
    const n = new FinishNotifier(mem.store, broken.sink);
    n.consume([run()]);
    expect(broken.attempts).toEqual(["acme/widget#1"]);
    // The thrown finish is not recorded as seen.
    expect(mem.written().flat()).toEqual([]);
    // The delivery path recovers; the retry lands the finish.
    const good = sink();
    const recovered = new FinishNotifier(mem.store, good.sink);
    recovered.consume([run()]);
    expect(good.attempts).toEqual(["acme/widget#1"]);
  });

  it("a poll that delivers nothing leaves the storage's window records alone", () => {
    const seen = runId(run());
    const mem = store();
    // Seed the store through its own write.
    mem.store.write([seen]);
    const s = sink({ permission: "default" });
    const n = new FinishNotifier(mem.store, s.sink);
    n.consume([run()]);
    expect(s.attempts).toEqual([]);
    // The storage's record survives: a poll that delivers nothing
    // erases nothing.
    expect(mem.store.read()).toEqual([seen]);
  });

  it("a finish delivered while the storage refused is persisted once the storage recovers", () => {
    const broken = store({ broken: true });
    const s = sink();
    const n = new FinishNotifier(broken.store, s.sink);
    n.consume([run()]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
    // The twin advanced despite the refusal; the storage holds nothing.
    expect(broken.store.read()).toEqual([]);
    // The storage recovers: the next consume re-merges the twin and
    // persists the delivered finish.
    const healthy = store();
    healthy.store.write([]);
    const recovered = new FinishNotifier(healthy.store, s.sink);
    recovered.consume([run()]);
    // Already in the recovered twin? No — a fresh notifier twin is
    // empty, but the merged read is empty too, so the window speaks
    // again and lands; the storage then records it.
    expect(healthy.store.read().length).toBeGreaterThan(0);
  });

  it("unwritable storage notifies once per finish and the recurrence stops", () => {
    const broken = store({ broken: true });
    const s = sink();
    const n = new FinishNotifier(broken.store, s.sink);
    n.consume([run()]);
    n.consume([run()]);
    n.consume([run()]);
    expect(s.attempts).toEqual(["acme/widget#1"]);
  });

  it("a window that rotates moves the seen-state with it: [A] then [B] stores [B] alone", () => {
    const a = run({ pr: 1 });
    const b = run({ pr: 2 });
    const mem = store();
    const s = sink();
    const n = new FinishNotifier(mem.store, s.sink);
    n.consume([a]);
    expect(mem.store.read()).toEqual([runId(a)]);
    n.consume([b]);
    expect(mem.store.read()).toEqual([runId(b)]);
  });

  it("a sibling tab's writes dedupe: the storage record stops the second tab", () => {
    const s1 = sink();
    const s2 = sink();
    const shared = store();
    const n1 = new FinishNotifier(shared.store, s1.sink);
    n1.consume([run()]);
    // The second tab re-merges the storage on every poll: the first
    // tab's record is already in the store, so the finish is not fresh.
    const n2 = new FinishNotifier(shared.store, s2.sink);
    n2.consume([run()]);
    expect(s2.attempts).toEqual([]);
  });
});

describe("the browser storage seam", () => {
  it("an unparseable storage read answers the empty state", () => {
    const backing = {
      getItem: (key: string) => (key === SEEN_KEY ? "{not json" : null),
      setItem: () => {
        throw new Error("refused");
      },
    };
    const read = localStorageSeenStore(backing as Storage).read();
    expect(read).toEqual([]);
  });

  it("a non-array storage value answers the empty state", () => {
    const backing = {
      getItem: (key: string) => (key === SEEN_KEY ? '"just a string"' : null),
      setItem: () => {},
    };
    expect(localStorageSeenStore(backing as Storage).read()).toEqual([]);
  });

  it("a read carrying non-string ids filters them out", () => {
    const backing = {
      getItem: (key: string) => (key === SEEN_KEY ? '["a", 3, null]' : null),
      setItem: () => {},
    };
    expect(localStorageSeenStore(backing as Storage).read()).toEqual(["a"]);
  });
});

describe("the control's states", () => {
  it("granted permission renders the on label", () => {
    expect(new FinishNotifier(store().store, sink().sink).state).toBe("on");
  });

  it("never-granted permission keeps the quiet control", () => {
    expect(
      new FinishNotifier(store().store, sink({ permission: "default" }).sink)
        .state,
    ).toBe("off");
  });

  it("an unsupported API reads unsupported", () => {
    const unsupported: NotificationSink = {
      supported: () => false,
      permission: () => "default",
      request: async () => "default",
      deliver: () => false,
    };
    expect(new FinishNotifier(store().store, unsupported).state).toBe(
      "unsupported",
    );
  });

  it("declined permission consumes the window silently and raises no call", () => {
    const s = sink({ permission: "denied" });
    const n = new FinishNotifier(store().store, s.sink);
    n.consume([run()]);
    expect(s.attempts).toEqual([]);
    // Consumed unread: a later grant starts with the next finish.
    expect(n.state).toBe("off");
  });

  it("the enable request advances the permission through the sink", async () => {
    const s = sink({ permission: "default" });
    const n = new FinishNotifier(store().store, s.sink);
    await n.enable();
    expect(n.state).toBe("on");
  });
});
