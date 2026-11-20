# ADR 20260911: Replace the mnemosyne library with an owned data store

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: the operator (schema lift disapproved; record amended at their direction)
  - Approved: none

## Context

The memory system runs on the pinned `mnemosyne-memory==3.15.1` package (user-agent memory product, MIT) with our code
wrapped around it: a client daemon/worker/sync client, a hub (server + worker), and an opencode plugin. Two sessions of
auditing what we actually use — against the live hub DB, the pinned package source, and upstream's commit history —
produced a precise dependency inventory.

**What we use today, file by file:** the hub server uses nothing from the package (pure stdlib HTTP + raw SQL). The
worker uses the MCP dispatch for exactly one operation (`remember`). The daemon wraps the tool surface but overrides its
descriptions and schemas and re-sorts recall results with our own boost logic. The sync client uses the package's
SyncEngine in relay mode over record kinds that are ours (episodic, persona_snapshot, op queue) — payloads the engine
never interprets — alongside our own cursor-pull/push/apply code, which already carries the actual distribution. The hub
worker uses the package for `sleep()` (consolidation) and `summarize_memories` (LLM call), plus raw SQL for claims,
queue, and snapshots.

**What the session's decisions already removed or scheduled for removal:** persona (leaves for the curated-rules store
per its PRD), consolidation/sleep (becomes our own loop per the AAAK ADR — claim/release, no fallback), the
automatic-recall path (becomes our own brute-force scorer over a restricted pool per the memory PRD; explicit recall
keeps a hybrid scorer for now), capture format and provenance (our classification and repo resolution replace the
package's user-agent assumptions).

**Upstream churn:** ~6–13 commits/day on main; 388 commits since our 46-day-old pin, 82 of them on `beam.py` alone
(~4,100 lines changed), much of it on CJK/Hangul/FTS paths we never exercise. The package is a user-agent memory product
(personal-assistant assumptions: user-preference veracity boosts, transcript-shaped consolidation, no repo/worktree
concept) and its trajectory — multimodal, tenant banks, Hermes integration — diverges from our use.

**What remains genuinely valuable in the package:** the hybrid scorer (explicit recall quality), the storage schema
(FTS5/vec0 table shapes — copyable verbatim for migration-free cutover), and sync machinery solving problems our star
topology with one hub does not have (P2P mesh, conflict vectors, payload encryption over TLS).

The nudge pool is small and stays small: ~133 deliberate rows plus ~404 episodic today, projected
hundreds-to-low-thousands even with label discipline fixed — brute-force scoring is a few dozen lines, not a fork of the
scorer.

## Decision

Replace the package with an owned data store. One service, one store, our schema, our scoring, our sync. The package
becomes a reference implementation we copied the good parts from, then deleted.

- **Copy, don't re-derive:** the storage schema and the explicit-recall scorer's pure functions lift directly (MIT). The
  scorer keeps the dict-out contract our consumers already use. _(Amended below: the storage-schema half of this clause
  is disapproved; the scorer half stands.)_
- **Own the sync:** the record protocol is already ours; the replacement is a generalization of the existing
  cursor-pull/push/apply code (~200–300 lines). The package's conflict/encryption/mesh machinery is out of scope — our
  topology is a hub star.
- **No compatibility layer:** the used surface is four handlers (`remember`, explicit `recall`, and the two curation
  ops). The sole consumer is our own daemon in this repo — there is no consumer coordination for a shim to absorb. The
  cutover is a port plus a cutover day, not a long overlap.
- **The planned phases remain the on-ramp:** each phase either deletes a package dependency (consolidation, nudge
  scoring) or builds its replacement in our code. The rewrite decision changes the end state those phases reach, not the
  phases themselves.
- **Sequencing:** hold the pin through Phases 1–2 (they create no new upstream coupling); the store swap lands as its
  own track once the hub consolidation loop is ours.

## Amendment: the schema lift was disapproved; the migration-free rationale was void

The operator's review, given after deployment: mnemosyne's storage schema was one of the things they did **not** want
lifted. The schema clause of "copy, don't re-derive" and the "copyable verbatim for migration-free cutover" rationale
were agent choices recorded as settled design in this Draft — authored by the agent, never approved.

The rationale is also void in fact: no migration ever used the copied schema.

- The old store (5,504 legacy memory rows, 5,680 beam working rows) was abandoned un-imported and deleted as residue;
  the new store started empty and refilled from live sessions.
- The one corpus that crossed — the 23 persona rules — was re-emitted through the propose/confirm tool path into the
  curated tables designed fresh per the curated-rules PRD, with no mnemosyne schema lineage. The only real migration was
  schema-independent.

The copy's realized benefit was speed-to-working-store, not what this record claimed. Its cost: behaviors attached to
the copied shape inherited without re-justification — the per-write embed of every captured turn is mnemosyne writer
behavior whose readers (semantic recall over all working rows, the facts table, the embeddings fallback) were never
lifted, so the new store paid the embed cost for vectors nothing read, and the fixed dimension made the embedding model
look unswitchable.

Standing consequence for future replacements: **a copied shape is an unapproved migration convenience, never an
endorsement of behavior.** Every behavior the shape implies must be re-justified against the new design's actual readers
within the change that lifts it; "that's the lift" is never a defense. The 2026-09-19 performance work removes the
vestigial capture embed and makes the vector store self-describing (model and dimension recorded in the store, migrated
at open).

## Alternatives considered

1. **Keep pinning, wrap with an adapter** (the transitional plan this ADR supersedes). Viable, and remains the fallback
   if the rewrite stalls — but it costs an adapter file with fail-closed guards, version-bump re-validation forever, and
   leaves the user-agent scoring biases in the recall channel. The inventory showed the adapter's "north side" was
   already ours; the south side was mostly dead weight.
2. **Nix-patch the package.** Rejected: ~10 commits/day on the exact files we'd patch is a permanent rebase
   subscription.
3. **Fork and maintain.** Rejected: we would inherit maintaining CJK tokenization, FTS edge cases, and a user-agent
   feature surface we do not use, while upstream fixes them weekly for a product that is not ours.
4. **Ride upstream releases (v4 betas).** Rejected as a primary path: closer coupling to a diverging product. Their
   features remain reference material — upstream shipping self-echo suppression and dense-pool dialog exclusion
   mid-session is evidence the problems are real and their solutions are worth reading, not adopting.

## Consequences

- Version pins, schema pins (the fail-closed PRAGMA check), adapter guards, and version-bump ceremony all go away; the
  store's schema is ours and changes by migration, not by upstream negotiation.
- We own the nudge and explicit-recall scorers' failure modes outright — no more attributing ranking surprises to
  upstream score-distribution shifts (the veracity multiplier alone moved every working-row score in a past bump).
- Explicit-recall quality risk is real until validated: the lifted scorer must pass a query-log replay against the old
  store's results for the same queries (measurable delta, bounded by migration being an implementation concern, not
  volumetric — ~4.4k working rows, ~400 episodic, embeddings recomputable).
- Sync's one open design question carries over: multi-writer semantics. Today's last-writer-wins is almost certainly
  fine (machines capture their own sessions; deliberate writes are rare), but the rewrite must state its answer.
- The work deployment is untouched: it pins its own copy and its own daemon; this decision covers the example deployment
  only. Cross-fertilization continues at the reference level (both sides read each other's solutions).
- Upstream remains a dependency for zero runtime code. Future upgrades become reading their changelog for ideas instead
  of adapting to their changes.
