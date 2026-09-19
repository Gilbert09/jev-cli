import { filesRead, finalText, toolCalls } from "../../lib/helpers.mjs";

// The MCP tool arrives as `mcp__<server>__rank`. Match on the leaf so a rename
// of the server in the runner's --mcp-config does not silently zero the metric.
const RANK_TOOL = /(^|__)rank$/;
// Tools that can only have produced their output by touching the repo.
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

/** Sentence-ish units. Split on newlines FIRST so markdown headings do not get
 *  glued onto the prose that follows them. Note `_` becomes a space, so any
 *  CONSTANT_NAME must be matched with `[_ ]?` between the words. */
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

/** Did any tool call reference this path? Covers Read, a Grep pattern, a
 *  `cat`/`sed` in Bash, and the candidate list passed to rank. */
function touchedPath(transcript, re) {
  return toolCalls(transcript).some((t) => re.test(JSON.stringify(t.input)));
}

const TAXY = /\bVAT\b|value[-\s]?added\s+tax|\btax(es|ed|ation)?\b/i;
// Accept the rate as a percentage, as the fraction, or purely as the constant.
const RATE_20 = /\b20(\.0+)?\s*%|\b0\.20?\b|\bVAT[_ ]?RATE\b/i;
// 20% VAT is the UK default and eminently guessable, so the number alone is not
// evidence of retrieval. These strings only come from this repo.
const EVIDENCE = /VAT[_ ]?RATE|withVat|billing[\/\\]tax|\btax\.ts\b|createOrder|orders[\/\\]create|\bcreate\.ts\b/i;
const ANSWER_FILES = /(billing[\/\\]+tax\.ts|orders[\/\\]+create\.ts)/;

const PCT = /\b(\d{1,3}(?:\.\d+)?)\s*%/g;
const HYPOTHETICAL =
  /\b(would|could|should|might|may|e\.?g\.?|i\.?e\.?|for example|such as|suggest|recommend|consider|propose|example|placeholder|typical|typically|common|commonly|usual|usually|often|if you|you'?d|you'?ll|unless|assuming|hypothetical|possibly|potentially|perhaps|maybe|likely|probably|appears|seems)\b/i;
const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bnowhere\b|\babsent\b|\bmissing\b|\blacks?\b|\bwithout\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b)/i;
// Recorded, not scored. Nothing in the fixture adds shipping, delivery or
// handling money to a total, but haiku often raises one as a UX aside AFTER
// correctly naming VAT, and failing a right answer for a stray aside measured
// phrasing rather than retrieval (2 of the first 5 calibration runs).
const FEE_CLAIM = /\b(shipping|delivery|handling|postage|packaging|service)\s+(fee|cost|charge|surcharge)/i;
// Recorded, not scored: did it understand VAT is applied once on the subtotal?
const ORDER_LEVEL = /order[-\s]?level|per[-\s]?line|whole order|on the subtotal|to the subtotal|once on the/i;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);
  const parts = sentences(text);

  const hasTax = TAXY.test(text);
  const hasRate = RATE_20.test(text.replace(/_/g, " ")) || RATE_20.test(text);

  // A sentence about the tax that asserts some other percentage, and never
  // mentions 20, is an asserted wrong rate. Sentences that also say 20 are fine.
  const wrongRate = parts.some((s) => {
    if (!TAXY.test(s)) return false;
    if (/\b20(\.0+)?\s*%|\b0\.20?\b/.test(s)) return false;
    return [...s.matchAll(PCT)].some((m) => Number(m[1]) !== 20);
  });

  const mentionedOtherFee = parts.some(
    (s) => FEE_CLAIM.test(s) && !NEGATION.test(s) && !HYPOTHETICAL.test(s),
  );

  const grounded =
    searchedTheRepo(transcript) &&
    (EVIDENCE.test(text) || touchedPath(transcript, ANSWER_FILES));

  metrics.statedTax = hasTax;
  metrics.statedTwentyPercent = hasRate;
  metrics.statedWrongRate = wrongRate;
  metrics.mentionedOtherFee = mentionedOtherFee;
  metrics.explainedOrderLevel = ORDER_LEVEL.test(text);
  metrics.grounded = grounded;

  const pass = hasTax && hasRate && !wrongRate && grounded;
  const detail = pass
    ? `identified 20% VAT${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : !hasTax
      ? "final answer never identifies the extra amount as tax/VAT"
      : wrongRate
        ? "asserted a tax rate other than 20%"
        : !hasRate
          ? "named tax but never gave the 20% / VAT_RATE figure"
          : "stated 20% VAT without reading it from the repo (20% is the UK default)";

  return { pass, detail, metrics };
}
