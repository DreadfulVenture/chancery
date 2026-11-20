import { describe, expect, it } from "vitest";
import {
  dropUnanchorable,
  extractJson,
  parseDiffHunks,
  validateReview,
} from "../src/review/validate.js";

describe("extractJson", () => {
  it("survives a nested code fence inside a string value via the brace scan", () => {
    // The ```json fence ends early because the review body quotes a code
    // block; the captured slice fails JSON.parse and the balanced-brace
    // scan over the full text must still recover the object.
    const text = [
      "here is the draft:",
      "```json",
      "{",
      '  "verdict": "APPROVE",',
      '  "body": "quoted code:\\n```\\nconst x = 1\\n```",',
      '  "comments": []',
      "}",
      "```",
    ].join("\n");
    expect(extractJson(text)).toEqual({
      verdict: "APPROVE",
      body: "quoted code:\n```\nconst x = 1\n```",
      comments: [],
    });
  });

  it("parses a well-formed fenced block directly", () => {
    const text = '```json\n{"verdict": "APPROVE", "body": "fine"}\n```';
    expect(extractJson(text)).toEqual({ verdict: "APPROVE", body: "fine" });
  });

  it("ignores braces inside string values", () => {
    expect(
      extractJson('{"body": "a { brace and a } brace", "comments": []}'),
    ).toEqual({ body: "a { brace and a } brace", comments: [] });
  });

  it("takes the last balanced object in the text", () => {
    expect(extractJson('draft {"a": 1} notes {"b": 2}')).toEqual({ b: 2 });
  });

  it("returns undefined for plain garbage and unbalanced text", () => {
    expect(extractJson("no json here at all")).toBeUndefined();
    expect(extractJson('{"verdict": "APPROVE"')).toBeUndefined();
  });
});

/** The one diff-text helper the whole file shares; no local shadows. */
const diff = (...lines: string[]): string => lines.join("\n");

describe("parseDiffHunks", () => {
  it("decodes a C-quoted non-ASCII path from +++", () => {
    // git's default core.quotepath renders the é bytes as octal escapes.
    const files = parseDiffHunks(
      diff(
        "diff --git a/caf\\303\\251.md b/caf\\303\\251.md",
        "--- a/caf\\303\\251.md",
        '+++ "b/caf\\303\\251.md"',
        "@@ -1,1 +1,2 @@",
        " context",
        "+added",
      ),
    );
    expect([...files.keys()]).toEqual(["café.md"]);
    expect(files.get("café.md")?.ranges).toEqual([[1, 2]]);
  });

  it("decodes a quoted path containing spaces", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/my file.md b/my file.md",
        "--- a/my file.md",
        '+++ "b/my file.md"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(["my file.md"]);
  });

  it("decodes embedded escaped quotes", () => {
    const files = parseDiffHunks(
      diff(
        'diff --git a/quoted"name.md b/quoted"name.md',
        '--- a/quoted"name.md',
        '+++ "b/quoted\\"name.md"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(['quoted"name.md']);
  });

  it("decodes an escaped tab", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/ta\tb.md b/ta\tb.md",
        "--- a/ta\tb.md",
        '+++ "b/ta\\tb.md"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(["ta\tb.md"]);
  });

  it("decodes an escaped carriage return", () => {
    // quote_c_style also emits \a \b \f \v \r; a CR filename must not
    // decode as the letter r.
    const files = parseDiffHunks(
      diff(
        "diff --git a/weird\rname.md b/weird\rname.md",
        "--- a/weird\rname.md",
        '+++ "b/weird\\rname.md"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(["weird\rname.md"]);
  });

  it("decodes the other short control escapes", () => {
    const files = parseDiffHunks(
      diff('+++ "b/esc\\a\\b\\f\\v.md"', "@@ -1 +1 @@", "-old", "+new"),
    );
    expect([...files.keys()]).toEqual(["esc\x07\x08\x0c\x0b.md"]);
  });

  it("leaves an unquoted path verbatim", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/plain.md b/plain.md",
        "--- a/plain.md",
        "+++ b/plain.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(["plain.md"]);
  });

  it("maps a new file and skips /dev/null", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/new.md b/new.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ),
    );
    expect([...files.keys()]).toEqual(["new.md"]);
    expect(files.get("new.md")?.ranges).toEqual([[1, 2]]);
  });

  it("maps a rename under the new path", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/old.md b/renamed.md",
        "similarity index 90%",
        "rename from old.md",
        "rename to renamed.md",
        "--- a/old.md",
        "+++ b/renamed.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect([...files.keys()]).toEqual(["renamed.md"]);
    expect(files.get("renamed.md")?.oldPaths).toEqual(["old.md"]);
  });

  it("collects the rename's old path once from both sources", () => {
    // git prints the rename pair AND the ---/+++ pair for a rename with
    // content edits; the old side is one path, not two.
    const files = parseDiffHunks(
      diff(
        "diff --git a/src/old-name.ts b/src/new-name.ts",
        "similarity index 80%",
        "rename from src/old-name.ts",
        "rename to src/new-name.ts",
        "--- a/src/old-name.ts",
        "+++ b/src/new-name.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect(files.get("src/new-name.ts")?.oldPaths).toEqual(["src/old-name.ts"]);
  });

  it("gains no entry for a contentless rename", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/moved.md b/moved.md",
        "similarity index 100%",
        "rename from moved.md",
        "rename to placed.md",
      ),
    );
    expect(files.size).toBe(0);
  });

  it("records nothing for a binary file entry", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/bin.dat b/bin.dat",
        "index 1111111..2222222 100644",
        "Binary files a/bin.dat and b/bin.dat differ",
      ),
    );
    expect(files.size).toBe(0);
  });

  it("keeps every hunk of a multi-hunk diff whose hunks carry context", () => {
    // PRJ-428: counting the body off at oldCount + newCount lines flat
    // overran every hunk that carried context (a context line counts on
    // both sides but appears once) and ate the next hunk's @@ header,
    // so every second hunk's ranges vanished and valid anchors were
    // refused as outside the changed lines.
    const files = parseDiffHunks(
      diff(
        "diff --git a/notes.md b/notes.md",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1,4 +1,4 @@",
        " context one",
        "-removed one",
        "+added one",
        " context two",
        " context three",
        "@@ -10,3 +11,4 @@",
        " context four",
        "+added two",
        " context five",
        " context six",
      ),
    );
    expect(files.get("notes.md")?.ranges).toEqual([
      [1, 4],
      [11, 14],
    ]);
  });

  it("skips no-newline markers without disturbing the next hunk's ranges", () => {
    const files = parseDiffHunks(
      diff(
        "diff --git a/notes.md b/notes.md",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "@@ -9 +9 @@",
        " context",
      ),
    );
    expect(files.get("notes.md")?.ranges).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });
});

describe("validateReview path normalization", () => {
  const RENAME_DIFF = diff(
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 80%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    " context",
  );

  const PLAIN_DIFF = diff(
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,2 +1,3 @@",
    " alpha",
    "+added one",
    "+added two",
    " gamma",
  );

  const comment = (path: string, line: number): unknown => ({
    path,
    line,
    body: "Agent-generated:\n\nsuggestion (non-blocking): say what was added.",
  });

  const draft = (path: string, line: number): unknown => ({
    verdict: "APPROVE",
    body: "fine",
    comments: [comment(path, line)],
  });

  it("normalizes a/ and b/ prefixed paths onto the new-side path", () => {
    for (const prefixed of ["a/notes.md", "b/notes.md"]) {
      const result = validateReview(draft(prefixed, 2), PLAIN_DIFF);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.comments[0]?.path).toBe("notes.md");
      }
    }
  });

  it("resolves the rename's old path and rewrites the comment onto the new side", () => {
    const result = validateReview(draft("src/old-name.ts", 1), RENAME_DIFF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.comments[0]?.path).toBe("src/new-name.ts");
    }
    // The prefixed old path resolves the same way.
    const prefixed = validateReview(draft("a/src/old-name.ts", 1), RENAME_DIFF);
    expect(prefixed.ok).toBe(true);
    if (prefixed.ok) {
      expect(prefixed.value.comments[0]?.path).toBe("src/new-name.ts");
    }
  });

  it("prefers the exact key when a file lives under a top-level a/ directory", () => {
    const topDirDiff = diff(
      "diff --git a/a/lib/mod.ts b/a/lib/mod.ts",
      "--- a/a/lib/mod.ts",
      "+++ b/a/lib/mod.ts",
      "@@ -1 +1 @@",
      "+change",
    );
    const result = validateReview(draft("a/lib/mod.ts", 1), topDirDiff);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.comments[0]?.path).toBe("a/lib/mod.ts");
    }
  });

  it("still refuses a path that resolves nowhere", () => {
    const result = validateReview(draft("src/missing.ts", 1), PLAIN_DIFF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("src/missing.ts does not appear");
    }
  });

  it("names the resolved path when an anchor falls outside the changed lines", () => {
    // The prefixed path resolves onto notes.md; the refusal reports the
    // identity the check ran against.
    const result = validateReview(draft("a/notes.md", 99), PLAIN_DIFF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe(
        "comment on notes.md line 99 is outside the diff's changed lines",
      );
    }
  });
});

describe("validateReview anchoring across hunks (PRJ-428 review 309)", () => {
  // Two context-bearing hunks, the shape that used to lose its second
  // hunk's ranges: an anchor on the second hunk must validate.
  const MULTI_HUNK_DIFF = diff(
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,4 +1,4 @@",
    " context one",
    "-removed one",
    "+added one",
    " context two",
    " context three",
    "@@ -10,3 +11,4 @@",
    " context four",
    "+added two",
    " context five",
    " context six",
  );

  const draftAt = (line: number): unknown => ({
    verdict: "APPROVE",
    body: "fine",
    comments: [
      {
        path: "notes.md",
        line,
        body: "Agent-generated:\n\nsuggestion (non-blocking): say what was added.",
      },
    ],
  });

  it("validates a comment anchored on the second hunk", () => {
    const result = validateReview(draftAt(12), MULTI_HUNK_DIFF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.comments[0]?.line).toBe(12);
    }
  });
});

describe("dropUnanchorable (PRJ-428)", () => {
  // Same shape as the harness fixture's diff: one hunk, new-side 1..3.
  const DROP_DIFF = diff(
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,2 +1,3 @@",
    " alpha",
    "+added one",
    "+added two",
    " gamma",
  );

  const comment = (
    path: string,
    line: number,
    blocking: boolean,
  ): { path: string; line: number; body: string } => ({
    path,
    line,
    body: `Agent-generated:\n\nissue ${
      blocking ? "(blocking)" : "(non-blocking)"
    }: say what was added.`,
  });

  it("drops one unanchorable comment and keeps the anchored ones", () => {
    const result = dropUnanchorable(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [comment("notes.md", 2, true), comment("notes.md", 99, true)],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.comments).toHaveLength(1);
      expect(result.value.comments[0]?.line).toBe(2);
      // The posted verdict is the draft's own verdict.
      expect(result.value.verdict).toBe("REQUEST_CHANGES");
      expect(result.drops).toHaveLength(1);
      expect(result.drops[0]).toEqual({
        source: "context",
        path: "notes.md",
        line: 99,
        reason:
          "comment on notes.md line 99 is outside the diff's changed lines",
        body: comment("notes.md", 99, true).body,
      });
    }
  });

  it("drops a comment whose path resolves nowhere, naming the model's path", () => {
    const result = dropUnanchorable(
      {
        verdict: "APPROVE",
        body: "summary",
        comments: [
          comment("notes.md", 2, false),
          comment("absent.md", 1, false),
        ],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.comments).toHaveLength(1);
      expect(result.drops[0]?.reason).toContain("absent.md does not appear");
      // The drop names the body that died with it.
      expect(result.drops[0]?.body).toBe(comment("absent.md", 1, false).body);
    }
  });

  it("names the resolved path in an out-of-range drop and the model's path for one that appears nowhere", () => {
    const result = dropUnanchorable(
      {
        verdict: "APPROVE",
        body: "summary",
        comments: [
          // The prefixed path resolves onto notes.md; the refusal names
          // the identity the check ran against.
          comment("a/notes.md", 99, false),
          comment("absent.md", 1, false),
        ],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.drops).toHaveLength(2);
      expect(result.drops?.[0]?.path).toBe("notes.md");
      expect(result.drops?.[0]?.reason).toBe(
        "comment on notes.md line 99 is outside the diff's changed lines",
      );
      // Nowhere to resolve: the record names the model's own path,
      // plainly.
      expect(result.drops?.[1]?.path).toBe("absent.md");
      expect(result.drops?.[1]?.reason).toBe(
        "comment path absent.md does not appear in the diff",
      );
    }
  });

  it("keeps the anchored comments under the resolved path, agreeing with validateReview's payload", () => {
    const renameDiff = diff(
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 80%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
    );
    const anchored = comment("src/old-name.ts", 1, true);
    const anchoredPrefixed = comment("a/src/new-name.ts", 1, false);
    const result = dropUnanchorable(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [anchored, anchoredPrefixed],
      },
      renameDiff,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both kept comments carry the new-side identity: the rename's
      // old path and the a/ prefix resolve the same way the normal
      // validation path rewrites them.
      expect(result.value.comments.map((c) => c.path)).toEqual([
        "src/new-name.ts",
        "src/new-name.ts",
      ]);
    }
    // The normal path's payload agrees on shape.
    const normal = validateReview(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [comment("src/old-name.ts", 1, true)],
      },
      renameDiff,
    );
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      expect(normal.value.comments[0]?.path).toBe("src/new-name.ts");
    }
    // The input draft is untouched: the rewrite is a copy, never an
    // in-place mutation of what the model sent.
    expect(anchored.path).toBe("src/old-name.ts");
    expect(anchoredPrefixed.path).toBe("a/src/new-name.ts");
  });

  it("records the verdict move the drops would have forced and refuses to mint it", () => {
    const result = dropUnanchorable(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [
          comment("notes.md", 99, true),
          comment("notes.md", 2, false),
        ],
      },
      DROP_DIFF,
    );
    // Dropping the only blocking comment would leave REQUEST_CHANGES
    // with nothing blocking behind it; the rescue refuses rather than
    // posting an approval the draft never issued.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "verdict is REQUEST_CHANGES but no comment is marked (blocking); the verdict must be APPROVE",
      );
      // The would-be move rides the refusal for the record.
      expect(result.verdictReconciled).toEqual({
        from: "REQUEST_CHANGES",
        to: "APPROVE",
        because:
          "every blocking comment dropped: comment on notes.md line 99 is outside the diff's changed lines",
      });
      expect(result.drops).toHaveLength(1);
    }
  });

  it("does not paper over a verdict the drops did not cause", () => {
    // A REQUEST_CHANGES draft with no blocking comment at all is the
    // model's own inconsistency; dropping nothing fixes nothing.
    const result = dropUnanchorable(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [comment("notes.md", 2, false)],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(
        "verdict is REQUEST_CHANGES but no comment is marked (blocking)",
      );
      // No drop caused this, so there is no would-be move to name.
      expect(result.verdictReconciled).toBeUndefined();
    }
  });

  it("does not rescue a draft whose kept comments carry a format failure", () => {
    const result = dropUnanchorable(
      {
        verdict: "APPROVE",
        body: "summary",
        comments: [
          // Anchored but missing the header: a format failure the
          // drops cannot remove, since this comment anchors fine.
          { path: "notes.md", line: 2, body: "no header at all" },
          comment("notes.md", 99, false),
        ],
      },
      DROP_DIFF,
    );
    // The unanchorable comment drops, but the kept one fails the format
    // rule, and a format failure is not rescuable by dropping.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("does not start with");
      expect(result.drops).toHaveLength(1);
    }
  });

  it("still refuses APPROVE over kept blocking comments", () => {
    const result = dropUnanchorable(
      {
        verdict: "APPROVE",
        body: "summary",
        comments: [
          comment("notes.md", 2, true),
          comment("notes.md", 99, false),
        ],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(
        "verdict is APPROVE but a comment is marked (blocking)",
      );
      // The draft was inconsistent as issued, not drop-caused.
      expect(result.verdictReconciled).toBeUndefined();
    }
  });

  it("refuses when every comment drops: there is no review to post", () => {
    const result = dropUnanchorable(
      {
        verdict: "REQUEST_CHANGES",
        body: "summary",
        comments: [
          comment("notes.md", 99, true),
          comment("notes.md", 100, false),
        ],
      },
      DROP_DIFF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(
        "every comment dropped; there is no review left to post",
      );
      expect(result.drops).toHaveLength(2);
      // No verdict move is named: nothing would post under any verdict.
      expect(result.verdictReconciled).toBeUndefined();
    }
  });

  it("formats a kept comment's format failure under the resolved identity, matching validateReview's string", () => {
    // A kept comment with a bad header on an a/-prefixed path: both
    // callers format the failure under the resolved path, so the
    // failure message's dedupe sees one string instead of two.
    const draftValue = {
      verdict: "APPROVE",
      body: "summary",
      comments: [
        { path: "a/notes.md", line: 2, body: "no header at all" },
        comment("notes.md", 99, false),
      ],
    };
    const normal = validateReview(draftValue, DROP_DIFF);
    const rescued = dropUnanchorable(draftValue, DROP_DIFF);
    expect(normal.ok).toBe(false);
    expect(rescued.ok).toBe(false);
    if (!normal.ok && !rescued.ok) {
      const expected =
        'comment on notes.md line 2 does not start with "Agent-generated:" followed by a blank line';
      expect(normal.errors).toContain(expected);
      expect(rescued.errors).toContain(expected);
    }
  });

  it("rescues nothing from a draft that fails the zod shape", () => {
    const result = dropUnanchorable(
      { verdict: "MAYBE", body: "summary", comments: [] },
      DROP_DIFF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("verdict");
      expect(result.drops).toBeUndefined();
    }
  });
});
