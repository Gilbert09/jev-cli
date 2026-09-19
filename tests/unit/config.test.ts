import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../../src/core/config.js";

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-config-"));
  resetConfigCache();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_MODEL;
  delete process.env.JEV_DEBUG;
  process.env.JEV_CONFIG_PATH = join(dir, "config.json");
});

afterEach(() => {
  process.env = { ...saved };
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

const writeConfig = (value: unknown) =>
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");

describe("defaults", () => {
  it("works with no config file at all", () => {
    const c = loadConfig();
    expect(c.model).toBe("jev-latest");
    expect(c.apiKey).toBeUndefined();
    expect(c.guard.enabled).toBe(true);
  });

  it("gives each capability its own latency budget", () => {
    const c = loadConfig();
    // guard is the tightest: it sits in front of every tool call.
    expect(c.guard.timeoutMs).toBeLessThan(c.rank.timeoutMs);
  });
});

describe("precedence", () => {
  it("prefers the environment over the config file", () => {
    writeConfig({ apiKey: "from-file", model: "from-file-model" });
    process.env.TYPESAFE_API_KEY = "from-env";
    process.env.JEV_MODEL = "from-env-model";
    const c = loadConfig();
    expect(c.apiKey).toBe("from-env");
    expect(c.model).toBe("from-env-model");
  });

  it("falls back to the config file when the environment is unset", () => {
    writeConfig({ apiKey: "from-file" });
    expect(loadConfig().apiKey).toBe("from-file");
  });
});

describe("resilience", () => {
  it("ignores a malformed config file instead of crashing every hook", () => {
    writeFileSync(join(dir, "config.json"), "{ not json", "utf8");
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().model).toBe("jev-latest");
  });

  it("merges partial capability overrides onto the defaults", () => {
    writeConfig({ screen: { enabled: false } });
    const c = loadConfig();
    expect(c.screen.enabled).toBe(false);
    // Unspecified fields must survive the merge.
    expect(c.screen.maxBytes).toBe(40_000);
    expect(c.screen.excludeGlobs.length).toBeGreaterThan(0);
  });

  it("lets a user disable the capabilities that send content off the machine", () => {
    writeConfig({ screen: { enabled: false }, rank: { enabled: false } });
    const c = loadConfig();
    expect(c.screen.enabled).toBe(false);
    expect(c.rank.enabled).toBe(false);
    expect(c.guard.enabled).toBe(true);
  });
});
