# ADR 20261105: The project key is named "project"; "repo" is deferred legacy

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator, 2026-11-05, PRJ-176 planning)
  - Edited: none
  - Approved: none
- **Companion**: PRD 20261104-memory-redesign; ADR 20261104-sleep-scope

## Decision

The per-project key that scopes memories and knowledge bases is named **project**, everywhere the concept appears:
schema columns, function names, wire payload fields, and parameter names. `repo` is a legacy name, not a rival
convention.

Two rules govern adoption:

1. **Surfaces not yet deployed take the name immediately.** A new table, route, or payload born after this decision uses
   `project` from its first commit — the `knowledge_base` table already does.
2. **Deployed surfaces defer.** The `repo` columns on `working_memory`, `agent_memory`, and `episodic_memory`, the
   `detect_repo` function, the `repo` field in wire record payloads, and recall's `workspace` parameter keep their names
   until a dedicated swap ticket renames them in one pass. New code consumes these internals as they are rather than
   renaming opportunistically — a mixed-vocabulary codebase mid-flight is cheaper than a wire-format rename done
   carelessly.

## Why

`repo` names how the value is sometimes _resolved_, not what it _is_. The value is a project key: a stable handle a
knowledge base and a memory row can share. "Repo" implies a git URI or a file path, and the resolver's own fallbacks
prove the implication false — its last resort is a directory basename, so a project need not be a repository at all.

The live store already carries the evidence both ways: `session.project` exists and is populated, while
`agent_memory.repo` holds at least one value that is a raw worktree path — the fallback returning a path because no git
identity existed. Same concept, two names, one of them demonstrably wrong for its data.

The wire-payload rename is the one breaking part: a new client's records must not land on an old daemon's apply path
mid-rollout. This is accepted without a compatibility shim — the fleet is one operator's, updated together, and the swap
ticket sequences the cutover as a single fleet-wide pass.

## Alternatives considered

- **Keep `repo`** — cheapest today, but every new surface inherits the wrong name and the fallback-path artifact keeps
  recurring; the name would need a docstring apology forever.
- **A compatibility shim for the wire rename** — dual-field reading during rollout. Rejected: real code and test surface
  to protect a one-operator, one-pass cutover.
