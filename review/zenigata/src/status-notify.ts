/**
 * The status page's browser notifications (PRJ-502): the finished-review
 * diff the page's inline script serves, and the script itself.
 *
 * While the page is open, its script polls /status on an interval and
 * each review run that finished since the last check — posted with its
 * verdict, or failed with its short reason — raises one browser
 * Notification. Skipped and aborted runs are not finishes (they posted
 * nothing and did not fail) and notify nobody. Permission is requested
 * through the page's own control in the footer — browsers require a user
 * gesture for the prompt — and a declined grant changes nothing: the
 * page keeps working, silently. The seen-state lives in the browser's
 * localStorage with a boot-scoped in-memory twin that advances whether
 * or not the storage accepts the write — each finish notifies at most
 * once per tab life — and re-merges the storage on every poll, so a
 * second open tab dedupes against the first tab's writes even where the
 * Notification tag does not (WebKit parses the tag but does not
 * coalesce by it); the tag stays as belt-and-braces. The run's identity
 * (repo, pull request, start stamp, and the outcome the row carries)
 * rides the tag, so a repeat poll never doubles and a retry that
 * changes the outcome notifies — the 2am failure gets its follow-up
 * when the retry posts.
 *
 * Delivery is best-effort per finish: a constructor that throws is
 * caught and the finish is consumed — the delivery path being dead is a
 * page-level condition, not a per-run retry — so a broken browser never
 * loops while the control reads its granted state. A cold start — an
 * empty seen-state at the first successful poll — has no last check to
 * diff against: the current window seeds silently and notifications
 * begin with the next finish, the same shape the declined path gives a
 * later grant. The branch latches on the first successful poll and is
 * never recomputed, so a boot window without finishes arms the state
 * instead of letting the first finish observed later die as a seed. The
 * choice is deliberate; an operator who wants the page's opening window
 * read aloud can flip the cold branch to notify.
 *
 * Delivery is tab-open only, by ruling: the browser's own Notification
 * API, no service worker, no Web Push, no push subscription. Closing the
 * tab stops the notifications — that is the accepted shape, not a
 * defect.
 *
 * One source of truth: the served script composes the shared diff
 * functions from their own serialized sources, so the logic the tests
 * cover is literally the logic the browser runs. The price is a
 * constraint the suite enforces: a shared function may reference nothing
 * outside its own body except the other shared functions — the browser
 * scope holds nothing else. The suite runs the served script's own
 * source with no module bindings, so a module-scope reference dies in
 * the test instead of shipping.
 */

/** The run rows /status serves; the fields the diff reads (RunView's shape). */
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
  /** The run's stable identity — the Notification tag and the seen key. */
  id: string;
  title: string;
  body: string;
}

/** The localStorage key the seen-state lives under. */
export const SEEN_KEY = "zenigata.seenFinishes";

/**
 * The poll interval. Reviews finish over minutes — the config's own
 * timeouts are minute-scale — so 30 seconds puts the worst-case
 * notification delay far inside a run's own length, and the read is one
 * loopback GET of at most ten rows. When the tab is hidden, browsers
 * clamp timers to about a minute anyway, which only stretches the delay
 * by 30 seconds in the state where notifications matter most.
 */
export const POLL_MS = 30_000;

/**
 * The run's identity: repo, pull request, the run's start stamp, and the
 * outcome the row now carries. The projection settles a retry in place —
 * a re-settle never moves the start stamp (the upsert's SET clause omits
 * it) and the settled-row guard refuses the re-delivered start record —
 * so the start stamp alone cannot distinguish one settled outcome from
 * its successor, and the outcome folds in. One row therefore carries one
 * identity per outcome it has held: a retry that changes the outcome
 * carries a new identity, misses the seen-state, and notifies — the 2am
 * failure gets its follow-up when the retry posts — while a retry that
 * re-states the same outcome keeps its identity and stays silent.
 */
export function runId(run: NotifyRun): string {
  return run.repo + "#" + run.pr + "@" + run.ts + "@" + run.outcome;
}

/**
 * One finish's notification payload: a posted run's verdict, or a failed
 * run's short reason. Skipped and aborted runs are not finishes — they
 * posted nothing and did not fail — and notify nobody.
 */
export function finishPayload(
  run: NotifyRun,
): { title: string; body: string } | undefined {
  const title = run.repo + "#" + run.pr;
  if (run.outcome === "posted") {
    return {
      title: title,
      body:
        run.verdict === undefined || run.verdict === null
          ? "review posted"
          : run.verdict,
    };
  }
  if (run.outcome === "failed") {
    return {
      title: title,
      body: run.failure === undefined ? "review failed" : run.failure.message,
    };
  }
  return undefined;
}

/**
 * The finishes the seen-state does not hold yet, in the order /status
 * serves them (newest first). Pure: the caller owns the seen-state —
 * read it, diff it, and store back the union of the current window's
 * finish ids and the fresh ones, which keeps the set bounded by the
 * runs window.
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
      fresh.push({ id: id, title: payload.title, body: payload.body });
    }
  }
  return fresh;
}

/**
 * The page's inline script source. The three shared functions above ride
 * in as their own serialized sources — the markers split them from the
 * browser-only orchestration, and the suite's sandbox run evaluates the
 * first block with no module bindings to hold the one-source-of-truth
 * constraint.
 *
 * The orchestration is deliberately written to the oldest common script
 * dialect (no template literals, no arrow functions): it sits inside a
 * page whose register is plain markup, and its own text never collides
 * with the composition.
 */
export function clientScript(): string {
  return `"use strict";
// --- the finish diff, composed from this module's own function sources ---
${runId}
${finishPayload}
${diffFinishes}
// --- the page's notification loop ---
(function () {
  var POLL_MS = ${POLL_MS};
  var SEEN_KEY = ${JSON.stringify(SEEN_KEY)};

  // The tab's own seen-state, boot-scoped: it advances whether or not
  // the storage accepts the write, so each finish notifies at most once
  // per tab life even when localStorage refuses.
  var seen = null;
  // The cold branch's one-shot latch: flipped on the first successful
  // poll, never recomputed — a boot window without finishes arms the
  // state instead of letting the first observed finish die as a seed.
  var armed = false;

  function readSeen() {
    if (seen === null) {
      seen = {};
    }
    // The storage re-merges on every poll: another open tab's writes
    // dedupe against this tab even where the Notification tag does not
    // (WebKit parses the tag but does not coalesce by it) — the shared
    // storage is the dedupe that holds.
    try {
      var value = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          if (typeof value[i] === "string") {
            seen[value[i]] = true;
          }
        }
      }
    } catch (error) {
      // An unreadable stored state is ignored: the boot-scoped twin
      // keeps this tab honest on its own.
    }
    return seen;
  }

  function writeSeen(ids) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch (error) {
      // The in-memory set already advanced; the page keeps working when
      // the storage refuses — the seen-state is a preference, not the
      // page's data.
    }
  }

  var control = document.getElementById("notify-control");
  var supported = typeof Notification !== "undefined";

  function renderControl() {
    if (!supported || control === null) {
      return;
    }
    if (Notification.permission === "granted") {
      control.textContent = "notifications on";
    } else if (Notification.permission === "denied") {
      // Declined permission: the page keeps working, silently.
      control.remove();
    } else {
      var button = document.createElement("button");
      button.textContent = "enable notifications";
      button.addEventListener("click", function () {
        var request = Notification.requestPermission(function (state) {
          renderControl();
        });
        // The promise form returns a thenable (Safari 15+, Chrome,
        // Firefox); Safari 7-14 supported only the deprecated callback
        // form and returns undefined, where the callback above has
        // already advanced the state. The thenable check guards the
        // .then, so the click advances the control on both forms.
        if (request && typeof request.then === "function") {
          request.then(renderControl);
        }
      });
      control.textContent = "";
      control.appendChild(button);
    }
  }
  renderControl();

  function notify(fresh) {
    if (!supported || Notification.permission !== "granted") {
      // No permission, no call: the page renders unchanged.
      return;
    }
    for (var i = 0; i < fresh.length; i++) {
      try {
        new Notification(fresh[i].title, {
          body: fresh[i].body,
          tag: fresh[i].id,
        });
      } catch (error) {
        // The delivery path being dead is a page-level condition, not a
        // per-run retry: the finish is consumed, and no later poll
        // re-raises it.
      }
    }
  }

  function poll() {
    fetch("/status", { headers: { accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) {
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (data === null || !Array.isArray(data.runs)) {
          return;
        }
        var state = readSeen();
        var known = Object.keys(state);
        // The cold branch latches on the first successful poll and is
        // never recomputed: a boot window with finishes seeds silently,
        // and a boot window without finishes arms the state instead, so
        // the first finish observed afterwards speaks rather than being
        // consumed as a seed that never was.
        var cold = !armed && known.length === 0;
        var fresh = cold ? [] : diffFinishes(data.runs, known);
        var current = [];
        for (var i = 0; i < data.runs.length; i++) {
          if (finishPayload(data.runs[i]) !== undefined) {
            var id = runId(data.runs[i]);
            current.push(id);
            // The seen-state advances before the delivery: a finish is
            // consumed whether or not its notification lands.
            state[id] = true;
          }
        }
        if (!cold) {
          notify(fresh);
        }
        // Every fresh id is already a current-window id: the write-back
        // stores the window's finish identities, which keeps the
        // seen-state bounded by the runs window.
        writeSeen(current);
        armed = true;
      })
      .catch(function () {
        // A failed poll leaves the page as it is; the next one retries.
      });
  }

  poll();
  setInterval(poll, POLL_MS);
})();
`;
}
