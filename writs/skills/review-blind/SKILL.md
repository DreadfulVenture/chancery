---
name: review-blind
description: >-
  One blind read of a branch's diff by a subagent with no context: correctness, security, tests, conventions,
  maintainability, and slop. The session that wrote the code cannot judge it — the author already knows what it was
  supposed to do, and that intent is exactly what blindness keeps out of the judgment. Emits raw findings (file, line,
  why); severity, verdicts, and ticket checks belong to the caller — `review-work` folds them into its report,
  `review-pr` into its markup. Use mid-flight when the user wants a fresh read of work in hand, or runs /review-blind.
---

# Review blind

A fresh pair of eyes on the current branch's diff. The judging subagent gets the repo path and the base ref and nothing
else — no chat context, no ticket, no plan. Blindness is the point: knowing what the code was supposed to do is what
stops a reader from seeing what it actually does.

Works from whatever exists. Committed and uncommitted work both land in the diff, so a branch mid-flight reads the same
as a settled one, and a clean checkout (a review worktree) just has nothing in the uncommitted half. Read-only — it
judges, edits nothing, posts nothing.

## Workflow

```
- [ ] 0. Resolve the base and the diff scope
- [ ] 1. Delegate the blind pass
- [ ] 2. Report the raw findings
```

### 0. Resolve the base and the diff scope

1. A base the caller named.
2. The parent topic branch, when the work is stacked on one rather than straight on the default branch. A real parent is
   both reachable from HEAD and ahead of the default, which rules out stale branches sitting on the default's own
   history:
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

Then the scope: diff against the merge-base rather than the base tip, so a branch that has fallen behind does not show
reverse deltas for every file the base moved since:

```bash
git fetch origin
git diff "<base>"...HEAD    # three dots: merge-base, not tip
git status                  # staged + unstaged included in the review
```

A file git has never seen is absent from that diff. Untracked files in `git status` are part of the work under review:
`git add -N <path>` records them without staging contents and brings them into the same diff.

**Span.** That default scope — the branch against its detected base, uncommitted work included — covers a review of the
work in hand. A caller-named span replaces it: one commit (`<sha>^...<sha>`), a range, or "from root" is the scope
exactly as given, with no working-tree blending.

### 1. Delegate the blind pass

A fresh general subagent works in this checkout. Its prompt carries the repo path, the base ref, and instructions to
compute the diff itself — `git diff "<base>"...HEAD`, plus `git status` so staged and unstaged work is in scope. Give it
no chat context, no ticket, and no plan. The brief says: judge the code on its own terms, and read surrounding files,
not just the patch. Cover:

- Correctness and edge cases; off-by-one, nil/None, error paths, concurrency.
- Security basics: injection, authz/authn, secret handling, unsafe deserialization.
- Tests: are new functions/behaviors covered? Do tests assert the right thing?
- Conventions: follow patterns in nearby code and any repo rules.
- Maintainability: dead code, leaky abstractions, structure imposed on callers. Watch for slop too: try/catch or
  defensive checks unusual for a trusted path, casts that only silence the type checker, nesting an early return would
  flatten, and patterns that don't match the surrounding file.

It returns raw findings — file, line, and why for each.

### 2. Report the raw findings

Pass them through as returned: file, line, why. No severity sort, no verdict, no ticket check — that is the caller's
lens, and callers want different ones (`review-work` sorts into a fix list, `review-pr` decorates for posting).

## Does not own

Ticket checks, scope discipline, and integration traces are `review-alignment`; running the repo's checks is
`review-gates`; prose truth is `claim-check`. A caller-breaking signature change is in lane here only when the
surrounding code proves it — the deliberate one-hop trace over consumers is alignment's.

## Guardrails

- **Blind means blind.** No chat context, no ticket, no plan reaches the subagent.
- **Read-only.** It judges; it fixes, commits, and posts nothing.
- **Raw findings out.** Severity and presentation are caller concerns.
