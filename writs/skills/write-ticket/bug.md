# Bug tickets

**Scope.** This covers bug tickets: reports of a defect. You write one once the bug's facts are in hand and before
anyone designs the repair, and its job is to keep those facts in one place.

**You state the defect twice, observed and expected.** Say what the bug did and what should have happened instead, in
words a reader who never saw it recognizes the next time it happens. Ground the expected half in something real: usually
behavior another path already has, or what the spec and the docs claim. How it feels to you is not a source.

**Date the observations and keep what you already have.** For each observation, say when it happened and what you saw it
on, and name what you still have from it: an export, a log, the reproduction notes. You don't hunt down the exact log
line. You put the timing in now because outputs scroll off and reproductions go stale. A reader with nothing attached
has only your word.

**The suspect surface is a guess you're allowed to write.** You name where the defect plausibly lives, and that gives
whoever picks the ticket up a place to start the search: "the reply pane and the path behind it" is a surface; "the
reply pane should debounce its refresh" is a fix.

**Severity and blast radius state what you already know.** Say who hit the bug, what it cost them, and how far it
plausibly reaches, but only as far as the evidence covers. If the reach or the frequency isn't known, write unknown and
stop; you don't go digging through logs for numbers the sightings never showed.

**The report must not prescribe the fix, pre-decide a design, or name a commit or PR.** If you write the repair in,
whoever picks the fix up has to argue through the ticket's own words to get past it.

## An example

A bug ticket might read:

> ### Drafting a reply in the inbox can lose the text already typed
>
> **Observed:** on 2026-11-10, a draft written in the inbox's reply pane vanished when a new message arrived and the
> pane refreshed mid-sentence. Typed text was gone, and nothing offered to restore it. **Expected:** the draft survives
> the refresh the way it survives a tab switch today, where the pane restores it from its own store.
>
> **Evidence:** I reproduced it twice on 2026-11-10 against the staging build of 2026-11-09, with steps in the
> reproduction notes. The session export from the first sighting on 2026-11-09 shows the same order of events: message
> arrives mid-typing, the pane refreshes, the draft is gone. No production sighting confirmed yet.
>
> **Suspect surface:** the reply pane's refresh path, where the incoming-message event meets whatever holds the
> in-progress draft. The reporter saw nothing outside that path misbehave.
>
> **Severity and blast radius:** hits anyone drafting while a message lands, and since the pane refreshes on arrival,
> that's the normal case rather than an edge case. Cost is retyping, and a lost draft is usually lost for good.
>
> Not in scope: the repair.

The labels are mine, not a required form. What each one is doing comes from the rest of this document: the title is the
defect, "observed" and "expected" state it twice, the evidence carries its timing and what you held onto, the suspect
surface gives the search its starting point, and severity reports the cost. The example shows a bug whose facts are
already gathered; a report written while reproduction is still under way keeps the same shape and says which parts are
so far unconfirmed.
