# PRD 20260911: Record-log sync and store convergence

- **Status**: Draft
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

The store runs on several machines at once and must stay one store: every machine holds everything, recalls and writes
with no network round trip, and a record written anywhere lands everywhere. One record-log protocol delivers that — one
log, one upsert, full per-machine convergence, and divergence resolved by weighting rather than merging.

## Topology

- **Every machine holds a complete store** — all captures, all deliberate memories, all episodic summaries, all curated
  rules, the session registry, knowledge bases, tool bindings, and the entity directory — with full local function:
  local recall, local rendering, local codification. No read touches the network.
- **The hub host is the relay.** It authenticates inbound records, logs them for cursor-paged pull, and serves them; it
  does not interpret, merge, or reorder. The hub host also runs the consolidation loop, which produces episodic records
  as a writer — that is a producer on the same host, not a step in the sync path.
- Machines: four client hosts and one hub host. The operator's work system is outside this protocol entirely.

## Record protocol

One log, one upsert. Eleven record kinds (`RECORD_KINDS` in `memory_store/store.py`):

| Kind             | Direction | Payload                                                                   | Apply                                                                                                                                                     |
| ---------------- | --------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`        | up + down | raw turn row                                                              | working-memory upsert plus the session-history turn; every machine converges on every session verbatim                                                    |
| `memory`         | up + down | deliberate write row                                                      | working-memory upsert at deliberate origin                                                                                                                |
| `session`        | up + down | registry row (machine, tool, conversation id, project, parent, initiator) | registry upsert; the only kind that carries child registrations no turn record names                                                                      |
| `agent_memory`   | up + down | deliberate fact, insight, or decision row                                 | upsert with the session resolved from its (machine, tool, conversation, project) triple — the FK is satisfied                                             |
| `knowledge_base` | up + down | one composed knowledge-base version                                       | upsert; the standing winner is the highest build seq with the newest created at that seq, identical everywhere                                            |
| `tool_rule`      | up + down | tool binding enrollment                                                   | content-addressed: every machine re-mints the ids from the payload, so all converge on the same rows                                                      |
| `episodic`       | down only | episodic summary row                                                      | upsert; single writer (the hub's consolidation loop)                                                                                                      |
| `rule`           | up + down | curated row, `target`: persona or situational                             | upsert into `persona_rules` or `situational_rules`                                                                                                        |
| `feedback`       | up + down | counter increment (rule id, kind, signal, polarity, delta)                | accumulative; never a counter value                                                                                                                       |
| `forget`         | up + down | table and row id                                                          | tombstone first, then delete — a delayed replay of the original write cannot resurrect; an entity forget adds an `entity_forgets` row instead of deleting |
| `entity`         | up + down | directory operation with an `op` field                                    | insert-if-absent or set-if-empty keyed on the payload id, so any apply order reaches the same state                                                       |

Transport: authenticated POST up (batched JSONL queue), cursor-paged GET down (`/records?cursor=N`), idempotent apply.
The relay validates each record's envelope and the payload of kinds it knows; a record that fails validation is logged
with its reason and stepped over by pullers, never applied.

### Capture is 1:1

Whatever the client provides as a turn is captured, stored, and relayed verbatim — drain → local store → hub record log
→ pull → apply. No drop, no truncation, no quarantine, and no size or count limit anywhere on the capture/sync path: the
ingest edge is bounded only by what the client actually sends. The hub validates identity and contract, never volume. A
very large turn is handled where it is processed — chunked summarization, embedding truncation — not by refusing it at
the door. An end-to-end test pins the contract (a turn just over 4 MiB through drain → hub → pull, byte for byte); any
reintroduced mid-wire limit turns it red. Volume problems are fixed when they exist, with measured data.

### Set-aside semantics (forward compatibility)

No new record kind needs an ordered rollout. A record this machine cannot apply — a kind it does not know, or an apply
that raises for a known one — is set aside with its reason in a machine-local `deferred_records` table, and the cursor
moves on; raising instead would fail the same page on every cycle and stall everything behind the gap. Deferred records
are retried at startup and after each pull, oldest first, and a later record for a row that already has one set aside is
set aside behind it, so a row's edits land in log order even when one of them is deferred. The relay accepts any kind
with a valid envelope and checks payloads only for kinds it knows, so a record written before every machine is upgraded
still reaches the others. A record that can never apply stays deferred and visible; nothing retires it automatically.

### Conflict semantics

- **Captures, memories, episodic**: last-write-wins. Append-mostly; same-content siblings are convergence, not loss.
- **Curated rules**: origin-keyed rows — a rule codified on machine A is A's row; a similar rule codified on B is a
  different row. Siblings coexist. Near-duplicates are a write-time concern (`memory_find_duplicates` warns at codify
  time) and a retrieval concern (confidence ranking); the feedback loop is the lifecycle. Rare cross-machine edits of a
  synced row resolve last-write-wins; a lost edit costs "the refinement didn't stick once," not "the rule vanished."
- **Persona floor**: proposals are additive (two pending proposals are a queue). Confirmation is human-paced and
  serializes through the operator; a parent mismatch on an inbound floor state flags both versions at the next
  confirmation — detection at the point the human is already in the loop. No machinery beyond this.
- **Feedback**: increments only; order-independent; every machine derives confidence deterministically from the same
  counts. Confidence values are never synced.
- **Forgets**: tombstone-first ordering is the one apply path that must respect log order; delete-after-resurrect is a
  legitimate sequence and the tombstone refuses it.

## Freshness and retention

- The sync loop runs on a fixed interval; record volume keeps a single cycle ample, and a long-poll GET on the hub is
  the pre-agreed escalation if freshness is ever wanted.
- **Raw turns are kept forever, deliberately**, on every machine and on the hub — a stated policy, not an inherited
  default. Verbatim recall of a past conversation is a capability; the cost is per-machine bytes, trivial for SQLite.
- **Deletes propagate** via `forget` records; a row forgotten on any machine disappears everywhere. Without them, stores
  drift on invalidated memories.

## Local function guarantees

- Recall, rendering, codification, grading, and consolidation-side reads run machine-local, offline-capable.
- Cross-machine raw recall works locally post-sync: an agent on a client host pulls exact session lines from a
  conversation originated on another client host by source filter, because the rows are in the agent's own store.
- A machine offline for weeks rejoins by draining its outbound queue and pulling the cursor forward; the queue is
  unbounded text and retention is not a concern.

## Non-goals

- No P2P mesh, encrypted payload layers (TLS to the hub suffices), vector clocks, or conflict-resolution tables — the
  star topology with per-row single writers does not have these problems.
- No partial or scoped stores per machine; full convergence is the decision.
- No retention or TTL machinery for any row kind.
- No compatibility with the operator's work system; that deployment shares nothing with this protocol.

## Success signals

- All machines converge to identical store contents (modulo cursor position and machine-local side tables) within the
  pull interval after any write.
- Cross-machine raw recall works on every machine for every session.
- An offline machine rejoining after N weeks loses nothing it captured and receives everything it missed; the only
  observable effect of the gap is delay.
- No row kind requires merge logic to converge.
- A record of a kind one machine does not know yet defers there without stalling the log, and applies untouched once
  that machine is upgraded.

## Open items

- Capture record batching size vs apply embedding cost (a large backlog after offline rejoin should embed concurrently
  with drain).
- Whether the floor parent-mismatch flag needs any UX beyond the confirm-time listing (probably not — the confirm path
  is the UX).
- Hub auth shape for the record endpoints (existing hub auth carries forward; confirm no new endpoints are needed beyond
  `/records`).
