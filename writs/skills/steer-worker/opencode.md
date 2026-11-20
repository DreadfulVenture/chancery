## OpenCode

**Resume, the common case.** `director_steer(sessionID, instruction)` delivers the next instruction as a waking prompt
and returns immediately; each turn end files a report and wakes this session with a fixed notice — call `report_read`
for the bodies.

**Continue without waiting.** Steering is already non-waiting: the coordinator moves on, and the wake notice finds this
session when the turn settles. The coordinator does not wait on parked workers.

**Probe an idle worker.** Two sources, in this order:

1. The session: `director_worker_status(sessionID)` reads the worker's live state — busy or idle, its last outcome, and
   the unread-report counts — from the session API.
2. The worktree: `git log --oneline` and `git status --short` show whether anything landed.

## The report is the signal, not the truth

`director_dispatch` and `director_steer` return before the worker's turn runs; each turn end files a report that
`report_read` returns. The report is the turn-result signal and a claim, never truth: verify against the worktree (the
close-out rule in this skill's body) before reporting anything done, and read a worker's BLOCKED question out of the
pulled report itself.
