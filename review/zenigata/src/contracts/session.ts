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
   * The session's recorded turns, oldest first: the prompts the caller
   * sent and the replies the runtime recorded. The read mirrors the
   * runtime's own record — a session the runtime no longer holds (the
   * retention sweep disposed it) fails the read with the runtime's
   * session-not-found error, which is how the status page's transcript
   * view knows to degrade.
   */
  transcript(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionTurn[]>;
  /** End the session. */
  dispose(sessionId: string): Promise<void>;
}

/** One turn of a session's transcript: who spoke and what they said. */
export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
}
