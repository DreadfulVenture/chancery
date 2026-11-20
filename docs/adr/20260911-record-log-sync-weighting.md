# ADR 20260911: Record-log sync with weighting, not merging

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Context

The store-rewrite ADR (`20260911-replace-mnemosyne-library.md`) removes the mnemosyne package, whose SyncEngine (2,231
lines: event log, hash chains, vector clocks, conflict resolution, P2P mesh, payload encryption) currently replicates
working rows between machines. The replacement topology is settled: every machine holds a complete store with full local
function; the hub host handles consolidation (LLM summarization of captured turns into episodic rows) and acts as the
relay point for distribution. Four client machines exist; write patterns are per-machine capture, human-paced deliberate
writes, hub-only episodic production.

Two findings from the current system motivated a redesign rather than a port:

1. **The SyncEngine is mostly dead weight in this topology.** Our deployment runs it in relay mode over record kinds
   that are ours (episodic, persona_snapshot, ops) — payloads it never interprets — alongside our own
   cursor-pull/push/apply code, which already carries the actual distribution. The hub's event log contains 994
   hub-authored events no client will ever pull. Its conflict and encryption machinery solves problems a hub-relayed
   star with one writer per row kind does not have.
2. **Offline windows make "last-write-wins" subtly wrong for shared mutable rows.** The motivating scenario: a laptop
   offline for weeks holds queued edits while a client host edits the same row; when the queue drains, timestamp order
   does not track causality — the edits are siblings, not a sequence, and LWW silently discards one side's intent.
   Analysis initially concluded this required parent-chain lineage and merge machinery for the curated corpus. That
   conclusion was wrong for a second reason: it modeled curated rules as shared mutable documents.

The corrected model: **most curated rules are append-mostly and origin-scoped, not shared-mutable.** Rules codified on
different machines are different rows. Near-duplicate rules are a retrieval problem (weighting), not a correctness
problem (merging). The one genuinely shared-mutable, capacity-limited surface is the persona floor, which already has a
human confirmation gate in its write path.

## Decision

Replace the SyncEngine with a minimal record-log protocol, and resolve divergence by weighting rather than merging.

- **One record log, one apply path.** Record kinds: `capture` (raw turns, up from every machine, down to every machine),
  `memory` (deliberate writes, all-to-all), `episodic` (hub-produced, down only), `rule` (curated rows — persona,
  behavior, prediction — all-to-all), `feedback` (counter increments, all-to-all), `forget` (deletes, all-to-all). Apply
  is idempotent upsert keyed by row id. The hub relay stays dumb: it applies inbound records and logs them; it does not
  interpret, merge, or reorder.
- **Full convergence per machine.** Every machine holds all raw captures, all deliberate memories, all episodic
  summaries, all curated rules. Cross-machine raw-session recall must work locally (an agent on any machine can pull
  exact session lines from any other machine's sessions). Projected volume (~120k capture rows/year/machine) is trivial
  for SQLite; the capability is worth more than the deduplication.
- **No merge machinery.** Curated rules are origin-keyed rows: a rule codified on machine A is A's row; a similar rule
  codified on machine B is a different row. Sibling rules coexist. Near-duplicates are handled at retrieval: fire-time
  cosine suppression among candidates (~0.9, keep the strongest), and the confidence loop over time spams the weaker
  duplicate below firing threshold — feedback is the lifecycle. Codify's existing query-before-create plus
  nearest-matcher linking prevents most duplicates once rows have synced. Rare cross-machine edits of a synced row
  resolve last-write-wins; a lost edit costs "the refinement didn't stick once," not "the rule vanished."
- **The floor keeps its gate, and gains only a notification.** Floor proposals are additive (two pending proposals are a
  queue, not a conflict). Confirmation is human-paced and serializes through the operator. If floor changes were
  confirmed on two machines during a sync gap, the apply path flags parent mismatch and surfaces both versions at the
  next confirmation — detection at the point where the human is already in the loop. No parent-chain machinery beyond
  this.
- **Feedback is accumulative.** Ham/spam and fire/apply telemetry ship as increments, never counter values; every
  machine accumulates independently, and confidence is derived deterministically from the same counts everywhere.
  Order-independent by construction — no conflicts possible.
- **Git remains a projection, not a store.** Rendered floor and full-row JSON backups refresh into a git-tracked
  directory on every render (the work deployment's `backup/` pattern) for diffing, history, and restore. Nothing
  operational reads from it; the store does not live in it.

## Alternatives considered

1. **Port the package SyncEngine.** Rejected: its features target P2P mesh, encrypted transports, and conflict chains
   that a hub-relayed star with per-row single writers does not have. The current deployment's own event log
   demonstrates the dead weight (hub-authored events no client consumes).
2. **Git as the curated store.** Rejected on three counts: telemetry is runtime-cadence and git is review-cadence; at
   projected curated-rule volume the merges would be machine-resolved, removing git's review leverage while keeping its
   per-write ceremony; and divergence reconciliation happens in the agent write path, which would have to wrap git in
   the same logic anyway. Git survives as the render projection only.
3. **Parent-chain lineage with reconcile-on-write for all curated rows.** Considered and designed in session, then
   rejected: origin-keying prevents the shared-mutable case it exists for, fire-time suppression plus the confidence
   loop handles the duplicate residue, and the volume assumption (hundreds-to-thousands of agent-authored rules, no hand
   review) makes per-divergence merge state unbounded busywork. Parent pointers survive as ordinary provenance metadata
   (who codified, from what signal), not as a merge structure.
4. **Hub-side lazy fetch for cross-machine raw recall.** Rejected: caps the capability at network reachability,
   contradicting full-local-function. Full mirroring of captures costs bytes only.

## Consequences

- Deletes: the SyncEngine dependency, the shared-surface concept and its row tagging, the persona op queue and snapshot
  mechanism (rules ride the record log as rows; the floor render becomes a per-machine view of converged state), and any
  per-kind routing logic in apply (one upsert).
- The hub keeps: consolidation loop (claim/release per the AAAK ADR), the record log, and render-hash bookkeeping until
  the curated tiers ship their own render.
- Pull cadence becomes load-bearing for nudge-pool freshness (stale pool = stale nudges); the sync spec must state a
  freshness requirement rather than leave it implicit. Current record volume (~40/day) makes the existing 60s pull
  ample; a long-poll is a trivial addition if volume grows.
- Raw-turn retention becomes a stated policy rather than an inherited package default: the package's
  additive-consolidation experiment ("originals remain recallable forever, TTL never touches consolidated rows") is
  accepted deliberately as keep-forever on every machine, because explicit-recall-of-verbatim-history is a capability
  and the cost is per-machine bytes. The hub's consolidation-input rows follow the same keep-forever policy (simpler
  than adding a TTL mechanism, and the 564-orphan class dies with the claim/release contract regardless).
- Deletes propagate to every machine via `forget` records; without them stores drift on invalidated memories. This is
  the actual remaining sync semantics surface.
- The work deployment is unaffected: it pins its own package copy, runs its own local store, and shares nothing with
  this protocol. Cross-fertilization stays at the reference level.
- Confidence values are never synced; only increments are. Machines converge on counts and compute identical posteriors.
