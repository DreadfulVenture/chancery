# Investigation tickets

**Scope.** An investigation exists because a question can't be answered from what's already known. If someone already
understands the thing and just needs to write it down, that's ordinary work. An investigation is when you have to go
find out first. The line is whether the answer was known when the ticket was written.

**The ticket has one question.** Stated as a question, and the title can be it. What's waiting on the answer belongs on
the ticket too; if nothing is waiting, that's a prioritization question. If nobody can state the question, the ticket
isn't ready to be worked.

**The question has to be answerable.** The test is that you can say now what form the answer takes: a cause, a count, a
chosen option, a set of options with what each would cost, a number, or an explanation of how something works.

**Two things can come out of an investigation.** Information the team didn't have, or an enumeration of concrete work
filed as tickets, and sometimes both. Either way it's the same kind of ticket.

- **Information:** usually it feeds a decision, and sometimes it's just how something works, which is enough on its own.
  Whether something works here is information rather than a choice. A no takes the candidate off the table for good. A
  yes is weaker: it only makes the candidate eligible for a decision nobody has made yet. Where the evidence is
  something you ran rather than something you argued, the thing that ran gets thrown away. A trial is not the start of
  the implementation.
- **Enumeration:** nobody knows the size until someone measures. A goal stated as a proportion needs a denominator, and
  counting is how you get one. Filing the tickets is where it stops. The investigation doesn't set priority, assign a
  milestone, or declare anything next, because prioritization is the decision the count exists to inform. Whether it's a
  slow bleed or a cliff is information, so report that too. What counts and what doesn't gets written down, including
  how the edge cases fall.

**The default decision is to do nothing.** Change has to be argued for. Being the default doesn't make it free, so every
finding says what leaving things alone costs, including the findings that conclude we should. Making the case to the
team happens inside this ticket. If the team isn't persuaded, the default holds and the ticket still did its job.

**The ticket is the record.** It gets closed with the finding written in it, not just moved to Done. An empty close is
the same as no trace, and that's how a question gets picked up fresh three times. A finding of leave-it-alone still
closes Done rather than Canceled, since answering the question was the job. A project description, a design document, or
an architecture decision record only gets touched when the decision constrains work beyond this ticket.

**The engineer is the backstop.** A ticket that arrives without its question is on whoever picks it up to finish before
starting.

## Examples

A direction question might read:

> ### Is a GitOps controller a better direction than growing opsctl's reconcile loop?
>
> opsctl reconciles Kubernetes objects when someone runs `opsctl ensure`, from manifests templated in Go. Argo CD and
> Flux ship that as a product: reconcile when declared state changes, prune what isn't declared, track ownership by
> label. A change that just landed is what makes the question live now: it adds ownership labels and a `drift`
> subcommand comparing live namespaces against declared manifests, which is most of a controller's pitch. Whether that
> work is redundant or exactly right depends on the answer.
>
> **Answer** is one of the two directions, with the line between what a controller would own and what stays in the CLI,
> and what moving each piece across that line costs. What it costs to keep growing the reconcile loop belongs there too.
> If a controller wins, making that case to the team is part of this.
>
> **Scope** is the Kubernetes-shaped half. opsctl also provisions managed databases, secret config, queue topics,
> encryption keys, and pre-upgrade snapshots, and no controller touches any of that.
>
> Not in scope: adopting anything. Nothing changes because this closed.

And a count might read:

> ### How many settings screens write to the database directly instead of going through the settings API?
>
> Some of them bypass the API and nobody knows how many. Until there's a number, moving the screens onto the API can't
> be stated as a goal or weighed against anything else.
>
> **Answer** is the count, plus the offenders filed as tickets grouped however they turn out to cluster, and what the
> bypasses cost while they stay.
>
> **Scope** is the settings screens in the customer-facing app, not the internal admin console. A screen that writes
> through a thin helper still counts as writing directly.
>
> Not in scope: which gaps matter most, or when any of them get worked.

The labels are mine, not a required form. What each one is doing comes from the rest of this document: the title is the
question, the paragraph under it says what's waiting on the answer, "answer" says what form the answer will take, and
"scope" says what's in and what's out. Neither example shows the case where the answer invalidates the work that
prompted the question. When that happens, the finding has to reach whoever is doing that work before this ticket closes.
