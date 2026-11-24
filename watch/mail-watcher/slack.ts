// The Slack source: the watcher's third source on the kernel's source
// contract (the forge source first, github second — the forge source's
// registration shape, not a legacy leg). A session subscribes to a
// channel by watcher_register
// (kind "slack-channel", the channel's id as the ref, the forge kinds'
// registration shape); every message that arrives on the channel after
// the watch wakes the subscriber once, carrying the message's content,
// sender, and timestamp.
//
// The temporal cursor is the whole channel rule, expressed inside the
// kernel's model (docs/adr/20261119-watcher-family.md): a watch's
// delivered markers — keyed by the message ts, on the subscriber's own
// watch row — are both the delivery bookkeeping and the cursor. The
// poll derives the floor (the newest spent ts), reads the channel's
// history with `oldest` at the floor, and filters again after the read
// against that same floor and the markers (the wire filter is never
// leaned on alone — the PagerDuty statuses[] rule). Mark-first,
// mail-second means the cursor advances exactly when the bookkeeping
// lands. The channel's history at register is the spent backlog (the
// register path's own baseline read; when Slack cannot answer it, the
// row is stamped baseline-pending and the first poll pass spends its
// page instead), so a watch wakes on messages that arrive after it,
// never the history it registered against.
//
// What wakes: channel messages only — no thread replies (a later
// slice's conversations.replies read), no edit/delete re-delivery (an
// edit keeps its ts, so the marker eats it; subtype and hidden rows —
// joins, leaves, tombstones — are not channel messages and never
// wake), bot messages included unfiltered (the subscriber filters).
// Slack's mrkdwn rides as-is: the wake is a prompt, not a rendering.
//
// The window is one read per watch per pass, at Slack's page maximum,
// newest first. A page that comes back full and claims more says its
// trade on a named line: the messages past its bottom are not served,
// and once the served ones mark, the floor jumps past them — a burst
// wider than the page loses its tail. The kernel contract's source
// cannot hold a cursor back (the delivered markers are the cursor), so
// settling the served page and naming the loss is the honest shape —
// the forge pr-reviews source's one-page trade, sized to Slack's
// maximum. Deeper paging drains bigger bursts and is a later slice.
//
// The event is the privacy contract (kernel.ts): the ts as the id, the
// resolved sender as the one ref field — pointer data, nothing else.
// The message TEXT is not an event field (the kernel's boundary would
// refuse it): it rides prepare()'s detail, the same opaque channel the
// failing job's log tail rides, fetched by one bounded history read
// around the ts before the stamp write (today's read-before-mark
// order, kept). The sender's display name resolves in the poll pass
// through a memoized users.info read per pass — a member id alone
// would force a second read the subscriber cannot make (the token is
// the watcher's) — falling back to the raw id, the bot's username, or
// the bot id.
//
// The config, on the watcher's plugins entry (the linear source's
// credential pattern — the token from configuration with the env
// fallback, an optional api base so tests dial loopback fakes):
//
//   "watcher": {
//     "slack": {
//       "token": "…",  // or SLACK_TOKEN in the host's environment
//       "url": "…"     // optional; the api's base, default https://slack.com/api
//     }
//   }
//
// An absent block leaves the source unbuilt and silent (the linear
// source's opt-in pattern; the composer builds the source only when
// readConfig answers); a block that cannot be served — no token — is
// said on its named line and the other sources carry on. The token
// never reaches an error message or a log line.

import { mailEnvelope } from "../../coordinate/director/director.ts";

import { z } from "zod";

import type {
  AdoptedWatch,
  Debug,
  DeliverCheckpoint,
  PassContext,
  PassMemo,
  RegisterRequest,
  WatchCursor,
  WatchEvent,
  WatchRowSeed,
} from "./kernel.ts";
import { WatchSource } from "./source.ts";

const SLACK_KIND = "slack-channel";
const SLACK_DEFAULT_URL = "https://slack.com/api";
const SLACK_API_TIMEOUT_MS = 15_000;
// The flat backoff when a 429 answers with no Retry-After header at
// all (Slack names the wait; the header's absence is answered with the
// github source's flat-minute shape).
const SLACK_RATE_LIMIT_FALLBACK_MS = 60_000;
// One history read per watch per pass, at Slack's own page maximum.
const SLACK_HISTORY_LIMIT = 200;
// The bounded read around a message ts (prepare's body fetch): ±2
// seconds and an exact-ts match in the answer — wide enough to be
// robust to the range bounds' inclusivity, small enough to be a cheap
// read.
const SLACK_TS_WINDOW_S = 2;
const SLACK_TS_WINDOW_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The numeric side of a Slack message ts ("1411764713.000007"): seconds
// and microseconds. Comparisons are numeric; the string form is the
// identity everywhere else (the event id, the delivered marker's key).
export const tsValue = (ts: string): number | null => {
  const value = Number.parseFloat(ts);
  return Number.isFinite(value) && value > 0 ? value : null;
};

// The source's side of the watcher config, as readConfig answers it —
// null means the source is unbuilt, never an instance.
export type SlackConfig = {
  token: string;
  url: string;
};

// The config read: the watcher options block's slack namespace (the
// kernel hands each source the block at ready(); the composer reads
// the same block to build the reads). Null — the absent block — is
// silent: the source is opt-in. A block that cannot be served says its
// line and the source is off.
export const readConfig = (watcherOptions: unknown): SlackConfig | null => {
  const block =
    isRecord(watcherOptions) && isRecord(watcherOptions.slack)
      ? watcherOptions.slack
      : null;
  if (!block) return null;

  const env = typeof process === "object" ? process.env : {};
  const rawToken = block.token ?? env.SLACK_TOKEN;
  if (
    typeof rawToken !== "string" ||
    rawToken.trim() === "" ||
    rawToken.trim() === "null"
  ) {
    console.error(
      "[forgejo-watcher] the slack source is off: no api token — set options.watcher.slack.token on the watcher's plugins entry, or SLACK_TOKEN in the host's environment",
    );
    return null;
  }

  const rawUrl = block.url ?? env.SLACK_API_URL ?? SLACK_DEFAULT_URL;
  let url: string;
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
    // A query or a fragment is never the api's base (the linear
    // source's rule): the client composes ${base}/${method}, so one
    // riding in would be silently dropped — a misconfiguration that
    // reads as configured. The url is not echoed either, because its
    // query is exactly the part that must never log.
    if (parsed.search || parsed.hash) {
      console.error(
        `[forgejo-watcher] the slack source is off: url must be the Slack api's http(s) base without a query or a fragment (got ${parsed.origin}${parsed.pathname} plus a query or fragment)`,
      );
      return null;
    }
    url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    console.error(
      `[forgejo-watcher] the slack source is off: url must be the Slack api's http(s) base (got ${JSON.stringify(rawUrl)})`,
    );
    return null;
  }

  return { token: rawToken.trim(), url };
};

// The Web API client: one GET per read, the token in the header in the
// scheme the api carries (Bearer). The client is stateless, and its
// errors name the method and the status — never the url beyond the
// method and never the token; the HTTP status phrase is kept out the
// way the linear client keeps it out. Slack answers api-level failures
// with HTTP 200 and ok:false — the error field is the api's bounded
// machine code (channel_not_found, invalid_auth, rate_limited), this
// surface's status phrase, and it rides the error so the named line
// can carry it.
//
// The budget answer: a burst's reads outrun Slack's per-minute tier and
// the api answers 429 with a Retry-After header naming the wait. The
// client holds the backoff it names (a flat minute when the header is
// absent — the github source's fallback shape) and retries the read
// once; the retry is where the body arrives. A second 429 throws, and
// the callers' discipline holds: a poll read's pass skips, a prepare
// read leaves its marker unspent, and the next pass re-reads.
export function slackClient(source: { token: string; url: string }) {
  const request = async (
    method: string,
    params: Record<string, string | number | undefined>,
  ): Promise<unknown> => {
    const route = new URL(`${source.url}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) route.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(route, {
        headers: { Authorization: `Bearer ${source.token}` },
        signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GET /${method} → ${(error as Error)?.message ?? error}`);
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : SLACK_RATE_LIMIT_FALLBACK_MS;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        response = await fetch(route, {
          headers: { Authorization: `Bearer ${source.token}` },
          signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `GET /${method} → ${(error as Error)?.message ?? error}`,
        );
      }
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`GET /${method} → HTTP ${response.status}`);
    }
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new Error(`GET /${method} → an unparseable JSON answer`);
    }
    if (isRecord(answer) && answer.ok === false) {
      const why =
        typeof answer.error === "string" && answer.error
          ? answer.error
          : "not ok";
      throw new Error(`GET /${method} → the api said ${why}`);
    }
    return answer;
  };
  return { get: request };
}

// The reads the source polls with, over the client (the forge source's
// injected-reads shape): the channel's history page and the user
// directory's one row.
export type SlackReads = {
  historyOf: (
    channel: string,
    opts: { limit: number; oldest?: string; latest?: string },
  ) => Promise<unknown>;
  usersInfo: (userId: string) => Promise<unknown>;
};

export const slackReads = (config: SlackConfig): SlackReads => {
  const client = slackClient(config);
  return {
    historyOf: (channel, opts) =>
      client.get("conversations.history", {
        channel,
        limit: opts.limit,
        ...(opts.oldest !== undefined ? { oldest: opts.oldest } : {}),
        ...(opts.latest !== undefined ? { latest: opts.latest } : {}),
      }),
    usersInfo: (userId) => client.get("users.info", { user: userId }),
  };
};

// The history answer's boundary shape. A shape that drifts parses to
// null — the pass is skipped, the wake never invented.
const ZHistoryAnswer = z.looseObject({
  messages: z.array(z.unknown()),
  has_more: z.boolean().optional(),
});

// One parsed message, as the wake carries it: the ts (the identity),
// the text, and the sender's raw shapes — resolved to a name in the
// poll pass, never here (the boundary names what the wire said).
export type ParsedMessage = {
  ts: string;
  tsMs: number;
  text?: string;
  userId?: string;
  username?: string;
  botId?: string;
};

const parseMessageRow = (raw: unknown): ParsedMessage | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.ts !== "string" || !raw.ts.trim()) return null;
  // Subtype rows (joins, leaves, tombstones) and hidden rows are not
  // channel messages: v1 never wakes them and never spends them.
  if (typeof raw.subtype === "string" && raw.subtype) return null;
  if (raw.hidden === true) return null;
  const tsMs = tsValue(raw.ts.trim());
  if (tsMs === null) return null;
  return {
    ts: raw.ts.trim(),
    tsMs,
    ...(typeof raw.text === "string" && raw.text ? { text: raw.text } : {}),
    ...(typeof raw.user === "string" && raw.user.trim()
      ? { userId: raw.user.trim() }
      : {}),
    ...(typeof raw.username === "string" && raw.username.trim()
      ? { username: raw.username.trim() }
      : {}),
    ...(typeof raw.bot_id === "string" && raw.bot_id.trim()
      ? { botId: raw.bot_id.trim() }
      : {}),
  };
};

// One history page, parsed at the Slack boundary. Null when the answer
// is not a page of messages. A row that fails to name itself is left
// out of the page and counted in `dropped`; `served` is the raw row
// count the answer carried.
export const parseHistoryPage = (
  answer: unknown,
): {
  rows: ParsedMessage[];
  served: number;
  dropped: number;
  more: boolean;
} | null => {
  const parsed = ZHistoryAnswer.safeParse(answer);
  if (!parsed.success) return null;
  const rows: ParsedMessage[] = [];
  let dropped = 0;
  for (const raw of parsed.data.messages ?? []) {
    const row = parseMessageRow(raw);
    if (row) rows.push(row);
    else dropped += 1;
  }
  return {
    rows,
    served: parsed.data.messages?.length ?? 0,
    dropped,
    more: parsed.data.has_more === true,
  };
};

const ZUserAnswer = z.looseObject({
  user: z
    .looseObject({
      id: z.string(),
      name: z.string().nullish(),
      profile: z
        .looseObject({
          display_name: z.string().nullish(),
          real_name: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

// The sender's display name from the directory row: the profile's
// display name, then the real name, then the bare name. Null — the
// caller falls back to the raw id.
const parseUserRow = (raw: unknown): string | null => {
  const parsed = ZUserAnswer.safeParse(raw);
  if (!parsed.success || !parsed.data.user) return null;
  const profile = parsed.data.user.profile ?? null;
  const name =
    profile?.display_name?.trim() ||
    profile?.real_name?.trim() ||
    parsed.data.user.name?.trim() ||
    "";
  return name || null;
};

// The delivered map's floor: the newest spent message ts (a key that
// is not a ts is ignored). An empty map's floor is -Infinity — nothing
// is below the watch yet.
export const floorOf = (delivered: Record<string, boolean>): number => {
  let floor = Number.NEGATIVE_INFINITY;
  for (const key of Object.keys(delivered)) {
    const value = tsValue(key);
    if (value !== null && value > floor) floor = value;
  }
  return floor;
};

/**
 * The wake candidates from one read: the parsed rows newer than the
 * cursor's floor (the wire's oldest bound re-checked after the read —
 * the PagerDuty statuses[] rule) that the markers have not spent. The
 * marker check reads the cursor's own map — the kernel's in-memory
 * copy, which trails the stamp only on this instance's failed write,
 * exactly the case whose owed mail the recovery pass re-serves. A row
 * the boundary could not name (a subtype row included) is never a
 * candidate; a candidate that re-serves is eaten by its marker at the
 * kernel's settle, so the floor's overlap costs reads, never wakes.
 */
export const classifyMessages = (
  rows: ParsedMessage[],
  floorMs: number,
  delivered: Record<string, boolean>,
): ParsedMessage[] =>
  rows.filter(
    (row) =>
      row.tsMs > floorMs &&
      !Object.prototype.hasOwnProperty.call(delivered, row.ts),
  );

// The event view: the ts as the id (the delivered marker's key), the
// resolved sender as the one ref field. The channel rides the watch
// (watch.ref) and the ts the id — the mail reads what it needs off
// those, so the event carries no duplicates.
const messageEventOf = (
  message: ParsedMessage,
  sender?: string,
): WatchEvent => ({
  id: message.ts,
  type: "message",
  fields: [
    ...(sender
      ? [{ kind: "ref" as const, name: "sender", value: sender }]
      : []),
  ],
});

// The wake: the channel, the message's ts and sender, and the body —
// the one wake that carries its content, because the subscriber has no
// Slack token of its own to fetch it with (the linear source's mail
// points at the ticket; this one carries the message).
const messageMail = (
  watch: AdoptedWatch,
  event: WatchEvent,
  text?: string | null,
): string => {
  const sender = event.fields.find((field) => field.name === "sender")?.value;
  const lines = [
    "Slack mail — channel message",
    `watch ${watch.id} — ${watch.kind} ${watch.ref} on ${watch.repo}${
      watch.note ? ` — ${watch.note}` : ""
    }`,
    "",
    `message ${event.id} from ${sender ?? "unknown sender"}`,
  ];
  if (text === null) {
    lines.push("(the message body could not be fetched)");
  } else if (typeof text === "string" && text) {
    lines.push("");
    for (const line of text.split(/\r?\n/)) lines.push(`  ${line}`);
  }
  return mailEnvelope(lines);
};

export type SlackSourceDeps = {
  reads: SlackReads;
  debug: Debug;
};

// The Slack source: the contract's class shape over the module's pure
// boundary (the parsers, the floor, the classification) and its reads. A
// channel watch is never claimed: every session that subscribes mints its
// own watch, stamped on its own session, so each subscriber wakes exactly
// once per message (the pr-reviews ownership shape) — the base's
// claimGroupOf, null, is the answer.
export class SlackSource extends WatchSource {
  readonly id = "slack";

  private readonly reads: SlackReads;

  // One named line per channel per state change (the projection's
  // noteSync pattern): a read failure or the full-page trade says when
  // it changes and clears when the channel reads healthy again.
  private readonly lastWhy = new Map<string, string>();

  constructor(deps: SlackSourceDeps) {
    super(deps.debug);
    this.reads = deps.reads;
  }

  private noteWhy(channel: string, why: string) {
    if (!why) {
      this.lastWhy.delete(channel);
      return;
    }
    if (this.lastWhy.get(channel) !== why) {
      this.lastWhy.set(channel, why);
      console.error(
        `[forgejo-watcher] the slack read for channel ${channel} keeps its pass: ${why}`,
      );
    }
  }

  // The sender's display name: a member id resolves through the
  // directory (one read per id per pass, memoized on the pass's memo);
  // a bot username or bot id is the name already. A read that fails
  // falls back to the raw id — the wake carries who it can.
  private async senderNameOf(
    row: ParsedMessage,
    memo: PassMemo,
  ): Promise<string | undefined> {
    if (row.userId) {
      const key = `slack user ${row.userId}`;
      const memoized = memo.get(key);
      if (typeof memoized === "string") return memoized;
      let name: string;
      try {
        name =
          parseUserRow(await this.reads.usersInfo(row.userId)) ?? row.userId;
      } catch {
        name = row.userId;
      }
      memo.set(key, name);
      return name;
    }
    return row.username ?? row.botId;
  }

  kinds(): readonly string[] {
    return [SLACK_KIND];
  }

  // The kernel calls ready once at construction with the watcher options
  // block. The composer has already built the source only when readConfig
  // answered, so this re-read cannot fail in the deployed shape; it still
  // answers honestly when it would. The module readConfig — null for an
  // absent or unusable block, its own line said — throws here, and the
  // base's ready gate maps the throw to the verdict the kernel says.
  protected readConfig(watcherOptions: unknown): unknown {
    const config = readConfig(watcherOptions);
    if (!config) {
      throw new Error(
        "its config block is absent or unusable (its own line above said which)",
      );
    }
    return config;
  }

  // The register request's validation for this source's kind: the kernel
  // routes kind "slack-channel" here by the registering kind (each source
  // owns its kinds and their validation). Bad arguments throw for the
  // tool to surface. The message is this source's own pinned wording, so
  // the base's kind check does not serve it.
  normalize(req: RegisterRequest): WatchRowSeed {
    const kind = String(req.kind || "").trim();
    if (kind !== SLACK_KIND) {
      throw new Error(
        `watcher_register: kind must be "slack-channel" (got ${JSON.stringify(req.kind)})`,
      );
    }
    const note = this.normalizeNote(req);
    // repo is the literal "slack" (the watched system — and a shape the
    // projection's repo sweep, which filters on owner/name, never
    // mistakes for a repository); ref is the channel's id, and nothing
    // else identity-wise: v1 carries the channel id alone.
    const repo = String(req.repo || "").trim();
    if (repo !== "slack") {
      throw new Error(
        `watcher_register: for kind slack-channel, repo must be "slack" (got ${JSON.stringify(req.repo)})`,
      );
    }
    const ref = String(req.ref || "").trim();
    if (!ref || ref.length > 200) {
      throw new Error("watcher_register: ref must be the Slack channel's id");
    }
    return { kind, repo, ref, note };
  }

  // The register-time baseline read: the channel's current page is the
  // spent backlog — the watch wakes on messages that arrive after it. A
  // read that cannot run (an outage, an answer that does not parse)
  // leaves the row baseline-pending; the first poll pass spends its page
  // instead. The backlog never wakes, whatever the timing. The kind
  // guard and the unread-to-pending mapping are the base's template.
  protected baselineKinds(): readonly string[] {
    return [SLACK_KIND];
  }

  protected noteBaselineUnread(seed: WatchRowSeed, error: unknown): void {
    this.debug("slack.register.baseline.unread", {
      channel: seed.ref,
      error: String(error),
    });
  }

  protected async readBaseline(
    seed: WatchRowSeed,
  ): Promise<Record<string, boolean> | null> {
    const answer = await this.reads.historyOf(seed.ref, {
      limit: SLACK_HISTORY_LIMIT,
    });
    const page = parseHistoryPage(answer);
    if (!page) return null;
    return Object.fromEntries(page.rows.map((row) => [row.ts, true]));
  }

  // The poll read: one history read per watch per pass, `oldest` at the
  // watch's floor (the brief's literal read since the cursor — and the
  // shape that re-serves a message a failed write's floor never covered),
  // the answer re-filtered after the read against that floor and the
  // markers. Sender names resolve through the per-pass memo — one
  // directory read per sender per pass, shared by every watch in it.
  async poll(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    pass: PassContext,
  ): Promise<WatchEvent[] | null> {
    const channel = watch.ref;
    const floorMs = floorOf(cursor.delivered);
    let answer: unknown;
    try {
      answer = await this.reads.historyOf(channel, {
        limit: SLACK_HISTORY_LIMIT,
        ...(Number.isFinite(floorMs) ? { oldest: String(floorMs) } : {}),
      });
    } catch (error) {
      this.noteWhy(
        channel,
        `the history read failed: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
    const page = parseHistoryPage(answer);
    if (!page) {
      this.noteWhy(
        channel,
        "the history answer did not parse as a page of messages",
      );
      return null;
    }
    // The register-time baseline's spend: the page as it stands is the
    // backlog, spent whole, waking nobody.
    if (cursor.baselinePending) {
      this.noteWhy(channel, "");
      return page.rows.map((row) => ({
        ...messageEventOf(row),
        baseline: true,
      }));
    }
    // The storm trade, said when it changes: a full page claiming more
    // leaves its tail unserved, and once the served messages mark, the
    // floor jumps past them. The loss is named, never silent; deeper
    // paging is a later slice.
    if (page.more && page.served >= SLACK_HISTORY_LIMIT) {
      this.noteWhy(
        channel,
        `the history page came back full (${page.served} messages) and claims more; the messages past its bottom are not served and the cursor advances past them as these mark — a burst wider than the page loses its tail`,
      );
    } else {
      this.noteWhy(channel, "");
    }
    const fresh = classifyMessages(page.rows, floorMs, cursor.delivered);
    const wakes: WatchEvent[] = [];
    for (const row of fresh) {
      wakes.push(messageEventOf(row, await this.senderNameOf(row, pass.memo)));
    }
    return wakes;
  }

  // The message body: one bounded history read around the ts, before the
  // stamp write (today's read-before-mark order — the kernel calls
  // prepare first). The body rides the detail, opaque to the kernel, the
  // way the failing job's log tail does. A message the channel no longer
  // carries (deleted, drifted) reads as null — the mail names the loss
  // and the wake marks once: a retry could not fetch what the channel
  // no longer carries, and holding the wake would wedge the watch's tail
  // behind it. An empty message reads as the empty string — no body
  // section renders, the honest report for a message Slack served fine.
  // A read that fails (an outage, a 429 the client's retry could not
  // clear) throws instead of answering: the kernel's per-watch catch
  // keeps the marker unspent, and the message re-reads on the next pass,
  // where a healthy api serves the body — rendering the loss line there
  // would spend a body a retry could still fetch, the one loss this
  // source never takes.
  async prepare(watch: AdoptedWatch, event: WatchEvent) {
    const at = tsValue(event.id);
    if (at === null) return { text: null };
    let answer: unknown;
    try {
      answer = await this.reads.historyOf(watch.ref, {
        limit: SLACK_TS_WINDOW_LIMIT,
        oldest: String(at - SLACK_TS_WINDOW_S),
        latest: String(at + SLACK_TS_WINDOW_S),
      });
    } catch (error) {
      this.debug("slack.message.unread", {
        id: watch.id,
        message: event.id,
        error: String(error),
      });
      throw error;
    }
    const page = parseHistoryPage(answer);
    const found = page?.rows.find((row) => row.ts === event.id);
    return { text: found ? (found.text ?? "") : null };
  }

  render(watch: AdoptedWatch, event: WatchEvent, detail: unknown): string {
    return messageMail(
      watch,
      event,
      (detail as { text?: string | null } | null)?.text,
    );
  }

  debugOp(
    checkpoint: DeliverCheckpoint,
    watch: AdoptedWatch,
    event: WatchEvent,
  ) {
    return {
      op: `message.${checkpoint}`,
      attrs: { id: watch.id, message: event.id },
    };
  }
}
