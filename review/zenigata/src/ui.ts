/**
 * The status page renderer. /status serves the JSON machine contract;
 * this renders the human page at / from the same snapshot — one static
 * HTML page: no scripts, no stylesheets, no assets the page would have
 * to fetch. The markup and the one CSS block ship in this module.
 *
 * Two inputs arrive outside the JSON payload: the route's
 * adapter-reachability probe result, and the runs table's wall time —
 * derived at the projection read from the settled rows' own stamps
 * (the RunWallView extension). A third arrives beside them: the live
 * sessions' started moments — the ledger's first stage-entry stamps
 * (the SessionStartView extension), the raw data the running duration
 * renders from. A fourth rides with them: the forge's base URL, the
 * config's ZENIGATA_FORGE_URL, which the PR cells render their links
 * with. A fifth rides with all of them: a failed run's failed drafts —
 * the journaled attempts the projection stored on the run's row
 * (the RunDraftsView extension), rendered in the failure cell. The
 * machine contract's shape is pinned, so all of these render at / and
 * nowhere else (the reason is named in the deployment doc and in the PR
 * body).
 *
 * Escaping discipline: table and list cells compose small amounts of
 * markup (chips, muted spans), so every raw field is routed through esc()
 * at the moment it enters a cell. A cell is only ever markup this module
 * wrote plus escaped leaves — the page cannot become the one place a
 * string sneaks through.
 */

export interface UptimeInfo {
  /** Process start, ISO 8601. */
  startedAt: string;
  uptimeSeconds: number;
  /** The port the intake actually bound (the OS resolves a 0 config). */
  listenPort: number;
  /** The configured adapter URL, userinfo and query tokens stripped. */
  adapterUrl: string;
}

export interface SessionView {
  eventId: string;
  repo: string;
  pr: number;
  eventKind: string;
  requester: string;
  commentId: string;
  /** The pipeline stage the run last reported ("queued" before dispatch). */
  stage: string;
  /** The journaled start's moment — the accepted moment it carried, ISO 8601. */
  acceptedAt: string;
  /** The accept moment or the last stage report, ISO 8601. */
  lastActivityAt: string;
}

/**
 * The page's live-session row: the JSON contract's session extended with
 * the moment the run left the queue — the ledger's first stage-entry
 * stamp — from which the page derives the running duration.
 * Server-internal render data — passed to renderStatusPage, never
 * serialized into /status (the RunWallView pattern).
 */
export interface SessionStartView extends SessionView {
  /**
   * The first stage entry's stamp, epoch milliseconds. Undefined only
   * while the row has never left "queued" — the parked rows; a running
   * row carries it by the ledger's own rule.
   */
  startedAtMs: number | undefined;
}

export interface DroppedStartView {
  eventId: string;
  repo: string;
  pr: number;
  eventKind: string;
  /** The journaled start's moment, ISO 8601. */
  acceptedAt: string;
}

export interface RunView {
  ts: string;
  repo: string;
  pr: number;
  outcome: string;
  verdict: string | null;
  phases: Array<{ phase: string; durationMs: number }>;
  failure?: { stage: string; message: string };
}

/**
 * The page's run row: the JSON contract's run extended with the run's
 * wall time, derived at the projection read. Server-internal render
 * data — passed to renderStatusPage, never serialized into /status.
 */
export interface RunWallView extends RunView {
  /**
   * Finished minus started, in seconds, on the row's own stamps. Null
   * only when a settled row carries no finish stamp, or its stamps do
   * not parse as time — states the projection's settlement rules rule
   * out; the read names either on the log and the page renders no wall
   * time for the run.
   */
  wallSeconds: number | null;
}

/**
 * One failed attempt a failed run journaled (PRJ-381's FailedDraft),
 * read for the human page's failed report (PRJ-423). The reply is the
 * capped raw model output exactly as the journal carried it — the
 * 64KiB cap and its truncation marker ride through unchanged — and
 * `truncated` says the marker is present, so the page labels the draft
 * instead of leaving the cap to be discovered.
 */
export interface FailedDraftView {
  /** The stage whose validation refused the attempt. */
  stage: string;
  /** Zero-based attempt number within the stage's own loop. */
  attempt: number;
  /** The parse-boundary refusal when validation died before the payload checks. */
  parseError?: string;
  /** The capped raw reply, as-is. */
  reply: string;
  /** True when the reply carries the journal's truncation marker. */
  truncated: boolean;
}

/**
 * The page's run row: the wall-time extension above, further extended
 * with the failed run's failed drafts, read from the projection row the
 * terminal record wrote. Undefined for every run that did not end
 * failed — failed attempts on runs that eventually posted or aborted
 * stay journal-only. Server-internal render data — passed to
 * renderStatusPage, never serialized into /status.
 */
export interface RunDraftsView extends RunWallView {
  failedDrafts?: FailedDraftView[];
}

export interface StatusConfig {
  /** The configured listen port (0 = the OS picks one). */
  listenPort: number;
  allowedLogins: number;
  allowedRepos: number;
  retryPolicy: string;
  reviewTimeoutSeconds: number;
  turnPollSeconds: number;
  turnBudgetSeconds: number;
  agent: string;
}

export interface StatusData {
  uptime: UptimeInfo;
  sessions: SessionView[];
  droppedStarts: { count: number; starts: DroppedStartView[] };
  runs: RunView[];
  config: StatusConfig;
}

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Time rendered for a person
// ---------------------------------------------------------------------------

/** A span of time in human words: "40ms", "3.2s", "2m 5s", "3h 12m", "4d 3h". */
const duration = (seconds: number): string => {
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < 60) {
    return seconds < 10
      ? `${seconds.toFixed(1).replace(/\.0$/, "")}s`
      : `${Math.floor(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.floor(seconds % 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  return hours % 24 === 0
    ? `${Math.floor(hours / 24)}d`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** A pipeline phase's duration: milliseconds under a second, human above. */
const phase = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : duration(ms / 1000);

/** How long ago an ISO moment was, as of the render. Title keeps the ISO. */
const age = (iso: string, nowMs: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0
      ? `${hours}h ago`
      : `${hours}h ${minutes % 60}m ago`;
  }
  return hours % 24 === 0
    ? `${Math.floor(hours / 24)}d ago`
    : `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
};

const stamped = (iso: string, nowMs: number): string =>
  `<span class="muted" title="${esc(iso)}">${esc(age(iso, nowMs))}</span>`;

// ---------------------------------------------------------------------------
// Semantic chips
// ---------------------------------------------------------------------------

/**
 * Green is running and healthy, amber is parked or waiting, red is stopped
 * or down, gray is settled and neutral. The word on the chip carries the
 * meaning; the color only speeds the glance.
 */
type Tone = "ok" | "warn" | "bad" | "mute";

const chip = (text: string, tone: Tone): string =>
  `<span class="chip ${tone}">${esc(text)}</span>`;

/**
 * The running chip's word: the state, and the run's age — how long since
 * the row left the queue — when the ledger holds the stamp for it. With
 * no started stamp the chip names the state alone; nothing renders that
 * the ledger does not hold.
 */
const runningChip = (session: SessionStartView, nowMs: number): string =>
  session.startedAtMs === undefined
    ? "running"
    : `running ${duration(Math.max(0, (nowMs - session.startedAtMs) / 1000))}`;

/** The state cell of a live session: parked behind the limiter, or running. */
const sessionState = (session: SessionStartView, nowMs: number): string =>
  session.stage === "queued"
    ? `${chip("parked", "warn")} <span class="muted small">waiting for a free review slot</span>`
    : `${chip(runningChip(session, nowMs), "ok")} <span class="muted small">${esc(session.stage)}</span>`;

// ---------------------------------------------------------------------------
// Forge links
// ---------------------------------------------------------------------------

/**
 * The forge URL of one pull request: the repo string is the forge path —
 * "example/repo" maps to `{forgeUrl}/example/repo/pulls/{pr}` — with
 * each path segment URI-encoded so a stray repo string cannot escape the
 * path, and a bare name (no owner), `.`/`..`, or empty segments refused
 * for the same reason — none of them has a forge PR page. An undefined
 * answer leaves the caller no URL: it renders the plain-text identity
 * instead. Exported for the tests.
 */
export const forgePullUrl = (
  repo: string,
  pr: number,
  forgeUrl: string,
): string | undefined => {
  const segments = repo.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  const base = forgeUrl.replace(/\/+$/, "");
  return `${base}/${segments.map(encodeURIComponent).join("/")}/pulls/${pr}`;
};

/**
 * A pull request cell: the identity linked into the forge, and — when
 * affordance is set — a second anchor on the same forge PR page. The
 * affordance is deliberately a link, not an intake mutation: the intake
 * is internet-exposed (zenigata.example.com proxies it), so a mutation with
 * no auth story is the wrong shape — one-click-from-the-page comes later
 * with a designed token story. On the forge's PR page, re-requesting the
 * review is the forge's own control, and the re-request rides the same
 * webhook path as today's starts (each a fresh delivery id — the retry
 * contract is untouched).
 */
const pullCell = (
  repo: string,
  pr: number,
  forgeUrl: string,
  affordance?: string,
): string => {
  const url = forgePullUrl(repo, pr, forgeUrl);
  const identity = `${esc(repo)}#${pr}`;
  if (url === undefined) {
    return `<strong>${identity}</strong>`;
  }
  const link = `<strong><a href="${esc(url)}">${identity}</a></strong>`;
  return affordance === undefined
    ? link
    : `${link}<br><span class="muted small"><a href="${esc(url)}">${esc(affordance)}</a></span>`;
};

/** The verdict chip a settled run earns. Color follows the outcome. */
const runResult = (run: RunView): string => {
  switch (run.outcome) {
    case "posted":
      return chip(run.verdict ?? "posted", "ok");
    case "aborted":
      return chip("aborted", "warn");
    case "skipped":
      return chip("skipped", "mute");
    default:
      return chip("failed", "bad");
  }
};

// ---------------------------------------------------------------------------
// The failed report
// ---------------------------------------------------------------------------

/**
 * One failed attempt's readable block (PRJ-423): the stage, the attempt
 * number, the parse-boundary refusal when one exists, and the capped
 * raw reply as-is. The reply is model output — every leaf routes
 * through esc() at the moment it enters the block, so a draft carrying
 * markup renders as text. The page acts on nothing here: viewing only.
 */
const failedDraft = (draft: FailedDraftView): string => {
  const truncatedLabel = draft.truncated ? ` ${chip("truncated", "warn")}` : "";
  const refusal =
    draft.parseError === undefined
      ? ""
      : `<div class="draft-refusal">${esc(draft.parseError)}</div>`;
  return `<div class="draft"><div class="draft-head">${chip(
    draft.stage,
    "mute",
  )}<span class="muted small">attempt ${draft.attempt}</span>${truncatedLabel}</div>${refusal}<pre class="draft-reply">${esc(
    draft.reply,
  )}</pre></div>`;
};

/**
 * A failed run's failed report: one block per failed attempt the run
 * journaled, appended to the failure cell beneath the failure message.
 * Empty for every run that carries no failed drafts — the clean runs'
 * failure cell renders exactly as it did before this view existed.
 */
const failedReport = (run: RunDraftsView): string =>
  run.failedDrafts === undefined
    ? ""
    : run.failedDrafts.map(failedDraft).join("");

// ---------------------------------------------------------------------------
// One table renderer
// ---------------------------------------------------------------------------

/**
 * One column: its header label and the cell markup it renders for a row.
 * Cells carry markup; every raw leaf is esc()ed where it enters the cell
 * (top of file).
 */
interface Column<Row> {
  label: string;
  cell: (row: Row) => string;
}

const table = <Row>(columns: Array<Column<Row>>, rows: Row[]): string => `
  <table>
    <thead><tr>${columns
      .map((column) => `<th>${esc(column.label)}</th>`)
      .join("")}</tr></thead>
    <tbody>${
      rows.length === 0
        ? `<tr><td colspan="${columns.length}" class="muted">none</td></tr>`
        : rows
            .map(
              (row) =>
                `<tr>${columns
                  .map((column) => `<td>${column.cell(row)}</td>`)
                  .join("")}</tr>`,
            )
            .join("")
    }</tbody>
  </table>`;

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const configList = (config: StatusConfig, forgeUrl: string): string => {
  const rows: Array<[string, string]> = [
    [
      "configured listen port",
      config.listenPort === 0
        ? "0 (the OS picks the port)"
        : String(config.listenPort),
    ],
    ["allowed logins", String(config.allowedLogins)],
    [
      "allowed repositories",
      config.allowedRepos === 0
        ? "no allowlist (every repository)"
        : String(config.allowedRepos),
    ],
    ["retry policy", config.retryPolicy],
    ["review timeout", duration(config.reviewTimeoutSeconds)],
    ["turn poll", `${config.turnPollSeconds}s`],
    ["turn budget", duration(config.turnBudgetSeconds)],
    ["agent", config.agent],
    // The forge URL is not a secret — it shows plainly, like the
    // adapter's URL on the health line.
    ["forge", forgeUrl],
  ];
  return `<dl class="grid">${rows
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    .join("")}</dl>`;
};

/**
 * The page renderer's inputs: the JSON snapshot, the route's
 * adapter-reachability probe answer, the page's session rows — the live
 * ledger's reads extended with each row's started stamp, arriving here
 * as server-internal render data (see SessionStartView) and never
 * serialized into /status — the page's run rows — the projection read
 * extended with each settled run's wall time (see RunWallView) and,
 * for the failed runs, with the failed drafts the projection stored
 * (see RunDraftsView) — plus the forge's base URL, which the PR cells
 * link with. All of these are page-only inputs: /status's pinned shape
 * gains nothing.
 */
export function renderStatusPage(
  status: StatusData,
  adapterReachable: boolean,
  sessions: SessionStartView[],
  runs: RunDraftsView[],
  forgeUrl: string,
): string {
  const now = Date.now();
  const renderedAt = new Date(now).toISOString();
  const { uptime, droppedStarts, config } = status;

  const sessionColumns: Array<Column<SessionStartView>> = [
    {
      label: "pull request",
      // Live rows carry the re-request affordance with the PR link.
      cell: (session) =>
        pullCell(session.repo, session.pr, forgeUrl, "request review again"),
    },
    { label: "state", cell: (session) => sessionState(session, now) },
    { label: "requester", cell: (session) => esc(session.requester) },
    { label: "accepted", cell: (session) => stamped(session.acceptedAt, now) },
    {
      label: "last activity",
      cell: (session) => stamped(session.lastActivityAt, now),
    },
  ];

  const runColumns: Array<Column<RunWallView>> = [
    { label: "started", cell: (run) => stamped(run.ts, now) },
    {
      label: "pull request",
      cell: (run) => pullCell(run.repo, run.pr, forgeUrl),
    },
    { label: "result", cell: runResult },
    {
      label: "wall time",
      cell: (run) =>
        run.wallSeconds === null
          ? `<span class="muted">—</span>`
          : `<span class="muted">${esc(duration(run.wallSeconds))}</span>`,
    },
    {
      label: "stages",
      cell: (run) =>
        run.phases.length === 0
          ? `<span class="muted">—</span>`
          : `<span class="muted small">${run.phases
              .map(
                (item) => `${esc(item.phase)} ${esc(phase(item.durationMs))}`,
              )
              .join(" · ")}</span>`,
    },
    {
      label: "failure",
      cell: (run) =>
        run.failure === undefined
          ? `<span class="muted">—</span>`
          : `<span class="danger">${esc(run.failure.stage)}${esc(": ")}${esc(
              run.failure.message,
            )}</span>${failedReport(run)}`,
    },
  ];

  const droppedColumns: Array<Column<DroppedStartView>> = [
    {
      label: "pull request",
      // The dropped row's re-request affordance: the link opens the
      // forge's PR page, whose own re-request control re-fires the
      // review through the webhook as a fresh delivery — the run the
      // restart dropped re-runs free (nothing was spent).
      cell: (start) =>
        pullCell(start.repo, start.pr, forgeUrl, "request review again"),
    },
    { label: "accepted", cell: (start) => stamped(start.acceptedAt, now) },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zenigata status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    background: #0d1017;
    color: #e6edf3;
    font: 400 1.05rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0 auto;
    max-width: 62rem;
    padding: 1.4rem clamp(1rem, 4vw, 3rem) 2.4rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: .4rem 1.5rem;
    margin: 0 0 1.1rem;
  }
  h1 { font-size: 1.55rem; font-weight: 650; letter-spacing: .01em; margin: 0; }
  header .muted { font-size: .85rem; }
  .panel {
    background: #141a23;
    border: 1px solid #242c38;
    border-radius: 12px;
    margin-bottom: 1.1rem;
    overflow-x: auto;
    padding: .95rem 1.2rem 1.1rem;
  }
  .panel h2 {
    color: #97a1b0;
    font-size: .8rem;
    font-weight: 600;
    letter-spacing: .09em;
    margin: 0 0 .75rem;
    text-transform: uppercase;
  }
  .health {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    font-size: 1.35rem;
    gap: .55rem .9rem;
    margin: 0;
  }
  .health .fact { font-variant-numeric: tabular-nums; }
  .fine { color: #97a1b0; font-size: .85rem; margin: .6rem 0 0; }
  .chip {
    background: #1a212c;
    border: 1px solid #3a4350;
    border-radius: 999px;
    color: #a7b1be;
    display: inline-block;
    font-size: .78rem;
    font-weight: 600;
    letter-spacing: .02em;
    padding: .12rem .65rem;
    white-space: nowrap;
  }
  .chip.ok   { background: #122a1b; border-color: #2c5f3a; color: #55d069; }
  .chip.warn { background: #2a2210; border-color: #6b561f; color: #e3b341; }
  .chip.bad  { background: #2c1411; border-color: #7c3a33; color: #ff857b; }
  .muted { color: #97a1b0; }
  .small { font-size: .88rem; }
  .danger { color: #ff857b; }
  .draft { border-top: 1px solid #1d242e; margin-top: .45rem; padding-top: .45rem; }
  .draft-head { align-items: baseline; display: flex; flex-wrap: wrap; gap: .3rem .5rem; }
  .draft-refusal { color: #ff857b; font-size: .82rem; margin: .3rem 0 0; }
  .draft-reply {
    background: #0d1017;
    border: 1px solid #242c38;
    border-radius: 6px;
    font: 400 .78rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    margin: .3rem 0 0;
    max-height: 16rem;
    overflow: auto;
    padding: .4rem .55rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  table { border-collapse: collapse; width: 100%; }
  th {
    border-bottom: 1px solid #2b3441;
    color: #97a1b0;
    font-size: .72rem;
    font-weight: 600;
    letter-spacing: .08em;
    padding: .25rem .6rem .45rem;
    text-align: left;
    text-transform: uppercase;
  }
  td {
    border-bottom: 1px solid #1d242e;
    padding: .5rem .6rem;
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: 0; }
  .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: .3rem 1.6rem;
    margin: 0;
  }
  .grid dt { color: #97a1b0; font-size: .88rem; }
  .grid dd { margin: 0; }
  .empty { color: #97a1b0; font-size: 1rem; margin: .2rem 0 .1rem; }
  footer {
    color: #97a1b0;
    display: flex;
    flex-wrap: wrap;
    font-size: .8rem;
    gap: .3rem 1.5rem;
    justify-content: space-between;
    margin-top: 1.4rem;
  }
  a { color: #7fb2ff; }
</style>
</head>
<body>
<header>
  <div>
    <h1>zenigata</h1>
    <p class="muted">review bot · pull-request reviews and thread answers</p>
  </div>
  <p class="muted">refreshed ${esc(renderedAt)}</p>
</header>

<section class="panel">
  <h2>Health</h2>
  <p class="health">
    ${chip(
      adapterReachable ? "adapter reachable" : "adapter unreachable",
      adapterReachable ? "ok" : "bad",
    )}
    <span class="fact">up ${esc(duration(uptime.uptimeSeconds))}</span>
    <span class="fact">listening on port ${esc(String(uptime.listenPort))}</span>
  </p>
  <p class="fine">started ${esc(uptime.startedAt)} · adapter ${esc(uptime.adapterUrl)}</p>
</section>

<section class="panel">
  <h2>Running now</h2>
  ${
    sessions.length === 0
      ? `<p class="empty">Nothing running right now.</p>`
      : table(sessionColumns, sessions)
  }
</section>

<section class="panel">
  <h2>Recent review runs</h2>
  ${
    runs.length === 0
      ? `<p class="empty">No runs yet.</p>`
      : table(runColumns, runs)
  }
</section>

<section class="panel">
  <h2>Review starts a restart dropped</h2>
  ${
    droppedStarts.count === 0
      ? `<p class="empty">None. Every start the journal holds, settled.</p>`
      : `<p class="fine"><strong>${droppedStarts.count} start${
          droppedStarts.count === 1 ? "" : "s"
        }</strong> this boot's journal holds with nothing settled behind them: their reviews never landed. A re-request re-runs them free: request review again on any row.</p>${table(
          droppedColumns,
          droppedStarts.starts,
        )}`
  }
</section>

<section class="panel">
  <h2>Configuration</h2>
  ${configList(config, forgeUrl)}
</section>

<footer>
  <span>the same projection as a machine feed: <a href="/status">GET /status</a></span>
</footer>
</body>
</html>
`;
}
