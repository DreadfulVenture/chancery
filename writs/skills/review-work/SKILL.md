---
name: review-work
description: >-
  Review the work in hand: a two-pass code review (blind, then ticket/intent-informed) over this branch's diff, plus
  repo gates, a claim-check pass on whether the prose matches the code, and delegated bug and security passes, ending in
  a go/no-go verdict. The passes it runs are callable on their own — review-blind, review-alignment, review-gates,
  claim-check — for mid-flight checks; this skill is the full run, so it fits settled work. Run only when the user asks
  — it is never a default step; agents do not start it because a commit or push is coming. For reviewing someone else's
  PR, use review-pr instead; for reviewing a ticket before it is built, use review-ticket.
---

# Review work

Review the work in hand, in the current workspace checkout — committed and uncommitted together. Borrows the two-pass
method from `review-pr` but produces a fix list for the author, not a postable PR review. It reviews; it does not
commit, push, or open PRs.

This is the user's tool. It runs when they ask for it — `/review-work`, "review the work", "review this branch",
"self-review" — and the fact that a push or commit is coming is never a reason to start it. Do not run it "while you're
at it", do not run it because a plan mentions a push, and do not offer it; the callable passes above are the cheap way
to check work while it moves.

Operate on the current branch and workspace. Optional: a depth hint ("quick check", "deep") and a ticket id if the
branch name doesn't carry one.

## Workflow

```
- [ ] 0. Resolve base branch and diff scope
- [ ] 1. Pass 1: blind code review (delegate: `review-blind`)
- [ ] 2. Pass 2: ticket alignment, scope, integration coherence (`review-alignment`)
- [ ] 3. Claim check (delegate: does the prose match the code?)
- [ ] 4. Automated gates (`review-gates`)
- [ ] 5. Delegated passes (per depth tier)
- [ ] 6. Report + go/no-go verdict
```

### 0. Resolve base branch and diff scope

Match what a reviewer will see for this branch alone. Pick the base in this order:

1. A base the user named.
2. The branch this one was built on, if the work is stacked on another topic branch rather than straight on the default
   branch. A real parent is both reachable from HEAD and ahead of the default, which rules out stale branches sitting on
   the default's own history:
   ```bash
   default=$(git symbolic-ref --short refs/remotes/origin/HEAD)
   current=$(git branch --show-current)
   git branch --merged HEAD --format='%(refname:short)' | while read -r b; do
     [ "$b" = "$current" ] && continue
     git merge-base --is-ancestor "$b" "$default" || echo "$b"
   done
   ```
   Nothing printed means the branch is not stacked, which is the common case. If several print, take the one closest to
   HEAD.
3. The default branch, which is the usual answer:
   ```bash
   git symbolic-ref --short refs/remotes/origin/HEAD
   ```

Then capture both committed and uncommitted work — you're checking what you're about to push, so include local edits,
not just committed hunks. Diff against the merge-base rather than the base tip, so a branch that has fallen behind does
not show reverse deltas for every file the base moved since:

```bash
git fetch origin
git diff "<base>"...HEAD    # three dots: merge-base, not tip
git status                  # staged + unstaged included in the review
```

### 1. Pass 1: blind code review

Delegate to `review-blind` with the base step 0 resolved. A fresh general subagent reviews the diff **blind** — the
session that wrote the branch cannot honor that itself: the code's author already knows what the code was supposed to
do, and that intent is exactly what blindness keeps out of the judgment. It returns raw findings — file, line, and why
for each; refine them in pass 2.

### 2. Pass 2: ticket alignment, scope, integration coherence

Run the `review-alignment` pass on the same diff scope, with the pass-1 findings. It detects what exists — the ticket
from the branch name, else an open PR's body — and adds what only context reveals, author-focused: the diff against the
ticket's acceptance criteria, scope discipline, and the one-hop integration trace out to callers, consumers, and
dependencies. It refines the pass-1 findings with that context: downgrade what's intentional or out of scope, sharpen
what you now know was required. No ticket linked comes back as a stated skip; scope and integration findings still land.

### 3. Claim check

Delegate to `claim-check` on the same diff scope. It owns one class of finding nothing else catches: prose that asserts
something the code does not do. Bug checkers stay quiet on it, because a comment that lies is not a bug in code, and a
reader who knows the change is the worst judge of whether its own comments are true.

Run it over every surface it knows — comments and docstrings the diff adds, docs it touches, the commit messages not yet
pushed, and the PR body. It can be pointed at one surface alone, but that is for prose in flight; a pre-push review
wants the lot, so name no surfaces and take the default. Take its `FALSE` list into `Blocking` when the claim ships in
code or docs, and into `Should fix` when it is in a commit message or the PR body. A `Could not read` entry is not a
finding — the run could not reach a dependency, so rerun it with that source available rather than edit anything.

### 4. Automated gates

Run `review-gates` over the changed files. It discovers the repo's own checks — never inventing commands — and records
each as pass / fail / skipped for the report.

### 5. Delegated passes (per depth tier)

Pick a tier and delegate to the existing skills — do **not** re-run their logic inline. Default to **standard** unless
the change or the user says otherwise.

| Tier                   | When                                              | Passes                                               |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **fast**               | Small/low-risk change, or user says "quick check" | Steps 0–4 only, plus the slop scan already in pass 1 |
| **standard** (default) | Normal pre-push                                   | fast + the bug pass                                  |
| **deep**               | Large refactor, auth/secrets, new surface area    | standard + the security pass                         |

The delegated passes run in a subagent, which keeps them blind to everything this session already believes about the
branch:

- `claim-check` — used in step 3, so it runs in every tier including **fast**. It costs one subagent and it is the check
  that catches false prose.
- **Bug pass.** Where the host ships a dedicated bug reviewer, use it: on Cursor that is the `review-bugbot` skill,
  which launches the `bugbot` subagent over the branch's changes. Otherwise hand a fresh general subagent the step 0
  diff and a bug brief — correctness, edge cases, error paths, concurrency — asking for file, line, and the input that
  fails for each finding.
- **Security pass.** Same shape: the `review-security` skill where the host has it, otherwise a general subagent with a
  security brief covering injection, authn/authz, secret handling, unsafe deserialization, and trust boundaries.
- **A specific falsifiable claim** the change makes — a perf fix, a bug repro — gets checked rather than taken: restate
  it with a threshold, run the same command at the merge-base and at HEAD, and report it `VERIFIED`, `NOT VERIFIED`, or
  `INCONCLUSIVE`. This is per-claim, not per-run.

Fold any findings from the delegated passes into the single report below; don't leave the user to reconcile separate
outputs. The lanes overlap by design — the blind pass and the bug brief both own correctness, the blind pass and the
gates both surface a missing test — so dedupe on collapse: the same file, line, and finding class from two lanes is one
finding, stated at the strength of the stronger account, with both lanes cited.

### 6. Report + verdict

Author-facing, structured to act on — not a postable PR review:

```markdown
## Self-review: <branch> (base: <base>)

Ticket: <id + one-line, or "none linked"> Depth: fast | standard | deep

### Blocking (fix before push)

- ...

### Should fix (strongly recommended)

- ...

### Nits (optional)

- ...

### Automated checks

| Check             | Result                        |
| ----------------- | ----------------------------- |
| compile/typecheck | pass/fail/skipped             |
| targeted tests    | pass/fail/skipped             |
| semgrep           | pass/fail/skipped             |
| claim check       | N false                       |
| bug pass          | N findings (runner) / skipped |
| security pass     | N findings (runner) / skipped |

### Ticket alignment

<gaps or OK>

### Verdict

**push** | **fix first** | **split the branch** — one line why
```

State findings as plain facts about the code, not as self-narration ("I checked...", "I verified...") or grading ("nice
work", "looks great"). Run the finding text and the verdict line through the `humanizer` skill before presenting the
report; leave the headings, the checks table, and the section structure as they are.

## Guardrails

- **Run it once, at the end.** Every run is a full pass over everything; nothing carries over from a previous one, so
  re-running while the branch is still moving repeats the whole cost to re-read prose that is about to change again.
  Wait until the code has settled and the commit message exists. While things are in flight, run `/claim-check` on its
  own as often as the prose changes — it is the cheap part of this review and the part that churns, and the other passes
  have standalone skills for mid-flight runs too (`review-blind`, `review-alignment`, `review-gates`) when one lane is
  all you need. The exception is `review-until-clean`, which pays that cost deliberately: each of its rounds is a full
  run, and a fresh one is the only evidence that the last round's fixes held.
- **User-invoked only.** The user calls this skill; a pending commit or push is not a trigger, and neither is a skill
  workflow step the user did not order.
- **Review only.** Do not commit, push, or open/update PRs.
- **Do not fix** unless the user asks after seeing the report, or `review-until-clean` is the caller — fixing between
  rounds is that skill's whole job.
- **Respect repo-local rules** when present (commenting style, `make semgrep` expectations, project rules for changed
  files). Don't hardcode any one repo's setup; read what the repo defines.
- **Findings are internal.** This skill produces a fix list, not outbound text; it posts nothing.
