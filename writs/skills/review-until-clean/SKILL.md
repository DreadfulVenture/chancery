---
name: review-until-clean
description: >-
  Run review-work in a loop: review the branch, fix what came back, re-review, and stop once nothing above a nit is
  left. Each round is a full review-work at one depth tier, with the repo gates and a re-read of the round's own fixes
  in between. Use when the user runs /review-until-clean or asks to review and fix until the branch is clean, or to keep
  reviewing until nothing is left. For a single review pass with no fixing, use review-work.
---

# Review until clean

Drive `review-work` to convergence on the current branch. Every round is that skill's full workflow at one tier; between
rounds you fix what it found and check your own fixes. The loop ends when a round comes back with nothing above a nit,
when the round cap is reached, or when something needs the user's judgment.

This skill reviews and fixes. It does not commit, push, amend, or post anything. Fixes stay in the working tree, which
`review-work` already covers: its step 0 diffs committed and uncommitted work together.

Inputs: the depth tier for the run (default **standard**, the same default `review-work` carries), and optionally a
round cap other than three.

## Workflow

```
- [ ] 1. Round: full review-work at the chosen tier
- [ ] 2. Triage the findings: fix, dispute, carry, or ask
- [ ] 3. Fix, then check the fixes
- [ ] 4. Converged, capped, or another round
- [ ] 5. Final report
```

### 1. Round: full review-work

Invoke `review-work` as written, start to finish, at the tier chosen for the run. Do not abridge it on a later round,
and do not carry findings forward in place of running it again. A round that skips the gates or the claim check to save
time is not a round: the only evidence a fix worked is a fresh review that no longer raises it.

Keep the tier fixed for the whole loop. Change depth mid-run and the rounds stop being comparable, because a finding
that vanishes when the pass that caught it stops running reads exactly like a finding that got fixed.

### 2. Triage the findings

Every finding in the round's report lands in one of four buckets before you touch code.

**Fix.** Blocking and should-fix findings about code, prose, or docs in the working tree. This is the loop's ordinary
work.

**Dispute.** A finding you believe is wrong. Disputing one is allowed and sometimes correct, but it needs a citation:
name the file and say what the code does there now. "Not an issue" on its own is how a real defect survives three
rounds. A disputed finding that a later round raises again goes to the user instead of being disputed twice, because two
independent reads calling the same thing wrong is evidence against your reading of it.

**Carry.** A finding about a commit message. Fixing one means rewriting history, which this skill does not do, so carry
it to the final report unchanged and let it block nothing. Name the commit it concerns, so the user can decide whether
it matters.

**Ask.** Anything needing a decision rather than an edit: a choice between defensible designs, a fix that would change
what the branch sets out to do, or work belonging on a different branch. Stop the loop and put the question to the user
in plain text. Guessing here produces a clean review of code nobody asked for.

### 3. Fix, then check the fixes

Make the fixes. Then, before starting another round, check what you just did:

- Rerun `review-gates` over the changed files — it discovers the repo's own checks (compile or typecheck, the tests
  covering the changed behavior, and static analysis where the repo expects it) and reports each pass / fail / skipped.
  A fix that breaks a gate is cheaper to catch here than in the next round's report.
- Re-read this round's fixes as a diff. Look for two things: a fix that contradicts another fix from the same round, and
  a corner one of them leaves open, such as an error path, a caller, or a second call site with the same bug.

This check is not a round and does not count against the cap. It is what keeps the next round from being spent
re-finding what this round's fixes broke.

### 4. Converged, capped, or another round

**Converged** when a round's report has nothing under Blocking and nothing under Should fix. Nits may remain; that is
the bar. Carried commit-message findings do not count against it either.

**Capped** at three rounds unless the user raised the cap. A loop that is not converging is usually stuck on something
no round can fix, and three reports are enough to say what. On reaching the cap, stop and report where the branch stands
rather than opening a fourth round.

Otherwise, go back to step 1.

### 5. Final report

Lead with the last round's `review-work` report in full. That report is the state of the branch and the part worth
reading. Then add:

- **Rounds**, one line each: the tier, how many findings at each severity, and what got fixed. One line, so the user can
  see the shape of the run without a transcript of it.
- **Disputes**, each with its citation from step 2.
- **Carried commit-message findings**, each naming its commit.
- **Decisions needed**, if the loop stopped to ask.

The verdict is the last round's, unchanged.

## Guardrails

- **Fixes live in the working tree.** No commits, no pushes, no amends, no PRs, nothing posted. The user decides when
  the work lands.
- **Never rewrite history.** A commit-message finding gets carried, not fixed.
- **Every round is a full `review-work`.** No abridged rounds, and no reusing a previous round's findings in place of a
  fresh pass.
- **Ask rather than decide** on anything in the ask bucket.
- **One tier for the whole loop.**
