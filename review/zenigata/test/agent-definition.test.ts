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

/**
 * The definition defers the posted format to the shipped `review-pr` skill:
 * the #189 refactor made that skill the format's sole carrier, so the
 * definition restating its rules would duplicate the skill's contract
 * (PRJ-539). Deployment-configuration duties do not belong in the agent's
 * definition — the deployment guarantees the skills tree, and the compat
 * check proves the delivery.
 */
describe("the reviewer definition's skill deferral", () => {
  it("defers the posted format to the shipped review-pr skill", () => {
    expect(definition).toContain("You use the `@review-pr` skill");
    expect(definition).not.toContain("Conventional Comment");
  });
});
