// The daemon's local route (PRJ-540): the registration surface the
// watcher tools in opencode sessions proxy to. The daemon binds
// loopback only — the route serves the same user's processes, the same
// trust domain the host's registration file lives in, and it carries no
// credentials in either direction: the forge and source tokens live in
// the daemon's own environment and are never part of any request or
// answer here. A caller names the session it acts for (the session id
// the tool context carries); the route is id-addressable within that
// same-user trust domain, exactly as the host's wake schedule is.
//
// The four routes map one to one onto the watcher tools' needs:
//
// - POST /register {sessionID, kind, repo, ref, note}  → the kernel's
//   register outcome (claimed / existing / registered), or a named
//   error — the same error text the kernel throws, surfaced by the tool.
// - POST /forget {sessionID, id}                       → {ok, id}.
// - GET  /list?session=<id>                            → the session's
//   stamp rows, raw; the tool renders them.
// - GET  /state?repo=<owner/name>                      → the projection's
//   board answer, raw; the tool wraps it.
//
// The route is transport only: every rule (claim groups, owner checks,
// the stamp discipline) stays in the kernel this file calls.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "../kernel.ts";
import type { RegisterOutcome, StampRow } from "../kernel.ts";

export type RouteDeps = {
  register: (
    req: Record<string, unknown>,
    caller: string,
  ) => Promise<RegisterOutcome>;
  forget: (id: string, caller: string) => Promise<void>;
  stampsOf: (sessionID: string) => Promise<StampRow[] | null | undefined>;
  stateOf: (repo: string | null) => Promise<unknown>;
};

export type RouteServer = {
  url: string;
  port: number;
  /** The node server itself; a test attaches its request capture here. */
  server: http.Server;
  close: () => Promise<void>;
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

// The POST body's record: an empty body is an empty record; anything
// else must parse to a JSON record.
const bodyOf = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const text = await readBody(request);
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the request body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the request body is not a JSON record");
  }
  return parsed as Record<string, unknown>;
};

// The route's start: binds the loopback address (never a wildcard — a
// route that answered off-host would carry the registration surface
// beyond its trust domain) and resolves once listening, so a caller
// knows the url is live.
export const startRoute = ({
  host = "127.0.0.1",
  port,
  register,
  forget,
  stampsOf,
  stateOf,
}: RouteDeps & { host?: string; port: number }): Promise<RouteServer> =>
  new Promise((resolve, reject) => {
    const inner = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1`);
      try {
        if (
          request.method === "POST" &&
          (url.pathname === "/register" || url.pathname === "/forget")
        ) {
          // The body is read exactly once per request: the stream does
          // not replay.
          const body = await bodyOf(request);
          const sessionID =
            typeof body.sessionID === "string" ? body.sessionID.trim() : "";
          if (!sessionID) {
            json(response, 400, {
              error: `the ${url.pathname.slice(1)} request carries no session id`,
            });
            return;
          }
          if (url.pathname === "/register") {
            const outcome = await register(body, sessionID);
            json(response, 200, outcome);
            return;
          }
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            json(response, 400, {
              error: "the forget request carries no watch id",
            });
            return;
          }
          await forget(id, sessionID);
          json(response, 200, { ok: true, id });
          return;
        }
        if (request.method === "GET" && url.pathname === "/list") {
          const sessionID = url.searchParams.get("session")?.trim() ?? "";
          if (!sessionID) {
            json(response, 400, {
              error: "the list request carries no session id",
            });
            return;
          }
          const rows = await stampsOf(sessionID);
          json(response, 200, { ok: true, rows: rows ?? [] });
          return;
        }
        if (request.method === "GET" && url.pathname === "/state") {
          const repo = url.searchParams.get("repo")?.trim() ?? "";
          const board = await stateOf(repo || null);
          if (isRecord(board) && typeof board.unavailable === "string") {
            json(response, 200, { ok: false, error: board.unavailable });
            return;
          }
          json(response, 200, {
            ok: true,
            ...(repo ? { repo } : {}),
            ...board,
          });
          return;
        }
        json(response, 404, {
          error: `no route ${request.method} ${url.pathname}`,
        });
      } catch (error) {
        // A domain error (a bad kind, a claimed watch, a stamp write
        // that failed) is the caller's to see: the kernel's own error
        // text, unchanged. Anything else is the same answer — the route
        // never leaks a stack, and it has no credential to leak.
        json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    inner.on("error", reject);
    inner.listen(port, host, () => {
      const address = inner.address();
      const bound =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${bound}`,
        port: bound,
        server: inner,
        close: () =>
          new Promise<void>((done) => {
            inner.close(() => done());
          }),
      });
    });
  });
