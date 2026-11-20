---
name: review-ticket-jira
description: >-
  The Jira lens for review-ticket: load it alongside review-ticket when the ticket under review lives in Jira. Thin on
  purpose: it carries what review-ticket has said of Jira since 2026-11-19 and marks everything else not yet verified
  against a live Atlassian workspace rather than inventing detail. To review a ticket in another tracker, load that
  tracker's lens instead.
---

# The Jira lens

This lens modifies `review-ticket` for tickets that live in Jira. Where it speaks, it wins on its own subject matter -
the calls to make, the input forms Jira accepts, and how the review is delivered. Nothing in it has been verified
against a live Atlassian workspace; what it carries is what review-ticket's Inputs section has said of Jira since
2026-11-19, and the rest states the gap instead of inventing a tool surface.

- Inputs: a Jira link. Fetch the ticket with the Atlassian tools. (Carried from review-ticket, 2026-11-19; not
  re-verified.)
- Step 5's discussion read, step 7's re-pull before quoting, and step 9's delivery: not yet verified against a live
  Atlassian workspace. Read the tool surface at the moment of use, and write what worked back into this lens, so the
  next run starts from it.
