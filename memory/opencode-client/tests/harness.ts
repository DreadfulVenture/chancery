import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { HOME, QUEUE_DIR, QUEUE_FILE, writeClientConfig } from "./sandbox.ts";
import plugin from "../memory.ts";

export { HOME, QUEUE_DIR, QUEUE_FILE, writeClientConfig, plugin };

// The plugin as OpenCode 2 loads it: setup() registers hooks against the
// domain objects, and a hook receives one mutable event.

export const SILENT = {
  json: { status: "ok", memories: [], rules: [], sections: {} },
};

// Records what setup() registers and hands back the callbacks, so a test
// can deliver the payload shape OpenCode would and read what the plugin did
// to it. subscribe() stays open until the cleanup function aborts it, the
// way the real stream does.
export function fakeContext() {
  const session = new Map<string, Function[]>();
  const tool = new Map<string, Function[]>();
  const mcp: Record<string, unknown> = {};
  const queue: { type: string; data: unknown }[] = [];
  const synthetics: Array<{ sessionID: string; text: string }> = [];
  // The session rows the host would carry, keyed by id: the plugin reads
  // them through ctx.session.get (the dispatch stamp lives in durable
  // metadata). A session with no row throws, the way the host does.
  const sessions = new Map<string, { metadata?: Record<string, unknown> }>();
  let push: (() => void) | undefined;

  const register = (map: Map<string, Function[]>) => (name, callback) => {
    map.set(name, [...(map.get(name) || []), callback]);
    return Promise.resolve({ dispose: async () => {} });
  };

  const ctx = {
    location: { directory: HOME },
    mcp: {
      transform: async (callback) => {
        callback({
          set: (name, config) => {
            mcp[name] = config;
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: register(session),
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.get(sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        return structuredClone(row);
      },
      // The session-start block and informational tool moments persist as
      // synthetics; the tests assert on what was handed to the session API.
      synthetic: async (input: { sessionID: string; text: string }) => {
        synthetics.push(input);
      },
    },
    tool: { hook: register(tool) },
    event: {
      subscribe: async function* ({ signal }) {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            push = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    },
  };

  return {
    ctx,
    mcp,
    synthetics,
    sessions,
    async fire(map: Map<string, Function[]>, name: string, event: unknown) {
      for (const callback of map.get(name) || []) await callback(event);
      return event;
    },
    sessionHooks: session,
    toolHooks: tool,
    // Delivers one event and waits for the subscriber to come back for the
    // next one, so an assertion never races the handler.
    async emit(type: string, data: unknown) {
      queue.push({ type, data });
      push?.();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// Brings the plugin up against a fake daemon answering `reply`. The
// connection rides client.json, the way a deployment writes it, so no
// environment juggling leaks between tests; the sandbox default is
// restored when the test ends.
export async function withDaemon(reply, run, config = {}) {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      bodies.push({ path: req.url, body });
      const answer = reply(body, req.url);
      // A connection-level failure (fetch rejects, no HTTP status), the
      // way a daemon crash mid-request behaves for the client.
      if (answer && answer.crash) {
        req.socket.destroy();
        return;
      }
      res.writeHead(answer.status || 200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(answer.json || {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The plugin parses client.json once at setup, so per-test knobs ride
  // the initial write; nothing mid-run can re-aim an already-built core.
  writeClientConfig({
    daemon_url: `http://127.0.0.1:${server.address().port}`,
    ...config,
  });
  rmSync(QUEUE_DIR, { recursive: true, force: true });
  const harness = fakeContext();
  const cleanup = await plugin.setup(harness.ctx);
  try {
    await run({ ...harness, bodies });
  } finally {
    await cleanup?.();
    writeClientConfig();
    await new Promise((resolve) => server.close(resolve));
  }
}

export function queued() {
  if (!existsSync(QUEUE_FILE)) return [];
  return readFileSync(QUEUE_FILE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
