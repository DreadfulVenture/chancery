// The Linear source (PRJ-475): the watcher's third source. The operator
// maps each watched Linear project to a director session in the watcher's
// config — the PagerDuty source's mapping shape, carried over. The poll
// pass reads the Linear GraphQL API with the discipline the other reads
// carry (plain HTTP with the credential in the header, every response
// through zod at the boundary, paging walked to the route's end), and
// each ticket change the claims machinery has not seen wakes exactly
// once, landing on the session the config names for that project.
//
// The temporal filter is the whole ticket rule: on registration (the
// claims row's first write) the row stamps `since` — the registration
// moment as the per-project last-change cursor. Every read asks for the
// project's issues with `updatedAt >= since`, and the answer is filtered
// again after the read against that same since (the wire filter is never
// leaned on alone, the PagerDuty statuses[] rule). A change older than
// the cursor wakes nothing; the accumulated pre-registration history is
// never replayed. Linear's workflow states play no part in the filter —
// "Backlog" is a state like any other, and a state name rides the wake
// as data, never gates it.
//
// The cursor ratchets: a complete read advances `since` to the read's
// start moment minus a skew margin (a host and Linear can disagree about
// "now" by more than a poll interval, so the margin keeps a change whose
// server-side timestamp landed just behind the read from being skipped
// forever), and the ratchet's floor is the row's own history — the
// cursor only climbs, so the window can never reach back below the
// registration moment no matter how far the margin reaches. The overlap
// the margin creates re-serves changes the markers have already spent;
// the delivered markers eat the duplicates. An incomplete read (a page
// cap, a spent budget, a parse failure) advances nothing — the next pass
// re-reads the window whole. A failed stamp write during settling holds
// the advance the same way, so the failed write's owed-mail recovery
// (the PagerDuty failedWrites path) keeps its next pass to read from.
//
// What wakes: a ticket edit (title, description), a state move, a new
// comment — discovered per issue from the issue's own updatedAt bump.
// The read carries each issue's latest few comments, and a comment
// newer than the cursor is the bump: the comment wakes (once, by its
// own id — comment edits do not re-wake). Without a newer comment the
// bump is the issue's own change: title, description, and state all
// surface as the one change wake carrying the current state name and
// title (the API has no cheap per-field history, so the mail names what
// is knowable and the woken session fetches the rest on demand). A
// comment wake spends the bump's change marker alongside its own, so
// the same bump never wakes twice.
//
// No source abstraction lives between the sources. Like the PagerDuty
// source, this rides the watcher's existing shape — the same poll pass,
// the same stamp machinery (each project's claims row is a
// `chancery.watches` row on the target session's stamp, beside the
// forge watches' and the pagerduty rows), the same mark-first
// mail-second discipline — through the kernel's legacy leg. The
// kernel/source split is the family's own decision; both legs migrate
// onto the source contract in later slices.
//
// Unlike the PagerDuty claims row, the Linear row carries no prune: a
// PagerDuty incident id can never reappear once its read window has
// passed, but a Linear issue keeps bumping forever, and any later bump
// can carry an old comment id back into a read — a marker's whole life
// is its row's life. The forge watches make the same trade (no expiry,
// no cap).
//
// The module is TypeScript, loaded through the deployed runtime's
// native .ts import (Bun transpiles it; Node 24 strips the types) — the
// syntax stays erasable-only, so nothing here needs a build step. The
// class owns the source's surface the way the PagerDuty source owns
// its: the credential and config handling (the static readConfig, which
// answers null — the source off — on any config it cannot serve), the
// GraphQL client, the zod boundary, and the change-to-wake mapping. The
// composer (composer.ts) reads the config, builds the instance beside the
// other legs, and calls poll() from the poll pass; the stamp machinery
// (patchStamps, readStamps, failedWrites, the stopped flag) is passed
// in, never forked.
//
// The config, on the watcher's plugins entry (options winning per key,
// the forge's credential pattern):
//
//   "watcher": {
//     "forgeUrl": "https://forge.example.com", "forgeToken": "…",
//     "linear": {
//       "token": "…",   // or LINEAR_TOKEN in the host's environment
//       "url": "…",     // optional; the api's base (no query or fragment), default https://api.linear.app
//       "projects": [
//         { "project": "<the Linear project's id>", "wake": "ses_…", "note": "the chancery lane" }
//       ]
//     }
//   }
//
// The watch key is the Linear project's id (the uuid the GraphQL api
// filters on), not its name or key: a name lookup would cost an extra
// read per pass and a key can be renamed. The token rides the watcher's
// credential pattern like forgeToken and PAGERDUTY_TOKEN — env,
// per-entry override — and never reaches an error message or a log
// line. A missing token, an unusable url, or zero watchable projects
// disables the Linear source at init with a named line; the forge and
// PagerDuty sources keep running. The plugin throws at init only for
// its forge-side config.

import { mailEnvelope } from "../../coordinate/director/director.ts";

import { z } from "zod";

const LN_DEFAULT_URL = "https://api.linear.app";
const LN_KIND = "linear";
const LN_API_TIMEOUT_MS = 15_000;
// The issues read's page: a conservative `first`, walked by the answer's
// own endCursor.
const LN_ISSUES_PER_READ = 50;
// The walk's page cap: 500 changed issues in one window. A capped walk
// settles the set it served — the wakes land, the markers spend — but
// the cursor holds: the api's ordering is documented by field only
// (linear.app/developers: orderBy takes createdAt, default, and
// updatedAt; the docs never state the direction), so a page the walk
// served cannot be proven to precede the tail it never reached, and
// advancing past it could lose changes. The window therefore re-reads
// whole next pass, the delivered markers keep the re-read to
// at-most-once, and the trade is the tail's starvation: while a
// project's window of changed tickets outruns the cap, tickets ranked
// past it wake later, not never — the window shrinks as the backlog
// drains, and the cap's read reaches further every pass it holds.
const LN_ISSUE_PAGES = 10;
// The per-issue comments read: the latest few, enough to name a comment
// bump. A bump whose window comes back full of fresh comments — at
// least this many unspent — may carry more the read did not serve, so
// it falls back to the ticket's change wake (one wake for the bump,
// every fresh id spent beside it) instead of per-comment wakes: the
// change is said once, and nothing the read could not carry is lost
// silently.
const LN_COMMENTS_PER_ISSUE = 5;
// The leg's pass budget (the PagerDuty leg's budget pattern, review
// 339's 16310): the most time the Linear leg may spend STARTING upstream
// reads inside one shared poll pass. The check runs before each page
// read and never after, so the bound is the deadline plus the one read
// already in flight (its own 15s timeout). There is no kernel pass
// deadline to fit: the kernel runs its legs back to back and holds the
// next interval tick while a pass is in flight, so the pass is the sum
// of this leg's budget and the PagerDuty leg's 60s beside it, and each
// budget bounds its own leg's share alone.
const LN_LEG_BUDGET_MS = 60_000;
// The wake tail's deadline: the most time the leg may spend settling
// one pass's wakes (one stamp write and one mail per wake) before it
// defers the rest to the next pass. A deferred wake is unmarked and
// the cursor holds, so the deferral loses nothing and double-wakes
// nothing — the next pass re-reads the window and the markers keep the
// settled ids to once.
const LN_SETTLE_BUDGET_MS = 30_000;
// The cursor's skew margin: how far a complete read's advance may reach
// back past the read's own start moment, to cover a Linear clock running
// behind this host's. An hour of disagreement covers any plausible
// skew; the delivered markers eat the overlap's re-served changes.
const LN_SKEW_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// One watched project's entry, as the config carries it after readConfig
// validated it.
export type LinearProjectEntry = {
  project: string;
  wake: string;
  note?: string;
};

// The source's config as readConfig answers it — null means the source
// is off, never an instance.
export type LinearConfig = {
  token: string;
  url: string;
  projects: LinearProjectEntry[];
};

// The stamp row the claims machinery reads and patches: the
// `chancery.watches` row, host-opaque beyond the fields the machinery
// names.
type StampRow = {
  id?: string;
  session?: string;
  kind?: string;
  ref?: string;
  note?: string;
  since?: string;
  delivered?: Record<string, boolean>;
  markedAt?: Record<string, string>;
  [key: string]: unknown;
};

type Debug = (op: string, attrs?: Record<string, unknown>) => void;

// The context the source touches directly: the wake delivery. Everything
// else rides through the stamp machinery passed in beside it.
type SourceContext = {
  session: {
    synthetic: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
};

// The stamp machinery's contract, stated where the mail-owed recovery
// depends on it (the PagerDuty source's reading of review 339's 16308):
// patchStamps attempts the write for ANY array a patch returns — an
// unchanged array included — and answers that array or `false` (the
// write failed). It answers `null` only when the patch itself aborted
// (a row it found gone), and `undefined` when the session is gone.
type PatchStamps = (
  ctx: SourceContext,
  debug: Debug,
  sessionID: string,
  patch: (rows: StampRow[]) => StampRow[] | null,
) => Promise<StampRow[] | null | false | undefined>;

type ReadStamps = (
  ctx: SourceContext,
  debug: Debug,
  sessionID: string,
) => Promise<StampRow[] | null | undefined>;

type LinearSourceDeps = {
  config: LinearConfig;
  ctx: SourceContext;
  debug: Debug;
  patchStamps: PatchStamps;
  readStamps: ReadStamps;
  isStopped: () => boolean;
  failedWrites: Set<string>;
  /**
   * The leg's pass budget in milliseconds, for tests; the deployment
   * rides the module constant (composer.ts passes nothing here).
   */
  legBudgetMs?: number;
  /**
   * The cursor's skew margin in milliseconds, for tests; the deployment
   * rides the module constant.
   */
  skewMs?: number;
};

// The GraphQL client: one POST per read against Linear's /graphql, the
// api key in the header in the scheme the api carries (the raw key, no
// scheme prefix — an OAuth token would take Bearer, and the config
// names the api key's own form). The client is stateless, and its
// errors name the route and the status — never the url's tail beyond
// the route and never the token; server-controlled text (a status
// reason phrase, a GraphQL error message) is kept out of the error the
// same way the PagerDuty client keeps statusText out.
function linearClient(source: { token: string; url: string }) {
  const request = async (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${source.url}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: source.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LN_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`POST /graphql → ${(error as Error)?.message ?? error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`POST /graphql → HTTP ${response.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`POST /graphql → an unparseable JSON answer`);
    }
  };
  return { post: request };
}

// The issues read, as one GraphQL document. The project filter and the
// temporal filter ride the wire as variables; the walk orders by
// updatedAt so a window's pages are stable while it walks.
const ISSUES_QUERY = `query WatchedIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      updatedAt
      state { name }
      comments(last: ${LN_COMMENTS_PER_ISSUE}) {
        nodes {
          id
          createdAt
          user { name }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// The answer's boundary shape. Linear reports query-level failures in a
// top-level `errors` array; `data` may be null beside it. A shape that
// drifts parses to null — the pass is skipped, the wake never invented.
const ZAnswer = z.looseObject({
  data: z
    .looseObject({
      issues: z.looseObject({
        nodes: z.array(z.unknown()),
        pageInfo: z.looseObject({
          hasNextPage: z.boolean().optional(),
          endCursor: z.string().nullish(),
        }),
      }),
    })
    .nullish(),
  errors: z.array(z.unknown()).optional(),
});

// The issue node's boundary shape: the fields a wake carries. A row
// that drifts parses to a dropped row.
const ZIssueNode = z.looseObject({
  id: z.string(),
  identifier: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  updatedAt: z.string(),
  state: z.looseObject({ name: z.string().nullish() }).optional(),
  comments: z.looseObject({ nodes: z.array(z.unknown()) }).nullish(),
});

// One parsed comment, as the wake carries it.
type ParsedComment = {
  id: string;
  createdAt: string;
  author?: string;
};

// One parsed issue, as the wake carries it.
type ParsedIssue = {
  id: string;
  identifier: string;
  title?: string;
  url?: string;
  updatedAt: string;
  stateName?: string;
  comments: ParsedComment[];
};

const parseCommentNode = (raw: unknown): ParsedComment | null => {
  const parsed = z
    .looseObject({
      id: z.string(),
      createdAt: z.string(),
      user: z.looseObject({ name: z.string().nullish() }).nullish(),
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  const id = parsed.data.id.trim();
  if (!id || !parsed.data.createdAt.trim()) return null;
  const author = parsed.data.user?.name;
  return {
    id,
    createdAt: parsed.data.createdAt,
    ...(typeof author === "string" && author.trim()
      ? { author: author.trim() }
      : {}),
  };
};

const parseIssueNode = (raw: unknown): ParsedIssue | null => {
  const parsed = ZIssueNode.safeParse(raw);
  if (!parsed.success) return null;
  const id = parsed.data.id.trim();
  const identifier = parsed.data.identifier.trim();
  const updatedAt = parsed.data.updatedAt.trim();
  if (!id || !identifier || !updatedAt) return null;
  const comments: ParsedComment[] = [];
  for (const rawComment of parsed.data.comments?.nodes ?? []) {
    const comment = parseCommentNode(rawComment);
    if (comment) comments.push(comment);
  }
  const stateName = parsed.data.state?.name;
  return {
    id,
    identifier,
    updatedAt,
    ...(typeof parsed.data.title === "string" && parsed.data.title.trim()
      ? { title: parsed.data.title.trim() }
      : {}),
    ...(typeof parsed.data.url === "string" && parsed.data.url.trim()
      ? { url: parsed.data.url.trim() }
      : {}),
    ...(typeof stateName === "string" && stateName.trim()
      ? { stateName: stateName.trim() }
      : {}),
    comments,
  };
};

// One issues page, parsed at the Linear boundary. Null when the answer
// is not an issues page (a query-level error included — said as the
// read's failure), and when the page claims more without carrying a
// cursor to walk with: a walk the answer leaves un pageable is a drift
// the pass cannot serve, not a list end. A node that fails to name
// itself is left out of the page and counted in `dropped` — the
// caller holds its window for the drop. The `served` count is the raw
// node count the answer carried; `dropped` is what the boundary could
// not name.
function parseIssuePage(answer: unknown): {
  rows: ParsedIssue[];
  served: number;
  dropped: number;
  more: boolean;
  endCursor?: string;
} | null {
  const parsed = ZAnswer.safeParse(answer);
  if (!parsed.success) return null;
  if (parsed.data.errors && parsed.data.errors.length > 0) return null;
  const issues = parsed.data.data?.issues;
  if (!issues) return null;
  const rows: ParsedIssue[] = [];
  let dropped = 0;
  for (const raw of issues.nodes) {
    const issue = parseIssueNode(raw);
    if (issue) rows.push(issue);
    else dropped += 1;
  }
  const hasNext = issues.pageInfo.hasNextPage === true;
  const endCursor = issues.pageInfo.endCursor;
  if (hasNext && typeof endCursor !== "string") return null;
  return {
    rows,
    served: issues.nodes.length,
    dropped,
    more: hasNext,
    ...(typeof endCursor === "string" ? { endCursor } : {}),
  };
}

// One wake, classified from a changed issue: a comment wake (one per
// new comment, the comment's id the once-only marker) or the issue's
// own change wake (the bump's moment the marker). `alsoMark` carries
// the change marker a comment wake spends alongside its own, so the
// same bump never wakes twice.
type ParsedWake = {
  kind: "comment" | "change";
  id: string;
  issue: ParsedIssue;
  comment?: ParsedComment;
  alsoMark: string[];
};

/**
 * The wake candidates from one read: the issues the read served,
 * filtered again after the read against the same `since` the wire
 * asked for (the temporal filter is never leaned on the wire alone —
 * the PagerDuty statuses[] rule), then classified per issue. The
 * candidates carry no delivered-marker filter — the settle loop owns
 * at-most-once, and a spent id must stay a candidate so a wake whose
 * write failed can still be found and its owed mail delivered. A
 * comment newer than the cursor is the bump: one candidate per
 * comment id, each carrying the bump's change marker in alsoMark, so
 * the bump mails once. The ticket's own change candidate rides behind
 * them and skips once that marker is spent — and wakes by itself when
 * no comment accounts for the bump (a spent comment's edit, a plain
 * edit, a state move). A window that comes back full of fresh
 * comments — at least the read's whole window — may carry more the
 * read did not serve, so it collapses to the single change candidate
 * carrying every fresh id in alsoMark: the change is said once, and
 * no comment the window could not carry is lost silently.
 */
export const classifyWakes = (
  issues: ParsedIssue[],
  sinceMs: number,
): ParsedWake[] => {
  const wakes: ParsedWake[] = [];
  for (const issue of issues) {
    const bumpedAt = Date.parse(issue.updatedAt);
    if (!Number.isFinite(bumpedAt) || bumpedAt < sinceMs) continue;
    const changeId = `${issue.id}:${issue.updatedAt}`;
    const freshByTime: ParsedComment[] = [];
    for (const comment of issue.comments) {
      const at = Date.parse(comment.createdAt);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      freshByTime.push(comment);
    }
    if (freshByTime.length >= LN_COMMENTS_PER_ISSUE) {
      wakes.push({
        kind: "change",
        id: changeId,
        issue,
        alsoMark: freshByTime.map((comment) => comment.id),
      });
      continue;
    }
    for (const comment of freshByTime) {
      wakes.push({
        kind: "comment",
        id: comment.id,
        issue,
        comment,
        alsoMark: [changeId],
      });
    }
    wakes.push({ kind: "change", id: changeId, issue, alsoMark: [] });
  }
  return wakes;
};

// The change wake: one per bumped issue, carried by the ticket's own
// words — its identifier, its current state, its title, its url, the
// bump's moment. A wake is a prompt, not a diff: the woken session
// fetches the ticket's content when it acts.
function changeMail(
  entry: LinearProjectEntry,
  rowId: string,
  wake: ParsedWake,
): string {
  const issue = wake.issue;
  const lines = [
    "Linear mail — ticket change",
    `watch ${rowId} — linear ${entry.project}${
      entry.note ? ` — ${entry.note}` : ""
    }`,
    "",
    `${issue.identifier} — changed`,
  ];
  if (issue.stateName) lines.push(`state ${issue.stateName}`);
  if (issue.title) lines.push(`title ${issue.title}`);
  if (issue.url) lines.push(`url ${issue.url}`);
  lines.push(`updated at ${issue.updatedAt}`);
  return mailEnvelope(lines);
}

// The comment wake: one per new comment id, carried by the ticket it
// landed on and the comment's author and moment. The comment's body
// never rides the mail — the woken session reads it in Linear.
function commentMail(
  entry: LinearProjectEntry,
  rowId: string,
  wake: ParsedWake,
): string {
  const issue = wake.issue;
  const comment = wake.comment!;
  const lines = [
    "Linear mail — ticket comment",
    `watch ${rowId} — linear ${entry.project}${
      entry.note ? ` — ${entry.note}` : ""
    }`,
    "",
    `${issue.identifier} — comment ${comment.id}`,
  ];
  if (comment.author)
    lines.push(`by ${comment.author} at ${comment.createdAt}`);
  else lines.push(`at ${comment.createdAt}`);
  if (issue.url) lines.push(`url ${issue.url}`);
  return mailEnvelope(lines);
}

export class LinearSource {
  /**
   * The Linear side of the watcher config. Null — the source off —
   * when the plugins entry carries no linear block at all (the source
   * is opt-in; the absence is silent), and when the block is present
   * but unusable (each case named on its line). Malformed project
   * entries are dropped individually with their named line; the source
   * runs on what survives.
   */
  static readConfig(ctx: unknown): LinearConfig | null {
    const options = isRecord(ctx) && isRecord(ctx.options) ? ctx.options : {};
    const watcher = isRecord(options.watcher) ? options.watcher : {};
    const block = isRecord(watcher.linear) ? watcher.linear : null;
    if (!block) return null;

    const env = typeof process === "object" ? process.env : {};
    const rawToken = block.token ?? env.LINEAR_TOKEN;
    if (
      typeof rawToken !== "string" ||
      rawToken.trim() === "" ||
      rawToken.trim() === "null"
    ) {
      console.error(
        "[forgejo-watcher] the linear source is off: no api token — set options.watcher.linear.token on the watcher's plugins entry, or LINEAR_TOKEN in the host's environment",
      );
      return null;
    }

    const rawUrl = block.url ?? env.LINEAR_API_URL ?? LN_DEFAULT_URL;
    let url: string;
    try {
      const parsed = new URL(String(rawUrl).trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("not http(s)");
      }
      // A query or a fragment is never the api's base: the client posts
      // to ${base}/graphql, so one riding in would be silently dropped
      // here — a misconfiguration that reads as configured. The source
      // is off instead, said on its line — and the url is not echoed,
      // because its query is exactly the part that must never log.
      if (parsed.search || parsed.hash) {
        console.error(
          `[forgejo-watcher] the linear source is off: url must be the Linear api's http(s) base without a query or a fragment (got ${parsed.origin}${parsed.pathname} plus a query or fragment)`,
        );
        return null;
      }
      url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      console.error(
        `[forgejo-watcher] the linear source is off: url must be the Linear api's http(s) base (got ${JSON.stringify(rawUrl)})`,
      );
      return null;
    }

    const projects: LinearProjectEntry[] = [];
    const watched = new Set<string>();
    const rawProjects = Array.isArray(block.projects) ? block.projects : [];
    for (const raw of rawProjects) {
      const project =
        isRecord(raw) && typeof raw.project === "string"
          ? raw.project.trim()
          : "";
      const wake =
        isRecord(raw) && typeof raw.wake === "string" ? raw.wake.trim() : "";
      const note =
        isRecord(raw) && typeof raw.note === "string" ? raw.note.trim() : "";
      if (!project || !wake) {
        console.error(
          "[forgejo-watcher] a linear projects entry is dropped: its project (the Linear project's id) and wake (the director session to wake) must both be non-empty strings",
        );
        continue;
      }
      if (watched.has(project)) {
        console.error(
          `[forgejo-watcher] the linear project ${project} is watched twice; the later entry is dropped`,
        );
        continue;
      }
      watched.add(project);
      projects.push({
        project,
        wake,
        ...(note ? { note: note.slice(0, 200) } : {}),
      });
    }
    if (projects.length === 0) {
      console.error(
        "[forgejo-watcher] the linear source is off: no watchable projects under options.watcher.linear.projects — each entry needs the Linear project's id (project) and the session to wake (wake)",
      );
      return null;
    }
    return { token: rawToken.trim(), url, projects };
  }

  config: LinearConfig;
  ctx: SourceContext;
  debug: Debug;
  patchStamps: PatchStamps;
  readStamps: ReadStamps;
  isStopped: () => boolean;
  failedWrites: Set<string>;
  client: ReturnType<typeof linearClient>;
  /** The leg's pass budget: the module constant unless a test set one. */
  legBudgetMs: number;
  /** The cursor's skew margin: the module constant unless a test set one. */
  skewMs: number;
  // In-memory only; the delivered markers and the cursor live on the
  // target's stamp. `held` reseeds from the stamp every pass, so it can
  // never drift across passes; within a pass it keeps an
  // already-settled id from a second stamp walk.
  held: Map<string, { seen: Set<string>; gone: boolean }>;
  // One read-failure line per project, logged when it changes and
  // cleared when the project reads again (the projection's noteSync
  // pattern). The page cap rides the same memo — it repeats, so it must
  // not repeat aloud.
  lastWhy: Map<string, string>;
  // One claims-row fault line per project (an unusable cursor), logged
  // when it changes and cleared when the row reads healthy again — a
  // fault the pass cannot heal itself must not repeat aloud forever.
  lastFault: Map<string, string>;

  /**
   * @param deps — the stamp machinery is the watcher's own (patchStamps,
   *   readStamps, failedWrites, the stopped flag), passed in, not
   *   forked.
   */
  constructor(deps: LinearSourceDeps) {
    this.config = deps.config;
    this.ctx = deps.ctx;
    this.debug = deps.debug;
    this.patchStamps = deps.patchStamps;
    this.readStamps = deps.readStamps;
    this.isStopped = deps.isStopped;
    this.failedWrites = deps.failedWrites;
    this.legBudgetMs = deps.legBudgetMs ?? LN_LEG_BUDGET_MS;
    this.skewMs = deps.skewMs ?? LN_SKEW_MS;
    this.client = linearClient(deps.config);
    this.held = new Map();
    this.lastWhy = new Map();
    this.lastFault = new Map();
  }

  /** The claims row's stamp id for one watched project. */
  rowIdOf(entry: LinearProjectEntry): string {
    return `lin-${entry.project}`;
  }

  /** The budget as the log lines name it. */
  get budgetLabel(): string {
    return this.legBudgetMs >= 1000
      ? `${Math.round(this.legBudgetMs / 1000)}s`
      : `${this.legBudgetMs}ms`;
  }

  noteWhy(project: string, why: string): void {
    if (!why) {
      this.lastWhy.delete(project);
      return;
    }
    if (this.lastWhy.get(project) !== why) {
      this.lastWhy.set(project, why);
      console.error(
        `[forgejo-watcher] the linear read for project ${project} keeps its pass: ${why}`,
      );
    }
  }

  // The claims-row fault's named line, logged when it changes and
  // cleared when the row reads healthy again (the read failures' own
  // memo pattern).
  noteFault(project: string, why: string): void {
    if (!why) {
      this.lastFault.delete(project);
      return;
    }
    if (this.lastFault.get(project) !== why) {
      this.lastFault.set(project, why);
      console.error(
        `[forgejo-watcher] the linear claims row for project ${project} keeps its pass: ${why}`,
      );
    }
  }

  /**
   * The changed-issues read: the project filter and the temporal filter
   * ride the wire as variables (the cursor's since), the walk pages on
   * the answer's own endCursor until hasNextPage says the list ended,
   * and the page cap bounds a walk that never ends. The leg's pass
   * deadline bounds the walk's time: a check before each page read
   * stops the walk and says so — the pages it did read still settle.
   * The walk is complete when it ended at the api's own end AND every
   * page named all its nodes; a drop marks the walk incomplete, and
   * the window is re-read whole next pass. Null when a page does not
   * parse at the boundary.
   */
  async readIssues(
    project: string,
    since: string,
    deadline: number,
  ): Promise<{
    rows: ParsedIssue[];
    complete: boolean;
    budgetSpent: boolean;
    dropped: number;
  } | null> {
    const rows: ParsedIssue[] = [];
    let dropped = 0;
    let after: string | undefined;
    for (let page = 0; page < LN_ISSUE_PAGES; page += 1) {
      if (Date.now() >= deadline) {
        return { rows, complete: false, budgetSpent: true, dropped };
      }
      const answer = await this.client.post(ISSUES_QUERY, {
        filter: {
          project: { id: { eq: project } },
          updatedAt: { gte: since },
        },
        first: LN_ISSUES_PER_READ,
        ...(after !== undefined ? { after } : {}),
      });
      const parsed = parseIssuePage(answer);
      if (parsed === null) return null;
      rows.push(...parsed.rows);
      dropped += parsed.dropped;
      // The walk's end: hasNextPage saying the list ended, or an empty
      // page — a pager that claims more past nothing is not walked
      // further.
      if (!parsed.more || parsed.served === 0) {
        return { rows, complete: dropped === 0, budgetSpent: false, dropped };
      }
      after = parsed.endCursor;
    }
    return { rows, complete: false, budgetSpent: false, dropped };
  }

  /**
   * The claims row: found on the target's stamp, or stamped fresh. The
   * fast path is a bare read — a pass that finds the row writes nothing.
   * The row's `since` is the temporal filter's cursor: stamped at
   * creation (the registration moment — the whole pre-registration
   * history sits behind it), ratcheted forward by a complete read, and
   * never backward. Returns the row's claims, `false` when a stamp
   * write failed this pass or the row's cursor does not parse (the
   * fault said on its named line), or `undefined` when the target
   * session is gone (nothing delivered nowhere).
   */
  async ensureRow(entry: LinearProjectEntry): Promise<
    | {
        id: string;
        since: string;
        sinceMs: number;
        delivered: Record<string, boolean>;
      }
    | false
    | undefined
  > {
    const id = this.rowIdOf(entry);
    const rows = await this.readStamps(this.ctx, this.debug, entry.wake);
    if (rows === undefined) return undefined;
    const found = (rows ?? []).find(
      (candidate) => candidate?.id === id && candidate?.kind === LN_KIND,
    );
    if (found) {
      const raw = typeof found.since === "string" ? found.since.trim() : "";
      if (!raw) {
        // A row without a cursor: the temporal filter has no floor, so
        // the row re-bases to the read moment — once, persisted, and
        // said on its line, because the changes before the re-base are
        // not woken and that loss is the policy's cost, not a silent
        // one. (A row should never arrive here: registration stamps the
        // cursor, so a missing one is stamp damage.)
        const now = new Date().toISOString();
        console.error(
          `[forgejo-watcher] the linear claims row ${id} on ${entry.wake} carries no cursor; it re-bases to the read moment and the changes before it are not woken`,
        );
        await this.patchStamps(
          this.ctx,
          this.debug,
          entry.wake,
          (freshRows) => {
            const row = freshRows.find(
              (candidate) =>
                candidate?.id === id && candidate?.kind === LN_KIND,
            );
            if (!row) return null;
            const current =
              typeof row.since === "string" ? row.since.trim() : "";
            if (current) return null;
            row.since = now;
            return freshRows;
          },
        );
        this.noteFault(entry.project, "");
        return { id, since: now, sinceMs: Date.parse(now), delivered: {} };
      }
      const sinceMs = Date.parse(raw);
      if (!Number.isFinite(sinceMs)) {
        // A cursor that does not parse: the pass cannot serve the
        // filter, and silently re-basing it would skip un-woken changes
        // — the fault is named instead, once per state change, and the
        // pass keeps its window (nothing reads, nothing wakes) until
        // the row's cursor is repaired.
        this.noteFault(
          entry.project,
          `the claims row's cursor (${JSON.stringify(found.since)}) does not parse as a timestamp`,
        );
        return false;
      }
      this.noteFault(entry.project, "");
      return {
        id,
        since: raw,
        sinceMs,
        delivered: isRecord(found.delivered)
          ? ({ ...found.delivered } as Record<string, boolean>)
          : {},
      };
    }
    // The registration: the cursor stamps the moment the watch comes
    // into being. Everything changed before it is the backlog this
    // source exists not to replay.
    const now = new Date().toISOString();
    const next = await this.patchStamps(
      this.ctx,
      this.debug,
      entry.wake,
      (copies) => {
        if (
          copies.some(
            (candidate) => candidate?.id === id && candidate?.kind === LN_KIND,
          )
        ) {
          return copies;
        }
        copies.push({
          id,
          session: entry.wake,
          kind: LN_KIND,
          ref: entry.project,
          ...(entry.note ? { note: entry.note } : {}),
          since: now,
          delivered: {},
          markedAt: {},
        });
        return copies;
      },
    );
    if (next === false || next === undefined) return next;
    return { id, since: now, sinceMs: Date.parse(now), delivered: {} };
  }

  /**
   * Mark first, deliver second — the family's discipline, pointed at
   * the config-mapped target. A comment wake spends the bump's change
   * marker alongside its own id, so the same bump never wakes twice.
   */
  async settleWake(
    entry: LinearProjectEntry,
    wake: ParsedWake,
  ): Promise<"seen" | "retry" | "gone"> {
    if (this.isStopped()) return "gone";
    const id = this.rowIdOf(entry);
    const attempt = `${id} ${wake.id}`;
    const mail =
      wake.kind === "comment"
        ? commentMail(entry, id, wake)
        : changeMail(entry, id, wake);
    let spent = false;
    const next = await this.patchStamps(
      this.ctx,
      this.debug,
      entry.wake,
      (rows) => {
        const row = rows.find(
          (candidate) => candidate?.id === id && candidate?.kind === LN_KIND,
        );
        if (!row) return null;
        const delivered = isRecord(row.delivered)
          ? ({ ...row.delivered } as Record<string, boolean>)
          : {};
        if (delivered[wake.id]) {
          if (this.failedWrites.has(attempt)) return rows;
          spent = true;
          return null;
        }
        const markedAt = isRecord(row.markedAt)
          ? ({ ...row.markedAt } as Record<string, string>)
          : {};
        const now = new Date().toISOString();
        delivered[wake.id] = true;
        markedAt[wake.id] = now;
        for (const also of wake.alsoMark) {
          if (!delivered[also]) {
            delivered[also] = true;
            markedAt[also] = now;
          }
        }
        row.delivered = delivered;
        row.markedAt = markedAt;
        return rows;
      },
    );
    if (spent) {
      this.debug("ticket.already", {
        project: entry.project,
        [wake.kind]: wake.id,
      });
      return "seen";
    }
    if (next === null) {
      this.debug("ticket.unstamped", {
        project: entry.project,
        [wake.kind]: wake.id,
      });
      return "gone";
    }
    if (next === undefined) return "gone";
    if (next === false) {
      this.failedWrites.add(attempt);
      return "retry";
    }
    this.failedWrites.delete(attempt);
    try {
      await this.ctx.session.synthetic({
        sessionID: entry.wake,
        text: mail,
      });
      // The delivered op only ever names a delivery that did not throw
      // (a failed one logs its own op below the error, so a debug trace
      // never reads a missed wake as landed).
      this.debug("ticket.delivered", {
        project: entry.project,
        [wake.kind]: wake.id,
      });
    } catch (error) {
      console.error(
        `[forgejo-watcher] mail delivery to ${entry.wake} failed: ${error}`,
      );
      this.debug("ticket.undelivered", {
        project: entry.project,
        [wake.kind]: wake.id,
        error: String(error),
      });
    }
    return "seen";
  }

  async pollProject(
    entry: LinearProjectEntry,
    deadline: number,
  ): Promise<void> {
    if (this.isStopped()) return;
    const id = this.rowIdOf(entry);
    let mine = this.held.get(entry.project);
    if (!mine) {
      mine = { seen: new Set<string>(), gone: false };
      this.held.set(entry.project, mine);
    }

    // The claims row first: a gone target costs the pass nothing
    // further, and the row's claims seed this pass's skip set and its
    // temporal filter.
    const ensured = await this.ensureRow(entry);
    if (ensured === undefined) {
      if (!mine.gone) {
        mine.gone = true;
        console.error(
          `[forgejo-watcher] the linear wake target ${entry.wake} for project ${entry.project} is not a live session; nothing is delivered to it while it is gone`,
        );
      }
      return;
    }
    if (mine.gone) {
      mine.gone = false;
      this.debug("linear.target.back", { project: entry.project });
    }
    // A false ensure has already said why on its own line (the stamp
    // machinery logged a failed write, or the row's cursor fault logged
    // its named line): the pass ends here on the strength of that line.
    if (ensured === false) return;
    mine.seen = new Set(Object.keys(ensured.delivered ?? {}));

    let read: {
      rows: ParsedIssue[];
      complete: boolean;
      budgetSpent: boolean;
      dropped: number;
    } | null = null;
    let why = "";
    const readStart = Date.now();
    try {
      read = await this.readIssues(entry.project, ensured.since, deadline);
    } catch (error) {
      why = `the issues read failed: ${(error as Error)?.message ?? error}`;
    }
    if (!why && read === null) {
      why = "the issues answer did not parse as an issues page";
    }
    if (!why && read !== null && read.budgetSpent) {
      why = `the linear leg ran out its ${this.budgetLabel} pass budget; the walk reads no further this pass`;
    }
    // A window the walk could not name whole (nodes the boundary
    // dropped) is an incomplete read: the next pass re-reads it whole,
    // so nothing the boundary could not name is lost.
    if (
      !why &&
      read !== null &&
      !read.complete &&
      !read.budgetSpent &&
      read.dropped > 0
    ) {
      why = `the changed-issues answer left ${read.dropped} nodes it could not name; the window is re-read whole next pass`;
    }
    // A page-capped walk is an incomplete window: the next pass
    // re-reads it whole (the cursor holds — the trade is the page cap's
    // own comment), and the set it served still wakes this pass.
    if (!why && read !== null && !read.complete && !read.budgetSpent) {
      why = `the changed issues ran past ${LN_ISSUE_PAGES} pages of ${LN_ISSUES_PER_READ}; the window is re-read whole next pass`;
    }
    this.noteWhy(entry.project, why);
    // An incomplete read holds the cursor; the pass it stopped short of
    // is re-read whole next pass. What the walk served before it
    // stopped — the budget's pages, the cap's pages, the nodes the
    // boundary did name — still settles, so the wake set stays the
    // read's and the bound defers nothing it read. The unreadable
    // answer is the one shape that settles nothing: there is no set to
    // settle.
    if (why && !(read !== null && !read.complete)) return;
    if (read === null) return;

    const wakes = classifyWakes(read.rows, ensured.sinceMs);
    let retrying = false;
    let deferred = false;
    // The settle tail's deadline (LN_SETTLE_BUDGET_MS): a wake the
    // deadline reaches is left unmarked for the next pass — the cursor
    // holds, so the deferral loses nothing and double-wakes nothing.
    const settleDeadline = Date.now() + LN_SETTLE_BUDGET_MS;
    for (let index = 0; index < wakes.length; index += 1) {
      const wake = wakes[index];
      if (this.isStopped()) break;
      if (Date.now() >= settleDeadline) {
        deferred = true;
        this.debug("ticket.deferred", {
          project: entry.project,
          settled: index,
          rest: wakes.length - index,
        });
        break;
      }
      const attempt = `${id} ${wake.id}`;
      // A spent marker skips its wake — unless this instance's own
      // failed write still owes that id its mail: the marker then
      // persisted under a failed-reported write, and only the settle
      // below delivers the owed mail.
      if (mine.seen.has(wake.id) && !this.failedWrites.has(attempt)) {
        continue;
      }
      const outcome = await this.settleWake(entry, wake);
      if (outcome === "seen") mine.seen.add(wake.id);
      if (outcome === "retry") retrying = true;
      // "gone": the target or the claims row left mid-pass — the next
      // pass's ensure says what it can and re-ensures.
    }
    // A settle that failed write-wise, and a tail the deadline deferred,
    // hold the advance: the next pass re-reads the window that still
    // owes mail or wakes.
    if (retrying || deferred) return;

    // The complete read ratchets the cursor: forward to the read's own
    // start moment minus the skew margin, never backward (the ratchet's
    // floor is the registration moment the row stamped first, which no
    // forward-only ratchet can cross). An incomplete read (the budget,
    // the page cap, a dropped node) advances nothing — the api's
    // ordering direction is not documented, so the served set is never
    // assumed to precede the unserved tail.
    if (!read.complete) return;
    const candidate = readStart - this.skewMs;
    if (candidate <= ensured.sinceMs) return;
    const since = new Date(candidate).toISOString();
    const advanced = await this.patchStamps(
      this.ctx,
      this.debug,
      entry.wake,
      (freshRows) => {
        const row = freshRows.find(
          (row) => row?.id === id && row?.kind === LN_KIND,
        );
        if (!row) return null;
        const current = Date.parse(
          typeof row.since === "string" && row.since.trim()
            ? row.since
            : new Date(0).toISOString(),
        );
        if (Number.isFinite(current) && current >= candidate) {
          // Another writer advanced it already, or ahead of this
          // candidate: the stamp is ahead, nothing to write.
          return null;
        }
        row.since = since;
        return freshRows;
      },
    );
    if (advanced === false || advanced === undefined) {
      this.debug("linear.cursor.held", { project: entry.project });
    }
  }

  /**
   * The pass: each configured project's claims row ensured on the
   * target's stamp, its changed issues read under the row's cursor, and
   * every wake the claims have not seen settled once. The leg's budget
   * spans the pass: a project the budget cannot reach anymore reads
   * next pass, named on the same memo line the read failures carry. One
   * project's failure says and moves on; the rest of the projects still
   * poll this pass.
   */
  async poll(): Promise<void> {
    const deadline = Date.now() + this.legBudgetMs;
    for (const entry of this.config.projects) {
      if (this.isStopped()) break;
      if (Date.now() >= deadline) {
        this.noteWhy(
          entry.project,
          `the linear leg ran out its ${this.budgetLabel} pass budget; the project reads next pass`,
        );
        continue;
      }
      try {
        await this.pollProject(entry, deadline);
      } catch (error) {
        console.error(
          `[forgejo-watcher] the linear pass for project ${entry.project} failed: ${error}`,
        );
      }
    }
  }
}
