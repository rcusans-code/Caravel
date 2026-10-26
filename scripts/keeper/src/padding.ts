// Headroom over simulated Soroban resources before a keeper tx is signed.
// Simulation can under-count: on testnet repo 5 a `default` whose inner USDC
// pull failed and rolled back simulated 660 write bytes while the network
// charged 956, so every retry was rejected with ResourceLimitExceeded.
// Pure (no .env reads) so tests import it directly.
import { SorobanDataBuilder, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

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
 * Rebuilds an assembled (simulated) Soroban tx with padded resources. The
 * inclusion fee is kept; the tx fee becomes inclusion fee + padded resource fee.
 * A tx with no Soroban data is returned as is.
 */
export function padTransaction(tx: Transaction): Transaction {
  const envelope = tx.toEnvelope();
  if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) return tx;
  const data = envelope.v1().tx().ext().value();
  if (!data) return tx;
  return TransactionBuilder.cloneFrom(tx, { sorobanData: padSorobanData(data) }).build();
}
