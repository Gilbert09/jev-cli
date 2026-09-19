import {
  explain,
  likely,
  massAtOrAbove,
  noulFinding,
  scoreAtLeast,
  scoreFinding,
  type Finding,
} from "../../core/decide.js";
import { describeFailure } from "../../core/types.js";
import type {
  Answer,
  JevFailure,
  NoulAnswer,
  ScoreAnswer,
  HandlerResult,
} from "../../core/types.js";
import { BASH_KEYS, FILE_KEYS, THRESHOLDS } from "./questions.js";

/**
 * The whole decision, as a pure function.
 *
 * Nothing here awaits, reads a file, or knows the API exists, so every branch —
 * including every way the API can let us down — is reachable from a unit test
 * with hand-built answers.
 *
 * The invariant this file exists to protect: guard FAILS CLOSED. Anything that
 * stops us from forming a judgement produces "ask", never "allow". A judge that
 * cannot judge defers to the human.
 */

export type GuardTool = "Bash" | "Write" | "Edit";

export interface GuardContext {
  tool: GuardTool;
  /** The command, or the path being written. Quoted back so a log is auditable. */
  subject: string;
}

export type GuardDecision = Extract<HandlerResult, { kind: "preToolUse" }>;

/** Human wording per answer key, used when an answer is too uncertain to rely on. */
const UNCERTAIN: Record<string, string> = {
  danger: "how destructive this command is",
  blastRadius: "what this file controls",
  systemWide: "whether this covers a whole system or home directory",
  escapesProject: "whether this reaches outside the project",
  sendsData: "whether this sends local data to a network host",
  irreversible: "whether this can be undone",
  pipesRemoteCode: "whether this runs code straight off the network",
  destroysContent: "whether this removes existing content",
  emptiesFile: "whether this leaves the file empty",
  removesTests: "whether this weakens the tests",
  addsRemoteExecution: "whether this adds a way to run code off the network",
};

function shorten(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function decision(
  permissionDecision: GuardDecision["permissionDecision"],
  ctx: GuardContext,
  body: string,
): GuardDecision {
  const verb =
    permissionDecision === "deny"
      ? "blocked"
      : permissionDecision === "ask"
        ? "needs your approval for"
        : "allowed";
  return {
    kind: "preToolUse",
    permissionDecision,
    permissionDecisionReason: `jev ${verb} \`${shorten(ctx.subject)}\`: ${body}`,
  };
}

/** The one result every failure path must produce. */
export function failClosed(error: JevFailure, ctx: GuardContext): GuardDecision {
  return decision("ask", ctx, `could not be evaluated (${describeFailure(error)}) — over to you`);
}

function asScore(answer: Answer | undefined): ScoreAnswer | undefined {
  return answer?.type === "score" ? answer : undefined;
}

function asNoul(answer: Answer | undefined): NoulAnswer | undefined {
  return answer?.type === "noul" ? answer : undefined;
}

/**
 * Findings for every answer the model is not confident enough about.
 *
 * An under-confident answer is not a "no": it is an unresolved risk, so it
 * blocks an allow instead of being ignored. `skip` names the keys whose risk
 * a more confident answer has already settled — see `settledByDanger`.
 */
function uncertainFindings(
  answers: Record<string, Answer>,
  keys: readonly string[],
  skip: readonly string[] = [],
): Finding[] {
  const out: Finding[] = [];
  for (const key of keys) {
    if (skip.includes(key)) continue;
    const answer = answers[key];
    if (!answer || answer.confidence >= THRESHOLDS.minConfidence) continue;
    const detail = `jev is unsure ${UNCERTAIN[key] ?? `about ${key}`}`;
    out.push(
      answer.type === "score"
        ? scoreFinding(key, detail, answer)
        : {
            key,
            detail,
            value: answer.type === "noul" ? answer.noul : 0,
            confidence: answer.confidence,
            as: "probability",
          },
    );
  }
  return out;
}

/** The top rubric level, whatever the rubric's size turns out to be. */
function topLevelMass(answer: ScoreAnswer): number {
  return massAtOrAbove(answer, answer.levels - 1);
}

function tailFinding(key: string, detail: string, answer: ScoreAnswer): Finding {
  return {
    key,
    detail,
    value: topLevelMass(answer),
    confidence: answer.confidence,
    as: "probability",
  };
}

function massFinding(key: string, detail: string, answer: ScoreAnswer, level: number): Finding {
  return {
    key,
    detail,
    value: massAtOrAbove(answer, level),
    confidence: answer.confidence,
    as: "probability",
  };
}

export function decideGuard(answers: Record<string, Answer>, ctx: GuardContext): GuardDecision {
  return ctx.tool === "Bash" ? decideBash(answers, ctx) : decideFile(answers, ctx);
}

function decideBash(answers: Record<string, Answer>, ctx: GuardContext): GuardDecision {
  const t = THRESHOLDS.bash;
  const danger = asScore(answers.danger);
  const systemWide = asNoul(answers.systemWide);
  const escapesProject = asNoul(answers.escapesProject);
  const sendsData = asNoul(answers.sendsData);
  const exfiltrates = asNoul(answers.exfiltrates);
  const irreversible = asNoul(answers.irreversible);
  const pipesRemoteCode = asNoul(answers.pipesRemoteCode);

  // A missing or mistyped answer means we do not actually have a judgement.
  if (
    !danger ||
    !systemWide ||
    !escapesProject ||
    !sendsData ||
    !exfiltrates ||
    !irreversible ||
    !pipesRemoteCode
  ) {
    return failClosed({ type: "malformed", message: "incomplete answer set" }, ctx);
  }

  const deny: Finding[] = [];
  if (topLevelMass(danger) >= t.denyTailMass) {
    // Checked before the mean: a bimodal "harmless or catastrophic" answer
    // averages out to something unremarkable, and the tail is the part that
    // wipes a disk.
    deny.push(tailFinding("dangerTail", "chance this destroys data with no other copy", danger));
  }
  if (scoreAtLeast(danger, t.denyScore, THRESHOLDS.minConfidence)) {
    deny.push(scoreFinding("danger", "destroys data or shared history", danger));
  }
  if (likely(pipesRemoteCode, t.pipesRemoteCode, THRESHOLDS.minConfidence)) {
    deny.push(
      noulFinding("pipesRemoteCode", "runs downloaded code without saving it first", pipesRemoteCode),
    );
  }
  if (likely(exfiltrates, t.exfiltrates, THRESHOLDS.minConfidence)) {
    // Destructiveness misses this one entirely: sending a private key changes
    // nothing on disk, and it is still the worst thing in the list.
    deny.push(noulFinding("exfiltrates", "sends secrets off the machine", exfiltrates));
  }
  if (
    likely(systemWide, t.systemWide, THRESHOLDS.minConfidence) &&
    scoreAtLeast(danger, t.askScore, THRESHOLDS.minConfidence)
  ) {
    // Scope plus destructiveness. Either alone is ordinary; together they are
    // the `rm -rf /` and `chmod -R 777 /` shape.
    deny.push(noulFinding("systemWide", "acts on a whole system or home directory", systemWide));
    deny.push(scoreFinding("danger", "and changes state rather than only reading", danger));
  }
  if (deny.length > 0) return decision("deny", ctx, explain(deny));

  const ask: Finding[] = [];
  // The two readings of `danger` that put a command in front of a human: where
  // its mean sits, and how much of it sits in the band a human should see.
  // Named once, so the "is this settled?" test below cannot drift away from the
  // test that escalates.
  const overAskScore = danger.score >= t.askScore;
  const bandMass = massAtOrAbove(danger, t.askLevel);
  const overAskBand = bandMass >= t.askBandMass;

  if (overAskScore && danger.confidence >= THRESHOLDS.minConfidence) {
    ask.push(scoreFinding("danger", "discards work or changes state outside this process", danger));
  }
  if (topLevelMass(danger) >= t.askTailMass) {
    ask.push(tailFinding("dangerTail", "chance this destroys data with no other copy", danger));
  }
  if (overAskBand) {
    // The tail checks above read the TOP level only, so a distribution split
    // between "ordinary in-project write" and "leaves files a person wrote
    // empty" is invisible to them — the mass never reaches level 3. That is
    // exactly the shape the in-place rewrite commands produced (level 2 at
    // 0.18-0.32, level 3 at 0.03-0.08), so the band is checked on its own.
    ask.push(
      massFinding(
        "dangerBand",
        "chance this destroys work or reaches outside the project",
        danger,
        t.askLevel,
      ),
    );
  }
  if (likely(systemWide, t.systemWide, THRESHOLDS.minConfidence)) {
    ask.push(noulFinding("systemWide", "acts on a whole system or home directory", systemWide));
  }
  if (likely(escapesProject, t.escapesProject, THRESHOLDS.minConfidence)) {
    ask.push(noulFinding("escapesProject", "reaches outside the project", escapesProject));
  }
  if (likely(sendsData, t.sendsData, THRESHOLDS.minConfidence)) {
    ask.push(noulFinding("sendsData", "sends local data to a network host", sendsData));
  }
  if (likely(irreversible, t.irreversible, THRESHOLDS.minConfidence)) {
    ask.push(noulFinding("irreversible", "cannot be undone without a backup", irreversible));
  }
  // Doubt only counts when it straddles the decision. Two cases where it does
  // not, and where prompting anyway is the permission fatigue that makes a
  // guard worth uninstalling:
  //
  //  - `danger` split between "only reads" and "rebuildable" (`npm test`) is
  //    uncertain and still wholly on the allow side of the ask bar, so the
  //    score and tail checks above carry the real signal and the doubt carries
  //    none.
  //  - `irreversible` re-asks what levels 0 and 1 of the `danger` rubric
  //    already settle: nothing changed, or a checkout or a rebuild brings it
  //    back. Under a confident low `danger` it is a question with no subject —
  //    `git status` has nothing to restore, so 0.5 is honesty, not a warning.
  //
  // Both discount DOUBT only. A confident answer on either key still fires
  // through the checks above, and every network and scope key is untouched.
  //
  // The second discount is the branch that opened the hole an adversarial
  // review found. Its stated premise — a low `danger` means nothing changed, or
  // a checkout brings it back — was asserted, never tested against the answer
  // it was discounting. `sed -i '' 's/.*//' src/*.ts` read as a level-1
  // in-project write and answered `irreversible` 0.65-0.75, and the branch
  // threw that away and allowed the command. So it now carries two extra
  // conditions, either of which alone would have caught those commands:
  //
  //   1. Nothing may sit in the ask band. A `danger` with a third of its mass
  //      on "leaves files empty" is not a settled question just because its
  //      mean has not crossed 1.5.
  //   2. The doubt must lean the safe way. Below 0.25 an answer is a confident
  //      no and never reaches this code; between 0.25 and 0.75 it is the model
  //      saying "probably, and I am not sure". "Probably reversible" is worth
  //      discounting under a calm `danger`; "probably NOT reversible" is the
  //      exact sentence a guard exists to escalate, and reading the two as the
  //      same thing is what made an emptied working tree look routine.
  //
  // Condition 1 is written as the negation of the two checks above rather than
  // as its own pair of comparisons: "settled" can then only ever mean "no check
  // above fired", and retuning either bar moves both sides together.
  const settled: string[] = [];
  const calmDanger = !overAskScore && !overAskBand;
  if (calmDanger) {
    // Both readings must sit on the allow side. An expected score above the bar
    // is a risk signal whatever the confidence behind it, so a shaky 2.9 still
    // asks rather than sliding through on its own uncertainty.
    settled.push("danger");
  }
  if (
    danger.confidence >= THRESHOLDS.minConfidence &&
    calmDanger &&
    topLevelMass(danger) < t.askTailMass &&
    irreversible.noul <= t.irreversibleSettled
  ) {
    settled.push("irreversible");
  }
  ask.push(...uncertainFindings(answers, BASH_KEYS, settled));
  if (ask.length > 0) return decision("ask", ctx, explain(ask));

  return decision("allow", ctx, explain([scoreFinding("danger", "reads or changes little", danger)]));
}

/**
 * Does this path hold tests? Deliberately broad — a false positive here only
 * restores the previous (more cautious) behaviour, so erring wide is free.
 */
export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\//.test(p)
  );
}

function decideFile(answers: Record<string, Answer>, ctx: GuardContext): GuardDecision {
  const t = THRESHOLDS.file;
  const blastRadius = asScore(answers.blastRadius);
  const escapesProject = asNoul(answers.escapesProject);
  const destroysContent = asNoul(answers.destroysContent);
  const emptiesFile = asNoul(answers.emptiesFile);
  const removesTests = asNoul(answers.removesTests);
  const addsRemoteExecution = asNoul(answers.addsRemoteExecution);

  if (
    !blastRadius ||
    !escapesProject ||
    !destroysContent ||
    !emptiesFile ||
    !removesTests ||
    !addsRemoteExecution
  ) {
    return failClosed({ type: "malformed", message: "incomplete answer set" }, ctx);
  }

  const deny: Finding[] = [];
  if (topLevelMass(blastRadius) >= t.denyTailMass) {
    deny.push(tailFinding("blastTail", "chance this writes credentials or system config", blastRadius));
  }
  if (scoreAtLeast(blastRadius, t.denyScore, THRESHOLDS.minConfidence)) {
    deny.push(scoreFinding("blastRadius", "writes outside the project or over secrets", blastRadius));
  }
  if (likely(addsRemoteExecution, t.addsRemoteExecution, THRESHOLDS.minConfidence)) {
    deny.push(
      noulFinding("addsRemoteExecution", "adds a way to run code off the network", addsRemoteExecution),
    );
  }
  if (
    likely(escapesProject, t.escapesProject, THRESHOLDS.minConfidence) &&
    likely(destroysContent, t.destroysContent, THRESHOLDS.minConfidence)
  ) {
    // Overwriting a file the project does not own, and that no checkout restores.
    deny.push(noulFinding("escapesProject", "writes outside the project", escapesProject));
    deny.push(noulFinding("destroysContent", "and removes what is already there", destroysContent));
  }
  if (deny.length > 0) return decision("deny", ctx, explain(deny));

  const ask: Finding[] = [];
  if (scoreAtLeast(blastRadius, t.askScore, THRESHOLDS.minConfidence)) {
    ask.push(scoreFinding("blastRadius", "changes how the project builds, deploys, or runs", blastRadius));
  }
  if (topLevelMass(blastRadius) >= t.askTailMass) {
    ask.push(tailFinding("blastTail", "chance this writes credentials or system config", blastRadius));
  }
  if (likely(escapesProject, t.escapesProject, THRESHOLDS.minConfidence)) {
    ask.push(noulFinding("escapesProject", "writes outside the project", escapesProject));
  }
  if (
    likely(destroysContent, t.destroysContent, THRESHOLDS.minConfidence) &&
    likely(emptiesFile, t.emptiesFile, THRESHOLDS.minConfidence)
  ) {
    // Deleting a module by writing nothing over it. `blastRadius` cannot see
    // this and is right not to: it grades what the file CONTROLS, and an
    // ordinary source file controls nothing, so it answers 0.00 at full
    // confidence whether the write rewrites the file or erases it. Before this
    // pair reached the ask path, `destroysContent` was consulted in the deny
    // path only, conjoined with `escapesProject` — so a 0.95 answer on a file
    // inside the project could not change the verdict at all, and a `Write` of
    // "" over a source module was allowed.
    //
    // Both halves are needed. `destroysContent` alone is true of every `Write`
    // to an existing file, which is why asking on it was rejected: it would
    // prompt on every rewrite. `emptiesFile` is what separates the rewrite from
    // the deletion.
    ask.push(noulFinding("emptiesFile", "leaves the file empty", emptiesFile));
    ask.push(noulFinding("destroysContent", "and discards what it held", destroysContent));
  }
  if (likely(removesTests, t.removesTests, THRESHOLDS.minConfidence)) {
    // Tests are the only thing telling the agent it is wrong, so removing them
    // is a human decision even when the write itself is small.
    ask.push(noulFinding("removesTests", "deletes or weakens tests", removesTests));
  }
  // Doubt about `removesTests` is settled deterministically when the target is
  // not a test file: you cannot remove tests from a file that holds none, so an
  // uncertain answer there is an unanswerable question, not an unresolved risk.
  //
  // Measured: in one ordinary sonnet coding session, 5 of 16 guard decisions
  // were asks and every one of them was "jev is unsure whether this removes
  // existing tests" on a non-test file. That is pure permission fatigue — it
  // buys no safety and trains the user to approve reflexively.
  const settledFile = isTestPath(ctx.subject) ? [] : ["removesTests"];

  // `destroysContent` never acts alone: it only contributes conjoined with
  // `escapesProject` (deny) or `emptiesFile` (ask). When BOTH partners are
  // confidently false the conjunctions cannot fire whatever `destroysContent`
  // turns out to be, so doubt about it cannot change the verdict — and an
  // answer that cannot change the verdict must not manufacture a prompt.
  //
  // It is true of nearly every `Write` to an existing file, so it is uncertain
  // often: it accounted for the remaining 3 asks in an ordinary coding session
  // after the `removesTests` fix, all on routine edits.
  const partnersQuiet =
    escapesProject.confidence >= THRESHOLDS.minConfidence &&
    escapesProject.noul < t.escapesProject &&
    emptiesFile.confidence >= THRESHOLDS.minConfidence &&
    emptiesFile.noul < t.emptiesFile;
  if (partnersQuiet) settledFile.push("destroysContent");
  ask.push(...uncertainFindings(answers, FILE_KEYS, settledFile));
  if (ask.length > 0) return decision("ask", ctx, explain(ask));

  return decision(
    "allow",
    ctx,
    explain([scoreFinding("blastRadius", "ordinary project file", blastRadius)]),
  );
}
