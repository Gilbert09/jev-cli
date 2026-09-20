// src/capabilities/rank/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/core/types.ts
function describeFailure(f) {
  switch (f.type) {
    case "no_api_key":
      return "no TYPESAFE_API_KEY configured";
    case "timeout":
      return `Jev timed out after ${f.ms}ms`;
    case "disabled":
      return "capability disabled by config";
    case "too_large":
      return `content too large to evaluate (${f.bytes} bytes)`;
    case "api_error":
      return `Jev API error${f.status ? ` (${f.status})` : ""}: ${f.message}`;
    case "malformed":
      return `unexpected Jev response: ${f.message}`;
  }
}

// src/core/config.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var DEFAULTS = {
  model: "jev-latest",
  // Latency budget: these run on every tool call. A slow judge is a broken
  // judge, so we would rather fail (to the capability's safe default) than
  // stall the agent loop.
  guard: { enabled: true, timeoutMs: 1500 },
  screen: {
    enabled: true,
    mode: "warn",
    timeoutMs: 2e3,
    excludeGlobs: ["**/.env*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.git/**"],
    maxBytes: 4e4
  },
  done: { enabled: false, timeoutMs: 2500, verifySweepClaims: false },
  rank: { enabled: false, timeoutMs: 4e3, maxCandidates: 400 },
  debug: false
};
function readConfigFile() {
  const path = process.env.JEV_CONFIG_PATH ?? join(homedir(), ".jev", "config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
function mergeCapability(base, override) {
  return { ...base, ...override ?? {} };
}
var cached;
function loadConfig() {
  if (cached) return cached;
  const file = readConfigFile();
  const forceEnabled = process.env.JEV_FORCE_ENABLED === "1";
  cached = {
    // When installed as a Claude Code plugin, the key declared in
    // plugin.json's `userConfig` arrives as CLAUDE_PLUGIN_OPTION_<KEY>. Checked
    // first so a plugin install works with no environment setup at all, then
    // the plain env var, then the config file.
    apiKey: process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY ?? file.apiKey,
    model: process.env.JEV_MODEL ?? file.model ?? DEFAULTS.model,
    guard: { ...mergeCapability(DEFAULTS.guard, file.guard), enabled: forceEnabled || mergeCapability(DEFAULTS.guard, file.guard).enabled },
    screen: {
      ...mergeCapability(DEFAULTS.screen, file.screen),
      enabled: forceEnabled || mergeCapability(DEFAULTS.screen, file.screen).enabled,
      mode: process.env.JEV_SCREEN_MODE ?? file.screen?.mode ?? DEFAULTS.screen.mode
    },
    done: {
      ...mergeCapability(DEFAULTS.done, file.done),
      enabled: forceEnabled || mergeCapability(DEFAULTS.done, file.done).enabled,
      verifySweepClaims: process.env.JEV_VERIFY_SWEEPS === "1" || file.done?.verifySweepClaims === true || DEFAULTS.done.verifySweepClaims
    },
    rank: { ...mergeCapability(DEFAULTS.rank, file.rank), enabled: forceEnabled || mergeCapability(DEFAULTS.rank, file.rank).enabled },
    debug: process.env.JEV_DEBUG === "1" || file.debug === true
  };
  return cached;
}

// src/core/log.ts
function debug(scope, data) {
  if (!loadConfig().debug) return;
  try {
    process.stderr.write(`[jev:${scope}] ${JSON.stringify(data)}
`);
  } catch {
    process.stderr.write(`[jev:${scope}] <unserialisable>
`);
  }
}

// src/capabilities/rank/questions.ts
import { choice, noul } from "@typesafe-ai/sdk";
var TUNING = {
  maxOptionsPerChoice: 255,
  maxCandidatesPerBatch: 24,
  maxSnippetBytes: 1200,
  maxBatchContentBytes: 24e3,
  finalistsPerBatch: 3,
  maxRounds: 4,
  defaultTopK: 5,
  maxTopK: 25,
  presentThreshold: 0.5,
  presentConfidenceFloor: 0.2
};
function buildState(query, batch) {
  return {
    question: query,
    files: batch.map((entry) => ({
      id: entry.id,
      path: entry.path,
      excerpt: entry.snippet
    }))
  };
}
var CHOICE_INSTRUCTIONS = "Each entry in `files` is one source file from a codebase: its short id, its path, and an excerpt from the top of the file. The developer's question is in `question`. Point to the id of the single file a developer should open FIRST to answer that question \u2014 the file most likely to contain the definition, implementation, or configuration the question is about. Judge the file by what it does, not by whether its path happens to repeat words from the question. A file that merely imports, calls, or mentions the thing is worse than the file that defines it.";
var PRESENT_INSTRUCTIONS = "Ignoring which file is best, does ANY file in `files` actually contain the answer to `question`? Answer about this specific set of files only. If the listed files are all about other subjects, and the developer would have to look somewhere else entirely, the answer is no \u2014 even if one file is closer to the question than the rest.";
var PRESENT_CRITERIA = {
  true: "At least one listed file contains the definition, implementation, or configuration the question asks about. Reading it would answer the question.",
  false: "No listed file contains the answer. The relevant code lives in some file that is not in this list. Superficial keyword overlap with the question is not containment."
};
function buildQuestions(batch) {
  const present = noul(PRESENT_INSTRUCTIONS, PRESENT_CRITERIA);
  if (batch.length < 2) return { present };
  const criteria = {};
  for (const entry of batch) criteria[entry.id] = entry.path;
  return { best: choice(CHOICE_INSTRUCTIONS, criteria), present };
}
var TOOL_DESCRIPTION = [
  "Semantic file ranking. Give it a question and a list of candidate files; it",
  "returns a short ranked shortlist of the files most likely to answer the",
  "question, plus a `present` probability saying whether the answer is in the",
  "candidate set at all.",
  "",
  "CALL THIS when you are about to read many files to answer one question in a",
  "codebase you do not already know \u2014 after a broad glob or grep has left you",
  "with 15+ plausible files, or when you would otherwise open files one by one",
  "hoping to find the right one. Pass every plausible candidate (hundreds are",
  "fine, they are batched automatically), then read only the top few it returns.",
  "",
  "DO NOT CALL THIS when you already know which file you need, when the",
  "candidate list is under about 5 files (just read them), when a plain grep for",
  "an exact symbol, string, or error message would answer the question, or when",
  "you need the contents of a file rather than a pointer to it. It ranks files;",
  "it does not read, summarise, or edit them.",
  "",
  "Trust the `present` field. When it is low the answer is probably NOT in the",
  "candidates you supplied \u2014 widen the search instead of reading the top hit,",
  "because the ranking is a forced choice and will name a file regardless.",
  "On error it returns an explanation and no ranking; fall back to reading files",
  "yourself."
].join("\n");

// src/capabilities/rank/rank.ts
import { closeSync, openSync, readSync } from "fs";

// src/core/jev.ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

// src/core/cache.ts
import { createHash } from "crypto";
import { mkdirSync, readFileSync as readFileSync2, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { join as join2 } from "path";
var TTL_MS = 30 * 6e4;
var MAX_ENTRIES = 500;
function cacheDir() {
  const base = process.env.JEV_CACHE_DIR ?? (process.env.CLAUDE_PLUGIN_DATA ? join2(process.env.CLAUDE_PLUGIN_DATA, "cache") : void 0) ?? join2(homedir2(), ".jev", "cache");
  try {
    mkdirSync(base, { recursive: true });
    return base;
  } catch {
    return tmpdir();
  }
}
function cacheKey(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
function cacheGet(key) {
  try {
    const file = join2(cacheDir(), `${key}.json`);
    const age = Date.now() - statSync(file).mtimeMs;
    if (age > TTL_MS) {
      unlinkSync(file);
      return void 0;
    }
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return void 0;
  }
}
function cacheSet(key, value) {
  try {
    writeFileSync(join2(cacheDir(), `${key}.json`), JSON.stringify(value), "utf8");
    sweep();
  } catch {
  }
}
function sweep() {
  if (Math.random() > 0.05) return;
  try {
    const dir = cacheDir();
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      const p = join2(dir, f);
      return { p, mtime: statSync(p).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    for (const [i, e] of entries.entries()) {
      if (i >= MAX_ENTRIES || now - e.mtime > TTL_MS) unlinkSync(e.p);
    }
  } catch {
  }
}

// src/core/decide.ts
function noulConfidence(probability) {
  if (!Number.isFinite(probability)) return 0;
  const clamped = Math.min(1, Math.max(0, probability));
  return Math.abs(clamped - 0.5) * 2;
}
function validateScore(raw, levels) {
  if (!Number.isFinite(raw)) {
    throw new RangeError(`score is not a finite number: ${raw}`);
  }
  if (levels < 2 || levels > 10) {
    throw new RangeError(`rubric must have 2..10 levels, got ${levels}`);
  }
  if (raw < -1e-6 || raw > levels - 1 + 1e-6) {
    throw new RangeError(
      `score ${raw} outside [0, ${levels - 1}] for a ${levels}-level rubric; the Jev score encoding differs from what jev-cli assumes`
    );
  }
  return Math.min(levels - 1, Math.max(0, raw));
}

// src/core/jev.ts
var client;
function getClient(apiKey) {
  client ??= new TypeSafeClient({ apiKey });
  return client;
}
function normalizeAnswer(key, raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`answer "${key}" is not an object`);
  }
  const a = raw;
  if (typeof a.noul === "number") {
    return { type: "noul", noul: a.noul, confidence: noulConfidence(a.noul) };
  }
  if (typeof a.score === "number") {
    const probabilities = a.probabilities ?? {};
    const legend = a.legend ?? {};
    const levels = Object.keys(probabilities).length;
    if (levels < 2) {
      throw new Error(`score answer "${key}" returned ${levels} level probabilities`);
    }
    const score = validateScore(a.score, levels);
    return {
      type: "score",
      score,
      nearest: Math.round(score),
      levels,
      probabilities,
      legend,
      confidence: typeof a.confidence === "number" ? a.confidence : 0
    };
  }
  if (typeof a.choice === "string") {
    return {
      type: "choice",
      choice: a.choice,
      probabilities: a.probabilities ?? {},
      confidence: typeof a.confidence === "number" ? a.confidence : 0
    };
  }
  throw new Error(`answer "${key}" has no noul, score, or choice field`);
}
function toFailure(err) {
  const e = err;
  if (e?.name === "AuthenticationError" || e?.status === 401) {
    return { type: "api_error", status: 401, message: "authentication failed" };
  }
  if (typeof e?.status === "number") {
    return { type: "api_error", status: e.status, message: e.message ?? "request failed" };
  }
  return { type: "api_error", message: e?.message ?? String(err) };
}
async function ask(opts) {
  const started = Date.now();
  const config = loadConfig();
  const capConfig = config[opts.capability];
  const fail = (error) => {
    debug(opts.capability, { error });
    return { ok: false, error, ms: Date.now() - started };
  };
  if (!capConfig.enabled) return fail({ type: "disabled" });
  if (!config.apiKey) return fail({ type: "no_api_key" });
  const key = cacheKey([config.model, opts.capability, opts.questions, opts.state]);
  if (!opts.noCache) {
    const hit = cacheGet(key);
    if (hit) {
      debug(opts.capability, { cached: true, ms: Date.now() - started });
      return { ok: true, answers: hit, cached: true, ms: Date.now() - started };
    }
  }
  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => controller.abort(), capConfig.timeoutMs);
    const response = await getClient(config.apiKey).systemOne(
      {
        model: config.model,
        state: opts.state,
        questions: opts.questions
      },
      { signal: controller.signal, timeout: capConfig.timeoutMs }
    );
    if (!response?.answers) return fail({ type: "malformed", message: "no answers field" });
    const answers = {};
    for (const [k, v] of Object.entries(response.answers)) {
      answers[k] = normalizeAnswer(k, v);
    }
    if (!opts.noCache) cacheSet(key, answers);
    const ms = Date.now() - started;
    debug(opts.capability, { cached: false, ms, answers });
    return { ok: true, answers, cached: false, ms };
  } catch (err) {
    const name = err?.name;
    if (controller.signal.aborted || name === "APITimeoutError" || name === "APIUserAbortError") {
      return fail({ type: "timeout", ms: capConfig.timeoutMs });
    }
    if (err instanceof RangeError || err?.message?.includes("answer ")) {
      return fail({ type: "malformed", message: err.message });
    }
    return fail(toFailure(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// src/core/redact.ts
var PATTERNS = [
  // Provider-prefixed keys (Anthropic, OpenAI, TypeSafe, Stripe, GitHub, Slack).
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,})\b/g, "[redacted-api-key]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key-id]"],
  // PEM private key blocks, body and all.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]"
  ],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  // KEY=value / TOKEN: value assignments in env files and configs.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'\n]{6,})["']?/gi,
    (_m, name) => `${name}=[redacted]`
  ]
];
function redact(input) {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
function truncate(input, maxBytes) {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) return { text: input, truncated: false };
  const text = buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { text, truncated: true };
}
function prepare(input, maxBytes) {
  return truncate(redact(input), maxBytes);
}

// src/capabilities/rank/rank.ts
var ID_SAFE = /^[A-Za-z0-9_.:-]{1,16}$/;
function assignIds(candidates) {
  const taken = /* @__PURE__ */ new Set();
  const ids = [];
  for (let i = 0; i < candidates.length; i++) {
    const proposed = candidates[i]?.id;
    let id = proposed && ID_SAFE.test(proposed) && !taken.has(proposed) ? proposed : `f${i}`;
    let suffix = 0;
    while (taken.has(id)) id = `f${i}_${++suffix}`;
    taken.add(id);
    ids.push(id);
  }
  return ids;
}
function batchCandidates(entries, limits) {
  const maxPerBatch = Math.max(1, Math.floor(limits.maxPerBatch));
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry.snippet, "utf8") + Buffer.byteLength(entry.path, "utf8");
    const full = current.length >= maxPerBatch || current.length > 0 && bytes + size > limits.maxBytesPerBatch;
    if (full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
function mergeRounds(rounds) {
  const merged = /* @__PURE__ */ new Map();
  rounds.forEach((scores, index) => {
    for (const [id, score] of Object.entries(scores)) {
      const value = Number.isFinite(score) ? score : 0;
      merged.set(id, { id, score: value, rounds: index + 1 });
    }
  });
  return [...merged.values()].sort(
    (a, b) => b.rounds - a.rounds || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
function readHead(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch (err) {
    return `(unreadable: ${err?.message ?? "unknown error"})`;
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function choiceProbabilities(answers) {
  const best = answers.best;
  if (!best || best.type !== "choice") return void 0;
  return best.probabilities ?? {};
}
function presentAnswer(answers) {
  const present = answers.present;
  return present && present.type === "noul" ? present : void 0;
}
async function mapPooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (; ; ) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === void 0) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
async function rankBatch(query, batch, ask2) {
  const result = await ask2({
    capability: "rank",
    state: buildState(query, batch),
    questions: buildQuestions(batch)
  });
  if (!result.ok) return { scores: {}, present: void 0, failure: result.error };
  const present = presentAnswer(result.answers);
  const probabilities = choiceProbabilities(result.answers);
  const scores = {};
  if (probabilities) {
    for (const entry of batch) {
      const p = probabilities[entry.id];
      scores[entry.id] = typeof p === "number" && Number.isFinite(p) ? p : 0;
    }
  } else {
    for (const entry of batch) scores[entry.id] = present?.noul ?? 0;
  }
  return { scores, present };
}
async function rankCandidates(request, deps = {}) {
  const ask2 = deps.ask ?? ask;
  const read = deps.readHead ?? readHead;
  const config = loadConfig();
  const topK = Math.max(
    1,
    Math.min(TUNING.maxTopK, Math.floor(request.topK ?? TUNING.defaultTopK))
  );
  const truncated = request.candidates.length > config.rank.maxCandidates;
  const kept = request.candidates.slice(0, config.rank.maxCandidates);
  if (kept.length === 0) {
    return {
      ok: true,
      ranked: [],
      present: 0,
      presentConfidence: 1,
      considered: 0,
      truncated,
      rounds: 0,
      calls: 0
    };
  }
  const ids = assignIds(kept);
  const entries = kept.map((candidate, index) => {
    const raw = candidate.snippet ?? read(candidate.path, TUNING.maxSnippetBytes * 2);
    return {
      id: ids[index] ?? `f${index}`,
      path: candidate.path,
      snippet: prepare(raw, TUNING.maxSnippetBytes).text
    };
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const limits = {
    maxPerBatch: Math.min(TUNING.maxCandidatesPerBatch, TUNING.maxOptionsPerChoice),
    maxBytesPerBatch: TUNING.maxBatchContentBytes
  };
  const roundScores = [];
  let pool = entries;
  let present;
  let calls = 0;
  for (let round = 0; round < TUNING.maxRounds; round++) {
    const batches = batchCandidates(pool, limits);
    const outcomes = await mapPooled(batches, 4, (batch) => rankBatch(request.query, batch, ask2));
    calls += batches.length;
    const failed = outcomes.find((outcome) => outcome.failure);
    if (failed?.failure) return { ok: false, error: failed.failure };
    const scores = {};
    for (const outcome of outcomes) Object.assign(scores, outcome.scores);
    roundScores.push(scores);
    present = pickPresent(outcomes) ?? present;
    if (batches.length <= 1) break;
    const finalists = promote(batches, scores, TUNING.finalistsPerBatch);
    if (finalists.length >= pool.length) break;
    pool = finalists;
  }
  const merged = mergeRounds(roundScores);
  const ranked = [];
  for (const entry of merged) {
    const candidate = byId.get(entry.id);
    if (!candidate) continue;
    ranked.push({ id: entry.id, path: candidate.path, score: entry.score, rounds: entry.rounds });
    if (ranked.length >= topK) break;
  }
  return {
    ok: true,
    ranked,
    present: present?.noul ?? 0,
    presentConfidence: present?.confidence ?? 0,
    considered: entries.length,
    truncated,
    rounds: roundScores.length,
    calls
  };
}
function pickPresent(outcomes) {
  let best;
  for (const outcome of outcomes) {
    const p = outcome.present;
    if (!p) continue;
    if (!best || p.noul > best.noul) best = p;
  }
  return best;
}
function promote(batches, scores, perBatch) {
  const promoted = [];
  for (const batch of batches) {
    const ordered = [...batch].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));
    promoted.push(...ordered.slice(0, perBatch));
  }
  return promoted;
}

// src/capabilities/rank/server.ts
var inputSchema = {
  query: z.string().min(1).describe("The question you are trying to answer, in plain words. Not a search term."),
  candidates: z.array(
    z.object({
      id: z.string().optional().describe("Your own id for this candidate; echoed back."),
      path: z.string().min(1).describe("Path to the file, absolute or relative to cwd."),
      snippet: z.string().optional().describe("Content to judge the file by. Omit to have a bounded head of the file read.")
    })
  ).describe("Every plausible file. Hundreds are fine; they are batched automatically."),
  topK: z.number().int().positive().optional().describe(`How many files to return. Default ${TUNING.defaultTopK}, max ${TUNING.maxTopK}.`)
};
function renderPresence(result) {
  const pct = Math.round(result.present * 100);
  if (result.presentConfidence < TUNING.presentConfidenceFloor) {
    return `present: ${pct}% (UNCERTAIN \u2014 jev could not tell whether the answer is in this set; treat the ranking as a weak hint)`;
  }
  if (result.present < TUNING.presentThreshold) {
    return `present: ${pct}% \u2014 the answer is probably NOT in these candidates. Widen the search rather than reading the files below; the ranking is a forced choice and names a file regardless.`;
  }
  return `present: ${pct}% \u2014 the answer is probably in these candidates.`;
}
function render(result) {
  if (result.considered === 0) return "No candidates were supplied, so there is nothing to rank.";
  const lines = [renderPresence(result), ""];
  lines.push(`ranked ${result.ranked.length} of ${result.considered} candidates:`);
  result.ranked.forEach((entry, index) => {
    lines.push(
      `  ${index + 1}. ${entry.path}  [id=${entry.id} score=${entry.score.toFixed(3)} rounds=${entry.rounds}]`
    );
  });
  if (result.truncated) {
    lines.push("", "note: the candidate list was cut to the configured ceiling before ranking.");
  }
  return lines.join("\n");
}
function createServer() {
  const server = new McpServer(
    { name: "jev-rank", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.registerTool(
    "rank",
    {
      title: "Rank files by relevance to a question",
      description: TOOL_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) => {
      const result = await rankCandidates({
        query: args.query,
        candidates: args.candidates,
        topK: args.topK
      });
      if (!result.ok) {
        debug("rank", { error: result.error });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `rank failed: ${describeFailure(result.error)}.
No ranking was produced. Fall back to reading the candidate files yourself.`
            }
          ]
        };
      }
      debug("rank", {
        considered: result.considered,
        rounds: result.rounds,
        calls: result.calls,
        present: result.present
      });
      return { content: [{ type: "text", text: render(result) }] };
    }
  );
  return server;
}
async function serve() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
export {
  createServer,
  serve
};
//# sourceMappingURL=mcp-server.js.map