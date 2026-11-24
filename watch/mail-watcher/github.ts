// The GitHub source: the watcher's second source on the kernel contract
// (kernel.ts, docs/adr/20261119-watcher-family.md), beside the forge
// source in forgejo-source.ts and composed in composer.ts. Where the
// PagerDuty and Linear sources are
// config-mapped (the operator maps each watched thing to a director
// session), the GitHub kinds are tool-registered: a register request
// carries the repo as owner/name and the number, and the watch rides the
// registering session's stamp like any forge watch. The kernel owns the
// poll pass, the registry and its adoption walk, the stamp machinery
// (the sole writer of the `chancery.watches` rows it adopts), the
// delivery discipline, and per-source failure isolation; this module is
// the source logic — the poll reads per watch kind, the zod boundaries,
// the REST client, the config read, and the verdict renders.
//
// Two kinds, v1 scope:
//
// - "github-pr" — one pull request by number. What wakes: a new review
//   (one wake per review id, the forge pr-reviews shape — every
//   reviewer's, the registering session's own included, because a wake
//   is a prompt, not a re-run), a new comment (one wake per issue-comment
//   id — a PR's comments are issue comments on GitHub), and the record's
//   own change (a state move, a draft flip, a title edit the api carries
//   only as the record's updated_at bump). The close ends the watch: one
//   terminal mail (merged, or closed unmerged), then the row dissolves
//   and no forget is needed — the forge pr watch's lifecycle, and a
//   closed pull request runs nothing new. Reopening a dissolved watch
//   takes a fresh register.
//
// - "github-issue" — one issue by number. The same comment and change
//   wakes, no terminal: an issue reopens casually, so close and reopen
//   are state changes riding the change wake's state field, and the
//   watch ends only at watcher_forget or when its stamped session dies.
//
// The cursor is the kernel's stamp-carried delivered map — the brief's
// "last seen item id/timestamp" lives in it, not beside it. The event id
// is the once-only marker key, prefixed so the id namespaces can never
// collide inside one row (`r<id>` for reviews, `c<id>` for comments,
// `chg@<updated_at>` for the record's change, the fixed `closed` for the
// terminal — a GitHub review id and comment id come from two
// independent sequences). The register-time baseline spends the backlog
// the watch already carries — the reviews and comments on the pages the
// read serves, plus the record's change marker — and never the terminal:
// a watch registered after a fast pipeline reports the finished result
// (the ADR's first-terminal rule), so a close is never spent silently.
// When the register-time read cannot run, the row stamps baseline-pending
// and the first poll pass spends its pages instead; the terminal arrives
// one pass late (the kernel's spend pass consumes the whole answer, so
// the terminal cannot ride it) — a narrow, named trade.
//
// The change wake's account rule, stateless across passes: the record's
// updated_at bump is accounted for when a parsed review or comment
// carries the bump's own timestamp (its arrival was the bump — the item
// wake is the bump's one wake), when a fresh item rides the same pass
// (the item wakes carry it), or when a spent chg@ marker already
// timestamps at or past the bump. Only a bump no item accounts for — a
// title edit, a state move — wakes as the change, carrying the state the
// record names now; the woken session fetches the rest on demand. A
// comment and an edit landing in the same window fold into the item's
// wake (the linear window-fallback's own trade), and a straddling edit
// wakes on its own pass.
//
// The reviews read diverges from the forge source's page-1-only shape on
// purpose: GitHub's review list is ordered ascending, so page 1 holds
// the oldest reviews and a page-1-only read would blind the watch to new
// reviews on any pull request past the page size. The read walks to the
// Link header's rel="last" page — the newest window the api serves —
// one extra read only past the first page's worth of reviews. The
// comments read sorts newest-first on the wire, so its first page is the
// window. An older item that falls off its page wakes late if a later
// read brings it back; the marker keeps every wake to one.
//
// The rate limit never crashes a pass: a 403 or 429 carrying
// x-ratelimit-remaining: 0 sets an in-memory backoff-until from the
// api's own x-ratelimit-reset (capped fifteen minutes out; a flat minute
// when the header is absent), said once on its named line when it
// extends. While the backoff holds, the source answers nothing usable
// without a read — the pass skips, the markers keep their once, and the
// first pass after expiry reads normally. No in-pass retries.
//
// The privacy contract holds the forge source's line: no free-text field
// exists — no title, no comment body, no review body rides an event or a
// mail. The event is pointer data and machine status; the woken session
// fetches content on demand. (Linear's change mail carries the ticket
// title, but linear rides the legacy leg outside the kernel boundary;
// an event carrying a title here would be refused at the kernel's
// boundary — the contract has nowhere to put one.)
//
// The credential is a deploy-time concern: the token rides the watcher's
// plugins entry (options.watcher.github.token, or GITHUB_TOKEN in the
// host's environment) and never reaches an error message or a log line;
// the tests stub the client's side with a loopback fake and stub tokens.
// The api base defaults to the public endpoint and rides
// options.watcher.github.url or GITHUB_API_URL for a proxy or a test.
// The source is opt-in: the composer builds nothing without the github
// block (the absence is silent), and a block it cannot serve — no token,
// an unusable url — says so once on its named line while the other
// sources carry on.

import { mailEnvelope } from "../../coordinate/director/director.ts";

import { z } from "zod";

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

const GH_DEFAULT_URL = "https://api.github.com";
const GH_KIND_PR = "github-pr";
const GH_KIND_ISSUE = "github-issue";
// The reviews page: GitHub's per_page maximum. The Link walk reaches the
// tail page past it (the newest window), never a second page before it.
const GH_REVIEWS_PER_READ = 100;
// The comments page: the newest window, newest-first on the wire.
const GH_COMMENTS_PER_READ = 50;
const GH_API_TIMEOUT_MS = 15_000;
// The rate limit's backoff ceiling: the api's own reset, never trusted
// further than fifteen minutes out (a bad clock must not park the
// source past a plausible window).
const GH_RATE_LIMIT_CAP_MS = 15 * 60_000;
// The flat backoff when the answer carries no reset header at all.
const GH_RATE_LIMIT_FALLBACK_MS = 60_000;

// One GET per read, the adapter's credential in the header in the scheme
// the api carries (Bearer). The client is stateless, and its errors name
// the route and the status — never the url's tail beyond the route and
// never the token; server-controlled text (a status reason phrase, an
// error body) is kept out of the error the way the other clients keep
// it. A rate-limited answer marks its error with the api's own reset
// moment so the source can hold its reads without parsing the status.
type GitHubError = Error & { rateLimitUntil?: number };

function githubClient(source: { token: string; url: string }) {
  const request = async (
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<{ status: number; headers: Headers; body: unknown }> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    let response: Response;
    try {
      response = await fetch(`${source.url}${path}${qs ? `?${qs}` : ""}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${source.token}`,
        },
        signal: AbortSignal.timeout(GH_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GET ${path} → ${(error as Error)?.message ?? error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const error = new Error(`GET ${path} → HTTP ${response.status}`);
      if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        // An absent header parses as NaN, not 0 — Number(null) is 0 and
        // 0 is finite, so the flat-minute fallback below would never
        // fire and a proxy stripping the header while forwarding
        // remaining: 0 would leave no backoff at all.
        const resetHeader = response.headers.get("x-ratelimit-reset");
        const reset = resetHeader === null ? NaN : Number(resetHeader);
        if (remaining === "0" && Number.isFinite(reset)) {
          (error as GitHubError).rateLimitUntil = reset * 1000;
        } else if (remaining === "0") {
          (error as GitHubError).rateLimitUntil =
            Date.now() + GH_RATE_LIMIT_FALLBACK_MS;
        }
      }
      throw error;
    }
    try {
      return {
        status: response.status,
        headers: response.headers,
        body: JSON.parse(text),
      };
    } catch {
      throw new Error(`GET ${path} → an unparseable JSON answer`);
    }
  };
  return { get: request };
}

// The config read, as the forge's readConfigOf: thrown messages are the
// ready reasons, named once. A watcher block without a github block
// never reaches here (the composer builds nothing) — the thrown line
// says so for the ready path's honesty.
const readConfigOf = (
  watcherOptions: unknown,
): { token: string; url: string } => {
  const options = isRecord(watcherOptions) ? watcherOptions : {};
  const block = isRecord(options.github) ? options.github : null;
  if (!block) {
    throw new Error(
      "no github block under options.watcher.github — the source is opt-in, and the composer builds nothing without the block",
    );
  }

  const env = typeof process === "object" ? process.env : {};
  const rawToken = block.token ?? env.GITHUB_TOKEN;
  if (
    typeof rawToken !== "string" ||
    rawToken.trim() === "" ||
    rawToken.trim() === "null"
  ) {
    throw new Error(
      "no api token — set options.watcher.github.token on the watcher's plugins entry, or GITHUB_TOKEN in the host's environment",
    );
  }

  const rawUrl = block.url ?? env.GITHUB_API_URL ?? GH_DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
  } catch {
    throw new Error(
      `url must be the GitHub api's http(s) base (got ${JSON.stringify(rawUrl)})`,
    );
  }
  // A query or a fragment is never the api's base: the client composes
  // routes under it, so one riding in would be silently dropped here —
  // a misconfiguration that reads as configured. The source is off
  // instead, said on its line — and the url is not echoed past its
  // origin and path, because its query is exactly the part that must
  // never log.
  if (parsed.search || parsed.hash) {
    throw new Error(
      `url must be the GitHub api's http(s) base without a query or a fragment (got ${parsed.origin}${parsed.pathname} plus a query or fragment)`,
    );
  }
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { token: rawToken.trim(), url };
};

// The record's boundary shape: the pull-request record (GET
// /repos/{owner}/{repo}/pulls/{number}) and the issue record (GET
// /repos/{owner}/{repo}/issues/{number}) carry the fields a wake needs.
// A shape that drifts parses to null — the pass is skipped, the wake
// never invented.
const ZPullRecord = z.looseObject({
  number: z.number(),
  state: z.string(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  updated_at: z.string(),
  html_url: z.string().nullish(),
});

const ZIssueRecord = z.looseObject({
  number: z.number(),
  state: z.string(),
  closed_at: z.string().nullish(),
  updated_at: z.string(),
  html_url: z.string().nullish(),
});

// The review row's boundary shape (GET
// /repos/{owner}/{repo}/pulls/{number}/reviews). A PENDING review is an
// unsubmitted draft: dropped before anything reads it, so the draft
// never wakes and its id is never spent — the verdict that submitting
// turns it into still wakes.
const ZReviewRow = z.looseObject({
  id: z.number(),
  state: z.string(),
  submitted_at: z.string().nullish(),
  user: z.looseObject({ login: z.string().nullish() }).nullish(),
  html_url: z.string().nullish(),
});

// The issue-comment row's boundary shape (GET
// /repos/{owner}/{repo}/issues/{number}/comments). The body rides the
// wire and stops here — the parsed comment carries none of it.
const ZCommentRow = z.looseObject({
  id: z.number(),
  created_at: z.string(),
  user: z.looseObject({ login: z.string().nullish() }).nullish(),
  html_url: z.string().nullish(),
});

// One parsed record, as the poll and the baseline carry it. `draft` and
// `merged` ride only the pull-request record.
type ParsedRecord = {
  number: number;
  state: string;
  updatedAt: string;
  url?: string;
  draft?: boolean;
  merged?: boolean;
  mergedAt?: string;
  closedAt?: string;
};

type ParsedReview = {
  id: number;
  state: string;
  reviewer?: string;
  submittedAt?: string;
  url?: string;
};

type ParsedComment = {
  id: number;
  createdAt: string;
  author?: string;
  url?: string;
};

const parseRecord = (raw: unknown, pr: boolean): ParsedRecord | null => {
  const parsed = pr ? ZPullRecord.safeParse(raw) : ZIssueRecord.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (
    !Number.isInteger(data.number) ||
    !data.state.trim() ||
    !data.updated_at.trim()
  ) {
    return null;
  }
  const url =
    typeof data.html_url === "string" && data.html_url.trim()
      ? data.html_url.trim()
      : undefined;
  if (pr) {
    return {
      number: data.number,
      state: data.state.trim(),
      updatedAt: data.updated_at.trim(),
      ...(url ? { url } : {}),
      ...(typeof data.draft === "boolean" ? { draft: data.draft } : {}),
      merged: data.merged === true,
      ...(typeof data.merged_at === "string" && data.merged_at.trim()
        ? { mergedAt: data.merged_at }
        : {}),
      ...(typeof data.closed_at === "string" && data.closed_at.trim()
        ? { closedAt: data.closed_at }
        : {}),
    };
  }
  return {
    number: data.number,
    state: data.state.trim(),
    updatedAt: data.updated_at.trim(),
    ...(url ? { url } : {}),
    ...(typeof data.closed_at === "string" && data.closed_at.trim()
      ? { closedAt: data.closed_at }
      : {}),
  };
};

const parseReviewRows = (raw: unknown): ParsedReview[] | null => {
  if (!Array.isArray(raw)) return null;
  const reviews: ParsedReview[] = [];
  for (const row of raw) {
    const parsed = ZReviewRow.safeParse(row);
    if (!parsed.success) continue;
    const state = parsed.data.state.trim();
    const reviewer = parsed.data.user?.login;
    if (
      !Number.isInteger(parsed.data.id) ||
      !state ||
      state.toUpperCase() === "PENDING"
    )
      continue;
    if (typeof reviewer !== "string" || !reviewer.trim()) continue;
    reviews.push({
      id: parsed.data.id,
      state,
      reviewer: reviewer.trim(),
      ...(typeof parsed.data.submitted_at === "string" &&
      parsed.data.submitted_at.trim()
        ? { submittedAt: parsed.data.submitted_at.trim() }
        : {}),
      ...(typeof parsed.data.html_url === "string" &&
      parsed.data.html_url.trim()
        ? { url: parsed.data.html_url.trim() }
        : {}),
    });
  }
  return reviews;
};

const parseCommentRows = (raw: unknown): ParsedComment[] | null => {
  if (!Array.isArray(raw)) return null;
  const comments: ParsedComment[] = [];
  for (const row of raw) {
    const parsed = ZCommentRow.safeParse(row);
    if (!parsed.success) continue;
    if (!Number.isInteger(parsed.data.id) || !parsed.data.created_at.trim())
      continue;
    const author = parsed.data.user?.login;
    comments.push({
      id: parsed.data.id,
      createdAt: parsed.data.created_at.trim(),
      ...(typeof author === "string" && author.trim()
        ? { author: author.trim() }
        : {}),
      ...(typeof parsed.data.html_url === "string" &&
      parsed.data.html_url.trim()
        ? { url: parsed.data.html_url.trim() }
        : {}),
    });
  }
  return comments;
};

// The Link header's rel="last" page: the walk's tail. Null when the
// answer carries no Link (the whole list fit one page) or no readable
// page number in it.
const lastPageOf = (link: string | null): number | null => {
  if (!link) return null;
  const segment = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel="last"/.test(part));
  if (!segment) return null;
  const target = /<([^>]*)>/.exec(segment)?.[1];
  const page = target ? /[?&]page=(\d+)/.exec(target)?.[1] : undefined;
  const parsed = page === undefined ? NaN : Number(page);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// The events the source's poll answers: the poll's reads, laid onto the
// kernel's privacy contract — id, ref, url, status, measure, and no
// free-text field. The event id is the delivered marker's key.
const reviewEventOf = (review: ParsedReview): WatchEvent => ({
  id: `r${review.id}`,
  type: "review",
  fields: [
    { kind: "id", name: "review", value: String(review.id) },
    { kind: "ref", name: "reviewer", value: review.reviewer! },
    { kind: "status", name: "review-state", value: review.state },
    ...(review.url
      ? [{ kind: "url", name: "review-url", value: review.url }]
      : []),
  ],
});

const commentEventOf = (comment: ParsedComment): WatchEvent => ({
  id: `c${comment.id}`,
  type: "comment",
  fields: [
    { kind: "id", name: "comment", value: String(comment.id) },
    ...(comment.author
      ? [{ kind: "ref", name: "author", value: comment.author }]
      : []),
    ...(comment.url
      ? [{ kind: "url", name: "comment-url", value: comment.url }]
      : []),
  ],
});

const changeEventOf = (record: ParsedRecord): WatchEvent => ({
  id: `chg@${record.updatedAt}`,
  type: "change",
  fields: [
    { kind: "id", name: "change", value: record.updatedAt },
    { kind: "status", name: "state", value: record.state },
    ...(typeof record.draft === "boolean"
      ? [
          {
            kind: "status",
            name: "draft",
            value: record.draft ? "true" : "false",
          },
        ]
      : []),
    { kind: "measure", name: "updated-at", value: record.updatedAt },
    ...(record.url ? [{ kind: "url", name: "pr-url", value: record.url }] : []),
  ],
});

// The terminal close: one mail, then the watch dissolves. The fixed id
// is the forge lifecycle's pattern — the dissolve makes it once-only.
const closedEventOf = (record: ParsedRecord): WatchEvent => {
  const at = record.merged ? record.mergedAt : record.closedAt;
  return {
    id: "closed",
    type: "closed",
    terminal: true,
    fields: [
      { kind: "id", name: "lifecycle", value: "closed" },
      {
        kind: "status",
        name: "how",
        value: record.merged ? "merged" : "closed unmerged",
      },
      ...(at ? [{ kind: "measure", name: "closed-at", value: at }] : []),
    ],
  };
};

// The verdicts, carried by the event's fields laid back out under the
// mail builders' own names. A field the event does not carry reads as
// undefined — the same absence the REST row's optional fields had.
const eventValue = (event: WatchEvent, name: string): string | undefined =>
  event.fields.find((field) => field.name === name)?.value;

const watchHead = (watch: AdoptedWatch) =>
  `watch ${watch.id} — ${watch.kind} ${watch.repo}#${watch.ref}${watch.note ? ` — ${watch.note}` : ""}`;

const surface = (kind: string) => (kind === GH_KIND_PR ? "PR" : "issue");

const reviewMail = (watch: AdoptedWatch, event: WatchEvent): string => {
  const lines = [
    "GitHub mail — PR review",
    watchHead(watch),
    "",
    `review ${eventValue(event, "review")} by ${eventValue(event, "reviewer")} — ${eventValue(event, "review-state")} on ${watch.repo}#${watch.ref}`,
  ];
  if (eventValue(event, "review-url"))
    lines.push(`url ${eventValue(event, "review-url")}`);
  return mailEnvelope(lines);
};

const commentMail = (watch: AdoptedWatch, event: WatchEvent): string => {
  const lines = [
    `GitHub mail — ${surface(watch.kind)} comment`,
    watchHead(watch),
    "",
    `${watch.repo}#${watch.ref} — comment ${eventValue(event, "comment")}`,
  ];
  if (eventValue(event, "author"))
    lines.push(`by ${eventValue(event, "author")}`);
  if (eventValue(event, "comment-url"))
    lines.push(`url ${eventValue(event, "comment-url")}`);
  return mailEnvelope(lines);
};

const changeMail = (watch: AdoptedWatch, event: WatchEvent): string => {
  const lines = [
    `GitHub mail — ${surface(watch.kind)} change`,
    watchHead(watch),
    "",
    `${watch.repo}#${watch.ref} — changed`,
    `state ${eventValue(event, "state")}`,
  ];
  if (eventValue(event, "draft") === "true") lines.push("draft");
  if (eventValue(event, "updated-at"))
    lines.push(`updated at ${eventValue(event, "updated-at")}`);
  if (eventValue(event, "pr-url"))
    lines.push(`url ${eventValue(event, "pr-url")}`);
  return mailEnvelope(lines);
};

const closedMail = (watch: AdoptedWatch, event: WatchEvent): string => {
  const at = eventValue(event, "closed-at");
  const lines = [
    "GitHub mail — watch closed",
    watchHead(watch),
    "",
    at
      ? `PR ${watch.repo}#${watch.ref} closed: ${eventValue(event, "how")} at ${at}`
      : `PR ${watch.repo}#${watch.ref} closed: ${eventValue(event, "how")}`,
  ];
  return mailEnvelope(lines);
};

// The reads, one per surface, built over the client. Each throws named
// on a failure — the route and the status, never the credential — and
// the reviews read walks to the Link header's tail page.
export type GitHubReads = {
  record: (
    owner: string,
    repo: string,
    number: number,
    pr: boolean,
  ) => Promise<unknown>;
  reviews: (owner: string, repo: string, number: number) => Promise<unknown>;
  comments: (owner: string, repo: string, number: number) => Promise<unknown>;
};

const readsOf = (config: { token: string; url: string }): GitHubReads => {
  const client = githubClient(config);

  const record = async (
    owner: string,
    repo: string,
    number: number,
    pr: boolean,
  ) => {
    const answer = await client.get(
      pr
        ? `/repos/${owner}/${repo}/pulls/${number}`
        : `/repos/${owner}/${repo}/issues/${number}`,
    );
    return answer.body;
  };

  const reviews = async (owner: string, repo: string, number: number) => {
    const route = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
    const first = await client.get(route, { per_page: GH_REVIEWS_PER_READ });
    const last = lastPageOf(first.headers.get("link"));
    if (last === null || last <= 1) return first.body;
    const tail = await client.get(route, {
      per_page: GH_REVIEWS_PER_READ,
      page: last,
    });
    return tail.body;
  };

  const comments = async (owner: string, repo: string, number: number) => {
    const answer = await client.get(
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        per_page: GH_COMMENTS_PER_READ,
        sort: "created",
        direction: "desc",
      },
    );
    return answer.body;
  };

  return { record, reviews, comments };
};

// The GitHub source: the contract's class shape over the module's pure
// boundary (the parsers, the event builders, the mail builders) and its
// reads. The claim group gives github-pr one owner per repo+number — a
// second register returns the claimed watch instead of a second owner —
// because the lifecycle dissolve makes a single owner the safe shape;
// github-issue never dissolves itself, so it claims nothing.
export class GitHubSource extends WatchSource {
  readonly id = "github";

  // The config and the reads over it, materialized by the ready gate's
  // config read (the kernel calls ready once before any poll runs) —
  // a source whose config cannot serve is dropped by the kernel and
  // never reads.
  private config: { token: string; url: string } | null = null;
  private reads: GitHubReads | null = null;

  // The rate limit's in-memory state: a backoff-until said once when it
  // extends, reset by nothing (expiry reads normally again).
  private backoffUntil = 0;

  constructor(deps: { debug: Debug }) {
    super(deps.debug);
  }

  // The config read, as the forge's: thrown messages are the ready
  // reasons, named once (the kernel's own disabled-source line carries
  // them). A watcher block without a github block never reaches here
  // (the composer builds nothing) — the thrown line says so for the
  // ready path's honesty.
  protected readConfig(watcherOptions: unknown): unknown {
    const read = readConfigOf(watcherOptions);
    this.config = read;
    this.reads = readsOf(read);
    return read;
  }

  private get githubReads(): GitHubReads {
    if (this.reads === null) {
      throw new Error("the github source's reads read before its config");
    }
    return this.reads;
  }

  private noteRateLimit(untilMs: number) {
    const capped = Math.min(untilMs, Date.now() + GH_RATE_LIMIT_CAP_MS);
    if (capped <= this.backoffUntil) return;
    this.backoffUntil = capped;
    console.error(
      `[forgejo-watcher] the github source hit the api rate limit; reads hold until ${new Date(capped).toISOString()} and the watches keep their cursors`,
    );
  }

  private limitNoteOf(error: unknown): number | null {
    const until = (error as GitHubError | null)?.rateLimitUntil;
    return typeof until === "number" ? until : null;
  }

  // The per-pass read memo: one read per surface key, shared by every
  // consumer in the pass — a github-pr watch and a github-issue watch on
  // the same number share the comments read. Null marks a read that
  // already failed this pass; the failure rethrows so the kernel says
  // the watch poll failed.
  private async throughMemo(
    memo: Map<string, unknown>,
    key: string,
    read: () => Promise<unknown>,
  ): Promise<unknown> {
    let held = memo.get(key);
    if (held === undefined) {
      try {
        held = await read();
        memo.set(key, held);
      } catch (error) {
        memo.set(key, null);
        const until = this.limitNoteOf(error);
        if (until !== null) this.noteRateLimit(until);
        throw error;
      }
    }
    return held;
  }

  // The change wake's account rules, stateless: a spent chg@ marker at
  // or past the bump means the change already woke (or an older bump
  // did — the markers ratchet); an item carrying the bump's own
  // timestamp means the item's wake is the bump's.
  private changeOvertaken(
    delivered: Record<string, boolean>,
    updatedAt: string,
  ): boolean {
    for (const key of Object.keys(delivered)) {
      if (!key.startsWith("chg@")) continue;
      if (key.slice(4) >= updatedAt) return true;
    }
    return false;
  }

  private bumpAccounted(
    record: ParsedRecord,
    items: Array<{ ts?: string }>,
  ): boolean {
    return items.some(
      (item) => item.ts !== undefined && item.ts === record.updatedAt,
    );
  }

  kinds(): readonly string[] {
    return [GH_KIND_PR, GH_KIND_ISSUE];
  }

  claimGroupOf(kind: string): string | null {
    return kind === GH_KIND_PR ? "github-pull" : null;
  }

  normalize(req: RegisterRequest): WatchRowSeed {
    const kind = this.checkKind(req);
    const repo = String(req.repo || "").trim();
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new Error(
        `watcher_register: repo must be owner/name (got ${JSON.stringify(req.repo)})`,
      );
    }
    const ref = String(req.ref || "").trim();
    if (!/^\d+$/.test(ref)) {
      throw new Error(
        `watcher_register: ref must be the numeric ${kind === GH_KIND_PR ? "pull request" : "issue"} number (got ${JSON.stringify(req.ref)})`,
      );
    }
    const note = this.normalizeNote(req);
    return { kind, repo, ref, note };
  }

  // The register-time baseline: the items the pages already carry and
  // the record's change marker are the spent backlog — the watch wakes
  // on what arrives after it, never on the page it registered against,
  // and never on a close (the ADR's first-terminal rule). When the api
  // cannot answer, the kernel stamps the watch baseline-pending and the
  // first poll pass spends its pages instead. The kind guard and the
  // unread-to-pending mapping are the base's template.
  protected baselineKinds(): readonly string[] {
    return [GH_KIND_PR, GH_KIND_ISSUE];
  }

  protected noteBaselineUnread(_seed: WatchRowSeed, error: unknown): void {
    const until = this.limitNoteOf(error);
    if (until !== null) this.noteRateLimit(until);
    this.debug("register.baseline.unread", { error: String(error) });
  }

  protected async readBaseline(
    seed: WatchRowSeed,
  ): Promise<Record<string, boolean> | null> {
    const [owner, repo] = seed.repo.split("/");
    const number = Number(seed.ref);
    const pr = seed.kind === GH_KIND_PR;
    const record = parseRecord(
      await this.githubReads.record(owner, repo, number, pr),
      pr,
    );
    if (!record) return null;
    const spent: Record<string, boolean> = {};
    if (pr) {
      const reviewRows = parseReviewRows(
        await this.githubReads.reviews(owner, repo, number),
      );
      if (reviewRows === null) return null;
      for (const review of reviewRows) spent[`r${review.id}`] = true;
    }
    const commentRows = parseCommentRows(
      await this.githubReads.comments(owner, repo, number),
    );
    if (commentRows === null) return null;
    for (const comment of commentRows) spent[`c${comment.id}`] = true;
    spent[`chg@${record.updatedAt}`] = true;
    return spent;
  }

  // The poll read, per kind — a pure read answering normalized events.
  // Null answers "the read gave nothing usable" (the pass skips; a
  // baseline-pending row keeps its flag); an array answers a successful
  // read (a baseline-pending row spends it, empty or not). Never writes
  // stamps, never delivers — the kernel owns both.
  async poll(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    pass: PassContext,
  ): Promise<WatchEvent[] | null> {
    const [owner, repo] = watch.repo.split("/");
    const number = Number(watch.ref);
    const pr = watch.kind === GH_KIND_PR;
    if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
      this.debug("watch.ref.unusable", { id: watch.id, kind: watch.kind });
      return null;
    }

    // A held backoff reads nothing: the pass skips, the markers keep
    // their once, and the first pass after expiry reads normally.
    if (Date.now() < this.backoffUntil) {
      this.debug("github.backoff.held", {
        id: watch.id,
        until: new Date(this.backoffUntil).toISOString(),
      });
      return null;
    }

    const recordKey = `github record ${pr ? "pulls" : "issues"} ${watch.repo}#${number}`;
    const record = parseRecord(
      await this.throughMemo(pass.memo, recordKey, () =>
        this.githubReads.record(owner, repo, number, pr),
      ),
      pr,
    );
    if (!record) {
      this.debug("record.unparsed", { id: watch.id, kind: watch.kind, number });
      return null;
    }

    // A baseline-pending pass spends its pages whole: the items and the
    // record's change marker, baseline-true, waking nobody. The terminal
    // cannot ride this answer (the kernel's spend consumes it whole), so
    // a close arrives one pass late — the named trade.
    if (cursor.baselinePending) {
      const reviewRows = pr
        ? parseReviewRows(
            await this.throughMemo(
              pass.memo,
              `github reviews ${watch.repo}#${number}`,
              () => this.githubReads.reviews(owner, repo, number),
            ),
          )
        : [];
      const commentRows = parseCommentRows(
        await this.throughMemo(
          pass.memo,
          `github comments ${watch.repo}#${number}`,
          () => this.githubReads.comments(owner, repo, number),
        ),
      );
      if (reviewRows === null || commentRows === null) {
        this.debug("items.unparsed", {
          id: watch.id,
          kind: watch.kind,
          number,
        });
        return null;
      }
      return [
        ...reviewRows.map((review) => ({
          ...reviewEventOf(review),
          baseline: true,
        })),
        ...commentRows.map((comment) => ({
          ...commentEventOf(comment),
          baseline: true,
        })),
        { ...changeEventOf(record), baseline: true },
      ];
    }

    // The close ends a github-pr watch: the record read alone decides it
    // (the forge pr lifecycle's shape — the close pass reads no items),
    // one terminal mail, then the row dissolves.
    if (pr && record.state === "closed") {
      return [closedEventOf(record)];
    }

    const reviewsKey = `github reviews ${watch.repo}#${number}`;
    const commentsKey = `github comments ${watch.repo}#${number}`;
    const reviewRows = pr
      ? parseReviewRows(
          await this.throughMemo(pass.memo, reviewsKey, () =>
            this.githubReads.reviews(owner, repo, number),
          ),
        )
      : [];
    const commentRows = parseCommentRows(
      await this.throughMemo(pass.memo, commentsKey, () =>
        this.githubReads.comments(owner, repo, number),
      ),
    );
    if (reviewRows === null || commentRows === null) {
      this.debug("items.unparsed", { id: watch.id, kind: watch.kind, number });
      return null;
    }

    const freshReviews = reviewRows.filter(
      (review) => !this.isSpent(cursor, `r${review.id}`),
    );
    const freshComments = commentRows.filter(
      (comment) => !this.isSpent(cursor, `c${comment.id}`),
    );
    const events: WatchEvent[] = [
      ...freshReviews.map(reviewEventOf),
      ...freshComments.map(commentEventOf),
    ];
    if (
      freshReviews.length === 0 &&
      freshComments.length === 0 &&
      !this.isSpent(cursor, `chg@${record.updatedAt}`) &&
      !this.changeOvertaken(cursor.delivered, record.updatedAt) &&
      !this.bumpAccounted(record, [
        ...reviewRows.map((review) => ({ ts: review.submittedAt })),
        ...commentRows.map((comment) => ({ ts: comment.createdAt })),
      ])
    ) {
      events.push(changeEventOf(record));
    }
    return events;
  }

  // The verdicts: the event's fields laid back out under the mail
  // builders' own names. A wake is a prompt, not a diff — the mail
  // names what is knowable; the woken session fetches the rest.
  render(watch: AdoptedWatch, event: WatchEvent): string {
    if (event.type === "review") return reviewMail(watch, event);
    if (event.type === "comment") return commentMail(watch, event);
    if (event.type === "change") return changeMail(watch, event);
    return closedMail(watch, event);
  }

  // The delivery discipline's debug ops, source-named: review.* for a
  // review wake, comment.* for a comment, change.* for the record's
  // change, lifecycle.* for the terminal close.
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
    const attrs =
      event.type === "review"
        ? { id: watch.id, review: event.id }
        : event.type === "comment"
          ? { id: watch.id, comment: event.id }
          : { id: watch.id, change: event.id };
    return { op: `${event.type}.${checkpoint}`, attrs };
  }
}
