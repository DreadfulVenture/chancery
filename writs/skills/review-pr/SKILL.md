---
name: review-pr
description: >-
  Check out a PR branch from a PR link and review it in two passes: a blind code-review pass on the diff against the PR
  base, then a context-informed second pass after reading the PR description, linked tickets, and existing review
  threads (reconciling against concerns already raised). Use when given a PR URL or a bare PR number and asked to review
  it, or when the user runs /review-pr. For reviewing a ticket or spec before it is built, use review-ticket instead.
  Halts before any work and asks whether to proceed when the PR is already merged, closed, or approved.
---

# Review PR

For reviewing your own work in the current checkout, use `review-work` instead — this skill is for reviewing someone
else's PR. To review a ticket before anyone writes the code, use `review-ticket`.

Review the PR that was linked, and only the changes it carries itself. Review the code **twice**: a blind first pass
over the diff with no surrounding narrative, then a second pass after gathering context (PR description, tickets,
existing comments). The blind pass surfaces what the code actually says; the context pass catches intent gaps and avoids
re-raising settled points.

## Inputs

A PR URL or a bare PR number. A URL's trailing segment is the PR number, and the path carries `<org>/<repo>` ahead of
it.

## Halt check: merged, closed, or approved PRs

**Before anything else, find out whether the PR is merged, closed, or already approved by anyone. If it is any of those,
stop: tell the user what you found, ask whether to proceed, and end your turn.** Do not resolve the source repo, create
a worktree, read the diff, or start any later step until the user answers in this conversation.

Report the finding in one line, then ask in plain text, for example: "PR 412 merged Nov 3 (by alice) and bob approved it
Nov 3. Do you still want me to review it?"

The user's answer to that question is the only thing that releases the halt. None of these does:

- The user linked the PR or ran `/review-pr`. That request is what the halt is checking, not an answer to it.
- The approval came from a bot, is old, or isn't the user's.
- The PR is small and the review would be quick.
- A post-merge review could still be useful as a follow-up, or the diff looks interesting.
- Asking feels like an interruption, or the user seems busy.
- This PR was reviewed in an earlier turn or session.

If the check can't be completed (an auth failure, a tool error, a host you can't read), that is a halt too. Report what
failed and ask. Don't proceed on the assumption that the PR is open.

The check reads the PR's state (open, merged, or closed), when and by whom it merged or closed, its head commit, and the
author and time of each latest review that is an approval. Read only the author and time of an approval, never its body.
The body is context for step 4, and reading it now breaks the blind pass.

A Linear review link (`linear.app/.../review/...`) wraps a PR on another host. Resolve it with the Linear MCP `get_diff`
tool, then use the variant for the host it points at.

**GitHub variant.**

```bash
gh pr view <number> --repo <org>/<repo> \
  --json headRefName,baseRefName,headRefOid,number,url,state,mergedAt,mergedBy,closedAt,latestReviews \
  --jq '{headRefName,baseRefName,headRefOid,number,url,state,mergedAt,
         mergedBy: .mergedBy.login, closedAt,
         approvals: [.latestReviews[] | select(.state=="APPROVED") | {author: .author.login, submittedAt}]}'
```

Halt if `state` is `MERGED` or `CLOSED`, or if `approvals` is non-empty.

## Workflow

Where the review's source repo comes from and how its worktree is created is the one part of this skill that differs per
client. The workspace block for the client this skill was deployed to is spliced in below, so the flow here is complete
for that client -- there is nothing to route on. Track progress with this checklist:

```
- [ ] HALT CHECK: merged, closed, or approved? Then report it, ask whether to proceed, and end the turn
- [ ] 0. Resolve the source repo and the review worktree
- [ ] 1. Resolve PR -> head + base branch (branch names only)
- [ ] 2. Create a worktree for the head branch and cd into it
- [ ] 3. First pass: blind code review of the PR's diff
- [ ] 4. Gather context: review request, PR description, tickets, existing review threads
- [ ] 5. Second pass: re-review with context; reconcile and finalize
- [ ] 6. Write the review to a plan file and humanize it; summarize briefly in chat
```

Start step 0 only once the halt check has passed or the user has answered it.

@workspaceSetup@

### 1. Resolve the PR to its head and base branch

A PR URL carries the number, not the branch. Resolve **only the branch refs** -- do not pull the title or body yet, so
the first pass stays blind:

```bash
gh pr view <number> --repo <org>/<repo> --json headRefName,baseRefName,number,url
```

`headRefName` is the branch you'll review. `baseRefName` is the branch this PR targets, which on a stacked PR **is the
parent branch** -- so it's exactly what the PR's own diff is taken against. The PR `title` and `body` are fetched later,
in step 4.

### 2. Create a worktree for the head branch

Fetch the two refs and add a worktree checked out at the head, in detached HEAD -- review needs no local branch, and
detaching sidesteps "branch already checked out" conflicts with the source repo or another in-flight review:

```bash
git -C "$repo_dir" fetch origin "<headRefName>" "<baseRefName>"
git -C "$repo_dir" worktree add --detach "$wt" "origin/<headRefName>"
cd "$wt"
```

`$repo_dir` and `$wt` are what the workspace block above resolved. The one invariant that holds on every host: the
review worktree is separate, and the checkout the session was sitting in is never re-checked-out -- its working state is
load-bearing.

**On a merged or closed PR the head branch is usually deleted**, so fetching `<headRefName>` fails. Meanwhile a stale
`origin/<headRefName>` left in the clone can still resolve and silently hand you an old commit. Fetch the host's PR ref
instead (on GitHub, `git -C "$repo_dir" fetch origin "pull/<number>/head"`), and use the head commit the halt check read
wherever these commands or the workspace block say `origin/<headRefName>`.

### 3. First pass: blind code review

Review only this PR's own changes, not everything the branch it targets brought with it. The diff under review is taken
against the PR base, and its file list is the set of places a comment can be anchored. Write the anchor set down now,
because every finding you form from here has to land inside it:

```bash
git diff --name-only "origin/<baseRefName>"...HEAD
```

On a merged PR, take the base from the parent of the PR's first commit instead, for the anchor set and for
`review-blind`. If the PR landed as a merge commit, its head is already part of `origin/<baseRefName>` and the three-dot
diff comes back empty.

On a file the PR adds, every line is anchorable. On one it only modifies, GitHub takes a comment on lines inside the
diff hunks and nowhere else.

Run the `review-blind` pass against that base, in this worktree: a fresh subagent judges the diff with no PR
description, no tickets, and no comments. Blindness is the point — what the code actually does, not what it's claimed to
do — and delegating keeps this session blind too, so nothing read here biases the context pass. It returns raw findings:
file, line, and why. Record them; you'll revisit them in the second pass.

### 4. Gather context

Now pull the surrounding context the first pass deliberately skipped.

**Your perspective is fixed.** CODEOWNERS does not enforce reviewers, so nothing routes a given PR to you and there is
no request to attribute. You read every PR from the same standing perspective, while keeping overall product health in
view.

**CODEOWNERS is the map of what your side owns**, and that is what decides where to read hardest. Match the diff's
changed files against it (last matching rule wins) and record the subset your side owns; that list drives the deep dive
in step 5.

It confers no limits. The user has standing over the entire repo, so every file in the diff is fair game, at full
strength, with the authority to block. There is no such thing as a finding that's "not ours." Never write that a point
belongs to another team, never soften a finding because CODEOWNERS points elsewhere, and never answer a question by
explaining whose call it is. Severity comes from the merits of the problem -- how bad is it, does it need fixing before
merge -- and from nothing else.

Security, access control, secrets, auth, and dependency surface get raised even when the file isn't in the diff at all.
A dead CSP allowlist entry or an unused dependency still on the supply chain is worth saying out loud. Do note when a
finding sits outside the diff, since that changes how it can be actioned -- a comment can't be anchored to a line that
isn't there, and the ask is a follow-up or an added commit rather than an edit. That's a fact about mechanics, not a
hedge about whether the finding counts.

That license is about substance, not location: it covers what an attacker or the supply chain could reach. It does not
stretch to build hygiene, coverage, or config gaps sitting in files the change leaves alone. Those are conditions the
author inherited, and asking for them makes repairing the repo a condition of merging their feature. The test is whether
the change made it worse -- a new file landing in an already-uncovered directory did not create the gap, and a module
that arrives with its own tests is not going unverified.

Apply that test the moment a finding forms outside the anchor set from step 3, not at submit time. There the answer is
ordinary judgment: one that belongs goes in the review body as a follow-up ask, one that doesn't gets dropped.
Discovering the problem after the text is confirmed is a halt instead, for whatever posts the review.

**Name the chain, don't gesture at the category.** When you call something a security concern, spell out what an
attacker would actually need, then let the reader size it. A permission is not a load and dead config is not exposure:
an allowlisted domain nothing requests only matters given a separate injection bug _and_ a compromise of that domain, so
say that instead of implying live traffic. A performance finding gets the same treatment: before it gets a label, work
out how often the condition arises and what one occurrence costs. A full map scan on every failure, under a lock two
goroutines share, sounds like a stall until the arithmetic comes out to well under a second per failed batch, in an
incident where those batches are failing anyway. Sizing it honestly usually reveals the right label -- most of these
land on `chore` or `nitpick` rather than `issue`. Inflating one finding is expensive, because it's the reason the next
one gets discounted.

The only findings that legitimately disappear on a second look are the ones that were never real findings: noise,
speculation the diff already answers, points an existing thread has covered, and pre-existing conditions the change
happens to sit next to. **If you find yourself deleting a batch of findings at once because you re-scoped, stop** --
you're confusing "not mine to decide" with "not worth saying," and a verified problem doesn't stop being one because
someone else owns the file. The line between the two: a defect this change introduces or worsens survives no matter who
owns the file, and a gap the change merely stands near does not become this PR's to close.

**PR description:**

```bash
gh pr view <number> --repo <org>/<repo> --json title,body
```

**Linked tickets** -- from the branch name and the PR body:

- **Linear**: an identifier like `ABC-123` (the branch `abc-123-detail-drawer` implies `ABC-123`), or a
  `linear.app/.../issue/ABC-123` URL in the body. Fetch it with the Linear MCP `get_issue` tool and read the
  requirements / acceptance criteria.
- **Jira / GitHub issues**: resolve links in the body with the appropriate tool.

**Existing review threads** -- with resolution state and full discussion. Use GraphQL, since REST doesn't expose whether
a thread is resolved:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes{
        isResolved isOutdated path line
        comments(first:30){ nodes{ author{login} body } }
      }}
      reviews(first:50){ nodes{ author{login} body state } }
      comments(first:50){ nodes{ author{login} body } }
    }
  }
}' -F owner=<org> -F repo=<repo> -F number=<number>
```

`reviewThreads` are inline threads (with `isResolved`); `reviews` are review summaries including Bugbot; `comments` are
top-level discussion.

Read **resolved threads too** -- do not skip them. A resolved thread often records _why_ a concern turned out to be a
non-issue (a deliberate decision, a constraint, a follow-up ticket). That rationale is exactly what keeps you from
re-raising a settled point.

### 5. Second pass: re-review with context

Go back over the code now that you have the description, tickets, and prior discussion. The goal is to refine the blind
findings and add what only context can reveal -- not to start over.

**Delegate the shared core to `review-alignment`.** It detects what exists -- the ticket from the branch name or this
PR's body -- and returns the ticket-alignment, scope-discipline, and one-hop integration findings, refining the blind
findings with the ticket's context: downgraded when the ticket shows the work intentional or out of scope, sharpened
when it shows what was actually required. It returns facts; the PR lens below decides presentation, so a label change
from this context (`issue (blocking)` to `suggestion (non-blocking)`, say) happens here, on the refined findings. Run it
before reconciliation, so a finding the ticket kills never reaches a thread check.

**Zoom in on the owned files.** The subset step 4 matched against CODEOWNERS is where you are likeliest to catch what
nobody else will -- give those a deeper, line-by-line look. Re-read each in full (not just the patch hunks), trace the
code paths the change touches, and scrutinize edge cases, error handling, and contracts with callers. That extra
attention is about how closely you read, not about grading on a curve: the same defect carries the same severity
wherever it sits in the diff. The rest of the diff still gets a real pass. On a partial match, give the one hop out from
each owned change the deep read yourself: `review-alignment` traces that hop for the whole diff at mechanical coverage,
and here it gets review depth -- the other changed files that touch your owned files, and existing call sites in the
codebase. Surface any integration mismatch even when the defect lives in a file you don't own -- name it and point at
the owned change it breaks.

**Add what only the PR lens sees:**

- **PR description accuracy** -- compare `title` and `body` to the actual diff. Flag claims that don't match the code, a
  stale/templated description, a `Testing` section not reflecting reality, or checklist/template misuse per repo
  conventions. The error has to move the conclusion, not just the credit for it. Before flagging a `Testing` claim about
  CI, enumerate the jobs that actually touch the changed files; a line citing the wrong job while some other job does
  cover the change is attribution-quibbling, and it gets dropped.

**Reconcile against existing threads.** Match on substance, not wording -- the same concern at the same place counts as
covered even if phrased differently:

- **Unresolved thread already raises it** -> drop your version of the argument; it's already on record. Do not drop the
  severity. This filter exists to keep you from repeating a point, not to launder a blocker out of the review, so never
  approve merely because filtering emptied your blocking list. Your own trace decides which way it goes:
  - Doesn't block -> stay silent on it. Their thread stands without help from you.
  - Does block -> the status is `REQUEST CHANGES`, and you owe a short note saying so. Put it in the review body rather
    than a second comment on the line their thread already occupies: name the thread, say you traced it and agree, and
    add whatever your trace found that theirs didn't. A sentence or two. Don't restate their argument back at them, and
    don't recap it in the inline comments either.

  Either way the trace has to be yours. Their `(blocking)` is their call on their reading of the code, not evidence
  about yours, and "someone else blocked, so I won't approve" collapses the first time you're asked to defend it.
  Agreeing without tracing is that same borrowed judgment wearing a friendlier label.

- **Resolved thread settles it** -> drop it, and trust the recorded rationale unless that rationale is clearly wrong.
- **You disagree with a resolution** -> keep the finding, but reference the prior thread and say why the recorded
  rationale doesn't hold. Don't silently resurrect a settled concern.

**Drop what the machinery surfaces on its own.** A merge conflict, a failing check, and a lint error are not review
findings. The author cannot merge without hitting them, so the comment spends credibility on something the process
guarantees they see. A second beat about why this particular one is tricky -- that a conflict needs a regenerate rather
than a side-pick, say -- does not rescue it. Before raising anything the merge or CI machinery will catch, ask what your
comment adds over the moment they hit it.

**When the substance of the diff is a comment, audit durability before accuracy.** Read each line against the
durable-comment standard first: is it still true in three months? Change history pinned to CVE IDs, a measured byte
size, a row describing a path that isn't in the image -- cut those rather than correcting them. A correction spends a
comment defending a line that should be deleted, and the best case is an accurate comment that still goes stale. Same
shape as not nitpicking code an open removal PR deletes. The line to recognize reads like
`It hid CVE-2025-60876 in busybox and CVE-2026-58055 in nghttp2-libs for as long as the database was deleted.` -- true
at merge, dated by the next base bump.

Keep only net-new findings plus any explicit, justified disagreements.

### 6. Write the review to a plan file

**Recall before you draft.** Before writing any comment text, run a memory recall keyed to the findings you are about to
write, not to the repo. Recall fires at prompt boundaries and this step lands hours of tool calls later, so a rule about
how to word a finding will not surface on its own, including one stored earlier the same day.

The review is a document to mark up, not a chat message. Write it to a plan file so the user can highlight any section
and comment on it; those notes come back as follow-up messages. A review pasted into chat can't be annotated, so **do
not** put the verdict, comments, or review body in a chat message -- that's the whole reason for the file.

Plans are loose files -- no index, no database, and no conversation id inside them. Write the file directly, in the
directory the host reads plans from:

```bash
# Cursor
echo "$HOME/.cursor/plans/pr-<number>-review-$(openssl rand -hex 4).plan.md"
# OpenCode
echo "$HOME/.opencode/plan/pr-<number>-review-$(openssl rand -hex 4).md"
```

On OpenCode that directory is the one place the Plan agent is allowed to write, so the file can be created and revised
from either agent.

On Cursor, don't try to reach the plan tool by switching modes. It only exists in plan mode, and step 2 needs agent mode
for the worktree. `SwitchMode` doesn't reliably surface a prompt here: it times out, and the timeout comes back worded
as though the user rejected the switch. That burns a turn and invites a wrong conclusion about what they asked for, so
write the file from agent mode and don't treat a failed switch as a decision. On any host where the model cannot enter
plan mode at all, write the file from whichever agent is running.

Cursor needs the frontmatter to render the file, and it costs nothing elsewhere:

```yaml
---
name: PR <number> review
overview: "<APPROVE|REQUEST CHANGES> on <org>/<repo>#<number> (<title>), <N> inline comments. Nothing posted yet."
todos: []
isProject: false
---
```

The file earns its existence by being markup-able, so it holds only text the user will mark up or that will get posted:
the verdict, the inline comments, and the overall review body. Nothing else. Anything written for the user's own
understanding rather than for the PR goes in chat, because they won't highlight it and refine it -- and anything they
won't refine is just making the file longer to scroll. Ticket alignment, description accuracy, the branch/ticket header
block, and the list of things you checked that were fine stay out entirely; that material did its job by shaping the
verdict and the comments.

**Verdict.** One line of reasoning plus the status, which is `APPROVE` or `REQUEST CHANGES`. There is no third option.
`COMMENT` is an abstention: a review that lists problems without saying whether the code should ship has handed the
decision back to the author.

The status is not a separate judgment call, it follows from the findings. Any comment you post decorated `(blocking)`
means `REQUEST CHANGES`, and so does agreeing that a point someone else already raised blocks (step 5 covers how to say
so). Nothing blocking means `APPROVE`. The real decision happens per finding, at the moment you pick the decoration, so
decide it there and let the status fall out.

**Trace the consumer before you write `(blocking)`.** Broken plus nobody-reads-it-yet is not blocking. Find what
consumes the thing you say is wrong and how the wrongness reaches a person: a report nothing runs, a label nothing
queries, a metric nobody alerts on are all real defects that hold up nothing. A drift command's blind spot once went out
as `issue (blocking)` before anyone checked whether the command was wired into CI, which it was not.

Approving while leaving open a question you actually want answered before merge is `COMMENT` with extra steps. Either
the answer gates the merge, so it is `question (blocking)` and the status is `REQUEST CHANGES`, or it does not, and then
a second test decides whether to post it at all: do the possible answers diverge in what you would do? A question whose
answers all lead to the same place is not a finding, whatever its label says. Cut it.

You will have the tell before anyone objects. If you can already write the sentence explaining why the answer would not
change the verdict, that sentence is the reason to cut the comment, not a caveat to attach to it.

**Inline comments.** One `###` subsection each, never a numbered list -- a list item can't be highlighted cleanly on its
own. Target in the heading, payload between rules under it. Skip the section entirely when there are no comments.

> ### Comment 1 -- `server/run.go:42`
>
> ---
>
> Agent-generated:
>
> suggestion (non-blocking): Guard against a nil cfg here. Callers in cmd/ can pass a zero-value config, which panics on
> the deref below.
>
> ---
>
> ### Comment 2 -- `server/config.go:18`

**Rules mark what gets posted.** Anything between a pair of `---` rules is verbatim payload; anything outside them is
commentary for the user. Never fence a payload: a fence stops it rendering the way it will render on the PR, and any
code block inside it then needs nested fences. Rules delimit without escaping, so backticks, code blocks, and
indentation inside a payload all behave normally.

How you arrange them is free. Bracket each comment on its own with commentary in between, or run several together in one
block -- whatever reads best for what you are showing. If a payload needs its own `---`, say in the commentary outside
the rules that it is intentional.

Keep a blank line above an opening rule: `---` directly beneath a line of text is a setext heading, not a rule, and
silently promotes that line to a heading.

Every comment body is a [Conventional Comment](https://conventionalcomments.org/): a
`<label> (blocking|non-blocking): <subject>` first line, then the reasoning below it. Each body opens with the
`Agent-generated:` prefix, a blank line, then the Conventional Comment. Always include an explicit `(blocking)` or
`(non-blocking)` decoration, even on labels that are inherently non-blocking (`note`, `nitpick`, `thought`) -- the
redundancy is deliberate. Pick the label that fits:

- **issue (blocking):** a problem that must be fixed before this merges.
- **issue (non-blocking):** a real problem that needn't hold up this PR.
- **suggestion:** a concrete improvement; decorate it to set expectations.
- **question:** a concern you're unsure about -- ask rather than assert. Reach for it when the change contradicts a
  decision recorded in the code it replaces and both behaviors are defensible: "this changed" is yours to say, "this is
  wrong" is not.
- **nitpick:** trivial, preference-based; always non-blocking.
- **praise:** never use, even though the standard defines it. Praise from an agent reads as condescending however well
  earned it is.
- **todo / chore / note / thought:** as defined by the standard.

**The subject line is the ask.** Every comment asks for something, even a `note`, and the ask belongs on the label line
where the author reads it first. A comment that states a fact and leaves the request to be inferred from a paragraph of
sizing invites "is this a suggestion for a comment?" -- and if you cannot write the ask, there is no comment to post.
How that ask sits on the page depends on length. A comment long enough to need a signpost gets the ask alone on the
label line with the reasoning below it; a two- or three-sentence comment runs as one block after the label, where the
structure costs more than it buys. When the finding is about a comment, the ask is the sentence the comment should say.
A request to cite a ticket or a PR description is not that -- it points at where the reason lives instead of putting the
reason in the file, which is the whole job of a comment. Write the ask as what you would do:
`I'd cut the deadline and the cancellation from this line`. The bare imperative (`Reword this.`) is an order, and giving
orders on someone's PR claims the same position over the author that praising their work does.

**Length: a claim, its evidence, and its consequence.** Anything past those three is restatement. The tells are a
closing sentence repeating the opening in weaker words, an aside softening a point immediately after making it, and
offering two ways to say the same objection. Name the file and function rather than narrating what the code does; the
author can open the file. The same holds for tooling: name the check you want and where it belongs, and skip how the
mechanism works -- explaining a linter's matching rules to the person who will write the rule is botsplaining, and the
ask was the only part they needed.

**Paraphrase it before you present it.** Say the comment back to yourself as the one-line ask it is. If "it'd be handy
to keep this query around, especially for X and Y" covers a three-paragraph comment, then that paraphrase is the comment
and everything past X and Y was you arguing for your own suggestion rather than making it. The user writes this
paraphrase himself when a draft is padded, and his version is always shorter, so getting there first is the whole job.
Don't hand over a long draft expecting the trim to come back as a correction.

**Hold your own prose to the same read as the code.** Every claim in your comment is a claim, including the ones about
where a behavior comes from. A finding padded with an unchecked rationale hands the author the rationale to argue with,
and the finding goes down with it. A comment once rested on a namespace-naming invariant coming from a workflow trigger,
when a shell script in the same repo enforced it outright.

A proposed fix is another claim and gets read just as hard. Verify it to the standard of a real recommendation or leave
it out and ask the question instead: `extra_data = COALESCE(EXCLUDED.extra_data, <existing>)` went out as the cure for a
clobbered column when it makes that column unclearable and cannot tell "the request carried none" from "explicitly
null." A soft fix gives the author something to argue with instead of a question to answer.

**A finding resting on how you read the author's words needs the other reading checked.** Their comments, commit
messages, and descriptions are prose, ambiguous in ways code is not. Before writing it up, state the reading that makes
the author right and ask whether it is the more natural one; if the finding survives only under yours, it is a question
or it is nothing. A Dockerfile comment saying a pinned pip keeps "the resolver behaviour behind poetry the same on every
build" is false read as the resolved output, since only POETRY_VERSION is pinned and poetry's own dependencies resolve
fresh on every build, and true read as pip's own behaviour, since PyPI release files are immutable. The second reading
is the obvious one.

The label is the tell. A `suggestion` asserts you know why the code is the way it is, so one written off a guess about
the author's intent reads as condescension even when the guess is right. If you cannot state the reason without
guessing, ask.

**Overall review body.** The verbatim top-level summary that accompanies the status, also `Agent-generated:`-prefixed
and bracketed by rules like any other payload. Carries the verdict and anything cross-cutting, with no recap of the
individual inline findings. A finding in a file the PR does not touch has no line to anchor to and lands here instead.
That is the one case where the body carries a critique, and when it does the critique takes a Conventional Comment label
and decoration like any inline one; a body that only carries the verdict takes no label.

Nothing that came back clean belongs here, and the reason is tone, not economy. Publishing a confirmation that someone
else's work checks out reads as auditing a peer, which is not your place on their PR. This covers another reviewer's
findings as well as the author's code. Reporting that a peer's finding holds up is the same move as reporting that their
deploy looks fine: you graded someone else's work and published the grade. The asymmetry is worth keeping straight,
because the rebuttal does belong here -- acting on a wrong finding makes the code worse, so contradicting one is
load-bearing, while agreeing with a right one only tells a reviewer you agreed on a thread they already own.

So verify as hard as you like and keep the result to yourself: its job was to tell you what to raise, and it did that.
This holds when the check cost you something -- an author who staged a rollout knows the state of their own deploy. Most
bodies run a line or two. When the verdict is all that's left to say, say only that, and omit the section entirely if
you'd submit the status with no body at all.

**The carve-out is a fact that exists nowhere yet.** What the rule above protects against is grading a peer, and every
case it names has an owner who already holds the fact: the author's code, the author's rollout, another reviewer's
finding on their own thread. A measurement nobody has taken has no owner to grade. When the PR is gated on evidence and
the author says that evidence is still outstanding, a check you ran is the only copy of that fact, and sitting on it
just means someone runs it again. That goes in the body.

**Evidence in the body carries the command that produced it.** A reviewer asserting production state is unfalsifiable on
its own -- "the index is absent on every tenant" asks the reader to take your word for something the diff cannot show
them. Put the invocation next to the claim with the output you got, so it can be re-run instead of believed. Writing the
command out is also the last check on the claim: spelling out how a sweep enumerated its targets is what reveals the
targets it never enumerated.

Then in chat, led by the PR URL and title: the verdict, how many comments, anything that genuinely needs a decision, and
the plan path last, as the absolute path `echo` printed, on its own line. The link goes first because the user may not
have it -- a Slack or Linear review link resolves to the PR only through a lookup you did and he didn't.

**Humanize before you show it.** The user cannot mark up text he cannot read, so the draft he first sees has already
been through the `humanizer` skill. Before the chat message goes out, load `humanizer-report` and run its full process
on the review body and every comment payload, including the closing "what makes this obviously AI-generated?" audit and
the revision after it, then write the result into the plan file. Keeping the patterns in mind or recalling them from
memory does not count as running it. Put the assessment and the audit in the chat message, briefly, so the user can see
the pass happened instead of having to ask.

Chat is also where the **product impact** goes -- what the change reaches and where a human would want to look, since
the user reads it to orient their own review pass rather than to refine it. Name the surface area that moves (which
screens, endpoints, jobs, or consumers behave differently) and who feels it. When the change isn't user-visible at all,
say which kind of invisible it is (pure refactor, test-only, infra) in one line instead of padding it.

**"The diff can't show it" is not "I can't know it."** Rollout state, migration state, and per-tenant data state are all
directly checkable, so check before writing a caveat about one. Reserve the go-look-at-this note for what is still
unknown after checking. When an expired credential blocks the check, start the re-login yourself where you can and let
the user finish any interactive step; ask him to refresh it only when you cannot start it. Either way, don't downgrade
the finding into a suggestion that the user run the check himself. Read a second repo at its remote ref rather than from
a clone on disk: `gh api repos/<org>/<repo>/contents/<path> --jq .content | base64 -d`. Only the review worktree gets
fetched, so any other clone can sit arbitrarily far behind `origin/main`, and a CLI built from one reports that
version's behavior instead of today's. Verifying can delete a finding outright, which is the cheapest outcome available.
Usually what the check produces is a decision about what to raise rather than prose for the review body; the exception
is a measurement that exists nowhere else, which is evidence and belongs in the body with the command that produced it.

**Open on the thing being changed, then on the change.** Before "what the PR does," give a paragraph on the service,
feature, or platform area it lives in, written for someone who doesn't work in that part of the codebase: what it's for
and what problem it solves, enough that the next paragraph lands. Then what the change does, in a sentence or two,
before what is wrong with it. A findings list assumes a reader who already knows what the PR is for, and on internal
tooling they often do not. Describing the change is not the same as describing the thing being changed, and naming which
kind of invisible an invisible change is covers neither: "infra, no user-visible surface" is a category, not an
explanation.

Beyond that, add what's worth saying and leave out what isn't -- a judgment call each time, not a set of sections to
fill in.

**Trim first and humanize last.** Compression produces exactly the patterns the humanizer strips: subjects dropped off
the front of sentences, gerunds standing in for verbs, the same cleft construction three times, verbs elided from lists.
So any edit after the humanizer pass needs another pass, and the humanized version runs a little longer than the trimmed
one, because putting subjects and verbs back costs words.

One tell survives both the long and the short draft instead of arriving with the trim: a noun in the subject slot of a
verb it cannot perform. "A key reads the False default" parses as active voice and still hides the actor, because the
key reads nothing -- something looks it up and gets the default back. Padding conceals these, so expect to find one
after the cut rather than because of it, and fix it by naming the thing that acts.

**Humanize the prose, not the format.** A comment's `<label> (decoration):` prefix (for example
`suggestion (non-blocking):`) is a required Conventional Comments convention, not an AI tell -- preserve it verbatim
through the humanizer pass even though patterns like inline-header lists and boldface would otherwise strip it. Run the
humanizer on the reasoning that follows the prefix; leave the label and decoration untouched.

**Keep the overall/verdict message distinct from the inline comments.** The review body should carry only what doesn't
belong on any single line: the verdict, scope, and cross-cutting observations. Do not recap or re-describe the inline
findings in it -- if a point is worth raising, it lives in its inline comment, not in both places. A reader should get
the specifics from the inline notes and the judgment from the summary, with no overlap.

**Don't write like an agent grading a human.** Drop self-narration of your own process
(`I checked each test against...`, `I traced...`, `I verified...`) and evaluator/approval language (`Nice work`,
`the pins are the ones I'd want`, `this is the right call`, `looks great`). State findings and conclusions as plain
facts about the code (`the pins match the pipeline`, `the migration sequence is consistent`), not as praise or as a
report on your effort. Nothing is exempt from this, including an approving remark that is specific and accurate.

**The subtler form is a clause whose grammatical job is to grade.** Politeness doesn't save it and neither does
accuracy. "The test still earns its keep, the reason above it doesn't" reads as judgy though nothing in it is rude and
both halves are true: ruling one thing worthy and another unworthy inside a balanced clause is a verdict on the author's
work, and the tidy parallel is what makes it land as a zinger. State the fact that supports the ask and let them draw
the rest -- "the uniqueness invariant still matters for the other consumers" carries the same recommendation with no
grade attached. Watch for grading the author's _prose_ as well as their code: "still spend a paragraph defending a split
that no longer buys anything" charges them with wasted effort where "each has one caller now" says the same thing.
Length and tone are separate sweeps and the length pass will not catch these.

**Prefix every comment.** Any comment, inline note, reply, or review body posted to the PR must begin with
`Agent-generated:` followed by a blank line, then the content. Include this prefix in the draft you show for
verification, not just at submit time.

**The review ends at the draft.** This skill does not change code and does not post. Once the plan file is written and
the chat summary is out, the turn ends; markup on the draft and anything that goes to the PR belong to whatever process
wraps the review.

### The worktree's end of life

Workspace lifetime is the host block's business, not the shared flow's: on Cursor the worktree stays in place -- the
user keeps it for re-reviews, posting comments later, or their own inspection, and a re-review refreshes it per step 2;
a weekly launchd job (`automation/review-cleanup/` in the `system` repo) reaps untouched ones after ~7 days. On OpenCode
the worktree and any throwaway clone are disposable and die with the session. Either way, do not remove anything
mid-review.
