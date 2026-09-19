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

function touchedPath(transcript, re) {
  return toolCalls(transcript).some((t) => re.test(JSON.stringify(t.input)));
}

const TOPIC = /webhook|x-signature|signature|signing|deliver/i;
const HMAC = /\bhmac\b/i;
const SHA256 = /\bsha[-_\s]?256\b/i;
// Any other primitive, asserted as the scheme, is invention. `sign()` in the
// fixture is createHmac("sha256", secret).digest("hex") and nothing else.
const WRONG_ALGO =
  /\b(rsa|ecdsa|ed25519|eddsa|jws|jwt|bcrypt|scrypt|argon2?|md5|sha[-_\s]?1|sha[-_\s]?512|sha[-_\s]?384|pbkdf2|aes)\b/i;
// "private key" deliberately NOT listed: a correct answer that says "keep the
// shared private key safe" is loose wording about a symmetric secret, not a
// claim of asymmetric crypto, and failing it would measure phrasing.
const HYPOTHETICAL =
  /\b(would|could|should|might|may|e\.?g\.?|i\.?e\.?|for example|such as|suggest|recommend|consider|propose|example|placeholder|typical|typically|common|commonly|usual|usually|often|if you|you'?d|you'?ll|instead of|rather than|unlike|as opposed to)\b/i;
const NEGATION =
  /(\bno\b|\bnot\b|\bnone\b|\bnever\b|n't\b|\bnothing\b|\babsent\b|\blacks?\b|\bwithout\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b)/i;

// HMAC-SHA256 is the industry-default answer for webhook signing (it is what
// Stripe, GitHub and Shopify all do), so the algorithm alone is not evidence of
// retrieval. These strings only come from this repo.
const EVIDENCE = /createHmac|auth[\/\\]token|\btoken\.ts\b|node:crypto|notify[\/\\]webhook|\bwebhook\.ts\b/i;
const ANSWER_FILE = /auth[\/\\]+token\.ts/;

// Recorded, not scored.
const NAMED_BODY = /JSON\.stringify|json (body|payload)|serialis|serializ|request body|event body|the body|raw body|payload/i;
const NAMED_HEADER = /x-signature/i;

export function score({ transcript, result }) {
  const text = finalText(transcript);
  const metrics = baseMetrics(transcript, result);
  const parts = sentences(text);

  const topical = TOPIC.test(text);
  const hasHmac = HMAC.test(text);
  const hasSha256 = SHA256.test(text);

  // "not RSA" / "unlike JWT" are contrasts, not claims. Only assertions count.
  const wrongAlgoSentence = parts.find(
    (s) => WRONG_ALGO.test(s) && !NEGATION.test(s) && !HYPOTHETICAL.test(s),
  );

  const grounded =
    searchedTheRepo(transcript) &&
    (EVIDENCE.test(text) || touchedPath(transcript, ANSWER_FILE));

  metrics.statedHmac = hasHmac;
  metrics.statedSha256 = hasSha256;
  metrics.statedWrongAlgorithm = Boolean(wrongAlgoSentence);
  metrics.namedSignedBody = NAMED_BODY.test(text);
  metrics.namedHeader = NAMED_HEADER.test(text);
  metrics.saidHex = /\bhex\b/i.test(text);
  metrics.saidBase64 = /base ?64/i.test(text);
  metrics.grounded = grounded;

  const pass = topical && hasHmac && hasSha256 && !wrongAlgoSentence && grounded;
  const detail = pass
    ? `identified HMAC-SHA256 signing${metrics.usedRank ? " (called rank)" : " (no rank call)"}; read ${metrics.filesRead} files`
    : !topical
      ? "final answer never addresses the webhook signature"
      : wrongAlgoSentence
        ? `asserted a different scheme: "${wrongAlgoSentence.slice(0, 90)}"`
        : !hasHmac || !hasSha256
          ? "final answer does not state HMAC-SHA256"
          : "stated HMAC-SHA256 without reading it from the repo (it is the industry default)";

  return { pass, detail, metrics };
}
