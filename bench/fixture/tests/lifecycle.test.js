import { test } from "node:test";
import assert from "node:assert";
import { canTransition } from "../src/orders/lifecycle.ts";

test("valid transitions", () => {
  assert.equal(canTransition("draft", "reserved"), true);
  assert.equal(canTransition("shipped", "cancelled"), false);
});
