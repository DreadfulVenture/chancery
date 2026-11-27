/**
 * The acceptance harness's local fakes (PRJ-548): one server carrying the
 * three surfaces the service-shaped invocation needs on loopback —
 *
 *   - the forge adapter fake the BOT talks to (the adapter contract of
 *     src/adapters/forge.ts: PR shape, diff, posted-review lookup, the
 *     POST /review the run's outcome reads back through);
 *   - the MCP forge server the REVIEWER SESSION posts through (the
 *     deployment's override wires it; the v2.3.0 serve mounts its tools
 *     as <server>_<tool>, here `ztforge_create_review`), whose tool call
 *     lands the same review on the adapter fake's record — one forge
 *     state, two doors;
 *   - the events feed (GET /events) the runner asserts from.
 *
 * Streamable-HTTP MCP by hand: JSON-RPC over POST, one JSON response per
 * request, an Mcp-Session-Id header minted at initialize, and a 405 for
 * the optional GET stream the SDK may probe. The SDK client (the serve's
 * side) negotiates the protocol version it sent.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { writeFileSync } from "node:fs";

interface ReviewPost {
  at: number;
  repo: string;
  pr: number;
  expectedHeadSha: string;
  verdict: string;
  body: string;
  comments: unknown;
  via: "adapter" | "mcp";
}

interface FakeEvent {
  kind:
    | "pr-fetch"
    | "diff-fetch"
    | "lookup"
    | "review-post"
    | "mcp-call"
    | "mcp-error";
  at: number;
  detail?: unknown;
}

const HEAD_SHA = process.env.ZT_FAKE_HEAD_SHA ?? "";
const BASE_SHA = process.env.ZT_FAKE_BASE_SHA ?? "";
const CLONE_URL = process.env.ZT_FAKE_CLONE_URL ?? "";
const REPO = process.env.ZT_FAKE_REPO ?? "zt-accept/widgets";
const PR = Number(process.env.ZT_FAKE_PR ?? 7);

const events: FakeEvent[] = [];
const posts: ReviewPost[] = [];

const DIFF = [
  "diff --git a/README.md b/README.md",
  "index 1111111..2222222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " base line",
  "+changed line",
  "",
].join("\n");

function prShape(): Record<string, unknown> {
  return {
    repo: REPO,
    pr: PR,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    headRef: "main",
    baseRef: "base",
    cloneUrl: CLONE_URL,
    title: "The acceptance fixture change",
    body: "Fixture PR body: one commit, one changed line.",
    isFork: false,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The MCP tool's forwarded post — the same record the adapter's own
 * POST /review writes, so the bookkeeping lookup sees one landed review
 * no matter which door posted it. */
function landReview(
  payload: {
    repo?: unknown;
    pr?: unknown;
    expectedHeadSha?: unknown;
    verdict?: unknown;
    body?: unknown;
    comments?: unknown;
  },
  via: ReviewPost["via"],
): { ok: boolean; reason?: string } {
  if (payload.expectedHeadSha !== HEAD_SHA) {
    return { ok: false, reason: "expectedHeadSha mismatch: the head moved" };
  }
  const post: ReviewPost = {
    at: Date.now(),
    repo: String(payload.repo ?? REPO),
    pr: Number(payload.pr ?? PR),
    expectedHeadSha: String(payload.expectedHeadSha ?? ""),
    verdict: String(payload.verdict ?? "APPROVE"),
    body: String(payload.body ?? ""),
    comments: payload.comments ?? [],
    via,
  };
  posts.push(post);
  events.push({
    kind: "review-post",
    at: post.at,
    detail: { via, body: post.body },
  });
  return { ok: true };
}

function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
): void {
  let rpc: {
    id?: number | string;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: unknown };
  };
  try {
    rpc = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "bad json" });
    return;
  }
  if (rpc.method === "initialize") {
    res.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "zt-accept-session",
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "ztforge", version: "0.0.1" },
        },
      }),
    );
    return;
  }
  if (rpc.method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }
  if (rpc.method === "tools/list") {
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        tools: [
          {
            name: "create_review",
            description: "Post the review payload to the acceptance forge fake",
            inputSchema: {
              type: "object",
              properties: {
                repo: { type: "string" },
                pr: { type: "number" },
                expectedHeadSha: { type: "string" },
                verdict: { type: "string" },
                body: { type: "string" },
                comments: { type: "array" },
              },
              required: ["repo", "pr", "expectedHeadSha", "verdict", "body"],
            },
          },
        ],
      },
    });
    return;
  }
  if (rpc.method === "tools/call" && rpc.params?.name === "create_review") {
    events.push({
      kind: "mcp-call",
      at: Date.now(),
      detail: rpc.params.arguments,
    });
    const landed = landReview(
      rpc.params.arguments as Record<string, unknown>,
      "mcp",
    );
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        content: [
          {
            type: "text",
            text: landed.ok
              ? `ztforge-accepted review-${posts.length}`
              : `ztforge-refused: ${landed.reason}`,
          },
        ],
      },
    });
    return;
  }
  events.push({ kind: "mcp-error", at: Date.now(), detail: rpc.method });
  json(res, 200, {
    jsonrpc: "2.0",
    id: rpc.id,
    error: { code: -32601, message: `no handler for ${rpc.method}` },
  });
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.method === "POST" && req.url?.split("?")[0] === "/mcp") {
      handleMcp(req, res, raw);
      return;
    }
    if (req.method === "GET" && req.url?.split("?")[0] === "/mcp") {
      // The SDK's optional server-stream probe: no server-initiated
      // stream is offered here, and a 405 says so per the spec.
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/pr?")) {
      events.push({ kind: "pr-fetch", at: Date.now() });
      json(res, 200, prShape());
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/pr/diff")) {
      events.push({ kind: "diff-fetch", at: Date.now() });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(DIFF);
      return;
    }
    if (req.method === "POST" && req.url?.split("?")[0] === "/review") {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const landed = landReview(payload, "adapter");
        if (!landed.ok) {
          json(res, 409, { error: landed.reason });
          return;
        }
        json(res, 200, {
          reviewCommentId: `rev-${posts.length}`,
          commentRefs: [],
        });
      } catch {
        json(res, 400, { error: "bad json" });
      }
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/review?")) {
      events.push({ kind: "lookup", at: Date.now() });
      const post = posts.at(-1);
      if (!post) {
        res.writeHead(404);
        res.end();
        return;
      }
      json(res, 200, {
        reviewCommentId: `rev-${posts.length}`,
        commentRefs: [],
        verdict: post.verdict,
        body: post.body,
        comments: post.comments,
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/events")) {
      json(res, 200, { events, posts });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});

const port = Number(process.env.ZT_FAKE_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const bound = server.address()?.port;
  if (bound === undefined) return;
  const file = process.env.ZT_FAKE_PORT_FILE;
  if (file) {
    writeFileSync(file, String(bound));
  }
  process.stdout.write(`zt-fakes listening on 127.0.0.1:${bound}\n`);
});
