import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { prepare } from "../../core/redact.js";
import { limits } from "./questions.js";

/**
 * Recovering evidence from the Claude Code transcript.
 *
 * `done` checks a claim against what actually happened, so it needs two things
 * the Stop payload does not carry: the user's request for this turn, and which
 * commands ran. Both live in the transcript JSONL file.
 *
 * Everything here is defensive. The file may be absent, empty, enormous,
 * half-written, or a shape no version of Claude Code ever produced. Every one
 * of those degrades to `available: false`, which `decide.ts` reads as "do not
 * use evidence-dependent signals" — never to a throw, and never to a wrong
 * conclusion drawn from a partial read.
 */

export type CommandStatus = "ok" | "failed" | "unknown";

export interface CommandRun {
  /** Tool name as recorded in the transcript, e.g. "Bash". */
  tool: string;
  /** The command or its most identifying argument. Redacted and bounded. */
  command: string;
  status: CommandStatus;
}

export interface TranscriptSummary {
  /** The user's request for this turn. Empty when it could not be recovered. */
  originalRequest: string;
  commandsRun: CommandRun[];
  /**
   * True only when at least one transcript entry parsed. False means we have
   * NO evidence, which is different from "evidence shows nothing happened".
   */
  available: boolean;
  /** True when the file was longer than the byte budget and we read the tail. */
  truncated: boolean;
}

export function emptySummary(truncated = false): TranscriptSummary {
  return { originalRequest: "", commandsRun: [], available: false, truncated };
}

/** Arguments worth reporting, in the order we prefer them. */
const IDENTIFYING_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "pattern",
  "path",
  "query",
  "url",
  "description",
] as const;

interface RawBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

interface RawEntry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { role?: unknown; content?: unknown } | unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this parsed line look like a transcript entry at all?
 *
 * Checked because `available` is load-bearing: it tells `decide.ts` whether
 * evidence exists. A file of well-formed JSON that is not a transcript must
 * report "no evidence", not "evidence showing nothing ran".
 */
function isEntry(value: unknown): value is RawEntry {
  if (!isObject(value)) return false;
  return typeof value.type === "string" || "message" in value;
}

function blocksOf(entry: RawEntry): RawBlock[] {
  const message = isObject(entry.message) ? entry.message : undefined;
  const content = message?.content;
  if (Array.isArray(content)) return content.filter(isObject) as RawBlock[];
  return [];
}

/** Plain text of a message, ignoring tool traffic. */
function textOf(entry: RawEntry): string {
  const message = isObject(entry.message) ? entry.message : undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((b) => (b as RawBlock).type === "text" && typeof (b as RawBlock).text === "string")
    .map((b) => (b as RawBlock).text as string)
    .join("\n")
    .trim();
}

/**
 * A user entry that is a real instruction — not a tool result echoed back, not
 * a system-injected caveat, and not traffic from a subagent's own thread.
 */
function isUserRequest(entry: RawEntry): boolean {
  if (entry.type !== "user") return false;
  if (entry.isMeta === true || entry.isSidechain === true) return false;
  if (blocksOf(entry).some((b) => b.type === "tool_result")) return false;
  return textOf(entry).length > 0;
}

function describeInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isObject(input)) return "";
  for (const key of IDENTIFYING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * Parse transcript text. Pure: no I/O, total over any input.
 *
 * Unparseable lines are skipped rather than fatal, because reading the tail of
 * a JSONL file almost always starts mid-line, and because a single corrupt
 * entry should not cost us the rest of the evidence.
 */
export function parseTranscript(text: string, truncated = false): TranscriptSummary {
  const entries: RawEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // Partial first line, or a corrupt record. Both are expected.
    }
  }

  if (entries.length === 0) return emptySummary(truncated);

  // Scope to the current turn: everything after the user's last instruction.
  let turnStart = 0;
  let request = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isUserRequest(entry)) {
      turnStart = i + 1;
      request = textOf(entry);
      break;
    }
  }

  // Preserve call order, then attach each result to its call.
  const byId = new Map<string, CommandRun>();
  const ordered: Array<{ id: string; run: CommandRun }> = [];

  for (let i = turnStart; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.isSidechain === true) continue;

    for (const block of blocksOf(entry)) {
      if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : `#${ordered.length}`;
        const run: CommandRun = {
          tool: typeof block.name === "string" ? block.name : "unknown",
          command: prepare(describeInput(block.input), limits.commandBytes).text,
          status: "unknown",
        };
        byId.set(id, run);
        ordered.push({ id, run });
      } else if (block.type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const run = byId.get(id);
        if (run) run.status = block.is_error === true ? "failed" : "ok";
      }
    }
  }

  // Keep the most recent calls: a long turn's tail is what the claim is about.
  const commandsRun = ordered.slice(-limits.maxCommands).map((o) => o.run);

  return {
    originalRequest: prepare(request, limits.requestBytes).text,
    commandsRun,
    available: true,
    truncated,
  };
}

/** Read at most `maxBytes` from the END of a file. */
function readTail(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { text: "", truncated: false };
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return { text: buffer.subarray(0, read).toString("utf8"), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** Read and summarise a transcript. Never throws. */
export function readTranscript(path: string | undefined): TranscriptSummary {
  if (typeof path !== "string" || path.length === 0) return emptySummary();
  try {
    const tail = readTail(path, limits.transcriptBytes);
    return parseTranscript(tail.text, tail.truncated);
  } catch {
    // Missing file, a directory, a permission error — all mean "no evidence".
    return emptySummary();
  }
}
