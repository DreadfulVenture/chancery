/**
 * The scripted OpenAI-compatible server the zenigata runtime compatibility
 * check spins up (PRJ-479). The packaged serve's harness config registers it
 * as a custom provider through opencode's bundled openai-compatible package,
 * so a prompt round-trip and a delegated review pass run against the real
 * serve with no network and no credentials.
 *
 * Scripted by model name, stateless:
 *   reviewer — one assistant text turn ("runtime compat round-trip"),
 *              unless the prompt asks for delegation, where it returns a
 *              `subagent` tool call for the harness's zt-worker agent and,
 *              once the tool result is in the messages, the parent's final
 *              text.
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
 * with no network.
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

/** The request records: chat turns, their completions, and one
 * "worker-read" row per child's second model call, saying whether the
 * child's `read` tool call returned the marker file's content. */
interface MockEvent {
  kind: "chat" | "chat-done" | "worker-read";
  model?: string;
  waitedMs?: number;
  sawToolResult?: boolean;
  toolCalls?: number;
  succeeded?: boolean;
  at: number;
}

const events: MockEvent[] = [];

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
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

/** The parent reviewer's script: delegate only when the prompt asks. The
 * worker child reads the target file with the `read` tool before it
 * reports, so the child's tool grant is exercised on every run. */
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
    if (sawToolResult(body)) {
      return { content: FINAL_TEXT, finish: "stop" };
    }
    const lastUser = [...body.messages]
      .reverse()
      .find((m) => m.role === "user");
    const asks =
      typeof lastUser?.content === "string" &&
      /delegate/i.test(lastUser.content);
    if (!asks) {
      return { content: ROUNDTRIP_TEXT, finish: "stop" };
    }
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
    res.writeHead(404);
    res.end("{}");
  });
});

const port = Number(process.env.ZT_MOCK_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const bound = server.address()?.port;
  if (bound === undefined) return;
  const file = process.env.ZT_MOCK_PORT_FILE;
  if (file) {
    writeFileSync(file, String(bound));
  }
  process.stdout.write(`zt-mock listening on 127.0.0.1:${bound}\n`);
});
