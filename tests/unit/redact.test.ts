import { describe, expect, it } from "vitest";
import { prepare, redact, truncate } from "../../src/core/redact.js";

describe("redact", () => {
  it.each([
    ["sk-ant-api03-AbCdEf0123456789xyz", "anthropic key"],
    ["ghp_0123456789abcdefghijklmnopqrstuvwxyz", "github token"],
    ["xoxb-123456789012-abcdefghijkl", "slack token"],
    ["AKIAIOSFODNN7EXAMPLE", "aws key id"],
  ])("removes a %s", (secret) => {
    const out = redact(`config value is ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(out).toContain("redacted");
  });

  it("removes a whole PEM block, not just its header", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxGgH2Dt0Nb1vQ9Zk",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(`before\n${pem}\nafter`);
    expect(out).not.toContain("MIIEowIBAAKCAQEAxGgH2Dt0Nb1vQ9Zk");
    expect(out).toContain("[redacted-private-key]");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("removes assignment-shaped secrets but keeps the variable name", () => {
    const out = redact('DATABASE_PASSWORD="hunter2hunter2"');
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("DATABASE_PASSWORD");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "The deploy script reads the token from the environment.";
    expect(redact(prose)).toBe(prose);
  });
});

describe("truncate", () => {
  it("passes short input through unchanged", () => {
    expect(truncate("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("bounds long input and flags it", () => {
    const result = truncate("x".repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(100);
  });

  it("does not emit a broken code point when slicing multi-byte text", () => {
    // '€' is three bytes; cutting at 100 lands mid-character.
    const result = truncate("€".repeat(200), 100);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
  });
});

describe("prepare", () => {
  it("redacts before truncating, so a secret cannot survive past the cut", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const { text } = prepare(`${secret} ${"padding ".repeat(200)}`, 120);
    expect(text).not.toContain(secret);
  });
});
