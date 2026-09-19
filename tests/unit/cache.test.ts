import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheGet, cacheKey, cacheSet } from "../../src/core/cache.js";

// The cache lives on disk because every hook invocation is a FRESH PROCESS —
// an in-memory cache would never produce a single hit.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
  process.env.JEV_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.JEV_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cacheKey", () => {
  it("is stable for equal input", () => {
    expect(cacheKey(["a", { b: 1 }])).toBe(cacheKey(["a", { b: 1 }]));
  });

  it("differs when any part differs", () => {
    expect(cacheKey(["a", { b: 1 }])).not.toBe(cacheKey(["a", { b: 2 }]));
  });

  it("separates capabilities so one cannot read another's verdict", () => {
    expect(cacheKey(["jev-latest", "guard", {}, "x"])).not.toBe(
      cacheKey(["jev-latest", "screen", {}, "x"]),
    );
  });
});

describe("round trip", () => {
  it("survives across processes, which is the whole point", () => {
    const key = cacheKey(["round", "trip"]);
    cacheSet(key, { danger: 3 });
    expect(cacheGet(key)).toEqual({ danger: 3 });
  });

  it("misses cleanly for an unknown key", () => {
    expect(cacheGet(cacheKey(["never", "written"]))).toBeUndefined();
  });
});

describe("resilience", () => {
  it("treats corrupt cache content as a miss rather than throwing", () => {
    const key = cacheKey(["corrupt"]);
    writeFileSync(join(dir, `${key}.json`), "{ not json", "utf8");
    expect(cacheGet(key)).toBeUndefined();
  });

  it("never throws when the cache directory is unusable", () => {
    process.env.JEV_CACHE_DIR = "/proc/definitely/not/writable";
    // A broken cache must degrade to a miss, never break a decision.
    expect(() => cacheSet(cacheKey(["x"]), { a: 1 })).not.toThrow();
    expect(() => cacheGet(cacheKey(["x"]))).not.toThrow();
  });
});
