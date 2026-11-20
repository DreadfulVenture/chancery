# ADR 20260926: Write-dedup on memory_remember — warn-only, thatch-mirror

- **Status**: Draft
- **Provenance**:
  - Authored: agent, 2026-09-26
  - Edited: (none)
  - Approved: none

## Context

Twelve near-identical deployment-boundary corrections accumulated in working_memory over days (`deploy≠commit`, "when I
say deploy you deploy x", "prod writes need their own word") — three of them written minutes apart in one session, all
variants of the same ruling. `memory_remember` computes no similarity check (verified: `tools.py:59-103` →
`store.upsert_capture`, nothing in the write path compares content against the existing pool), so every correction filed
silently as another row and no mechanism surfaced "this rule class keeps getting re-taught." The pollution matters
downstream: recall keeps returning the cluster, and any future correction-recurrence detection (floor proposals) reads
this cluster as evidence — duplicates corrupt it.

The operator steered this as the first lever of the store-tending work ("one of our biggest levers to start with is
deduplicating on memory write") and ruled its shape ("Follow thatch" — "We can always crank it up if we need").

## Decision

`memory_remember` writes unconditionally; the response warns on semantic near-duplicates. Mirroring thatch's verified
mechanism (tool-defs.ts:120-176, db.ts:265-330 — checked from source, not from our notes):

- **No refusal path on similarity.** Thatch's write path has exactly one hard refusal — a label collision ("Pass
  overwrite: true to replace it", db.ts:315-330) — and none on semantics. Our equivalent key doesn't exist (we have
  opaque ids, not labels), so the write proceeds unconditionally, which is the behavior thatch's semantic check
  produces: advisory, never blocking.
- **The check**: after the upsert, cosine between the new content's vector (already embedded by the write itself —
  sha256 cache hit, zero double inference) and the deliberate pool's stored vectors (`vec_working`, the nudge pool's
  shape). Hits at cosine ≥ 0.85 (thatch's findSimilar/find_duplicates default) return as
  `similar_to: [{id, source, score}...]`, top 3, with reconcile instructions in the tool response (thatch's ⚠ text, our
  verbs: memory_get to review, memory_update + memory_forget to merge, or accept as distinct).
- **The reconcile loop assumes a dedup cycle exists** — thatch's warning points at `dedup_mark_checked`. Ours ships the
  companion in the same unit: `memory_find_duplicates` (pairs and clusters over the deliberate pool, cluster-of-3+ =
  "one topic fragmented") and `memory_mark_checked` verdicts (duplicate | supplement | contradiction | unrelated;
  verdict-marked pairs stop re-flagging; update/forget clears a member's verdicts, so merges can re-flag on their new
  content — intended, verified in thatch's deduplication.md). Verdicts are machine-local, not synced.
- **Honest degrade**: embeddings unavailable → `similar_to: []`, never an exception (same posture as recall's knn leg).
- **Deliberate-only pool** (decided, not offered — trivia rule): captures are noise; episodic rows are summaries OF
  captures, so a deliberate row legitimately resembles its own summary — warning on those would train the agent to
  ignore the warning.

## Alternatives considered

- **Graduated refusal (agent proposal, withdrawn by ruling).** Refuse at cosine ≥ 0.98 (the burst-garbage class: three
  corrections written minutes apart), warn at 0.85 (the legitimate facet class). Matches the failure's apparent
  structure but adds a severity scheme thatch deliberately lacks; rejected — start at thatch's severity, crank on
  evidence.
- **Labels + overwrite (thatch's key shape).** The deterministic answer to same-entry rewrites; deferred — requires a
  naming habit from every write. Revisit only if the warning proves insufficient.
- **Exact-content-hash refusal.** Byte-identical write returns the existing id — the analog of thatch's label-collision
  gate, offered as a genuine option and parked by the follow-thatch ruling.

## Consequences

- The write path gains one read (pool vectors per remember) — bounded, cache-served; the deliberate pool is already the
  nudge pool's shape.
- The tool response grows one additive field; both renderers tolerate unknown keys (verified).
- One new machine-local table (dedup_verdicts, carrying created_at/updated_at per the schema-standards ADR) and one new
  read-only tool (find_duplicates) + one verdict tool.
- `memory_update`/`memory_forget` gain verdict-clearing on touched rows.
- The twelve-duplicates cluster gets consolidated through the new cycle as its first real exercise (implementation task,
  not part of this decision).
- Floor activation semantics unchanged: memory is the agent's own tool; the warning teaches, it never gates.

## Implementation location

The WHAT/TESTS detail lives in the store-tending program plan (`.opencode/plans/` — uncommitted working state,
intentionally not referenced here as durable history). The durable context this record needs is self-contained above:
the incident, the decision, the alternatives, the consequences.
