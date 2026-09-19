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

/** Sentences plus adjacent pairs. The verdict often straddles two sentences
 *  ("Shipped orders are terminal. cancelOrder throws."), and demanding all
 *  three concepts inside one sentence rejects perfectly correct answers. */
function chunks(text) {
  const parts = sentences(text);
  const out = [...parts];
  for (let i = 0; i < parts.length - 1; i++) out.push(`${parts[i]} ${parts[i + 1]}`);
  return out;
}

function searchedTheRepo(transcript) {
  return toolCalls(transcript).some((t) => SEARCH_TOOL.test(t.name));
}

function touchedPath(transcript, re) {
  return toolCalls(transcript).some((t) => re.test(JSON.stringify(t.input)));
}

const CANCELISH = /\bcancel/i;
const SHIPPED = /\bship(ped|ping|s)?\b/i;
const BLOCKED =
  /\b(cannot|can ?not|can'?t|won'?t|will not|not allowed|not permitted|not possible|impossible|disallow\w*|refus\w*|reject\w*|block\w*|throw\w*|fail\w*|error|prevent\w*|forbidden|denied|terminal|dead[-\s]?end|no allowed transitions|returns? false|\bfalse\b|\[\s*\])/i;

// An explicit claim that the shipped order CAN be cancelled through the code.
// Deliberately narrow: "support can cancel it manually in the database" is a
// correct answer to this prompt, not a contradiction, so manual routes are
// excluded from the check.
const ALLOWED_CLAIM =
  /\b(can|could|is able to|are able to|will be able to|allowed to|permitted to|possible to|able to)\s+(still\s+)?(be\s+)?cancel|cancel(l)?(ed|ation|able)\s+(is|are)\s+(allowed|permitted|possible|supported|fine)|order\s+can\s+be\s+cancel/i;
const MANUAL_ROUTE =
  /\bmanual\w*|by hand|out of band|outside (the|this) (code|service|flow)|directly|database|\bdb\b|\bsql\b|\bops\b|\badmin\b|\bfinance\b|credit note|support (team|agent)|editing the state|\bworkaround\b/i;

const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bcannot\b|\bcan ?not\b|\bwon'?t\b|\bwithout\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bdo ?n[o']?t\b|\bunable\b)/i;

// "shipped orders cannot be cancelled" is generic e-commerce common sense, so
// the claim alone is not evidence of retrieval. These strings only come from
// this repo's state machine.
const EVIDENCE = /canTransition|\bALLOWED\b|lifecycle\.ts|orders[\/\\]lifecycle|cannot cancel from|markShipped/i;
const ANSWER_FILE = /orders[\/\\]+lifecycle\.ts/;

// Recorded, not scored: the 90-day refund window is the keyword-reachable trap.
const NINETY = /\b(90|ninety)\b/;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);

  const saidBlocked = chunks(text).some(
    (c) => CANCELISH.test(c) && SHIPPED.test(c) && BLOCKED.test(c),
  );

  const allowedSentence = sentences(text).find(
    (s) => ALLOWED_CLAIM.test(s) && !NEGATION.test(s) && !MANUAL_ROUTE.test(s),
  );

  const grounded =
    searchedTheRepo(transcript) &&
    (EVIDENCE.test(text) || touchedPath(transcript, ANSWER_FILE));

  metrics.saidBlocked = saidBlocked;
  metrics.assertedCancelAllowed = Boolean(allowedSentence);
  metrics.citedRefundWindow = NINETY.test(text);
  metrics.saidManualProcess = /manual|by hand|credit note|out of band|ops\b|admin\b/i.test(text);
  metrics.grounded = grounded;

  const pass = saidBlocked && !allowedSentence && grounded;
  const detail = pass
    ? `correctly reported that a shipped order cannot be cancelled${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : allowedSentence
      ? `claimed the shipped order can be cancelled in code: "${allowedSentence.slice(0, 90)}"`
      : !saidBlocked
        ? "never stated that the code refuses to cancel a shipped order"
        : "stated the rule without reading it from the repo (it is generic e-commerce common sense)";

  return { pass, detail, metrics };
}
