import { describe, expect, it } from "vitest";
import {
  createServer,
  type AddressInfo,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  ForgeDouble,
  ForgeEventSchema,
  ForgeEventSource,
  makeReply,
  makeReviewRequested,
  type SeededPr,
} from "../src/adapters/forge-double.js";
import { httpForgeAdapter } from "../src/adapters/forge.js";
import { SessionDouble } from "../src/adapters/session-double.js";
import type { PrShape } from "../src/contracts/forge.js";

const seededPr = (over: Partial<PrShape> = {}): SeededPr => ({
  repo: "org/repo",
  pr: 1,
  headSha: "sha-a",
  baseSha: "sha-base",
  headRef: "feature",
  baseRef: "main",
  cloneUrl: "https://example.com/org/repo.git",
  title: "a title",
  body: "a body",
  isFork: false,
  diff: "diff --git a/f b/f",
  ...over,
});

const double = (seed = [seededPr()]): ForgeDouble =>
  new ForgeDouble({
    prs: Object.fromEntries(seed.map((p) => [`${p.repo}#${p.pr}`, p])),
  });

describe("ForgeDouble outbound side", () => {
  it("returns the seeded PR shape and diff", async () => {
    const forge = double();
    await expect(forge.getPullRequest("org/repo", 1)).resolves.toMatchObject({
      repo: "org/repo",
      pr: 1,
      headSha: "sha-a",
      isFork: false,
    });
    await expect(forge.getDiff("org/repo", 1)).resolves.toBe(
      "diff --git a/f b/f",
    );
  });

  it("throws on an unseeded PR", async () => {
    const forge = double();
    await expect(forge.getPullRequest("org/other", 1)).rejects.toThrow(
      /org\/other#1/,
    );
  });

  it("posts a review against the seeded head and returns deterministic refs", async () => {
    const forge = double();
    const posted = await forge.postReview({
      repo: "org/repo",
      pr: 1,
      expectedHeadSha: "sha-a",
      verdict: "APPROVE",
      body: "looks good",
      comments: [
        { path: "a.ts", line: 3, body: "first" },
        { path: "b.ts", line: 9, body: "second" },
      ],
    });
    expect(posted).toEqual({
      reviewCommentId: "r1",
      commentRefs: [
        { index: 0, commentId: "c1" },
        { index: 1, commentId: "c2" },
      ],
    });
    expect(forge.postedReviews).toHaveLength(1);
    expect(forge.postedReviews[0]?.payload.body).toBe("looks good");
  });

  it("numbers posted review and comment ids sequentially per double", async () => {
    const forge = double();
    const first = await forge.postReview({
      repo: "org/repo",
      pr: 1,
      expectedHeadSha: "sha-a",
      verdict: "APPROVE",
      body: "first",
      comments: [{ path: "a.ts", line: 3, body: "one" }],
    });
    const second = await forge.postReview({
      repo: "org/repo",
      pr: 1,
      expectedHeadSha: "sha-a",
      verdict: "APPROVE",
      body: "second",
      comments: [
        { path: "a.ts", line: 3, body: "two" },
        { path: "b.ts", line: 9, body: "three" },
      ],
    });
    expect(first).toEqual({
      reviewCommentId: "r1",
      commentRefs: [{ index: 0, commentId: "c1" }],
    });
    expect(second).toEqual({
      reviewCommentId: "r2",
      commentRefs: [
        { index: 0, commentId: "c2" },
        { index: 1, commentId: "c3" },
      ],
    });
    expect(forge.postedReviews).toHaveLength(2);
  });

  it("throws when the review's expected head no longer matches", async () => {
    const forge = double();
    forge.setHead("org/repo", 1, "sha-new");
    await expect(
      forge.postReview({
        repo: "org/repo",
        pr: 1,
        expectedHeadSha: "sha-a",
        verdict: "REQUEST_CHANGES",
        body: "stale",
        comments: [],
      }),
    ).rejects.toThrow(/head moved/);
    expect(forge.postedReviews).toHaveLength(0);
  });

  it("patches fields via setHeadRef", async () => {
    const forge = double();
    forge.setHeadRef("org/repo", 1, {
      headSha: "sha-c",
      title: "rebased",
      isFork: true,
    });
    await expect(forge.getPullRequest("org/repo", 1)).resolves.toMatchObject({
      headSha: "sha-c",
      headRef: "feature",
      title: "rebased",
      isFork: true,
    });
  });

  it("answers getPostedReview with the landed review or null", async () => {
    const forge = double();
    await expect(
      forge.getPostedReview("org/repo", 1, "sha-a"),
    ).resolves.toBeNull();
    await forge.postReview({
      repo: "org/repo",
      pr: 1,
      expectedHeadSha: "sha-a",
      verdict: "APPROVE",
      body: "looks good",
      comments: [{ path: "a.ts", line: 3, body: "one" }],
    });
    await expect(
      forge.getPostedReview("org/repo", 1, "sha-a"),
    ).resolves.toEqual({
      reviewCommentId: "r1",
      commentRefs: [{ index: 0, commentId: "c1" }],
      verdict: "APPROVE",
      body: "looks good",
      comments: [{ path: "a.ts", line: 3, body: "one" }],
    });
    await expect(
      forge.getPostedReview("org/repo", 1, "sha-b"),
    ).resolves.toBeNull();
  });

  it("ignores the abort signal on reads: it is client-side only", async () => {
    const forge = double();
    const controller = new AbortController();
    controller.abort();
    await expect(
      forge.getPullRequest("org/repo", 1, { signal: controller.signal }),
    ).resolves.toMatchObject({ repo: "org/repo" });
    await expect(
      forge.getPostedReview("org/repo", 1, "sha-a", {
        signal: controller.signal,
      }),
    ).resolves.toBeNull();
  });

  it("records replies and failure comments", async () => {
    const forge = double();
    await forge.postReply({
      repo: "org/repo",
      pr: 1,
      inReplyTo: "r1",
      body: "a reply",
    });
    await forge.postFailureComment({
      repo: "org/repo",
      pr: 1,
      body: "it failed",
    });
    expect(forge.postedReplies).toEqual([
      { repo: "org/repo", pr: 1, inReplyTo: "r1", body: "a reply" },
    ]);
    expect(forge.postedFailures).toEqual([
      { repo: "org/repo", pr: 1, body: "it failed" },
    ]);
  });
});

describe("ForgeEventSource inbound side", () => {
  it("produces valid review_requested events from defaults", () => {
    const event = makeReviewRequested();
    expect(ForgeEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      kind: "review_requested",
      repo: "org/repo",
      pr: 1,
      requesterLogin: "example-user",
    });
  });

  it("produces valid reply events and honors overrides", () => {
    const event = makeReply({ repo: "org/other", pr: 7, text: "nit: rename" });
    expect(ForgeEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      kind: "reply",
      repo: "org/other",
      pr: 7,
      authorLogin: "example-user",
      text: "nit: rename",
    });
  });

  it("rejects an event with an unknown kind", () => {
    const result = ForgeEventSchema.safeParse({
      kind: "star",
      eventId: "evt-x",
    });
    expect(result.success).toBe(false);
  });

  it("records delivered events", () => {
    const source = new ForgeEventSource();
    const event = source.deliver(makeReviewRequested());
    expect(source.delivered).toEqual([event]);
  });
});

describe("ForgeAdapterClient reconciliation lookup", () => {
  /** One-shot local adapter serving GET /review by head. */
  const serve = (
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{
    forge: ReturnType<typeof httpForgeAdapter>;
    close: () => Promise<void>;
  }> =>
    new Promise((resolve) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          forge: httpForgeAdapter({
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
          }),
          close: () =>
            new Promise<void>((done, fail) =>
              server.close((error) => (error ? fail(error) : done())),
            ),
        });
      });
    });

  it("parses a found review and maps 404 to null", async () => {
    const adapter = await serve((request, response) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (
        url.pathname === "/review" &&
        url.searchParams.get("head") === "sha-a"
      ) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            reviewCommentId: "r1",
            commentRefs: [{ index: 0, commentId: "c1" }],
            verdict: "APPROVE",
            body: "looks good",
            comments: [{ path: "a.ts", line: 3, body: "one" }],
          }),
        );
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("no review for that head");
    });
    try {
      await expect(
        adapter.forge.getPostedReview("org/repo", 1, "sha-a"),
      ).resolves.toEqual({
        reviewCommentId: "r1",
        commentRefs: [{ index: 0, commentId: "c1" }],
        verdict: "APPROVE",
        body: "looks good",
        comments: [{ path: "a.ts", line: 3, body: "one" }],
      });
      await expect(
        adapter.forge.getPostedReview("org/repo", 1, "sha-b"),
      ).resolves.toBeNull();
    } finally {
      await adapter.close();
    }
  });

  it("surfaces a non-404 status as a failed lookup", async () => {
    const adapter = await serve((_request, response) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("boom");
    });
    try {
      await expect(
        adapter.forge.getPostedReview("org/repo", 1, "sha-a"),
      ).rejects.toThrow(/500/);
    } finally {
      await adapter.close();
    }
  });

  it("redacts the response body before truncating the composed error", async () => {
    // The credentialed URL straddles char 500 of the body: truncating
    // first would cut the token mid-userinfo, where no pattern matches,
    // and leak the cut. Redact-then-truncate must not.
    const body = `${"y".repeat(484)} https://user:supersecrettoken@host/repo refused`;
    expect(body.slice(0, 500)).toContain("https://user:su");
    const adapter = await serve((_request, response) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(body);
    });
    try {
      const error = await adapter.forge
        .getPostedReview("org/repo", 1, "sha-a")
        .then(
          () => {
            throw new Error("expected the lookup to reject");
          },
          (e: unknown) => e as Error,
        );
      expect(error.message).not.toContain("supersecrettoken");
      expect(error.message).toMatch(/500/);
    } finally {
      await adapter.close();
    }
  });
});

describe("SessionDouble", () => {
  it("serves a fixed script one output per prompt, per session", async () => {
    const session = new SessionDouble([
      "blind draft",
      "context draft",
      "final",
    ]);
    const id = await session.createSession("/work/tree", "reviewer");
    expect(session.createdSessions).toEqual([
      { sessionId: id, directory: "/work/tree", agent: "reviewer" },
    ]);

    await session.prompt(id, "first prompt");
    await session.prompt(id, "second prompt");
    expect(session.prompts).toEqual([
      { sessionId: id, index: 0, text: "first prompt" },
      { sessionId: id, index: 1, text: "second prompt" },
    ]);
    await expect(session.readOutput(id)).resolves.toBe("context draft");

    await session.prompt(id, "third prompt");
    await expect(session.readOutput(id)).resolves.toBe("final");

    await session.dispose(id);
    expect(session.disposed).toEqual([id]);
  });

  it("serves a second session from script position 0 and never crosses outputs", async () => {
    const session = new SessionDouble(["a", "b"]);
    const first = await session.createSession("/one", "agent");
    const second = await session.createSession("/two", "agent");
    await session.prompt(first, "p");
    await session.prompt(second, "p");
    await expect(session.readOutput(first)).resolves.toBe("a");
    await expect(session.readOutput(second)).resolves.toBe("a");
  });

  it("scripts outputs from a function", async () => {
    const session = new SessionDouble(
      (_sessionId, index, promptText) => `${index}:${promptText}`,
    );
    const id = await session.createSession("/w", "agent");
    await session.prompt(id, "hello");
    await session.prompt(id, "again");
    await expect(session.readOutput(id)).resolves.toBe("1:again");
  });

  it("serves an empty output past the end of a fixed script", async () => {
    const session = new SessionDouble(["only"]);
    const id = await session.createSession("/w", "agent");
    await session.prompt(id, "1");
    await session.prompt(id, "2");
    await expect(session.readOutput(id)).resolves.toBe("");
  });
});
