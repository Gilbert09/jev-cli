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

/**
 * Defaults follow the measurement, not the build order.
 *
 * Across 1,176 benchmark sessions on haiku:
 *
 *   guard    +29 pts   cost  +9%    <- on
 *   screen   +33 pts   cost -26%    <- on (it is cheaper AND better: an agent
 *                                        that ignores an injection does not
 *                                        follow it down a rabbit hole, saving
 *                                        3.3 turns per session)
 *   done      +3 pts   cost  +8%    <- off, p=0.593
 *   rank      +1 pt    cost  +6%    <- off, p=0.865, and never called unless
 *                                        driven directly: 0 adoptions in 18
 *                                        sessions where it was connected
 *
 * `done` and `rank` ship off because charging users 6-8% for an effect
 * indistinguishable from zero is not a default anyone would choose knowing the
 * numbers. Both are one config line away for anyone who wants them.
 */
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
  done: { enabled: false, timeoutMs: 2500, verifySweepClaims: false },
  rank: { enabled: false, timeoutMs: 4000, maxCandidates: 400 },
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

  // The fixture suites measure whether the QUESTIONS are worded well, which is
  // independent of whether a capability ships switched on. Without this, turning
  // `done` and `rank` off by default would silently stop testing them — the
  // suite would report 0/21 and read as a catastrophic regression rather than
  // "this capability is disabled".
  const forceEnabled = process.env.JEV_FORCE_ENABLED === "1";

  cached = {
    // When installed as a Claude Code plugin, the key declared in
    // plugin.json's `userConfig` arrives as CLAUDE_PLUGIN_OPTION_<KEY>. Checked
    // first so a plugin install works with no environment setup at all, then
    // the plain env var, then the config file.
    apiKey:
      process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY ??
      process.env.TYPESAFE_API_KEY ??
      (file as { apiKey?: string }).apiKey,
    model: process.env.JEV_MODEL ?? file.model ?? DEFAULTS.model,
    guard: { ...mergeCapability(DEFAULTS.guard, file.guard), enabled: forceEnabled || mergeCapability(DEFAULTS.guard, file.guard).enabled },
    screen: {
      ...mergeCapability(DEFAULTS.screen, file.screen),
      enabled: forceEnabled || mergeCapability(DEFAULTS.screen, file.screen).enabled,
      mode: (process.env.JEV_SCREEN_MODE as Config["screen"]["mode"]) ?? file.screen?.mode ?? DEFAULTS.screen.mode,
    },
    done: {
      ...mergeCapability(DEFAULTS.done, file.done),
      enabled: forceEnabled || mergeCapability(DEFAULTS.done, file.done).enabled,
      verifySweepClaims:
        process.env.JEV_VERIFY_SWEEPS === "1" ||
        file.done?.verifySweepClaims === true ||
        DEFAULTS.done.verifySweepClaims,
    },
    rank: { ...mergeCapability(DEFAULTS.rank, file.rank), enabled: forceEnabled || mergeCapability(DEFAULTS.rank, file.rank).enabled },
    debug: process.env.JEV_DEBUG === "1" || file.debug === true,
  };
  return cached;
}

/** Test seam. */
export function resetConfigCache(): void {
  cached = undefined;
}
