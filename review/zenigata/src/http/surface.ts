/**
 * The read surface: the pinned machine contract (/status), the page-data
 * feed the UI app consumes (/page), the live log's transcript reads
 * (/log/<session id>), the /metrics and /healthz probes, and the root
 * placeholder pointing at the UI app. The endpoints' auth and exposure
 * contract lives in the canonical table at the top of
 * docs/deployment.md.
 *
 * /page carries the page-only data the old HTML render composed
 * in-process (the RunWallView pattern): the live rows' started stamps
 * and reviewer-session ids, the runs' wall times, failed drafts, and
 * transcripts, the forge URL, the narration tail, and the adapter
 * reachability probe. /status's pinned shape gains none of it.
 */

import type { Context } from "hono";
import {
  pageLiveRows,
  pageRunRows,
  readTranscriptView,
  type TranscriptCacheEntry,
} from "../transcript.js";
import type { StatusSource, LiveSessions } from "../status.js";
import type { StatusDb } from "../status-db.js";
import type { LogRing } from "../log-ring.js";
import type { SessionDriver } from "../contracts/session.js";
import type { Metrics } from "../metrics.js";
import type { PageData } from "../page.js";
import { plain } from "./intake.js";

/** How long the page feed's adapter probe may wait for any HTTP answer. */
const ADAPTER_PROBE_TIMEOUT_MS = 1500;

/**
 * Whether the forge adapter answers at all: any HTTP response — even a
 * 404 — proves the service is reachable; DNS failure, refusal, TLS
 * failure, or a timeout answers no. The probe carries no Authorization
 * header of its own, is bounded short so a dead adapter costs the page
 * feed one bounded wait rather than a hung request, and never redirects
 * off the configured host.
 */
const probeAdapter = (adapterUrl: string): Promise<boolean> =>
  fetch(adapterUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(ADAPTER_PROBE_TIMEOUT_MS),
  })
    .then(() => true)
    .catch(() => false);

/** Everything the read surface serves from; built once per server boot. */
export interface SurfaceInputs {
  statusDb: StatusDb;
  /** The live-session ledger the live rows read from. */
  live: LiveSessions;
  sessions: SessionDriver;
  metrics: Metrics;
  logRing: LogRing;
  /** The forged PR links' base URL (page-only data). */
  forgeUrl: string;
  /** The adapter probe's target. */
  adapterUrl: string;
}

const json = (c: Context, body: string): Response =>
  c.body(body, 200, { "Content-Type": "application/json; charset=utf-8" });

export class SurfaceRoute {
  /**
   * The composed transcript views the failed rows render from, cached
   * per session until the sweep disposes it (see pageRunRows).
   */
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();
  /**
   * The status projection. Assigned by the composition root right after
   * the server binds — the source needs the bound port for its uptime
   * view, so it cannot exist at construction. A request landing in that
   * gap reads the thrown accessor and answers 500, as the pre-hono
   * server answered.
   */
  private statusSource: StatusSource | undefined;

  constructor(private readonly inputs: SurfaceInputs) {}

  assignStatus(source: StatusSource): void {
    this.statusSource = source;
  }

  /** One pass's cache invalidation, the sweeper's hand (see pageRunRows). */
  invalidateTranscript(sessionId: string): void {
    this.transcriptCache.delete(sessionId);
  }

  private get source(): StatusSource {
    if (this.statusSource === undefined) {
      throw new Error("the status source is not assigned yet");
    }
    return this.statusSource;
  }

  healthz = (c: Context): Response => plain(c, 200, "ok");

  metrics = (c: Context): Response =>
    c.body(this.inputs.metrics.render(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });

  status = async (c: Context): Promise<Response> =>
    json(c, JSON.stringify(await this.source.snapshot()));

  pageData = async (c: Context): Promise<Response> => {
    const inputs = this.inputs;
    const [snapshot, adapterReachable] = await Promise.all([
      this.source.snapshot(),
      probeAdapter(inputs.adapterUrl),
    ]);
    const page: PageData = {
      // The render moment, the feed's own stamp — the UI renders its
      // refreshed-at line from it and derives nothing else from it.
      renderedAt: new Date(Date.now()).toISOString(),
      uptime: snapshot.uptime,
      adapterReachable,
      forgeUrl: inputs.forgeUrl,
      // The log tail: the narration ring's lines since boot, held in
      // memory. /status never serializes them.
      log: inputs.logRing.tail(),
      // The live rows, read from the ledger with each run's started
      // stamp and its reviewer session's id, each standing session's
      // log read live through the driver.
      sessions: await pageLiveRows(
        inputs.live.viewsWithStartedAt(),
        inputs.sessions,
      ),
      droppedStarts: snapshot.droppedStarts,
      // The run rows, read straight from the projection with each
      // settled run's wall time, and each failed run carrying a
      // retained session extended with its transcript view.
      runs: await pageRunRows(
        inputs.statusDb.recentRunsWithWallTime(),
        inputs.sessions,
        this.transcriptCache,
      ),
      config: snapshot.config,
    };
    return json(c, JSON.stringify(page));
  };

  /**
   * The live session log's transcript view, keyed to the sessions the
   * live ledger holds right now (PRJ-547's refresh surface, as JSON —
   * the UI renders it with lit): a settled or swept session answers not
   * found, and the UI keeps the block it rendered. The read rides the
   * same bounded, aborting read the page rows use.
   */
  log = async (c: Context, sessionId: string): Promise<Response> => {
    const row = this.inputs.live
      .viewsWithStartedAt()
      .find((view) => view.sessionId === sessionId);
    if (row?.sessionId === undefined) {
      return plain(c, 404, "not found");
    }
    const view = await readTranscriptView(row.sessionId, this.inputs.sessions);
    return json(c, JSON.stringify(view));
  };

  /**
   * The root placeholder: the human status page is its own app
   * (zenigata-ui), deployed and served separately; the bot's root names
   * that and the machine surface. A static document, not data markup —
   * the UI renders everything the page shows.
   */
  home = (c: Context): Response =>
    c.body(
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>zenigata</title></head>
<body>
<h1>zenigata</h1>
<p>The review bot is running. Its status UI is the zenigata-ui app, served separately.</p>
<p>Machine surface: <a href="/status">/status</a> (pinned JSON), <a href="/metrics">/metrics</a>, <a href="/healthz">/healthz</a>.</p>
</body>
</html>`,
      200,
      { "Content-Type": "text/html; charset=utf-8" },
    );
}
