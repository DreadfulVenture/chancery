---
name: review-alignment
description: >-
  The context pass over a branch's diff: does a ticket exist and does the change satisfy it, is the scope disciplined,
  and does the change cohere one hop out with its callers, consumers, and dependencies. Detects what exists at runtime —
  a caller-named ticket, else the branch name, else an open PR's body; no ticket means a stated skip, not a failure.
  Takes pass-1 findings when the caller has them and refines them; emits its own findings either way. `review-work` runs
  it as pass 2, `review-pr` as the shared core of its second pass. Severity sorting and presentation belong to the
  caller.
---

# Review alignment

What only context reveals. The blind pass judges code on its own terms; this pass reads the change against what it was
for — the ticket, the stated goal, the consumers — and returns what the code alone cannot show: missing in-scope work,
out-of-scope work that does not belong here, and callers a changed contract breaks.

Nothing is assumed to exist. A branch can carry a ticket id, or not; a PR can be open, or not; the work can be a partial
piece of a larger change, or whole. Detect the world each run, in the run — the caller's context (before-push, PR,
mid-flight) changes none of the facts.

Runs in-session, not in a subagent: the refinement half needs the caller's knowledge of intent. Read-only — it judges,
edits nothing, posts nothing.

## Workflow

```
- [ ] 0. Detect what exists: ticket, PR
- [ ] 1. Ticket alignment (when one exists)
- [ ] 2. Scope discipline
- [ ] 3. Integration coherence
- [ ] 4. Refine the caller's findings (when it has some)
- [ ] 5. Report
```

### 0. Detect what exists

The ticket, in order:

1. One the caller named.
2. From the branch name (`abc-123-...` implies `ABC-123`).
3. From an open PR's body (`gh pr view --json number,body 2>/dev/null`), which may link a `linear.app/.../issue/ABC-123`
   URL, a Jira key, or a GitHub issue.

Fetch it with the Linear MCP `get_issue` tool, Jira, or the GitHub issue. Not found is a normal result: say so, skip
step 1, and still emit steps 2 and 3 — scope and integration findings do not need a ticket.

**Span.** The default scope is the branch's diff against its detected base. A caller-named span — one commit
(`<sha>^...<sha>`), a range, or "from root" — replaces it, and the ticket check then judges the named span's diff, not
the branch's history.

### 1. Ticket alignment

Check the diff against the ticket's acceptance criteria: in-scope work missing, or out-of-scope work that doesn't belong
here.

Verification status is part of this. Before calling a ticket's manual acceptance step outstanding, look for a recorded
result in memory or the transcript, and either cite that evidence or say no record exists. A step someone already ran is
not an open item just because this session has not seen it.

### 2. Scope discipline

Drive-by edits, unrelated refactors, or partial pieces that don't complete the stated goal. Without a ticket, the stated
goal is what the caller says the branch is for; when nothing states one, say that and judge drive-bys by whether the
files they touch serve the rest of the diff.

### 3. Integration coherence

For a partial change especially, trace one hop out in both directions:

- **Callers / consumers** — who uses what changed? Check the other changed files that touch this one, and existing call
  sites in the codebase. Did a signature, return shape, prop, or invariant change in a way those callers must handle?
- **Dependencies** — what does the change now rely on? If it consumes a type, helper, or value defined in another
  changed file, read that definition to confirm the assumption holds.

A changed signature, return shape, prop, or invariant callers must handle is a finding even if the changed file looks
fine alone. The aim is coherence with the surrounding work, not just internal consistency. Surface any integration
mismatch even when the defect lives outside the diff — name it and point at the change that breaks it.

### 4. Refine the caller's findings

When the caller hands over pass-1 findings, adjust them with this context: downgrade what the ticket or the stated goal
makes intentional or out of scope, sharpen what the ticket now shows was required. Standalone, skip this — the pass
produces its own findings.

### 5. Report

Facts, not presentation:

```markdown
## Alignment: <branch>

Ticket: <id + one-line, or "none detected">

### Ticket alignment

<gaps, or OK, or skipped — none found>

### Scope

<findings, or none>

### Integration

<findings, or none>

### Refined findings

<only when the caller supplied pass-1 findings>
```

The caller applies the lens — a fix list for `review-work`, markup for `review-pr`.

## Does not own

The blind code read is `review-blind`; running the repo's checks is `review-gates`; prose truth is `claim-check`. Scope
discipline can overlap the blind pass's convention findings — a drive-by looks like an off-pattern edit to both. Blind
sees the file-level anomaly; this pass judges it against the goal. Say which side a finding came from; the caller
dedupes.

## Guardrails

- **Detect, don't assume.** Check for the ticket and the PR every run; a missing one is a stated skip, never a silent
  pass or a failure.
- **Read-only.** It judges; it fixes, commits, and posts nothing.
- **Facts out.** Severity and presentation are caller concerns.
