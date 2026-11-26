/**
 * End-to-end flow tests. Real git, hermetic: a bare origin fixture, the
 * ForgeDouble seeded from it, the SessionDouble scripted per scenario, the
 * MemoryFake recording writes. Events go through the intake HTTP surface
 * and settle via the server's awaitSettled(eventId) hook.
 */

import { once } from "node:events";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAILED_DRAFT_CAP,
  DROPPED_COMMENT_TRUNCATION_MARKER,
  type DroppedSource,
} from "../src/journal.js";
import {
  ForgeDouble,
  makeReply,
  makeReviewRequested,
} from "../src/adapters/forge-double.js";
import { worktreeDirName } from "../src/review.js";
import { MAX_BODY_BYTES, REVIEW_SLOTS } from "../src/server.js";
import type { SessionDriver } from "../src/contracts/session.js";
import type { ForgeAdapter, ForgeEvent } from "../src/contracts/forge.js";
import { MemoryFake } from "./memory-fake.js";
import {
  addReviewWorktree,
  canonicalCloneDir,
  canonicalCloneDirName,
  ensureCanonicalClone,
} from "../src/canonical-clone.js";
import {
  EVENT_TOKEN,
  FAILED_REPLY,
  POSTED_REPLY,
  SEEDED_POSTED_BODY,
  happyScript,
  PR,
  REPO,
  expectGone,
  intakeUrl,
  postReviewEvent,
  startHarness,
  waitFor,
  type Harness,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

async function fetchMetrics(harness: Harness): Promise<string> {
  const response = await fetch(`${intakeUrl(harness)}/metrics`);
  expect(response.status).toBe(200);
  return response.text();
}

/**
 * The journal's run records: everything except the intake's accepted-start
 * lines. One enqueued review now journals a review-start line before its
 * run writes any outcome, so tests that assert run outcomes read the
 * filtered list; the start lines themselves are asserted raw.
 */
const runRecords = (h: Harness): Promise<Array<Record<string, unknown>>> =>
  (async () => {
    const rows = (await h.journal()) as Array<Record<string, unknown>>;
    return rows.filter((r) => r.type !== "review-start");
  })();

const worktreeDir = (harness: Harness): string =>
  join(harness.config.worktreesDir, worktreeDirName(REPO, PR));

/** The registered worktree roots of a canonical clone, from git itself. */
const listWorktrees = async (cloneDir: string): Promise<string[]> => {
  const { stdout } = await execFileAsync("git", [
    "-C",
    cloneDir,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
};

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

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("review flow", () => {
  it("1. dispatches one prompt and records the posted outcome the session reported", async () => {
    const h = await harness({ script: happyScript() });

    // The session posts its own review through the deployment's forge
    // tools; the double is seeded with what such a post leaves on the
    // forge, so the bookkeeping lookup has something to find.
    await h.forge.postReview({
      repo: REPO,
      pr: PR,
      expectedHeadSha: h.fixture.headSha,
      verdict: "REQUEST_CHANGES",
      body: "The case: two lines land and neither one says what it adds.",
      comments: [
        {
          path: "notes.md",
          line: 3,
          body: "Agent-generated:\n\nissue (blocking): 'added one' names nothing.",
        },
      ],
    });

    await postReviewEvent(h);

    // The pipeline dispatches one prompt and posts nothing itself; the
    // double's one posted review is the test's seed.
    expect(h.sessions.prompts).toHaveLength(1);
    const prompt = h.sessions.prompts[0]?.text ?? "";
    expect(prompt).toContain("Review pull request acme/widget#1");
    expect(prompt).toContain("review-status: posted");
    expect(h.forge.postedReviews).toHaveLength(1);

    const records = await runRecords(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "review",
      repo: REPO,
      pr: PR,
      headSha: h.fixture.headSha,
      requester: "example-user",
      verdict: "REQUEST_CHANGES",
      inlineComments: 1,
      outcome: "posted",
    });
    // The humanize stage is the session's own flow now; the record
    // carries no pipeline-side humanizer accounting.
    expect(records[0]).not.toHaveProperty("humanizer");
    const phases = records[0]?.phases as Array<{
      phase: string;
      durationMs: number;
    }>;
    expect(phases.map((p) => p.phase)).toEqual([
      "intake",
      "git",
      "review",
      "bookkeeping",
    ]);
    for (const phase of phases) {
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    }

    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="posted"} 1`,
    );
    expect(metrics).toContain(
      `zenigata_review_phase_seconds_count{phase="git"}`,
    );
    expect(metrics).toMatch(
      /zenigata_review_phase_seconds_sum\{phase="git"\} /,
    );

    // PRJ-382: the run keeps its session and worktree; the journal record
    // names both and stamps the settle moment, so the sweep can retire
    // them inside the window.
    expect(h.sessions.disposed).toHaveLength(0);
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
    const record = records[0] as Record<string, unknown>;
    expect(record.sessionId).toBe(h.sessions.createdSessions[0]?.sessionId);
    expect(record.worktreeDir).toBe(worktreeDir(h));
    expect(Number.isNaN(Date.parse(record.finishedAt as string))).toBe(false);
  });

  it("5. skips a disallowed requester with no session and no post", async () => {
    const h = await harness({
      script: happyScript(),
      allowedLogins: "someone-else",
    });

    await postReviewEvent(h, { requesterLogin: "stranger" });

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "skipped" });
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="skipped"} 1`,
    );
  });

  it("6. skips a fork PR", async () => {
    const h = await harness({
      script: happyScript(),
      forgeOverrides: { isFork: true },
    });

    await postReviewEvent(h);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "skipped" });
  });

  it("4. journals a mid-pipeline failure with the failing stage", async () => {
    const h = await harness({
      script: () => {
        throw new Error("agent runtime exploded");
      },
    });

    await postReviewEvent(h);

    const records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      failure: { stage: "review", message: "agent runtime exploded" },
    });
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="failed"} 1`,
    );
  });

  it("13. settles a timed-out run as failed and records the failure", async () => {
    const h = await harness({
      script: happyScript(),
      // 3s rather than 1s: reaching the bookkeeping stage races real git
      // clone latency, and a loaded runner must not flake the deadline.
      // The assertions' meaning is unchanged: the deadline fires while
      // the bookkeeping lookup is parked.
      env: { ZENIGATA_REVIEW_TIMEOUT_SECONDS: "3" },
    });
    const releaseGate = h.forge.parkGetPostedReviews();

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);

    // The session's one prompt completes with the status line, and the
    // bookkeeping lookup parks there; the deadline then fires while the
    // lookup is still in flight. The run resolves failed and journals
    // the failure.
    await waitFor(() => h.forge.parkedLookups === 1);
    await h.handle.awaitSettled(event.eventId);

    const records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      failure: { stage: "bookkeeping" },
    });
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="failed"} 1`,
    );

    // Release the parked lookup: the abandoned body resumes into an
    // already-aborted signal, and the record count stays at one.
    releaseGate();
    await waitFor(() => h.forge.parkedLookups === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await runRecords(h)).toHaveLength(1);
  });

  it("14. keeps going when the memory gateway fails on recall", async () => {
    const h = await harness({
      script: happyScript(),
      memory: {
        recall: async () => {
          throw new Error("memory daemon down");
        },
        write: async () => {
          throw new Error("memory daemon down");
        },
      },
    });

    await postReviewEvent(h);

    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "posted" });
  });

  it("rejects a dash-leading ref before git runs", async () => {
    const h = await harness({
      script: happyScript(),
      forgeOverrides: { headRef: "-oProxyCommand=evil" },
    });

    await postReviewEvent(h);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    expect(h.forge.postedFailures).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "failed" });
  });

  it("rejects a cloneUrl with a disallowed scheme", async () => {
    const h = await harness({
      script: happyScript(),
      forgeOverrides: { cloneUrl: "ext::sh -c echo pwned" },
    });

    await postReviewEvent(h);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    expect(h.forge.postedFailures).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "failed" });
  });

  it("redacts the cloneUrl when the URL parser rejects it", async () => {
    const h = await harness({
      script: happyScript(),
      // A space in the host makes new URL() throw; the parse-error
      // message embeds the raw cloneUrl and must not carry the token.
      forgeOverrides: { cloneUrl: "https://user:supersecrettoken@ho st/repo" },
    });

    await postReviewEvent(h);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    expect(h.forge.postedFailures).toHaveLength(0);
    // The redaction holds in the journal record: the failure message
    // truncates only after the secrets are gone.
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "failed" });
    const message = (records[0]?.failure as { message?: string } | undefined)
      ?.message;
    expect(message).not.toContain("supersecrettoken");
    expect(message).toMatch(/cloneUrl/);
  });

  it("completes the git stage over a stale worktree registration in the canonical clone", async () => {
    // The retry's log line is the observable for "fires only when needed".
    const infoLines: string[] = [];
    const h = await harness({
      script: happyScript(),
      logger: {
        info: (message) => infoLines.push(message),
        error: () => {},
      },
    });

    // An earlier run died between add and cleanup: the per-PR path is
    // registered in the canonical clone while its directory is gone.
    const cloneDir = canonicalCloneDir(h.stateDir, REPO);
    await ensureCanonicalClone({
      stateDir: h.stateDir,
      repo: REPO,
      cloneUrl: h.fixture.cloneUrl,
    });
    await addReviewWorktree({
      canonicalCloneDir: cloneDir,
      worktreeDir: worktreeDir(h),
      sha: h.fixture.headSha,
    });
    await rm(worktreeDir(h), { recursive: true, force: true });
    // The stale registration is the bug: the exact add the run performs
    // refuses the path until the clone drops the entry.
    await expect(
      addReviewWorktree({
        canonicalCloneDir: cloneDir,
        worktreeDir: worktreeDir(h),
        sha: h.fixture.headSha,
      }),
    ).rejects.toThrow(/missing but already registered worktree/);

    await postReviewEvent(h);

    // The pre-add prune cleared the entry: the review completed, the
    // deregister retry never fired. PRJ-382: the run keeps its fresh
    // worktree registered alongside the clone, so the sweep is what will
    // deregister and remove it.
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "posted" });
    expect(
      infoLines.filter((line) => line.includes("deregistering and retrying")),
    ).toEqual([]);
    const registered = await listWorktrees(cloneDir);
    expect(registered).toHaveLength(2);
    expect(registered).toContain(worktreeDir(h));
    expect(
      registered.some((entry) => entry.includes(canonicalCloneDirName(REPO))),
    ).toBe(true);
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
  });

  it("surfaces a worktree add that fails through the deregister retry exactly as any stage failure", async () => {
    const infoLines: string[] = [];
    const h = await harness({
      script: happyScript(),
      // The clone can never hold this commit: the add fails, the belt
      // deregisters and repeats the add exactly once, and the retry's
      // failure surfaces as an ordinary git stage failure.
      forgeOverrides: { headSha: "e".repeat(40) },
      logger: {
        info: (message) => infoLines.push(message),
        error: () => {},
      },
    });

    await postReviewEvent(h);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.forge.postedFailures).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      failure: {
        stage: "git",
        message: expect.stringContaining("e".repeat(40)),
      },
    });
    // The belt fired exactly once: one retry line, then the run settled.
    expect(
      infoLines.filter((line) => line.includes("deregistering and retrying")),
    ).toHaveLength(1);
    await expectGone(worktreeDir(h));
  });

  it("15. settles the run when the journal append fails", async () => {
    const h = await harness({ script: happyScript() });
    // The journal path is now a directory: every append fails with EISDIR.
    await mkdir(join(h.stateDir, "reviews.jsonl"));

    await postReviewEvent(h);

    // The run settled with its pre-journal outcome; the process survived.
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="posted"} 1`,
    );
    await expect(h.journal()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("7. records failed with the reply's head when the final reply carries no status line", async () => {
    const h = await harness({
      script: [
        "I thought about the change a lot. Here is my opinion, but nothing posted.",
      ],
    });

    await postReviewEvent(h);

    const records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      failure: {
        stage: "bookkeeping",
        message: expect.stringContaining("no review-status line"),
      },
    });
    const message = (records[0]?.failure as { message?: string }).message ?? "";
    expect(message).toContain("Here is my opinion");
    // One prompt: a re-prompt would re-run the whole review, so none
    // is sent.
    expect(h.sessions.prompts).toHaveLength(1);
  });

  it("8. records failed when the session reports the review failed", async () => {
    const h = await harness({ script: [FAILED_REPLY] });

    await postReviewEvent(h);

    const records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      failure: {
        stage: "bookkeeping",
        message: "the session reported the review failed",
      },
    });
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(
      `zenigata_reviews_total{repo="${REPO}",status="failed"} 1`,
    );
  });

  it("9. stages the material the harness holds in the one prompt", async () => {
    const h = await harness({
      script: happyScript(),
      memory: {
        recall: async () => [
          { content: "this repo's fixtures carry the token", source: "fact" },
        ],
        write: async () => {
          throw new Error("unused");
        },
      },
    });

    await postReviewEvent(h);

    const prompt = h.sessions.prompts[0]?.text ?? "";
    expect(prompt).toContain("Head feature @ ");
    expect(prompt).toContain("base main");
    expect(prompt).toContain("Title: add two lines");
    expect(prompt).toContain("a fixture pull request");
    expect(prompt).toContain("[fact] this repo's fixtures carry the token");
  });

  it("10. injects the persona from the override file, or the packaged default", async () => {
    const overridePath = join(
      await mkdtemp(join(tmpdir(), "zenigata-persona-")),
      "persona.md",
    );
    await writeFile(overridePath, "CUSTOM PERSONA MARKER\nsecond line\n");

    const overridden = await harness({
      script: happyScript(),
      personaFile: overridePath,
    });
    await postReviewEvent(overridden);
    expect(overridden.sessions.prompts[0]?.text).toContain(
      "CUSTOM PERSONA MARKER",
    );

    const defaulted = await harness({ script: happyScript() });
    await postReviewEvent(defaulted);
    // The packaged persona.md opens with this line.
    expect(defaulted.sessions.prompts[0]?.text).toContain(
      "# The inspector's report",
    );
  });
});

describe("reply flow operator speech", () => {
  it("renders the operator-speech sentence and names the reply's author", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        // First session: the review. Second session: the answer.
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer: "Fair point; the verdict stands.",
        });
      },
      env: {
        ZENIGATA_HUMANS: "example-user, example-two",
      },
    });
    await postReviewEvent(h);
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      authorLogin: "example-user",
      text: "why is this blocking? it is just a name",
    });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      replyEvent,
    );
    expect(response.status).toBe(202);
    await h.handle.awaitSettled(replyEvent.eventId);
    expect(h.forge.postedReplies).toHaveLength(1);

    // The answer prompt carries the same sentence the blind pass renders,
    // built by the same builder, and names the reply's author where the
    // reply is introduced (review 589, count 18599).
    const prompt = h.sessions.prompts.find((p) => p.sessionId.endsWith("-2"));
    expect(prompt?.text).toContain(
      "Operator speech: the forge names an author on every comment; " +
        "prose authored by example-user and example-two is the operator's own words",
    );
    expect(prompt?.text).toContain(
      "example-user replied to your review comment",
    );
  });

  it("names the author and renders no sentence without a humans list", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer: "Standing by the label.",
        });
      },
    });
    await postReviewEvent(h);
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      authorLogin: "example-bot",
      text: "why is this blocking?",
    });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      replyEvent,
    );
    expect(response.status).toBe(202);
    await h.handle.awaitSettled(replyEvent.eventId);
    expect(h.forge.postedReplies).toHaveLength(1);

    const prompt = h.sessions.prompts.find((p) => p.sessionId.endsWith("-2"));
    // The author's name rides the answer prompt as context whatever the
    // lists carry; the rule renders only from the humans list.
    expect(prompt?.text).toContain(
      "example-bot replied to your review comment",
    );
    expect(prompt?.text).not.toContain("Operator speech:");
  });
});

describe("reply flow", () => {
  it("2. answers a reply in thread and stores the learning observation", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        // First session: the review. Second session: the reply.
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer:
            "Fair point; I still stand by the label. The verdict does not move under questioning.",
          learning: {
            source: "fact",
            content: "reviewers in this repo want addend names spelled out",
          },
        });
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      text: "why is this blocking? it is just a name",
    });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      replyEvent,
    );
    expect(response.status).toBe(202);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]).toMatchObject({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
    });
    expect(h.forge.postedReplies[0]?.body).toContain("does not move");

    // The reply prompt quotes the posted review body.
    const replyPrompt = h.sessions.prompts.find((p) =>
      p.sessionId.endsWith("-2"),
    );
    expect(replyPrompt?.text).toContain(SEEDED_POSTED_BODY);
    expect(replyPrompt?.text).toContain("why is this blocking");

    expect((h.memory as MemoryFake).writes).toEqual([
      {
        source: "fact",
        content: "reviewers in this repo want addend names spelled out",
        ctx: {
          cwd: join(
            h.stateDir,
            "canonical-clones",
            canonicalCloneDirName(REPO),
          ),
        },
      },
    ]);

    const records = await runRecords(h);
    expect(records[1]).toMatchObject({
      type: "reply",
      repo: REPO,
      pr: PR,
      author: "example-user",
      inReplyTo: "r1",
      outcome: "posted",
      learning: "fact",
    });

    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(`zenigata_replies_total{repo="${REPO}"} 1`);
    expect(metrics).toContain(
      'zenigata_memory_observations_total{source="fact"} 1',
    );
  });

  it("answers an unknown inReplyTo with a no-record reply and no session", async () => {
    const h = await harness({ script: happyScript() });
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "nonexistent",
      text: "what?",
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]?.body).toContain("no record");
    // The trigger sentence names the shipped re-fire set, not a single
    // stale promise: a forge re-request runs, and each forge delivery
    // is spend-gated.
    expect(h.forge.postedReplies[0]?.body).toContain(
      "Reviews fire on a forge review re-request. PR comments trigger nothing.",
    );
    expect(h.forge.postedReplies[0]?.body).toContain(
      "Each forge delivery runs at most once",
    );
    expect(h.sessions.createdSessions).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ type: "reply", outcome: "posted" });
  });

  it("keeps going when the memory gateway fails on write", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer: "standing answer",
          learning: { source: "insight", content: "something durable" },
        });
      },
      memory: {
        recall: async () => [],
        write: async () => {
          throw new Error("memory daemon down");
        },
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    const records = await runRecords(h);
    // The learning was detected but the write failed, so the record
    // carries no learning source and the counter stays empty.
    expect(records[1]).toMatchObject({ outcome: "posted" });
    expect(records[1]?.learning).toBeUndefined();
    const metrics = await fetchMetrics(h);
    // A failed write is not counted.
    expect(metrics).not.toContain(
      'zenigata_memory_observations_total{source="insight"} 1',
    );
  });

  it("16. answers a non-allowed author but stores nothing", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer: "standing answer",
          learning: { source: "fact", content: "should not be stored" },
        });
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      authorLogin: "stranger",
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    // The answer still posts; the learning is dropped with no write.
    expect(h.forge.postedReplies).toHaveLength(1);
    expect((h.memory as MemoryFake).writes).toEqual([]);
    const records = await runRecords(h);
    expect(records[1]).toMatchObject({ outcome: "posted" });
    expect(records[1]?.learning).toBeUndefined();
    const metrics = await fetchMetrics(h);
    expect(metrics).not.toContain(
      'zenigata_memory_observations_total{source="fact"} 1',
    );
  });

  it("17. stores the learning only after the answer posts", async () => {
    let h: Harness;
    const calls: string[] = [];
    h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({
          answer: "standing answer",
          learning: { source: "insight", content: "something durable" },
        });
      },
      memory: {
        recall: async () => [],
        write: async (source, content, ctx) => {
          calls.push(
            `${source}:${content}:${typeof ctx?.cwd === "string"} after ${h.forge.postedReplies.length} posted replies`,
          );
        },
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(calls).toEqual([
      "insight:something durable:true after 1 posted replies",
    ]);
  });

  it("18. posts a failure reply and journals failed when the answer run times out", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: "never reached" });
      },
      // Same 3s reasoning as scenario 13.
      env: { ZENIGATA_REVIEW_TIMEOUT_SECONDS: "3" },
      wrapSessions: (inner: SessionDriver): SessionDriver => ({
        createSession: (d, a) => inner.createSession(d, a),
        prompt: async (sid, text) => {
          if (sid.endsWith("-2")) {
            // Park the reply's first prompt past the deadline.
            await gate;
          }
          return inner.prompt(sid, text);
        },
        readOutput: (sid) => inner.readOutput(sid),
        dispose: (sid) => inner.dispose(sid),
      }),
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    // Resolves instead of hanging: the deadline settles the parked run.
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]?.body).toContain("question stands");
    const records = await runRecords(h);
    expect(records[1]).toMatchObject({ type: "reply", outcome: "failed" });

    releaseGate?.();
    await waitFor(() => h.sessions.prompts.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The abandoned answer run landed nothing extra.
    expect(h.forge.postedReplies).toHaveLength(1);
  });

  it("19. caps an oversized reply text in the prompt", async () => {
    const longText = "x".repeat(4500) + "THE-TAIL-MARKER";
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: "standing answer" });
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      text: longText,
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    const replyPrompt = h.sessions.prompts.find((p) =>
      p.sessionId.endsWith("-2"),
    );
    expect(replyPrompt?.text).toContain("[reply truncated]");
    expect(replyPrompt?.text).toContain("x".repeat(4000));
    expect(replyPrompt?.text).not.toContain("THE-TAIL-MARKER");
    expect(h.forge.postedReplies).toHaveLength(1);
  });

  it("20. treats a reply pointing at another PR's comment as unknown", async () => {
    const h = await harness({
      script: happyScript(),
      extraPrs: [{ repo: REPO, pr: 2 }],
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: 2, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    // The r1 record belongs to PR 1: no session was spent quoting its
    // body into the wrong thread, and the reply takes the no-record path.
    expect(h.sessions.createdSessions).toHaveLength(1);
    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]).toMatchObject({ repo: REPO, pr: 2 });
    expect(h.forge.postedReplies[0]?.body).toContain("no record");
    expect(h.forge.postedReplies[0]?.body).not.toContain(SEEDED_POSTED_BODY);
  });

  it("skips a reply to a repository outside allowedRepos", async () => {
    const h = await harness({
      script: happyScript(),
      allowedRepos: "acme/widget",
    });

    const replyEvent = makeReply({
      repo: "other/repo",
      pr: 1,
      inReplyTo: "r1",
    });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      replyEvent,
    );
    expect(response.status).toBe(202);
    await h.handle.awaitSettled(replyEvent.eventId);

    // Skipped entirely: no session, no post, one journal record.
    expect(h.sessions.createdSessions).toHaveLength(0);
    expect(h.forge.postedReplies).toHaveLength(0);
    const records = await runRecords(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "reply",
      repo: "other/repo",
      outcome: "skipped",
    });
    const metrics = await fetchMetrics(h);
    expect(metrics).toContain(`zenigata_replies_total{repo="other/repo"} 1`);
  });

  it("skips a replayed reply event while the first is in flight", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let parkedReplies = 0;

    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: "standing answer" });
      },
      wrapForge: (inner): ForgeAdapter => ({
        getPullRequest: (repo, pr, opts) =>
          inner.getPullRequest(repo, pr, opts),
        getDiff: (repo, pr) => inner.getDiff(repo, pr),
        getPostedReview: (repo, pr, head, opts) =>
          inner.getPostedReview(repo, pr, head, opts),
        postReview: (review, opts) => inner.postReview(review, opts),
        postReply: async (input) => {
          parkedReplies += 1;
          await gate;
          parkedReplies -= 1;
          return inner.postReply(input);
        },
        postFailureComment: (input) => inner.postFailureComment(input),
      }),
    });

    await postReviewEvent(h);
    const first = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      text: "why?",
    });
    const firstResponse = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      first,
    );
    expect(firstResponse.status).toBe(202);
    await waitFor(() => parkedReplies === 1);

    const replay = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      text: "why?",
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replay);
    // The replay skips instead of queueing a second post behind the gate.
    await h.handle.awaitSettled(replay.eventId);
    expect(parkedReplies).toBe(1);

    releaseGate?.();
    await h.handle.awaitSettled(first.eventId);
    expect(h.forge.postedReplies).toHaveLength(1);
  });

  it("caps the reply queue and skips the excess with a journal record", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let parkedReplies = 0;

    const h = await harness({
      script: happyScript(),
      wrapForge: (inner): ForgeAdapter => ({
        getPullRequest: (repo, pr, opts) =>
          inner.getPullRequest(repo, pr, opts),
        getDiff: (repo, pr) => inner.getDiff(repo, pr),
        getPostedReview: (repo, pr, head, opts) =>
          inner.getPostedReview(repo, pr, head, opts),
        postReview: (review, opts) => inner.postReview(review, opts),
        postReply: async (input) => {
          parkedReplies += 1;
          await gate;
          parkedReplies -= 1;
          return inner.postReply(input);
        },
        postFailureComment: (input) => inner.postFailureComment(input),
      }),
    });

    await postReviewEvent(h);

    // Distinct threads: 4 run, 100 wait in the queue, the 105th skips.
    const events = Array.from({ length: 105 }, (_, i) =>
      makeReply({ repo: REPO, pr: PR, inReplyTo: `unknown-${i}`, text: "q" }),
    );
    for (const event of events) {
      const response = await h.source.postToIntake(
        intakeUrl(h),
        EVENT_TOKEN,
        event,
      );
      expect(response.status).toBe(202);
    }
    await waitFor(() => parkedReplies === 4);

    // The 105th reply skipped; its journal record is written before the
    // event settles.
    await h.handle.awaitSettled(events[104].eventId);
    const records = await runRecords(h);
    const skipped = records.filter(
      (record) => record.type === "reply" && record.outcome === "skipped",
    );
    expect(skipped).toHaveLength(1);

    releaseGate?.();
    await waitFor(() => h.forge.postedReplies.length === 104, 10_000);
  }, 30_000);

  it("indexes the bot's answer so a reply to it resolves in a two-turn thread", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        if (sessionId.endsWith("-2")) {
          return JSON.stringify({ answer: "FIRST ANSWER BODY" });
        }
        return JSON.stringify({ answer: "SECOND ANSWER BODY" });
      },
    });

    await postReviewEvent(h);
    const first = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "r1",
      text: "why?",
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, first);
    await h.handle.awaitSettled(first.eventId);

    // The journal carries the posted answer id and text.
    let records = await runRecords(h);
    expect(records[1]).toMatchObject({
      type: "reply",
      outcome: "posted",
      postedCommentId: "p1",
      body: "FIRST ANSWER BODY",
    });

    const second = makeReply({
      repo: REPO,
      pr: PR,
      inReplyTo: "p1",
      text: "and again?",
    });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, second);
    await h.handle.awaitSettled(second.eventId);

    // The second reply resolved against the bot's answer: the prompt
    // quoted it, and the run answered instead of posting the no-record
    // text.
    expect(h.forge.postedReplies).toHaveLength(2);
    expect(h.forge.postedReplies[1]?.body).toBe("SECOND ANSWER BODY");
    const prompt = h.sessions.prompts.find((p) => p.sessionId.endsWith("-3"));
    expect(prompt?.text).toContain("FIRST ANSWER BODY");
    expect(prompt?.text).not.toContain("no record");

    // Re-read: the first read predates the second reply's journal write.
    records = await runRecords(h);
    const secondRecord = records[2];
    expect(secondRecord).toMatchObject({
      type: "reply",
      inReplyTo: "p1",
      postedCommentId: "p2",
    });
  });

  it("instructs the model to state the learning plainly without a repo prefix", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: "standing answer" });
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    const prompt = h.sessions.prompts.find((p) => p.sessionId.endsWith("-2"));
    expect(prompt?.text).toContain(
      "repo scoping is carried structurally by the memory write, not by a text",
    );
    expect(prompt?.text).not.toContain(`Repo ${REPO}: `);
  });

  it("truncates an oversized answer before posting", async () => {
    const longAnswer = "a".repeat(9000) + "THE-TAIL-MARKER";
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: longAnswer });
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    const body = h.forge.postedReplies[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(
      8000 + "\n\n[answer truncated]".length,
    );
    expect(body).toContain("[answer truncated]");
    expect(body).not.toContain("THE-TAIL-MARKER");
  });
});

describe("json repair in the answer loop (PRJ-381)", () => {
  /** Transpose the valid `,\"` into the observed backslash-comma-quote form. */
  const transpose = (jsonText: string): string =>
    jsonText.replace(',\\"', '\\,"');

  const UNREPAIRABLE_ANSWER = '{ "answer": STANDING-NOTE }';

  const intendedAnswer = () => ({
    answer:
      'standing by the label: "the wording is thin," and the verdict holds.',
    learning: {
      source: "insight",
      content: "the reviewer wants anchors named",
    },
  });

  /** The review record's failed-attempt entries. */
  const failedDrafts = (
    record: Record<string, unknown>,
  ): Array<{
    stage?: string;
    attempt?: number;
    reply?: string;
    parseError?: string;
  }> =>
    record.failedDrafts as Array<{
      stage?: string;
      attempt?: number;
      reply?: string;
      parseError?: string;
    }>;

  /**
   * The one reply-session prompt count and texts, filtered from the
   * review pipeline's prompts.
   */
  const replyPrompts = (h: Harness, suffix: string) =>
    h.sessions.prompts.filter((p) => p.sessionId.endsWith(suffix));

  it("6. repairs a transposed answer output on attempt 0; the learning survives", async () => {
    const intended = JSON.stringify(intendedAnswer());
    const broken = transpose(intended);
    expect(() => JSON.parse(broken)).toThrow(/Bad escaped character/);
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return index === 0 ? broken : intended;
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    // The answer posted was parsed from the repaired output.
    expect(h.forge.postedReplies[0]?.body).toBe(intendedAnswer().answer);
    // One prompt only: no corrective retry for a repaired reply, and
    // the learning stored as it would on a clean parse.
    expect(replyPrompts(h, "-2")).toHaveLength(1);
    expect((h.memory as MemoryFake).writes).toHaveLength(1);
    const records = await runRecords(h);
    expect(records[1]).toMatchObject({
      type: "reply",
      outcome: "posted",
      learning: "insight",
    });
    expect(
      (records[1] as Record<string, unknown>).failedDrafts,
    ).toBeUndefined();
  });

  it("7. re-prompts once for an unrepairable answer output, naming the parse error and the output head", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return index === 0
          ? UNREPAIRABLE_ANSWER
          : JSON.stringify(intendedAnswer());
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]?.body).toBe(intendedAnswer().answer);
    const prompts = replyPrompts(h, "-2");
    expect(prompts).toHaveLength(2);
    const retryPrompt = prompts[1]?.text ?? "";
    expect(retryPrompt).toContain("failed validation");
    expect(retryPrompt).toContain("not valid JSON");
    // The head shows the model the text it actually sent.
    expect(retryPrompt).toContain("STANDING-NOTE");
    expect(retryPrompt).not.toContain("received undefined");
    const records = await runRecords(h);
    const drafts = failedDrafts(records[1] as Record<string, unknown>);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      stage: "answer",
      attempt: 0,
      reply: UNREPAIRABLE_ANSWER,
    });
    expect(drafts[0]?.parseError).toContain("not valid JSON");
  });

  it("8. posts the static failure reply on double answer failure and journals the raw outputs with the parse error", async () => {
    const errorLines: string[] = [];
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return UNREPAIRABLE_ANSWER;
      },
      logger: {
        info: () => {},
        error: (message) => errorLines.push(message),
      },
    });

    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    // The thread still gets the static failure text; only the thrown
    // text stops lying (naming the parse error, logged here).
    expect(h.forge.postedReplies).toHaveLength(1);
    expect(h.forge.postedReplies[0]?.body).toContain("The answer run failed");
    const failureLine = errorLines.find((line) =>
      line.includes("reply output failed validation twice"),
    );
    expect(failureLine).toContain("not valid JSON");
    expect(failureLine).not.toContain("received undefined");

    const records = await runRecords(h);
    expect(records[1]).toMatchObject({ type: "reply", outcome: "failed" });
    const drafts = failedDrafts(records[1] as Record<string, unknown>);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      stage: "answer",
      attempt: 0,
      reply: UNREPAIRABLE_ANSWER,
    });
    expect(drafts[1]).toMatchObject({
      stage: "answer",
      attempt: 1,
      reply: UNREPAIRABLE_ANSWER,
    });
    for (const draft of drafts) {
      expect(draft.parseError).toContain("not valid JSON");
    }
    // The learning path never ran: no write on a failed parse.
    expect((h.memory as MemoryFake).writes).toHaveLength(0);
  });
});

describe("intake auth and validation", () => {
  it("11. rejects a wrong token with 401 and an invalid event with 400", async () => {
    const h = await harness({ script: happyScript() });

    const wrongToken = await fetch(`${intakeUrl(h)}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: "Bearer nope",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "review_requested" }),
    });
    expect(wrongToken.status).toBe(401);

    const noAuth = await fetch(`${intakeUrl(h)}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noAuth.status).toBe(401);

    const invalid = await fetch(`${intakeUrl(h)}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EVENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "star", eventId: "evt-x" }),
    });
    expect(invalid.status).toBe(400);

    const unparseable = await fetch(`${intakeUrl(h)}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EVENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    expect(unparseable.status).toBe(400);

    const health = await fetch(`${intakeUrl(h)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
  });

  it("rejects a non-integer or non-positive pr with 400 on both event kinds", async () => {
    const h = await harness({ script: happyScript() });

    for (const pr of [1.5, 0, -1]) {
      const review = await fetch(`${intakeUrl(h)}/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${EVENT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(makeReviewRequested({ repo: REPO, pr })),
      });
      expect(review.status).toBe(400);

      const reply = await fetch(`${intakeUrl(h)}/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${EVENT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(makeReply({ repo: REPO, pr })),
      });
      expect(reply.status).toBe(400);
    }
  });

  it("rejects a repo outside owner/name with 400", async () => {
    const h = await harness({ script: happyScript() });

    for (const repo of ["no slash", "/leading", "trailing/", "a b/c", "a//b"]) {
      const response = await fetch(`${intakeUrl(h)}/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${EVENT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(makeReviewRequested({ repo })),
      });
      expect(response.status).toBe(400);
    }
  });

  it("answers 413 on an oversized body", async () => {
    const h = await harness({ script: happyScript() });

    const response = await fetch(`${intakeUrl(h)}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EVENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
  });

  it("answers promptly when a client stops mid-upload", async () => {
    const h = await harness({ script: happyScript() });

    const socket = net.connect(h.handle.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST /v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer ${EVENT_TOKEN}\r\n` +
        `Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n` +
        `{"partial"`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Half-close: the body never completes, but the client can still read
    // the response. Without the close handler the body read never settles
    // and no response ever goes out.
    socket.end();
    const [data] = await once(socket, "data");
    expect(String(data)).toContain("400");
    socket.destroy();

    // The cut did not wedge the server.
    const health = await fetch(`${intakeUrl(h)}/healthz`);
    expect(health.status).toBe(200);
  });
});

describe("settled map pruning", () => {
  it("evicts the oldest settled entries past the cap and keeps the newest awaitable", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let prompted = false;

    const h = await harness({
      script: happyScript(),
      wrapSessions: (inner: SessionDriver): SessionDriver => ({
        createSession: (d, a) => inner.createSession(d, a),
        prompt: async (sid, text) => {
          if (!prompted) {
            prompted = true;
            // Park the first review in flight so every later event for
            // the same repo#pr settles as a skipped duplicate.
            await gate;
          }
          return inner.prompt(sid, text);
        },
        readOutput: (sid) => inner.readOutput(sid),
        dispose: (sid) => inner.dispose(sid),
      }),
    });

    const first = makeReviewRequested({ repo: REPO, pr: PR });
    const firstResponse = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      first,
    );
    expect(firstResponse.status).toBe(202);

    const duplicates = Array.from({ length: 510 }, () =>
      makeReviewRequested({ repo: REPO, pr: PR }),
    );
    for (const duplicate of duplicates) {
      const response = await h.source.postToIntake(
        intakeUrl(h),
        EVENT_TOKEN,
        duplicate,
      );
      expect(response.status).toBe(202);
    }

    // Settled entries evict oldest-first past the cap: the earliest
    // duplicates are gone, the newest is still awaitable, and the parked
    // (never settled) first review survived the pruning.
    await expect(h.handle.awaitSettled(duplicates[0].eventId)).rejects.toThrow(
      /no accepted event/,
    );
    const last = duplicates[duplicates.length - 1].eventId;
    await expect(h.handle.awaitSettled(last)).resolves.toMatchObject({
      repo: REPO,
      pr: PR,
    });

    releaseGate?.();
    await h.handle.awaitSettled(first.eventId);
  }, 60_000);

  it("keeps pending entries past the cap until they settle", async () => {
    const h = await harness({ script: happyScript() });
    // Park every getPullRequest: the review semaphore queues everything
    // behind the parked slots, so all 505 events' settled entries stay
    // pending and none may be evicted by the cap.
    const releaseGets = h.forge.parkGetPullRequests();

    const events = Array.from({ length: 505 }, (_, i) =>
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

    // The oldest entry is still present (a pending entry over the cap is
    // never evicted, or the completion signal for running work is lost).
    let rejected = false;
    h.handle.awaitSettled(events[0].eventId).catch(() => {
      rejected = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rejected).toBe(false);

    // The newest is present too.
    let lastRejected = false;
    h.handle.awaitSettled(events[504].eventId).catch(() => {
      lastRejected = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lastRejected).toBe(false);

    // The work itself was never cancelled by pruning: releasing the gate
    // settles the first event normally.
    releaseGets();
    await h.handle.awaitSettled(events[0].eventId);
  }, 60_000);
});

describe("worktree naming", () => {
  it("keeps slug-colliding repos on distinct directories", () => {
    expect(worktreeDirName("acme/widget", 1)).toBe(
      worktreeDirName("acme/widget", 1),
    );
    expect(worktreeDirName("acme/widget", 1)).not.toBe(
      worktreeDirName("acme-widget", 1),
    );
    expect(worktreeDirName("acme/widget", 1)).toMatch(
      /^acme-widget-1-[0-9a-f]{8}$/,
    );
  });
});

describe("duplicate in-flight reviews", () => {
  it("12. skips a second review for the same repo#pr while the first runs", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let prompted = false;

    const h = await harness({
      script: happyScript(),
      wrapSessions: (inner: SessionDriver): SessionDriver => ({
        createSession: (d, a) => inner.createSession(d, a),
        prompt: async (sid, text) => {
          if (!prompted) {
            prompted = true;
            await gate;
          }
          return inner.prompt(sid, text);
        },
        readOutput: (sid) => inner.readOutput(sid),
        dispose: (sid) => inner.dispose(sid),
      }),
    });

    const first = makeReviewRequested({ repo: REPO, pr: PR });
    const duplicate = makeReviewRequested({ repo: REPO, pr: PR });
    const firstResponse = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      first,
    );
    expect(firstResponse.status).toBe(202);
    // The first review is parked inside its first prompt; fire the duplicate.
    const duplicateResponse = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      duplicate,
    );
    expect(duplicateResponse.status).toBe(202);
    await h.handle.awaitSettled(duplicate.eventId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    releaseGate?.();
    await h.handle.awaitSettled(first.eventId);

    expect(h.sessions.createdSessions).toHaveLength(1);
    const records = await runRecords(h);
    expect(records).toHaveLength(1);
  });
});

describe("review concurrency cap", () => {
  it("runs reviews up to the slot cap and queues the rest", async () => {
    const extra = Array.from({ length: 2 * REVIEW_SLOTS - 1 }, (_, i) => ({
      repo: REPO,
      pr: i + 2,
    }));
    const h = await harness({ script: happyScript(), extraPrs: extra });
    // Park every getPullRequest: each review body holds its semaphore
    // slot parked in the intake stage, so parkedGets is the number of
    // reviews running concurrently.
    const releaseGets = h.forge.parkGetPullRequests();

    const events = Array.from({ length: 2 * REVIEW_SLOTS }, (_, i) =>
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

    // The slots fill; the remaining reviews queue and never reach the
    // forge while the slots are out.
    await waitFor(() => h.forge.parkedGets === REVIEW_SLOTS);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.forge.parkedGets).toBe(REVIEW_SLOTS);

    releaseGets();
    await Promise.all(
      events.map((event) => h.handle.awaitSettled(event.eventId)),
    );
    const records = await runRecords(h);
    expect(records).toHaveLength(events.length);
    for (const record of records) {
      expect((record as { outcome?: string }).outcome).toBe("posted");
    }
  });
});

describe("cancelled-run invariants and reconciliation", () => {
  it("21. a timed-out run creates no session and no worktree", async () => {
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_REVIEW_TIMEOUT_SECONDS: "1" },
    });
    const releaseGets = h.forge.parkGetPullRequests();

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);
    // The body parks in the intake stage; the deadline fires there.
    await waitFor(() => h.forge.parkedGets === 1);
    await h.handle.awaitSettled(event.eventId);

    expect(h.forge.postedReviews).toHaveLength(0);
    expect(h.forge.postedFailures).toHaveLength(0);
    expect(h.sessions.createdSessions).toHaveLength(0);
    const records = await runRecords(h);
    expect(records[0]).toMatchObject({ outcome: "failed" });

    // The abandoned body resumes and hits the cancelled gate at the git
    // stage entry: no clone, so no worktree directory ever exists.
    releaseGets();
    await waitFor(() => h.forge.parkedGets === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.sessions.createdSessions).toHaveLength(0);
    await expectGone(worktreeDir(h));
  });

  it("25. abandons a hung session dispose at its bound during the sweep", async () => {
    // PRJ-382 moved teardown off the run and onto the sweep; the
    // bounded-abandonment contract moved with it. A dispose that never
    // resolves gives up at the 15s bound, the pass moves on, and the
    // same pass still removes the worktree it owes.
    const h = await harness({
      script: happyScript(),
      sweepNowMs: Date.now() + 30 * 60 * 60 * 1000,
      wrapSessions: (inner: SessionDriver): SessionDriver => ({
        createSession: (d, a, opts) => inner.createSession(d, a, opts),
        prompt: (sid, text, opts) => inner.prompt(sid, text, opts),
        readOutput: (sid, opts) => inner.readOutput(sid, opts),
        dispose: () => new Promise<string>(() => {}),
      }),
    });

    await postReviewEvent(h);
    // The sweep clock is frozen ahead of the run's stamp: the retained
    // record is already past the 24h window.
    const started = Date.now();
    const summary = await h.handle.sweep();
    const elapsedMs = Date.now() - started;

    // The hung dispose was abandoned at the 15s bound and the pass still
    // completed: the worktree went away, the failed step carries its
    // count, and nothing hung.
    expect(elapsedMs).toBeGreaterThanOrEqual(14_000);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(summary).toMatchObject({ disposed: 0, failed: 1, removed: 1 });
    await expectGone(worktreeDir(h));
  }, 60_000);
});

describe("reliability: transport failure, wedge discipline, retry policy", () => {
  /**
   * The happy one-prompt script, served from the first prompt of every
   * session except the first: session 1's opening prompt dies in
   * transport (the forced failure), while every later session — a fresh
   * run reviews from the top — proceeds normally.
   */
  const happyExceptFirstSession = () => {
    return (sessionId: string, index: number): string => {
      if (sessionId.endsWith("-1") && index === 0) {
        throw new Error(
          "fetch failed: ECONNRESET (forced transport failure, loopback)",
        );
      }
      return happyScript()[index] ?? "";
    };
  };

  /** Post one review event, built explicitly, and wait for its settlement. */
  const postEvent = async (
    h: Harness,
    overrides: Parameters<typeof makeReviewRequested>[0] = {},
  ): Promise<ForgeEvent> => {
    const event = makeReviewRequested({ repo: REPO, pr: PR, ...overrides });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);
    await h.handle.awaitSettled(event.eventId);
    return event;
  };

  it("1. settles a run whose prompt died in transport and consumes the next event", async () => {
    const h = await harness({
      script: happyExceptFirstSession(),
    });

    // First event: the review's first prompt dies mid-transport.
    const first = await postEvent(h);
    let records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      commentId: first.commentId,
      failure: { stage: "review" },
    });
    // PRJ-382: the dead run leaves its work standing — the failed class
    // is exactly the one whose transcript must survive — and the record
    // names the session and the worktree for the sweep.
    expect(h.sessions.disposed).toHaveLength(0);
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
    const failed = records[0] as Record<string, unknown>;
    expect(failed.sessionId).toBe(h.sessions.createdSessions[0]?.sessionId);
    expect(failed.worktreeDir).toBe(worktreeDir(h));
    expect(h.forge.postedFailures).toHaveLength(0);

    // The next event (a fresh @review, its own comment id) is consumed:
    // the dead run released its slot and the pipeline kept serving.
    const second = await postEvent(h);
    records = await runRecords(h);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      outcome: "posted",
      commentId: second.commentId,
    });
    expect(h.forge.postedFailures).toHaveLength(0);
  });

  it("2. spends one delivery once in the default configuration; a fresh delivery runs", async () => {
    const h = await harness({
      script: happyExceptFirstSession(),
    });

    const first = await postEvent(h);
    let records = await runRecords(h);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      commentId: first.commentId,
      failure: { stage: "review" },
    });

    // The same delivery replayed (same event identity) is the spend gate:
    // under `never` the run already happened, so the replay is refused.
    await postEvent(h, {
      commentId: first.commentId,
      eventId: first.eventId,
    });
    records = await runRecords(h);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      outcome: "skipped",
      commentId: first.commentId,
      failure: { stage: "intake" },
    });
    // The refusal was free: no new session, no second comment.
    expect(h.sessions.createdSessions).toHaveLength(1);
    expect(h.forge.postedFailures).toHaveLength(0);
    expect(h.forge.postedReviews).toHaveLength(0);

    // A re-request of the same PR rides its own forge delivery: same
    // reviewer metadata, a new delivery id — a fresh identity, and it
    // runs. The gate keys on the identity, never on the comment anchor.
    const reRequest = await postEvent(h, {
      commentId: first.commentId,
      eventId: `${first.eventId}-re-request`,
    });
    const after = await runRecords(h);
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({
      outcome: "posted",
      commentId: reRequest.commentId,
    });
  });

  it("3. allows one automatic retry of a failed event under the explicit once policy", async () => {
    const h = await harness({
      env: { ZENIGATA_RETRY_POLICY: "once" },
      script: happyExceptFirstSession(),
    });

    const first = await postEvent(h); // run 1: failed in transport
    // Replay of the same delivery (the same event identity): the one
    // allowed automatic retry, which this time completes the review.
    let replay = await postEvent(h, {
      commentId: first.commentId,
      eventId: first.eventId,
    });
    let records = await runRecords(h);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      outcome: "posted",
      commentId: replay.commentId,
    });

    // A further replay of the same delivery: the spend is exhausted, so
    // it refuses for free.
    await postEvent(h, {
      commentId: first.commentId,
      eventId: first.eventId,
    });
    records = await runRecords(h);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ outcome: "skipped" });

    // A fresh delivery is a fresh identity: it runs even after the same
    // comment's other deliveries are all spent.
    replay = await postEvent(h, {
      commentId: first.commentId,
      eventId: `${first.eventId}-re-request`,
    });
    records = await runRecords(h);
    expect(records).toHaveLength(4);
    expect(records[3]).toMatchObject({
      outcome: "posted",
      commentId: replay.commentId,
    });
  });
});

describe("accepted-start records and the rejected-run surface", () => {
  /**
   * Poll an async condition until it holds or the timeout expires. The
   * start and failed-run records are written fire-and-forget by the
   * intake, so tests that reach them from the outside must wait for the
   * journal's file contents, not for a settle hook.
   */
  const waitForAsync = async (
    condition: () => Promise<boolean>,
    timeoutMs = 2000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error("waitForAsync timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("journals the accepted start and the failed run when the review pipeline rejects before its first phase", async () => {
    const errorLines: string[] = [];
    const h = await harness({
      script: happyScript(),
      // The pipeline throws in its setup region: the chain rejects with
      // no session, no forge write, and no settlement record of its own.
      runReview: async () => {
        throw new Error(
          "boom in setup: https://user:supersecrettoken@host/repo is the clone url",
        );
      },
      logger: {
        info: () => {},
        error: (message) => errorLines.push(message),
      },
    });

    const event = makeReviewRequested({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      event,
    );
    expect(response.status).toBe(202);

    // The intake answers 202 before anything runs; the original chain
    // rejection still reaches the event's awaiter.
    await expect(h.handle.awaitSettled(event.eventId)).rejects.toThrow(
      "boom in setup",
    );

    await waitForAsync(async () => (await h.journal()).length >= 2);
    const records = (await h.journal()) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    const start = records.find((r) => r.type === "review-start");
    const failed = records.find((r) => r.type === "review");
    expect(start).toMatchObject({
      type: "review-start",
      eventId: event.eventId,
      repo: REPO,
      pr: PR,
      commentId: event.commentId,
      eventKind: "review_requested",
    });
    expect(failed).toMatchObject({
      type: "review",
      repo: REPO,
      pr: PR,
      eventId: event.eventId,
      commentId: event.commentId,
      outcome: "failed",
      failure: {
        stage: "dispatch",
        message: expect.stringContaining("boom in setup"),
      },
    });
    // The error went through the redaction path before any surface.
    const failure = failed?.failure as { message: string } | undefined;
    expect(failure?.message).not.toContain("supersecrettoken");
    expect(failure?.message).toContain("https://host/repo");
    // Loud on the logger, same redaction, naming the phase position.
    const failureLine = errorLines.find((line) =>
      line.includes("failed before/at a pipeline phase"),
    );
    expect(failureLine).toContain("boom in setup");
    expect(failureLine).not.toContain("supersecrettoken");
    expect(failureLine).toContain("https://host/repo");

    // The run never reached the pipelines: no session, and the failed-run
    // metric the empty catch used to swallow is on the counter.
    expect(h.sessions.createdSessions).toHaveLength(0);
    const metricsText = await fetchMetrics(h);
    expect(metricsText).toContain(
      'zenigata_reviews_total{repo="acme/widget",status="failed"} 1',
    );
  });

  it("journals the failed reply run when the reply pipeline rejects before its first phase", async () => {
    const h = await harness({
      script: happyScript(),
      runReply: async () => {
        throw new Error("reply boom in setup");
      },
    });

    const replyEvent = makeReply({ repo: REPO, pr: PR });
    const response = await h.source.postToIntake(
      intakeUrl(h),
      EVENT_TOKEN,
      replyEvent,
    );
    expect(response.status).toBe(202);

    await expect(h.handle.awaitSettled(replyEvent.eventId)).rejects.toThrow(
      "reply boom in setup",
    );

    await waitForAsync(async () => (await h.journal()).length >= 1);
    const records = (await h.journal()) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "reply",
      repo: REPO,
      pr: PR,
      author: replyEvent.authorLogin,
      inReplyTo: replyEvent.inReplyTo,
      outcome: "failed",
      failure: {
        stage: "dispatch",
        message: expect.stringContaining("reply boom in setup"),
      },
    });
    expect(h.sessions.createdSessions).toHaveLength(0);
    expect(await fetchMetrics(h)).toContain(
      'zenigata_replies_total{repo="acme/widget"} 1',
    );
  });

  it("leaves only the accepted start record when a limiter never dispatches the run", async () => {
    // Reviews fill the limiter's slots and park in them: every
    // getPullRequest awaits a gate that never opens. The events beyond
    // the slots, for other PRs, queue and are never dispatched.
    const gate = new Promise<void>(() => {});
    let parkedCalls = 0;
    const h = await harness({
      script: happyScript(),
      extraPrs: Array.from({ length: REVIEW_SLOTS + 1 }, (_, i) => ({
        repo: REPO,
        pr: PR + i + 1,
      })),
      wrapForge: (inner: ForgeDouble): ForgeAdapter => ({
        getPullRequest: async (repo, pr) => {
          parkedCalls += 1;
          await gate;
          return inner.getPullRequest(repo, pr);
        },
        getPostedReview: (repo, pr, headSha) =>
          inner.getPostedReview(repo, pr, headSha),
        getDiff: (repo, pr) => inner.getDiff(repo, pr),
        postReview: (review, opts) => inner.postReview(review, opts),
        postReply: (input) => inner.postReply(input),
        postFailureComment: (input) => inner.postFailureComment(input),
      }),
    });

    const events: ForgeEvent[] = Array.from(
      { length: REVIEW_SLOTS + 2 },
      (_, i) => makeReviewRequested({ repo: REPO, pr: PR + i }),
    );
    for (const event of events) {
      const response = await h.source.postToIntake(
        intakeUrl(h),
        EVENT_TOKEN,
        event,
      );
      expect(response.status).toBe(202);
    }
    // The limiter fills; only then is a later event's enqueue
    // guaranteed to queue instead of dispatching.
    await waitForAsync(async () => parkedCalls >= REVIEW_SLOTS);

    // The queued accepted events ride their start records alone.
    await waitForAsync(async () => {
      const rows = (await h.journal()) as Array<Record<string, unknown>>;
      if (rows.filter((r) => r.type !== "review-start").length > 0) {
        throw new Error("a run settled for a parked or queued run");
      }
      return rows.length >= events.length;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const records = (await h.journal()) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(events.length);
    // Every accepted event carries exactly its own start line.
    expect(new Set(records.map((r) => r.eventId as string))).toEqual(
      new Set(events.map((e) => e.eventId)),
    );
    expect(new Set(records.map((r) => r.commentId as string))).toEqual(
      new Set(events.map((e) => e.commentId)),
    );
    for (const record of records) {
      expect(record.type).toBe("review-start");
      expect(record.eventKind).toBe("review_requested");
    }
    // None of those runs ever settled.
    expect(h.sessions.createdSessions).toHaveLength(0);
  });

  it("keeps the PRJ-330 redelivery refusal keyed on ran/settled records only", async () => {
    // Bot A accepts an event whose run parks queued forever: its journal
    // gains only the accepted-start record. Nothing ran; nothing was spent.
    const parkGate = new Promise<void>(() => {});
    const hA = await startHarness({
      script: happyScript(),
      wrapForge: (inner: ForgeDouble): ForgeAdapter => ({
        getPullRequest: async (repo, pr) => {
          await parkGate;
          return inner.getPullRequest(repo, pr);
        },
        getPostedReview: (repo, pr, headSha) =>
          inner.getPostedReview(repo, pr, headSha),
        getDiff: (repo, pr) => inner.getDiff(repo, pr),
        postReview: (review, opts) => inner.postReview(review, opts),
        postReply: (input) => inner.postReply(input),
        postFailureComment: (input) => inner.postFailureComment(input),
      }),
    });
    const first = makeReviewRequested({ repo: REPO, pr: PR });
    try {
      const response = await hA.source.postToIntake(
        intakeUrl(hA),
        EVENT_TOKEN,
        first,
      );
      expect(response.status).toBe(202);
      await waitForAsync(async () => (await hA.journal()).length >= 1);
      const rowsA = (await hA.journal()) as Array<Record<string, unknown>>;
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]).toMatchObject({
        type: "review-start",
        commentId: first.commentId,
      });
    } finally {
      await hA.handle.close();
    }

    // Bot B restarts on the same state dir and redelivers the same forge
    // comment behind a fresh delivery: the start record must not consume
    // the gate (a fresh identity), so the redelivery re-runs free (its
    // pipeline rejects in setup, which at least proves it ran). A replay
    // of that now-failed delivery — the same event identity — refuses for
    // free, still keyed on ran/settled records.
    const hB = await startHarness({
      script: happyScript(),
      env: { ZENIGATA_STATE_DIR: hA.stateDir },
      runReview: async () => {
        throw new Error("boom on the redelivered re-run");
      },
    });
    try {
      const replay = makeReviewRequested({
        repo: REPO,
        pr: PR,
        commentId: first.commentId,
        eventId: `${first.eventId}-redelivered`,
      });
      const replayResponse = await hB.source.postToIntake(
        intakeUrl(hB),
        EVENT_TOKEN,
        replay,
      );
      expect(replayResponse.status).toBe(202);
      // The redelivery ran: its chain rejected, and the intake journaled
      // the failed run with the gate's counters.
      await expect(hB.handle.awaitSettled(replay.eventId)).rejects.toThrow(
        "boom on the redelivered re-run",
      );
      await waitForAsync(async () => {
        const rows = (await hB.journal()) as Array<Record<string, unknown>>;
        return rows.length >= 3;
      });

      const second = makeReviewRequested({
        repo: REPO,
        pr: PR,
        commentId: first.commentId,
        eventId: replay.eventId,
      });
      const secondResponse = await hB.source.postToIntake(
        intakeUrl(hB),
        EVENT_TOKEN,
        second,
      );
      expect(secondResponse.status).toBe(202);
      await hB.handle.awaitSettled(second.eventId);

      const records = (await hB.journal()) as Array<Record<string, unknown>>;
      // start(A), start(replay), failed(replay), skipped(refusal)
      expect(records).toHaveLength(4);
      const failed = records.find(
        (r) => r.type === "review" && r.outcome === "failed",
      );
      expect(failed).toMatchObject({
        type: "review",
        commentId: first.commentId,
        outcome: "failed",
        failure: {
          stage: "dispatch",
          message: expect.stringContaining("boom on the redelivered re-run"),
        },
      });
      const skipped = records.find(
        (r) => r.type === "review" && r.outcome === "skipped",
      );
      expect(skipped).toMatchObject({
        type: "review",
        commentId: first.commentId,
        outcome: "skipped",
      });
      // The second run consumed exactly one refused redelivery and the
      // two start records never landed in the gate.
      expect(records.filter((r) => r.type === "review-start")).toHaveLength(2);
      expect(
        new Set(
          records
            .filter((r) => r.type === "review-start")
            .map((r) => r.eventId as string),
        ),
      ).toEqual(new Set([first.eventId, replay.eventId]));
      expect(hB.forge.postedReviews).toHaveLength(0);
      expect(hB.sessions.createdSessions).toHaveLength(0);
    } finally {
      await hB.handle.close();
    }
  });
});
