import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";

/** Where the hook command lives, resolved from this file rather than cwd. */
function binPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jev.mjs");
}

type Scope = "user" | "project";
type Target = "claude" | "codex";

function settingsPath(scope: Scope, target: Target): string {
  // Codex keeps hooks in their own file rather than inside a settings blob.
  if (target === "codex") {
    return scope === "user"
      ? join(homedir(), ".codex", "hooks.json")
      : join(process.cwd(), ".codex", "hooks.json");
  }
  return scope === "user"
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or move it, then run install again.`);
  }
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

function jevHooks(bin: string, target: Target): Record<string, HookEntry[]> {
  // `--host=codex` switches the output vocabulary. Codex rejects "ask" and a
  // bare "allow", so the same decision has to be spelled differently or every
  // non-deny verdict is logged as a failed hook.
  const suffix = target === "codex" ? " --host=codex" : "";
  const cmd = (sub: string) => `node ${JSON.stringify(bin)} ${sub}${suffix}`;
  return {
    PreToolUse: [{ matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: cmd("guard"), timeout: 10 }] }],
    PostToolUse: [{ matcher: "WebFetch|Read|Bash", hooks: [{ type: "command", command: cmd("screen"), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: cmd("done"), timeout: 15 }] }],
  };
}

/** True when this entry is one of ours, so re-installing replaces rather than duplicates. */
function isJevEntry(entry: HookEntry): boolean {
  return entry.hooks?.some((h) => /jev\.mjs/.test(h.command ?? "")) ?? false;
}

/**
 * Merge our hooks into the user's settings without disturbing theirs.
 *
 * Their hooks are other people's work and may be load-bearing; we only ever add
 * our own entries and replace our own previous ones. A settings file is not
 * ours to rewrite.
 */
function mergeHooks(settings: Record<string, unknown>, bin: string, target: Target): void {
  const existing = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const ours = jevHooks(bin, target);
  for (const [event, entries] of Object.entries(ours)) {
    const keep = (existing[event] ?? []).filter((e) => !isJevEntry(e));
    existing[event] = [...keep, ...entries];
  }
  settings.hooks = existing;
}

export async function install(argv: string[]): Promise<number> {
  const out = (s = "") => process.stdout.write(s + "\n");
  const scope: Scope = argv.includes("--project") ? "project" : "user";
  const target: Target = argv.includes("--codex") ? "codex" : "claude";
  const dryRun = argv.includes("--dry-run");
  const bin = binPath();

  out(`jev install (${target})`);

  if (!existsSync(bin)) {
    out(`  FAILED: ${bin} is missing. Run \`npm run build\` first.`);
    return 1;
  }

  const path = settingsPath(scope, target);
  out(`  target           ${path}`);
  out(`  hook command     node ${bin} <capability>${target === "codex" ? " --host=codex" : ""}`);

  let settings: Record<string, unknown>;
  try {
    settings = readJson(path);
  } catch (err) {
    out(`  FAILED: ${(err as Error).message}`);
    return 1;
  }

  mergeHooks(settings, bin, target);

  if (dryRun) {
    out();
    out("  --dry-run, nothing written. Settings would become:");
    out(JSON.stringify({ hooks: settings.hooks }, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  out("  hooks            written (guard, screen, done)");

  const config = loadConfig();
  if (!config.apiKey) {
    out();
    out("  NOTE: no API key found, so every guarded call will prompt for approval.");
    out("  Set TYPESAFE_API_KEY, or add \"apiKey\" to ~/.jev/config.json, then run `jev doctor`.");
    return 0;
  }

  return verify(bin, out, target);
}

/**
 * Prove the hooks actually fire.
 *
 * Config being written is not evidence that anything works. Two capabilities in
 * this project shipped 100% inert — `done` emitted a decision value the Stop
 * contract does not accept, and `screen` read a payload field Claude Code does
 * not send — while 462 unit tests and 157 live fixture cases passed, because
 * every test built its payload the same wrong way. The only check that would
 * have caught either is this one: feed the real binary a real payload and
 * require a real decision back.
 */
async function verify(bin: string, out: (s?: string) => void, target: Target): Promise<number> {
  out();
  out("  verifying hooks actually fire...");

  const payload = JSON.stringify({
    session_id: "jev-install-check",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  });

  const args = target === "codex" ? [bin, "guard", "--host=codex"] : [bin, "guard"];
  const res = spawnSync("node", args, { input: payload, encoding: "utf8", timeout: 20_000 });
  if (res.status !== 0) {
    out(`  FAILED: guard exited ${res.status}. ${(res.stderr ?? "").slice(0, 200)}`);
    return 1;
  }

  let decision: string | undefined;
  try {
    decision = JSON.parse(res.stdout || "{}")?.hookSpecificOutput?.permissionDecision;
  } catch {
    out(`  FAILED: guard did not emit JSON. Got: ${res.stdout.slice(0, 200)}`);
    return 1;
  }

  // `rm -rf /` must not be allowed. Either deny or ask proves the round trip —
  // binary, API key, question set, and wire format all work.
  if (decision !== "deny" && decision !== "ask") {
    out(`  FAILED: guard returned "${decision}" for \`rm -rf /\`. Expected deny or ask.`);
    return 1;
  }

  out(`  guard            ${decision} on \`rm -rf /\`  — hooks are live`);
  out();
  out(`  Done. Restart ${target === "codex" ? "Codex" : "Claude Code"} to load the hooks.`);
  if (target === "codex") {
    out();
    // Writing the config is not the last step on Codex, and a half-finished
    // install is indistinguishable from a working one until something
    // destructive gets through.
    out("  ONE MORE STEP — run `/hooks` in Codex and trust these hooks.");
    out("  Codex records trust against the hook definition's hash and SKIPS");
    out("  untrusted hooks silently, so until you do this jev is not running.");
    out("  A jev upgrade changes the hash and needs trusting again.");
    out();
    out("  Note: Codex has no \"ask\" verdict, so anything jev cannot judge safe is");
    out("  blocked rather than prompted. Set JEV_CODEX_ASK=pass to defer those to");
    out("  Codex's own approval policy instead.");
  }
  return 0;
}
