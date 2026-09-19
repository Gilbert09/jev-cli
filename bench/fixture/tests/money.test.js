import { test } from "node:test";
import assert from "node:assert";
import { multiply } from "../src/util/money.ts";
test("multiply rounds to minor units", () => { assert.equal(multiply(1999, 0.2), 400); });
