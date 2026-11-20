# ADR 20261110: Each domain owns its commands under its own prefix

- **Status**: Draft
- **Provenance**:
  - Authored: agent (decision dictated by the operator, 2026-11-10)
  - Edited: none
  - Approved: none
- **Companion**: PRD 20261104-memory-redesign

## Decision

The store's agent-facing tools are grouped by domain. Each domain has one command prefix, and every operation on that
domain's data — write, read, change, remove — is a tool under that prefix. No tool reaches into another domain's tables.

| Domain                                 | Prefix        |
| -------------------------------------- | ------------- |
| Memory rows (working, agent, episodic) | `memory_`     |
| Knowledge base                         | `knowledge_`  |
| Floor (persona) rules                  | `persona_`    |
| Situational rules                      | `rule_`       |
| Tool rules                             | `tool_rule_`  |
| Compliance review                      | `compliance_` |

A new domain gets a new prefix; a new operation on an existing domain joins that domain's family. Removal follows the
same rule: `tool_rule_remove` mirrors `tool_rule_add`, `rule_forget` retires a situational rule, a floor rule is retired
with `persona_update`, and `memory_forget` forgets memory rows and nothing else.

## Why

The generic delete drifted, and nothing caught it. `memory_forget` took a table argument and reached memory rows, floor
rules, and situational rules. When cross-project tool-rule curation (PRJ-168) needed promote to tombstone the rule it
replaces, `tool_rules` joined the store's list of forgettable tables, but the tool's schema never gained it. The only
way to remove a tool rule was then an undocumented argument to a memory tool, and the text delivered with every tool
rule told the agent to "forget the row" without saying which table or which id.

An agent looks for a domain's operations among that domain's tools. When the knowledge base is `memory_kb` and tool
rules are `memory_tool_rule_*`, the prefix says "memory" for data that is not memory, and the reader cannot tell from
the names where one domain ends.

This extends an earlier naming ruling, the rename of `memory_bind` to `memory_tool_rule_add`: the agent-facing name
carries the domain word, not module-internal vocabulary. That ruling put the domain word in the name; this one makes it
the prefix.

## Alternatives considered

- **One generic forget across every table.** One verb for agents to learn. Rejected: its table list is a second copy of
  the store's, and it drifted the first time a domain was added. A domain whose removal lives in another family is not
  discoverable from its own tools.
- **Keep `memory_` as an umbrella prefix with the domain inside it** (`memory_tool_rule_*`, `memory_kb`). No renames.
  Rejected: the umbrella prefix is the ambiguity this decision removes.
- **Compatibility aliases for the old names.** Rejected: the fleet is one operator's and deploys together. Cursor's
  cached tool list needs a restart after the deploy either way.
