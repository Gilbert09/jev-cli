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

const flat = (text) => sentences(text).join(" ");

const FIFTEEN = /\b(15|fifteen)\b\s*-?\s*(minutes?|mins?\b|m\b)/i;
const HOLD_CONST = /HOLD[_ ]?MINUTES\s*[:=]\s*15\b/i;
// The answer is only right if it is attached to the stock hold, not to some
// other 15 that happens to appear in the prose.
const TOPICAL = /(reserv|hold|held|inventory|stock|sku|expiresAt)/i;
// 15 minutes is a plausible guess for a cart hold, so require the answer to
// be traceable to this repo rather than to a prior about e-commerce defaults.
const EVIDENCE = /HOLD[_ ]?MINUTES|reserve\.ts|reaper\.ts|inventory\/reserve|expiresAt/i;
const RIGHT_FILE = /inventory[\/\\]+reserve\.ts/;

const DURATION = /\b(\d{1,4})\s*-?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/gi;
const TO_MINUTES = { second: 1 / 60, sec: 1 / 60, minute: 1, min: 1, hour: 60, hr: 60, day: 1440 };


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

  const hasFifteen = FIFTEEN.test(flat(text)) || HOLD_CONST.test(flat(text));
  const topical = TOPICAL.test(text);

  // A sentence about the hold that states some duration other than 15 minutes
  // and never says 15 is an asserted wrong answer. The trap this catches is
  // TOKEN_TTL_HOURS = 12 from src/auth/token.ts.
  const wrongDuration = sentences(text).some((s) => {
    if (!TOPICAL.test(s)) return false;
    if (/\b(15|fifteen)\b/i.test(s)) return false;
    return [...s.matchAll(DURATION)].some((m) => {
      const unit = m[2].toLowerCase().replace(/s$/, "").replace(/^hrs?$/, "hr");
      const minutes = Number(m[1]) * (TO_MINUTES[unit] ?? 0);
      return minutes > 0 && minutes !== 15;
    });
  });

  const grounded =
    searchedTheRepo(transcript) &&
    (EVIDENCE.test(text) || touchedPath(transcript, RIGHT_FILE));

  metrics.statedFifteenMinutes = hasFifteen;
  metrics.statedWrongDuration = wrongDuration;
  metrics.grounded = grounded;

  const pass = hasFifteen && topical && !wrongDuration && grounded;
  const detail = pass
    ? `answered 15 minutes${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : !topical
      ? "final answer never mentions the stock hold"
      : wrongDuration
        ? "asserted a hold duration other than 15 minutes"
        : !hasFifteen
          ? "final answer does not state the 15-minute hold"
          : "stated 15 minutes but never read it from the repo";

  return { pass, detail, metrics };
}
