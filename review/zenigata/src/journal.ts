/**
 * Append-only JSONL journal of reviews and replies, plus the in-memory
 * index of the bot's own posted comments that the reply flow reads.
 *
 * The record shape carries two fields beyond the minimum the pipeline
 * produces: `comments` and `posted`. The reply flow must quote the
 * original review body or inline comment body it answers, and a count
 * alone cannot serve that; the index needs the posted forge ids too.
 */

import { readFile, appendFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "./ctx.js";
import type {
  InlineComment,
  PostedReview,
  Verdict,
} from "./contracts/forge.js";
import type { ObservationSource } from "./contracts/memory.js";

export interface PhaseTiming {
  phase: string;
  durationMs: number;
}

export type ReviewOutcome = "posted" | "aborted" | "failed" | "skipped";

/**
 * PRJ-381: one failed validation attempt in a JSON stage (the review
 * pipeline's context and humanize passes, the reply flow's answer run).
 * The raw reply text and the real parse refusal are the diagnosis the
 * corrective retry prompt carries to the model; they persist here for
 * the same reason. Additive fields only: the status projection consumes
 * none of it, and the /status shapes stay byte-identical.
 */
export interface FailedDraft {
  /** The stage whose validation refused the attempt. */
  stage: "context" | "humanize" | "answer";
  /** Zero-based attempt number within the stage's own loop. */
  attempt: number;
  /** The raw model output for the attempt, capped with a truncation marker. */
  reply: string;
  /** The parse-boundary refusal when validation died before the payload checks. */
  parseError?: string;
}

/** A failed attempt's raw draft caps at 64KiB in the journal. */
export const FAILED_DRAFT_CAP = 65_536;
export const FAILED_DRAFT_TRUNCATION_MARKER =
  "\n[failed draft truncated at the 64KiB journal cap]";

/**
 * The record's dropped-comment bodies cap with the failed drafts'
 * mechanics but under their own marker: a dropped comment is not a
 * draft attempt, and the failed drafts' marker would misname it
 * (PRJ-439). The failed drafts' marker stays as it is — the status db
 * derives the stored drafts' truncation flag from it, so its text is
 * load-bearing for rows already on disk.
 */
export const DROPPED_COMMENT_TRUNCATION_MARKER =
  "\n[dropped comment truncated at the 64KiB journal cap]";

/**
 * PRJ-428: one comment a stage dropped from the review. The context
 * stage's drop rescue removes the comments that still cannot anchor
 * after the corrective retry; PRJ-440 extended the accounting to the
 * humanize stage, whose reply can omit comments the kept set carried.
 * The drop keeps the review postable without killing the run; the
 * record names what was dropped, why it never reached the forge, and
 * the body that died with it — two drops with different costs must not
 * look identical.
 */
export type DroppedSource = "context" | "humanize";

/**
 * `source` is required on rows written since PRJ-440; rows written
 * before it (PRJ-428's shape) carry no `source` field. Stored rows are
 * read tolerantly everywhere: the journal walk parses each line without
 * a schema, the boot index and the status db's projection validate only
 * the fields they consume (looseObject shapes, and the projection names
 * no droppedComments field at all), and nothing re-reads a stored row's
 * source back into the posted annotation — that reads the run's own
 * state. A source-less old row therefore loads wherever it is read.
 */
export interface DroppedComment {
  /** The stage that dropped the comment; the posted annotation groups on it. */
  source: DroppedSource;
  path: string;
  line: number;
  reason: string;
  /** The dropped comment's body, capped at record time with the failed drafts' mechanics, under the drop's own marker. */
  body: string;
}

/**
 * PRJ-428: the verdict move the drops would have forced, recorded as
 * what ALMOST happened. The rescue refuses to apply it — the posted
 * review's verdict is always the draft's own verdict, and the forge
 * never sees a verdict the draft did not issue — so this field only
 * ever rides a record whose review did not post under the move. One
 * shape only: a REQUEST_CHANGES draft whose every blocking comment
 * dropped is the sole reachable break, so `from` is always
 * REQUEST_CHANGES and `to` is always APPROVE.
 */
export interface VerdictReconciliation {
  from: "REQUEST_CHANGES";
  to: "APPROVE";
  because: string;
}

/**
 * Cap a raw reply for the journal; runaways get the marker. The failed
 * drafts' marker is the default; the record's dropped-comment bodies
 * pass their own (PRJ-439).
 */
export function capFailedDraft(
  reply: string,
  marker: string = FAILED_DRAFT_TRUNCATION_MARKER,
): string {
  if (reply.length <= FAILED_DRAFT_CAP) {
    return reply;
  }
  return reply.slice(0, FAILED_DRAFT_CAP) + marker;
}

export interface ReviewRecord {
  ts: string;
  type: "review";
  reviewId: string;
  repo: string;
  pr: number;
  /**
   * The event's identity the intake gate spends: the forge delivery id the
   * adapter carried (the adapter derives it from the webhook delivery, so a
   * re-request of the same PR is its own identity here). Absent only in
   * records written before the identity existed.
   */
  eventId?: string;
  /**
   * The requesting comment's forge id, as metadata: the webhook's stable
   * repeat (the reviewer's id on a forge request-review, the comment's id
   * on an @review mention). Narration and per-comment history ride on it;
   * the retry gate does not — it keys on the event identity above.
   */
  commentId?: string;
  /**
   * Set only after the intake guard fetched the PR shape: a fork skip, a
   * repository skip, or a failure inside getPullRequest all settle before
   * it is assigned, as does any later failure.
   */
  headSha?: string;
  requester: string;
  phases: PhaseTiming[];
  verdict?: Verdict;
  inlineComments: number;
  humanizer: { assessment?: string; changed: boolean };
  outcome: ReviewOutcome;
  failure?: { stage: string; message: string };
  /** The review body exactly as posted (posted outcome only). */
  body?: string;
  /** The comments exactly as posted (posted outcome only). */
  comments?: InlineComment[];
  /** The forge's ids for the posted review and its inline comments. */
  posted?: PostedReview;
  /** True when the posted outcome came from the reconciliation, not this run's post. */
  reconciled?: boolean;
  /**
   * The work the run left in place when the retention window kept it
   * (PRJ-382): the session id, the per-PR worktree path, and the settle
   * moment the sweep's clock compare reads. A record in the window-0
   * configuration tears its work down at settle time and carries none of
   * these; the sweep only ever sees records that carry at least one.
   */
  sessionId?: string;
  worktreeDir?: string;
  finishedAt?: string;
  /**
   * PRJ-381: the raw replies of failed validation attempts in the JSON
   * stages, one entry per failed attempt in run order. Absent when every
   * attempt of the run validated.
   */
  failedDrafts?: FailedDraft[];
  /**
   * PRJ-428: the comments that never reached the forge — the context
   * stage's unanchorable drops and, since PRJ-440, the comments the
   * humanize stage's reply omitted from the context stage's kept set.
   * On a posted run the review carried the kept comments; on a failed
   * run the record names what the rescue would have dropped. Absent
   * when nothing was dropped.
   */
  droppedComments?: DroppedComment[];
  /**
   * PRJ-428: the verdict move the drops would have forced, recorded as
   * what almost happened. Never applied: a posted review's verdict is
   * always the draft's own verdict.
   */
  verdictReconciled?: VerdictReconciliation;
}

export interface ReplyRecord {
  ts: string;
  type: "reply";
  repo: string;
  pr: number;
  author: string;
  inReplyTo: string;
  outcome: "posted" | "failed" | "skipped";
  learning?: ObservationSource;
  /** The posted answer's forge id (posted outcome only). */
  postedCommentId?: string;
  /** The answer text exactly as posted (posted outcome only). */
  body?: string;
  /**
   * Set on the intake's rejected-run record only: the reply chain's catch
   * journals a reply whose run rejected before its own settlement record
   * landed. A settled reply never sets it (its record carries the outcome
   * itself).
   */
  failure?: { stage: string; message: string };
  /**
   * The work the reply left in place when the retention window kept it
   * (PRJ-382): the session id and the settle moment the sweep's clock
   * compare reads. Replies build no worktree, so no path rides the
   * record. A window-0 reply tears its session down at settle time and
   * carries neither field.
   */
  sessionId?: string;
  finishedAt?: string;
  /**
   * PRJ-381: the raw outputs of failed validation attempts in the answer
   * run, one entry per failed attempt, same convention as the review
   * record's field.
   */
  failedDrafts?: FailedDraft[];
}

/**
 * The intake's accepted-start trail for one enqueued review: written the
 * moment the server answers 202 and enqueues the run, so an event that
 * dies between acceptance and its first phase still leaves a journal line.
 * Deliberately a distinct record type, not a run outcome: the PRJ-330
 * redelivery-refusal gate (and the boot-time index that feeds it) counts
 * only ran/settled records, so a bot restart that dropped a start leaves
 * the event free to re-run — nothing was spent.
 */
export interface ReviewStartRecord {
  ts: string;
  type: "review-start";
  eventId: string;
  repo: string;
  pr: number;
  /** The requesting comment's forge id, carried as metadata. */
  commentId: string;
  /** The accepted event's kind, carried verbatim for line readability. */
  eventKind: "review_requested";
}

export type JournalRecord = ReviewRecord | ReplyRecord | ReviewStartRecord;

export function isReviewRecord(record: JournalRecord): record is ReviewRecord {
  return record.type === "review";
}

export function isReplyRecord(record: JournalRecord): record is ReplyRecord {
  return record.type === "reply";
}

export function journalPath(stateDir: string): string {
  return `${stateDir}/reviews.jsonl`;
}

export async function appendJournal(
  path: string,
  record: JournalRecord,
): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// The journal walk
// ---------------------------------------------------------------------------

/**
 * One journaled line: its 1-based number within the walked text, `label`
 * as the prefix every skip log for this walk prints (the file position),
 * and the parsed JSON value. Shape validation happens on top of the walk,
 * one consumer at a time.
 */
export interface JournalLine {
  line: number;
  label: string;
  value: unknown;
}

/**
 * A missing journal reads as absent text; any other failure (an
 * unreadable file, a directory where the file should be) is a real
 * problem and must not pass silently.
 */
const readJournalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
};

/**
 * The walk's one split-and-parse discipline: blank lines pass, every line
 * whose JSON fails to parse is skipped with one log line carrying its
 * line number, and the walk continues. A systemd restart into a torn
 * journal (an unclean shutdown's torn trailing line is the common case)
 * must not crash into a loop waiting for a human to repair the file.
 */
const buildLines = (
  text: string,
  log: Logger | undefined,
  label: (line: number) => string,
): JournalLine[] => {
  const parts = text.split("\n");
  const lines: JournalLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.trim() === "") {
      continue;
    }
    try {
      lines.push({
        line: i + 1,
        label: label(i + 1),
        value: JSON.parse(line),
      });
    } catch {
      log?.info(`${label(i + 1)} skipped: unparseable JSON`);
    }
  }
  return lines;
};

/**
 * Walk the whole journal: one ordered pass that yields every parseable
 * line with its number, skipping unparseable ones with a log line. The
 * boot reads the file through this walk once and feeds it to every
 * consumer that wants the journal's history.
 */
export async function walkJournal(
  path: string,
  log?: Logger,
): Promise<JournalLine[]> {
  const text = await readJournalText(path);
  if (text === undefined) {
    return [];
  }
  return buildLines(text, log, (line) => `journal line ${line}`);
}

// ---------------------------------------------------------------------------
// Posted-comment index
// ---------------------------------------------------------------------------

export interface PostedReviewRef {
  kind: "review";
  repo: string;
  pr: number;
  reviewId: string;
  body: string;
}

export interface PostedCommentRef {
  kind: "inline";
  repo: string;
  pr: number;
  reviewId: string;
  body: string;
  path: string;
  line: number;
}

/** The bot's own posted reply in a thread; carries no review linkage. */
export interface PostedReplyRef {
  kind: "reply";
  repo: string;
  pr: number;
  body: string;
}

export type PostedRef = PostedReviewRef | PostedCommentRef | PostedReplyRef;

// ---------------------------------------------------------------------------
// Journal record shapes the index consumes
// ---------------------------------------------------------------------------

/**
 * The fields of a posted review record that addPosted reads. Only what
 * the index needs is validated; every object tolerates unknown extra
 * fields (z.looseObject), so a future record shape still loads.
 */
const ZInlineComment = z.looseObject({
  path: z.string(),
  line: z.number(),
  body: z.string(),
});

const ZPostedReview = z.looseObject({
  reviewCommentId: z.string(),
  commentRefs: z.array(
    z.looseObject({ index: z.number(), commentId: z.string() }),
  ),
});

const ZIndexedReviewRecord = z.looseObject({
  type: z.literal("review"),
  repo: z.string(),
  pr: z.number(),
  reviewId: z.string(),
  outcome: z.literal("posted"),
  /** Missing body indexes as empty; the reply flow quotes what it has. */
  body: z.string().optional(),
  comments: z.array(ZInlineComment),
  posted: ZPostedReview,
});

const ZIndexedReplyRecord = z.looseObject({
  type: z.literal("reply"),
  repo: z.string(),
  pr: z.number(),
  outcome: z.literal("posted"),
  postedCommentId: z.string(),
  /** Missing body indexes as empty; the reply flow quotes what it has. */
  body: z.string().optional(),
});

export class ReviewIndex {
  private readonly byCommentId = new Map<string, PostedRef>();

  /**
   * Runs recorded per review event, keyed by the event's identity (the
   * forge delivery id the adapter carried). A run is a journal line that
   * actually executed (any outcome but `skipped`); a redelivery refusal
   * writes a `skipped` line and never counts. Older records carry no
   * identity and count only under their legacy comment-anchor key, which
   * no fresh event can collide with.
   */
  private readonly reviewRuns = new Map<
    string,
    { runs: number; failed: number; posted: number; aborted: number }
  >();

  /** Index one posted review: the review comment id and every inline ref. */
  addPosted(input: {
    repo: string;
    pr: number;
    reviewId: string;
    body: string;
    comments: InlineComment[];
    posted: PostedReview;
  }): void {
    const reviewRef: PostedReviewRef = {
      kind: "review",
      repo: input.repo,
      pr: input.pr,
      reviewId: input.reviewId,
      body: input.body,
    };
    this.byCommentId.set(input.posted.reviewCommentId, reviewRef);
    for (const ref of input.posted.commentRefs) {
      const comment = input.comments[ref.index];
      if (!comment) {
        continue;
      }
      this.byCommentId.set(ref.commentId, {
        kind: "inline",
        repo: input.repo,
        pr: input.pr,
        reviewId: input.reviewId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
      });
    }
  }

  lookup(commentId: string): PostedRef | undefined {
    return this.byCommentId.get(commentId);
  }

  /**
   * Index the bot's own posted reply: a later reply answering the bot's
   * answer resolves against it instead of taking the no-record path.
   */
  addReply(input: {
    repo: string;
    pr: number;
    commentId: string;
    body: string;
  }): void {
    this.byCommentId.set(input.commentId, {
      kind: "reply",
      repo: input.repo,
      pr: input.pr,
      body: input.body,
    });
  }

  /** Count one journaled review run, keyed by the event's identity. */
  recordRun(input: {
    repo: string;
    pr: number;
    eventId: string;
    outcome: string;
  }): void {
    const entryKey = `${input.repo}#${input.pr}#${input.eventId}`;
    const counts = this.reviewRuns.get(entryKey) ?? {
      runs: 0,
      failed: 0,
      posted: 0,
      aborted: 0,
    };
    if (input.outcome !== "skipped") {
      counts.runs += 1;
    }
    if (input.outcome === "failed") {
      counts.failed += 1;
    }
    if (input.outcome === "posted") {
      counts.posted += 1;
    }
    if (input.outcome === "aborted") {
      counts.aborted += 1;
    }
    this.reviewRuns.set(entryKey, counts);
  }

  /**
   * What the journal says a review event already produced, by the event's
   * identity.
   */
  eventRuns(
    repo: string,
    pr: number,
    eventId: string,
  ): { runs: number; failed: number; posted: number; aborted: number } {
    return (
      this.reviewRuns.get(`${repo}#${pr}#${eventId}`) ?? {
        runs: 0,
        failed: 0,
        posted: 0,
        aborted: 0,
      }
    );
  }

  get size(): number {
    return this.byCommentId.size;
  }
}

/** Rebuild the index from the journal at boot. A missing file is an empty index. */
export async function loadIndex(
  path: string,
  log?: Logger,
): Promise<ReviewIndex> {
  return indexFromJournal(await walkJournal(path, log), log);
}

/**
 * Build the posted-comment index from an already-walked journal, so a
 * caller that walked the file once can feed the index without a second
 * read of the same lines.
 */
export function indexFromJournal(
  lines: JournalLine[],
  log?: Logger,
): ReviewIndex {
  const index = new ReviewIndex();
  for (const { label, value } of lines) {
    const probe = value as {
      type?: unknown;
      outcome?: unknown;
      postedCommentId?: unknown;
      commentId?: unknown;
      eventId?: unknown;
      repo?: unknown;
      pr?: unknown;
    };
    // The retry policy's run counts ride the same boot walk: every review
    // record lands in the index under its identity whatever its outcome,
    // so a restart keeps the same poster the live process had. The key is
    // the event's identity (the forge delivery id); records written before
    // identities were journaled count only under their legacy comment
    // anchor, which no fresh event can reach.
    // An accepted-start record (type `review-start`) never lands there:
    // it is the intake's accepted-event trail, not a ran/settled record,
    // so a bot restart that dropped a start re-runs the event free.
    if (probe.type === "review-start") {
      continue;
    }
    if (
      probe.type === "review" &&
      typeof probe.repo === "string" &&
      typeof probe.pr === "number" &&
      typeof probe.outcome === "string" &&
      (typeof probe.eventId === "string" || typeof probe.commentId === "string")
    ) {
      index.recordRun({
        repo: probe.repo,
        pr: probe.pr,
        eventId:
          typeof probe.eventId === "string"
            ? probe.eventId
            : `legacy-comment-${String(probe.commentId)}`,
        outcome: probe.outcome,
      });
    }
    if (probe.type === "reply") {
      // A posted reply carries the answer's forge id; index it so a reply
      // to the bot's own answer still resolves after a restart. Older
      // records and failed/skipped replies have no id and stay
      // unconsumed, as legitimate journal lines.
      if (
        probe.outcome === "posted" &&
        typeof probe.postedCommentId === "string"
      ) {
        const reply = ZIndexedReplyRecord.safeParse(value);
        if (!reply.success) {
          const issue = reply.error.issues[0];
          log?.info(
            `${label} skipped: posted reply record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`,
          );
          continue;
        }
        index.addReply({
          repo: reply.data.repo,
          pr: reply.data.pr,
          commentId: reply.data.postedCommentId,
          body: reply.data.body ?? "",
        });
      }
      continue;
    }
    if (probe.type !== "review" || probe.outcome !== "posted") {
      // Non-posted reviews are legitimate journal lines the index does
      // not consume; not a corruption signal.
      continue;
    }
    const record = ZIndexedReviewRecord.safeParse(value);
    if (!record.success) {
      const issue = record.error.issues[0];
      log?.info(
        `${label} skipped: posted review record failed validation at ${issue?.path.join(".") || "record"}: ${issue?.message ?? "unknown"}`,
      );
      continue;
    }
    index.addPosted({
      repo: record.data.repo,
      pr: record.data.pr,
      reviewId: record.data.reviewId,
      body: record.data.body ?? "",
      comments: record.data.comments,
      posted: record.data.posted,
    });
  }
  return index;
}
