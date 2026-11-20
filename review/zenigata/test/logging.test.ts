/**
 * Logging-surface regression tests. The bot logs to stdout and stderr
 * through the console logger and writes no log file of its own: the only
 * appends under the state dir are the journal's run records (state the
 * boot reader and the retry gate consume), the status db rows the status
 * surface reads, the canonical clones, and the disposable review
 * worktrees. PRJ-461's narration ring sits beside the console sink —
 * the same lines, one write path — but is memory only: it appends no
 * file, so the state-dir-only-state invariant below survives unchanged,
 * and the ring's own bounds and capture live in test/log-ring.test.ts.
 */

import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PR,
  REPO,
  postReviewEvent,
  startHarness,
  type Harness,
} from "./helpers.js";

const harnesses: Harness[] = [];

async function harness(
  options: Parameters<typeof startHarness>[0],
): Promise<Harness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

/** Join every spied console call into one text block to assert against. */
const spyText = (spy: { mock: { calls: Array<Array<unknown>> } }): string =>
  spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");

/** The state dir's legitimately-written entries, sorted. */
const STATE_DIR_ENTRIES = [
  "canonical-clones",
  "reviews.jsonl",
  "status.db",
  "worktrees",
];

// The proven happy-path script (same fixtures as flow.test.ts): blind
// findings, a valid draft, a humanized payload.
const happyScript = () => [
  [
    "notes.md line 3: 'added one' names nothing; say what was added.",
    "notes.md line 4: same vagueness.",
  ].join("\n"),
  JSON.stringify({
    verdict: "REQUEST_CHANGES",
    body: "The change adds two lines but neither says what was added.",
    comments: [
      {
        path: "notes.md",
        line: 3,
        body: "Agent-generated:\n\nissue (blocking): 'added one' names nothing; say what was added or drop the line.",
      },
    ],
  }),
  JSON.stringify({
    payload: {
      verdict: "REQUEST_CHANGES",
      body: "The case: two lines land and neither one says what it adds.",
      comments: [
        {
          path: "notes.md",
          line: 3,
          body: "Agent-generated:\n\nissue (blocking): 'added one' names nothing; say what was added or drop the line.",
        },
      ],
    },
    assessment: "tightened the prose, kept the verdict",
  }),
];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.handle.close()));
  vi.restoreAllMocks();
});

describe("logging surface", () => {
  it("narration lands on stdout and stderr, not in any file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Boot: the intake announce goes to stdout through the console logger.
    const h = await harness({ script: [] });
    expect(spyText(logSpy)).toContain(
      `zenigata: intake listening on port ${h.handle.port}`,
    );

    // A skipped run: its narration is a stdout line.
    const hSkip = await harness({
      script: [],
      allowedLogins: "someone-else",
    });
    await postReviewEvent(hSkip, { requesterLogin: "stranger" });
    expect(spyText(logSpy)).toContain(
      `zenigata: skipped ${REPO}#${PR}: requester stranger is not in the allowed logins`,
    );

    // A failed run: its narration is a stderr line.
    const hFail = await harness({
      script: ["blind noise", "not json", "still not json"],
    });
    await postReviewEvent(hFail);
    expect(spyText(errorSpy)).toContain(
      `zenigata: review failed for ${REPO}#${PR}`,
    );
  });

  it("a full review run writes only state under the state dir", async () => {
    const h = await harness({ script: happyScript() });
    await postReviewEvent(h);

    const names = (await readdir(h.stateDir, { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(STATE_DIR_ENTRIES);

    const records = (await h.journal()) as Array<Record<string, unknown>>;
    // The accepted start always journals (PRJ-337), then the run's own
    // settlement record.
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: "review-start",
      eventId: expect.any(String),
    });
    expect(records[1]).toMatchObject({ type: "review", outcome: "posted" });
  });
});
