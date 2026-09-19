import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noulConfidence } from "../../src/core/decide.js";
import { resetConfigCache } from "../../src/core/config.js";
import type { JevFailure, NoulAnswer, ScoreAnswer, StopPayload } from "../../src/core/types.js";
import {
  decideDone,
  failOpen,
  toSignals,
  turnKey,
  type DoneContext,
  type DoneSignals,
} from "../../src/capabilities/done/decide.js";
import { done, hasIntervened, recordIntervention } from "../../src/capabilities/done/handler.js";
import { limits, thresholds } from "../../src/capabilities/done/questions.js";
import type { CommandRun } from "../../src/capabilities/done/transcript.js";
import { parseTranscript, readTranscript } from "../../src/capabilities/done/transcript.js";
import {
  changedFiles,
  invocationKinds,
  parseCommand,
  ranNoCommand,
  ranNothingExecutable,
  unsupportedClaims,
  sweptAfterLastEdit,
  verificationRan,
  VERIFICATIONS,
  type Verification,
} from "../../src/capabilities/done/verification.js";

const noulOf = (p: number): NoulAnswer => ({
  type: "noul",
  noul: p,
  confidence: noulConfidence(p),
});

/** Confidently true / confidently false, comfortably past every threshold. */
const YES = noulOf(0.95);
const NO = noulOf(0.03);

const context = (overrides: Partial<DoneContext> = {}): DoneContext => ({
  alreadyIntervened: false,
  transcriptAvailable: true,
  originalRequest: "add a slugify helper and test it",
  commandsRun: [{ tool: "Edit", command: "src/text.ts", status: "ok" }],
  ...overrides,
});

/** No gap anywhere, and nothing excuses the stop either — the quiet baseline. */
const quiet: DoneSignals = {
  claimsComplete: YES,
  claimsTestsPassed: NO,
  claimsBuildPassed: NO,
  claimsTypecheckPassed: NO,
  claimsLintPassed: NO,
  leavesStubs: NO,
  namesUndoneWork: NO,
  leavesRequestUnaddressed: NO,
  explainsWhatIsMissing: NO,
  userLimitedScope: NO,
};

const shell = (command: string, status: CommandRun["status"] = "ok"): CommandRun => ({
  tool: "Bash",
  command,
  status,
});

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "jev-done-test-"));
  process.env.JEV_STATE_DIR = join(workspace, "state");
  // No key and no config file: `ask` fails with `no_api_key` instead of
  // reaching the network, which is exactly the fail-open path we want to prove.
  delete process.env.TYPESAFE_API_KEY;
  process.env.JEV_CONFIG_PATH = join(workspace, "no-such-config.json");
  resetConfigCache();
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("the sweep gate is opt-in", () => {
  // Measured: on a task sonnet handles correctly the gate fired in 6 of 8 runs
  // and added 35% wall-clock to catch nothing. The mechanism is sound (it
  // caught 2 of 2 real incomplete sweeps on replay) but default-on it costs
  // more than it returns, so it ships off and is documented for the case it
  // was built for: large mechanical refactors.
  const sweepContext = (verify: boolean) => ({
    alreadyIntervened: false,
    transcriptAvailable: true,
    originalRequest: "rename audit to take an area argument at every call site",
    commandsRun: [
      { tool: "Edit", command: "src/a.ts", status: "ok" },
      { tool: "Bash", command: "npx tsc --noEmit", status: "ok" },
    ],
    verifySweepClaims: verify,
  }) as never;

  const claimed = { ...quiet, claimsExhaustiveChange: YES } as never;

  it("stays silent when not enabled, even on an unverified sweep claim", () => {
    expect(decideDone(claimed, sweepContext(false))).toEqual({ kind: "none" });
  });

  it("blocks the same turn once enabled", () => {
    expect(decideDone(claimed, sweepContext(true))).toMatchObject({ kind: "blockStop" });
  });
});

describe("unverified sweep claims", () => {
  // A universal claim about code — "every call site", "all usages" — asserts
  // something about files the agent cannot all see at once. Only a search run
  // AFTER the last edit turns it into knowledge.
  //
  // Measured on a 19-site rename sonnet got wrong 38% of the time: every
  // failing run verified its own edits (tests, typecheck, `git diff`) and never
  // searched for what it had missed; the run that found all 19 searched for
  // both the direct symbol and its local alias.
  const bash = (command: string) => ({ tool: "Bash", command, status: "ok" }) as never;
  const edit = (file: string) => ({ tool: "Edit", command: file, status: "ok" }) as never;

  it("counts a recursive tree search after the last edit", () => {
    expect(sweptAfterLastEdit([edit("a.ts"), bash("grep -rn 'audit(' src")])).toBe(true);
  });

  it("counts the Grep and Glob tools", () => {
    expect(sweptAfterLastEdit([edit("a.ts"), { tool: "Grep", command: "audit(", status: "ok" } as never])).toBe(true);
    expect(sweptAfterLastEdit([edit("a.ts"), { tool: "Glob", command: "**/*.ts", status: "ok" } as never])).toBe(true);
  });

  it("does not count verifying your own edits", () => {
    // Exactly what the failing runs did: prove the change works, never look for
    // what was missed.
    const after = [edit("a.ts"), bash("npx tsc --noEmit"), bash("node --test"), bash("git diff --stat")];
    expect(sweptAfterLastEdit(after)).toBe(false);
  });

  it("does not count a lookup inside one already-known file", () => {
    // `cat package.json | grep scripts` reads a file the agent already had; it
    // is not a sweep of the tree, and treating it as one would silence the gate.
    expect(sweptAfterLastEdit([edit("a.ts"), bash("cat package.json | grep -A5 scripts")])).toBe(false);
  });

  it("does not count a search that happened BEFORE the last edit", () => {
    // The ordering is the whole point: a sweep only supports the claim if it
    // came after the final change.
    expect(sweptAfterLastEdit([bash("grep -rn 'audit(' src"), edit("a.ts")])).toBe(false);
  });

  it("is vacuously satisfied when nothing was edited", () => {
    expect(sweptAfterLastEdit([bash("ls")])).toBe(true);
  });
});

describe("direct test-file invocations count as a test run", () => {
  // Found by replaying a real sonnet session: the agent ran
  // `node --experimental-strip-types tests/money.test.js`, which genuinely
  // executes the suite, and the matcher did not recognise it. `done` then told
  // the agent it had never run the tests moments after it had — a false block
  // that costs turns, which is the expensive direction for this capability.
  const ran = (command: string) =>
    verificationRan([{ tool: "Bash", command, failed: false } as never], "test");

  it.each([
    "node --test",
    "node --test tests/money.test.js",
    "node --experimental-strip-types tests/money.test.js",
    "node tests/money.test.js",
    "npx tsx tests/money.test.js",
    "bun test/foo.spec.ts",
  ])("counts %s", (command) => {
    expect(ran(command)).toBe(true);
  });

  it.each([
    // Inspecting a spec file is not running it.
    "cat tests/money.test.js",
    "grep -rn multiply tests/money.test.js",
    // Running ordinary code is not running the suite — this is the boundary
    // that keeps the fix from turning into a false negative on the other side.
    "node dist/cli.js doctor",
    "node scripts/build.js",
  ])("does not count %s", (command) => {
    expect(ran(command)).toBe(false);
  });
});

describe("invariant 1: fail open", () => {
  const failures: Array<[string, JevFailure]> = [
    ["no_api_key", { type: "no_api_key" }],
    ["timeout", { type: "timeout", ms: 2500 }],
    ["disabled", { type: "disabled" }],
    ["too_large", { type: "too_large", bytes: 999_999 }],
    ["api_error", { type: "api_error", status: 500, message: "boom" }],
    ["malformed", { type: "malformed", message: "no answers field" }],
  ];

  it.each(failures)("allows the stop on a %s failure", (_name, failure) => {
    // A judge that cannot judge must never be able to trap the turn.
    expect(failOpen(failure)).toEqual({ kind: "none" });
  });

  it("allows the stop when the handler has no API key at all", async () => {
    const result = await done({
      hook_event_name: "Stop",
      session_id: "fail-open-session",
      cwd: workspace,
      prompt_id: "fail-open-turn",
      last_assistant_message: "All tests pass.",
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("allows the stop when the message is empty, without asking anything", async () => {
    const result = await done({
      hook_event_name: "Stop",
      session_id: "empty-session",
      cwd: workspace,
      last_assistant_message: "   ",
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("allows the stop when the payload is malformed", async () => {
    const result = await done({ hook_event_name: "Stop" } as unknown as StopPayload);
    expect(result).toEqual({ kind: "none" });
  });
});

describe("invariant 2: at most one intervention per turn", () => {
  const gaps: DoneSignals = { ...quiet, claimsTestsPassed: YES, leavesStubs: YES };

  it("blocks the first stop of a turn when Jev reports gaps", () => {
    const result = decideDone(gaps, context({ alreadyIntervened: false }));
    expect(result).toMatchObject({ kind: "blockStop" });
  });

  it("allows a second stop in the SAME turn even when the gaps are unchanged", () => {
    // Without this, a disagreement between Jev and the model never terminates.
    expect(decideDone(gaps, context({ alreadyIntervened: true }))).toEqual({ kind: "none" });
  });

  it("keys the budget on prompt_id, so a new turn gets a fresh budget", () => {
    const first = turnKey("prompt-a", "any request");
    const second = turnKey("prompt-b", "any request");
    expect(first).not.toBe(second);

    recordIntervention("session-1", first);
    expect(hasIntervened("session-1", first)).toBe(true);
    expect(hasIntervened("session-1", second)).toBe(false);
  });

  it("isolates the budget per session", () => {
    const key = turnKey("shared-prompt", "");
    recordIntervention("session-a", key);
    expect(hasIntervened("session-a", key)).toBe(true);
    expect(hasIntervened("session-b", key)).toBe(false);
  });

  it("overwrites the stored key rather than accumulating turns", () => {
    const older = turnKey("prompt-old", "");
    const newer = turnKey("prompt-new", "");
    recordIntervention("session-roll", older);
    recordIntervention("session-roll", newer);
    expect(hasIntervened("session-roll", newer)).toBe(true);
    expect(hasIntervened("session-roll", older)).toBe(false);
  });

  it.each([
    ["prompt_id when present", "prompt-x", "request text", "prompt-x"],
    ["prompt_id regardless of the request", "prompt-x", "a different request", "prompt-x"],
  ])("prefers %s", (_name, promptId, request, expected) => {
    expect(turnKey(promptId, request)).toBe(`p:${expected}`);
  });

  it("falls back to the request text, which does not change mid-turn", () => {
    // A count of commands run WOULD change as the agent works, handing every
    // Stop a fresh budget. The request text cannot.
    expect(turnKey(undefined, "fix the parser")).toBe(turnKey(undefined, "  fix the parser  "));
    expect(turnKey(undefined, "fix the parser")).not.toBe(turnKey(undefined, "fix the printer"));
    expect(turnKey("", "fix the parser")).toBe(turnKey(undefined, "fix the parser"));
  });

  it("uses one stable key when neither a prompt id nor a request is known", () => {
    // One intervention per session is the conservative reading of "unknown".
    expect(turnKey(undefined, "")).toBe(turnKey(undefined, "   "));
  });
});

describe("decideDone", () => {
  it("allows a stop with no signal above threshold", () => {
    expect(decideDone(quiet, context())).toEqual({ kind: "none" });
  });

  it("allows a stop when every answer is missing", () => {
    expect(decideDone({}, context())).toEqual({ kind: "none" });
  });

  it.each([
    ["an unverified test claim", { claimsTestsPassed: YES }, /run the check and report the real output/i],
    ["a leftover stub", { leavesStubs: YES }, /placeholders or unimplemented pieces/i],
    ["named undone work", { namesUndoneWork: YES }, /named work the user asked for/i],
    [
      "a skipped part of the request",
      { leavesRequestUnaddressed: YES },
      /still unaddressed/i,
    ],
  ])("blocks on %s with an actionable reason", (_name, signals, pattern) => {
    const result = decideDone({ ...quiet, ...signals }, context());
    expect(result.kind).toBe("blockStop");
    if (result.kind !== "blockStop") return;
    expect(result.reason).toMatch(pattern);
    // The reason is fed back as an instruction, so it cites the evidence too.
    expect(result.reason).toMatch(/jev:/);
  });

  it("names every gap it found, not just the first", () => {
    const result = decideDone({ ...quiet, leavesStubs: YES, namesUndoneWork: YES }, context());
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(/placeholders/i);
    expect(result.reason).toMatch(/named work the user asked for/i);
  });

  it("points out when the turn ran no command at all", () => {
    const result = decideDone({ ...quiet, claimsTestsPassed: YES }, context({ commandsRun: [] }));
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(/ran no command at all/i);
  });

  it("does not claim 'no command at all' when commands ran but none matched", () => {
    const result = decideDone(
      { ...quiet, claimsTestsPassed: YES },
      context({ commandsRun: [shell("git status")] }),
    );
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(/no command in this turn produced that result/i);
  });

  it("does not fire on a probability below the threshold", () => {
    // p = 0.7 gives confidence 0.4, under both bars for a gap.
    const weak = noulOf(0.7);
    expect(thresholds.leavesStubs.probability).toBeGreaterThan(weak.noul);
    expect(decideDone({ ...quiet, leavesStubs: weak }, context())).toEqual({ kind: "none" });
  });

  it("does not fire on a coin-flip answer", () => {
    expect(decideDone({ ...quiet, claimsTestsPassed: noulOf(0.5) }, context())).toEqual({
      kind: "none",
    });
  });

  it("drops the unverified-claim signal when there is no transcript evidence", () => {
    // Without the transcript we cannot know what ran, so "you never ran it" is
    // a guess, not a finding.
    expect(
      decideDone({ ...quiet, claimsTestsPassed: YES }, context({ transcriptAvailable: false })),
    ).toEqual({ kind: "none" });
  });

  it("still catches message-only gaps when the transcript is unreadable", () => {
    const result = decideDone(
      { ...quiet, leavesStubs: YES },
      context({ transcriptAvailable: false, originalRequest: "", commandsRun: [] }),
    );
    expect(result).toMatchObject({ kind: "blockStop" });
  });
});

describe("the claim-to-command join", () => {
  // The correlation that used to live inside one compound question. Jev now
  // only reads the message; these branches are decided in code.

  it.each([
    ["claimsTestsPassed" as const, "npx vitest run tests/text.test.ts"],
    ["claimsBuildPassed" as const, "npm run build"],
    ["claimsTypecheckPassed" as const, "npx tsc --noEmit"],
    ["claimsLintPassed" as const, "npm run lint"],
  ])("allows %s when a matching command succeeded", (key, command) => {
    expect(
      decideDone({ ...quiet, [key]: YES }, context({ commandsRun: [shell(command)] })),
    ).toEqual({ kind: "none" });
  });

  it.each([
    ["claimsTestsPassed" as const, "npm run build", /the tests passed/],
    ["claimsBuildPassed" as const, "npm test", /the build succeeded/],
    ["claimsLintPassed" as const, "npm test", /the lint check passed/],
  ])("blocks %s when only an unrelated command ran", (key, command, phrase) => {
    const result = decideDone({ ...quiet, [key]: YES }, context({ commandsRun: [shell(command)] }));
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(phrase);
  });

  it("blocks when the matching command FAILED", () => {
    // The evidence contradicts the claim rather than merely missing.
    const result = decideDone(
      { ...quiet, claimsBuildPassed: YES },
      context({ commandsRun: [shell("npm run build", "failed")] }),
    );
    expect(result).toMatchObject({ kind: "blockStop" });
  });

  it("allows when a failed run is superseded by a later successful one", () => {
    expect(
      decideDone(
        { ...quiet, claimsTestsPassed: YES },
        context({
          commandsRun: [shell("npm test -- auth", "failed"), shell("npm test -- auth")],
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("cites every unsupported claim in one reason", () => {
    const result = decideDone(
      { ...quiet, claimsTestsPassed: YES, claimsLintPassed: YES },
      context({ commandsRun: [] }),
    );
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(/the tests passed and the lint check passed/);
  });

  it("is not excused by a reason for missing work: a false claim stays false", () => {
    // The suppressors cover judgement gaps only. "I could not reach Redis" does
    // not make "the tests pass" true.
    expect(
      decideDone(
        { ...quiet, claimsTestsPassed: YES, explainsWhatIsMissing: YES, userLimitedScope: YES },
        context({ commandsRun: [] }),
      ),
    ).toMatchObject({ kind: "blockStop" });
  });
});

describe("question polarity", () => {
  it("reads a HIGH leavesRequestUnaddressed as the gap", () => {
    // The negative reframing of `addressesRequest`. High means work is missing.
    const result = decideDone({ ...quiet, leavesRequestUnaddressed: YES }, context());
    expect(result).toMatchObject({ kind: "blockStop" });
    if (result.kind !== "blockStop") return;
    expect(result.reason).toMatch(/still unaddressed/i);
  });

  it("does NOT invert leavesRequestUnaddressed: a confident LOW is a finished turn", () => {
    // The bug this guards against: a positively framed `addressesRequest` read
    // by a uniform "high is bad" rule blocks every completed turn instead.
    const result = decideDone({ ...quiet, leavesRequestUnaddressed: NO }, context());
    expect(result).toEqual({ kind: "none" });
    expect(NO.confidence).toBeGreaterThan(thresholds.leavesRequestUnaddressed.minConfidence);
  });

  it("requires a completion claim before the unaddressed-request gap counts", () => {
    const result = decideDone(
      { ...quiet, claimsComplete: NO, leavesRequestUnaddressed: YES },
      context(),
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("requires a recovered request before the unaddressed-request gap counts", () => {
    const result = decideDone(
      { ...quiet, leavesRequestUnaddressed: YES },
      context({ originalRequest: "   " }),
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("does NOT gate namesUndoneWork on a completion claim", () => {
    // A turn that says "I still need to wire this up" does not read as
    // complete, and that is exactly the turn worth catching.
    expect(
      decideDone({ ...quiet, claimsComplete: NO, namesUndoneWork: YES }, context()),
    ).toMatchObject({ kind: "blockStop" });
  });

  it.each([
    ["userLimitedScope" as const],
    ["explainsWhatIsMissing" as const],
  ])("treats %s as a suppressor: a HIGH value allows the stop", (key) => {
    const result = decideDone(
      { ...quiet, [key]: YES, namesUndoneWork: YES, leavesRequestUnaddressed: YES },
      context(),
    );
    expect(result).toEqual({ kind: "none" });
  });

  it.each([
    ["userLimitedScope" as const],
    ["explainsWhatIsMissing" as const],
  ])("does NOT invert %s: a LOW value suppresses nothing", (key) => {
    expect(decideDone({ ...quiet, [key]: NO }, context())).toEqual({ kind: "none" });
    expect(decideDone({ ...quiet, [key]: NO, namesUndoneWork: YES }, context())).toMatchObject({
      kind: "blockStop",
    });
  });

  it.each([
    ["userLimitedScope" as const],
    ["explainsWhatIsMissing" as const],
  ])("suppresses on %s at a bare majority, because allowing is the cheap mistake", (key) => {
    // A hair over the bar rather than exactly on it: |p - 0.5| * 2 is not
    // exact in binary, so p = 0.6 derives a confidence a few ulps under 0.2.
    const marginal = noulOf(thresholds[key].probability + 0.01);
    expect(marginal.noul).toBeLessThan(0.7);
    expect(
      decideDone({ ...quiet, [key]: marginal, namesUndoneWork: YES }, context()),
    ).toEqual({ kind: "none" });
  });

  it("leaves a stub finding standing even when the stop is excused", () => {
    // Placeholders are evidence in the message itself, not a judgement about
    // whether stopping was reasonable.
    expect(
      decideDone({ ...quiet, userLimitedScope: YES, leavesStubs: YES }, context()),
    ).toMatchObject({ kind: "blockStop" });
  });
});

describe("verificationRan", () => {
  it.each([
    ["test", "npm test"],
    ["test", "npm test -- users"],
    ["test", "pnpm run test"],
    ["test", "npx vitest run tests/text.test.ts"],
    ["test", "pytest tests/test_date.py"],
    ["test", "go test ./..."],
    ["test", "cargo test"],
    ["build", "npm run build"],
    ["build", "yarn build"],
    ["build", "cargo build --release"],
    ["build", "vite build"],
    ["typecheck", "npx tsc --noEmit"],
    ["typecheck", "npm run typecheck"],
    ["typecheck", "mypy src"],
    ["lint", "npm run lint"],
    ["lint", "npx eslint src --fix"],
    ["lint", "ruff check ."],
    ["lint", "cargo clippy"],
  ] as Array<[Verification, string]>)("matches %s for `%s`", (kind, command) => {
    expect(verificationRan([shell(command)], kind)).toBe(true);
  });

  it.each([
    ["test", "npm run build"],
    ["test", "git status"],
    ["lint", "npm test"],
    ["typecheck", "npm test"],
  ] as Array<[Verification, string]>)("does not match %s for `%s`", (kind, command) => {
    expect(verificationRan([shell(command)], kind)).toBe(false);
  });

  it("treats a type check as enough to back a 'it compiles' claim", () => {
    // `tsc --noEmit` really does compile. Both directions, because a
    // successful build also proves the types resolve.
    expect(verificationRan([shell("npx tsc --noEmit")], "build")).toBe(true);
    expect(verificationRan([shell("npm run build")], "typecheck")).toBe(true);
  });

  it.each(VERIFICATIONS)("accepts an umbrella script for %s", (kind) => {
    expect(verificationRan([shell("npm run ci")], kind)).toBe(true);
    expect(verificationRan([shell("pre-commit run --all-files")], kind)).toBe(true);
  });

  it("ignores a FAILED run", () => {
    expect(verificationRan([shell("npm test", "failed")], "test")).toBe(false);
  });

  it("accepts a run whose result never arrived, because accusing is the costly mistake", () => {
    expect(verificationRan([shell("npm test", "unknown")], "test")).toBe(true);
  });

  it("does not read a file path as a command", () => {
    // `Edit` records a path. Without this, `tests/text.test.ts` would satisfy
    // a claim that the tests ran.
    const edits: CommandRun[] = [
      { tool: "Edit", command: "tests/text.test.ts", status: "ok" },
      { tool: "Read", command: "src/build/lint.ts", status: "ok" },
    ];
    for (const kind of VERIFICATIONS) expect(verificationRan(edits, kind)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(verificationRan([shell("NPM TEST")], "test")).toBe(true);
  });

  it("reports no support for an empty command list", () => {
    for (const kind of VERIFICATIONS) expect(verificationRan([], kind)).toBe(false);
  });
});

describe("vouching for behaviour nothing observed", () => {
  // The gap the claim-to-command join cannot see: a message that names no
  // check at all and simply asserts that the code works.

  const edited: CommandRun[] = [{ tool: "Edit", command: "src/retry.ts", status: "ok" }];
  const vouching: DoneSignals = { ...quiet, vouchesForBehaviour: YES };

  it("blocks an edit-only turn that reports the code works", () => {
    const result = decideDone(vouching, context({ commandsRun: edited }));
    expect(result.kind).toBe("blockStop");
    if (result.kind !== "blockStop") return;
    expect(result.reason).toMatch(/nothing in this turn ran it/i);
  });

  it.each([
    ["nothing was edited", [{ tool: "Read", command: "src/core/decide.ts", status: "ok" }]],
    ["the turn ran the code", [...edited, { tool: "Bash", command: "node dist/cli.js doctor", status: "ok" }]],
    ["the turn ran a script", [...edited, { tool: "Bash", command: "./scripts/smoke.sh", status: "ok" }]],
    ["the turn ran the tests", [...edited, { tool: "Bash", command: "npm test", status: "ok" }]],
    ["the turn started a container", [...edited, { tool: "Bash", command: "docker compose up -d", status: "ok" }]],
  ] as Array<[string, CommandRun[]]>)("allows the stop when %s", (_name, commands) => {
    expect(decideDone(vouching, context({ commandsRun: commands }))).toEqual({ kind: "none" });
  });

  it("allows a turn whose commands only READ files", () => {
    // Reading is not observing behaviour, so the signal still applies.
    const result = decideDone(
      vouching,
      context({ commandsRun: [...edited, shell("grep -rn retry src"), shell("cat src/retry.ts")] }),
    );
    expect(result).toMatchObject({ kind: "blockStop" });
  });

  it.each([
    ["userLimitedScope" as const],
    ["explainsWhatIsMissing" as const],
  ])("is suppressed by %s", (key) => {
    expect(
      decideDone({ ...vouching, [key]: YES }, context({ commandsRun: edited })),
    ).toEqual({ kind: "none" });
  });

  it("requires a completion claim", () => {
    expect(
      decideDone({ ...vouching, claimsComplete: NO }, context({ commandsRun: edited })),
    ).toEqual({ kind: "none" });
  });

  it("stays silent when the message names a check, which the join already owns", () => {
    // Otherwise every unverified claim would be reported twice, in two voices.
    const result = decideDone(
      { ...vouching, claimsTestsPassed: YES },
      context({ commandsRun: edited }),
    );
    if (result.kind !== "blockStop") throw new Error("expected a block");
    expect(result.reason).toMatch(/run the check and report the real output/i);
    expect(result.reason).not.toMatch(/nothing in this turn ran it/i);
  });

  it("stays silent when a named check really did run", () => {
    expect(
      decideDone(
        { ...vouching, claimsTestsPassed: YES },
        context({ commandsRun: [...edited, shell("npm test")] }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("needs transcript evidence, because 'nothing ran' would otherwise be a guess", () => {
    expect(
      decideDone(vouching, context({ transcriptAvailable: false, commandsRun: [] })),
    ).toEqual({ kind: "none" });
  });

  it("does not fire on a merely descriptive message", () => {
    expect(decideDone(quiet, context({ commandsRun: edited }))).toEqual({ kind: "none" });
  });
});

describe("changedFiles and ranNothingExecutable", () => {
  it.each([
    ["an edit", [{ tool: "Edit", command: "src/a.ts", status: "ok" }], true],
    ["a write", [{ tool: "Write", command: "src/a.ts", status: "ok" }], true],
    ["a read", [{ tool: "Read", command: "src/a.ts", status: "ok" }], false],
    ["a command", [{ tool: "Bash", command: "npm test", status: "ok" }], false],
    ["nothing", [], false],
  ] as Array<[string, CommandRun[], boolean]>)("changedFiles reports %s as %s", (_n, c, e) => {
    expect(changedFiles(c)).toBe(e);
  });

  it.each([
    ["nothing at all", [], true],
    ["an edit only", [{ tool: "Edit", command: "src/a.ts", status: "ok" }], true],
    ["inspectors only", [{ tool: "Bash", command: "cat src/a.ts | grep foo", status: "ok" }], true],
    ["a git command", [{ tool: "Bash", command: "git status", status: "ok" }], true],
    ["the program itself", [{ tool: "Bash", command: "node dist/cli.js", status: "ok" }], false],
    ["a failed run", [{ tool: "Bash", command: "npm test", status: "failed" }], false],
    // `curl` talks to the running program, so it observed something.
    ["a curl against it", [{ tool: "Bash", command: "curl -s localhost:3000 | jq .", status: "ok" }], false],
  ] as Array<[string, CommandRun[], boolean]>)(
    "ranNothingExecutable reports %s as %s",
    (_n, c, e) => {
      expect(ranNothingExecutable(c)).toBe(e);
    },
  );
});

describe("the join is on an invocation, not a substring", () => {
  // The HIGH-severity defect this suite exists for: a bare tool name matched
  // anywhere in the command string, so a claim was "verified" by a command
  // that never ran a check.

  it.each([
    ["a runner named only as a file argument", "cat jest.config.js"],
    ["a runner named inside a quoted commit message", 'git commit -am "chore: make test helpers reusable"'],
    ["a runner named as a quoted grep pattern", "grep -rn 'vitest' package.json"],
    ["a runner named as an unquoted grep pattern", "grep -rn vitest package.json"],
    ["a runner listed by an inspector", "ls node_modules/.bin"],
    ["a config file paged through", "less vitest.config.ts"],
    ["a test file located by find", "find . -name '*.test.ts'"],
    ["a command quoted into an echo", 'echo "npm test"'],
    ["a runner named in a branch name", "git checkout -b fix/jest-config"],
    ["a runner named in a file being read", "head -50 jest.config.js"],
  ] as Array<[string, string]>)("does not read %s as a test run", (_name, command) => {
    expect(verificationRan([shell(command)], "test")).toBe(false);
  });

  it("does not read the words 'make test' in a commit message as `make test`", () => {
    // `/\bmake\s+tests?\b/` used to match this. The words are prose inside a
    // quoted argument to `git`, which runs no check of any kind.
    const command = 'git commit -am "chore: make test helpers reusable"';
    for (const kind of VERIFICATIONS) expect(verificationRan([shell(command)], kind)).toBe(false);
  });

  it("does not read `cat jest.config.js` as a test run for any claim", () => {
    for (const kind of VERIFICATIONS) {
      expect(verificationRan([shell("cat jest.config.js")], kind)).toBe(false);
    }
  });

  it.each([
    ["npx vitest run", "npx vitest run"],
    ["a path invocation of the runner", "./node_modules/.bin/jest --ci"],
    ["a runner behind a wrapper", "timeout 300 npm test"],
    ["a runner behind env assignments", "TZ=utc CI=1 npm test"],
    ["a runner in the second half of a chain", "cd packages/app && npm test"],
    ["a runner piped into a pager", "npm test 2>&1 | tail -5"],
    ["a runner inside `bash -c`", 'bash -c "npm test"'],
    ["a local test script", "./scripts/run-tests.sh"],
    ["a python module invocation", "python -m pytest tests/"],
    ["a runner after a redirect", "npm test > /tmp/out.log"],
  ] as Array<[string, string]>)("still credits %s", (_name, command) => {
    expect(verificationRan([shell(command)], "test")).toBe(true);
  });

  it("credits a real invocation of the runner the grep case only named", () => {
    // The near-miss control. Same claim, opposite evidence.
    expect(verificationRan([shell("npx vitest run")], "test")).toBe(true);
  });
});

describe("umbrella scripts cover only what they plausibly check", () => {
  it.each(VERIFICATIONS)("credits a conventional full gate for %s", (kind) => {
    expect(verificationRan([shell("npm run ci")], kind)).toBe(true);
    expect(verificationRan([shell("pre-commit run --all-files")], kind)).toBe(true);
    expect(verificationRan([shell("npm run precommit")], kind)).toBe(true);
  });

  it.each([
    ["npm run verify"],
    ["npm run check"],
    ["npm run validate"],
    ["make check"],
  ])("credits %s with the static checks only", (command) => {
    // A script whose name says "check something" plausibly runs lint and types.
    // Reading it as a passing TEST SUITE and a green BUILD as well let one
    // vague command whitewash four separate reported results.
    expect(verificationRan([shell(command)], "lint")).toBe(true);
    expect(verificationRan([shell(command)], "typecheck")).toBe(true);
    expect(verificationRan([shell(command)], "test")).toBe(false);
  });

  it("does not read `npm ci` as an umbrella, because it is an install", () => {
    for (const kind of VERIFICATIONS) expect(verificationRan([shell("npm ci")], kind)).toBe(false);
  });

  it("keeps a named category ahead of an umbrella name", () => {
    expect(verificationRan([shell("npm run test:ci")], "test")).toBe(true);
    expect(verificationRan([shell("npm run test:ci")], "build")).toBe(false);
  });
});

describe("parseCommand", () => {
  it("drops quoted text from the arguments it will match on", () => {
    const [inv] = parseCommand('git commit -m "run the tests"');
    expect(inv).toEqual({ exe: "git", path: false, args: ["commit", "-m"] });
  });

  it("splits a chain into one invocation per program", () => {
    expect(parseCommand("npm run lint && npm test | tee out.log").map((i) => i.exe)).toEqual([
      "npm",
      "npm",
      "tee",
    ]);
  });

  it("drops the filename a redirection writes to", () => {
    expect(parseCommand("npm test > jest.log").map((i) => i.exe)).toEqual(["npm"]);
  });

  it("reduces an executable to its basename and records that it was a path", () => {
    expect(parseCommand("./node_modules/.bin/eslint src")).toEqual([
      { exe: "eslint", path: true, args: ["src"] },
    ]);
  });

  it("unwraps runners so the real program is what gets matched", () => {
    expect(parseCommand("npx --yes vitest run")[0]?.exe).toBe("vitest");
    expect(parseCommand("pnpm exec tsc --noEmit")[0]?.exe).toBe("tsc");
    expect(parseCommand("poetry run pytest")[0]?.exe).toBe("pytest");
    expect(parseCommand("sudo -E env timeout 30 npm test")[0]?.exe).toBe("npm");
  });

  it("returns nothing for an empty or blank command", () => {
    expect(parseCommand("")).toEqual([]);
    expect(parseCommand("   ")).toEqual([]);
  });

  it("does not throw on an unbalanced quote", () => {
    expect(() => parseCommand("echo 'unterminated")).not.toThrow();
    expect(() => parseCommand('grep "also unterminated src')).not.toThrow();
  });
});

describe("invocationKinds", () => {
  it.each([
    ["npm test", ["test"]],
    ["npm run build", ["build"]],
    ["npm ci", []],
    ["yarn build", ["build"]],
    ["npm build", []],
    ["cargo clippy", ["lint"]],
    ["go vet ./...", ["typecheck"]],
    ["make", ["build"]],
    ["make lint", ["lint"]],
    ["cat jest.config.js", []],
    ["prettier src", []],
    ["prettier --check src", ["lint"]],
    ["node --test", ["test"]],
    ["node scripts/jest-runner.js", []],
  ] as Array<[string, Verification[]]>)("reads `%s` as %s", (command, expected) => {
    const kinds = parseCommand(command).flatMap((inv) => invocationKinds(inv));
    expect(kinds.sort()).toEqual([...expected].sort());
  });
});

describe("unsupportedClaims", () => {
  it("returns only the claims no command backs", () => {
    expect(unsupportedClaims([shell("npm test")], ["test", "lint"])).toEqual(["lint"]);
  });

  it("returns nothing when nothing was claimed", () => {
    expect(unsupportedClaims([], [])).toEqual([]);
  });

  it("returns every claim when the turn ran nothing", () => {
    expect(unsupportedClaims([], [...VERIFICATIONS])).toEqual([...VERIFICATIONS]);
  });
});

describe("ranNoCommand", () => {
  it.each([
    ["an empty list", [], true],
    ["file edits only", [{ tool: "Edit", command: "src/a.ts", status: "ok" }], true],
    ["a shell command", [{ tool: "Bash", command: "ls", status: "ok" }], false],
  ] as Array<[string, CommandRun[], boolean]>)("reports %s as %s", (_name, commands, expected) => {
    expect(ranNoCommand(commands)).toBe(expected);
  });
});

/** Build a transcript in the JSONL shape Claude Code writes. */
function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const userLine = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content },
  ...extra,
});

const toolUseLine = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const toolResultLine = (id: string, isError: boolean) =>
  userLine([{ type: "tool_result", tool_use_id: id, is_error: isError, content: "output" }]);

describe("parseTranscript", () => {
  it("recovers the request and every command with its status", () => {
    const summary = parseTranscript(
      jsonl([
        userLine("add a slugify helper and test it"),
        toolUseLine("t1", "Edit", { file_path: "src/text.ts" }),
        toolResultLine("t1", false),
        toolUseLine("t2", "Bash", { command: "npm test", description: "run tests" }),
        toolResultLine("t2", true),
      ]),
    );

    expect(summary.available).toBe(true);
    expect(summary.originalRequest).toBe("add a slugify helper and test it");
    expect(summary.commandsRun).toEqual([
      { tool: "Edit", command: "src/text.ts", status: "ok" },
      { tool: "Bash", command: "npm test", status: "failed" },
    ]);
  });

  it("scopes commands to the latest turn only", () => {
    const summary = parseTranscript(
      jsonl([
        userLine("first request"),
        toolUseLine("old", "Bash", { command: "npm test" }),
        toolResultLine("old", false),
        userLine("second request"),
        toolUseLine("new", "Bash", { command: "npm run build" }),
        toolResultLine("new", false),
      ]),
    );
    expect(summary.originalRequest).toBe("second request");
    expect(summary.commandsRun.map((c) => c.command)).toEqual(["npm run build"]);
  });

  it("reads a request given as text blocks rather than a plain string", () => {
    const summary = parseTranscript(
      jsonl([userLine([{ type: "text", text: "rename the module" }])]),
    );
    expect(summary.originalRequest).toBe("rename the module");
  });

  it.each([
    ["a meta entry", { isMeta: true }],
    ["a subagent entry", { isSidechain: true }],
  ])("does not mistake %s for the user's request", (_name, extra) => {
    const summary = parseTranscript(
      jsonl([userLine("the real request"), userLine("injected system note", extra)]),
    );
    expect(summary.originalRequest).toBe("the real request");
  });

  it("does not mistake a tool result for the user's request", () => {
    const summary = parseTranscript(
      jsonl([
        userLine("the real request"),
        toolUseLine("t1", "Bash", { command: "ls" }),
        toolResultLine("t1", false),
      ]),
    );
    expect(summary.originalRequest).toBe("the real request");
  });

  it("marks a command with no result as unknown rather than passing", () => {
    const summary = parseTranscript(
      jsonl([userLine("do a thing"), toolUseLine("t1", "Bash", { command: "npm test" })]),
    );
    expect(summary.commandsRun[0]?.status).toBe("unknown");
  });

  it("falls back to an identifying argument when there is no command", () => {
    const summary = parseTranscript(
      jsonl([userLine("look around"), toolUseLine("t1", "Grep", { pattern: "maxRetries" })]),
    );
    expect(summary.commandsRun[0]).toEqual({
      tool: "Grep",
      command: "maxRetries",
      status: "unknown",
    });
  });

  it("redacts credentials out of the request and the commands", () => {
    const secret = "sk-ant-api03-AbCdEf0123456789xyz";
    const summary = parseTranscript(
      jsonl([
        userLine(`deploy with ${secret}`),
        toolUseLine("t1", "Bash", { command: `curl -H "key: ${secret}"` }),
      ]),
    );
    expect(summary.originalRequest).not.toContain(secret);
    expect(summary.commandsRun[0]?.command).not.toContain(secret);
  });

  it("bounds how many commands it reports, keeping the most recent", () => {
    const lines: unknown[] = [userLine("do many things")];
    const total = limits.maxCommands + 10;
    for (let i = 0; i < total; i++) lines.push(toolUseLine(`t${i}`, "Bash", { command: `step ${i}` }));

    const summary = parseTranscript(jsonl(lines));
    expect(summary.commandsRun).toHaveLength(limits.maxCommands);
    expect(summary.commandsRun[summary.commandsRun.length - 1]?.command).toBe(`step ${total - 1}`);
  });

  it("bounds the length of a single command", () => {
    const summary = parseTranscript(
      jsonl([userLine("go"), toolUseLine("t1", "Bash", { command: "x".repeat(5_000) })]),
    );
    expect((summary.commandsRun[0]?.command ?? "").length).toBeLessThanOrEqual(limits.commandBytes);
  });

  it.each([
    ["an empty string", ""],
    ["blank lines only", "\n\n   \n"],
    ["plain prose", "this is not JSONL at all"],
    ["JSON that is not an object", "[1,2,3]\n\"just a string\"\n42"],
  ])("reports no evidence for %s rather than throwing", (_name, text) => {
    const summary = parseTranscript(text);
    expect(summary.available).toBe(false);
    expect(summary.originalRequest).toBe("");
    expect(summary.commandsRun).toEqual([]);
  });

  it("keeps the good lines around a corrupt one", () => {
    const text =
      '{"type":"user","message":{"role":"user","content":"real request"}}\n' +
      '{"type":"assistant","message":{"role":"assist\n' +
      "not json at all\n" +
      jsonl([toolUseLine("t1", "Bash", { command: "npm test" })]);

    const summary = parseTranscript(text);
    expect(summary.available).toBe(true);
    expect(summary.originalRequest).toBe("real request");
    expect(summary.commandsRun.map((c) => c.command)).toEqual(["npm test"]);
  });

  it("survives entries whose shape is nothing like a message", () => {
    const summary = parseTranscript(
      jsonl([
        { type: "summary", summary: "older session" },
        { type: "user", message: null },
        { type: "assistant", message: { content: "a string, not blocks" } },
        { type: "assistant", message: { content: [null, 7, { type: "tool_use" }] } },
        userLine("still readable"),
      ]),
    );
    expect(summary.available).toBe(true);
    expect(summary.originalRequest).toBe("still readable");
  });
});

describe("readTranscript", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
  ])("reports no evidence when the path is %s", (_name, path) => {
    expect(readTranscript(path)).toMatchObject({ available: false, commandsRun: [] });
  });

  it("reports no evidence when the file does not exist", () => {
    const summary = readTranscript(join(workspace, "nope", "missing.jsonl"));
    expect(summary).toEqual({
      originalRequest: "",
      commandsRun: [],
      available: false,
      truncated: false,
    });
  });

  it("reports no evidence when the path is a directory", () => {
    expect(readTranscript(workspace).available).toBe(false);
  });

  it("reports no evidence for an empty file", () => {
    const path = join(workspace, "empty.jsonl");
    writeFileSync(path, "", "utf8");
    expect(readTranscript(path)).toMatchObject({ available: false, truncated: false });
  });

  it("reads a well-formed transcript from disk", () => {
    const path = join(workspace, "good.jsonl");
    writeFileSync(
      path,
      jsonl([
        userLine("fix the parser"),
        toolUseLine("t1", "Bash", { command: "npm test" }),
        toolResultLine("t1", false),
      ]),
      "utf8",
    );
    const summary = readTranscript(path);
    expect(summary.available).toBe(true);
    expect(summary.originalRequest).toBe("fix the parser");
    expect(summary.commandsRun).toEqual([{ tool: "Bash", command: "npm test", status: "ok" }]);
  });

  it("reads only the tail of an oversized transcript, and says so", () => {
    const path = join(workspace, "huge.jsonl");
    const filler = jsonl(
      Array.from({ length: 4_000 }, (_, i) => userLine(`old request ${i}`, { isMeta: true })),
    );
    expect(Buffer.byteLength(filler, "utf8")).toBeGreaterThan(limits.transcriptBytes);
    writeFileSync(
      path,
      filler + jsonl([userLine("the latest request"), toolUseLine("t1", "Bash", { command: "ls" })]),
      "utf8",
    );

    const summary = readTranscript(path);
    expect(summary.truncated).toBe(true);
    expect(summary.originalRequest).toBe("the latest request");
    expect(summary.commandsRun.map((c) => c.command)).toEqual(["ls"]);
  });

  it("survives a transcript sliced mid-line by the tail read", () => {
    // The first line of a tail read is almost always a fragment.
    const path = join(workspace, "sliced.jsonl");
    const filler = "x".repeat(limits.transcriptBytes) + "\n";
    writeFileSync(path, filler + jsonl([userLine("after the slice")]), "utf8");
    expect(readTranscript(path).originalRequest).toBe("after the slice");
  });
});
