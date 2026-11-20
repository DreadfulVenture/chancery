import { loadConfig } from "./config.js";
import { forgejoClient } from "./forgejo-client.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const forgejo = forgejoClient({
    baseUrl: config.forgeBaseUrl,
    token: config.forgeToken,
    timeoutMs: config.requestTimeoutMs,
  });
  await startServer(config, { forgejo, logger: console });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`forgejo-adapter failed to start: ${message}`);
  process.exit(1);
});
