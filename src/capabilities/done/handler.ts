import { loadConfig } from "../../core/config.js";
import { ask } from "../../core/jev.js";
import { prepare } from "../../core/redact.js";
import { readState, writeState } from "../../core/session-state.js";
import type { Answer, HandlerResult, StopPayload } from "../../core/types.js";
import { decideDone, failOpen, toSignals, turnKey } from "./decide.js";
import { limits, questions } from "./questions.js";
import { readTranscript } from "./transcript.js";

/**
 * `jev done` — the Stop hook.
 *
 * It catches the premature-completion failure mode: the agent reports success
 * while stubs remain, or reports a passing test suite it never ran.
 *
 * The two invariants:
 *
 *   1. FAIL OPEN. Every failure path returns `{kind: "none"}`. A broken judge
 *      must never be able to trap a user in a turn that will not end.
 *   2. AT MOST ONE INTERVENTION PER TURN. Enforced here, before the API call,
 *      so a second Stop in the same turn costs nothing and can only allow.
 */

/**
 * One field, holding the key of the turn we last blocked.
 *
 * Storing the key rather than a counter means a new turn resets the budget for
 * free: a different key simply does not match, so no expiry or cleanup logic
 * exists to get wrong.
 */
const STATE_FIELD = "done.lastBlockedTurn";

export function hasIntervened(sessionId: string, key: string): boolean {
  return readState(sessionId)[STATE_FIELD] === key;
}

export function recordIntervention(sessionId: string, key: string): void {
  // Best effort by design. `session-state` swallows write errors; if the store
  // is unwritable we fall back to the first-pass behaviour and may intervene
  // again on the next Stop. That is the documented core trade-off.
  writeState(sessionId, { [STATE_FIELD]: key });
}

export async function done(payload: StopPayload): Promise<HandlerResult> {
  try {
    const message = (payload.last_assistant_message ?? "").trim();
    // Nothing was said, so there is no claim to check.
    if (message.length === 0) return { kind: "none" };

    const transcript = readTranscript(payload.transcript_path);
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const key = turnKey(payload.prompt_id, transcript.originalRequest);

    // INVARIANT 2, applied before the round trip.
    if (hasIntervened(sessionId, key)) return { kind: "none" };

    const prepared = prepare(message, limits.messageBytes);
    const result = await ask<Record<string, Answer>>({
      capability: "done",
      // `commandsRun` is deliberately NOT sent. No question needs it: every
      // question is a single-field read, and the message-to-commands
      // correlation is done in code by `verification.ts` after the answers
      // come back. Leaving the command list out of view removes the
      // invitation for the model to attempt that correlation itself.
      state: {
        message: prepared.text,
        messageTruncated: prepared.truncated,
        originalRequest: transcript.originalRequest,
      },
      questions,
    });

    // INVARIANT 1.
    if (!result.ok) return failOpen(result.error);

    const decision = decideDone(toSignals(result.answers), {
      alreadyIntervened: false,
      transcriptAvailable: transcript.available,
      originalRequest: transcript.originalRequest,
      commandsRun: transcript.commandsRun,
      verifySweepClaims: loadConfig().done.verifySweepClaims,
    });

    if (decision.kind === "blockStop") recordIntervention(sessionId, key);
    return decision;
  } catch {
    // Belt and braces over INVARIANT 1: `ask` does not throw and the transcript
    // reader does not throw, but a malformed payload still must not block.
    return { kind: "none" };
  }
}
