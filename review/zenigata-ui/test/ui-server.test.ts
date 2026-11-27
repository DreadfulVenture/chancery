/**
 * The UI server's surface: the built page's shell and assets, and the
 * bot's read surface proxied server-side — /page, /log/<session id>,
 * /status ride through untouched, the browser stays same-origin, and an
 * unreachable intake answers 502.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server } from "node:http";
import { distAssets, loadUiConfig, UiServer } from "../src/server/ui-server.js";
import type { Logger } from "pino";

/** A silent logger seam: the tests record nothing. */
const loggerStub = {
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections?.();
      return new Promise((r) => s.close(r));
    }),
  );
});

describe("the configuration", () => {
  it("the defaults bind 8472 and point at the intake's default port", () => {
    expect(loadUiConfig({})).toEqual({
      listenPort: 8472,
      serverUrl: "http://127.0.0.1:8471",
    });
  });

  it("the environment overrides both, and a trailing slash loses it", () => {
    expect(
      loadUiConfig({
        ZENIGATA_UI_LISTEN_PORT: "9",
        ZENIGATA_SERVER_URL: "http://127.0.0.1:9///",
      }),
    ).toEqual({ listenPort: 9, serverUrl: "http://127.0.0.1:9" });
  });

  it("a garbage port falls back to the default", () => {
    expect(loadUiConfig({ ZENIGATA_UI_LISTEN_PORT: "nope" }).listenPort).toBe(
      8472,
    );
  });
});

describe("the built page", () => {
  it("the dist reader serves the built shell and assets, and missing ones answer null", async () => {
    const root = await mkdtemp(join(tmpdir(), "zenigata-ui-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html><div id=app>");
    await writeFile(join(root, "app.js"), "// bundle");
    await writeFile(join(root, "styles.css"), "body {}");
    await writeFile(join(root, "assets/favicon.svg"), "<svg/>");
    expect((await distAssets("index.html", root))?.toString()).toContain(
      "<!doctype html>",
    );
    expect(
      (await distAssets("assets/favicon.svg", root))?.toString(),
    ).toContain("<svg/>");
    expect(await distAssets("app.css", root)).toBeNull();
  });

  it("the server serves the shell, the bundle, the stylesheet, and the favicon", async () => {
    const root = await mkdtemp(join(tmpdir(), "zenigata-ui-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><div id="app"></div>',
    );
    await writeFile(join(root, "app.js"), "// bundle");
    await writeFile(join(root, "styles.css"), "body {}");
    await writeFile(join(root, "assets/favicon.svg"), "<svg/>");
    const server = new UiServer(
      loadUiConfig({}),
      {
        fetch: async (p) => {
          try {
            const { readFile } = await import("node:fs/promises");
            return await readFile(join(root, p));
          } catch {
            return null;
          }
        },
      },
      loggerStub,
    );
    const port = await server.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const shell = await fetch(base);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="app"></div>');
    const app = await fetch(`${base}/app.js`);
    expect(await app.text()).toBe("// bundle");
    const css = await fetch(`${base}/styles.css`);
    expect(await css.text()).toBe("body {}");
    const icon = await fetch(`${base}/assets/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    const missing = await fetch(`${base}/nope.js`);
    expect(missing.status).toBe(404);
    await server.close();
  });
});

describe("the intake proxy", () => {
  /** A local fake intake standing in for the bot. */
  const fakeIntake = async (
    answer: (path: string) => { status: number; body: string } | undefined,
  ): Promise<number> => {
    const fake = createServer((request, response) => {
      const url = request.url ?? "";
      const hit = answer(url);
      if (hit === undefined) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(hit.status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(hit.body);
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    servers.push(fake);
    return (fake.address() as AddressInfo).port;
  };

  it("/page, /log/<session id>, and /status ride through untouched", async () => {
    const intakePort = await fakeIntake((url) => {
      if (url === "/page") {
        return { status: 200, body: '{"renderedAt":"now"}' };
      }
      if (url === "/log/sess%20one") {
        return { status: 200, body: '{"state":"found","text":"turns"}' };
      }
      if (url === "/status") {
        return { status: 200, body: '{"uptime":{}}' };
      }
      return undefined;
    });
    const server = new UiServer(
      loadUiConfig({ ZENIGATA_SERVER_URL: `http://127.0.0.1:${intakePort}` }),
      { fetch: async () => null },
      loggerStub,
    );
    const port = await server.listen(0);
    const base = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${base}/page`)).text()).toBe(
      '{"renderedAt":"now"}',
    );
    const log = await fetch(`${base}/log/sess%20one`);
    expect(await log.text()).toBe('{"state":"found","text":"turns"}');
    expect(await (await fetch(`${base}/status`)).text()).toBe('{"uptime":{}}');
    // The bot's own 404 rides through with its status: a settled or
    // swept session's not-found answer keeps the UI's block semantics.
    const missing = await fetch(`${base}/log/gone`);
    expect(missing.status).toBe(404);
    await server.close();
  });

  it("an unreachable intake answers 502 with the error named", async () => {
    const server = new UiServer(
      loadUiConfig({ ZENIGATA_SERVER_URL: "http://127.0.0.1:1" }),
      { fetch: async () => null },
      loggerStub,
    );
    const port = await server.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/page`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "the intake is unreachable",
    });
    await server.close();
  });
});
