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
   * The deployment's identity arrays and access list (PRJ-505): humans
   * classifies accounts whose thread prose is a human's words, agents
   * names accounts known to be agents, and access names the accounts
   * whose review requests and replies the thin pipeline will serve.
   * Named, validated, and carried to the review session's start prompt
   * as data; their consumers arrive with later slices, and nothing else
   * in the current pipeline reads them.
   */
  humans: string[];
  agents: string[];
  access: string[];
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

/** Parse configuration from an environment-shaped record. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const stateDir = required(env, "ZENIGATA_STATE_DIR");
  return {
    listenPort: int(env, "ZENIGATA_LISTEN_PORT", portSchema, 8471),
    stateDir,
    allowedLogins: csv(env, "ZENIGATA_ALLOWED_LOGINS"),
    allowedRepos: csvOf(env, "ZENIGATA_ALLOWED_REPOS", []),
    humans: accountNames(env, "ZENIGATA_HUMANS"),
    agents: accountNames(env, "ZENIGATA_AGENTS"),
    access: accountNames(env, "ZENIGATA_ACCESS"),
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
