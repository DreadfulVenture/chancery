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

## Note

Filter out canceled and completed for selecting work by using the states above. You may use these states check the
status of completed/canceled tickets if needed, but these are not relevant to selecting your next task.

## Never invent or truncate identifiers

Every identifier comes from tool output.
