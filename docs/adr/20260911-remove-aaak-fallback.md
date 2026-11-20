# ADR 20260911: Remove the AAAK consolidation fallback — fail-and-retry, never fail-and-fabricate

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Context

When sleep's LLM chain exhausts (remote API down, local model unavailable), the package falls back to "AAAK encoding"
(`core/aaak.py`) and writes the result as an episodic summary. AAAK is a regex phrase-substitution table — "User asked "
→ "ASK ", "Married to " → "MARRIED→", "Software Developer" → "SDEV", "real-time" → "RT" — applied over the raw joined
turns (`beam.py:8455-8463`).

This is a terrible fallback because its output is a fabricated summary:

- **It looks like content but is not readable content.** The episodic row holds `[cursor:xyz] PREF RT AIENG | GH:...` —
  lossy token soup that reads as a summary, ranks in FTS (polluting recall), and is indistinguishable from a real memory
  except by the `llm_used: 0` flag buried in its metadata. A silent failure dressed as success.
- **It damages the durable record irreversibly.** Once written, the mangled row is a legitimate-looking episodic memory.
  The work deployment wrote a repair script (`reconsolidate-fallbacks.py`) whose entire job is deleting these rows and
  re-running the material through the model — keeping the fallback while maintaining a repair script to clean up after
  it is paying twice for the same failure.
- **It erodes the trust contract.** The memory system's value depends on recalled rows being things somebody said or a
  faithful compression of them. A store that contains machine-mangled fabrications with no visible marker trains the
  agent to distrust everything, which is the failure that no repair script fixes.

The deeper defect is the fallback's premise: that sleep producing _nothing_ is worse than sleep producing _garbage_. For
memory consolidation the premise is inverted. A summary that never happens is recoverable — the rows still exist; the
next pass can try again. A summary that fabricates is not recoverable by anything that trusts the store.

## Decision

Remove the AAAK fallthrough entirely. When the LLM chain exhausts:

1. **No summary is written.** The group is skipped, not mangled.
2. **The claim is released.** The working-memory rows keep their unconsolidated state and TTL (the work deployment holds
   captured rows 48h by design), so the next sleep pass retries them. Consolidation is allowed to wait; it is not
   allowed to fabricate.
3. **The pause is alarmed, not silent.** With AAAK gone, "consolidation paused" is the one failure state worth
   monitoring: a one-query alarm on the nudge-eligible backlog (unconsolidated captured rows), since sleep otherwise
   reports the same either way.

The claim/release contract is prerequisite machinery: compaction claims must set both `consolidated_at` and
`consolidation_claimed_at` (the package's `reclaim_orphans` contract), so released groups are visible and retryable —
the same fix already required for the 564 hub rows stranded by the claim-survives-summary-fails ordering.

## Alternatives considered

1. **Keep AAAK as last resort** (status quo). Rejected on the grounds above: it fabricates durable content.
2. **Truncation fallback** — write the first N chars of the joined turns, marked `llm_used: 0`. Considered; rejected. It
   does not fabricate, but it still poisons FTS with raw-fragment noise, and the repair script then has to distinguish
   three row classes instead of two. No-summary-with-retry is strictly simpler and strictly safer.
3. **Hard-fail sleep** — raise on LLM exhaustion, abort the whole pass. Rejected: other groups in the same pass are
   independent and should still consolidate; failing loudly per-group with retry-next-pass gives the same visibility
   without losing good work.

## Consequences

- Deployment shapes: the example deployment's chain is effectively one link (the 397B cloud route), so an LLM outage
  pauses consolidation until it returns — with the 48h-class TTLs and fast catch-up drain, this is correct behavior. The
  work deployment's ladder becomes remote → local 14B → wait; the local model must remain the 14B (the 7B was documented
  to lose speaker attribution and draft status — a weak local model failing loudly into wait is fine; failing silently
  into mangled output was the bug class).
- The `llm_used: 0` monitoring surface changes meaning: today it detects fabricated rows after the fact; post-removal
  there are none, and the alarm moves to paused-backlog count, which detects the same outage before damage.
- Existing fabricated rows (zero on the example hub at audit; unknown count on the work deployment) are repaired by the
  fallback-reconsolidation script, which remains in scope.
- Local-model sizing pressure inverts: the local model no longer needs to be "always available" (that was AAAK's job);
  it needs to be "good enough when present." A smaller local model that is skipped in favor of wait is acceptable; a
  smaller local model that produces bad summaries is not — the distinction is now a routing choice, not a fallback
  accident.
