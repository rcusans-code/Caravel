// npm test: the keeper's reading of contract error codes (errors.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { xdr } from "@stellar/stellar-sdk";
import { Err, errName, outcomeOf, txFailReason } from "./errors.js";

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

test("Err lists every code in contracts/repo/src/errors.rs, same names", () => {
  const rs = readFileSync(new URL("../../../contracts/repo/src/errors.rs", import.meta.url), "utf8");
  const fromRs = Object.fromEntries([...rs.matchAll(/^\s*(\w+) = (\d+),/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual({ ...Err }, fromRs);
});

test("errName: code to the contract's name, unknown is empty", () => {
  assert.equal(errName(7), "InvalidStatus");
  assert.equal(errName(16), "AutoRepayFailed");
  assert.equal(errName(999), "");
  assert.equal(errName(null), "");
});

// TransactionResult of tx eca39c31… (repo 5 default, 2026-10-26 06:41): fee 6342 stroops,
// txFailed with one invokeHostFunction op that ran out of its declared resources.
const RESOURCE_LIMIT = "AAAAAAAAGMb/////AAAAAQAAAAAAAAAY/////QAAAAA=";

test("txFailReason names the outer and the op result of a failed tx", () => {
  assert.equal(txFailReason(RESOURCE_LIMIT), "txFailed/invokeHostFunctionResourceLimitExceeded");
  // the RPC client hands over the decoded result; same answer
  assert.equal(txFailReason(xdr.TransactionResult.fromXDR(RESOURCE_LIMIT, "base64")), "txFailed/invokeHostFunctionResourceLimitExceeded");
});

test("txFailReason: a successful or unreadable result is no failure reason", () => {
  const ok = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  });
  assert.equal(txFailReason(ok), "");
  assert.equal(txFailReason(ok.toXDR("base64")), "");
  assert.equal(txFailReason("not xdr"), "");
  assert.equal(txFailReason(undefined), "");
});
