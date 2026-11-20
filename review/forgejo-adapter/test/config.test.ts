import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  FORGEJO_BASE_URL: "https://git.example/",
  FORGEJO_TOKEN: "forge-token",
  ZENIGATA_ADAPTER_TOKEN: "outbound",
  ZENIGATA_INTAKE_URL: "https://bot.example/",
  ZENIGATA_EVENT_TOKEN: "event",
  FORGEJO_WEBHOOK_SECRET: "secret",
};

describe("loadConfig", () => {
  it("parses required config and applies defaults", () => {
    const config = loadConfig(baseEnv);
    expect(config.listenPort).toBe(8472);
    expect(config.forgeBaseUrl).toBe("https://git.example");
    expect(config.intakeUrl).toBe("https://bot.example");
    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it("fails fast naming the offending variable", () => {
    expect(() => loadConfig({ ...baseEnv, FORGEJO_TOKEN: "" })).toThrow(
      /FORGEJO_TOKEN is required/,
    );
    expect(() =>
      loadConfig({ ...baseEnv, FORGEJO_BASE_URL: "not-a-url" }),
    ).toThrow(/FORGEJO_BASE_URL/);
  });
});
