import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { baseConfig, makeFakeForgejo } from "./helpers.js";
import { ForgejoHttpError } from "../src/forgejo-client.js";

const auth = { Authorization: "Bearer outbound-token" };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (close) await close();
  close = undefined;
});

async function boot(forgejo = makeFakeForgejo(), extra: any = {}) {
  const handle = await startServer({ ...baseConfig, ...extra } as any, {
    forgejo,
  });
  close = handle.close;
  return { handle, forgejo, base: `http://127.0.0.1:${handle.port}` };
}

describe("outbound endpoints", () => {
  it("requires bearer auth", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/pr?repo=org/repo&pr=1`);
    expect(res.status).toBe(401);
  });

  it("returns PR shape", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/pr?repo=org/repo&pr=7`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      repo: "org/repo",
      pr: 7,
      headSha: "head-a",
      baseSha: "base-a",
      headRef: "feature",
      baseRef: "main",
      cloneUrl: "https://forge.example/org/repo.git",
      title: "title",
      body: "body",
      isFork: false,
    });
  });

  it("returns diff as text/plain", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/pr/diff?repo=org/repo&pr=7`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("diff --git");
  });

  it("returns 404 when no posted review exists for head", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/review?repo=org/repo&pr=7&head=none`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("returns posted review lookup when present", async () => {
    const forgejo = makeFakeForgejo();
    await forgejo.postReview({
      repo: "org/repo",
      pr: 7,
      expectedHeadSha: "head-a",
      verdict: "APPROVE",
      body: "ok",
      comments: [{ path: "a.ts", line: 1, body: "hi" }],
    });
    const { base } = await boot(forgejo);
    const res = await fetch(`${base}/review?repo=org/repo&pr=7&head=head-a`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe("APPROVE");
    expect(body.body).toBe("ok");
    expect(body.comments).toEqual([{ path: "a.ts", line: 1, body: "hi" }]);
    expect(body.reviewCommentId).toBeTruthy();
    expect(body.commentRefs).toHaveLength(1);
  });

  it("posts review and returns ids", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/review`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        pr: 7,
        expectedHeadSha: "head-a",
        verdict: "REQUEST_CHANGES",
        body: "changes",
        comments: [{ path: "a.ts", line: 2, body: "fix" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewCommentId).toBeTruthy();
    expect(body.commentRefs).toEqual([
      { index: 0, commentId: expect.any(String) },
    ]);
  });

  // PRJ-445: the humanize shrink reconcile's identity comment claims the
  // forge takes two kept comments on one anchor, resting on the
  // adapter's payload schema putting no uniqueness on {path, line}. This
  // test pins that claim at the adapter surface: the double passes the
  // schema, reaches the forge client as two independent entries, and
  // lands with one ref per entry.
  it("posts two comments on one anchor as two independent entries (PRJ-445)", async () => {
    const forgejo = makeFakeForgejo();
    const { base } = await boot(forgejo);
    const res = await fetch(`${base}/review`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        pr: 7,
        expectedHeadSha: "head-a",
        verdict: "REQUEST_CHANGES",
        body: "changes",
        comments: [
          { path: "a.ts", line: 2, body: "first" },
          { path: "a.ts", line: 2, body: "second" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(forgejo.postedReviews[0].comments).toEqual([
      { path: "a.ts", line: 2, body: "first" },
      { path: "a.ts", line: 2, body: "second" },
    ]);
    expect(body.commentRefs).toHaveLength(2);
    expect(body.commentRefs[0].commentId).not.toBe(
      body.commentRefs[1].commentId,
    );
  });

  it("refuses review on expected-head mismatch naming both heads", async () => {
    const forgejo = makeFakeForgejo({
      async postReview() {
        throw new ForgejoHttpError(409, "expected head old but PR head is new");
      },
    } as any);
    const { base } = await boot(forgejo);
    const res = await fetch(`${base}/review`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        pr: 7,
        expectedHeadSha: "old",
        verdict: "APPROVE",
        body: "ok",
        comments: [],
      }),
    });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("old");
    expect(text).toContain("new");
  });

  it("posts reply and returns commentId", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/reply`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        pr: 7,
        inReplyTo: "c1",
        body: "reply",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commentId: expect.any(String) });
  });

  it("posts failure comment (2xx, optional inReplyTo)", async () => {
    const { base, forgejo } = await boot();
    const res = await fetch(`${base}/failure`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", pr: 7, body: "failed" }),
    });
    expect(res.status).toBe(200);
    expect(forgejo.calls.some((c) => c[0] === "postFailureComment")).toBe(true);
  });
});
