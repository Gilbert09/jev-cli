import { test } from "node:test";
import assert from "node:assert";
import { isRetryable, nextDelay } from "../src/util/retry.ts";

test("retries on 429 and 5xx", () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 400 }), false);
});

test("backoff is capped", () => {
  for (let i = 0; i < 20; i++) assert.ok(nextDelay(i) <= 5000);
});
