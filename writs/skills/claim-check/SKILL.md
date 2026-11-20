---
name: claim-check
description: >-
  Check that the claims a change makes about behavior are true of the code: comments and docstrings it adds, docs it
  touches, its commit messages, and the PR body. Extraction is mechanical; judgment goes to a subagent with no context
  that has to cite code per claim. Any one surface can be targeted on its own, so use it also when the user asks to
  check just the commit messages, just the PR description, or just the comments on a change. Use while the work is still
  moving, every time prose is written or reworked, or when the user runs /claim-check or asks whether the comments and
  docs match the code. `review-work` calls this as a step. It is not a style pass; that is `humanizer`.
---

# Claim check

A comment that lies is not a bug in code, so the bug checkers do not catch it. Nobody catches it, which is how three
false sentences on one branch took three review rounds to find one at a time. This skill owns that class: every
assertion the change makes about behavior gets checked against what the code does now.

Two halves, deliberately split. Enumerating the claims is mechanical, so commands do it and nothing depends on
remembering where prose hides. Judging them needs a reader with no stake in the text, so that goes to a subagent that
never saw the work.

Takes a diff scope, defaulting to the current branch against its PR base, and a set of surfaces, defaulting to all of
them. Read-only: it judges truth, edits nothing, posts nothing.

## Workflow

```
- [ ] 0. Resolve the scope and surfaces
- [ ] 1. Extract the claim surfaces
- [ ] 2. Judge them blind
- [ ] 3. Report the false ones
```

### 0. Resolve the scope and surfaces

Four surfaces carry claims, and each can be checked on its own:

| Surface   | What it covers                                      |
| --------- | --------------------------------------------------- |
| `code`    | comments and docstrings the diff adds to code files |
| `docs`    | prose in doc files the diff touches                 |
| `commits` | commit messages not yet pushed                      |
| `pr`      | the open PR's body                                  |

Take the surfaces from the caller — "check the commit messages" is `commits`, "check the PR description" is `pr`, "do
the comments match" is `code`. With nothing named, all four run, which is the full pass `review-work` asks for.

Then the base, resolved the same way a review resolves it, so the claim set matches what ships on this branch:

1. An open PR's `baseRefName`: `gh pr view --json baseRefName,number 2>/dev/null`
2. Else the parent topic branch, when the work is stacked on one. A real parent is reachable from HEAD and not already
   contained in the default branch, which rules out stale branches sitting on the default's own history:
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
3. Else the default branch merge-base

A single commit or an arbitrary range is fine too when the caller gives one, for example `<sha>^...<sha>` to check one
commit's prose. A range the caller picked is the scope exactly as given, so leave the working tree out of it — that is
the one run asking about history rather than about what is in hand.

The default `commits` range starts at the branch's pushed tip rather than at the base. A pushed commit has been
reviewed, and rewriting its message means a force-push nobody wants, so a finding there is noise. A branch that was
never pushed falls back to the base:

```bash
since=$(git rev-parse --verify -q '@{push}' >/dev/null && echo '@{push}' || echo "<base>")
```

An amended message is not reachable from `@{push}`, so it stays in scope until the force-push lands.

Two surfaces need less than that. A `pr`-only run reads the PR body and needs no base at all, so skip the resolution
rather than failing when there is no diff. A `commits`-only run needs a range and nothing else, and on a pushed branch
`@{push}` supplies it without the base being resolved at all.

### 1. Extract the claim surfaces

Run only the extractions for the surfaces in scope. Each one appends to the same claims file, so a targeted run is the
full run minus the parts that were not asked for.

#### `code` and `docs`: prose in the diff

Added and changed lines carry their file and line number so findings are locatable. Diff the merge-base against the
working tree, naming no second revision, so a comment reworked a minute ago is in scope alongside the committed ones. A
run while the work is moving is reading prose that is being written, and prose being written is not yet committed:

```bash
git diff "$(git merge-base "<base>" HEAD)" -U0 --no-color | awk '
  /^\+\+\+ b\// { file=substr($0,7); next }
  /^@@/ { match($0, /\+[0-9]+/); line=substr($0, RSTART+1, RLENGTH-1); next }
  /^\+/ { print file ":" line ":" substr($0,2); line++ }
'
```

A file git has never seen is absent from that diff, so a new file's comments go unchecked while every reworded line in
its neighbours gets a verdict. `git add -N <path>` records the file without staging contents and brings it into the same
diff; do that for the untracked files in `git status` before extracting.

Keep the prose out of that stream. Comment and docstring openers cover the code files, and every added line in a doc is
prose already:

```bash
... | rg -v ':[0-9]+:\s*$' | rg '(\.md:[0-9]+:|:[0-9]+:\s*(#|//|\*|/\*|"""|<!--))'
```

Adjust the opener list for the languages in the diff, and watch the bodies: only the first line of a Python docstring or
a `/* */` block carries an opener, so the lines under it fall out of the stream and the claim arrives with its middle
missing. Widen the filter to keep them when the diff has either.

That one filter serves both surfaces, since the opener alternation picks up code files and the extension alternation
picks up docs. `docs` alone keeps nothing but the extension branch. `code` alone has to drop the doc files from the
stream, not just drop that branch: a markdown heading opens with `#`, so it satisfies the opener branch too and arrives
tagged as a code comment.

So for a single surface the last filter above becomes one of these, with the blank-content `rg -v` still ahead of it:

```bash
... | rg -v '\.md:[0-9]+:' | rg ':[0-9]+:\s*(#|//|\*|/\*|"""|<!--)'     # surface: code
... | rg '\.md:[0-9]+:'                                                 # surface: docs
```

Extend the doc extensions, in both places, to whatever prose the repo keeps outside `.md`.

A claim is a comment block, not a line. A sentence usually spans several lines and a line is usually half a sentence, so
one claim per line asks the judge to rule on fragments and inflates the count about fourfold. Merge runs of consecutive
lines from the same file into one claim, strip the openers, and tag it with the range:

```bash
... | awk '
  function flush() { if (buf != "") print file ":" start "-" stop "\t" buf; buf = "" }
  {
    p = index($0, ":"); f = substr($0, 1, p-1); r = substr($0, p+1)
    q = index(r, ":");  n = substr(r, 1, q-1) + 0; t = substr(r, q+1)
    if (f != file || n != last + 1 || (f ~ /\.md$/ && t ~ /^[ \t]*([-*+#]|[0-9]+[.)])/)) {
      flush(); file = f
    }
    sub(/^[ \t]*(\/\/+|#+|\*+|\/\*+|"""|<!--|[-+]|[0-9]+[.)])[ \t]*/, "", t)
    sub(/[ \t]*(\*\/|"""|-->)?[ \t]*$/, "", t)
    if (t != "") { if (buf == "") start = n; buf = (buf == "" ? t : buf " " t); stop = n }
    last = n
  }
  END { flush() }
'
```

A line carrying only an opener holds a block together without contributing text, which is what keeps a `//`-separated
doc comment in one piece. Blank lines are already gone from the stream, so the gap they leave in the numbering is what
splits one doc comment from the next and a markdown file into paragraphs. In markdown a bullet or a heading also starts
a claim, because a tight list has no blank lines and would otherwise hand back ten assertions on one line with no way to
say which one is false.

#### `commits` and `pr`: prose outside the diff

Neither is in the diff. Both split on blank lines, so a commit message's subject, each of its paragraphs, and each
paragraph of the PR body arrive as separate claims rather than one blob:

```bash
paras() { awk -v s="$1" 'BEGIN{RS="";FS="\n"} {t=""; for(i=1;i<=NF;i++) t=(t==""?$i:t" "$i); print s ":" NR "\t" t}'; }
git log "$since"..HEAD --format=%B | paras commit-message    # surface: commits
gh pr view --json body -q .body | paras pr-body              # surface: pr, when one is open
```

Unlike the diff surfaces, `commits` has no uncommitted half to pick up, and wants none: a run before amending a message
is checking the message that is already there.

Write the whole list to a scratch file, one claim per line, each tagged with where it came from. That file is what the
subagent gets.

#### The inert-symbol sweep

Last, when the change establishes that a symbol is inert, or that its behavior moved elsewhere, grep the surfaces in
scope for that symbol's name and add what comes back. The shape it catches: a branch proves some function never runs on
the path in question, and the name goes on appearing in a new comment, in the commit message, and in the PR body as the
thing doing the work.

```bash
rg -n "<symbol>" -- "<changed files>"              # surfaces: code, docs
git log "$since"..HEAD --format=%B | rg -n "<symbol>"   # surface: commits
gh pr view --json body -q .body | rg -n "<symbol>"      # surface: pr
```

### 2. Judge them blind

Hand the scratch file and the repo path to a fresh `explore` subagent at "very thorough". Give it no chat context, no
ticket, and no plan. Context is what lets a false claim through: knowing a ticket exists to fix a sentence turns into
filing the sentence under that ticket instead of judging it.

One subagent for the whole file. Split only when the file is genuinely too large for one reader, a few hundred claims,
and split it by package or directory so each subagent reads related code at once. Never split on a claim count: that is
what turned one branch into six subagents reading the same handful of packages.

The prompt has to carry, in its own words:

- the repo path and the claims file path
- read the code as it is now, not the diff, and not the intent
- every claim gets read; only the contradicted ones get reported
- `TRUE` with the file and the behavior that makes it true
- `FALSE` with what the code does instead
- nothing else. A claim the code neither confirms nor contradicts is silence, and silence is not a finding
- absence of implementation is not contradiction. If the claim's subject is in the code, read it and judge it. If the
  subject exists nowhere, a worker or an endpoint or a job nothing implements, there is nothing to contradict and no
  verdict
- judge each claim on its own: a claim that also appears elsewhere in the file, or in a doc already on the default
  branch, or that some ticket says it will fix later, is still judged here
- a comment describing a test's own intent is `TRUE` when the test does that
- skip `TODO` lines and statements about future plans; only assertions about current behavior get a verdict
- skip reported results too: a test-suite pass count or a "verified against a live deployment" line is a claim about a
  run, not about the code, and reading the code can neither confirm nor refute it. `review-work` checks those against a
  recorded result.
- a commit message's account of what was there before the change describes the parent commit, not the tree, so it gets
  no verdict. "Six places in this repo still pinned Node 20" is how a commit message says what it is fixing, and the
  judge reads a tree where all six say 24

A stated reason is a claim. "The ceiling stops a millisecond value from overflowing the expiry arithmetic" asserts both
a cap and what the cap prevents, and the second half can be false while the cap is real. Judge the reason, not just the
behavior.

#### Claims about a dependency need the dependency's source

A comment that explains why a guard exists usually does it by describing what some library does, and the repo cannot
answer that. A subagent handed only the repo path returns nothing on those, so the claims that most need checking are
the ones that silently pass.

So resolve the dependency before judging, and say so in the prompt:

1. Get the pinned version from the lockfile the repo actually tracks, not the version range in the manifest. Confirm
   with `git ls-files` before reading: a repo part-way through a tooling migration grows a second lockfile, and the
   abandoned one sits untracked in the tree pinning versions nothing installs. Pointing a subagent at that file resolves
   nothing while looking like it did.
2. Find that version's source on disk: the project virtualenv's `site-packages`, `node_modules`, a vendor directory, the
   module cache.
3. When it is not on disk, fetch the pinned version into a scratch directory and read it there
   (`pip download --no-deps`, `npm pack`, `go mod download`). Reading a dependency is not the same as installing it into
   the project.
4. Cite the package, the version, and the file and line, the same as for repo code.
5. When the dependency cannot be read at all, say so under `Could not read` with the claims that needed it. That is a
   gap in the run, not a verdict on the claim, and it means rerun with the source available rather than edit the prose.

Trace the path the repo's own call actually takes. A library usually has several guards that look like the one the claim
describes, and citing the wrong one produces a confident verdict that is backwards. A review of `configcat-client` 9.0.4
called a comment false by citing the `ValueError` in `get_value` and the error-2001 handler around it. Those exist, but
they fire when a stored value contradicts its own declared setting type. The call the repo makes is
`get_value(key, int_default)`, and for a flag whose type was changed in the dashboard the path is
`_check_type_mismatch`, which logs warning 4002 and hands the raw value back, which is what the comment said. Start from
the call site's arguments and follow them in; do not grep for a guard that matches the sentence.

### 3. Report the false ones

```markdown
## Claim check: <scope>

Surfaces: <the ones checked, or "all"> Claims checked: <n>

### False

- `<file>:<lines>` or <surface> - <the claim>. The code <what it actually does>.

### Could not read

- <the dependency or source the run failed to resolve> - <the claims that needed it>
```

Nothing else in the output. No `TRUE` list, no style notes, no praise, and nothing about what the code does not mention.
When everything checks out, say so in one line with the count.

Naming the surfaces matters most when a run was targeted: a quiet report on three of them reads exactly like a quiet
report on all four, and the difference is which prose nobody has looked at.

## When to run it

While the work is moving, not only at the end. Run it whenever a comment, docstring, doc paragraph, commit message, or
PR body is written or reworked, as many times as the prose changes. It reads one diff and delegates one subagent, so it
costs a fraction of a review pass, and prose is what churns most while a change settles.

Nothing has to be committed first. A sentence is worth checking while it is still in the editor, which is the moment the
author can still change their mind cheaply; the `code` and `docs` extraction reads the working tree for that reason.

Target the surface that just changed, and the run shrinks to match. Before amending prose into a commit, that is the
`commits` surface over `<sha>^...<sha>`. Before posting a rewritten description, it is `pr` on its own, which needs no
diff at all. Rewriting a comment calls for `code`. Checking one surface says nothing about the others, so a targeted run
is for prose in flight, not a substitute for the full pass on a settled branch.

The sequencing with the full review: this skill runs standalone, as often as needed, while the branch is in flight.
`review-work` runs once at the end, on a settled branch with a commit message and a PR body, and calls this as one of
its steps. Running it here is not a reason to skip that step; by then the prose has usually changed again.

## Guardrails

- **Truth only.** Wording, tone, and AI tells belong to `humanizer`. A claim that is true but badly written is not a
  finding here.
- **Current behavior decides.** Not the ticket, not the plan, not what the author meant.
- **No edits, no posting.** It hands back a list; the caller fixes.
- **A claim on an added line is in scope** even when the same claim predates the change. Inherited prose the change
  repeats is the change's problem now.
- **A clean run does not make the prose true.** The same claim set judged twice does not return the same tail, so a
  quiet run is the absence of a finding and not evidence of truth. It is a reason to run again the next time the prose
  changes, not a reason to rerun an unchanged branch.
- **Silence is not a finding.** Reporting what the code does not mention buried the real findings two to one and was
  wrong every time it fired.
