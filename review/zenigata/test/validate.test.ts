import { describe, expect, it } from "vitest";
import { extractJsonDetailed } from "../src/review/validate.js";

/** The value the extraction pulled, or undefined when it refused. */
const extractJson = (text: string): unknown | undefined => {
  const result = extractJsonDetailed(text);
  return result.ok ? result.value : undefined;
};

describe("extractJsonDetailed", () => {
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
