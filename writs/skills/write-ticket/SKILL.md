---
name: write-ticket
description: >-
  Write a ticket: settle where it is going, follow the destination team's own issue template when it has one, and
  otherwise write it as an implementation, investigation, bug, or feature request ticket against the guidelines shipped
  beside this file. Use when asked to write, draft, or file a ticket, issue, story, or spike, or when the user runs
  /write-ticket. To review a ticket someone already wrote, use `review-ticket` instead.
---

# Write ticket

A ticket is read by whoever picks the work up, so the shape it has to take comes from where it is going, not from this
skill. A Linear team with an issue template has already decided what its tickets look like. Only when nothing at the
destination decides it do the archetype guidelines beside this file apply.

Filing is not a mode problem. A ticket is a document on the tracker, not a system or configuration change, so the
workflow runs in whatever mode the session is in: a plan-mode session writes and files the ticket itself rather than
refusing or asking for a build-agent switch.

Four files ship here, each the full guidance for one archetype:

| File                 | Archetype                               |
| -------------------- | --------------------------------------- |
| `implementation.md`  | units of work with a verifiable outcome |
| `investigation.md`   | answer a question before anyone builds  |
| `bug.md`             | a defect's facts, not a fix             |
| `feature-request.md` | a want, not yet a decision              |

## Workflow

```
- [ ] 0. Settle the destination, and the team if it is Linear
- [ ] 1. Look up the destination's templates
- [ ] 2. With a template: fill its sections
- [ ] 3. Without one: pick the archetype and read its file
- [ ] 4. Draft
- [ ] 5. Humanize and judge
- [ ] 6. File it
```

### 0. Settle the destination

Where the ticket is being filed, and for Linear which team, decides everything after this. Neither is guessable from the
work itself: the same piece of work filed on two teams gets two different shapes. Ask when the request and the project
do not settle it.

### 1. Look up the destination's templates

For Linear, list what the team has and read the candidate:

```
list_templates(type: "issue", team: "<team>")
get_template(id: "<id or name>")
```

That listing returns the team's own templates plus any workspace-level ones.

Look them up every time. Never carry a template name in from a previous session or from this file, because the set
changes and a name that no longer resolves sends the whole ticket down the archetype path without anything looking
wrong.

**A `[draft]` prefix does not disqualify a template.** It marks a name nobody has gotten around to changing, not a
template that is optional to follow. Renaming one is the team's call.

**A form template cannot be filled through the API.** `get_template` says as much: applying one creates the issue with
its form unanswered. Say so and stop rather than filing a blank form.

**Several issue templates on one team:** choose with the templates' own descriptions and instructions, which usually say
outright which is which. One team's default template sends work that has no proposed solution to their spike template by
name. Ask when that still leaves it open.

### 2. With a template: fill its sections

The template governs the ticket. Its sections, in its order, with its bracketed instructions replaced by content that
does what each bracket asks for. Do not add sections, drop ones that feel thin, or reorder them to suit the work. The
archetype files are not read on this path.

When a section asks for something the work does not have, that is a finding about the work, not a section to improvise.
A template demanding a proposed approach and saying the ticket is not ready without one means exactly that: report it
instead of inventing a solution to fill the heading.

### 3. Without one: pick the archetype and read its file

Only reachable when the destination is not Linear, or the team has no issue template.

The split is what is already settled when the ticket is written. Work that builds something toward a known outcome is
implementation; a question that has to be gone and found out first is an investigation; a defect report is a bug, whose
facts are established and whose fix is not; and a request for what the product doesn't do yet is a feature request,
whose want is stated and whose build nobody has committed to. Each file opens with its own scope paragraph, which is the
authority on the line between them.

Read the matching file in full before drafting. It carries the reasoning, not just a section list, and the section
labels in its example are explicitly not a required form.

Work fitting none of these archetypes has no guidance here. Say that rather than stretching one of them over it.

### 4. Draft

Nothing in this step comes from this file. On the template path the headings and their bracketed instructions are the
spec; on the archetype path the file just read is.

### 5. Humanize and judge

Filing an issue publishes under the user's name, so the text goes through the outbound process in full: draft, then
actually invoke `humanizer` and run its whole process on this exact text including the closing audit and the revision
after it, then compose the finished text as it will appear. Whether the ticket is worth filing at all is the agent's own
judgment, made on the composed text. The removed wait is not a license to file more — never file to fill a queue, and
never let the absence of the wait pull a marginal ticket out.

**Prefix the payload.** `Agent-generated:`, a blank line, then the content — the description is published text just like
a PR review body, and the prefix marks agent-written text wherever it posts, so a ticket filed from work the agent did
is marked the same way the review is. Run the humanizer on the content, not the prefix line: humanize, then prepend the
prefix, and compose the prefixed text as it will appear.

### 6. File it

Filing does not wait for approval: once the text is composed, filing proceeds on that judgment.

```
save_issue(team: "<team>", title: "<title>", description: "<the composed text>",
           template: "<the template, when one applied>")
```

Pass the template even though the description is written out, so its fields — state, priority, labels — still land. A
non-empty description replaces the template body rather than merging with it, which is why step 2 fills the sections in
rather than leaving them for the server.

Post the composed text byte for byte, and quote it verbatim in the transcript or status after filing so what went out
stays auditable. If anything about the text changes after the humanize pass, it goes back through the humanizer before
filing.
