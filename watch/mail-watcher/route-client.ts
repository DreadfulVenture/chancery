// The route client (PRJ-540): the plugin side of the split. The tools
// in an opencode session know no forge credential and no kernel — they
// carry the caller's session id and their arguments to the watcher
// daemon's local route, and render the answer exactly as the in-process
// kernel's answers rendered before the split (the tool schemas and
// result strings are byte-identical; only the transport changed). The
// route url rides the plugin's options (options.watcher.daemonUrl) or
// the host's environment (WATCHER_DAEMON_URL), defaulting to the
// daemon's loopback port; a route that cannot be reached is a named
// error on the tool call — the plugin has no init-throw anymore, since
// the daemon may start after opencode and the tools stay registered
// either way.

const ROUTE_URL_DEFAULT = "http://127.0.0.1:8473";

const HTTP_TIMEOUT_MS = 15_000;

export type RouteConfig = {
  url: string;
  /** The per-call timeout; the tests' knob, the daemon's default otherwise. */
  timeoutMs?: number;
};

export const routeConfig = (ctx: unknown): RouteConfig => {
  const host =
    ctx !== null && typeof ctx === "object" && !Array.isArray(ctx)
      ? (ctx as Record<string, unknown>)
      : {};
  const options =
    host.options !== null &&
    typeof host.options === "object" &&
    !Array.isArray(host.options)
      ? (host.options as Record<string, unknown>)
      : {};
  const watcher =
    options.watcher !== null &&
    typeof options.watcher === "object" &&
    !Array.isArray(options.watcher)
      ? (options.watcher as Record<string, unknown>)
      : {};
  const env = typeof process === "object" ? process.env : {};
  const raw =
    (typeof watcher.daemonUrl === "string" &&
    watcher.daemonUrl.trim() !== "" &&
    watcher.daemonUrl.trim() !== "null"
      ? watcher.daemonUrl.trim()
      : undefined) ??
    (typeof env.WATCHER_DAEMON_URL === "string" &&
    env.WATCHER_DAEMON_URL.trim() !== "" &&
    env.WATCHER_DAEMON_URL.trim() !== "null"
      ? env.WATCHER_DAEMON_URL.trim()
      : undefined) ??
    ROUTE_URL_DEFAULT;
  return { url: raw.replace(/\/+$/, "") };
};

export type RouteClient = {
  url: string;
  register: (
    input: Record<string, unknown>,
    sessionID: string,
  ) => Promise<Record<string, unknown>>;
  forget: (id: string, sessionID: string) => Promise<Record<string, unknown>>;
  list: (sessionID: string) => Promise<Record<string, unknown>>;
  state: (repo: string | null) => Promise<Record<string, unknown>>;
};

// A route answer the route refused (a bad kind, a claimed watch, a
// stamp write that failed) arrives as {error} — thrown as an Error
// carrying the route's own text, which is the kernel's error text
// unchanged.
const call = async (
  url: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
) => {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new Error(
        `the watcher daemon at ${url} did not answer in time: ${path}`,
      );
    }
    throw new Error(
      `the watcher daemon is unreachable at ${url} (${(error as Error)?.message ?? error}); is the watcher-daemon service running?`,
    );
  }
  const text = await response.text().catch(() => "");
  let body: unknown = undefined;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `the watcher daemon at ${url} answered a non-JSON body on ${path}`,
      );
    }
  }
  if (!response.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).error === "string"
        ? (body as Record<string, unknown>).error
        : `HTTP ${response.status} ${response.statusText || "request failed"}`;
    throw new Error(String(message));
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      `the watcher daemon at ${url} answered without a record on ${path}`,
    );
  }
  return body as Record<string, unknown>;
};

export const routeClient = (config: RouteConfig): RouteClient => {
  const { url, timeoutMs = HTTP_TIMEOUT_MS } = config;
  const post = (path: string, body: unknown) =>
    call(url, path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);
  return {
    url,
    register: (input, sessionID) => post("/register", { ...input, sessionID }),
    forget: (id, sessionID) => post("/forget", { id, sessionID }),
    list: (sessionID) =>
      call(
        url,
        `/list?session=${encodeURIComponent(sessionID)}`,
        { method: "GET" },
        timeoutMs,
      ),
    state: (repo) =>
      call(
        url,
        `/state${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
        { method: "GET" },
        timeoutMs,
      ),
  };
};
