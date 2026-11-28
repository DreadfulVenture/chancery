// The watcher kernel: one poll
// pass, the adoption walk, the registry, and the stamp machinery —
// everything the watcher sources have in common. A source is an adapter
// that reads its external system and answers normalized events; it never
// writes stamps and never delivers. The kernel is the sole writer of the
// watch registry — the `chancery.watches` rows it adopts — and the sole
// caller of the wake leg (this slice, the mailEnvelope push the family
// already uses; the delivery cutover to the director package's pull transport is a
// later slice, and the kernel is the only site that changes).
//
// The contract's exact method shapes were judged against the code:
//
// - Baseline-on-register is stamp-carried, not cursor-inferred. Register
//   spends the backlog itself (the source's baseline read), and a watch
//   whose register-time read could not run carries `baseline: "pending"`
//   on the stamp — the first pass spends its page and wakes nobody. A
//   watch whose first event is terminal must DELIVER on that first pass
//   (a watch created after a fast pipeline reports the finished result),
//   so "first pass" alone can never mean "spend silently".
// - The event is the privacy contract: its fields are id, ref, url,
//   status, measure — pointer data and machine status, values whose
//   provenance is the source's API. No free-text field exists; the
//   daemon-log adapter relies on it. The kernel validates every event at
//   its boundary — no field kind outside the union, no keys outside the
//   contract's key sets, the baseline spend included — and an event
//   outside it is refused, never marked, never delivered, said on its
//   line. Detail a verdict carries today (the failing job's log tail)
//   is the source's own read, taken in prepare() BEFORE the stamp write
//   — today's read-before-mark order, kept — and handed to render()
//   opaque to the kernel.
// - A not-yet-migrated source (PagerDuty this slice) rides as a legacy
//   leg: it may write its own row family through the kernel's stamp
//   machinery, exactly as it does today. The kernel never resets or
//   rewrites the rows it does not adopt — a patch touches only the row
//   it matched by id — so a legacy row's delivered markers stay its
//   owner's, and nothing re-wakes.
//
// The stamp is host-opaque and written back whole: a fresh read, the
// watches subtree patched, the full record sent back — setMetadata
// replaces the record, so writing the subtree alone would drop the rest
// of the record. A session that no longer answers is a stamp that left
// with it: reads come back undefined and callers keep the watch unmarked.

const STAMP = "chancery";
const WATCHES = "watches";

const CLEANUP_POLL_WAIT_MS = 2_000;

// The privacy contract's field kinds: the only
// fields a source event may carry. Enforced at the kernel's boundary on
// every event, so a source author has nowhere to put a comment body.
const FIELD_KINDS = new Set(["id", "ref", "url", "status", "measure"]);

// The event's and the field's full key sets: a key outside them is
// refused like a bad kind — the event is the contract, exactly, and
// nothing rides in under an unnamed key.
const EVENT_KEYS = new Set(["id", "type", "fields", "baseline", "terminal"]);
const FIELD_KEYS = new Set(["kind", "name", "value"]);

export type Debug = (op: string, attrs?: Record<string, unknown>) => void;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The host surface the kernel touches directly: the session reads and
// writes the stamps ride, the synthetic mail leg, and the event bus the
// adoption walk subscribes to.
export type KernelContext = {
  session: {
    get: (input: { sessionID: string }) => Promise<unknown>;
    list: (input?: { cursor?: unknown }) => Promise<unknown>;
    update: (input: {
      sessionID: string;
      metadata: Record<string, unknown>;
    }) => Promise<unknown>;
    synthetic: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
  event: {
    subscribe: (input: {
      signal: AbortSignal;
    }) => AsyncIterable<{ type: string; data?: unknown }>;
  };
};

// The stamp row the machinery reads and patches: the `chancery.watches`
// row, host-opaque beyond the fields the machinery names. The kernel's
// in-memory watch carries one field the stamp never sees (`source`) —
// stampRowOf strips it again on the way in.
export type StampRow = {
  id?: unknown;
  session?: unknown;
  kind?: unknown;
  repo?: unknown;
  ref?: unknown;
  note?: unknown;
  delivered?: unknown;
  baseline?: unknown;
  claimedBy?: unknown;
  [key: string]: unknown;
};

// The privacy contract: the only fields an event may carry. `name` is
// the source's own label for the field (structural, not content); the
// kinds are the contract — pointer data and machine status only.
export type WatchField =
  | { kind: "id"; name: string; value: string }
  | { kind: "ref"; name: string; value: string }
  | { kind: "url"; name: string; value: string }
  | { kind: "status"; name: string; value: string }
  | { kind: "measure"; name: string; value: string };

export type WatchEvent = {
  /** The event's once-only identity — the delivered marker's key. */
  id: string;
  /** Source-namespaced structural tag; render and prepare dispatch on it. */
  type: string;
  fields: WatchField[];
  /** Spend-only: the kernel marks the id and never delivers it. */
  baseline?: boolean;
  /** The watch dissolves after this event's one terminal delivery. */
  terminal?: boolean;
};

// The cursor a poll reads: the watch's progress, kernel-persisted on the
// stamp (the delivered markers are the cursor's store) and interpreted
// by the source. `baselinePending` is the stamp-carried register-baseline
// flag, not a first-pass inference — see the header comment.
export type WatchCursor = {
  delivered: Record<string, boolean>;
  baselinePending: boolean;
};

// The per-pass read memo: one read per (source, surface) key, shared by
// every consumer in the pass — the wakes and whatever the composer wires
// after them (the projection this slice).
export type PassMemo = Map<string, unknown>;
export type PassContext = { memo: PassMemo };

export type RegisterRequest = {
  kind?: unknown;
  repo?: unknown;
  ref?: unknown;
  note?: unknown;
  [key: string]: unknown;
};

// The canonical register request, validated by the source's normalize.
export type WatchRowSeed = {
  kind: string;
  repo: string;
  ref: string;
  note: string | null;
};

// The kernel's in-memory watch: the adopted row plus the source that
// owns it (in-memory only — never stamped).
export type AdoptedWatch = {
  source: string;
  id: string;
  session: string;
  kind: string;
  repo: string;
  ref: string;
  delivered: Record<string, boolean>;
  baseline?: "pending";
  claimedBy?: string;
  note?: string;
};

export type ReadyResult<C> =
  | { ok: true; config: C }
  | { ok: false; reason: string };

// The debug ops the kernel emits at the delivery discipline's
// checkpoints. The ops are the source's to name (the id namespaces the
// log lines); a source that says nothing gets generic ones.
export type DeliverCheckpoint = "unstamped" | "already" | "delivered";

// A source adapter. ready() receives the watcher's options block and
// reads its own namespace within it (the forge source's keys are the
// block's own — today's surface; a new source reads config[id]).
export interface WatchSource {
  readonly id: string;
  ready(config: unknown): ReadyResult<unknown>;
  /** The watch kinds the source polls; feeds the registry's adoption. */
  kinds(): readonly string[];
  /**
   * The claim group a kind belongs to, when a second register on the
   * same repo+ref must return the claimed watch instead of a second
   * owner (the forge source's pr and branch share one group). Null when
   * the kind is never claimed.
   */
  claimGroupOf(kind: string): string | null;
  /**
   * Validate and canonicalize one register request. Bad arguments throw
   * for the tool to surface — the error strings are the source's.
   */
  normalize(req: RegisterRequest): WatchRowSeed;
  /**
   * The register-time baseline read, when the kind has one (the
   * forge source's pr-reviews): the events the source already carries
   * at register are the spent backlog. Answers the spent ids; null
   * means the read could not run — the row is stamped baseline-pending
   * and the first poll pass spends its page instead. A throw reads the
   * same.
   */
  baseline?(seed: WatchRowSeed): Promise<Record<string, boolean> | null>;
  /**
   * The pure read: one watch's pass, answering normalized events.
   * cursor === null semantics live in the cursor's fields, not in
   * null — see WatchCursor. Null answers "the read gave nothing usable"
   * (the pass skips; a baseline-pending row keeps its flag); an array
   * answers a successful read (a baseline-pending row spends it, empty
   * or not). Never writes stamps, never delivers.
   */
  poll(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    pass: PassContext,
  ): Promise<WatchEvent[] | null>;
  /**
   * The verdict's detail reads, taken BEFORE the stamp write so that
   * nothing but the mail follows it (today's verdictDetail order). The
   * answer is opaque to the kernel and handed to render. Absent for
   * sources whose events carry no detail.
   */
  prepare?(watch: AdoptedWatch, event: WatchEvent): Promise<unknown>;
  /** The verdict: the wake text the kernel delivers verbatim. */
  render(watch: AdoptedWatch, event: WatchEvent, detail: unknown): string;
  /** The checkpoints' debug ops, source-named. Optional. */
  debugOp?(
    checkpoint: DeliverCheckpoint,
    watch: AdoptedWatch,
    event: WatchEvent,
  ): { op: string; attrs?: Record<string, unknown> };
}

// A legacy leg: a not-yet-migrated source's pass, run inside the kernel's
// pass with the same isolation. It may write its own row family through
// the kernel's stamp machinery; the kernel never adopts its rows.
export type WatchLeg = {
  id: string;
  poll: () => Promise<void>;
};

export type KernelOptions = {
  ctx: KernelContext;
  debug: Debug;
  pollMs: number;
  /**
   * The sources' shared config surface (the watcher's options block),
   * handed to each source's ready() once at construction; each source
   * reads its own namespace within it. Omitted: every source stands.
   */
  config?: unknown;
  sources: WatchSource[];
  legs?: WatchLeg[];
  /** The composer's own after-stage (the projection sync this slice). */
  afterPass?: (memo: PassMemo) => Promise<void>;
};

export type RegisterOutcome =
  | { outcome: "claimed"; id: string; claimedBy: string }
  | { outcome: "existing"; id: string }
  | {
      outcome: "registered";
      id: string;
      kind: string;
      repo: string;
      ref: string;
    };

export type WatcherKernel = {
  register(req: RegisterRequest, caller: string): Promise<RegisterOutcome>;
  forget(id: string, caller: string): Promise<void>;
  watches(): AdoptedWatch[];
  isStopped(): boolean;
  failedWrites: Set<string>;
  cleanup(): Promise<void>;
};

export function stampOf(metadata: unknown): StampRow[] | null {
  if (!isRecord(metadata)) return null;
  const stamp = metadata[STAMP];
  if (!isRecord(stamp) || !Array.isArray(stamp[WATCHES])) return null;
  return stamp[WATCHES] as StampRow[];
}

// The stamp is host-opaque and written back whole: a fresh read, the
// watches subtree patched, the full record sent back. A session that no
// longer answers is a stamp that left with it: reads come back undefined
// and callers keep the watch unmarked.
export async function readStamps(
  ctx: KernelContext,
  debug: Debug,
  sessionID: string,
): Promise<StampRow[] | null | undefined> {
  try {
    const info = (await ctx.session.get({ sessionID })) as
      | { metadata?: unknown }
      | undefined;
    return stampOf(info?.metadata);
  } catch {
    debug("stamp.session.gone", { session: sessionID });
    return undefined;
  }
}

export async function writeStamps(
  ctx: KernelContext,
  sessionID: string,
  rows: StampRow[],
): Promise<boolean> {
  let info;
  try {
    info = (await ctx.session.get({ sessionID })) as
      | { metadata?: unknown }
      | undefined;
  } catch {
    return false;
  }
  const fresh: Record<string, unknown> = { ...(info?.metadata ?? {}) };
  const chancery: Record<string, unknown> = {
    ...(isRecord(fresh[STAMP]) ? fresh[STAMP] : {}),
  };
  chancery[WATCHES] = rows;
  fresh[STAMP] = chancery;
  try {
    await ctx.session.update({ sessionID, metadata: fresh });
  } catch (error) {
    console.error(
      `[forgejo-watcher] stamp write to ${sessionID} failed: ${error}`,
    );
    return false;
  }
  return true;
}

// The patch fn returns the new rows array, or null when the watch is gone
// from the fresh stamp — forgotten between adoption and this write.
// Returns the patched rows on a written stamp, null for a forgotten row,
// false when the write itself failed (a transient stamp fault: the caller
// keeps its row and re-attempts on the next pass), undefined when the
// session is gone (the stamp left with it). An unchanged array is still
// an attempted write — the answer is then the array or false, never
// null: a patch that finds its row already in the shape it wants returns
// the array and lets the write commit (the pagerduty source's
// failedWrites recovery re-attempts exactly that way).
export async function patchStamps(
  ctx: KernelContext,
  debug: Debug,
  sessionID: string,
  patch: (rows: StampRow[]) => StampRow[] | null,
): Promise<StampRow[] | null | false | undefined> {
  const rows = await readStamps(ctx, debug, sessionID);
  if (rows === undefined) return undefined;
  const copies = (rows ?? []).map((row) => (isRecord(row) ? { ...row } : row));
  const next = patch(copies);
  if (next === null) return null;
  return (await writeStamps(ctx, sessionID, next)) ? next : false;
}

// The event's shape at the kernel's boundary: an id, a type, and fields
// inside the privacy contract — no extra keys, no kind outside the
// union, no non-string values. Anything else is refused — never marked,
// never delivered.
const eventWhy = (event: unknown): string | null => {
  if (!isRecord(event)) return "the event is not a record";
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) {
      return `the event carries a key outside the contract: ${JSON.stringify(key)}`;
    }
  }
  if (typeof event.id !== "string" || !event.id) return "the event has no id";
  if (typeof event.type !== "string" || !event.type) {
    return "the event has no type";
  }
  if (!Array.isArray(event.fields)) return "the event has no fields";
  for (const field of event.fields) {
    if (!isRecord(field)) return "a field is not a record";
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS.has(key)) {
        return `a field carries a key outside the contract: ${JSON.stringify(key)}`;
      }
    }
    if (typeof field.kind !== "string" || !FIELD_KINDS.has(field.kind)) {
      return `field kind ${JSON.stringify(field.kind ?? null)} is outside the contract (id, ref, url, status, measure)`;
    }
    if (typeof field.name !== "string" || !field.name) {
      return `field ${field.kind} carries no name`;
    }
    if (typeof field.value !== "string") {
      return `field ${field.kind} carries a non-string value`;
    }
  }
  return null;
};

// The delivered map's reads go through the object's own keys only: an
// event id that shadows a prototype member ("toString", "__proto__")
// must neither read as spent (a silent drop) nor write into the
// prototype. The writes are computed-key defines — own properties, safe
// for any id.
const ownedDelivered = (delivered: unknown, id: string): boolean =>
  isRecord(delivered) && Object.prototype.hasOwnProperty.call(delivered, id);

export function createWatcherKernel(options: KernelOptions): WatcherKernel {
  const { ctx, debug, pollMs } = options;

  // A source that cannot run disables itself: ready() is called once,
  // here, with the shared config surface — ok is in, ok:false is said
  // once on its own named line and the family carries on without it.
  const sources: WatchSource[] = [];
  for (const source of options.sources) {
    if (options.config === undefined) {
      sources.push(source);
      continue;
    }
    const verdict = source.ready(options.config);
    if (verdict.ok) {
      sources.push(source);
    } else {
      console.error(
        `[forgejo-watcher] the ${source.id} source is off: ${verdict.reason}`,
      );
    }
  }

  const legs = options.legs ?? [];

  // Adopted watches, keyed by id: the in-memory mirror of the stamps the
  // poller walks. The stamp is the durable record — a reload rebuilds this
  // map from a walk over the live session list, and the delivered markers
  // ride the same stamp, so a restart cannot re-deliver a spent verdict.
  const registry = new Map<string, AdoptedWatch>();
  // `${watch.id} ${event.id}` for each verdict whose stamp write threw: the
  // write may still have been applied, so a marker found next pass is
  // this instance's, and its mail is still owed.
  const failedWrites = new Set<string>();

  // kind → source, first registration wins on a shared kind.
  const sourceOfKind = new Map<string, WatchSource>();
  for (const source of sources) {
    for (const kind of source.kinds()) {
      if (!sourceOfKind.has(kind)) sourceOfKind.set(kind, source);
    }
  }

  // One pass at a time; a pass that fails anywhere is said and left to the
  // next tick — no throw ever escapes the loop. Once stopped, a pass in
  // flight starts no stamp write; one already inside its stamp write
  // finishes it and sends that verdict's mail.
  let polling = false;
  let stopped = false;
  let pass = Promise.resolve();

  const mintWatchID = () => `w-${crypto.randomUUID().slice(0, 8)}`;

  // Adoption reads without writing: a row whose kind sits outside the
  // registered kinds (a legacy leg's own row family) keeps its delivered
  // markers exactly as its owner wrote them; nothing rebuilds it.
  const adopt = (sessionID: string, metadata: unknown) => {
    const rows = stampOf(metadata);
    if (!rows) return;
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string" || !row.id) continue;
      const source = sourceOfKind.get(String(row.kind));
      if (!source) continue;
      if (registry.has(row.id)) continue;
      const session =
        typeof row.session === "string" && row.session
          ? row.session
          : sessionID;
      const watch: AdoptedWatch = {
        source: source.id,
        id: row.id,
        session,
        kind: String(row.kind),
        repo: typeof row.repo === "string" ? row.repo : "",
        ref: typeof row.ref === "string" ? row.ref : "",
        delivered: isRecord(row.delivered)
          ? ({ ...row.delivered } as Record<string, boolean>)
          : {},
        // A register whose own baseline read could not run leaves the
        // baseline to the first poll pass; the marker rides the stamp so
        // a reload does not turn it back into a backlog wake.
        ...(row.baseline === "pending" ? { baseline: "pending" as const } : {}),
        ...(row.claimedBy && typeof row.claimedBy === "string"
          ? { claimedBy: row.claimedBy }
          : {}),
        ...(row.note && typeof row.note === "string" ? { note: row.note } : {}),
      };
      registry.set(row.id, watch);
      debug("watch.adopted", {
        id: watch.id,
        session: watch.session,
        kind: watch.kind,
      });
    }
  };

  // Reload adoption: watches stamped on live sessions carry
  // `chancery.watches` in durable metadata, so an activation that starts
  // late re-adopts them from a cross-directory walk instead of losing
  // their verdicts. The paging cap keeps a pathological session list from
  // spinning the loop (the module's walk shape).
  void (async () => {
    try {
      let cursor: unknown;
      for (let page = 0; page < 10; page += 1) {
        const listed = await ctx.session.list(cursor ? { cursor } : undefined);
        const rows = Array.isArray(listed)
          ? listed
          : ((listed as { data?: unknown[] })?.data ?? []);
        for (const row of rows) {
          const record = row as { id?: unknown; metadata?: unknown };
          if (record && typeof record.id === "string") {
            adopt(record.id, record.metadata);
          }
        }
        cursor = Array.isArray(listed)
          ? undefined
          : (listed as { cursor?: { next?: unknown } })?.cursor?.next;
        if (!cursor) break;
      }
    } catch (error) {
      console.error(`[forgejo-watcher] reload adoption failed: ${error}`);
    }
  })();

  const opsOf = (
    source: WatchSource,
    watch: AdoptedWatch,
    event: WatchEvent,
    checkpoint: DeliverCheckpoint,
  ) => {
    const named = source.debugOp?.(checkpoint, watch, event);
    debug(
      named?.op ?? `event.${checkpoint}`,
      named?.attrs ?? {
        id: watch.id,
        event: event.id,
      },
    );
  };

  // A source event outside the contract: said on its own line, never
  // marked, never delivered. Its id is free to return well-formed on a
  // later pass.
  const refuseEvent = (
    source: WatchSource,
    watch: AdoptedWatch,
    event: unknown,
    why: string,
  ) => {
    console.error(
      `[forgejo-watcher] the ${source.id} source returned a bad event ${JSON.stringify(
        isRecord(event) && typeof event.id === "string" ? event.id : null,
      )} on watch ${watch.id}: ${why}`,
    );
  };

  // Remove the watch's row from its session's stamp: the poller's answer
  // to the close, so no forget follows. A removal that cannot commit
  // retries on the next pass — the delivered marker already stops any
  // second event meanwhile.
  const dissolveWatch = async (watch: AdoptedWatch) => {
    const next = await patchStamps(ctx, debug, watch.session, (rows) =>
      rows.filter((candidate) => candidate?.id !== watch.id),
    );
    if (next === false) {
      debug("watch.undissolved", { id: watch.id });
      return;
    }
    registry.delete(watch.id);
    debug("watch.dissolved", { id: watch.id });
  };

  // Mark first, deliver second: a verdict is delivered once, ever — the
  // stamp write makes the event's verdict spent even if the mail leg then
  // fails, and that miss is said, not retried (the module's mail rule).
  // Once a stamp is written the mail is sent, stopped or not; a pass
  // stopped before its stamp write leaves the verdict unspent for the
  // next load. The detail reads happened in prepare, before the mark —
  // nothing but the mail follows the write.
  const deliver = async (
    source: WatchSource,
    watch: AdoptedWatch,
    event: WatchEvent,
  ) => {
    if (stopped) return;
    const detail = source.prepare
      ? await source.prepare(watch, event)
      : undefined;
    if (stopped) {
      opsOf(source, watch, event, "unstamped");
      return;
    }
    // A fresh stamp already marking this event was written either by this
    // instance, in a write that threw after it was applied (this instance
    // mails it now), or by another instance (one cleaned up mid-verdict)
    // after this one adopted the watch (that instance mails it).
    const attempt = `${watch.id} ${event.id}`;
    let spent = false;
    const next = await patchStamps(ctx, debug, watch.session, (rows) => {
      const row = rows.find((candidate) => candidate?.id === watch.id);
      if (!row) return null;
      if (ownedDelivered(row.delivered, event.id)) {
        if (failedWrites.has(attempt)) return rows;
        spent = true;
        return null;
      }
      row.delivered = {
        ...(isRecord(row.delivered) ? row.delivered : {}),
        [event.id]: true,
      };
      return rows;
    });
    if (spent) {
      watch.delivered[event.id] = true;
      opsOf(source, watch, event, "already");
      return;
    }
    if (next === null) {
      registry.delete(watch.id);
      debug("watch.forgotten", { id: watch.id, [event.type]: event.id });
      return;
    }
    if (next === undefined) {
      registry.delete(watch.id);
      debug("watch.inert", { id: watch.id, [event.type]: event.id });
      return;
    }
    if (next === false) {
      // The stamp write failed: the verdict may not be marked, and the
      // next pass re-attempts and mails. Sending the mail now would
      // double-deliver on the next pass.
      failedWrites.add(attempt);
      return;
    }
    failedWrites.delete(attempt);
    watch.delivered[event.id] = true;
    const mail = source.render(watch, event, detail);
    try {
      await ctx.session.synthetic({ sessionID: watch.session, text: mail });
    } catch (error) {
      console.error(
        `[forgejo-watcher] mail delivery to ${watch.session} failed: ${error}`,
      );
    }
    opsOf(source, watch, event, "delivered");
  };

  // A terminal event's one mail, before the watch dissolves: the stamp
  // discipline is the verdict's, staged — mark the close on the row,
  // mail, then remove the row. The marker is the once-only record, so a
  // mail miss is said and never retried, and the dissolve is only ever
  // attempted after this pass's marker write committed.
  const settleTerminal = async (
    source: WatchSource,
    watch: AdoptedWatch,
    event: WatchEvent,
  ) => {
    if (stopped) return;
    const attempt = `${watch.id} ${event.id}`;
    let spentOrOwed = false;
    const next = await patchStamps(ctx, debug, watch.session, (rows) => {
      const row = rows.find((candidate) => candidate?.id === watch.id);
      if (!row) return null;
      if (ownedDelivered(row.delivered, event.id)) {
        // Marked before — by this instance's failed write, or by another
        // pass or instance. Either way the removal rides this write; the
        // mail decision is made against failedWrites after it commits.
        spentOrOwed = true;
        return rows.filter((candidate) => candidate?.id !== watch.id);
      }
      row.delivered = {
        ...(isRecord(row.delivered) ? row.delivered : {}),
        [event.id]: true,
      };
      return rows;
    });
    if (next === undefined) {
      registry.delete(watch.id);
      debug("watch.inert", { id: watch.id });
      return;
    }
    if (next === null) {
      registry.delete(watch.id);
      debug("watch.forgotten", { id: watch.id });
      return;
    }
    if (next === false) {
      if (spentOrOwed) return;
      // The mark may have applied: the next pass re-reads, finds the
      // marker, and mails it as its own failed write.
      failedWrites.add(attempt);
      opsOf(source, watch, event, "unstamped");
      return;
    }
    if (spentOrOwed && !failedWrites.has(attempt)) {
      // Another pass or instance marked the close and holds the mail:
      // the removal (committed above) is this pass's whole job.
      registry.delete(watch.id);
      opsOf(source, watch, event, "already");
      return;
    }
    // This pass's write committed: any attempt it retired is spent, and a
    // fresh mark carries the mail.
    failedWrites.delete(attempt);
    if (!spentOrOwed) watch.delivered[event.id] = true;
    const mail = source.render(watch, event, undefined);
    try {
      await ctx.session.synthetic({ sessionID: watch.session, text: mail });
    } catch (error) {
      console.error(
        `[forgejo-watcher] mail delivery to ${watch.session} failed: ${error}`,
      );
    }
    opsOf(source, watch, event, "delivered");
    if (!spentOrOwed) {
      await dissolveWatch(watch);
      return;
    }
    // Owed mail, retired above: the removal rode the same committed write.
    registry.delete(watch.id);
    debug("watch.dissolved", { id: watch.id });
  };

  // The baseline spend: a register whose own baseline read could not run
  // (the source was down, the entry unusable) left the baseline to this
  // pass — the page as it stands is the backlog, spent whole, waking
  // nobody. The spend sends no mail, so a write that failed after
  // applying needs no failedWrites record — the next pass reads the
  // taken marker and wakes nothing either way.
  const spendBaseline = async (
    source: WatchSource,
    watch: AdoptedWatch,
    events: WatchEvent[],
  ) => {
    const ids = events
      .filter((event) => event.baseline === true)
      .map((event) => event.id);
    const spent = await patchStamps(ctx, debug, watch.session, (rows) => {
      const row = rows.find((candidate) => candidate?.id === watch.id);
      if (!row) return null;
      row.delivered = {
        ...(isRecord(row.delivered) ? row.delivered : {}),
        ...Object.fromEntries(ids.map((id) => [id, true])),
      };
      delete row.baseline;
      return rows;
    });
    if (spent === null) {
      registry.delete(watch.id);
      debug("watch.forgotten", { id: watch.id });
      return;
    }
    if (spent === undefined) {
      registry.delete(watch.id);
      debug("watch.inert", { id: watch.id });
      return;
    }
    if (spent === false) return;
    watch.baseline = undefined;
    for (const id of ids) watch.delivered[id] = true;
    // The family's historical op name for the spend — the forge source's
    // pr-reviews is the spender this slice — kept so the MEMORY_SPAN_LOG
    // debug surface reads exactly as before.
    debug("review.baseline.spent", { id: watch.id, count: ids.length });
  };

  const pollWatch = async (
    source: WatchSource,
    watch: AdoptedWatch,
    memo: PassMemo,
  ) => {
    const cursor: WatchCursor = {
      delivered: watch.delivered,
      baselinePending: watch.baseline === "pending",
    };
    const events = await source.poll(watch, cursor, { memo });
    if (events === null) return;
    if (cursor.baselinePending) {
      // The privacy contract holds on the spend path too: a baseline
      // event outside the union is refused exactly as a deliverable one
      // — said once, never marked.
      const spendable: WatchEvent[] = [];
      for (const event of events) {
        const why = eventWhy(event);
        if (why) {
          refuseEvent(source, watch, event, why);
          continue;
        }
        spendable.push(event);
      }
      await spendBaseline(source, watch, spendable);
      return;
    }
    for (const event of events) {
      if (stopped) break;
      // The privacy contract, enforced at the boundary: an event
      // carrying a field or key outside the contract is refused — never
      // marked, never delivered, said on its line.
      const why = eventWhy(event);
      if (why) {
        refuseEvent(source, watch, event, why);
        continue;
      }
      // The spent pre-check guards only the plain delivery: a terminal
      // event's settle must run even when this pass's copy of the row
      // already carries the marker — a dissolve whose write failed last
      // pass heals here, the removal riding the marked write (the old
      // settleLifecycle's heal).
      if (event.terminal) {
        await settleTerminal(source, watch, event);
        continue;
      }
      if (ownedDelivered(watch.delivered, event.id)) continue;
      await deliver(source, watch, event);
    }
  };

  // One pass at a time; a pass that fails anywhere is said and left to the
  // next tick — no throw ever escapes the loop. Once stopped, a pass in
  // flight starts no stamp write; one already inside its stamp write
  // finishes it and sends that verdict's mail. (The pass's own state —
  // polling, stopped, the pass promise — lives above, beside the
  // registry; the timer below drives the passes.)
  const pollOnce = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      // The pass's read memo: one read per source surface, shared by every
      // consumer in this pass — the wakes and the composer's after-stage.
      const memo: PassMemo = new Map();
      for (const source of sources) {
        for (const watch of [...registry.values()]) {
          if (stopped) break;
          if (watch.source !== source.id) continue;
          try {
            await pollWatch(source, watch, memo);
          } catch (error) {
            console.error(
              `[forgejo-watcher] watch ${watch.id} poll failed: ${error}`,
            );
          }
        }
      }
      // The legacy legs (the not-yet-migrated sources): each one's
      // failure says and moves on; the pass carries on.
      for (const leg of legs) {
        try {
          await leg.poll();
        } catch (error) {
          console.error(
            `[forgejo-watcher] the ${leg.id} pass failed: ${error}`,
          );
        }
      }
      // The composer's after-stage (the projection sync this slice),
      // sharing the pass's memo; it isolates its own failures.
      if (options.afterPass) {
        await options.afterPass(memo);
      }
    } finally {
      polling = false;
    }
    debug("poll.pass", { watches: registry.size });
  };

  const timer = setInterval(() => {
    if (!polling) pass = pollOnce();
  }, pollMs);

  // The family tool surface calls these; the tool definitions and their
  // schemas stay with the composer.
  const register = async (
    rawReq: RegisterRequest,
    caller: string,
  ): Promise<RegisterOutcome> => {
    const req: RegisterRequest = rawReq ?? {};
    const kind = String(req.kind || "").trim();
    const source = sources.find((candidate) =>
      candidate.kinds().includes(kind),
    );
    if (!source) {
      throw new Error(
        `watcher_register: kind must be one of ${sources
          .flatMap((candidate) => candidate.kinds())
          .join(", ")} (got ${JSON.stringify(req.kind)})`,
      );
    }
    const seed = source.normalize(req);

    // One reviewer-owner per claim group: a second register on the same
    // repo+ref returns the claimed watch instead of creating a second
    // owner.
    const claimGroup = source.claimGroupOf(seed.kind);
    if (claimGroup !== null) {
      const claimed = [...registry.values()].find(
        (watch) =>
          source.claimGroupOf(watch.kind) === claimGroup &&
          watch.repo === seed.repo &&
          watch.ref === seed.ref,
      );
      if (claimed) {
        debug("watch.claimed", { id: claimed.id, ref: seed.ref });
        return {
          outcome: "claimed",
          id: claimed.id,
          claimedBy: claimed.session,
        };
      }
    }
    const own = [...registry.values()].find(
      (watch) =>
        watch.session === caller &&
        watch.kind === seed.kind &&
        watch.repo === seed.repo &&
        watch.ref === seed.ref,
    );
    if (own) return { outcome: "existing", id: own.id };

    // The register-time baseline: the source's own read. A read that
    // cannot run leaves the row baseline-pending — the first poll pass
    // spends its page instead, so the backlog never wakes, whatever the
    // timing.
    let spentMap: Record<string, boolean> = {};
    let pending = false;
    if (source.baseline) {
      try {
        const spent = await source.baseline(seed);
        if (spent === null) pending = true;
        else spentMap = spent;
      } catch {
        pending = true;
      }
    }

    const watch: AdoptedWatch = {
      source: source.id,
      id: mintWatchID(),
      session: caller,
      kind: seed.kind,
      repo: seed.repo,
      ref: seed.ref,
      ...(claimGroup !== null ? { claimedBy: caller } : {}),
      ...(pending ? { baseline: "pending" as const } : {}),
      ...(seed.note ? { note: seed.note } : {}),
      delivered: spentMap,
    };
    const stamped = await patchStamps(ctx, debug, caller, (rows) => [
      ...rows,
      stampRowOf(watch),
    ]);
    if (stamped === false || stamped === undefined) {
      throw new Error(
        `[forgejo-watcher] watcher_register: the stamp write to ${caller} failed; try again`,
      );
    }
    registry.set(watch.id, { ...watch });
    debug("watch.registered", { id: watch.id, ref: seed.ref });
    return {
      outcome: "registered",
      id: watch.id,
      kind: seed.kind,
      repo: seed.repo,
      ref: seed.ref,
    };
  };

  const forget = async (id: string, caller: string) => {
    const held = registry.get(id);
    if (!held) throw new Error(`watcher_forget: no such watch ${id}`);
    if (held.session !== caller) {
      throw new Error(
        `watcher_forget: watch ${id} is claimed by ${held.session}; only its owner can forget it`,
      );
    }
    const rows = await readStamps(ctx, debug, caller);
    const remaining = (rows ?? []).filter((row) => row?.id !== id);
    const written = await writeStamps(ctx, caller, remaining);
    if (!written) {
      throw new Error(
        `watcher_forget: the stamp write failed; the watch ${id} stays until a later forget`,
      );
    }
    registry.delete(id);
    debug("watch.forgotten", { id });
  };

  // The event handler's errors are said and swallowed: one session's
  // metadata drift never takes the pass down.
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        try {
          const data = (event.data ?? {}) as {
            sessionID?: unknown;
            metadata?: unknown;
          };
          switch (event.type) {
            case "session.created":
              if (typeof data.sessionID === "string") {
                adopt(data.sessionID, data.metadata);
              }
              break;
            case "session.deleted": {
              for (const watch of [...registry.values()]) {
                if (watch.session === data.sessionID) registry.delete(watch.id);
              }
              break;
            }
          }
        } catch (handlerError) {
          console.error(
            `[forgejo-watcher] event handler failed (${event.type}): ${handlerError}`,
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`[forgejo-watcher] event subscription failed: ${error}`);
      }
    }
  })();

  return {
    register,
    forget,
    watches: () => [...registry.values()],
    isStopped: () => stopped,
    failedWrites,
    // OpenCode awaits the returned cleanup (packages/plugin/src/promise/
    // adapter.ts, v2.0.29). Each step runs even when the one before
    // throws; the composer appends its own steps after these.
    cleanup: async () => {
      await step("timer", () => clearInterval(timer));
      await step("event subscription", () => controller.abort());
      await step("poll pass", () => {
        let waited: ReturnType<typeof setTimeout>;
        return Promise.race([
          pass,
          new Promise((resolve) => {
            waited = setTimeout(resolve, CLEANUP_POLL_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(waited));
      });
      stopped = true;
    },
  };
}

// The stamped row: the kernel's in-memory watch minus the source field —
// today's `chancery.watches` row, byte for byte.
const stampRowOf = (watch: AdoptedWatch): StampRow => ({
  id: watch.id,
  session: watch.session,
  kind: watch.kind,
  repo: watch.repo,
  ref: watch.ref,
  ...(watch.claimedBy ? { claimedBy: watch.claimedBy } : {}),
  ...(watch.baseline ? { baseline: watch.baseline } : {}),
  ...(watch.note ? { note: watch.note } : {}),
  delivered: watch.delivered,
});

const step = async (name: string, fn: () => unknown) => {
  try {
    await fn();
  } catch (error) {
    console.error(`[forgejo-watcher] cleanup: ${name} failed: ${error}`);
  }
};
