/**
 * The retention lifecycle (PRJ-382): finished runs keep their session and
 * worktree, the journal record names both with a finished stamp, and the
 * sweep retires them once the stamp is older than the window — boot pass
 * and on-demand pass alike, each bounded and idempotent.
 */

import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSweeper,
  type SweepSummary,
  type Sweeper,
} from "../src/sweep.js";
import {
  canonicalCloneDir,
  canonicalCloneDirName,
} from "../src/canonical-clone.js";
import type { SessionDriver } from "../src/contracts/session.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/ctx.js";
import { makeReply } from "../src/adapters/forge-double.js";
import { worktreeDirName } from "../src/review.js";
import {
  EVENT_TOKEN,
  happyScript,
  PR,
  REPO,
  expectGone,
  intakeUrl,
  postReviewEvent,
  startHarness,
  type Harness,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

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

/** The run records, start lines filtered. */
const runRecords = (h: Harness): Promise<Array<Record<string, unknown>>> =>
  (async () => {
    const rows = (await h.journal()) as Array<Record<string, unknown>>;
    return rows.filter((r) => r.type !== "review-start");
  })();

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

/** A stub SessionDriver: records disposals, optionally throws per case. */
function makeDriverDouble(failures?: {
  always?: Error;
  goneSessionIds?: string[];
}): SessionDriver {
  return {
    createSession: async () => "ses-stub",
    prompt: async () => {},
    readOutput: async () => "",
    dispose: async (sessionId: string) => {
      if (failures?.always !== undefined) {
        throw failures.always;
      }
      if (failures?.goneSessionIds?.includes(sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
    },
  };
}

const silentLogger: Logger = { info: () => {}, error: () => {} };

describe("run keeps its work (PRJ-382)", () => {
  it("the posted run's journal record carries the session, the worktree, and the finished stamp", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);

    expect(h.sessions.disposed).toHaveLength(0);
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
    const [record] = await runRecords(h);
    expect(record.sessionId).toBe(h.sessions.createdSessions[0]?.sessionId);
    expect(record.worktreeDir).toBe(worktreeDir(h));
    expect(Number.isNaN(Date.parse(record.finishedAt as string))).toBe(false);
  });

  it("the failed run's session and worktree survive: the PRJ-381 class", async () => {
    const h = await harness({
      script: () => {
        throw new Error("agent runtime exploded");
      },
    });
    await postReviewEvent(h);

    expect(h.sessions.disposed).toHaveLength(0);
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
    const [record] = await runRecords(h);
    expect(record).toMatchObject({ outcome: "failed" });
    expect(record.sessionId).toBe(h.sessions.createdSessions[0]?.sessionId);
    expect(record.worktreeDir).toBe(worktreeDir(h));
  });
});

describe("the reply session's retention", () => {
  it("the answer keeps its session past settle and the sweep disposes both runs' sessions", async () => {
    const h = await harness({
      seedPostedReview: true,
      script: (sessionId, index) => {
        if (sessionId.endsWith("-1")) {
          return happyScript()[index] ?? "";
        }
        return JSON.stringify({ answer: "standing answer" });
      },
      sweepNowMs: Date.now() + 30 * 60 * 60 * 1000,
    });
    await postReviewEvent(h);
    const replyEvent = makeReply({ repo: REPO, pr: PR, inReplyTo: "r1" });
    await h.source.postToIntake(intakeUrl(h), EVENT_TOKEN, replyEvent);
    await h.handle.awaitSettled(replyEvent.eventId);

    const replyRecords = (await runRecords(h)).filter(
      (r) => r.type === "reply",
    );
    expect(replyRecords).toHaveLength(1);
    const replyRecord = replyRecords[0] as Record<string, unknown>;
    expect(replyRecord.sessionId).toBe(
      h.sessions.createdSessions[1]?.sessionId,
    );
    expect(Number.isNaN(Date.parse(replyRecord.finishedAt as string))).toBe(
      false,
    );
    expect(h.sessions.disposed).toHaveLength(0);

    const summary = await h.handle.sweep();
    expect(summary.disposed).toBe(2);
    expect(summary.removed).toBe(1);
    expect(h.sessions.disposed).toEqual(
      expect.arrayContaining([
        h.sessions.createdSessions[0]?.sessionId,
        h.sessions.createdSessions[1]?.sessionId,
      ]),
    );
    await expectGone(worktreeDir(h));
  });
});

describe("the sweep", () => {
  it("removes the retained worktree after the window and prunes its registration", async () => {
    const h = await harness({
      script: happyScript(),
      sweepNowMs: Date.now() + 30 * 60 * 60 * 1000,
    });
    await postReviewEvent(h);
    const cloneDir = canonicalCloneDir(h.stateDir, REPO);
    await expect(listWorktrees(cloneDir)).resolves.toHaveLength(2);

    const summary = await h.handle.sweep();
    expect(summary).toMatchObject({ disposed: 1, removed: 1, kept: 0 });
    await expectGone(worktreeDir(h));
    expect(h.sessions.disposed).toEqual([
      h.sessions.createdSessions[0]?.sessionId,
    ]);
    // The registration went with the worktree: git worktree remove and
    // prune semantics through the existing removeReviewWorktree machinery.
    const registered = await listWorktrees(cloneDir);
    expect(registered).toHaveLength(1);
    expect(
      registered
        .map((entry) => entry.includes(canonicalCloneDirName(REPO)))
        .some(Boolean),
    ).toBe(true);
  });

  it("keeps retained work inside the window untouched", async () => {
    const h = await harness({
      script: happyScript(),
      sweepNowMs: Date.now() + 60 * 60 * 1000,
    });
    await postReviewEvent(h);

    const summary = await h.handle.sweep();
    expect(summary).toMatchObject({
      disposed: 0,
      removed: 0,
      kept: 1,
      failed: 0,
    });
    await expect(stat(worktreeDir(h))).resolves.toBeDefined();
    expect(h.sessions.disposed).toHaveLength(0);
  });

  it("a second pass over swept work removes nothing new (the logged no-op)", async () => {
    const h = await harness({
      script: happyScript(),
      sweepNowMs: Date.now() + 30 * 60 * 60 * 1000,
    });
    await postReviewEvent(h);
    const first = await h.handle.sweep();
    expect(first).toMatchObject({ disposed: 1, removed: 1 });

    // The journal has no swept marker, so each pass attempts the record
    // again: the worktree side finds the directory gone (the no-op) and
    // the session side re-attempts the dispose on the double. Nothing is
    // removed a second time and no step fails.
    const second = await h.handle.sweep();
    expect(second).toMatchObject({ removed: 0, noops: 1, failed: 0 });
    await expectGone(worktreeDir(h));
  });

  it("the boot pass picks up the records a restart left behind", async () => {
    const worktreesDir = await mkdtemp(join(tmpdir(), "zenigata-sweep-"));
    const seededWorktree = join(worktreesDir, "seeded-worktree");
    await mkdir(seededWorktree, { recursive: true });
    const longAgo = iso(Date.now() - 48 * 60 * 60 * 1000);
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_WORKTREES_DIR: worktreesDir },
      seedJournal: [
        {
          ts: longAgo,
          type: "review",
          reviewId: "seeded-review",
          repo: REPO,
          pr: PR,
          requester: "example-user",
          phases: [],
          inlineComments: 0,
          humanizer: { changed: false },
          outcome: "posted",
          sessionId: "ses-pre-restart-review",
          worktreeDir: seededWorktree,
          finishedAt: longAgo,
        },
        {
          ts: longAgo,
          type: "reply",
          repo: REPO,
          pr: PR,
          author: "example-user",
          inReplyTo: "seeded-r1",
          outcome: "posted",
          sessionId: "ses-pre-restart-reply",
          finishedAt: longAgo,
        },
      ],
    });
    // startServer awaited the boot pass, so by the time the harness is
    // returned both expired sessions are gone and the seeded worktree
    // directory with them.
    expect(h.sessions.disposed).toEqual(
      expect.arrayContaining([
        "ses-pre-restart-review",
        "ses-pre-restart-reply",
      ]),
    );
    await expectGone(seededWorktree);
  });

  it("tears down immediately when the window is 0: the escape hatch", async () => {
    const h = await harness({
      script: happyScript(),
      env: { ZENIGATA_RETENTION_WINDOW_SECONDS: "0" },
    });
    await postReviewEvent(h);

    expect(h.sessions.disposed).toEqual([
      h.sessions.createdSessions[0]?.sessionId,
    ]);
    await expectGone(worktreeDir(h));
    const [record] = await runRecords(h);
    expect(record.sessionId).toBeUndefined();
    expect(record.worktreeDir).toBeUndefined();
    expect(record.finishedAt).toBeUndefined();
  });
});

describe("sweep steps (unit): idempotency and failure classification", () => {
  const baseConfig: Config = {
    listenPort: 0,
    stateDir: "/tmp/zenigata-sweep-unit",
    allowedLogins: [],
    allowedRepos: [],
    humans: [],
    adapterUrl: "http://adapter.invalid",
    forgeUrl: "https://forge.invalid",
    adapterToken: "t",
    eventToken: "t",
    opencodeUrl: "http://opencode.invalid",
    memoryUrl: "http://memory.invalid",
    reviewTimeoutSeconds: 1,
    agent: "zenigata-reviewer",
    worktreesDir: "/tmp/zenigata-sweep-unit/worktrees",
    turnPollSeconds: 1,
    turnBudgetSeconds: 1,
    retentionWindowSeconds: 3600,
    retryPolicy: "never",
  };

  const candidateRecord = (over: Record<string, unknown> = {}) => ({
    ts: iso(0),
    type: "review",
    reviewId: "unit",
    repo: REPO,
    pr: PR,
    requester: "example-user",
    phases: [],
    inlineComments: 0,
    humanizer: { changed: false },
    outcome: "posted",
    finishedAt: iso(Date.now() - 48 * 60 * 60 * 1000),
    ...over,
  });

  const drive = async (
    sweeper: Sweeper,
    lines: unknown[],
  ): Promise<SweepSummary> =>
    sweeper.sweepOnce(
      lines.map((value, i) => ({
        line: i + 1,
        label: `journal line ${i + 1}`,
        value,
      })),
    );

  it("calls an already-disposed session a no-op, and a real failure a failure", async () => {
    const gone = await drive(
      createSweeper({
        config: baseConfig,
        sessions: makeDriverDouble({ goneSessionIds: ["ses-gone"] }),
        logger: silentLogger,
        clock: { now: () => Date.now() },
      }),
      [candidateRecord({ sessionId: "ses-gone" })],
    );
    expect(gone).toMatchObject({ disposed: 0, noops: 1, failed: 0 });

    const dead = await drive(
      createSweeper({
        config: baseConfig,
        sessions: makeDriverDouble({
          always: new Error("memory daemon down"),
        }),
        logger: silentLogger,
        clock: { now: () => Date.now() },
      }),
      [candidateRecord({ sessionId: "ses-any" })],
    );
    expect(dead).toMatchObject({ disposed: 0, noops: 0, failed: 1 });
  });

  it("skips a candidate-shaped record with no comparable stamp instead of guessing its age", async () => {
    const summary = await drive(
      createSweeper({
        config: baseConfig,
        sessions: makeDriverDouble(),
        logger: silentLogger,
        clock: { now: () => Date.now() },
      }),
      [candidateRecord({ sessionId: "ses-stamped", finishedAt: undefined })],
    );
    expect(summary).toMatchObject({ failed: 1, disposed: 0, noops: 0 });
  });
});
