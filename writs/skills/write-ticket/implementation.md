# Implementation tickets

**Scope.** This covers implementation tickets: units of work that build a product feature, usually inside a project.
Spikes, investigations, and specialized task tickets are separate archetypes, not covered here.

**A ticket is a specification.** An engineer reads it to know what done means, and everything in it serves that.

**Size.** A small unit of work, a few hours to a couple of days, backed by a single user story or a few closely related
ones. Work that runs longer belongs to a project. The story's actor doesn't matter; customer, administrator, or
engineer, the ticket owes the same things either way.

**Done has to be verifiable.** State the outcome so someone can confirm or refute it. Showing it to a person works, so
does a test, a query, or a measurement. Any instrument will do as long as the outcome can actually be checked.

**Naming concrete things.** You usually can't write a verifiable outcome without naming the endpoint, the screen, the
field, or the flag involved, and naming them doesn't turn the ticket into a design document. The ticket says what will
be true. It doesn't normally say how to build it, but it can where the how matters: a constraint that can't be violated,
or an approach that's already been decided.

**Where the design lives depends on how big the work is.** For a small ticket, design happens inline while the work gets
done, and may never be published anywhere. For a large body of work, the design comes up front at the project level,
before tickets are broken out, and the tickets become the units that prove the design holds and that the requested
impact actually landed.

**Tickets are increments against goals.** Where the goal has something countable under it, the ticket reports its
reading. A goal of driving failed uploads to zero across a named set of file types is countable in more than one
direction: one ticket might cut the failure rate on the types already covered, while another takes coverage from 78% of
those types to 100%. Both are real increments against the same goal. A goal with nothing countable under it can't have
measurable increments beneath it, which constrains how goals get written rather than how tickets get written.

**The engineer receiving it is the backstop.** A ticket that doesn't say what done means is not license to build from
it, and it isn't something to swallow quietly either. Say what's missing, to whoever wrote it, and push for the next one
to land in better shape. Then fill the gap anyway: chase the requirement, write the verifiable outcome that got skipped,
and treat it as a specification once it actually is one. Take a bad hand-off quietly and the next one will be just as
bad.

**When the work invalidates the ticket's premises,** the next step is a conversation with the project's stakeholders and
your manager. What you learned means the request itself needs rethinking, and that isn't a call to make alone inside the
ticket.

## An example

Under a project goal of driving failed album uploads to zero, a ticket might read:

> ### Uploads finish for albums above two gigabytes
>
> As a photographer uploading a full shoot, I can upload an album over two gigabytes and actually have every photo land,
> so I can hand the gallery to a client the same day. Today the upload stalls partway and the album is left incomplete.
>
> **Done when** an upload of at least two gigabytes finishes with every photo present, and the photo count in the album
> matches the count the uploader sent.
>
> **Verified by** uploading the seeded four-gigabyte shoot on staging and diffing the two counts, then walking a
> finished gallery through with the two photographers who reported it.
>
> **Increment** on the project goal: takes large-album upload failures from every attempt to none. Small albums are
> unchanged; that's a different ticket.
>
> **Constraints:** small uploads keep working on the existing path, and the order photos appear in doesn't change, since
> clients link to galleries by position.
>
> Not in scope: resuming an upload that was interrupted.

The labels are mine, not a required form. What each one is doing comes from the rest of this document: the title is the
state of the world once it's done, the story says who cares, "done when" is the verifiable outcome, "verified by" names
an instrument, the increment ties it to a project goal with a number, and the constraints are the places where how it
gets built actually matters.
