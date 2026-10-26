// npm test: resource padding for app txs (resources.ts), replaying the testnet
// repo 5 incident (tx eca39c31…: `default` simulated 660 write bytes, the
// network needed 956, so the tx failed with ResourceLimitExceeded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, contract, xdr } from "@stellar/stellar-sdk";
import { padAssembled, padSorobanData } from "../src/resources.ts";

// SorobanTransactionData of tx eca39c31818044052ab80c874531e6478e3415048bec5ebe4693d7dafb358ac0
const INCIDENT =
  "AAAAAAAAAAQAAAABAAAAAMq4irwmCprgsiqtQUFdf8hIliS3zjWGKwULHoxCp7KhAAAAAVVTREMAAAAAQj59BfLsr7/sGSshWj8b6WrtuNjnAlSr40E+AgfeVrIAAAAGAAAAAVBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8BAAAAFAAAAAEAAAAGAAAAAdi0gt0Xl9l702BO5zEhj19bNT+oAkYx2JKPrKf44AueAAAAFAAAAAEAAAAHwecoJ1uFRagc6X1diqIOFJDCE54gPsDj4NDMk7dt1xUAAAACAAAABgAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAABAAAAABAAAAAgAAAA8AAAAJQWxsb3dhbmNlAAAAAAAAEQAAAAEAAAACAAAADwAAAARmcm9tAAAAEgAAAAAAAAAAyriKvCYKmuCyKq1BQV1/yEiWJLfONYYrBQsejEKnsqEAAAAPAAAAB3NwZW5kZXIAAAAAEgAAAAHYtILdF5fZe9NgTucxIY9fWzU/qAJGMdiSj6yn+OALngAAAAAAAAAGAAAAAdi0gt0Xl9l702BO5zEhj19bNT+oAkYx2JKPrKf44AueAAAAEAAAAAEAAAACAAAADwAAAARSZXBvAAAABQAAAAAAAAAFAAAAAQATdBUAAAB0AAAClAAAAAAAADwB";
const REPO = "CDMLJAW5C6L5S66TMBHOOMJBR5PVWNJ7VABEMMOYSKH2ZJ7Y4AFZ5JEX"; // repo contract of the incident

const incident = () => xdr.SorobanTransactionData.fromXDR(INCIDENT, "base64");
const footprint = (d: xdr.SorobanTransactionData) => d.resources().footprint().toXDR("base64");
const envelopeData = (tx: { toEnvelope(): xdr.TransactionEnvelope }) =>
  tx.toEnvelope().v1().tx().ext().value() as xdr.SorobanTransactionData;

test("resources: fixture is the incident, unpadded it under-declares (660 < 956 write bytes)", () => {
  const d = incident();
  const r = d.resources();
  assert.equal(r.instructions(), 1_274_901);
  assert.equal(r.diskReadBytes(), 116);
  assert.equal(r.writeBytes(), 660);
  assert.ok(r.writeBytes() < 956);
  assert.equal(d.resourceFee().toBigInt(), 15_361n);
});

test("resources: padSorobanData covers what the network charged for repo 5's default", () => {
  const padded = padSorobanData(incident());
  const r = padded.resources();
  assert.ok(r.writeBytes() >= 956, `write bytes ${r.writeBytes()}`);
  assert.equal(r.writeBytes(), 660 * 2 + 2000);
  assert.ok(r.instructions() >= 1_657_371, `instructions ${r.instructions()}`);
  assert.equal(r.instructions(), Math.ceil(1_274_901 * 1.3));
  assert.ok(padded.resourceFee().toBigInt() >= 146_083n);
  assert.equal(padded.resourceFee().toBigInt(), 15_361n * 3n + 100_000n);
  assert.equal(r.diskReadBytes(), 116);
  assert.equal(footprint(padded), footprint(incident()));
});

// The incident's `default(5)` as an assembled, simulated tx, rebuilt offline
// (no RPC call: the SDK only builds an RpcServer object from rpcUrl).
function assembledIncident(signTransaction: contract.SignTransaction) {
  const source = Keypair.random().publicKey();
  const built = new TransactionBuilder(new Account(source, "41"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(REPO).call("default", xdr.ScVal.scvU64(xdr.Uint64.fromString("5"))))
    .setSorobanData(incident())
    .setTimeout(60)
    .build();
  const tx = contract.AssembledTransaction.fromJSON<null>(
    {
      method: "default",
      contractId: REPO,
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://soroban-testnet.stellar.org",
      publicKey: source,
      signTransaction,
      parseResultXdr: () => null,
    },
    {
      tx: built.toXDR(),
      simulationResult: { auth: [], retval: xdr.ScVal.scvVoid().toXDR("base64") },
      simulationTransactionData: INCIDENT,
    },
  );
  return { tx, built };
}

test("resources: submit path (padAssembled) signs an envelope with padded resources and fee", async () => {
  let walletSaw: string | null = null;
  const stub: contract.SignTransaction = async (txXdr) => {
    walletSaw = txXdr;
    return { signedTxXdr: txXdr };
  };
  const { tx, built } = assembledIncident(stub);
  const padded = padAssembled(tx);

  // Simulation data the SDK will declare on sign().
  assert.ok(padded.simulationData.transactionData.resources().writeBytes() >= 956);
  // The original is untouched.
  assert.equal(tx.simulationData.transactionData.resources().writeBytes(), 660);
  // Options survive the round trip (the wallet signer and public key).
  assert.equal(padded.options.signTransaction, stub);
  assert.equal(padded.options.publicKey, tx.options.publicKey);

  await padded.sign();
  assert.ok(walletSaw, "the stub signer was called");
  const signed = padded.signed!;
  const data = envelopeData(signed);
  const resourceFee = data.resourceFee().toBigInt();
  assert.ok(data.resources().writeBytes() >= 956, `signed write bytes ${data.resources().writeBytes()}`);
  assert.equal(resourceFee, 15_361n * 3n + 100_000n);
  assert.ok(BigInt(signed.fee) >= BigInt(BASE_FEE) + resourceFee, `fee ${signed.fee} vs resource fee ${resourceFee}`);
  assert.equal(footprint(data), footprint(incident()));
  assert.equal(
    signed.toEnvelope().v1().tx().operations()[0].toXDR("base64"),
    built.toEnvelope().v1().tx().operations()[0].toXDR("base64"),
  );
});
