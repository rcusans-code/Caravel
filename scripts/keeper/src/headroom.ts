// Write-byte headroom for simulated Soroban txs (twin of padWrites in
// app/src/chain.ts; keep the two numbers equal).
//
// When a token call inside the contract fails and is rolled back (try_transfer
// / try_transfer_from: `pay_or_park`, `push_or_park`, the auto-repay pull),
// testnet simulation declares fewer write bytes than the host then charges, so
// the tx lands FAILED with txFailed/invokeHostFunctionResourceLimitExceeded.
// The gap is the size of entries the rolled-back call touched and nothing else
// wrote. Measured: default with a failed auto-repay pull 660 simulated / 956
// needed, claim_in_kind 3,024 / 3,248 (runbook: scripts/README.md,
// "Under-simulated write bytes"). The keeper sends every write with this headroom.
import { xdr } from "@stellar/stellar-sdk";

/** Extra write bytes per tx: ~7x the largest gap measured (296 B). */
export const PAD_WRITE_BYTES = 2048;
/**
 * Extra resource fee (stroops) so the padded write bytes are paid for. Only
 * the write-byte share (a few thousand stroops for 2 KB) is kept by the
 * network; the rest of this cap is refundable and comes back unused.
 */
export const PAD_RESOURCE_FEE = 200_000n;

/** A copy of `data` with PAD_WRITE_BYTES more write bytes and PAD_RESOURCE_FEE more resource fee. */
export function padWrites(
  data: xdr.SorobanTransactionData,
  bytes = PAD_WRITE_BYTES,
  fee = PAD_RESOURCE_FEE,
): xdr.SorobanTransactionData {
  const out = xdr.SorobanTransactionData.fromXDR(data.toXDR());
  const r = out.resources();
  r.writeBytes(r.writeBytes() + bytes);
  out.resourceFee(xdr.Int64.fromString((out.resourceFee().toBigInt() + fee).toString()));
  return out;
}
