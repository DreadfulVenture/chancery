---
name: review-project-linear
description: >-
  The Linear lens for review-project: load it alongside review-project when the project under review lives in Linear.
  Carries the verified tool surface (as of 2026-11-19), the input forms the tracker accepts, and the review-delivery
  mechanics with their known traps. To review a project in another tracker, load that tracker's lens instead.
---

# The Linear lens

This lens modifies `review-project` for projects that live in Linear. Where it speaks, it wins on its own subject
matter - the calls to make, the input forms Linear accepts, and how the review is delivered. Verified against the live
MCP `linear` namespace on 2026-11-19. Linear calls project documents "projects", their work items "issues", and their
discussion "comments".

- Inputs: a project name, or a `P-XXX-NNN` identifier. The project tools key on the name - `get_project` errors on an
  id - so when only an identifier is at hand, ask for the name before anything else.
- `get_project({query: "<name>"})` returns the description, lead, dates, status, labels, and teams. The query takes the
  name; passing an id or a projectId errors.
- `list_milestones({project: "<name>"})` returns each milestone's id, name, description, progress, and sortOrder.
- `list_issues({project: "<name>"})` returns the project's issues - review-project step 1's membership pull. The name
  works; a uuid, a `P-XXX-NNN` identifier, and a URL slug all return empty. The call paginates: pass the returned cursor
  back as a string while `hasNextPage` is true, and follow it to the end.
- Issue rows carry no project field, so membership is knowable only through `list_issues({project})`.
- `get_issue({id})` reads one issue - step 1's citation cross-reference.
- `list_comments` reads the project's discussion - step 5's reconciliation.
- Step 7's re-fetch before quoting: re-pull the description with `get_project` and the milestones with
  `list_milestones`.
- Step 9's delivery, verified: the proven path is a thread reply carrying the review as an attached md, sent through the
  draft tool so the operator reviews and sends it - a Linear project comment is sidebar-grade for a document. Two traps:
  completing an upload without a channel named leaves the file attached to nothing, and the completion tool's share step
  reports success while the thread stays empty; the send tool drops file ids silently, so the attachment rides the
  draft, not the send.
