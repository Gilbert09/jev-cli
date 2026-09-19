import type { FixtureCase, FixtureSuite } from "../../fixtures/harness.js";
import { describeFailure } from "../../core/types.js";
import { TUNING } from "./questions.js";
import { rankCandidates, type RankCandidate } from "./rank.js";

/**
 * Fixtures for `rank`.
 *
 * Two things are being measured, and only one of them is ranking quality:
 *
 *   hit   jev asserts the answer is in the set AND puts the right file in the
 *         top 3 — a shortlist Claude can act on.
 *   miss  jev asserts the answer is NOT in the set.
 *
 * So a "miss" is the correct outcome for every case whose answer is genuinely
 * absent, and that is the half of the matrix that matters most. Embedding
 * search cannot produce a miss: it always returns its nearest neighbour. If the
 * presence noul drifts high on absent cases, this tool is just a slower
 * nearest-neighbour search, and the confusion matrix says so immediately.
 *
 * Snippets are inline rather than read from disk so the suite measures question
 * wording, not this repo's file layout.
 */

export type Label = "hit" | "miss";

interface RankFixtureInput {
  query: string;
  /** Path that should be found, or null when the answer is genuinely absent. */
  answer: string | null;
  candidates: RankCandidate[];
  topK?: number;
}

/** A small, realistic service. Paths and content are deliberately plausible. */
const CORPUS: Record<string, string> = {
  "src/auth/tokens.ts": `import { createSigner } from "fast-jwt";
// The signing secret comes from AUTH_JWT_SECRET, rotated quarterly.
const secret = process.env.AUTH_JWT_SECRET ?? readSecretFile("/run/secrets/jwt");
export const sign = createSigner({ key: secret, expiresIn: "15m", algorithm: "HS256" });
export function issueAccessToken(userId: string, scopes: string[]) {
  return sign({ sub: userId, scopes });
}`,
  "src/auth/session.ts": `import { serialize } from "cookie";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const IDLE_TIMEOUT_SECONDS = 60 * 30;
export function sessionCookie(id: string, lastSeen: number) {
  const idleLeft = IDLE_TIMEOUT_SECONDS - (Date.now() / 1000 - lastSeen);
  const maxAge = Math.min(SESSION_TTL_SECONDS, Math.max(0, idleLeft));
  return serialize("sid", id, { httpOnly: true, sameSite: "lax", maxAge });
}`,
  "src/auth/password.ts": `import { hash, verify } from "@node-rs/argon2";
export const hashPassword = (plain: string) => hash(plain, { memoryCost: 19456, timeCost: 2 });
export const checkPassword = (plain: string, stored: string) => verify(stored, plain);`,
  "src/middleware/rate-limit.ts": `import { redis } from "../db/redis.js";
// Sliding window, 300 requests per minute per API key, 30 per minute anonymous.
const WINDOW_MS = 60_000;
export async function rateLimit(req, res, next) {
  const key = req.apiKey ? \`rl:key:\${req.apiKey}\` : \`rl:ip:\${req.ip}\`;
  const limit = req.apiKey ? 300 : 30;
  const used = await redis.incr(key);
  if (used === 1) await redis.pexpire(key, WINDOW_MS);
  if (used > limit) return res.status(429).set("Retry-After", "60").end();
  next();
}`,
  "src/middleware/request-id.ts": `import { randomUUID } from "node:crypto";
export function requestId(req, res, next) {
  req.id = req.get("x-request-id") ?? randomUUID();
  res.set("x-request-id", req.id);
  next();
}`,
  "src/middleware/cors.ts": `const ALLOWED = new Set(["https://app.example.com", "https://admin.example.com"]);
export function cors(req, res, next) {
  const origin = req.get("origin");
  if (origin && ALLOWED.has(origin)) res.set("access-control-allow-origin", origin);
  next();
}`,
  "src/http/retry.ts": `// Outbound HTTP retry policy: exponential backoff with full jitter.
const BASE_MS = 100;
const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has(err.status)) throw err;
      await sleep(Math.random() * BASE_MS * 2 ** attempt);
    }
  }
}`,
  "src/http/client.ts": `import { withRetry } from "./retry.js";
export const fetchJson = (url: string, init?: RequestInit) =>
  withRetry(() => fetch(url, init).then((r) => r.json()));`,
  "src/db/pool.ts": `import { Pool } from "pg";
// Pool size is per process; 8 processes * 12 = 96 connections, under the 120 cap.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 12),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});`,
  "src/db/redis.ts": `import Redis from "ioredis";
export const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });`,
  "src/db/migrations/0042_add_orders.sql": `ALTER TABLE orders ADD COLUMN settled_at timestamptz;
CREATE INDEX orders_settled_at_idx ON orders (settled_at);`,
  "src/billing/stripe-webhook.ts": `import { stripe } from "./client.js";
export function handleWebhook(req, res) {
  // Raw body is required: the signature is computed over the unparsed bytes.
  const event = stripe.webhooks.constructEvent(
    req.rawBody,
    req.get("stripe-signature"),
    process.env.STRIPE_WEBHOOK_SECRET!,
  );
  return dispatch(event);
}`,
  "src/billing/invoices.ts": `import { pool } from "../db/pool.js";
export async function listInvoices(customerId: string) {
  const { rows } = await pool.query("select * from invoices where customer_id = $1", [customerId]);
  return rows.map(toInvoice);
}`,
  "src/billing/client.ts": `import Stripe from "stripe";
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" });`,
  "src/email/send.ts": `import { ses } from "./ses.js";
export const send = (to: string, subject: string, html: string) =>
  ses.sendEmail({ Destination: { ToAddresses: [to] }, Message: { Subject: { Data: subject }, Body: { Html: { Data: html } } } });`,
  "src/email/templates/password-reset.ts": `export function passwordResetEmail(name: string, link: string) {
  return {
    subject: "Reset your password",
    html: \`<p>Hi \${name},</p><p>Use <a href="\${link}">this link</a> within 30 minutes.</p>\`,
  };
}`,
  "src/email/templates/welcome.ts": `export function welcomeEmail(name: string) {
  return { subject: "Welcome", html: \`<p>Welcome aboard, \${name}.</p>\` };
}`,
  "src/flags/evaluate.ts": `import { murmur3 } from "./hash.js";
// A flag is on for a user when the bucket falls under the rollout percentage.
export function evaluate(flag: Flag, userId: string): boolean {
  for (const rule of flag.rules) if (rule.userIds.includes(userId)) return rule.value;
  const bucket = murmur3(\`\${flag.key}:\${userId}\`) % 100;
  return bucket < flag.rolloutPercentage;
}`,
  "src/flags/store.ts": `import { redis } from "../db/redis.js";
export const loadFlags = async () => JSON.parse((await redis.get("flags")) ?? "{}");`,
  "src/export/csv.ts": `// Column order is part of the public contract; downstream sheets index by position.
const COLUMNS = ["id", "created_at", "customer", "total", "currency", "status"] as const;
export function toCsv(rows: Row[]): string {
  const head = COLUMNS.join(",");
  return [head, ...rows.map((r) => COLUMNS.map((c) => quote(r[c])).join(","))].join("\\n");
}`,
  "src/export/pdf.ts": `import { renderToStream } from "@react-pdf/renderer";
export const toPdf = (rows: Row[]) => renderToStream(<Report rows={rows} />);`,
  "src/search/index-config.ts": `// Analyzer for the product index: edge n-grams for prefix search, ASCII folding.
export const settings = {
  analysis: {
    analyzer: { product: { tokenizer: "edge_ngram_2_15", filter: ["lowercase", "asciifolding"] } },
    tokenizer: { edge_ngram_2_15: { type: "edge_ngram", min_gram: 2, max_gram: 15 } },
  },
};`,
  "src/search/query.ts": `export const productQuery = (term: string) => ({ multi_match: { query: term, fields: ["name^3", "description"] } });`,
  "tests/auth/tokens.test.ts": `import { issueAccessToken } from "../../src/auth/tokens.js";
it("signs an access token with the user id", () => {
  expect(decode(issueAccessToken("u1", ["read"])).sub).toBe("u1");
});`,
  "tests/middleware/rate-limit.test.ts": `import { rateLimit } from "../../src/middleware/rate-limit.js";
it("returns 429 once the window is exhausted", async () => { /* ... */ });`,
  "docs/architecture.md": `# Architecture
The API is an Express app behind an ALB. Auth is JWT based. Billing runs through
Stripe. Search runs on OpenSearch. See each src/ directory for detail.`,
  "README.md": `# example-service
Run \`npm start\`. Environment variables are documented in docs/config.md.`,
  "package.json": `{ "name": "example-service", "scripts": { "start": "node dist/server.js" } }`,
};

const ALL_PATHS = Object.keys(CORPUS);

function pick(paths: readonly string[]): RankCandidate[] {
  return paths.map((path) => ({ path, snippet: CORPUS[path] ?? "" }));
}

/** Everything in the corpus except the listed paths. Realistic distractors. */
function allExcept(excluded: readonly string[]): RankCandidate[] {
  const drop = new Set(excluded);
  return pick(ALL_PATHS.filter((path) => !drop.has(path)));
}

/**
 * Synthetic filler, used to push a case past the batch ceiling. Each file is a
 * plausible generated module so padding does not read as obvious noise — a
 * ranker that only has to beat lorem ipsum has not been tested.
 */
function filler(count: number, seed: number): RankCandidate[] {
  const domains = ["orders", "shipments", "catalog", "reviews", "tickets", "inventory", "returns"];
  const kinds = ["repository", "service", "mapper", "validator", "controller", "serializer"];
  const out: RankCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const domain = domains[(i + seed) % domains.length] ?? "orders";
    const kind = kinds[(i * 3 + seed) % kinds.length] ?? "service";
    out.push({
      path: `src/${domain}/${kind}-${i}.ts`,
      snippet: `import { pool } from "../db/pool.js";
// ${kind} for ${domain} records, generated module ${i}.
export class ${domain}${kind}${i} {
  async byId(id: string) { return pool.query("select * from ${domain} where id = $1", [id]); }
  async list(limit = 50) { return pool.query("select * from ${domain} limit $1", [limit]); }
}`,
    });
  }
  return out;
}

function shuffled(candidates: RankCandidate[], seed: number): RankCandidate[] {
  // Deterministic shuffle so a failure is reproducible; position must not be
  // what makes the answer findable.
  const out = [...candidates];
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a && b) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const present = (
  name: string,
  query: string,
  answer: string,
  candidates: RankCandidate[],
  notes: string,
): FixtureCase<Label> => ({ name, input: { query, answer, candidates }, expect: "hit", notes });

const absent = (
  name: string,
  query: string,
  candidates: RankCandidate[],
  notes: string,
): FixtureCase<Label> => ({ name, input: { query, answer: null, candidates }, expect: "miss", notes });

const CASES: FixtureCase<Label>[] = [
  // ---- the answer is in the set -------------------------------------------
  present(
    "jwt-secret",
    "Where does the JWT signing secret come from?",
    "src/auth/tokens.ts",
    shuffled(pick(ALL_PATHS), 11),
    "Whole corpus. Two other auth files compete; only one loads the secret.",
  ),
  present(
    "rate-limit",
    "How do we rate limit incoming API requests?",
    "src/middleware/rate-limit.ts",
    shuffled(pick(ALL_PATHS), 12),
    "A test file names the same concept — the implementation must still win.",
  ),
  present(
    "http-backoff",
    "What is the retry and backoff policy for outbound HTTP calls?",
    "src/http/retry.ts",
    shuffled(pick(ALL_PATHS), 13),
    "src/http/client.ts merely calls withRetry; the policy lives in retry.ts.",
  ),
  present(
    "pool-size",
    "Which file decides the database connection pool size?",
    "src/db/pool.ts",
    shuffled(pick(ALL_PATHS), 14),
    "Many files import the pool. Only one configures it.",
  ),
  present(
    "stripe-signature",
    "Where do we verify Stripe webhook signatures?",
    "src/billing/stripe-webhook.ts",
    shuffled(pick(ALL_PATHS), 15),
    "Three billing files, two of which are strong keyword distractors.",
  ),
  present(
    "password-reset-email",
    "How is the password reset email body rendered?",
    "src/email/templates/password-reset.ts",
    shuffled(pick(ALL_PATHS), 16),
    "src/email/send.ts and src/auth/password.ts both overlap on keywords.",
  ),
  present(
    "flag-evaluation",
    "Where is the logic that decides whether a feature flag is on for a user?",
    "src/flags/evaluate.ts",
    shuffled(pick(ALL_PATHS), 17),
    "flags/store.ts loads flags but decides nothing.",
  ),
  present(
    "session-expiry",
    "What controls when a session cookie expires?",
    "src/auth/session.ts",
    shuffled(pick(ALL_PATHS), 18),
    "tokens.ts also has an expiry, for a different object.",
  ),
  present(
    "csv-columns",
    "Where is the column order of the CSV export decided?",
    "src/export/csv.ts",
    shuffled(pick(ALL_PATHS), 19),
    "export/pdf.ts is the sibling distractor.",
  ),
  present(
    "search-analyzer",
    "Which file configures the search index analyzer?",
    "src/search/index-config.ts",
    shuffled(pick(ALL_PATHS), 20),
    "search/query.ts is about querying, not indexing.",
  ),
  present(
    "implementation-over-test",
    "Where is the sliding window that counts requests per API key?",
    "src/middleware/rate-limit.ts",
    shuffled(pick(ALL_PATHS), 21),
    "Near-miss: the test file describes the same behaviour in the same words.",
  ),
  present(
    "batched-60",
    "How do we verify that a Stripe webhook really came from Stripe?",
    "src/billing/stripe-webhook.ts",
    shuffled([...pick(ALL_PATHS), ...filler(35, 3)], 22),
    "~60 candidates: forces several batches, so the answer must survive a runoff.",
  ),
  present(
    "batched-130",
    "Where is the exponential backoff with jitter implemented?",
    "src/http/retry.ts",
    shuffled([...pick(ALL_PATHS), ...filler(105, 7)], 23),
    "~130 candidates over multiple rounds: proves the merge keeps the winner on top.",
  ),

  // ---- the answer is genuinely absent -------------------------------------
  absent(
    "no-graphql",
    "Where is the GraphQL schema defined?",
    shuffled(pick(ALL_PATHS), 31),
    "A REST service. The forced choice will name something; presence must say no.",
  ),
  absent(
    "no-kafka",
    "How is the Kafka consumer group sharded across workers?",
    shuffled(pick(ALL_PATHS), 32),
    "No message broker exists in this codebase at all.",
  ),
  absent(
    "no-push-certs",
    "Where is the iOS push notification certificate configured?",
    shuffled(pick(ALL_PATHS), 33),
    "Mobile concerns are absent; email and web only.",
  ),
  absent(
    "no-webrtc",
    "Where is the WebRTC peer connection set up?",
    shuffled(pick(ALL_PATHS), 34),
    "Networking files exist but none of them do this.",
  ),
  absent(
    "no-refunds",
    "Where is the refund flow implemented?",
    shuffled(pick(["src/billing/stripe-webhook.ts", "src/billing/invoices.ts", "src/billing/client.ts", "src/db/migrations/0042_add_orders.sql", "src/export/csv.ts"]), 35),
    "Hardest absent case: every candidate is a billing file. Keyword overlap is total, containment is nil.",
  ),
  absent(
    "no-terraform",
    "Where is the Terraform configuration for the production VPC?",
    shuffled(allExcept(["README.md", "docs/architecture.md"]), 36),
    "Infrastructure lives in another repository.",
  ),
  absent(
    "no-oauth-provider",
    "Which file implements our OAuth2 authorisation server endpoints?",
    shuffled(pick(["src/auth/tokens.ts", "src/auth/session.ts", "src/auth/password.ts", "src/middleware/cors.ts", "src/middleware/request-id.ts"]), 37),
    "We consume JWTs but issue no OAuth grants; the auth directory is a trap.",
  ),
  absent(
    "batched-absent",
    "Where do we generate the monthly revenue recognition report?",
    shuffled([...pick(ALL_PATHS), ...filler(90, 5)], 38),
    "Absence must survive batching: no single batch may talk the runoff into a yes.",
  ),
];

export const suite: FixtureSuite<Label> = {
  capability: "rank",
  labels: ["hit", "miss"],
  cases: CASES,
  run: async (input: unknown): Promise<Label> => {
    const fixture = input as RankFixtureInput;
    const result = await rankCandidates({
      query: fixture.query,
      candidates: fixture.candidates,
      // Top 3: a shortlist longer than this is not a saving over reading files.
      topK: fixture.topK ?? 3,
    });

    if (!result.ok) throw new Error(describeFailure(result.error));

    const asserted = result.present >= TUNING.presentThreshold;
    const found =
      fixture.answer === null ? true : result.ranked.some((r) => r.path === fixture.answer);
    return asserted && found ? "hit" : "miss";
  },
};
