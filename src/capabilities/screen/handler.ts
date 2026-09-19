import { loadConfig } from "../../core/config.js";
import { ask } from "../../core/jev.js";
import { prepare } from "../../core/redact.js";
import type { Answer, HandlerResult, PostToolUsePayload } from "../../core/types.js";
import { decideScreen, type ScreenContext } from "./decide.js";
import { QUESTIONS, THRESHOLDS, type ScreenState } from "./questions.js";

/**
 * `jev screen` — PostToolUse prompt-injection screening.
 *
 * Runs on every fetch, read, and command output, which forces two properties:
 *   - it must be cheap, so anything trivially small is never sent;
 *   - it must fail open and silent, so a screening failure can never cost the
 *     user their turn. Every early return below is `{kind: "none"}`.
 *
 * It warns, it never blocks. False positives are possible on security
 * documentation and on legitimate agent instructions, and a warning the user
 * can ignore is the only proportionate response to that.
 */

/** Longest origin string we will send. Paths and URLs are context, not content. */
const MAX_ORIGIN_BYTES = 500;

interface Extracted {
  content: string;
  /** URL, path, or command. */
  origin: string;
  /** Phrase used in the state and in the warning: "the web page", "the file". */
  source: string;
  /** Paths to test against `excludeGlobs`. Empty for content with no path. */
  paths: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pull text out of a tool result. The concrete shape differs per tool and has
 * changed across Claude Code versions, so this walks the usual containers
 * rather than assuming one.
 */
function collectText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => collectText(v, depth + 1))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const keys = ["text", "content", "result", "output", "stdout", "stderr", "file", "body", "data"];
    return keys
      .filter((k) => k in o)
      .map((k) => collectText(o[k], depth + 1))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Decide what, if anything, of this tool call is untrusted content entering the
 * agent's context. Tools not listed here are not screened at all.
 */
export function extractContent(payload: PostToolUsePayload): Extracted | undefined {
  const input = payload.tool_input ?? {};
  // `tool_response` is what Claude Code actually sends; `tool_output` is kept
  // only so hand-written payloads in older tests still resolve.
  const output = payload.tool_response ?? payload.tool_output;

  switch (payload.tool_name) {
    case "WebFetch": {
      const url = str(input.url) ?? "an unknown URL";
      return { content: collectText(output), origin: url, source: "the web page", paths: [url] };
    }
    case "WebSearch": {
      const query = str(input.query) ?? "a web search";
      return { content: collectText(output), origin: query, source: "the web search results", paths: [] };
    }
    case "Read":
    case "NotebookRead": {
      const path = str(input.file_path) ?? str(input.notebook_path) ?? "an unknown file";
      return { content: collectText(output), origin: path, source: "the file", paths: [path] };
    }
    case "Bash": {
      const command = str(input.command) ?? "a shell command";
      return {
        content: collectText(output),
        origin: command,
        source: "the command output",
        // A command has no single path, so every path-shaped argument is
        // checked: `cat ~/.env` must be excluded just like reading it would be.
        paths: commandPaths(command),
      };
    }
    default:
      return undefined;
  }
}

/** Path-shaped arguments of a shell command, for exclusion checking. */
export function commandPaths(command: string): string[] {
  return command
    .split(/[\s;|&<>()"'`]+/)
    .filter((t) => t.length > 1 && !t.startsWith("-") && /[/.]/.test(t));
}

/**
 * Minimal glob matcher: `**`, `*`, `?`. No dependency, and the config only ever
 * holds simple path patterns.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(normalized);
}

/** True when any candidate path matches any configured exclusion. */
export function isExcluded(paths: readonly string[], globs: readonly string[]): boolean {
  return paths.some((p) => globs.some((g) => matchesGlob(p, g)));
}

export async function screen(payload: PostToolUsePayload): Promise<HandlerResult> {
  const none: HandlerResult = { kind: "none" };

  const extracted = extractContent(payload);
  if (!extracted) return none;

  const config = loadConfig();

  // Never send content from an excluded path. This is checked before anything
  // is prepared, so excluded content is not even held in a second buffer.
  if (isExcluded(extracted.paths, config.screen.excludeGlobs)) return none;

  const raw = extracted.content.trim();
  if (Buffer.byteLength(raw, "utf8") < THRESHOLDS.minContentBytes) return none;

  // Untrusted content NEVER reaches `ask` unprepared.
  const { text, truncated } = prepare(raw, config.screen.maxBytes);
  const origin = prepare(extracted.origin, MAX_ORIGIN_BYTES).text;

  const state: ScreenState = {
    source: extracted.source,
    origin,
    content: text,
    truncated,
  };

  const result = await ask<Record<string, Answer>>({
    capability: "screen",
    state,
    questions: QUESTIONS,
  });

  // THE INVARIANT: any failure at all is silent. No warning, no noise, no
  // broken turn — screening is an enhancement, never a dependency.
  if (!result.ok) return none;

  const context: ScreenContext = { source: extracted.source, origin, truncated };
  return decideScreen(result.answers, context);
}
