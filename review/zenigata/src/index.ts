#!/usr/bin/env node
/**
 * The zenigata bin: load configuration, build the real dependencies, start
 * the intake server.
 */

import { consoleLogger } from "./ctx.js";
import { loadConfig } from "./config.js";
import { memoryMcpGateway } from "./adapters/memory-mcp.js";
import { httpForgeAdapter } from "./adapters/forge.js";
import { opencodeSessionDriver } from "./adapters/opencode.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await startServer(config, {
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
    memory: memoryMcpGateway({ url: config.memoryUrl, logger: consoleLogger }),
  });
}

void main().catch((error) => {
  consoleLogger.error(
    `startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
