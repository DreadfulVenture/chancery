import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A deployment's worth of state in a temp directory, set up as a side
// effect of importing this. Every test file that builds the plugin needs
// it: the plugin refuses to load without a client.json, and without a
// sandboxed HOME it would find the developer's real one and append test
// turns to the real capture queue.
export const HOME = mkdtempSync(join(tmpdir(), "memory-plugin-"));
process.env.HOME = HOME;

const serviceDir = join(HOME, ".local/services/memory");
export const QUEUE_DIR = join(serviceDir, "queue");
export const QUEUE_FILE = join(QUEUE_DIR, "capture.jsonl");

mkdirSync(join(serviceDir, "data"), { recursive: true });

// Nothing listens on TCP port 1, so a daemon_url accident dies instantly on
// connect instead of reaching whatever runs on the production port (the
// default would otherwise have been that port, 17173). Tests that need a
// daemon bring their own via withDaemon, which overrides per request.
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:1";

export function writeClientConfig(overrides: Record<string, string> = {}) {
  writeFileSync(
    join(serviceDir, "client.json"),
    JSON.stringify({
      daemon_url: DEFAULT_DAEMON_URL,
      queue_dir: QUEUE_DIR,
      ...overrides,
    }),
  );
}

writeClientConfig();
