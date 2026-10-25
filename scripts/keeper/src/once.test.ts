// npm test: exit-code decision of `keeper --once`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onceExitCode } from "./once.js";

test("clean tick (holds and skips are not failures): exit 0", () => {
  assert.equal(onceExitCode(false, 0), 0);
});

test("a failed action inside the tick: exit 1", () => {
  assert.equal(onceExitCode(false, 1), 1);
  assert.equal(onceExitCode(false, 3), 1);
});

test("tick threw: exit 1", () => {
  assert.equal(onceExitCode(true, 0), 1);
});
