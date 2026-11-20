# ADR 20260911: No aging for curated rules; record the switch-cost telemetry instead

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Context

Curated rules (persona, behavior, prediction) need a lifecycle policy: what retires a rule that is no longer useful. The
alternative systems examined each answer differently — Mnemosyne's persona table documents tier decay that is not
implemented; the work deployment routes everything to `permanent` to defeat it; the example deployment has no removal
mechanism at all beyond manual demotion. Thatch has no wall-clock decay anywhere: rule confidence is a Bayesian
posterior (confirm/disconfirm; soft signals = 0.25) that moves only on feedback, and stale memory is surfaced as a
hygiene report, never deleted ("thatch never deletes memories on its own").

## Decision

Adopt thatch's approach: no aging for curated rules. Nothing is retired by age; confidence moves only on feedback
signals, and low confidence stops a rule from firing rather than removing it.

Do not build aging, sleep, or consolidation for any tier now. If the system is later forced to age, the switch should be
cheap — so all three tiers record the same hit/usage metrics persona rows carry (fire-count and last-fired for
matcher-fired rules; apply-count and last-applied for the floor). Any future aging regime is then a policy over recorded
history, not a schema migration.

## Consequences

- Persona aging remains what it already is: fullness triggers curation (the agent proposes what to remove or reword to
  fit something new), and the operator confirms. This is unchanged by this decision and needs no aging machinery.
- The behavior/prediction stores grow unboundedly. Thatch's own position is that graded confidence earns its keep "when
  hundreds of rules compete"; with tens, having the rules at all is the binding constraint. That is the bet: populate
  first.
- The no-aging stance is safe only if the feedback loop actually runs — agents grading surfaced rules. Unverified in any
  deployment, including thatch's. The shared telemetry is also the instrument that will show whether grading happens.
