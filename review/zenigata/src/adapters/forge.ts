/**
 * ForgeAdapter over HTTP+JSON against the deployment's adapter service.
 *
 * Endpoint contract an adapter author implements (JSON bodies unless noted,
 * bearer-token authentication):
 *
 *   GET  {base}/pr?repo=<repo>&pr=<n>       -> PrShape JSON
 *   GET  {base}/pr/diff?repo=<repo>&pr=<n>  -> text/plain unified diff
 *   GET  {base}/review?repo=&pr=&head=      -> PostedReviewLookup JSON
 *                                              (404 when no review by the
 *                                              bot exists for that head)
 *   POST {base}/review                      -> ReviewPayload JSON body,
 *                                              responds PostedReview JSON
 *   POST {base}/reply                       -> {repo, pr, inReplyTo, body},
 *                                              responds {commentId} JSON
 *   POST {base}/failure                     -> {repo, pr, inReplyTo?, body}
 *
 * A non-2xx response throws an Error carrying the status and the first 500
 * characters of the response body. Every request times out after
 * fetchTimeoutMs (default 30 s) via AbortSignal.timeout; the review post
 * additionally honors a caller-supplied AbortSignal (the run's deadline)
 * composed with it. The PR and posted
 * review responses are shape-checked with zod; the write endpoints trust the
 * adapter's 2xx, except the reply's response, which must carry the posted
 * reply's id ({commentId}) for the bot's reply index.
 */

import { z } from "zod";
import type {
  ForgeAdapter,
  PostedReview,
  PostedReviewLookup,
  PrShape,
  ReviewPayload,
} from "../contracts/forge.js";
import { redactSecrets } from "../redact.js";

export const PrShapeSchema = z.object({
  repo: z.string(),
  pr: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  cloneUrl: z.string(),
  title: z.string(),
  body: z.string(),
  isFork: z.boolean(),
});

export const PostedReviewSchema = z.object({
  reviewCommentId: z.string(),
  commentRefs: z.array(z.object({ index: z.number(), commentId: z.string() })),
});

/** The reconciliation lookup's response: posted ids plus what landed. */
export const PostedReviewLookupSchema = PostedReviewSchema.extend({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  body: z.string(),
  comments: z.array(
    z.object({ path: z.string(), line: z.number(), body: z.string() }),
  ),
});

export interface ForgeAdapterOptions {
  baseUrl: string;
  token: string;
  fetchTimeoutMs?: number;
}

/** A non-2xx adapter response; the status rides the error for callers that distinguish one. */
class ForgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ForgeHttpError";
  }
}

export class ForgeAdapterClient implements ForgeAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: ForgeAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.fetchTimeoutMs ?? 30_000;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.token}`,
      },
      // The caller's signal (a run deadline) composes with the per-request
      // timeout: whichever fires first aborts the fetch.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      // The body may echo adapter-composed values (a credentialed URL
      // among them); redact before truncating or the slice can cut a URL
      // mid-userinfo, where no pattern matches any more.
      throw new ForgeHttpError(
        response.status,
        `forge request failed: ${init.method} ${path} -> ${response.status}: ${redactSecrets(body).slice(0, 500)}`,
      );
    }
    return response;
  }

  private async getJson<T>(
    path: string,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(path, { method: "GET" }, signal);
    return parse(await response.json());
  }

  private async postJson(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  async getPullRequest(
    repo: string,
    pr: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PrShape> {
    const query = new URLSearchParams({ repo, pr: String(pr) });
    const value = await this.getJson(
      `/pr?${query}`,
      (raw) => PrShapeSchema.parse(raw),
      opts?.signal,
    );
    return value;
  }

  async getPostedReview(
    repo: string,
    pr: number,
    headSha: string,
    opts?: { signal?: AbortSignal },
  ): Promise<PostedReviewLookup | null> {
    const query = new URLSearchParams({
      repo,
      pr: String(pr),
      head: headSha,
    });
    let response: Response;
    try {
      response = await this.request(
        `/review?${query}`,
        { method: "GET" },
        opts?.signal,
      );
    } catch (error) {
      // 404 means "no review by the bot for this head"; the request
      // helper turns every non-2xx into a throw, so the status is matched
      // on the error before it leaves the client.
      if (error instanceof ForgeHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
    return PostedReviewLookupSchema.parse(await response.json());
  }

  async getDiff(repo: string, pr: number): Promise<string> {
    const query = new URLSearchParams({ repo, pr: String(pr) });
    const response = await this.request(`/pr/diff?${query}`, { method: "GET" });
    return response.text();
  }

  async postReview(
    review: ReviewPayload,
    opts?: { signal?: AbortSignal },
  ): Promise<PostedReview> {
    const response = await this.postJson("/review", review, opts?.signal);
    return PostedReviewSchema.parse(await response.json());
  }

  async postReply(input: {
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }): Promise<{ commentId: string }> {
    const response = await this.postJson("/reply", input);
    // The posted reply's id feeds the bot's reply index; an adapter whose
    // 2xx body lacks it is a contract break, not an empty success.
    return z.object({ commentId: z.string() }).parse(await response.json());
  }

  async postFailureComment(input: {
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }): Promise<void> {
    await this.postJson("/failure", input);
  }
}

/** Factory so the bot core consumes only the ForgeAdapter contract. */
export function httpForgeAdapter(opts: ForgeAdapterOptions): ForgeAdapter {
  return new ForgeAdapterClient(opts);
}
