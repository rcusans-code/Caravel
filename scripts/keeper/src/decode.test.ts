// npm test: a repo opened by fill_request (borrow requests) decodes the same
// way as an offer-born one. The keeper reads repos with scValToNative and uses
// only the fields it names, so the added `request_id` must not change them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = () => nativeToScVal(Keypair.random().publicKey(), { type: "address" });

/** The Repo struct as the contract stores it: a map with keys in sorted order (contracttype). */
function repoScVal(requestId: bigint | null): xdr.ScVal {
  const fields: [string, xdr.ScVal][] = [
    ["auto_repay", xdr.ScVal.scvBool(false)],
    ["borrower", addr()],
    ["collateral_amount", nativeToScVal(11_000_000_000n, { type: "i128" })],
    ["collateral_asset", nativeToScVal("CDCYRLASS44B6UUZNUJCXTYIJUXJOWG4LBECAD66S3467SAKWY6PBO5I", { type: "address" })],
    ["haircut_bps", nativeToScVal(300, { type: "u32" })],
    ["id", nativeToScVal(1n, { type: "u64" })],
    ["interest", nativeToScVal(9_301_370n, { type: "i128" })],
    ["lender", addr()],
    ["margin_call_deadline", xdr.ScVal.scvVoid()],
    ["maturity_ts", nativeToScVal(1_420n, { type: "u64" })],
    ["offer_id", nativeToScVal(requestId === null ? 1n : 0n, { type: "u64" })],
    ["principal", nativeToScVal(9_700_000_000n, { type: "i128" })],
    ["request_id", requestId === null ? xdr.ScVal.scvVoid() : nativeToScVal(requestId, { type: "u64" })],
    ["start_ts", nativeToScVal(1_000n, { type: "u64" })],
    ["status", xdr.ScVal.scvVec([sym("Open")])],
  ];
  return xdr.ScVal.scvMap(fields.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
}

test("request-born and offer-born repos decode to the same keeper fields", () => {
  const fromOffer = scValToNative(repoScVal(null));
  const fromRequest = scValToNative(repoScVal(7n));
  for (const r of [fromOffer, fromRequest]) {
    assert.deepEqual(r.status, ["Open"]);
    assert.equal(r.principal, 9_700_000_000n);
    assert.equal(r.interest, 9_301_370n);
    assert.equal(r.collateral_amount, 11_000_000_000n);
    assert.equal(r.maturity_ts, 1_420n);
    assert.equal(r.margin_call_deadline, null);
    assert.equal(r.auto_repay, false);
  }
  assert.equal(fromOffer.request_id, null);
  assert.equal(fromRequest.request_id, 7n);
  assert.equal(fromRequest.offer_id, 0n);
});
