/**
 * The intake server's HTTP layer: a hono app whose routes are the
 * IntakeRoute and SurfaceRoute classes, served through the node adapter
 * bound to loopback. The routing itself is the framework's; what this
 * class owns is the assembly — the 404 and error surfaces, the listen
 * and close lifecycle, and the ServerHandle the callers hold.
 */

import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { Server } from "node:http";
import { plain } from "./intake.js";
import { IntakeRoute } from "./intake.js";
import { SurfaceRoute } from "./surface.js";
import type { EventPipeline } from "../pipeline.js";
import type { Config } from "../config.js";
import type { Logger } from "../ctx.js";

type App = Hono<{ Bindings: HttpBindings }>;

export interface IntakeServerInputs {
  config: Config;
  pipeline: EventPipeline;
  surface: SurfaceRoute;
  logger: Logger;
}

export class IntakeServer {
  private readonly app: App = new Hono();
  private server: Server | undefined;
  private readonly intake: IntakeRoute;
  private readonly surface: SurfaceRoute;
  private bound: Server | undefined;

  /** The node server the adapter built; undefined until listen(). */
  get http(): Server {
    if (this.bound === undefined) {
      throw new Error("the intake server is not listening yet");
    }
    return this.bound;
  }

  constructor(inputs: IntakeServerInputs) {
    this.intake = new IntakeRoute(inputs.config.eventToken, inputs.pipeline);
    this.surface = inputs.surface;
    this.wire(inputs.logger);
  }

  private wire(logger: Logger): void {
    const app = this.app;
    app.post("/v1/events", (c) => this.intake.handle(c));
    app.get("/metrics", (c) => this.surface.metrics(c));
    app.get("/healthz", (c) => this.surface.healthz(c));
    app.get("/status", (c) => this.surface.status(c));
    app.get("/page", (c) => this.surface.pageData(c));
    app.get("/log/:sessionId", (c) =>
      this.surface.log(c, c.req.param("sessionId")),
    );
    app.get("/", (c) => this.surface.home(c));
    app.notFound((c) => plain(c, 404, "not found"));
    app.onError((error, c) => {
      logger.error(
        `request handler failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return plain(c, 500, "internal error");
    });
  }

  /** Bind to loopback; resolves with the port the OS actually assigned. */
  listen(port: number): Promise<number> {
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
}
