import type { HandlerResult, HookPayload } from "./types.js";

/**
 * Hook I/O contract.
 *
 * We always exit 0 and print structured JSON. The hook docs are explicit that
 * exit-2 blocking and JSON output are two different mechanisms and must not be
 * mixed, so this module only ever does the latter.
 */

export async function readPayload(stream: NodeJS.ReadableStream = process.stdin): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("no hook payload on stdin");
  return JSON.parse(text) as HookPayload;
}

/** Serialise a handler result into the exact shape Claude Code expects. */
export function serialize(result: HandlerResult): string | undefined {
  switch (result.kind) {
    case "none":
      return undefined;

    case "preToolUse":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: result.permissionDecision,
          permissionDecisionReason: result.permissionDecisionReason,
          ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
        },
      });

    case "postToolUse":
      return JSON.stringify({
        // `decision`/`reason` are TOP-LEVEL for PostToolUse, the same shape as
        // Stop: "the only value for `decision` is `block`". `updatedToolOutput`
        // and `additionalContext` live inside hookSpecificOutput.
        ...(result.decision ? { decision: result.decision, reason: result.reason ?? "" } : {}),
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
          ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
          ...(result.updatedToolOutput !== undefined ? { updatedToolOutput: result.updatedToolOutput } : {}),
        },
      });

    case "blockStop":
      // Top-level `decision`, not `hookSpecificOutput`. `reason` is what Claude
      // reads as its instruction to keep working.
      return JSON.stringify({ decision: "block", reason: result.reason });
  }
}

export function emit(result: HandlerResult): void {
  const payload = serialize(result);
  if (payload) process.stdout.write(payload + "\n");
}
