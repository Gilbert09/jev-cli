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

describe("codex output vocabulary", () => {
  // Codex ships a deliberately Claude-Code-compatible hook engine, but its
  // output parser is stricter (`codex-rs/hooks/src/engine/output_parser.rs`):
  // `permissionDecision` may be "deny", or "allow" only when paired with
  // `updatedInput`. A bare "allow" is rejected and "ask" is rejected outright.
  //
  // Sending Claude-shaped output at Codex would therefore log a failed hook on
  // every allow and every ask — the guard would be silently inert, which is
  // exactly how two capabilities in this project already shipped broken.
  const pre = (permissionDecision: string) =>
    ({ kind: "preToolUse", permissionDecision, permissionDecisionReason: "because" }) as never;

  it("passes a deny through unchanged", () => {
    const out = JSON.parse(serialize(pre("deny"), "codex") as string);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("never emits a bare allow, which Codex rejects", () => {
    // Silence defers to Codex's own approval policy. We raise the user's
    // configured safety level, never lower it.
    expect(serialize(pre("allow"), "codex")).toBeUndefined();
  });

  it("converts ask to deny, because Codex has no way to prompt", () => {
    // guard's invariant is that it fails CLOSED. Deny is the only closed
    // option Codex offers, so uncertainty blocks rather than passes.
    const out = JSON.parse(serialize(pre("ask"), "codex") as string);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("says a converted ask was uncertainty, not a known hazard", () => {
    // The distinction matters to whoever reads the block: one means "this is
    // dangerous", the other means "I could not tell". Collapsing them would
    // make every uncertain verdict look like an accusation.
    const out = JSON.parse(serialize(pre("ask"), "codex") as string);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not be judged safe/);
  });

  it("lets JEV_CODEX_ASK=pass defer uncertainty to Codex instead", () => {
    process.env.JEV_CODEX_ASK = "pass";
    try {
      expect(serialize(pre("ask"), "codex")).toBeUndefined();
      // A real hazard is still blocked; the escape hatch only softens ask.
      expect(serialize(pre("deny"), "codex")).toBeDefined();
    } finally {
      delete process.env.JEV_CODEX_ASK;
    }
  });

  it("leaves the claude vocabulary alone", () => {
    for (const d of ["allow", "ask", "deny"]) {
      const out = JSON.parse(serialize(pre(d), "claude") as string);
      expect(out.hookSpecificOutput.permissionDecision).toBe(d);
    }
  });
});

describe("codex PostToolUse wire shape", () => {
  // Codex's PostToolUse wire uses `deny_unknown_fields` and permits only
  // `hookEventName`, `additionalContext`, and `updatedMCPToolOutput` inside
  // `hookSpecificOutput` — and rejects `updatedMCPToolOutput` anyway.
  //
  // Our Claude shape nests `systemMessage` and `updatedToolOutput` there. On
  // Codex that fails the WHOLE parse, so screen would emit nothing usable and
  // be silently inert — the same failure that already shipped twice here.
  const ALLOWED = ["hookEventName", "additionalContext"];
  const post = (extra: Record<string, unknown>) =>
    ({ kind: "postToolUse", additionalContext: "untrusted", ...extra }) as never;

  it("never nests a key Codex would reject", () => {
    for (const extra of [{}, { systemMessage: "m" }, { updatedToolOutput: "q" }, { decision: "block", reason: "r" }]) {
      const out = JSON.parse(serialize(post(extra), "codex") as string);
      expect(Object.keys(out.hookSpecificOutput).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    }
  });

  it("lifts systemMessage to the top level, where Codex expects it", () => {
    const out = JSON.parse(serialize(post({ systemMessage: "heads up" }), "codex") as string);
    expect(out.systemMessage).toBe("heads up");
    expect(out.hookSpecificOutput.systemMessage).toBeUndefined();
  });

  it("degrades quarantine to a block, since Codex cannot replace shell output", () => {
    // There is no supported way to rewrite a Bash tool_response. Silently
    // dropping the quarantine would leave the injected text in context with no
    // warning at all, so it becomes the strongest thing Codex does support.
    const out = JSON.parse(serialize(post({ updatedToolOutput: "[removed]" }), "codex") as string);
    expect(out.decision).toBe("block");
    expect(out.reason).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain("updatedToolOutput");
  });

  it("still nests them for claude, which is where they belong", () => {
    const out = JSON.parse(serialize(post({ systemMessage: "m", updatedToolOutput: "q" }), "claude") as string);
    expect(out.hookSpecificOutput.systemMessage).toBe("m");
    expect(out.hookSpecificOutput.updatedToolOutput).toBe("q");
  });
});
