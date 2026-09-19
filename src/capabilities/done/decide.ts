import { explain, likely, noulFinding, type Finding } from "../../core/decide.js";
import type { Answer, HandlerResult, JevFailure, NoulAnswer } from "../../core/types.js";
import { thresholds, type NoulThreshold, type QuestionKey } from "./questions.js";
import type { CommandRun } from "./transcript.js";
import {
  changedFiles,
  ranNoCommand,
  ranNothingExecutable,
  unsupportedClaims,
  VERIFICATION_NOUNS,
  VERIFICATIONS,
  type Verification,
} from "./verification.js";

/**
 * The decision, as a pure function.
 *
 * Nothing here reads a file, calls the network, or awaits. Every branch —
 * including the two invariants — is reachable from a unit test with a literal
 * answer map.
 *
 * The shape of the capability is: deterministic code -> Jev judges -> typed
 * decisions -> deterministic code. Everything Jev returns is a single-field
 * read of the message. Every join between two pieces of state happens HERE,
 * or in `verification.ts`.
 */

/**
 * Answers, each optional.
 *
 * The API is asked for ten nouls, but a handler must not assume it got ten
 * nouls back. A missing or wrong-typed answer is treated as "signal absent",
 * which can only ever move the decision toward allowing the stop.
 */
export type DoneSignals = Partial<Record<QuestionKey, NoulAnswer>>;

export interface DoneContext {
  /** True when this turn already got one "keep working". INVARIANT 2. */
  alreadyIntervened: boolean;
  /** False when the transcript yielded no evidence at all. */
  transcriptAvailable: boolean;
  originalRequest: string;
  commandsRun: readonly CommandRun[];
}

const SIGNAL_KEYS: readonly QuestionKey[] = [
  "claimsComplete",
  "claimsTestsPassed",
  "claimsBuildPassed",
  "claimsTypecheckPassed",
  "claimsLintPassed",
  "vouchesForBehaviour",
  "leavesStubs",
  "namesUndoneWork",
  "leavesRequestUnaddressed",
  "explainsWhatIsMissing",
  "userLimitedScope",
];

/** Which answer key carries each verification claim. */
const CLAIM_KEYS: Record<Verification, QuestionKey> = {
  test: "claimsTestsPassed",
  build: "claimsBuildPassed",
  typecheck: "claimsTypecheckPassed",
  lint: "claimsLintPassed",
};

/** Narrow a raw answer map to the nouls we asked for, dropping anything else. */
export function toSignals(answers: Record<string, Answer | undefined>): DoneSignals {
  const signals: DoneSignals = {};
  for (const key of SIGNAL_KEYS) {
    const answer = answers[key];
    if (answer && answer.type === "noul" && Number.isFinite(answer.noul)) {
      signals[key] = answer;
    }
  }
  return signals;
}

/**
 * INVARIANT 1: fail open.
 *
 * Every `JevFailure` — no key, timeout, disabled, oversized, API error,
 * malformed response — allows the stop. A judge that cannot judge must not be
 * able to trap the user in a turn that will not end.
 */
export function failOpen(_failure: JevFailure): HandlerResult {
  return { kind: "none" };
}

/** FNV-1a. Not for security — only to make a request string a short key. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The key that scopes the once-per-turn budget. INVARIANT 2.
 *
 * It must be STABLE for the whole of one turn and DIFFERENT for the next one.
 * `prompt_id` is exactly that, so it is preferred. When it is missing we hash
 * the user's request instead: the request text does not change while a turn
 * runs (unlike, say, a command count, which grows as the agent works and would
 * silently hand the turn a fresh budget on every Stop — the infinite loop this
 * invariant exists to prevent).
 *
 * The final fallback is one constant key. With no way to tell turns apart, a
 * session gets one intervention in total. That errs toward allowing, which is
 * the safe direction.
 */
export function turnKey(promptId: string | undefined, originalRequest: string): string {
  if (typeof promptId === "string" && promptId.length > 0) return `p:${promptId}`;
  const request = originalRequest.trim();
  if (request.length > 0) return `r:${hash(request)}`;
  return "s:unidentified";
}

function fired(answer: NoulAnswer | undefined, threshold: NoulThreshold): boolean {
  return answer !== undefined && likely(answer, threshold.probability, threshold.minConfidence);
}

/**
 * Which passing results does `message` assert?
 *
 * Purely a read of the answer map. Whether each assertion is TRUE is a
 * separate, code-only question answered against `commandsRun`.
 */
export function claimedVerifications(signals: DoneSignals): Verification[] {
  return VERIFICATIONS.filter((kind) => {
    const key = CLAIM_KEYS[kind];
    return fired(signals[key], thresholds[key]);
  });
}

/** "the tests passed and the build succeeded" */
function listNouns(kinds: readonly Verification[]): string {
  const parts = kinds.map((k) => VERIFICATION_NOUNS[k]);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The strongest verification claim, used to cite one concrete probability. */
function strongestClaim(signals: DoneSignals, kinds: readonly Verification[]): NoulAnswer {
  let best: NoulAnswer | undefined;
  for (const kind of kinds) {
    const answer = signals[CLAIM_KEYS[kind]];
    if (answer && (best === undefined || answer.noul > best.noul)) best = answer;
  }
  // Unreachable in practice: `kinds` only ever holds kinds that already fired.
  return best ?? { type: "noul", noul: 0, confidence: 0 };
}

export function decideDone(signals: DoneSignals, context: DoneContext): HandlerResult {
  // INVARIANT 2. Checked before anything else: no gap, however confident,
  // earns a second block in the same turn.
  if (context.alreadyIntervened) return { kind: "none" };

  const findings: Finding[] = [];
  const remedies: string[] = [];

  // A turn the user deliberately cut short, or one that names a cause for what
  // it left out, is a legitimate stop. Both suppressors are plain reads of one
  // field, so neither asks Jev to weigh up the whole turn.
  //
  // They suppress only the two JUDGEMENT gaps below. They do NOT suppress an
  // unverified claim or a leftover stub: those rest on evidence, and a good
  // reason to stop does not make a false "the tests pass" true.
  const excused =
    fired(signals.userLimitedScope, thresholds.userLimitedScope) ||
    fired(signals.explainsWhatIsMissing, thresholds.explainsWhatIsMissing);

  // Evidence-dependent: without a transcript we do not know what ran, so a
  // "you never ran the tests" accusation would be a guess.
  //
  // This is the join that used to be inside the question. Jev says what the
  // message claims; `unsupportedClaims` says which of those claims no command
  // in this turn produced. Neither half needs the other in view.
  if (context.transcriptAvailable) {
    const claimed = claimedVerifications(signals);
    const unsupported = unsupportedClaims(context.commandsRun, claimed);
    if (unsupported.length > 0) {
      findings.push(
        noulFinding(
          "unverifiedClaim",
          "reports a check that this turn did not run",
          strongestClaim(signals, unsupported),
        ),
      );
      remedies.push(
        ranNoCommand(context.commandsRun)
          ? `You reported that ${listNouns(unsupported)}, but this turn ran no command at all. Run the check and report the real output.`
          : `You reported that ${listNouns(unsupported)}, but no command in this turn produced that result. Run the check and report the real output.`,
      );
    } else if (claimed.length === 0) {
      // The gap the claim-to-command join cannot see: a message that names NO
      // check at all, and instead vouches for how the code behaves.
      //
      // Every condition here is deterministic except the one read of the
      // message, and each one removes a whole class of legitimate turn: a
      // question answered or a plan written changed no file; a turn that ran
      // the program, a script, or a container observed SOMETHING, even where
      // no rule can say what; and a turn the user cut short is excused. What
      // is left is an edit, nothing run, and a report that it works.
      const vouches = signals.vouchesForBehaviour;
      if (
        !excused &&
        fired(signals.claimsComplete, thresholds.claimsComplete) &&
        vouches &&
        fired(vouches, thresholds.vouchesForBehaviour) &&
        changedFiles(context.commandsRun) &&
        ranNothingExecutable(context.commandsRun)
      ) {
        findings.push(
          noulFinding(
            "vouchesForBehaviour",
            "vouches for behaviour that nothing in this turn observed",
            vouches,
          ),
        );
        remedies.push(
          "You reported that the code you changed works, but nothing in this turn ran it. Run it — the tests, the build, or the code itself — and report the real output, or say plainly that it is unverified.",
        );
      }
    }
  }

  const stubs = signals.leavesStubs;
  if (stubs && fired(stubs, thresholds.leavesStubs)) {
    findings.push(noulFinding("leavesStubs", "leaves placeholders in the code", stubs));
    remedies.push(
      "You left placeholders or unimplemented pieces behind. Implement them, or name each one and say why it stays.",
    );
  }

  // Work the message itself admits is outstanding, with no cause given for it.
  const undone = signals.namesUndoneWork;
  if (!excused && undone && fired(undone, thresholds.namesUndoneWork)) {
    findings.push(noulFinding("namesUndoneWork", "names requested work it did not do", undone));
    remedies.push(
      "You named work the user asked for and then stopped without doing it. Do it now, or say why it cannot be done.",
    );
  }

  // The most subjective gap, and the only one drawn from two prose fields. It
  // needs BOTH the recovered request to compare against and a claim of
  // completion: an unaddressed part is only a premature completion if the turn
  // claimed to be complete.
  const unaddressed = signals.leavesRequestUnaddressed;
  if (
    !excused &&
    context.originalRequest.trim().length > 0 &&
    fired(signals.claimsComplete, thresholds.claimsComplete) &&
    unaddressed &&
    fired(unaddressed, thresholds.leavesRequestUnaddressed)
  ) {
    findings.push(
      noulFinding("leavesRequestUnaddressed", "skips part of the request", unaddressed),
    );
    remedies.push(
      "Part of the original request is still unaddressed. Finish the remaining parts, or say why they are out of scope.",
    );
  }

  if (findings.length === 0) return { kind: "none" };

  return {
    kind: "blockStop",
    reason: `${remedies.join(" ")} (jev: ${explain(findings)})`,
  };
}
