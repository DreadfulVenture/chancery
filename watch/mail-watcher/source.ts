// The source-contract base class (kernel.ts, docs/adr/20261119-watcher-family.md):
// what the source adapters share, defined once. The kernel owns the pass
// machinery — the poll pass, the registry and its adoption walk, the stamp
// machinery, the mark-first/mail-second delivery discipline, the claims-row
// lifecycle — and keeps its `WatchSource` interface for its own typing (this
// class implements it; instances satisfy the contract structurally, so the
// kernel never changes). What the factories duplicated around that contract
// lives here: the ready gate over the source's own config read, the
// registration plumbing's common half (the kind check, the note limit), the
// register-time baseline template (the kind guard, the unread-to-pending
// mapping), the never-claimed default, and the delivered map's owned-key
// read — the cursor machinery the kernel's markers carry.
//
// A subclass defines only its own specifics: its id and kinds, its config
// read, its register validation's kind-specific half (repo and ref), its
// external reads (poll), its wake renders, and the optional detail reads and
// debug ops. Credentials ride the configuration (each source's own namespace
// with the environment fallback) and never reach an error message or a log
// line.

import type {
  AdoptedWatch,
  Debug,
  PassContext,
  ReadyResult,
  RegisterRequest,
  WatchCursor,
  WatchEvent,
  WatchRowSeed,
} from "./kernel.ts";
// The kernel's contract, aliased: the kernel keeps typing against its own
// interface; this class implements it.
import type { WatchSource as WatchSourceContract } from "./kernel.ts";

export abstract class WatchSource implements WatchSourceContract {
  protected constructor(debug: Debug) {
    this.debug = debug;
  }
  protected readonly debug: Debug;

  abstract readonly id: string;

  // The source's config read, from the shared watcher options block: the
  // source's own namespace within it, credentials from configuration with
  // the environment fallback. Unusable config throws — the messages are
  // the source's own ready reasons, named once — and the ready gate
  // catches.
  protected abstract readConfig(config: unknown): unknown;

  // The kernel's gate, called once at construction with the shared config
  // surface: ok is in, ok:false is said once on the source's own named
  // line and the family carries on without it.
  ready(config: unknown): ReadyResult<unknown> {
    try {
      return { ok: true, config: this.readConfig(config) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** The watch kinds the source polls; feeds the registry's adoption. */
  abstract kinds(): readonly string[];

  // The claim group a kind belongs to, when a second register on the same
  // repo+ref must return the claimed watch instead of a second owner.
  // Defined once: no kind is claimed unless the source says so.
  claimGroupOf(_kind: string): string | null {
    return null;
  }

  // The register's kind half: trim, and reject outside the source's kinds.
  // The message is today's forge and github wording — the kinds list read
  // off the source itself. A source whose pinned message differs overrides
  // this (the slack kind's quoted wording).
  protected checkKind(req: RegisterRequest): string {
    const kind = String(req.kind || "").trim();
    if (!this.kinds().includes(kind)) {
      throw new Error(
        `watcher_register: kind must be one of ${this.kinds().join(", ")} (got ${JSON.stringify(req.kind)})`,
      );
    }
    return kind;
  }

  // The register's note half, every source's: trim, the 200-character
  // limit, null when empty.
  protected normalizeNote(req: RegisterRequest): string | null {
    const note = String(req.note ?? "").trim();
    if (note.length > 200) {
      throw new Error("watcher_register: note must be 200 characters or less");
    }
    return note || null;
  }

  /**
   * Validate and canonicalize one register request. Bad arguments throw
   * for the tool to surface — the error strings are the source's.
   */
  abstract normalize(req: RegisterRequest): WatchRowSeed;

  // The kinds whose register reads a baseline page (the rest register
  // with nothing spent).
  protected baselineKinds(): readonly string[] {
    return [];
  }

  /**
   * The register-time baseline read for a baseline kind: the items the
   * source already carries at register are the spent backlog. Answers the
   * spent ids; null means the read could not run — the row is stamped
   * baseline-pending and the first poll pass spends its page instead. A
   * throw reads the same.
   */
  protected abstract readBaseline(
    seed: WatchRowSeed,
  ): Promise<Record<string, boolean> | null>;

  // The named line when the register-time baseline read cannot run. The
  // default op is the forge's; a source with its own op overrides this.
  protected noteBaselineUnread(_seed: WatchRowSeed, error: unknown): void {
    this.debug("register.baseline.unread", { error: String(error) });
  }

  // The baseline template: the kind guard, the read, the unread-to-pending
  // mapping — the kernel stamps the watch baseline-pending on null, and
  // the first poll pass spends its page instead — the backlog never wakes,
  // whatever the timing.
  async baseline(seed: WatchRowSeed): Promise<Record<string, boolean> | null> {
    if (!this.baselineKinds().includes(seed.kind)) return {};
    try {
      return await this.readBaseline(seed);
    } catch (error) {
      this.noteBaselineUnread(seed, error);
      return null;
    }
  }

  /**
   * The pure read: one watch's pass, answering normalized events. The
   * floor's interpretation is the source's own (an id-set membership or a
   * numeric-ts floor); the base's isSpent is the delivered map's read.
   * Null answers "the read gave nothing usable"; an array answers a
   * successful read. Never writes stamps, never delivers.
   */
  abstract poll(
    watch: AdoptedWatch,
    cursor: WatchCursor,
    pass: PassContext,
  ): Promise<WatchEvent[] | null>;

  /** The verdict: the wake text the kernel delivers verbatim. */
  abstract render(
    watch: AdoptedWatch,
    event: WatchEvent,
    detail: unknown,
  ): string;

  // The delivered map's read, through the object's own keys only: an
  // event id that shadows a prototype member ("toString", "__proto__")
  // must neither read as spent (a silent drop) nor write into the
  // prototype — the slack source's rule, now every source's.
  protected isSpent(cursor: WatchCursor, id: string | number): boolean {
    return Object.prototype.hasOwnProperty.call(cursor.delivered, id);
  }
}
