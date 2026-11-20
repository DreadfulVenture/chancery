# ADR 20261104: Sleep builds knowledge bases; behavioural rules are out of its reach

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator across the 2026-11-04 session)
  - Edited: agent (2026-11-05, PRJ-175 planning — one artifact family, deliberate-rows delta, composed doc; the
    operator's rulings that session)
- **Companion**: PRD 20261104-memory-redesign; ADR 20261104-corrections-are-operations; ADR
  20260911-no-aging-curated-rules (adjacent, curated-rule side)

## Decision

The consolidation ("sleep") pipeline builds exactly one artifact family:

1. **`knowledge_base`** — one composed doc per project: the previous doc plus the watermarked delta of new
   `agent_memory` rows (deliberate rows only — capture and summaries never enter the fold), rolled up by the same agent
   chain that summarizes, recency-precedence reconciliation, replace-with-history versioning. Each version journals the
   row ids it consumed (`inputs`).

**Sleep ships no summary artifact of its own.** The walk named a `session_summaries` table (built from
`session_history`, a nullable FK marking consolidation); it was never built. The episodic consolidator that exists today
remains the system's summary producer, unchanged by this ADR; whether summarization stays in the system at all is a
separately-decided question pending a raw-session-search spike.

Sleep **never** creates, distills, reviews, dedupes, or rewrites behavioural rules. The `guidance` (behavioural)
lifecycle is: agent-authored at correction time (author-time, single write — the guidance row IS the correction record),
graded exclusively by the agent feedback loop (confirm/disconfirm), bound to tools by agents. Hard line from the
operator, 2026-11-04: "I do NOT want anything sleep-assisted touching behavioural rules."

## Alternatives considered

1. **Sleep-assisted distillation of rules from correction events** (agent writes only an event record; sleep distills
   `guidance` rows later). Rejected: a rule birthed this way does not exist until the next sleep — leaving a window
   where a corrected behaviour silently recurs — and it strips nuance ("exactly what the operator said") because
   distillation reads summaries-of-conversations, a layer removed from the correction. It also makes rule authorship
   unaccountable: no agent chose the wording.
2. **Sleep-assisted review/dedupe of guidance rows.** Rejected under the same hard line: any sleep pass that reads,
   clusters, or flags rules is a touch. Corpus-wide duplicate detection on rules, if wanted, is an agent-initiated
   hygiene activity — agent-run, on demand.
3. **Author-time two writes (correction event in `agent_memory` + distilled rule).** Rejected with the corrections ADR:
   the event record is history narration in content, which the state-only ruling removes; provenance via the session FK
   answers the audit question without it.

## Why this shape won

The authority risk is asymmetric: a wrong _summary_ misleads one future reader who can re-derive; a wrong _rule_ steers
behaviour across every future session and would be machine-rewritten on schedule — the worst accountability shape in the
system. Two corroborating precedents: mnemosyne's heuristic-only conflict invalidation silently expired 59% of a memory
pool in production (their cautionary tale — confirmations gate invalidation, machines don't author rules); and our own
ADR 20260911-no-aging-curated-rules already bars sleep/aging machinery from curated-rule tiers. This ADR extends that
stance to the new behavioural store and makes sleep's contract explicit and narrow.

## Consequences

- Sleep's outputs stay traceable: each KB version journals the row ids its build consumed (`inputs`), each build keeps
  its prior version (replace-with-history) so fold provenance is auditable. The composed doc itself carries no inline
  citation markers — an agent-facing text littered with `[m18…]` tags is noise at the one place it is read most.
- KB input is deliberate rows only, and the KB correction channel is those same rows (see the corrections ADR:
  correcting standing knowledge = writing the truer fact; the next build's recency precedence evicts the claim, and a
  forget carries the dead row's text on its tombstone so the composer drops the claim without waiting for a
  replacement). No separate KB-correction surface exists and none is planned; the walk's `knowledge_base_update` queue
  was rejected as a second path for delta content — a dispute and a new fact take the same write. If
  correction-litigation ever proves awkward, an agent-direct KB rewrite is the acknowledged fallback, to be added as its
  own increment when evidence calls for it.
- One composition race is documented, not repaired: two machines composing the same seq from disjoint deltas each
  advance their own cursor, and the standing doc carries only the winner's rows. The window is debounce-bounded, and the
  recovery tool is the cursor deletion a rebuild-idempotence test covers; detection rides the usage-counters ticket.
- The standing set's growth is bounded by its input: deliberate writes drain through forgets and adjudicated duplicates,
  and the composing prompt folds the previous doc rather than appending. A compaction mechanism, if evidence ever
  demands one, is an evidence-gated later change on counter data — never a silent rewrite pass.
- Guidance provenance is always a specific authoring session; grading history lives in the existing feedback log.
- Write-time, warn-only near-duplicate checking remains (authoring-time machinery per the 20260926 write-dedup ADR) — it
  is not a sleep pass.
- The KB build still never consults behavioural rows: fold selection is facts-of-the-project only; behavioural knowledge
  reaches sessions through guidance recall and tool bindings.
