# ADR 20261104: Forget tombstones retain the body and are never surfaced

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator across the 2026-11-04 session)
  - Edited: none
  - Approved: none
- **Companion**: PRD 20261104-memory-redesign; ADR 20261104-corrections-are-operations

## Decision

`forget` changes semantics: the row is **tombstoned and retained** — the body stays in its table with a forgotten
marker, and every surfacing path treats it exactly as deleted. Nothing surfaces it: not recall (full-text or vector),
not the knowledge-base build, not consolidation inputs, not the write-nudge pool, not telemetry. The daemon stamps a
provenance edge on the tombstone record (`superseded_by` the replace row's id) so "was this row corrected?" and "what
replaced this belief?" are both queryable without the agent ever seeing, writing, or knowing about the linkage.

Digging stays possible: the body exists, so a direct fetch by id works, and `session_history` carries the conversational
narrative. The store remembers history so agents don't have to; agents see only present tense.

## Alternatives considered

1. **Hard deletion (today's behavior).** Verified on the live snapshot: 0 of 40 sampled tombstoned rows survive in their
   table — the body is gone. Rejected: irreversible; every "what did the deleted row say" question becomes
   session_history archaeology; the one documented staleness-cleanup pass (2026-09-21) had exactly that burden.
2. **A distinct `supersede` verb with a soft hidden state.** Rejected (the operator): adds a third verb and a separate
   lifecycle for a case that has never occurred in the record. Retention + one exclusion flag achieves the same outcome
   with the same two verbs the system already has.
3. **`memory_update` in place.** Rejected for belief changes: destroys provenance (see corrections ADR); acceptable only
   for wording/repair edits, which remain in-place.

## Why this shape won

The threshold question — "is history worth the row's body?" — has a one-sided record: no forensic session ever needed
the retained body of a corrected row (the accepted evidence channel is the raw turn where the wrong claim was made). But
when the need arose in the one documented case, its cost was real, and retention costs one flag plus one filter.
Provenance (the daemon-stamped edge) licenses removal of the prose convention ("Supersedes m18…") without losing the
audit chain — the system carries it so content never has to.

## Consequences

- The exclusion must be **one shared, low-level filter** (a view or query helper), not a per-callsite convention: the
  failure mode is a future consumer leaking a forgotten row, and the protection class matches the reason the rule
  exists.
- Sync: the tombstone event already replays cancellation cross-machine; it now also carries the superseded_by edge.
- Sensitive-purge edge: authoring rules ban secrets, so retention is the default; a genuinely sensitive row needing true
  removal is a rare, explicit, non-default operation (not a daily verb, not part of normal correction flow).
- Migration: existing tombstones record removal only (no retained body, no edge); accepted residue — historical
  forensics keep using `session_history`.
