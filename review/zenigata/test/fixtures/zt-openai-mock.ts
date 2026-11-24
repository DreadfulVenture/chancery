/**
 * The scripted OpenAI-compatible server the zenigata runtime compatibility
 * check spins up (PRJ-479). The packaged serve's harness config registers it
 * as a custom provider through opencode's bundled openai-compatible package,
 * so a prompt round-trip, a delegated review pass, and the reviewer's own
 * tool grants run against the real serve with no network and no credentials.
 *
 * Scripted by model name, stateless:
 *   reviewer — one assistant text turn ("runtime compat round-trip"),
 *              unless the prompt drives a tool: a delegation prompt returns
 *              a `subagent` tool call for the harness's zt-worker agent, a
 *              shell prompt returns a `shell` tool call echoing the shell
 *              marker, and a docs prompt returns a `webfetch` tool call
 *              against this mock's own /docs/handbook (PRJ-496). Once the
 *              tool result is in the messages, the parent's final text
 *              names its probe, and the parent's tool-result content is
 *              recorded under GET /events as a "parent-tool" row saying
 *              whether the expected marker came back — that row is how the
 *              test asserts the file-defined reviewer's own grants won over
 *              the config floor's deny-all.
 *   worker   — first call returns a `read` tool call for the target file
 *              (env ZT_MOCK_READ_TARGET), delayed 2s; once the tool result
 *              is in the messages it returns the child's report text. The
 *              delay is what the settle test reads: the parent's turn may
 *              only settle after the child's report landed. The tool
 *              result's content is inspected against ZT_MOCK_READ_MARKER
 *              and recorded under GET /events (kind "worker-read"), which
 *              is how the test asserts the child's read tool call succeeded
 *              under the config floor's deny-all carve-out (PRJ-479).
 *
 * Every request is recorded with a timestamp under GET /events so the test
 * can order the child's completion against the driver's settle.
 *
 * The check also points the serve's catalog source (OPENCODE_MODELS_URL) at
 * this server: GET /experimental/v2.0/api.json serves the minimal catalog
 * file, so the serve's model catalog populates and refreshes over loopback
 * with no network. GET /docs/handbook serves the local docs fake the
 * reviewer's webfetch proof fetches — loopback only, inside the harness's
 * no_proxy, never a live docs site.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FINAL_TEXT = "parent final after the subagent report";
const CHILD_TEXT = "child report text";
const CHILD_DELAY_MS = Number(process.env.ZT_MOCK_CHILD_DELAY_MS ?? 2000);
const ROUNDTRIP_TEXT = "runtime compat round-trip";

/** The reviewer-grant probes' markers and finals: the shell command's echo,
 * the docs fake's page, and the parent text each final turn reports. */
const SHELL_MARKER = "zt-compat-shell-ok";
const DOCS_MARKER = "zt-compat-docs-fake";
const SHELL_FINAL_TEXT = "compat shell ran and returned the marker";
const DOCS_FINAL_TEXT = "compat docs page fetched and read";
const DOCS_PAGE = `${DOCS_MARKER}: the reviewer fetched the local docs fake`;

/** The request records: chat turns, their completions, one
 * "worker-read" row per child's second model call, saying whether the
 * child's `read` tool call returned the marker file's content, and one
 * "parent-tool" row per reviewer probe's final call, saying whether the
 * grant's tool call returned its marker. */
interface MockEvent {
  kind: "chat" | "chat-done" | "worker-read" | "parent-tool";
  model?: string;
  waitedMs?: number;
  sawToolResult?: boolean;
  toolCalls?: number;
  tool?: string;
  succeeded?: boolean;
  at: number;
}

const events: MockEvent[] = [];

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
  }>;
}

function toolResultText(body: ChatBody): string {
  const tool = body.messages.find((m) => m.role === "tool");
  if (!tool) return "";
  if (typeof tool.content === "string") return tool.content;
  if (Array.isArray(tool.content)) {
    return tool.content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

function sawToolResult(body: ChatBody): boolean {
  return body.messages.some((m) => m.role === "tool");
}

/** The parent reviewer's script: the round-trip turn unless the prompt
 * drives a tool — the delegation probe, the shell probe, or the docs
 * probe. The worker child reads the target file with the `read` tool
 * before it reports, so the child's tool grant is exercised on its run;
 * the parent's grant probes are exercised on the shell and docs turns. */
function choose(body: ChatBody): Scripted {
  const model = body.model;
  if (model === "worker") {
    if (sawToolResult(body)) {
      events.push({
        kind: "worker-read",
        model,
        succeeded: toolResultText(body).includes(
          process.env.ZT_MOCK_READ_MARKER ?? "zt-compat-worker-read-ok",
        ),
        at: Date.now(),
      });
      return { content: CHILD_TEXT, finish: "stop" };
    }
    return {
      toolCalls: [
        {
          id: "call_read_1",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({
              path:
                process.env.ZT_MOCK_READ_TARGET ??
                "/nonexistent/zt-worker-read.txt",
            }),
          },
        },
      ],
      finish: "tool_calls",
      delay: CHILD_DELAY_MS,
    };
  }
  if (model === "reviewer") {
    const lastUser = [...body.messages]
      .reverse()
      .find((m) => m.role === "user");
    const asks = typeof lastUser?.content === "string" ? lastUser.content : "";
    if (sawToolResult(body)) {
      // The parent's final turn: the tool result is in. The evidence row
      // goes out unconditionally on this turn, the way the worker-read
      // rows do, with `succeeded` computed from the marker's presence —
      // so a lost grant records its failure here and the test's event
      // asserts stay reachable. The row's tool is the call that precedes
      // the result; the delegated flow's `subagent` result (the
      // background notice) carries no marker, so its row reads
      // succeeded false and nothing asserts on it.
      const result = toolResultText(body);
      const calls = [...body.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls.length > 0,
        );
      const tool = calls?.tool_calls?.[0]?.function?.name ?? "unknown";
      const marker =
        tool === "shell"
          ? SHELL_MARKER
          : tool === "webfetch"
            ? DOCS_MARKER
            : undefined;
      events.push({
        kind: "parent-tool",
        tool,
        succeeded: marker === undefined ? false : result.includes(marker),
        at: Date.now(),
      });
      if (result.includes(SHELL_MARKER)) {
        return { content: SHELL_FINAL_TEXT, finish: "stop" };
      }
      if (result.includes(DOCS_MARKER)) {
        return { content: DOCS_FINAL_TEXT, finish: "stop" };
      }
      return { content: FINAL_TEXT, finish: "stop" };
    }
    if (/delegate/i.test(asks)) {
      return {
        toolCalls: [
          {
            id: "call_subagent_1",
            type: "function",
            function: {
              name: "subagent",
              arguments: JSON.stringify({
                agent: "zt-worker",
                description: "compat probe",
                prompt:
                  "Read the harness's target file with the read tool, then report the child text and nothing else.",
              }),
            },
          },
        ],
        finish: "tool_calls",
      };
    }
    if (/shell/i.test(asks)) {
      // The shell probe: a foreground echo (no background key — a call
      // pending across turn end is the park posture the runtime forbids),
      // whose output carries the marker. The session's own cwd is the
      // serve's project directory, so no workdir is sent.
      return {
        toolCalls: [
          {
            id: "call_shell_1",
            type: "function",
            function: {
              name: "shell",
              arguments: JSON.stringify({
                command: `echo ${SHELL_MARKER}`,
              }),
            },
          },
        ],
        finish: "tool_calls",
      };
    }
    if (/docs/i.test(asks)) {
      // The docs probe: a webfetch against this mock's own /docs/handbook
      // fake — the bound port is only known here, at request time.
      return {
        toolCalls: [
          {
            id: "call_fetch_1",
            type: "function",
            function: {
              name: "webfetch",
              arguments: JSON.stringify({
                url: `http://127.0.0.1:${boundPort}/docs/handbook`,
              }),
            },
          },
        ],
        finish: "tool_calls",
      };
    }
    return { content: ROUNDTRIP_TEXT, finish: "stop" };
  }
  return { content: `zt-mock: no script for model ${model}`, finish: "stop" };
}
/** One streaming response, OpenAI SSE shape. */
function writeStream(
  res: ServerResponse,
  scripted: Scripted,
  model: string,
  created: number,
  id: string,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const parts: string[] = [];
  if (scripted.toolCalls) {
    for (const [index, call] of scripted.toolCalls.entries()) {
      parts.push(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              },
            ],
          },
          null,
        ),
      );
    }
    parts.push(chunk({}, "tool_calls"));
  } else {
    parts.push(chunk({ role: "assistant", content: scripted.content }, null));
    parts.push(chunk({}, scripted.finish));
  }
  parts.push(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  );
  parts.push("data: [DONE]\n\n");
  res.write(parts.join(""));
  res.end();
}

function handleChat(res: ServerResponse, body: ChatBody): void {
  const scripted = choose(body);
  const model = body.model;
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-zt-" + events.length;
  const wait = scripted.delay ?? 0;

  events.push({
    kind: "chat",
    model,
    waitedMs: wait,
    sawToolResult: sawToolResult(body),
    at: Date.now(),
  });

  const respond = () => {
    if (body.stream) {
      writeStream(res, scripted, model, created, id);
      events.push({
        kind: "chat-done",
        model,
        toolCalls: scripted.toolCalls?.length ?? 0,
        at: Date.now(),
      });
      return;
    }
    const message: Record<string, unknown> = {
      role: "assistant",
      content: scripted.content ?? null,
    };
    if (scripted.toolCalls) message.tool_calls = scripted.toolCalls;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message, finish_reason: scripted.finish, logprobs: null },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    events.push({
      kind: "chat-done",
      model,
      toolCalls: scripted.toolCalls?.length ?? 0,
      at: Date.now(),
    });
  };

  if (wait > 0) {
    // The wait IS the test's material: record when it starts and ends so
    // the settle test can prove the parent's turn settled after it.
    setTimeout(respond, wait);
  } else {
    respond();
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: ChatBody = { model: "", messages: [] };
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<ChatBody>) : {};
      body = {
        model: parsed.model ?? "",
        stream: parsed.stream,
        messages: parsed.messages ?? [],
      };
    } catch {
      body = { model: "", messages: [] };
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      handleChat(res, body);
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/events")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }
    if (
      req.method === "GET" &&
      req.url?.startsWith("/experimental/v2.0/api.json")
    ) {
      const catalog = process.env.ZT_MOCK_CATALOG_FILE;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(catalog ? readFileSync(catalog, "utf8") : "{}");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/docs/handbook")) {
      // The docs fake the reviewer's webfetch proof fetches: plain text,
      // loopback only, inside the harness's no_proxy.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${DOCS_PAGE}\n`);
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});

/** This server's own bound port, set at listen and read only through
 * choose(), so the scripted webfetch call can name this very mock. */
let boundPort = 0;

const port = Number(process.env.ZT_MOCK_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const bound = server.address()?.port;
  if (bound === undefined) return;
  boundPort = bound;
  const file = process.env.ZT_MOCK_PORT_FILE;
  if (file) {
    writeFileSync(file, String(bound));
  }
  process.stdout.write(`zt-mock listening on 127.0.0.1:${bound}\n`);
});
