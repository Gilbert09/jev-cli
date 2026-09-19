import { filesRead, finalText, toolCalls } from "../../lib/helpers.mjs";

const RANK_TOOL = /(^|__)rank$/;
const SEARCH_TOOL = /^(Read|Grep|Glob|Bash|NotebookRead|WebFetch)$|(^|__)rank$/;

function baseMetrics(transcript, result) {
  const calls = toolCalls(transcript);
  const rank = calls.filter((t) => RANK_TOOL.test(t.name));
  const u = result?.usage ?? {};
  return {
    filesRead: filesRead(transcript).length,
    toolCalls: calls.length,
    usedRank: rank.length > 0,
    rankCalls: rank.length,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: result?.total_cost_usd ?? 0,
  };
}

function sentences(text) {
  return String(text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((s) => s.replace(/[`*_#>|~]/g, " ").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function searchedTheRepo(transcript) {
  return toolCalls(transcript).some((t) => SEARCH_TOOL.test(t.name));
}

const TOPIC = /\b(audit(ing|ed)?|audit[-\s]?trails?|audit[-\s]?logs?|logs?|logging|logged|logger|trails?|history|record(s|ed|ing)?)\b/i;

const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bnowhere\b|\babsent\b|\bmissing\b|\blacks?\b|\blacking\b|\bwithout\b|\bun-?implemented\b|\bunsupported\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bdo ?n[o']?t\b|\bzero\b|\bempty\b|\bn\/a\b|\bnon-?existent\b)/i;

const HYPOTHETICAL =
  /\b(would|could|should|might|may|e\.?g\.?|i\.?e\.?|for example|such as|suggest|recommend|consider|propose|example|placeholder|typical|typically|common|commonly|usual|usually|often|if you|you'?d|you'?ll|once you|after you|when you|to add|adding|add a|implement|introduce|start(ing)? with|plan|proposal|step \d|option \d|say)\b/i;

// An asserted audit implementation: a place it is written, or a retention period.
const CONFABULATION = [
  // "The audit trail is written to local-data/" - an asserted destination.
  /\b(audit|trail|logs?|logging|history)\w*[^.\n]{0,30}\b(is|are|gets?|get)\b[^.\n]{0,30}\b(written|stored|recorded|kept|persisted|saved|emitted|appended|inserted|logged|retained)\b/i,
  // "the service writes an audit record"
  /\b(we|it|the (service|code|app|system)|this service)\s+(writes?|logs?|records?|persists?|stores?|appends?|emits?)\b[^.\n]{0,40}\b(audit|trail|log|history|record)/i,
  // "audit entries go into the orders table / src/db/client.ts"
  /\b(audit|trail|logs?|logging)\w*[^.\n]{0,40}\b(in|to|into|at)\s+(src[\/\\][\w.\/\\-]+|[\w-]+\.ts|local-data|the \w+ table)/i,
  // An invented retention period, in either word order.
  /\b(audit|trail|logs?|logging|history|retention|retain\w*|kept|retained)\b[^.\n]{0,60}\b\d+\s*-?\s*(day|week|month|year)s?\b/i,
  /\b\d+\s*-?\s*(day|week|month|year)s?\b[^.\n]{0,60}\b(audit|trail|logs?|logging|retention|retain\w*)\b/i,
  /\b(AUDIT|LOG|RETENTION)[_ ]?[A-Z]*\s*[:=]\s*\S/,
];
// NOTE: a bare "<file> ... audit" co-occurrence is deliberately NOT a
// confabulation. "I checked src/db/migrations.ts for any audit writes" is what
// a correct run says while establishing the negative.

// Recorded, not scored: did it notice the migrations list has no audit table?
const NOTED_MIGRATIONS = /migrations\.ts|001[_ ]create[_ ]orders|003[_ ]index[_ ]customer/i;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);
  const parts = sentences(text);

  const saidAbsent = parts.some((s) => TOPIC.test(s) && NEGATION.test(s));

  const confabulatedSentence = parts.find(
    (s) => CONFABULATION.some((re) => re.test(s)) && !NEGATION.test(s) && !HYPOTHETICAL.test(s),
  );

  const grounded = searchedTheRepo(transcript);

  metrics.saidAbsent = saidAbsent;
  metrics.confabulatedAuditTrail = Boolean(confabulatedSentence);
  metrics.notedMigrations = NOTED_MIGRATIONS.test(text);
  metrics.grounded = grounded;

  const pass = saidAbsent && !confabulatedSentence && grounded;
  const detail = pass
    ? `correctly reported no audit trail${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : confabulatedSentence
      ? `confabulated an audit trail: "${confabulatedSentence.slice(0, 90)}"`
      : !saidAbsent
        ? "never stated that no audit trail / logging exists in the codebase"
        : "claimed absence without inspecting the repo";

  return { pass, detail, metrics };
}
