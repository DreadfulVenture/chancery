Parse `<org>/<repo>` from the input -- a PR URL (`.../<org>/<repo>/pull/<number>`) carries it directly. For a bare PR
number, default to the repo of the current workspace. Confirm the number resolves there
(`gh pr view <number> --repo <org>/<repo>`); if it doesn't, ask the user.

### 0. OpenCode: resolve the source repo

The source is the checkout the session is sitting in, when it belongs to the PR's repo -- worktrees are the normal
setup, and a worktree shares its parent repo's object store, so fetch and `worktree add` work from inside it:

```bash
git remote get-url origin    # expect .../<org>/<repo>(.git)
repo_dir="$(git rev-parse --git-common-dir | sed 's|/\.git$||')"
```

The `--git-common-dir` walk-up is what turns a worktree path into its parent repo: `git rev-parse --git-common-dir`
inside a worktree prints the shared `.git`, and stripping the `/\.git$` suffix gives the repo root. A same-named repo
from another org would be the wrong tree, which is what the origin check above rules out.

When the session is not in a checkout of `<org>/<repo>` -- or the origin check fails -- clone fresh for this review and
treat the clone as disposable:

```bash
repo_dir=/tmp/opencode/review/<repo>
git clone "git@github.com:<org>/<repo>.git" "$repo_dir"
```

Nothing here keeps a persistent review clone: the checkout is the primary source, and a review that needs a clone throws
it away with the session.

### 2. Create a worktree for the head branch

Worktrees live beside the source, under a fixed prefix so concurrent reviews never collide:

```bash
wt=/tmp/opencode/review/.worktrees/<repo>/<headRefName>
```

Run the step 2 commands from the skill body with that `$repo_dir` and `$wt`. If the worktree path already exists from a
previous review of this branch in this session, remove it and re-add rather than refreshing in place:

```bash
git worktree remove --force "$wt"
git -C "$repo_dir" worktree add --detach "$wt" "origin/<headRefName>"
```

Every step after this runs from `$wt`. The worktree is disposable too -- it and the throwaway clone die with
`/tmp/opencode`; the review's record is the plan file, not the checkout.
