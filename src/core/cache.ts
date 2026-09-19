import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Cross-process answer cache.
 *
 * Every hook invocation is a FRESH PROCESS, so an in-memory cache would never
 * hit. Repeated judgements within a session (the same `npm test` run five
 * times) are common, so the cache has to live on disk.
 *
 * Best-effort throughout: any failure degrades to a miss. A broken cache must
 * never break a decision.
 */

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 500;

function cacheDir(): string {
  const base =
    process.env.JEV_CACHE_DIR ??
    (process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "cache") : undefined) ??
    join(homedir(), ".jev", "cache");
  try {
    mkdirSync(base, { recursive: true });
    return base;
  } catch {
    return tmpdir();
  }
}

export function cacheKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export function cacheGet<T>(key: string): T | undefined {
  try {
    const file = join(cacheDir(), `${key}.json`);
    const age = Date.now() - statSync(file).mtimeMs;
    if (age > TTL_MS) {
      unlinkSync(file);
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    writeFileSync(join(cacheDir(), `${key}.json`), JSON.stringify(value), "utf8");
    sweep();
  } catch {
    // Ignore: caching is an optimisation, never a requirement.
  }
}

/** Opportunistic cleanup, ~1 run in 20, so no invocation pays the full cost. */
function sweep(): void {
  if (Math.random() > 0.05) return;
  try {
    const dir = cacheDir();
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(dir, f);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const now = Date.now();
    for (const [i, e] of entries.entries()) {
      if (i >= MAX_ENTRIES || now - e.mtime > TTL_MS) unlinkSync(e.p);
    }
  } catch {
    // Ignore.
  }
}
