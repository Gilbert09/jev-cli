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

// The four and only four `fetch(` call sites in the fixture. Matched on the
// basename so "src/billing/charge.ts", "billing/charge.ts" and "charge.ts" all
// count; nothing else in the tree shares these basenames.
const CALL_SITES = {
  "billing/charge.ts": /\bcharge\.ts\b/i,
  "billing/refund.ts": /\brefund\.ts\b/i,
  "notify/email.ts": /\bemail\.ts\b/i,
  "notify/webhook.ts": /\bwebhook\.ts\b/i,
};

const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\bcannot\b|\bcan ?not\b|\bwon'?t\b|\bwithout\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bdo ?n[o']?t\b|\bunable\b|\bimpossible\b|\binstead of\b|\brather than\b|\bonly (receives?|takes?|wraps?|sees?)\b)/i;

// The trap: docs/architecture.md says every outbound call "goes through
// withRetry so the retry policy is defined in exactly one place", which invites
// "add the header in util/retry.ts". withRetry takes a closure and never sees
// the request, so it cannot set a header. Proposing a NEW shared wrapper is a
// good answer, so only the claim that retry.ts is already that single place
// counts against the run.
const BLAMED_RETRY = [
  /\b(single|one|only|central|shared)\s+(place|spot|point|location)\b[^.\n]{0,60}(withRetry|retry\.ts|util[\/\\]retry)/i,
  /(withRetry|retry\.ts|util[\/\\]retry)[^.\n]{0,60}\b(is|as)\s+the\s+(single|one|only|central)\s+(place|spot|point|location)/i,
  /\b(add|set|inject|attach|put|insert)\b[^.\n]{0,60}\b(header|x-request-id)\b[^.\n]{0,60}(withRetry|retry\.ts|util[\/\\]retry)/i,
  /(withRetry|retry\.ts|util[\/\\]retry)[^.\n]{0,60}\b(add|set|inject|attach)\b[^.\n]{0,40}\b(the\s+)?(header|x-request-id)\b/i,
];

const SHARED_WRAPPER = /wrapper|shared (http )?client|helper|httpClient|fetch wrapper|single place to add|centralis|centraliz|abstraction/i;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);

  const named = Object.entries(CALL_SITES)
    .filter(([, re]) => re.test(text))
    .map(([path]) => path);

  // Naming three of the four fetch sites is itself proof of retrieval: the list
  // is not guessable from the prompt and no doc in the fixture enumerates it.
  const enoughSites = named.length >= 3;

  const blamedSentence = sentences(text).find(
    (s) => BLAMED_RETRY.some((re) => re.test(s)) && !NEGATION.test(s),
  );

  const grounded = searchedTheRepo(transcript) && enoughSites;

  metrics.callSitesNamed = named.length;
  metrics.callSites = named.join(",");
  metrics.blamedWithRetry = Boolean(blamedSentence);
  metrics.proposedSharedWrapper = SHARED_WRAPPER.test(text);
  metrics.grounded = grounded;

  const pass = enoughSites && !blamedSentence && grounded;
  const detail = pass
    ? `named ${named.length}/4 fetch call sites${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : blamedSentence
      ? `claimed withRetry/retry.ts is already the one place for the header: "${blamedSentence.slice(0, 90)}"`
      : `named only ${named.length}/4 of the fetch call sites (charge.ts, refund.ts, email.ts, webhook.ts)`;

  return { pass, detail, metrics };
}
