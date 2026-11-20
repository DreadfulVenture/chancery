# ADR 20260919: Memory fixes validate by rehearsal, not by deployment

- **Status**: Draft
- **Provenance**:
  - Authored: agent, 2026-09-19
  - Edited: (none)
  - Approved: (none)

## Context

The memory store is deployed on a client host (the only concurrent-session host) and the hub host. During the first days
of ownership, every fix — session context stamping, the migration guard, the vec0 knn shape, the forget-tombstone sync
poison — was validated the same way: build, merge, then ask the operator to rebuild a client host, wait for the deploy,
and inspect live state. That loop failed three ways, repeatedly:

1. **The validator was the operator.** Validation depended on the operator's rebuild at their convenience — "pause
   concurrent work, rebuild" — for checks that were ours to run. Deploys are delivery decisions; they were carrying
   validation load.
2. **Fresh-database blind spots.** The test suite builds fresh stores, and three of the day's bugs lived exactly where
   fresh data can't go: a migration guard that never fired on pre-existing stores, an FTS5 external-content delete
   against rows the index had never seen, and a forget-tombstone UNIQUE violation that required a _replayed real record_
   to fire. Each shipped through CI green and failed in production.
3. **A dev environment existed and was underused.** `make memory-dev` (an operator-directed requirement) boots the full
   stack locally; the contract and convergence tests exercise real handlers. But neither ran against _production-shaped
   state_ — real corpus, real record log, real cursor — which is where the actual failure modes lived.

The trigger: yet another fix report ended with "rebuild a client host to validate" after a local drill had already
proven the fix. The operator's correction: the local dev environment was built so the client host would not need
deploying every few minutes; validation was to happen there.

## Decision

**A memory fix is validation-complete when its behavior is demonstrated against production-shaped state locally.
Deployment appears in fix reports only as a delivery option on the operator's timing — never as the validation step.**

Concretely:

1. **`make memory-rehearsal` is the validation instrument.** It runs the stack from the worktree against real production
   state obtained read-only: a client host's live store via the sqlite online-backup API, the hub's actual record log
   via GETs served locally. It prints what a deploy would do — cursor movement, backlog applied by provenance, sync
   failures. Nothing in the rehearsal writes to a production machine.
2. **Fix PRs carry a rehearsal report.** The report shows the fix's effect on real-shaped data (cursor movement, applied
   records, failure counts) and, where a bug is behavioral, the two-variable form: reproduce the failure without the
   fix, then the clean result with it.
3. **Unit tests and drills remain the contract layer; rehearsal is the integration layer.** Fresh-store tests stay
   (fast, hermetic, CI-covered), but they are never cited as evidence that a fix works on the deployed system. Where a
   test _can_ encode the production shape (old-shape DB fixtures, own-record replay), it should — the rehearsal
   complements it, it does not replace it.
4. **Deploys stay the operator's, deliberately.** A deploy is a delivery and risk decision (concurrent sessions, runner
   jobs, host churn) that only they can time. The rehearsal exists so that their deploy is a delivery of already-proven
   code, not an experiment on a live machine.

## Consequences

- Fix cycles no longer require host rebuilds to reach confidence; the operator-facing ask shrinks from "rebuild and let
  me inspect" to "deploy when convenient."
- The rehearsal runs against real data read-only, which means validation cannot corrupt prod inputs — the loop is safe
  to run mid-session.
- Residual gap, named: rehearsal cannot validate the _interactive_ surfaces — MCP tool calls through a live opencode
  process and plugin. Those still require a session to observe. The rehearsal covers the store, sync, and daemon;
  harness-level behavior is unit-tested; only the final human-perceptible check remains live.
- Harness maintenance is in scope going forward: when the store or record protocol changes, the rehearsal's fetch/serve
  assumptions are part of the change's blast radius. The first rehearsal run catching its own direction-label bug is the
  pattern to expect.

## Alternatives considered

- **Status quo** (deploy-to-validate): the failure this ADR corrects — operator-loaded validation, repeated live-only
  discovery.
- **A staging machine**: a full host mirror is the heavyweight version of the same idea; the store copy + log fetch
  achieves production-_shaped_ inputs at a fraction of the machinery. Revisit if rehearsal drift becomes a recurring
  cost.
- **More unit tests only**: necessary but insufficient — the blind-spot class is specifically "fresh store, no history,
  no legacy shape," and no fresh fixture exercises what production-shaped state exercises.
