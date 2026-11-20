# ADR 20260926: Recall returns judged rows; raw transcript is two-step drill-down

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: none
  - Approved: none

## Context

Explicit recall is the agent's main window into the store, and it currently returns everything it matches as full
content rows. On the live store (2026-09-26): 633 deliberate memory rows, 590 episodic summaries, and ~5.5k raw captured
conversation turns — of which 96% are unconsolidated. The raw tier includes chat-history summaries (the voice/capture
tool's fork preamble, captured 1:1 per the capture-reliability rule) that reach 22k–46k characters.

Three failures follow from returning raw turns as content:

1. **The response-overflow tax.** OpenCode truncates tool output at ~50KB and dumps the overflow to a file that can only
   be searched by spawning a subagent. Three subagent spawns in one session for what inline content would have shown
   directly.
2. **Transcript noise drowns judged text.** Raw turns and fork summaries outrank the deliberate memories and episodic
   summaries that actually carry judgment. Keyword hits in a fork summary pull the whole 46k blob into a recall
   response.
3. **The nudge channel already made this choice.** The automatic nudge pool excludes raw captures by design (ADR
   20260911-non-speech-input-classification); explicit recall kept them only under its "everything remains reachable,
   labeled" requirement — reachable, but at full content cost per turn.

Separately, the store's summary↔raw linkage already exists but is unused: every episodic summary carries `summary_of`
(the session id it summarizes; verified populated on all 590 rows), and every raw turn carries `session_id`. Reverse
lookups ("which summaries cover this conversation?") are keyed reads on that shared key — measured at ~5ms unindexed
over 590 rows — not searches.

## Decisions

The operator ruled on each point during plan review; the decisions below are theirs, with the agent's withdrawn
proposals recorded in Alternatives.

### 1. Recall returns judged rows only

`memory_recall` returns deliberate memories and episodic summaries — the tiers that carry judgment. Raw captured turns
are excluded from its content results entirely, including fork summaries. The PRD's reachability requirement
("everything remains reachable, labeled") is met by explicit two-step access, not by default return.

Content-bearing results are elided head+tail at 1200 characters with a `truncated: true` flag — the same budget the
plugin and Cursor hook already apply when framing injected memories, so one framing contract holds across every surface.
The full row remains one `memory_get` call away.

With captures excluded, the conversation-grouping block in the recall scorer becomes dead code (it exists to stop one
session's raw turns flooding results; deliberate rows always carry the exempt `default` session id) and is removed.

### 2. Raw-transcript discovery is its own command

The pointer design was first proposed as a `raw_conversations` field inside the recall response, with pointers filling
leftover result slots. The operator rejected the coupling: "Split this into a different command." Two different
questions — "what do I know?" and "where did we discuss it?" — sharing one response shape was the same single-verb error
the store already makes elsewhere.

`memory_find_conversations(query, limit=8)` answers the second question alone: per-session pointer records
(`session_id`, `matched_count`, `total_count`, `first_ts`, `last_ts`, ~120-char preview of the best-matching turn), one
pointer per conversation regardless of how many of its turns matched, ordered by match count. No content rows ever.
Lexical scoring only, consistent with the working leg; empty result is silence, not fabricated sessions. Pointers
recompute per call from live rows — forgotten rows drop out, so no stale-pointer state can exist.

### 3. The summary↔raw link is the existing shared key

The double-sided link needs no new column: raw rows carry `session_id`, summaries carry `summary_of` — the key already
exists on both sides. The operator asked whether the existing `summary_of` query would be "just as quick" against
materializing a reverse-reference stamp at consolidation time; it is (5ms measured, table of 590). The stamped-column
variant was withdrawn and the shared-key design adopted, with one new index on `episodic_memory(summary_of)` so the
keyed read stays a keyed read as the table grows. The index applies automatically at next daemon boot.

### 4. Drill-down is explicit, not automatic

The read chain — all keyed reads over existing columns:

- summary → its source conversation: `summary_of` → list rows by session
- conversation → turns: `memory_list(session_id=...)`, chronological, including deliberate writes made during the
  conversation
- turn → full text: `memory_get(id)`
- raw turn → its summaries: `memory_list` episodic mode filtered by `summary_of` (the same key, read in the other
  direction)

`memory_list` is the one new inventory verb (default view: judged tiers; `session_id` filter switches to one
conversation's rows; metadata only, no content in the SELECT). Nothing chains automatically — recall never triggers
conversation discovery, and discovery never fetches turns. Each step is a separate call the agent chooses.

### 5. Fork summaries are previews, never content

Chat-history summaries are system-injected preamble, not speech by either speaker — captured 1:1, classified
`fork_summary` at ingest, excluded from consolidation and the nudge pool already. Under this design they also leave
recall's content results: they surface only as their conversation's preview line in `memory_find_conversations`. The 46k
blobs stop flowing through every response path; the rare case where one is genuinely wanted is one `memory_get` away.

## Alternatives considered

- **Raw conversations as a field on recall's response** (the original pointer design): rejected by the operator — two
  questions, one response, plus slot-coupling between judged rows and pointers. Split into a command.
- **A materialized `summarized_by` stamp on raw rows** (double-sided link written at consolidation time): more precise
  for "which summary covers this exact turn" on re-summarized sessions, but costs a schema column, a sync-payload field,
  and a best-effort legacy backfill. Withdrawn when the shared key proved equally fast; revisit only if re-summarization
  ambiguity ever becomes a real problem.
- **Elision-only (the original A1)**: keep returning raw turns but truncate them. Keeps the overflow tax down but keeps
  transcript noise in results, and truncating a 46k blob still wastes the budget; superseded by the judged-only
  contract.
- **Keeping raw turns in recall with a bigger preview**: rejected — the problem is not preview size, it is transcript
  rows occupying result slots that judged text should fill.

## Consequences

- Recall responses shrink from unbounded (up to ~50KB-truncated) to bounded by the judged tier's content at the
  1200-char elision budget; the explore-subagent tax disappears for recall-sized queries.
- The 96% unconsolidated transcript tier remains reachable — via explicit two-step access — so reachability survives
  until consolidation catches up. Agents that need transcript context make two calls instead of zero; this is the
  intended friction.
- One schema addition: `idx_em_summary_of` (one index line). No column changes, no wire changes, no client changes; the
  daemon's tool gate passes both new verbs on the existing `memory_` prefix.
- `explicit_recall`'s positional signature is unchanged; its output contract (judged rows only) is a behavior change for
  any future direct consumer.
- The contract text (`instructions/memory.md`) teaches the new recall shape and the drill-down chain; tool descriptions
  carry the same teaching.
