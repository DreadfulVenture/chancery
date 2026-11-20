/**
 * Scripted SessionDriver double. No agent runtime: each prompt consumes the
 * next scripted output and readOutput returns it. Indexing is per session:
 * every session starts at script position 0.
 */

import type { SessionDriver, SessionTurn } from "../contracts/session.js";

export type SessionScript =
  | string[]
  | ((sessionId: string, promptIndex: number, promptText: string) => string);

export interface RecordedSession {
  sessionId: string;
  directory: string;
  agent: string;
}

export interface RecordedPrompt {
  sessionId: string;
  index: number;
  text: string;
}

export class SessionDouble implements SessionDriver {
  readonly createdSessions: RecordedSession[] = [];
  readonly prompts: RecordedPrompt[] = [];
  readonly disposed: string[] = [];

  private readonly script: SessionScript;
  private readonly nextSessionNumber = { value: 1 };
  private readonly promptCounts = new Map<string, number>();
  private readonly lastOutput = new Map<string, string>();
  /** Each prompt's scripted output, per session and turn index. */
  private readonly turnOutputs = new Map<string, string>();

  constructor(script: SessionScript) {
    this.script = script;
  }

  async createSession(
    directory: string,
    agent: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const sessionId = `ses-double-${this.nextSessionNumber.value}`;
    this.nextSessionNumber.value += 1;
    this.createdSessions.push({ sessionId, directory, agent });
    return sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const index = this.promptCounts.get(sessionId) ?? 0;
    this.promptCounts.set(sessionId, index + 1);
    this.prompts.push({ sessionId, index, text });
    const output =
      typeof this.script === "function"
        ? this.script(sessionId, index, text)
        : (this.script[index] ?? "");
    this.lastOutput.set(sessionId, output);
    this.turnOutputs.set(`${sessionId}:${index}`, output);
  }

  async readOutput(
    sessionId: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<string> {
    // Divergence from the real driver, for convenience: a repeat read
    // replays the scripted output where the real one returns "".
    return this.lastOutput.get(sessionId) ?? "";
  }

  async transcript(
    sessionId: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<SessionTurn[]> {
    // Honest on disposal, like the runtime: a disposed session is gone,
    // and the read fails the way the sweep's no-op detection reads it.
    if (this.disposed.includes(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const turns: SessionTurn[] = [];
    for (const prompt of this.prompts) {
      if (prompt.sessionId !== sessionId) {
        continue;
      }
      turns.push({ role: "user", text: prompt.text });
      const output = this.turnOutputs.get(`${sessionId}:${prompt.index}`);
      if (output !== undefined) {
        turns.push({ role: "assistant", text: output });
      }
    }
    return turns;
  }

  async dispose(sessionId: string): Promise<void> {
    this.disposed.push(sessionId);
  }
}
