import { noul } from "@typesafe-ai/sdk";

/**
 * Every question and every number `done` decides with.
 *
 * Three rules shape this file:
 *
 *   1. ONE FIELD PER QUESTION. Jev is a five-second expert read, not a
 *      reasoner. Every question below is answerable from ONE field of the
 *      state object — almost always `message`. No question asks Jev to hold
 *      two fields and correlate them; where a correlation is needed,
 *      `decide.ts` and `verification.ts` do it in code afterwards.
 *
 *      `leavesRequestUnaddressed` is the single question that reads two
 *      fields, because both of them are free prose and no string matching can
 *      join them. It is called out again where it is defined.
 *
 *   2. ONE DIMENSION PER QUESTION. Each question asks about a single
 *      observable situation and is combined in `decide.ts`. A compound
 *      question ("is this incomplete or unverified?") cannot be gated, cited
 *      in a reason, or tuned independently.
 *
 *   3. NEGATIVE FRAMING FOR EVERY GAP. A high probability always means "there
 *      is a gap". The starting sketch had `addressesRequest`, where a LOW
 *      probability was the concerning signal; mixing both polarities in one
 *      answer map invites exactly one class of bug — a uniform "high is bad"
 *      rule silently inverts that one question and blocks every finished turn.
 *      So it is asked here as `leavesRequestUnaddressed`.
 *
 *      Two questions are SUPPRESSORS rather than gaps — `userLimitedScope`
 *      and `explainsWhatIsMissing`. A high probability on either means "allow".
 *      `decide.ts` handles both in their own branch so the gap rule never has
 *      to invert a probability.
 */

/** Content bounds. Everything sent to Jev passes through one of these. */
export const limits = {
  /** Bytes of the final assistant message we evaluate. */
  messageBytes: 8_000,
  /** Bytes read from the TAIL of the transcript file. Transcripts get large. */
  transcriptBytes: 256_000,
  /** Bytes of the recovered user request we send. */
  requestBytes: 4_000,
  /** Bytes of any one command string. */
  commandBytes: 400,
  /** Commands kept from the transcript. The most recent are kept. */
  maxCommands: 40,
} as const;

export interface NoulThreshold {
  /** Minimum probability before the signal counts. */
  probability: number;
  /** Minimum derived confidence (|p - 0.5| * 2) before the signal counts. */
  minConfidence: number;
}

export type QuestionKey =
  | "claimsComplete"
  | "claimsExhaustiveChange"
  | "claimsTestsPassed"
  | "claimsBuildPassed"
  | "claimsTypecheckPassed"
  | "claimsLintPassed"
  | "vouchesForBehaviour"
  | "leavesStubs"
  | "namesUndoneWork"
  | "leavesRequestUnaddressed"
  | "explainsWhatIsMissing"
  | "userLimitedScope";

/**
 * Thresholds.
 *
 * A false "keep working" costs the user tokens and time on work they did not
 * ask for, so every GAP bar is high. Noul confidence is derived as
 * |p - 0.5| * 2, so each pair below is self-consistent: p = 0.80 yields
 * confidence 0.60. Neither bar is dead weight, and neither is unreachable.
 *
 * Gates and suppressors are permissive, because both only ever narrow what can
 * fire, and allowing is the cheap mistake.
 */
export const thresholds: Record<QuestionKey, NoulThreshold> = {
  // A gate, not a gap.
  claimsComplete: { probability: 0.6, minConfidence: 0.2 },

  // Each of these is only half a finding. The other half is whether a matching
  // command ran, which `verification.ts` decides in code.
  claimsTestsPassed: { probability: 0.8, minConfidence: 0.6 },
  claimsBuildPassed: { probability: 0.8, minConfidence: 0.6 },
  claimsTypecheckPassed: { probability: 0.8, minConfidence: 0.6 },
  claimsLintPassed: { probability: 0.8, minConfidence: 0.6 },

  vouchesForBehaviour: { probability: 0.8, minConfidence: 0.6 },

  leavesStubs: { probability: 0.8, minConfidence: 0.6 },
  // A universal claim is only a gap when nothing verified it, and the code-side
  // check (`sweptAfterLastEdit`) does the verifying. So this bar only has to be
  // confident the claim WAS made, not that it was wrong.
  claimsExhaustiveChange: { probability: 0.8, minConfidence: 0.6 },
  namesUndoneWork: { probability: 0.8, minConfidence: 0.6 },
  // Measured, not guessed. Across the allow cases this signal peaks at 0.13;
  // across the continue cases it bottoms at 0.79. A bar of 0.8 sat at the very
  // edge of the cluster it must catch (margin 0.02, and one full-suite run did
  // flip because of it). 0.65 sits inside the empty 0.13-0.79 gap with ~0.14 of
  // headroom below the signal and ~0.52 above the noise.
  //
  // minConfidence moves with it because the two are the same constraint:
  // confidence is |p - 0.5| * 2, so 0.6 IS "p >= 0.8". Leaving it at 0.6 would
  // silently re-impose the old bar and make the probability change a no-op.
  leavesRequestUnaddressed: { probability: 0.65, minConfidence: 0.3 },

  // Suppressors.
  explainsWhatIsMissing: { probability: 0.6, minConfidence: 0.2 },
  userLimitedScope: { probability: 0.6, minConfidence: 0.2 },
};

/**
 * The questions.
 *
 * `message` and `originalRequest` are the exact keys of the state object
 * `handler.ts` sends, so the wording can reference them directly. Note what is
 * NOT sent: `commandsRun`. No question needs it, and having it in view is an
 * invitation for the model to attempt the correlation that code now owns.
 */
export const questions = {
  claimsComplete: noul(
    "Does `message` present the requested work as finished, rather than as in progress?",
    {
      true: "The message reports the task as done, delivered, complete, or ready to use.",
      false:
        "The message asks the user a question, reports being blocked, or describes work still in progress.",
    },
  ),

  // ---- Verification claims. Each is a plain read of `message`. Whether the
  // claim is TRUE is decided in code, against `commandsRun`.
  claimsTestsPassed: noul("Does `message` state that a test run passed?", {
    true: "The message says the tests pass, the suite is green, everything is green, or gives a passing test count.",
    false:
      "The message says nothing about a test result, or reports the tests as failing, or only says it will run them.",
  }),

  claimsBuildPassed: noul("Does `message` state that a build or compile step succeeded?", {
    true: "The message says the build succeeds, the project compiles, or the bundle was produced without errors.",
    false:
      "The message says nothing about a build, or reports the build as failing, or only says it will build.",
  }),

  claimsTypecheckPassed: noul("Does `message` state that a type check reported no errors?", {
    true: "The message says tsc, mypy, pyright, or another type checker is clean, or that there are no type errors left.",
    false:
      "The message says nothing about type checking, or reports type errors that remain.",
  }),

  claimsLintPassed: noul("Does `message` state that a lint check passed?", {
    true: "The message says lint is clean, the linter passes, or there are no lint errors left.",
    false: "The message says nothing about linting, or reports lint errors that remain.",
  }),

  vouchesForBehaviour: noul(
    "Does `message` vouch for how the code behaves when it runs — that it works, is correct, or is ready to use?",
    {
      true: "The message asserts that the code it changed behaves correctly, handles its cases, is verified, is in order, or is ready to use.",
      false:
        "The message only describes what it changed or found, reports a problem, asks a question, or makes no claim about how the code behaves.",
    },
  ),

  // ---- Gaps that live entirely inside `message`.
  claimsExhaustiveChange: noul(
    "Does `message` claim that a change was applied to every place it belongs — every call site, all usages, or throughout the codebase?",
    {
      true: "The message states or clearly implies the change reached all of them: 'every call site', 'all usages', 'throughout', 'each of the N places', or a count presented as the complete set.",
      false:
        "The message describes changing specific named places without claiming to have covered them all, or reports the work as partial, or makes no claim about coverage at all.",
    },
  ),

  leavesStubs: noul(
    "Does `message` say that placeholders, TODOs, stubs, mocks, or unimplemented pieces remain in the code it changed?",
    {
      true: "The message names a placeholder, TODO, stub, mock, hard-coded value, or unimplemented branch that is still in the code it wrote.",
      false: "The message names no such remaining piece in the code it wrote.",
    },
  ),

  namesUndoneWork: noul(
    "Does `message` name a piece of the work the user asked for that it has not done?",
    {
      true: "The message says a requested piece is still to do, still needs wiring up, will be done next, or remains outstanding.",
      false:
        "The message reports every requested piece as done, or the only further work it names is an extra the user did not ask for, or an option the user may decline.",
    },
  ),

  // The ONE question that reads two fields. It stays a question because both
  // fields are free prose: no string matching can decide whether a paragraph
  // of report covers a paragraph of request. It is still a single judgement
  // ("does the report cover the ask?"), not a scan-and-correlate.
  //
  // Negatively framed on purpose. See the file header.
  leavesRequestUnaddressed: noul(
    "Does `message` report work on only some of the things `originalRequest` asks for?",
    {
      true: "`originalRequest` asks for several distinct things, and `message` reports work on fewer of them than it asks for.",
      false:
        "`message` reports work on every distinct thing `originalRequest` asks for, or `originalRequest` asks for one thing only.",
    },
  ),

  // ---- Suppressors. A HIGH probability means allow.
  explainsWhatIsMissing: noul(
    "Does `message` give a reason for something it did not do, or name something that stopped it?",
    {
      true: "The message gives a cause — a missing credential, an unreachable service, a failure it reports honestly, a limit the user set, or a decision it needs from the user first.",
      false:
        "The message names missing or unfinished work and gives no cause for it, or names no missing work at all.",
    },
  ),

  userLimitedScope: noul("Does `originalRequest` limit how far the agent should go?", {
    true: "The request tells the agent to stop at a point, to do only part of the work, to change no code, or to describe a plan rather than implement it.",
    false: "The request asks for the whole job, with no limit on how far to take it.",
  }),
};
