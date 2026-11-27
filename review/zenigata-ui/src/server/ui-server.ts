/**
 * The UI server: the zenigata-ui app's own process. It serves the built
 * page (shell, styles, bundle, favicon) and proxies the bot's read
 * surface — GET /page, /log/<session id>, /status — server-side, so the
 * browser stays same-origin and the bot's intake can keep binding
 * loopback only. The bot's HTTP surface is the contract; the UI adds
 * nothing to it and consumes it as a client.
 */

import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Logger } from "./logger.js";

/** The UI's configuration, from the unit environment. */
export interface UiConfig {
  /** The port the UI server binds (0 = the OS picks one). */
  listenPort: number;
  /** The intake server's base URL. */
  serverUrl: string;
}

export const loadUiConfig = (env: NodeJS.ProcessEnv): UiConfig => ({
  listenPort: int(env.ZENIGATA_UI_LISTEN_PORT, 8472),
  serverUrl: (env.ZENIGATA_SERVER_URL ?? "http://127.0.0.1:8471").replace(
    /\/+$/,
    "",
  ),
});

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

/** What the server reads its built assets through; injected for tests. */
export interface AssetSource {
  fetch(path: string): Promise<Buffer | null>;
}

/** The dist asset read the server wires in production. */
export const distAssets = async (
  path: string,
  dir: string = clientDir(),
): Promise<Buffer | null> => {
  try {
    return await readFile(join(dir, path));
  } catch {
    return null;
  }
};

/** The built client tree the server serves from. */
export const clientDir = (): string =>
  join(new URL("../../dist/client/", import.meta.url).pathname);

export class UiServer {
  private readonly app = new Hono<{ Bindings: HttpBindings }>();
  private bound: Server | undefined;

  constructor(
    private readonly config: UiConfig,
    private readonly assets: AssetSource,
    private readonly logger: Logger,
  ) {}

  get http(): Server {
    if (this.bound === undefined) {
      throw new Error("the UI server is not listening yet");
    }
    return this.bound;
  }

  /** Bind to loopback; resolves with the port the OS actually assigned. */
  listen(port: number): Promise<number> {
    this.wire();
    const server = createAdaptorServer({ fetch: this.app.fetch }) as Server;
    this.bound = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : port;
        resolve(bound);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.bound === undefined) {
        resolve();
        return;
      }
      this.bound.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private wire(): void {
    const app = this.app;

    // The page shell: one document, the app mounts into it.
    app.get("/", async (c) => {
      const shell = await this.assets.fetch("index.html");
      if (shell === null) {
        return c.text("the UI build is missing; run the package's build", 500);
      }
      return c.body(new Uint8Array(shell), 200, {
        "Content-Type": "text/html; charset=utf-8",
      });
    });

    // The bot's read surface, proxied server-side: the browser stays
    // same-origin and the intake keeps its loopback binding.
    app.get("/page", (c) => this.proxy(c, "/page"));
    app.get("/log/:sessionId", (c) =>
      this.proxy(c, `/log/${encodeURIComponent(c.req.param("sessionId"))}`),
    );
    app.get("/status", (c) => this.proxy(c, "/status"));

    // The built client: the bundle, the stylesheet, and the favicon.
    const staticAssets = [
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/styles.css", "styles.css", "text/css; charset=utf-8"],
      ["/assets/favicon.svg", "assets/favicon.svg", "image/svg+xml"],
    ] as const;
    for (const [route, file, type] of staticAssets) {
      app.get(route, async (c) => {
        const asset = await this.assets.fetch(file);
        if (asset === null) {
          return c.text("not found", 404);
        }
        return c.body(new Uint8Array(asset), 200, { "Content-Type": type });
      });
    }

    app.notFound((c) => c.text("not found", 404));
    app.onError((error, c) => {
      this.logger.error(error, "request handler failed");
      return c.text("internal error", 500);
    });
  }

  /** One proxied read: the bot's answer rides through untouched, status included. */
  private async proxy(c: Context, path: string): Promise<Response> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.config.serverUrl}${path}`);
    } catch (error) {
      this.logger.error(
        error,
        `the intake is unreachable at ${this.config.serverUrl}`,
      );
      return c.body(
        JSON.stringify({ error: "the intake is unreachable" }),
        502,
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }
    const body = await response.text();
    return c.body(body, response.status as 200, {
      "Content-Type":
        response.headers.get("content-type") ??
        "application/json; charset=utf-8",
    });
  }
}
