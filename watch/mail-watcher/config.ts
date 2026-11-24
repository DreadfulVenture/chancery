// The forge source's config: the watcher options block (the source's
// namespace is the block's own keys — today's surface) plus the
// adapter's environment. The data source is the Forgejo REST API
// directly (the operator's ruling on #89, superseding the MCP surface
// the poller rode until now): the MCP layer's shapes and paging/clamping
// cost the projection its blocking review count, and the same endpoints
// it wraps are plain API reads with predictable paging. The credentials
// are the adapter's own — the deployment sets FORGEJO_BASE_URL and
// FORGEJO_TOKEN the way the forgejo-adapter's unit carries them, and
// options.watcher overrides per entry (options winning per key, the
// poll cadence's pattern). A missing base url or token, or a bad poll
// cadence, disables the plugin at init: setup throws, OpenCode logs it
// and runs the other plugins without this one. Every read is one GET
// against /api/v1 with the token header; the answers pass zod at the
// boundary before anything reads them, and a failure names the route —
// never the url, never the token.
//
// The token never rides an error message or a log line.

import os from "node:os";

import { isRecord } from "./kernel.ts";

function debugOf() {
  let level = "";
  try {
    level = (process.env.MEMORY_SPAN_LOG || "").toLowerCase();
  } catch {
    level = "";
  }
  return (op, attrs = {}) => {
    if (level !== "debug") return;
    const parts = Object.entries(attrs).map(
      ([key, value]) => `${key}=${value}`,
    );
    console.error(`[forgejo-watcher] ${op} ${parts.join(" ")}`);
  };
}

const DEFAULT_POLL_SECONDS = 30;

// Config rides the operator's opencode config surface: the plugin's entry
// options (options.watcher of a plugins entry) for the forge's base url
// and token, the poll cadence, and the projection's database file, with
// every one of them also readable from the process environment the host
// runs with (options winning per key) — the environment names being the
// adapter's own (FORGEJO_BASE_URL, FORGEJO_TOKEN), so a deployment
// provisions the credential once and both consumers carry it. The base
// url and the token have no default and no other route: a plugin found
// by scanning a plugins directory is loaded with empty options, so the
// watcher is shipped as a directory plugin the deployment names in its
// config. The token never rides an error message or a log line.
const defaultDbPath = () => {
  const state =
    typeof process === "object" && process.env.XDG_STATE_HOME
      ? process.env.XDG_STATE_HOME
      : `${os.homedir()}/.local/state`;
  return `${state}/forgejo-watcher/pr-state.db`;
};

// The forge source's side of the watcher config: the watcher options
// block (the source's namespace is the block's own keys — today's
// surface) plus the adapter's environment. The thrown messages are the
// source's ready reasons, named once.
const readConfigOf = (watcher) => {
  const options = isRecord(watcher) ? watcher : {};
  const env = typeof process === "object" ? process.env : {};

  const rawForgeUrl = options.forgeUrl ?? env.FORGEJO_BASE_URL;
  if (
    typeof rawForgeUrl !== "string" ||
    rawForgeUrl.trim() === "" ||
    rawForgeUrl.trim() === "null"
  ) {
    throw new Error(
      "[forgejo-watcher] no forge base url — set options.watcher.forgeUrl on the watcher's plugins entry, or FORGEJO_BASE_URL in the host's environment (the adapter's own variable); the watcher is off",
    );
  }
  let forgeUrl;
  try {
    const parsed = new URL(rawForgeUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
    // The base keeps the origin and any mount path (a reverse-proxy
    // prefix), trailing slashes trimmed: the REST client composes the
    // /api/v1 routes under it, so a forge served at a subpath composes
    // cleanly and a root-hosted forge carries none.
    forgeUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new Error(
      `[forgejo-watcher] watcher forgeUrl must be the forge's http(s) base url (got ${JSON.stringify(rawForgeUrl)})`,
    );
  }

  const rawForgeToken = options.forgeToken ?? env.FORGEJO_TOKEN;
  if (
    typeof rawForgeToken !== "string" ||
    rawForgeToken.trim() === "" ||
    rawForgeToken.trim() === "null"
  ) {
    throw new Error(
      "[forgejo-watcher] no forge token — set options.watcher.forgeToken on the watcher's plugins entry, or FORGEJO_TOKEN in the host's environment (the adapter's own variable); the watcher is off",
    );
  }

  const rawPoll = options.pollSeconds ?? env.WATCHER_POLL_SECONDS;
  let pollSeconds = DEFAULT_POLL_SECONDS;
  if (rawPoll !== undefined) {
    const parsed = Number(rawPoll);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `[forgejo-watcher] watcher pollSeconds must be a positive number (got ${JSON.stringify(rawPoll)})`,
      );
    }
    pollSeconds = parsed;
  }
  const rawDbPath = options.dbPath ?? env.WATCHER_DB_PATH;
  if (
    rawDbPath !== undefined &&
    (typeof rawDbPath !== "string" || rawDbPath.trim() === "")
  ) {
    throw new Error(
      `[forgejo-watcher] watcher dbPath must be the projection's sqlite file (got ${JSON.stringify(rawDbPath)})`,
    );
  }
  return {
    forge: { url: forgeUrl, token: rawForgeToken.trim() },
    pollMs: pollSeconds * 1000,
    dbPath: rawDbPath === undefined ? defaultDbPath() : rawDbPath.trim(),
  };
};

// The forge source's ready: the config read, as an ok/ok:false verdict.
// The plugin's setup calls it first (a false verdict throws — the plugin
// is off, today's behavior), and the kernel calls it again at
// construction; the same block reads the same answer.
const forgejoReady = (watcherOptions) => {
  try {
    return { ok: true, config: readConfigOf(watcherOptions) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
};

export { debugOf, forgejoReady };
