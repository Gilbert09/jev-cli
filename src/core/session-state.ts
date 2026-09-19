import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tiny per-session scratch store.
 *
 * `done` needs it to enforce "intervene at most once per turn" — without that,
 * a disagreement between Jev and the model could trap the user in a loop where
 * the turn never ends. State is keyed by session so concurrent sessions do not
 * interfere.
 */

function stateFile(sessionId: string): string {
  const base =
    process.env.JEV_STATE_DIR ??
    (process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "state") : undefined) ??
    join(homedir(), ".jev", "state");
  try {
    mkdirSync(base, { recursive: true });
    return join(base, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
  } catch {
    return join(tmpdir(), `jev-${sessionId.replace(/[^\w-]/g, "_")}.json`);
  }
}

export function readState(sessionId: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeState(sessionId: string, patch: Record<string, unknown>): void {
  try {
    const next = { ...readState(sessionId), ...patch };
    writeFileSync(stateFile(sessionId), JSON.stringify(next), "utf8");
  } catch {
    // Best effort. Losing state degrades to "intervene again", which is the
    // behaviour we already accept on the first pass.
  }
}
