---
name: git-workflow
description: Enforce safe git practices before committing, amending, pushing, and submitting pull requests.
license: MIT
metadata:
  audience: agents
  workflow: git
---

# Git workflow

Never amend a commit unless the user explicitly directs it. Before an allowed amend, inspect the commit and diff, and
amend only a commit created in the current session that has not been pushed.

Before pushing a branch for a pull request, fetch and rebase onto the current upstream base branch.

Never push with a bare `git push`. Host git config can redirect a push to the branch the current branch tracks — often
`main` — so always name the destination. For the first push of a branch use `git push -u origin HEAD`, which creates a
same-named remote branch and points tracking at it. For later pushes use `git push origin HEAD`. Never push to `main` or
the repository's default branch; using the workspace's ephemeral branch or a newly created one are both fine. Force-push
only with `--force-with-lease`. If a push is rejected because it targeted a branch other than the one checked out, stop
and re-push with the explicit form above rather than retrying blind.

Before updating a pull-request branch, verify the pull request remains open. Do not push to a merged or closed
pull-request branch. Do not close and recreate a pull request merely to repair a branch state.
