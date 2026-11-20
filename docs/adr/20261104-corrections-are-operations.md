# ADR 20261104: Corrections are operations, not row types; content is state-only

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator across the 2026-11-04 session)
  - Edited: none
  - Approved: none
- **Companion**: PRD 20261104-memory-redesign; ADR 20261104-forget-retains-history

## Decision

There is no "correction" class on memory rows. Correcting a memory is an operation: **write the new state row, forget
the old one** — and the daemon links the pair invisibly (provenance edge on the tombstone record; see companion forget
ADR). The correcting agent does two present-tense things and nothing else:

- New row content is **state-only**: no "supersedes m18…", no "CORRECTED fact", no history narration, no why-it-changed
  story. Time travels exclusively as row metadata (`created_at` in injection framing). Rationale (the operator,
  in-session): agents don't do time-based understanding — they read narrated history rows and treat everything as
  current; narration also fuses an event log with a state statement, and the reader cannot tell which claim is live
  without parsing tense.
- Correction routes by _what it fixes_, not by a label:
  - **Project/world facts** → `agent_memory` rows (project-affinity); the per-project knowledge base absorbs them at
    build time via the watermarked ingestion that already reads facts. Correcting the standing knowledge = writing the
    truer fact; the next build's recency precedence folds it.
  - **Behavioural corrections** → `guidance` rows, authored at correction time, single write (situation → statement; the
    guidance row IS the correction record; the narrative of what was said lives in `session_history`, reachable through
    provenance).
- "Correcting" is never a special write verb or source label on rows; `replace` is an operation on `agent_memory` rows
  (forget + new, daemon-linked).

## Alternatives considered

1. **Supersede rows carrying history ("supersedes m18…" as a system feature).** Rejected: agents authored such prose
   today, but it embeds an event log into a state statement, requires the reader to resolve both rows (the referenced
   one is often not in front of them), and adds a belief-lifecycle machinery with zero observed demand — every "what did
   we believe then" audit traced through session_history, never through a retained superseded row. Also the operator's
   direction: drop backreferences entirely; agents treat time as one instant.
2. **In-place `memory_update` for belief changes.** Rejected: destroys the prior state (no provenance) and, under
   multi-machine sync, rewrites collide with new-row semantics.
3. **An explicit `knowledge_base_update` stream for factual corrections.** Rejected as redundant: KB-relevant facts
   arrive as `agent_memory` rows anyway; the stream was a second write path for the same content and its acceptance
   marker was a performance cursor (never an agent-facing signal), fully replaced by the build watermark.

## Why this shape won

The current store's biggest deliberate class (676 `correction` rows) conflated two fundamentally different fixes — fact
corrections (state-of-world: "the Inngest publisher's ID is rebuild-campaign-characters, not what I claimed"; "the
store-path hash is NOT stable across hosts") and behavioural corrections ("don't invent names"; "don't restart the unit
that hosts his sessions") — under one label, delivered by one word-luck channel, with supersession as prose. Splitting
by _what is fixed_ (state → facts/KB; conduct → guidance) removes the misdelivery failure mode structurally: a conduct
ruling can no longer be folded into a project's standing recap, and a fact can no longer be graded as if it were a rule.

## Consequences

- `agent_memory` carries facts / insights / decisions / events only.
- Provenance, recall scope, and KB-fold selection are three independent dimensions: provenance = row → session →
  session_history (answers "why did we decide this?", "what exactly was said?"); scope = recall-ranking metadata
  (project affinity / global-neutral); fold = session-affinity only. No mechanism consults another's field (a global-row
  correction must not trigger cross-project KB rebuilds or duplicate text across arcs).
- Behavioural rules are agent-authored and agent-graded only; sleep never touches them (hard line — see ADR
  20261104-sleep-scope).
- The old "name what you're correcting" instruction dies; freshness remains visible solely via `created_at` in injection
  framing (the Sept staleness contract).
