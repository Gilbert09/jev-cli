/**
 * Shared types for the jev judgement layer.
 *
 * Capability handlers depend on this module and on nothing else in core except
 * `jev.ts`, `decide.ts`, and `redact.ts`. Keep it free of runtime behaviour.
 */

/** Fields present on every Claude Code hook payload. */
export interface HookCommon {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  transcript_path?: string;
}

export interface PreToolUsePayload extends HookCommon {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PostToolUsePayload extends HookCommon {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: unknown;
  tool_use_id?: string;
}

export interface StopPayload extends HookCommon {
  hook_event_name: "Stop";
  last_assistant_message?: string;
  prompt_id?: string;
}

export type HookPayload = PreToolUsePayload | PostToolUsePayload | StopPayload;

/**
 * What a handler returns. `cli.ts` serialises this to the exact
 * `hookSpecificOutput` shape Claude Code expects and prints it on stdout.
 *
 * A handler NEVER writes to stdout itself and NEVER calls process.exit.
 * We always exit 0 with structured JSON — mixing exit-2 blocking with JSON
 * output is explicitly undefined behaviour in the hook docs.
 */
export type HandlerResult =
  | { kind: "none" }
  | {
      kind: "preToolUse";
      permissionDecision: "allow" | "deny" | "ask";
      permissionDecisionReason: string;
      additionalContext?: string;
    }
  | { kind: "postToolUse"; additionalContext?: string; systemMessage?: string }
  /**
   * Block a Stop. Per the hook reference, `"block"` is the ONLY value `decision`
   * accepts, it is TOP-LEVEL (not inside `hookSpecificOutput`), and `reason` is
   * required with it. To allow the stop you emit nothing at all — which is what
   * `{kind: "none"}` does.
   */
  | { kind: "blockStop"; reason: string };

/**
 * A Jev answer, normalised across the three primitive types.
 *
 * These shapes deliberately differ from the raw SDK responses, because the raw
 * responses have two sharp edges:
 *
 *   1. `NoulResponse` carries NO `confidence` field — only `choice` and `score`
 *      answers do. We derive one (see `noulConfidence`) so every capability can
 *      apply a uniform confidence gate.
 *   2. Score rubrics are indexed FROM ZERO, and `score` is an *expected* value
 *      that may fall between integer levels (e.g. 2.4). Treating it as a 1-based
 *      integer silently mis-gates.
 */
export interface NoulAnswer {
  type: "noul";
  /** Probability the proposition is true, 0..1. */
  noul: number;
  /**
   * Derived, not reported by the API: how far the probability sits from a coin
   * flip, rescaled to 0..1. A noul of 0.95 or 0.05 is a confident answer; 0.5
   * is maximal uncertainty.
   */
  confidence: number;
}

export interface ChoiceAnswer<T extends string = string> {
  type: "choice";
  choice: T;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /**
   * Expected score on the rubric, ZERO-BASED, and possibly fractional — the
   * API returns an expectation over the level distribution, so a genuinely
   * ambiguous case lands between levels. Thresholds should be written against
   * this value (`score >= 2.5`), not against an integer equality.
   */
  score: number;
  /** Nearest integer level, 0-based. For display and coarse branching. */
  nearest: number;
  /** Number of levels in the rubric. Valid levels are 0..levels-1. */
  levels: number;
  /** Probability per level, keyed by the stringified level index. */
  probabilities: Record<string, number>;
  /** Rubric text per level, as echoed back by the API. */
  legend: Record<string, unknown>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Outcome of a Jev call. Never throws past the handler boundary. */
export type JevResult<T extends Record<string, Answer>> =
  | { ok: true; answers: T; cached: boolean; ms: number }
  | { ok: false; error: JevFailure; ms: number };

export type JevFailure =
  | { type: "no_api_key" }
  | { type: "timeout"; ms: number }
  | { type: "disabled" }
  | { type: "too_large"; bytes: number }
  | { type: "api_error"; status?: number; message: string }
  | { type: "malformed"; message: string };

export function describeFailure(f: JevFailure): string {
  switch (f.type) {
    case "no_api_key":
      return "no TYPESAFE_API_KEY configured";
    case "timeout":
      return `Jev timed out after ${f.ms}ms`;
    case "disabled":
      return "capability disabled by config";
    case "too_large":
      return `content too large to evaluate (${f.bytes} bytes)`;
    case "api_error":
      return `Jev API error${f.status ? ` (${f.status})` : ""}: ${f.message}`;
    case "malformed":
      return `unexpected Jev response: ${f.message}`;
  }
}
