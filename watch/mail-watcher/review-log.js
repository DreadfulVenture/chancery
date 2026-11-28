// The review_log entity (PRJ-406): one row per review the forge answered
// for an open pull request on a watched repo. The class owns the table's
// drizzle definition, its DDL, its forge-boundary zod schema, and its
// read and write; the composer (projection.js) hands it the shared
// drizzle handle and owns the per-repo transaction around it.
//
// Invariants: a pure mirror — a PENDING review is an unsubmitted draft
// that never wakes anyone, and the mirror still maps it, state string and
// all. Wholesale per read scope: a PR's good reviews read replaces that
// PR's rows, and one the read no longer named (it fell off the page, or
// the PR now carries none) leaves. A read that failed or was refused
// replaces nothing — the PR's rows stay, as stale as their syncedAt says.
// The list's silence never deletes: a PR the list did not name retires
// its rows only by the sweep's direct word from the forge for that PR —
// the PR closed or is gone. Every row stamps syncedAt with the sync
// moment.
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

const reviewLog = sqliteTable(
  "review_log",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    reviewId: integer("review_id").notNull(),
    reviewer: text("reviewer").notNull(),
    state: text("state").notNull(),
    body: text("body"),
    submittedAt: text("submitted_at").notNull(),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr, t.reviewId] })],
);

export const DDL = `
CREATE TABLE IF NOT EXISTS review_log (
  repo         TEXT NOT NULL,
  pr           INTEGER NOT NULL,
  review_id    INTEGER NOT NULL,
  reviewer     TEXT NOT NULL,
  state        TEXT NOT NULL,
  body         TEXT,
  submitted_at TEXT NOT NULL,
  synced_at    TEXT NOT NULL,
  PRIMARY KEY (repo, pr, review_id)
);
`;

// The wire shape, validated at the forge boundary before it touches the
// entity — the same page the wake's parseReviews reads, kept whole here.
// A row that fails is left out with the rest of the page (the watcher's
// parseReviews precedent); a page where nothing parses is a read that
// failed, never an empty board. The submitted stamp falls back to the
// row's created_at when the surface carries only that; a row carrying
// neither cannot be stamped and is left out.
const ZReview = z.looseObject({
  id: z.number().int().positive(),
  state: z.string(),
  body: z.string().nullable().optional(),
  user: z.looseObject({ login: z.string() }),
  submitted_at: z.string().optional(),
  created_at: z.string().optional(),
});

/**
 * One PR's reviews page, parsed for the projection. Null when the answer
 * is not a review array, or when no row on it can be named.
 */
function parseReviewPage(data) {
  if (!Array.isArray(data)) return null;
  let dropped = 0;
  const rows = [];
  for (const raw of data) {
    const review = ZReview.safeParse(raw);
    if (!review.success) {
      dropped += 1;
      continue;
    }
    const reviewer = review.data.user.login.trim();
    const submittedAt = review.data.submitted_at ?? review.data.created_at;
    if (!reviewer || submittedAt === undefined) {
      dropped += 1;
      continue;
    }
    rows.push({
      reviewId: review.data.id,
      reviewer,
      state: review.data.state,
      body: review.data.body ?? null,
      submittedAt,
    });
  }
  if (data.length > 0 && rows.length === 0 && dropped === data.length) {
    return null;
  }
  return { rows, dropped };
}

export class ReviewLog {
  /** @param {{ db: ReturnType<typeof drizzle> }} deps — the shared drizzle handle over the projection file. */
  constructor({ db }) {
    this.db = db;
  }

  /**
   * The write: per open PR with a good reviews answer, that PR's rows in,
   * wholesale, and every review the read no longer named out. `open` is
   * null when the list walk refused — the read scopes still apply, and
   * nothing else does. A null answer is a reviews read that failed, and
   * a page that fills its limit cannot prove the PR's reviews complete
   * (older pages may follow that the wake's one-read budget never
   * chases): both refuse, and that PR's rows keep theirs. The sweep's
   * verdicts retire a PR's rows only by the forge's own word for it (a
   * close or a gone). Returns the reasons the apply is incomplete; an
   * empty list is a clean write.
   */
  apply({ repo, answers, now, limit, sweep }) {
    const reasons = [];
    for (const verdict of sweep ?? []) {
      if (verdict.how === "terminal" || verdict.how === "gone") {
        this.db
          .delete(reviewLog)
          .where(and(eq(reviewLog.repo, repo), eq(reviewLog.pr, verdict.pr)))
          .run();
      }
    }
    for (const [pr, raw] of answers) {
      if (raw === null) {
        reasons.push(
          `the reviews read for ${repo}#${pr} failed; its rows keep theirs`,
        );
        continue;
      }
      const parsed = parseReviewPage(raw);
      if (!parsed) {
        reasons.push(
          `the reviews answer for ${repo}#${pr} did not parse as a review list; its rows keep theirs`,
        );
        continue;
      }
      if (limit !== undefined && parsed.rows.length + parsed.dropped >= limit) {
        reasons.push(
          `the reviews answer for ${repo}#${pr} filled its page of ${limit}; the pass cannot learn whether older reviews follow, so its rows keep theirs`,
        );
        continue;
      }
      if (parsed.dropped) {
        console.error(
          `[forgejo-watcher] ${parsed.dropped} of ${raw.length} review rows on ${repo}#${pr} carried no usable identity and were left out of the projection`,
        );
      }
      for (const row of parsed.rows) {
        this.db
          .insert(reviewLog)
          .values({
            repo,
            pr,
            reviewId: row.reviewId,
            reviewer: row.reviewer,
            state: row.state,
            body: row.body,
            submittedAt: row.submittedAt,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [reviewLog.repo, reviewLog.pr, reviewLog.reviewId],
            set: {
              reviewer: row.reviewer,
              state: row.state,
              body: row.body,
              submittedAt: row.submittedAt,
              syncedAt: now,
            },
          })
          .run();
      }
      const ids = parsed.rows.map((row) => row.reviewId);
      this.db
        .delete(reviewLog)
        .where(
          ids.length
            ? and(
                eq(reviewLog.repo, repo),
                eq(reviewLog.pr, pr),
                notInArray(reviewLog.reviewId, ids),
              )
            : and(eq(reviewLog.repo, repo), eq(reviewLog.pr, pr)),
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
      .from(reviewLog)
      .where(repo ? eq(reviewLog.repo, repo) : undefined)
      .orderBy(reviewLog.repo, reviewLog.pr, reviewLog.reviewId)
      .all();
  }
}
