/**
 * PRJ-381: the local transposition repair and the detailed extract step.
 * The repair is deliberately narrow — it fixes the two observed
 * transposed-escape forms the review pipeline's own model output emits,
 * and nothing else; these tests pin both the recovery and the refusals.
 */

import { describe, expect, it } from "vitest";
import { repairTransposedEscapes } from "../src/review/repair.js";
import {
  extractJsonDetailed,
  outputHead,
  parseRefusalLine,
} from "../src/review/validate.js";
import {
  capFailedDraft,
  FAILED_DRAFT_CAP,
  FAILED_DRAFT_TRUNCATION_MARKER,
} from "../src/journal.js";

/**
 * A valid JSON source text: the body carries literal braces and an
 * American-style phrase close, so its JSON text contains the valid
 * `,\"` bytes the model transposed in worktree-manager #29.
 */
const INTENDED =
  '{"verdict": "REQUEST_CHANGES", "body": "the map call: {\\"k\\": v} then \\"the close,\\" note", "comments": []}';
const intendedValue = (): unknown => JSON.parse(INTENDED);

/** Form 1: backslash before the comma, bare quote (`\,"`). */
const TRANSPOSED_A = INTENDED.replace(',\\"', '\\,"');
/** Form 2: spurious escaped comma plus escaped quote (`\,\"`). */
const TRANSPOSED_B = INTENDED.replace(',\\"', '\\,\\"');

describe("repairTransposedEscapes", () => {
  it("both observed forms refuse JSON.parse before the repair", () => {
    expect(TRANSPOSED_A).not.toBe(INTENDED);
    expect(TRANSPOSED_B).not.toBe(INTENDED);
    expect(() => JSON.parse(TRANSPOSED_A)).toThrow(/Bad escaped character/);
    expect(() => JSON.parse(TRANSPOSED_B)).toThrow(/Bad escaped character/);
  });

  it("the backslash-before-comma form repairs to the intended text", () => {
    const repaired = repairTransposedEscapes(TRANSPOSED_A);
    expect(repaired.changed).toBe(true);
    expect(repaired.text).toBe(INTENDED);
    expect(JSON.parse(repaired.text)).toEqual(intendedValue());
    // The recovered body keeps the comma inside the quoted phrase.
    expect((intendedValue() as { body: string }).body).toContain('the close,"');
  });

  it("the spurious-pre-comma-backslash form repairs to the intended text", () => {
    const repaired = repairTransposedEscapes(TRANSPOSED_B);
    expect(repaired.changed).toBe(true);
    expect(repaired.text).toBe(INTENDED);
    expect(JSON.parse(repaired.text)).toEqual(intendedValue());
  });

  it("a bare comma is never repaired", () => {
    // `\,` not followed by a quote: not one of the observed forms. A
    // bare-comma substitution would not recover anyway (the bare quote
    // would terminate the string); the repair refuses to touch it.
    const bare = '{"body": "a\\, tail"}';
    expect(() => JSON.parse(bare)).toThrow(/Bad escaped character/);
    const repaired = repairTransposedEscapes(bare);
    expect(repaired.changed).toBe(false);
    expect(repaired.text).toBe(bare);
    expect(() => JSON.parse(repaired.text)).toThrow(/Bad escaped character/);
  });

  it("non-transposed malformed JSON is left untouched", () => {
    // Unterminated string; the stray `\,` (not quote-adjacent) must not
    // tempt the repair into general escape normalization.
    const malformed = '{"body": "trailing\\, garbage';
    expect(() => JSON.parse(malformed)).toThrow();
    const repaired = repairTransposedEscapes(malformed);
    expect(repaired.changed).toBe(false);
    expect(repaired.text).toBe(malformed);
  });

  it("a literal backslash before a comma, then an escaped quote, stays untouched", () => {
    // The valid `\\,\"` construct: escaped backslash, comma, escaped
    // quote. A position-blind search would see the observed form here;
    // the walk consumes the escaped backslash and never fires.
    const valid = '{"body": "regex: a\\\\,\\" b", "comments": []}';
    expect(JSON.parse(valid)).toEqual({ body: 'regex: a\\," b', comments: [] });
    const repaired = repairTransposedEscapes(valid);
    expect(repaired.changed).toBe(false);
    expect(repaired.text).toBe(valid);
  });
});

describe("extractJsonDetailed", () => {
  it("repairs a transposed reply inside the extract step", () => {
    // Form A also deranges the brace scan's string state badly enough
    // that the scan finds no balanced span at all (the body's braces
    // get swallowed); the extract step repairs the full reply and
    // rescans — the incident's own shape, which `undefined`-returning
    // extraction turned into the zod ghost.
    const result = extractJsonDetailed(TRANSPOSED_A);
    expect(result).toMatchObject({
      ok: true,
      route: "brace-scan",
      repaired: true,
    });
    if (result.ok) {
      expect(result.value).toEqual(intendedValue());
    }
  });

  it("repairs the second transposed form as well", () => {
    const result = extractJsonDetailed(TRANSPOSED_B);
    expect(result).toMatchObject({ ok: true, repaired: true });
    if (result.ok) {
      expect(result.value).toEqual(intendedValue());
    }
    // Form B leaves a (deranged) span for the scan; both paths converge.
  });

  it("reads a reply with no JSON span as its own outcome", () => {
    expect(extractJsonDetailed("no json here at all")).toEqual({
      ok: false,
      kind: "no-json",
    });
    expect(extractJsonDetailed('{"verdict": "APPROVE"')).toEqual({
      ok: false,
      kind: "no-json",
    });
  });

  it("refuses with the real parse error when the repair cannot help", () => {
    const unquoted = '{ "verdict": REQUEST_CHANGES, "comments": [] }';
    const result = extractJsonDetailed(unquoted);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "parse-error") {
      expect(result.route).toBe("brace-scan");
      expect(result.repaired).toBe(false);
      // The carried message is JSON.parse's own refusal, not a summary.
      expect(result.error).toContain("not valid JSON");
      expect(parseRefusalLine(result)).toContain("not valid JSON");
      expect(parseRefusalLine(result)).toContain("balanced-brace scan");
      expect(parseRefusalLine(result)).not.toContain("received undefined");
    } else {
      expect.unreachable("expected a parse-error refusal");
    }
  });
});

describe("parseRefusalLine no-json phrasing", () => {
  it("says no JSON found plainly", () => {
    const line = parseRefusalLine({ ok: false, kind: "no-json" });
    expect(line).toContain("no JSON found");
    expect(line).not.toContain("expected object");
    expect(line).not.toContain("received undefined");
  });
});

describe("outputHead", () => {
  it("passes short output through verbatim", () => {
    expect(outputHead("short")).toBe("short");
  });

  it("caps long output at 200 characters with the marker", () => {
    const long = "y".repeat(500);
    const head = outputHead(long);
    expect(head).toHaveLength(200 + "\n[head truncated]".length);
    expect(head.startsWith("y".repeat(200))).toBe(true);
    expect(head.endsWith("[head truncated]")).toBe(true);
  });
});

describe("capFailedDraft", () => {
  it("passes drafts under the cap through verbatim", () => {
    expect(capFailedDraft("raw reply")).toBe("raw reply");
  });

  it("caps runaways at 64KiB with the truncation marker", () => {
    const runaway = "z".repeat(FAILED_DRAFT_CAP + 1000);
    const capped = capFailedDraft(runaway);
    expect(capped).toHaveLength(
      FAILED_DRAFT_CAP + FAILED_DRAFT_TRUNCATION_MARKER.length,
    );
    expect(capped.endsWith(FAILED_DRAFT_TRUNCATION_MARKER)).toBe(true);
    expect(capped.startsWith("z".repeat(FAILED_DRAFT_CAP))).toBe(true);
  });
});
