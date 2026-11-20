# ADR 20261104: Retire per-message delivery; automatic surfacing is event-shaped only

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator across the 2026-11-04 session)
  - Edited: none
  - Approved: none
- **Companion**: PRD 20261104-memory-redesign

## Context (measured, 2026-11-03/04 against the live snapshot and fork-validation run)

- **Volume**: 1,278 real recalled-memory injection events across 19 fork-recorded sessions (up to 174 pushes/session),
  average 2,703 bytes per injection (~3.34 MB recall text + ~621 KB fired-rule text total).
- **Precision**: ~20–27% — a labeled 22-instance random sample found ≥1 clearly on-point row in only 4–6 instances; PRD
  20260911 had already measured "roughly a quarter earned their slot" on a maximally-relevant session. One sampled turn
  asked directly for a stored fact and still served three unrelated rows.
- **Channel blindness**: the commit-gate rule's ~1,467 recorded fires all landed on turns already discussing git;
  approval turns ("go ahead", sub-threshold length) fired nothing. 7-for-7 tool-turn injections were irrelevant in one
  diagnosis session.
- **Content skew**: 3,700 of 3,702 delivered slots were deliberately-authored rows; consolidated episodic content (771
  summaries) got 2 slots in six weeks. Repeat tail: 89 ids across ≥5 sessions carried 52.8% of all slots.

## Decision

The memory system never surfaces stored content on message arrival. No recalled-memory block, no fired-rules block, no
pointer nudge rides a user prompt. Automatic delivery is event-shaped only:

- **Session start**: the project knowledge base (per the redesign PRD).
- **Tool executions**: rules bound to a tool token key (exact match).
- **Pull**: agents recall with queries they compose into working context.
- **Write-nudge**: unchanged in role (drives authoring, not retrieval).

Recall discipline is taught statically — instruction files (AGENTS.md / floor) and the recall tool's own description
("state what you're about to do and ask what's established; re-ask richer when a pull misses") — never per-message. The
recall-compliance loop is counter-gated and escalating, instrumented on explicit-pull stamps only, and only observes
_that_ the agent pulled, never _what for_.

## Alternatives considered

1. **Keep per-message matching, tune thresholds.** Rejected — measured. Push precision ceiling is ~20–27% (labeled
   22-sample replay of real injections; PRD 20260911 already measured "roughly a quarter earned their slot" on a
   maximally-relevant session). Raising thresholds shrinks volume proportionally, not noise: the matcher keys on word
   resemblance at the moment messages carry least signal ("go ahead", <12-char prompts skip injection entirely today).
   The commit-gate rule's 1,400+ recorded fires all landed on turns already discussing git; approval turns fired
   nothing.
2. **Per-message content, stricter bars (mnemosyne-style injection gates).** Rejected for the same ceiling: gates filter
   a matcher whose ranking — not whose cutoff — is the failure.
3. **Thatch-style label-only pointer per message.** Rejected after adoption-debate: it still leaves system-side guessing
   in charge of relevance on turns ("ok build") where there is nothing to match, costs the noise floor of a nudge to no
   effect, and contradicts the design's core split — the agent composes queries because it holds context the matcher
   never sees.
4. **Session-start synthesis + per-message silence (hindsight's reflect shape).** Adopted in adapted form: one automatic
   block per session (the knowledge base, precomputed at sleep — no LLM call at open), everything else pull. This ADR
   bans what remains: any per-message content surface.

## Why this shape won

Message arrival is structurally the wrong moment: decision turns carry minimal text, and rich turns yield
word-resemblance rather than task-relevance (7-for-7 irrelevant tool-turn injections measured in one session; ~67
pushes/session in fork-recorded sessions, ~91 KB of memory text). All three reference systems (hindsight, mnemosyne,
thatch) either ban or hard-gate per-message content delivery. Under the redesign, decision moments are covered by
exact-match tool bindings and the session-start KB; discovery is covered by agent-composed recall whose usage the store
can finally measure.

## Consequences

- Per-message code paths retire: the nudge handler, prompt-time rule matching, and the tool-recall injection on command
  turns.
- Usage/staleness telemetry exists only on agent-initiated pulls (pointer/automatic surfaces never stamp usage — no
  phantoms in staleness detection).
- PRD 20260911's channel economics section is amended (its "automatic nudge" channel is removed; the explicit-recall
  channel becomes the only memory channel).
- Residual gap, accepted: guidance relevant to upcoming work with no bound tool relies on the floor's recall discipline;
  coverage of that gap (beyond the ~quarter-precision ceiling the matcher could never exceed) is measurable via pull
  counters, and a topic-shift detection nudge stays parked as the fallback if agents demonstrably flail.
