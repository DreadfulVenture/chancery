import { describe, expect, it } from "vitest";
import {
  createServer,
  type AddressInfo,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { httpForgeAdapter } from "../src/adapters/forge.js";
import type { ForgeAdapter } from "../src/contracts/forge.js";

const TOKEN = "bearer-secret";

const prShape = {
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
};

const reviewPayload = {
  repo: "org/repo",
  pr: 1,
  expectedHeadSha: "sha-a",
  verdict: "APPROVE" as const,
  body: "looks good",
  comments: [],
};

/** One-shot local adapter server; the handler decides every response. */
const serve = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> =>
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

const client = (
  baseUrl: string,
  opts: { fetchTimeoutMs?: number } = {},
): ForgeAdapter => httpForgeAdapter({ baseUrl, token: TOKEN, ...opts });

/** Capture a rejection instead of failing the test on it. */
const caught = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (error: unknown) => error as Error,
  );

describe("ForgeAdapterClient HTTP surface", () => {
  it("sends the bearer token on every request", async () => {
    let authorization: string | undefined;
    const adapter = await serve((req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(prShape));
    });
    try {
      await client(adapter.baseUrl).getPullRequest("org/repo", 1);
      expect(authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await adapter.close();
    }
  });

  it("abandons a request that outlives the fetch timeout", async () => {
    const adapter = await serve(() => {
      // Hold the request open: never respond.
    });
    try {
      const error = await caught(
        client(adapter.baseUrl, { fetchTimeoutMs: 100 }).getDiff("org/repo", 1),
      );
      expect(`${error.name} ${error.message}`).toMatch(
        /TimeoutError|AbortError|aborted|timed?\s?out/i,
      );
    } finally {
      await adapter.close();
    }
  });

  it("rejects when the caller's signal aborts mid-request", async () => {
    const adapter = await serve(() => {
      // Hold the request open until the client aborts.
    });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const error = await caught(
        client(adapter.baseUrl).postReview(reviewPayload, {
          signal: controller.signal,
        }),
      );
      expect(`${error.name} ${error.message}`).toMatch(
        /AbortError|TimeoutError|abort/i,
      );
    } finally {
      await adapter.close();
    }
  });

  it("carries the status and a redacted, truncated body on a non-2xx", async () => {
    // The credential sits early in the body so the 500-char slice would
    // carry it if redaction ran after truncation.
    const body = `refused https://user:supersecrettoken@host/repo ${"y".repeat(600)}`;
    const adapter = await serve((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(body);
    });
    try {
      const error = await caught(
        client(adapter.baseUrl).getPullRequest("org/repo", 1),
      );
      expect(error.message).toContain("502");
      expect(error.message).not.toContain("supersecrettoken");
      expect(error.message).toContain("https://host/repo");
      // Truncated: the 600-char tail of y's is cut before the URL-ish text.
      expect(error.message).not.toContain("y".repeat(480));
    } finally {
      await adapter.close();
    }
  });

  it("maps a 404 posted-review lookup to null", async () => {
    const adapter = await serve((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no review for that head");
    });
    try {
      await expect(
        client(adapter.baseUrl).getPostedReview("org/repo", 1, "sha-a"),
      ).resolves.toBeNull();
    } finally {
      await adapter.close();
    }
  });

  it("parses the posted reply's comment id", async () => {
    const adapter = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ commentId: "forge-reply-42" }));
    });
    try {
      await expect(
        client(adapter.baseUrl).postReply({
          repo: "org/repo",
          pr: 1,
          inReplyTo: "r1",
          body: "a reply",
        }),
      ).resolves.toEqual({ commentId: "forge-reply-42" });
    } finally {
      await adapter.close();
    }
  });
});
