/**
 * The status page renderer's forge links: the PR cell's anchor
 * construction (the repo string is the forge path) and the page-level
 * rendering — live sessions, recent runs, dropped starts, and the config
 * echo. These are page-only concerns by construction: renderStatusPage
 * takes the forge URL and the live rows' started stamps as render
 * inputs, so /status's pinned shape gains nothing (the harness tests pin
 * that from the wire side too).
 */

import { describe, expect, it } from "vitest";
import { forgePullUrl, renderStatusPage } from "../src/ui.js";
import { diffFinishes, finishPayload, runId } from "../src/status-notify.js";
import type {
  FailedDraftView,
  RunDraftsView,
  SessionLiveView,
  StatusData,
  TranscriptView,
} from "../src/ui.js";

const FORGE_URL = "https://forge.invalid";

const status = (over: Partial<StatusData> = {}): StatusData => ({
  uptime: {
    startedAt: "2026-11-16T09:00:00.000Z",
    uptimeSeconds: 12,
    listenPort: 8471,
    adapterUrl: "http://adapter.invalid",
  },
  sessions: [],
  droppedStarts: { count: 0, starts: [] },
  runs: [],
  config: {
    listenPort: 0,
    allowedLogins: 1,
    allowedRepos: 0,
    retryPolicy: "never",
    reviewTimeoutSeconds: 1800,
    turnPollSeconds: 3,
    turnBudgetSeconds: 900,
    agent: "zenigata-reviewer",
  },
  ...over,
});

const session = {
  eventId: "evt-live",
  repo: "acme/widget",
  pr: 1,
  eventKind: "review_requested",
  requester: "example-user",
  commentId: "c-1",
  stage: "intake",
  acceptedAt: "2026-11-16T10:00:00.000Z",
  lastActivityAt: "2026-11-16T10:00:05.000Z",
};

/** A page row for the NOW panel: the session plus the ledger's stamp. */
const sessionStart = (startedAtMs: number | undefined) => ({
  ...session,
  startedAtMs,
});

const dropped = {
  eventId: "evt-dropped",
  repo: "acme/widget",
  pr: 9,
  eventKind: "review_requested",
  acceptedAt: "2026-11-16T09:00:00.000Z",
};

const run = {
  ts: "2026-11-16T11:00:00.000Z",
  repo: "acme/widget",
  pr: 2,
  outcome: "posted",
  verdict: "APPROVE",
  phases: [],
  wallSeconds: 300,
};

describe("forgePullUrl", () => {
  it("maps owner/name onto the forge's PR path", () => {
    expect(forgePullUrl("example/repo", 7, "https://forge.example.com")).toBe(
      "https://forge.example.com/example/repo/pulls/7",
    );
  });

  it("keeps a nested repo path intact", () => {
    expect(forgePullUrl("acme/team/widget", 1, FORGE_URL)).toBe(
      "https://forge.invalid/acme/team/widget/pulls/1",
    );
  });

  it("does not double the slash of a trailing-slash base URL", () => {
    expect(forgePullUrl("acme/widget", 3, "https://forge.invalid/")).toBe(
      "https://forge.invalid/acme/widget/pulls/3",
    );
  });

  it("URI-encodes each path segment of the repo string", () => {
    expect(forgePullUrl("acme/w id", 2, FORGE_URL)).toBe(
      "https://forge.invalid/acme/w%20id/pulls/2",
    );
    expect(forgePullUrl("acme/a?b/c", 4, FORGE_URL)).toBe(
      "https://forge.invalid/acme/a%3Fb/c/pulls/4",
    );
  });

  it("refuses a repo with no forge path shape and hostile segments", () => {
    expect(forgePullUrl("widget", 1, FORGE_URL)).toBeUndefined();
    expect(forgePullUrl("acme/", 1, FORGE_URL)).toBeUndefined();
    expect(forgePullUrl("/acme", 1, FORGE_URL)).toBeUndefined();
    expect(forgePullUrl("", 1, FORGE_URL)).toBeUndefined();
    expect(forgePullUrl("acme/..", 1, FORGE_URL)).toBeUndefined();
    expect(forgePullUrl("acme/.", 1, FORGE_URL)).toBeUndefined();
  });
});

describe("the page's forge links", () => {
  it("links the live, run, and dropped PR cells, and the re-request affordance rides the live and dropped cells only", () => {
    const live = renderStatusPage(
      status(),
      true,
      [sessionStart(undefined)],
      [],
      FORGE_URL,
    );
    expect(
      live.includes(
        `<a href="${FORGE_URL}/acme/widget/pulls/1">acme/widget#1</a>`,
      ),
    ).toBe(true);
    expect((live.match(/request review again/g) ?? []).length).toBe(1);
    expect(live).toContain(
      `<a href="${FORGE_URL}/acme/widget/pulls/1">request review again</a>`,
    );

    const settled = renderStatusPage(status(), true, [], [run], FORGE_URL);
    expect(settled).toContain(
      `<a href="${FORGE_URL}/acme/widget/pulls/2">acme/widget#2</a>`,
    );
    expect(settled).not.toContain("request review again");

    const droppedRender = renderStatusPage(
      status({ droppedStarts: { count: 1, starts: [dropped] } }),
      true,
      [],
      [],
      FORGE_URL,
    );
    expect(droppedRender).toContain(
      `<a href="${FORGE_URL}/acme/widget/pulls/9">acme/widget#9</a>`,
    );
    expect(droppedRender).toContain(
      `<a href="${FORGE_URL}/acme/widget/pulls/9">request review again</a>`,
    );
  });

  it("renders a repo with no forge path shape as the plain-text identity", () => {
    const page = renderStatusPage(
      status(),
      true,
      [{ ...sessionStart(undefined), repo: "widget", pr: 3 }],
      [],
      FORGE_URL,
    );
    expect(page).toContain("<strong>widget#3</strong>");
    expect(page).not.toContain("forge.invalid/widget/pulls/3");
  });

  it("escapes the repo string in the text and the href both", () => {
    const page = renderStatusPage(
      status(),
      true,
      [{ ...sessionStart(undefined), repo: 'acme/a"b&c', pr: 5 }],
      [],
      FORGE_URL,
    );
    expect(page).toContain("acme/a&quot;b&amp;c#5");
    expect(page).toContain(`href="${FORGE_URL}/acme/a%22b%26c/pulls/5"`);
  });

  it("shows the forge URL plainly in the config echo", () => {
    const page = renderStatusPage(status(), true, [], [], FORGE_URL);
    expect(page).toContain("<dt>forge</dt><dd>https://forge.invalid</dd>");
  });
});

describe("the NOW panel's started render", () => {
  it("a running row's chip names the state and the run's age from the started stamp", () => {
    // Elapsed 9m 30s with sub-second tolerance at the render: the pin is
    // the minutes, not the exact second.
    const page = renderStatusPage(
      status(),
      true,
      [{ ...session, startedAtMs: Date.now() - 570_500 }],
      [],
      FORGE_URL,
    );
    expect(page).toMatch(/class="chip ok">running 9m/);
    expect(page).toContain('<span class="muted small">intake</span>');
  });

  it("a parked row keeps the amber chip and its wait, and claims no running duration", () => {
    const page = renderStatusPage(
      status(),
      true,
      [{ ...session, stage: "queued", startedAtMs: undefined }],
      [],
      FORGE_URL,
    );
    expect(page).toContain(`class="chip warn">parked</span>`);
    expect(page).toContain("waiting for a free review slot");
    expect(page).not.toMatch(/class="chip ok">running/);
  });

  it("a running row whose ledger holds no started stamp names the state alone", () => {
    const page = renderStatusPage(
      status(),
      true,
      [sessionStart(undefined)],
      [],
      FORGE_URL,
    );
    expect(page).toContain(`class="chip ok">running</span>`);
    expect(page).toContain('<span class="muted small">intake</span>');
  });
});

describe("the NOW panel's session log cell", () => {
  /** A live row: the session id and the log view the server read. */
  const liveRow = (
    log: TranscriptView | undefined,
    sessionId: string | undefined = "ses-1",
  ): SessionLiveView => ({
    ...session,
    startedAtMs: Date.now() - 500,
    sessionId,
    log,
  });

  it("a row whose run has not created its session names the fact", () => {
    const page = renderStatusPage(
      status(),
      true,
      [liveRow(undefined, undefined)],
      [],
      FORGE_URL,
    );
    expect(page).toContain("no session yet");
  });

  it("the glance rides the cell and the full log stays behind the collapsible block, escaped", () => {
    const page = renderStatusPage(
      status(),
      true,
      [
        liveRow({
          state: "found",
          text: 'tool bash — completed\n    output: git & "log"',
          truncated: false,
          latest: "tool bash — completed",
        }),
      ],
      [],
      FORGE_URL,
    );
    expect(page).toContain("tool bash — completed");
    expect(page).toContain("session log</summary>");
    expect(page).toContain("git &amp; &quot;log&quot;");
    expect(page).not.toContain('git & "log"');
  });

  it("an unreadable read and an empty log say so plainly", () => {
    const unreadable = renderStatusPage(
      status(),
      true,
      [liveRow({ state: "unavailable" })],
      [],
      FORGE_URL,
    );
    expect(unreadable).toContain("the log could not be read right now");
    const empty = renderStatusPage(
      status(),
      true,
      [liveRow({ state: "found", text: "", truncated: false })],
      [],
      FORGE_URL,
    );
    expect(empty).toContain("the session stands, but has recorded nothing yet");
  });
});

describe("the failed report's transcript view", () => {
  const transcriptRun = (over: Partial<RunDraftsView> = {}): RunDraftsView => ({
    ...run,
    outcome: "failed",
    verdict: null,
    failure: { stage: "blind", message: "boom" },
    ...over,
  });

  it("renders the standing session's transcript as a collapsible pre block, escaped", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [
        transcriptRun({
          sessionId: "ses-1",
          transcript: {
            state: "found",
            text: 'user: review <diff>\nreviewer: says & "no"',
            truncated: false,
          },
        }),
      ],
      FORGE_URL,
    );
    expect(page).toContain("reviewer session log");
    expect(page).toContain("user: review &lt;diff&gt;");
    expect(page).toContain("reviewer: says &amp; &quot;no&quot;");
    expect(page).not.toContain("review <diff>");
  });

  it("labels a capped transcript with the note and the marker rides the text", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [
        transcriptRun({
          sessionId: "ses-1",
          transcript: {
            state: "found",
            text: "the last turn before the cut",
            truncated: true,
          },
        }),
      ],
      FORGE_URL,
    );
    expect(page).toContain("the log is capped at the page's 64KiB");
    expect(page).toContain("the last turn before the cut");
  });

  it("says plainly when the session is gone, without attributing the sweeper", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [transcriptRun({ sessionId: "ses-1", transcript: { state: "swept" } })],
      FORGE_URL,
    );
    expect(page).toContain(
      "the session is gone — the transcript is not available",
    );
    expect(page).not.toContain("reviewer session log");
  });

  it("distinguishes an unreadable transcript from a swept one", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [
        transcriptRun({
          sessionId: "ses-1",
          transcript: { state: "unavailable" },
        }),
      ],
      FORGE_URL,
    );
    expect(page).toContain("the transcript could not be read right now");
    expect(page).not.toContain("transcript was swept");
  });

  it("a run with no transcript view renders the failure cell exactly as before", () => {
    const bare = renderStatusPage(
      status(),
      true,
      [],
      [transcriptRun({ sessionId: "ses-1" })],
      FORGE_URL,
    );
    // The style block always carries the classes; the markup must not.
    expect(bare).not.toContain('class="transcript"');
    expect(bare).not.toContain('class="transcript-note');
    expect(bare).not.toContain("reviewer session log");
  });
});

describe("the failed report", () => {
  const draft = (over: Partial<FailedDraftView> = {}): FailedDraftView => ({
    stage: "context",
    attempt: 0,
    reply: '{"verdict":',
    truncated: false,
    ...over,
  });

  const failedRun = (failedDrafts?: FailedDraftView[]): RunDraftsView => ({
    ...run,
    outcome: "failed",
    verdict: null,
    failure: {
      stage: "context",
      message: "context draft failed validation twice",
    },
    failedDrafts,
  });

  it("renders the stage, attempt, refusal, and capped reply beneath the failure message", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [failedRun([draft({ parseError: "unexpected end of JSON" })])],
      FORGE_URL,
    );
    expect(page).toContain(
      "context draft failed validation twice</span>" +
        '<div class="draft"><div class="draft-head">' +
        '<span class="chip mute">context</span>' +
        '<span class="muted small">attempt 0</span></div>' +
        '<div class="draft-refusal">unexpected end of JSON</div>' +
        '<pre class="draft-reply">{&quot;verdict&quot;:</pre></div>',
    );
  });

  it("labels a truncated draft with the chip, and an uncapped one claims no truncation", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [
        failedRun([
          draft({ truncated: true, reply: "cut off mid-attempt" }),
          draft({ stage: "humanize", attempt: 1 }),
        ]),
      ],
      FORGE_URL,
    );
    expect(page).toContain('<span class="chip warn">truncated</span>');
    expect((page.match(/class="chip warn">truncated/g) ?? []).length).toBe(1);
    expect(page).toContain("attempt 1");
  });

  it("escapes the refusal and the reply — model output renders as text", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [
        failedRun([
          draft({
            parseError: "unexpected <end> of input",
            reply: '<script>alert("draft")</script>',
          }),
        ]),
      ],
      FORGE_URL,
    );
    expect(page).toContain("unexpected &lt;end&gt; of input");
    expect(page).toContain(
      "&lt;script&gt;alert(&quot;draft&quot;)&lt;/script&gt;",
    );
    expect(page).not.toContain("<script>alert");
  });

  it("a run without failed drafts renders the failure cell exactly as before", () => {
    const clean = renderStatusPage(status(), true, [], [run], FORGE_URL);
    expect(clean).not.toContain('class="draft"');

    const failedNoDrafts = renderStatusPage(
      status(),
      true,
      [],
      [failedRun()],
      FORGE_URL,
    );
    expect(failedNoDrafts).not.toContain('class="draft"');
    expect(failedNoDrafts).toContain("context draft failed validation twice");
  });
});

describe("the page's favicon link", () => {
  it("renders one icon link in the head when the href rides in", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [],
      FORGE_URL,
      [],
      "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E",
    );
    expect(page.split('<link rel="icon" type="image/svg+xml"').length).toBe(2);
    // The link sits inside the head, before the page's title closes it.
    expect(page.indexOf('rel="icon"')).toBeLessThan(page.indexOf("</title>"));
  });

  it("renders no icon link when the href is absent", () => {
    const page = renderStatusPage(status(), true, [], [], FORGE_URL);
    expect(page).not.toContain('rel="icon"');
  });

  it("escapes the href like every other raw value the page renders", () => {
    const page = renderStatusPage(
      status(),
      true,
      [],
      [],
      FORGE_URL,
      [],
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg">',
    );
    expect(page).toContain('href="data:image/svg+xml,&lt;svg xmlns=&quot;');
    expect(page).not.toContain('href="data:image/svg+xml,<svg');
  });
});

describe("the page's notifications", () => {
  it("the page carries the quiet control and the inline script", () => {
    const page = renderStatusPage(status(), true, [], [], FORGE_URL);
    expect(page).toContain('<span class="muted" id="notify-control"></span>');
    expect(page).toContain("<script>");
    expect(page).toContain('fetch("/status"');
  });

  it("the served script is composed from the shared functions' own sources", () => {
    // The page's script must be the tested diff logic itself, not a
    // hand-mirrored copy: each shared function's serialized source rides
    // the served text verbatim. A future edit that lets one of them
    // reference something outside its own body is caught by the sandbox
    // run in the status-notify suite, which executes the served script
    // with no module bindings — exactly the browser's scope.
    const page = renderStatusPage(status(), true, [], [], FORGE_URL);
    expect(page).toContain(String(runId));
    expect(page).toContain(String(finishPayload));
    expect(page).toContain(String(diffFinishes));
  });

  it("the page embed carries no script closer inside the script", () => {
    const page = renderStatusPage(status(), true, [], [], FORGE_URL);
    const start = page.indexOf("<script>");
    // The anchor is the LAST closer, not the first: the page carries
    // exactly one script block, so the last closer is its real closing
    // tag. Anchoring on the first closer would make a closer riding the
    // composed source become `end` itself, and the slice ending there
    // could never match — green in exactly the case this check names.
    const end = page.lastIndexOf("</script>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // The opening-tag count above cannot see closers: a literal
    // `</script` inside the composed source would truncate the inline
    // script in the browser while every suite stays green.
    expect(page.slice(start + "<script>".length, end)).not.toMatch(
      /<\/script/i,
    );
  });
});
