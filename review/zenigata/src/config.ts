/**
 * Environment-driven configuration. Every validation failure names the
 * offending variable so a misconfigured deployment fails at boot with the
 * exact variable to fix.
 */

import { z } from "zod";

export interface Config {
  listenPort: number;
  stateDir: string;
  allowedLogins: string[];
  allowedRepos: string[];
  /**
   * The deployment's humans list. It renders one operator-speech sentence
   * into the review session's and the answer session's start prompts:
   * accounts on it speak for the operator — veracity and corrections —
   * and every other account's prose is a claim to trace.
   */
  humans: string[];
  personaFile?: string;
  adapterUrl: string;
  /**
   * The forge's base URL: the status page renders the PR cells as links
   * into the forge with it. Not a secret — the config echo shows it plainly.
   */
  forgeUrl: string;
  adapterToken: string;
  eventToken: string;
  opencodeUrl: string;
  opencodeKey?: string;
  memoryUrl: string;
  reviewTimeoutSeconds: number;
  agent: string;
  worktreesDir: string;
  /** Seconds between the agent turn's state polls. */
  turnPollSeconds: number;
  /** Seconds one agent turn may run before the driver calls it stuck. */
  turnBudgetSeconds: number;
  /**
   * Seconds finished work (the review session, the per-PR worktree) stays
   * on disk before the retention sweep retires it (PRJ-382). 0 restores
   * the immediate teardown the run itself once performed.
   */
  retentionWindowSeconds: number;
  /** Whether a failed review event may be re-processed by a redelivery. */
  retryPolicy: RetryPolicy;
}

/**
 * The retry posture for review events, explicit values only. `never` (the
 * default) refuses to re-process an event the journal already ran: an
 * automatic re-fire path exists nowhere in the default configuration, so a
 * failed review costs exactly one run. A deployment that wants one
 * automatic retry of a failed event on redelivery opts into `once` —
 * at most one re-run per failed event, and only a failure triggers it.
 */
export type RetryPolicy = "never" | "once";

export const RETRY_POLICY_VALUES: readonly RetryPolicy[] = ["never", "once"];

const intSchema = z.coerce
  .number()
  .int("must be an integer")
  .min(0, "must be >= 0 (0 lets the OS pick the listen port)");

const portSchema = intSchema.max(
  65535,
  "must be <= 65535 (the largest TCP port number)",
);

const secondsSchema = z.coerce
  .number()
  .int("must be an integer")
  .positive("must be > 0");

/** Like secondsSchema, but 0 is meaningful: the retention escape hatch. */
const nonNegativeSecondsSchema = z.coerce
  .number()
  .int("must be an integer")
  .min(0, "must be >= 0 (0 tears work down the moment the run settles)");

const urlSchema = z.string().refine(
  (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be an absolute URL" },
);

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function int(
  env: Record<string, string | undefined>,
  name: string,
  schema: z.ZodType<number, unknown>,
  fallback?: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    if (fallback === undefined) {
      throw new Error(`${name} is required`);
    }
    return fallback;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${name}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return result.data;
}

function url(env: Record<string, string | undefined>, name: string): string {
  const value = required(env, name);
  const result = urlSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${name}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return value;
}

function csv(env: Record<string, string | undefined>, name: string): string[] {
  const value = required(env, name);
  return splitCsv(value);
}

/**
 * The value-taking variant: a variable that is unset or empty yields the
 * fallback, so a caller can accept a possibly-empty list. csv() cannot
 * offer that because it hard-codes required().
 */
function csvOf(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string[],
): string[] {
  const raw = optional(env, name);
  return raw === undefined ? fallback : splitCsv(raw);
}

/**
 * An enum-valued variable: unset or empty yields the default, and any other
 * value must name an explicit member — the value list is the configuration's
 * whole surface, with no silent fallback beyond the default.
 */
function oneOf<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!values.includes(raw as T)) {
    throw new Error(`${name}: must be one of ${values.join(", ")}`);
  }
  return raw as T;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * The account-name shape the deployment's identity variables carry: a
 * conservative charset (letters, digits, dot, underscore, hyphen,
 * starting with a letter or digit), minus the comma the CSV rendering
 * cannot carry. The module's option type enforces the same pattern at
 * eval time; this re-check catches a value set in the environment by
 * hand, at boot, naming the variable and the offending entry.
 */
const accountNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "must be an account name (letters, digits, dot, underscore, hyphen, starting with a letter or digit)",
  );

/**
 * An identity variable's list: unset or empty yields the empty default,
 * and every entry must be an account name.
 */
function accountNames(
  env: Record<string, string | undefined>,
  name: string,
): string[] {
  const entries = csvOf(env, name, []);
  for (const entry of entries) {
    const result = accountNameSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(`${name}: '${entry}' ${result.error.issues[0]?.message}`);
    }
  }
  return entries;
}

/**
 * Every ZENIGATA_-prefixed variable loadConfig reads — the configuration's
 * whole surface. An environment naming a variable outside this set fails
 * at boot naming itself, instead of being silently swallowed: an unknown
 * variable is as unrepairable as a missing one. A value that trims empty
 * is treated as unset (the contract optional() and csvOf() honor) and is
 * not named.
 */
const KNOWN_VARIABLES: readonly string[] = [
  "ZENIGATA_LISTEN_PORT",
  "ZENIGATA_STATE_DIR",
  "ZENIGATA_ALLOWED_LOGINS",
  "ZENIGATA_ALLOWED_REPOS",
  "ZENIGATA_HUMANS",
  "ZENIGATA_PERSONA_FILE",
  "ZENIGATA_ADAPTER_URL",
  "ZENIGATA_FORGE_URL",
  "ZENIGATA_ADAPTER_TOKEN",
  "ZENIGATA_EVENT_TOKEN",
  "ZENIGATA_OPENCODE_URL",
  "ZENIGATA_OPENCODE_KEY",
  "ZENIGATA_MEMORY_URL",
  "ZENIGATA_REVIEW_TIMEOUT_SECONDS",
  "ZENIGATA_WORKTREES_DIR",
  "ZENIGATA_TURN_POLL_SECONDS",
  "ZENIGATA_TURN_BUDGET_SECONDS",
  "ZENIGATA_RETENTION_WINDOW_SECONDS",
  "ZENIGATA_RETRY_POLICY",
  "ZENIGATA_AGENT",
];

/**
 * Variables a configuration can no longer carry: the unknown-variable
 * check consults this map so a retired name fails with its own removal
 * note instead of a generic unknown-variable refusal.
 */
const RETIRED_VARIABLES: Readonly<Record<string, string>> = {
  ZENIGATA_AGENTS:
    "retired (PRJ-518); remove the variable from the configuration",
  ZENIGATA_ACCESS:
    "retired (PRJ-518); remove the variable from the configuration",
};

/**
 * The loud end of the variable surface: a retired name carries its own
 * removal note, any other unknown ZENIGATA_-prefixed variable refuses as
 * unknown, and both reach every loadConfig caller — the boot, the
 * --check-config gate, the tests.
 */
function refuseForeignVariables(env: Record<string, string | undefined>): void {
  const refusals: string[] = [];
  for (const name of Object.keys(env)
    .filter((name) => name.startsWith("ZENIGATA_"))
    .sort()) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      continue;
    }
    const retired = RETIRED_VARIABLES[name];
    if (retired !== undefined) {
      refusals.push(`${name}: ${retired}`);
    } else if (!KNOWN_VARIABLES.includes(name)) {
      refusals.push(`${name}: unknown configuration variable`);
    }
  }
  if (refusals.length > 0) {
    throw new Error(refusals.join("; "));
  }
}

/** Parse configuration from an environment-shaped record. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  refuseForeignVariables(env);
  const stateDir = required(env, "ZENIGATA_STATE_DIR");
  return {
    listenPort: int(env, "ZENIGATA_LISTEN_PORT", portSchema, 8471),
    stateDir,
    allowedLogins: csv(env, "ZENIGATA_ALLOWED_LOGINS"),
    allowedRepos: csvOf(env, "ZENIGATA_ALLOWED_REPOS", []),
    humans: accountNames(env, "ZENIGATA_HUMANS"),
    personaFile: optional(env, "ZENIGATA_PERSONA_FILE"),
    adapterUrl: url(env, "ZENIGATA_ADAPTER_URL"),
    forgeUrl: url(env, "ZENIGATA_FORGE_URL"),
    adapterToken: required(env, "ZENIGATA_ADAPTER_TOKEN"),
    eventToken: required(env, "ZENIGATA_EVENT_TOKEN"),
    opencodeUrl: url(env, "ZENIGATA_OPENCODE_URL"),
    opencodeKey: optional(env, "ZENIGATA_OPENCODE_KEY"),
    memoryUrl: url(env, "ZENIGATA_MEMORY_URL"),
    reviewTimeoutSeconds: int(
      env,
      "ZENIGATA_REVIEW_TIMEOUT_SECONDS",
      secondsSchema,
      1800,
    ),
    agent: optional(env, "ZENIGATA_AGENT") ?? "zenigata-reviewer",
    worktreesDir:
      optional(env, "ZENIGATA_WORKTREES_DIR") ?? `${stateDir}/worktrees`,
    turnPollSeconds: int(env, "ZENIGATA_TURN_POLL_SECONDS", secondsSchema, 3),
    turnBudgetSeconds: int(
      env,
      "ZENIGATA_TURN_BUDGET_SECONDS",
      secondsSchema,
      900,
    ),
    retentionWindowSeconds: int(
      env,
      "ZENIGATA_RETENTION_WINDOW_SECONDS",
      nonNegativeSecondsSchema,
      86_400,
    ),
    retryPolicy: oneOf(
      env,
      "ZENIGATA_RETRY_POLICY",
      RETRY_POLICY_VALUES,
      "never",
    ),
  };
}
