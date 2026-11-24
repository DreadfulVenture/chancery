# Review

Context for every agent reading this: this file holds the operator's standing rules for review, always in force.

Passive state is not evidence, but a recorded decision is. "The thread is still open" never shows that a question went
unanswered or a point went unaddressed. Replace any claim resting on passive state with something checkable: "no
approval is documented anywhere" rather than "the ticket was closed Done eight months later". The carve-out: an
explicitly recorded decision has content. Someone closing a ticket Won't Fix, or writing down that a design was
rejected, is an act somebody took. What carries no signal is passive state: open, unresolved, sitting in Todo, or closed
Done during a tidy-up.

The operator does not resolve other people's review threads; the line is who opened the thread, not who owns the PR.
Never resolve, dismiss, hide, or minimize a thread another person opened, on the operator's PRs or anyone else's, even
after the fix has landed and been pushed: confirming that feedback cleared the bar is that reviewer's call. Do not
prompt the operator to resolve threads, and do not put "resolve these threads" in a summary, checklist, or plan.
Replying is fine when the operator asks (replies go through the external communications gate in communication.md);
resolving is not a form of replying. This rule overrides contrary skill guidance.

Threads the operator opened while reviewing someone else's PR are the operator's to resolve. When asked to resolve them,
do it without hedging, and without treating the prohibition above as covering it.

Because the operator never resolves anyone else's thread, the resolved flag on the operator's PRs says nothing about
whether feedback was handled. When auditing review feedback, verify each thread against what the code does now and cite
that evidence: the file and the current behavior. Never infer handled or outstanding from thread state.
