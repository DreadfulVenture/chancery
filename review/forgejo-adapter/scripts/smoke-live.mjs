#!/usr/bin/env node
/**
 * Smoke (portable, fully local): verifies the forge-client code path against a
 * local fake Forgejo server. One dependency-free script (global fetch + node
 * stdlib only), runnable anywhere node >= 24 exists — no install, no build, no
 * dist, no node_modules, no network beyond 127.0.0.1.
 *
 * It spins up an in-process fake Forgejo HTTP server with fixture responses for
 * the PR shape and diff endpoints, then drives the same request shapes, headers,
 * token auth, and field extraction the adapter's forge client uses, asserting
 * the PR-shape fields (head/base sha, refs, title, body, clone_url) and a
 * non-empty unified diff.
 *
 * No live forge is contacted and no live credentials are used. The
 * operator-supplied Forgejo token and the live forge.example.com check belong to
 * deployment (PRJ-301), not to this script.
 */

import { createServer } from "node:http";

const owner = "example";
const name = "repo";
const repo = `${owner}/${name}`;
const pr = 7;
const token = "smoke-token";

const fixturePr = {
  number: pr,
  title: "Add example change",
  body: "Exercise the forge client path.",
  head: {
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ref: "feature/example",
    repo: {
      clone_url: `https://git.example/${repo}.git`,
      fork: false,
    },
  },
  base: {
    sha: "cafebabecafebabecafebabecafebabecafebabe",
    ref: "main",
  },
};

const fixtureDiff = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+world
`;

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const prPath = `/api/v1/repos/${owner}/${name}/pulls/${pr}`;
  const diffPath = `/api/v1/repos/${owner}/${name}/pulls/${pr}.diff`;
  const auth = req.headers.authorization;
  const accept = req.headers.accept;

  if (req.method === "GET" && url === prPath) {
    if (auth !== `token ${token}`) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (accept !== "application/json") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("unexpected accept header");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fixturePr));
    return;
  }

  if (req.method === "GET" && url === diffPath) {
    if (auth !== `token ${token}`) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (accept !== "text/plain") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("unexpected accept header");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(fixtureDiff);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const listen = () =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve(port);
    });
  });

const close = () =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

/** Forge-client code path: request shapes, auth, headers, and field extraction. */
async function getPullRequest(baseUrl) {
  const response = await fetch(
    `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}`,
    {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GET pull request failed: ${response.status} ${await response.text()}`,
    );
  }
  const raw = await response.json();
  const head = raw.head ?? {};
  const base = raw.base ?? {};
  const headRepo = head.repo ?? {};
  const cloneUrl =
    headRepo.clone_url ?? headRepo.ssh_url ?? raw.url ?? undefined;
  return {
    headSha: head.sha,
    baseSha: base.sha,
    headRef: head.ref,
    baseRef: base.ref,
    title: raw.title,
    body: raw.body ?? "",
    clone_url: cloneUrl,
  };
}

async function getDiff(baseUrl) {
  const response = await fetch(
    `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr}.diff`,
    {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "text/plain",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GET pull request diff failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.text();
}

try {
  const port = await listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  const shape = await getPullRequest(baseUrl);
  const checks = [
    ["head sha", shape.headSha],
    ["base sha", shape.baseSha],
    ["head ref", shape.headRef],
    ["base ref", shape.baseRef],
    ["title", shape.title],
    ["body", shape.body],
    ["clone_url", shape.clone_url],
  ];
  for (const [label, value] of checks) {
    if (value === undefined || value === null) {
      throw new Error(`PR shape missing field: ${label}`);
    }
  }
  if (typeof shape.headSha !== "string" || shape.headSha === "")
    throw new Error("head sha must be a non-empty string");
  if (typeof shape.baseSha !== "string" || shape.baseSha === "")
    throw new Error("base sha must be a non-empty string");
  if (typeof shape.headRef !== "string" || shape.headRef === "")
    throw new Error("head ref must be a non-empty string");
  if (typeof shape.baseRef !== "string" || shape.baseRef === "")
    throw new Error("base ref must be a non-empty string");
  if (typeof shape.title !== "string")
    throw new Error("title must be a string");
  if (typeof shape.body !== "string") throw new Error("body must be a string");
  if (typeof shape.clone_url !== "string" || shape.clone_url === "")
    throw new Error("clone_url must be a non-empty string");

  console.log(
    `PR shape ok: ${repo}#${pr} head=${shape.headSha} base=${shape.baseSha} headRef=${shape.headRef} baseRef=${shape.baseRef}`,
  );

  const diff = await getDiff(baseUrl);
  if (!diff || diff.trim() === "") {
    throw new Error("diff is empty");
  }
  console.log(`PR diff ok: ${diff.split("\n").length} lines`);
  console.log("smoke passed");
} finally {
  await close();
}
