// npm test: the keeper's reading of contract error codes (errors.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Err, outcomeOf } from "./errors.js";

test("codes match contracts/repo/src/errors.rs", () => {
  assert.equal(Err.StaleNav, 9);
  assert.equal(Err.NotDefaultable, 12);
  assert.equal(Err.NotDue, 15);
  assert.equal(Err.AutoRepayFailed, 16);
  assert.equal(Err.Paused, 17);
  assert.equal(Err.NavOutOfBand, 18);
});

test("NotDue (15) is pending like NotDefaultable (12): ledger clock lag, not a failure", () => {
  assert.equal(outcomeOf(15), "pending");
  assert.equal(outcomeOf(12), "pending");
});

test("NavOutOfBand (18) is out-of-band, not a failure", () => {
  assert.equal(outcomeOf(18), "out-of-band");
});

test("other mapped codes", () => {
  assert.equal(outcomeOf(9), "stale");
  assert.equal(outcomeOf(16), "short");
  assert.equal(outcomeOf(17), "paused");
  assert.equal(outcomeOf(1), "no-margin");
});

test("unknown codes and non-contract errors fail", () => {
  assert.equal(outcomeOf(7), "fail"); // InvalidStatus
  assert.equal(outcomeOf(13), "fail"); // NoPrice
  assert.equal(outcomeOf(100), "fail"); // token NotWhitelisted
  assert.equal(outcomeOf(null), "fail");
  assert.equal(outcomeOf(undefined), "fail");
});
