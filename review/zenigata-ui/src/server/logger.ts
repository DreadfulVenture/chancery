/**
 * The UI server's logger: pino, one line of JSON per record to stdout —
 * journald's source. The app field names the process; the message stays
 * plain. Error records carry the error under pino's own `err` key.
 */

import { pino, type Logger } from "pino";

export type { Logger };

export const logger: Logger = pino({
  base: { app: "zenigata-ui" },
  level: "info",
});
