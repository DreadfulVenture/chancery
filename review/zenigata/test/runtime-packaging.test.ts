import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The runtime package composes its own config layout (PRJ-548) as
 * ordinary derivations: the neutral floor as the layout's ONE config
 * file, the reviewer agent definition under the id the driver selects,
 * and the skills tree — plain symlink composition, no wrapper machinery.
 * The deployment's own config file layers beside the floor as
 * opencode.jsonc through the serve's native two-file precedence
 * (opencode.json and opencode.jsonc load from one directory, jsonc wins
 * for settings — config/discovery.ts `names` and config.ts `latest`,
 * v2.3.0); no env var carries a config path.
 */
const runtime = readFileSync(
  new URL("../runtime.nix", import.meta.url),
  "utf8",
);

describe("the runtime package's self-contained config layout", () => {
  it("takes the opencode assets tree as a package input", () => {
    expect(runtime).toContain("opencodeAssets");
  });

  it("composes the serve's config home as its own derivation", () => {
    expect(runtime).toContain("opencodeHome = runCommand");
    expect(runtime).toContain(
      "${runtimeConfigJson} $out/share/zenigata/opencode-home/opencode.json",
    );
  });

  it("ships exactly one config file in that layout — the floor", () => {
    expect(runtime).toContain(`writeText "opencode.json"`);
    // No second config file ships in the layout, and no env var carries
    // an override: the deployment's own file layers through the serve's
    // native two-file precedence, placed there by the deployment's
    // module option.
    expect(runtime).not.toMatch(/ln -s[^\n]*opencode\.jsonc/);
    expect(runtime).not.toContain("OPENCODE_CONFIG_OVERRIDES");
    expect(runtime).not.toContain("OPENCODE_CONFIG=");
  });

  it("publishes the reviewer definition under the id the driver selects", () => {
    expect(runtime).toContain(
      "$out/share/zenigata/opencode-home/agent/zenigata-reviewer.md",
    );
  });

  it("ships the skills tree into that layout", () => {
    expect(runtime).toContain("$out/share/zenigata/opencode-home/skills");
  });

  it("leaves the serve and bot bins unwrapped", () => {
    expect(runtime).not.toContain("makeBinaryWrapper");
    expect(runtime).not.toContain("makeWrapper");
  });

  it("ships the stack launcher the service's ExecStart runs", () => {
    expect(runtime).toContain('writeShellScriptBin "zenigata-stack"');
    // The launcher's config-home default is the package's own layout; a
    // deployment pointing the unit at its composed two-file directory
    // overrides the location, not the content.
    expect(runtime).toContain("OPENCODE_CONFIG_DIR");
    expect(runtime).toContain("OPENCODE_PASSWORD");
  });
});
