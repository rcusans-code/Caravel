// npm test: write-byte headroom added to every keeper tx (headroom.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { PAD_RESOURCE_FEE, PAD_WRITE_BYTES, padWrites } from "./headroom.js";

const simulated = () => new SorobanDataBuilder().setResources(1_000_000, 5_000, 660).setResourceFee(90_000n).build();

test("adds PAD_WRITE_BYTES and PAD_RESOURCE_FEE, keeps the rest", () => {
  const before = simulated();
  const after = padWrites(before);
  assert.equal(after.resources().writeBytes(), 660 + PAD_WRITE_BYTES);
  assert.equal(after.resourceFee().toBigInt(), 90_000n + PAD_RESOURCE_FEE);
  assert.equal(after.resources().instructions(), 1_000_000);
  assert.equal(after.resources().diskReadBytes(), 5_000);
});

test("covers every measured under-count (default 660 -> 956, claim_in_kind 3,024 -> 3,248)", () => {
  for (const [sim, needed] of [
    [660, 956],
    [3_024, 3_248],
  ]) {
    const data = new SorobanDataBuilder().setResources(1, 1, sim).setResourceFee(1n).build();
    assert.ok(padWrites(data).resources().writeBytes() >= needed);
  }
});

test("does not mutate the simulated data", () => {
  const before = simulated();
  const xdrBefore = before.toXDR("base64");
  padWrites(before);
  assert.equal(before.toXDR("base64"), xdrBefore);
});

test("a padded tx pays the extra resource fee in its total fee", async () => {
  const { Account, Contract, Networks, TransactionBuilder } = await import("@stellar/stellar-sdk");
  const build = (data: xdr.SorobanTransactionData) =>
    new TransactionBuilder(new Account("GAWPUXBFQ4R4FWHPER66YMQ2JDGNPTAYV4JGCXL27G2DB6QPUD4OFNYR", "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract("CBWTB23F5PQTGX2QYOA3FJB3M6ZHDRCTT33XFKHXFD5SJJFTJEA7YTD6").call("repay"))
      .setTimeout(60)
      .setSorobanData(data)
      .build();
  const plain = build(simulated());
  const padded = build(padWrites(simulated()));
  assert.equal(BigInt(padded.fee) - BigInt(plain.fee), PAD_RESOURCE_FEE);
});
