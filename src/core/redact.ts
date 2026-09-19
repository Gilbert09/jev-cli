/**
 * Strip credential-shaped strings before any content leaves the machine.
 *
 * This is defence in depth, not a guarantee: `screen` and `rank` send content
 * to the TypeSafe API by design, and the README says so plainly. The goal here
 * is to stop the obvious accidents — a key pasted into a file the agent
 * happened to read.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Provider-prefixed keys (Anthropic, OpenAI, TypeSafe, Stripe, GitHub, Slack).
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,})\b/g, "[redacted-api-key]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key-id]"],
  // PEM private key blocks, body and all.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  ],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  // KEY=value / TOKEN: value assignments in env files and configs.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'\n]{6,})["']?/gi,
    (_m: string, name: string) => `${name}=[redacted]`,
  ] as unknown as [RegExp, string],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** Truncate to a byte budget, keeping the head (where instructions usually sit). */
export function truncate(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) return { text: input, truncated: false };
  // Slice on a byte boundary, then drop any partial trailing code point.
  const text = buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { text, truncated: true };
}

/** Prepare untrusted content for evaluation: redact, then bound. */
export function prepare(input: string, maxBytes: number): { text: string; truncated: boolean } {
  return truncate(redact(input), maxBytes);
}
