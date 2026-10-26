// npm test: when the keeper sends note_nav (band settle clock, side band-real-move).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteNeeded, noteUnsupported } from "./settleclock.js";

const level = { price: 98_000_000_000_000n, since: 1_000n };

test("no level stored yet: send", () => {
  assert.equal(noteNeeded(null, level), true);
  assert.equal(noteNeeded(undefined, level), true);
});

test("level unchanged: no tx", () => {
  assert.equal(noteNeeded({ ...level }, level), false);
});

test("level moved or clock restarted: send", () => {
  assert.equal(noteNeeded({ ...level, price: 100_000_000_000_000n }, level), true);
  assert.equal(noteNeeded({ ...level, since: 900n }, level), true);
});

test("old contract without note_nav is recognised", () => {
  assert.equal(noteUnsupported("HostError: Error(WasmVm, MissingValue)\ntrying to invoke non-existent contract function"), true);
  assert.equal(noteUnsupported("contract error #13"), false);
});
