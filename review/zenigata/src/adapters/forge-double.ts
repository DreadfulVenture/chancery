/**
 * In-memory ForgeAdapter double plus a scripted inbound event source.
 * Tests run against this double: no forge, no network.
 *
 * Two halves:
 *   - ForgeDouble        the outbound side (ForgeAdapter, seeded state)
 *   - ForgeEventSource   the inbound side (events delivered or POSTed to intake)
 */

import type {
  ForgeAdapter,
  ForgeEvent,
  PostedReview,
  PostedReviewLookup,
  PrShape,
  ReviewPayload,
} from "../contracts/forge.js";
import { whenAborted } from "../with-timeout.js";

// The canonical intake schema lives beside the ForgeEvent type; the double
// re-exports it so fixtures and tests keep one import path.
export { ForgeEventSchema } from "../contracts/forge.js";

export type SeededPr = PrShape & { diff: string };

const key = (repo: string, pr: number): string => `${repo}#${pr}`;

export class ForgeDouble implements ForgeAdapter {
  private readonly prs = new Map<string, SeededPr>();
  /** Posted review ids are sequential per double instance (r1, r2, ...). */
  private reviewCounter = 0;
  /** Posted comment ids are sequential per double instance (c1, c2, ...). */
  private commentCounter = 0;
  /** Posted reply ids are sequential per double instance (p1, p2, ...). */
  private replyCounter = 0;
  /** Posted reviews by (repo, pr, headSha), for getPostedReview. */
  private readonly postedByKey = new Map<
    string,
    { posted: PostedReview; payload: ReviewPayload }
  >();
  readonly postedReviews: Array<{
    repo: string;
    pr: number;
    payload: ReviewPayload;
  }> = [];
  readonly postedReplies: Array<{
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }> = [];
  readonly postedFailures: Array<{
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }> = [];

  constructor(seed: { prs: Record<string, SeededPr> }) {
    for (const [k, shape] of Object.entries(seed.prs)) {
      this.prs.set(k, { ...shape });
    }
  }

  private lookup(repo: string, pr: number): SeededPr {
    const seeded = this.prs.get(key(repo, pr));
    if (!seeded) {
      throw new Error(`forge double: no seeded PR ${key(repo, pr)}`);
    }
    return seeded;
  }

  private getGate?: Promise<void>;
  /** Test hook counter: getPullRequest calls currently parked on the gate. */
  parkedGets = 0;

  /**
   * Park every getPullRequest at a gate until the returned release is
   * called (test hook for deadline-during-intake scenarios). While
   * parked, calls count in parkedGets.
   */
  parkGetPullRequests(): () => void {
    let release!: () => void;
    this.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  private lookupGate?: Promise<void>;
  /** Test hook counter: getPostedReview calls currently parked on the gate. */
  parkedLookups = 0;

  /**
   * Park every getPostedReview at a gate until the returned release is
   * called (test hook for deadline-during-bookkeeping scenarios). While
   * parked, calls count in parkedLookups.
   */
  parkGetPostedReviews(): () => void {
    let release!: () => void;
    this.lookupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async getPullRequest(
    repo: string,
    pr: number,
    _opts?: { signal?: AbortSignal },
  ): Promise<PrShape> {
    if (this.getGate !== undefined) {
      this.parkedGets += 1;
      await this.getGate;
      this.parkedGets -= 1;
    }
    const { diff: _diff, ...shape } = this.lookup(repo, pr);
    return shape;
  }

  async getDiff(repo: string, pr: number): Promise<string> {
    return this.lookup(repo, pr).diff;
  }

  async postReview(
    review: ReviewPayload,
    opts?: { signal?: AbortSignal },
  ): Promise<PostedReview> {
    if (this.postGate !== undefined) {
      // Test hook: park the post until release() is called or the
      // caller's signal aborts, whichever comes first.
      this.parkedPosts += 1;
      await (opts?.signal
        ? Promise.race([this.postGate, whenAborted(opts.signal)])
        : this.postGate);
      this.parkedPosts -= 1;
    }
    // The signal is client-side only and the double has no wire to abort;
    // by default it refuses the post when the client already gave up on
    // it. With completeAbortedPosts set, it models the other behavior the
    // contract allows — the adapter received the request and completed it
    // even though the client abandoned the fetch.
    if (opts?.signal?.aborted && !this.completeAbortedPosts) {
      throw new Error("forge double: the post was aborted by the client");
    }
    const seeded = this.lookup(review.repo, review.pr);
    // Simulates the adapter refusing a review produced against a moved head.
    if (review.expectedHeadSha !== seeded.headSha) {
      throw new Error(
        `forge double: head moved, expected ${review.expectedHeadSha}, is ${seeded.headSha}`,
      );
    }
    this.postedReviews.push({
      repo: review.repo,
      pr: review.pr,
      payload: review,
    });
    this.reviewCounter += 1;
    // Sequential per double: a second review in one test must not reuse
    // the first review's ids, which would overwrite its index entries.
    const reviewCommentId = `r${this.reviewCounter}`;
    const commentRefs = review.comments.map((_comment, index) => {
      this.commentCounter += 1;
      return { index, commentId: `c${this.commentCounter}` };
    });
    const posted = { reviewCommentId, commentRefs };
    this.postedByKey.set(
      `${key(review.repo, review.pr)}@${review.expectedHeadSha}`,
      { posted, payload: review },
    );
    return posted;
  }

  async getPostedReview(
    repo: string,
    pr: number,
    headSha: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<PostedReviewLookup | null> {
    if (this.lookupGate !== undefined) {
      this.parkedLookups += 1;
      await this.lookupGate;
      this.parkedLookups -= 1;
    }
    const found = this.postedByKey.get(`${key(repo, pr)}@${headSha}`);
    if (found === undefined) {
      return null;
    }
    const { posted, payload } = found;
    return {
      ...posted,
      verdict: payload.verdict,
      body: payload.body,
      comments: payload.comments,
    };
  }

  async postReply(input: {
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }): Promise<{ commentId: string }> {
    this.lookup(input.repo, input.pr);
    this.postedReplies.push({ ...input });
    this.replyCounter += 1;
    return { commentId: `p${this.replyCounter}` };
  }

  async postFailureComment(input: {
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }): Promise<void> {
    this.lookup(input.repo, input.pr);
    this.postedFailures.push({ ...input });
  }

  /** Move the head so a review produced earlier refuses to post. */
  setHead(repo: string, pr: number, sha: string): void {
    this.lookup(repo, pr).headSha = sha;
  }

  private postGate?: Promise<void>;
  /** Test hook counter: postReview calls currently parked on the gate. */
  parkedPosts = 0;

  /**
   * When true, a post that was in flight when the client's signal aborted
   * still completes and records (the adapter-completed side of the abort
   * contract); the default refuses it instead. Set before releasing a
   * parked post or before the abort that ends the park.
   */
  completeAbortedPosts = false;

  /**
   * Park every postReview at a gate until the returned release is called
   * (test hook for deadline-during-post scenarios). While parked, calls
   * count in parkedPosts.
   */
  parkPostReviews(): () => void {
    let release!: () => void;
    this.postGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Patch any subset of the seeded PR's fields, head included. */
  setHeadRef(
    repo: string,
    pr: number,
    patch: Partial<
      Pick<
        PrShape,
        | "headSha"
        | "headRef"
        | "baseRef"
        | "baseSha"
        | "title"
        | "body"
        | "cloneUrl"
        | "isFork"
      >
    >,
  ): void {
    Object.assign(this.lookup(repo, pr), patch);
  }
}

// ---------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------

let eventCounter = 0;

export interface ReviewRequestedOverrides {
  eventId?: string;
  repo?: string;
  pr?: number;
  requesterLogin?: string;
  commentId?: string;
  text?: string;
}

export function makeReviewRequested(
  overrides: ReviewRequestedOverrides = {},
): Extract<ForgeEvent, { kind: "review_requested" }> {
  eventCounter += 1;
  return {
    kind: "review_requested",
    eventId: overrides.eventId ?? `evt-${eventCounter}`,
    repo: overrides.repo ?? "org/repo",
    pr: overrides.pr ?? 1,
    requesterLogin: overrides.requesterLogin ?? "example-user",
    commentId: overrides.commentId ?? `comment-${eventCounter}`,
    text: overrides.text ?? "please review",
  };
}

export interface ReplyOverrides {
  eventId?: string;
  repo?: string;
  pr?: number;
  authorLogin?: string;
  inReplyTo?: string;
  commentId?: string;
  text?: string;
}

export function makeReply(
  overrides: ReplyOverrides = {},
): Extract<ForgeEvent, { kind: "reply" }> {
  eventCounter += 1;
  return {
    kind: "reply",
    eventId: overrides.eventId ?? `evt-${eventCounter}`,
    repo: overrides.repo ?? "org/repo",
    pr: overrides.pr ?? 1,
    authorLogin: overrides.authorLogin ?? "example-user",
    inReplyTo: overrides.inReplyTo ?? "r1",
    commentId: overrides.commentId ?? `comment-${eventCounter}`,
    text: overrides.text ?? "a reply",
  };
}

export class ForgeEventSource {
  readonly delivered: ForgeEvent[] = [];

  /** Record an event as if the adapter had delivered it. */
  deliver(event: ForgeEvent): ForgeEvent {
    this.delivered.push(event);
    return event;
  }

  /**
   * POST the event to the bot's intake the way the adapter would
   * (POST /v1/events, bearer token). Returns the raw response so a test
   * asserts the status and the accepted/rejected body.
   */
  async postToIntake(
    baseUrl: string,
    token: string,
    event: ForgeEvent,
  ): Promise<Response> {
    return fetch(`${baseUrl.replace(/\/+$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
  }
}
