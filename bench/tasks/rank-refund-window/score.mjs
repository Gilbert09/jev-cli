import { filesRead, finalText, toolCalls } from "../../lib/helpers.mjs";

// The MCP tool arrives as `mcp__<server>__rank`. Match on the leaf so a rename
// of the server in the runner's --mcp-config does not silently zero the metric.
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
    // input_tokens alone is misleading here: almost everything is cached, so a
    // run that reads 35 files shows input_tokens ~20 and cache_read ~45000.
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: result?.total_cost_usd ?? 0,
  };
}

/** Sentence-ish units. Split on newlines FIRST so markdown headings do not get
 *  glued onto the prose that follows them. */
function sentences(text) {
  return String(text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((s) => s.replace(/[`*_#>|~]/g, " ").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const flat = (text) => sentences(text).join(" ");

// Accept the number in words or digits, with or without a hyphen, and accept
// the answer given purely as the constant.
const NINETY = /\b(90|ninety)\b\s*-?\s*(calendar\s+|business\s+)?days?\b/i;
const NINETY_CONST = /REFUND[_ ]?WINDOW[_ ]?DAYS\s*[:=]\s*90\b/i;
const REFUNDISH = /refund/i;
// 90 days is also Stripe's documented refund window, so the number alone is
// not evidence of retrieval. These strings only come from this repo.
const EVIDENCE = /REFUND[_ ]?WINDOW[_ ]?DAYS|refund\.ts|isRefundable|billing\/refund/i;
const RIGHT_FILE = /billing[\/\\]+refund\.ts/;

// Any "<n> day(s)" duration, used only to detect a competing asserted window.
const DAY_DURATION = /\b(\d{1,4})\s*-?\s*days?\b/gi;
const WINDOW_WORDS = /\b(window|within|up to|after|older than|limit|period|deadline|cut ?off|eligib)/i;


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

  const hasNinety = NINETY.test(flat(text)) || NINETY_CONST.test(flat(text));
  const topical = REFUNDISH.test(text);

  // A sentence that is about the refund window, states some other day count,
  // and never mentions 90, is an asserted wrong answer. Sentences that contain
  // 90 as well are fine ("accepted up to 90 days; past 120 finance steps in").
  const wrongWindow = sentences(text).some((s) => {
    if (!REFUNDISH.test(s) || !WINDOW_WORDS.test(s)) return false;
    if (/\b(90|ninety)\b/i.test(s)) return false;
    return [...s.matchAll(DAY_DURATION)].some((m) => Number(m[1]) !== 90);
  });

  const grounded =
    searchedTheRepo(transcript) &&
    (EVIDENCE.test(text) || touchedPath(transcript, RIGHT_FILE));

  metrics.statedNinetyDays = hasNinety;
  metrics.statedWrongWindow = wrongWindow;
  metrics.grounded = grounded;

  const pass = hasNinety && topical && !wrongWindow && grounded;
  const detail = pass
    ? `answered 90 days${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : !topical
      ? "final answer never mentions refunds"
      : wrongWindow
        ? "asserted a refund window other than 90 days"
        : !hasNinety
          ? "final answer does not state the 90-day window"
          : "stated 90 days but never read it from the repo (Stripe's default is also 90)";

  return { pass, detail, metrics };
}
