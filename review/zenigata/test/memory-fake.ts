/**
 * MemoryFake: records writes, returns canned recalls, and remembers the
 * queries and options it was asked.
 */

import type {
  MemoryGateway,
  MemoryRecallOpts,
  MemoryWriteContext,
  ObservationSource,
  RecalledMemory,
} from "../src/contracts/memory.js";

export class MemoryFake implements MemoryGateway {
  readonly writes: Array<{
    source: ObservationSource;
    content: string;
    ctx: MemoryWriteContext;
  }> = [];
  readonly queries: Array<{ query: string; opts?: MemoryRecallOpts }> = [];
  private readonly canned: RecalledMemory[];

  constructor(canned: RecalledMemory[] = []) {
    this.canned = canned;
  }

  async recall(
    query: string,
    opts?: MemoryRecallOpts,
  ): Promise<RecalledMemory[]> {
    this.queries.push({ query, opts });
    return this.canned;
  }

  async write(
    source: ObservationSource,
    content: string,
    ctx: MemoryWriteContext,
  ): Promise<void> {
    this.writes.push({ source, content, ctx });
  }
}
