#!/usr/bin/env node
/**
 * The zenigata bin: load configuration, build the real dependencies, start
 * the intake server. With `--check-config` it instead validates a rendered
 * deployment: the unit environment composed with an environment file,
 * through the same schema every boot pays (PRJ-505).
 */

import { consoleLogger, narratingLogger } from "./ctx.js";
import { loadConfig } from "./config.js";
import { runConfigCheck } from "./check-config.js";
import { LogRing } from "./log-ring.js";
import { memoryMcpGateway } from "./adapters/memory-mcp.js";
import { httpForgeAdapter } from "./adapters/forge.js";
import { opencodeSessionDriver } from "./adapters/opencode.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--check-config") {
    runConfigCheck(process.argv.slice(3));
    return;
  }
  const config = loadConfig(process.env);
  // One narration ring shared by every logger this process builds: the
  // gateway's lines and the server's land in the same bounded store the
  // status page renders (PRJ-461).
  const logRing = new LogRing();
  await startServer(config, {
    logRing,
    forge: httpForgeAdapter({
      baseUrl: config.adapterUrl,
      token: config.adapterToken,
    }),
    sessions: opencodeSessionDriver({
      baseUrl: config.opencodeUrl,
      apiKey: config.opencodeKey,
      turnPollSeconds: config.turnPollSeconds,
      turnBudgetSeconds: config.turnBudgetSeconds,
    }),
    memory: memoryMcpGateway({
      url: config.memoryUrl,
      logger: narratingLogger(logRing, consoleLogger),
    }),
  });
}

void main().catch((error) => {
  consoleLogger.error(
    `startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
