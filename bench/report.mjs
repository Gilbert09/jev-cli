#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const file = join(HERE, "results", "runs.jsonl");
if (!existsSync(file)) { console.error("no results yet"); process.exit(1); }

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * The smallest difference this many runs per arm could detect at 80% power.
 * Printed next to every cell, because a null result at n=9 and a null result at
 * n=90 are completely different claims and the bare percentages look identical.
 */
function detectable(n, p1 = 0.85) {
  if (n < 2) return null;
  const za = 1.96, zb = 0.84;
  for (let d = 0.01; d < 0.6; d += 0.005) {
    const p2 = Math.min(0.999, p1 + d);
    const pbar = (p1 + p2) / 2;
    const se0 = Math.sqrt((2 * pbar * (1 - pbar)) / n);
    const se1 = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / n);
    if (Math.abs(p2 - p1) >= za * se0 + zb * se1) return d;
  }
  return null;
}

/**
 * Wilson score interval. With 9 runs per cell a naive proportion is badly
 * overconfident, and the normal approximation misbehaves at 0/9 and 9/9 —
 * which are exactly the cells we expect here.
 */
function wilson(passes, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

/** Two-proportion z-test. Honest about small n: reports the statistic, not a verdict. */
function twoProp(a, na, b, nb) {
  if (na === 0 || nb === 0) return { z: 0, p: 1 };
  const p1 = a / na, p2 = b / nb;
  const pooled = (a + b) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  // Two-sided normal tail via erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = 2 * d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return { z, p: Math.min(1, Math.max(0, p)) };
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const cell = (rs) => {
  const n = rs.length;
  const k = rs.filter((r) => r.pass).length;
  return { n, k, rate: n ? k / n : 0, ci: wilson(k, n) };
};

const models = [...new Set(rows.map((r) => r.model))];
const caps = [...new Set(rows.map((r) => r.capability))];

console.log("=".repeat(78));
console.log("jev benchmark — pass rate by capability and arm");
console.log("  pass = the desired outcome (canaries survived / injection resisted /");
console.log("         work genuinely finished / correct answer). Higher is better.");
console.log("=".repeat(78));

for (const model of models) {
  console.log(`\n### ${model}\n`);
  console.log("  capability   baseline          jev               delta    2-prop z   p");
  console.log("  " + "-".repeat(72));
  for (const cap of caps) {
    const base = cell(rows.filter((r) => r.model === model && r.capability === cap && r.arm === "baseline"));
    const jev = cell(rows.filter((r) => r.model === model && r.capability === cap && r.arm === "jev"));
    if (base.n === 0 && jev.n === 0) continue;
    const { z, p } = twoProp(jev.k, jev.n, base.k, base.n);
    const delta = jev.rate - base.rate;
    console.log(
      `  ${cap.padEnd(12)} ${`${base.k}/${base.n} ${pct(base.rate)}`.padEnd(17)} ` +
      `${`${jev.k}/${jev.n} ${pct(jev.rate)}`.padEnd(17)} ` +
      `${(delta >= 0 ? "+" : "") + pct(delta)}`.padEnd(8) +
      ` ${z.toFixed(2).padStart(7)}  ${p < 0.001 ? "<0.001" : p.toFixed(3)}`,
    );
    const md = detectable(Math.min(base.n, jev.n));
    console.log(`  ${"".padEnd(12)} [${pct(base.ci[0])}-${pct(base.ci[1])}]`.padEnd(32) +
                `[${pct(jev.ci[0])}-${pct(jev.ci[1])}]`.padEnd(18) +
                (md ? `can detect >=${Math.round(md * 100)}pts` : "underpowered"));
  }
}

// Per-task detail: an aggregate can hide one task carrying the whole effect.
console.log("\n" + "=".repeat(78));
console.log("per-task (this is where an aggregate can lie)");
console.log("=".repeat(78));
const tasks = [...new Set(rows.map((r) => r.task))].sort();
for (const model of models) {
  console.log(`\n### ${model}`);
  for (const t of tasks) {
    const b = cell(rows.filter((r) => r.model === model && r.task === t && r.arm === "baseline"));
    const j = cell(rows.filter((r) => r.model === model && r.task === t && r.arm === "jev"));
    if (b.n === 0 && j.n === 0) continue;
    console.log(`  ${t.padEnd(26)} baseline ${b.k}/${b.n}   jev ${j.k}/${j.n}`);
  }
}

// Cost of the guarantee.
console.log("\n" + "=".repeat(78));
console.log("overhead — what jev costs in the session it protects");
console.log("=".repeat(78));
console.log("  model    arm       runs   $/run    turns   wall(s)   out-tokens");
for (const model of models) {
  for (const arm of ["baseline", "jev"]) {
    const rs = rows.filter((r) => r.model === model && r.arm === arm);
    if (!rs.length) continue;
    const avg = (f) => rs.reduce((s, r) => s + (f(r) || 0), 0) / rs.length;
    console.log(
      `  ${model.padEnd(8)} ${arm.padEnd(9)} ${String(rs.length).padStart(4)}   ` +
      `$${avg((r) => r.costUsd).toFixed(3)}   ${avg((r) => r.turns).toFixed(1).padStart(5)}   ` +
      `${(avg((r) => r.wallMs) / 1000).toFixed(0).padStart(6)}   ${avg((r) => r.outputTokens).toFixed(0).padStart(9)}`,
    );
  }
}

const spend = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
const bad = rows.filter((r) => r.timedOut || r.rateLimited);
console.log(`\n  total spend: $${spend.toFixed(2)} over ${rows.length} runs`);
if (bad.length) console.log(`  WARNING: ${bad.length} runs timed out or were rate limited — excluded conclusions may be biased`);

// The interaction hypothesis: does jev help a weaker model more?
if (models.length > 1) {
  console.log("\n" + "=".repeat(78));
  console.log("does jev help a weaker model more? (delta by model)");
  console.log("=".repeat(78));
  for (const model of models) {
    const b = cell(rows.filter((r) => r.model === model && r.arm === "baseline"));
    const j = cell(rows.filter((r) => r.model === model && r.arm === "jev"));
    console.log(`  ${model.padEnd(8)} baseline ${pct(b.rate)} -> jev ${pct(j.rate)}   delta ${(j.rate - b.rate >= 0 ? "+" : "") + pct(j.rate - b.rate)}`);
  }
}
