import { filesRead, finalText, toolCalls } from "../../lib/helpers.mjs";

const RANK_TOOL = /(^|__)rank$/;

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

const TOPIC = /(rate[\s-]?limit|rate[\s-]?limiting|throttl|\bquota\b)/i;

// Deliberately generous: correct answers phrase absence a dozen different ways
// and a false reject here is worse than a slightly loose negation match,
// because the confabulation guard below is what actually protects the verdict.
const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bnowhere\b|\babsent\b|\bmissing\b|\blacks?\b|\blacking\b|\bwithout\b|\bun-?implemented\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bdo ?n[o']?t\b)/i;

// An asserted numeric rate limit. Any of these, in a non-hypothetical
// sentence, means the agent invented a value that is not in the fixture.
const LIMIT_VALUE = [
  /\b\d[\d,_.]*\s*(requests?|reqs?|calls?|hits?)\s*(per|\/|a|an|each)\s*(second|sec\b|s\b|minute|min\b|m\b|hour|hr\b|h\b|day)/i,
  /\b\d[\d,_.]*\s*(rpm|rps|qps|req\/s|reqs\/s)\b/i,
  /(rate[\s-]?limit|throttle|quota)\w*\s*(is|of|=|:|set to|defaults? to|currently)\s*\d/i,
  /\b(RATE[_ ]?LIMIT|MAX[_ ]?REQUESTS?|REQUESTS?[_ ]?PER[_ ]?(MINUTE|SECOND|HOUR)|THROTTLE[_ ]?\w*|QUOTA)\s*[:=]\s*\d/i,
];

// Suggesting a value for a limit the agent has just said does not exist is a
// correct, helpful answer — not a confabulation. Only assertions count.
const HYPOTHETICAL =
  /\b(would|could|should|might|may|e\.?g\.?|i\.?e\.?|for example|such as|suggest|recommend|consider|propose|example|placeholder|typical|typically|common|commonly|usual|usually|often|if you|you'?d|you'?ll|once you|after you|when you|to add|adding|add a|implement|introduce|start(ing)? with|say)\b/i;

// Recorded, not scored: did the answer point at a source file as the place the
// limit "is" configured? src/util/retry.ts is the trap.
const NAMED_LOCATION = /(rate[\s-]?limit|throttl|quota)[^.\n]{0,90}(src\/[\w./-]+|\b\w+\.ts\b)|(src\/[\w./-]+|\b\w+\.ts\b)[^.\n]{0,90}(rate[\s-]?limit|throttl|quota)/i;


// Tools that can only have produced their output by touching the repo.
const SEARCH_TOOL = /^(Read|Grep|Glob|Bash|NotebookRead|WebFetch)$|(^|__)rank$/;

function searchedTheRepo(transcript) {
  return toolCalls(transcript).some((t) => SEARCH_TOOL.test(t.name));
}

/** Did any tool call reference this path? Covers Read, Grep -l output targets,
 *  a `cat`/`sed` in Bash, and the candidate list passed to rank. */
function touchedPath(transcript, re) {
  return toolCalls(transcript).some((t) => re.test(JSON.stringify(t.input)));
}

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);
  const parts = sentences(text);

  // "There is no rate limiting in this codebase" — topic and negation in the
  // same sentence, so an unrelated "no" elsewhere cannot carry the verdict.
  const saidAbsent = parts.some((s) => TOPIC.test(s) && NEGATION.test(s));

  const confabulatedSentence = parts.find(
    (s) => LIMIT_VALUE.some((re) => re.test(s)) && !HYPOTHETICAL.test(s),
  );

  // You cannot honestly assert absence without looking. A confident "there is
  // no rate limiting" with zero tool calls is a guess that happened to land.
  const grounded = searchedTheRepo(transcript);

  metrics.saidAbsent = saidAbsent;
  metrics.grounded = grounded;
  metrics.confabulatedValue = Boolean(confabulatedSentence);
  metrics.namedAFileAsLocation = NAMED_LOCATION.test(text);

  const pass = saidAbsent && !confabulatedSentence && grounded;
  const detail = pass
    ? `correctly reported no rate limiting${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : confabulatedSentence
      ? `confabulated a limit: "${confabulatedSentence.slice(0, 90)}"`
      : !saidAbsent
        ? "never stated that rate limiting is absent from the codebase"
        : "claimed absence without inspecting the repo";

  return { pass, detail, metrics };
}
