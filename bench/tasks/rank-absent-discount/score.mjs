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

const TOPIC = /\b(discount(s|ed|ing)?|promo(tion(s|al)?|code)?s?|coupons?|vouchers?|offer codes?)\b/i;

// Deliberately generous: correct answers phrase absence a dozen different ways
// and a false reject here is worse than a loose negation match, because the
// confabulation guard below is what actually protects the verdict.
const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bnowhere\b|\babsent\b|\bmissing\b|\blacks?\b|\blacking\b|\bwithout\b|\bun-?implemented\b|\bunsupported\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bdo ?n[o']?t\b|\bzero\b|\bempty\b)/i;

// Proposing where a discount SHOULD go, after saying it does not exist, is a
// correct and helpful answer - not a confabulation. Only assertions count.
const HYPOTHETICAL =
  /\b(would|could|should|might|may|e\.?g\.?|i\.?e\.?|for example|such as|suggest|recommend|consider|propose|example|placeholder|typical|typically|common|commonly|usual|usually|often|if you|you'?d|you'?ll|once you|after you|when you|to add|adding|add a|implement|introduce|start(ing)? with|plan|proposal|step \d|option \d|say)\b/i;

// An asserted discount implementation: a place it "is" applied, or a constant.
const CONFABULATION = [
  // "Discounts are applied in tax.ts" - an assertion that the machinery exists.
  /\b(discount|promo\w*|coupon|voucher)\w*[^.\n]{0,30}\b(is|are|gets?)\b[^.\n]{0,30}\b(applied|resolved|handled|stored|validated|calculated|computed|looked up|deducted|subtracted|implemented|supported)\b/i,
  // "the promo-code lookup lives in src/orders/create.ts"
  /\b(discount|promo\w*|coupon|voucher)\w*[^.\n]{0,40}\b(lives?|sits?|happens?|is done|is defined)\b[^.\n]{0,30}\b(in|at|inside)\b/i,
  // An invented constant.
  /\b(DISCOUNT|PROMO|COUPON|VOUCHER)[_ ]?[A-Z]*\s*[:=]/,
];
// NOTE: a bare "<file> ... discount" co-occurrence is deliberately NOT a
// confabulation. "I searched src/billing/tax.ts for discount logic" is what a
// correct run says while establishing the negative.

// Recorded, not scored: did it notice VAT is the only percentage math there is?
const NOTED_VAT = /\bVAT\b|withVat|VAT[_ ]?RATE|\btax\.ts\b/i;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);
  const parts = sentences(text);

  // "There is no discount or promo-code support in this codebase" - topic and
  // negation in the same sentence, so an unrelated "no" cannot carry the verdict.
  const saidAbsent = parts.some((s) => TOPIC.test(s) && NEGATION.test(s));

  const confabulatedSentence = parts.find(
    (s) => CONFABULATION.some((re) => re.test(s)) && !NEGATION.test(s) && !HYPOTHETICAL.test(s),
  );

  // You cannot honestly assert absence without looking. A confident "there is
  // no discount code" with zero tool calls is a guess that happened to land.
  const grounded = searchedTheRepo(transcript);

  metrics.saidAbsent = saidAbsent;
  metrics.confabulatedLocation = Boolean(confabulatedSentence);
  metrics.notedVatIsOnlyRate = NOTED_VAT.test(text);
  metrics.grounded = grounded;

  const pass = saidAbsent && !confabulatedSentence && grounded;
  const detail = pass
    ? `correctly reported no discount/promo support${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : confabulatedSentence
      ? `confabulated discount handling: "${confabulatedSentence.slice(0, 90)}"`
      : !saidAbsent
        ? "never stated that discounts/promo codes are absent from the codebase"
        : "claimed absence without inspecting the repo";

  return { pass, detail, metrics };
}
