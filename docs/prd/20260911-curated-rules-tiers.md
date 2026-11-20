# PRD 20260911: Curated rules — persona, behavior, prediction

- **Status**: Draft
- **Companion ADR**: `docs/adr/20260911-curated-rules-system.md`
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

Both current persona deployments (the example deployment hub-rendered, the work deployment local-rendered) grow
unbounded narratives into an always-on payload, keep lifecycle metadata nobody reads, and share a borrowed table schema
they must pin or patch. Neither can express situational rules without paying for them on every request, and neither has
a retirement mechanism other than manual demotion. The curated tier needs its own shape: three kinds of signal, three
delivery regimes, one tool contract.

## The three tiers

### Persona — always-on floor

What a future session must know before it does anything, regardless of project or turn content: standing prohibitions,
communication style, identity. Distilled statements, not narratives.

- **Delivery**: rendered into the system prompt at session start (instructions file / User Rule). Every session pays the
  full floor; no matcher, no per-turn injection.
- **Shape**: short statement per rule. Hard per-statement length cap, enforced by the write path — a promote that
  exceeds the cap is refused, not truncated silently. Origin stories, incident narratives, and elaboration live in
  provenance metadata or in a matching behavior, never in the rendered floor.
- **Write path**: agent proposes; the proposal enters `proposed` state and requires the operator's confirmation to
  become `active`. Floor changes are the one place a human gate is mechanical, not conventional.
- **Aging**: none automatic. Fullness triggers curation — the agent must be aware of the budget and propose what to
  remove or reword to admit something new, trading within the roster rather than overflowing it. Staleness is handled
  the same way: propose the removal, the operator confirms.
- **Metadata**: provenance (origin, author, date, reason), apply-count and last-applied timestamps (agent self-reports
  application, the work deployment's reinforce habit shows this works), scope. None of it renders.

### Behavior — agent discipline, fired on situation

The agent's own operational rules: "when situation X, I do Y." The hub host's incident rules — identifiers derived from
live output, plan mode read-only for remote systems, investigations stay open while threads remain — are the canonical
corpus.

- **Delivery**: host-side. Each prompt is embedded and matched against situation descriptions above a cosine threshold;
  hits are injected as a labeled nudge block (the reminder channel the recall nudge already uses). Not agent-pulled:
  delivery must not depend on the agent remembering to query.
- **Shape**: situation (the matcher text), rule statement, rationale (the narrative — zero prompt cost until it fires).
- **Write path**: agent codifies directly, no confirmation gate. A bad rule fires when matched and gets spam-trained
  out; the cost of a wrong rule is one turn, not every turn, which is why the gate is loose here and strict on persona.
- **Grading**: on every surfacing the agent evaluates relevance and records ham/spam. Confidence is Bayesian (K=5 prior,
  soft signals = 0.25); low confidence drops a rule below firing threshold. No wall-clock decay.
- **Anti-laziness guard** (from thatch): rules encode discipline, not shortcuts — worth carrying into the codify tool's
  description.

### Prediction — user tendencies, fired on situation

The operator's decision preferences: "when reviewing with tech debt, they tend to flag it first." Agent-scribed from
their signals; their responses are ground truth.

- **Delivery**: same host-side matcher fire as behaviors.
- **Write path**: query-before-create (check existing matchers first), then create, reinforce, or weaken from his
  signals. Review-style discussions are flagged as high-signal material.
- **Use**: follow strong predictions silently; surface ambiguous or conflicting ones ("you usually prefer X here — not
  sure; what do you want?").
- **Grading**: confirms and disconfirms from user responses adjust the same confidence math. No rows exist in either
  corpus today; schema ships, adoption is open.

## Shared machinery

- **Scope axis**: every row — all three tiers — carries repo/branch/global scope, resolved mechanically at tool-binding
  time (thatch's `detectRepo` chain: git remote → git-common-dir → directory basename; worktree-safe). Scope ranks
  retrieval (current repo + global first); it never deletes. Environmental metadata must never depend on the agent
  remembering to supply it.
- **Telemetry**: fire-count / last-fired (matcher tiers, host-stamped on injection), apply-count / last-applied (agent
  self-report), confirm/disconfirm counts, on every row in every tier. Fire-vs-read split: prompt-matching that surfaces
  a rule does not count as use until the agent acts on it. This is the data that makes any future aging regime a policy
  decision instead of a migration.
- **Confidence**: one implementation, shared by behavior and prediction; persona does not participate (floor rules don't
  compete for slots).
- **Provenance**: every write, edit, confirmation, and grade is a provenance row. Seeding is normal, not exceptional —
  both existing corpora descend from a hand-written document, and provenance is where that lineage lives.
- **Git as review surface**: every render refreshes rendered output plus full-row backups (JSON with all columns) into a
  git-tracked directory. The store is operational; git is history, diff, and restore. Telemetry does not go to git.
- **Regime enforcement**: what requires confirmation is a function of tier + state, expressed in the tool layer. Memory
  writes (ambient system) are agent-owned and can never require approval; persona floor changes always require approval;
  behaviors and predictions never do. The 30–50% leak rate of agents asking to confirm memory writes is the failure this
  mechanically eliminates.

## Non-goals

- No cross-tier promotion paths; no auto-extraction of rules from memory; the agent is the only thing that moves
  information between tiers.
- No sync between the work and example deployments. Shared lineage, shared machinery, separate stores. Cross-environment
  propagation is a deliberate agent-mediated proposal judged against the seed-time filter precedent: only what is
  universal survives the crossing.
- No aging, sleep, or consolidation for any tier. Recorded telemetry keeps the switch cost low if forced.
- No new background writers. The host's matcher fire is the only machine-driven touch, and it writes telemetry, not
  rules.

## Success signals

- The rendered floor stays under its byte budget with headroom, because over-cap promotes are refused and force explicit
  trade proposals.
- Behaviors fire on the incident-class situations they were codified from (the identifier-typing rule fires during
  debugging sessions, not during docs work).
- Reinforcement/grading telemetry accumulates — the metric that is 6/12 on the work deployment and 0/23 on the example
  deployment becomes nonzero everywhere the loop is taught.
- The confirm-leak rate on memory writes drops to zero (the tool cannot express the question).

## Open items

- Per-statement cap value (data points at 200–300 chars: every promoted maxim in both corpora fits under 200; every
  narrative exceeds it).
- Floor roster today: which of the existing 23 rules stay standing, which convert to behaviors. Working cut:
  collaboration + communication core stays; incident narratives convert with statements distilled and narratives moved
  to rationale.
- Whether behaviors and predictions share one table with authority/stance columns or two tables over one library —
  implementation detail, decided by cost of the cross-engine query that surfaces both together.
- Deployment shape on the example deployment: own table in the existing hub vs. own service. The ADR fixes the boundary
  and the tiers; the process boundary remains open until the matcher/telemetry requirements are weighed against a new
  deployment unit.
