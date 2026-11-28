/**
 * Unit tests for the MCP memory gateway, over the SDK's InMemoryTransport:
 * a tiny in-process MCP server exposes memory_recall and memory_remember
 * with fake handlers, so the gateway's client wiring is exercised end to
 * end without a network.
 */

import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  memoryMcpGateway,
  parseRecallText,
} from "../src/adapters/memory-mcp.js";
import type { Logger } from "../src/ctx.js";

type ToolHandler = (
  args: Record<string, unknown> | undefined,
) => Promise<string>;

class FakeMemoryServer {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, ToolHandler>();

  constructor() {
    this.server = new Server(
      { name: "fake-memory", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "memory_recall",
          description: "recall",
          inputSchema: { type: "object" },
        },
        {
          name: "memory_remember",
          description: "remember",
          inputSchema: { type: "object" },
        },
      ],
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.handlers.get(name);
      this.calls.push({ name, args: args ?? {} });
      if (!handler) {
        return {
          isError: true,
          content: [{ type: "text", text: `unknown tool ${name}` }],
        };
      }
      try {
        return { content: [{ type: "text", text: await handler(args) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });
  }

  readonly server: Server;

  on(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  /**
   * One pair per call: the gateway connects a fresh client per call, and
   * an InMemoryTransport is single-use.
   */
  async clientTransport(): Promise<Transport> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await this.server.connect(serverSide);
    return clientSide;
  }
}

const collectLogger = (): { errors: string[]; logger: Logger } => {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      error: (m) => errors.push(m),
    },
  };
};

const failingTransport = (): Transport => ({
  start: () => Promise.reject(new Error("connection refused")),
  close: async () => {},
  send: async () => {},
});

describe("parseRecallText", () => {
  it("parses a JSON array of {content, source}", () => {
    const text = JSON.stringify([
      { content: "spell out addend names", source: "fact" },
      { content: "the reviewer wants tests", source: "insight" },
    ]);
    expect(parseRecallText(text)).toEqual([
      { content: "spell out addend names", source: "fact" },
      { content: "the reviewer wants tests", source: "insight" },
    ]);
  });

  it("defaults a missing source to unknown", () => {
    const text = JSON.stringify([{ content: "no source here" }]);
    expect(parseRecallText(text)).toEqual([
      { content: "no source here", source: "unknown" },
    ]);
  });

  it("parses the daemon's {status, count, results} envelope", () => {
    const text = JSON.stringify({
      status: "ok",
      count: 2,
      workspace: "example",
      results: [
        {
          id: "m1",
          content: "the reviewer wants tests",
          source: "insight",
          tier: "working",
        },
        { id: "m2", content: "pin the client version", source: "fact" },
      ],
    });
    expect(parseRecallText(text)).toEqual([
      { content: "the reviewer wants tests", source: "insight" },
      { content: "pin the client version", source: "fact" },
    ]);
  });

  it("parses an empty results array in the envelope to no memories", () => {
    expect(
      parseRecallText(JSON.stringify({ status: "ok", count: 0, results: [] })),
    ).toEqual([]);
  });

  it("falls back to raw text when the payload is not the expected shape", () => {
    expect(parseRecallText("plain prose answer")).toEqual([
      { content: "plain prose answer", source: "unknown" },
    ]);
    expect(parseRecallText('["a string array"]')).toEqual([
      { content: '["a string array"]', source: "unknown" },
    ]);
    expect(parseRecallText('{"content": "not an array"}')).toEqual([
      { content: '{"content": "not an array"}', source: "unknown" },
    ]);
  });

  it("parses empty text to no memories", () => {
    expect(parseRecallText("")).toEqual([]);
    expect(parseRecallText("  \n")).toEqual([]);
  });
});

describe("memoryMcpGateway over InMemoryTransport", () => {
  it("recall sends {query, limit} and parses the JSON array result", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_recall", async () =>
      JSON.stringify([{ content: "spell out addend names", source: "fact" }]),
    );
    const { errors, logger } = collectLogger();
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp?app=zenigata&initiator=agent",
      logger,
      transport: () => fake.clientTransport(),
    });

    await expect(
      memory.recall("review corrections", { limit: 5 }),
    ).resolves.toEqual([{ content: "spell out addend names", source: "fact" }]);
    expect(fake.calls).toEqual([
      {
        name: "memory_recall",
        args: { query: "review corrections", limit: 5 },
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("recall passes workspace and cwd when provided", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_recall", async () => "no stored corrections");
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(
      memory.recall("review corrections", {
        cwd: "/tmp/repo",
        workspace: "acme/widget",
      }),
    ).resolves.toEqual([
      { content: "no stored corrections", source: "unknown" },
    ]);
    expect(fake.calls).toEqual([
      {
        name: "memory_recall",
        args: {
          query: "review corrections",
          cwd: "/tmp/repo",
          workspace: "acme/widget",
        },
      },
    ]);
  });

  it("recall omits limit when it is not given", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_recall", async () => "no stored corrections");
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(memory.recall("query")).resolves.toEqual([
      { content: "no stored corrections", source: "unknown" },
    ]);
    expect(fake.calls).toEqual([
      { name: "memory_recall", args: { query: "query" } },
    ]);
  });

  it("recall surfaces a tool error as a thrown Error", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_recall", async () => {
      throw new Error("daemon overloaded");
    });
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(memory.recall("q")).rejects.toThrow(
      "memory_recall failed: daemon overloaded",
    );
  });

  it("remember sends {content, source, cwd} for a repo-stamped observation", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_remember", async () => "stored");
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(
      memory.write("insight", "something durable", { cwd: "/tmp/repo" }),
    ).resolves.toBeUndefined();
    expect(fake.calls).toEqual([
      {
        name: "memory_remember",
        args: {
          content: "something durable",
          source: "insight",
          cwd: "/tmp/repo",
        },
      },
    ]);
  });

  it("remember rejects a missing cwd before calling the daemon", async () => {
    const fake = new FakeMemoryServer();
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(
      // @ts-expect-error runtime guard: cwd is required to stamp the repo
      memory.write("fact", "x", {}),
    ).rejects.toThrow("memory write requires a cwd");
    expect(fake.calls).toEqual([]);
  });

  it("remember surfaces a tool error as a thrown Error", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_remember", async () => {
      throw new Error("refused: wrong lineage");
    });
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(
      memory.write("fact", "x", { cwd: "/tmp/repo" }),
    ).rejects.toThrow("memory_remember failed: refused: wrong lineage");
  });

  it("write refuses a source outside the contract", async () => {
    const fake = new FakeMemoryServer();
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await expect(
      memory.write("correction" as "fact", "x", { cwd: "/tmp/repo" }),
    ).rejects.toThrow(/source must be one of/);
    expect(fake.calls).toEqual([]);
  });

  it("logs one line on connect failure and rethrows", async () => {
    const { errors, logger } = collectLogger();
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      logger,
      transport: failingTransport,
    });

    await expect(memory.recall("q")).rejects.toThrow("connection refused");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "memory gateway connect failed: connection refused",
    );

    const { errors: writeErrors, logger: writeLogger } = collectLogger();
    const writeMemory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      logger: writeLogger,
      transport: failingTransport,
    });
    await expect(
      writeMemory.write("fact", "x", { cwd: "/tmp/repo" }),
    ).rejects.toThrow("connection refused");
    expect(writeErrors).toHaveLength(1);
  });

  it("opens a fresh connection per call and closes it", async () => {
    const fake = new FakeMemoryServer();
    fake.on("memory_recall", async () => "[]");
    const memory = memoryMcpGateway({
      url: "http://memory.invalid/mcp",
      transport: () => fake.clientTransport(),
    });

    await memory.recall("first");
    await memory.recall("second");
    expect(fake.calls).toHaveLength(2);
  });
});
