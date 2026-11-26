/**
 * The status page's browser notifications (PRJ-502): the diff logic's
 * unit surface, and the served script's own behavior. The script tests
 * run clientScript()'s source through `new Function` with the browser
 * globals injected as parameters and nothing else in scope — no module
 * bindings — so the one-source-of-truth constraint (a shared function
 * references nothing outside its own body except the other shared
 * functions) is enforced by running the script exactly as the browser
 * would: a module-scope reference dies here instead of shipping.
 */

import { describe, expect, it } from "vitest";
import {
  clientScript,
  diffFinishes,
  finishPayload,
  runId,
  SEEN_KEY,
  type NotifyRun,
} from "../src/status-notify.js";

const posted = (over: Partial<NotifyRun> = {}): NotifyRun => ({
  ts: "2026-11-25T12:00:00.000Z",
  repo: "acme/widget",
  pr: 2,
  outcome: "posted",
  verdict: "APPROVE",
  ...over,
});

describe("the finish diff", () => {
  it("a new finish diffs into exactly one notice", () => {
    const fresh = diffFinishes([posted()], []);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual({
      id: "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
      title: "acme/widget#2",
      body: "APPROVE",
    });
  });

  it("a finish the seen-state holds diffs into nothing", () => {
    const run = posted();
    expect(diffFinishes([run], [runId(run)])).toEqual([]);
  });

  it("a second poll of the same state diffs into nothing", () => {
    const runs = [posted(), posted({ pr: 1, verdict: "COMMENT" })];
    const seen = runs.map(runId);
    expect(diffFinishes(runs, seen)).toEqual([]);
  });

  it("a skipped run is not a finish and notifies nobody", () => {
    expect(
      diffFinishes([posted({ outcome: "skipped", verdict: null })], []),
    ).toEqual([]);
  });

  it("an aborted run is not a finish and notifies nobody", () => {
    expect(
      diffFinishes([posted({ outcome: "aborted", verdict: null })], []),
    ).toEqual([]);
  });

  it("a re-settled run whose outcome changed diffs into one new notice", () => {
    // The projection settles a retry in place over the same startedAt,
    // so the row's start stamp never moves; the folded outcome is what
    // makes the recovery a new identity.
    const failed = posted({
      outcome: "failed",
      verdict: null,
      failure: { stage: "blind", message: "the draft never parsed" },
    });
    const recovered = posted({
      ...failed,
      outcome: "posted",
      verdict: "APPROVE",
    });
    expect(diffFinishes([recovered], [runId(failed)])).toEqual([
      {
        id: "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
        title: "acme/widget#2",
        body: "APPROVE",
      },
    ]);
  });

  it("a re-settled run that re-states its outcome diffs into nothing", () => {
    const run = posted();
    expect(diffFinishes([run], [runId(run)])).toEqual([]);
  });

  it("a failed run's notice carries the short reason", () => {
    const fresh = diffFinishes(
      [
        posted({
          outcome: "failed",
          verdict: null,
          failure: { stage: "blind", message: "the draft never parsed" },
        }),
      ],
      [],
    );
    expect(fresh).toEqual([
      {
        id: "acme/widget#2@2026-11-25T12:00:00.000Z@failed",
        title: "acme/widget#2",
        body: "the draft never parsed",
      },
    ]);
  });

  it("a failed run with no failure detail names the outcome alone", () => {
    expect(finishPayload(posted({ outcome: "failed", verdict: null }))).toEqual(
      {
        title: "acme/widget#2",
        body: "review failed",
      },
    );
  });

  it("a posted run with no verdict names the outcome alone", () => {
    expect(finishPayload(posted({ verdict: null }))).toEqual({
      title: "acme/widget#2",
      body: "review posted",
    });
  });

  it("a mixed window notifies only the unseen finishes", () => {
    const seenRun = posted({ pr: 1 });
    const runs = [
      posted(),
      seenRun,
      posted({ pr: 3, outcome: "skipped", verdict: null }),
    ];
    const fresh = diffFinishes(runs, [runId(seenRun)]);
    expect(fresh.map((notice) => notice.title)).toEqual(["acme/widget#2"]);
  });
});

describe("the composed script's bytes", () => {
  it("carries no script closer — a literal one would truncate the inline script in the browser", () => {
    // The sandbox runs the composed source as JavaScript and never as
    // HTML, so nothing else would catch a `</script` riding a future
    // edit: the browser would truncate the inline script there while
    // every suite stays green.
    expect(clientScript()).not.toMatch(/<\/script/i);
  });
});

// ---------------------------------------------------------------------------
// The served script, run as the browser runs it
// ---------------------------------------------------------------------------

interface NoticeCall {
  title: string;
  body?: string;
  tag?: string;
}

/**
 * Run clientScript()'s own source with the browser globals injected as
 * parameters — document, localStorage, Notification, fetch, setInterval
 * — and nothing else in scope. The returned `tick` fires the captured
 * interval (the second and later polls) and waits for the fetch chain
 * to settle.
 */
const serveScript = (opts: {
  permission: "granted" | "denied" | "default" | "unsupported";
  runs: NotifyRun[];
  /** When set, every write throws — the page keeps working anyway. */
  brokenStorage?: boolean;
  /**
   * Seen ids the storage already holds — the last check the diff starts
   * from. Absent: the storage starts empty and the boot poll is a cold
   * open that speaks the window whole.
   */
  seedSeen?: string[];
  /** When set, every Notification constructor call throws. */
  throwingDelivery?: boolean;
  /**
   * When set, requestPermission takes the deprecated callback form and
   * returns undefined — Safari 7-14's shape; the thenable guard on the
   * click must not throw there.
   */
  callbackOnlyPermission?: boolean;
}) => {
  const constructed: NoticeCall[] = [];
  /** Every constructor invocation, landed or thrown. */
  const attempts: string[] = [];
  const store = new Map<string, string>();
  if (opts.seedSeen !== undefined) {
    store.set(SEEN_KEY, JSON.stringify(opts.seedSeen));
  }
  let removed = false;
  const control = {
    textContent: "",
    remove: () => {
      removed = true;
    },
    appendChild: () => {},
  };
  // The control's click handler, captured from the button the script
  // builds — the click flow's observable surface.
  let clickHandler: (() => void) | undefined;
  const documentStub = {
    getElementById: () => control,
    createElement: () => ({
      textContent: "",
      addEventListener: (_kind: string, handler: () => void) => {
        clickHandler = handler;
      },
    }),
  };
  let storageBroken = opts.brokenStorage === true;
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageBroken) {
        throw new Error("storage refused");
      }
      store.set(key, value);
    },
  };
  // The permission state is live: a requestPermission call flips it to
  // granted the way a real browser's prompt does, so a re-render after
  // the grant reads the granted state.
  let permission =
    opts.permission === "unsupported" ? undefined : opts.permission;
  const requestPermission =
    opts.callbackOnlyPermission === true
      ? (callback: (state: string) => void) => {
          // Safari 7-14's deprecated callback form: the state arrives
          // through the callback and the return is undefined.
          permission = "granted";
          callback(permission);
          return undefined;
        }
      : (): Promise<string> =>
          Promise.resolve("granted").then((state) => {
            permission = state;
            return state;
          });
  // The delivery path can be broken live: when broken, every
  // constructor call throws, but the attempt is still counted so the
  // loop's behavior stays observable — including the recovery.
  let deliveryBroken = opts.throwingDelivery === true;
  class Notification {
    readonly title: string;
    readonly options: { body?: string; tag?: string };
    constructor(title: string, options: { body?: string; tag?: string } = {}) {
      attempts.push(title);
      if (deliveryBroken) {
        throw new Error("the delivery path is dead");
      }
      this.title = title;
      this.options = options;
      constructed.push({ title, ...options });
    }
    static get permission() {
      return permission;
    }
    static requestPermission = requestPermission;
  }
  let interval: (() => void) | undefined;
  // The served window: mutable, so a test can move it between polls the
  // way the real /status answer moves as runs settle and rotate.
  let served = opts.runs;
  const boot = new Function(
    "document",
    "localStorage",
    "Notification",
    "fetch",
    "setInterval",
    clientScript(),
  );
  boot(
    documentStub,
    storage,
    opts.permission === "unsupported" ? undefined : Notification,
    () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ runs: served }),
      }),
    (fn: () => void, _ms: unknown) => {
      interval = fn;
      return 1;
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    constructed,
    attempts,
    control,
    removed: () => removed,
    seen: () => store.get(SEEN_KEY),
    /** Serve a different runs window from the next poll on. */
    setRuns: (next: NotifyRun[]) => {
      served = next;
    },
    /** Break or restore the Notification constructor between polls. */
    setDeliveryBroken: (broken: boolean) => {
      deliveryBroken = broken;
    },
    /** Break or restore the storage's writes between polls. */
    setStorageBroken: (broken: boolean) => {
      storageBroken = broken;
    },
    /** The control button's click, with the fetch chain settled after. */
    clickControl: async () => {
      clickHandler?.();
      await settle();
    },
    tick: async () => {
      interval?.();
      await settle();
    },
    settle,
  };
};

describe("the served script", () => {
  // The seen-state these tests pre-seed is the last check the diff
  // starts from. No seed means the boot poll is a cold open: with the
  // seen-state empty, the window it opens to is spoken whole — a test
  // wanting a quiet boot poll needs a seed.
  const lastCheck = "acme/widget#9@2026-11-01T00:00:00.000Z@posted";

  it("with permission granted, one new finish raises exactly one notification", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted()],
      seedSeen: [lastCheck],
    });
    await page.settle();
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]).toEqual({
      title: "acme/widget#2",
      body: "APPROVE",
      tag: "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
    });
  });

  it("a second poll of the same state raises nothing", async () => {
    const run = posted();
    const page = serveScript({
      permission: "granted",
      runs: [run],
      seedSeen: [runId(run)],
    });
    await page.settle();
    const afterFirst = page.attempts.length;
    await page.tick();
    expect(page.attempts).toHaveLength(afterFirst);
    // The seen-state now holds the run, so a later poll stays quiet even
    // after the run leaves and re-enters the served window unchanged.
    await page.tick();
    expect(page.attempts).toHaveLength(afterFirst);
  });

  it("a skipped run raises nothing", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted({ outcome: "skipped", verdict: null })],
      seedSeen: [lastCheck],
    });
    await page.settle();
    expect(page.constructed).toEqual([]);
  });

  it("an aborted run raises nothing", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted({ outcome: "aborted", verdict: null })],
      seedSeen: [lastCheck],
    });
    await page.settle();
    expect(page.constructed).toEqual([]);
  });

  it("a cold open says the window it opens to, and the next finish speaks once", async () => {
    // Empty storage: no last check exists, and the boot poll says the
    // window anyway — the operator's ruling, 2026-11-25: an open or
    // refresh says what finished since the last seen state, so a
    // browser whose storage does not persist is not silent forever.
    const first = posted();
    const page = serveScript({ permission: "granted", runs: [first] });
    await page.settle();
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]).toEqual({
      title: "acme/widget#2",
      body: "APPROVE",
      tag: runId(first),
    });

    // The next finish — a new identity — speaks once.
    const second = posted({ pr: 4 });
    page.setRuns([second]);
    await page.tick();
    expect(page.constructed).toHaveLength(2);
    expect(page.constructed[1]).toEqual({
      title: "acme/widget#4",
      body: "APPROVE",
      tag: runId(second),
    });
  });

  it("a boot on a finish-free window has nothing to say: the first finish observed later is notified", async () => {
    // The fresh deployment's "No runs yet." page: the boot window holds
    // no finishes, so the cold open has nothing to say — and the first
    // finish observed afterwards speaks on its own poll, no seed to be
    // consumed by.
    const page = serveScript({ permission: "granted", runs: [] });
    await page.settle();
    expect(page.constructed).toEqual([]);

    const first = posted();
    page.setRuns([first]);
    await page.tick();
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]?.tag).toBe(runId(first));
  });

  it("a boot on a window of only skipped rows stays quiet: the first finish observed later is notified", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted({ outcome: "skipped", verdict: null })],
    });
    await page.settle();
    expect(page.constructed).toEqual([]);

    const first = posted();
    page.setRuns([first]);
    await page.tick();
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]?.tag).toBe(runId(first));
  });

  it("the enable click advances the control through the promise form", async () => {
    const page = serveScript({ permission: "default", runs: [] });
    await page.settle();
    expect(page.control.textContent).toBe("");

    await page.clickControl();
    expect(page.control.textContent).toBe("notifications on");
  });

  it("the enable click advances the control through the callback form without throwing", async () => {
    // Safari 7-14's deprecated callback form returns undefined; the
    // thenable guard must not .then on it, and the callback the script
    // passes advances the state instead.
    const page = serveScript({
      permission: "default",
      runs: [],
      callbackOnlyPermission: true,
    });
    await page.settle();
    expect(page.control.textContent).toBe("");

    await page.clickControl();
    expect(page.control.textContent).toBe("notifications on");
  });

  it("a delivery throw leaves the finish unseen and the next poll retries it", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted(), posted({ pr: 3 })],
      seedSeen: [lastCheck],
      throwingDelivery: true,
    });
    await page.settle();
    // One attempt per finish, nothing delivered, nothing consumed.
    expect(page.attempts).toHaveLength(2);
    expect(page.constructed).toEqual([]);
    // The next poll diffs the same finishes again: one try per finish
    // per poll, and the retries are quiet — no throw escapes the poll.
    await page.tick();
    expect(page.attempts).toHaveLength(4);
    expect(page.constructed).toEqual([]);
    // When the browser recovers, the finishes land.
    page.setDeliveryBroken(false);
    await page.tick();
    expect(page.attempts).toHaveLength(6);
    expect(page.constructed).toHaveLength(2);
    expect(page.constructed[0]?.tag).toBe(
      "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
    );
    expect(page.constructed[1]?.tag).toBe(
      "acme/widget#3@2026-11-25T12:00:00.000Z@posted",
    );
    // Delivered now: the seen-state holds them and the loop goes quiet.
    await page.tick();
    expect(page.attempts).toHaveLength(6);
    expect(page.constructed).toHaveLength(2);
    // The control still reads its granted state — the page swears it is
    // listening, and the loop lived through the dead delivery path.
    expect(page.control.textContent).toBe("notifications on");
  });

  it("a poll that delivers nothing leaves the storage's window records alone", async () => {
    const run = posted();
    const page = serveScript({
      permission: "granted",
      runs: [run],
      seedSeen: [runId(run)],
    });
    await page.settle();
    // Nothing fresh, nothing delivered: the write-back must not erase
    // the window record the storage already holds — a second open tab
    // diffs against it.
    expect(page.seen()).toEqual(JSON.stringify([runId(run)]));
    await page.tick();
    expect(page.seen()).toEqual(JSON.stringify([runId(run)]));
  });

  it("a thrown finish is not recorded as seen", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted()],
      seedSeen: [lastCheck],
      throwingDelivery: true,
    });
    await page.settle();
    expect(page.attempts).toHaveLength(1);
    expect(page.seen()).not.toContain(runId(posted()));
  });

  it("a finish delivered while the storage refused is persisted once the storage recovers", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted()],
      seedSeen: [lastCheck],
      brokenStorage: true,
    });
    await page.settle();
    expect(page.constructed).toHaveLength(1);
    // The write landed nowhere: the storage still holds only the seed,
    // while the twin holds the delivered record.
    expect(page.seen()).toEqual(JSON.stringify([lastCheck]));

    // The storage recovers: the next poll persists the twin's delivered
    // record, though the finish diffs nothing fresh anymore — the
    // record never rides on a fresh diff to be written.
    page.setStorageBroken(false);
    await page.tick();
    expect(page.seen()).toEqual(JSON.stringify([runId(posted())]));
    expect(page.constructed).toHaveLength(1);
  });

  it("unwritable storage notifies once per finish and the recurrence stops", async () => {
    const page = serveScript({
      permission: "granted",
      runs: [posted()],
      seedSeen: [lastCheck],
      brokenStorage: true,
    });
    await page.settle();
    expect(page.constructed).toHaveLength(1);
    // The in-memory twin advanced with the write refused: the second
    // poll of the same window re-raises nothing.
    await page.tick();
    expect(page.constructed).toHaveLength(1);
    // The next new finish still speaks, still once, storage still broken.
    page.setRuns([posted({ pr: 3 })]);
    await page.tick();
    expect(page.constructed).toHaveLength(2);
    await page.tick();
    expect(page.constructed).toHaveLength(2);
  });

  it("declined permission raises no call and the control leaves the page", async () => {
    const page = serveScript({ permission: "denied", runs: [posted()] });
    await page.settle();
    expect(page.constructed).toEqual([]);
    expect(page.removed()).toBe(true);
    // The seen-state still advances: a later grant starts with the next
    // finish, not a flood of every finish the decline covered.
    expect(page.seen()).toContain(
      "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
    );
  });

  it("never-granted permission raises no call and keeps the quiet control", async () => {
    const page = serveScript({ permission: "default", runs: [posted()] });
    await page.settle();
    expect(page.constructed).toEqual([]);
    expect(page.removed()).toBe(false);
  });

  it("an unsupported Notification API raises no call and touches nothing", async () => {
    const page = serveScript({ permission: "unsupported", runs: [posted()] });
    await page.settle();
    expect(page.constructed).toEqual([]);
    expect(page.removed()).toBe(false);
  });

  it("granted permission renders the control as the on label", async () => {
    const page = serveScript({ permission: "granted", runs: [] });
    await page.settle();
    expect(page.control.textContent).toBe("notifications on");
  });
});

describe("the seen-state across polls", () => {
  it("a window that rotates moves the seen-state with it: [A] then [B] stores [B] alone", async () => {
    const first = posted({ pr: 1, verdict: "COMMENT" });
    const second = posted({ pr: 2 });
    const page = serveScript({ permission: "granted", runs: [first] });
    await page.settle();
    // The cold open says the window: [A] speaks, then is consumed.
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]?.tag).toBe(runId(first));

    // The first run leaves the served window (the projection's window
    // is the ten newest rows), the second arrives: the stored seen-state
    // prunes to the current window alone, bounded by it, and the new
    // finish speaks.
    page.setRuns([second]);
    await page.tick();
    expect(page.constructed).toHaveLength(2);
    expect(page.constructed[1]?.tag).toBe(runId(second));
    expect(page.seen()).toEqual(JSON.stringify([runId(second)]));
  });

  it("a re-settled run whose outcome changed raises the follow-up with the new identity", async () => {
    const failed = posted({
      outcome: "failed",
      verdict: null,
      failure: { stage: "blind", message: "the draft never parsed" },
    });
    const recovered = { ...failed, outcome: "posted", verdict: "APPROVE" };
    const page = serveScript({
      permission: "granted",
      runs: [failed],
      seedSeen: ["acme/widget#9@2026-11-01T00:00:00.000Z@posted"],
    });
    await page.settle();
    expect(page.constructed).toHaveLength(1);
    expect(page.constructed[0]).toEqual({
      title: "acme/widget#2",
      body: "the draft never parsed",
      tag: "acme/widget#2@2026-11-25T12:00:00.000Z@failed",
    });

    // The retry settles in place — same start stamp, new outcome. The
    // folded identity misses the seen-state, so the recovery speaks
    // once, and the seen-state now holds only the outcome the row
    // carries now.
    page.setRuns([recovered]);
    await page.tick();
    expect(page.constructed).toHaveLength(2);
    expect(page.constructed[1]).toEqual({
      title: "acme/widget#2",
      body: "APPROVE",
      tag: "acme/widget#2@2026-11-25T12:00:00.000Z@posted",
    });
    expect(page.seen()).toEqual(JSON.stringify([runId(recovered)]));
  });

  it("a re-settled run that re-states its outcome raises nothing", async () => {
    const run = posted();
    const page = serveScript({
      permission: "granted",
      runs: [run],
      seedSeen: ["acme/widget#9@2026-11-01T00:00:00.000Z@posted"],
    });
    await page.settle();
    expect(page.constructed).toHaveLength(1);

    // The same outcome settles again over the same start stamp: the
    // identity holds, the seen-state has it, and no notification fires.
    page.setRuns([run]);
    await page.tick();
    expect(page.constructed).toHaveLength(1);
  });
});
