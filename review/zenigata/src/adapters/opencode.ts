/**
 * SessionDriver over the opencode background service, via @opencode/client.
 *
 * Version pin rationale: the opencode API is generated and moves fast; the
 * client is pinned to 2.2.5 to match the deployed opencode service exactly.
 * Every @opencode/client import in the service lives in this file, so an
 * upstream bump costs one file.
 *
 * Method names verified against the 2.2.5 typings
 * (node_modules/@opencode/client/dist/promise/):
 *   - client factory: `OpenCode.make({ baseUrl })` (named export `OpenCode`,
 *     a namespace whose `make` builds the network client)
 *   - create: `session.create({ location: { directory }, agent })` -> SessionInfo
 *     (SessionCreateInput carries both a `location.directory` and an `agent`,
 *     so per-session agent selection is available at create time;
 *     `session.switchAgent({ sessionID, agent })` exists for later switches)
 *   - one-turn prompt: `session.prompt({ sessionID, text })` -> SessionInboxUser
 *     (the queued user item; the turn itself is awaited by the polling loop)
 *   - turn state read: `message.list({ sessionID, order: "desc", limit })`
 *     -> SessionMessagesResponse; the listed messages carry the turn's
 *     terminal state (see turnSettled below)
 *   - stuck-turn stop: `session.interrupt({ sessionID })` -> 204
 *   - last assistant message text: the message content parts
 *   - dispose: `session.remove({ sessionID })` (a delete endpoint exists)
 *
 * Turn barrier: prompt() holds no long request. It fires the prompt (the
 * endpoint resolves with the queued user item) and then awaits the turn
 * through a polling loop of short message.list reads: the turn is settled
 * when an `idle` record lands after our user item, or when the newest
 * assistant message completed with a non-tool-call finish (the idle record
 * is the honest terminal marker; the completed-assistant rule covers a
 * runtime that never writes one). Each poll holds one short HTTP call;
 * a failed poll retries on the next tick. A turn still busy past the
 * poll budget is a stuck turn: the driver interrupts it (stopping the
 * spend) and fails the prompt, which ends the run through its existing
 * cleanup path (dispose, worktree removal, journal, failure comment).
 *
 * Turn correlation: the loop keys on the queued user item's creation time
 * (returned by the prompt endpoint) and reads only records created at or
 * after it, so markers from earlier turns never settle our turn. Same-
 * millisecond collisions between an old turn's terminal marker and the new
 * user item are accepted as immediately settled — readOutput still sees no
 * fresh assistant message and the pipeline's validation owns the outcome.
 *
 * readOutput tracks the id of the last assistant message it returned, per
 * session. When the newest assistant message is still the one it already
 * returned — a turn that produced no assistant message, or a repeated read
 * — it returns "" instead of the stale text, so the pipeline's
 * corrective-retry path sees a fresh (empty) output rather than silently
 * re-validating the previous turn. prompt() records nothing; only
 * readOutput decides what has been read.
 */

import { OpenCode } from "@opencode/client";
import { whenAborted } from "../with-timeout.js";
import type { SessionDriver, SessionTurn } from "../contracts/session.js";

export interface OpencodeDriverOptions {
  baseUrl: string;
  /**
   * The opencode service's password, when the service has one configured.
   * The service authenticates mutations with HTTP Basic auth (username
   * `opencode`) and leaves reads open; the deployment sources the password
   * from the service's state (see docs/deployment.md). No header is sent
   * when the key is unset, matching a service without a password.
   */
  apiKey?: string;
  /**
   * Seconds between the turn-state polls. Backoff doubles each tick up to
   * five times the interval, and the deployment default is a few seconds.
   */
  turnPollSeconds?: number;
  /**
   * Seconds one prompt's turn loop may run before the turn is declared
   * stuck, interrupted, and failed. The deployment default is generous
   * (minutes, not seconds); the review run's own timeout backstops it.
   */
  turnBudgetSeconds?: number;
  /** Injectable clock (ms epoch) for tests. */
  clock?: () => number;
  /** Injectable sleep for tests; the driver awaits no other timers. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TURN_POLL_SECONDS = 3;
const DEFAULT_TURN_BUDGET_SECONDS = 900;

/** Messages per state read: the newest-first window the loop scans. */
const MESSAGES_WINDOW = 25;

/** Messages per transcript read: the newest-first window the page's view scans. */
const TRANSCRIPT_MESSAGES_WINDOW = 50;

/**
 * Structural subset of the 2.2.5 message shapes the loop reads.
 * SessionMessageAssistant carries the completion markers; the user, idle,
 * and bookkeeping records share the {type, time.created} core.
 */
interface AssistantMessage {
  time: { created: number; streamed?: number; completed?: number };
  finish?: string;
  retry?: unknown;
  error?: unknown;
}

type ListedMessage = {
  type: string;
  time: { created: number };
};

/**
 * Whether the turn queued at `userCreatedMs` has settled, judged only
 * from a newest-first page of listed messages. An `idle` record after
 * the user item is the runtime's own turn-outcome marker. A completed
 * assistant message with a finish (not "tool-calls", which hands off to
 * the next step, and not carrying a scheduled retry) is the fallback for
 * a runtime that completed the turn without writing the idle record.
 */
export function turnSettled(
  listed: ListedMessage[],
  userCreatedMs: number,
): boolean {
  for (const item of listed) {
    if (item.time.created < userCreatedMs) {
      return false;
    }
    if (item.type === "idle") {
      return true;
    }
    if (item.type === "assistant") {
      const assistant = item as AssistantMessage;
      if (assistant.retry !== undefined) {
        // The runtime scheduled another attempt: still in progress.
        continue;
      }
      if (assistant.error !== undefined) {
        return true;
      }
      if (
        assistant.time.completed !== undefined &&
        assistant.finish !== undefined &&
        assistant.finish !== "tool-calls"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A message read that found no session. The promise client turns every
 * non-2xx into a thrown error: an unplanned status (not in the route's
 * declared list) surfaces as ClientError("UnexpectedStatus") with the
 * status in the message, while the route's declared statuses — 404 is one
 * for the message list — surface the server's error body whose generated
 * shape is tagged (SessionNotFoundError in 2.2.5). Both shapes are read,
 * so either client-level or service-level reporting marks the session gone.
 */
function isSessionNotFound(error: unknown): boolean {
  const err = error as { name?: unknown; reason?: unknown };
  if (err.name === "SessionNotFoundError") {
    return true;
  }
  return (
    err.name === "ClientError" &&
    err.reason === "UnexpectedStatus" &&
    /\b404\b/.test(error instanceof Error ? error.message : String(error))
  );
}

class OpenCodeSessionDriver implements SessionDriver {
  private readonly client: ReturnType<typeof OpenCode.make>;

  /** The assistant message id readOutput last returned, per session. */
  private readonly lastRead = new Map<string, string>();

  private readonly turnPollSeconds: number;
  private readonly turnBudgetSeconds: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OpencodeDriverOptions) {
    const headers: Record<string, string> = {};
    if (opts.apiKey !== undefined && opts.apiKey !== "") {
      const basic = Buffer.from(`opencode:${opts.apiKey}`).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }
    this.client = OpenCode.make({
      baseUrl: opts.baseUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    this.turnPollSeconds = opts.turnPollSeconds ?? DEFAULT_TURN_POLL_SECONDS;
    this.turnBudgetSeconds =
      opts.turnBudgetSeconds ?? DEFAULT_TURN_BUDGET_SECONDS;
    this.clock = opts.clock ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  async createSession(
    directory: string,
    agent: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const created = await this.client.session.create(
      { location: { directory }, agent },
      { signal: opts?.signal },
    );
    return created.id;
  }

  async prompt(
    sessionId: string,
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    let userCreatedMs: number;
    try {
      const queued = await this.client.session.prompt(
        { sessionID: sessionId, text },
        { signal: opts?.signal },
      );
      userCreatedMs = queued.time.created;
    } catch (error) {
      // The transport died before the queued item came back, so the turn
      // may still be running server-side. Stop it best-effort — a dead
      // run must not keep burning turns — and surface the failure; the
      // run's cleanup path disposes the session from here.
      await this.stopTurn(sessionId);
      throw error;
    }
    await this.awaitTurn(sessionId, userCreatedMs, opts);
  }

  async readOutput(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const listed = await this.client.message.list(
      {
        sessionID: sessionId,
        order: "desc",
        limit: 1,
        type: "assistant",
      },
      { signal: opts?.signal },
    );
    const last = listed.data[0];
    if (!last || last.type !== "assistant") {
      return "";
    }
    // A turn that produced no assistant message leaves the newest one
    // unchanged; returning "" here takes the pipeline's corrective-retry
    // path instead of reusing the previous turn's text.
    if (this.lastRead.get(sessionId) === last.id) {
      return "";
    }
    this.lastRead.set(sessionId, last.id);
    return last.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n");
  }

  async dispose(sessionId: string): Promise<void> {
    this.lastRead.delete(sessionId);
    await this.client.session.remove({ sessionID: sessionId });
  }

  async transcript(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionTurn[]> {
    // One bounded list read, newest first, reversed to the turns' own
    // order. The window keeps the read's cost fixed; a session with
    // more recorded turns than the window offers its newest ones — the
    // page's own byte cap trims the view further anyway.
    const listed = await this.client.message.list(
      {
        sessionID: sessionId,
        order: "desc",
        limit: TRANSCRIPT_MESSAGES_WINDOW,
      },
      { signal: opts?.signal },
    );
    return (
      listed.data as Array<{
        type: string;
        content?: Array<{ type: string; text: string }>;
      }>
    )
      .filter((item) => item.type === "user" || item.type === "assistant")
      .map((item) => ({
        role: item.type as SessionTurn["role"],
        text:
          item.content
            ?.filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join("\n") ?? "",
      }))
      .reverse();
  }

  /**
   * Await the turn queued at `userCreatedMs` with short state reads: a
   * failed or not-yet-settled read retries on the next tick, one short
   * HTTP call at a time, bounded by the turn budget. A stuck turn is
   * interrupted and the prompt fails; the run's cleanup owns the rest.
   */
  private async awaitTurn(
    sessionId: string,
    userCreatedMs: number,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const pollMs = this.turnPollSeconds * 1000;
    const backoffCapMs = pollMs * 5;
    const deadline = this.clock() + this.turnBudgetSeconds * 1000;
    let delayMs = pollMs;
    for (;;) {
      opts?.signal?.throwIfAborted();
      let listed: { data: ListedMessage[] } | undefined;
      try {
        listed = await this.client.message.list(
          { sessionID: sessionId, order: "desc", limit: MESSAGES_WINDOW },
          { signal: opts?.signal },
        );
      } catch (error) {
        if (isSessionNotFound(error)) {
          // The session is gone: no turn can ever settle on it. Fail the
          // prompt now instead of polling out the budget.
          throw new Error(
            `session ${sessionId} disappeared while waiting for the turn`,
          );
        }
        // A transport failure on one state read is a retried tick, not a
        // dead turn: the next read carries the loop. The budget bounds a
        // runtime that never answers again.
        listed = undefined;
      }
      if (listed !== undefined && turnSettled(listed.data, userCreatedMs)) {
        return;
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) {
        await this.stopTurn(sessionId);
        throw new Error(
          `turn wait exceeded the ${this.turnBudgetSeconds}s budget for session ${sessionId}; the stuck turn was interrupted`,
        );
      }
      const waited = this.sleep(Math.min(delayMs, remaining));
      if (opts?.signal) {
        // The run's deadline may abort during a tick: wake on the abort
        // instead of finishing the sleep.
        await Promise.race([waited, whenAborted(opts.signal)]);
      } else {
        await waited;
      }
      // Mild backoff over a long turn: each tick waits up to twice the
      // last, capped at five times the base interval.
      delayMs = Math.min(delayMs * 2, backoffCapMs);
    }
  }

  /** Best-effort stop of a running turn; every failure is swallowed. */
  private async stopTurn(sessionId: string): Promise<void> {
    try {
      await this.client.session.interrupt({ sessionID: sessionId });
    } catch {
      // A dead transport or an already-idle session leaves nothing to
      // stop; dispose still removes the session.
    }
  }
}

/** Factory so the bot core consumes only the SessionDriver contract. */
export function opencodeSessionDriver(
  opts: OpencodeDriverOptions,
): SessionDriver {
  return new OpenCodeSessionDriver(opts);
}
