/**
 * The rendered-config check's engine (PRJ-505). The flake's
 * `zenigata-rendered-config` check evaluates the NixOS module, renders one
 * test deployment's unit environment to a JSON file, and hands three files
 * to `zenigata --check-config`: the rendered environment, the unit's own
 * environment file, and the identity lists that deployment carries. This
 * module composes the first two the way a deployed boot composes them —
 * systemd layers the EnvironmentFile over the unit's plain environment —
 * and validates the composition through loadConfig, the same schema every
 * boot pays. The check pins the lineage declaration: the memory URL
 * must carry `app=zenigata&initiator=agent`, the shape docs/deployment.md
 * pins. The `initiator` value is how the deployment tells the gate its
 * conversations are agent-started: the gate reads a conversation it has
 * not seen as the agent-lineage class (`unanchored`) on a declared
 * connection, as `absent` on an undeclared one. The observation grant is
 * the same either way; the class the conversation carries and the
 * refusal its non-observation writes get are what differ.
 */

import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";

/** The identity lists the test deployment is expected to carry. */
export interface IdentityExpectations {
  humans: string[];
  agents: string[];
  access: string[];
}

export interface ConfigCheckResult {
  /** The parsed boot configuration, present only when it loaded clean. */
  config?: Config;
  /** Every failure, named the way loadConfig names a bad variable. */
  failures: string[];
}

/**
 * Parse an environment file's plain KEY=VALUE form, the subset the
 * deployment's secrets file uses. That is a subset of what systemd's
 * EnvironmentFile reader accepts: whole-line `;` comments, backslash
 * continuations, and quoted-value escapes are beyond this parser. Blank
 * lines and `#` comments skip; a whole-line surrounding quote pair on
 * the value strips; everything after the first `=` joins verbatim, so an
 * embedded `=` rides inside the value. A non-empty line with no `=`
 * throws: a malformed secrets file must fail named, not silently lose a
 * variable at the boot composition.
 */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`environment file line '${trimmed}' is not KEY=VALUE`);
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

/** Read the rendered unit environment: a JSON object of strings only. */
export function readRenderedEnvironment(path: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object of environment strings`);
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${path}: '${key}' is not an environment string`);
    }
    entries[key] = value;
  }
  return entries;
}

/** Read the expected identity lists: three arrays of account names. */
export function readIdentityExpectations(path: string): IdentityExpectations {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object of identity lists`);
  }
  const read = (field: string): string[] => {
    const value = (raw as Record<string, unknown>)[field];
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`${path}: '${field}' must be an array of account names`);
    }
    return value;
  };
  return {
    humans: read("humans"),
    agents: read("agents"),
    access: read("access"),
  };
}

/**
 * Validate one rendered deployment the boot path validates itself: the
 * composition must load clean, its memory URL must carry the lineage
 * gate's declaration, and the three identity lists must equal the arrays
 * the test deployment sets — the expectation pins what the module
 * actually rendered, not what its condition happened to produce.
 */
export function checkRenderedConfig(input: {
  rendered: Record<string, string | undefined>;
  secrets: Record<string, string | undefined>;
  want: IdentityExpectations;
}): ConfigCheckResult {
  const failures: string[] = [];
  const bootEnvironment = { ...input.rendered, ...input.secrets };
  let config: Config | undefined;
  try {
    config = loadConfig(bootEnvironment);
  } catch (error) {
    failures.push(
      `the composed boot environment fails boot-time validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (config === undefined) {
    return { failures };
  }
  let memoryUrl: URL;
  try {
    memoryUrl = new URL(bootEnvironment.ZENIGATA_MEMORY_URL ?? "");
  } catch {
    // An unparsable URL already failed loadConfig's own schema, and the
    // named failure above is the one the operator fixes; the lineage
    // check has nothing further to say about it.
    return { config, failures };
  }
  if (memoryUrl.searchParams.get("app") !== "zenigata") {
    failures.push(
      "ZENIGATA_MEMORY_URL must carry app=zenigata: the daemon stamps the client name off the connection, and docs/deployment.md pins the shape <host>:<port>/mcp?app=zenigata&initiator=agent",
    );
  }
  if (memoryUrl.searchParams.get("initiator") !== "agent") {
    failures.push(
      "ZENIGATA_MEMORY_URL must carry initiator=agent: without the declaration an unseen conversation reads as class 'absent' instead of the agent-lineage class, which changes the conversation's attribution class and the refusal its non-observation writes get — the observation grant itself is the same either way",
    );
  }
  const rendered = {
    humans: config.humans,
    agents: config.agents,
    access: config.access,
  };
  for (const field of ["humans", "agents", "access"] as const) {
    if (JSON.stringify(rendered[field]) !== JSON.stringify(input.want[field])) {
      failures.push(
        `the identity list '${field}' rendered as ${JSON.stringify(
          rendered[field],
        )}, wanted ${JSON.stringify(input.want[field])}`,
      );
    }
  }
  return { config, failures };
}

/**
 * The `zenigata --check-config` entry: three file paths — the rendered
 * unit environment (JSON), the unit's environment file (its secrets, the
 * file the unit's EnvironmentFile reads at boot), and the expected
 * identity lists (JSON). Failures print named, one per line, and the
 * process exits 1 on any and 2 on malformed input.
 */
export function runConfigCheck(args: string[]): void {
  if (args.length !== 3) {
    console.error(
      "usage: zenigata --check-config <rendered-environment.json> <environment-file> <expected-identity.json>",
    );
    process.exit(2);
  }
  let result: ConfigCheckResult;
  try {
    result = checkRenderedConfig({
      rendered: readRenderedEnvironment(args[0] as string),
      secrets: parseEnvironmentFile(readFileSync(args[1] as string, "utf8")),
      want: readIdentityExpectations(args[2] as string),
    });
  } catch (error) {
    console.error(
      `zenigata --check-config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(2);
  }
  for (const failure of result.failures) {
    console.error(`zenigata --check-config: ${failure}`);
  }
  if (result.failures.length > 0) {
    process.exit(1);
  }
  console.log(
    "zenigata --check-config: the composed boot environment loads clean, declares its lineage, and carries the identity lists",
  );
}
