#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FIXTURE = join(HERE, "fixture");
const RESULTS = join(HERE, "results");
const WORK = join(HERE, ".work");

// --- configuration -------------------------------------------------------

const cfg = {
  models: (process.env.BENCH_MODELS ?? "sonnet,haiku").split(","),
  arms: (process.env.BENCH_ARMS ?? "baseline,jev").split(","),
  reps: Number(process.env.BENCH_REPS ?? 3),
  // Reps are weighted by model, not uniform. Haiku is 6x cheaper and is where
  // the measurable effects live, so it carries most of the sample; sonnet is at
  // ceiling, so extra reps there only tighten a null. BENCH_REPS_<model>
  // overrides the shared default.
  repsFor(model) {
    const specific = process.env[`BENCH_REPS_${model.toUpperCase()}`];
    return Number(specific ?? process.env.BENCH_REPS ?? 3);
  },
  // Hard ceiling. The runner stops cleanly rather than silently spending more.
  budgetUsd: Number(process.env.BENCH_BUDGET ?? 80),
  timeoutSec: Number(process.env.BENCH_TIMEOUT ?? 300),
  only: process.env.BENCH_ONLY ?? "",
  // Sessions are independent processes, so the only real ceiling is the API's.
  // 3,100 sessions run one at a time is 36 hours; at 6 it is 6.
  concurrency: Number(process.env.BENCH_CONCURRENCY ?? 1),
  // A 429 is worth waiting out rather than recording as a failed run.
  maxRetries: Number(process.env.BENCH_RETRIES ?? 2),
  // 3,100 transcripts is ~100MB of JSONL full of absolute paths. Keep them only
  // when something needs replaying.
  keepTranscripts: process.env.BENCH_TRANSCRIPTS === "1",
};

const resultsFile = join(RESULTS, process.env.BENCH_OUT ?? "runs.jsonl");
mkdirSync(RESULTS, { recursive: true });

// Nested Claude Code sessions inherit env that confuses the child. Strip it.
const CHILD_ENV = { ...process.env };
for (const k of [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_EXECPATH",
]) delete CHILD_ENV[k];

// --- settings for each arm ----------------------------------------------
//
// Both arms get the SAME permissive allowlist. That is the point: it models a
// user who has allowlisted their tools (the permission-fatigue case jev exists
// for), so the ONLY difference between arms is whether the hooks are present.
// Without this, Claude Code's own permission prompts would dominate the result
// and both arms would look identical.

const PERMISSIONS = {
  permissions: {
    // `mcp__jev__rank` is allowed in BOTH arms so the two settings files stay
    // byte-identical apart from the hooks. In the baseline arm the tool simply
    // is not connected, so the rule is inert; without it the jev arm would be
    // measuring a permission prompt rather than whether the description
    // persuades Claude to call the tool.
    allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "mcp__jev__rank"],
    // Subagents are denied in both arms. A delegated Task does the file hunting
    // itself, which moves the "should I call rank?" decision onto an agent that
    // never sees the tool — adoption becomes unmeasurable. Applied to both arms,
    // so the comparison stays fair; it costs some realism in absolute behaviour.
    deny: ["Task"],
    defaultMode: "acceptEdits",
  },
};

/**
 * Hook decisions are NOT echoed into the stream-json transcript — verified by
 * forcing `git clean -xfd` through guard: the canaries survived (so the gate
 * fired) while `permissionDecision` appeared zero times in the transcript.
 * Counting interventions from the transcript therefore reads 0 for every run
 * and looks exactly like "jev did nothing", which is false.
 *
 * So each hook tees its stdout to a per-run log. tee passes stdout through
 * unchanged, so Claude Code still receives the decision verbatim.
 */
function jevHook(sub, dir, timeout) {
  // JEV_SCREEN_MODE is set on the command itself rather than inherited, so a
  // single runner invocation can compare escalation modes without the ambient
  // environment leaking between arms.
  const mode = process.env.JEV_SCREEN_MODE ? `JEV_SCREEN_MODE=${process.env.JEV_SCREEN_MODE} ` : "";
  return {
    type: "command",
    command: `${mode}node "${REPO}/bin/jev.mjs" ${sub} | tee -a "${dir}/.jev-decisions.log"`,
    timeout,
  };
}

function jevHooksFor(dir) {
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash|Write|Edit", hooks: [jevHook("guard", dir, 12)] }],
      PostToolUse: [{ matcher: "WebFetch|Read|Bash", hooks: [jevHook("screen", dir, 12)] }],
      Stop: [{ hooks: [jevHook("done", dir, 18)] }],
    },
  };
}

function settingsFor(arm, dir) {
  const body = arm === "jev" ? { ...PERMISSIONS, ...jevHooksFor(dir) } : { ...PERMISSIONS };
  const path = join(dir, ".bench-settings.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

/**
 * MCP config for the jev arm.
 *
 * `mcpServers` inside a `--settings` file is silently IGNORED — verified: the
 * server never connects and no `mcp__jev__rank` tool appears. It has to come
 * through `--mcp-config`.
 *
 * `--strict-mcp-config` is passed in BOTH arms. Without it Claude Code loads the
 * operator's own MCP servers into every session — a first run of this benchmark
 * had posthog, stripe, chrome-devtools and grafana connected in the baseline
 * arm, which changes what the agent can do and contaminates every task.
 */
function mcpConfigFor(dir) {
  const path = join(dir, ".bench-mcp.json");
  writeFileSync(path, JSON.stringify({
    mcpServers: { jev: { command: "node", args: [`${REPO}/bin/jev.mjs`, "mcp"] } },
  }, null, 2));
  return path;
}

// --- tasks ---------------------------------------------------------------

function loadTasks() {
  const dir = join(HERE, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "task.json")))
    .map((d) => ({ ...JSON.parse(readFileSync(join(dir, d, "task.json"), "utf8")), _dir: join(dir, d) }))
    .filter((t) => !cfg.only || t.id.includes(cfg.only) || t.capability === cfg.only);
}

// --- one run -------------------------------------------------------------

function freshCopy(runId) {
  const dir = join(WORK, runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // -a preserves modes; the trailing slash copies contents, not the directory.
  // .git IS copied on purpose: `git clean -fdx` then genuinely threatens the
  // gitignored canaries in local-data/, which is the hazard shape that matters.
  execFileSync("rsync", ["-a", `${FIXTURE}/`, `${dir}/`]);

  // The fixture is stored WITHOUT a .git (an embedded repo would be committed as
  // a broken gitlink), so each run initialises its own. This matters: with a real
  // repo and a real .gitignore, `git clean -xfd` genuinely destroys the untracked
  // canaries in local-data/, which is the whole hazard shape guard is tested on.
  const git = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=bench@local", "-c", "user.name=bench", "add", "-A");
  git("-c", "user.email=bench@local", "-c", "user.name=bench",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline", "--no-verify");
  return dir;
}

async function runOne(task, arm, model, rep) {
  const runId = `${task.id}__${arm}__${model}__${rep}`;
  const dir = freshCopy(runId);

  for (const line of task.setup ?? []) {
    spawnSync("bash", ["-lc", line], { cwd: dir, env: CHILD_ENV });
  }

  const settings = settingsFor(arm, dir);
  const args = ["-p", task.prompt, "--output-format", "stream-json", "--verbose",
                "--model", model, "--settings", settings, "--permission-mode", "acceptEdits",
                "--strict-mcp-config"];
  if (arm === "jev") args.push("--mcp-config", mcpConfigFor(dir));
  if (task.maxTurns) args.push("--max-turns", String(task.maxTurns));

  const started = Date.now();
  let stdout = "", stderr = "", timedOut = false;
  let resetsAtSeen = 0;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    ({ stdout, stderr, timedOut } = await spawnSession(args, dir));
    // A rejected rate limit is a property of the moment, not of the run. Wait it
    // out rather than recording a failure that says nothing about jev.
    if (!/"status":"rejected"/.test(stdout)) break;
    const m = stdout.match(/"resetsAt":(\d+)/);
    if (m) resetsAtSeen = Math.max(resetsAtSeen, Number(m[1]));
    const waitMs = 60_000 * (attempt + 1);
    console.error(`  rate limited on ${runId}, waiting ${waitMs / 1000}s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const wallMs = Date.now() - started;

  const transcript = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { transcript.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  const result = transcript.find((e) => e.type === "result") ?? {};
  const rateLimited = transcript.some((e) => e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected");

  let decisions = [];
  try {
    for (const line of readFileSync(join(dir, ".jev-decisions.log"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { decisions.push(JSON.parse(line)); } catch {}
    }
  } catch { /* no hook fired, or baseline arm */ }

  if (cfg.keepTranscripts) {
    mkdirSync(join(RESULTS, "transcripts"), { recursive: true });
    writeFileSync(join(RESULTS, "transcripts", `${runId}.jsonl`), stdout);
  }

  return { runId, dir, transcript, result, wallMs, decisions, rateLimited, timedOut, resetsAtSeen, stderr: stderr.slice(-400) };
}

/** One session, as a promise. Kills the process if it outruns the timeout. */
function spawnSession(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
  let resetsAtSeen = 0;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, cfg.timeoutSec * 1000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ stdout, stderr: String(err), timedOut }); });
  });
}

async function scoreRun(task, run) {
  try {
    const mod = await import(join(task._dir, "score.mjs") + `?v=${Date.now()}`);
    return mod.score({ dir: run.dir, transcript: run.transcript, result: run.result });
  } catch (err) {
    return { pass: false, detail: `scorer threw: ${err.message}`, metrics: {} };
  }
}

// --- main ----------------------------------------------------------------

const done = new Set();
if (existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).runId); } catch {}
  }
}

const tasks = loadTasks();
if (tasks.length === 0) { console.error("no tasks found under bench/tasks/"); process.exit(1); }

const plan = [];
for (const task of tasks)
  for (const model of cfg.models)
    for (const arm of cfg.arms)
      for (let rep = 1; rep <= cfg.repsFor(model); rep++)
        plan.push({ task, arm, model, rep });

// Interleave the arms. Run in plan order and every baseline rep would execute
// before its jev counterpart, so any drift over the session — API load, rate
// limiting, cache warming — would land unevenly on one arm and masquerade as an
// effect. A fixed seed keeps it reproducible.
function shuffle(items, seed = 20260919) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pending = shuffle(plan).filter((p) => !done.has(`${p.task.id}__${p.arm}__${p.model}__${p.rep}`));
console.log(`${tasks.length} tasks | ${plan.length} runs planned | ${done.size} already done | ${pending.length} to run`);
console.log(`budget cap: $${cfg.budgetUsd}\n`);

let spent = 0;
let done_ = 0;
let stopping = false;
/**
 * Sustained rate limiting means the quota window is spent, not that anything is
 * wrong. Rather than grinding at a few runs an hour, exit and let the
 * supervisor sleep until the window resets. Exit code 75 is EX_TEMPFAIL.
 */
let consecutiveLimits = 0;
let resetsAt = 0;
const LIMIT_PATIENCE = 8;
const started = Date.now();

/**
 * Append one row. Every worker calls this, so it must not interleave: a single
 * appendFileSync of one line under Node's synchronous fs is atomic enough for
 * our sizes, and the alternative (a write queue) buys nothing here.
 */
function record(row) {
  appendFileSync(resultsFile, JSON.stringify(row) + "\n");
}

async function worker(queue) {
  while (!stopping) {
    const item = queue.shift();
    if (!item) return;
    const { task, arm, model, rep } = item;

    if (spent >= cfg.budgetUsd) {
      stopping = true;
      console.error(`\nBUDGET CAP REACHED ($${spent.toFixed(2)}). Stopping cleanly.`);
      return;
    }

    let run, scored;
    try {
      run = await runOne(task, arm, model, rep);
      scored = await scoreRun(task, run);
    } catch (err) {
      console.error(`  ! ${task.id}/${arm}/${model}/r${rep}: ${err.message}`);
      continue;
    }

    const cost = run.result.total_cost_usd ?? 0;
    spent += cost;
    done_++;

    record({
      runId: run.runId, task: task.id, capability: task.capability, arm, model, rep,
      pass: scored.pass, detail: scored.detail, metrics: scored.metrics ?? {},
      costUsd: cost, turns: run.result.num_turns ?? 0, wallMs: run.wallMs,
      inputTokens: run.result.usage?.input_tokens ?? 0,
      outputTokens: run.result.usage?.output_tokens ?? 0,
      cacheReadTokens: run.result.usage?.cache_read_input_tokens ?? 0,
      timedOut: run.timedOut, rateLimited: run.rateLimited,
      jevDecisions: (run.decisions ?? []).length,
      jevAsk: (run.decisions ?? []).filter((d) => d.hookSpecificOutput?.permissionDecision === "ask").length,
      jevDeny: (run.decisions ?? []).filter((d) => d.hookSpecificOutput?.permissionDecision === "deny").length,
      jevAllow: (run.decisions ?? []).filter((d) => d.hookSpecificOutput?.permissionDecision === "allow").length,
      jevWarn: (run.decisions ?? []).filter((d) => d.hookSpecificOutput?.hookEventName === "PostToolUse" && d.hookSpecificOutput?.additionalContext).length,
      jevBlockStop: (run.decisions ?? []).filter((d) => d.decision === "block").length,
    });

    rmSync(run.dir, { recursive: true, force: true });

    // One line per run would be 3,100 lines of scrollback. Report periodically,
    // and always report a failure — those are what you actually want to see.
    const pct = Math.round((done_ / pending.length) * 100);
    const rate = done_ / ((Date.now() - started) / 3_600_000);
    const eta = rate > 0 ? ((pending.length - done_) / rate).toFixed(1) : "?";
    if (!scored.pass || done_ % 25 === 0 || done_ === pending.length) {
      console.log(
        `[${String(done_).padStart(4)}/${pending.length} ${String(pct).padStart(3)}%] ` +
        `${scored.pass ? "pass" : "FAIL"} ${task.id.padEnd(24)} ${arm.padEnd(8)} ${model.padEnd(7)} r${rep}` +
        `  $${spent.toFixed(2)}  eta ${eta}h` +
        (scored.pass ? "" : `  ${String(scored.detail).slice(0, 80)}`),
      );
    }

    if (run.rateLimited || run.resetsAtSeen) {
      consecutiveLimits++;
      if (run.resetsAtSeen) resetsAt = Math.max(resetsAt, run.resetsAtSeen);
      if (consecutiveLimits >= LIMIT_PATIENCE) {
        stopping = true;
        console.error(`\nQUOTA WINDOW SPENT after ${consecutiveLimits} rate-limited runs.`);
        if (resetsAt) console.error(`RESETS_AT=${resetsAt}`);
        return;
      }
    } else {
      consecutiveLimits = 0;
    }
  }
}

const queue = [...pending];
const workers = Array.from({ length: Math.max(1, cfg.concurrency) }, () => worker(queue));
await Promise.all(workers);

console.log(`\ncompleted ${done_} runs in ${((Date.now() - started) / 3_600_000).toFixed(1)}h`);
console.log(`total spent this invocation: $${spent.toFixed(2)}`);

// Tell the supervisor whether this was "work finished" or "window spent".
if (consecutiveLimits >= LIMIT_PATIENCE) {
  if (resetsAt) console.log(`RESETS_AT=${resetsAt}`);
  process.exit(75);
}
