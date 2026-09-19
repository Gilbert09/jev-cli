import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPayload, serialize } from "../../src/core/hook.js";

describe("serialize", () => {
  it("emits nothing for a no-op, so the normal permission flow applies", () => {
    expect(serialize({ kind: "none" })).toBeUndefined();
  });

  it("shapes a PreToolUse decision exactly as the hook contract requires", () => {
    const out = JSON.parse(
      serialize({
        kind: "preToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "destroys data outside the project",
      })!,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "destroys data outside the project",
      },
    });
  });

  it("omits optional fields rather than sending empty strings", () => {
    const out = JSON.parse(serialize({ kind: "postToolUse" })!);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PostToolUse" });
  });

  it("carries additionalContext on PostToolUse when there is something to say", () => {
    const out = JSON.parse(
      serialize({ kind: "postToolUse", additionalContext: "untrusted content" })!,
    );
    expect(out.hookSpecificOutput.additionalContext).toBe("untrusted content");
  });

  it("shapes a Stop block exactly as the hook reference documents", () => {
    // Verified against the Claude Code hook reference, which states: "`\"block\"`
    // prevents Claude from stopping" and "`reason` is required when `decision` is
    // `\"block\"`". Both fields are TOP-LEVEL, not inside `hookSpecificOutput`,
    // and "block" is the only value `decision` accepts.
    //
    // An earlier version emitted `hookSpecificOutput.decision = "continue"`, which
    // Claude Code silently ignores — every intervention was a no-op, and no test
    // caught it because the tests asserted our own invented shape. Hence this one.
    const out = JSON.parse(serialize({ kind: "blockStop", reason: "tests were never run" })!);
    expect(out).toEqual({ decision: "block", reason: "tests were never run" });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("allows a stop by emitting nothing at all", () => {
    // Omitting `decision` is how the contract expresses "let Claude stop".
    expect(serialize({ kind: "none" })).toBeUndefined();
  });
});

describe("readPayload", () => {
  it("parses a hook payload from stdin", async () => {
    const payload = {
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const parsed = await readPayload(Readable.from([JSON.stringify(payload)]));
    expect(parsed).toEqual(payload);
  });

  it("rejects empty stdin so the caller can apply its safe default", async () => {
    await expect(readPayload(Readable.from([""]))).rejects.toThrow(/no hook payload/);
  });

  it("rejects malformed JSON", async () => {
    await expect(readPayload(Readable.from(["{not json"]))).rejects.toThrow();
  });
});
