import { loadConfig } from "./config.js";

/**
 * Diagnostics go to stderr only. Claude Code logs stderr rather than feeding
 * it to the model (except on a blocking exit, which we never use), so this is
 * safe to leave on.
 */
export function debug(scope: string, data: unknown): void {
  if (!loadConfig().debug) return;
  try {
    process.stderr.write(`[jev:${scope}] ${JSON.stringify(data)}\n`);
  } catch {
    process.stderr.write(`[jev:${scope}] <unserialisable>\n`);
  }
}
