/**
 * The favicon loader's contract: the data URI round-trips to the packaged
 * file's own text, and nothing the file contained can terminate the link
 * tag's attribute.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { consoleLogger } from "../src/ctx.js";
import { loadFaviconHref } from "../src/favicon.js";

const PACKAGED = new URL("../assets/favicon.svg", import.meta.url);

const hrefOf = async (): Promise<string> => {
  const href = await loadFaviconHref(consoleLogger);
  expect(href).toBeDefined();
  return href as string;
};

describe("loadFaviconHref", () => {
  it("encodes the packaged svg into a data-URI href", async () => {
    const href = await hrefOf();
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("round-trips to the packaged file's exact text", async () => {
    const href = await hrefOf();
    const [scheme, encoded] = href.split(",", 2);
    expect(scheme).toBe("data:image/svg+xml");
    const svg = await readFile(PACKAGED, "utf8");
    expect(decodeURIComponent(encoded)).toBe(svg);
  });

  it("encodes the fills' # and the markup's \" so the attribute holds", async () => {
    const href = await hrefOf();
    expect(href).toContain("%23e3593f");
    expect(href).not.toContain('"');
  });
});
