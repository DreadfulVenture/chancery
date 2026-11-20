/**
 * The forge-agnostic contract the bot consumes. No type, field, or method
 * names a forge: the deployment's adapter implements it, and the in-repo
 * test double implements the same shapes. The interface spec for adapter
 * authors lives in review/zenigata/docs/forge-adapter.md.
 */

import { z } from "zod";

export type Verdict = "APPROVE" | "REQUEST_CHANGES";

export interface PrShape {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  /** The PR's base branch. Refs, not SHAs, are what git fetch can rely on. */
  baseRef: string;
  /** A URL the bot may git-clone; the adapter composes any credentials. */
  cloneUrl: string;
  title: string;
  body: string;
  isFork: boolean;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewPayload {
  repo: string;
  pr: number;
  /** The head the review was produced against; the adapter refuses the post on mismatch. */
  expectedHeadSha: string;
  verdict: Verdict;
  body: string;
  comments: InlineComment[];
}

/** Comment references are opaque strings in the forge's own id space. */
export interface PostedReview {
  reviewCommentId: string;
  /** Maps the index of each inline comment in ReviewPayload.comments to its posted id. */
  commentRefs: Array<{ index: number; commentId: string }>;
}

/**
 * What the reconciliation lookup returns for a review the bot posted
 * against one head: the posted ids plus the verdict, body, and comments
 * exactly as they landed on the forge. The reply index needs the body and
 * comments, and the journal records the verdict.
 */
export interface PostedReviewLookup extends PostedReview {
  verdict: Verdict;
  body: string;
  comments: InlineComment[];
}

export interface ForgeAdapter {
  /**
   * The pull request's shape. `opts.signal` is a client-side-only abort
   * (the run's deadline); the wire contract is unchanged.
   */
  getPullRequest(
    repo: string,
    pr: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PrShape>;
  /**
   * The bot's own review for one (repo, pr, headSha), or null when no
   * review by the bot exists for that head. The failure path runs it to
   * reconcile an in-flight post the client abandoned: an adapter that
   * already received the request may still complete it, and this call is
   * how the run finds out what actually landed. `opts.signal` bounds the
   * call the same way as the other reads.
   */
  getPostedReview(
    repo: string,
    pr: number,
    headSha: string,
    opts?: { signal?: AbortSignal },
  ): Promise<PostedReviewLookup | null>;
  /** The unified diff of the PR against its base. */
  getDiff(repo: string, pr: number): Promise<string>;
  /**
   * Post the review. `opts.signal` is a client-side-only abort: the bot
   * may abandon the in-flight request when its own run deadline fires.
   * The HTTP wire contract is unchanged.
   */
  postReview(
    review: ReviewPayload,
    opts?: { signal?: AbortSignal },
  ): Promise<PostedReview>;
  postReply(input: {
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }): Promise<{ commentId: string }>;
  /** A failure comment carries no verdict and never carries labels. */
  postFailureComment(input: {
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }): Promise<void>;
}

/**
 * Events the adapter delivers to the bot's intake (POST /v1/events,
 * authenticated with the inbound token). Comment ids are opaque strings.
 */
export type ForgeEvent =
  | {
      kind: "review_requested";
      eventId: string;
      repo: string;
      pr: number;
      requesterLogin: string;
      commentId: string;
      text: string;
    }
  | {
      kind: "reply";
      eventId: string;
      repo: string;
      pr: number;
      authorLogin: string;
      inReplyTo: string;
      commentId: string;
      text: string;
    };

/**
 * A repo is `owner/name` from a safe character set: these strings reach
 * metrics labels, slugs, and filesystem paths downstream, so anything
 * outside this shape is refused at intake.
 */
export const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The canonical intake schema; the double re-exports it for its fixtures. */
export const ForgeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("review_requested"),
    eventId: z.string(),
    repo: z.string().regex(REPO_PATTERN, "must be owner/name"),
    pr: z.number().int().positive(),
    requesterLogin: z.string(),
    commentId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("reply"),
    eventId: z.string(),
    repo: z.string().regex(REPO_PATTERN, "must be owner/name"),
    pr: z.number().int().positive(),
    authorLogin: z.string(),
    inReplyTo: z.string(),
    commentId: z.string(),
    text: z.string(),
  }),
]);
