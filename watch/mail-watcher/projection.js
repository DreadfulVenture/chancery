// The PR-state projection (PRJ-406): a local SQLite mirror of the forge's
// PR state per watched repo, so an agent walks one forge_state query
// instead of scouring forgejo read by read. One entity per table composes
// it — PrState (pr-state.js), ReviewLog (review-log.js), CiLog
// (ci-log.js) — each owning its drizzle table, its DDL, its
// forge-boundary zod schema, and its read and write. This module is the
// composer: it opens the file, creates the tables, and owns the
// transaction — the poll pass collects the raw answers (the walked
// open-PR list, the reviews per open PR, the commit statuses per head
// sha, and the sweep's direct words per un-named PR) and hands them here;
// the sync writes them through the entities in one transaction per repo,
// and the forge_state tool reads the entities' boards back.
//
// The projection is a pure mirror — no derived judgments, no logic beyond
// mapping, no own-state beyond the rows the forge returned. A read that
// failed cleans nothing — the rows it would have replaced stay, as stale
// as their syncedAt says, which is the only staleness the mirror knows.
// A row leaves or closes only on the forge's own word for that specific
// PR, carried by the sweep; the list's silence is never a removal's
// license. The per-entity invariants live with their entities; every
// answer is validated through zod at the entity it enters, before it
// touches the projection.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { CiLog, DDL as ciLogDdl } from "./ci-log.js";
import { PrState, DDL as prStateDdl } from "./pr-state.js";
import { ReviewLog, DDL as reviewLogDdl } from "./review-log.js";

/**
 * Opens the projection's SQLite file (created when missing, parent
 * directory included) and returns its sync, stale, board and close.
 * Throws to the caller when the file cannot be opened — the watcher
 * treats that as a per-pass failure and retries, and the forge_state
 * tool says the projection is unavailable.
 */
export function openProjectionDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  let file = new DatabaseSync(path);
  file.exec([prStateDdl, reviewLogDdl, ciLogDdl].join("\n"));
  const db = drizzle({ client: file });
  const prState = new PrState({ db });
  const reviewLog = new ReviewLog({ db });
  const ciLog = new CiLog({ db });

  const rollback = (why) => {
    try {
      file.exec("ROLLBACK");
    } catch (rollbackError) {
      // A rollback that failed strands the handle inside its
      // transaction — every later write would fail with it. The file
      // closes (the stranded transaction rolls back with the handle)
      // and the composer turns unusable: the next use opens a fresh
      // one (review 279).
      try {
        file.close();
      } catch (closeError) {
        console.error(
          `[forgejo-watcher] the projection write for ${why}: the close itself failed: ${closeError}`,
        );
      }
      file = null;
      console.error(
        `[forgejo-watcher] the projection write for ${why}: the file is closed and the next pass reopens it`,
      );
    }
  };

  /**
   * The sweep's candidates: the repo's open rows whose syncedAt
   * predates the pass's stamp — the rows the pass's open-PR list did
   * not name, each owed a direct word from the forge before it closes
   * or leaves. Rows already carrying a verified terminal state are
   * final and never re-swept.
   */
  const stale = (repo, before) => prState.staleOpen(repo, before);

  /**
   * Writes one repo's answers into the projection through the entities —
   * wholesale per read scope, one transaction per repo. `open` is null
   * when the repo's PR list walk refused (nothing of the repo's open set
   * is replaced); an array is the walk's proven-complete open rows. The
   * reviews and statuses maps carry raw answers per open pr and head
   * sha, with null for a read that failed (that scope's rows keep
   * theirs); each entity validates its own at the forge boundary, and a
   * page that fills cannot prove its scope complete, so it refuses too.
   * The `sweep` verdicts are the forge's own words per un-named PR: a
   * row closes in place, leaves, or keeps with a fresh stamp by them —
   * never by the list's silence. Returns the reasons the sync is
   * incomplete, for the pass's reason-change log; an empty list is a
   * clean mirror.
   */
  const sync = ({
    repo,
    open,
    reviewAnswers,
    statusAnswers,
    reviewLimit,
    statusLimit,
    sweep,
    now,
  }) => {
    const reasons = [];
    file.exec("BEGIN");
    try {
      reasons.push(...prState.apply({ repo, open, now, sweep }));
      reasons.push(
        ...reviewLog.apply({
          repo,
          open,
          answers: reviewAnswers,
          now,
          limit: reviewLimit,
          sweep,
        }),
      );
      reasons.push(
        ...ciLog.apply({
          repo,
          open,
          answers: statusAnswers,
          now,
          limit: statusLimit,
          sweep,
        }),
      );
      file.exec("COMMIT");
    } catch (error) {
      rollback(repo);
      throw error;
    }
    return reasons;
  };

  /**
   * The board the forge_state tool serves: the entities' current rows,
   * one repo's or every repo's, each as stale as its syncedAt.
   */
  const board = (repo) => ({
    prs: prState.board(repo),
    reviews: reviewLog.board(repo),
    ci: ciLog.board(repo),
  });

  const close = () => {
    if (file === null) return;
    try {
      file.close();
    } catch {
      // The file dies with the process's handle either way.
    }
    file = null;
  };

  return {
    sync,
    stale,
    board,
    close,
    // False once the file handle is gone (a failed rollback closed it):
    // the next use opens a fresh composer over the same file.
    get usable() {
      return file !== null;
    },
  };
}
