# The session driver contract

Zenigata runs its review passes in sessions hosted by an agent runtime — the deployment's opencode background service.
The bot core consumes the runtime through the `SessionDriver` contract (`src/contracts/session.ts`); the concrete driver
lives in `src/adapters/opencode.ts` and its double in `src/adapters/session-double.ts`. This document is the spec a
driver author implements and the rationale behind the pin.

## The five methods

| Method                            | What it does                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `createSession(directory, agent)` | Create a session working in `directory`, running the named agent; returns the session id. |
| `prompt(sessionId, text)`         | Send one prompt and wait for the turn to finish.                                          |
| `readOutput(sessionId)`           | Return the text of the session's last assistant message, after the most recent turn.      |
| `transcript(sessionId)`           | Return the session's recorded turns, oldest first (`{role, text}` per turn).              |
| `dispose(sessionId)`              | End the session.                                                                          |

A review uses one session for its whole run: create, then one prompt/readOutput round — the session's own skill flow
does the review, its humanize, and the forge post, and the reply's final line is the run's status — then dispose. The
reply flow creates its own short-lived session the same way.

`readOutput` returns the text of the newest assistant message only. When the newest assistant message is the one already
returned — a turn that produced no assistant output — it returns `""` rather than the stale text. The pipeline's
corrective-retry path depends on this: a retry prompt that yields no answer reads as empty and fails validation, instead
of silently re-validating the previous stage's output. The in-repo `SessionDouble` diverges here for convenience: it
replays the scripted output on a repeat read instead of returning `""`.

`transcript` reads the whole recorded session for the status page's transcript view (PRJ-461's transcript scope): the
prompts the caller sent and the replies the runtime recorded, oldest first, text parts joined per message. The read
mirrors the runtime's own record, so a session the runtime no longer holds — the retention sweep disposed it — fails the
read with the runtime's session-not-found error; that failure is how the page's view knows to degrade to the swept note.
The read is one bounded window over the message list (the newest 50 records), so its cost is fixed; a session with more
turns than the window offers its newest ones.

## The version pin

Every `@opencode/client` import in the service lives in `src/adapters/opencode.ts`, and the client version is pinned in
`package.json` to match the deployed opencode service exactly (2.2.5 at the time of writing). The opencode API is
generated and moves fast, so the pin keeps the driver's method names in lockstep with the service they call — and
confining the imports to one file means an upstream bump costs one file, not a hunt. Placements to re-verify first on
any bump: the `idle` record the turn barrier keys on (type `SessionMessageIdle` upstream), the queued user item
`session.prompt` returns, and the message-list shapes the poll reads — the driver's turn-state judgement rests only on
these.

## Authentication

The opencode background service authenticates mutating calls (session create, prompt, remove) with HTTP Basic auth and
leaves reads open. The driver takes the service's password as its `apiKey` option and sends the `Authorization: Basic`
header on every call when one is set; with no key configured it sends no header, matching a service without a password.
The deployment sources the password from the opencode service's state file (`password` key in
`~/.local/state/opencode/service.json` on the service host) and carries it in Zenigata's secrets file as
`ZENIGATA_OPENCODE_KEY`.

## The turn barrier: `prompt` waits for the turn without holding a request

`prompt` resolves only when the turn has finished, and no single request it makes waits on the model. In the opencode
client this takes two calls: `session.prompt` resolves with the queued user item and does not document that the
assistant turn has finished, so the driver follows it with a polling loop of short `message.list` reads and returns only
when the turn is settled. Each read is one bounded request; a failed read retries on the next tick. The turn is settled
when an `idle` record lands after the queued user item (the runtime's own turn-outcome marker), or when the newest
assistant message after it completed with a non-tool-call finish and no scheduled retry. While the turn is still busy,
the loop backs off mildly and polls again; a turn still busy past the poll budget is declared stuck, interrupted
(stopping the spend), and `prompt` fails, which ends the run through its existing cleanup path. A driver that skips the
barrier lets `readOutput` run before the assistant has answered, and the review pipeline reads stale or empty output; a
driver that holds one long request on the turn can be cut mid-wait by the client's HTTP stack and lose the turn's
completion by surprise — the poll keeps every request short instead.

## What a driver must not assume

- The agent named in `createSession` exists in the runtime; a session created for an unknown agent either fails or
  silently runs a different agent, and both break the review route. The deployment registers the agent before the bot
  starts (see `docs/deployment.md`).
- Output ordering: a driver must return the assistant message that follows the most recent `prompt`, not the first
  message of the session.
