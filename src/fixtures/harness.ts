/**
 * Fixture harness.
 *
 * The plumbing in this repo is straightforward; the part that decides whether
 * jev is any good is the wording of ~20 questions. So every capability ships a
 * labelled suite that runs against the LIVE Jev API and asserts the final
 * decision — not the raw score — because the decision is what users feel.
 *
 * Output is a pass rate plus a confusion matrix, which is the number we tune
 * question wording against.
 */

export interface FixtureCase<Label extends string> {
  name: string;
  /** Capability-specific input, passed straight to the suite's `run`. */
  input: unknown;
  expect: Label;
  /** Why this case exists — especially valuable for deliberate near-misses. */
  notes?: string;
}

export interface FixtureSuite<Label extends string> {
  capability: string;
  /** All possible labels, in the order they should appear in the matrix. */
  labels: readonly Label[];
  cases: ReadonlyArray<FixtureCase<Label>>;
  /** Run one case through the real handler and return the observed label. */
  run: (input: unknown) => Promise<Label>;
}

export interface CaseOutcome<Label extends string> {
  name: string;
  expected: Label;
  actual: Label | "ERROR";
  pass: boolean;
  ms: number;
  notes?: string;
}

export interface SuiteReport<Label extends string> {
  capability: string;
  outcomes: CaseOutcome<Label>[];
  passed: number;
  total: number;
  matrix: Record<string, Record<string, number>>;
}

export async function runSuite<Label extends string>(
  suite: FixtureSuite<Label>,
): Promise<SuiteReport<Label>> {
  const outcomes: CaseOutcome<Label>[] = [];

  // Sequential on purpose: concurrent runs make rate limits and latency
  // measurements both harder to read, and suites are small.
  for (const c of suite.cases) {
    const started = Date.now();
    let actual: Label | "ERROR";
    try {
      actual = await suite.run(c.input);
    } catch (err) {
      actual = "ERROR";
      process.stderr.write(`  ! ${c.name}: ${(err as Error).message}\n`);
    }
    outcomes.push({
      name: c.name,
      expected: c.expect,
      actual,
      pass: actual === c.expect,
      ms: Date.now() - started,
      notes: c.notes,
    });
  }

  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of suite.labels) {
    matrix[expected] = Object.fromEntries([...suite.labels, "ERROR"].map((l) => [l, 0]));
  }
  for (const o of outcomes) {
    const row = matrix[o.expected];
    if (row) row[o.actual] = (row[o.actual] ?? 0) + 1;
  }

  return {
    capability: suite.capability,
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    total: outcomes.length,
    matrix,
  };
}

export function formatReport<Label extends string>(report: SuiteReport<Label>): string {
  const lines: string[] = [];
  const rate = report.total === 0 ? 0 : Math.round((report.passed / report.total) * 100);
  lines.push(`\n${report.capability}: ${report.passed}/${report.total} (${rate}%)`);

  const failures = report.outcomes.filter((o) => !o.pass);
  if (failures.length > 0) {
    lines.push("  failures:");
    for (const f of failures) {
      lines.push(`    ${f.name}: expected ${f.expected}, got ${f.actual}`);
      if (f.notes) lines.push(`        ${f.notes}`);
    }
  }

  const cols = Object.keys(Object.values(report.matrix)[0] ?? {});
  const width = Math.max(10, ...Object.keys(report.matrix).map((r) => r.length) ) + 2;
  lines.push("  confusion (rows = expected, cols = actual):");
  lines.push("    " + "".padEnd(width) + cols.map((c) => c.padStart(8)).join(""));
  for (const [rowLabel, row] of Object.entries(report.matrix)) {
    lines.push(
      "    " + rowLabel.padEnd(width) + cols.map((c) => String(row[c] ?? 0).padStart(8)).join(""),
    );
  }

  const times = report.outcomes.map((o) => o.ms).sort((a, b) => a - b);
  if (times.length > 0) {
    const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    lines.push(`  latency: p50 ${p50}ms, p95 ${p95}ms`);
  }
  return lines.join("\n");
}
