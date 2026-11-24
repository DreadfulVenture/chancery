# forgejo-adapter

Forgejo implementation of zenigata's forge adapter contract (`review/zenigata/docs/forge-adapter.md`). It is the
go-between: zenigata calls this service (outbound) and Forgejo webhooks are translated here and delivered to zenigata's
intake (inbound).

## Endpoints

Outbound (bot → adapter, `Authorization: Bearer <ZENIGATA_ADAPTER_TOKEN>`):

- `GET /pr?repo=<owner/name>&pr=<n>` → PR shape JSON
- `GET /pr/diff?repo=<owner/name>&pr=<n>` → unified diff (`text/plain`)
- `GET /review?repo=<owner/name>&pr=<n>&head=<sha>` → posted review lookup (200) or 404 when none for that head
- `POST /review` → post review (enforces `expectedHeadSha`, idempotent per `(repo, pr, expectedHeadSha)` as a backstop),
  returns `{reviewCommentId, commentRefs}`
- `POST /reply` → post reply, returns `{commentId}`
- `POST /failure` → post failure comment (no verdict/labels), 2xx on success

Inbound:

- `POST /webhooks/forgejo` → verifies Forgejo webhook HMAC signature (`X-Gitea-Signature` / `X-Hub-Signature-256`,
  SHA-256, constant-time compare), translates supported events into contract events, and delivers them to zenigata
  `POST /v1/events` with `Authorization: Bearer <ZENIGATA_EVENT_TOKEN>`.

Other: `GET /healthz`.

## Webhook translation (contract events only)

- **`review_requested`**: Forgejo `pull_request` webhook, `action: "review_requested"`. Translated to
  `{kind, eventId, repo, pr, requesterLogin, commentId, text}` with `repo` normalized to `owner/name`. `eventId` is the
  forge delivery id, so each re-request of the same PR is its own event (the intake's retry policy gates replays of a
  delivery, not re-requests); `commentId` metadata is the requested reviewer's forge id. When the delivery header is
  absent the event id falls back to a deterministic key, so the translation never fabricates a per-run identity.
- **`reply`**: Forgejo `issue_comment` or `pull_request_comment` webhook, `action: "created"`, on a pull request, **only
  when the payload provides an explicit reply target** (`comment.in_reply_to_id` / `comment.in_reply_to` /
  `comment.reply_to`). Translated to `{kind, eventId, repo, pr, authorLogin, inReplyTo, commentId, text}` with opaque
  ids. Without a reply target the comment is never a reply (`inReplyTo` cannot be fabricated); it is acknowledged and
  ignored.
- Comments trigger nothing: a top-level PR comment (no reply target) is ordinary chatter, whatever it mentions. Reviews
  fire on a forge review re-request. PR comments trigger nothing.

Unsupported/unmappable events are acknowledged (`202 ignored`) without inventing a third event kind. If real Forgejo
payloads cannot satisfy the contract without guessing or extending it, that is a `BLOCKED` discrepancy per the contract
boundary.

## Configuration (env)

| Variable                             | Required | Default | Meaning                                                                |
| ------------------------------------ | -------- | ------- | ---------------------------------------------------------------------- |
| `FORGEJO_ADAPTER_LISTEN_PORT`        | no       | `8472`  | Listen port (`0` lets the OS pick; binds `127.0.0.1`)                  |
| `FORGEJO_BASE_URL`                   | yes      | —       | Forgejo base URL (e.g. `https://forge.example.com`)                    |
| `FORGEJO_TOKEN`                      | yes      | —       | Least-scope Forgejo API token (operator-materialized; never committed) |
| `ZENIGATA_ADAPTER_TOKEN`             | yes      | —       | Bearer token expected on outbound bot→adapter requests                 |
| `ZENIGATA_INTAKE_URL`                | yes      | —       | Zenigata base URL for inbound event delivery (`/v1/events`)            |
| `ZENIGATA_EVENT_TOKEN`               | yes      | —       | Bearer token for inbound delivery to zenigata                          |
| `FORGEJO_WEBHOOK_SECRET`             | yes      | —       | Shared secret for webhook HMAC verification                            |
| `FORGEJO_ADAPTER_REQUEST_TIMEOUT_MS` | no       | `30000` | Upstream request timeout                                               |

Validation fails fast and names the offending variable.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Deployment (NixOS)

The flake exports `packages.forgejo-adapter` and `nixosModules.forgejo-adapter`. Enable `services.forgejo-adapter` and
point it at the Forgejo instance and Zenigata intake. The module takes `forgeBaseUrl` from the deployer with no upstream
default and defaults `zenigataIntakeUrl` to `http://127.0.0.1:8471` (base only; the adapter appends the intake path
`/v1/events` itself). Non-secret knobs are module options (`listenPort`, `stateDir`, `forgeBaseUrl`,
`zenigataIntakeUrl`, optional `requestTimeoutMs`); the service binds loopback only.

`services.forgejo-adapter.secretsFile` is an environment file carrying the required secret tokens: `FORGEJO_TOKEN`,
`ZENIGATA_ADAPTER_TOKEN`, `FORGEJO_WEBHOOK_SECRET`, and `ZENIGATA_EVENT_TOKEN` (for inbound delivery to zenigata). Keep
those secrets out of the Nix store.

**Forgejo webhook registration (per repository, Forgejo-side):** in each repo the adapter serves, add a webhook pointing
at the adapter's inbound endpoint `POST /webhooks/forgejo`, set the webhook secret to the same `FORGEJO_WEBHOOK_SECRET`,
and enable the events the adapter translates (`pull_request` with `review_requested`, and `issue_comment` /
`pull_request_comment` `created` for reply delivery). Unsupported events are acknowledged and ignored.

## Smoke (local fake forge, portable)

`scripts/smoke-live.mjs` verifies the forge-client code path against a **local fake Forgejo server** — it never contacts
a live forge and takes no live credentials. The operator-supplied Forgejo token and the live forge.example.com check
belong to deployment (PRJ-301's flow), not to this script.

It is one dependency-free script (global `fetch` + node stdlib only), with no imports from `src/`, no `dist/`, and no
`node_modules`. It runs anywhere `node >= 24` exists — no install, no build, and no network beyond `127.0.0.1`.

The script spins up an in-process fake Forgejo HTTP server with fixture responses for the PR shape and diff endpoints,
then drives the same request shapes, headers, token auth, and field extraction the adapter's forge client uses,
asserting the PR-shape fields (head/base sha, refs, title, body, `clone_url`) and a non-empty unified diff.

Run (from anywhere the script is available):

```sh
node review/forgejo-adapter/scripts/smoke-live.mjs
```
