---
name: check-linear-queue
description:
  "Instructions for checking a Linear project's queue, use to select new work to get done when the operator uses Linear"
---

# Check Linear queue

## The three tiers

Tickets should be worked in the following order:

1. started: If any work in started is stalled and not waiting on operator action, these should be checked on and resumed
   if needed.
2. unstarted: Unstarted tickets have been queued for next steps purposely, this is the next bucket to get working on.
3. backlog: If all tickets in started/unstarted are complete or stalled on operator action, you should start pulling
   backlog tickets.

## Filter each call to the tier's state type

Every `list_issues` call carries the `state` filter set to the tier being queried: `started` for tier 1, `unstarted` for
tier 2, `backlog` for tier 3. Without the filter the call returns tickets in every state, completed and canceled
included.

Completed and canceled tickets are never part of queue selection. If a result contains either type, the state filter was
not applied: fix the call, do not filter the result in your head. Looking up a completed or canceled ticket is fine when
the operator asks about its state; that is never a way to select work.

## Run each tier through the shared setup

Every tier runs the same pipeline:

- **Paginate.** `list_issues` returns one page. Loop with the cursor until the result set is exhausted before reporting
  anything. The result set is limited by default, you may request more in a single page, or paginate with the cursor if
  necessary. Do not immediately trust that your resultset is the complete list of all tickets.
- **Filter to not-assigned-to-the-operator.** Keep unassigned tickets and tickets assigned to the calling agent; drop
  everything the operator (or any other human) is assigned. Resolve the calling agent's identity with Linear's
  whoami/viewer call when needed.
- **Sort.** Priority in urgency order — Linear's numbers run backwards for this: Urgent is 1 and Low is 4. The order is
  1, 2, 3, 4, then no-priority (0) last. Never a naive numeric descending sort — it buries the urgent tickets. Ties
  break by `createdAt` ascending, oldest first.

## The pick rule

Pick from the highest tier that has work, flowing over to the next tier. You should aim to run 3 to 5 tickets in
parallel when possible.

## Never invent or truncate identifiers

Every identifier comes from tool output.
