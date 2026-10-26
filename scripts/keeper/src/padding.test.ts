// npm test: resource padding for keeper txs (padding.ts), replaying the
// testnet repo 5 incident (tx eca39c31…, simulated 660 write bytes, network
// needed 956).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { padSorobanData, padTransaction } from "./padding.js";

// SorobanTransactionData of tx eca39c31818044052ab80c874531e6478e3415048bec5ebe4693d7dafb358ac0
const INCIDENT =
  "AAAAAAAAAAQAAAABAAAAAMq4irwmCprgsiqtQUFdf8hIliS3zjWGKwULHoxCp7KhAAAAAVVTREMAAAAAQj59BfLsr7/sGSshWj8b6WrtuNjnAlSr40E+AgfeVrIAAAAGAAAAAVBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8BAAAAFAAAAAEAAAAGAAAAAdi0gt0Xl9l702BO5zEhj19bNT+oAkYx2JKPrKf44AueAAAAFAAAAAEAAAAHwecoJ1uFRagc6X1diqIOFJDCE54gPsDj4NDMk7dt1xUAAAACAAAABgAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAABAAAAABAAAAAgAAAA8AAAAJQWxsb3dhbmNlAAAAAAAAEQAAAAEAAAACAAAADwAAAARmcm9tAAAAEgAAAAAAAAAAyriKvCYKmuCyKq1BQV1/yEiWJLfONYYrBQsejEKnsqEAAAAPAAAAB3NwZW5kZXIAAAAAEgAAAAHYtILdF5fZe9NgTucxIY9fWzU/qAJGMdiSj6yn+OALngAAAAAAAAAGAAAAAdi0gt0Xl9l702BO5zEhj19bNT+oAkYx2JKPrKf44AueAAAAEAAAAAEAAAACAAAADwAAAARSZXBvAAAABQAAAAAAAAAFAAAAAQATdBUAAAB0AAAClAAAAAAAADwB";
const REPO = "CDMLJAW5C6L5S66TMBHOOMJBR5PVWNJ7VABEMMOYSKH2ZJ7Y4AFZ5JEX"; // repo contract of the incident
const INCLUSION_FEE = String(Number(BASE_FEE) * 1000);

const incident = () => xdr.SorobanTransactionData.fromXDR(INCIDENT, "base64");
const footprint = (d: xdr.SorobanTransactionData) => d.resources().footprint().toXDR("base64");

test("fixture is the incident: 1274901 instructions, 116 read, 660 write, fee 15361", () => {
  const r = incident().resources();
  assert.equal(r.instructions(), 1_274_901);
  assert.equal(r.diskReadBytes(), 116);
  assert.equal(r.writeBytes(), 660);
  assert.equal(incident().resourceFee().toBigInt(), 15_361n);
});

test("padSorobanData covers what the network charged for repo 5's default", () => {
  const padded = padSorobanData(incident());
  const r = padded.resources();
  assert.ok(r.writeBytes() >= 956, `write bytes ${r.writeBytes()}`);
  assert.equal(r.writeBytes(), 660 * 2 + 2000);
  assert.ok(r.instructions() >= 1_657_371, `instructions ${r.instructions()}`);
  assert.ok(padded.resourceFee().toBigInt() >= 146_083n);
  assert.equal(r.diskReadBytes(), 116);
  assert.equal(footprint(padded), footprint(incident()));
  // the input is not mutated
  assert.equal(incident().resources().writeBytes(), 660);
});

test("padTransaction: fee = inclusion fee + padded resource fee, op and footprint kept", () => {
  const source = new Account(Keypair.random().publicKey(), "41");
  const assembled = new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(REPO).call("default", xdr.ScVal.scvU64(xdr.Uint64.fromString("5"))))
    .setSorobanData(incident())
    .setTimeout(60)
    .build();
  assert.equal(Number(assembled.fee), Number(INCLUSION_FEE) + 15_361);

  const padded = padTransaction(assembled);
  const data = padded.toEnvelope().v1().tx().ext().value() as xdr.SorobanTransactionData;
  const resourceFee = data.resourceFee().toBigInt();
  assert.equal(resourceFee, 15_361n * 3n + 100_000n);
  assert.ok(BigInt(padded.fee) >= BigInt(BASE_FEE) + resourceFee);
  assert.equal(BigInt(padded.fee), BigInt(INCLUSION_FEE) + resourceFee);
  assert.ok(data.resources().writeBytes() >= 956);
  assert.equal(footprint(data), footprint(incident()));
  assert.equal(padded.sequence, assembled.sequence);
  assert.equal(padded.operations.length, 1);
  assert.equal(
    padded.toEnvelope().v1().tx().operations()[0].toXDR("base64"),
    assembled.toEnvelope().v1().tx().operations()[0].toXDR("base64"),
  );
});
