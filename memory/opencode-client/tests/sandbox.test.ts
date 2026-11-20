import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DAEMON_URL, HOME } from "./sandbox.ts";

test("the sandbox default daemon url is dead by construction", () => {
  assert.equal(
    DEFAULT_DAEMON_URL,
    "http://127.0.0.1:1",
    "the default must not be the production port: an accidental POST outside withDaemon has to fail on connect",
  );
  const config = JSON.parse(
    readFileSync(join(HOME, ".local/services/memory/client.json"), "utf8"),
  );
  assert.equal(config.daemon_url, DEFAULT_DAEMON_URL);
});
