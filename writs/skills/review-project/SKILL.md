---
name: review-project
description: >-
  Review a whole project in your tracker as a buildable spec: extract the claims its description and milestones make
  about the tree, verify each one against main, test the project's shape, and land a single markup-able review in a plan
  file. Tracker-agnostic: load the lens skill for the tracker at hand alongside this skill (the Linear lens is the one
  written so far). Use when given a project and asked to review, evaluate, or sanity-check it, or when the user runs
  /review-project. To review one ticket, use review-ticket; to review a PR, use review-pr.
---

# Review project

A project's description is prose, so it is not evidence about itself. Neither are its milestones, and a progress number
is a claim like any other. Every statement a project makes about the code — that a capability exists, that a component
owns a behavior, that a milestone is done — is a claim to check against the tree. The findings come out of that
checking, not out of reading the description carefully. Read it first only to know what to go check.

## Workflow

```
- [ ] 0. Resolve the project and the repo to verify against
- [ ] 1. Read the project: the ask, claims, touch points, membership
- [ ] 2. Verify each claim against the code, keyed to the milestone that made it
- [ ] 3. Trace one hop out from every touch point
- [ ] 4. Test the project's shape: coverage, tracking health, sequencing
- [ ] 5. Reconcile against the project's existing discussion
- [ ] 6. Filter down to findings the project causes
- [ ] 7. Write the review to a plan file; summarize in chat
- [ ] 8. Incorporate the markup
- [ ] 9. Post on approval
- [ ] 10. Read the correction log back and decide where each lesson belongs
```

### 0. Resolve the project and the repo

Two facts to pin before reading anything: which project, and which repo its claims are about. Resolve the project in its
tracker, and record the lead, the start and target dates, and the status it returns — step 4's tracking-health check
reads them. The lens states the call.

The repo is not in the project. A project name usually implies the repo, and a description that cites tickets names it.
Ask if neither settles it.

Verification only reads `main`, so work in the base clone. No worktree needed.

```bash
repo_dir=~/git/review/<repo>
git -C "$repo_dir" remote get-url origin      # expect .../<org>/<repo>(.git)
git -C "$repo_dir" fetch origin main
git -C "$repo_dir" checkout -f main
git -C "$repo_dir" reset --hard origin/main
cd "$repo_dir"
```

These clones are read-only mirrors of main, so discard local drift rather than stashing it or asking.

With the clone on a clean `main`, get into plan mode if the host lets you. Everything from here until the post is
reading code and writing markdown. On Cursor, switch modes; if the switch does not come back, carry on in agent mode and
write the file directly, since a timed-out switch is not a refusal and it reports itself as one. On a host where only
the user can switch, ask once and carry on in the current agent if they don't.

### 1. Read the project

Find the ask before judging absence. The requester's message, the project's discussion, or the channel that requested
the review states the project's stage. Zero work items is a finding only when the project claims started work; an
early-stage project with unticketed milestones is the process working, and reviewing its membership as a defect reads
the stage wrong.

Then pull four lists before touching code, so the code reading is directed rather than wandering:

1. Claims from the description, each extracted as a testable statement about the tree.
2. Claims from the milestones, extracted per milestone: each claim record carries the milestone that made it. The keying
   is what makes verification complete by construction — step 2 finishes only when every milestone's list is fully
   resolved.
3. Touch points: the files, packages, flags, and scripts the description or any milestone names.
4. Membership: pull the project's work items, all of them, to the end of whatever pagination the tracker uses. The lens
   states the call. Cross-reference the citations too: read every ticket the description or a milestone cites, and look
   for it in the pulled membership. A cited ticket that is not a member is either a tracking gap or a claim resting on
   work the project does not own; both are findings.

### 2. Verify the claims

Every claim comes back verified, refuted, or unverifiable. Read the claim's tense first: a claim about the present
("this component owns teardown") grades against the tree; a claim about the future is a plan, and plans are graded in
step 4, not here — a pending milestone fails nothing by being pending. Each finding carries its milestone, from the
keying in step 1, so "did I check everything" becomes a count of unresolved claims per milestone.

Ownership claims get the widest verification. When a milestone claims exclusive ownership of data or behavior, verify
against every mutation class, not only the writes the description narrates: deletes, teardowns, expiry and cleanup
daemons, and the code that already does them. Inserts get narrated; deletes break claims quietly.

### 3. Trace one hop out

From every touch point, one hop: callers, consumers, dependencies. The question is what the project's claims disturb
that the description doesn't mention.

Where a milestone moves or rehomes shared code, every current consumer of that code is a touch point, not only the named
destination. A rehome that forgets a consumer is a breakage the milestone's own description hides.

### 4. Test the project's shape

Read the description's problem statement as a claim and test it against the tree like any other. Three checks then cover
the project as a whole:

1. Coverage. A promise in the description with no milestone to hold it, and a milestone that serves no promise, are both
   findings — the first is work nobody tracks, the second is tracking nobody asked for.
2. Tracking health. Read the start and target dates, the status, each milestone's progress, and the update channel the
   project names, and state gaps as facts about tracking. Pass the observations through step 6's filter like every other
   candidate: a young project without dates reads differently from a stalled one with people waiting.
3. Cross-project sequencing. A statement like "M1's benchmark decides whether the sibling project keeps its current
   design" binds two projects. Check that the counterpart project exists and states the dependency on its side; a
   binding statement whose counterpart does not carry it is a finding.

Two tests ride alongside the checks:

Risk sizing compares a threat against what the system already tolerates, not against the mechanism alone. The mechanism
says what an attacker could do; the tolerance says what it was worth.

The assumption pass: for each safety mechanism a milestone mentions, ask what it compensates for, and check that the
review states it. Unstated compensations are findings even when every stated claim verifies.

### 5. Reconcile against the discussion

Read the project's discussion in its tracker. A review that re-raises what the discussion already settled wastes the
operator's time, and one that misses what the discussion left open repeats it. A branch or draft PR is neither evidence
nor subject matter.

### 6. Filter to findings the project causes

A candidate survives when it is verified rather than inferred, carries real consequence, and belongs to the project
under review — not to a sibling project's design, the surrounding process, or a ticket's own wording. Proposing a
separate ticket to track a candidate is fair game when the reasoning is strong, which most candidates are not: the
defect has to be verified rather than inferred, carry real consequence, and be too large to fold in rather than merely
inconvenient. A closing line arguing the bug is related is the tell that reasoning is what you are short of.

This section accumulates the project review's own worked examples over time, one per rule; step 10 governs what enters.

### 7. Write the review

The file is `<project-hyphenated>-project-review-<hex>.md`, with `isProject: true` in the frontmatter and the title
"<PROJECT> project review".

Before quoting, re-pull the description and the milestones from the tracker so the quotes stay verbatim. The lens states
the calls.

**Humanize before writing.** Actually invoke the `humanizer-report` skill and run its full process on the payload,
including the closing "what makes this obviously AI-generated?" audit and the revision after it. Recalling the patterns
does not count. The prose that lands in the file is the humanized version.

**Prefix the payload.** `Agent-generated:`, a blank line, then the content. Include it in the draft shown for
confirmation, not just at post time.

Then in chat: how many findings, anything that genuinely needs a decision, and the plan path last, as the absolute path
`echo` printed, on its own line.

### 8. Incorporate the markup

Highlight comments arrive as follow-up chat messages, not as edits inside the file. The plan is the single source of
truth, so edit it in place for every note that lands. Revised text goes back through the humanizer and needs confirming
again.

Do not edit the project description, do not create, edit, or reorder milestones, and do not move work items between
milestones or projects. Mutating the thing under review is the failure the ticket rule describes, at project scale.

**A question is not a correction.** When the user asks how much a finding really matters, answer the question; do not
edit the file. A correction changes the review; a question does not.

Keep the correction log the post reads back: each entry carries the project's ident and what changed.

### 9. Post on approval

Post the review where the ask landed. A review is a document, not a comment: trackers that thread comments beside a
project make a sidebar, and a document's home is a document. Deliver it as an attached file on the thread where the ask
landed, through whatever draft mechanism lets the operator review and send it. The lens carries the proven mechanics and
the known traps for its tracker.

### 10. Read the correction log back

Read the log and decide where each lesson belongs: a rule of this file, a worked example under step 6 (one per rule),
`review-ticket` when the lesson is really about ticket review, or the `humanizer` patterns when it is a writing lesson.
An empty log is stated in chat and stops there.

## Lenses

The workflow is tracker-agnostic: it speaks of the project, its milestones, its work items, and its discussion, and
never names a product. The tracker-specific instructions live in lens skills - one skill per tracker, loaded by its ID
through the skill tool:

- `review-project-linear` - the project lives in Linear.

Load the lens for the tracker at hand alongside this skill, and run the workflow with the lens's deltas applied. Where a
lens and this workflow disagree, the lens wins on its own subject matter: the calls to make, the input forms the tracker
accepts, and how the review is delivered there. A tracker with no lens yet runs the workflow plain, naming its own tools
as you go - write the lens down afterward, so the next run starts from it.
