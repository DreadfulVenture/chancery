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
  /** End the session. */
  dispose(sessionId: string): Promise<void>;
}
