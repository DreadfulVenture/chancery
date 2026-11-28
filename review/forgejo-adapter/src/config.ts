/**
 * Environment-driven configuration. Every validation failure names the
 * offending variable so a misconfigured deployment fails at boot with the
 * exact variable to fix.
 */

import { z } from "zod";

export interface Config {
  listenPort: number;
  forgeBaseUrl: string;
  forgeToken: string;
  outboundToken: string;
  intakeUrl: string;
  eventToken: string;
  webhookSecret: string;
  requestTimeoutMs: number;
}

const portSchema = z.coerce
  .number()
  .int("must be an integer")
  .min(0, "must be >= 0 (0 lets the OS pick the listen port)")
  .max(65535, "must be <= 65535 (the largest TCP port number)");

const positiveIntSchema = z.coerce
  .number()
  .int("must be an integer")
  .positive("must be > 0");

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
  return value.replace(/\/+$/, "");
}

/** Parse configuration from an environment-shaped record. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    listenPort: int(env, "FORGEJO_ADAPTER_LISTEN_PORT", portSchema, 8472),
    forgeBaseUrl: url(env, "FORGEJO_BASE_URL"),
    forgeToken: required(env, "FORGEJO_TOKEN"),
    outboundToken: required(env, "ZENIGATA_ADAPTER_TOKEN"),
    intakeUrl: url(env, "ZENIGATA_INTAKE_URL"),
    eventToken: required(env, "ZENIGATA_EVENT_TOKEN"),
    webhookSecret: required(env, "FORGEJO_WEBHOOK_SECRET"),
    requestTimeoutMs: int(
      env,
      "FORGEJO_ADAPTER_REQUEST_TIMEOUT_MS",
      positiveIntSchema,
      30_000,
    ),
  };
}
