---
name: steer-worker
description: >-
  Continue, probe, unblock, or close out an existing worker session: resume it with the next instruction, continue it
  without waiting, probe idle state through the session's own record and the worktree git log, route BLOCKED exchanges
  to the operator, and verify the worktree before reporting anything finished. Use for every interaction with a worker
  after its first dispatch, and before any completion claim.
---

# Steer worker

@clientBlock@

## BLOCKED routing

On `BLOCKED:` from a worker:

1. Route the blocker to the operator as a self-contained message (not a continuation of an earlier turn): name the thing
   and slice, state where it came from (which ticket, ruling, and/or session, as applicable), state what is blocked and
   in what worker/session, what was already tried, and what is being asked and why now. Include the worker's question
   verbatim, the worker's session id, and the manifest row. A ticket number is never a substitute for naming the thing.
   One question per message; wait for the answer.
2. The operator's answer is the next instruction, not advice to interpret: append the exchange to the manifest's
   decision ledger (question, answer, date) and resume the worker with it.

## Close out, only before reporting done

Verify with the worktree itself, never with the worker's word:

- `git log --oneline -5` and `git status --short` show what exists.
- The tests or builds the brief named ran, and the worker said what ran.
- The diff shape or commit list matches the slice.

Anything short of that reports as `WORKING`, not done. A close-out message names the session id, what exists in the
worktree, and what ran.

When the slice's outcome is final, the coordinator disposes the worktree: remove it and discard untracked state, and do
not leave debris or ask the operator to clean it up. Dispose on close when the slice is merged, abandoned, or
superseded. A worktree with an open PR stays until merge. Disposing a worktree does not replace verification; verify
what exists and what ran before reporting done, and keep the worktree in place while its PR remains open.

## Status vocabulary

The coordinator's upward report uses exactly three words: `done` (verified against the worktree), `working` (in flight),
`blocked` (question stated and waiting). A live-system change made outside an authorized route, or by the coordinator's
own hands, is reported as `blocked`, never as `done`. There is no fourth word; "almost" is `working`.

Each status is verified against the worktree and live service state at send time; a status computed earlier in the
conversation is stale and gets re-verified before it is repeated. While an operator discussion is open, hold status
interjections and recaps until the discussion closes or the operator asks for status.
