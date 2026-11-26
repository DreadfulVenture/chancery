import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The runtime package ships the skills tree the review session loads the
 * `review-pr` skill from — and the humanizer that skill's flow runs beside
 * it: the packaged serve carries the opencode assets package's per-client
 * composition at `share/skills.opencode`, and the deployment links it into
 * the serve's config home (PRJ-539; the deployment step is documented in
 * docs/deployment.md). These pins hold the shipping; the compat check
 * composes the deployment shape and exercises the wiring behaviorally.
 */
const runtime = readFileSync(
  new URL("../runtime.nix", import.meta.url),
  "utf8",
);

describe("the runtime package's skills tree", () => {
  it("takes the opencode assets tree as a package input", () => {
    expect(runtime).toContain("opencodeAssets");
  });

  it("ships the tree at the per-client share layout", () => {
    expect(runtime).toContain("share/skills.opencode");
    expect(runtime).toContain(
      "${opencodeAssets}/share/skills.opencode $out/share/skills.opencode",
    );
  });
});
