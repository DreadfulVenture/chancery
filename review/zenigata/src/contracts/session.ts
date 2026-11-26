/**
 * The agent-runtime contract the review driver consumes. Only the opencode
 * adapter imports @opencode/client, so a moving upstream API costs one file.
 * The interface spec lives in review/zenigata/docs/session-driver.md.
 */

export interface SessionDriver {
  /**
   * Create a session working in the given directory, running the named
   * agent. `opts.signal` is a client-side-only abort; the runtime contract
   * is unchanged.
   */
  createSession(
    directory: string,
    agent: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
  /** Send one prompt and wait for the turn to finish. */
  prompt(
    sessionId: string,
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  /** The text of the session's last assistant message, after the most recent turn. */
  readOutput(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
  /**
   * The session's recorded activity, oldest first: the prompts the caller
   * sent, the replies the runtime recorded, the tool calls those replies
   * ran, and the subagent reports the runtime delivered into the session.
   * The read mirrors the runtime's own record — a session the runtime no
   * longer holds (the retention sweep disposed it) fails the read with the
   * runtime's session-not-found error, which is how the status page's
   * transcript view knows to degrade.
   */
  transcript(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionTurn[]>;
  /** End the session. */
  dispose(sessionId: string): Promise<void>;
}

/**
 * One record of a session's activity (PRJ-538's turn-by-turn log), oldest
 * first. `at` is the record's created moment in epoch milliseconds; 0
 * means the driver holds no stamp for it (the test double's turns), and
 * the page renders such a turn unstamped.
 */
export type SessionTurn =
  | { role: "user"; at: number; text: string }
  | { role: "assistant"; at: number; text: string }
  | {
      role: "tool";
      at: number;
      /** The tool's name as the runtime recorded it. */
      name: string;
      /** The tool state's status word as the runtime recorded it ("completed", "error", "running", "streaming"). */
      status: string;
      /** The tool's input, serialized as text; empty when the record carries none. */
      input: string;
      /** The tool's output text, its content parts joined; empty on a record without output. */
      output: string;
      /** The tool's error text on a failed call; undefined otherwise. */
      error?: string;
    }
  | { role: "report"; at: number; text: string };
