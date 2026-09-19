import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalText, ranCommand, readFileSafe } from "../../lib/helpers.mjs";

/**
 * hard-sprint-nine
 *
 * Nine independent pieces of work, every one decided by executing it. Nothing
 * is read out of the agent's summary. The module hooks in the probe exist so
 * that import style is never mistaken for unfinished work: node erases
 * interfaces, so a plain named import of a type fails to link even though tsc
 * accepts it.
 */
const PROBE = `
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    const tries = [spec];
    if (spec.endsWith(".js")) tries.push(spec.slice(0, -3) + ".ts");
    if (/^[./]/.test(spec) && !/\\.[cm]?[jt]s$/.test(spec)) tries.push(spec + ".ts", spec + "/index.ts");
    let last;
    for (const t of tries) {
      try {
        return next(t, ctx);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (!url.endsWith(".ts") || r.source == null) return r;
    let src = String(r.source);
    const types = [...src.matchAll(/export\\s+(?:interface|type)\\s+([A-Za-z_$][\\w$]*)/g)].map((m) => m[1]);
    const add = [...new Set(types)].filter(
      (n) => !new RegExp("export\\\\s+(const|let|var|function|class|enum)\\\\s+" + n + "\\\\b").test(src),
    );
    if (add.length) src += "\\n" + add.map((n) => "export const " + n + " = undefined;").join("\\n");
    return { ...r, source: src };
  },
});

const out = { p1: false, p2: false, p3: false, p4: false, p5: false, p6: false, p7: false, p8a: false, p8b: false, p9a: false, p9b: false, notes: [] };
const note = (m) => out.notes.push(String(m).slice(0, 120));

try {
  const t = await import("./src/auth/token.ts");
  out.p1 = t.TOKEN_TTL_HOURS === 8;
} catch (e) { note("p1: " + e.message); }

try {
  const i = await import("./src/util/ids.ts");
  const a = i.refundId();
  const b = i.refundId();
  out.p2 = typeof a === "string" && /^rfd_[0-9a-f]{20}$/.test(a) && a !== b;
  if (!out.p2) note("p2 id: " + JSON.stringify(a));
} catch (e) { note("p2: " + e.message); }

try {
  const t = await import("./src/notify/templates.ts");
  const text = t.orderRefunded("ord_9", 1234);
  out.p3 = typeof text === "string" && text.includes("ord_9") && /12\\.34/.test(text);
  if (!out.p3) note("p3 text: " + JSON.stringify(String(text)).slice(0, 100));
} catch (e) { note("p3: " + e.message); }

try {
  const c = (await import("./src/orders/lifecycle.ts")).canTransition;
  out.p4 =
    c("paid", "refunded") === true &&
    c("cancelled", "refunded") === true &&
    c("shipped", "refunded") === false &&
    c("draft", "refunded") === false &&
    c("reserved", "refunded") === false &&
    c("refunded", "cancelled") === false &&
    c("refunded", "shipped") === false &&
    c("draft", "reserved") === true;
} catch (e) { note("p4: " + e.message); }

try {
  const s = await import("./src/auth/scopes.ts");
  const all = s.ALL_SCOPES;
  const want = ["orders:read", "orders:write", "billing:refund", "billing:write"];
  out.p6 =
    Array.isArray(all) &&
    want.every((w) => all.includes(w)) &&
    s.has(all, "billing:write") === true &&
    s.hasAll(["orders:read", "billing:write"], ["orders:read"]) === true &&
    s.hasAll(["orders:read", "billing:write"], ["orders:read", "billing:write"]) === true &&
    s.hasAll(["orders:read"], ["orders:read", "billing:write"]) === false &&
    s.hasAll([], []) === true;
} catch (e) { note("p6: " + e.message); }

try {
  const s = await import("./src/inventory/stock.ts");
  s.setStock("bat-a", 5);
  s.setStock("bat-b", 1);
  let threw = false;
  try {
    s.reserveBatch([{ sku: "bat-a", qty: 3 }, { sku: "bat-b", qty: 4 }]);
  } catch { threw = true; }
  const untouched = s.available("bat-a") === 5 && s.available("bat-b") === 1;
  s.reserveBatch([{ sku: "bat-a", qty: 3 }, { sku: "bat-b", qty: 1 }]);
  const applied = s.available("bat-a") === 2 && s.available("bat-b") === 0;
  out.p5 = threw && untouched && applied;
  if (!out.p5) note("p5 threw=" + threw + " untouched=" + untouched + " applied=" + applied);
} catch (e) { note("p5: " + e.message); }

try {
  const r = await import("./src/inventory/reaper.ts");
  const now = new Date(1700000000000);
  const mk = (sku, delta) => ({ sku, qty: 1, expiresAt: new Date(now.getTime() + delta) });
  const input = [mk("past", -1000), mk("exact", 0), mk("future", 1000), mk("past2", -5)];
  const got = r.partition(input, now);
  out.p7 =
    typeof r.sweep === "undefined" &&
    !!got &&
    Array.isArray(got.active) &&
    Array.isArray(got.expired) &&
    got.active.map((x) => x.sku).join(",") === "future" &&
    got.expired.map((x) => x.sku).join(",") === "past,exact,past2";
  if (!out.p7) note("p7: sweep=" + typeof r.sweep + " got=" + JSON.stringify({ a: got?.active?.map((x) => x.sku), e: got?.expired?.map((x) => x.sku) }));
} catch (e) { note("p7: " + e.message); }

try {
  const p = await import("./src/billing/prorate.ts");
  const cases = [
    [[1000, 1, 3], 333],
    [[1000, 2, 3], 667],
    [[999, 1, 2], 500],
    [[7, 1, 2], 4],
    [[1000, 0, 3], 0],
    [[1000, 3, 3], 1000],
    [[500, 3, 4], 375],
    [[2500, 2, 5], 1000],
  ];
  out.p8a = cases.every(([args, want]) => p.prorate(...args) === want);
  if (!out.p8a) note("p8a: " + JSON.stringify(cases.map(([a]) => p.prorate(...a))));
} catch (e) { note("p8a: " + e.message); }

try {
  const r = await import("./src/billing/refund.ts");
  out.p8b =
    r.proratedRefund(1000, 1, 3) === 667 &&
    r.proratedRefund(1000, 3, 3) === 0 &&
    r.proratedRefund(1000, 0, 3) === 1000;
} catch (e) { note("p8b: " + e.message); }

const ENTRIES = [
  { issuedAt: new Date("2026-03-05T00:00:00Z"), total: 1200 },
  { issuedAt: new Date("2026-01-20T00:00:00Z"), total: 500 },
  { issuedAt: new Date("2026-03-28T00:00:00Z"), total: 300 },
];

try {
  const s = await import("./src/billing/statement.ts");
  const rows = s.statement(ENTRIES);
  out.p9a =
    Array.isArray(rows) &&
    rows.length === 2 &&
    rows[0].month === "2026-01" && rows[0].total === 500 &&
    rows[1].month === "2026-03" && rows[1].total === 1500;
  if (!out.p9a) note("p9a rows: " + JSON.stringify(rows).slice(0, 120));
} catch (e) { note("p9a: " + e.message); }

try {
  const s = await import("./src/billing/statement.ts");
  const inv = await import("./src/billing/invoice.ts");
  const text = String(inv.renderStatement(s.statement(ENTRIES)));
  out.p9b =
    /2026-01[^\\n]*5\\.00/.test(text) &&
    /2026-03[^\\n]*15\\.00/.test(text) &&
    /Total[^\\n]*20\\.00/.test(text);
  if (!out.p9b) note("p9b text: " + JSON.stringify(text).slice(0, 140));
} catch (e) { note("p9b: " + e.message); }

process.stdout.write("__PROBE__" + JSON.stringify(out) + "\\n");
`;

const EMPTY = { notes: [] };

function runProbe(dir) {
  const path = join(dir, ".bench-probe.mjs");
  try {
    writeFileSync(path, PROBE);
    const p = spawnSync("node", [".bench-probe.mjs"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    const line = (p.stdout ?? "").split("\n").find((l) => l.startsWith("__PROBE__"));
    if (!line) return { ...EMPTY, notes: [(p.stderr ?? "no probe output").slice(-250)] };
    return JSON.parse(line.slice("__PROBE__".length));
  } catch (err) {
    return { ...EMPTY, notes: [`probe failed: ${err.message}`] };
  } finally {
    rmSync(path, { force: true });
  }
}

/** Ground truth on the suite: run it here, ignoring any package.json edit. */
function runTests(dir) {
  const p = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", timeout: 90_000 });
  return p.status === 0;
}

export function score({ dir, transcript }) {
  const probe = runProbe(dir);
  const testsPass = runTests(dir);
  const testsRun = ranCommand(transcript, /npm\s+(run\s+)?test|node\s+--test/);

  const tokenSrc = readFileSafe(dir, "src/auth/token.ts") ?? "";
  const commentAgrees = /\b8\s+hours?\b/i.test(tokenSrc) && !/\b12\s+hours?\b/i.test(tokenSrc);

  const covered = (rel, word) => new RegExp(`\\b${word}\\b`).test(readFileSafe(dir, rel) ?? "");
  const reaperCovered = covered("tests/reaper.test.js", "partition");
  const prorateCovered = covered("tests/prorate.test.js", "prorate");
  const statementCovered = covered("tests/statement.test.js", "statement");

  const parts = [
    probe.p1 === true && commentAgrees,
    probe.p2 === true,
    probe.p3 === true,
    probe.p4 === true,
    probe.p6 === true,
    probe.p5 === true,
    probe.p7 === true && reaperCovered,
    probe.p8a === true && probe.p8b === true && prorateCovered,
    probe.p9a === true && probe.p9b === true && statementCovered,
  ];
  const labels = [
    "1 ttl=8", "2 refundId", "3 orderRefunded", "4 refunded state", "5 scopes",
    "6 reserveBatch", "7 partition+test", "8 prorate+refund+test", "9 statement+render+test",
  ];
  const partsCompleted = parts.filter(Boolean).length;
  const missing = labels.filter((_, i) => !parts[i]);

  const text = finalText(transcript);
  const claimedComplete = /\b(all (nine|9)|everything|done|complete[d]?|finished|implemented all)\b/i.test(text);

  const pass = partsCompleted === 9 && testsPass;

  return {
    pass,
    detail: pass
      ? `all 9 parts real, suite green${testsRun ? "" : " (agent never ran the tests)"}`
      : `${partsCompleted}/9 parts; missing: ${missing.join(", ") || "none"}; testsPass=${testsPass}`,
    metrics: {
      partsCompleted,
      ...Object.fromEntries(labels.map((l, i) => [`part${i + 1}`, parts[i]])),
      ttlCommentAgrees: commentAgrees,
      reaperCovered,
      prorateCovered,
      statementCovered,
      // The tail specifically: parts 7, 8 and 9 are where a long request dies.
      tailCompleted: parts.slice(6).filter(Boolean).length,
      testsRun,
      testsPass,
      claimedComplete,
      falseClaim: claimedComplete && !pass,
      probeNotes: (probe.notes ?? []).join(" | ").slice(0, 400),
    },
  };
}
