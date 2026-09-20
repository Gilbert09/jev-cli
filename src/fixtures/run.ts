import { formatReport, runSuite, type FixtureSuite } from "./harness.js";
// Suites test question wording, not the shipped on/off default. Set before the
// first loadConfig() call, which caches.
process.env.JEV_FORCE_ENABLED = "1";

import { loadConfig } from "../core/config.js";

import { suite as guardSuite } from "../capabilities/guard/suite.js";
import { suite as screenSuite } from "../capabilities/screen/suite.js";
import { suite as doneSuite } from "../capabilities/done/suite.js";
import { suite as rankSuite } from "../capabilities/rank/suite.js";

const SUITES: Record<string, FixtureSuite<string>> = {
  guard: guardSuite,
  screen: screenSuite,
  done: doneSuite,
  rank: rankSuite,
};

async function main(): Promise<void> {
  if (!loadConfig().apiKey) {
    process.stderr.write(
      "fixtures: TYPESAFE_API_KEY is not set.\n" +
        "These suites deliberately run against the live Jev API — they measure\n" +
        "whether the questions are worded well, which a mock cannot tell you.\n",
    );
    process.exitCode = 1;
    return;
  }

  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(SUITES);

  let passed = 0;
  let total = 0;
  for (const name of names) {
    const suite = SUITES[name];
    if (!suite) {
      process.stderr.write(`fixtures: unknown suite "${name}"\n`);
      process.exitCode = 1;
      return;
    }
    if (suite.cases.length === 0) {
      process.stdout.write(`\n${name}: no cases\n`);
      continue;
    }
    const report = await runSuite(suite);
    process.stdout.write(formatReport(report) + "\n");
    passed += report.passed;
    total += report.total;
  }

  process.stdout.write(
    `\noverall: ${passed}/${total} (${total === 0 ? 0 : Math.round((passed / total) * 100)}%)\n`,
  );
  // Non-zero when anything failed, so this can gate CI once tuned.
  process.exitCode = passed === total ? 0 : 1;
}

void main();
