# The forge adapter contract

Zenigata never talks to a forge directly. The deployment runs an adapter service in front of the forge, and the bot
consumes that adapter over HTTP+JSON through the `ForgeAdapter` contract (`src/contracts/forge.ts`). The in-tree HTTP
client (`src/adapters/forge.ts`) is the reference consumer; this document is the spec an adapter author implements. Test
against the in-tree double (`src/adapters/forge-double.ts`) or a live instance of the client before wiring Zenigata to a
new adapter.

Two directions, both on this page:

- **Outbound** — the bot calls the adapter to fetch a pull request's shape and diff and to post reviews and replies.
- **Inbound** — the adapter delivers events (a review request, a reply) to the bot's intake endpoint.

## Authentication

Every outbound request carries `Authorization: Bearer <token>`, where `<token>` is the value the deployment gave
Zenigata as `ZENIGATA_ADAPTER_TOKEN`. Inbound event posts carry the same header with the intake token
(`ZENIGATA_EVENT_TOKEN`).

## Outbound endpoints

Paths are relative to the adapter's base URL. All bodies are JSON unless noted. The client times every request out after
30 seconds.

### GET /pr?repo=<repo>&pr=<n>

The pull request's shape. The response is JSON with exactly these fields:

| Field      | Type    | Meaning                                                                      |
| ---------- | ------- | ---------------------------------------------------------------------------- |
| `repo`     | string  | The repository, as the events name it.                                       |
| `pr`       | number  | The pull request number.                                                     |
| `headSha`  | string  | The head commit the PR points at right now.                                  |
| `baseSha`  | string  | The base commit.                                                             |
| `headRef`  | string  | The head branch name.                                                        |
| `baseRef`  | string  | The base branch name; the bot fetches refs by name.                          |
| `cloneUrl` | string  | A URL the bot may `git clone`; the adapter composes any credentials into it. |
| `title`    | string  | The pull request title.                                                      |
| `body`     | string  | The pull request description, verbatim.                                      |
| `isFork`   | boolean | True when the head branch lives in a fork; the bot skips fork PRs.           |

### GET /pr/diff?repo=<repo>&pr=<n>

The pull request's unified diff against its base, as `text/plain`. The bot parses new-side hunk ranges from it, so it
must be a standard unified diff.

### POST /review

Post the review. The request body is JSON:

| Field             | Type   | Meaning                                                                                                                               |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`            | string | The repository.                                                                                                                       |
| `pr`              | number | The pull request number.                                                                                                              |
| `expectedHeadSha` | string | The head the review was produced against.                                                                                             |
| `verdict`         | string | `APPROVE` or `REQUEST_CHANGES`.                                                                                                       |
| `body`            | string | The review summary body.                                                                                                              |
| `comments`        | array  | Inline comments: `{path, line, body}` each. `path` is a file in the diff, `line` is a new-side line, `body` is the full comment text. |

The bot appends the same fixed footer to every review body it posts —
``A fresh `@zenigata @review` comment re-runs the review, and a review re-request does too. A bare mention, a mention in a reply, or a bare push triggers nothing.``
— at the post site rather than in model prose, so the posted review states the re-review trigger contract as structure.

The response is JSON with the posted ids:

| Field             | Type   | Meaning                                                                                                                                                   |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewCommentId` | string | The id of the posted review comment, in the forge's id space.                                                                                             |
| `commentRefs`     | array  | `{index, commentId}` each: `index` is the position of the comment in the request's `comments` array, `commentId` is the posted id of that inline comment. |

The client may abort this request when its own run deadline fires; see "What a client abort means" below.

### GET /review?repo=<repo>&pr=<n>&head=<sha>

The bot's own reconciliation lookup: what the forge has for one (repo, pr, head). The response is 200 with JSON when a
review by the bot exists for that head, and 404 when none does; any other status is an error and the client treats it as
a failed lookup. The 200 body carries the posted ids plus exactly what landed:

| Field             | Type   | Meaning                                                            |
| ----------------- | ------ | ------------------------------------------------------------------ |
| `reviewCommentId` | string | The posted review comment's id, as `POST /review` returned it.     |
| `commentRefs`     | array  | `{index, commentId}` each, as `POST /review` returned them.        |
| `verdict`         | string | `APPROVE` or `REQUEST_CHANGES` — the verdict of the landed review. |
| `body`            | string | The landed review's summary body, verbatim.                        |
| `comments`        | array  | `{path, line, body}` each: the landed inline comments, verbatim.   |

### POST /reply

Reply to a comment on the bot's own review. Request body: `{repo, pr, inReplyTo, body}` — `inReplyTo` is the comment id
the reply answers, taken from the inbound event that carried it. The response is JSON:

| Field       | Type   | Meaning                                         |
| ----------- | ------ | ----------------------------------------------- |
| `commentId` | string | The posted reply's id, in the forge's id space. |

The bot records the id (and the answer text) in its reply index, so a later reply answering the bot's own answer
resolves against it in a normal two-turn thread instead of taking the no-record path.

### POST /failure

Post a failure comment. Request body: `{repo, pr, inReplyTo?, body}`. `inReplyTo` is optional; when present the failure
comment lands in that thread. A failure comment carries no verdict and never carries labels. A 2xx response means it
posted. The review pipeline posts nothing on failure — the bot's journal is its failure surface and only a completed
review reaches the pull request. The endpoint remains part of the adapter contract; the in-tree double implements it and
the ForgeDouble records the calls.

## What a client abort means

Every outbound call takes an optional caller-supplied `AbortSignal` (the bot's run deadline), composed client-side with
the per-request timeout. What the signal means for the adapter:

- The abort may or may not reach the adapter before processing. A request that was already received can still complete
  on the forge after the client stopped waiting; the bot accepts that.
- Completing the action and discarding it are both acceptable responses to an abort. The bot does not promise which one
  happened, and it reconciles afterwards (see `GET /review` above) instead of assuming.
- A review created from an abandoned in-flight post may land after the client stopped waiting. That is accepted
  behavior, not a bug: the bot reconciles what actually landed and journals it. The adapter is the backstop against the
  mirrored case — a retried or reconciled client racing an already-completed post — and SHOULD treat `POST /review` as
  idempotent per `(repo, pr, expectedHeadSha)`, so a client retry or reconciliation cannot double-post a review for the
  same head.

## Error handling

A non-2xx response to any outbound call makes the client throw an Error carrying the method, path, status, and the first
500 characters of the response body. An adapter signals a refused action with a non-2xx status and a body a human can
read.

## The expected-head rule

The adapter MUST refuse `POST /review` when the pull request's current head differs from the request's
`expectedHeadSha`. The bot re-checks the head itself before posting, but the two checks run seconds apart, and the
adapter sits closer to the forge: the adapter's check is the one that stands between a stale review and the pull
request. Refuse with a non-2xx status whose body names both heads.

## Comment ids are opaque strings

Comment ids — `reviewCommentId`, `commentRef.commentId`, and the `inReplyTo` values on both directions — are opaque
strings in the forge's own id space. The bot never parses, compares, or reconstructs them; it echoes them back. Any
string the forge accepts as a comment reference works.

## The boundary: nothing forge-specific leaks

The bot core sees only the shapes on this page. No forge-specific type, field name, or identifier crosses the adapter
boundary in either direction, and the adapter never translates forge state into anything beyond what the shapes carry.
Two standing consequences:

- **Labels never move.** The contract has no label actions and no label fields anywhere; a review's verdict lives in the
  review text alone. An adapter must not add label behavior to the endpoints above, and the bot will never ask for it.
- **The event shapes are the intake's whole surface.** An adapter adds no third event kind without extending the
  contract first; the intake rejects unknown event kinds with a 400.
