// The Forgejo watcher (PRJ-244): the family's first source adapter on
// the watcher kernel (kernel.ts).
// The kernel owns everything the sources have in common — the poll pass,
// the registry and its adoption walk, the stamp machinery (it is the
// sole writer of the `chancery.watches` rows it adopts), the delivery
// discipline, and per-source failure isolation. This module is the
// Forgejo source: the source logic (the poll reads per watch kind, the
// zod boundaries, the verdict renders) and the register validation. The
// REST client (forge-client.ts), the config (config.ts), the family's
// tool surface (tools.ts), the projection wiring (projection-sync.ts),
// and the composition (composer.ts, behind the plugin entry) are their
// own modules beside this one.
//
// In-process only — one poller interval on the host process; no daemon,
// no subprocess, no model calls, and nothing ever writes to a forge:
// the poller only reads the Forgejo REST API and delivers mail.
//
// The registry is source-agnostic in shape and Forgejo-specific here. A
// `run` watch polls one Actions run by id. A `pr` or `branch` watch
// resolves its head's current sha and polls that head's runs, so a later
// push on the same head arrives as new runs of the same watch. A pr watch
// also follows the pull request itself: the read that resolves its head
// carries the PR's state, and a closed one ends the watch — one terminal
// mail (merged, or closed unmerged), then the watch dissolves and no
// forget is needed. A `pr-reviews` watch (PRJ-399) reads one pull
// request's reviews — one reviews read per watch per pass, the poll
// budget — and wakes once per review the stamp has not spent: every
// reviewer's, the registering session's own included, because a wake is a
// prompt, not a re-run, and no loop exists. The wake is for reviews that
// arrive after the watch, never the backlog: register spends the reviews
// page the PR carries at creation (the register path's own baseline
// read; when the forge cannot answer, the first poll pass spends its
// page instead), and an unsubmitted draft (PENDING) is filtered before
// any of it. It follows no lifecycle: it reads reviews until
// watcher_forget. A `run` or `branch` watch ends only
// at watcher_forget or when its stamped session dies — no expiry, no cap.
// A watch whose session is gone is inert: the stamp lives with its
// session, the adopted row is dropped, and nothing is delivered nowhere.
//
// The REST reads and their shapes (the zod boundary; a shape that drifts
// parses to null and the pass is skipped — a poll that cannot read the
// forge never invents a verdict or a row):
// - `GET /repos/{owner}/{repo}/pulls?state=open&page&limit` — the
//   open-PR list the projection walks; the state filter rides the wire
//   (verified live 2026-11-18: the deployed route's x-total-count
//   answers the open set, not every PR ever), so the walk's budget
//   scales with open PRs; the rows are still filtered open after the
//   read, and the walk's empty-page end plus the sweep's per-PR words
//   keep a wrongful answer from costing a row. The rows are the
//   pull-request records themselves (`index`, `title`,
//   `state`, `draft`, `head.sha`, `base.ref`).
// - `GET /repos/{owner}/{repo}/pulls/{index}` — one pull-request record:
//   the pr watch's lifecycle read (`state`, `merged`, `merged_at`,
//   `closed_at`) and its head resolution (`head.sha`), and the sweep's
//   direct word about a PR the list did not name.
// - `GET /repos/{owner}/{repo}/pulls/{index}/reviews?limit` — one page
//   per read (the wake's budget, never paged after), as JSON records
//   (`{id, user: {login}, state, body, submitted_at, created_at,
//   html_url, …}`).
// - `GET /repos/{owner}/{repo}/commits/{sha}/statuses?limit` — the
//   commit-status leaves per head sha (the leaf's state field is
//   `status` on the gitea-shaped record and `state` on the combined
//   flavor; the answer arrives as the statuses array itself or wrapped
//   in it).
// - `GET /repos/{owner}/{repo}/branches?page&limit` — the listing a
//   branch watch resolves its head from (`[{name, commit: {id}}]`).
// - `GET /repos/{owner}/{repo}/actions/runs?head_sha&limit` — the runs
//   per head, as JSON (`{workflow_runs: […]}` or the bare array), rows
//   of `{id, status, head_sha, title, html_url, …}`; and
//   `GET …/actions/runs/{run_id}` — one run's record.
// - `GET …/actions/runs/{run_id}/jobs` — the run's full job list (the
//   forge answers it whole; the verdict caps its read at
//   JOBS_READ_CAP and says so past it); and
//   `GET …/jobs/{job_id}/logs?max_bytes` — the failing job's plaintext
//   log (a JSON `{content}` wrapper accepted), the tail lines the
//   verdict mail carries.
// - `list_workflow_runs` filters on the full 40-character sha; a short
//   sha matches nothing, so heads are always passed as resolved.
// - run and job statuses on the wire: success, failure, cancelled,
//   skipped are terminal; running, waiting, pending, blocked are not;
//   anything unfamiliar is treated as non-terminal and logged once.

// Mail and stamps reuse the director package's. The envelope is imported —
// one mail-leg definition for the family, never a fork — across the deployed
// layout: the mail-watcher package materializes coordinate/director/director.ts
// at the relative spot this import resolves to, rebuilt from it on every
// build (see the package.nix and NOTICE.md). The watch stamp rides the same
// `chancery` namespace the module stamps (`chancery.watches` beside
// `chancery.coordinatedBy`; NOTICE.md maps the derivation).
//
// from @sysread/thatch (src/opencode/v2.ts ~788-798, MIT): the
// namespaced-metadata stamp pattern — the same span the module's
// coordinator-stamp row carries. The watcher's watches ride
// chancery.watches the way the module's children ride chancery.coordinatedBy.
import { mailEnvelope } from "../../coordinate/director/director.ts";

import { z } from "zod";

// The watcher kernel: the poll pass, the registry and its adoption walk,
// the stamp machinery (the sole writer of the rows it adopts), the
// delivery discipline, and the per-source isolation. The source-contract
// base class (source.ts) owns what the adapters shared; this module is
// the Forgejo specifics.
import {
  isRecord,
  type AdoptedWatch,
  type Debug,
  type DeliverCheckpoint,
  type PassContext,
  type RegisterRequest,
  type WatchCursor,
  type WatchEvent,
  type WatchRowSeed,
} from "./kernel.ts";
import { WatchSource } from "./source.ts";
import { forgejoReady } from "./config.ts";
// The webhook deliveries' event side (PRJ-542): the ingest queue's
// shape the drain reads, the Actions statuses (one vocabulary for the
// wire's two doors), and the cross-family absorbs — a webhook-delivered
// run or review's marker stops the REST read from waking it again.
import {
  TERMINAL_STATUSES,
  reviewDedupeId,
  webhookPrMarkerKey,
  webhookRunSpent,
  type IngestEntry,
  type IngestQueue,
} from "./webhook-events.ts";

const WATCH_KINDS = new Set(["run", "pr", "branch", "pr-reviews"]);
// The PagerDuty and Linear sources' claims rows (kinds "pagerduty" and
// "linear") also ride the `chancery.watches` stamp — stamped on the
// session the config names — but they are config-owned: the poll pass
// re-ensures each of them from the config every pass (pagerduty.ts,
// linear.ts), so adoption never takes them into the registry, and the
// kinds above are all the registry polls. No
// pass resets or rewrites the rows it does not adopt — that is the
// claims row's at-most-once floor (review 339's 16307): adoption reads
// without writing, every stamp write goes through the kernel's
// patchStamps with a patch that touches only the row it matched by id
// (settle, dissolve, forget all filter or mutate by id, never by kind),
// and a session's death deletes nothing on its stamp — the stamp leaves
// with the session. A row whose kind sits outside this set therefore
// keeps its delivered markers exactly as its owner wrote them; nothing
// rebuilds it with an empty map, so nothing re-wakes.
const NON_TERMINAL_STATUSES = new Set([
  "running",
  "waiting",
  "pending",
  "blocked",
]);
// The delivered marker on a pr watch whose pull request is closed: a run
// id on the same record is always numeric, so the key cannot collide. A
// review id is numeric too, so a pr-reviews watch's markers cannot
// collide with it either.
const LIFECYCLE = "closed";
const RUNS_PER_HEAD = 20;
// One reviews read per registered pr-reviews watch per pass: the read
// takes the largest page the API answers, and never pages after. An
// older review that fell off the first page is read as new if a later
// read brings it back — the stamp keeps every wake to one.
const REVIEWS_PER_READ = 50;
const BRANCH_PAGES = 10;
const BRANCH_PAGE_SIZE = 100;
// The run's job list arrives whole; the verdict caps how much of it it
// reads and says so past the cap.
const JOBS_READ_CAP = 1000;
const LOG_TAIL_LINES = 8;
// The Actions job row's boundary shape: the verdict's job line and its
// failing-job log read name these.
const ZJobRow = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  status: z.string().nullish(),
});

// The run rows' boundary shapes: the list arrives as
// `{workflow_runs: […]}` or the bare array, and one run's record is the
// row itself. The fields a verdict needs are the strict ones; the rest
// tolerate absence, and a shape that drifts parses to null — the pass is
// skipped, the verdict never invented.
const ZRunRow = z.looseObject({
  id: z.number(),
  status: z.string(),
  head_sha: z.string().optional(),
  commit_sha: z.string().optional(),
  sha: z.string().optional(),
  title: z.string().optional(),
  html_url: z.string().optional(),
  duration: z.string().optional(),
  run_number: z.number().optional(),
  index_in_repo: z.number().optional(),
});
const ZRunList = z.union([
  z.array(ZRunRow),
  z.looseObject({ workflow_runs: z.array(ZRunRow) }),
]);

const runRowOf = (row) => {
  const parsed = ZRunRow.safeParse(row);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (!Number.isInteger(data.id) || !data.status.trim()) return null;
  const sha = data.head_sha ?? data.commit_sha ?? data.sha;
  return {
    id: data.id,
    status: data.status.trim(),
    ...(sha !== undefined ? { commit_sha: sha } : {}),
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.html_url !== undefined ? { html_url: data.html_url } : {}),
    ...(data.duration !== undefined ? { duration: data.duration } : {}),
    ...(Number.isInteger(data.index_in_repo)
      ? { index_in_repo: data.index_in_repo }
      : Number.isInteger(data.run_number)
        ? { index_in_repo: data.run_number }
        : {}),
  };
};

const parseRunRows = (data) => {
  const list = ZRunList.safeParse(data);
  if (!list.success) return null;
  const rows = Array.isArray(list.data) ? list.data : list.data.workflow_runs;
  const parsed = rows.map(runRowOf).filter((row) => row !== null);
  // Every row dropped is a shape the mirror cannot name: the read
  // failed, the pass skips.
  if (rows.length > 0 && parsed.length === 0) return null;
  return parsed;
};
// list_pull_reviews, one JSON record per review — the fields a wake
// carries, read defensively: a shape that drifts parses to null and the
// pass is skipped, so a poll that cannot read the reviews never invents
// one. A review without a reviewer or a state is not a review this
// watcher can name, and is left unparsed with the rest of the page. A
// PENDING review is an unsubmitted draft: it is dropped here, so the
// draft never wakes the session and its id is never spent — the verdict
// that submitting turns it into (same id or a new one) still wakes.
const parseReviews = (data) => {
  if (!Array.isArray(data)) return null;
  const reviews = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const id = row.id;
    const state = typeof row.state === "string" ? row.state.trim() : "";
    const reviewer =
      typeof row.user?.login === "string" ? row.user.login.trim() : "";
    if (state.toUpperCase() === "PENDING") continue;
    if (typeof id !== "number" || !Number.isInteger(id) || !state || !reviewer)
      continue;
    reviews.push({
      id,
      state,
      reviewer,
      ...(typeof row.html_url === "string" && row.html_url
        ? { url: row.html_url }
        : {}),
    });
  }
  return reviews;
};

// The pull-request record's boundary shape: the pr watch's lifecycle
// read and the sweep's direct word both read it, and a shape that drifts
// parses to null — no watch is ended, no row written, by a state that
// did not parse.
const ZPullRecord = z.looseObject({
  state: z.string().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  head: z.looseObject({ sha: z.string() }).optional(),
});

const parsePullRecord = (data) => {
  const parsed = ZPullRecord.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data;
};

// The pull request's own state, read from the record the head
// resolution already answers: `closed` with `merged` is a merge,
// `closed` without one ended unmerged, and anything else — open, or a
// shape this parser does not know — reads open. A watch is never ended
// by a state that did not parse.
const prLifecycle = (pull, debug) => {
  if (!isRecord(pull)) return null;
  const state = String(pull.state ?? "").toLowerCase();
  if (state === "open") return null;
  if (state !== "closed") {
    if (state) debug("pull.state.unfamiliar", { state });
    return null;
  }
  const merged = pull.merged === true;
  const at = merged ? pull.merged_at : pull.closed_at;
  return {
    how: merged ? "merged" : "closed unmerged",
    ...(typeof at === "string" && at ? { at } : {}),
  };
};

const runIsTerminal = (run, debug) => {
  const status = String(run?.status ?? "").toLowerCase();
  if (TERMINAL_STATUSES.has(status)) return status;
  if (!NON_TERMINAL_STATUSES.has(status)) {
    debug("status.unfamiliar", { status, run: run?.id });
  }
  return null;
};

// The Actions job rows' boundary shape and the verdict's job line: the
// states the verdict reads, capped by JOBS_READ_CAP at the read.
const jobsOf = (data) => {
  const list = z
    .union([z.array(ZJobRow), z.looseObject({ jobs: z.array(ZJobRow) })])
    .safeParse(data);
  if (!list.success) return null;
  const rows = Array.isArray(list.data) ? list.data : list.data.jobs;
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? null,
  }));
};

const jobsLine = (jobs) =>
  Array.isArray(jobs) && jobs.length
    ? jobs
        .map((job) => [job?.name, job?.status].filter(Boolean).join(" ").trim())
        .filter(Boolean)
        .join(", ")
    : null;

// The runner prefixes every log line with a timestamp and action output
// can carry ANSI color; the mail shows the real lines.
const TIMESTAMP_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\s*/;
// The matcher needs the real ESC byte: a control character in a regex is
// the point here — the rule flags it, so this line is exempted inline.
// oxlint-disable-next-line no-control-regex
const ANSI_CODES = /\x1b\[[0-9;]*[A-Za-z]/g;

function unwrapLog(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) =>
      line.replace(ANSI_CODES, "").replace(TIMESTAMP_PREFIX, "").trimEnd(),
    )
    .filter((line) => line.trim() !== "")
    .slice(-LOG_TAIL_LINES);
}

const runLine = (run) => {
  const number = Number.isInteger(run?.index_in_repo)
    ? `(#${run.index_in_repo})`
    : "";
  return `run ${run?.id ?? "?"} ${number} — ${run?.status ?? "unknown status"}`.replace(
    /\s+/g,
    " ",
  );
};

const describeWatch = (watch) =>
  `${watch.kind} ${watch.ref} on ${watch.repo}${
    watch.note ? ` — ${watch.note}` : ""
  }`;

function verdictMail(watch, run, jobsText, tail) {
  const lines = [
    "Forgejo mail — watch verdict",
    `watch ${watch.id} — ${describeWatch(watch)}`,
    "",
    runLine(run),
  ];
  if (run?.html_url) lines.push(`url ${run.html_url}`);
  if (run?.commit_sha) lines.push(`sha ${run.commit_sha}`);
  if (run?.duration) lines.push(`duration ${run.duration}`);
  if (jobsText) lines.push(`jobs: ${jobsText}`);
  if (String(run?.status ?? "").toLowerCase() === "failure") {
    if (tail) {
      lines.push("", `last lines of job "${tail.job}":`);
      for (const line of tail.lines) lines.push(`  ${line}`);
    } else {
      lines.push("", "(the failing job's log could not be fetched)");
    }
  }
  return mailEnvelope(lines);
}

// A pr watch's one terminal mail, before the watch dissolves: the repo,
// the PR index, the terminal state, and the merge/closed timestamp when
// the server carries one.
function lifecycleMail(watch, how, at) {
  const lines = [
    "Forgejo mail — watch closed",
    `watch ${watch.id} — ${describeWatch(watch)}`,
    "",
    at
      ? `PR ${watch.repo}#${watch.ref} closed: ${how} at ${at}`
      : `PR ${watch.repo}#${watch.ref} closed: ${how}`,
  ];
  return mailEnvelope(lines);
}

// The pr-reviews wake: one per new review id, carried by reviewer, review
// state, review id, and the repo#pr it landed on. A wake is a prompt, not
// a re-run — the mail names the review; the woken session reads it.
function reviewMail(watch, review) {
  const lines = [
    "Forgejo mail — watch review",
    `watch ${watch.id} — ${describeWatch(watch)}`,
    "",
    `review ${review.id} by ${review.reviewer} — ${review.state} on ${watch.repo}#${watch.ref}`,
  ];
  if (review.url) lines.push(`url ${review.url}`);
  return mailEnvelope(lines);
}

// The event views the renders read: the privacy contract's fields, laid
// back out under the mail builders' own names. A field the event does
// not carry reads as undefined — the same absence the REST row's
// optional fields had.
const eventValue = (event, name) =>
  event.fields.find((field) => field.name === name)?.value;

const runViewOf = (event) => {
  const index = eventValue(event, "index");
  return {
    id: event.id,
    status: eventValue(event, "run-status"),
    html_url: eventValue(event, "run-url"),
    commit_sha: eventValue(event, "sha"),
    duration: eventValue(event, "duration"),
    index_in_repo: index !== undefined ? Number(index) : undefined,
  };
};
// The events the source's poll answers: the poll's reads, laid onto the
// kernel's privacy contract — id, ref, url, status, measure, and no
// free-text field. The event id is the delivered marker's key, exactly
// the key the stamp rows have always carried. A field's name is the
// source's own label for it (structural, not content).
const runEventOf = (run) => ({
  id: String(run.id),
  type: "run",
  fields: [
    { kind: "id", name: "run", value: String(run.id) },
    { kind: "status", name: "run-status", value: run.status },
    ...(run.html_url
      ? [{ kind: "url", name: "run-url", value: run.html_url }]
      : []),
    ...(run.commit_sha
      ? [{ kind: "ref", name: "sha", value: run.commit_sha }]
      : []),
    ...(run.duration
      ? [{ kind: "measure", name: "duration", value: run.duration }]
      : []),
    ...(Number.isInteger(run.index_in_repo)
      ? [
          {
            kind: "measure",
            name: "index",
            value: String(run.index_in_repo),
          },
        ]
      : []),
  ],
});

const reviewEventOf = (review) => ({
  id: String(review.id),
  type: "review",
  fields: [
    { kind: "id", name: "review", value: String(review.id) },
    // The reviewer's login: an identity pointer into the source — who,
    // never what they wrote. The agent fetches content on demand.
    { kind: "ref", name: "reviewer", value: review.reviewer },
    { kind: "status", name: "review-state", value: review.state },
    ...(review.url
      ? [{ kind: "url", name: "review-url", value: review.url }]
      : []),
  ],
});

const lifecycleEventOf = (life) => ({
  id: LIFECYCLE,
  type: "closed",
  terminal: true,
  fields: [
    { kind: "id", name: "lifecycle", value: LIFECYCLE },
    { kind: "status", name: "how", value: life.how },
    ...(life.at
      ? [{ kind: "measure", name: "closed-at", value: life.at }]
      : []),
  ],
});

// A pr watch resolves its head from the pull-request read it takes for
// the lifecycle; a branch watch follows the listing: the current sha is
// resolved fresh each pass, so a later push presents new runs of the
// same watch. An unresolved head (a deleted branch) skips the pass and
// leaves the watch in place — nothing expires silently.
const branchSha = async (watch, debug, branchesOf) => {
  const [owner, repo] = watch.repo.split("/");
  // The listing is walked page by page until the branch answers. A page
  // that comes back short ends the walk, so a deleted branch resolves
  // to a clean, unexpired nothing. This is a search, not a sweep: a
  // page the forge clamped shorter than asked costs a missed branch
  // only in the head's next resolution, never a deleted row.
  for (let page = 1; page <= BRANCH_PAGES; page += 1) {
    const data = await branchesOf(owner, repo, page, BRANCH_PAGE_SIZE);
    const rows = Array.isArray(data) ? data : [];
    const row = rows.find((candidate) => candidate?.name === watch.ref);
    if (row) {
      const sha = row.commit?.id;
      if (typeof sha === "string" && sha) return sha;
      debug("watch.head.unresolved", { id: watch.id, kind: watch.kind });
      return null;
    }
    if (rows.length < BRANCH_PAGE_SIZE) break;
  }
  debug("watch.head.unresolved", { id: watch.id, kind: watch.kind });
  return null;
};

export { parsePullRecord, prLifecycle, REVIEWS_PER_READ };

// The REST reads the source polls with, over the forge client (the
// composer builds them; the tests dial loopback fakes).
type ForgejoReads = {
  prRecord: (owner: string, name: string, index: number) => Promise<unknown>;
  reviewsOf: (
    owner: string,
    name: string,
    index: number,
    limit: number,
  ) => Promise<unknown>;
  runsOfHead: (
    owner: string,
    name: string,
    headSha: string,
    limit: number,
  ) => Promise<unknown>;
  runRecord: (owner: string, name: string, runId: number) => Promise<unknown>;
  runJobs: (owner: string, name: string, runId: number) => Promise<unknown>;
  jobLog: (
    owner: string,
    name: string,
    runId: number,
    jobId: number,
  ) => Promise<unknown>;
  branchesOf: (
    owner: string,
    name: string,
    page: number,
    limit: number,
  ) => Promise<unknown>;
};

// The ingest half (PRJ-542): the verified webhook deliveries' queue,
// drained at each pass. Typed at its take alone — the source never
// pushes; the receiver does.
type ForgejoIngest = Pick<IngestQueue, "take">;

// The Forgejo source: the contract's class shape over the module's pure
// boundary (the run and review parsers, the pull-record lifecycle, the
// log-tail read) and the REST reads built beside it. A pr or branch
// watch shares one claim group — a second register on the same repo+ref
// returns the claimed watch instead of a second owner. The ingest queue
// (PRJ-542) rides in as the third wiring: the receiver's verified
// deliveries, drained at each pass before the REST reads.
export class ForgejoSource extends WatchSource {
  readonly id = "forgejo";

  private readonly reads: ForgejoReads;
  private readonly ingest: ForgejoIngest | null;

  constructor(reads: ForgejoReads, debug: Debug, ingest?: ForgejoIngest) {
    super(debug);
    this.reads = reads;
    this.ingest = ingest ?? null;
  }

  protected readConfig(config: unknown): unknown {
    const verdict = forgejoReady(config);
    if (!verdict.ok) throw new Error(verdict.reason);
    return verdict.config;
  }

  kinds(): readonly string[] {
    return [...WATCH_KINDS];
  }

  claimGroupOf(kind: string): string | null {
    return kind === "pr" || kind === "branch" ? "pull" : null;
  }

  // The register request's validation: the source's own argument errors,
  // thrown for the tool to surface. The messages are today's, word for
  // word; the kind check and the note limit are the base's. The repo
  // reads lowercase — the canonical form the ingest queue keys by (the
  // receiver's payload normalization canonicalizes its side the same
  // way), so a case-mismatched spelling can never miss a delivery.
  normalize(req: RegisterRequest): WatchRowSeed {
    const kind = this.checkKind(req);
    const repo = String(req.repo || "")
      .trim()
      .toLowerCase();
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new Error(
        `watcher_register: repo must be owner/name (got ${JSON.stringify(req.repo)})`,
      );
    }
    const ref = String(req.ref || "").trim();
    if (kind === "branch") {
      if (!ref || ref.length > 200) {
        throw new Error("watcher_register: ref must be a branch name");
      }
    } else if (!/^\d+$/.test(ref)) {
      throw new Error(
        `watcher_register: ref must be a numeric ${kind} ${kind === "run" ? "id" : "index"} (got ${JSON.stringify(req.ref)})`,
      );
    }
    const note = this.normalizeNote(req);
    return { kind, repo, ref, note };
  }

  // The pr-reviews baseline (review 213's note on the backlog): the
  // reviews the pull request already carries are the backlog, spent at
  // creation — the watch wakes on reviews that arrive after it, never
  // on the page it registered against. The baseline read is one read,
  // through the same client a pass reads with; when the forge cannot
  // answer it (an outage, an answer that does not parse), the kernel
  // stamps the watch baseline-pending, and the first poll pass spends
  // its page instead — the backlog never wakes, whatever the timing.
  // (The kind guard and the unread-to-pending mapping are the base's
  // baseline template.)
  protected baselineKinds(): readonly string[] {
    return ["pr-reviews"];
  }

  protected async readBaseline(
    seed: WatchRowSeed,
  ): Promise<Record<string, boolean> | null> {
    const [owner, repo] = seed.repo.split("/");
    const data = await this.reads.reviewsOf(
      owner,
      repo,
      Number(seed.ref),
      REVIEWS_PER_READ,
    );
    const reviews = parseReviews(data);
    if (!reviews) return null;
    return Object.fromEntries(reviews.map((review) => [review.id, true]));
  }

  // The ingest's takes, per watch kind: the queue's entries this watch
  // can consume, drained BEFORE the API reads (PRJ-542) so a verified
  // delivery is processed even when the read then fails, and never
  // delayed behind one. A baseline-pending watch takes nothing — the
  // fresh page its first pass spends whole covers the queue's entries,
  // and the spend's markers keep their replays absorbed (the baseline
  // race's resolution). A queue entry the watch cannot consume stays
  // queued for the watch that can; a repo's register still in flight
  // is no consumer at all.
  private takeIngest(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    want: (entry: IngestEntry) => boolean,
  ): IngestEntry[] {
    if (cursor.baselinePending || !this.ingest) return [];
    return this.ingest.take(watch.repo, want);
  }

  // The drain's absorb: a queue entry whose dedupe id is spent (a
  // replayed delivery) or whose REST-form id is spent (the other path
  // got there first — the REST row's plain id, the lifecycle's
  // "closed") is dropped here; the marker either form wrote keeps the
  // item at one wake.
  private ingestEvents(
    entries: IngestEntry[],
    cursor: WatchCursor,
    restSpent: (entry: IngestEntry) => boolean,
  ): WatchEvent[] {
    return entries
      .filter(
        (entry) => !this.isSpent(cursor, entry.event.id) && !restSpent(entry),
      )
      .map((entry) => entry.event);
  }

  // The poll read, per kind — a pure read answering normalized events.
  // Null answers "the read gave nothing usable" (the pass skips; a
  // baseline-pending row keeps its flag); an array answers a successful
  // read (a baseline-pending row spends it, empty or not). The cursor is
  // the watch's stamp-carried progress; the memo shares this pass's
  // reads with the projection. The ingest queue's entries (PRJ-542)
  // answer ahead of the REST rows, in the order the read of each
  // surface follows them.
  async poll(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    pass: PassContext,
  ): Promise<WatchEvent[] | null> {
    const [owner, repo] = watch.repo.split("/");
    if (watch.kind === "pr-reviews") {
      // The poll budget: one reviews read per registered watch per pass.
      // The read takes the tool's largest page; whatever it brings that
      // the stamp has not spent wakes once, whoever wrote it. The read is
      // shared with the projection's sync through the per-pass memo — a
      // pass that already read this PR's reviews for the projection (or
      // for another wake) reads them no second time, and a read that
      // already failed this pass fails the wake without a retry.
      const queued = this.takeIngest(
        watch,
        cursor,
        (entry) =>
          entry.family === "pr-review" && String(entry.index) === watch.ref,
      );
      const memoKey = `reviews ${watch.repo} ${Number(watch.ref)}`;
      let data = pass.memo.get(memoKey);
      if (data === undefined) {
        try {
          data = await this.reads.reviewsOf(
            owner,
            repo,
            Number(watch.ref),
            REVIEWS_PER_READ,
          );
          pass.memo.set(memoKey, data);
        } catch (error) {
          pass.memo.set(memoKey, null);
          // The drain ran before the read: its entries are answered even
          // when the read failed — a verified delivery is never lost
          // behind a failing read. Nothing queued: the read's failure is
          // the answer, said and left to the next pass.
          const fromQueue = this.ingestEvents(queued, cursor, (entry) =>
            this.isSpent(cursor, entry.reviewId ?? NaN),
          );
          if (fromQueue.length > 0) return fromQueue;
          throw error;
        }
      }
      if (data === null) {
        // A read that already failed this pass: the drain's entries are
        // answered even so — a verified delivery is never lost behind a
        // failing read.
        const fromQueue = this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, entry.reviewId ?? NaN),
        );
        return fromQueue.length > 0 ? fromQueue : null;
      }
      const reviews = parseReviews(data);
      if (!reviews) {
        this.debug("reviews.list.unparsed", { id: watch.id, pr: watch.ref });
        const fromQueue = this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, entry.reviewId ?? NaN),
        );
        return fromQueue.length > 0 ? fromQueue : null;
      }
      // A register whose own baseline read could not run (the forge was
      // down, the entry unusable) left the baseline to this pass: the
      // page as it stands is the backlog, spent whole, waking nobody.
      if (cursor.baselinePending) {
        return reviews.map((review) => ({
          ...reviewEventOf(review),
          baseline: true,
        }));
      }
      // The webhook-first reviews answer ahead of the REST page; the
      // REST side skips a review either family's marker already spent,
      // and skips the very ids this pass's drain took (one pass, one
      // wake per review — the queue entry answers, the REST row does
      // not repeat it).
      const takenReviewIds = new Set(
        queued.map((entry) => entry.reviewId).filter((id) => id !== undefined),
      );
      const reviewSpent = (review: { id: number }) =>
        this.isSpent(cursor, review.id) ||
        takenReviewIds.has(review.id) ||
        this.isSpent(
          cursor,
          reviewDedupeId(watch.repo, Number(watch.ref), review.id),
        );
      return [
        ...this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, entry.reviewId ?? NaN),
        ),
        ...reviews
          .filter((review) => !reviewSpent(review))
          .map((review) => reviewEventOf(review)),
      ];
    }
    if (watch.kind === "run") {
      // The run watch's drain: the queue's deliveries for this run id,
      // ahead of the record read. The REST side absorbs a run a webhook
      // delivered (the dedupe id's prefix, the row's own id) and skips
      // the non-terminal rows as before; the ids this pass's drain took
      // answer once, from the queue.
      const queued = this.takeIngest(
        watch,
        cursor,
        (entry) =>
          entry.family === "run" &&
          entry.runId !== undefined &&
          String(entry.runId) === watch.ref,
      );
      const takenRunIds = new Set(
        queued.map((entry) => entry.runId).filter((id) => id !== undefined),
      );
      let run;
      try {
        run = runRowOf(
          await this.reads.runRecord(owner, repo, Number(watch.ref)),
        );
      } catch (error) {
        // The drain ran before the read; its entries answer even when
        // the read failed — a verified delivery is never lost behind a
        // failing read. Nothing queued: the read's failure is the
        // answer, said and left to the next pass.
        this.debug("run.record.unread", {
          id: watch.id,
          run: watch.ref,
          error: String(error),
        });
        const fromQueue = this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, String(entry.runId)),
        );
        if (fromQueue.length > 0) return fromQueue;
        throw error;
      }
      if (!run) {
        this.debug("run.record.unparsed", { id: watch.id, run: watch.ref });
        return this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, String(entry.runId)),
        );
      }
      const restEvents =
        !runIsTerminal(run, this.debug) ||
        this.isSpent(cursor, run.id) ||
        takenRunIds.has(run.id) ||
        webhookRunSpent(cursor.delivered, watch.repo, run.id)
          ? []
          : [runEventOf(run)];
      return [
        ...this.ingestEvents(queued, cursor, (entry) =>
          this.isSpent(cursor, String(entry.runId)),
        ),
        ...restEvents,
      ];
    }
    // The pr and branch watches: the head resolves fresh each pass, so a
    // later push presents new runs of the same watch. The pr watch's
    // close rides first — a queue entry for it (the delivery's own
    // dedupe id) ahead of the lifecycle read's word.
    const closed =
      watch.kind === "pr"
        ? this.takeIngest(
            watch,
            cursor,
            (entry) =>
              entry.family === "pr-close" && String(entry.index) === watch.ref,
          )
        : [];
    let sha;
    if (watch.kind === "pr") {
      // The pull-request read decides two things every pass: the watch's
      // lifecycle — a closed pull request ends it, before any run is
      // read — and, on an open one, the head the run reads follow.
      let pull;
      try {
        pull = parsePullRecord(
          await this.reads.prRecord(owner, repo, Number(watch.ref)),
        );
      } catch (error) {
        this.debug("pr.record.unread", {
          id: watch.id,
          pr: watch.ref,
          error: String(error),
        });
        const fromQueue = this.ingestEvents(closed, cursor, () =>
          this.isSpent(cursor, LIFECYCLE),
        );
        if (fromQueue.length > 0) return fromQueue;
        throw error;
      }
      if (pull === null) {
        this.debug("pr.record.unparsed", { id: watch.id, pr: watch.ref });
        return this.ingestEvents(closed, cursor, () =>
          this.isSpent(cursor, LIFECYCLE),
        );
      }
      const life = prLifecycle(pull, this.debug);
      if (life) {
        // The close, twice named (the queue's delivery and the read's
        // word): the first settles, the second finds no row to mark —
        // the one-terminal-mail rule, unchanged. The drain's entry goes
        // first, the read's word behind it. A close a webhook delivered
        // earlier carries its dedupe id on the row; the read's word
        // answers under that marker's own key, so the heal pass's
        // settle reads it spent — the mail already went — and rides the
        // dissolve, never a second close mail.
        const markerKey = webhookPrMarkerKey(
          cursor.delivered,
          watch.repo,
          Number(watch.ref),
        );
        const restClose = lifecycleEventOf(life);
        return [
          ...this.ingestEvents(closed, cursor, () =>
            this.isSpent(cursor, LIFECYCLE),
          ),
          markerKey ? { ...restClose, id: markerKey } : restClose,
        ];
      }
      sha = pull?.head?.sha;
      if (typeof sha !== "string" || !sha) {
        this.debug("watch.head.unresolved", { id: watch.id, kind: watch.kind });
        return null;
      }
    } else {
      sha = await branchSha(watch, this.debug, this.reads.branchesOf);
    }
    if (!sha) return null;
    // The head's run deliveries: taken after the sha resolves — the
    // payload's head sha is the match — and before the runs read, so the
    // queue's entries answer first and the REST page absorbs what they
    // spent (the prefix read, own keys only).
    const headRuns = this.takeIngest(
      watch,
      cursor,
      (entry) => entry.family === "run" && entry.headSha === sha,
    );
    const takenRunIds = new Set(
      headRuns.map((entry) => entry.runId).filter((id) => id !== undefined),
    );
    let listed;
    try {
      listed = parseRunRows(
        await this.reads.runsOfHead(owner, repo, sha, RUNS_PER_HEAD),
      );
    } catch (error) {
      this.debug("runs.list.unread", {
        id: watch.id,
        error: String(error),
      });
      const fromQueue = this.ingestEvents(headRuns, cursor, (entry) =>
        this.isSpent(cursor, String(entry.runId)),
      );
      if (fromQueue.length > 0) return fromQueue;
      throw error;
    }
    if (!listed) {
      this.debug("runs.list.unparsed", { id: watch.id });
      return headRuns.length
        ? this.ingestEvents(headRuns, cursor, (entry) =>
            this.isSpent(cursor, String(entry.runId)),
          )
        : null;
    }
    const events: WatchEvent[] = [];
    for (const entry of listed) {
      if (
        !runIsTerminal(entry, this.debug) ||
        this.isSpent(cursor, entry.id) ||
        takenRunIds.has(entry.id) ||
        webhookRunSpent(cursor.delivered, watch.repo, entry.id)
      ) {
        continue;
      }
      // The verdict is built from the run's full record, and falls back
      // to the listing entry when that read cannot keep up — the
      // listing held a fine record too.
      let run = entry;
      try {
        const record = runRowOf(
          await this.reads.runRecord(owner, repo, entry.id),
        );
        if (record) run = record;
        else this.debug("run.record.unparsed", { id: watch.id, run: entry.id });
      } catch (error) {
        this.debug("run.record.unread", {
          id: watch.id,
          run: entry.id,
          error: String(error),
        });
      }
      events.push(runEventOf(run));
    }
    return [
      ...this.ingestEvents(headRuns, cursor, (entry) =>
        this.isSpent(cursor, String(entry.runId)),
      ),
      ...events,
    ];
  }

  // The verdict's detail reads — the job states and the failing job's
  // log tail — taken BEFORE the stamp write so that nothing but the mail
  // follows it. The forge answers the run's full job list in one read;
  // the verdict caps how much of it it takes and says so past the cap.
  // The answer is opaque to the kernel; render lays it into the mail.
  async prepare(watch: AdoptedWatch, event: WatchEvent) {
    if (event.type !== "run") return undefined;
    // The run's id comes off the event's fields (the `run` field both
    // families lay down): the webhook events' ids are the content-derived
    // dedupe ids, and Number(event.id) would read a run that does not
    // exist.
    const runId = Number(eventValue(event, "run") ?? event.id);
    const [owner, name] = watch.repo.split("/");
    let jobs = null;
    try {
      const rows = jobsOf(await this.reads.runJobs(owner, name, runId));
      if (rows === null) {
        this.debug("jobs.unparsed", { id: watch.id, run: runId });
      } else if (rows.length > JOBS_READ_CAP) {
        jobs = rows.slice(0, JOBS_READ_CAP);
        console.error(
          `[forgejo-watcher] run ${runId} of ${watch.repo} lists ${rows.length} jobs; its verdict reads the first ${JOBS_READ_CAP}`,
        );
      } else {
        jobs = rows;
      }
    } catch (error) {
      this.debug("jobs.unread", {
        id: watch.id,
        run: runId,
        error: String(error),
      });
    }
    const jobsText = jobsLine(jobs);
    const failing = Array.isArray(jobs)
      ? jobs.filter(
          (job) => String(job?.status ?? "").toLowerCase() === "failure",
        )
      : [];
    let tail = null;
    if (failing.length) {
      try {
        // Omitting offset is the forge's tail read; the client tails the
        // lines locally besides, so a route that answers the whole log
        // still costs the mail only its tail.
        const text = await this.reads.jobLog(
          owner,
          name,
          runId,
          Number(failing[0].id),
        );
        if (typeof text !== "string" || text === "") {
          this.debug("log.unread", {
            id: watch.id,
            job: failing[0]?.id,
            error: "the job-log answer carries no content",
          });
        } else {
          tail = {
            job: String(failing[0].name ?? failing[0].id),
            lines: unwrapLog(text),
          };
        }
      } catch (error) {
        this.debug("log.unread", {
          id: watch.id,
          job: failing[0]?.id,
          error: String(error),
        });
      }
    }
    return { jobsText, tail };
  }

  // The verdicts, byte for byte today's mails: the event's fields laid
  // back out under the mail builders' own names, the detail (the job
  // states and the log tail) exactly as prepare read it.
  render(watch: AdoptedWatch, event: WatchEvent, detail: unknown): string {
    if (event.type === "run") {
      const jobs = (detail ?? null) as {
        jobsText?: string | null;
        tail?: { job: string; lines: string[] } | null;
      } | null;
      return verdictMail(
        watch,
        runViewOf(event),
        jobs?.jobsText ?? null,
        jobs?.tail ?? null,
      );
    }
    if (event.type === "review") {
      return reviewMail(watch, {
        id: event.id,
        reviewer: eventValue(event, "reviewer"),
        state: eventValue(event, "review-state"),
        url: eventValue(event, "review-url"),
      });
    }
    return lifecycleMail(
      watch,
      eventValue(event, "how"),
      eventValue(event, "closed-at"),
    );
  }

  // The delivery discipline's debug ops, named as today's: verdict.* for
  // a run's CI verdict, review.* for a review wake, lifecycle.* for a
  // pr watch's close.
  debugOp(
    checkpoint: DeliverCheckpoint,
    watch: AdoptedWatch,
    event: WatchEvent,
  ) {
    if (event.terminal) {
      if (checkpoint === "unstamped") {
        return { op: "lifecycle.unstamped", attrs: { id: watch.id } };
      }
      return {
        op: `lifecycle.${checkpoint}`,
        attrs: { id: watch.id, how: eventValue(event, "how") },
      };
    }
    const stem = event.type === "run" ? "verdict" : "review";
    const attrs =
      event.type === "run"
        ? { id: watch.id, run: event.id }
        : { id: watch.id, review: event.id };
    return { op: `${stem}.${checkpoint}`, attrs };
  }
}
