---
name: dispatch-worker
description: >-
  Spawn a worker session against a work brief inside its own worktree: create the worktree, dispatch the worker session
  and capture its session id, and record the dispatch in the run manifest. Use when a coordinator needs a new worker for
  one slice of work, or when the operator asks to dispatch a worker.
---

# Dispatch worker

A slice means one worker session in one worktree of its own. Everything after the first turn is steer-worker's business.

## Steps

1. **Worktree.** Fetch origin and fast-forward to origin/main before creating the worker's worktree: the worker's base
   ref is whatever origin/main is at dispatch time, never a remembered tip or a stale local checkout. The brief's
   verify-first line stays: the worker confirms the exact base commit at start and stops dead on mismatch. An old base
   ref replays already-merged defect classes into review: "the shipped standard" of yesterday, found and fixed in the
   meantime. Before an unattended push, run the repo's own gate once inside the fresh worktree. Discover the gate from
   the repo itself - its flake, Makefile, package scripts, or AGENTS.md; never assume nix or pre-commit, and repos with
   neither have nothing to generate. Hooks are never silenced or bypassed (PRE_COMMIT_ALLOW_NO_CONFIG and --no-verify
   are out). Create the worker's worktree as the client section below says. That directory is the worker's blast radius;
   every step below happens inside it. The coordinator creates a worktree for the slice and owns its lifecycle: keep it
   only while the slice has live work, and dispose it when the slice closes (merged, abandoned, or superseded), as
   steer-worker describes. Do not leave debris or ask the operator to clean it up.
2. **Brief.** Fill the template below; everything the worker must or must not do appears in the brief. Do not rely on
   the worker guessing. Reported defects and features arrive as tickets (the loop's intake owns the filing); a dispatch
   without its ticket id is the failure the intake rule exists to stop.
3. **Pre-create scratch resources.** Before the first turn, create any scratch resources the worker needs inside its
   worktree, so it never needs a shell command referencing a path outside the worktree. The worktree is the boundary the
   worker's work lives inside.
4. **Dispatch** the worker session from inside the worktree, as the client section below says, and capture its session
   id. On OpenCode the dispatch is the director module: it returns immediately, and the worker's turn result arrives
   later as delivered mail to this director session.
5. **Record** the manifest row before anything else: session id, worktree path, slice, status. The manifest row is the
   only address that survives the coordinator's own context loss.

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

## Brief template

```
objective : <the slice, one or two sentences>
worktree  : <the path the worker works in>
commit    : local commits on this branch, at the brief's word; never push
standing  : <the never-restart line from the client section>; no push, PR, merge, tag, deploy
report    : end every turn with STATUS: <done | working | blocked> + one line
```

Worker contract, verbatim in every brief:

- First turn is the plan turn: one-line acknowledgment plus the plan of attack, ending with `STATUS: planned`. The
  worktree stays untouched in this turn; the plan is the turn's deliverable.
- Execution is a separate turn and starts only after the coordinator approves the plan. A brief may authorize planning
  and execution in a single turn only when it says so explicitly.
- Treat ticket proposals as proposals, not literal specs. Before building, judge the design against overall health and
  maintainability of what ships (does this option earn its surface area? does the default fit the real use case? is the
  failure mode acceptable?). Push back or amend the plan rather than shipping the literal reading when judgment says so.
- If your judgment conflicts with what the ticket literally says, do not silently pick a side: ask the operator to weigh
  in (comment in the ticket or assign them, the same way the loop routes questions) before building the contested part.
  State the conflict and your recommendation in the plan or turn.
- Record design reasoning in the ticket or PR (or in commit and PR text you prepare) so review can see what was judged,
  not just what was built.
- Stuck is a stated outcome: end the turn with `BLOCKED:` and the question verbatim. Do not guess, do not paper over, do
  not silently work around a blocker.
- Done is never a claim: the worktree holds the change (`git status` and `git diff` show it, or the commits the brief
  asked for exist) and the relevant tests or build ran; say what ran.
- State lives in the worktree and the turn reply only. The coordinator reads nothing else, and the memory store is not a
  channel.
