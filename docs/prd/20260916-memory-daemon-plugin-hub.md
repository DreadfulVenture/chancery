# PRD 20260916: Memory daemon, plugin, and side-by-side hub

- **Status**: Draft
- **Companion ADRs**: `docs/adr/20260911-replace-mnemosyne-library.md` (the store),
  `docs/adr/20260911-record-log-sync-weighting.md` (distribution)
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

The store rewrite shipped the data layer (schema, scorers, curation, sync client) but the client stack still runs the
old package's process shape: a warm MCP daemon that wraps package dispatch, a separate capture worker, a separate sync
client — four processes per machine, glued by the package we removed. This PRD specifies the owned replacement: one
daemon per machine, one dumb plugin, and a new hub running side-by-side with the old one.

## Topology

```
opencode process                    memory daemon (one per machine)
  plugin/memory.ts                    MCP server (memory_* tools, SSE, loopback)
    ├─ turns → JSONL queue ──────▶    POST /nudge (both channels in one response)
    └─ POST /nudge per prompt ◀─────  capture drain timer (classify → upsert → enqueue)
                                      sync cycle timer (push queue, pull cursor, apply)
                                      floor render on floor-changing writes
hub (the hub host, side-by-side with the old mnemosyne hub)
  hub_server.py: record log (six kinds) + capture mirror
  hub_worker.py: consolidation groups, episodic fan-out, backlog alarm
```

All product code — store, scorers, daemon, hub server, hub worker — lives in `nix/packages/memory-store/` as one
self-contained directory (the unit that would move if this ever splits into its own repo). The package builds two
derivations from it: `default.nix` ships the client set (the daemon and its imports), `hub.nix` ships the hub set
(hub_server, hub_worker, backlog_check, store, consolidation). Clients carry zero hub bytes; the hub host carries zero
daemon bytes. Host directories contain only wiring: units, Traefik routes, DNS, and secrets.

## Daemon

One process owns the machine's store (single-writer). It serves:

- **MCP over SSE** on loopback port **17173** (the old stack keeps 17172 — both daemons run side-by-side per machine
  until the switch, so the endpoints must not collide). Tools are the owned `memory_*` surface — no package dispatch, no
  schema patching.
- **POST /nudge**: `{prompt, workspace, injected_contents, session_texts}` → `{memories, rules}` — the nudge scorer's
  framed results AND the matcher engine's fired situational rules in one response. The plugin renders one reminder block
  from one call; there is no second injection path.
- **Timers**: capture drain (classify at ingest, upsert, enqueue records), sync cycle (one push+pull per interval),
  floor render on floor-changing writes.

Every mutation flows through a Tools wrapper that both writes the row and enqueues the matching record — the record path
has no second writer.

## Plugin

The plugin is a dumb client: it writes turns (user on message, assistant at idle) to the queue JSONL, POSTs /nudge once
per prompt, renders the returned channels with honest framing, and resets injection tracking at compaction boundaries.
All intelligence — pool restriction, score thresholds, semantic debounce, containment, self-echo suppression — lives
server-side in the scorer and matcher. Child-session and compaction guards stay client-side (they are session lifecycle
facts only the plugin can see).

## Hub (side-by-side)

The new hub runs next to the old mnemosyne hub on the hub host: separate state dir (`/var/lib/memory`), separate port
(8767), separate Traefik route (`memory-store.example.com`), separate API key. The old stack stays untouched and keeps
serving the fleet until the switch.

- **hub_server**: validates the six record kinds, appends to the record log, mirrors capture/memory payloads into the
  hub store's working memory (consolidation input). Pull is cursor-paged over everything appended. Two writers (server +
  worker) share WAL databases with busy timeouts; writes are tiny single-row transactions.
- **hub_worker**: `next_consolidation_group` → claim → LLM summarize via the LLM gateway → episodic row → outbound
  record; release on failure (no-fabrication rule). Publishes new episodic rows into the record log each pass. Logs the
  pending backlog.
- **Backlog alarm**: hourly timer; non-zero exit when unconsolidated speech backlog exceeds the threshold.

## Machine identity

`MEMORY_MACHINE_ID` defaults to hostname on Linux and is pinned per host config. Records carry it; it is the origin key
for feedback accumulation and conflict accounting.

## Validation

- `make test-memory`: 100 tests including the daemon round-trip (both channels, record emission from tool calls, capture
  classification), the hub integration (POST → consolidate → pull), the convergence drill, and the replay fixture.
- Plugin tests in the `node --test` suite: reminder framing, both-channel rendering.
- `nix flake check`: all hosts build with both stacks side-by-side.

## Out of scope

Client switchover order, historical data migration, old-service retirement. The old stack keeps running; the new hub
collecting fresh records side-by-side is the steady state.
