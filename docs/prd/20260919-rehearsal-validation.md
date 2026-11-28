# PRD 20260919: Memory fixes validate by rehearsal, not by deployment

- **Status**: Draft
- **Audience**: the agents that implement and validate memory fixes
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

The store runs on a client host (the only concurrent-session host) and the hub host. A fix validated only by the
hermetic test suite ships blind: the suite builds fresh stores, so the failure modes that need existing state — a
migration guard that never fires on a pre-existing store, an external-content delete against rows the index has never
seen, a tombstone violation that needs a replayed real record — pass CI green and fail in production. When "rebuild a
client host and let me inspect" is the validation step, the operator carries validation load that belongs to the fix
itself, and every fix becomes an experiment on a live machine.

## Requirements

1. **A memory fix is validation-complete when its behavior is demonstrated end to end on a scratch stack.** Deployment
   appears in fix reports only as a delivery option on the operator's timing — never as the validation step. The
   observable: a fix report cites what ran on the scratch stack, not a host rebuild.
2. **`make rehearse` is the validation instrument for memory-store redesign tickets.** It boots the hardened scratch
   stack — the dev-environment gate, a relocated HOME and XDG tree, hub, LLM stub, and daemon — and drives a real
   `opencode run` client leg against a stub model answering SSE, so the client loop runs end to end without touching the
   developer's provider, config, or quota. It captures turns from a real repo worktree, so project resolution exercises
   the worktree-safe path, then asserts the session registry's provenance facts by read-only SQL and log receipts. The
   observables: nothing outside the run directory is written except the two shared content caches; no production service
   is contacted; the stub answers every model request the same way, so the capture → registry → history path reproduces
   run to run.
3. **`make memory-dev` is the interactive leg.** It boots the full stack — hub relay plus one client daemon — against a
   scratch directory on loopback, seeds one capture turn, and follows the record until the daemon consolidates it and
   the episodic row lands locally. The LLM call is answered by a stub server, so every run follows the same path. The
   observable: one seeded capture turn is traceable by hand from the client through consolidation to the local episodic
   row.
4. **Fix PRs carry a rehearsal report.** The report states what ran, and the receipts it asserted — the read-only SQL
   facts and log receipts `make rehearse` checks. Where a bug is behavioral, the report shows the two-variable form: the
   failure reproduced without the fix, then the clean result with it. Unit tests stay the contract layer — fast,
   hermetic, CI-covered, and never cited alone as evidence that a fix works on a deployed system; where a test can
   encode a production-shaped fixture (an old-shape database, a replayed own-record), it should.
5. **Deploys are delivery.** A deploy is a delivery and risk decision — concurrent sessions, runner jobs, host churn —
   that only the operator can time. The rehearsal exists so the deploy delivers already-proven code: the operator-facing
   ask is "deploy when convenient," never "rebuild so I can check."

## Alternatives considered

1. **A staging machine.** Rejected: the scratch stack reaches the same end-to-end path without a second host; revisit
   only if rehearsal drift becomes a recurring cost.
2. **Production data in the rehearsal loop.** Rejected: rehearsal state is scratch-built, never copied from a live
   store, so validation cannot corrupt production inputs and the loop is safe to run mid-session.
3. **A harness maintenance exemption.** Rejected: when the store or record protocol changes, the rehearsal's own
   assumptions are part of the change's blast radius; a rehearsal run catching its own bug is the pattern to expect.

## Non-goals

- No coverage of interactive MCP tool calls through a long-lived opencode session against a live model. `make rehearse`
  covers the store, sync, daemon, and the real client capture path; a live-model session still needs a session to
  observe, and remains the final human-perceptible check.

## Success criteria

- A rehearsal run on a worktree completes with the dev-environment gate passed, the provenance receipts asserted, and
  nothing written outside its run directory but the two shared content caches.
- A redesign fix's PR report names what ran and the receipts it asserted; a behavioral bug's report shows the failure
  without the fix and the clean result with it.
- No fix report cites a deploy or host rebuild as its validation step.
