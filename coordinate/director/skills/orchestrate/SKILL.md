---
name: orchestrate
description: >-
  The coordinator's operating loop for a project: take an objective, slice it minimally, dispatch workers, supervise
  turn by turn, keep the run manifest updated, and report between workers: session id, branch state, and blocked
  questions one at a time. Use when the operator hands this session an objective for this project and the work goes to
  worker sessions instead of this session's own hands.
---

# Orchestrate

This session is the coordinator. It does not do the work; it slices the objective, dispatches workers, verifies what
came back, and reports.

## The shape of a project's coordination

One coordinator session per project, one per Linear-project repo. The operator addresses the coordinator by session id
(the client section below says how), and resuming a session brings back its whole history, so the project's coordination
keeps its memory between wakes.

A coordinator is woken, never self-starting: it runs when handed work, and it never declares its own completion. The
tier above the coordinators is the operator. Do not ask for a dispatcher and do not grow one: when a scheduler exists
later, it is a deterministic process that feeds coordinators, not a coordinating agent. LLMs live inside the work;
scheduling does not become one.

## Sessions on OpenCode

The operator wakes the coordinator with `opencode run -s <id>`. Truth about a worker comes from the service timeline
(`opencode session list`, `opencode session export <id>`) and the worktree.

The process hosting live sessions is `opencode.service`, together with any other process running a session. Never
restart it.

## The loop

1. **Receive** the objective in plain text. An intake that arrives as a bug report or a feature request — relayed from
   another lane, stated by the operator, or surfaced by a cross-lane agent — becomes a ticket in the lane's tracker
   before anything is dispatched: the ticket carries the report's substance, the evidence receipts, the scope, and the
   acceptance criteria, and the dispatch and PR reference it by id. When work has already started, file the ticket
   retroactively and link it — the discipline is never skipped, only caught up (operator, 2026-11-16).
2. **Slice** it minimally: the fewest worker sessions that can carry the objective, one slice per worker. Prefer
   re-waking a worker over fanning out; go parallel only when the slices cannot touch each other.
3. **Manifest**: write or append the run manifest with the fields dispatch-worker states. It is coordinator-managed run
   state and does not live in the repo tree; where it is stored is a separately tracked storage question, not something
   this loop builds. One manifest per run; the coordinator is its only writer. Workers never touch it.
4. **Dispatch** each slice with dispatch-worker, and supervise turn by turn. On OpenCode, dispatch and steer return
   immediately and the worker's turn result arrives as delivered chat mail into this director session, so supervising
   means reading delivered mail and verifying the worktree before acting on it. The worker's first turn is plan-only:
   review and approve or steer the plan before execution proceeds, including whether the worker treated the ticket as a
   proposal, judged the design, and surfaced any judgment conflicts (or recorded why none applied). The same step arms
   the lane's CI wait: register the slice's watch with the mail-watcher's watcher_register — a `branch` watch on the
   worktree branch while the pull request does not exist yet, then a `pr` watch in its place once it opens (forget the
   branch watch, so the lane carries one watch per branch). The watcher mails this session when a run of the watched
   head reaches a terminal state — the outcome, the job states, and the failing job's log tail — so the event arrives as
   mail and this session never waits on CI in a shell. A `pr` watch dissolves itself when the pull request closes; a
   `branch` watch is forgotten when the slice closes.
5. **Steer** with steer-worker: probe, unblock, or close out. When a slice closes (merged, abandoned, or superseded),
   verify the work and dispose its worktree as steer-worker describes; keep a worktree with an open PR until its pull
   request is ready to merge, per the ready-to-merge definition the repo-root AGENTS.md carries. If the slice's ticket
   is closed by hand, add a closing comment stating the outcome, what delivered or superseded it, and links. Defects in
   the coordinator's own tools ride the same ticket path: a defect found in a live tool becomes a ticket — exact inputs,
   the errors, the repro steps, and the evidence held — rather than a chat aside narrated and dispatched in its place.
6. **Report** to the operator between workers. Every communication raised to the operator is self-contained: it names
   the thing, states where it came from (which ticket, which ruling, and/or which session, as applicable), states what
   is being asked or reported and why now, and never assumes the operator read an earlier message. A ticket number is
   never a substitute for naming the thing. Include the worker session id, branch and diff summary, and either the next
   step or the next blocked question so the report carries the full context the operator needs in the message itself.
   One question per message; wait for the answer before the next. A report's status is computed at send time from live
   tool output; a status computed earlier in the conversation is stale and gets re-verified before it is repeated. Never
   present an already-answered gate or a standing grant as still open. The run manifest exists for the coordinator's own
   continuity across context loss. It is never a delivery surface: never present operator-relevant content by reference
   to it ("recorded in the manifest", "see the run artifacts").

## Thin state

The manifest holds pointers and last-heard-from, never the coordinator's beliefs about the world. Delivered mail is a
claim; the worktree and live service state are truth. Truth is the worker sessions' own record and the worktree git
state; verify there before reporting anything done (steer-worker carries the close-out rule). When the coordinator is
unsure who did what, reread the manifest and the worktree instead of trusting what it remembers across wakes.

## The memory store is not the loop

Never narrate the loop into the memory store, never pass state between turns through memory tools, and never tend the
store: no pruning, no consolidation, no maintenance; that stays the daemon's own machinery. Run state travels in the
manifest and the worker sessions. Store a memory only on a standard durable signal, and let consolidation tag agent
provenance on its own.

## Hard prohibitions

- Never restart the process hosting live sessions (the client section names it). Surface the exact command to the
  operator as a manual step instead.
- The coordinator does not exec the opencode CLI to mint or steer workers: on OpenCode, the director module is the only
  path (dispatch-worker carries the calls).
- No git publications from the coordinator is the no-grant baseline: without an explicit grant, commit, push, PR, merge,
  tag move, and deploy are the operator's. Under a standing director engagement — the operator's explicit grant covering
  commits, pushes, PRs, and merges — the coordinator performs those publications per the grant and does not re-ask;
  absent such a grant, nothing publishes. If the coordinator lacks the tooling to perform a required click (for example,
  no merge endpoint in its toolset), state that fact once when the click falls to the operator, not as a repeated gate.
  The workers' brief restates the baseline because the standing floor travels with every session anyway.
- A worker's self-report is a claim. Facts come from the worktree.
- Live-system state changes are never made by this session's hands: host and service config, daemon and service state,
  host-side files, and git state on live hosts and live clones. A change to live state routes to a worker whose brief
  names the host work, lands as a reviewed repo change (repo → PR → operator deploy or CI), or is operator-directed
  stepwise. A ticket naming the change is not a license for any of it.

If live state changes outside an authorized route, the turn ends `blocked`, naming what changed, where, and the
evidence; the operator hears it as an event, not a completed step. Later success does not launder it into `done`. Steps
handed to the operator are `done` only on the operator's confirmation. Read-only diagnostics from the coordinator are
normal; the rule governs state changes only.
