/**
 * Test fixtures: a hermetic git repository (bare origin + base and head
 * commits), a seeded ForgeDouble built from it, and a startServer harness
 * that binds port 0.
 */

import { execFile } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  ForgeDouble,
  ForgeEventSource,
  makeReviewRequested,
  type ReviewRequestedOverrides,
  type SeededPr,
} from "../src/adapters/forge-double.js";
import {
  SessionDouble,
  type SessionScript,
} from "../src/adapters/session-double.js";
import { loadConfig, type Config } from "../src/config.js";
import {
  startServer,
  type ServerDeps,
  type ServerHandle,
} from "../src/server.js";
import { runReview } from "../src/review.js";
import { runReply } from "../src/replies.js";
import { journalPath } from "../src/journal.js";
import type { Logger } from "../src/ctx.js";
import type { ForgeAdapter } from "../src/contracts/forge.js";
import type { SessionDriver } from "../src/contracts/session.js";
import type { MemoryGateway } from "../src/contracts/memory.js";
import { MemoryFake } from "./memory-fake.js";

const exec = promisify(execFile);

export const REPO = "acme/widget";
export const PR = 1;
export const EVENT_TOKEN = "event-secret";
/** The adapter token the harness's default environment carries. */
export const ADAPTER_TOKEN = "adapter-secret";

// ---------------------------------------------------------------------------
// Scripted review outputs
// ---------------------------------------------------------------------------

/**
 * The final reply a scripted session answers with: the status contract's
 * one line. The session posts its own review in a real run; the pipeline
 * never sees the payload, only this line.
 */
export const POSTED_REPLY = [
  "The review is on the pull request.",
  "",
  "review-status: posted",
].join("\n");

export const FAILED_REPLY = [
  "The review did not make it to the pull request.",
  "",
  "review-status: failed",
].join("\n");

/** The one-prompt script: the session replies with the status line. */
export const happyScript = () => [POSTED_REPLY];

/** The review body the harness's seeded posted review carries. */
export const SEEDED_POSTED_BODY =
  "The case: two lines land and neither one says what it adds.";

/**
 * Poll a probe until it returns a value present — anything but undefined,
 * null, or false — or the timeout expires. The probe runs on every tick,
 * so it may await. An answer of 0 or an empty string is present and
 * resolves; a probe that keeps returning false (or nothing) burns the
 * timeout.
 */
export async function waitFor<T>(
  probe: () =>
    | T
    | undefined
    | null
    | false
    | Promise<T | undefined | null | false>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface GitFixture {
  /** file:// URL of the bare origin the double's cloneUrl points at. */
  cloneUrl: string;
  baseSha: string;
  headSha: string;
  headRef: "feature";
  baseRef: "main";
  /** The PR's unified diff (git diff baseSha..headSha). */
  diff: string;
  /** Path of the one file the head commit touches. */
  file: string;
  /** The tmp root holding origin.git and the work repo (for cleanup/debug). */
  root: string;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, cwd === undefined ? {} : { cwd });
  return stdout;
}

/**
 * Build a bare origin with a base commit on main and a head branch with one
 * more commit touching a file mid-tree, so changed lines have anchors on
 * both sides.
 */
export async function buildGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "zenigata-git-"));
  const work = join(root, "work");
  const origin = join(root, "origin.git");

  await git(["init", "--initial-branch", "main", work]);
  await git(["config", "user.email", "fixture@example.invalid"], work);
  await git(["config", "user.name", "fixture"], work);

  const file = "notes.md";
  await writeFile(
    join(work, file),
    "alpha line\nbeta line\ngamma line\ndelta line\nepsilon line\n",
  );
  await git(["add", file], work);
  await git(["commit", "-m", "base"], work);
  const baseSha = (await git(["rev-parse", "HEAD"], work)).trim();

  await git(["checkout", "-b", "feature"], work);
  await writeFile(
    join(work, file),
    "alpha line\nbeta line\nadded one\nadded two\ngamma line\ndelta line\nepsilon line\n",
  );
  await git(["add", file], work);
  await git(["commit", "-m", "head"], work);
  const headSha = (await git(["rev-parse", "HEAD"], work)).trim();

  const diff = await git(["diff", `${baseSha}..${headSha}`], work);

  await git(["init", "--bare", origin]);
  await git(["push", origin, "main", "feature"], work);

  return {
    cloneUrl: `file://${origin}`,
    baseSha,
    headSha,
    headRef: "feature",
    baseRef: "main",
    diff,
    file,
    root,
  };
}

export function seededPr(
  fixture: GitFixture,
  over: Partial<SeededPr> = {},
): SeededPr {
  return {
    repo: REPO,
    pr: PR,
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    headRef: fixture.headRef,
    baseRef: fixture.baseRef,
    cloneUrl: fixture.cloneUrl,
    title: "add two lines",
    body: "a fixture pull request",
    isFork: false,
    diff: fixture.diff,
    ...over,
  };
}

export function makeForgeDouble(
  fixture: GitFixture,
  over: Partial<SeededPr> = {},
  extra: Array<{ repo: string; pr: number }> = [],
): ForgeDouble {
  const prs: Record<string, SeededPr> = {
    [`${REPO}#${PR}`]: seededPr(fixture, over),
  };
  for (const extraPr of extra) {
    prs[`${extraPr.repo}#${extraPr.pr}`] = seededPr(fixture, {
      repo: extraPr.repo,
      pr: extraPr.pr,
    });
  }
  return new ForgeDouble({ prs });
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

export interface Harness {
  handle: ServerHandle;
  forge: ForgeDouble;
  sessions: SessionDouble;
  memory: MemoryGateway;
  source: ForgeEventSource;
  config: Config;
  fixture: GitFixture;
  /** The state dir the server was pointed at. */
  stateDir: string;
  /** reviews.jsonl, re-read and parsed on every call. */
  journal(): Promise<unknown[]>;
}

export interface HarnessOptions {
  script: SessionScript;
  allowedLogins?: string;
  allowedRepos?: string;
  personaFile?: string;
  forgeOverrides?: Partial<SeededPr>;
  /** Extra seeded PRs (same fixture diff/refs) for cross-PR scenarios. */
  extraPrs?: Array<{ repo: string; pr: number }>;
  memory?: MemoryGateway;
  env?: Record<string, string | undefined>;
  /**
   * Seed the double with the review the session "posted" through its
   * forge tools (review 665): the pipeline never posts, so a test that
   * exercises the reply index, the record's landed shape, or any reply
   * to the review's comments seeds what such a post leaves on the forge.
   * The bookkeeping lookup then fills the index and the record.
   */
  seedPostedReview?: boolean;
  /** Wrap the SessionDouble before injection (test gates, hooks). */
  wrapSessions?: (inner: SessionDriver) => SessionDriver;
  /** Wrap the ForgeDouble before injection (test hooks on the forge side). */
  wrapForge?: (inner: ForgeDouble) => ForgeAdapter;
  /**
   * Test seams for the intake's background chains: force a pipeline
   * rejection to exercise the rejected-run surface (the journaling catch
   * on each chain) without staging a failure inside a real run.
   */
  runReview?: typeof runReview;
  runReply?: typeof runReply;
  /** Replace the console logger (tests capture failed-run log lines). */
  logger?: Logger;
  /**
   * Journal lines appended into the state dir before the server boots:
   * the pre-restart records a boot retention sweep will see (PRJ-382).
   */
  seedJournal?: Array<Record<string, unknown>>;
  /**
   * The retention sweep's window compare on a frozen clock at this epoch
   * ms. Production leaves it unset and the sweep reads the system clock;
   * setting it ahead of the runs' real stamps ages finished work past
   * the window without moving the run timing itself.
   */
  sweepNowMs?: number;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const fixture = await buildGitFixture();
  const stateDir = await mkdtemp(join(tmpdir(), "zenigata-state-"));
  const forge = makeForgeDouble(
    fixture,
    options.forgeOverrides,
    options.extraPrs,
  );
  if (options.seedPostedReview === true) {
    await forge.postReview({
      repo: REPO,
      pr: PR,
      expectedHeadSha: fixture.headSha,
      verdict: "REQUEST_CHANGES",
      body: SEEDED_POSTED_BODY,
      comments: [
        {
          path: "notes.md",
          line: 3,
          body: "Agent-generated:\n\nissue (blocking): 'added one' names nothing.",
        },
      ],
    });
  }
  const sessions = new SessionDouble(options.script);
  const memory = options.memory ?? new MemoryFake();

  const env: Record<string, string | undefined> = {
    ZENIGATA_STATE_DIR: stateDir,
    ZENIGATA_ALLOWED_LOGINS: options.allowedLogins ?? "example-user, coworker",
    ZENIGATA_ALLOWED_REPOS: options.allowedRepos ?? "",
    ZENIGATA_PERSONA_FILE: options.personaFile,
    ZENIGATA_ADAPTER_URL: "http://adapter.invalid",
    ZENIGATA_FORGE_URL: "https://forge.invalid",
    ZENIGATA_ADAPTER_TOKEN: "adapter-secret",
    ZENIGATA_EVENT_TOKEN: EVENT_TOKEN,
    ZENIGATA_OPENCODE_URL: "http://opencode.invalid",
    ZENIGATA_MEMORY_URL: "http://memory.invalid",
    ZENIGATA_LISTEN_PORT: "0",
    ...options.env,
  };
  // Drop explicitly-undefined keys so optional vars stay unset.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete env[key];
    }
  }
  const config = loadConfig(env);
  // Pre-restart records land before the boot walk reads the journal, so
  // the boot retention sweep sees them the way a restart would.
  if (options.seedJournal !== undefined && options.seedJournal.length > 0) {
    await appendFile(
      journalPath(config.stateDir),
      options.seedJournal
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
      "utf8",
    );
  }

  const sessionsForServer = options.wrapSessions
    ? options.wrapSessions(sessions)
    : sessions;
  const forgeForServer = options.wrapForge ? options.wrapForge(forge) : forge;
  const deps: ServerDeps = {
    forge: forgeForServer,
    sessions: sessionsForServer,
    memory,
  };
  if (options.sweepNowMs !== undefined) {
    deps.sweepClock = { now: () => options.sweepNowMs as number };
  }
  if (options.logger !== undefined) {
    deps.logger = options.logger;
  }
  if (options.runReview !== undefined) {
    deps.runReview = options.runReview;
  }
  if (options.runReply !== undefined) {
    deps.runReply = options.runReply;
  }
  const handle = await startServer(config, deps);
  return {
    handle,
    forge,
    sessions,
    memory,
    source: new ForgeEventSource(),
    config,
    fixture,
    stateDir,
    journal: async () => {
      // Read exactly what the server writes: the config's state dir, not
      // the harness's default tmp dir. A harness that overrides
      // ZENIGATA_STATE_DIR (a restart story across two servers) journals
      // into the overridden dir. A file that does not exist yet counts as
      // empty: the accepted-start record is written fire-and-forget, so a
      // read can precede the first append.
      let text: string;
      try {
        text = await readFile(journalPath(config.stateDir), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    },
  };
}

export const intakeUrl = (harness: Harness): string =>
  `http://127.0.0.1:${harness.handle.port}`;

export interface PostedEvent {
  eventId: string;
  response: Response;
}

/** Post a review event through the intake and await its full settlement. */
export async function postReviewEvent(
  harness: Harness,
  overrides: ReviewRequestedOverrides = {},
): Promise<Response> {
  const event = makeReviewRequested({ repo: REPO, pr: PR, ...overrides });
  const response = await harness.source.postToIntake(
    intakeUrl(harness),
    EVENT_TOKEN,
    event,
  );
  expect(response.status).toBe(202);
  await harness.handle.awaitSettled(event.eventId);
  return response;
}

/** Assert a directory no longer exists. */
export async function expectGone(dir: string): Promise<void> {
  await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
}
