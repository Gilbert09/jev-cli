import { emit, readPayload } from "./core/hook.js";
import { loadConfig } from "./core/config.js";
import { debug } from "./core/log.js";
import type { HandlerResult, HookPayload } from "./core/types.js";

import { guard } from "./capabilities/guard/handler.js";
import { screen } from "./capabilities/screen/handler.js";
import { done } from "./capabilities/done/handler.js";

/**
 * Subcommand dispatch for the hook binary.
 *
 * Invariants every capability inherits from here:
 *   1. We always exit 0 and communicate through JSON on stdout.
 *   2. A crash, hang, or unhandled rejection still produces the capability's
 *      documented safe default — never silence where silence means "allow".
 *   3. Nothing is ever written to stdout except the single result object.
 */

export type Handler = (payload: HookPayload) => Promise<HandlerResult>;

interface Subcommand {
  run: Handler;
  /**
   * What to emit when the handler itself fails. `guard` fails CLOSED (ask the
   * human); everything else fails OPEN, because a broken judge must not be able
   * to break the user's turn.
   */
  safeDefault: (reason: string) => HandlerResult;
  /** Hard ceiling on the whole invocation, including process overhead. */
  budgetMs: number;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  guard: {
    run: guard as Handler,
    safeDefault: (reason) => ({
      kind: "preToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: `jev could not evaluate this command (${reason}) — asking you instead`,
    }),
    budgetMs: 3000,
  },
  screen: {
    run: screen as Handler,
    safeDefault: () => ({ kind: "none" }),
    budgetMs: 3500,
  },
  done: {
    run: done as Handler,
    safeDefault: () => ({ kind: "none" }),
    budgetMs: 4000,
  },
};

function usage(): string {
  return [
    "jev — a Jev-powered judgement layer for Claude Code",
    "",
    "Hook subcommands (read a hook payload on stdin, write JSON on stdout):",
    "  jev guard     PreToolUse   semantic permission gating",
    "  jev screen    PostToolUse  prompt-injection screening",
    "  jev done      Stop         completion verification",
    "",
    "Other:",
    "  jev mcp       run the MCP server exposing the `rank` tool",
    "  jev doctor    check configuration and API connectivity",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || name === "--help" || name === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (name === "mcp") {
    const { serve } = await import("./capabilities/rank/server.js");
    await serve();
    return;
  }

  if (name === "doctor") {
    const { doctor } = await import("./doctor.js");
    process.exitCode = await doctor();
    return;
  }

  const sub = SUBCOMMANDS[name];
  if (!sub) {
    process.stderr.write(`jev: unknown subcommand "${name}"\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  let settled = false;
  const settle = (result: HandlerResult): void => {
    if (settled) return;
    settled = true;
    emit(result);
  };

  // Watchdog. The per-request timeout in jev.ts bounds the network call; this
  // bounds everything else (a wedged stdin read, a pathological payload).
  const watchdog = setTimeout(() => {
    debug(name, { watchdog: "fired", budgetMs: sub.budgetMs });
    settle(sub.safeDefault(`timed out after ${sub.budgetMs}ms`));
    process.exit(0);
  }, sub.budgetMs);
  watchdog.unref();

  try {
    const payload = await readPayload();
    settle(await sub.run(payload));
  } catch (err) {
    debug(name, { error: (err as Error)?.message });
    settle(sub.safeDefault((err as Error)?.message ?? "unexpected error"));
  } finally {
    clearTimeout(watchdog);
  }
}

// Load config eagerly so a malformed config file surfaces in debug output
// rather than midway through a decision.
loadConfig();

main().then(
  () => {
    process.exitCode ??= 0;
  },
  (err) => {
    // Truly unreachable in normal operation: main() catches its own errors.
    process.stderr.write(`jev: fatal: ${(err as Error)?.message ?? err}\n`);
    process.exitCode = 0;
  },
);
