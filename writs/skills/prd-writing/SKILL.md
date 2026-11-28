---
name: prd-writing
description: "Use when creating or editing a PRD under docs/prd/: problem framing, acceptance criteria, provenance."
license: MIT
metadata:
  audience: agents
  workflow: documentation
---

# Writing PRDs

Use this skill only when the user explicitly asks to create or edit a PRD.

A PRD is the durable statement of what a product requires and why. Its reader is a future session — an implementing
agent or the operator — with no context for this conversation. The record has to stand whole: what the product must do,
for whom, and how anyone will tell it is true.

## When to write one

The user's ask settles it: an explicit request for a PRD, or a requirement that needs the durable record the user names.
A PRD is not the home for a session plan, a run manifest, a review draft, or a decision that never leaves the
conversation. If the content is one decision's why rather than a product requirement, say so instead of stretching a PRD
over it.

## Location and header

- Store PRDs in `docs/prd/` as `YYYYMMDD-$topic.md`, using the decision date; the title uses the same identifier:
  `# PRD YYYYMMDD: Requirement title`.
- The header carries **Status** (Draft), an **Audience** line (who reads it — the agents that will implement and run it;
  add "the operator" when the operator reviews it too), and the **Provenance** block:

```markdown
- **Status**: Draft
- **Audience**: the agents that will implement it; the operator
- **Provenance**:
  - Authored: <who> (one clause of context when the decision's shape matters — e.g. "design decided with the operator
    across the 2026-11-14 session")
  - Edited: <who> (running list)
  - Approved: <explicit approval or none>
```

## Sections

Use the sections the content needs; the repo's PRDs draw from this set, in roughly this order:

1. **Problem** — what is wrong today, in the present tense, concrete: the failure, who it hits, the evidence.
2. **Requirements** — numbered, bold-lead statements of the behavior the product must deliver.
3. **Design** — the decided how, when it is decided: subsections per mechanism, tables where a matrix is the truth.
4. **Alternatives considered** — one entry per alternative, each ending in its verdict: "Rejected: <reason>."
5. **Non-goals** — what the record deliberately does not ask for.
6. **Success criteria** (or **Success signals**) — the observable checks that show the bar is met.
7. **Open items** — genuinely undecided points, not restated requirements.
8. **Out of scope** — adjacent work the record excludes.

Do not pad to a template. A PRD with four honest sections beats one with eight thin ones.

## Problem and outcome framing

A requirement earns its place by naming the outcome: what a session, a machine, or the operator can do afterward that
they cannot do now. "Add X" is not a requirement until it says what changes for whom. State the problem before the
solution, and keep every requirement behavioral — something a reader can observe happening or not happening.

## Testable acceptance

Every requirement states observable behavior: what happens on which input, and what refusal a wrong call earns. Include
numbers where they matter (caps, intervals, thresholds) and say why each number is what it is when the reasoning is not
obvious. Success criteria are independently checkable — a pass/fail read, not a sentiment. Where a requirement cannot
yet be tested, that is a finding about the requirement, not a section to soften.

## Current-only content

A PRD describes what IS. Present tense, stated as fact.

- No history narration: no "we used to", "now we", "switched to", "originally".
- No supersession chains: no "supersedes X", no "per the decision in Y" pointing at a record that may not exist where
  the PRD is read. The requirement is stated here, whole, or not recorded.
- No "we decided". The record carries the decision's content; who stands behind it carries the provenance block.
- A rejected alternative is one line, current form: "**Rejected:** reason" — the requirement section states what IS
  required, and the rejection lives beside it, not in a story about the discussion.
- A requirement nothing has built yet is still present tense, stated honestly as the requirement: "the tools are not
  built yet; this section is the requirement they have to meet."

## Provenance and Draft discipline

Every PRD carries the provenance block above, in every repo the agent sees. Its meaning is a weight ladder, in
increasing weight:

1. **Present without objection (baseline).** Agent-authored, in the repo, and the operator did not object to what they
   read. Non-objection, never approval: a good-faith record, re-checkable against the code, carrying no endorsement
   beyond being allowed to stand.
2. **Edited by the operator (weighed more).** Direct edits, agent-assisted edits the operator directs, and review
   comments all count. It carries the operator's _intention_ on the parts the operator engaged with, but remains agent
   prose — never evidence of how the operator writes.
3. **Authored by the operator, or explicitly approved (very heavy).** Dictation counts as authorship. "Approved" and
   "accepted" mean the same thing: settled word, rare, reserved for records that must carry very significant weight.

- **Status starts Draft and stays Draft.** An agent never upgrades a status on inference — not from presence in the
  repo, not from non-objection, not from partial reading. If drafts accumulate, that is fine; the operator asks for
  corrections or removes misleading ones.
- **Authored records who composed the text**; an agent writing up the operator's dictated points does not make the agent
  the author. Never write "Edited: Agent" — agent work is covered by Authored.
- **Dates are not recorded in the block** — git history holds them.
- When the record depends on facts about the operator's intentions, setups, or consumers that are not in evidence, ask
  the operator — one direct question beats a paragraph of assumption.
