/**
 * The finished-review notifications (PRJ-502): the finish diff and the
 * notifier that delivers it. On each page poll the notifier diffs the
 * runs window against the seen-state and delivers each fresh finish —
 * a posted run with its verdict, or a failed run with its short reason.
 * Skipped and aborted runs are not finishes: they posted nothing and
 * did not fail, and notify nobody.
 *
 * The seen-state lives in the browser's localStorage with a boot-scoped
 * in-memory twin that advances with every delivered finish whether or
 * not the storage accepts the write, and re-merges the storage on every
 * poll, so a second open tab dedupes against the first tab's writes
 * even where the Notification tag does not (WebKit parses the tag but
 * does not coalesce by it); the tag stays as belt-and-braces. The run's
 * identity (repo, pull request, start stamp, and the outcome the row
 * carries) rides the id, so a repeat poll never doubles and a retry
 * that changes the outcome notifies.
 *
 * Consumption is delivered-only: the seen-state advances per
 * successfully delivered notification, not before delivery. A delivery
 * that throws leaves its finish unseen, and the next poll diffs it
 * again and retries — so a browser that refuses construction eats
 * nothing and the finish still lands when the browser recovers.
 * Permission that is not granted is different silence, and deliberate:
 * with no delivery path a retry could use, the window is consumed
 * unread, so a later grant starts with the next finish instead of a
 * flood of everything the grant did not cover.
 *
 * There is no cold seed: a first poll with an empty seen-state diffs
 * the current window and speaks it, at most the ten rows the runs
 * window carries — an open or refresh of a granted tab says what
 * finished since the last seen state, so a browser whose localStorage
 * does not persist is not silent forever while the control reads
 * "notifications on". Delivery is tab-open only: closing the tab stops
 * the notifications — that is the accepted shape, not a defect.
 */

/** The run rows /page serves; the fields the diff reads. */
export interface NotifyRun {
  ts: string;
  repo: string;
  pr: number;
  outcome: string;
  verdict: string | null;
  failure?: { stage: string; message: string };
}

/** One run's finish notice: the payload one Notification carries. */
export interface FinishNotice {
  id: string;
  title: string;
  body: string;
}

/** The seen-state's storage seam: localStorage in the browser, fakes in tests. */
export interface SeenStore {
  read(): string[];
  write(ids: string[]): void;
}

/**
 * The browser notification surface, as the notifier uses it. A grant
 * check gates delivery; the request rides the page's own control
 * (browsers require a user gesture for the prompt). deliver() answers
 * false when the constructor threw — the finish is not consumed, and
 * the next poll retries it.
 */
export interface NotificationSink {
  permission(): "granted" | "denied" | "default";
  request(): Promise<"granted" | "denied" | "default">;
  deliver(notice: FinishNotice): boolean;
  supported(): boolean;
}

/**
 * The run's identity: repo, pull request, the run's start stamp, and the
 * outcome the row now carries. The projection settles a retry in place —
 * a re-settle never moves the start stamp — so the start stamp alone
 * cannot distinguish one settled outcome from its successor, and the
 * outcome folds in. One row therefore carries one identity per outcome
 * it has held: a retry that changes the outcome carries a new identity,
 * misses the seen-state, and notifies — the 2am failure gets its
 * follow-up when the retry posts — while a retry that re-states the
 * same outcome keeps its identity and stays silent.
 */
export function runId(run: NotifyRun): string {
  return `${run.repo}#${run.pr}@${run.ts}@${run.outcome}`;
}

/**
 * One finish's notification payload: a posted run's verdict, or a failed
 * run's short reason. Skipped and aborted runs are not finishes — they
 * posted nothing and did not fail — and notify nobody.
 */
export function finishPayload(
  run: NotifyRun,
): { title: string; body: string } | undefined {
  const title = `${run.repo}#${run.pr}`;
  if (run.outcome === "posted") {
    return {
      title,
      body:
        run.verdict === undefined || run.verdict === null
          ? "review posted"
          : run.verdict,
    };
  }
  if (run.outcome === "failed") {
    return {
      title,
      body: run.failure === undefined ? "review failed" : run.failure.message,
    };
  }
  return undefined;
}

/**
 * The finishes the seen-state does not hold yet, in the order /page
 * serves them (newest first). Pure: the caller owns the seen-state.
 */
export function diffFinishes(
  runs: NotifyRun[],
  seen: string[],
): FinishNotice[] {
  const known = new Set(seen);
  const fresh: FinishNotice[] = [];
  for (const run of runs) {
    const payload = finishPayload(run);
    if (payload === undefined) {
      continue;
    }
    const id = runId(run);
    if (!known.has(id)) {
      fresh.push({ id, title: payload.title, body: payload.body });
    }
  }
  return fresh;
}

/**
 * The browser's localStorage seen-state: the key holds the ids of the
 * finishes the tab (or a sibling) consumed. A read that throws (or a
 * storage that will not parse) answers the empty state; a write that
 * throws is swallowed by the caller's twin, which advances anyway.
 */
export const localStorageSeenStore = (storage: Storage): SeenStore => ({
  read: () => {
    try {
      const raw = storage.getItem(SEEN_KEY);
      if (raw === null) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  },
  write: (ids) => {
    try {
      storage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch {
      // The twin already advanced; a refusing storage catches up on a
      // later poll's re-merge.
    }
  },
});

/** The localStorage key the seen-state lives under. */
export const SEEN_KEY = "zenigata.seenFinishes";

/**
 * The poll interval. Reviews finish over minutes — the config's own
 * timeouts are minute-scale — so 30 seconds puts the worst-case
 * notification delay far inside a run's own length, and the read is one
 * loopback GET of at most ten rows.
 */
export const POLL_MS = 30_000;

/**
 * One poll's finish consumption: diff, deliver, and advance the
 * seen-state. The state the poll writes back is bounded by the runs
 * window and never a record of an undelivered finish: everything the
 * twin holds is either a record the storage wrote (re-merged on every
 * read) or a finish this tab consumed — delivered, or consumed unread
 * for lack of a delivery path. A delivered finish whose write the
 * storage refused therefore persists on a later poll, and a poll that
 * delivers nothing erases nothing.
 */
export class FinishNotifier {
  /** The boot-scoped twin: advances even when the storage refuses. */
  private readonly twin = new Set<string>();

  constructor(
    private readonly store: SeenStore,
    private readonly sink: NotificationSink,
  ) {}

  /** The control's label state: what the page's footer button offers. */
  get state(): "on" | "off" | "unsupported" {
    if (!this.sink.supported()) {
      return "unsupported";
    }
    return this.sink.permission() === "granted" ? "on" : "off";
  }

  /** The footer control's request: the user gesture the prompt needs. */
  async enable(): Promise<void> {
    await this.sink.request();
  }

  consume(runs: NotifyRun[]): void {
    // Every poll re-merges the storage: a sibling tab's writes dedupe
    // here, and a storage that refused an earlier write catches up.
    const merged = new Set([...this.store.read(), ...this.twin]);
    const fresh = diffFinishes(runs, [...merged]);
    const granted =
      this.sink.supported() && this.sink.permission() === "granted";
    for (const notice of fresh) {
      // Delivered-only consumption: a delivery that throws or answers
      // false leaves the finish unseen, and the next poll retries it.
      // No permission is intentional silence — the window is consumed
      // unread, so a later grant starts with the next finish instead of
      // a flood.
      let delivered = false;
      if (granted) {
        try {
          delivered = this.sink.deliver(notice);
        } catch {
          delivered = false;
        }
      }
      if (!granted || delivered) {
        this.twin.add(notice.id);
      }
    }
    // Bounded by the runs window, and never a record of an undelivered
    // finish: everything written back is either a record the storage
    // wrote (re-merged above) or a finish this tab consumed —
    // delivered, or consumed unread for lack of a delivery path. A
    // delivered finish whose write the storage refused persists on a
    // later poll, and a poll that delivers nothing erases nothing.
    const finishIds = new Set(
      runs.flatMap((run) =>
        finishPayload(run) === undefined ? [] : [runId(run)],
      ),
    );
    try {
      this.store.write(
        [...new Set([...merged, ...this.twin])].filter((id) =>
          finishIds.has(id),
        ),
      );
    } catch {
      // The twin already advanced; a refusing storage catches up on a
      // later poll's re-merge. The write's failure changes nothing the
      // page shows.
    }
  }
}
