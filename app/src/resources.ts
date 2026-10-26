// Headroom over simulated Soroban resources before an app tx is signed.
// Simulation can under-count when a try_ sub-call writes, fails and is rolled
// back (pay_or_park parking a frozen payout, try_settle's refund, the USDC
// pull inside `default`): on testnet repo 5 a `default` simulated 660 write
// bytes while the network charged 956 (tx eca39c31…), so it failed with
// ResourceLimitExceeded. The keeper pads with the same numbers in
// scripts/keeper/src/padding.ts; keep the two copies equal.
// Imports only the SDK (no config/env), so `node --test` loads it directly.
import { SorobanDataBuilder, contract, xdr } from "@stellar/stellar-sdk";

const INSTRUCTIONS_X10 = 13; // ×1.3
const WRITE_BYTES_X = 2;
const WRITE_BYTES_PLUS = 2000;
const RESOURCE_FEE_X = 3n;
const RESOURCE_FEE_PLUS = 100_000n;

/** Instructions ×1.3, write bytes ×2 + 2000, resource fee ×3 + 100000; read bytes and footprint unchanged. */
export function padSorobanData(data: xdr.SorobanTransactionData): xdr.SorobanTransactionData {
  const r = data.resources();
  return new SorobanDataBuilder(data)
    .setResources(
      Math.ceil((r.instructions() * INSTRUCTIONS_X10) / 10),
      r.diskReadBytes(),
      r.writeBytes() * WRITE_BYTES_X + WRITE_BYTES_PLUS,
    )
    .setResourceFee(data.resourceFee().toBigInt() * RESOURCE_FEE_X + RESOURCE_FEE_PLUS)
    .build();
}

/**
 * A copy of a simulated AssembledTransaction whose simulation data carries the
 * padded resources, so `signAndSend()` declares them. Goes through the SDK's
 * public toJSON/fromJSON with the tx's own options, which keeps the signer,
 * public key, method, result parser and contract error types. `sign()` then
 * sets fee = the assembled fee + the padded resource fee.
 */
export function padAssembled<R>(tx: contract.AssembledTransaction<R>): contract.AssembledTransaction<R> {
  const json = JSON.parse(tx.toJSON()) as {
    tx: string;
    simulationResult: { auth: string[]; retval: string };
    simulationTransactionData: string;
  };
  const padded = padSorobanData(xdr.SorobanTransactionData.fromXDR(json.simulationTransactionData, "base64"));
  return contract.AssembledTransaction.fromJSON<R>(tx.options, {
    tx: json.tx,
    simulationResult: json.simulationResult,
    simulationTransactionData: padded.toXDR("base64"),
  });
}
