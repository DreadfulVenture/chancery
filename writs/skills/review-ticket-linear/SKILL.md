---
name: review-ticket-linear
description: >-
  The Linear lens for review-ticket: load it alongside review-ticket when the ticket under review lives in Linear.
  Carries the verified tool surface (as of 2026-11-20), the input forms the tracker accepts, and the review-delivery
  mechanics with their known traps. To review a ticket in another tracker, load that tracker's lens instead.
---

# The Linear lens

This lens modifies `review-ticket` for tickets that live in Linear. Where it speaks, it wins on its own subject matter -
the calls to make, the input forms Linear accepts, and how the review is delivered. Verified against the live MCP
`linear` namespace on 2026-11-20. Linear calls tickets "issues" and their discussion "comments".

- Inputs: a bare identifier like `ABC-212`, or a Linear URL. The URL is for you, not for the tool: `get_issue` keys on
  the identifier and errors on the full URL ("Could not find referenced Issue"), so extract the identifier from the link
  before anything else.
- Fetch the ticket with `get_issue({id: "<IDENT>", includeRelations: true})`. The flag adds the issue's `relations` to
  the row. The row carries the description as one markdown string, plus title, status, labels, project, and team.
- Step 5's discussion read: `list_comments({issueId: "<IDENT>"})`. The bare identifier works; a uuid works too. The
  response is `{comments, hasNextPage}`. This verification ran against an issue with no comments, so the hand-off past
  an empty first page is unexercised - follow `hasNextPage` and pass the returned cursor back when one arrives.
- Step 7's re-fetch before quoting: re-pull the description with `get_issue` rather than reconstructing it from memory.
  The row's description is the verbatim text the quotes anchor to.
- Delivery: Linear has no inline comments on a description - the description is one markdown string on the issue and the
  discussion lives in separate comment entities - so review-ticket step 7's single-payload rule applies as written, and
  the review posts as one comment on the issue. The posting call itself is a write and was not exercised in the
  2026-11-20 verification; read the tool surface at post time rather than trusting this lens for it.
