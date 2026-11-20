import { redactSecrets } from "./redact.js";

export interface ForgejoPrShape {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  cloneUrl: string;
  title: string;
  body: string;
  isFork: boolean;
}

export interface ForgejoPostedReview {
  reviewCommentId: string;
  commentRefs: Array<{ index: number; commentId: string }>;
}

export interface ForgejoPostedReviewLookup extends ForgejoPostedReview {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface ForgejoReviewInput {
  repo: string;
  pr: number;
  expectedHeadSha: string;
  verdict: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface ForgejoClient {
  getPullRequest(repo: string, pr: number): Promise<ForgejoPrShape>;
  getDiff(repo: string, pr: number): Promise<string>;
  getPostedReview(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<ForgejoPostedReviewLookup | null>;
  postReview(input: ForgejoReviewInput): Promise<ForgejoPostedReview>;
  postReply(input: {
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }): Promise<{ commentId: string }>;
  postFailureComment(input: {
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }): Promise<void>;
}

export class ForgejoHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ForgejoHttpError";
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repo "${repo}", expected owner/name`);
  }
  return { owner: parts[0], name: parts[1] };
}

function composeCloneUrl(raw: string, token: string): string {
  try {
    const url = new URL(raw);
    // Inject token for https clone; leave non-http(s) untouched.
    if (url.protocol === "https:" || url.protocol === "http:") {
      url.username = "x-access-token";
      url.password = token;
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

export class ForgejoApiClient implements ForgejoClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  /** In-memory idempotency backstop per (repo, pr, expectedHeadSha). */
  private readonly posted = new Map<
    string,
    { posted: ForgejoPostedReview; lookup: ForgejoPostedReviewLookup }
  >();
  private reviewCounter = 0;
  private commentCounter = 0;
  private replyCounter = 0;

  constructor(opts: { baseUrl: string; token: string; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async apiRequest(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        Authorization: `token ${this.token}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ForgejoHttpError(
        response.status,
        `forgejo request failed: ${init.method ?? "GET"} ${path} -> ${response.status}: ${redactSecrets(body).slice(0, 500)}`,
      );
    }
    return response;
  }

  async getPullRequest(repo: string, pr: number): Promise<ForgejoPrShape> {
    const { owner, name } = splitRepo(repo);
    const response = await this.apiRequest(
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}`,
      { method: "GET" },
    );
    const raw = (await response.json()) as Record<string, any>;
    const head = raw.head ?? {};
    const base = raw.base ?? {};
    const headRepo = head.repo ?? {};
    const cloneRaw: string =
      headRepo.clone_url ?? headRepo.ssh_url ?? raw.url ?? "";
    return {
      repo,
      pr: Number(raw.number ?? pr),
      headSha: String(head.sha ?? ""),
      baseSha: String(base.sha ?? ""),
      headRef: String(head.ref ?? ""),
      baseRef: String(base.ref ?? ""),
      cloneUrl: composeCloneUrl(String(cloneRaw), this.token),
      title: String(raw.title ?? ""),
      body: String(raw.body ?? ""),
      isFork: Boolean(headRepo.fork ?? raw.from_fork ?? false),
    };
  }

  async getDiff(repo: string, pr: number): Promise<string> {
    const { owner, name } = splitRepo(repo);
    const response = await fetch(
      `${this.baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}.diff`,
      {
        method: "GET",
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "text/plain",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new ForgejoHttpError(
        response.status,
        `forgejo request failed: GET /pulls/${pr}.diff -> ${response.status}: ${redactSecrets(body).slice(0, 500)}`,
      );
    }
    return response.text();
  }

  private async getAuthenticatedLogin(): Promise<string | undefined> {
    try {
      const response = await this.apiRequest("/api/v1/user", { method: "GET" });
      const raw = (await response.json().catch(() => ({}))) as Record<
        string,
        any
      >;
      const login = raw.login ?? raw.username ?? raw.name;
      return typeof login === "string" && login !== "" ? login : undefined;
    } catch {
      return undefined;
    }
  }

  async getPostedReview(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<ForgejoPostedReviewLookup | null> {
    const key = `${repo}#${pr}@${headSha}`;
    const found = this.posted.get(key);
    if (found) return found.lookup;

    // Forge-backed reconciliation path (spec: lookup what the forge has for
    // this head). Used when an in-flight post completed after the client
    // stopped waiting or across restarts/instances.
    try {
      const { owner, name } = splitRepo(repo);
      const login = await this.getAuthenticatedLogin();
      const reviewsRes = await this.apiRequest(
        `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}/reviews`,
        { method: "GET" },
      );
      const reviews = (await reviewsRes.json().catch(() => [])) as Array<
        Record<string, any>
      >;
      const match = reviews.find((r) => {
        const commit = String(r.commit_id ?? r.commitId ?? "");
        if (commit !== headSha) return false;
        const state = String(r.state ?? r.event ?? "").toUpperCase();
        if (state !== "APPROVED" && state !== "REQUEST_CHANGES") return false;
        if (!login) return true;
        const user = r.user ?? {};
        const reviewer = String(user.login ?? user.username ?? "");
        return reviewer === login;
      });
      if (!match) return null;

      const reviewId = String(match.id ?? match.ID ?? "");
      const verdict: "APPROVE" | "REQUEST_CHANGES" =
        String(match.state ?? match.event ?? "").toUpperCase() === "APPROVED"
          ? "APPROVE"
          : "REQUEST_CHANGES";
      const body = String(match.body ?? "");

      let comments: Array<{ path: string; line: number; body: string }> = [];
      if (reviewId) {
        try {
          const commentsRes = await this.apiRequest(
            `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}/reviews/${encodeURIComponent(reviewId)}/comments`,
            { method: "GET" },
          );
          const rawComments = (await commentsRes
            .json()
            .catch(() => [])) as Array<Record<string, any>>;
          comments = rawComments.map((c) => ({
            path: String(c.path ?? c.Path ?? ""),
            line: Number(c.line ?? c.new_position ?? c.position ?? 0),
            body: String(c.body ?? ""),
          }));
        } catch {
          comments = [];
        }
      }

      const commentRefs = comments.map((_c, index) => {
        this.commentCounter += 1;
        return { index, commentId: `comment-${this.commentCounter}` };
      });
      const posted = {
        reviewCommentId: reviewId || `review-forge-${headSha}`,
        commentRefs,
      };
      const lookup: ForgejoPostedReviewLookup = {
        ...posted,
        verdict,
        body,
        comments,
      };
      // Cache as idempotency/reconciliation backstop for this process.
      this.posted.set(key, { posted, lookup });
      return lookup;
    } catch {
      return null;
    }
  }

  async postReview(input: ForgejoReviewInput): Promise<ForgejoPostedReview> {
    const key = `${input.repo}#${input.pr}@${input.expectedHeadSha}`;
    const existing = this.posted.get(key);
    if (existing) {
      return existing.posted;
    }
    // Re-check head via PR shape for expected-head rule enforcement at adapter.
    const current = await this.getPullRequest(input.repo, input.pr);
    if (current.headSha !== input.expectedHeadSha) {
      throw new ForgejoHttpError(
        409,
        `expected head ${input.expectedHeadSha} but PR head is ${current.headSha}`,
      );
    }
    const { owner, name } = splitRepo(input.repo);
    const forgeEvent =
      input.verdict === "APPROVE" ? "APPROVED" : "REQUEST_CHANGES";
    // Best-effort Forgejo/Gitea review creation; contract response ids are what matter to zenigata.
    let reviewId = "";
    let inlineCommentsLanded = input.comments.length === 0 ? false : true;
    try {
      const response = await this.apiRequest(
        `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${input.pr}/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: forgeEvent,
            body: input.body,
            commit_id: input.expectedHeadSha,
            comments: input.comments.map((c) => ({
              path: c.path,
              new_position: c.line,
              body: c.body,
            })),
          }),
        },
      );
      const raw = (await response.json().catch(() => ({}))) as Record<
        string,
        any
      >;
      reviewId = String(raw.id ?? raw.ID ?? "");
      inlineCommentsLanded = input.comments.length > 0;
    } catch (error) {
      // If Forgejo rejects inline comment shape, fall back to a summary-only review so verdict/body still land.
      if (error instanceof ForgejoHttpError && input.comments.length > 0) {
        const response = await this.apiRequest(
          `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${input.pr}/reviews`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: forgeEvent,
              body: input.body,
              commit_id: input.expectedHeadSha,
            }),
          },
        );
        const raw = (await response.json().catch(() => ({}))) as Record<
          string,
          any
        >;
        reviewId = String(raw.id ?? raw.ID ?? "");
        inlineCommentsLanded = false;
      } else {
        throw error;
      }
    }
    this.reviewCounter += 1;
    const reviewCommentId = reviewId || `review-${this.reviewCounter}`;
    const landedComments = inlineCommentsLanded ? input.comments : [];
    const commentRefs = landedComments.map((_c, index) => {
      this.commentCounter += 1;
      return { index, commentId: `comment-${this.commentCounter}` };
    });
    const posted = { reviewCommentId, commentRefs };
    const lookup: ForgejoPostedReviewLookup = {
      ...posted,
      verdict: input.verdict,
      body: input.body,
      comments: landedComments,
    };
    this.posted.set(key, { posted, lookup });
    return posted;
  }

  async postReply(input: {
    repo: string;
    pr: number;
    inReplyTo: string;
    body: string;
  }): Promise<{ commentId: string }> {
    const { owner, name } = splitRepo(input.repo);
    // Forgejo's issue-comments API does not attach a comment to an arbitrary
    // target comment id. Preserve the contract's thread intent explicitly in
    // content so inReplyTo is never silently discarded.
    const body = `In reply to comment ${input.inReplyTo}:\n\n${input.body}`;
    const response = await this.apiRequest(
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${input.pr}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    const raw = (await response.json().catch(() => ({}))) as Record<
      string,
      any
    >;
    const id = String(raw.id ?? raw.ID ?? "");
    if (id) return { commentId: id };
    this.replyCounter += 1;
    return { commentId: `reply-${this.replyCounter}` };
  }

  async postFailureComment(input: {
    repo: string;
    pr: number;
    inReplyTo?: string;
    body: string;
  }): Promise<void> {
    const { owner, name } = splitRepo(input.repo);
    // If a thread target is provided, preserve it explicitly in content when
    // the forge API cannot place the comment in that thread directly.
    const body =
      input.inReplyTo !== undefined
        ? `Failure in reply to comment ${input.inReplyTo}:\n\n${input.body}`
        : input.body;
    await this.apiRequest(
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${input.pr}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  }
}

export function forgejoClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): ForgejoClient {
  return new ForgejoApiClient(opts);
}
