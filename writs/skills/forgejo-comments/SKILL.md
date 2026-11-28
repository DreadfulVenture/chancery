---
name: forgejo-comments
description: "Read and follow Forgejo PR comments — review bodies, inline threads, and issue comments"
license: MIT
metadata:
  audience: agents
  workflow: review-reading
---

# Reading Forgejo PR comments — reviews, inline threads, issue comments

A Forgejo PR carries three kinds of comments. A GitHub-shaped client reads them wrong twice: it looks for review bodies
and inline comments in the issue-comments list (they are not there), and it looks for a parent field linking a reply to
its root (there is none — a reply is a second row at the same anchor). This skill walks the three surfaces with the MCP
tools, the thread walk from any comment to its latest word, and the severity rule.

Throughout, `{owner}` is the repo owner and `example-repo` the repository. The forge host appears as `git.example.com`.

## The three surfaces

- **Review** — one submission by one reviewer: a state (`APPROVED`, `REQUEST_CHANGES`, `COMMENT`), a body, and any
  number of inline comments. `list_pull_reviews` returns the reviews. The body — verdict prose included — lives here and
  nowhere else.
- **Inline review comment** — a comment anchored to a file and line, fetched per review with
  `list_pull_review_comments`.
- **Issue comment** — plain PR discussion, unanchored and unthreaded, from `list_issue_comments`. Tracker bots post
  here: the live PR's entire issue-comment list was one ticket-link row a bot posted.

## Reading review state — list_pull_reviews

`list_pull_reviews({owner, repo, index})` returns the review rows. Each row carries:

- `id` — the review's database id. The inline-comments endpoint keys on this; nothing else does.
- `user.login`, `state`, `body`, `submitted_at`.
- `comments_count` — how many inline comments ride the review.
- `stale` — true when the PR's head moved after the review was submitted. It does not retract the review.

Rows arrived in submission order on the live PR (three reviews, oldest first). Do not build state on that ordering:
identify an author's current word by `submitted_at` and `id`, not by position. A newer review from the same author
replaces their older one.

## Inline comments and their label line

`list_pull_review_comments({owner, repo, index, id=<review id>})` returns the review's inline comments as one list. Each
row carries:

- The anchor: `path` (file path), `position` (the anchored line), `diff_hunk` (the hunk the line sits in), `commit_id`,
  and `html_url` linking to the comment in the UI. `original_commit_id` may be an empty string — treat it as absent.
- `pull_request_review_id` — which review the comment rides. The only linkage field the row carries.
- `id`, `user.login`, `body`, `created_at`, `updated_at`.
- `resolver` — present, and null on every live row. Never read resolution state from it.

`position` matched the new-file line number of the anchored change on every live row checked, but the field name does
not say whether it counts diff lines or file lines. Confirm an anchor by reading `diff_hunk` against the position, not
by trusting the name.

## Walking a thread from any comment

Forgejo exposes no parent field. A reply is its own row with its own id, sitting beside the root in the same review's
comment list. The live shape of a reply: same `pull_request_review_id`, same `path`, same `position`, same `diff_hunk`,
a later `created_at`. Threads are co-location, not linkage.

From any comment:

1. Read its `pull_request_review_id` and its anchor (`path` + `position`).
2. Fetch that review's full comment list with `list_pull_review_comments`.
3. Group the rows by `path` and `position`. A group is a thread; a comment with no neighbors at its anchor is a thread
   of one.
4. Order the group by `created_at`. The last row is the thread's latest word. Use `created_at` for the order, not
   `updated_at` — an edit moves `updated_at` without moving the row's place in the conversation.

Authors mix inside one group freely: the live thread held the bot's opening comment and the operator's one-line reply.
The grouping runs inside one review's list; if the reply you expect is not there, check the PR's other reviews for a row
at the same anchor.

## Plain issue comments

`list_issue_comments({owner, repo, index})` returns the flat discussion list: `id`, `user.login`, `body`, `created_at`,
`updated_at`, `html_url`. No anchors, no threads, no labels. Review bodies and inline comments never surface here — a PR
can hold a three-round review fight while this list carries nothing but a tracker bot's ticket link, which is exactly
what the live PR's list held.

## The traps

1. `list_pull_review_comments` takes the **review id** — the `id` field of a `list_pull_reviews` row. Passing a comment
   id or a nonexistent review id returns the identical error, `list pull review comments err: GetReviewByID`; the error
   cannot tell you which mistake you made. Re-read the id from the reviews list before retrying.
2. A valid review id against the wrong PR `index` errors `list pull review comments err: ReviewNotInPR`. That one is
   diagnostic: the review exists but belongs to another pull request.
3. The inline-comments tool has no paging parameters and returns the review's comments whole. The reviews and
   issue-comments lists do page (limit defaults to 20) — pass `limit` and page through until the result set is exhausted
   before reporting.
4. Reading only `list_issue_comments` misses every review body and every inline finding. State read that way is not
   review state.
5. Every review id and comment id comes from tool output — never from a URL guess or a recount.
