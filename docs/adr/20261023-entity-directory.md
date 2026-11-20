# ADR 20261023: Entity directory — append-only people, agents, and bots, with their observations

- **Status**: Draft
- **Companion**: PRD 20261023-entity-directory (schema, tool surface, behavior); ADR 20261023-forward-compatible-sync
  (the rollout this kind depends on)
- **Provenance**:
  - Authored: agent
  - Edited: the operator (design directed through plan review; observations in their own store, sessions on directory
    rows)
  - Approved: none

## Context

Before writing a review comment, a reply, or a message to or about a specific person, an agent should recall what has
been learned about how that person, or an agent acting for them, communicates, and adjust its framing to fit. The
findings, evidence, and asks stay the same; only the framing moves. The pattern comes from the "Author sensitivity" step
of thatch's review synthesizer (github.com/sysread/thatch).

The store has no way to say who an observation is about. Observations about people exist as deliberate memories that
open with a convention such as `About <Name> (GitHub <login>):`, and recall can find them only when the query happens to
share words with that line. Because they are deliberate memories, they also fold into the knowledge base of whichever
project the session that wrote them belonged to.

The motivating case: a person runs a review agent that posts replies from the person's own GitHub account, each opening
with a fixed line naming the agent and the person it acts for. The account resolves to the person, but the agent wrote
the text. What the agent's replies teach about the agent should be filed under the agent; reviewing the person's PR
should recall both.

The operator settled these before the design work, and the records below take them as given:

- Many small observations per entry, not one growing note per person. A single row runs into recall's 1200-character
  elision as it grows.
- Learn from any source: PRs, reviews, replies, chat, tickets, and the conventions in someone's code and docs.
- Real structure, not a text convention.
- Agents must not invent structure. Kinds and alias types are fixed sets in code, and the server refuses anything else
  with the valid values listed.
- An agent acting for someone is its own entry, not that person. Who spoke is decided by the content, not by the account
  that posted it.
- A new schema, not tags stored in `metadata_json`.
- Observations record style and habits, never judgments of skill.

He settled two more after the first draft, once deliberate memories had moved to `agent_memory` and the knowledge base
build had landed:

- Observations about people never fold into a project's knowledge base.
- Every directory row records the session that wrote it, the way deliberate memories do.

## Decisions

1. **A directory of entries that holds its own observations.** An entry is a `human`, an `agent`, or a `bot`. Entries
   carry aliases (accounts on GitHub, Slack, Linear, Jira, email addresses, names, and agent signatures), relations to
   other entries, and observations. An observation is one row about one entry: the entry that wrote or did the thing
   observed. Observations are not memories, so the knowledge base build, which reads deliberate memories, never sees
   them.
2. **Append-only tables.** Nothing is edited in place. A change inserts a row, or sets a one-way `deleted_at` on an
   existing row: removing an alias, ending a relation, removing an observation, restoring a forgotten entry. A removal
   names the specific row it ends, so a stale edit from another machine can never bring a removed alias back. Applying a
   synced record is then either an insert-if-absent or a set-if-empty, and machines holding the same rows reach the same
   state whatever order they arrived in, which ADR 20261023-forward-compatible-sync requires of every new kind. When two
   machines set `deleted_at` on the same row, the earlier timestamp is kept. Every row records the session that wrote
   it; on the wire that is the session's machine, tool, and conversation, which each machine resolves to its own
   registry row.
3. **Materialized current state.** The daemon keeps the current entries, relations, and aliases in machine-local tables,
   recomputing them for the whole directory in the same transaction as each local write and each applied record. A merge
   chain makes the set an edit affects open-ended, and recomputing everything is order-independent by construction. The
   tables are derived and never synced, like the vector tables, and are rebuilt from the append-only tables when missing
   or when their schema version changes. Observations are read through the current entries rather than materialized, so
   writing one recomputes nothing.
4. **Relationships are subject-verb-object rows.** `acts_for` (an agent acts for a human) and `merged_into` (one entry
   is a duplicate of another) are rows in one relations table, with a fixed verb set and per-verb rules enforced at
   write time. A new verb is a code change, not a schema change.
5. **A merge is a relation.** Merging A into B adds `A merged_into B`. Nothing is copied: A's aliases and observations
   resolve to B through the current entries, and ending the relation undoes the merge with nothing to move back.
6. **Alias uniqueness is checked at write time and surfaced at lookup.** An alias is unique on type, instance, and
   normalized value. The tool refuses an alias another entry on this machine holds. Apply accepts everything, because
   uniqueness cannot be checked across machines before they sync. A lookup that finds two current entries holding one
   alias does not resolve; it returns both and names the fix, a merge or removing the wrong alias. This follows the
   warn-then-clean-up approach in ADR 20260926-write-dedup.
7. **Signatures are aliases on the agent.** An agent's identifying line is a `signature` alias on the agent's own entry.
   Resolution takes the posting account and the text: the account's owner, then any agent that acts for that owner whose
   signature appears in the opening lines of the text, after normalizing case, whitespace, and markdown and dropping
   quoted lines. A miss falls through to a hint that the text reads as agent-written. A near match never decides
   authorship.
8. **Forgetting is a row; restoring ends it.** Forgetting an entry adds a forget row. The entry drops out of lookups and
   search, and its observations drop out with it; the rows stay, so a restore brings everything back. Lookups never
   mention forgotten entries. Creating an entry or adding an alias checks forgotten holders too: the call is refused
   with the restore call offered, and `override_confirmation` creates a separate entry anyway. The override only passes
   a forgotten holder; an alias held by a current entry is refused regardless.

## Alternatives considered

- **Observations as deliberate memories linked to entries with an `about` parameter.** The first draft of this design.
  It reused recall, text search, and vectors, but every observation would fold into the knowledge base of the project
  its session belonged to, and each link depended on a table owned by the memory domain: when deliberate memories moved
  from `working_memory` to `agent_memory`, every link stopped resolving. Rejected by the operator in favor of a store
  inside the directory.
- **Tags in `metadata_json`.** No migration, but nothing could validate the keys, and agents would produce `person`,
  `people`, and `author` for the same thing. Rejected by the operator before design.
- **A text convention at the top of each memory.** Already in use and already failing: recall matches it only by
  accident. Rejected by the operator before design.
- **Upserts with last write wins.** Matches the `memory` and `rule` kinds. With full copies of an entry on the wire, a
  stale edit restores removed aliases; with per-field merging, the protocol gains merge logic it has avoided so far.
  Append-only rows avoid both.
- **Views instead of materialized tables.** Fewer moving parts, but every lookup would recompute merge chains and alias
  attribution. Writes to the directory are rare and reads happen before every drafted message.
- **`acts_for` and `merged_into` as columns on the entry.** A version row carrying every mutable field makes concurrent
  edits of different fields overwrite each other, and each new relationship would be a schema change.
- **A redirects table, or copying aliases on merge.** A redirects table is a second way to express a relationship the
  relations table already holds. Copying aliases makes an unmerge a cleanup job.
- **An automatic fold when two entries collide on an alias.** Deterministic, but the likelier cause of a collision is an
  agent attaching the wrong alias, and folding then merges two different people silently.
- **Signatures in their own table, scoped to the account they appear under.** Scoping is unnecessary: an agent posting
  from a person's account is found through `acts_for`, and an agent with its own account holds that account as its own
  alias.
- **Delete plus tombstone for forget.** Irreversible, and needs the tombstone table the append-only tables otherwise do
  without.
- **Restore on any later reference.** An agent that happens to look up an old alias would undo a deliberate forget
  without anyone deciding to.
- **A graph database.** The relations table already stores a graph. The queries are at most two steps over a few dozen
  entries, and a second database would need its own sync and forget semantics.

## Consequences

- **Observations are reached through their entry, not through text recall.** `memory_recall` does not search them; an
  agent looks the person up. A note about someone written as an ordinary memory is still an ordinary memory and still
  folds into the project knowledge base.
- **A forgotten entry's observations are hidden with it** and come back on restore.
- A new record kind, `entity`, rolled out with ADR 20261023-forward-compatible-sync in one ordered deploy.
- Six append-only tables and three materialized ones. Every append-only row records the session that wrote it, which is
  what tells a wrong alias from a right one after a collision.
- Six tools under the directory's own prefix, `entity_`: `entity_save`, `entity_get`, `entity_find`, `entity_merge`,
  `entity_observe`, and `entity_forget`, following ADR 20261110, "Each domain owns its commands under its own prefix".
  No `memory_*` tool touches the directory.
- A GitHub login freed by a rename and claimed by someone else resolves to the old owner until an alias is removed or
  entries are merged. Keying on GitHub's numeric user id would avoid it at the cost of a lookup agents would have to get
  right.
- Free-form tags on memories remain out of scope.
