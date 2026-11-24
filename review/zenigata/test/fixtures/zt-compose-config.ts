/**
 * The compatibility check's config-home composition (PRJ-479): the packaged
 * serve boots against a deployment-shaped config home built here, so the
 * harness exercises exactly the layering a deployment does — the packaged
 * neutral config as the base, the harness's provider and model wiring as
 * the deployment layer on top, and the packaged agent definition published
 * under the id the driver selects. The check pins every XDG dir (DATA,
 * STATE, CACHE, CONFIG, HOME) into its own work tree, so the serve touches
 * nothing of the invoking user's opencode state.
 *
 * Usage: node zt-compose-config.ts <packaged-config> <agent-md> <mock-base-url> <out-dir>
 *
 * Writes <out-dir>/opencode/opencode.json and the agent definitions at
 * <out-dir>/opencode/agent/zenigata-reviewer.md (the parent) and
 * <out-dir>/opencode/agent/zt-worker.md (the file-defined tool-using child).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [packagedConfig, agentMd, mockBaseUrl, outDir] = process.argv.slice(2);
if (!packagedConfig || !agentMd || !mockBaseUrl || !outDir) {
  console.error(
    "usage: node zt-compose-config.ts <packaged-config> <agent-md> <mock-base-url> <out-dir>",
  );
  process.exit(1);
}

interface PackagedConfig {
  agents?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

const base = JSON.parse(readFileSync(packagedConfig, "utf8")) as PackagedConfig;

// The harness provider: the catalog's openai provider overlaid onto the
// scripted mock (chat protocol, mock baseURL), so no package fetch, no
// credentials, no network. The reviewer rides the reviewer script; the
// child agent rides the worker script; anything else defaults to the
// round-trip script.
const composed = {
  ...base,
  model: "openai/reviewer",
  agents: {
    ...base.agents,
    // The file-defined reviewer's model: the parent script.
    "zenigata-reviewer": {
      model: "openai/reviewer",
    },
    // The child the reviewer spawns: subagent mode, the delayed worker.
    "zt-worker": {
      mode: "subagent",
      model: "openai/worker",
    },
  },
  providers: {
    ...base.providers,
    // The catalog's openai provider, overlaid onto the scripted mock: the
    // chat-protocol entrypoint explicitly (the catalog default is the
    // responses route), the mock's baseURL, and the two scripted models.
    openai: {
      package: "@opencode/ai/providers/openai/chat",
      name: "ZT Mock via OpenAI",
      settings: {
        baseURL: mockBaseUrl,
        apiKey: "zt-compat-dummy",
      },
      models: {
        reviewer: { name: "Reviewer" },
        worker: { name: "Worker" },
      },
    },
  },
};

const configDir = join(outDir, "opencode");
const agentDir = join(configDir, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(configDir, "opencode.json"),
  JSON.stringify(composed, null, 2),
);
copyFileSync(agentMd, join(agentDir, "zenigata-reviewer.md"));

// The child as a file-defined agent, its own tool grants in frontmatter:
// the config plugin pushes the config floor onto every agent's ruleset
// first, and a file-defined agent's own rules land after the floor's, so
// they win at the serve's last-match rule evaluation. The allow-all row
// here is the evidence surface for that asymmetry: the worker's `read`
// tool call runs under the deny-all config floor. The one-line values
// keep the YAML multiline-scalar gotcha away.
writeFileSync(
  join(agentDir, "zt-worker.md"),
  [
    "---",
    "name: zt-worker",
    "description: The compatibility harness's file-defined subagent child",
    "mode: subagent",
    "permissions:",
    '  - { action: "*", resource: "*", effect: "allow" }',
    "---",
    "",
    "The harness's tool-using child: reads the target file the delegator's",
    "prompt points it at, then reports the child text.",
    "",
  ].join("\n"),
);
console.log(`composed config home at ${outDir}`);
