import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_STATUSES,
  createIngestQueue,
  normalizeForgejoDelivery,
  prDedupeId,
  reviewDedupeId,
  runDedupeId,
  runDedupePrefix,
  webhookPrMarkerKey,
  webhookRunSpent,
  type IngestEntry,
} from "../webhook-events.ts";
import type { WatchEvent } from "../kernel.ts";

// The webhook deliveries' event side (PRJ-542): the payload→event
// normalization per family, the content-derived dedupe ids, and the
// per-repo ingest queue the forge source drains. The fixtures are the
// forge's GitHub-compatible webhook records, local only — nothing here
// dials a forge.

const repo = { full_name: "acme/widgets" };

const runPayload = (over: Record<string, unknown> = {}) => {
  const { workflow_run, ...rest } = over;
  return {
    action: "completed",
    repository: repo,
    workflow_run: {
      id: 999,
      status: "failure",
      updated_at: "2026-11-26T10:00:00Z",
      head_sha: "sha-7",
      html_url: "https://forge.example/acme/widgets/actions/runs/999",
      run_number: 12,
      ...(workflow_run as object),
    },
    ...rest,
  };
};

const reviewPayload = (over: Record<string, unknown> = {}) => {
  const { review, ...rest } = over;
  return {
    action: "submitted",
    repository: repo,
    pull_request: { number: 7, state: "open" },
    review: {
      id: 42,
      state: "APPROVED",
      user: { login: "fresh-reviewer" },
      html_url: "https://forge.example/acme/widgets/pulls/7#review-42",
      ...(review as object),
    },
    ...rest,
  };
};

const prPayload = (over: Record<string, unknown> = {}) => {
  const { pull_request, ...rest } = over;
  return {
    action: "closed",
    repository: repo,
    pull_request: {
      number: 7,
      state: "closed",
      merged: true,
      merged_at: "2026-11-26T10:00:00Z",
      closed_at: "2026-11-26T10:00:00Z",
      updated_at: "2026-11-26T10:00:01Z",
      ...(pull_request as object),
    },
    ...rest,
  };
};

const fieldOf = (event: WatchEvent, name: string): string | undefined =>
  event.fields.find((field) => field.name === name)?.value;

test("a run delivery normalizes to the run family with its content-derived dedupe id", () => {
  const entry = normalizeForgejoDelivery(runPayload());
  assert.ok(entry, "the delivery names an event");
  assert.equal(entry!.family, "run");
  assert.equal(entry!.repo, "acme/widgets");
  assert.equal(entry!.runId, 999);
  assert.equal(entry!.headSha, "sha-7");
  assert.equal(
    entry!.event.id,
    "run:acme/widgets:999:completed:2026-11-26T10:00:00Z",
  );
  assert.equal(entry!.event.type, "run");
  assert.equal(fieldOf(entry!.event, "run"), "999");
  assert.equal(fieldOf(entry!.event, "run-status"), "failure");
  assert.equal(
    fieldOf(entry!.event, "run-url"),
    "https://forge.example/acme/widgets/actions/runs/999",
  );
  assert.equal(fieldOf(entry!.event, "sha"), "sha-7");
  assert.equal(fieldOf(entry!.event, "index"), "12");
});

test("a non-terminal run delivery, a job-level delivery, and a shapeless payload normalize to nothing", () => {
  assert.equal(
    normalizeForgejoDelivery(
      runPayload({ workflow_run: { id: 999, status: "running" } }),
    ),
    null,
    "a running run is not a wake",
  );
  assert.equal(
    normalizeForgejoDelivery(
      runPayload({ workflow_run: { id: 999, status: "in_progress" } }),
    ),
    null,
  );
  assert.equal(
    normalizeForgejoDelivery({
      action: "completed",
      repository: repo,
      workflow_job: { id: 5, status: "failure" },
    }),
    null,
    "the job family carries no wake this watcher reads",
  );
  assert.equal(normalizeForgejoDelivery({ hello: "world" }), null);
  assert.equal(normalizeForgejoDelivery("not a record"), null);
  assert.equal(
    normalizeForgejoDelivery(runPayload({ repository: { name: "widgets" } })),
    null,
    "no repo, no event",
  );
  assert.equal(
    normalizeForgejoDelivery(
      runPayload({
        workflow_run: { id: 999, status: "failure", updated_at: undefined },
      }),
    ),
    null,
    "a run without its updated_at has no content-derived id to carry",
  );
});

test("a submitted review normalizes to the review family; a draft and an edit do not", () => {
  const entry = normalizeForgejoDelivery(reviewPayload());
  assert.ok(entry);
  assert.equal(entry!.family, "pr-review");
  assert.equal(entry!.index, 7);
  assert.equal(entry!.reviewId, 42);
  assert.equal(entry!.event.id, "pr-review:acme/widgets:7:42");
  assert.equal(entry!.event.type, "review");
  assert.equal(fieldOf(entry!.event, "reviewer"), "fresh-reviewer");
  assert.equal(fieldOf(entry!.event, "review-state"), "APPROVED");
  assert.equal(
    normalizeForgejoDelivery(
      reviewPayload({ review: { state: "PENDING", user: { login: "d" } } }),
    ),
    null,
    "an unsubmitted draft never wakes",
  );
  assert.equal(
    normalizeForgejoDelivery(reviewPayload({ action: "edited" })),
    null,
    "an edit is not a new review",
  );
  assert.equal(
    normalizeForgejoDelivery(reviewPayload({ action: "dismissed" })),
    null,
  );
});

test("a closed pull request normalizes to the terminal close with the merged flags the REST lifecycle read maps", () => {
  const merged = normalizeForgejoDelivery(prPayload());
  assert.ok(merged);
  assert.equal(merged!.family, "pr-close");
  assert.equal(merged!.event.terminal, true);
  assert.equal(
    merged!.event.id,
    "pr:acme/widgets:7:closed:2026-11-26T10:00:01Z",
  );
  assert.equal(fieldOf(merged!.event, "how"), "merged");
  assert.equal(fieldOf(merged!.event, "closed-at"), "2026-11-26T10:00:00Z");
  const unmerged = normalizeForgejoDelivery(
    prPayload({
      pull_request: {
        merged: false,
        merged_at: null,
        closed_at: "2026-11-26T11:00:00Z",
        updated_at: "2026-11-26T11:00:01Z",
      },
    }),
  );
  assert.ok(unmerged);
  assert.equal(fieldOf(unmerged!.event, "how"), "closed unmerged");
  assert.equal(fieldOf(unmerged!.event, "closed-at"), "2026-11-26T11:00:00Z");
  assert.equal(
    normalizeForgejoDelivery(prPayload({ action: "opened" })),
    null,
    "an open pull request is not a wake",
  );
  assert.equal(
    normalizeForgejoDelivery(
      prPayload({
        pull_request: { merged: false, closed_at: null, updated_at: "u" },
      }),
    ) !== null,
    true,
    "a close the server timestamps nowhere still names its event",
  );
});

test("the dedupe ids are the content-derived forms, and the prefix reads disambiguate", () => {
  assert.equal(
    runDedupeId("acme/widgets", 999, "completed", "2026-11-26T10:00:00Z"),
    "run:acme/widgets:999:completed:2026-11-26T10:00:00Z",
  );
  assert.equal(
    reviewDedupeId("acme/widgets", 7, 42),
    "pr-review:acme/widgets:7:42",
  );
  assert.equal(
    prDedupeId("acme/widgets", 7, "closed", "u"),
    "pr:acme/widgets:7:closed:u",
  );
  // A run 99 marker never absorbs run 999: the trailing colon holds the
  // boundary.
  const delivered = {
    [runDedupeId("acme/widgets", 99, "completed", "u1")]: true,
  };
  assert.equal(webhookRunSpent(delivered, "acme/widgets", 999), false);
  assert.equal(
    webhookRunSpent(
      { [runDedupeId("acme/widgets", 999, "completed", "u1")]: true },
      "acme/widgets",
      999,
    ),
    true,
  );
  assert.equal(runDedupePrefix("acme/widgets", 999), "run:acme/widgets:999:");
  // The pr family's prefix reads past the review family's ids.
  assert.equal(
    webhookPrMarkerKey(
      { "pr-review:acme/widgets:7:42": true },
      "acme/widgets",
      7,
    ),
    null,
  );
  assert.equal(
    webhookPrMarkerKey(
      { "pr:acme/widgets:7:closed:u": true },
      "acme/widgets",
      7,
    ),
    "pr:acme/widgets:7:closed:u",
  );
  assert.deepEqual([...TERMINAL_STATUSES].sort(), [
    "cancelled",
    "failure",
    "skipped",
    "success",
  ]);
});

test("a delivery's repo and a registered watch's repo read lowercase on both sides, so a case-mismatched spelling cannot miss", () => {
  const upper = normalizeForgejoDelivery(
    runPayload({ repository: { full_name: "ACME/Widgets" } }),
  );
  assert.ok(upper);
  assert.equal(
    upper!.repo,
    "acme/widgets",
    "the queue keys read the canonical form, whatever the payload's spelling",
  );
  const assembled = normalizeForgejoDelivery(
    runPayload({ repository: { owner: { login: "ACME" }, name: "Widgets" } }),
  );
  assert.ok(assembled);
  assert.equal(assembled!.repo, "acme/widgets");
});

test("the ingest queue takes what a watch can consume and keeps the rest", () => {
  let wakes = 0;
  const debug = () => {};
  const queue = createIngestQueue({ wake: () => (wakes += 1), debug });
  const entry = (
    family: IngestEntry["family"],
    runId?: number,
  ): IngestEntry => ({
    family,
    repo: "acme/widgets",
    ...(runId !== undefined ? { runId } : {}),
    event: { id: `${family}-${runId}`, type: "run", fields: [] },
  });
  queue.push("acme/widgets", entry("run", 1));
  queue.push("acme/widgets", entry("pr-review"));
  assert.equal(wakes, 2, "every push wakes the pass loop");
  const taken = queue.take(
    "acme/widgets",
    (candidate) => candidate.family === "run",
  );
  assert.equal(taken.length, 1);
  assert.equal(taken[0].runId, 1);
  const again = queue.take(
    "acme/widgets",
    (candidate) => candidate.family === "run",
  );
  assert.equal(again.length, 0, "a taken entry is consumed");
  const later = queue.take(
    "acme/widgets",
    (candidate) => candidate.family === "pr-review",
  );
  assert.equal(
    later.length,
    1,
    "the entry another watch can consume stayed queued",
  );
  assert.equal(queue.take("acme/widgets", () => true).length, 0);
  // A repo's entries never bleed into another repo's queue.
  queue.push("acme/other", entry("run", 2));
  assert.equal(queue.take("acme/widgets", () => true).length, 0);
  assert.equal(queue.take("acme/other", () => true).length, 1);
});

test("the ingest queue drops its oldest entry past the cap, said on its line", () => {
  const dropped: string[] = [];
  const queue = createIngestQueue({
    wake: () => {},
    debug: (op, attrs) => {
      if (op === "webhook.ingest.drop") dropped.push(String(attrs?.repo));
    },
    cap: 2,
  });
  for (let id = 1; id <= 3; id += 1) {
    queue.push("acme/widgets", {
      family: "run",
      repo: "acme/widgets",
      runId: id,
      event: { id: String(id), type: "run", fields: [] },
    });
  }
  const held = queue.take("acme/widgets", () => true);
  assert.deepEqual(
    held.map((entry) => entry.runId),
    [2, 3],
    "the oldest entry gave way",
  );
  assert.deepEqual(dropped, ["acme/widgets"]);
});
