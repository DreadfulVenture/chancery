---
name: adr-writing
description:
  Use when creating or editing an architecture decision record (ADR) under docs/adr/, or a PRD under docs/prd/. Covers
  the provenance block, status discipline, and the record's purpose as the durable why behind a decision.
license: MIT
metadata:
  audience: agents
  workflow: documentation
---

# Writing ADRs and PRDs

Use this skill only when the user explicitly asks to create or edit an ADR or PRD.

- Store ADRs in `docs/adr/` as `YYYYMMDD-$topic.md`, using the decision date.
- Use the same date-based identifier in the title: `# ADR YYYYMMDD: Decision title`.
- Do not use sequential ADR numbers. Date-based names avoid merge conflicts when independent ADRs are added
  concurrently.
- Record the architectural choice, alternatives considered, and why the choice won. Do not turn the record into an
  implementation checklist; deployment steps, verification, and accompanying documentation updates belong with the
  implementation unless they are material consequences of the decision.
- Keep the record factual and specific to the decision. Include only verified context; label uncertainty explicitly.
- The record's purpose is the durable why: future sessions should be able to tell an intentional convention from an
  unnoticed agent choice by reading it.

## Provenance

Every ADR and PRD carries a provenance block in its header, in every repo the agent sees:

```markdown
- **Status**: Draft
- **Provenance**:
  - Authored: <who>
  - Edited: <who> (running list)
  - Approved: <explicit approval or none>
```

- **Status starts Draft and stays Draft.** "Accepted" and "approved" mean the same thing to the operator: their explicit
  word, given only in rare circumstances where a record must hold very significant weight. An agent never upgrades a
  status on inference — not from presence in the repo, not from non-objection, not from partial reading. If drafts
  accumulate, that is fine; the operator asks for corrections or removes misleading ones.
- **Authored records who composed the text.** Dictation and voice input count as the operator's authorship; an agent
  writing up the operator's dictated points does not. The operator signs documents they author.
- **Edited records the operator's attention**, not agent effort. Direct edits, agent-assisted edits they direct, and
  review comments (on the document or on replies about it) all count. Never write "Edited: Agent" — agent work is
  already covered by Authored. Accepting agent-suggested wording is not an edit event; redirecting or correcting is.
- **Dates are not recorded in the block** — git history holds them.
- The full weight ladder and its rationale live in `docs/adr/20260911-adr-prd-provenance.md` (the example deployment's
  repo; the convention applies everywhere).
