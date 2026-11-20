// The ci_log entity (PRJ-406): one row per commit status the forge
// answered for an open pull request's head sha on a watched repo. The
// class owns the table's drizzle definition, its DDL, its forge-boundary
// zod schema, and its read and write; the composer (projection.js) hands
// it the shared drizzle handle and owns the per-repo transaction around
// it.
//
// Invariants: a pure mirror — no derived judgments, no aggregate verdict
// of the statuses, one row per (repo, sha, context) exactly as the read
// answered it. Wholesale per read scope: a sha's good statuses read
// replaces that sha's rows, and one the read no longer named (the
// context went away, or the sha now carries none) leaves. A read that
// failed or was refused replaces nothing — the sha's rows stay, as stale
// as their syncedAt says. The list's silence never deletes: a PR the
// list did not name retires its head sha's rows only by the sweep's
// direct word from the forge for that PR (the PR closed or is gone),
// and only while no open PR still shares the head. The rows' pr
// identity is the open PR whose head the sha is — the list's first
// naming it; two PRs sharing a head keep that head's rows once. loggedAt
// is when the watcher first logged the sha's status in this context: the
// insert stamps it, the upsert keeps it. Every row stamps syncedAt with
// the sync moment.
//
// The DDL and the drizzle mirror below must move together in one edit —
// the pairing the zenigata status db keeps (review/zenigata/src/
// status-db.ts). The drizzle-orm 1.0.0-rc.5 pin is deliberate: no 1.0.0
// final exists on the registry (the latest stable tag is 0.45.4 as of
// 2026-11-18), and the rc is the version the repo's other drizzle
// consumers carry. The schema evolves by pointing the watcher's dbPath
// at a fresh file, never by migration: the next pass repopulates it
// wholesale.

import { and, eq, notInArray } from "drizzle-orm/sql";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { z } from "zod";

const ciLog = sqliteTable(
  "ci_log",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    sha: text("sha").notNull(),
    context: text("context").notNull(),
    state: text("state").notNull(),
    description: text("description"),
    loggedAt: text("logged_at").notNull(),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.sha, t.context] })],
);

export const DDL = `
CREATE TABLE IF NOT EXISTS ci_log (
  repo        TEXT NOT NULL,
  pr          INTEGER NOT NULL,
  sha         TEXT NOT NULL,
  context     TEXT NOT NULL,
  state       TEXT NOT NULL,
  description TEXT,
  logged_at   TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (repo, sha, context)
);
`;

// The wire shape, validated at the forge boundary before it touches the
// entity. The leaf's state is `status` on the gitea-shaped record and
// `state` on the combined-status flavor; the answer arrives either as
// the statuses array itself or wrapped in it. A leaf that fails is left
// out with the rest of the answer; an answer where nothing parses is a
// read that failed, never an empty board.
const ZStatusLeaf = z.looseObject({
  context: z.string(),
  state: z.string().optional(),
  status: z.string().optional(),
  description: z.string().nullable().optional(),
});
const ZStatusAnswer = z.union([
  z.array(ZStatusLeaf),
  z.looseObject({ statuses: z.array(ZStatusLeaf) }),
]);

/**
 * One head sha's commit statuses, parsed for the projection. Null when
 * the answer carries no statuses array, or when no leaf on it can be
 * named.
 */
function parseStatusPage(data) {
  const answer = ZStatusAnswer.safeParse(data);
  if (!answer.success) return null;
  const leaves = Array.isArray(answer.data)
    ? answer.data
    : answer.data.statuses;
  let dropped = 0;
  const rows = [];
  for (const leaf of leaves) {
    const context = leaf.context.trim();
    const state = (leaf.state ?? leaf.status ?? "").trim();
    if (!context || !state) {
      dropped += 1;
      continue;
    }
    rows.push({ context, state, description: leaf.description ?? null });
  }
  if (leaves.length > 0 && rows.length === 0 && dropped === leaves.length) {
    return null;
  }
  return { rows, dropped };
}

export class CiLog {
  /** @param {{ db: ReturnType<typeof drizzle> }} deps — the shared drizzle handle over the projection file. */
  constructor({ db }) {
    this.db = db;
  }

  /**
   * The write: per head sha with a good statuses answer, that sha's rows
   * in, wholesale, and every context the read no longer named out. The
   * list's silence removes nothing: the sweep's verdicts retire a PR's
   * head sha's rows only by the forge's own word for that PR (a close or
   * a gone), and only while no open PR shares the head. A null answer is
   * a statuses read that failed, and a page that fills its limit cannot
   * prove the sha's contexts complete: both refuse, and that sha's rows
   * keep theirs. Returns the reasons the apply is incomplete; an empty
   * list is a clean write.
   */
  apply({ repo, open, answers, now, limit, sweep }) {
    const reasons = [];
    // The sweep's retirement, with the share guard: a sha two PRs share
    // keeps its rows while any open PR still names the head. The open
    // set unknown (a refused walk), the retirement waits for a pass
    // that knows.
    const heads =
      open === null ? null : new Set(open.map((row) => row.headSha));
    for (const verdict of sweep ?? []) {
      if (
        (verdict.how === "terminal" || verdict.how === "gone") &&
        heads !== null &&
        !heads.has(verdict.sha)
      ) {
        this.db
          .delete(ciLog)
          .where(and(eq(ciLog.repo, repo), eq(ciLog.sha, verdict.sha)))
          .run();
      }
    }
    const prOfSha = new Map();
    for (const row of open ?? []) {
      if (!prOfSha.has(row.headSha)) prOfSha.set(row.headSha, row.pr);
    }
    for (const [sha, raw] of answers) {
      if (raw === null) {
        reasons.push(
          `the commit-status read for ${sha} failed; its rows keep theirs`,
        );
        continue;
      }
      const parsed = parseStatusPage(raw);
      if (!parsed) {
        reasons.push(
          `the commit-status answer for ${sha} did not parse as a status list; its rows keep theirs`,
        );
        continue;
      }
      if (limit !== undefined && parsed.rows.length + parsed.dropped >= limit) {
        reasons.push(
          `the commit-status answer for ${sha} filled its page of ${limit}; the pass cannot learn whether more contexts follow, so its rows keep theirs`,
        );
        continue;
      }
      if (parsed.dropped) {
        console.error(
          `[forgejo-watcher] ${parsed.dropped} of ${parsed.rows.length + parsed.dropped} status leaves on ${sha} carried no usable identity and were left out of the projection`,
        );
      }
      const pr = prOfSha.get(sha) ?? 0;
      for (const row of parsed.rows) {
        this.db
          .insert(ciLog)
          .values({
            repo,
            pr,
            sha,
            context: row.context,
            state: row.state,
            description: row.description,
            loggedAt: now,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [ciLog.repo, ciLog.sha, ciLog.context],
            set: {
              pr,
              state: row.state,
              description: row.description,
              syncedAt: now,
            },
          })
          .run();
      }
      const contexts = parsed.rows.map((row) => row.context);
      this.db
        .delete(ciLog)
        .where(
          contexts.length
            ? and(
                eq(ciLog.repo, repo),
                eq(ciLog.sha, sha),
                notInArray(ciLog.context, contexts),
              )
            : and(eq(ciLog.repo, repo), eq(ciLog.sha, sha)),
        )
        .run();
    }
    return reasons;
  }

  /**
   * The read: the entity's current rows, one repo's or every repo's,
   * each as stale as its syncedAt.
   */
  board(repo) {
    return this.db
      .select()
      .from(ciLog)
      .where(repo ? eq(ciLog.repo, repo) : undefined)
      .orderBy(ciLog.repo, ciLog.sha, ciLog.context)
      .all();
  }
}
