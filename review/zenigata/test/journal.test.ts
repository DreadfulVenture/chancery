import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/ctx.js";
import { loadIndex, walkJournal } from "../src/journal.js";

/** One posted review record in the full shape the journal appends. */
const postedRecord = (
  reviewId: string,
  reviewCommentId: string,
  inlineCommentId: string,
) => ({
  ts: "2026-11-15T00:00:00.000Z",
  type: "review",
  reviewId,
  repo: "acme/widget",
  pr: 1,
  requester: "example-user",
  phases: [],
  inlineComments: 1,
  humanizer: { changed: false },
  outcome: "posted",
  body: "review body",
  comments: [{ path: "notes.md", line: 3, body: "inline body" }],
  posted: {
    reviewCommentId,
    commentRefs: [{ index: 0, commentId: inlineCommentId }],
  },
});

/** A journal file with one record per line; strings pass through raw. */
async function writeJournal(
  lines: Array<unknown>,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zenigata-journal-"));
  const path = join(dir, "reviews.jsonl");
  const text =
    lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n") + "\n";
  await writeFile(path, text, "utf8");
  return { dir, path };
}

const capturingLog = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return {
    log: { info: (message) => lines.push(message), error: () => {} },
    lines,
  };
};

describe("loadIndex", () => {
  it("returns an empty index when the journal does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenigata-journal-"));
    const index = await loadIndex(join(dir, "missing.jsonl"));
    expect(index.size).toBe(0);
  });

  it("rejects a non-ENOENT failure instead of treating it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenigata-journal-"));
    // A directory where the journal file should be: the read fails with
    // EISDIR, which is a real boot problem, not an empty journal.
    const journalDir = join(dir, "reviews.jsonl");
    await mkdir(journalDir);
    await expect(loadIndex(journalDir)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("indexes valid posted records for the reply lookup", async () => {
    const { path } = await writeJournal([
      postedRecord("r1", "rc1", "ic1"),
      postedRecord("r2", "rc2", "ic2"),
      "",
    ]);
    const index = await loadIndex(path);
    expect(index.size).toBe(4);
    expect(index.lookup("rc1")).toMatchObject({
      kind: "review",
      repo: "acme/widget",
      pr: 1,
      reviewId: "r1",
      body: "review body",
    });
    expect(index.lookup("ic2")).toMatchObject({
      kind: "inline",
      path: "notes.md",
      line: 3,
      body: "inline body",
      reviewId: "r2",
    });
  });

  it("boots past a parseable line whose posted shape is broken", async () => {
    const { path } = await writeJournal([
      postedRecord("r1", "rc1", "ic1"),
      // Parses, but commentRefs is missing: addPosted used to throw out
      // of this and reject the boot.
      '{"type":"review","outcome":"posted","posted":{"reviewCommentId":"rc2"}}',
      postedRecord("r3", "rc3", "ic3"),
      "",
    ]);
    const { log, lines: logs } = capturingLog();
    const index = await loadIndex(path, log);
    // The valid lines index; the corrupt one is skipped with one log
    // line carrying its line number.
    expect(index.size).toBe(4);
    expect(index.lookup("rc1")).toBeDefined();
    expect(index.lookup("rc3")).toBeDefined();
    expect(index.lookup("rc2")).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("line 2");
  });

  it("boots past an unparseable torn line", async () => {
    const { path } = await writeJournal([
      postedRecord("r1", "rc1", "ic1"),
      '{"type":"review","outcome":"posted","posted":{"reviewComm',
      postedRecord("r2", "rc2", "ic2"),
      "",
    ]);
    const { log, lines: logs } = capturingLog();
    const index = await loadIndex(path, log);
    expect(index.size).toBe(4);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("line 2");
    expect(logs[0]).toContain("unparseable");
  });

  it("consumes reply records and failed reviews without a skip log", async () => {
    const failed = {
      ...postedRecord("r2", "rc2", "ic2"),
      outcome: "failed",
      body: undefined,
      comments: undefined,
      posted: undefined,
    };
    const reply = {
      ts: "2026-11-15T00:00:01.000Z",
      type: "reply",
      repo: "acme/widget",
      pr: 1,
      author: "example-user",
      inReplyTo: "rc1",
      outcome: "posted",
    };
    const { path } = await writeJournal([failed, reply, ""]);
    const { log, lines: logs } = capturingLog();
    const index = await loadIndex(path, log);
    // Legitimate journal lines the index does not consume are not a
    // corruption signal.
    expect(index.size).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it("indexes a posted reply so replies to the bot's answer resolve after a boot", async () => {
    const reply = {
      ts: "2026-11-15T00:00:02.000Z",
      type: "reply",
      repo: "acme/widget",
      pr: 1,
      author: "example-user",
      inReplyTo: "rc1",
      outcome: "posted",
      postedCommentId: "p1",
      body: "the posted answer",
    };
    const { path } = await writeJournal([
      postedRecord("r1", "rc1", "ic1"),
      reply,
      "",
    ]);
    const index = await loadIndex(path);
    expect(index.lookup("p1")).toEqual({
      kind: "reply",
      repo: "acme/widget",
      pr: 1,
      body: "the posted answer",
    });
  });

  describe("accepted-start records", () => {
    const startRecord = {
      ts: "2026-11-16T12:00:00.000Z",
      type: "review-start",
      eventId: "evt-1",
      repo: "acme/widget",
      pr: 1,
      commentId: "rc1",
      eventKind: "review_requested",
    };

    it("leaves the gate's run counts untouched by an accepted-start line", async () => {
      const { path } = await writeJournal([startRecord, ""]);
      const { log, lines: logs } = capturingLog();
      const index = await loadIndex(path, log);
      // A start record is the accepted-event trail, not a ran/settled
      // record: the identity it names produced no run, so the redelivery
      // it would otherwise block re-runs free.
      expect(index.eventRuns("acme/widget", 1, "evt-1")).toEqual({
        runs: 0,
        failed: 0,
        posted: 0,
        aborted: 0,
      });
      // A legitimate journal line the index does not consume is not a
      // corruption signal.
      expect(logs).toHaveLength(0);
      expect(index.size).toBe(0);
    });

    it("counts the ran/settled records around the start records", async () => {
      const failed = {
        ...postedRecord("r1", "rc1", "ic1"),
        eventId: "evt-9",
        commentId: "rc1",
        outcome: "failed",
        body: undefined,
        comments: undefined,
        posted: undefined,
      };
      const { path } = await writeJournal([startRecord, failed, ""]);
      const index = await loadIndex(path);
      expect(index.eventRuns("acme/widget", 1, "evt-9")).toEqual({
        runs: 1,
        failed: 1,
        posted: 0,
        aborted: 0,
      });
    });

    it("counts pre-identity records under their legacy comment anchor", async () => {
      const failed = {
        ...postedRecord("r1", "rc1", "ic1"),
        commentId: "rc1",
        outcome: "failed",
        body: undefined,
        comments: undefined,
        posted: undefined,
      };
      const { path } = await writeJournal([failed, ""]);
      const index = await loadIndex(path);
      // Records written before identities were journaled count under a
      // legacy key no fresh event can collide with, so an old anchor
      // neither blocks nor feeds a redelivery gate today.
      expect(index.eventRuns("acme/widget", 1, "legacy-comment-rc1")).toEqual({
        runs: 1,
        failed: 1,
        posted: 0,
        aborted: 0,
      });
      expect(index.eventRuns("acme/widget", 1, "rc1")).toEqual({
        runs: 0,
        failed: 0,
        posted: 0,
        aborted: 0,
      });
    });
  });
});

// PRJ-445: the journal.ts comment promises stored-row tolerance on every
// read path, naming three. The status db's projection is pinned in the
// status suite; the journal-walk and boot-index halves are pinned here,
// one test per reader, each walking a PRJ-428-era row — a posted record
// whose droppedComments entries carry no `source`, the field PRJ-440
// later made required. A reader stricter than the comment promises
// fails one of these instead of silently refusing a stored old row.
describe("PRJ-428-era source-less rows read tolerantly (PRJ-445)", () => {
  const preSourceDrop = {
    path: "notes.md",
    line: 99,
    reason: "comment on notes.md line 99 is outside the diff's changed lines",
    body: "issue (blocking): this line does not exist in the diff.",
  };
  const preSourcePosted = {
    ...postedRecord("r1", "rc1", "ic1"),
    eventId: "evt-pre-source",
    droppedComments: [preSourceDrop],
  };

  it("the journal walk parses the row without a schema and yields it intact", async () => {
    const { path } = await writeJournal([preSourcePosted, ""]);
    const { log, lines: logs } = capturingLog();
    const lines = await walkJournal(path, log);
    // The walk splits and parses only: the missing `source` cannot
    // refuse the row, and nothing logs a skip.
    expect(logs).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].value).toEqual(preSourcePosted);
  });

  it("the boot index loads the posted source-less row for lookup and run counts", async () => {
    const { path } = await writeJournal([preSourcePosted, ""]);
    const { log, lines: logs } = capturingLog();
    const index = await loadIndex(path, log);
    // The index validates only the fields it consumes: the posted shape
    // is a loose object that names neither droppedComments nor source,
    // so the row indexes and counts without a skip log.
    expect(logs).toEqual([]);
    expect(index.size).toBe(2);
    expect(index.lookup("rc1")).toMatchObject({
      kind: "review",
      reviewId: "r1",
    });
    expect(index.lookup("ic1")).toMatchObject({
      kind: "inline",
      path: "notes.md",
      line: 3,
    });
    expect(index.eventRuns("acme/widget", 1, "evt-pre-source")).toEqual({
      runs: 1,
      failed: 0,
      posted: 1,
      aborted: 0,
    });
  });
});
