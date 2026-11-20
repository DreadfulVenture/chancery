# ADR 20260921: Consolidation moves to the client daemon — hub becomes relay-only

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: none
  - Approved: none

## Context

Consolidation — the LLM summarization of captured conversation turns into episodic rows — currently runs only on the hub
host, polling on a fixed cadence with claim/release per the AAAK ADR. The placement was inherited from the
mnemosyne-wrap era and written down after the fact: the record-log PRD/ADR (20260911) declared "the hub host is the
relay and the consolidator" and "episodic: down only, single writer (the hub); no conflict surface." Neither statement
was examined against how sessions actually work; both carry the wrap's single-writer machinery forward as settled
design. The placement was challenged (2026-09-21, after a rate-limit storm traced to the hub worker) and found
unjustified on its own terms.

Three findings motivated the move:

1. **The 429 storm (2026-09-20, five hours, 1,326 responses)** was amplified by the hub worker's shape: fixed-cadence
   polling, release-then-retry on any LLM failure with no backoff, and the upstream error swallowed rather than logged.
   An upstream throttle on the consolidation route therefore produced an escalating retry storm that no local limit
   existed to attribute. One retry loop at one deployment point amplified a transient upstream condition into hours of
   noise for every client of the shared route.
2. **Sessions are host-local.** Opencode session ids are minted by one host and never span hosts. The hub's
   single-writer claim silently assumed multi-host conversations could contend for the same group; they cannot. The
   claim/release contention machinery — the reason consolidation sat at a central point — serializes races that
   per-session ownership makes structurally impossible. One writer per conversation requires no central point.
3. **The boundary triggers are client-native events the hub topology drops.** The plugin already emits compaction
   markers (the trigger the work deployment's hooks use); the daemon discards them. The mnemosyne worker's idle trigger
   — consolidate when the queue has been quiet, back off naturally on failure ("avoid hammering") — died at the first
   hop, because the hub cannot observe client traffic patterns except as mirrored rows.

The hub's own docstring states it "never interprets record semantics beyond validation"; the capture mirror exists
solely to feed consolidation, quietly contradicting that. Removing consolidation from the hub makes the hub what the
relay was always specified to be.

## Decision

Each host's memory daemon consolidates its own sessions. The hub host becomes relay-only: record log, validation,
distribution. The AAAK contract is unchanged — claim/release, no summary on LLM exhaustion, never fabricate.

- **Ownership**: one writer per conversation — the session's origin host — with no central coordination. Ownership
  derives from the session id itself, not from machinery that infers or negotiates it. Summaries fan out fleet-global
  via the existing record log exactly as before: memory is fleet-global, consolidation is conversation-scoped.
- **Version stamp as the ownership predicate**: every consolidation claim carries the consolidator's build identity —
  the git revision for clean trees, a dirty-tree marker otherwise. Both are pure functions of the flake source (commit
  metadata, not wall clock; build-time timestamps in derivation outputs would be impure). The rev needs no bump
  discipline, is monotonic in the sense that matters, is host-independent for the same commit, and resolves to exact
  source.
- **Legacy adoption, not a hub backstop**: the rollout decision recorded in this revision is that the hub does NOT keep
  a transitional backstop. Rows that predate per-host ownership (`captured_by` empty — four days of pre-PR captures) are
  adopted by the designated adopting host's daemon (`adopt_unowned`), which consolidates them exactly like its own. Two
  findings from the first day of live running killed the backstop design: its bounded-batch throughput could not keep
  pace with capture production (the original 429-storm shape was a throughput ceiling, not an incident), and the
  backstop's summaries made sessions permanently invisible to the client's duplicate guard — the transition converged
  toward hub-does-everything, the topology being retired. One adopter per unowned pool, deterministic; every session
  with a capture-producing daemon has exactly one writer from the day its daemon deploys.
- **Scheduling is per-session idle, not machine-quiet**: a session is eligible for consolidation when its own newest
  capture is at least the idle window old. A machine-global idle clock would let interleaved sessions starve each
  other's summaries indefinitely (verified live: seven concurrent sessions kept a global trigger silent all day).
  Consolidation remains a session-end proxy: quiet means the conversation ended, not that the machine is idle.
- **Triggers replace the fixed poll**: per-session quiet (above), force on compaction boundaries (the plugin's existing
  markers, which set priority — never bypass the no-fabrication contract), and back off exponentially on upstream
  failure with the error body logged. No fixed-cadence infinite retry is possible in the new loop.
- **Auth is a prerequisite**: remote clients consolidate through the LLM gateway's public surface with the existing
  opencode bearer key (today the hub trusts loopback and sends nothing). Consolidation remains attributable through its
  client address and Python HTTP user agent; a dedicated key remains available only if independent proxy-side budgets or
  rate limits become necessary.
- **Per-host identity is a prerequisite**: the client fleet currently shares one machine id for all Linux hosts, which
  would make ownership meaningless. True hostname identity (the daemon's existing default) becomes the single source.
- **Revision note (2026-09-21, later the same day)**: the first revision of this ADR planned a hub backstop with
  transition guards during rollout. One day of live running falsified that plan — the backstop's throughput ceiling and
  its interaction with the duplicate guard (above) — and the decision moved to immediate client ownership with legacy
  adoption. The backstop language elsewhere in this record describes a mechanism that never fully shipped and was
  removed same-day.

## Alternatives considered

1. **Keep hub-only consolidation, fix its backoff.** Rejected: the backoff fix treats the symptom. The boundary triggers
   remain unreachable — the hub cannot see client events except through the wire, which would mean new record kinds and
   per-host scheduling state at the hub: central machinery approximating what the client knows natively.
2. **Hybrid permanent backstop** (hub keeps consolidating forever alongside clients). Rejected: preserves the two-store
   duplicate race forever, keeps two consolidation code paths, and the hub's relay contract stays violated. The backstop
   is a transition tool, not a destination.
3. **Delegation semantics at the hub** (hub stays the consolidator but only for sessions whose origin host has
   delegated). Rejected: it re-derives, from the record log, ownership information the client holds trivially —
   inference where a stamp answers directly, plus a predicate that must distinguish "host will consolidate" from "host
   is stale," which is the version problem in disguise.
4. **Semantic version stamps with bump discipline.** Rejected: bump discipline is the kind of process that stops being
   maintained; the git rev needs none and is monotonic. (The raw nix store path was rejected as a stamp — its hash
   shifts with derivation inputs, not just code, so it identifies a build, not a version, and is not comparable across
   hosts.)

## Consequences

- The record-log PRD/ADR's "episodic: single writer (the hub); down only" is superseded by "one writer per conversation,
  origin host." Their remaining content (record kinds, apply semantics, weighting) is unaffected. The AAAK ADR is
  unaffected: claim/release and the no-fabrication rule are preserved; what changes is who runs the loop and when.
- Version skew becomes a bounded, visible, per-host condition instead of a uniformity guarantee: a stale daemon
  consolidates its own sessions with old code — no cross-host interference is possible (different sessions, different
  rows) — and the stamp on episodic rows makes the lag observable fleet-wide. Deploy cadence already diverges per host,
  so this changes the blast radius of skew, not the skew itself.
- Every host gains an LLM dependency for consolidation (today only the hub host calls it), authenticated with the
  existing opencode bearer key. Its traffic shares that key's proxy-side budget and rate limits; daemon-side backoff
  bounds the resulting coupling.
- The hub shrinks to relay in the same change that turns clients on: the capture mirror, the hub worker, and its backlog
  alarm are deleted, and the hub holds only the record log. Unowned territory is adopted by the designated host's daemon
  (above). With a single writer per session in a single store, the duplicate-race class is structurally impossible and
  no transition guards exist to remove later.
- The work deployment is unaffected: it runs its own stack; cross-fertilization stays at the reference level. The quiet
  trigger, compaction force, and natural backoff are that lineage's ideas, finally applied where they always belonged.
