# PRD 20260911: Record-log sync and store convergence

- **Status**: Draft
- **Companion ADRs**: `docs/adr/20260911-record-log-sync-weighting.md` (the decision),
  `docs/adr/20260911-replace-mnemosyne-library.md` (the store it runs on)
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

The mnemosyne package's SyncEngine (2,231 lines) replicates working rows between machines through a shared-surface
mirror, parallel to our own record path (hub_records + cursor pull) that already carries episodic and persona
distribution. The store rewrite removes the package; this PRD specifies the replacement: one record-log protocol, full
per-machine convergence, and the conflict behavior the ADR settled (weighting, not merging).

## Topology

- **Every machine holds a complete store** — all captures, all deliberate memories, all episodic summaries, all curated
  rules — with full local function: local scoring (nudge and explicit recall), local rendering, local codification. No
  read touches the network.
- **The hub host is the relay and the consolidator.** It receives all inbound records, logs them for cursor-paged pull,
  and runs the consolidation loop (captured turns in, episodic summaries out — claim/release per the AAAK ADR, our LLM
  call, no fallback).
- Machines: four client hosts and one hub host. The operator's work system is outside this protocol entirely.

## Record protocol

One log, one upsert. Record kinds:

| Kind       | Direction                   | Payload                                                                                    | Notes                                                                |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `capture`  | up from origin, down to all | raw turn row (id, source, role-labeled content, timestamps, kind)                          | every machine converges on every session verbatim                    |
| `memory`   | up + down                   | deliberate write row                                                                       | corrections, facts, preferences; label discipline per the memory PRD |
| `episodic` | down only                   | episodic summary row                                                                       | single writer (the hub); no conflict surface                         |
| `rule`     | up + down                   | curated row (tier, scope, matcher/statement/rationale, status, provenance, origin machine) | persona, behavior, prediction all ride this kind                     |
| `feedback` | up + down                   | counter increments (rule id, signal type, delta)                                           | accumulative; never a counter value                                  |
| `forget`   | up + down                   | row id to delete                                                                           | the delete path; without it stores drift                             |

Transport: the existing shape — authenticated POST up (batched JSONL queue), cursor-paged GET down
(`/records?cursor=N`), idempotent apply. The hub relay does not interpret, merge, or reorder; it logs and serves.

### Apply semantics

- Upsert by row id; apply is idempotent and re-runnable.
- Embedding happens on apply (the apply machine embeds with the pinned local model — same model everywhere, pinned in
  the module; vectors are never shipped).
- `capture` rows apply into working memory; `episodic` into the episodic table; `rule` into the curated tables;
  `feedback` increments side-table counters.
- Hub-side: `capture` rows additionally land in the consolidation-input store the sleep loop consumes.

## Conflict behavior (per the ADR)

- **Captures, memories, episodic**: last-write-wins. Append-mostly; same-content siblings are convergence, not loss.
- **Curated rules**: origin-keyed rows — a rule codified on machine A is A's row; a similar rule codified on B is a
  different row. Siblings coexist.
  - Near-duplicates: fire-time cosine suppression among fired candidates (~0.9, keep strongest) plus the confidence loop
    spams the weaker one below threshold over time.
  - Query-before-create and nearest-matcher linking at codify time prevent most duplicates once rows have synced down.
  - Rare cross-machine edits of a synced row: LWW. Bounded damage — the rule survives in pre-edit form.
- **Persona floor**: proposals are additive (two pending proposals are a queue). Floor confirmation is human-paced and
  serializes through the operator. Parent mismatch on an inbound floor state flags both versions for the next
  confirmation — detection at the point the human is already in the loop. No machinery beyond this.
- **Feedback**: increments only; order-independent; confidence is derived deterministically from the same counts on
  every machine. Never synced as values.

## What this deletes

- The package SyncEngine and its dependency.
- The shared-surface concept and `sync_surface_id` row tagging.
- The persona op queue and snapshot mechanism — rules ride the record log as rows; the floor render becomes a
  per-machine deterministic view of converged state.
- The hub's `memory_events`/`sync_memory_state` bookkeeping (5,409 events, 994 of them hub-authored rows no client
  consumes).
- Per-kind routing in apply — one upsert, one cursor.

## Freshness and retention

- **Pull cadence is load-bearing for the nudge pool**: stale pool = stale nudges. The sync loop runs at the existing 60s
  interval; record volume (~40/day today, growing with capture mirroring) keeps this ample. Requirement, not detail:
  pool age at inject time should be bounded by the pull interval, and the interval must be revisited if record volume
  grows past what a 60s pull drains comfortably. A long-poll GET on the hub is the pre-agreed escalation if push-style
  freshness is ever wanted.
- **Raw turns are kept forever, deliberately**, on every machine and on the hub — converting the package's inherited
  additive-consolidation default into stated policy. Rationale: explicit verbatim recall is a capability (PRD: raw turns
  reachable by explicit recall, labeled); the cost is per-machine bytes (~120k rows/year projected — trivial for
  SQLite).
- **Deletes propagate** via `forget` records; a row forgotten on any machine disappears everywhere. This is the
  remaining sync-semantics surface and the one apply path that must handle ordering (delete-after-resurrect is a
  legitimate sequence).

## Local function guarantees

- Nudge scoring, explicit recall, rule matching, floor rendering, codification, and feedback all run machine-local,
  offline-capable.
- Cross-machine raw recall works locally post-sync: an agent on a client host can pull exact session lines from a
  conversation originated on another client host by source filter, because the rows are in the agent's own store.
- A machine offline for weeks rejoins by draining its outbound queue and pulling the cursor forward; the queue is
  unbounded text and retention is not a concern.

## Non-goals

- No P2P mesh, encrypted payload layers (TLS to the hub suffices), vector clocks, or conflict-resolution tables — the
  star topology with per-row single writers does not have these problems.
- No partial or scoped stores per machine (no read-cache tier); the capability-first decision was full convergence.
- No retention/TTL machinery for any row kind.
- No compatibility with the operator's work system; that deployment shares nothing with this protocol.

## Success signals

- All machines converge to identical store contents (modulo cursor position and machine-local side tables) within the
  pull interval after any write.
- Cross-machine raw recall works on every machine for every session.
- An offline machine rejoining after N weeks loses nothing it captured and receives everything it missed; the only
  observable effect of the gap is delay.
- No row kind requires merge logic to converge; the fire-time suppression threshold measurably collapses duplicate fires
  (visible in fire telemetry).

## Open items

- `forget` ordering semantics (delete-after-resurrect; tombstone lifetime if the delete must survive a delayed replay of
  the original write).
- Long-poll vs fixed-interval pull (fixed 60s first; escalate on evidence).
- Capture record batching size vs apply embedding cost (each applied capture embeds once; a large backlog after offline
  rejoin should embed concurrently with drain).
- Whether the floor parent-mismatch flag needs any UX beyond the confirm-time listing (probably not — the confirm path
  is the UX).
- Hub auth for the record endpoints (existing hub_records auth carries forward; confirm no new endpoints are needed
  beyond `/records`).
