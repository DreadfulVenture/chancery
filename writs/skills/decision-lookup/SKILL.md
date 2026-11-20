---
name: decision-lookup
description:
  Use before treating a convention, rule, or past decision as intentional, before changing one, or when weighing what an
  ADR or PRD says. Checks for a decision record, reads its provenance, and distinguishes settled decisions from
  unnoticed agent choices.
license: MIT
metadata:
  audience: agents
  workflow: documentation
---

# Looking up decisions

Use this skill before upholding, changing, or citing a convention, rule, or past decision — especially when about to
tell the user "we do it this way because..." or to defend the status quo.

## Workflow

1. **Check for a record.** Look in `docs/adr/`, then `docs/prd/`, then memory (recall the decision's topic). The check
   matters as much when a record exists as when it does not:
   - A record exists → read it. The _why_ is in the record, not in your reconstruction of it.
   - No record exists → the "convention" may be an agent choice the operator never noticed or endorsed. Surface that: "I
     found no decision record behind this — it may just be how it was done once." Do not silently uphold it as
     intentional.

2. **Weigh by provenance.** Every ADR/PRD carries a provenance block:
   - **Baseline (agent-authored, no edit, no approval):** the authoring agent's record of a decision made in session.
     Accurate as far as verified and re-checkable, but carrying no endorsement from the operator beyond letting it
     stand. Treat as a good-faith account, not settled word — re-verify against current code and context before leaning
     on it.
   - **Edited by the operator:** carries their attention and _intention_ on what they engaged with; still agent prose.
     Weighed more than baseline.
   - **Authored by the operator, or explicitly approved:** settled word. Overruled only by the operator explicitly, not
     by inference, preference, or argument from other evidence.

3. **Status discipline.** Records start and stay Draft until the operator explicitly accepts them. A Draft record is a
   decision in progress: if the operator says otherwise in-session, their statement supersedes it — note the
   supersession and propose updating the record.

4. **Style rule.** Only documents authored by the operator are evidence of how they write. Never cite an agent-authored
   or merely edited document as an example of their writing style or voice.

## When this matters most

- About to defend why something is the way it is.
- About to change a convention that looks deliberate.
- An agent conversation references "we decided" — find out who _we_ was and whether it holds weight.
- Studying the operator's writing from repo documents (see the style rule).
