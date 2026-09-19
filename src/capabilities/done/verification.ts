import type { CommandRun } from "./transcript.js";

/**
 * Correlating a verification claim with the commands that ran.
 *
 * This is deliberately CODE, not a question. Jev is a five-second judgement
 * model: it reads one piece of text and reports a probability. Asking it
 * "does the message claim a passing test run *that no entry in commandsRun
 * produced*?" makes it hold two fields of state at once and join them, which
 * is the one thing the model is documented as unable to do.
 *
 * So the split is: Jev reads the message and says WHICH results it claims;
 * this file reads `commandsRun` and says which results were actually produced.
 * Both halves are pure, and the disagreement between them is the finding.
 *
 * The join is on an INVOCATION, never on a substring. A command string is
 * parsed into the programs it actually runs — executable plus arguments, with
 * quoted text discarded — and only the executable and its subcommand can
 * support a claim. Matching a bare tool name anywhere in the string made a
 * claim "verified" by `cat jest.config.js`, by the words "make test" inside a
 * commit message, and by `grep -rn 'vitest' package.json`. None of those ran
 * a check.
 */

/** The kinds of "it passes" claim a closing message can make. */
export type Verification = "test" | "build" | "typecheck" | "lint";

export const VERIFICATIONS: readonly Verification[] = ["test", "build", "typecheck", "lint"];

/** How each kind reads in a sentence addressed to the agent. */
export const VERIFICATION_NOUNS: Record<Verification, string> = {
  test: "the tests passed",
  build: "the build succeeded",
  typecheck: "the type check was clean",
  lint: "the lint check passed",
};

/**
 * Tools whose recorded argument is a shell command.
 *
 * Restricted on purpose. `Edit` records a file path, and a path like
 * `tests/text.test.ts` would otherwise satisfy a claim that the tests ran.
 */
const COMMAND_TOOLS = new Set(["bash", "shell", "terminal", "run_command", "runcommand"]);

/** Tools that write to a file, so the turn actually changed code. */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
  "create_file",
]);

/* -------------------------------------------------------------------------
 * Parsing a command string into the programs it runs.
 * ---------------------------------------------------------------------- */

interface Token {
  text: string;
  /** True when any part of the token came from inside quotes. */
  quoted: boolean;
}

interface Segment {
  tokens: Token[];
  /** True when the segment follows a redirection, so its head is a filename. */
  afterRedirect: boolean;
}

/** One program this command runs. `args` never includes quoted text. */
export interface Invocation {
  /** Basename of the executable, lowercased, with any runner unwrapped. */
  exe: string;
  /** True when the executable was written as a path, e.g. `./scripts/test.sh`. */
  path: boolean;
  /** Unquoted arguments, lowercased, in order. */
  args: string[];
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a command line into segments of tokens.
 *
 * Quoting is honoured because quoted text is DATA, not a program: a commit
 * message, a grep pattern, a `--filter` value. Operators (`&&`, `|`, `;`) end
 * a segment because each side of one is a separate program. A redirection also
 * ends a segment, and the filename that follows it is dropped.
 */
function split(command: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: Token[] = [];
  let text = "";
  let quoted = false;
  let open = false;
  let afterRedirect = false;

  const endToken = (): void => {
    if (!open) return;
    tokens.push({ text, quoted });
    text = "";
    quoted = false;
    open = false;
  };
  const endSegment = (redirect: boolean): void => {
    endToken();
    if (tokens.length > 0) segments.push({ tokens, afterRedirect });
    tokens = [];
    afterRedirect = redirect;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      text += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      quoted = true;
      open = true;
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < command.length) {
        if (command[j] === "\\" && j + 1 < command.length) {
          text += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === '"') break;
        text += command[j];
        j += 1;
      }
      quoted = true;
      open = true;
      i = j < command.length ? j + 1 : command.length;
      continue;
    }

    if (c === "\\" && i + 1 < command.length) {
      text += command[i + 1];
      open = true;
      i += 2;
      continue;
    }

    if (/\s/.test(c)) {
      endToken();
      i += 1;
      continue;
    }

    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      endSegment(false);
      i += 2;
      continue;
    }
    if (pair === ">>" || pair === "2>" || pair === "&>") {
      endSegment(true);
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      endSegment(true);
      i += 1;
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
      endSegment(false);
      i += 1;
      continue;
    }

    text += c;
    open = true;
    i += 1;
  }
  endSegment(false);
  return segments;
}

function basename(value: string): string {
  const parts = value.split(/[/\\]/);
  return (parts[parts.length - 1] ?? value).toLowerCase();
}

/** Prefixes that run another program, so the real executable is further right. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "nice",
  "ionice",
  "nohup",
  "stdbuf",
  "command",
  "exec",
  "timeout",
  "xargs",
  "watch",
  "caffeinate",
]);

/** Package runners whose next non-flag token is the real executable. */
const EXEC_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "dlx"]);

/** Runners whose named subcommand is followed by the real executable. */
const DELEGATES: Record<string, Set<string>> = {
  npm: new Set(["exec"]),
  pnpm: new Set(["exec", "dlx"]),
  yarn: new Set(["exec", "dlx"]),
  bun: new Set(["x"]),
  poetry: new Set(["run"]),
  pipenv: new Set(["run"]),
  uv: new Set(["run", "tool"]),
  rye: new Set(["run"]),
  pdm: new Set(["run"]),
  hatch: new Set(["run"]),
  bundle: new Set(["exec"]),
  rbenv: new Set(["exec"]),
  pyenv: new Set(["exec"]),
  deno: new Set(["run"]),
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

const isFlag = (token: Token): boolean => token.text.startsWith("-");

function skipFlags(tokens: Token[], from: number): number {
  let i = from;
  while (i < tokens.length && isFlag(tokens[i] as Token)) i += 1;
  return i;
}

/** Peel wrappers and runners off a segment until the real program is in hand. */
function peel(tokens: Token[], depth: number): Invocation[] {
  if (depth > 3) return [];

  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test((tokens[start] as Token).text)) start += 1;
  if (start >= tokens.length) return [];

  const head = tokens[start] as Token;
  const exe = basename(head.text);
  const rest = tokens.slice(start + 1);

  // `bash -c "npm test"` really does run the tests, so the quoted script is
  // parsed rather than discarded. Anything else quoted stays data.
  if (SHELLS.has(exe)) {
    const flag = rest.findIndex((t) => t.text === "-c" || t.text === "-lc" || t.text === "-ic");
    const script = flag === -1 ? undefined : rest[flag + 1];
    return script ? parseCommand(script.text, depth + 1) : [];
  }

  if (WRAPPERS.has(exe)) {
    let i = skipFlags(rest, 0);
    // `timeout 60 npm test`, `watch -n 5 ...`: drop a bare duration too.
    while (i < rest.length && /^\d+(\.\d+)?[smhd]?$/.test((rest[i] as Token).text)) {
      i = skipFlags(rest, i + 1);
    }
    return peel(rest.slice(i), depth + 1);
  }

  if (EXEC_RUNNERS.has(exe)) {
    return peel(rest.slice(skipFlags(rest, 0)), depth + 1);
  }

  const delegated = DELEGATES[exe];
  if (delegated) {
    const i = skipFlags(rest, 0);
    const word = rest[i];
    if (word && delegated.has(word.text.toLowerCase())) {
      return peel(rest.slice(skipFlags(rest, i + 1)), depth + 1);
    }
  }

  return [
    {
      exe,
      path: /[/\\]/.test(head.text),
      args: rest.filter((t) => !t.quoted).map((t) => t.text.toLowerCase()),
    },
  ];
}

/** Every program a command string actually invokes. Pure and total. */
export function parseCommand(command: string, depth = 0): Invocation[] {
  const out: Invocation[] = [];
  for (const segment of split(command)) {
    const tokens = segment.afterRedirect ? segment.tokens.slice(1) : segment.tokens;
    if (tokens.length === 0) continue;
    out.push(...peel(tokens, depth));
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Classifying one invocation.
 * ---------------------------------------------------------------------- */

/**
 * Programs that only LOOK at things.
 *
 * Excluded whatever their arguments are, because their arguments are exactly
 * where a runner's name shows up without being run: `cat jest.config.js`,
 * `grep -rn vitest package.json`, `git commit -m "make test helpers"`.
 */
const READ_ONLY = new Set([
  "cat",
  "bat",
  "grep",
  "rg",
  "ag",
  "ack",
  "egrep",
  "fgrep",
  "ls",
  "ll",
  "head",
  "tail",
  "less",
  "more",
  "find",
  "fd",
  "tree",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "diff",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
  "jq",
  "yq",
  "echo",
  "printf",
  "pwd",
  "cd",
  "which",
  "whereis",
  "whoami",
  "type",
  "man",
  "date",
  "sleep",
  "export",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "chown",
  "open",
  "code",
  "vim",
  "nano",
  "tee",
  "git",
  "gh",
  "hg",
  "svn",
]);

/** Executables that are a check all by themselves. */
const EXE_KINDS: Record<string, Verification> = {
  vitest: "test",
  jest: "test",
  mocha: "test",
  ava: "test",
  karma: "test",
  jasmine: "test",
  cypress: "test",
  playwright: "test",
  nightwatch: "test",
  pytest: "test",
  "py.test": "test",
  nose2: "test",
  tox: "test",
  rspec: "test",
  minitest: "test",
  phpunit: "test",
  pest: "test",
  ctest: "test",
  gotestsum: "test",

  tsc: "typecheck",
  mypy: "typecheck",
  pyright: "typecheck",
  pyre: "typecheck",
  flow: "typecheck",

  eslint: "lint",
  tslint: "lint",
  biome: "lint",
  oxlint: "lint",
  standard: "lint",
  xo: "lint",
  ruff: "lint",
  flake8: "lint",
  pylint: "lint",
  pycodestyle: "lint",
  rubocop: "lint",
  credo: "lint",
  phpcs: "lint",
  swiftlint: "lint",
  ktlint: "lint",
  detekt: "lint",
  "golangci-lint": "lint",
  golint: "lint",
  staticcheck: "lint",

  tsup: "build",
  webpack: "build",
  rollup: "build",
  esbuild: "build",
  parcel: "build",
  cmake: "build",
  ninja: "build",
};

/** Executables whose first subcommand names the check. */
const SUBCOMMANDS: Record<string, Record<string, Verification>> = {
  go: { test: "test", build: "build", install: "build", vet: "typecheck" },
  cargo: {
    test: "test",
    nextest: "test",
    build: "build",
    b: "build",
    check: "typecheck",
    clippy: "lint",
  },
  dotnet: { test: "test", build: "build" },
  bazel: { test: "test", build: "build" },
  swift: { test: "test", build: "build" },
  vite: { build: "build" },
  next: { build: "build" },
  nuxt: { build: "build" },
  astro: { build: "build" },
  remix: { build: "build" },
  deno: { test: "test", lint: "lint", check: "typecheck", compile: "build", bundle: "build" },
};

/** Build tools where the check name can be any of several goals. */
const GOAL_TOOLS = new Set(["mvn", "gradle", "gradlew", "sbt", "ant", "lein", "rake"]);

/** Task runners whose arguments are task names, like a package script. */
const TASK_RUNNERS = new Set(["turbo", "nx", "just", "task", "moon", "lerna"]);

/** Package managers that run a named script. */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Manager subcommands that are NOT script runs.
 *
 * `npm ci` is a clean INSTALL, not continuous integration. The old substring
 * rule read it as an umbrella that backed every claim at once.
 */
const MANAGER_SUBCOMMANDS = new Set([
  "add",
  "install",
  "i",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "link",
  "unlink",
  "publish",
  "pack",
  "init",
  "create",
  "why",
  "audit",
  "outdated",
  "view",
  "info",
  "cache",
  "config",
  "login",
  "logout",
  "dedupe",
  "import",
  "licenses",
  "patch",
  "set",
  "get",
  "list",
  "ls",
  "store",
  "bin",
  "version",
  "whoami",
  "exec",
  "dlx",
  "x",
]);

/** Script names that name a conventional full gate over every check. */
const FULL_UMBRELLA = new Set([
  "ci",
  "precommit",
  "prepush",
  "prepr",
  "preflight",
  "checkall",
  "allchecks",
  "verifyall",
  "validateall",
  "runall",
  "everything",
]);

/** Script names that plausibly cover the STATIC checks, and no more. */
const STATIC_UMBRELLA = ["check", "checks", "verify", "validate", "qa", "sanity"];

/**
 * What does a script, task, or make target of this name check?
 *
 * Named categories win over umbrella names, so `test:ci` is a test run rather
 * than a full gate. A name that says nothing supports nothing.
 */
export function scriptKinds(name: string): Verification[] {
  const lower = name.toLowerCase();
  const parts = lower.split(/[:./\\_\-\s]+/).filter(Boolean);
  const flat = lower.replace(/[^a-z0-9]/g, "");
  const has = (...words: string[]): boolean => words.some((w) => parts.includes(w));

  const kinds = new Set<Verification>();
  if (has("test", "tests", "spec", "specs", "unit", "e2e", "itest", "vitest", "jest", "pytest")) {
    kinds.add("test");
  }
  if (has("build", "bundle", "compile", "dist")) kinds.add("build");
  if (has("typecheck", "typechecks", "types", "type", "tsc", "typing") || flat === "checktypes") {
    kinds.add("typecheck");
  }
  if (has("lint", "lints", "eslint", "clippy", "rubocop")) kinds.add("lint");
  if (kinds.size > 0) return [...kinds];

  if (FULL_UMBRELLA.has(flat) || has("ci")) return [...VERIFICATIONS];
  if (STATIC_UMBRELLA.some((w) => parts.includes(w))) return ["lint", "typecheck"];
  return [];
}

/** Arguments before a `--` separator that are not flags. */
function positional(args: string[]): string[] {
  const end = args.indexOf("--");
  const scoped = end === -1 ? args : args.slice(0, end);
  return scoped.filter((a) => !a.startsWith("-"));
}

function scriptRunnerKinds(exe: string, args: string[]): Verification[] {
  const words = positional(args);
  const first = words[0];
  if (first === undefined) return [];

  if (first === "run" || first === "run-script") {
    const script = words[1];
    return script === undefined ? [] : scriptKinds(script);
  }
  // Every manager supports `<manager> test` as a builtin.
  if (first === "test" || first === "tests") return ["test"];
  // npm has no implicit script form: `npm ci` installs, `npm build` is not a
  // script run. The others do run `<manager> <script>`.
  if (exe === "npm") return [];
  if (MANAGER_SUBCOMMANDS.has(first)) return [];
  return scriptKinds(first);
}

/** Which checks did this one invocation actually perform? */
/** Runtimes that execute a file argument as code, rather than inspecting it. */
const TEST_FILE_RUNTIMES = new Set(["tsx", "ts-node", "bun", "deno", "esbuild-register", "swc-node"]);

/**
 * A path that is unambiguously a test file. Deliberately narrow: it must look
 * like a spec file or sit under a test directory, so `node build.js` is not
 * mistaken for a test run.
 */
function isTestFile(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  const path = arg.replace(/\\/g, "/");
  if (/(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path);
}

export function invocationKinds(inv: Invocation): Verification[] {
  const { exe, args } = inv;
  if (READ_ONLY.has(exe)) return [];

  const direct = EXE_KINDS[exe];
  if (direct) return [direct];

  if (exe === "pre-commit" || exe === "precommit") return [...VERIFICATIONS];

  if (SCRIPT_RUNNERS.has(exe)) return scriptRunnerKinds(exe, args);
  if (TASK_RUNNERS.has(exe)) {
    const kinds = new Set<Verification>();
    for (const word of positional(args)) {
      if (word === "run" || word === "run-many" || word === "exec") continue;
      for (const kind of scriptKinds(word)) kinds.add(kind);
    }
    return [...kinds];
  }

  if (exe === "make") {
    const target = positional(args)[0];
    if (target === undefined) return ["build"];
    const kinds = scriptKinds(target);
    // A target that names no check is still a build: `make`, `make release`.
    return kinds.length > 0 ? kinds : ["build"];
  }

  if (GOAL_TOOLS.has(exe)) {
    const kinds = new Set<Verification>();
    for (const goal of positional(args)) {
      for (const kind of scriptKinds(goal)) kinds.add(kind);
    }
    return [...kinds];
  }

  if (exe === "black") return args.includes("--check") ? ["lint"] : [];
  if (exe === "prettier") {
    return args.includes("--check") || args.includes("-c") ? ["lint"] : [];
  }
  // `node --test` is the obvious form, but an agent may equally run a spec file
  // directly: `node tests/money.test.js`, `node --experimental-strip-types
  // tests/x.test.ts`, `npx tsx tests/x.test.ts`. Those genuinely execute the
  // tests, and failing to count them made `done` tell an agent it had never run
  // the suite moments after it did — a false block that costs real turns.
  if (exe === "node") {
    if (args.includes("--test")) return ["test"];
    return positional(args).some(isTestFile) ? ["test"] : [];
  }
  if (TEST_FILE_RUNTIMES.has(exe)) {
    return positional(args).some(isTestFile) ? ["test"] : [];
  }
  if (exe === "python" || exe === "python3" || exe === "py") {
    const module = args[args.indexOf("-m") + 1];
    if (args.includes("-m") && module !== undefined) {
      const byExe = EXE_KINDS[module];
      if (byExe) return [byExe];
      if (module === "unittest") return ["test"];
      if (module === "build") return ["build"];
    }
    return [];
  }

  const sub = SUBCOMMANDS[exe];
  if (sub) {
    const word = positional(args)[0];
    const kind = word === undefined ? undefined : sub[word];
    return kind ? [kind] : [];
  }

  // A local script is an invocation, so `./scripts/run-tests.sh` counts — but
  // only because it is the program being RUN, never because it is an argument.
  const stem = exe.replace(/\.(sh|bash|zsh|py|rb|js|mjs|cjs|ts)$/, "");
  if (inv.path || stem !== exe) return scriptKinds(stem);
  return [];
}

/**
 * Which command kinds can stand behind each claim.
 *
 * `tsc` is both a type checker and a compiler, so an agent that runs
 * `tsc --noEmit` and then says "it compiles" has said something true. Claiming
 * otherwise produced the only false "keep working" this suite ever measured.
 * Every entry here errs toward supporting the claim.
 */
const SUPPORTED_BY: Record<Verification, readonly Verification[]> = {
  test: ["test"],
  build: ["build", "typecheck"],
  typecheck: ["typecheck", "build"],
  lint: ["lint"],
};

/**
 * Did any command in this turn produce the result the claim asserts?
 *
 * A command counts unless it is recorded as FAILED. "unknown" — a call whose
 * result never made it into the slice of transcript we read — counts as
 * support, because the expensive mistake is accusing an agent of skipping a
 * check it actually ran.
 */
export function verificationRan(commands: readonly CommandRun[], kind: Verification): boolean {
  const accepted = new Set(SUPPORTED_BY[kind]);
  for (const run of commands) {
    if (!COMMAND_TOOLS.has(run.tool.toLowerCase())) continue;
    if (run.status === "failed") continue;
    for (const inv of parseCommand(run.command)) {
      if (invocationKinds(inv).some((k) => accepted.has(k))) return true;
    }
  }
  return false;
}

/** Every claimed result that no command in this turn produced. */
export function unsupportedClaims(
  commands: readonly CommandRun[],
  claimed: readonly Verification[],
): Verification[] {
  return claimed.filter((kind) => !verificationRan(commands, kind));
}

/** True when the turn ran no shell command at all — a sharper remedy line. */
export function ranNoCommand(commands: readonly CommandRun[]): boolean {
  return !commands.some((run) => COMMAND_TOOLS.has(run.tool.toLowerCase()));
}

/** True when the turn wrote to at least one file. */
export function changedFiles(commands: readonly CommandRun[]): boolean {
  return commands.some((run) => EDIT_TOOLS.has(run.tool.toLowerCase()));
}

/**
 * True when NOTHING in this turn could have shown that the code works.
 *
 * Deliberately wider than "no check ran". Running the program itself, a script,
 * a container, or a request against it is evidence too, even though no rule
 * here can say which result it produced. Only the inspectors — which read files
 * and nothing else — leave the behaviour of the code entirely unobserved.
 */
export function ranNothingExecutable(commands: readonly CommandRun[]): boolean {
  for (const run of commands) {
    if (!COMMAND_TOOLS.has(run.tool.toLowerCase())) continue;
    for (const inv of parseCommand(run.command)) {
      if (!READ_ONLY.has(inv.exe)) return false;
    }
  }
  return true;
}

/**
 * Did a codebase-wide search run AFTER the last file edit?
 *
 * This is the evidence behind an exhaustive-change claim. An agent that says
 * "every call site now passes the area" has made a universal claim about code
 * it cannot see all of; the only thing that turns that into knowledge is a
 * search run after the final edit.
 *
 * Measured on a 19-call-site rename where sonnet failed 38% of the time: every
 * failing run verified its own changes (tests, typecheck, `git diff`) and never
 * once searched for what it might have missed. The one run that reliably found
 * all 19 searched for both the direct name and its local alias.
 *
 * Deliberately strict about what counts. `cat package.json | grep scripts` is a
 * lookup in a file the agent already had; it is not a sweep of the tree.
 */
export function sweptAfterLastEdit(commands: readonly CommandRun[]): boolean {
  const lastEdit = commands.map((c, i) => (isEditTool(c.tool) ? i : -1)).filter((i) => i >= 0).pop();
  if (lastEdit === undefined) return true; // Nothing was edited, so nothing to sweep for.
  return commands.slice(lastEdit + 1).some(isCodebaseSearch);
}

function isEditTool(tool: string): boolean {
  return tool === "Edit" || tool === "Write" || tool === "NotebookEdit" || tool === "MultiEdit";
}

/** A search across the tree, as opposed to a lookup inside one known file. */
function isCodebaseSearch(run: CommandRun): boolean {
  if (run.tool === "Grep" || run.tool === "Glob") return true;
  if (run.tool !== "Bash") return false;

  for (const inv of parseCommand(run.command)) {
    if (!SEARCH_TOOLS.has(inv.exe)) continue;
    const args = positional(inv.args);
    // `grep pattern file.json` targets one file; a sweep either names a
    // directory, recurses, or globs. Either shape is enough.
    const recursive = inv.args.some((a) => /^-[a-zA-Z]*r/.test(a) || a === "--recursive");
    const wideTarget = args.slice(1).some((a) => a === "." || a.endsWith("/") || a.includes("*") || !a.includes("."));
    if (recursive || wideTarget || inv.exe === "rg" || inv.exe === "ag") return true;
  }
  return false;
}

const SEARCH_TOOLS = new Set(["grep", "rg", "ag", "ack", "ugrep", "find", "fd"]);
