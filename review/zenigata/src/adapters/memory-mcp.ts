/**
 * MemoryGateway over the memory daemon's MCP endpoint.
 *
 * The daemon serves MCP over streamable HTTP, and the deployment composes
 * the full endpoint URL itself — query params included, e.g.
 * `http://127.0.0.1:28132/mcp?app=zenigata&initiator=agent`. The
 * `initiator=agent` param is the daemon's lineage gate declaring that
 * writes from this connection are agent-attributed; dropping it changes
 * what the daemon refuses, so it must never be stripped from the URL.
 *
 * Sessions are not held open: each call connects a fresh client, runs its
 * one tool call, and closes. Connect failures log one line and rethrow;
 * tool errors surface as thrown Errors, which the core treats as
 * non-fatal. `transport` exists for tests: the unit suite pairs the
 * gateway with the SDK's InMemoryTransport so the client wiring is
 * exercised end to end without a network.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../ctx.js";
import type {
  MemoryGateway,
  MemoryRecallOpts,
  MemoryWriteContext,
  ObservationSource,
  RecalledMemory,
} from "../contracts/memory.js";
import { redactSecrets } from "../redact.js";

export interface MemoryMcpGatewayOptions {
  /** The full MCP endpoint URL, query params included. */
  url: string;
  logger?: Logger;
  /** Transport override for tests; default is streamable HTTP over `url`. */
  transport?: () => Transport | Promise<Transport>;
}

const CLIENT_INFO = { name: "zenigata", version: "0.1.0" } as const;

const SOURCES: readonly ObservationSource[] = [
  "fact",
  "insight",
  "decision",
  "task",
];

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Join the result's text blocks; a tool result with no text yields "". */
const resultText = (result: CallToolResult): string =>
  result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");

/**
 * Parse recall text tolerantly. The daemon's memory_recall returns a JSON
 * object shaped {status, count, results: [{content, source, ...}]}; a bare
 * JSON array of {content, source} also parses. Anything else falls back to
 * the raw text as one unattributed memory. An empty result parses to no
 * memories.
 */
export function parseRecallText(text: string): RecalledMemory[] {
  if (text.trim() === "") {
    return [];
  }
  const toMemory = (item: unknown): RecalledMemory | undefined => {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as { content?: unknown }).content !== "string"
    ) {
      return undefined;
    }
    const record = item as { content: string; source?: unknown };
    return {
      content: record.content,
      source: typeof record.source === "string" ? record.source : "unknown",
    };
  };
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const memories = parsed
        .map(toMemory)
        .filter((item): item is RecalledMemory => item !== undefined);
      if (memories.length === parsed.length && memories.length > 0) {
        return memories;
      }
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { results?: unknown }).results)
    ) {
      const rows = (parsed as { results: unknown[] }).results;
      // The daemon answered with its envelope: an empty results array is
      // a real "no memories", not a parse failure.
      return rows
        .map(toMemory)
        .filter((item): item is RecalledMemory => item !== undefined);
    }
  } catch {
    // Not JSON: fall through to the raw-text fallback.
  }
  return [{ content: text, source: "unknown" }];
}

class MemoryMcpGateway implements MemoryGateway {
  private readonly url: string;
  private readonly logger: Logger | undefined;
  private readonly makeTransport: () => Transport | Promise<Transport>;

  constructor(opts: MemoryMcpGatewayOptions) {
    this.url = opts.url;
    this.logger = opts.logger;
    this.makeTransport =
      opts.transport ??
      (() => new StreamableHTTPClientTransport(new URL(opts.url)));
  }

  /** Connect a fresh client for one call; the caller closes it. */
  private async connect(): Promise<Client> {
    const client = new Client(CLIENT_INFO);
    try {
      await client.connect(await this.makeTransport());
    } catch (error) {
      this.logger?.error(`memory gateway connect failed: ${message(error)}`);
      throw error;
    }
    return client;
  }

  /** Run one tool call on a throwaway connection. */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const client = await this.connect();
    try {
      // A non-task callTool returns CallToolResult under the requested
      // schema; the union static type includes the task shape, so narrow
      // it here.
      const result = (await client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
      )) as CallToolResult;
      return { text: resultText(result), isError: result.isError === true };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async recall(
    query: string,
    opts?: MemoryRecallOpts,
  ): Promise<RecalledMemory[]> {
    const result = await this.callTool("memory_recall", {
      query,
      ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts?.workspace === undefined ? {} : { workspace: opts.workspace }),
      ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
    if (result.isError) {
      // Tool output can echo stored text (a credentialed URL among it);
      // redact before truncating or the slice can cut a URL mid-userinfo.
      throw new Error(
        `memory_recall failed: ${redactSecrets(result.text).slice(0, 500) || "tool error"}`,
      );
    }
    return parseRecallText(result.text);
  }

  async write(
    source: ObservationSource,
    content: string,
    ctx: MemoryWriteContext,
  ): Promise<void> {
    if (!SOURCES.includes(source)) {
      throw new Error(
        `memory write source must be one of ${SOURCES.join("|")}, got ${source}`,
      );
    }
    if (!ctx?.cwd) {
      throw new Error("memory write requires a cwd to stamp the repo/project");
    }
    const result = await this.callTool("memory_remember", {
      content,
      source,
      cwd: ctx.cwd,
    });
    if (result.isError) {
      throw new Error(
        `memory_remember failed: ${redactSecrets(result.text).slice(0, 500) || "tool error"}`,
      );
    }
  }
}

/** Factory so the bot core consumes only the MemoryGateway contract. */
export function memoryMcpGateway(opts: MemoryMcpGatewayOptions): MemoryGateway {
  return new MemoryMcpGateway(opts);
}
