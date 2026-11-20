Parse `<org>/<repo>` from the input -- a PR URL (`.../<org>/<repo>/pull/<number>`) carries it directly. For a bare PR
number, default to the repo of the current workspace. Confirm the number resolves there
(`gh pr view <number> --repo <org>/<repo>`); if it doesn't, ask the user.

### 0. Cursor: resolve the source repo

Cursor's worktree handling is unreliable, so the reviews' source is a persistent clone at `~/git/review/<repo>`, one per
repo. Confirm it exists and actually points at `<org>/<repo>`, since a same-named repo from another org would be the
wrong tree:

```bash
repo_dir=~/git/review/<repo>
git -C "$repo_dir" remote get-url origin    # expect .../<org>/<repo>(.git)
```

If `~/git/review/<repo>` is missing (or its `origin` points somewhere else), don't silently fall back to the current
directory. Tell the user the clone isn't there and offer to create it:

```bash
git clone "git@github.com:<org>/<repo>.git" ~/git/review/<repo>
```

Only clone after the user confirms. Leave the clone itself untouched -- everything from here on happens in a worktree,
not in `$repo_dir`.

### 2. Create a worktree for the head branch

Worktrees come off the persistent clone and live beside it, keyed by repo and branch:

```bash
wt=~/git/review/.worktrees/<repo>/<headRefName>
```

Run the step 2 commands from the skill body with that `$repo_dir` and `$wt`. If the worktree path already exists from a
previous review of this branch, refresh it instead of re-adding:

```bash
cd "$wt" && git fetch origin "<headRefName>" "<baseRefName>" \
  && git checkout --detach "origin/<headRefName>"
```

Every step after this runs from `$wt`. Leave the worktree in place at the end -- the user keeps it for re-reviews, and a
weekly launchd job (`automation/review-cleanup/` in the `system` repo) reaps untouched ones after ~7 days.
