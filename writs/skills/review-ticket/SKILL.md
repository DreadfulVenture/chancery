---
name: review-ticket
description: >-
  Review a ticket as a buildable spec before anyone writes the code: extract the claims it makes about the tree, verify
  each one against main, trace the blast radius of the code it touches, and land a single markup-able review in a plan
  file. Tracker-agnostic: load the lens skill for the tracker at hand alongside this skill (the Linear and Jira lenses
  are the ones written so far). Use when given a ticket URL or identifier and asked to review, evaluate, or sanity-check
  it, or when the user runs /review-ticket.
---

# Review ticket

To review a PR someone opened, use `review-pr`. To review your own work in the current checkout, use `review-work`.

A ticket is prose, so it is not evidence about itself. Every statement it makes about the code is a claim to check
against the tree, and the findings come out of that checking rather than out of reading the ticket carefully. Read it
first only to know what to go check.

## Inputs

A tracker URL or a bare identifier like `ABC-212`. The lens for the ticket's tracker states the fetch: which tool reads
the ticket, with which options, and what comes back with it.

## Workflow

```
- [ ] 0. Resolve the ticket and the repo to verify against
- [ ] 1. Read the ticket: claims, touch points, stated problem
- [ ] 2. Verify each claim against the code
- [ ] 3. Trace one hop out from every touch point
- [ ] 4. Test the problem statement, then the fit
- [ ] 5. Reconcile against the ticket's existing discussion
- [ ] 6. Filter down to findings the ticket causes
- [ ] 7. Write the review to a plan file; summarize in chat
- [ ] 8. Incorporate the markup, logging each correction to a side file
- [ ] 9. Post on approval
- [ ] 10. Read the correction log back and decide where each lesson belongs
```

### 0. Resolve the ticket and the repo

The repo is not in the ticket. A project name in the ticket usually implies the repo. A PR attachment, on the rare
ticket that has one, names the repo outright. Ask if neither settles it.

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

Use the PR attachment to identify the repo, not to read the branch; see step 5.

With the clone on a clean `main`, get into plan mode if the host lets you. Everything from here until the post is
reading code and writing markdown. On Cursor, switch modes; if the switch does not come back, carry on in agent mode and
write the file directly, since a timed-out switch is not a refusal and it reports itself as one. On a host where only
the user can switch, ask once and carry on in the current agent if they don't.

### 1. Read the ticket

Pull out three lists before touching code, so the code reading is directed rather than exploratory.

**Claims about the current tree.** Anything phrased as fact: "X only processes Y", "Z already merges labels on every
update", "no backfill needed". These are the cheapest findings available and they are frequently wrong.

**Touch points.** Files, functions, flags, scripts.

**The stated problem**, in the author's words, kept separate from the proposed fix.

### 2. Verify each claim

Read the named code. Every claim comes back verified, refuted, or unverifiable from the tree, that last one meaning it
needs cluster state, a rollout order, or a config value you cannot see. Say which. Never upgrade unverifiable to
verified because it sounds right.

Refuted claims are usually the strongest findings, because the rest of the plan is built on them.

### 3. Trace one hop out from every touch point

For each file or function the ticket touches, ask who else reads it. Unscoped blast radius lives here:

- A shared helper with more callers than the ticket names.
- A struct whose serialization or hash feeds something else.
- A label map inherited by objects the ticket never mentions.
- A value crossing a validator, sanitizer, or selector on its way out.

State the reach as a fact about what changes, not as a warning.

### 4. Test the problem statement, then the fit

Read the problem statement as a claim in its own right, then be slow to raise anything about it. A synopsis that names
the common case and the mechanism for detecting it is ordinary ticket writing, not a definitional error, and the author
almost always holds a fuller model of the problem than the sentence they wrote down.

Run this test before raising anything: take the cases you believe the definition cannot classify and resolve each one
against the author's evident intent. If they resolve cleanly, there is no finding. What you have found is that the
proposed mechanism cannot distinguish those cases, which is a concrete comment about the mechanism and probably one you
already wrote.

Then the ordinary fit checks. The solution covers less than the problem claims, or the approach carries work the problem
never asked for. Both are far cheaper to fix in a ticket than in a PR.

Also ask whether the ticket is buildable at all: are the touch points accurate, are tests specified, is there an
acceptance criterion, does the out-of-scope section contradict the approach.

### 5. Reconcile against the ticket's existing discussion

Read the ticket's comments. A point already raised there stays out of your review, though if your own trace says it
matters, say so once rather than dropping it silently.

If a branch or draft PR already exists, it is neither evidence nor subject matter. Nobody asked you to review it, and a
finding is not weakened by the implementer having already worked around it, because the ticket is what the next person
reads. Findings cite `main`.

### 6. Filter down to findings the ticket causes

By now you have more candidates than belong in the review. The instinct this step exists to catch is treating a ticket
as a specification that owes completeness, when it is a description of work someone is about to do. Each rule below is
one costume that instinct wears. The worked examples come from ABC-212, a ticket adding Kubernetes labels so
unreconciled namespaces could be found.

**Only findings the ticket causes.** Two questions: would this be true if the ticket shipped exactly as written, and is
it true _because_ of what the ticket does? A bug already living next to the code being changed fails the second
question, so it is not a finding against this ticket. Read the out-of-scope section first, since it often answers these
outright.

Proposing a separate ticket to track one is fair game when the reasoning is strong, which most candidates are not: the
defect has to be verified rather than inferred, carry real consequence, and be too large to fold in rather than merely
inconvenient. Thematic relation to the work is not reasoning, and a closing line arguing the bug is related is the tell
that reasoning is what you are short of.

Both ABC-212 candidates missed. Its problem statement said an orphaned namespace leaves its database, pods, and secrets
running; read as a coverage list that looks like a gap, but it describes harm, and finding the namespace is enough
because the delete path handles the rest. There was no defect there to track. Separately, a cleanup command skipped some
namespaces on a parse failure, which was verified and real but cost a few undeleted dev namespaces.

A pre-existing bug does survive the filter when the ticket makes it newly consequential. The same ticket shipped a label
whose value a common command clobbers, which puts a wrong answer somewhere people are meant to query.

**Groundwork does not owe you a consumer.** Some tickets exist to put data in place before anyone knows what will read
it. Reviewing one as though the consumer were missing generates a question per unused field. Three separate ABC-212
findings, asking what consumed the new command's output, what one label was for, and noting that another label never
participated in the mechanism, had one answer between them: the labels are metadata staged so the team can see the
existing situation first.

What survives is anything making the staged data wrong. Data nobody reads yet still has to be true by the time somebody
does.

**A touch-point list is a pointer, not a contract.** It orients whoever picks the ticket up. Do not audit it for
completeness or count call sites against it. Where code should live is fair game, because that outlives the ticket;
whether the list enumerated everything is not.

**Review, do not redesign.** The strongest pull on a ticket review is writing the ticket you would have written.
Findings point at what is wrong or missing. They do not hand over an alternative plan.

Naming the condition a ticket is actually detecting is not redesign, and where it genuinely differs from what the ticket
says, state it flatly rather than offering it as one reading among several. Step 4's test comes first, though: most of
the time it does not differ.

Redesign starts after that line, at the labels and their values, the flag surface, the command's shape, the sequencing.
The pull is strongest right after someone hands you a better model of the problem, because building on it feels like
agreement.

**Hold your own prose to step 2.** Claims get verified, refuted, or marked unverifiable, and that applies to the
sentences you write as much as the ones you read. A finding padded with an unchecked rationale hands the author the
rationale to argue with, and the finding goes down with it.

Consequences are claims too, and inflated stakes are the easiest kind to get wrong. Three checks: the worst case has to
follow from the scenario you described, the failure has to be silent rather than loud, and the worst case has to be
worse than normal operation. One ABC-212 finding claimed a forgotten config file would get a customer's database
deleted, when the namespaces in a newly added file are new and hold no data, and a report suddenly listing all of them
is about as loud as a failure gets. Another flagged a config hash change restarting every pod in the fleet, which is
exactly what a normal deploy does.

A tell for the third check: when you find yourself conceding the normal case in an aside, the aside is the finding's
answer.

### 7. Write the review to a plan file

The review is a document to mark up, not a chat message. Write it to the directory the host reads plans from.

```bash
# Cursor
echo "$HOME/.cursor/plans/<ident>-ticket-review-$(openssl rand -hex 4).plan.md"
# OpenCode
echo "$HOME/.opencode/plan/<ident>-ticket-review-$(openssl rand -hex 4).md"
```

```yaml
---
name: <IDENT> ticket review
overview: "Review of <IDENT> (<title>), <N> findings. Nothing posted yet."
todos:
  - id: mark-up
    content: Apply markup on the review; re-humanize any text that moves
    status: pending
  - id: post
    content: After explicit go-ahead on the verbatim text, post the review
    status: pending
isProject: false
---
```

The file holds the comment payload and nothing else. Everything written for the user's own understanding goes in chat.
Nothing about how the review went goes here; that has its own file, see step 10.

**One comment, not many.** A tracker's discussion lives as comments beside the ticket, not inline on the description, so
there is no line number to anchor to: the whole review is a single payload in a single fenced block. Anchor each finding
by quoting the author's wording verbatim under a header naming the section it sits in, so the reader can tell what is
being objected to without a line number. Re-fetch the description before writing those quotes rather than reconstructing
them from memory - the lens states the re-pull - because a misquote reads as a misunderstanding of the spec. Lead with
the findings that would change the design.

**No verdict.** This is feedback on a ticket, not a gate. There is nothing to approve and nothing to reject, and
borrowing `APPROVE` or `REQUEST CHANGES` from a PR review imports a ceremony the tracker does not have. Open with what
the review found, foregrounding anything that would change how the work gets built, and let the ordering carry the rest.
The author decides what to do about it.

**No Conventional Comments labels.** They exist to give a one-line verdict to each of fifty inline diff comments. A
ticket review is one piece of prose with a handful of findings, and `**issue (non-blocking):**` in front of each is
scaffolding around a sentence that already says what it means. Lead each section with the finding as a plain sentence.

**Length: a claim, its evidence, and its consequence.** Anything past those three is restatement. The tells are a
closing sentence repeating the opening in weaker words, an aside softening a point immediately after making it, and
offering two ways to say the same objection.

Name the function and file rather than narrating what the code does; the author can open the file. A worked example
earns its length only where the consequence is not obvious from the fact.

**Attach a testing concern to the defect it catches.** "This needs a test" is weak standing alone and tends to inflate
into an architecture opinion about where code should live. Named next to a concrete bug it would have caught, it costs
one sentence.

**The body carries nothing the findings already carry, and nothing about how to read them.** Do not recap the findings;
the reader has them. Do not sequence the author's work for them with lines like "the piece I would settle first" or
"worth settling before the labels are chosen." State what is true about the ticket. Priority is the author's.

**Humanize before writing.** Actually invoke the `humanizer` skill, read `/humanizer`, and run its full process on the
payload including the closing "what makes this obviously AI-generated?" audit and the revision after it. Recalling the
patterns does not count. The prose that lands in the file is the humanized version.

**Prefix the payload.** `Agent-generated:`, a blank line, then the content. Include it in the draft shown for
confirmation, not just at post time.

Then in chat: how many findings, anything that genuinely needs a decision, and the plan path last, as the absolute path
`echo` printed, on its own line.

### 8. Incorporate the markup

Highlight comments arrive as follow-up chat messages, not as edits inside the file. Don't reply in chat and leave the
file stale: the plan is the single source of truth, so edit it in place for every note that lands. Revised text goes
back through the humanizer and needs confirming again.

Do not edit the ticket, change its status, create sub-issues, or post anything here.

**A question is not a correction.** When the user asks how much a finding really matters, answer the question rather
than quietly softening it. What a finding is worth changes when a fact about the code changes, not when the same fact
gets queried again. A finding that moves every time it is questioned tells the user nothing.

**Log every correction as it lands**, to the side file described in step 10. The writing down is not the part to batch.

A correction is any response meaning the review should have come out differently: a finding cut or reworded, a format
change, a redirect on this skill's own mechanics, or a fact about the project that would have changed what you wrote.
Tone objections count. So do the terse ones, since "too wordy" and "overly critical" are corrections with the reasoning
left implicit and inferring it is your job.

Some questions are corrections too. The test is whether answering changes the artifact: "did the draft PR already fix
these?" wants information, while "is anyone arguing it is the same?" wants a section gone.

### 9. Post on approval

Post the review where the ask landed, as the tracker's comment on the ticket. A review is a document, and on a ticket
the document's home is the ticket's discussion; the lens carries the proven mechanics and the known traps for its
tracker. Confirm the verbatim text, then post what the fenced block contains, byte for byte. On Cursor, leave plan mode
first; elsewhere, ask the user to switch out of it if posting is blocked. Writing the plan file is not a request to
review it, and approving the plan is not approval to send. Nothing about the review process comes up before this.

### 10. Capture what the corrections taught

Corrections from step 8 are the best available evidence about how this skill is wrong, and they are worthless unless
written down. This step is why the filters in step 6 exist.

Raise it only after posting. While the review is live the user is deciding what goes out, and notes about how the review
went compete with that.

**Keep the log outside your context and outside the plan file.** Append each correction to
`/tmp/review-ticket-<ident>-corrections.md` the moment it arrives, one entry apiece: the user's own words, what you had
written, and a provisional read of the principle. A review long enough to be worth doing runs past a compaction
boundary, and the corrections that get summarized away are the early ones, which by then read as settled history rather
than as evidence. Record the user's wording rather than your gloss on it, because your read of why they objected is the
part most likely to be wrong, and the gloss is what a summary keeps.

**Analyze only once the review is posted.** A correction can be reversed by a later one, and several often turn out to
be a single mistake. Three of ABC-212's cuts looked like three problems and were one; a rule written after the first
would have been three shallow rules instead of the real one, and one written mid-session about that ticket's synopsis
would have been deleted a turn later.

Sort each correction into one of four destinations:

- **A rule for this skill**, if it would hold for a different ticket in a different repo.
- **A fact about the project**, stored with `memory_remember` scoped to the repo so the next review recalls it. "We do
  not manually reconcile, the next reconcile always follows a version bump" is true of one codebase and useless anywhere
  else. Two ABC-212 findings died to facts of exactly that shape.
- **A durable preference about working with the user**, via `memory_remember`, then proposed to the user in chat and
  written to the floor with `persona_codify` once he answers. The bar there is high and most corrections do not clear
  it.
- **Nothing.** A one-off factual fix about this ticket teaches nothing.

Propose the edits in chat and apply them on approval. Do not silently rewrite the skill you are running.

**Fold before appending.** Ask whether an existing rule already names the same instinct and extend that one if so. Step
6's out-of-scope rule and its pre-existing-bug rule were the same rule in different clothes, and merging them produced
something sharper than either. A skill gaining a bullet per correction is unreadable after three tickets.

**One worked example per rule.** Examples are what make these actionable, so keep the most vivid and swap rather than
append when a better one arrives. Rules get more general as evidence accumulates, not longer.

## Lenses

The workflow is tracker-agnostic: it speaks of the ticket, its claims, its touch points, and its discussion, and never
names a product. The tracker-specific instructions live in lens skills - one skill per tracker, loaded by its ID through
the skill tool:

- `review-ticket-linear` - the ticket lives in Linear.
- `review-ticket-jira` - the ticket lives in Jira.

Load the lens for the tracker at hand alongside this skill, and run the workflow with the lens's deltas applied. Where a
lens and this workflow disagree, the lens wins on its own subject matter: the calls to make, the input forms the tracker
accepts, and how the review is delivered there. A tracker with no lens yet runs the workflow plain, naming its own tools
as you go - write the lens down afterward, so the next run starts from it.
