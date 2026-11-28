// The webhook deliveries' event side (PRJ-542): what a verified forge
// delivery normalizes to, the dedupe ids those events carry, and the
// per-repo ingest queue the forge source drains at each pass. The HTTP
// half — the receiver that verifies X-Forgejo-Signature before anything
// here runs — is daemon/webhook-receiver.ts; this module is pure, so
// the forge source reads the same shapes the receiver writes.
//
// The forge family's dedupe ids are content-derived (the plan's ruling):
// they survive run reuse on reruns and status reversals, where the REST
// rows' plain ids would absorb a reused run's second terminal status:
//
//   pr:        <repo>:<index>:<action>:<updated_at>
//   pr-review: <repo>:<index>:<review-id>
//   run:       <repo>:<run-id>:<action>:<run.updated>
//
// `<action>` and `<run.updated>` are the webhook payload's own `action`
// and the run record's `updated_at`, read verbatim — the receiver never
// invents a status name, and a rerun's fresh updated_at makes the same
// run id a fresh marker. The REST side of the forge source absorbs
// across the two id families (source.ts's poll): a review or run either
// path delivered first stops the other from waking it twice.
//
// The payload shapes are the forge's GitHub-compatible webhook records,
// verified live on Forgejo 17.0.2: the per-status workflow run/job
// events (workflow_run, workflow_job), not the deprecated action-run
// ones. A shape this module does not recognize normalizes to nothing —
// the receiver answers the delivery and the REST read carries on; a
// poll that cannot read the forge never invents a verdict, and a
// delivery it cannot name never queues one.

import { isRecord, type Debug, type WatchEvent } from "./kernel.ts";

// The Actions statuses the wake family reads, shared with the forge
// source's REST boundary (one vocabulary for the wire's two doors).
export const TERMINAL_STATUSES = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);

export const runDedupeId = (
  repo: string,
  runId: number | string,
  action: string,
  updated: string,
): string => `run:${repo}:${runId}:${action}:${updated}`;

// The prefix a run's webhook-form markers share: the REST side absorbs a
// webhook-delivered run by this prefix, because a REST row cannot
// reconstruct the payload's action and updated_at to rebuild the full
// id. The trailing colon keeps a prefix for run 99 from matching run
// 999's markers.
export const runDedupePrefix = (repo: string, runId: number | string): string =>
  `run:${repo}:${runId}:`;

export const reviewDedupeId = (
  repo: string,
  index: number | string,
  reviewId: number | string,
): string => `pr-review:${repo}:${index}:${reviewId}`;

export const prDedupeId = (
  repo: string,
  index: number | string,
  action: string,
  updatedAt: string,
): string => `pr:${repo}:${index}:${action}:${updatedAt}`;

// One entry of the ingest queue: the payload bits a watch matches by
// (the watch's kind and ref decide), plus the normalized event the
// kernel will verify, mark, and deliver.
export type IngestEntry = {
  family: "run" | "pr-review" | "pr-close";
  repo: string;
  /** The pull request's index (the pr-review and pr-close families). */
  index?: number;
  /** The review's id (the pr-review family). */
  reviewId?: number;
  /** The run's id (the run family). */
  runId?: number;
  /** The run's head sha (the run family). */
  headSha?: string;
  event: WatchEvent;
};

// The queue's per-repo cap: a repo that out-delivers its watches drops
// its oldest entries, said on its line — the queue is memory, not a
// durable record, and the REST backstop is the floor under a flood.
const INGEST_QUEUE_CAP = 500;

export type IngestQueue = {
  push: (repo: string, entry: IngestEntry) => void;
  /**
   * The entries the predicate accepts, removed from the queue; the rest
   * stay queued for the watch that can consume them (a repo's watches
   * poll one after another, and a register in flight is no consumer at
   * all — the baseline race's entry waits for the watch to exist).
   */
  take: (repo: string, want: (entry: IngestEntry) => boolean) => IngestEntry[];
};

export const createIngestQueue = ({
  wake,
  debug,
  cap = INGEST_QUEUE_CAP,
}: {
  wake: () => void;
  debug: Debug;
  cap?: number;
}): IngestQueue => {
  const queues = new Map<string, IngestEntry[]>();
  return {
    push: (repo, entry) => {
      let held = queues.get(repo);
      if (!held) {
        held = [];
        queues.set(repo, held);
      }
      if (held.length >= cap) {
        held.shift();
        debug("webhook.ingest.drop", { repo, cap });
      }
      held.push(entry);
      wake();
    },
    take: (repo, want) => {
      const held = queues.get(repo);
      if (!held || held.length === 0) return [];
      const taken: IngestEntry[] = [];
      const kept: IngestEntry[] = [];
      for (const entry of held) (want(entry) ? taken : kept).push(entry);
      if (taken.length > 0) {
        if (kept.length === 0) queues.delete(repo);
        else queues.set(repo, kept);
      }
      return taken;
    },
  };
};

// The delivery's repo: the payload's repository record, full_name
// first, owner/name assembled behind it. Both sides read lowercase —
// the ingest queue keys by this name and the registered watch's repo
// is canonicalized the same way at registration (the forge source's
// normalize), so a case-mismatched spelling can never miss a
// delivery. No record, no repo, no event.
const repoNameOf = (repository: unknown): string | null => {
  if (!isRecord(repository)) return null;
  if (typeof repository.full_name === "string") {
    const name = repository.full_name.trim().toLowerCase();
    if (/^[^/]+\/[^/]+$/.test(name)) return name;
  }
  const owner =
    isRecord(repository.owner) && typeof repository.owner.login === "string"
      ? repository.owner.login.trim().toLowerCase()
      : "";
  const name =
    typeof repository.name === "string"
      ? repository.name.trim().toLowerCase()
      : "";
  if (owner && name) return `${owner}/${name}`;
  return null;
};

const intOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

// The pull request payload's index: the forge carries it on the
// pull_request record itself (number, the GitHub-compatible field;
// index behind it, the REST record's name).
const prIndexOf = (pull: Record<string, unknown>): number | undefined =>
  intOf(pull.number) ?? intOf(pull.index);

/**
 * One verified delivery's normalized events: zero or one — a delivery
 * whose family carries no wake for this watcher (an unsubmitted review
 * draft, a non-terminal run status, a job-level workflow_job event, a
 * shape this watcher does not consume) normalizes to nothing, and the
 * receiver still answers it. The event is inside the kernel's privacy
 * contract by construction: the same field names the REST builders lay
 * down, so a webhook wake renders byte for byte like a polled one.
 */
export const normalizeForgejoDelivery = (
  payload: unknown,
): IngestEntry | null => {
  if (!isRecord(payload)) return null;
  const repo = repoNameOf(payload.repository);
  if (!repo) return null;
  const action = stringOf(payload.action);

  // The review family: a submitted review wakes the pr-reviews watches;
  // an edit or a dismissal does not (the review's id spent at submit),
  // and a PENDING review is an unsubmitted draft — the same drop the
  // REST reader applies.
  if (isRecord(payload.pull_request) && isRecord(payload.review)) {
    const review = payload.review;
    if (action !== "submitted") return null;
    const state = stringOf(review.state)?.trim() ?? "";
    if (state.toUpperCase() === "PENDING") return null;
    const index = prIndexOf(payload.pull_request);
    const reviewId = intOf(review.id);
    const reviewer =
      isRecord(review.user) && typeof review.user.login === "string"
        ? review.user.login.trim()
        : "";
    if (index === undefined || reviewId === undefined || !state || !reviewer)
      return null;
    const url = stringOf(review.html_url);
    return {
      family: "pr-review",
      repo,
      index,
      reviewId,
      event: {
        id: reviewDedupeId(repo, index, reviewId),
        type: "review",
        fields: [
          { kind: "id", name: "review", value: String(reviewId) },
          { kind: "ref", name: "reviewer", value: reviewer },
          { kind: "status", name: "review-state", value: state },
          ...(url ? [{ kind: "url", name: "review-url", value: url }] : []),
        ],
      },
    };
  }

  // The pr family: the close is the pr watch's one terminal wake. The
  // payload's own action and updated_at are the dedupe id's content;
  // the how and the timestamp ride the merged flags exactly as the REST
  // lifecycle read maps them.
  if (isRecord(payload.pull_request)) {
    const pull = payload.pull_request;
    if (action !== "closed") return null;
    const index = prIndexOf(pull);
    if (index === undefined) return null;
    const merged = pull.merged === true;
    const at = merged ? stringOf(pull.merged_at) : stringOf(pull.closed_at);
    const updated = stringOf(pull.updated_at) ?? at ?? "";
    return {
      family: "pr-close",
      repo,
      index,
      event: {
        id: prDedupeId(repo, index, "closed", updated),
        type: "closed",
        terminal: true,
        fields: [
          { kind: "id", name: "lifecycle", value: "closed" },
          {
            kind: "status",
            name: "how",
            value: merged ? "merged" : "closed unmerged",
          },
          ...(at ? [{ kind: "measure", name: "closed-at", value: at }] : []),
        ],
      },
    };
  }

  // The run family: a run that reached a terminal status wakes the run
  // watches. A non-terminal delivery (requested, in_progress, the
  // per-status intermediate states) queues nothing — the delivery's
  // wake alone brings the pass, and the REST read answers the head's
  // runs as before. A run record without its action or its updated_at
  // has no content-derived id to carry: nothing is queued, and the REST
  // backstop covers it.
  if (isRecord(payload.workflow_run)) {
    const run = payload.workflow_run;
    const runId = intOf(run.id);
    const status = stringOf(run.status)?.trim().toLowerCase() ?? "";
    const updated = stringOf(run.updated_at) ?? stringOf(run.updated);
    if (
      runId === undefined ||
      !action ||
      !updated ||
      !TERMINAL_STATUSES.has(status)
    )
      return null;
    const url = stringOf(run.html_url);
    const sha = stringOf(run.head_sha);
    const indexInRepo = intOf(run.run_number) ?? intOf(run.index_in_repo);
    return {
      family: "run",
      repo,
      runId,
      ...(sha !== undefined ? { headSha: sha } : {}),
      event: {
        id: runDedupeId(repo, runId, action, updated),
        type: "run",
        fields: [
          { kind: "id", name: "run", value: String(runId) },
          { kind: "status", name: "run-status", value: status },
          ...(url ? [{ kind: "url", name: "run-url", value: url }] : []),
          ...(sha ? [{ kind: "ref", name: "sha", value: sha }] : []),
          ...(indexInRepo !== undefined
            ? [{ kind: "measure", name: "index", value: String(indexInRepo) }]
            : []),
        ],
      },
    };
  }

  // The job family (workflow_job): the per-status job events the v17
  // forge emits beside the run events. A job's status change is not a
  // wake this watcher carries — the verdict is the run's — so the
  // delivery answers and nothing is queued.
  return null;
};

// The REST side's webhook-form absorb for the pr family: a close the
// receiver delivered carries its dedupe id on the row, and the REST
// lifecycle word cannot rebuild it. The scan answers the marker's own
// key (or null) — the heal path's word answers under that key, so the
// kernel's settle reads it spent (the close's mail already went) and
// rides the dissolve instead of mailing a second close.
export const webhookPrMarkerKey = (
  delivered: Record<string, boolean>,
  repo: string,
  index: number | string,
): string | null => {
  const prefix = `pr:${repo}:${index}:`;
  for (const key of Object.keys(delivered)) {
    if (key.startsWith(prefix)) return key;
  }
  return null;
};

// The REST side's webhook-form absorb: a run the receiver delivered
// carries a dedupe id the REST row cannot rebuild (the payload's action
// and updated_at are not the row's fields), so the row reads the id's
// shared prefix off the delivered map instead — own keys only, the same
// rule every marker read runs under.
export const webhookRunSpent = (
  delivered: Record<string, boolean>,
  repo: string,
  runId: number | string,
): boolean => {
  const prefix = runDedupePrefix(repo, runId);
  for (const key of Object.keys(delivered)) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};
