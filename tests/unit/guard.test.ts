import { describe, expect, it } from "vitest";
import { noulConfidence } from "../../src/core/decide.js";
import type { Answer, JevFailure, NoulAnswer, ScoreAnswer } from "../../src/core/types.js";
import { decideGuard, failClosed, type GuardContext } from "../../src/capabilities/guard/decide.js";
import { BASH_KEYS, FILE_KEYS, THRESHOLDS } from "../../src/capabilities/guard/questions.js";

/**
 * These exercise the pure decision only. No network, no API key, no fixtures —
 * so every branch, including every way the API can fail, is reachable here.
 */

const noulOf = (p: number): NoulAnswer => ({
  type: "noul",
  noul: p,
  confidence: noulConfidence(p),
});

const scoreOf = (
  score: number,
  probabilities: Record<string, number>,
  confidence = 0.9,
): ScoreAnswer => ({
  type: "score",
  score,
  nearest: Math.round(score),
  levels: Object.keys(probabilities).length,
  probabilities,
  legend: {},
  confidence,
});

/** A quiet 4-level distribution with no mass on the catastrophic end. */
const CALM = { "0": 0.85, "1": 0.13, "2": 0.02, "3": 0 };

const bashAnswers = (overrides: Record<string, Answer> = {}): Record<string, Answer> => ({
  danger: scoreOf(0.2, CALM),
  systemWide: noulOf(0.02),
  escapesProject: noulOf(0.04),
  sendsData: noulOf(0.03),
  exfiltrates: noulOf(0.01),
  irreversible: noulOf(0.05),
  pipesRemoteCode: noulOf(0.01),
  ...overrides,
});

const fileAnswers = (overrides: Record<string, Answer> = {}): Record<string, Answer> => ({
  blastRadius: scoreOf(0.2, CALM),
  escapesProject: noulOf(0.03),
  destroysContent: noulOf(0.1),
  emptiesFile: noulOf(0.02),
  removesTests: noulOf(0.02),
  addsRemoteExecution: noulOf(0.01),
  ...overrides,
});

const BASH: GuardContext = { tool: "Bash", subject: "ls -la" };
const WRITE: GuardContext = { tool: "Write", subject: "/repo/src/index.ts" };

const decideBash = (overrides?: Record<string, Answer>) =>
  decideGuard(bashAnswers(overrides), BASH);
const decideFile = (overrides?: Record<string, Answer>) => decideGuard(fileAnswers(overrides), WRITE);

const FAILURES: JevFailure[] = [
  { type: "no_api_key" },
  { type: "timeout", ms: 1500 },
  { type: "disabled" },
  { type: "too_large", bytes: 90_000 },
  { type: "api_error", status: 503, message: "upstream unavailable" },
  { type: "api_error", message: "socket hang up" },
  { type: "malformed", message: "no answers field" },
];

describe("the fail-closed invariant", () => {
  // The single most important property of this capability: a judge that cannot
  // judge hands the decision to the human. Anything else silently widens the
  // agent's permissions exactly when the safety layer is broken.
  it.each(FAILURES.map((f) => [f.type, f] as const))(
    "asks the human when Jev fails with %s, so a broken judge never becomes a permissive one",
    (_type, failure) => {
      const result = failClosed(failure, BASH);
      expect(result.permissionDecision).toBe("ask");
    },
  );

  it("names the failure in the reason, so the user can tell a timeout from a missing key", () => {
    expect(failClosed({ type: "timeout", ms: 1500 }, BASH).permissionDecisionReason).toContain(
      "timed out after 1500ms",
    );
    expect(failClosed({ type: "no_api_key" }, BASH).permissionDecisionReason).toContain(
      "no TYPESAFE_API_KEY",
    );
  });

  it.each([...BASH_KEYS])(
    "asks when the answer set is missing `%s`, because a partial judgement is not a judgement",
    (key) => {
      const answers = bashAnswers();
      delete answers[key];
      expect(decideGuard(answers, BASH).permissionDecision).toBe("ask");
    },
  );

  it.each([...FILE_KEYS])("asks when a file write answer set is missing `%s`", (key) => {
    const answers = fileAnswers();
    delete answers[key];
    expect(decideGuard(answers, WRITE).permissionDecision).toBe("ask");
  });

  it("asks when an answer comes back as the wrong primitive type", () => {
    // A score question answered with a noul means our contract with the API
    // has drifted; guessing past that is how a gate fails open.
    expect(decideBash({ danger: noulOf(0.1) }).permissionDecision).toBe("ask");
    expect(decideFile({ blastRadius: noulOf(0.1) }).permissionDecision).toBe("ask");
  });
});

describe("bimodal danger", () => {
  it("denies on the dangerous tail even when the mean sits nowhere near the deny bar", () => {
    // "Harmless, unless that glob matches": the mean is barely past the ask
    // threshold and a whole rubric level below the deny one, and half the mass
    // is on 'destroys data with no other copy'.
    const bimodal = scoreOf(1.55, { "0": 0.45, "1": 0.05, "2": 0, "3": 0.5 });
    expect(bimodal.score).toBeLessThan(THRESHOLDS.bash.denyScore - 1);
    expect(decideBash({ danger: bimodal }).permissionDecision).toBe("deny");
  });

  it("asks on a thinner tail rather than allowing it through", () => {
    const thin = scoreOf(0.75, { "0": 0.75, "1": 0, "2": 0, "3": 0.25 });
    const result = decideBash({ danger: thin });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("25%");
  });

  it("allows when the whole distribution really does sit on the safe levels", () => {
    expect(decideBash().permissionDecision).toBe("allow");
  });

  it("applies the same tail rule to file writes", () => {
    const bimodal = scoreOf(1.2, { "0": 0.6, "1": 0, "2": 0, "3": 0.4 });
    expect(decideFile({ blastRadius: bimodal }).permissionDecision).toBe("deny");
  });
});

describe("confidence gating", () => {
  /**
   * `danger` and `irreversible` are excluded here and covered by "doubt that
   * straddles the decision" below. Doubt about them is only a risk signal when
   * the risk is live, and a blanket rule turned `git status` into a prompt.
   */
  const ALWAYS_GATED = BASH_KEYS.filter((k) => k !== "danger" && k !== "irreversible");

  it.each([...ALWAYS_GATED])(
    "never allows when `%s` came back as a coin flip, because an unresolved risk is not a cleared one",
    (key) => {
      expect(decideBash({ [key]: noulOf(0.5) }).permissionDecision).not.toBe("allow");
    },
  );

  it.each([...FILE_KEYS])("never allows when a file write answer `%s` is a coin flip", (key) => {
    const unsure: Answer = key === "blastRadius" ? scoreOf(0.5, CALM, 0.1) : noulOf(0.5);
    expect(decideFile({ [key]: unsure }).permissionDecision).not.toBe("allow");
  });

  it("does not deny on a high score the model is not confident about", () => {
    // Low confidence must not manufacture a block either: the human decides.
    const shaky = scoreOf(2.9, { "0": 0, "1": 0, "2": 0.1, "3": 0 }, 0.2);
    expect(decideBash({ danger: shaky }).permissionDecision).toBe("ask");
  });

  it("treats a confident 'no' as cleared rather than uncertain", () => {
    // p=0.04 is a confident no (confidence 0.92) and must not block an allow.
    expect(decideBash({ escapesProject: noulOf(0.04) }).permissionDecision).toBe("allow");
  });
});

describe("doubt that straddles the decision", () => {
  /**
   * Measured against the live API, a blanket "any coin flip asks" rule sent 10
   * of 19 safe commands to a prompt — `git status`, `npm test`, `rm -rf ./dist`
   * — and a guard that prompts on those teaches the user to approve without
   * reading. Doubt still asks; doubt with nothing to be in doubt ABOUT does not.
   */

  it("allows an unsure `danger` whose whole distribution sits below the ask bar", () => {
    // `npm test`: split between "only reads" and "rebuildable", uncertain and
    // still unambiguously safe on either reading.
    const split = scoreOf(0.9, { "0": 0.35, "1": 0.45, "2": 0.2, "3": 0 }, 0.45);
    expect(split.confidence).toBeLessThan(THRESHOLDS.minConfidence);
    expect(decideBash({ danger: split }).permissionDecision).toBe("allow");
  });

  it("asks on an unsure `danger` once enough mass reaches the ask level", () => {
    const straddling = scoreOf(1.35, { "0": 0.25, "1": 0.2, "2": 0.5, "3": 0.05 }, 0.3);
    expect(straddling.score).toBeLessThan(THRESHOLDS.bash.askScore);
    expect(decideBash({ danger: straddling }).permissionDecision).toBe("ask");
  });

  it("asks on an unsure `danger` whose expected score is above the bar", () => {
    // Low confidence never turns a high score into an allow, whatever the
    // shape of the distribution behind it.
    const shaky = scoreOf(2.9, { "0": 0, "1": 0, "2": 0.1, "3": 0 }, 0.2);
    expect(decideBash({ danger: shaky }).permissionDecision).toBe("ask");
  });

  it("allows an unsure `irreversible` when `danger` confidently settles it", () => {
    // Levels 0 and 1 of the rubric already say the previous state comes back,
    // and that answer is the confident one.
    expect(decideBash({ irreversible: noulOf(0.5) }).permissionDecision).toBe("allow");
  });

  it("asks on an unsure `irreversible` when `danger` does not settle it", () => {
    const reachesAskBar = scoreOf(1.6, { "0": 0, "1": 0.4, "2": 0.6, "3": 0 }, 0.9);
    const result = decideBash({ danger: reachesAskBar, irreversible: noulOf(0.5) });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("undone");
  });

  it.each([
    ["0.45, leaning reversible", 0.45, "allow"],
    ["0.50, a true coin flip", 0.5, "allow"],
    ["0.55, leaning irreversible", 0.55, "ask"],
    ["0.70, leaning irreversible", 0.7, "ask"],
  ])(
    "reads an unsure `irreversible` at %s as %s, because doubt has a direction",
    (_label, probability, expected) => {
      // The hole an adversarial review found. Every command that blanks a
      // project's source files in place — `sed -i '' 's/.*//' src/*.ts`, a
      // truncating loop, `perl -pi -e`, a bare `> src/index.ts` — answered
      // `irreversible` between 0.57 and 0.75: under the confidence floor, and
      // pointing straight at the risk. The old discount treated "probably not
      // reversible, not sure" and "probably reversible, not sure" as the same
      // absence of information and allowed all of them.
      //
      // Measured on the other side: every benign in-project write answers
      // 0.03-0.45, `echo "ok" > notes.txt` being the highest. The bar sits in
      // that gap, and 0.5 exactly stays on the quiet side of it.
      const answer = noulOf(probability);
      expect(answer.confidence).toBeLessThan(THRESHOLDS.minConfidence);
      expect(decideBash({ irreversible: answer }).permissionDecision).toBe(expected);
    },
  );

  it("stops discounting `irreversible` once `danger` puts real mass in the ask band", () => {
    // The other half of the narrowing, and enough on its own to have caught the
    // same commands. A `danger` whose mean has not crossed the bar but which
    // holds a third of its mass on "leaves files a person wrote empty" has not
    // settled anything, however confident the model is about that shape.
    const banded = scoreOf(1.45, { "0": 0.1, "1": 0.35, "2": 0.55, "3": 0 }, 0.9);
    expect(banded.score).toBeLessThan(THRESHOLDS.bash.askScore);
    expect(decideBash({ danger: banded, irreversible: noulOf(0.4) }).permissionDecision).toBe(
      "ask",
    );
  });

  it("asks on a confident `irreversible` however calm `danger` is", () => {
    // Only the doubt is discounted. A confident yes still reaches the human,
    // even when it contradicts a confident low `danger`.
    const result = decideBash({ irreversible: noulOf(0.95) });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("cannot be undone");
  });

  it("still gates the network keys when `danger` is confidently at the bottom", () => {
    // The discount covers the questions that presuppose a change. Nothing that
    // asks where data goes is affected, because a read-only command can still
    // ship a private key off the machine.
    for (const key of ["sendsData", "exfiltrates", "pipesRemoteCode"] as const) {
      expect(decideBash({ [key]: noulOf(0.5) }).permissionDecision).not.toBe("allow");
    }
  });
});

describe("mass one level below the top", () => {
  /**
   * `denyTailMass` and `askTailMass` both read the TOP rubric level only. The
   * bimodality they exist to catch does not always land there: on the in-place
   * rewrite commands the mass sat on level 2 — "leaves files a person wrote
   * empty" — while level 3 stayed at 0.03-0.08. The tail checks looked straight
   * past it.
   */

  it("asks on mass at the ask level even when the top level is empty and the mean is below the bar", () => {
    const banded = scoreOf(1.45, { "0": 0.1, "1": 0.35, "2": 0.55, "3": 0 }, 0.95);
    expect(banded.score).toBeLessThan(THRESHOLDS.bash.askScore);
    expect(banded.probabilities["3"]).toBe(0);
    const result = decideBash({ danger: banded });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("55%");
  });

  it("still allows when that band holds only the ordinary amount of doubt", () => {
    // `rm -rf ./dist` and `find . -name '*.log' -delete` measure 0.22-0.24 here.
    const quiet = scoreOf(1.31, { "0": 0, "1": 0.76, "2": 0.17, "3": 0.07 }, 0.9);
    expect(decideBash({ danger: quiet }).permissionDecision).toBe("allow");
  });

  it("reads the ask level from `askLevel`, not from the arithmetic of `askScore`", () => {
    // `Math.ceil(askScore)` happened to equal `askLevel` at askScore 1.5. It
    // would have silently become level 1 at 0.9 and level 3 at 2.1, moving
    // which band the checks inspect as a side effect of retuning a mean.
    const t = THRESHOLDS.bash;
    expect(Number.isInteger(t.askLevel)).toBe(true);
    expect(t.askLevel).toBeGreaterThan(0);
    // The coupling is gone: the level no longer tracks the score bar.
    expect(t.askLevel).not.toBe(Math.ceil(t.askScore + 1));
  });
});

describe("bash decisions", () => {
  const high = scoreOf(2.8, { "0": 0, "1": 0, "2": 0.2, "3": 0.8 }, 0.9);
  const moderate = scoreOf(2.0, { "0": 0, "1": 0.1, "2": 0.85, "3": 0.05 }, 0.9);

  it("denies a command whose expected destructiveness sits on the top level", () => {
    expect(decideBash({ danger: high }).permissionDecision).toBe("deny");
  });

  it("asks for a command that changes state outside the process but destroys nothing", () => {
    expect(decideBash({ danger: moderate }).permissionDecision).toBe("ask");
  });

  it("denies piping downloaded code into a shell however tame the rest looks", () => {
    // The command cannot be audited before it runs, so the score alone is not
    // evidence of safety.
    expect(decideBash({ pipesRemoteCode: noulOf(0.95) }).permissionDecision).toBe("deny");
  });

  it("denies sending secrets off the machine even though nothing is destroyed", () => {
    const result = decideBash({ exfiltrates: noulOf(0.9), sendsData: noulOf(0.95) });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("secrets");
  });

  it("separates a whole-tree command from a single directory outside the project", () => {
    // `rm -rf ~` against `rm -rf ~/dist`: same destructiveness rubric level,
    // and only `systemWide` tells them apart.
    const wholeTree = decideBash({ danger: moderate, systemWide: noulOf(0.95) });
    const oneDirectory = decideBash({ danger: moderate, escapesProject: noulOf(0.95) });
    expect(wholeTree.permissionDecision).toBe("deny");
    expect(oneDirectory.permissionDecision).toBe("ask");
  });

  it("does not deny a whole-tree command that only reads", () => {
    // `grep -r foo /etc` is system-wide and harmless.
    expect(decideBash({ systemWide: noulOf(0.95) }).permissionDecision).toBe("ask");
  });

  it.each([
    ["escapesProject", "reaches outside the project"],
    ["sendsData", "sends local data"],
    ["irreversible", "cannot be undone"],
  ])("asks when `%s` fires on its own", (key, phrase) => {
    const result = decideBash({ [key]: noulOf(0.95) });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain(phrase);
  });
});

describe("file write decisions", () => {
  it("allows an ordinary edit to a project source file", () => {
    expect(decideFile().permissionDecision).toBe("allow");
  });

  it("asks before removing tests, because tests are what contradict the agent", () => {
    const result = decideFile({ removesTests: noulOf(0.92) });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("weakens tests");
  });

  it("asks for a write that changes how the project builds or deploys", () => {
    const ci = scoreOf(2.0, { "0": 0, "1": 0.1, "2": 0.88, "3": 0.02 }, 0.9);
    expect(decideFile({ blastRadius: ci }).permissionDecision).toBe("ask");
  });

  it("denies a write to credentials or system configuration", () => {
    const outside = scoreOf(2.9, { "0": 0, "1": 0, "2": 0.1, "3": 0.9 }, 0.9);
    expect(decideFile({ blastRadius: outside }).permissionDecision).toBe("deny");
  });

  it("denies content that adds a way to run code off the network", () => {
    expect(decideFile({ addsRemoteExecution: noulOf(0.9) }).permissionDecision).toBe("deny");
  });

  it("separates writing outside the project from overwriting outside the project", () => {
    const additive = decideFile({ escapesProject: noulOf(0.95) });
    const destructive = decideFile({ escapesProject: noulOf(0.95), destroysContent: noulOf(0.9) });
    expect(additive.permissionDecision).toBe("ask");
    expect(destructive.permissionDecision).toBe("deny");
  });

  it("does not ask merely because a write replaces content inside the project", () => {
    // Every `Write` to an existing file destroys content; asking each time
    // would make the gate noise and train the user to click through it.
    expect(decideFile({ destroysContent: noulOf(0.95) }).permissionDecision).toBe("allow");
  });

  it("asks before a write that leaves a project file empty", () => {
    // `Write` of "" over `src/core/decide.ts`. `blastRadius` reads 0.00 at full
    // confidence and is right to: an ordinary source file controls nothing. The
    // write still deletes a module. Before `destroysContent` reached the ask
    // path it was consulted only in the deny path, conjoined with
    // `escapesProject`, so a 0.95 answer on a file inside the project could not
    // move the verdict at all and this returned allow.
    const result = decideFile({ destroysContent: noulOf(0.96), emptiesFile: noulOf(0.95) });
    expect(result.permissionDecision).toBe("ask");
    expect(result.permissionDecisionReason).toContain("leaves the file empty");
    expect(result.permissionDecisionReason).toContain("96%");
  });

  it("allows a full rewrite that puts real content back", () => {
    // The near miss that stops the rule above from prompting on every `Write`.
    // Measured: `destroysContent` answers 0.94-0.98 for a rewrite and for an
    // erasure alike, and only `emptiesFile` separates them — 0.02-0.11 against
    // 0.90-0.95.
    expect(
      decideFile({ destroysContent: noulOf(0.97), emptiesFile: noulOf(0.03) }).permissionDecision,
    ).toBe("allow");
  });

  it("does not ask when a new file is created empty but nothing is being replaced", () => {
    expect(
      decideFile({ destroysContent: noulOf(0.1), emptiesFile: noulOf(0.95) }).permissionDecision,
    ).toBe("allow");
  });
});

describe("reason strings", () => {
  it("cites the score, the rubric size, and the confidence behind a deny", () => {
    const result = decideBash({ danger: scoreOf(2.8, { "0": 0, "1": 0, "2": 0.2, "3": 0.8 }, 0.88) });
    expect(result.permissionDecisionReason).toContain("2.8 of 0-3");
    expect(result.permissionDecisionReason).toContain("confidence 88%");
  });

  it("cites the probability behind a yes/no signal", () => {
    const result = decideBash({ escapesProject: noulOf(0.93) });
    expect(result.permissionDecisionReason).toContain("93%");
  });

  it("cites numbers on an allow too, so a permissive decision is auditable", () => {
    expect(decideBash().permissionDecisionReason).toMatch(/0\.2 of 0-3/);
  });

  it("quotes the subject so a transcript says which call was judged", () => {
    expect(decideBash().permissionDecisionReason).toContain("`ls -la`");
  });

  it("shortens a long subject rather than pasting a whole heredoc into the prompt", () => {
    const long = { tool: "Bash" as const, subject: "echo " + "x".repeat(500) };
    const reason = decideGuard(bashAnswers(), long).permissionDecisionReason;
    expect(reason.length).toBeLessThan(300);
    expect(reason).toContain("…");
  });
});

describe("threshold table", () => {
  it.each([
    ["bash", THRESHOLDS.bash],
    ["file", THRESHOLDS.file],
  ])("keeps the %s deny bar above its ask bar, so the bands cannot invert", (_name, t) => {
    expect(t.denyScore).toBeGreaterThan(t.askScore);
    expect(t.denyTailMass).toBeGreaterThan(t.askTailMass);
  });

  it("keeps every settled-doubt bar on the quiet side of a coin flip", () => {
    // A discount that fires on an answer leaning toward the risk is not a
    // discount, it is a suppression.
    expect(THRESHOLDS.bash.irreversibleSettled).toBeLessThanOrEqual(0.5);
  });

  it("puts the noul bars written at 0.75 exactly on the floor `minConfidence` implies", () => {
    // Documented rather than corrected: these four numbers do nothing today,
    // because confidence = |p - 0.5| * 2 makes 0.75 the lowest probability a
    // `likely()` call can ever accept. The comment that used to claim they sat
    // ABOVE that floor was wrong, and a reader trusting it would have retuned
    // the wrong dial.
    for (const bar of [THRESHOLDS.bash.escapesProject, THRESHOLDS.bash.sendsData]) {
      expect(noulConfidence(bar)).toBe(THRESHOLDS.minConfidence);
    }
    for (const bar of [THRESHOLDS.file.escapesProject, THRESHOLDS.file.removesTests]) {
      expect(noulConfidence(bar)).toBe(THRESHOLDS.minConfidence);
    }
  });

  it("sets a confidence floor that rejects the whole mushy middle of a probability", () => {
    // minConfidence 0.5 means p between 0.25 and 0.75 counts as 'do not know'.
    expect(noulConfidence(0.7)).toBeLessThan(THRESHOLDS.minConfidence);
    expect(noulConfidence(0.8)).toBeGreaterThanOrEqual(THRESHOLDS.minConfidence);
  });
});
