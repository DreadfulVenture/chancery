// The daemon's host leg (PRJ-540): the opencode server's session API and
// event stream, shaped as the kernel's KernelContext (kernel.ts). The
// daemon runs outside any opencode process — it is the credential-free
// watcher the operator's ruling asked for — so its stamp reads and
// writes, its synthetic mail, and its session-event adoption ride the
// host's HTTP API instead of a plugin ctx:
//
// - GET    /api/session               — the adoption walk's list
// - GET    /api/session/:id           — a stamp read
// - PATCH  /api/session/:id           — a stamp write (metadata replace)
// - POST   /api/session/:id/synthetic — the mail leg
// - GET    /api/event (SSE)           — the event stream the kernel
//                                       subscribes to
//
// Discovery follows the host's own clients (the oc-wake bin's rule): the
// registration file ($XDG_STATE_HOME/opencode/service.json, 0600) names
// the service url and local password, Basic auth user "opencode". A
// deployment that runs the daemon as its own unit — where a DynamicUser
// sandbox cannot read the operator's home — feeds the daemon its own
// WATCHER_OPENCODE_URL / WATCHER_OPENCODE_PASSWORD environment instead;
// the environment wins over the registration file. The password is a
// host credential, never a forge credential: it stays inside the daemon
// process, rides no route the watcher proxy sees, and never rides an
// error message or a log line.

import { readFileSync } from "node:fs";
import os from "node:os";

import { isRecord } from "../kernel.ts";

const HTTP_TIMEOUT_MS = 15_000;

const stateRoot = () =>
  typeof process.env.XDG_STATE_HOME === "string" && process.env.XDG_STATE_HOME
    ? process.env.XDG_STATE_HOME
    : `${os.homedir()}/.local/state`;

const serviceFileDefault = () => `${stateRoot()}/opencode/service.json`;

// The registration file's read, the oc-wake bin's parse: a JSON record
// whose url is required and whose password is optional.
type Registration =
  | { ok: true; url?: string; password?: string }
  | { ok: false; reason: string };

const readRegistration = (file: string): Registration => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `no opencode service registration at ${file} (${(error as { code?: string })?.code ?? error})`,
    };
  }
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: `the service registration at ${file} is not JSON`,
    };
  }
  if (!isRecord(info)) {
    return {
      ok: false,
      reason: `the service registration at ${file} is not a record`,
    };
  }
  const url = typeof info.url === "string" ? info.url : undefined;
  const password =
    typeof info.password === "string" ? info.password : undefined;
  return {
    ok: true,
    ...(url ? { url } : {}),
    ...(password ? { password } : {}),
  };
};

// The env's read: present, non-empty, and not the string "null" — the
// same test the sources' config reads run on their variables.
const usable = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.trim() !== "null";

export type HostConfig = {
  /** The opencode server's base url, when the deployment states it outright. */
  url?: string;
  /** The server's local password, when the deployment states it outright. */
  password?: string;
  /** The registration file; defaults to the host's own location. */
  serviceFile?: string;
};

// The host's resolved endpoint: the url the session API rides and the
// auth header's password, or the named reason neither could be read.
export type ResolvedHost =
  | { ok: true; url: string; password?: string }
  | { ok: false; reason: string };

export const resolveHost = (config: HostConfig = {}): ResolvedHost => {
  const env = typeof process === "object" ? process.env : {};
  const serviceFile = config.serviceFile ?? serviceFileDefault();
  let registration: Registration = { ok: true };
  if (!usable(config.url) && !usable(env.WATCHER_OPENCODE_URL)) {
    registration = readRegistration(serviceFile);
    if (!registration.ok) {
      return {
        ok: false,
        reason: `no opencode server url — set WATCHER_OPENCODE_URL in the daemon's environment, or point the registration file at it (${serviceFile}; the registration read failed: ${registration.reason})`,
      };
    }
  }
  const url =
    (usable(config.url) ? config.url.trim() : undefined) ??
    (usable(env.WATCHER_OPENCODE_URL)
      ? env.WATCHER_OPENCODE_URL.trim()
      : undefined) ??
    registration.url;
  if (!url) {
    return {
      ok: false,
      reason: `no opencode server url — set WATCHER_OPENCODE_URL in the daemon's environment, or point the registration file at it (${serviceFile})`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
  } catch {
    return {
      ok: false,
      reason: `the opencode server url must be http(s) (got ${JSON.stringify(url)})`,
    };
  }
  const password =
    (usable(config.password) ? config.password.trim() : undefined) ??
    (usable(env.WATCHER_OPENCODE_PASSWORD)
      ? env.WATCHER_OPENCODE_PASSWORD.trim()
      : undefined) ??
    registration.password;
  return {
    ok: true,
    url: url.replace(/\/+$/, ""),
    ...(password ? { password } : {}),
  };
};

// The KernelContext over the server API. Reads and writes keep the
// kernel's own error discipline: a failed call throws a named error —
// the route and the status, never the password — and the kernel's
// callers catch and say it on their own lines. The reconnect timing is
// the tests' knob; the daemon runs the defaults.
export const hostContext = (
  host: ResolvedHost & { ok: true },
  opts?: { reconnectBaseMs?: number; reconnectMaxMs?: number },
) => {
  const base = `${host.url}/api`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (host.password) {
    headers.Authorization = `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}`;
  }

  const call = async (
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ) => {
    const route = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) route.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await fetch(route, {
        method,
        headers: {
          ...headers,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`${method} ${path} → ${error?.message ?? error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `${method} ${path} → HTTP ${response.status} ${response.statusText || "request failed"}`,
      );
    }
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} → an unparseable JSON answer`);
    }
  };

  const unwrap = (answered: unknown) =>
    isRecord(answered) && "data" in answered ? answered.data : answered;

  // One stream: the connection, the reader, and the yield loop. A
  // transport failure or a clean end throws/returns to the reconnect
  // loop above; the reader is released either way.
  const oneStream = async function* (signal: AbortSignal) {
    let response: Response;
    try {
      response = await fetch(`${base}/event`, {
        headers,
        signal,
      });
    } catch (error) {
      throw new Error(`GET /event → ${error?.message ?? error}`);
    }
    if (!response.ok || !response.body) {
      throw new Error(
        `GET /event → HTTP ${response.status} ${response.statusText || "request failed"}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        // A clean end answers value: undefined, and decode(undefined,
        // {stream: false}) is the legal final flush — a stand-in object
        // here would throw before the done handling below runs, so a
        // graceful close would be misreported as a failure and any
        // trailing unterminated block would be dropped.
        buffer += decoder.decode(next.value, { stream: !next.done });
        if (next.done && buffer === "") return;
        if (next.done) buffer += "\n\n";
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .flatMap((line) =>
              line.startsWith("data:") ? [line.slice(5).trimStart()] : [],
            )
            .join("\n");
          if (data !== "") {
            try {
              yield JSON.parse(data) as { type: string; data?: unknown };
            } catch {
              // A malformed SSE block is skipped, not fatal: the
              // stream carries events the kernel filters by type.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (next.done) return;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already ending.
      }
      reader.releaseLock();
    }
  };

  // The backoff's wait, abort-aware: false when the signal fired during
  // the wait (the caller stops), true when the wait ran out.
  const sleepUntil = (ms: number, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  return {
    session: {
      get: async (input: { sessionID: string }) =>
        unwrap(
          await call("GET", `/session/${encodeURIComponent(input.sessionID)}`),
        ),
      list: async (input?: { cursor?: unknown }) =>
        call("GET", "/session", {
          query: {
            cursor:
              input?.cursor === undefined ? undefined : String(input.cursor),
          },
        }),
      update: async (input: {
        sessionID: string;
        metadata: Record<string, unknown>;
      }) =>
        call("PATCH", `/session/${encodeURIComponent(input.sessionID)}`, {
          body: { metadata: input.metadata },
        }),
      synthetic: async (input: { sessionID: string; text: string }) =>
        unwrap(
          await call(
            "POST",
            `/session/${encodeURIComponent(input.sessionID)}/synthetic`,
            {
              body: { text: input.text },
            },
          ),
        ),
    },
    event: {
      // The server's event stream, parsed the client's way (the SSE
      // reader in the generated client): data lines, one JSON event per
      // block, yielded as the kernel's {type, data?} records.
      //
      // The stream outlives the server: a host restart closes the SSE
      // body, and without reconnect the generator would return and the
      // kernel's for-await would exit silently — deleted-session
      // cleanup and new-session adoption would stop with nothing looking
      // broken from outside (zenigata review 700, comment 19377). So
      // this generator reconnects itself: a stream that ends or fails
      // retries after a backoff that doubles from the base and resets
      // once a stream delivers again; the abort signal is the only way
      // out. Each attempt is said on its own line, and the retry never
      // carries credentials in the error text.
      subscribe: async function* (input: { signal: AbortSignal }) {
        const baseMs = opts?.reconnectBaseMs ?? 1_000;
        const maxMs = opts?.reconnectMaxMs ?? 30_000;
        let delay = baseMs;
        while (!input.signal.aborted) {
          let delivered = false;
          try {
            for await (const event of oneStream(input.signal)) {
              delivered = true;
              yield event;
            }
            if (input.signal.aborted) return;
            console.error(
              `[forgejo-watcher] the host's event stream ended; reconnecting in ${delay}ms`,
            );
          } catch (error) {
            if (input.signal.aborted) return;
            console.error(
              `[forgejo-watcher] the host's event stream failed: ${
                error instanceof Error ? error.message : error
              }; reconnecting in ${delay}ms`,
            );
          }
          // The sleep is abort-aware: a stop during the backoff ends the
          // subscription promptly instead of after the delay.
          if (!(await sleepUntil(delay, input.signal))) return;
          delay = delivered ? baseMs : Math.min(delay * 2, maxMs);
        }
      },
    },
  };
};

export { readRegistration, serviceFileDefault };
