# PRD 20260911: Curated rules — the floor and situational rules

- **Status**: Draft
- **Audience**: the agents that implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

The curated tier needs two shapes of signal and one confidence contract: a floor every session pays for before it does
anything, and rules that matter only when their situation arrives. One table each (`persona_rules`,
`situational_rules`), two delivery regimes, and a confidence number derived from grading alone.

## The two tiers

### Persona — the always-on floor

What a session must know before it does anything, regardless of project or turn content: standing prohibitions,
communication style, identity. Distilled statements, not narratives.

- **Table**: `persona_rules` — statement, status, topic, provenance, apply-count telemetry.
- **Delivery**: the daemon renders the floor deterministically — rules grouped under their topic, topics alphabetical,
  no timestamps — into a rule file the client applies to every request. Every session pays the full floor; no matcher,
  no per-turn injection. An empty corpus takes the file away instead of leaving frontmatter no request learns from.
- **Shape**: one short statement per rule, under a topic. A hard global character budget is enforced by the write path —
  a promote that exceeds it is refused with the full roster, never truncated silently; the agent rewords or retires to
  make room.
- **Write path**: `persona_codify` / `persona_update`, and both require that the rule was first put to the user in chat,
  in full, with their word back before the write. Floor changes are the one place a human gate is mechanical, not
  conventional.
- **Aging**: none. Fullness triggers curation — trading within the roster, never overflowing it. Staleness is the same
  trade: propose the removal, the user confirms.
- **Metadata**: provenance (origin, author, reason), apply-count and last-applied (agent self-report), status, topic.
  None of it renders.

### Situational rules — fired by situation, pulled on demand

Rules with a trigger: the agent's own operational discipline ("when situation X, I do Y") and the operator's decision
tendencies ("when reviewing X, they flag Y"). Two `grader` values separate them — `agent` for discipline the agent
codifies about its own conduct, `user` for tendencies scribed from the operator's signals, where their responses are
ground truth. Every rule also carries a required `stance`: `prescriptive` (a rule to follow) or `descriptive` (a
prediction of what the user tends to do).

- **Table**: `situational_rules` — situation (the trigger text), statement, rationale, grader, stance, scope, status,
  provenance, confirm/disconfirm counts, fire telemetry.
- **Delivery**, three channels; content never rides message arrival:
  1. **Session open** — the floor and the knowledge block arrive with the session's opening context.
  2. **Tool moments** — a binding in `tool_rules` fires when a bound tool executes, delivered deterministically, no
     similarity roll.
  3. **Pull** — `rule_recall`: the agent formulates the moment it is in and the store answers. Same matching as the
     tool-moment path with pull-shaped gates: a lower similarity threshold, low-confidence rules returned and marked
     quiet, relevance left to the caller's judgment. There is no auto-fire channel: no component matches every prompt
     against rules and injects hits on its own.
- **Write path**: `rule_codify`, no confirmation gate. The agent asks the store first (`rule_recall`); the store refuses
  a near-clone and names the row to grade or amend. A bad rule costs one grading turn, not every turn — the gate is
  loose here and strict on persona. Rules encode discipline, not shortcuts.
- **Grading**: on every surfacing the agent evaluates relevance and records it with `rule_feedback` — confirm or
  disconfirm with grounds, or a soft signal with an explicit polarity. Grounds are audit data; feedback without them is
  a classifier with no evidence trail.
- **Metadata**: fire-count/last-fired (tool-moment deliveries count as fires), apply-count/last-applied (agent
  self-report — a surfaced rule is not use until the agent acts on it), confirm/disconfirm counts. None of it renders.

## Confidence

One implementation, shared by every read that gates or ranks on it. Confidence derives from feedback counts only —
Laplace-smoothed over confirm and disconfirm with a K=5 prior; soft signals weigh 0.25. There is no wall-clock decay and
no aging: a rule's standing is exactly its grading record. Low-confidence rules rank below confirmed ones; the counts,
never the clock, move a rule.

## Shared machinery

- **Scope**: situational rows carry scope; scope ranks retrieval (current project and global first) and never deletes.
  Environmental metadata must never depend on the agent remembering to supply it.
- **Provenance**: every write, edit, confirmation, and grade is a provenance row. Seeding is normal, not exceptional —
  corpora descend from hand-written documents, and provenance is where that lineage lives.
- **Regime enforcement**: what requires confirmation is a function of tier, expressed in the tool layer. Memory writes
  (ambient system) are agent-owned and can never require approval; persona floor changes always require the user's word;
  situational rules never do. Agents asking permission to write memories is the failure this mechanically eliminates.

## Non-goals

- No cross-tier promotion paths; no auto-extraction of rules from memory; the agent is the only thing that moves
  information between tiers.
- No auto-fire matcher, and no resurrection of one: delivery is the three channels above, or nothing.
- No aging, sleep, or consolidation for either tier. The grading counts keep any future policy a decision instead of a
  migration.
- No new background writers for the curated tier.

## Success signals

- The rendered floor stays under its budget, because over-budget promotes are refused and force explicit trades.
- Situational rules surface through the tool moments and pulls where their situations occur — not on every prompt.
- Grading telemetry accumulates: confirm/disconfirm counts and grounds trail every rule that stands.
- The confirm-leak rate on memory writes is zero (the tool cannot express the question).
- No rule's standing depends on when it was written.
