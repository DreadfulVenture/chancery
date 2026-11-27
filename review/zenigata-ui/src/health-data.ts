/**
 * The health line's data: the process facts the health panel reads from
 * the /page feed.
 */

export interface UptimeInfo {
  /** Process start, ISO 8601. */
  startedAt: string;
  uptimeSeconds: number;
  /** The port the intake actually bound. */
  listenPort: number;
  /** The configured adapter URL, userinfo and query tokens stripped. */
  adapterUrl: string;
}
