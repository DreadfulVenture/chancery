---
name: incident-timeline
description: >-
  Write an incident timeline as a record of what we did and verified: reconstruct our own actions from the session
  transcript, re-verify every number inherited from a subagent or a colleague, file each fact at the point it was used,
  and audit for the four fabrication modes before handing it over. Use when asked for an incident timeline, a response
  record, or a writeup of what happened during an outage, or when the user runs /incident-timeline. The retro, the
  root-cause analysis, and the follow-up actions belong to the incident commander; this skill deliberately does not
  produce them.
---

# Incident timeline

A timeline is the responder's record: what we did, when, and what each action returned. The incident commander writes
the retro. Anything that reads like analysis is theirs, and handing it to them anyway buries the thing that was asked
for.

Pair with `humanizer` for the final prose pass, and with `obsidian-vault-structure` when filing the result if that skill
is loaded. This skill writes a document; it posts nothing.

## The one rule

**Log only what we ourselves did or verified.**

Then the corollary that does the real work: absence from the document means we did not check it. Say that out loud in
the scope line, because a reader who does not know it will read every gap as a finding.

## Workflow

```
- [ ] 0. Establish the boundary: whose record, which reader, who owns the retro
- [ ] 1. Reconstruct our actions from the session transcript
- [ ] 2. Re-verify every inherited number
- [ ] 3. Draft entries at their point of use
- [ ] 4. Audit for the four fabrication modes
- [ ] 5. Write the commands appendix
- [ ] 6. Retro-drift check
- [ ] 7. Style pass, then humanizer
- [ ] 8. File it
```

### 0. Establish the boundary

Settle three things before writing a line. Whose actions the document covers, usually ours and not the whole response.
Who reads it, usually the IC. And that the retro is someone else's, so analysis is out of scope.

Our record starts when we picked the incident up. Everything before that is in the logs, Slack history, and ticket
activity the reader already holds, and reproducing it pads the document without adding anything only we could
contribute.

### 1. Reconstruct our actions from the session transcript

Do not write this from memory. Memory smooths the sequence, drops the dead ends, and invents tidy decisions. Read the
transcript. Where it lives and what it looks like depends on the host.

**On Cursor**, it is one JSON object per line, with `role` and `message.content`:

```
~/.cursor/projects/<workspace-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
```

Timestamps are embedded in user messages as `<timestamp>` tags rather than sitting in a field, so extract them and carry
the last-seen value forward across assistant turns:

```python
import json, re
rows = []
with open(path) as f:
    for line in f:
        d = json.loads(line)
        c = d.get("message", {}).get("content")
        if isinstance(c, list):
            c = " ".join(x.get("text", "") for x in c
                         if isinstance(x, dict) and x.get("type") == "text")
        ts = re.search(r"<timestamp>(.*?)</timestamp>", c or "")
        rows.append((ts.group(1) if ts else "", d.get("role"), " ".join((c or "").split())))
```

**On OpenCode**, `opencode session list` gives the session id and `opencode session export <id>` prints the transcript
as one JSON document: `{"info": ..., "messages": [...]}`. Every message carries `time.created` in epoch milliseconds, so
the timestamps are real rather than scraped out of the text. A user message holds `text`; an assistant message holds
`content`, a list whose entries are `text`, `reasoning`, or `tool`:

```python
import json, datetime
d = json.load(open(path))
rows = []
for m in d["messages"]:
    when = datetime.datetime.fromtimestamp(m["time"]["created"] / 1000,
                                           datetime.timezone.utc)
    if m["type"] == "user":
        rows.append((when, "user", m.get("text", "")))
    elif m["type"] == "assistant":
        for part in m.get("content", []):
            if part["type"] == "text":
                rows.append((when, "assistant", part["text"]))
            elif part["type"] == "tool":
                rows.append((when, part["name"], json.dumps(part["state"].get("input"))))
```

A `tool` entry also carries `state.content`, which is what the tool returned. That is the one place a command and its
output sit together, so it is worth reading for step 5.

Convert to the timeline's timezone once, at the end. Do not mix.

### 2. Re-verify every inherited number

Anything reported by a subagent, a colleague, or an earlier version of you is a lead, not a fact. Re-run the query
before it goes in the document. The cost of the error is highest exactly when the number is load-bearing for a
conclusion, which is also when it is most tempting to accept.

Two failures from the incident this skill came out of, both inherited and both wrong: a reported collapse of database
connection counts to zero that held flat on re-query, and a single-moment onset that was actually staggered across
fifteen minutes.

Probe hygiene, learned the hard way. Any script that reaches out to named infrastructure must derive its addresses from
the API in the same script. Never hardcode them from recall. A connection failure against a host you invented is
indistinguishable from an outage, so a hardcoded endpoint list is a silent false-positive generator.

If you cannot verify something, cut it or state plainly that it was asserted and not checked. Do not launder it into the
record with hedging.

### 3. Draft entries at their point of use

Attach a fact to the timestamp where it was **used**, not where it was derived or merely observed. Information that
never drove a decision is raw data and belongs to whoever owns the source.

This has a useful side effect. If a finding feels too important to omit but has no point of use, that usually means an
action is missing from the timeline. On one incident timeline the assessment that cleared our own changes was absent
entirely, and only the point-of-use question surfaced it.

Where a conclusion rested on several inputs, name them and say which have since been verified. That makes visible when a
correct call was reached on partly wrong evidence, which is exactly what the reader needs and what a bare derivation log
hides.

### 4. Audit for the four fabrication modes

Run all four against the draft. Each one produced a real error in the incident that generated this skill.

**Unverified absence.** Recording that something did not happen, having checked one place. "No alert fires" was written
after listing one alerting system out of three; the alerts had in fact fired into Slack seventeen minutes before the
customer report. This is worse than an omission, because it reads as a checked finding and sends the reader down a false
path. _Check:_ every negative claim either names the system queried or comes out.

**Backfilled discovery.** Slotting something learned hours later into the timestamp where it would have been useful,
which misrepresents what was known when. _Check:_ for each entry, ask whether we knew it at that time. If not, it
belongs in a later verification pass or nowhere.

**Fabricated decision.** Recording a decision against an action nobody proposed. "Stopped considering a revert" survived
several drafts before a transcript grep showed every mention of a revert was mine. This shape is the sneakiest because
it reads as diligence. _Check:_ before any "decided not to X" or "ruled out X", grep the record for who actually
proposed X.

**Passive voice hiding the actor.** "gcloud reauthenticated" erases who did it. "Figures that had been asserted" erases
who asserted them. In a document about who did what, this is a correctness bug and not a style preference. _Check:_
`rg -n '\b(was|were|has been|had been) \w+(ed|n)\b'` over the draft. The grep yields candidates, not verdicts: a passive
with no human actor behind it ("onset was staggered across fifteen minutes") is fine, since nobody staggered it. Give a
subject to every hit where a person or a tool did the thing.

### 5. Write the commands appendix

Every finding gets the command that produced it, and each command gets run once to confirm it works before it goes in.
The appendix is what lets the reader re-derive a number instead of trusting it, which matters more than usual given
step 2.

Carry forward any query traps found along the way. Two from Cloud Logging worth keeping: ordering descending with a
per-namespace filter returned identical timestamps across different namespaces and cannot be trusted, and ascending
results are page-capped so the last row returned is an artifact of paging rather than a recovery time.

### 6. Retro-drift check

These sections must not appear. Each one crept back in at least once:

- Impact
- Mechanism, or any root-cause narrative
- Onset or pattern analysis
- Findings, or "what we verified"
- Lessons, recommendations, follow-ups
- A conclusion-first summary paragraph

The shape is a title, a couple of sentences of framing with the ticket link, the scope statement from the rule above,
the chronological entries, and the appendix. Beyond those, if a paragraph is not an event with a time attached, it does
not belong.

### 7. Style pass, then humanizer

- Times in one zone, stated once. No time-of-day words with UTC timestamps, because nobody lives in UTC and 16:18 UTC is
  lunchtime somewhere real. Same for "today" and "yesterday" in a document read after the fact.
- No defensive clauses. After a correction, the fix belongs in the text and the justification does not. The test: would
  this sentence exist if nobody had objected? If not, cut it.
- Keep genuine verification caveats. "We did not re-check that finding ourselves" and "we did not narrow it further" are
  information, not self-defense.

Then run `humanizer` over the prose. Leave the entry list, tables, and section structure alone; parallel structure is
what makes a log scannable.

### 8. File it

Default location is `References/` in the vault, named `<TICKET> Incident Timeline.md`. Where `obsidian-vault-structure`
is loaded, follow it for anything else; otherwise ask the user where the document belongs.

## Guardrails

- **Writes only.** This skill produces a document. It posts nothing to Jira, Slack, or Confluence, and it does not
  commit.
- **If it is going out**, it goes through the standing external communications gate: draft, run `humanizer` on the exact
  text, prepend `Agent-generated:` as the first line, then get explicit approval and post unchanged.
- **Do not supply the retro** even when asked to be helpful. Point at the boundary instead; the IC's analysis is better
  for not being pre-empted.
- **Related but out of scope:** how to _run_ an incident (testing reachability from outside the provider network,
  enumerating every alerting system before concluding coverage, preferring health-check logs over connection metrics).
  That is a separate skill about investigation, not about writing the record.
