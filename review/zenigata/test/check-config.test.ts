import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRenderedConfig,
  parseEnvironmentFile,
  readIdentityExpectations,
  readRenderedEnvironment,
} from "../src/check-config.js";

const renderedEnv: Record<string, string | undefined> = {
  ZENIGATA_STATE_DIR: "/state",
  ZENIGATA_ALLOWED_LOGINS: "example-user",
  ZENIGATA_ADAPTER_URL: "http://adapter.invalid",
  ZENIGATA_FORGE_URL: "https://forge.invalid",
  ZENIGATA_OPENCODE_URL: "http://opencode.invalid",
  ZENIGATA_MEMORY_URL:
    "http://127.0.0.1:28132/mcp?app=zenigata&initiator=agent",
  ZENIGATA_HUMANS: "example-user",
  ZENIGATA_AGENTS: "example-bot",
  ZENIGATA_ACCESS: "example-user,example-bot",
};

const secretsEnv: Record<string, string | undefined> = {
  ZENIGATA_ADAPTER_TOKEN: "adapter-secret",
  ZENIGATA_EVENT_TOKEN: "event-secret",
};

const want = {
  humans: ["example-user"],
  agents: ["example-bot"],
  access: ["example-user", "example-bot"],
};

describe("checkRenderedConfig", () => {
  it("loads a rendered deployment clean and carries the rendered identity lists", () => {
    const result = checkRenderedConfig({
      rendered: { ...renderedEnv, PATH: "/usr/bin:/bin" },
      secrets: secretsEnv,
      want,
    });
    expect(result.failures).toEqual([]);
    expect(result.config?.humans).toEqual(["example-user"]);
    expect(result.config?.agents).toEqual(["example-bot"]);
    expect(result.config?.access).toEqual(["example-user", "example-bot"]);
  });

  it("names the boot-time validation failure when the environment is incomplete", () => {
    const rendered = { ...renderedEnv };
    delete rendered.ZENIGATA_STATE_DIR;
    const result = checkRenderedConfig({ rendered, secrets: secretsEnv, want });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("ZENIGATA_STATE_DIR is required");
    expect(result.config).toBeUndefined();
  });

  it("refuses a memory URL without the lineage declaration", () => {
    const result = checkRenderedConfig({
      rendered: {
        ...renderedEnv,
        ZENIGATA_MEMORY_URL: "http://127.0.0.1:28132/mcp?app=zenigata",
      },
      secrets: secretsEnv,
      want,
    });
    expect(result.failures).toHaveLength(1);
    // The consequence the message states is the gate's real one: an
    // unseen conversation classifies 'absent' rather than the
    // agent-lineage class, and the observation grant is the same either
    // way — not a refused or re-derived observation write.
    expect(result.failures[0]).toContain("initiator=agent");
    expect(result.failures[0]).toContain("class 'absent'");
    expect(result.failures[0]).toContain(
      "observation grant itself is the same",
    );
  });

  it("refuses a memory URL that does not name the bot's client", () => {
    const result = checkRenderedConfig({
      rendered: {
        ...renderedEnv,
        ZENIGATA_MEMORY_URL:
          "http://127.0.0.1:28132/mcp?app=other&initiator=agent",
      },
      secrets: secretsEnv,
      want,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("app=zenigata");
  });

  it("fails the identity list whose rendering diverged", () => {
    const result = checkRenderedConfig({
      rendered: { ...renderedEnv, ZENIGATA_AGENTS: "" },
      secrets: secretsEnv,
      want,
    });
    expect(result.failures).toEqual([
      "the identity list 'agents' rendered as [], wanted [\"example-bot\"]",
    ]);
  });
});

describe("parseEnvironmentFile", () => {
  it("reads KEY=VALUE lines, skips blanks and comments, and strips whole-value quotes", () => {
    expect(
      parseEnvironmentFile(
        [
          "# the tokens",
          "ZENIGATA_EVENT_TOKEN=event-secret",
          "",
          "ZENIGATA_ADAPTER_TOKEN='adapter secret'",
          'ZENIGATA_OPENCODE_KEY="quoted double"',
        ].join("\n"),
      ),
    ).toEqual({
      ZENIGATA_EVENT_TOKEN: "event-secret",
      ZENIGATA_ADAPTER_TOKEN: "adapter secret",
      ZENIGATA_OPENCODE_KEY: "quoted double",
    });
  });

  it("keeps every byte after the first equals sign inside the value", () => {
    expect(
      parseEnvironmentFile("ZENIGATA_MEMORY_URL=http://mcp/mcp?a=b&c=d"),
    ).toEqual({ ZENIGATA_MEMORY_URL: "http://mcp/mcp?a=b&c=d" });
  });

  it("throws on a non-empty line without an equals sign, instead of losing it", () => {
    expect(() => parseEnvironmentFile("GARBAGE")).toThrow(
      /environment file line 'GARBAGE' is not KEY=VALUE/,
    );
  });
});

describe("file readers", () => {
  const writeTemp = async (name: string, content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "zenigata-check-"));
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  };

  it("reads a rendered environment of strings only, naming a non-string value", async () => {
    expect(
      readRenderedEnvironment(
        await writeTemp("env.json", JSON.stringify({ A: "1", B: "2" })),
      ),
    ).toEqual({ A: "1", B: "2" });
    const numeric = await writeTemp("env.json", JSON.stringify({ A: 1 }));
    expect(() => readRenderedEnvironment(numeric)).toThrow(
      /'A' is not an environment string/,
    );
    const array = await writeTemp("env.json", JSON.stringify([1]));
    expect(() => readRenderedEnvironment(array)).toThrow(
      /expected a JSON object/,
    );
  });

  it("reads identity expectations of three arrays, naming a foreign entry", async () => {
    expect(
      readIdentityExpectations(
        await writeTemp("want.json", JSON.stringify(want)),
      ),
    ).toEqual(want);
    const nonArray = await writeTemp(
      "want.json",
      JSON.stringify({ ...want, agents: "example-bot" }),
    );
    expect(() => readIdentityExpectations(nonArray)).toThrow(
      /'agents' must be an array/,
    );
    const nonString = await writeTemp(
      "want.json",
      JSON.stringify({ ...want, humans: [3] }),
    );
    expect(() => readIdentityExpectations(nonString)).toThrow(
      /'humans' must be an array/,
    );
  });
});
