// The PagerDuty source (PRJ-426): the watcher's second source. The
// operator maps each watched PagerDuty service to a director session in
// the watcher's config — no on-call derivation, no session registering
// the watch. The poll pass reads PagerDuty's REST API with the
// discipline the forge reads carry (plain HTTP with the token header,
// every response through zod at the boundary, paging walked to the
// route's end), and each triggered incident id the claims machinery has
// not seen wakes exactly once, landing on the session the config names
// for that service. An acknowledged or resolved incident wakes nothing:
// the read asks for triggered only, and the rows are filtered triggered
// again after the read.
//
// No source abstraction lives between the sources. This is the second
// concrete source (Forgejo, PagerDuty, then Linear in PRJ-475), and it
// rides the watcher's existing shape — the same poll pass, the same
// stamp machinery (each service's claims row is a `chancery.watches`
// row on the target session's stamp, beside the forge watches'), the
// same mark-first mail-second discipline. The extraction the pattern
// earns is the watcher kernel's source contract, and both legs migrate
// onto it in later slices; the Linear source rides the same legacy shape.
//
// The trigger is a new incident, not a state change. An incident that is
// already triggered when a service's claims row is first written wakes
// with that first pass — a live fire is the director's business however
// old it is — and after that the id's delivered marker keeps every later
// pass to one wake: one wake per incident id, ever, per the claims
// machinery.
//
// The module is TypeScript, loaded through the deployed runtime's
// native .ts import (Bun transpiles it; Node 24 strips the types) — the
// syntax stays erasable-only, so nothing here needs a build step. The
// class owns the source's surface the way the projection's entities own
// theirs: the credential and config handling (the static readConfig,
// which answers null — the source off — on any config it cannot serve),
// the REST client and its page walk, the zod boundary, and the
// incident-to-wake mapping. The composer (composer.ts) reads the config,
// builds the instance beside the forge client, and calls poll() from
// the poll pass; the stamp machinery (patchStamps, readStamps,
// failedWrites, the stopped flag) is passed in, never forked.
//
// The config, on the watcher's plugins entry (options winning per key,
// the forge's credential pattern):
//
//   "watcher": {
//     "forgeUrl": "https://forge.example.com", "forgeToken": "…",
//     "pagerduty": {
//       "token": "…",   // or PAGERDUTY_TOKEN in the host's environment
//       "url": "…",     // optional; the REST api base, default https://api.pagerduty.com
//       "services": [
//         { "service": "PIJ90N7", "wake": "ses_…", "note": "the matrix stack" }
//       ]
//     }
//   }
//
// The watch key is the PagerDuty service id: GET /incidents filters on
// service_ids[] and carries no escalation-policy filter, so the docs
// pick the service id (read 2026-11-19). The token rides the watcher's
// credential pattern like forgeToken — env, per-entry override — and
// never reaches an error message or a log line. A missing token, an
// unusable url, or zero watchable services disables the PagerDuty
// source at init with a named line; the forge source keeps running. The
// plugin throws at init only for its forge-side config.

import { mailEnvelope } from "../../coordinate/director/director.ts";

import { z } from "zod";

const PD_DEFAULT_URL = "https://api.pagerduty.com";
const PD_KIND = "pagerduty";
const PD_API_TIMEOUT_MS = 15_000;
// The incidents read's page: the route's own maximum.
const PD_INCIDENTS_PER_READ = 100;
// The walk's page cap: 1000 triggered incidents, then the pass reads no
// further and says so. The route's date range defaults to the last
// month, so a service that outruns the cap is pathological; the claims
// markers keep the ids it did read to one wake.
const PD_INCIDENT_PAGES = 10;
// The leg's pass budget (review 339's 16310, comment 16411): the most
// time the PagerDuty leg may spend STARTING upstream reads inside one
// shared poll pass — the forge watches and the projection sync share
// that pass and wait behind it, and with each page carrying its own 15s
// timeout the unbounded worst case is services × pages × 15s. The check
// runs before each page read and never after, so the bound is the
// deadline plus the one read already in flight (its own 15s timeout):
// the leg can overshoot by that much and no more. A walk that reaches
// the budget stops reading and says so; everything it already read
// still settles, so the bound changes when the incidents are read,
// never which of them wake.
const PD_LEG_BUDGET_MS = 60_000;
// The read's date window (review 346's 16409): the request carries
// `since` set to now minus this window, so what the read can serve is
// bounded by this code, not by the route's documented default (the
// reference's since parameter reads "Maximum range is 6 months and
// default is 1 month"; read 2026-11-19). A marker written at t was read
// under this window, so its incident's creation sat inside it.
const PD_READ_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// The delivered markers' age limit (review 339's 16309): the read
// window plus two days of slack for clock skew between this host and
// PagerDuty. By construction — the window rides the wire since the
// since pin — a marker written at t was for an incident whose creation
// sat inside [t − window, t], and the id can never reappear once t plus
// the window has passed; pruning at window + slack therefore drops
// exactly the ids no future read can bring back. Pruning on absence
// from a read is not the rule, because an acknowledged incident can
// flip back to triggered inside the window. A marker with no readable
// age — a stamp written before the markers carried times — is never
// pruned.
const PD_DELIVERED_TTL_MS = PD_READ_WINDOW_MS + 2 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// One watched service's entry, as the config carries it after readConfig
// validated it.
export type PagerDutyServiceEntry = {
  service: string;
  wake: string;
  note?: string;
};

// The source's config as readConfig answers it — null means the source
// is off, never an instance.
export type PagerDutyConfig = {
  token: string;
  url: string;
  services: PagerDutyServiceEntry[];
};

// The stamp row the claims machinery reads and patches: the
// `chancery.watches` row, host-opaque beyond the fields the machinery
// names.
type StampRow = {
  id?: string;
  session?: string;
  kind?: string;
  ref?: string;
  note?: string;
  delivered?: Record<string, boolean>;
  // The moment each delivered marker was written, as the prune's age.
  markedAt?: Record<string, string>;
  [key: string]: unknown;
};

type Debug = (op: string, attrs?: Record<string, unknown>) => void;

// The context the source touches directly: the wake delivery. Everything
// else rides through the stamp machinery passed in beside it.
type SourceContext = {
  session: {
    synthetic: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
};

// The stamp machinery's contract, stated where the mail-owed recovery
// depends on it (review 339's 16308): patchStamps attempts the write
// for ANY array a patch returns — an unchanged array included — and
// answers that array or `false` (the write failed). It answers `null`
// only when the patch itself aborted (a row it found gone), and
// `undefined` when the session is gone. A settle whose marker persisted
// under a failed-reported write therefore walks the failedWrites path:
// the next pass re-attempts with the rows returned unchanged, and the
// owed mail goes out once that write commits.
type PatchStamps = (
  ctx: SourceContext,
  debug: Debug,
  sessionID: string,
  patch: (rows: StampRow[]) => StampRow[] | null,
) => Promise<StampRow[] | null | false | undefined>;

type ReadStamps = (
  ctx: SourceContext,
  debug: Debug,
  sessionID: string,
) => Promise<StampRow[] | null | undefined>;

type PagerDutySourceDeps = {
  config: PagerDutyConfig;
  ctx: SourceContext;
  debug: Debug;
  patchStamps: PatchStamps;
  readStamps: ReadStamps;
  isStopped: () => boolean;
  failedWrites: Set<string>;
  /**
   * The leg's pass budget in milliseconds, for tests; the deployment
   * rides the module constant (composer.ts passes nothing here).
   */
  legBudgetMs?: number;
};

// The REST client: one GET per read against PagerDuty's /incidents, the
// api key in the header in the scheme the route's docs carry. The client
// is stateless, and its errors name the route and the status — never the
// url's tail beyond the route and never the token.
function pagerdutyClient(source: { token: string; url: string }) {
  const request = async (
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<unknown> => {
    const route = new URL(`${source.url}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) route.searchParams.append(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(route, {
        headers: {
          Accept: "application/vnd.pagerduty+json;version=2",
          Authorization: `Token token=${source.token}`,
        },
        signal: AbortSignal.timeout(PD_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GET ${path} → ${(error as Error)?.message ?? error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      // The message names the route and the status — never the status
      // text (server-controlled; the redaction test's echo rides that
      // channel), never the url's tail beyond the route, never the
      // token.
      throw new Error(`GET ${path} → HTTP ${response.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GET ${path} → an unparseable JSON answer`);
    }
  };
  return { get: request };
}

// The incident row's boundary shape: the fields a wake carries. A row
// that drifts parses to a dropped row; the answer itself failing to be
// an incident list parses to null — the pass is skipped, the wake never
// invented.
const ZIncidentRow = z.looseObject({
  id: z.string(),
  status: z.string(),
  incident_number: z.number().optional(),
  title: z.string().nullish(),
  created_at: z.string().nullish(),
  html_url: z.string().nullish(),
  service: z.looseObject({ id: z.string() }).optional(),
});

// One parsed incident, as the wake carries it.
type ParsedIncident = {
  id: string;
  status: string;
  number?: number;
  title?: string;
  url?: string;
  createdAt?: string;
};

/**
 * One incidents page, parsed at the PagerDuty boundary. Null when the
 * answer is not an incident list; a row that fails to name itself is
 * left out of the page. Non-triggered rows (acknowledged, resolved) are
 * dropped here — the wire's statuses[] filter is never leaned on alone.
 * The row's own service reference, when it carries one, must agree with
 * the watched service, so a wrongful answer never wakes the wrong
 * director.
 */
function parseIncidentPage(
  answer: unknown,
  service: string,
): { rows: ParsedIncident[]; served: number; more: boolean } | null {
  const list = z
    .looseObject({
      incidents: z.array(z.unknown()),
      more: z.boolean().optional(),
    })
    .safeParse(answer);
  if (!list.success) return null;
  const rows: ParsedIncident[] = [];
  for (const raw of list.data.incidents) {
    if (!isRecord(raw)) continue;
    const parsed = ZIncidentRow.safeParse(raw);
    if (!parsed.success) continue;
    const id = parsed.data.id.trim();
    const status = parsed.data.status.trim().toLowerCase();
    if (!id || !status) continue;
    if (status !== "triggered") continue;
    const rowService = parsed.data.service?.id;
    if (typeof rowService === "string" && rowService && rowService !== service)
      continue;
    rows.push({
      id,
      status,
      ...(Number.isInteger(parsed.data.incident_number)
        ? { number: parsed.data.incident_number }
        : {}),
      ...(typeof parsed.data.title === "string" && parsed.data.title.trim()
        ? { title: parsed.data.title.trim() }
        : {}),
      ...(typeof parsed.data.html_url === "string" && parsed.data.html_url
        ? { url: parsed.data.html_url }
        : {}),
      ...(typeof parsed.data.created_at === "string" && parsed.data.created_at
        ? { createdAt: parsed.data.created_at }
        : {}),
    });
  }
  // The pagerduty answer carries `more` as the walk's end flag; an
  // answer without it ends the walk. `served` is the raw row count the
  // answer carried — the walk's offset advances by it, never by what
  // the read asked.
  return {
    rows,
    served: list.data.incidents.length,
    more: list.data.more === true,
  };
}

// The incident wake: one per new incident id, carried by the incident's
// own words — its id and number, its title, its url, its trigger time.
function incidentMail(
  entry: PagerDutyServiceEntry,
  rowId: string,
  incident: ParsedIncident,
): string {
  const lines = [
    "PagerDuty mail — incident",
    `watch ${rowId} — pagerduty ${entry.service}${
      entry.note ? ` — ${entry.note}` : ""
    }`,
    "",
    incident.number !== undefined
      ? `incident ${incident.id} (#${incident.number}) — triggered`
      : `incident ${incident.id} — triggered`,
  ];
  if (incident.title) lines.push(`title ${incident.title}`);
  if (incident.url) lines.push(`url ${incident.url}`);
  if (incident.createdAt) lines.push(`triggered at ${incident.createdAt}`);
  return mailEnvelope(lines);
}

// The claims row's delivered markers, as the stamp carries them.
type ClaimsRow = {
  id: string;
  delivered: Record<string, boolean>;
};

// What one incident's settle decided: "seen" — the id is spent one way
// or another and the caller may skip it from here on; "retry" — the
// stamp write failed and failedWrites holds the attempt for the next
// pass; "gone" — the target session or the claims row left, nothing was
// marked and nothing was delivered.
type SettleOutcome = "seen" | "retry" | "gone";

export class PagerDutySource {
  /**
   * The PagerDuty side of the watcher config. Null — the source off —
   * when the plugins entry carries no pagerduty block at all (the
   * source is opt-in; the absence is silent), and when the block is
   * present but unusable (each case named on its line). Malformed
   * service entries are dropped individually with their named line; the
   * source runs on what survives.
   */
  static readConfig(ctx: unknown): PagerDutyConfig | null {
    const options = isRecord(ctx) && isRecord(ctx.options) ? ctx.options : {};
    const watcher = isRecord(options.watcher) ? options.watcher : {};
    const block = isRecord(watcher.pagerduty) ? watcher.pagerduty : null;
    if (!block) return null;

    const env = typeof process === "object" ? process.env : {};
    const rawToken = block.token ?? env.PAGERDUTY_TOKEN;
    if (
      typeof rawToken !== "string" ||
      rawToken.trim() === "" ||
      rawToken.trim() === "null"
    ) {
      console.error(
        "[forgejo-watcher] the pagerduty source is off: no api token — set options.watcher.pagerduty.token on the watcher's plugins entry, or PAGERDUTY_TOKEN in the host's environment",
      );
      return null;
    }

    const rawUrl = block.url ?? env.PAGERDUTY_API_URL ?? PD_DEFAULT_URL;
    let url: string;
    try {
      const parsed = new URL(String(rawUrl).trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("not http(s)");
      }
      url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      console.error(
        `[forgejo-watcher] the pagerduty source is off: url must be the PagerDuty REST api's http(s) base (got ${JSON.stringify(rawUrl)})`,
      );
      return null;
    }

    const services: PagerDutyServiceEntry[] = [];
    const watched = new Set<string>();
    const rawServices = Array.isArray(block.services) ? block.services : [];
    for (const raw of rawServices) {
      const service =
        isRecord(raw) && typeof raw.service === "string"
          ? raw.service.trim()
          : "";
      const wake =
        isRecord(raw) && typeof raw.wake === "string" ? raw.wake.trim() : "";
      const note =
        isRecord(raw) && typeof raw.note === "string" ? raw.note.trim() : "";
      if (!service || !wake) {
        console.error(
          "[forgejo-watcher] a pagerduty services entry is dropped: its service (the PagerDuty service id) and wake (the director session to wake) must both be non-empty strings",
        );
        continue;
      }
      if (watched.has(service)) {
        console.error(
          `[forgejo-watcher] the pagerduty service ${service} is watched twice; the later entry is dropped`,
        );
        continue;
      }
      watched.add(service);
      services.push({
        service,
        wake,
        ...(note ? { note: note.slice(0, 200) } : {}),
      });
    }
    if (services.length === 0) {
      console.error(
        "[forgejo-watcher] the pagerduty source is off: no watchable services under options.watcher.pagerduty.services — each entry needs the PagerDuty service id (service) and the session to wake (wake)",
      );
      return null;
    }
    return { token: rawToken.trim(), url, services };
  }

  config: PagerDutyConfig;
  ctx: SourceContext;
  debug: Debug;
  patchStamps: PatchStamps;
  readStamps: ReadStamps;
  isStopped: () => boolean;
  failedWrites: Set<string>;
  client: ReturnType<typeof pagerdutyClient>;
  /** The leg's pass budget: the module constant unless a test set one. */
  legBudgetMs: number;
  // In-memory only; the delivered markers live on the target's stamp.
  // `seen` reseeds from the stamp every pass, so it can never drift
  // across passes; within a pass it keeps an already-settled id from a
  // second stamp walk.
  held: Map<string, { seen: Set<string>; gone: boolean }>;
  // One read-failure line per service, logged when it changes and
  // cleared when the service reads again (the projection's noteSync
  // pattern). The page cap rides the same memo — it repeats, so it must
  // not repeat aloud.
  lastWhy: Map<string, string>;

  /**
   * @param deps — the stamp machinery is the watcher's own (patchStamps,
   *   readStamps, failedWrites, the stopped flag), passed in, not
   *   forked.
   */
  constructor(deps: PagerDutySourceDeps) {
    this.config = deps.config;
    this.ctx = deps.ctx;
    this.debug = deps.debug;
    this.patchStamps = deps.patchStamps;
    this.readStamps = deps.readStamps;
    this.isStopped = deps.isStopped;
    this.failedWrites = deps.failedWrites;
    this.legBudgetMs = deps.legBudgetMs ?? PD_LEG_BUDGET_MS;
    this.client = pagerdutyClient(deps.config);
    this.held = new Map();
    this.lastWhy = new Map();
  }

  /** The claims row's stamp id for one watched service. */
  rowIdOf(entry: PagerDutyServiceEntry): string {
    return `pd-${entry.service}`;
  }

  /** The budget as the log lines name it. */
  get budgetLabel(): string {
    return this.legBudgetMs >= 1000
      ? `${Math.round(this.legBudgetMs / 1000)}s`
      : `${this.legBudgetMs}ms`;
  }

  noteWhy(service: string, why: string): void {
    if (!why) {
      this.lastWhy.delete(service);
      return;
    }
    if (this.lastWhy.get(service) !== why) {
      this.lastWhy.set(service, why);
      console.error(
        `[forgejo-watcher] the pagerduty read for service ${service} keeps its pass: ${why}`,
      );
    }
  }

  /**
   * The triggered-incidents read: the route's filters ride the wire
   * (statuses[]=triggered, service_ids[]=<id>), the walk pages on the
   * offset until the answer's `more` flag says the list ended, and the
   * page cap bounds a walk that never ends. The leg's pass deadline
   * bounds the walk's time: a check before each page read stops the walk
   * and says so — the pages it did read settle normally (the wake set is
   * the read's, never the budget's). The read's date window rides the
   * wire as `since`. Null when a page does not parse at the boundary.
   */
  async readTriggered(
    service: string,
    deadline: number,
  ): Promise<{
    rows: ParsedIncident[];
    capped: boolean;
    budgetSpent: boolean;
  } | null> {
    const rows: ParsedIncident[] = [];
    let offset = 0;
    // The read's own window, pinned on the wire (review 346's 16409):
    // what this read can serve is bounded by this code, not by the
    // route's documented default.
    const since = new Date(Date.now() - PD_READ_WINDOW_MS).toISOString();
    for (let page = 0; page < PD_INCIDENT_PAGES; page += 1) {
      if (Date.now() >= deadline) {
        return { rows, capped: false, budgetSpent: true };
      }
      const answer = await this.client.get("/incidents", {
        "statuses[]": "triggered",
        "service_ids[]": service,
        since,
        limit: PD_INCIDENTS_PER_READ,
        offset,
      });
      const parsed = parseIncidentPage(answer, service);
      if (parsed === null) return null;
      rows.push(...parsed.rows);
      // The walk's end: the answer's `more` flag saying the list ended,
      // or an empty page — a pager that claims `more` past nothing is
      // not walked further. The offset advances by the rows the answer
      // served, not by what the read asked: the route's own page size
      // governs the answer, and walking by the asked limit would skip
      // whatever a clamp left out.
      if (!parsed.more || parsed.served === 0) {
        return { rows, capped: false, budgetSpent: false };
      }
      offset += parsed.served;
    }
    return { rows, capped: true, budgetSpent: false };
  }

  /**
   * The delivered ids the read window has aged out: a marker written at
   * t was read under the window the wire pins, so the incident's own
   * age was inside it, and the id can never reappear once t plus the
   * window has passed — its marker is pruned at the window plus the
   * skew slack. A marker with no readable age (a stamp written before
   * the markers carried times) stays, and so does an id whose failed
   * write still owes it mail.
   */
  private staleDelivered(
    rowId: string,
    delivered: Record<string, boolean>,
    markedAt: Record<string, string>,
  ): string[] {
    const cutoff = Date.now() - PD_DELIVERED_TTL_MS;
    const stale: string[] = [];
    for (const incidentId of Object.keys(delivered)) {
      if (this.failedWrites.has(`${rowId} ${incidentId}`)) continue;
      const at = Date.parse(markedAt[incidentId] ?? "");
      if (Number.isFinite(at) && at < cutoff) stale.push(incidentId);
    }
    return stale;
  }

  /**
   * The claims row: found on the target's stamp, or stamped fresh. The
   * fast path is a bare read — a pass that finds the row writes nothing
   * (the prune's write happens only when the window has aged markers
   * out, and it prunes on a fresh read through the machinery, never
   * from this pass's copy, so a marker another writer added in between
   * survives). Returns the row's delivered markers, `false` when a
   * stamp write failed this pass (the row's creation or its prune; the
   * stamp still owns what it owned, and the next pass re-ensures), or
   * `undefined` when the target session is gone (nothing delivered
   * nowhere).
   */
  async ensureRow(
    entry: PagerDutyServiceEntry,
  ): Promise<ClaimsRow | false | undefined> {
    const id = this.rowIdOf(entry);
    const rows = await this.readStamps(this.ctx, this.debug, entry.wake);
    if (rows === undefined) return undefined;
    const found = (rows ?? []).find(
      (candidate) => candidate?.id === id && candidate?.kind === PD_KIND,
    );
    if (found) {
      const delivered: Record<string, boolean> = isRecord(found.delivered)
        ? ({ ...found.delivered } as Record<string, boolean>)
        : {};
      const markedAt: Record<string, string> = isRecord(found.markedAt)
        ? ({ ...found.markedAt } as Record<string, string>)
        : {};
      const stale = this.staleDelivered(id, delivered, markedAt);
      if (stale.length > 0) {
        const pruned = await this.patchStamps(
          this.ctx,
          this.debug,
          entry.wake,
          (freshRows) => {
            const row = freshRows.find(
              (candidate) =>
                candidate?.id === id && candidate?.kind === PD_KIND,
            );
            if (!row) return null;
            const rowDelivered: Record<string, boolean> = isRecord(
              row.delivered,
            )
              ? ({ ...row.delivered } as Record<string, boolean>)
              : {};
            const rowMarkedAt: Record<string, string> = isRecord(row.markedAt)
              ? ({ ...row.markedAt } as Record<string, string>)
              : {};
            const fresh = this.staleDelivered(id, rowDelivered, rowMarkedAt);
            if (fresh.length === 0) return null;
            for (const incidentId of fresh) {
              delete rowDelivered[incidentId];
              delete rowMarkedAt[incidentId];
            }
            row.delivered = rowDelivered;
            row.markedAt = rowMarkedAt;
            return freshRows;
          },
        );
        if (pruned === false) {
          // The write failed: the stamp still owns the stale markers,
          // so this pass's copy keeps them (they cannot re-wake — the
          // window keeps their ids out of the read) and the caller
          // reads false; the next pass re-ensures and re-prunes.
          return false;
        }
        // Null: the patch aborted on the fresh read — another writer
        // pruned first and nothing was left to drop, or the claims row
        // left. The stamp is then ahead of this copy or gone with it;
        // this pass's view prunes either way, and no dropped id can
        // reappear.
        for (const incidentId of stale) {
          delete delivered[incidentId];
          delete markedAt[incidentId];
        }
      }
      return { id, delivered };
    }
    const next = await this.patchStamps(
      this.ctx,
      this.debug,
      entry.wake,
      (copies) => {
        if (
          copies.some(
            (candidate) => candidate?.id === id && candidate?.kind === PD_KIND,
          )
        ) {
          return copies;
        }
        copies.push({
          id,
          session: entry.wake,
          kind: PD_KIND,
          ref: entry.service,
          ...(entry.note ? { note: entry.note } : {}),
          delivered: {},
        });
        return copies;
      },
    );
    if (next === false || next === undefined) return next;
    return { id, delivered: {} };
  }

  /**
   * Mark first, deliver second — the forge wakes' own discipline,
   * pointed at the config-mapped target.
   */
  async settleIncident(
    entry: PagerDutyServiceEntry,
    incident: ParsedIncident,
  ): Promise<SettleOutcome> {
    if (this.isStopped()) return "gone";
    const id = this.rowIdOf(entry);
    const attempt = `${id} ${incident.id}`;
    let spent = false;
    const next = await this.patchStamps(
      this.ctx,
      this.debug,
      entry.wake,
      (rows) => {
        const row = rows.find(
          (candidate) => candidate?.id === id && candidate?.kind === PD_KIND,
        );
        if (!row) return null;
        if (isRecord(row.delivered) && row.delivered[incident.id]) {
          if (this.failedWrites.has(attempt)) return rows;
          spent = true;
          return null;
        }
        row.delivered = {
          ...(isRecord(row.delivered) ? row.delivered : {}),
          [incident.id]: true,
        };
        // The marker's write moment: the prune's age key (the read's
        // date window bounds how long the id can ever reappear).
        row.markedAt = {
          ...(isRecord(row.markedAt) ? row.markedAt : {}),
          [incident.id]: new Date().toISOString(),
        };
        return rows;
      },
    );
    if (spent) {
      this.debug("incident.already", {
        service: entry.service,
        incident: incident.id,
      });
      return "seen";
    }
    if (next === null) {
      this.debug("incident.unstamped", {
        service: entry.service,
        incident: incident.id,
      });
      return "gone";
    }
    if (next === undefined) return "gone";
    if (next === false) {
      this.failedWrites.add(attempt);
      return "retry";
    }
    this.failedWrites.delete(attempt);
    try {
      await this.ctx.session.synthetic({
        sessionID: entry.wake,
        text: incidentMail(entry, id, incident),
      });
      // The delivered op only ever names a delivery that did not throw
      // (review 339's 16312): a failed one logs its own op below the
      // error, so a debug trace never reads a missed wake as landed.
      this.debug("incident.delivered", {
        service: entry.service,
        incident: incident.id,
      });
    } catch (error) {
      console.error(
        `[forgejo-watcher] mail delivery to ${entry.wake} failed: ${error}`,
      );
      this.debug("incident.undelivered", {
        service: entry.service,
        incident: incident.id,
        error: String(error),
      });
    }
    return "seen";
  }

  async pollService(
    entry: PagerDutyServiceEntry,
    deadline: number,
  ): Promise<void> {
    if (this.isStopped()) return;
    const id = this.rowIdOf(entry);
    let mine = this.held.get(entry.service);
    if (!mine) {
      mine = { seen: new Set<string>(), gone: false };
      this.held.set(entry.service, mine);
    }

    // The claims row first: a gone target costs the pass nothing
    // further, and the row's delivered markers seed this pass's skip
    // set.
    const ensured = await this.ensureRow(entry);
    if (ensured === undefined) {
      if (!mine.gone) {
        mine.gone = true;
        console.error(
          `[forgejo-watcher] the pagerduty wake target ${entry.wake} for service ${entry.service} is not a live session; nothing is delivered to it while it is gone`,
        );
      }
      return;
    }
    if (mine.gone) {
      mine.gone = false;
      this.debug("pagerduty.target.back", { service: entry.service });
    }
    if (ensured === false) return;
    mine.seen = new Set(Object.keys(ensured.delivered ?? {}));

    let read: {
      rows: ParsedIncident[];
      capped: boolean;
      budgetSpent: boolean;
    } | null = null;
    let why = "";
    try {
      read = await this.readTriggered(entry.service, deadline);
    } catch (error) {
      why = `the incidents read failed: ${(error as Error)?.message ?? error}`;
    }
    if (!why && read === null) {
      why = "the incidents answer did not parse as an incident list";
    }
    if (!why && read !== null && read.capped) {
      why = `the triggered incidents ran past ${PD_INCIDENT_PAGES} reads of ${PD_INCIDENTS_PER_READ}; the pass reads no further`;
    }
    if (!why && read !== null && read.budgetSpent) {
      why = `the pagerduty leg ran out its ${this.budgetLabel} pass budget; the walk reads no further this pass`;
    }
    this.noteWhy(entry.service, why);
    // A cap or an unreadable answer leaves this pass's rows unwoken —
    // the next pass reads them again from the walk's start. The budget
    // is not one of those: what the walk read before it stopped still
    // settles, so the wake set stays the read's and the bound defers
    // nothing it read.
    if (why && !(read !== null && read.budgetSpent)) return;
    if (read === null) return;

    for (const incident of read.rows) {
      if (this.isStopped()) break;
      const attempt = `${id} ${incident.id}`;
      // A spent marker skips its incident — unless this instance's own
      // failed write still owes that id its mail: the marker then
      // persisted under a failed-reported write, and only the settle
      // below delivers the owed mail (its patch returns the rows
      // unchanged, the write commits, failedWrites retires).
      if (mine.seen.has(incident.id) && !this.failedWrites.has(attempt)) {
        continue;
      }
      const outcome = await this.settleIncident(entry, incident);
      if (outcome === "seen") mine.seen.add(incident.id);
      // "retry": the attempt sits in failedWrites for the next pass.
      // "gone": the target or the claims row left mid-pass — the next
      // pass's ensure says what it can and re-ensures.
    }
  }

  /**
   * The pass: each configured service's claims row ensured on the
   * target's stamp, its triggered incidents read, and every id the
   * claims have not seen settled once. The leg's budget spans the pass:
   * a service the budget cannot reach anymore reads next pass, named on
   * the same memo line the read failures carry. One service's failure
   * says and moves on; the rest of the services still poll this pass.
   */
  async poll(): Promise<void> {
    const deadline = Date.now() + this.legBudgetMs;
    for (const entry of this.config.services) {
      if (this.isStopped()) break;
      if (Date.now() >= deadline) {
        this.noteWhy(
          entry.service,
          `the pagerduty leg ran out its ${this.budgetLabel} pass budget; the service reads next pass`,
        );
        continue;
      }
      try {
        await this.pollService(entry, deadline);
      } catch (error) {
        console.error(
          `[forgejo-watcher] the pagerduty pass for service ${entry.service} failed: ${error}`,
        );
      }
    }
  }
}
