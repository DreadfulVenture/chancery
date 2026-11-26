import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The reviewer definition is authored in this tree and packaged verbatim
 * (package.nix ships ./agent). Its permission rows are load-bearing: an
 * agent ruleset denies every action it does not name, so these rows are
 * what keeps the skills loadable, the working tools granted, and the
 * no-push fence intact.
 */
const definition = readFileSync(
  new URL("../agent/reviewer.md", import.meta.url),
  "utf8",
);
const frontmatter = definition.slice(
  definition.indexOf("---") + 3,
  definition.indexOf("---", 4),
);

describe("the reviewer definition's permission rows", () => {
  it("allows the skill action over the deployment's whole skills tree", () => {
    expect(frontmatter).toContain(
      '{ action: "skill", resource: "*", effect: "allow" }',
    );
  });

  it("keeps the shell allow and the no-push deny beside it", () => {
    expect(frontmatter).toContain(
      '{ action: "shell", resource: "*", effect: "allow" }',
    );
    expect(frontmatter).toContain(
      '{ action: "shell", resource: "git push*", effect: "deny" }',
    );
  });
});
