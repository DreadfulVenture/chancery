/**
 * The read-only status surface: GET /status (the pinned JSON machine
 * contract) and GET / (the human page as one static HTML rendering, plus
 * the route's adapter-reachability probe). Loopback harness, hermetic:
 * the status db projection, the live session model, and the process's
 * own configuration are the sources the surface reads; the journal is
 * walked once at boot. /ui is retired — any other GET falls to 404.
 */

import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { makeReviewRequested } from "../src/adapters/forge-double.js";
import { consoleLogger, type Logger } from "../src/ctx.js";
import type { SessionDriver } from "../src/contracts/session.js";
import {
  appendJournal,
  capFailedDraft,
  FAILED_DRAFT_CAP,
  FAILED_DRAFT_TRUNCATION_MARKER,
  journalPath,
  type JournalLine,
  type JournalRecord,
  type ReviewRecord,
  type ReviewStartRecord,
} from "../src/journal.js";
import {
  composeTranscriptView,
  REVIEW_SLOTS,
  SESSION_LOG_GLANCE_CAP,
  TOOL_INPUT_CAP,
  TOOL_OUTPUT_CAP,
  TRANSCRIPT_TURN_MARKER,
  TRANSCRIPT_VIEW_CAP,
} from "../src/server.js";
import { StatusDb, statusDbPath } from "../src/status-db.js";
import { LiveSessions } from "../src/status.js";
import type { StatusData } from "../src/ui.js";
import {
  ADAPTER_TOKEN,
  EVENT_TOKEN,
  PR,
  REPO,
  happyScript,
  intakeUrl,
  postReviewEvent,
  startHarness,
  waitFor,
  type Harness,
} from "./helpers.js";

const harnesses: Harness[] = [];

async function harness(
  options: Parameters<typeof startHarness>[0],
): Promise<Harness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.handle.close()));
});

const capturingLog = (): { logger: Logger; lines: string[] } => {
  const lines: string[] = [];
  return {
    logger: {
      info: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
    lines,
  };
};

const fetchStatus = async (harness: Harness): Promise<StatusData> => {
  const response = await fetch(`${intakeUrl(harness)}/status`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as StatusData;
};

/** The rows the projection file holds, counted through plain SQL. */
const countRows = (path: string): number => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number })
      .n;
  } finally {
    db.close();
  }
};

/** Wrap the session driver so its first prompt parks on a gate. */
const gated =
  (gate: Promise<void>) =>
  (inner: SessionDriver): SessionDriver => ({
    createSession: (directory, agent, opts) =>
      inner.createSession(directory, agent, opts),
    prompt: (sessionId, text, opts) =>
      gate.then(() => inner.prompt(sessionId, text, opts)),
    readOutput: (sessionId, opts) => inner.readOutput(sessionId, opts),
    transcript: (sessionId, opts) => inner.transcript(sessionId, opts),
    dispose: (sessionId) => inner.dispose(sessionId),
  });

/**
 * Wrap the session driver so its transcript read hangs until the bound
 * aborts it: the promise settles only through the signal, so a test can
 * tell a cancelled read (the signal reached the driver) from an
 * abandoned one (the promise never settles).
 */
const hangingTranscript =
  (onAbort: () => void) =>
  (inner: SessionDriver): SessionDriver => ({
    createSession: (directory, agent, opts) =>
      inner.createSession(directory, agent, opts),
    prompt: (sessionId, text, opts) => inner.prompt(sessionId, text, opts),
    readOutput: (sessionId, opts) => inner.readOutput(sessionId, opts),
    transcript: (sessionId, opts) =>
      new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          onAbort();
          reject(new Error("the transcript read was aborted"));
        });
      }),
    dispose: (sessionId) => inner.dispose(sessionId),
  });

/** One terminal review record for a pre-seeded journal. */
const settledRecord = (
  n: number,
  verdict: string | undefined,
): ReviewRecord => ({
  ts: `2026-11-16T10:00:${String(n).padStart(2, "0")}.000Z`,
  type: "review",
  reviewId: `rev-${n}`,
  repo: REPO,
  pr: n,
  eventId: `evt-w${n}`,
  commentId: `c-${n}`,
  requester: "example-user",
  phases: [{ phase: "intake", durationMs: n }],
  inlineComments: 0,
  humanizer: { changed: false },
  ...(verdict === undefined ? {} : { verdict }),
  outcome: verdict === undefined ? "failed" : "posted",
  ...(verdict === undefined
    ? { failure: { stage: "blind", message: `run ${n} failed` } }
    : {}),
});

/** The posted shape, fattened to `body` bytes so the records are big. */
const fatRecord = (n: number, bodyChars: number): ReviewRecord => ({
  ts: `2026-11-16T11:00:${String(n).padStart(2, "0")}.000Z`,
  type: "review",
  reviewId: `rev-fat-${n}`,
  repo: REPO,
  pr: n,
  eventId: `evt-fat-${n}`,
  commentId: `c-${n}`,
  requester: "example-user",
  phases: [{ phase: "intake", durationMs: n }],
  inlineComments: 0,
  humanizer: { changed: false },
  verdict: "APPROVE",
  outcome: "posted",
  body: "x".repeat(bodyChars),
  comments: [],
  posted: { reviewCommentId: `rc-${n}`, commentRefs: [] },
});

describe("status surface", () => {
  it("GET /status serves the shape a completed run and the config produce", async () => {
    const h = await harness({ script: happyScript() });

    const before = await fetchStatus(h);
    expect(before.sessions).toEqual([]);
    expect(before.droppedStarts).toEqual({ count: 0, starts: [] });
    expect(before.runs).toEqual([]);

    await postReviewEvent(h);

    const body = await fetchStatus(h);
    expect(body.uptime.listenPort).toBe(h.handle.port);
    expect(body.uptime.adapterUrl).toBe("http://adapter.invalid");
    expect(typeof body.uptime.startedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.uptime.startedAt))).toBe(false);
    expect(body.uptime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.sessions).toEqual([]);

    // The config echo: counts, policy, timeouts — no token, no URLs with
    // credentials. The listen port is the configured one (0 = OS-assigned);
    // the bound one lives on the uptime line.
    expect(body.config).toEqual({
      listenPort: 0,
      allowedLogins: 2,
      allowedRepos: 0,
      retryPolicy: "never",
      reviewTimeoutSeconds: 1800,
      turnPollSeconds: 3,
      turnBudgetSeconds: 1800,
      agent: "zenigata-reviewer",
    });

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      repo: REPO,
      pr: PR,
      outcome: "posted",
      verdict: null,
    });
    expect(body.runs[0]?.failure).toBeUndefined();
    expect(body.runs[0]?.phases.map((phase) => phase.phase)).toEqual([
      "intake",
      "git",
      "review",
      "bookkeeping",
    ]);
    for (const phase of body.runs[0]?.phases ?? []) {
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    }

    expect(body.droppedStarts).toEqual({ count: 0, starts: [] });
  });

  it("carries no token anywhere in the /status payload", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);
    const response = await fetch(`${intakeUrl(h)}/status`);
    const body = await response.text();
    expect(body).not.toContain(EVENT_TOKEN);
    expect(body).not.toContain(ADAPTER_TOKEN);
  });

  it("shows a running review with its stage, then forgets it once settled", async () => {
    const h = await harness({ script: happyScript() });
    const releaseGets = h.forge.parkGetPullRequests();

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);
    await waitFor(() => h.forge.parkedGets === 1);

    const body = await fetchStatus(h);
    // The journaled start carries the identity fields; the live row adds
    // only the requester, the stage, and the timing. The event this boot
    // accepted is live, not a restart-dropped start.
    expect(body.sessions).toEqual([
      {
        eventId: event.eventId,
        repo: REPO,
        pr: PR,
        eventKind: "review_requested",
        requester: "example-user",
        commentId: event.commentId,
        stage: "intake",
        acceptedAt: expect.any(String),
        lastActivityAt: expect.any(String),
      },
    ]);
    expect(body.droppedStarts.count).toBe(0);

    // The page's NOW row names the run's age on its chip, from the
    // ledger's started stamp — while /status's pinned session shape
    // carries no started field at all.
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toMatch(/class="chip ok">running /);
    const statusText = await (await fetch(`${intakeUrl(h)}/status`)).text();
    expect(statusText).not.toContain("startedAtMs");

    releaseGets();
    await h.handle.awaitSettled(event.eventId);

    const settled = await fetchStatus(h);
    expect(settled.sessions).toEqual([]);
    expect(settled.runs[0]).toMatchObject({
      repo: REPO,
      pr: PR,
      outcome: "posted",
      verdict: null,
    });
  });

  it("shows the pipeline's own stage as the run moves", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const h = await harness({
      script: happyScript(),
      wrapSessions: gated(promptGate),
    });
    const releaseGets = h.forge.parkGetPullRequests();

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);
    await waitFor(() => h.forge.parkedGets === 1);

    const inIntake = await fetchStatus(h);
    expect(inIntake.sessions[0]?.stage).toBe("intake");

    releaseGets();
    // The run leaves the intake stage, crosses the git stage, and parks
    // in its one prompt; the surface's stage moves with it.
    const inReview = await waitFor(async () => {
      const body = await fetchStatus(h);
      return body.sessions.find((session) => session.stage === "review");
    });
    expect(inReview.stage).toBe("review");
    expect(inReview.lastActivityAt).not.toBe(inIntake.sessions[0]?.acceptedAt);

    releasePrompt();
    await h.handle.awaitSettled(event.eventId);
  });

  it("the running row carries its reviewer session's log once the pipeline created it (PRJ-538)", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const h = await harness({
      script: happyScript(),
      wrapSessions: gated(promptGate),
    });
    const releaseGets = h.forge.parkGetPullRequests();

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, event);
    await waitFor(() => h.forge.parkedGets === 1);

    // Parked in the intake stage, before the session exists: the log
    // cell names the fact.
    const before = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(before).toContain("no session yet");
    expect(before).not.toContain("session log</summary>");

    releaseGets();
    await waitFor(async () => {
      const body = await fetchStatus(h);
      return body.sessions.find((session) => session.stage === "review");
    });

    // The session exists now; its log is empty while the prompt is
    // parked, and the cell says so instead of implying a log.
    const during = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(during).toContain(
      "the session stands, but has recorded nothing yet",
    );

    releasePrompt();
    await h.handle.awaitSettled(event.eventId);
    // Settled: the live row is gone, so the cell rides the runs table's
    // failed-row transcript path instead — a posted run carries none.
    const after = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(after).toContain("Nothing running right now.");
  });

  it("the live log cell renders the log through the failed rows' own bounded read", async () => {
    // A run parked with its transcript recorded — the read hangs to the
    // bound and the cell names it, without hanging the page.
    let aborted = false;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const h = await harness({
      script: happyScript(),
      wrapSessions: (inner) =>
        hangingTranscript(() => {
          aborted = true;
        })(gated(promptGate)(inner)),
    });
    const releaseGets = h.forge.parkGetPullRequests();
    const event = makeReviewRequested({ repo: REPO, pr: PR });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, event);
    releaseGets();
    await waitFor(async () => {
      const body = await fetchStatus(h);
      return body.sessions.find((session) => session.stage === "review");
    });

    const started = Date.now();
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(aborted).toBe(true);
    expect(page).toContain("the log could not be read right now");

    releasePrompt();
    await h.handle.awaitSettled(event.eventId);
  });

  it("shows reviews queued behind a full review limiter", async () => {
    const h = await harness({
      script: happyScript(),
      extraPrs: Array.from({ length: REVIEW_SLOTS }, (_, i) => ({
        repo: REPO,
        pr: i + 2,
      })),
    });
    const releaseGets = h.forge.parkGetPullRequests();

    // Fill every slot and post one more: only the newest review queues.
    const events = Array.from({ length: REVIEW_SLOTS + 1 }, (_, i) =>
      makeReviewRequested({ repo: REPO, pr: i + 1 }),
    );
    for (const event of events) {
      const response = await h.source.postToIntake(
        intakeUrl(h),
        EVENT_TOKEN,
        event,
      );
      expect(response.status).toBe(202);
    }
    await waitFor(() => h.forge.parkedGets === REVIEW_SLOTS);

    const body = await fetchStatus(h);
    expect(body.sessions).toHaveLength(REVIEW_SLOTS + 1);
    // Running sessions sit in a pipeline stage; the queued one has not
    // entered the pipeline at all.
    const running = body.sessions.filter(
      (session) => session.stage !== "queued",
    );
    expect(running).toHaveLength(REVIEW_SLOTS);
    for (const session of running) {
      expect(session.stage).toBe("intake");
    }
    const queued = body.sessions.find((session) => session.stage === "queued");
    expect(queued?.pr).toBe(events[events.length - 1].pr);
    expect(body.droppedStarts.count).toBe(0);

    // The human page states parked versus running: the sessions in the
    // pipeline read running (green) — each chip carrying the run's age
    // from the ledger's started stamp — while the one queued behind the
    // limiter reads parked and names what it is waiting for.
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toMatch(/class="chip ok">running /);
    expect(page).toContain(`class="chip warn">parked</span>`);
    expect(page).toContain("waiting for a free review slot");

    releaseGets();
    await Promise.all(
      events.map((event) => h.handle.awaitSettled(event.eventId)),
    );
    const settled = await fetchStatus(h);
    expect(settled.sessions).toEqual([]);
    expect(settled.runs).toHaveLength(events.length);
  });

  it("reports the starts a restart dropped, with the journal's failure redacted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    const droppedStart = {
      ts: "2026-11-16T09:00:00.000Z",
      type: "review-start",
      eventId: "evt-dropped",
      repo: REPO,
      pr: 9,
      commentId: "c-9",
      eventKind: "review_requested",
    };
    // A terminal record with a credentialed URL in the failure message:
    // the projection must redact it, exactly as the composition sites do.
    const settled: ReviewRecord = {
      ts: "2026-11-16T10:00:00.000Z",
      type: "review",
      reviewId: "rev-done",
      repo: REPO,
      pr: PR,
      eventId: "evt-done",
      commentId: "c-1",
      requester: "example-user",
      phases: [],
      inlineComments: 0,
      humanizer: { changed: false },
      outcome: "failed",
      failure: {
        stage: "git",
        message: "clone https://user:hunter2-clone@forge.invalid/x failed",
      },
    };
    await appendJournal(journalPath(stateDir), droppedStart);
    await appendJournal(journalPath(stateDir), settled);

    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    const body = await fetchStatus(h);
    expect(body.droppedStarts.count).toBe(1);
    expect(body.droppedStarts.starts).toEqual([
      {
        eventId: "evt-dropped",
        repo: REPO,
        pr: 9,
        eventKind: "review_requested",
        acceptedAt: "2026-11-16T09:00:00.000Z",
      },
    ]);
    // The settled event closed its start: it is a run, not a dropped row,
    // and its failure message carries the URL without the credential.
    expect(body.runs[0]).toMatchObject({
      repo: REPO,
      pr: PR,
      outcome: "failed",
      failure: { stage: "git" },
    });
    const text = await (await fetch(`${intakeUrl(h)}/status`)).text();
    expect(text).toContain("https://forge.invalid/x failed");
    expect(text).not.toContain("hunter2-clone");
    expect(text).not.toContain(EVENT_TOKEN);
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toContain("restart dropped");
    expect(page).not.toContain("hunter2-clone");
  });

  it("redacts a credentialed adapter URL the configuration carried", async () => {
    const credentialed = await harness({
      script: happyScript(),
      env: {
        ZENIGATA_ADAPTER_URL:
          "https://zenigata-bot:hunter2-secret@forge.invalid/x",
      },
    });
    const body = await fetchStatus(credentialed);
    expect(body.uptime.adapterUrl).toBe("https://forge.invalid/x");
    const page = await (await fetch(`${intakeUrl(credentialed)}/`)).text();
    expect(page).toContain("https://forge.invalid/x");
    expect(page).not.toContain("hunter2-secret");
    expect(page).not.toContain(EVENT_TOKEN);

    const tokenInQuery = await harness({
      script: happyScript(),
      env: {
        ZENIGATA_ADAPTER_URL: "http://forge.invalid/x?token=shh-query-value",
      },
    });
    const body2 = await fetchStatus(tokenInQuery);
    expect(body2.uptime.adapterUrl).toBe(
      "http://forge.invalid/x?token=[redacted]",
    );
  });

  it("keeps the newest 10 review runs, newest first", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    for (let n = 1; n <= 12; n++) {
      await appendJournal(
        journalPath(stateDir),
        settledRecord(n, n % 2 === 0 ? undefined : "APPROVE"),
      );
    }
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    const body = await fetchStatus(h);
    expect(body.runs).toHaveLength(10);
    const prs = body.runs.map((run) => run.pr);
    expect(prs).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(body.runs[0]).toMatchObject({
      verdict: null,
      outcome: "failed",
      failure: { stage: "blind", message: "run 12 failed" },
    });
    expect(body.runs[1]).toMatchObject({
      verdict: "APPROVE",
      outcome: "posted",
    });
    expect(body.droppedStarts.count).toBe(0);
  });

  it("the runs table renders each settled run's wall time, and /status carries none", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    // Three walls the seeds make exact: a terminal-only record (start and
    // finish share the one stamp, so under a second), four hours on the
    // stamp pair, and five and a half minutes.
    await appendJournal(journalPath(stateDir), settledRecord(1, "APPROVE"));
    const wallStart = (eventId: string, ts: string): ReviewStartRecord => ({
      ts,
      type: "review-start",
      eventId,
      repo: REPO,
      pr: 1,
      commentId: "c-1",
      eventKind: "review_requested",
    });
    const wallTerminal = (
      eventId: string,
      pr: number,
      ts: string,
    ): ReviewRecord => ({
      ts,
      type: "review",
      reviewId: `rev-wall-${eventId}`,
      repo: REPO,
      pr,
      eventId,
      commentId: `c-${pr}`,
      requester: "example-user",
      phases: [],
      inlineComments: 0,
      humanizer: { changed: false },
      verdict: "APPROVE",
      outcome: "posted",
    });
    await appendJournal(
      journalPath(stateDir),
      wallStart("evt-wall-4h", "2026-11-16T09:00:00.000Z"),
    );
    await appendJournal(
      journalPath(stateDir),
      wallTerminal("evt-wall-4h", 2, "2026-11-16T13:00:00.000Z"),
    );
    await appendJournal(
      journalPath(stateDir),
      wallStart("evt-wall-330s", "2026-11-16T10:01:00.000Z"),
    );
    await appendJournal(
      journalPath(stateDir),
      wallTerminal("evt-wall-330s", 3, "2026-11-16T10:06:30.000Z"),
    );
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    // The runs table gains the wall column and renders the human form
    // each run's stamps make.
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toContain("<th>wall time</th>");
    expect(page).toContain(`class="muted">4h</span>`);
    expect(page).toContain(`class="muted">5m 30s</span>`);
    expect(page).toContain(`class="muted">&lt;1s</span>`);

    // The machine contract stays byte-shape pinned: no wall time on the wire.
    const body = await (await fetch(`${intakeUrl(h)}/status`)).text();
    expect(body).not.toContain("wallSeconds");
    expect(body).not.toContain("wall time");
  });

  it("a journal larger than the status window still yields the newest 10 runs, and a torn tail line skips by its number", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    // Twelve posted records at ~20 KiB each: the file outgrows the tail
    // window, so no single windowed read covers the whole runs window.
    for (let n = 1; n <= 12; n++) {
      await appendJournal(journalPath(stateDir), fatRecord(n, 20_000));
    }
    await writeFile(journalPath(stateDir), '{"ts":"2026-11-16T12:0', {
      flag: "a",
    });
    const captured = capturingLog();
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
      logger: captured.logger,
    });

    const body = await fetchStatus(h);
    expect(body.runs).toHaveLength(10);
    expect(body.runs.map((run) => run.pr)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
    ]);
    expect(body.droppedStarts.count).toBe(0);
    // The torn line is skipped, loudly, with its line number — never
    // silently, and without faulting a healthy record.
    expect(
      captured.lines.some((line) => line.includes("skipped: unparseable JSON")),
    ).toBe(true);
  });

  it("GET / serves the human page with no secrets, and /ui is retired", async () => {
    const h = await harness({ script: happyScript() });
    const releaseGets = h.forge.parkGetPullRequests();
    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const posted = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(posted.status).toBe(202);
    await waitFor(() => h.forge.parkedGets === 1);

    const response = await fetch(`${intakeUrl(h)}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("zenigata");
    expect(body).toContain(`${REPO}#${PR}`);
    expect(body).toContain("intake");
    expect(body).toContain("restart dropped");
    expect(body).not.toContain(EVENT_TOKEN);
    expect(body).not.toContain(ADAPTER_TOKEN);
    const retired = await fetch(`${intakeUrl(h)}/ui`);
    expect(retired.status).toBe(404);

    releaseGets();
    await h.handle.awaitSettled(event.eventId);
    // After the run settles, the runs table renders the outcome.
    const done = await fetch(`${intakeUrl(h)}/`);
    const rendered = await done.text();
    expect(rendered).toContain("posted");
  });

  it("the health line answers the adapter's reachability, checked at render", async () => {
    // The default harness points the adapter at a host that cannot
    // resolve: the human page reads unreachable while the JSON still
    // carries only the redacted URL.
    const down = await harness({ script: happyScript() });
    const downPage = await (await fetch(`${intakeUrl(down)}/`)).text();
    expect(downPage).toContain("adapter unreachable");
    expect(downPage).not.toContain("adapter reachable");

    // A local fake the test spins up itself answers on any path with any
    // status: the probe reads reachable, it asked for nothing sensitive,
    // and it arrived bare — no Authorization header of ours, ever.
    let lastAuth: string | undefined;
    let requests = 0;
    const fake = createServer((request, response) => {
      requests += 1;
      lastAuth = request.headers.authorization;
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const adapterPort = (fake.address() as AddressInfo).port;
    try {
      const up = await harness({
        script: happyScript(),
        env: { ZENIGATA_ADAPTER_URL: `http://127.0.0.1:${adapterPort}` },
      });
      const page = await (await fetch(`${intakeUrl(up)}/`)).text();
      expect(page).toContain("adapter reachable");
      expect(page).not.toContain("adapter unreachable");
      expect(requests).toBe(1);
      expect(lastAuth).toBeUndefined();
    } finally {
      fake.closeAllConnections();
      await new Promise((resolve) => fake.close(resolve));
    }
  });

  it("an adapter that accepts but never answers reads unreachable inside its bound", async () => {
    const hanging = createServer(() => {
      // Accepted, never answered: the probe gives up on its own bound.
    });
    await new Promise<void>((resolve) =>
      hanging.listen(0, "127.0.0.1", resolve),
    );
    const adapterPort = (hanging.address() as AddressInfo).port;
    try {
      const h = await harness({
        script: happyScript(),
        env: { ZENIGATA_ADAPTER_URL: `http://127.0.0.1:${adapterPort}` },
      });
      const started = Date.now();
      const response = await fetch(`${intakeUrl(h)}/`);
      expect(response.status).toBe(200);
      const waitedMs = Date.now() - started;
      // Bounded, not hung: the 1500ms probe gives up, the page answers.
      expect(waitedMs).toBeGreaterThanOrEqual(1400);
      expect(waitedMs).toBeLessThan(10_000);
      const page = await response.text();
      expect(page).toContain("adapter unreachable");
    } finally {
      hanging.closeAllConnections();
      await new Promise((resolve) => hanging.close(resolve));
    }
  }, 15_000);

  it("GET / renders the first screen for a human and carries no external asset", async () => {
    const h = await harness({ script: happyScript() });

    // Honest empty states on the fresh boot, before any run.
    const empty = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(empty).toContain("Nothing running right now.");
    expect(empty).toContain("No runs yet.");
    expect(empty).toContain("Every start the journal holds, settled.");

    await postReviewEvent(h);

    const body = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The read the operator makes at 2am arrives in this order: health
    // line, what is running, recent runs, dropped starts, the bot's own
    // narration, config echo.
    const positions = [
      "up ",
      "Running now",
      "Recent review runs",
      "restart dropped",
      "Bot narration",
      "Configuration",
    ].map((marker) => body.indexOf(marker));
    expect(positions).not.toContain(-1);
    for (let n = 1; n < positions.length; n++) {
      expect(positions[n]).toBeGreaterThan(positions[n - 1] ?? 0);
    }
    // The page depends on nothing outside this document: every link the
    // head carries is the favicon's data URI, and the one script is
    // inline — the browser notifications — with no src and no external
    // asset of any kind.
    expect(body.match(/<style>/g)).toHaveLength(1);
    expect(body.match(/<script/gi)).toHaveLength(1);
    for (const link of body.matchAll(/<link\b[^>]*>/gi)) {
      expect(link[0]).toMatch('rel="icon"');
      expect(link[0]).toMatch(/href="data:image\/svg\+xml,/);
    }
    expect(body).not.toContain("src=");
  });
});

describe("the page's forge links", () => {
  it("a live session's PR cell links into the forge and offers the re-request", async () => {
    const h = await harness({ script: happyScript() });
    const releaseGets = h.forge.parkGetPullRequests();
    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const posted = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(posted.status).toBe(202);
    await waitFor(() => h.forge.parkedGets === 1);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(
      page.includes(`<a href="https://forge.invalid/${REPO}/pulls/${PR}">`),
    ).toBe(true);
    // The affordance rides the live cell; one session, one affordance.
    expect((page.match(/request review again/g) ?? []).length).toBe(1);

    releaseGets();
    await h.handle.awaitSettled(event.eventId);
    // A settled run links too, without the affordance.
    const done = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(done).toContain(`href="https://forge.invalid/${REPO}/pulls/${PR}"`);
    expect(done).not.toContain("request review again");
  });

  it("a dropped start's row links into the forge and offers the re-request", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    await appendJournal(journalPath(stateDir), {
      ts: "2026-11-16T09:00:00.000Z",
      type: "review-start",
      eventId: "evt-dropped-link",
      repo: REPO,
      pr: 9,
      commentId: "c-9",
      eventKind: "review_requested",
    });
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toContain(
      `<a href="https://forge.invalid/${REPO}/pulls/9">${REPO}#9</a>`,
    );
    expect(page).toContain(">request review again</a>");
    // The copy names the control the rows now carry.
    expect(page).toContain(
      "A re-request re-runs them free: request review again on any row.",
    );
  });

  it("the machine contract gains nothing: no started stamp, no forge URL, no PR links, no narration on /status", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);
    const text = await (await fetch(`${intakeUrl(h)}/status`)).text();
    expect(text).not.toContain("startedAtMs");
    expect(text).not.toContain("forgeUrl");
    expect(text).not.toContain("forge.invalid");
    expect(text).not.toContain("pulls/");
    // The narration ring is a page-only input: neither its lines nor its
    // panel's note appears on the wire.
    expect(text).not.toContain("zenigata: intake listening");
    expect(text).not.toContain("held in memory since this boot");
    // The transcript views ride the same rule: no read, no note, no
    // session id on the wire.
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("sessionId");
  });
});

// ---------------------------------------------------------------------------
// The page's narration tail
// ---------------------------------------------------------------------------

describe("the page's narration tail", () => {
  it("renders the bot's narration since boot, with the memory-only store named", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);
    // A skipped run narrates a line of its own; a clean posted run
    // narrates nothing beyond the boot lines.
    await postReviewEvent(h, { requesterLogin: "stranger" });

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The boot's own narration is in the tail, exactly as journald
    // collected it — prefix and all.
    expect(page).toContain(
      `zenigata: intake listening on port ${h.handle.port}`,
    );
    // The skip's narration landed behind it.
    expect(page).toContain(
      `zenigata: skipped ${REPO}#${PR}: requester stranger is not in the allowed logins`,
    );
    // The note names the store's contract: in memory since this boot,
    // written nowhere, emptied by a restart. No log file is implied.
    expect(page).toContain("held in memory since this boot, written nowhere");
    expect(page).toContain("a restart empties it");
    // The narration is a leak surface like any other: no token rides it.
    expect(page).not.toContain(EVENT_TOKEN);
    expect(page).not.toContain(ADAPTER_TOKEN);
  });

  it("the reviewer session's turns stay out of the ring — the transcript view reads them through the driver instead", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The scripted session's own outputs ride the session driver, never
    // the logger: the ring holds narration alone. A posted run's
    // session reaches the page by no route — the transcript view reads
    // failed runs only.
    expect(page).not.toContain("names nothing; say what was added");
    expect(page).not.toContain("The case: two lines land");
  });
});

// ---------------------------------------------------------------------------
// The failed run's transcript view
// ---------------------------------------------------------------------------

describe("the failed run's transcript view", () => {
  /** A scripted run that fails: the reply carries no status line. */
  const failingScript = () => ["not json"];

  it("a retained failed run offers its reviewer session log while the session stands", async () => {
    const h = await harness({ script: failingScript() });
    await postReviewEvent(h);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The failure cell carries the collapsible transcript, oldest turn
    // first: the pipeline's own prompt, then the scripted reply.
    expect(page).toContain("reviewer session log");
    expect(page).toContain("user: ");
    expect(page).toContain("reviewer: not json");
    // The posted runs' cells stay exactly as they were.
    expect((page.match(/reviewer session log/g) ?? []).length).toBe(1);
  });

  it("a swept session degrades: the note names the fact without the sweeper", async () => {
    const h = await harness({
      script: failingScript(),
      // The sweep's window compare on a clock past the window: one
      // on-demand pass disposes the run's retained session.
      sweepNowMs: Date.now() + 100 * 24 * 60 * 60 * 1000,
    });
    await postReviewEvent(h);

    // The first view composes the standing session's transcript and
    // caches it; the sweep's disposal must invalidate that entry, or
    // the second view would render the stale transcript instead of the
    // gone note.
    const before = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(before).toContain("reviewer session log");

    await h.handle.sweep();
    expect(h.sessions.disposed).toHaveLength(1);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toContain(
      "the session is gone — the transcript is not available",
    );
    expect(page).not.toContain("reviewer session log");
  });

  it("a window-0 run tears its session down at settle and offers no transcript", async () => {
    const h = await harness({
      script: failingScript(),
      env: { ZENIGATA_RETENTION_WINDOW_SECONDS: "0" },
    });
    await postReviewEvent(h);
    // The immediate teardown ran, and the record carried no session id,
    // so the row offers no transcript block at all.
    expect(h.sessions.disposed).toHaveLength(1);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).not.toContain("reviewer session log");
    expect(page).not.toContain("transcript was swept");
  });

  it("a cap cut can never strand a credential: the newest turn is redacted before it is capped", async () => {
    // The raw turn is padded so the cap's cut lands between
    // "https://user:" and its "@": under cap-first the fragment carries
    // the scheme and the user with no "@" behind them, and neither
    // redaction pattern can match — the credential rides the open page.
    // The real order redacts the full text first, so the cut lands in
    // already-redacted text and the page carries only the host.
    const room =
      TRANSCRIPT_VIEW_CAP -
      Buffer.byteLength(TRANSCRIPT_TURN_MARKER, "utf8") -
      Buffer.byteLength("reviewer: ", "utf8");
    // " https://user:" is 14 bytes: the separating space plus the
    // scheme and user the cut keeps whole, the "@" just past it.
    const h = await harness({
      script: [
        `${"y".repeat(room - 14)} https://user:secretpw@forge.invalid/x failed`,
      ],
    });
    await postReviewEvent(h);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The transcript's own rendered line: extract it from the page —
    // the failed drafts panel beside it renders the raw model output by
    // PRJ-423's settled design, so the no-fragment assertions scope to
    // the transcript's pre block alone.
    const transcriptBody =
      /<pre class="transcript-body">([\s\S]*?)<\/pre>/.exec(page)?.[1] ?? "";
    expect(transcriptBody).not.toBe("");
    // The newest turn rendered, capped and marked: the boundary rule
    // kept it.
    expect(transcriptBody).toContain("reviewer: ");
    expect(transcriptBody).toContain(TRANSCRIPT_TURN_MARKER);
    // And no fragment of the raw credential rode it: the redaction ran
    // on the full text before the cut, so the cut landed in
    // already-redacted text.
    expect(transcriptBody).not.toContain("https://user");
    expect(transcriptBody).not.toContain("secretpw");
    expect(page).not.toContain("recorded no turns");
  });

  it("a newest turn capped mid-codepoint keeps the failure cell's transcript", async () => {
    // The unfixed cap cut mid-codepoint and the decoder paid the dangle
    // back as a 3-byte replacement character: the rendered line
    // exceeded the view cap by a byte, the composer dropped the newest
    // turn whole, and the cell reported a session that "recorded no
    // turns" — one whose newest turn was merely huge. The boundary
    // trim keeps the turn in place.
    const room =
      TRANSCRIPT_VIEW_CAP -
      Buffer.byteLength(TRANSCRIPT_TURN_MARKER, "utf8") -
      Buffer.byteLength("reviewer: ", "utf8");
    const h = await harness({
      script: [`x${"日".repeat(Math.ceil((room - 1) / 3))}`],
    });
    await postReviewEvent(h);

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).not.toContain("recorded no turns");
    const transcriptBody =
      /<pre class="transcript-body">([\s\S]*?)<\/pre>/.exec(page)?.[1] ?? "";
    expect(transcriptBody).toContain(TRANSCRIPT_TURN_MARKER);
    expect(transcriptBody).not.toContain("\uFFFD");
  });

  it("a second page view reuses the composed transcript: one driver read across the views", async () => {
    // The composed view is cached per session until the sweep
    // invalidates it: a failed run's session is frozen between settle
    // and sweep, so the second render serves the entry instead of
    // re-reading the driver.
    let reads = 0;
    const counting = (inner: SessionDriver): SessionDriver => ({
      createSession: (directory, agent, opts) =>
        inner.createSession(directory, agent, opts),
      prompt: (sessionId, text, opts) => inner.prompt(sessionId, text, opts),
      readOutput: (sessionId, opts) => inner.readOutput(sessionId, opts),
      transcript: (sessionId, opts) => {
        reads += 1;
        return inner.transcript(sessionId, opts);
      },
      dispose: (sessionId) => inner.dispose(sessionId),
    });
    const h = await harness({
      script: failingScript(),
      wrapSessions: counting,
    });
    await postReviewEvent(h);

    const first = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(first).toContain("reviewer session log");
    expect(reads).toBe(1);

    const second = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(second).toContain("reviewer session log");
    expect(reads).toBe(1);
  });

  it("the transcript read's bound cancels the read instead of abandoning it", async () => {
    let aborted = false;
    const h = await harness({
      script: failingScript(),
      wrapSessions: hangingTranscript(() => {
        aborted = true;
      }),
    });
    await postReviewEvent(h);

    const started = Date.now();
    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The page answers inside the bound's neighborhood, not hung.
    expect(Date.now() - started).toBeLessThan(10_000);
    // The read itself observed the abort: the contract's signal reached
    // the driver, so the bound cancelled the in-flight request.
    expect(aborted).toBe(true);
    expect(page).toContain("the transcript could not be read right now");
  });
});

// ---------------------------------------------------------------------------
// The transcript view's cap math
// ---------------------------------------------------------------------------

describe("the transcript view's cap math", () => {
  it("an oversized newest turn renders its capped line at the view cap exactly", () => {
    const view = composeTranscriptView([
      { role: "assistant", at: 0, text: "y".repeat(200_000) },
    ]);
    expect(view.state).toBe("found");
    expect(view.truncated).toBe(false);
    // The prefix is budgeted inside the cap: the rendered line totals
    // the view cap once, never over it.
    expect(Buffer.byteLength(view.text, "utf8")).toBe(TRANSCRIPT_VIEW_CAP);
    expect(view.text.startsWith("reviewer: ")).toBe(true);
    expect(view.text.endsWith(TRANSCRIPT_TURN_MARKER)).toBe(true);
  });

  it("an oversized newest turn cut mid-codepoint renders at or under the view cap", () => {
    // The one-byte spacer shifts the three-byte codepoints so the cap's
    // cut lands inside one. The unfixed cap paid the dangle back as a
    // 3-byte replacement character — the rendered line exceeded the
    // view cap, the composer dropped the newest turn whole, and the
    // failure cell reported "recorded no turns" about a session whose
    // newest turn was merely huge.
    const room =
      TRANSCRIPT_VIEW_CAP -
      Buffer.byteLength(TRANSCRIPT_TURN_MARKER, "utf8") -
      Buffer.byteLength("reviewer: ", "utf8");
    const view = composeTranscriptView([
      {
        role: "assistant",
        at: 0,
        text: `x${"日".repeat(Math.ceil((room - 1) / 3))}`,
      },
    ]);
    expect(view.state).toBe("found");
    expect(view.truncated).toBe(false);
    expect(view.text.length).toBeGreaterThan(0);
    // The prefix is budgeted inside the cap and the boundary trim drops
    // the partial codepoint: the rendered line totals at or under the
    // view cap once, never over it.
    expect(Buffer.byteLength(view.text, "utf8")).toBeLessThanOrEqual(
      TRANSCRIPT_VIEW_CAP,
    );
    expect(view.text.startsWith("reviewer: ")).toBe(true);
    expect(view.text.endsWith(TRANSCRIPT_TURN_MARKER)).toBe(true);
    expect(view.text).not.toContain("\uFFFD");
  });

  it("older turns drop whole once the newest capped line fills the cap", () => {
    const view = composeTranscriptView([
      { role: "user", at: 0, text: "the older prompt" },
      { role: "assistant", at: 0, text: "y".repeat(200_000) },
    ]);
    expect(view.truncated).toBe(true);
    expect(view.text).not.toContain("the older prompt");
    expect(Buffer.byteLength(view.text, "utf8")).toBe(TRANSCRIPT_VIEW_CAP);
  });

  it("a view under the cap keeps every turn and claims no truncation", () => {
    const view = composeTranscriptView([
      { role: "user", at: 0, text: "prompt" },
      { role: "assistant", at: 0, text: "reply" },
    ]);
    expect(view.truncated).toBe(false);
    expect(view.text).toBe("user: prompt\n\nreviewer: reply");
  });

  it("an unstamped turn renders bare, and a stamped one carries its local time (PRJ-538)", () => {
    const view = composeTranscriptView([
      { role: "user", at: 0, text: "prompt" },
      // A fixed epoch whose local rendering the assertion reads back
      // off the page's own clock — the stamp is the server's local time.
      { role: "assistant", at: 1_700_000_000_000, text: "reply" },
    ]);
    expect(view.text).toContain("user: prompt\n\n");
    expect(view.text).toMatch(/\[\d{2}:\d{2}:\d{2}\] reviewer: reply$/);
  });

  it("a tool turn renders its block: status, input, output, error", () => {
    const view = composeTranscriptView([
      {
        role: "tool",
        at: 0,
        name: "bash",
        status: "completed",
        input: '{"command":"git log -1"}',
        output: "abc the head",
      },
      {
        role: "tool",
        at: 0,
        name: "read",
        status: "error",
        input: '{"path":"src/x.ts"}',
        output: "",
        error: "file not found",
      },
    ]);
    expect(view.text).toContain(
      'tool bash — completed\n    input: {"command":"git log -1"}\n    output: abc the head',
    );
    expect(view.text).toContain(
      'tool read — error\n    input: {"path":"src/x.ts"}\n    error: file not found',
    );
    // No output line on a tool without one, no error line on a success.
    expect(view.text).not.toContain("    error: undefined");
  });

  it("a subagent report renders under its own prefix", () => {
    const view = composeTranscriptView([
      { role: "report", at: 0, text: "the blind pass found nothing" },
    ]);
    expect(view.text).toBe("report: the blind pass found nothing");
  });

  it("a tool output's credential is redacted before the cap cuts it", () => {
    // The credentialed-URL rule holds per piece: the redaction runs on
    // the full tool output first, so the capped head can only carry
    // already-redacted text — no scheme://user fragment without its @.
    const raw = `head https://user:secretpw@forge.invalid/x ${"y".repeat(TOOL_OUTPUT_CAP)}`;
    const view = composeTranscriptView([
      {
        role: "tool",
        at: 0,
        name: "bash",
        status: "completed",
        input: "",
        output: raw,
      },
    ]);
    expect(view.text).not.toContain("https://user");
    expect(view.text).not.toContain("secretpw");
    expect(view.text).toContain("forge.invalid/x");
  });

  it("a huge tool piece is capped to its own budget, not the view's", () => {
    const view = composeTranscriptView([
      {
        role: "tool",
        at: 0,
        name: "bash",
        status: "completed",
        input: '{"command":"' + "z".repeat(5000) + '"}',
        output: "y".repeat(5000),
      },
    ]);
    // Input line under TOOL_INPUT_CAP, output line under TOOL_OUTPUT_CAP:
    // one tool cannot eat the view and strand every older turn.
    const inputLine = /    input: .*/.exec(view.text)?.[0] ?? "";
    const outputLine = /    output: .*/.exec(view.text)?.[0] ?? "";
    expect(Buffer.byteLength(inputLine, "utf8")).toBeLessThanOrEqual(
      TOOL_INPUT_CAP + 32,
    );
    expect(Buffer.byteLength(outputLine, "utf8")).toBeLessThanOrEqual(
      TOOL_OUTPUT_CAP + 32,
    );
    expect(view.text).toContain("[cut at the page's cap]");
  });

  it("latest carries the newest turn's first line, capped for the glance", () => {
    const view = composeTranscriptView([
      { role: "user", at: 0, text: "prompt" },
      {
        role: "tool",
        at: 0,
        name: "bash",
        status: "running",
        input: '{"command":"long build"}',
        output: "",
      },
    ]);
    expect(view.latest).toBe("tool bash — running");
    const view2 = composeTranscriptView([
      { role: "assistant", at: 0, text: "y".repeat(500) },
    ]);
    // The glance stays short even when the newest line is huge.
    expect(Buffer.byteLength(view2.latest ?? "", "utf8")).toBeLessThanOrEqual(
      SESSION_LOG_GLANCE_CAP,
    );
  });
});

// ---------------------------------------------------------------------------
// The live session ledger
// ---------------------------------------------------------------------------

/** One journaled start record for the ledger's unit fixtures. */
const ledgerStart = (eventId: string): ReviewStartRecord => ({
  ts: "2026-11-16T09:00:00.000Z",
  type: "review-start",
  eventId,
  repo: REPO,
  pr: 9,
  commentId: "c-9",
  eventKind: "review_requested",
});

/** A Clock the test moves in whole steps, so each stamp is a known value. */
const ledgerClock = () => {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("the live session ledger", () => {
  it("stamps the started moment once, at the first stage entry, and later entries never move it", () => {
    const clock = ledgerClock();
    const ledger = new LiveSessions(clock);
    const event = makeReviewRequested({ repo: REPO, pr: 9 });
    ledger.accept(event, ledgerStart(event.eventId), clock.now());

    // Parked: the row carries no started stamp — the queue has not let
    // go, and the page can claim nothing older than the accepted moment.
    const parked = ledger.viewsWithStartedAt();
    expect(parked).toHaveLength(1);
    expect(parked[0]?.stage).toBe("queued");
    expect(parked[0]?.startedAtMs).toBeUndefined();
    expect(parked[0]?.acceptedAt).toBe("2026-11-16T09:00:00.000Z");

    // The first stage entry stamps the transition out of the queue...
    clock.advance(60_000);
    ledger.markStage(event.eventId, "intake");
    expect(ledger.viewsWithStartedAt()[0]?.startedAtMs).toBe(1_060_000);

    // ...and a later entry moves the stage and the activity, never the
    // started stamp.
    clock.advance(30_000);
    ledger.markStage(event.eventId, "blind");
    const running = ledger.viewsWithStartedAt()[0];
    expect(running?.startedAtMs).toBe(1_060_000);
    expect(running?.stage).toBe("blind");
    expect(running?.lastActivityAt).toBe(new Date(1_090_000).toISOString());
  });

  it("views() — the machine contract's read — stays the pinned nine keys, no started stamp among them", () => {
    const clock = ledgerClock();
    const ledger = new LiveSessions(clock);
    const event = makeReviewRequested({ repo: REPO, pr: 9 });
    ledger.accept(event, ledgerStart(event.eventId), clock.now());
    ledger.markStage(event.eventId, "intake");

    const rows = ledger.views();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "eventId",
      "repo",
      "pr",
      "eventKind",
      "requester",
      "commentId",
      "stage",
      "acceptedAt",
      "lastActivityAt",
    ]);
  });

  it("a stage mark for an unknown event id marks nothing, and a release empties the ledger", () => {
    const clock = ledgerClock();
    const ledger = new LiveSessions(clock);
    const event = makeReviewRequested({ repo: REPO, pr: 9 });
    ledger.accept(event, ledgerStart(event.eventId), clock.now());
    ledger.markStage("evt-unknown", "intake");
    expect(ledger.viewsWithStartedAt()[0]?.startedAtMs).toBeUndefined();
    ledger.release(event.eventId);
    expect(ledger.views()).toHaveLength(0);
  });

  it("markSession puts the reviewer session's id on the row — the page's log key, outside the machine contract (PRJ-538)", () => {
    const clock = ledgerClock();
    const ledger = new LiveSessions(clock);
    const event = makeReviewRequested({ repo: REPO, pr: 9 });
    ledger.accept(event, ledgerStart(event.eventId), clock.now());
    // Before the session exists the row carries none.
    expect(ledger.viewsWithStartedAt()[0]?.sessionId).toBeUndefined();
    ledger.markStage(event.eventId, "review");
    ledger.markSession(event.eventId, "ses-fake-1");
    expect(ledger.viewsWithStartedAt()[0]?.sessionId).toBe("ses-fake-1");
    // The machine contract's views stay pinned nine keys.
    expect(Object.keys(ledger.views()[0] ?? {})).toEqual([
      "eventId",
      "repo",
      "pr",
      "eventKind",
      "requester",
      "commentId",
      "stage",
      "acceptedAt",
      "lastActivityAt",
    ]);
    // A re-run's fresh session overwrites the id.
    ledger.markSession(event.eventId, "ses-fake-2");
    expect(ledger.viewsWithStartedAt()[0]?.sessionId).toBe("ses-fake-2");
  });

  it("a markSession for an unknown event id marks nothing", () => {
    const clock = ledgerClock();
    const ledger = new LiveSessions(clock);
    const event = makeReviewRequested({ repo: REPO, pr: 9 });
    ledger.accept(event, ledgerStart(event.eventId), clock.now());
    ledger.markSession("evt-unknown", "ses-fake-1");
    expect(ledger.viewsWithStartedAt()[0]?.sessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The status db projection
// ---------------------------------------------------------------------------

/** One journaled start for the projection's unit fixtures. */
const unitStart = (eventId: string, ts: string): JournalRecord => ({
  ts,
  type: "review-start",
  eventId,
  repo: REPO,
  pr: 9,
  commentId: "c-9",
  eventKind: "review_requested",
});

/** One terminal review record for the projection's unit fixtures. */
const unitTerminal = (
  eventId: string,
  ts: string,
  over: Partial<ReviewRecord> = {},
): ReviewRecord => ({
  ts,
  type: "review",
  reviewId: `rev-${eventId}`,
  repo: REPO,
  pr: 9,
  eventId,
  commentId: "c-9",
  requester: "example-user",
  phases: [{ phase: "intake", durationMs: 3 }],
  inlineComments: 0,
  humanizer: { changed: false },
  outcome: "posted",
  ...over,
});

/** Walk-shaped lines, as the boot walk yields them. */
const asLines = (values: unknown[]): JournalLine[] =>
  values.map((value, index) => ({
    line: index + 1,
    label: `journal line ${index + 1}`,
    value,
  }));

/** The projection's raw row state, read through plain SQL. */
const states = (path: string): Array<Record<string, unknown>> => {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT * FROM runs").all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
};

const projectionClock = () => {
  let now = 1731753600000;
  return { now: () => now++ };
};

describe("status db projection", () => {
  it("the typed schema the module serves mirrors the table the CREATE statement builds", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    try {
      const file = new DatabaseSync(statusDbPath(stateDir));
      try {
        // The column set, in order, with the nullability and the key the
        // drizzle schema expects: name, type, NOT NULL flag, PK flag.
        const columns = file.prepare("PRAGMA table_info(runs)").all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>;
        expect(
          columns.map(({ name, type, notnull, pk }) => ({
            name,
            type,
            notnull,
            pk,
          })),
        ).toEqual([
          { name: "eventId", type: "TEXT", notnull: 0, pk: 1 },
          { name: "repo", type: "TEXT", notnull: 1, pk: 0 },
          { name: "pr", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "commentId", type: "TEXT", notnull: 0, pk: 0 },
          { name: "eventKind", type: "TEXT", notnull: 0, pk: 0 },
          { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
          { name: "state", type: "TEXT", notnull: 1, pk: 0 },
          { name: "verdict", type: "TEXT", notnull: 0, pk: 0 },
          { name: "outcome", type: "TEXT", notnull: 0, pk: 0 },
          { name: "startedAt", type: "TEXT", notnull: 1, pk: 0 },
          { name: "finishedAt", type: "TEXT", notnull: 0, pk: 0 },
          { name: "lastStage", type: "TEXT", notnull: 0, pk: 0 },
          { name: "stages", type: "TEXT", notnull: 0, pk: 0 },
          { name: "failureStage", type: "TEXT", notnull: 0, pk: 0 },
          { name: "failureMessage", type: "TEXT", notnull: 0, pk: 0 },
          { name: "failedDrafts", type: "TEXT", notnull: 0, pk: 0 },
          { name: "sessionId", type: "TEXT", notnull: 0, pk: 0 },
          { name: "updatedAt", type: "TEXT", notnull: 1, pk: 0 },
        ]);
        // The idempotency contract rides on the unique key: the primary
        // key the replay tests exercise exists as a unique index on
        // eventId, and only on eventId.
        const key = file
          .prepare(
            "SELECT name, \"unique\" FROM pragma_index_list('runs') WHERE origin = 'pk'",
          )
          .get() as { name: string; unique: number } | undefined;
        expect(key?.unique).toBe(1);
        const keyColumn = key
          ? (file
              .prepare(`SELECT name FROM pragma_index_info('${key.name}')`)
              .get() as { name: string } | undefined)
          : undefined;
        expect(keyColumn?.name).toBe("eventId");
      } finally {
        file.close();
      }
    } finally {
      db.close();
    }
  });

  it("a runs table from an older build gains its missing drafts column at open and takes a failed record with drafts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const path = statusDbPath(stateDir);

    // The pre-drafts table, built by hand exactly as the older build's
    // CREATE made it, already holding one settled row.
    const older = new DatabaseSync(path);
    try {
      older.exec(`
        CREATE TABLE runs (
          eventId        TEXT PRIMARY KEY,
          repo           TEXT NOT NULL,
          pr             INTEGER NOT NULL,
          commentId      TEXT,
          eventKind      TEXT,
          kind           TEXT NOT NULL,
          state          TEXT NOT NULL,
          verdict        TEXT,
          outcome        TEXT,
          startedAt      TEXT NOT NULL,
          finishedAt     TEXT,
          lastStage      TEXT,
          stages         TEXT,
          failureStage   TEXT,
          failureMessage TEXT,
          updatedAt      TEXT NOT NULL
        )`);
      older.exec(`
        INSERT INTO runs (eventId, repo, pr, kind, state, startedAt, updatedAt)
        VALUES ('evt-older', '${REPO}', 9, 'review', 'done',
                '2026-11-16T09:00:00.000Z', '2026-11-16T09:00:00.000Z')`);
    } finally {
      older.close();
    }

    const captured = capturingLog();
    const db = new StatusDb({
      path,
      logger: captured.logger,
      clock: projectionClock(),
    });
    try {
      // The open named its migration.
      expect(
        captured.lines.some((line) =>
          line.includes(
            "the status db migrated its runs table: added failedDrafts",
          ),
        ),
      ).toBe(true);

      // The migrated table takes the newer write — no no-such-column.
      db.apply(
        unitTerminal("evt-migrated", "2026-11-16T10:00:00.000Z", {
          outcome: "failed",
          failure: {
            stage: "context",
            message: "context draft failed validation twice",
          },
          failedDrafts: [
            {
              stage: "context",
              attempt: 0,
              reply: '{"verdict":',
              parseError: "unexpected end of JSON",
            },
          ],
        }),
        "the failed review record",
      );
      const pageRows = db.recentRunsWithWallTime();
      const migrated = pageRows.find((row) => row.failedDrafts !== undefined);
      expect(migrated?.failedDrafts).toEqual([
        {
          stage: "context",
          attempt: 0,
          reply: '{"verdict":',
          parseError: "unexpected end of JSON",
          truncated: false,
        },
      ]);

      // The pre-existing row survived the migration untouched.
      expect(states(path).find((row) => row.eventId === "evt-older")).toEqual(
        expect.objectContaining({ state: "done" }),
      );

      // A second open re-checks and adds nothing — the migration is
      // idempotent, and no second migration line appears.
      const reopenLog = capturingLog();
      const reopened = new StatusDb({
        path,
        logger: reopenLog.logger,
        clock: projectionClock(),
      });
      reopened.close();
      expect(
        reopenLog.lines.filter((line) =>
          line.includes("the status db migrated its runs table"),
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a PRJ-428-era review record whose dropped comments carry no source still projects (PRJ-442)", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    try {
      // The record shape PRJ-428 wrote: droppedComments entries without
      // the `source` field PRJ-440 later made required. The projection
      // validates only the fields it consumes, so the row reads and
      // settles instead of being refused.
      const reason = db.apply(
        {
          ts: "2026-11-16T09:00:00.000Z",
          type: "review",
          reviewId: "rev-pre-source",
          repo: REPO,
          pr: 9,
          eventId: "evt-pre-source",
          commentId: "c-9",
          requester: "example-user",
          phases: [{ phase: "intake", durationMs: 3 }],
          inlineComments: 0,
          humanizer: { changed: false },
          outcome: "failed",
          failure: {
            stage: "context",
            message: "context draft failed validation twice",
          },
          droppedComments: [
            {
              path: "notes.md",
              line: 99,
              reason:
                "comment on notes.md line 99 is outside the diff's changed lines",
              body: "Agent-generated:\n\nissue (blocking): this line does not exist in the diff.",
            },
          ],
        },
        "the pre-source record",
      );
      expect(reason).toBeNull();
      expect(
        states(statusDbPath(stateDir)).find(
          (row) => row.eventId === "evt-pre-source",
        ),
      ).toEqual(
        expect.objectContaining({ state: "failed", outcome: "failed" }),
      );
    } finally {
      db.close();
    }
  });

  it("settles one event's start and terminal records into one row, and an exact replay changes nothing", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    const startTs = "2026-11-16T09:00:00.000Z";
    db.apply(unitStart("evt-merge", startTs), "the accepted-start record");

    // The opened run is a 'running' row no status read surfaces yet.
    expect(states(statusDbPath(stateDir))).toEqual([
      expect.objectContaining({
        state: "running",
        startedAt: startTs,
        lastStage: "queued",
        finishedAt: null,
      }),
    ]);
    expect(db.recentRuns()).toEqual([]);

    const terminalTs = "2026-11-16T09:05:00.000Z";
    const terminal = unitTerminal("evt-merge", terminalTs, {
      phases: [
        { phase: "intake", durationMs: 3 },
        { phase: "blind", durationMs: 40 },
      ],
    });
    db.apply(terminal, "the review record");
    db.apply(terminal, "the review record");

    expect(countRows(statusDbPath(stateDir))).toBe(1);
    expect(db.recentRuns()).toHaveLength(1);
    expect(db.recentRuns()[0]).toEqual({
      ts: startTs,
      repo: REPO,
      pr: 9,
      outcome: "posted",
      verdict: null,
      phases: [
        { phase: "intake", durationMs: 3 },
        { phase: "blind", durationMs: 40 },
      ],
      failure: undefined,
    });
    db.close();
  });

  it("a replayed or re-accepted start never unsettles a settled row, and a real terminal after it still re-settles", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // The 2am shape: a failed run settled, the event's redelivery was
    // re-accepted under retryPolicy "once", and the fresh start landed
    // before the retry's own terminal ever did. The settled row keeps
    // its outcome, verdict, and finish — the run keeps answering.
    const failedTs = "2026-11-16T10:00:00.000Z";
    db.apply(
      unitTerminal("evt-once-more", failedTs, {
        outcome: "failed",
        failure: { stage: "blind", message: "first run failed" },
      }),
      "the failed review record",
    );
    db.apply(
      unitStart("evt-once-more", "2026-11-16T10:01:00.000Z"),
      "the replayed start record",
    );
    expect(
      states(statusDbPath(stateDir)).find(
        (row) => row.eventId === "evt-once-more",
      ),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        outcome: "failed",
        verdict: null,
        startedAt: failedTs,
        finishedAt: failedTs,
        failureStage: "blind",
      }),
    );

    // Terminal-after-settled, deliberately: the retry's own terminal
    // re-sets the row it re-ran.
    db.apply(
      unitTerminal("evt-once-more", "2026-11-16T10:05:00.000Z", {
        outcome: "posted",
        verdict: "APPROVE",
      }),
      "the retry's review record",
    );
    expect(
      states(statusDbPath(stateDir)).find(
        (row) => row.eventId === "evt-once-more",
      ),
    ).toEqual(
      expect.objectContaining({
        state: "done",
        outcome: "posted",
        verdict: "APPROVE",
        failureStage: null,
      }),
    );
    db.close();
  });

  it("one bad line rolls the whole backfill back: the projection stays empty and the next walk retries for free", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const captured = capturingLog();
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: captured.logger,
      clock: projectionClock(),
    });

    // A valid start and terminal land before the bad line: without the
    // transaction they would survive a half-filled walk the emptiness
    // gate then refuses to repair.
    const bad = {
      ts: "2026-11-16T09:02:00.000Z",
      type: "review",
      reviewId: "rev-bad",
      repo: REPO,
      pr: "nine",
      outcome: "posted",
    };
    const lines = asLines([
      unitStart("evt-b2", "2026-11-16T09:00:00.000Z"),
      unitTerminal("evt-b2", "2026-11-16T09:01:00.000Z"),
      bad,
      unitTerminal("evt-b3", "2026-11-16T09:03:00.000Z"),
    ]);
    expect(db.backfill(lines)).toBe(0);
    expect(countRows(statusDbPath(stateDir))).toBe(0);
    expect(
      captured.lines.some((line) =>
        line.includes(
          "the status db backfill rolled back every row of its walk (stopped at journal line 3 of 4, reason: review record failed validation at pr",
        ),
      ),
    ).toBe(true);

    // The db is empty again, so the next boot's walk retries — and lands.
    const retry = asLines([
      unitStart("evt-retry", "2026-11-16T09:10:00.000Z"),
      unitTerminal("evt-retry", "2026-11-16T09:11:00.000Z"),
    ]);
    expect(db.backfill(retry)).toBe(1);
    expect(countRows(statusDbPath(stateDir))).toBe(1);
    db.close();
  });

  it("a refused replay's skipped record never demotes a settled row, while a real retry settlement does", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // A posted run, then the same event replayed and refused: the refusal
    // (outcome skipped, stage intake) writes a journal record but must
    // not rewrite the settlement's row.
    db.apply(
      unitTerminal("evt-replay", "2026-11-16T10:00:00.000Z"),
      "the review record",
    );
    db.apply(
      unitTerminal("evt-replay", "2026-11-16T10:01:00.000Z", {
        outcome: "skipped",
        failure: { stage: "intake", message: "refused the redelivery" },
      }),
      "the skipped review record",
    );
    expect(db.recentRuns()[0]).toEqual(
      expect.objectContaining({ outcome: "posted", verdict: null }),
    );

    // A settled row only yields to a real settlement — the retry policy's
    // one re-run of a failed event.
    db.apply(
      unitTerminal("evt-once", "2026-11-16T11:00:00.000Z", {
        outcome: "failed",
        failure: { stage: "blind", message: "first run failed" },
      }),
      "the review record",
    );
    db.apply(
      unitTerminal("evt-once", "2026-11-16T11:02:00.000Z", {
        outcome: "posted",
        verdict: "APPROVE",
      }),
      "the retry's review record",
    );
    const rows = states(statusDbPath(stateDir));
    const retried = rows.find((row) => row.eventId === "evt-once");
    expect(retried).toEqual(
      expect.objectContaining({
        state: "done",
        outcome: "posted",
        verdict: "APPROVE",
        failureStage: null,
      }),
    );
    // And a refused replay of that failed event leaves it settled.
    db.apply(
      unitTerminal("evt-once", "2026-11-16T11:03:00.000Z", {
        outcome: "skipped",
        failure: { stage: "intake", message: "refused again" },
      }),
      "the skipped review record",
    );
    expect(
      states(statusDbPath(stateDir)).find((row) => row.eventId === "evt-once"),
    ).toEqual(expect.objectContaining({ outcome: "posted" }));
    db.close();
  });

  it("the terminal record's retained session id rides the row, and a replayed start never unsets it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    db.apply(
      unitStart("evt-ses", "2026-11-16T09:00:00.000Z"),
      "the accepted-start record",
    );
    // The running row never surfaces; only the settled one carries the
    // session id the page reads the transcript through.
    expect(db.recentRunsWithWallTime()).toEqual([]);
    db.apply(
      unitTerminal("evt-ses", "2026-11-16T09:05:00.000Z", {
        outcome: "failed",
        failure: { stage: "blind", message: "boom" },
        sessionId: "ses-reviewer-1",
      }),
      "the failed review record",
    );
    expect(db.recentRunsWithWallTime()[0]?.sessionId).toBe("ses-reviewer-1");
    // A replayed start carries no session of its own and must not
    // unsettle the settled row's id.
    db.apply(
      unitStart("evt-ses", "2026-11-16T09:06:00.000Z"),
      "the replayed start record",
    );
    expect(db.recentRunsWithWallTime()[0]?.sessionId).toBe("ses-reviewer-1");
    db.close();
  });

  it("a run that arrives without a start keys per run, and equal start times order by arrival", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // A record predating identities keys on its own review id: two runs
    // of it stay two rows.
    db.apply(
      unitTerminal("evt-old", "2026-11-16T10:00:00.000Z", {
        eventId: undefined,
      }),
      "the legacy review record",
    );
    expect(states(statusDbPath(stateDir))).toHaveLength(1);

    // Two settled runs sharing a start moment: the later arrival renders
    // first (rowid breaks the tie), never an arbitrary one.
    const sameTs = "2026-11-16T10:01:00.000Z";
    db.apply(
      unitTerminal("evt-tie-a", sameTs, {
        outcome: "posted",
        verdict: "APPROVE",
      }),
      "the first tie record",
    );
    db.apply(
      unitTerminal("evt-tie-b", sameTs, {
        outcome: "failed",
        failure: { stage: "blind", message: "boom" },
      }),
      "the second tie record",
    );
    const window = db.recentRuns();
    // Newest first, ties broken by arrival: the two same-moment records
    // first, the older per-run row behind them.
    expect(window.map((run) => run.outcome)).toEqual([
      "failed",
      "posted",
      "posted",
    ]);
    db.close();
  });

  it("backfill syncs an empty projection from the boot walk exactly once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const journalRecords: JournalRecord[] = [
      unitStart("evt-b1", "2026-11-16T09:00:00.000Z"),
      unitTerminal("evt-b1", "2026-11-16T09:05:00.000Z"),
    ];
    for (const record of journalRecords) {
      await appendJournal(journalPath(stateDir), record);
    }
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    const lines = asLines(journalRecords);

    // The return counts the rows the walk landed, not the lines it was
    // fed: a start and its terminal are one row.
    expect(db.backfill(lines)).toBe(1);
    expect(countRows(statusDbPath(stateDir))).toBe(1);
    // A projection that already holds rows never syncs again: a second
    // boot walk (or a re-walk) applies nothing.
    expect(db.backfill(lines)).toBe(0);
    expect(countRows(statusDbPath(stateDir))).toBe(1);
    db.close();
  });

  it("a failed projection write logs its label and moves on, and never throws", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const captured: string[] = [];
    const logger: Logger = {
      info: () => {},
      error: (message) => captured.push(message),
    };
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger,
      clock: projectionClock(),
    });
    db.close();

    expect(() =>
      db.apply(
        unitTerminal("evt-after-close", "2026-11-16T10:00:00.000Z"),
        "the closed db write",
      ),
    ).not.toThrow();
    expect(
      captured.some((line) =>
        line.includes("skipped: the status db is closed"),
      ),
    ).toBe(true);
    expect(countRows(statusDbPath(stateDir))).toBe(0);
  });

  it("the page's runs read derives each settled run's wall time, and the machine contract's read stays the pinned shape", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // A run the projection saw from its start: five minutes on the wall.
    db.apply(
      unitStart("evt-wall-a", "2026-11-16T09:00:00.000Z"),
      "the accepted-start record",
    );
    db.apply(
      unitTerminal("evt-wall-a", "2026-11-16T09:05:00.000Z"),
      "the review record",
    );
    // A record predating identities: terminal-only, its row's start and
    // finish share the one stamp, and the run's wall is zero.
    db.apply(
      unitTerminal("evt-wall-b", "2026-11-16T10:00:00.000Z"),
      "the legacy review record",
    );

    // The page read, newest first: each row carrying the wall time its
    // own stamps make.
    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows.map((run) => run.wallSeconds)).toEqual([0, 300]);
    expect(pageRows[1]).toEqual({
      ts: "2026-11-16T09:00:00.000Z",
      repo: REPO,
      pr: 9,
      outcome: "posted",
      verdict: null,
      phases: [{ phase: "intake", durationMs: 3 }],
      failure: undefined,
      wallSeconds: 300,
    });

    // The machine contract's read keeps its exact pinned shape — the same
    // rows, no wall time among the columns.
    expect(db.recentRuns()[0]).toEqual({
      ts: "2026-11-16T10:00:00.000Z",
      repo: REPO,
      pr: 9,
      outcome: "posted",
      verdict: null,
      phases: [{ phase: "intake", durationMs: 3 }],
      failure: undefined,
    });
    expect(Object.keys(db.recentRuns()[0] ?? {})).toEqual([
      "ts",
      "repo",
      "pr",
      "outcome",
      "verdict",
      "phases",
      "failure",
    ]);
    db.close();
  });

  it("a settled row whose stamps do not parse as time renders no wall time and names it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const captured = capturingLog();
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: captured.logger,
      clock: projectionClock(),
    });

    // The projection's shapes check that a stamp is a string, not that it
    // parses: a record like this backfills, so the read meets stamps it
    // cannot subtract — named on the log, no wall time rendered, no throw.
    db.apply(unitTerminal("evt-nan", "not-a-timestamp"), "the review record");

    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows).toHaveLength(1);
    expect(pageRows[0]?.wallSeconds).toBeNull();
    expect(
      captured.lines.some((line) =>
        line.includes(
          "the status db read for evt-nan: the run's stamps do not parse as time, rendering no wall time",
        ),
      ),
    ).toBe(true);
    db.close();
  });

  it("a settled row carrying no finish stamp — the state the settlement rules rule out — renders no wall time and names it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const captured = capturingLog();
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: captured.logger,
      clock: projectionClock(),
    });
    db.apply(
      unitStart("evt-unstamped", "2026-11-16T09:00:00.000Z"),
      "the accepted-start record",
    );
    db.apply(
      unitTerminal("evt-unstamped", "2026-11-16T09:05:00.000Z"),
      "the review record",
    );

    // No write path reaches this state; the row is written through raw SQL
    // to pin what the read does should the projection violate its own
    // rules anyway.
    const file = new DatabaseSync(statusDbPath(stateDir));
    try {
      file.exec(
        "UPDATE runs SET finishedAt = NULL WHERE eventId = 'evt-unstamped'",
      );
    } finally {
      file.close();
    }

    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows).toHaveLength(1);
    expect(pageRows[0]?.wallSeconds).toBeNull();
    expect(
      captured.lines.some((line) =>
        line.includes(
          "the status db read for evt-unstamped: the settled row carries no finish stamp, rendering no wall time",
        ),
      ),
    ).toBe(true);
    // The machine contract's read is untouched by the missing stamp.
    expect(db.recentRuns()[0]).toEqual({
      ts: "2026-11-16T09:00:00.000Z",
      repo: REPO,
      pr: 9,
      outcome: "posted",
      verdict: null,
      phases: [{ phase: "intake", durationMs: 3 }],
      failure: undefined,
    });
    db.close();
  });

  it("a settled row whose record carries a real finish stamp renders the real wall its phases make", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // The defect's exact shape: the record's ts is the run's start stamp,
    // its finishedAt the real settle moment, and the phases sum to the
    // same five minutes. Stamping the start over itself (the old path)
    // rendered <1s while the stage column read five minutes.
    db.apply(
      unitStart("evt-real", "2026-11-16T09:00:00.000Z"),
      "the accepted-start record",
    );
    db.apply(
      unitTerminal("evt-real", "2026-11-16T09:00:00.000Z", {
        phases: [
          { phase: "intake", durationMs: 60_000 },
          { phase: "git", durationMs: 240_000 },
        ],
        finishedAt: "2026-11-16T09:05:00.000Z",
      }),
      "the review record",
    );

    const [row] = states(statusDbPath(stateDir));
    expect(row?.startedAt).toBe("2026-11-16T09:00:00.000Z");
    expect(row?.finishedAt).toBe("2026-11-16T09:05:00.000Z");
    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows[0]?.wallSeconds).toBe(300);
    db.close();
  });

  it("a record without a finish stamp takes the ts fallback and renders the wall that fallback makes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    // A pre-retention record carries no finishedAt: the fallback stamps
    // the record's own ts (the run's start stamp) as the finish, so the
    // wall reads the accept-to-start drift and never pretends the
    // retention shape it has no stamp for.
    db.apply(
      unitStart("evt-fallback", "2026-11-16T10:00:00.000Z"),
      "the accepted-start record",
    );
    db.apply(
      unitTerminal("evt-fallback", "2026-11-16T10:04:00.000Z"),
      "the review record",
    );

    const [row] = states(statusDbPath(stateDir));
    expect(row?.finishedAt).toBe("2026-11-16T10:04:00.000Z");
    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows[0]?.wallSeconds).toBe(240);
    db.close();
  });

  it("a start row plus a terminal settles with the accept-time start and the record's finish", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });
    db.apply(
      unitStart("evt-both", "2026-11-16T11:00:00.000Z"),
      "the accepted-start record",
    );
    db.apply(
      unitTerminal("evt-both", "2026-11-16T11:01:00.000Z", {
        finishedAt: "2026-11-16T11:09:00.000Z",
      }),
      "the review record",
    );

    // The upsert's conflict clause never touches startedAt: the row keeps
    // the accept-time start, and the finish stamp comes from the record —
    // the wall is the record's own nine minutes.
    const [row] = states(statusDbPath(stateDir));
    expect(row?.startedAt).toBe("2026-11-16T11:00:00.000Z");
    expect(row?.finishedAt).toBe("2026-11-16T11:09:00.000Z");
    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows[0]?.wallSeconds).toBe(540);
    db.close();
  });

  it("a failed run's drafts land on the row with their truncation flags, a posting run's stay journal-only, and a retry settlement drops them", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: consoleLogger,
      clock: projectionClock(),
    });

    db.apply(
      unitTerminal("evt-drafts", "2026-11-16T10:00:00.000Z", {
        outcome: "failed",
        failure: {
          stage: "context",
          message: "context draft failed validation twice",
        },
        failedDrafts: [
          {
            stage: "context",
            attempt: 0,
            reply: '{"verdict":',
            parseError: "unexpected end of JSON",
          },
          { stage: "context", attempt: 1, reply: '{"verdict":"APPROVE"}' },
          {
            stage: "humanize",
            attempt: 0,
            reply: capFailedDraft("y".repeat(FAILED_DRAFT_CAP + 10)),
          },
        ],
      }),
      "the failed review record",
    );

    // The page read carries the drafts with the truncation flag computed
    // from the marker — only the capped one reads truncated.
    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows[0]?.failedDrafts).toEqual([
      {
        stage: "context",
        attempt: 0,
        reply: '{"verdict":',
        parseError: "unexpected end of JSON",
        truncated: false,
      },
      {
        stage: "context",
        attempt: 1,
        reply: '{"verdict":"APPROVE"}',
        parseError: undefined,
        truncated: false,
      },
      {
        stage: "humanize",
        attempt: 0,
        reply: capFailedDraft("y".repeat(FAILED_DRAFT_CAP + 10)),
        parseError: undefined,
        truncated: true,
      },
    ]);

    // The machine contract's read stays the pinned shape: no drafts there.
    expect(db.recentRuns()[0]).not.toHaveProperty("failedDrafts");

    // The scope: the same failed attempts on a run that posted never
    // enter the row — journal-only.
    db.apply(
      unitTerminal("evt-posted-drafts", "2026-11-16T11:00:00.000Z", {
        failedDrafts: [{ stage: "context", attempt: 0, reply: "refused" }],
      }),
      "the posted review record",
    );
    const postedRow = states(statusDbPath(stateDir)).find(
      (row) => row.eventId === "evt-posted-drafts",
    );
    expect(postedRow?.failedDrafts).toBeNull();

    // A retry that re-settles the failed run posted drops the drafts with
    // its own outcome: the row then speaks for the posted settlement.
    db.apply(
      unitTerminal("evt-drafts", "2026-11-16T10:05:00.000Z", {
        outcome: "posted",
        verdict: "APPROVE",
      }),
      "the retry's review record",
    );
    const retriedRow = states(statusDbPath(stateDir)).find(
      (row) => row.eventId === "evt-drafts",
    );
    expect(retriedRow?.failedDrafts).toBeNull();

    // The render alignment: a failed record whose drafts ride without a
    // failure object stores none — the page's failure cell would never
    // draw them.
    db.apply(
      unitTerminal("evt-failureless", "2026-11-16T12:00:00.000Z", {
        outcome: "failed",
        failedDrafts: [{ stage: "context", attempt: 0, reply: "refused" }],
      }),
      "the failureless failed review record",
    );
    const failurelessRow = states(statusDbPath(stateDir)).find(
      (row) => row.eventId === "evt-failureless",
    );
    expect(failurelessRow?.failedDrafts).toBeNull();
    db.close();
  });

  it("a row whose stored drafts do not parse renders none and names it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-projection-"));
    const captured = capturingLog();
    const db = new StatusDb({
      path: statusDbPath(stateDir),
      logger: captured.logger,
      clock: projectionClock(),
    });
    db.apply(
      unitTerminal("evt-bad-drafts", "2026-11-16T09:00:00.000Z", {
        outcome: "failed",
        failure: { stage: "blind", message: "boom" },
      }),
      "the review record",
    );

    // No write path reaches this state; the drafts column is corrupted
    // through raw SQL to pin what the read does should the projection
    // violate its own storage contract anyway.
    const file = new DatabaseSync(statusDbPath(stateDir));
    try {
      file.exec(
        "UPDATE runs SET failedDrafts = '[not json' WHERE eventId = 'evt-bad-drafts'",
      );
    } finally {
      file.close();
    }

    const pageRows = db.recentRunsWithWallTime();
    expect(pageRows[0]?.failedDrafts).toBeUndefined();
    expect(
      captured.lines.some((line) =>
        line.includes(
          "the status db read for evt-bad-drafts: the stored failed drafts did not parse, rendering none",
        ),
      ),
    ).toBe(true);
    db.close();
  });
});

describe("status surface reads the projection", () => {
  it("the boot backfill fills the projection once, and the runs table answers from it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    for (let n = 1; n <= 12; n++) {
      await appendJournal(
        journalPath(stateDir),
        settledRecord(n, n % 2 === 0 ? undefined : "APPROVE"),
      );
    }
    const bootLog = capturingLog();
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
      logger: bootLog.logger,
    });

    // Every seeded record landed in the projection exactly once; the
    // surface's window is the SQL read over it.
    expect(countRows(statusDbPath(stateDir))).toBe(12);
    // The boot log reports rows landed, not lines fed.
    expect(
      bootLog.lines.some((line) =>
        line.includes(
          "the status db was empty; the boot backfill landed 12 rows from the journal",
        ),
      ),
    ).toBe(true);
    const body = await fetchStatus(h);
    expect(body.runs).toHaveLength(10);
    expect(body.runs.map((run) => run.pr)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
    ]);
  });

  it("GET /status reads the projection, never the journal, after boot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    for (let n = 1; n <= 3; n++) {
      await appendJournal(journalPath(stateDir), settledRecord(n, "APPROVE"));
    }
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    // After boot the journal is audit only: removing it cannot change an
    // answer, and the runs a fresh event settles reach /status through
    // the write-through, not through any file walk.
    await unlink(journalPath(stateDir));
    await postReviewEvent(h);

    const body = await fetchStatus(h);
    expect(body.runs).toHaveLength(4);
    expect(body.runs[0]).toMatchObject({
      repo: REPO,
      pr: PR,
      outcome: "posted",
      verdict: null,
    });
    expect(countRows(statusDbPath(stateDir))).toBe(4);
  });
});

describe("the failed report on the page", () => {
  /** One failed terminal record for a pre-seeded journal. */
  const failedDraftsRecord = (
    over: Partial<ReviewRecord> = {},
  ): ReviewRecord => ({
    ts: "2026-11-16T10:00:00.000Z",
    type: "review",
    reviewId: "rev-drafts",
    repo: REPO,
    pr: 7,
    eventId: "evt-drafts",
    commentId: "c-7",
    requester: "example-user",
    phases: [{ phase: "context", durationMs: 40 }],
    inlineComments: 0,
    humanizer: { changed: false },
    outcome: "failed",
    failure: {
      stage: "context",
      message: "context draft failed validation twice",
    },
    ...over,
  });

  it("a seeded failed run renders each draft's stage, attempt, refusal, and escaped reply; a clean run's rows render as before; /status gains nothing", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    await appendJournal(journalPath(stateDir), {
      ts: "2026-11-16T09:55:00.000Z",
      type: "review-start",
      eventId: "evt-drafts",
      repo: REPO,
      pr: 7,
      commentId: "c-7",
      eventKind: "review_requested",
    });
    await appendJournal(
      journalPath(stateDir),
      failedDraftsRecord({
        failedDrafts: [
          {
            stage: "context",
            attempt: 0,
            reply: '{"verdict":',
            parseError: "unexpected token <end> at position 12",
          },
          {
            stage: "humanize",
            attempt: 1,
            reply:
              '<script>alert("draft")</script> https://user:hunter2-draft@forge.invalid/x',
          },
        ],
      }),
    );
    // One clean posted run beside the failed one: its row renders as before.
    await appendJournal(journalPath(stateDir), settledRecord(1, "APPROVE"));

    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    // The failure message, and beneath it the failed report blocks.
    expect(page).toContain("context draft failed validation twice");
    expect(page).toContain('<span class="chip mute">context</span>');
    expect(page).toContain('<span class="chip mute">humanize</span>');
    expect(page).toContain("attempt 0");
    expect(page).toContain("attempt 1");
    // The parse refusal renders, escaped.
    expect(page).toContain("unexpected token &lt;end&gt; at position 12");
    // The draft is model output, carried and stored as-is: markup renders
    // as text — never executes — and the draft is not redacted, unlike
    // the failure message beside it (the raw reply is what the 2am
    // reader came for).
    expect(page).toContain(
      "&lt;script&gt;alert(&quot;draft&quot;)&lt;/script&gt;",
    );
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("https://user:hunter2-draft@forge.invalid/x");
    // Exactly the failed run's two drafts render; the clean run
    // contributed none.
    expect((page.match(/class="draft"/g) ?? []).length).toBe(2);
    // The clean run's row unchanged: its verdict chip renders as it did
    // before this view existed.
    expect(page).toContain('<span class="chip ok">APPROVE</span>');

    // The machine contract stays byte-shape pinned: no drafts on the wire.
    const wire = await (await fetch(`${intakeUrl(h)}/status`)).text();
    expect(wire).not.toContain("failedDrafts");
    expect(wire).not.toContain("draft-reply");
    expect(wire).not.toContain("draft-refusal");
  });

  it("a truncated draft renders the capped text with the marker labeled, and an uncapped one claims no truncation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "zenigata-status-"));
    await appendJournal(
      journalPath(stateDir),
      failedDraftsRecord({
        failedDrafts: [
          {
            stage: "context",
            attempt: 0,
            reply: capFailedDraft("z".repeat(FAILED_DRAFT_CAP + 10)),
          },
          { stage: "humanize", attempt: 0, reply: '{"verdict":"APPROVE"}' },
        ],
      }),
    );
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: stateDir },
    });

    const page = await (await fetch(`${intakeUrl(h)}/`)).text();
    expect(page).toContain('<span class="chip warn">truncated</span>');
    // The cap and its marker carry through unchanged: the reply's own
    // tail sits against the marker, nothing lost between.
    expect(page.includes("z".repeat(64) + FAILED_DRAFT_TRUNCATION_MARKER)).toBe(
      true,
    );
    expect((page.match(/class="chip warn">truncated/g) ?? []).length).toBe(1);
  });
});
