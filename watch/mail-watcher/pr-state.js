// The pr_state entity (PRJ-406): one row per open pull request on a
// watched repo — the board the forge_state tool serves. The class owns
// the table's drizzle definition, its DDL, its forge-boundary zod schema,
// and its read and write; the composer (projection.js) hands it the
// shared drizzle handle and owns the per-repo transaction around it.
//
// Invariants: a pure mirror — no derived judgments, no logic beyond
// mapping, no own-state beyond the rows the forge returned. The open set
// the walk proves upserts wholesale; the list's silence never deletes —
// a row the list did not name closes, leaves, or keeps only by the
// sweep's direct word from the forge for that specific PR (the
// operator's correction: an API race or a paging artifact must never
// cost a row). A closed row is final: its terminal state and timestamps
// are the forge's own verified word, and the sweep never re-sweeps it.
// Every write stamps syncedAt with the sync moment.
//
// The DDL and the drizzle mirror below must move together in one edit —
// the pairing the zenigata status db keeps (review/zenigata/src/
// status-db.ts). The drizzle-orm 1.0.0-rc.5 pin is deliberate: no 1.0.0
// final exists on the registry (the latest stable tag is 0.45.4 as of
// 2026-11-18), and the rc is the version the repo's other drizzle
// consumers carry. The schema evolves by pointing the watcher's dbPath
// at a fresh file, never by migration: the next pass repopulates it
// wholesale.

import { and, eq, lt } from "drizzle-orm/sql";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { z } from "zod";

const prState = sqliteTable(
  "pr_state",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    mergedAt: text("merged_at"),
    closedAt: text("closed_at"),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr] })],
);

export const DDL = `
CREATE TABLE IF NOT EXISTS pr_state (
  repo      TEXT NOT NULL,
  pr        INTEGER NOT NULL,
  head_sha  TEXT NOT NULL,
  base_ref  TEXT NOT NULL,
  title     TEXT NOT NULL,
  state     TEXT NOT NULL,
  draft     INTEGER NOT NULL DEFAULT 0,
  merged_at TEXT,
  closed_at TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
`;

// The wire shape, validated at the forge boundary before it touches the
// entity. Loose (z.looseObject), so a future forge field still loads; the
// fields a row needs before the mirror can name it are the strict ones.
// The PR's identity is `index`, with `number` accepted as the flavor some
// surfaces carry.
const ZPullRequest = z.looseObject({
  index: z.number().int().positive().optional(),
  number: z.number().int().positive().optional(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  head: z.looseObject({ sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
});

const identityOf = (row) => {
  const pr = row.index ?? row.number;
  return typeof pr === "number" && Number.isInteger(pr) && pr > 0 ? pr : null;
};

/**
 * The repo's PR list page, parsed. Returns null when the answer is not a
 * pull-request array at all, or when it is an array no row of which the
 * mirror can name — either way the read failed and the projection keeps
 * its rows. Returns the open rows (already mapped), the count of rows
 * left out, and every nameable row's identity — open PRs and closed
 * ones — for the walk's page-advance check.
 */
export function parsePullList(data) {
  if (!Array.isArray(data)) return null;
  let dropped = 0;
  const open = [];
  const seen = [];
  for (const raw of data) {
    const row = ZPullRequest.safeParse(raw);
    if (!row.success) {
      dropped += 1;
      continue;
    }
    const pr = identityOf(row.data);
    const state = row.data.state.trim();
    if (pr === null) {
      dropped += 1;
      continue;
    }
    seen.push(pr);
    if (state.toLowerCase() !== "open") continue;
    open.push({
      pr,
      headSha: row.data.head.sha,
      baseRef: row.data.base.ref,
      title: row.data.title,
      // The stored spelling is normalized lowercase, so the sweep's
      // stale-state match is exact whatever the surface answered.
      state: state.toLowerCase(),
      draft: row.data.draft === true,
    });
  }
  // Every row dropped: a shape the mirror cannot name, not a board that
  // emptied. The read failed; the projection keeps its rows.
  if (data.length > 0 && open.length === 0 && dropped === data.length) {
    return null;
  }
  return { open, dropped, seen };
}

export class PrState {
  /** @param {{ db: ReturnType<typeof drizzle> }} deps — the shared drizzle handle over the projection file. */
  constructor({ db }) {
    this.db = db;
  }

  /**
   * The write: the repo's proven-complete open set in, wholesale; the
   * list's silence removes nothing. The sweep's verdicts — the forge's
   * own word per un-named PR — close a row in place (its terminal state
   * and timestamps), remove it when the forge has none, or refresh its
   * stamp when the forge still says open. Returns the reasons the apply
   * is incomplete; an empty list is a clean write.
   */
  apply({ repo, open, now, sweep }) {
    if (open === null) {
      return ["the open-pr list read failed; the repo keeps its rows"];
    }
    for (const row of open) {
      this.db
        .insert(prState)
        .values({
          repo,
          pr: row.pr,
          headSha: row.headSha,
          baseRef: row.baseRef,
          title: row.title,
          state: row.state,
          draft: row.draft,
          mergedAt: null,
          closedAt: null,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [prState.repo, prState.pr],
          set: {
            headSha: row.headSha,
            baseRef: row.baseRef,
            title: row.title,
            state: row.state,
            draft: row.draft,
            mergedAt: null,
            closedAt: null,
            syncedAt: now,
          },
        })
        .run();
    }
    for (const verdict of sweep ?? []) {
      if (verdict.how === "terminal") {
        // The forge's word for this PR: closed in place, carrying its
        // terminal state and timestamps.
        this.db
          .insert(prState)
          .values({
            repo,
            pr: verdict.pr,
            headSha: verdict.sha,
            baseRef: "",
            title: "",
            state: "closed",
            draft: false,
            mergedAt: verdict.mergedAt ?? null,
            closedAt: verdict.closedAt ?? null,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [prState.repo, prState.pr],
            set: {
              state: "closed",
              mergedAt: verdict.mergedAt ?? null,
              closedAt: verdict.closedAt ?? null,
              syncedAt: now,
            },
          })
          .run();
      } else if (verdict.how === "gone") {
        // The forge has no such PR: the row is a phantom's, and leaves.
        this.db
          .delete(prState)
          .where(and(eq(prState.repo, repo), eq(prState.pr, verdict.pr)))
          .run();
      } else if (verdict.how === "open") {
        // The forge still says open: the row keeps, freshly stamped.
        this.db
          .update(prState)
          .set({ syncedAt: now })
          .where(and(eq(prState.repo, repo), eq(prState.pr, verdict.pr)))
          .run();
      }
    }
    return [];
  }

  /**
   * The sweep's candidates: the repo's rows in the open state whose
   * syncedAt predates the pass's stamp — the rows the pass's open-PR
   * list did not name. A row already carrying a verified terminal state
   * is final and never re-swept.
   */
  staleOpen(repo, before) {
    return this.db
      .select()
      .from(prState)
      .where(
        and(
          eq(prState.repo, repo),
          eq(prState.state, "open"),
          lt(prState.syncedAt, before),
        ),
      )
      .all();
  }

  /**
   * The read: the entity's current rows, one repo's or every repo's,
   * each as stale as its syncedAt.
   */
  board(repo) {
    return this.db
      .select()
      .from(prState)
      .where(repo ? eq(prState.repo, repo) : undefined)
      .orderBy(prState.repo, prState.pr)
      .all();
  }
}
