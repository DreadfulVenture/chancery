import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";

describe("canonicalJson", () => {
  it("treats reordered object keys as equal", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts keys recursively, inside arrays too", () => {
    expect(canonicalJson({ outer: [{ y: 1, x: 2 }], a: 0 })).toBe(
      canonicalJson({ a: 0, outer: [{ x: 2, y: 1 }] }),
    );
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes different values", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});
