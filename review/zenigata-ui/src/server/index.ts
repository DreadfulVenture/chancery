/**
 * The zenigata-ui bin: load the configuration, build the dist asset
 * reader, start the UI server.
 */

import { logger } from "./logger.js";
import { loadUiConfig, UiServer, distAssets } from "./ui-server.js";

async function main(): Promise<void> {
  const config = loadUiConfig(process.env);
  const server = new UiServer(config, { fetch: distAssets }, logger);
  const port = await server.listen(config.listenPort);
  logger.info({ port, intake: config.serverUrl }, "zenigata-ui listening");
}

void main().catch((error) => {
  logger.error(error, "startup failed");
  process.exit(1);
});
