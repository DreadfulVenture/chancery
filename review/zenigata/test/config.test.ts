import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv: Record<string, string | undefined> = {
  ZENIGATA_STATE_DIR: "/state",
  ZENIGATA_ALLOWED_LOGINS: "example-user",
  ZENIGATA_ADAPTER_URL: "http://adapter.invalid",
  ZENIGATA_FORGE_URL: "https://forge.invalid",
  ZENIGATA_ADAPTER_TOKEN: "adapter-secret",
  ZENIGATA_EVENT_TOKEN: "event-secret",
  ZENIGATA_OPENCODE_URL: "http://opencode.invalid",
  ZENIGATA_MEMORY_URL: "http://memory.invalid",
};

describe("loadConfig", () => {
  it("rejects a listen port past 65535, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_LISTEN_PORT: "99999" }),
    ).toThrow(/ZENIGATA_LISTEN_PORT: must be <= 65535/);
  });

  it("accepts port 65535 and 0", () => {
    expect(
      loadConfig({ ...baseEnv, ZENIGATA_LISTEN_PORT: "65535" }).listenPort,
    ).toBe(65535);
    expect(
      loadConfig({ ...baseEnv, ZENIGATA_LISTEN_PORT: "0" }).listenPort,
    ).toBe(0);
  });
});

describe("loadConfig forge URL", () => {
  it("parses the forge's base URL", () => {
    expect(
      loadConfig({
        ...baseEnv,
        ZENIGATA_FORGE_URL: "https://forge.example.com",
      }).forgeUrl,
    ).toBe("https://forge.example.com");
  });

  it("is required, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_FORGE_URL: undefined }),
    ).toThrow(/ZENIGATA_FORGE_URL/);
    expect(() => loadConfig({ ...baseEnv, ZENIGATA_FORGE_URL: "" })).toThrow(
      /ZENIGATA_FORGE_URL/,
    );
  });

  it("refuses a non-URL value, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_FORGE_URL: "forge.example.com" }),
    ).toThrow(/ZENIGATA_FORGE_URL: must be an absolute URL/);
  });
});

describe("loadConfig turn and retry keys", () => {
  it("defaults to a few-second poll, a generous turn budget, and no retry", () => {
    const config = loadConfig(baseEnv);
    expect(config.turnPollSeconds).toBe(3);
    expect(config.turnBudgetSeconds).toBe(900);
    expect(config.retryPolicy).toBe("never");
  });

  it("parses explicit turn poll and budget overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      ZENIGATA_TURN_POLL_SECONDS: "10",
      ZENIGATA_TURN_BUDGET_SECONDS: "300",
    });
    expect(config.turnPollSeconds).toBe(10);
    expect(config.turnBudgetSeconds).toBe(300);
  });

  it("rejects non-positive or non-integer turn timings, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_TURN_POLL_SECONDS: "0" }),
    ).toThrow(/ZENIGATA_TURN_POLL_SECONDS/);
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_TURN_BUDGET_SECONDS: "2.5" }),
    ).toThrow(/ZENIGATA_TURN_BUDGET_SECONDS/);
  });

  it("accepts every explicit retry policy value", () => {
    expect(
      loadConfig({ ...baseEnv, ZENIGATA_RETRY_POLICY: "once" }).retryPolicy,
    ).toBe("once");
    expect(
      loadConfig({ ...baseEnv, ZENIGATA_RETRY_POLICY: "never" }).retryPolicy,
    ).toBe("never");
  });

  it("refuses an unlisted retry policy value, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_RETRY_POLICY: "auto" }),
    ).toThrow(/ZENIGATA_RETRY_POLICY: must be one of never, once/);
  });
});

describe("loadConfig retention window", () => {
  it("defaults to a day of retention", () => {
    expect(loadConfig(baseEnv).retentionWindowSeconds).toBe(86_400);
  });

  it("parses explicit windows and takes 0 as the immediate-teardown escape hatch", () => {
    expect(
      loadConfig({
        ...baseEnv,
        ZENIGATA_RETENTION_WINDOW_SECONDS: "172800",
      }).retentionWindowSeconds,
    ).toBe(172_800);
    expect(
      loadConfig({ ...baseEnv, ZENIGATA_RETENTION_WINDOW_SECONDS: "0" })
        .retentionWindowSeconds,
    ).toBe(0);
  });

  it("rejects a negative or non-integer window, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_RETENTION_WINDOW_SECONDS: "-1" }),
    ).toThrow(/ZENIGATA_RETENTION_WINDOW_SECONDS/);
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_RETENTION_WINDOW_SECONDS: "1.5" }),
    ).toThrow(/ZENIGATA_RETENTION_WINDOW_SECONDS/);
  });
});

describe("loadConfig identity arrays", () => {
  it("defaults all three lists to empty", () => {
    const config = loadConfig(baseEnv);
    expect(config.humans).toEqual([]);
    expect(config.agents).toEqual([]);
    expect(config.access).toEqual([]);
  });

  it("parses the three lists from their CSV variables", () => {
    const config = loadConfig({
      ...baseEnv,
      ZENIGATA_HUMANS: "example-user, second-user",
      ZENIGATA_AGENTS: "example-bot",
      ZENIGATA_ACCESS: "example-user, example-bot",
    });
    expect(config.humans).toEqual(["example-user", "second-user"]);
    expect(config.agents).toEqual(["example-bot"]);
    expect(config.access).toEqual(["example-user", "example-bot"]);
  });

  it("tolerates whitespace and empty segments in the CSV", () => {
    const config = loadConfig({
      ...baseEnv,
      ZENIGATA_HUMANS: " example-user , , second-user,",
    });
    expect(config.humans).toEqual(["example-user", "second-user"]);
  });

  it("rejects an entry with a comma-foreign character, naming the variable", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_HUMANS: " example-user, space name" }),
    ).toThrow(/ZENIGATA_HUMANS: 'space name'/);
    expect(() => loadConfig({ ...baseEnv, ZENIGATA_AGENTS: "bot!" })).toThrow(
      /ZENIGATA_AGENTS: 'bot!'/,
    );
    expect(() =>
      loadConfig({ ...baseEnv, ZENIGATA_ACCESS: "user@example.com" }),
    ).toThrow(/ZENIGATA_ACCESS: 'user@example\.com'/);
  });

  it("accepts the charset the forge admits in account names", () => {
    const config = loadConfig({
      ...baseEnv,
      ZENIGATA_HUMANS: "the-operator.2, worker_bot-3",
    });
    expect(config.humans).toEqual(["the-operator.2", "worker_bot-3"]);
  });
});
