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
 * localStorage with a boot-scoped in-memory twin that advances with
 * every delivered finish whether or not the storage accepts the write —
 * a delivered finish notifies at most once per tab life — and re-merges
 * the storage on every poll, so a
 * second open tab dedupes against the first tab's writes even where the
 * Notification tag does not (WebKit parses the tag but does not
 * coalesce by it); the tag stays as belt-and-braces. The run's identity
 * (repo, pull request, start stamp, and the outcome the row carries)
 * rides the tag, so a repeat poll never doubles and a retry that
 * changes the outcome notifies — the 2am failure gets its follow-up
 * when the retry posts.
 *
 * Consumption is delivered-only: the seen-state advances per
 * successfully constructed Notification, not before delivery. A
 * constructor that throws leaves its finish unseen, and the next poll
 * diffs it again and retries — one try per finish per poll, quiet and
 * cheap — so a browser that refuses construction eats nothing and the
 * finish still lands when the browser recovers. Permission that is not
 * granted is different silence, and deliberate: with no delivery path a
 * retry could use, the window is consumed unread, so a later grant
 * starts with the next finish instead of a flood of everything the
 * grant did not cover.
 *
 * There is no cold seed: a first poll with an empty seen-state diffs the
 * current window and says it, at most the ten rows the runs window
 * carries — the operator's ruling, 2026-11-25, that an open or refresh
 * of a granted tab says what finished since the last seen state, so a
 * browser whose localStorage does not persist (private mode, cleared
 * storage) is not silent forever while the control reads "notifications
 * on". The arm/latch pair dissolved with the cold branch: the latch's
 * only job was keeping a first poll from consuming the window as a
 * silent seed, and a first poll that speaks leaves nothing for it to
 * guard — an empty boot window diffs to nothing on its own, and a
 * delivery-dead one re-diffs and retries every poll until the
 * constructor recovers. The storage write-back that bounds the
 * seen-state by the runs window stores the window's finishes the twin
 * holds — delivered this poll, consumed unread for lack of a delivery
 * path, or already recorded by the storage — so a delivered finish
 * whose write the storage refused persists on a later poll, and a poll
 * that delivers nothing erases nothing.
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
 * read it, diff it, and store back the current window's finishes the
 * seen-state holds, which keeps the set bounded by the runs window.
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

  // The tab's own seen-state, boot-scoped: delivered finishes advance
  // it whether or not the storage accepts the write, so each delivered
  // finish notifies at most once per tab life even when localStorage
  // refuses.
  var seen = null;

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

  // Delivers each fresh finish and returns the ids whose Notification
  // constructor succeeded — or null when there is no delivery path at
  // all (no permission, or the API is absent), where the caller
  // consumes the window silently: a declined grant is intentional
  // silence, not a failed delivery.
  function notify(fresh) {
    if (!supported || Notification.permission !== "granted") {
      // No permission, no call: the page renders unchanged.
      return null;
    }
    var delivered = [];
    for (var i = 0; i < fresh.length; i++) {
      try {
        new Notification(fresh[i].title, {
          body: fresh[i].body,
          tag: fresh[i].id,
        });
        delivered.push(fresh[i].id);
      } catch (error) {
        // The constructor failed, so the finish is not consumed: the
        // next poll diffs it again and retries — one try per finish per
        // poll, quiet and cheap — and the finish still lands when the
        // browser recovers.
      }
    }
    return delivered;
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
        // Every successful poll diffs the window against the seen-state
        // and speaks what is missing — the first poll included. There is
        // no cold seed and no arm latch: the old branch existed to keep
        // a first poll from consuming the window as a silent seed, and
        // a first poll that speaks leaves nothing for a latch to guard.
        var fresh = diffFinishes(data.runs, known);
        var delivered = notify(fresh);
        var granted = delivered !== null;
        var deliveredNow = {};
        if (delivered !== null) {
          for (var i = 0; i < delivered.length; i++) {
            deliveredNow[delivered[i]] = true;
          }
        }
        var writeBack = [];
        for (var j = 0; j < data.runs.length; j++) {
          var payload = finishPayload(data.runs[j]);
          if (payload === undefined) {
            continue;
          }
          var id = runId(data.runs[j]);
          // A finish is consumed when its notification delivered — or
          // when there is no delivery path a retry could use (no
          // permission): a constructor failure is neither, and leaves
          // the finish unseen for the next poll to retry.
          var consumed = !granted || deliveredNow[id] === true;
          if (consumed) {
            state[id] = true;
          }
          // Bounded by the runs window, and never a record of an
          // undelivered finish: everything the twin holds is either a
          // record the storage wrote (re-merged on every read) or a
          // finish this tab consumed — delivered, or consumed unread for
          // lack of a delivery path. A delivered finish whose write the
          // storage refused therefore persists on a later poll, and a
          // poll that delivers nothing erases nothing.
          if (state[id] === true) {
            writeBack.push(id);
          }
        }
        writeSeen(writeBack);
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
