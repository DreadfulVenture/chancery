## OpenCode

**Worktree.** Call `worktree_add` (the director module's; it runs `git worktree add` itself and tracks the worktree) and
use the directory it returns.

**Dispatch and steer — the director module only.** The coordinator never execs the opencode CLI to mint or steer
workers. Dispatch and steering are plugin calls on this session:

- `director_dispatch(directory, brief, agent?, title?, model?, base?)` creates the worker session in `directory` — the
  agent defaults to `build` — stamps this session as its coordinator, and delivers the brief as a waking prompt. It
  returns immediately with the session id and an acknowledged status. When `base` names the commit the worktree's HEAD
  must be at, the worktree is validated at the call and a stale or detached HEAD refuses with both commits named,
  instead of a worker discovering it mid-turn.
- `director_steer(sessionID, instruction)` re-prompts an existing session as a waking prompt; it returns immediately.
- `director_worker_status(sessionID)` reads a session's live state (busy or idle, its last outcome, the dispatch stamp);
  convenience only, never authoritative over the worktree.

The exact shapes and semantics live in the module's own doc lines (plugin/director.ts). The dispatcher returns before
the worker's first turn runs: each turn end files a report and wakes this session with a fixed notice (the worker
session and the unread count) — call `report_read` for the bodies. Worker text never arrives in context on its own; it
reaches the model only as a `report_read` tool result, never as stdout.

**Failure reports.** A pulled report that says turn-not-completed is a dead turn: re-dispatch. The upstream can hiccup
independent of anything the brief said.

**Permissions.** A director-dispatched worker runs under the deployment's permission rules, not under a headless flag. A
command that stops on a permission ask parks the worker's turn, and a parked turn files no report: keep the worker's
work inside its worktree so no ask fires.

**Never-restart line** for the brief's `standing` field: `never restart opencode.service`.
