import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("strips the credentials from a composed git error", () => {
    const message = redactSecrets(
      "git clone https://user:token@git.example.com/org/repo.git /tmp/work failed: fatal: could not read from remote repository",
    );
    expect(message).not.toContain("user:token");
    expect(message).toContain("https://git.example.com/org/repo.git");
  });

  it("leaves credential-free text untouched", () => {
    const text = "git fetch origin -- feature main failed: not a repo";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts every clone-able scheme", () => {
    for (const scheme of ["https", "http", "ssh", "git", "file"]) {
      expect(redactSecrets(`${scheme}://bot:secret@host/org/repo`)).toBe(
        `${scheme}://host/org/repo`,
      );
    }
  });

  it("redacts userinfo containing a slash in full", () => {
    expect(redactSecrets("https://u:p/ss@host/repo")).toBe("https://host/repo");
  });

  it("redacts the scheme-less user:pass@host form", () => {
    expect(redactSecrets("git clone user:token@host/org/repo failed")).toBe(
      "git clone host/org/repo failed",
    );
    expect(
      redactSecrets("clone failed for user:token@host/org/repo"),
    ).not.toContain("token");
  });

  it("leaves an email address unredacted", () => {
    expect(redactSecrets("ping alice@example.com about it")).toBe(
      "ping alice@example.com about it",
    );
    // A colon elsewhere in the sentence must not join the email into a
    // credential-shaped match.
    expect(redactSecrets("at 09:30, ping alice@example.com")).toBe(
      "at 09:30, ping alice@example.com",
    );
  });

  it("masks every token-bearing query parameter, case-insensitively", () => {
    for (const name of [
      "token",
      "access_token",
      "password",
      "secret",
      "api_key",
      "key",
      "Token",
      "SECRET",
    ]) {
      expect(redactSecrets(`?${name}=abc123&x=1`)).toBe(
        `?${name}=[redacted]&x=1`,
      );
    }
  });

  it("masks a query token only up to the next &, whitespace, or quote", () => {
    expect(redactSecrets("failed near ?access_token=zzz here")).toBe(
      "failed near ?access_token=[redacted] here",
    );
    expect(redactSecrets('?token=abc" tail')).toBe('?token=[redacted]" tail');
    // A parameter outside the token list, and one whose name does not
    // start at a ? or &, stay untouched.
    expect(redactSecrets("?monkey=untouched")).toBe("?monkey=untouched");
  });

  it("redacts a URL the truncation cap would cut mid-userinfo", () => {
    // Composed the way the git helper composes after this fix: redact
    // the full message first, cap afterwards. The userinfo straddles
    // char 500 of the raw message, so the reverse order (truncate, then
    // redact) would cut the token where no pattern matches any more.
    const message = `${"y".repeat(484)} https://user:supersecrettoken@host/repo failed: fatal: refused`;
    expect(message.slice(0, 500)).toContain("https://user:su");
    const truncated = redactSecrets(message).slice(0, 500);
    expect(truncated).not.toContain("supersecrettoken");
    expect(truncated).toContain("https://");
  });

  it("stays linear on a long run of matchable characters with no @ in it", () => {
    // The scheme-less pattern's regex form rescans such a run from every
    // position — minutes on a 64KiB blob. A narration line can carry
    // one (a base64 blob riding an error body), so the scan must not.
    const blob = `zenigata: the body was ${"y".repeat(65_536)}`;
    const started = Date.now();
    expect(redactSecrets(blob)).toBe(blob);
    // 3.3s was the quadratic reading on this machine; the linear scan
    // is a millisecond. The bound keeps the test honest without pinning
    // a speed.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
