/**
 * The /page feed's contract: everything the page renders from, as the
 * UI consumes it. Each member rides its own feature domain's module
 * (health, sessions, runs, dropped starts, the bot's config echo); this
 * module is the feed's composition, not a grab-bag of those shapes.
 */

import type { StatusConfig } from "./bot-config-data.js";
import type { DroppedStartView } from "./dropped-start-data.js";
import type { UptimeInfo } from "./health-data.js";
import type { RunDraftsView } from "./run-data.js";
import type { SessionLiveView } from "./session-data.js";

/** GET /page's response. */
export interface PageData {
  /** The render moment, ISO 8601 — the page's rendered-at line. */
  renderedAt: string;
  uptime: UptimeInfo;
  /** The adapter reachability probe's answer for this render. */
  adapterReachable: boolean;
  /** The forge's base URL, composing the PR cells' links. */
  forgeUrl: string;
  /** The narration ring's lines since boot, the page's log tail. */
  log: string[];
  sessions: SessionLiveView[];
  droppedStarts: { count: number; starts: DroppedStartView[] };
  runs: RunDraftsView[];
  config: StatusConfig;
}
