// The PR-state projection (PRJ-406) and its forge_state tool: per watched
// repo, the poll pass walks the open-PR list, reads the reviews per open
// PR and the commit statuses per head sha, and maps the validated answers
// into a local SQLite database — a pure mirror, every row stamped with
// its syncedAt. One entity per table composes the projection
// (projection.js with pr-state.js, review-log.js and ci-log.js beside
// the entry in the shipped directory): the sync writes through the
// entity classes, forge_state reads their boards, and the zod schemas
// validate at each entity's forge boundary. The pass's reads are shared
// with the pr-reviews wakes through a per-pass memo, so a repo whose
// reviews a wake already read this pass costs the projection nothing.
//
// This module is the projection's wiring: the database holder (opened on
// first use, retried each pass), the open-PR list walk, the per-repo
// sync and its sweep, and the kernel's afterPass stage. The composer
// hands it the REST reads and the kernel accessor.

import { openProjectionDb } from "./projection.js";
import { parsePullList } from "./pr-state.js";
import {
  parsePullRecord,
  prLifecycle,
  REVIEWS_PER_READ,
} from "./forgejo-source.ts";

// The open-PR list walk's page: the size the walk asks for. The page
// that comes back may be smaller — the forge's own page size governs —
// which is why the walk ends on an EMPTY page, never a short one.
const PRS_PER_READ = 50;
const PR_LIST_PAGES = 10;
// The commit-status read's page (the deployed route's own maximum).
const STATUS_PER_READ = 50;

export const createProjectionSync = ({
  reads: { prListPage, prRecord, reviewsOf, commitStatuses },
  debug,
  dbPath,
  getKernel,
}) => {
  // The projection's database, opened on first use and retried each pass
  // when the file cannot be opened — a projection failure costs the sync,
  // never the watches. A composer whose rollback failed has closed its
  // file (a stranded transaction would fail every later write): it is
  // replaced by a fresh open on the next use.
  let projection = null;
  const projectionDb = () => {
    if (projection !== null && !projection.usable) projection = null;
    return (projection ??= openProjectionDb(dbPath));
  };

  // The projection sync for one watched repo, run after the watches each
  // pass: the repo's open-PR list (walked to its empty page), then the
  // reviews per open PR and the commit statuses per head sha — every
  // read through the per-pass memo, so a read a wake already made is not
  // made twice. The sweep then gives every open row the list did not
  // name a direct word from the forge. The answers go to the projection
  // whole; whatever failed to read or to validate comes back as a
  // reason, logged when it changes and retried on the next pass.
  const lastSyncReasons = new Map();
  const noteSync = (repo, reasons) => {
    const why = reasons.join("; ");
    if (!reasons.length) {
      if (lastSyncReasons.delete(repo)) {
        debug("projection.synced", { repo });
      }
      return;
    }
    if (lastSyncReasons.get(repo) !== why) {
      lastSyncReasons.set(repo, why);
      console.error(
        `[forgejo-watcher] the pr-state projection for ${repo} keeps its rows: ${why}`,
      );
    }
  };

  // The open-PR list walk: pages of the repo's PR list until the forge
  // says the list ended. The end's proof is the EMPTY page: a forge may
  // serve fewer rows than the limit asked — its own page size governs
  // the answer — so a short page proves nothing and the walk reads once
  // more; the empty answer is the one size-independent end (review 283;
  // the cost is one extra read per walk). Completeness is what the
  // sweep's per-PR checks stand on — the walk refuses (complete: false,
  // with the reason) whenever it cannot prove the list ended: a page
  // that brings nothing new (a pager that does not advance), or the
  // page cap.
  const walkOpenPrs = async (owner, name) => {
    const open = [];
    const seen = new Set();
    let dropped = 0;
    for (let page = 1; page <= PR_LIST_PAGES; page += 1) {
      let data;
      try {
        data = await prListPage(owner, name, page, PRS_PER_READ);
      } catch (error) {
        return {
          complete: false,
          why: `the open-pr list read failed on page ${page}: ${error?.message ?? error}`,
        };
      }
      const parsed = parsePullList(data);
      if (!parsed) {
        return {
          complete: false,
          why: "the open-pr list answer did not parse as a pull-request list",
        };
      }
      dropped += parsed.dropped;
      let fresh = 0;
      for (const identity of parsed.seen) {
        if (!seen.has(identity)) {
          seen.add(identity);
          fresh += 1;
        }
      }
      for (const row of parsed.open) open.push(row);
      // The empty page: the list's own end, whatever the page size.
      if (parsed.seen.length + parsed.dropped === 0) {
        return { complete: true, open, dropped };
      }
      if (fresh === 0) {
        return {
          complete: false,
          why: `the open-pr list answered page ${page} with nothing new; the pass cannot walk further, so the repo keeps its rows`,
        };
      }
    }
    return {
      complete: false,
      why: `the open-pr list runs past ${PR_LIST_PAGES} pages; the pass reads no further, so the repo keeps its rows`,
    };
  };

  const syncRepo = async (repo, memo) => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return;
    const reasons = [];

    // The open-PR list: walked to its end, because a page applied as the
    // whole open set would let the sweep retire rows the walk could not
    // see. The walk carries `state=open` on the wire — verified live
    // 2026-11-18 against the deployed route (x-total-count answers the
    // open set, not every PR ever) — so the walk's budget scales with
    // open PRs, not history, and its empty-page end plus the sweep's
    // per-PR words keep a wrongful answer from costing a row. A page
    // that fills without an end in sight — the cap, a page bringing
    // nothing new — refuses the write, and the repo's rows keep theirs.
    // `open` stays null when the walk refused: the projection replaces
    // nothing of the repo's board, and the sweep skips entirely (the
    // forge's word per un-named PR cannot be had from a repo this pass
    // cannot read).
    let open = null;
    try {
      const walked = await walkOpenPrs(owner, name);
      if (walked.complete) {
        open = walked.open;
        if (walked.dropped) {
          debug("projection.prs.dropped", {
            repo,
            dropped: walked.dropped,
          });
        }
      } else {
        reasons.push(walked.why);
      }
    } catch (error) {
      reasons.push(`the open-pr list read failed: ${error?.message ?? error}`);
    }

    // Reviews per open PR, and commit statuses per distinct head sha:
    // each read once per pass, shared with the wakes through the memo.
    const reviewAnswers = new Map();
    for (const row of open ?? []) {
      const key = `reviews ${repo} ${row.pr}`;
      if (!memo.has(key)) {
        try {
          memo.set(key, await reviewsOf(owner, name, row.pr, REVIEWS_PER_READ));
        } catch {
          memo.set(key, null);
        }
      }
      reviewAnswers.set(row.pr, memo.get(key));
    }
    const statusAnswers = new Map();
    for (const sha of new Set((open ?? []).map((row) => row.headSha))) {
      const key = `statuses ${repo} ${sha}`;
      if (!memo.has(key)) {
        try {
          memo.set(
            key,
            await commitStatuses(owner, name, sha, STATUS_PER_READ),
          );
        } catch {
          memo.set(key, null);
        }
      }
      statusAnswers.set(sha, memo.get(key));
    }

    // The sweep: the open-PR list's silence is never a removal's
    // license. The projection's open rows the list did not name this
    // pass — their syncedAt predates it — each get a direct
    // pull-request read: the forge's word for that one PR closes the
    // row in place (its terminal state and timestamps), removes it when
    // the forge has none, or leaves it with a fresh stamp and a log
    // line when the forge still says open (a race, a paging artifact).
    // A check that cannot run says nothing and leaves the row for the
    // next pass. A refused walk skips the sweep entirely (review 303):
    // a repo this pass cannot read would answer every direct read
    // wrong — a deleted, renamed, or token-scoped-away repo would
    // retire its whole review history in one pass while its pr_state
    // rows stayed open forever — and the per-PR reads would pile up
    // against it, each able to sit out the full read timeout.
    const now = new Date().toISOString();
    const sweep = [];
    if (open !== null) {
      try {
        for (const row of projectionDb().stale(repo, now)) {
          if (getKernel().isStopped()) break;
          if (open.some((cand) => cand.pr === row.pr)) continue;
          try {
            const record = parsePullRecord(await prRecord(owner, name, row.pr));
            if (record === null) {
              debug("projection.sweep.unparsed", { repo, pr: row.pr });
              continue;
            }
            const life = prLifecycle(record, debug);
            if (life === null) {
              console.error(
                `[forgejo-watcher] the open-pr list of ${repo} does not name pr ${row.pr}, but the direct read says it is open; its row keeps with a fresh stamp`,
              );
              sweep.push({ pr: row.pr, sha: row.headSha, how: "open" });
            } else {
              sweep.push({
                pr: row.pr,
                sha: row.headSha,
                how: "terminal",
                mergedAt:
                  life.how === "merged" ? (record.merged_at ?? null) : null,
                closedAt: record.closed_at ?? null,
              });
            }
          } catch (error) {
            if (error?.status === 404) {
              sweep.push({ pr: row.pr, sha: row.headSha, how: "gone" });
            } else {
              debug("projection.sweep.unread", {
                repo,
                pr: row.pr,
                error: String(error),
              });
            }
          }
        }
      } catch (error) {
        // The stale read itself failed: the sweep skips this pass and the
        // rows keep theirs.
        debug("projection.sweep.unread", { repo, error: String(error) });
      }
    }

    try {
      reasons.push(
        ...projectionDb().sync({
          repo,
          open,
          reviewAnswers,
          statusAnswers,
          reviewLimit: REVIEWS_PER_READ,
          statusLimit: STATUS_PER_READ,
          sweep,
          now,
        }),
      );
    } catch (error) {
      reasons.push(`the projection write failed: ${error?.message ?? error}`);
    }
    noteSync(repo, reasons);
  };

  // The projection, after the wakes: every watched repo's board,
  // synced through the same memo. One repo's unexpected failure says
  // and moves on: the rest of the boards still sync this pass (the
  // watch loop's shape).
  const afterPass = async (memo) => {
    const repos = new Set(
      getKernel()
        .watches()
        .map((watch) => watch.repo)
        .filter((repo) => typeof repo === "string" && repo.includes("/")),
    );
    for (const repo of [...repos].sort()) {
      if (getKernel().isStopped()) break;
      try {
        await syncRepo(repo, memo);
      } catch (error) {
        console.error(
          `[forgejo-watcher] the projection sync for ${repo} failed: ${error}`,
        );
      }
    }
  };

  return { afterPass, projectionDb, close: () => projection?.close() };
};
