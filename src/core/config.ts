import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Configuration resolution, in precedence order:
 *   1. environment variables
 *   2. ~/.jev/config.json
 *   3. built-in defaults
 *
 * The API key is never logged, never echoed, and never included in any
 * hook output.
 */

export interface CapabilityConfig {
  enabled: boolean;
  /** Hard ceiling on a single Jev round trip. */
  timeoutMs: number;
}

export interface Config {
  apiKey: string | undefined;
  model: string;
  guard: CapabilityConfig;
  screen: CapabilityConfig & {
    /**
     * What to do when content is judged an injection.
     *   warn       - append a note to context (advisory)
     *   block      - also place the reason beside the tool result
     *   quarantine - additionally replace the tool output, so the injected
     *                instructions never reach the model as instructions
     */
    mode: "warn" | "block" | "quarantine";
    /** Paths matching any of these are never sent off the machine. */
    excludeGlobs: string[];
    /** Truncate content beyond this before evaluating. */
    maxBytes: number;
  };
  done: CapabilityConfig & {
    /**
     * Block a Stop when the message claims a change reached every place it
     * belongs but nothing searched the tree after the last edit.
     *
     * OFF by default, and the measurements are why. The mechanism is sound —
     * replayed against real transcripts of a 19-call-site rename it caught 2 of
     * 2 genuinely incomplete sweeps, and correctly stayed quiet on the run that
     * had searched for both the symbol and its local alias. But on a live task
     * sonnet handles correctly it fired in 6 of 8 runs and added 35% wall-clock
     * for nothing, because there was nothing to catch.
     *
     * Turn it on for large mechanical refactors — renames, signature changes,
     * codemods across many files — where a silently missed call site is
     * expensive and one extra verification turn is not.
     */
    verifySweepClaims: boolean;
  };
  rank: CapabilityConfig & { maxCandidates: number };
  /** Write decision traces to stderr. Claude Code shows these with --debug. */
  debug: boolean;
}

const DEFAULTS: Omit<Config, "apiKey"> = {
  model: "jev-latest",
  // Latency budget: these run on every tool call. A slow judge is a broken
  // judge, so we would rather fail (to the capability's safe default) than
  // stall the agent loop.
  guard: { enabled: true, timeoutMs: 1500 },
  screen: {
    enabled: true,
    mode: "warn",
    timeoutMs: 2000,
    excludeGlobs: ["**/.env*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.git/**"],
    maxBytes: 40_000,
  },
  done: { enabled: true, timeoutMs: 2500, verifySweepClaims: false },
  rank: { enabled: true, timeoutMs: 4000, maxCandidates: 400 },
  debug: false,
};

function readConfigFile(): Partial<Config> {
  const path = process.env.JEV_CONFIG_PATH ?? join(homedir(), ".jev", "config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch {
    // A missing or unreadable config file is normal, not an error.
    return {};
  }
}

function mergeCapability<T extends CapabilityConfig>(base: T, override: Partial<T> | undefined): T {
  return { ...base, ...(override ?? {}) };
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const file = readConfigFile();

  cached = {
    apiKey: process.env.TYPESAFE_API_KEY ?? (file as { apiKey?: string }).apiKey,
    model: process.env.JEV_MODEL ?? file.model ?? DEFAULTS.model,
    guard: mergeCapability(DEFAULTS.guard, file.guard),
    screen: {
      ...mergeCapability(DEFAULTS.screen, file.screen),
      mode: (process.env.JEV_SCREEN_MODE as Config["screen"]["mode"]) ?? file.screen?.mode ?? DEFAULTS.screen.mode,
    },
    done: {
      ...mergeCapability(DEFAULTS.done, file.done),
      verifySweepClaims:
        process.env.JEV_VERIFY_SWEEPS === "1" ||
        file.done?.verifySweepClaims === true ||
        DEFAULTS.done.verifySweepClaims,
    },
    rank: mergeCapability(DEFAULTS.rank, file.rank),
    debug: process.env.JEV_DEBUG === "1" || file.debug === true,
  };
  return cached;
}

/** Test seam. */
export function resetConfigCache(): void {
  cached = undefined;
}
