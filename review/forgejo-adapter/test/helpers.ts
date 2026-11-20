import {
  createServer,
  type AddressInfo,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  ForgejoClient,
  ForgejoPostedReview,
  ForgejoPostedReviewLookup,
  ForgejoPrShape,
  ForgejoReviewInput,
} from "../src/forgejo-client.js";

export const baseConfig = {
  listenPort: 0,
  forgeBaseUrl: "https://forge.example",
  forgeToken: "forge-token",
  outboundToken: "outbound-token",
  intakeUrl: "http://127.0.0.1:9",
  eventToken: "event-token",
  webhookSecret: "webhook-secret",
  requestTimeoutMs: 30_000,
};

export function makeFakeForgejo(
  overrides: Partial<ForgejoClient> = {},
): ForgejoClient & {
  calls: any[];
  postedReviews: ForgejoReviewInput[];
} {
  const calls: any[] = [];
  const postedReviews: ForgejoReviewInput[] = [];
  const posted = new Map<
    string,
    { posted: ForgejoPostedReview; lookup: ForgejoPostedReviewLookup }
  >();
  let rc = 0;
  let cc = 0;
  let pc = 0;
  const base: ForgejoClient & {
    calls: any[];
    postedReviews: ForgejoReviewInput[];
  } = {
    calls,
    postedReviews,
    async getPullRequest(repo, pr) {
      calls.push(["getPullRequest", repo, pr]);
      return {
        repo,
        pr,
        headSha: "head-a",
        baseSha: "base-a",
        headRef: "feature",
        baseRef: "main",
        cloneUrl: "https://forge.example/org/repo.git",
        title: "title",
        body: "body",
        isFork: false,
      } satisfies ForgejoPrShape;
    },
    async getDiff(repo, pr) {
      calls.push(["getDiff", repo, pr]);
      return "diff --git a/a b/a\n+hello\n";
    },
    async getPostedReview(repo, pr, headSha) {
      calls.push(["getPostedReview", repo, pr, headSha]);
      return posted.get(`${repo}#${pr}@${headSha}`)?.lookup ?? null;
    },
    async postReview(input) {
      calls.push(["postReview", input]);
      postedReviews.push(input);
      const key = `${input.repo}#${input.pr}@${input.expectedHeadSha}`;
      const existing = posted.get(key);
      if (existing) return existing.posted;
      rc += 1;
      const reviewCommentId = `r${rc}`;
      const commentRefs = input.comments.map((_c, i) => {
        cc += 1;
        return { index: i, commentId: `c${cc}` };
      });
      const out = { reviewCommentId, commentRefs };
      posted.set(key, {
        posted: out,
        lookup: {
          ...out,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        },
      });
      return out;
    },
    async postReply(input) {
      calls.push(["postReply", input]);
      pc += 1;
      return { commentId: `p${pc}` };
    },
    async postFailureComment(input) {
      calls.push(["postFailureComment", input]);
    },
  };
  return Object.assign(base, overrides);
}

export const serve = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
