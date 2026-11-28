import assert from "node:assert/strict";
import test from "node:test";
import { ForgejoSource } from "../forgejo-source.ts";
import { createIngestQueue } from "../webhook-events.ts";
import type { AdoptedWatch, WatchCursor, WatchEvent } from "../kernel.ts";
import type { IngestEntry } from "../webhook-events.ts";

// The forge source's webhook half (PRJ-542): the drain runs before the
// API read, the dedupe ids survive run reuse and replay, each family's
// markers absorb the other path's wake, and the baseline race leaves
// the queue's entries to the watch that can consume them. Local fakes
// only — the reads are this suite's own records.

const REPO = "acme/widgets";

const debug = () => {};

type Reads = ConstructorParameters<typeof ForgejoSource>[0];

const reads = (over: Partial<Reads> = {}): Reads & { trace: string[] } => {
  const trace: string[] = [];
  const named = <T>(name: string, fn: T): T =>
    ((...args: Array<unknown>) => {
      trace.push(name);
      return (fn as (...rest: Array<unknown>) => unknown)(...args);
    }) as T;
  const base = {
    prRecord: async () => ({
      state: "open",
      head: { sha: "sha-7" },
    }),
    reviewsOf: async () => [],
    runsOfHead: async () => [],
    runRecord: async (_owner: string, _name: string, runId: number) => ({
      id: runId,
      status: "success",
    }),
    runJobs: async () => [],
    jobLog: async () => "",
    branchesOf: async () => [],
    ...over,
  };
  return {
    trace,
    prRecord: named("prRecord", base.prRecord),
    reviewsOf: named("reviewsOf", base.reviewsOf),
    runsOfHead: named("runsOfHead", base.runsOfHead),
    runRecord: named("runRecord", base.runRecord),
    runJobs: named("runJobs", base.runJobs),
    jobLog: named("jobLog", base.jobLog),
    branchesOf: named("branchesOf", base.branchesOf),
  } as Reads & { trace: string[] };
};

const watch = (kind: string, ref: string): AdoptedWatch => ({
  source: "forgejo",
  id: "w-test",
  session: "ses_test",
  kind,
  repo: REPO,
  ref,
  delivered: {},
});

const cursor = (delivered: Record<string, boolean> = {}): WatchCursor => ({
  delivered,
  baselinePending: false,
});

const runEntry = (
  runId: number,
  over: Partial<IngestEntry> = {},
): IngestEntry => ({
  family: "run",
  repo: REPO,
  runId,
  headSha: "sha-7",
  event: {
    id: `run:${REPO}:${runId}:completed:u${runId}`,
    type: "run",
    fields: [
      { kind: "id", name: "run", value: String(runId) },
      { kind: "status", name: "run-status", value: "failure" },
    ],
  },
  ...over,
});

const reviewEntry = (index: number, reviewId: number): IngestEntry => ({
  family: "pr-review",
  repo: REPO,
  index,
  reviewId,
  event: {
    id: `pr-review:${REPO}:${index}:${reviewId}`,
    type: "review",
    fields: [
      { kind: "id", name: "review", value: String(reviewId) },
      { kind: "ref", name: "reviewer", value: "fresh-reviewer" },
      { kind: "status", name: "review-state", value: "COMMENTED" },
    ],
  },
});

const closeEntry = (index: number): IngestEntry => ({
  family: "pr-close",
  repo: REPO,
  index,
  event: {
    id: `pr:${REPO}:${index}:closed:u${index}`,
    type: "closed",
    terminal: true,
    fields: [
      { kind: "id", name: "lifecycle", value: "closed" },
      { kind: "status", name: "how", value: "merged" },
    ],
  },
});

const ids = (events: WatchEvent[]): string[] => events.map((event) => event.id);

test("a registered watch's repo reads lowercase, the queue key's canonical form", () => {
  const fake = reads();
  const source = new ForgejoSource(fake, debug);
  const seed = source.normalize({
    kind: "pr",
    repo: "ACME/Widgets",
    ref: "7",
  });
  assert.equal(
    seed.repo,
    "acme/widgets",
    "a case-mismatched registration spelling cannot miss a delivery",
  );
  assert.equal(
    source.normalize({ kind: "branch", repo: "  Acme/Widgets ", ref: "main" })
      .repo,
    "acme/widgets",
    "whitespace around the spelling reads the same way",
  );
});

test("the drain runs before the API read, and the queue's entry answers even when the read gives nothing", async () => {
  const fake = reads();
  let queue = createIngestQueue({ wake: () => {}, debug });
  let source = new ForgejoSource(fake, debug, {
    take: (repo, want) => {
      fake.trace.push("take");
      return queue.take(repo, want);
    },
  });
  queue.push(REPO, runEntry(999));
  const events = await source.poll(watch("run", "999"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(ids(events ?? []), ["run:acme/widgets:999:completed:u999"]);
  assert.ok(
    fake.trace.indexOf("take") < fake.trace.indexOf("runRecord"),
    `the drain precedes the read: ${JSON.stringify(fake.trace)}`,
  );

  // The read fails: the taken entries are already answered, not lost.
  queue = createIngestQueue({ wake: () => {}, debug });
  const failing = reads({
    runRecord: async () => {
      throw new Error("GET runs/999 → HTTP 500");
    },
  });
  source = new ForgejoSource(failing, debug, {
    take: (repo, want) => {
      failing.trace.push("take");
      return queue.take(repo, want);
    },
  });
  queue.push(REPO, runEntry(999));
  const fromQueue = await source.poll(watch("run", "999"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(
    ids(fromQueue ?? []),
    ["run:acme/widgets:999:completed:u999"],
    "a verified delivery is not lost behind a failed read",
  );
  // Nothing queued and the read still failing: the poll throws, the
  // kernel's per-watch isolation says it, and the next pass retries —
  // the queue held nothing to lose.
  const queue3 = createIngestQueue({ wake: () => {}, debug });
  const source3 = new ForgejoSource(failing, debug, {
    take: (repo, want) => queue3.take(repo, want),
  });
  await assert.rejects(
    source3.poll(watch("run", "999"), cursor(), { memo: new Map() }),
  );
});

test("a replayed delivery is absorbed by its dedupe id; a reused run id on a rerun wakes again", async () => {
  const fake = reads();
  const queue = createIngestQueue({ wake: () => {}, debug });
  const source = new ForgejoSource(fake, debug, {
    take: (repo, want) => queue.take(repo, want),
  });
  // Replay: the same delivery twice, the second absorbed.
  queue.push(REPO, runEntry(999));
  const first = await source.poll(watch("run", "999"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(ids(first ?? []), ["run:acme/widgets:999:completed:u999"]);
  queue.push(REPO, runEntry(999));
  const replay = await source.poll(
    watch("run", "999"),
    cursor({ "run:acme/widgets:999:completed:u999": true }),
    { memo: new Map() },
  );
  assert.deepEqual(ids(replay ?? []), [], "the replay never wakes twice");

  // Run reuse: the same run id, a rerun's fresh updated_at, wakes.
  const rerun = runEntry(999, {
    event: {
      id: "run:acme/widgets:999:completed:u-rerun",
      type: "run",
      fields: [
        { kind: "id", name: "run", value: "999" },
        { kind: "status", name: "run-status", value: "failure" },
      ],
    },
  });
  queue.push(REPO, rerun);
  const second = await source.poll(
    watch("run", "999"),
    cursor({ "run:acme/widgets:999:completed:u999": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(second ?? []),
    ["run:acme/widgets:999:completed:u-rerun"],
    "the rerun's fresh dedupe id wakes",
  );

  // The REST-first absorb: the row's own id spent, the delivery absorbed.
  queue.push(REPO, runEntry(999));
  const restFirst = await source.poll(
    watch("run", "999"),
    cursor({ "999": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(restFirst ?? []),
    [],
    "the REST row's marker absorbs the delivery",
  );
});

test("the REST read absorbs a webhook-delivered run by the dedupe id's prefix, and never a neighbor's run", async () => {
  const fake = reads({
    runRecord: async (_owner: string, _name: string, runId: number) => ({
      id: runId,
      status: "failure",
    }),
  });
  const source = new ForgejoSource(fake, debug);
  const absorbed = await source.poll(
    watch("run", "999"),
    cursor({ "run:acme/widgets:999:completed:u1": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(absorbed ?? []),
    [],
    "the webhook-form marker absorbs the REST row",
  );

  const neighbor = await source.poll(
    watch("run", "999"),
    cursor({ "run:acme/widgets:99:completed:u1": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(neighbor ?? []),
    ["999"],
    "a run 99 marker never absorbs run 999",
  );

  // Same rule on the pr watch's head read.
  const prFake = reads({
    prRecord: async () => ({ state: "open", head: { sha: "sha-7" } }),
    runsOfHead: async () => [{ id: 999, status: "failure", head_sha: "sha-7" }],
  });
  const prSource = new ForgejoSource(prFake, debug);
  const prAbsorbed = await prSource.poll(
    watch("pr", "7"),
    cursor({ "run:acme/widgets:999:completed:u1": true }),
    {
      memo: new Map(),
    },
  );
  assert.deepEqual(ids(prAbsorbed ?? []), []);
});

test("a queued review wakes; the REST page skips the taken id; either family's marker absorbs the other path", async () => {
  const fake = reads({
    reviewsOf: async () => [
      { id: 2, state: "COMMENTED", user: { login: "queued-one" } },
      { id: 3, state: "APPROVED", user: { login: "rest-only" } },
    ],
  });
  const queue = createIngestQueue({ wake: () => {}, debug });
  const source = new ForgejoSource(fake, debug, {
    take: (repo, want) => queue.take(repo, want),
  });
  queue.push(REPO, reviewEntry(7, 2));
  const both = await source.poll(watch("pr-reviews", "7"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(
    ids(both ?? []),
    ["pr-review:acme/widgets:7:2", "3"],
    "one pass answers the delivery and the rest-only review, once each",
  );
  assert.equal(
    queue.take(REPO, () => true).length,
    0,
    "the taken entry was consumed",
  );

  // The webhook-first absorb: the dedupe marker on the row, the REST
  // review silent.
  queue.push(REPO, reviewEntry(7, 4));
  const webhookFirst = await source.poll(
    watch("pr-reviews", "7"),
    cursor({ "pr-review:acme/widgets:7:4": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(webhookFirst ?? []),
    ["2", "3"],
    "review 4 was already delivered by the receiver's path",
  );

  // The REST-first absorb: the plain marker on the row, the delivery
  // silent.
  queue.push(REPO, reviewEntry(7, 2));
  const restFirst = await source.poll(
    watch("pr-reviews", "7"),
    cursor({ "2": true }),
    { memo: new Map() },
  );
  assert.deepEqual(ids(restFirst ?? []), ["3"]);
});

test("the baseline race: a baseline-pending watch takes nothing, and the backlog the baseline spent absorbs the queued delivery", async () => {
  const fake = reads({
    reviewsOf: async () => [
      { id: 5, state: "APPROVED", user: { login: "backlog" } },
    ],
  });
  const source = new ForgejoSource(fake, debug, {
    take: () => {
      throw new Error("a baseline-pending watch must never take");
    },
  });
  // Baseline pending: the pass spends the page whole and takes nothing.
  const pending = await source.poll(
    watch("pr-reviews", "7"),
    { delivered: {}, baselinePending: true },
    { memo: new Map() },
  );
  assert.deepEqual(
    (pending ?? []).map((event) => event.id),
    ["5"],
  );
  assert.deepEqual(
    (pending ?? []).map((event) => event.baseline),
    [true],
    "the page is the backlog, spent whole",
  );

  // The baseline spent review 5 under the REST form; a delivery for the
  // same review is absorbed by that marker.
  const queue2 = createIngestQueue({ wake: () => {}, debug });
  const source2 = new ForgejoSource(fake, debug, {
    take: (repo, want) => queue2.take(repo, want),
  });
  queue2.push(REPO, reviewEntry(7, 5));
  const absorbed = await source2.poll(
    watch("pr-reviews", "7"),
    cursor({ "5": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(absorbed ?? []),
    [],
    "the baseline's marker absorbs the delivery — one wake per review",
  );

  // A review the baseline never saw (it arrived after the register's
  // read) still wakes from the queue.
  queue2.push(REPO, reviewEntry(7, 6));
  const fresh = await source2.poll(
    watch("pr-reviews", "7"),
    cursor({ "5": true }),
    { memo: new Map() },
  );
  assert.deepEqual(ids(fresh ?? []), ["pr-review:acme/widgets:7:6"]);
});

test("a reviews read that already failed this pass still answers the queue's entries", async () => {
  const failing = reads({
    reviewsOf: async () => {
      throw new Error("GET reviews → HTTP 500");
    },
  });
  const queue = createIngestQueue({ wake: () => {}, debug });
  const source = new ForgejoSource(failing, debug, {
    take: (repo, want) => queue.take(repo, want),
  });
  const memo = new Map();
  // The read fails once: nothing queued, the failure is the answer, and
  // the memo carries it for the pass's other consumers.
  await assert.rejects(
    source.poll(watch("pr-reviews", "7"), cursor(), { memo }),
  );
  // The delivery arrives after the read failed: this pass still answers
  // it, never losing a verified delivery behind the failure.
  queue.push(REPO, reviewEntry(7, 8));
  const events = await source.poll(watch("pr-reviews", "7"), cursor(), {
    memo,
  });
  assert.deepEqual(ids(events ?? []), ["pr-review:acme/widgets:7:8"]);
});

test("a queued close answers ahead of the lifecycle read, and the heal pass rides the webhook marker's key", async () => {
  // Open pull request: the close entry is not the read's word yet, and
  // nothing else answers.
  const open = reads({
    prRecord: async () => ({ state: "open", head: { sha: "sha-7" } }),
  });
  const openQueue = createIngestQueue({ wake: () => {}, debug });
  const openSource = new ForgejoSource(open, debug, {
    take: (repo, want) => openQueue.take(repo, want),
  });
  openQueue.push(REPO, closeEntry(7));
  const held = await openSource.poll(watch("pr", "7"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(
    ids(held ?? []),
    [],
    "a close delivery for an open pull request is not a wake",
  );

  // Closed pull request, delivery and read in one pass: the delivery's
  // dedupe id goes first, the read's word behind it.
  const closed = reads({
    prRecord: async () => ({
      state: "closed",
      merged: true,
      merged_at: "2026-11-26T10:00:00Z",
      closed_at: "2026-11-26T10:00:00Z",
    }),
  });
  const closedQueue = createIngestQueue({ wake: () => {}, debug });
  const closedSource = new ForgejoSource(closed, debug, {
    take: (repo, want) => closedQueue.take(repo, want),
  });
  closedQueue.push(REPO, closeEntry(7));
  const both = await closedSource.poll(watch("pr", "7"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(ids(both ?? []), ["pr:acme/widgets:7:closed:u7", "closed"]);

  // The heal pass: the webhook close's marker on the row, the dissolve
  // uncommitted — the read's word answers under the marker's own key,
  // so the settle reads it spent and rides the dissolve.
  const heal = await closedSource.poll(
    watch("pr", "7"),
    cursor({ "pr:acme/widgets:7:closed:u7": true }),
    { memo: new Map() },
  );
  assert.deepEqual(
    ids(heal ?? []),
    ["pr:acme/widgets:7:closed:u7"],
    "the heal word carries the webhook marker's key, never a second close mail",
  );
});

test("a pr watch's head deliveries match the resolved sha, and prepare reads the run's id off the fields", async () => {
  const fake = reads({
    prRecord: async () => ({ state: "open", head: { sha: "sha-7" } }),
    runsOfHead: async () => [],
    runJobs: async (_owner: string, _name: string, runId: number) => {
      assert.equal(
        runId,
        999,
        "the job read names the run's real id, not the dedupe id",
      );
      return [];
    },
  });
  const queue = createIngestQueue({ wake: () => {}, debug });
  const source = new ForgejoSource(fake, debug, {
    take: (repo, want) => queue.take(repo, want),
  });
  queue.push(REPO, runEntry(999));
  const events = await source.poll(watch("pr", "7"), cursor(), {
    memo: new Map(),
  });
  assert.deepEqual(ids(events ?? []), ["run:acme/widgets:999:completed:u999"]);
  const detail = await source.prepare(watch("pr", "7"), events![0]);
  assert.deepEqual(detail, { jobsText: null, tail: null });
});
