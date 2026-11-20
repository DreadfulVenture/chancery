/**
 * The memory contract. Learning flows through this gateway only; the MCP
 * implementation lives in adapters/memory-mcp.ts, so the bot core never
 * touches a memory daemon directly.
 */

export type ObservationSource = "fact" | "insight" | "decision" | "task";

export interface RecalledMemory {
  content: string;
  source: string;
}

export interface MemoryRecallOpts {
  limit?: number;
  /** Scope recall to one repo/project workspace. */
  workspace?: string;
  /** Working directory the daemon resolves to a repo/workspace. */
  cwd?: string;
}

export interface MemoryWriteContext {
  /** Working directory the daemon resolves to a repo/project stamp. */
  cwd: string;
}

export interface MemoryGateway {
  recall(
    query: string,
    opts?: MemoryRecallOpts,
  ): Promise<Array<RecalledMemory>>;
  /** Store one agent-attributed observation, stamped to a repo via cwd. */
  write(
    source: ObservationSource,
    content: string,
    ctx: MemoryWriteContext,
  ): Promise<void>;
}
