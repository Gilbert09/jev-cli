import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ask } from "../../core/jev.js";
import type { QuestionMap } from "../../core/jev.js";
import { prepare } from "../../core/redact.js";
import type { Answer, HandlerResult, PreToolUsePayload } from "../../core/types.js";
import { decideGuard, failClosed, type GuardContext, type GuardTool } from "./decide.js";
import { bashQuestions, fileQuestions, THRESHOLDS } from "./questions.js";

/**
 * PreToolUse gate.
 *
 * Thin by design: assemble the state, ask, hand the answers to the pure
 * decision. Everything that decides anything lives in `decide.ts`, so this file
 * has no branch that a test cannot reach.
 */

// Codex names its file-edit tool `apply_patch`. It is aliased to Write/Edit for
// MATCHER purposes, but the `tool_name` that arrives on stdin is the real one,
// so it has to be guarded explicitly or edits go completely unscored there.
const GUARDED: readonly string[] = ["Bash", "Write", "Edit", "apply_patch"];

/** Nearest ancestor holding a `.git`, else the cwd. Anchors "inside the project". */
function repoRootFor(cwd: string): string {
  let dir = cwd;
  for (let i = 0; i < 40; i += 1) {
    try {
      if (existsSync(resolve(dir, ".git"))) return dir;
    } catch {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/** Paths named in a patch header, so the model can see what it touches. */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface Plan {
  state: Record<string, unknown>;
  questions: QuestionMap;
  ctx: GuardContext;
}

function planFor(payload: PreToolUsePayload, tool: GuardTool): Plan | undefined {
  const cwd = payload.cwd || process.cwd();
  const repoRoot = repoRootFor(cwd);

  if (tool === "Bash") {
    const command = str(payload.tool_input, "command");
    if (!command) return undefined;
    return {
      state: {
        tool: "Bash",
        command: prepare(command, THRESHOLDS.previewBytes).text,
        description: str(payload.tool_input, "description"),
        cwd,
        repoRoot,
      },
      questions: bashQuestions(),
      ctx: { tool, subject: command },
    };
  }

  // Codex's apply_patch carries the whole patch as `command`, not the
  // {file_path, old_string, new_string} triple Claude Code sends. Judging the
  // patch body directly is the honest read: it is what will actually be
  // applied, and the paths it touches are in its header.
  if (tool === "apply_patch") {
    const patch = str(payload.tool_input, "command");
    if (!patch) return undefined;
    return {
      state: {
        patch: prepare(patch, THRESHOLDS.previewBytes).text,
        paths: patchPaths(patch),
        cwd,
        repoRoot,
      },
      questions: bashQuestions(),
      ctx: { tool, subject: patchPaths(patch).join(", ") || "patch" },
    };
  }

  const path = str(payload.tool_input, "file_path");
  if (!path) return undefined;
  // Resolve relative paths against the cwd so the model compares like with
  // like when it judges whether the write escapes `repoRoot`.
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const preview =
    tool === "Write"
      ? { content: prepare(str(payload.tool_input, "content") ?? "", THRESHOLDS.previewBytes).text }
      : {
          replaces: prepare(str(payload.tool_input, "old_string") ?? "", THRESHOLDS.previewBytes)
            .text,
          with: prepare(str(payload.tool_input, "new_string") ?? "", THRESHOLDS.previewBytes).text,
        };

  return {
    state: {
      tool,
      path: absolute,
      // Write replaces a whole file; Edit swaps one region. `destroysContent`
      // cannot be answered without knowing which.
      writeMode: tool === "Write" ? "replaces the entire file" : "replaces one region of the file",
      preview,
      cwd,
      repoRoot,
    },
    questions: fileQuestions(),
    ctx: { tool, subject: absolute },
  };
}

export async function guard(payload: PreToolUsePayload): Promise<HandlerResult> {
  if (!GUARDED.includes(payload.tool_name)) return { kind: "none" };
  const tool = payload.tool_name as GuardTool;

  const plan = planFor(payload, tool);
  if (!plan) {
    return failClosed(
      { type: "malformed", message: `${tool} call had no command or file_path` },
      { tool, subject: payload.tool_name },
    );
  }

  const result = await ask<Record<string, Answer>>({
    capability: "guard",
    state: plan.state,
    questions: plan.questions,
  });

  if (!result.ok) return failClosed(result.error, plan.ctx);
  return decideGuard(result.answers, plan.ctx);
}
