# ADR 20260911: ADRs and PRDs carry document provenance — authored, edited, approved

- **Status**: Draft
- **Provenance**:
  - Authored: agent, 2026-09-11
  - Edited: the operator, 2026-09-11 (review comments)
  - Approved: none

## Context

ADRs and PRDs are almost exclusively agent-authored: five were produced in a single session. A future reader cannot tell
how much of a document's weight is the operator's and how much is the authoring agent's claim. The status line describes
the decision, not the record — conflating the two is the same failure class as recall content labeled "treat as
established": an agent's account surfaced with an authority it did not earn.

This fails hardest where it already fails today: agents studying the operator's writing style keep citing
agent-generated documents as evidence of how they write, and it gets stupid fast. Only documents authored by the
operator carry their voice. Edited documents carry their attention — more weight — but remain agent prose. Heavy editing
makes the result their _intention_, not their wording or tone.

## Decision

Every ADR and PRD carries a **Provenance** block in its header:

```markdown
- **Provenance**:
  - Authored: <who>
  - Edited: <who> (running list)
  - Approved: <explicit approval or none>
```

Dates are not recorded; git history holds them.

Semantics of each state, in increasing weight:

1. **Present without objection (baseline).** Agent-authored, in the repo, and the operator did not object to what they
   read. This is non-objection, never approval. A reader treats the document as the authoring agent's record of a
   decision — accurate as far as verified, re-checkable against evidence, but carrying no endorsement from the operator
   beyond the fact that they let it stand.
2. **Edited by the operator (weighed more).** The operator has paid attention to the document — through direct edits,
   agent-assisted edits, or review comments. It carries their _intention_ on the parts they engaged with, but remains
   agent prose: it is not evidence of their writing style.
3. **Authored by the operator, or explicitly approved by them (very heavy).** Authored means the operator composed the
   text; dictation and voice input count as authorship. The operator commits to writing their name on documents they
   author. Explicitly approved — "approved" and "accepted" mean the same thing — is settled word, held only in rare
   circumstances where something must carry very significant weight.

Enforcement rules:

- **An agent never marks a document Approved/Accepted** unless the operator explicitly asks for that exact document.
  Documents start as Draft and stay there otherwise. If drafts accumulate holding weight, that is fine: the operator
  asks for corrections when needed or removes misleading ones.
- Provenance tracks the **document lifecycle** (who wrote, edited, approved the record).
- Review comments on a document count as edits to it.

## Alternatives considered

1. **git history as provenance.** Not usable here: the agent commits as the operator, and sometimes commits text the
   operator wrote, so blame carries neither authorship nor approval — it records only that a commit happened.
2. **A separate registry of document weights.** Not chosen: extra machinery, guaranteed to drift from the documents it
   describes. The block lives where the reader is.
3. **No provenance (status quo).** The ambiguity documented in Context.

## Consequences

- Agents consuming these documents calibrate trust by the block: baseline documents are working records whose decisions
  were made in session but whose prose no human has fully vetted; approved documents are settled.
- The trust-weight ladder is defined here; where agents apply it (opencode skill/rules) is a separate change, planned
  alongside this document.
- The ADR skill file is managed via the opencode configuration; its template is superseded on this point, and changes to
  it are planned separately.
- Editing a document updates its Edited list without resetting earlier entries.
