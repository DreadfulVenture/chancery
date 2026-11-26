/**
 * SessionDriver over the opencode background service, via @opencode/client.
 *
 * Version pin rationale: the opencode API is generated and moves fast; the
 * client pin in package.json floats freely with Renovate, and the runtime
 * package's compatibility check — the flake's zenigata-runtime-compat —
 * runs this driver against the packaged serve, so an upgrade that breaks
 * the driver lands red naming the break instead of being blocked by a
 * version string (PRJ-479). This driver targets the 2.3.x serve semantics:
 * the subagent tool always runs in the background there (PRJ-474), and the
 * settle barrier below waits it out. Every @opencode/client import in the
 * service lives in this file, so an upstream bump costs one file.
 *
 * Method names verified against the 2.3.x typings and the v2.3.0 source:
 *   - client factory: `OpenCode.make({ baseUrl })` (named export `OpenCode`,
 *     a namespace whose `make` builds the network client)
 *   - create: `session.create({ location: { directory }, agent, metadata })`
 *     -> SessionInfo (SessionCreateInput carries a `location.directory`, an
 *     `agent`, and the free-form `metadata` bag, so per-session agent
 *     selection and the origin declaration both land at create time)
 *   - one-turn prompt: `session.prompt({ sessionID, text })` -> SessionInboxUser
 *     (the queued user item, whose `time.created` keys the turn; the turn
 *     itself is awaited by the polling loop. The prompt's delivery defaults
 *     to `steer` server-side: when the session is already executing, the
 *     item joins the running turn at a step boundary instead of waiting
 *     behind it — the pipeline prompts only settled sessions, so this
 *     matters only for an operator prompt racing a background wake)
 *   - turn state read: `message.list({ sessionID, order: "desc", limit })`
 *     -> SessionMessagesResponse; the listed messages carry the turn's
 *     terminal state and the delivered subagent reports (see turnOpen below)
 *   - background-work read: `experimental.job.list({ sessionID, descendants: true })`
 *     -> JobInfo[]; the serve lists active and unconsumed background jobs —
 *     a completed-but-unconsumed subagent job is still listed, so the
 *     report-delivery race cannot settle the turn early
 *   - stuck-turn stop: `session.interrupt({ sessionID })` -> 204 (the serve
 *     cancels the session's background jobs with it)
 *   - last assistant message text: the message content parts
 *   - dispose: `session.remove({ sessionID })` (a delete endpoint exists)
 *
 * Turn barrier (2.3.x): prompt() holds no long request. It fires the prompt
 * (the endpoint resolves with the queued user item) and then awaits the turn
 * through a polling loop of short reads. The settle rule has three parts,
 * all of which must hold:
 *   1. an `idle` record landed after our user item (a terminal-error
 *      assistant with no idle is the stand-in for a runtime that failed the
 *      turn without writing one);
 *   2. no `synthetic` record is newer than the newest `idle` — a synthetic
 *      record is a delivered subagent report, and the wake execution it
 *      starts is still running until its own idle lands;
 *   3. the serve's job list for the session and its descendants is empty —
 *      a listed job is active or unconsumed work, so a child that finished
 *      but whose report is still mid-delivery keeps the turn open.
 * The job endpoint is the pairing contract, not a graceful degradation: a
 * serve without it raises the named pairing error — silently treating the
 * absence as "no outstanding work" would reintroduce the early-settle bug
 * the barrier exists to prevent. Each poll holds short HTTP calls; a failed
 * transport read retries on the next tick. A turn still busy past the poll
 * budget is a stuck turn: the driver interrupts it (stopping the spend and
 * cancelling the serve-side jobs) and fails the prompt, which ends the run
 * through its existing cleanup path (dispose, worktree removal, journal,
 * failure comment).
 *
 * Turn correlation: the loop keys on the queued user item's creation time
 * (returned by the prompt endpoint) and reads only records created at or
 * after it, so markers from earlier turns never settle our turn. Same-
 * millisecond collisions between an old turn's terminal marker and the new
 * user item are accepted as immediately settled — readOutput still sees no
 * fresh assistant message and the pipeline's validation owns the outcome.
 *
 * readOutput tracks the id of the last assistant message it returned, per
 * session. On a session that ran background work it reads the newest
 * assistant message created after the newest delivered report — the
 * summary the parent produced after the reports land, never the launch
 * text the first turn writes while children are still out. When no such
 * message exists (or the newest assistant is still the one it already
 * returned) it returns "", so the pipeline's corrective-retry path sees a
 * fresh (empty) output rather than silently re-validating the previous
 * turn. prompt() records nothing; only readOutput decides what has been
 * read.
 */

import { OpenCode } from "@opencode/client";
import { whenAborted } from "../with-timeout.js";
import { originRecord } from "../origin.js";
import type { SessionDriver, SessionTurn } from "../contracts/session.js";

// The composition carries the contract: exported so the memory client's
// origin contract test reads the exact record createSession declares.
export { originRecord };

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

/** Messages per output read: the newest-first window readOutput scans. */
const OUTPUT_MESSAGES_WINDOW = 25;

/**
 * Structural subset of the 2.3.x message shapes the loop reads.
 * SessionMessageAssistant carries the completion markers; the user, idle,
 * synthetic (delivered subagent report), and bookkeeping records share the
 * {type, time.created} core.
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

/** Structural subset of the 2.3.x Job.Info the loop reads. */
export interface JobRecord {
  kind: string;
  status: string;
}

/**
 * Whether the turn queued at `userCreatedMs` is still open, judged from a
 * newest-first page of listed messages plus the serve's job list for the
 * session and its descendants. Returns null when the turn settled, else a
 * short reason naming what keeps it open — the settle rule's three parts
 * (an idle marker, no report newer than the newest idle, zero outstanding
 * background jobs) must all hold; see the module header for the shape of
 * each. A terminal-error assistant stands in for the idle marker when the
 * runtime failed the turn without writing one.
 */
export function turnOpen(
  listed: ListedMessage[],
  jobs: readonly JobRecord[],
  userCreatedMs: number,
): string | null {
  if (jobs.length > 0) {
    const parts = jobs
      .slice(0, 4)
      .map((job) => `${job.kind}:${job.status}`)
      .join(", ");
    return `background work outstanding (${parts}${jobs.length > 4 ? ", …" : ""})`;
  }
  let newestIdle: number | undefined;
  let newestSynthetic: number | undefined;
  let terminalError = false;
  for (const item of listed) {
    if (item.time.created < userCreatedMs) {
      break;
    }
    if (item.type === "idle") {
      newestIdle ??= item.time.created;
    } else if (item.type === "synthetic") {
      newestSynthetic ??= item.time.created;
    } else if (item.type === "assistant") {
      const assistant = item as AssistantMessage;
      if (assistant.retry !== undefined) {
        // The runtime scheduled another attempt: still in progress.
        continue;
      }
      if (assistant.error !== undefined) {
        terminalError = true;
      }
    }
  }
  if (
    newestSynthetic !== undefined &&
    (newestIdle ?? -Infinity) < newestSynthetic
  ) {
    return "a subagent report arrived after the newest idle marker; its wake execution is still running";
  }
  if (newestIdle === undefined && !terminalError) {
    return "no idle marker since the prompt";
  }
  return null;
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

/**
 * The HTTP status the generated client reports for a non-2xx whose status
 * is not one of the route's declared ones — the shape a serve's 503 job
 * read arrives in.
 */
function jobFailureLabel(error: unknown): string {
  const err = error as { name?: unknown; reason?: unknown };
  if (err.name !== "ClientError") return "a transport error";
  const status = unexpectedStatus(error);
  return status !== undefined
    ? `HTTP ${status}`
    : `client error (${String(err.reason)})`;
}
function unexpectedStatus(error: unknown): string | undefined {
  const err = error as { name?: unknown; reason?: unknown };
  if (err.name !== "ClientError" || err.reason !== "UnexpectedStatus") {
    return undefined;
  }
  const text = error instanceof Error ? error.message : String(error);
  const match = /\b(\d{3})\b/.exec(text);
  return match?.[1];
}

/**
 * The transcript read's record-to-turn helpers (PRJ-538). Each reads its
 * piece structurally and degrades to empty or a generic value when the
 * wire shape moves — an unrecognized shape renders a thinner line, never
 * a failed read.
 */

/** A user record's prompt: the top-level text field, content parts as the fallback. */
const promptText = (record: {
  text?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): string => {
  if (typeof record.text === "string") {
    return record.text;
  }
  return partsText(record.content);
};

/** A tool state's input record, serialized compactly for the page. */
const serializeToolInput = (input: unknown): string => {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input !== "object") {
    return String(input);
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
};

/** A content array's text parts joined; non-text parts (file refs) stay out. */
const partsText = (
  content: Array<{ type: string; text?: string }> | undefined,
): string =>
  (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

/**
 * A tool state's error as text: the wire carries a structured error whose
 * message field is the readable part, and an older bare-string shape
 * passes through as itself.
 */
const toolErrorText = (error: unknown): string | undefined => {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error === "string") {
    return error;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
};

class OpenCodeSessionDriver implements SessionDriver {
  private readonly client: ReturnType<typeof OpenCode.make>;

  /** The assistant message id readOutput last returned, per session. */
  private readonly lastRead = new Map<string, string>();

  private readonly turnPollSeconds: number;
  private readonly turnBudgetSeconds: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * The last background-job read failure of the current wait, carried to
   * the budget error so a run that exhausts its budget on failing job
   * reads names the broken pairing instead of a bare stuck turn. Cleared
   * by every successful read and at the start of each turn wait.
   */
  private jobReadFailure: string | null = null;

  /**
   * The last non-null turnOpen reason of the current wait, carried to the
   * budget error so "stuck turn" says why (background work outstanding,
   * no idle marker, the report wake) instead of nothing. Cleared at the
   * start of each turn wait.
   */
  private lastOpenReason: string | null = null;

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

  /**
   * Every create the runtime makes declares its origin (ADR: "Session
   * origin as a create-time metadata signal"): the runtime process is not
   * a session, so the record's parent is null — the parentless-program
   * declaration, which the memory client parses explicitly and registers
   * as an agent root with no parent conversation; the store's lineage
   * walk resolves such a row unanchored, so the bot's writes are
   * observation-only (the depth table's grant). The review pass and the
   * answer session both create through this call, and the record's shape
   * is imported from src/origin.ts — the composition the origin contract
   * test ties to the consumer across the package boundary.
   */
  async createSession(
    directory: string,
    agent: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const created = await this.client.session.create(
      {
        location: { directory },
        agent,
        metadata: { chancery_origin: originRecord(null) },
      },
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
    // One bounded newest-first window rather than a single assistant read:
    // the output of a turn that ran background work is the assistant
    // message created after the newest delivered report (the parent's
    // post-report summary), and the launch text the first turn wrote sits
    // before it. A session with no delivered reports reads the newest
    // assistant message, exactly as before.
    const listed = await this.client.message.list(
      {
        sessionID: sessionId,
        order: "desc",
        limit: OUTPUT_MESSAGES_WINDOW,
      },
      { signal: opts?.signal },
    );
    let newestReport: number | undefined;
    for (const item of listed.data) {
      if (item.type === "synthetic") {
        newestReport = item.time.created;
        break;
      }
    }
    const eligible = listed.data.filter(
      (
        item,
      ): item is Extract<(typeof listed.data)[number], { type: "assistant" }> =>
        item.type === "assistant" &&
        (newestReport === undefined || item.time.created > newestReport),
    );
    const last = eligible[0];
    if (!last) {
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
    // One bounded list read, newest first, walked oldest first so the
    // turns leave in record order. The window keeps the read's cost
    // fixed; a session with more recorded records than the window
    // offers its newest ones — the page's own byte cap trims the view
    // further anyway.
    const listed = await this.client.message.list(
      {
        sessionID: sessionId,
        order: "desc",
        limit: TRANSCRIPT_MESSAGES_WINDOW,
      },
      { signal: opts?.signal },
    );
    const turns: SessionTurn[] = [];
    for (const item of [...listed.data].reverse()) {
      // The records the page's log renders (PRJ-538): prompts, replies,
      // tool calls, delivered subagent reports. Everything else — idle
      // markers, bookkeeping, shell records — is runtime plumbing the
      // view stays out of.
      if (item.type === "user") {
        const record = item as {
          text?: unknown;
          content?: Array<{ type: string; text?: string }>;
        };
        turns.push({
          role: "user",
          at: item.time.created,
          // The 2.3.0 User record carries the prompt as a top-level
          // text field; the content-parts read stays as the fallback
          // so an older wire shape still renders.
          text: promptText(record),
        });
      } else if (item.type === "assistant") {
        const record = item as {
          content?: Array<{
            type: string;
            text?: string;
            name?: string;
            state?: {
              status?: string;
              input?: unknown;
              content?: Array<{ type: string; text?: string }>;
              error?: { message?: string } | string;
            };
          }>;
        };
        const text = (record.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (text !== "") {
          turns.push({ role: "assistant", at: item.time.created, text });
        }
        for (const part of record.content ?? []) {
          if (part.type !== "tool") {
            continue;
          }
          const timed = part as { time?: { created?: number } };
          const at =
            typeof timed.time?.created === "number" &&
            Number.isFinite(timed.time.created)
              ? timed.time.created
              : item.time.created;
          turns.push({
            role: "tool",
            at,
            name: part.name ?? "unknown tool",
            status: part.state?.status ?? "unknown",
            input: serializeToolInput(part.state?.input),
            output: partsText(part.state?.content),
            error: toolErrorText(part.state?.error),
          });
        }
      } else if (item.type === "synthetic") {
        const record = item as { text?: unknown };
        turns.push({
          role: "report",
          at: item.time.created,
          text: typeof record.text === "string" ? record.text : "",
        });
      }
    }
    return turns;
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
    this.jobReadFailure = null;
    this.lastOpenReason = null;
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
      if (listed !== undefined) {
        const reason = turnOpen(listed.data, [], userCreatedMs);
        if (reason !== null) {
          // The why the budget error carries if this wait runs out: the
          // last non-null turnOpen reason across polls, kept the way the
          // job-read failure label is.
          this.lastOpenReason = reason;
        } else {
          // The message page says the turn settled. The job list is read
          // AFTER the page and is the last read of the tick: a turn may
          // settle only on a job list the serve actually answered, and
          // only when it is empty after the page. Work that appeared
          // between the two reads shows up in the job list — a report
          // delivered after the page read is a completed-but-unconsumed
          // job row, and a nested subagent spawned after it is a running
          // row — so the read order leaves nothing to the gap between
          // the reads; the page only ever rules out work that predates
          // it, and the job list rules in anything newer.
          const jobs = await this.listJobs(sessionId, opts);
          if (jobs === null) {
            // A failed read never settles (it would read as empty): the
            // tick repeats with a fresh job read, exactly like a failed
            // message read.
          } else if (jobs.length === 0) {
            return;
          } else {
            this.lastOpenReason = turnOpen([], jobs, userCreatedMs);
          }
        }
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) {
        await this.stopTurn(sessionId);
        const jobTrouble = this.jobReadFailure
          ? `; the background-job read kept failing (${this.jobReadFailure}) — the pairing may be broken`
          : "";
        throw new Error(
          `turn wait exceeded the ${this.turnBudgetSeconds}s budget for session ${sessionId}; the stuck turn was interrupted — last observed: ${this.lastOpenReason ?? "no settle information"}${jobTrouble}`,
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

  /**
   * The serve's job list for the session and its descendants, with the
   * shape the route answers verified against the v2.3.0 source
   * (packages/protocol/src/groups/job.ts: `GET /api/experimental/job`
   * returns `{ data: Array<Job.Info> }` with no cursor, and the client SDK
   * unwraps `.data`). The job list is the settle rule's third guard and
   * the pairing contract; it is the last read of each settle-candidate
   * tick, so the turn settles only on a list the serve actually answered
   * (returns null on a failed read — silence is never "empty"). The
   * package makes the serve/driver pairing true by construction, so an
   * absent endpoint is a broken pairing and fails named: treating the
   * absence as "no outstanding work" would reintroduce the early-settle
   * bug the barrier exists to prevent.
   */
  private async listJobs(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<JobRecord[] | null> {
    let jobs;
    try {
      jobs = await this.client.experimental.job.list(
        { sessionID: sessionId, descendants: true },
        { signal: opts?.signal },
      );
    } catch (error) {
      if ((error as { name?: unknown }).name === "AbortError") {
        throw error;
      }
      // Fail-named only when the pairing break is pinned to the 404 the
      // SDK can report: an unexpected 404 status. An undecodable body —
      // an HTML error page from anything between driver and serve, or
      // the paired serve's own bare 404 — surfaces through the SDK
      // without its status (verified: an empty-body 404 and an HTML 502
      // both arrive as the unsupported-content-type error), so it cannot
      // prove the 404 the pairing break needs, and it retries to the
      // poll budget like every transient read, where the budget error
      // carries the may-be-broken diagnosis.
      const err = error as { name?: unknown; reason?: unknown };
      if (err.name === "ClientError" && unexpectedStatus(error) === "404") {
        throw new Error(
          "this driver needs a serve with the job endpoint; the serve answered 404 — the pairing is broken",
        );
      }
      if (err.name === "SessionNotFoundError") {
        // The route's own typed session-gone answer: the route exists
        // and says the session is gone, like the message read would.
        throw new Error(
          `session ${sessionId} disappeared while waiting for the turn`,
        );
      }
      this.jobReadFailure = jobFailureLabel(error);
      return null;
    }
    this.jobReadFailure = null;
    return jobs.map((job) => ({ kind: job.kind, status: job.status }));
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
