// Read-only view of the order book, straight from RPC (no wallet, no bindings).
// Shared by the app (chain.ts re-exports it) and the landing page's live deals
// (landing.ts), so both show the same offers and repos.
import { Account, Address, BASE_FEE, Contract, TransactionBuilder, contract as sdkContract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, REPO_ID, RPC_URL } from "./config";

export const server = new rpc.Server(RPC_URL);

// --- types (normalised from on-chain structs, contracts/repo/src/types.rs) ----

export type Status = "Open" | "MarginCall" | "Repaid" | "Defaulted" | "Liquidated";

export interface Offer {
  id: bigint;
  lender: string;
  collateral_asset: string;
  principal: bigint;
  apr_bps: bigint;
  term_secs: bigint;
  created_at: bigint;
}

export interface Repo {
  id: bigint;
  offer_id: bigint;
  lender: string;
  borrower: string;
  collateral_asset: string;
  collateral_amount: bigint;
  principal: bigint;
  interest: bigint;
  haircut_bps: bigint;
  start_ts: bigint;
  maturity_ts: bigint;
  margin_call_deadline: bigint | null;
  status: Status;
  auto_repay: boolean;
}

export const big = (v: unknown) => BigInt(v as bigint | number | string);

// Read-only call on a contract without TS bindings, from the all-zero source
// account the SDK's own read-only simulations use.
export async function simulateView<T>(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<T> {
  const tx = new TransactionBuilder(new Account(sdkContract.NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const ret = sim.result?.retval;
  return (ret ? scValToNative(ret) : undefined) as T;
}

// --- offers and repos straight from ledger entries ------------------------------
// The contract has no list getter. Ids are sequential counters in instance
// storage (DataKey::NextOfferId / NextRepoId), offers are deleted on take or
// cancel, repos are kept. So: read the counters, then batch-read every
// Offer(i) / Repo(i) persistent entry in one getLedgerEntries call each.

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const dataKey = (variant: string, id?: bigint) =>
  xdr.ScVal.scvVec(id === undefined ? [sym(variant)] : [sym(variant), xdr.ScVal.scvU64(new xdr.Uint64(id))]);

export const contractDataKey = (key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(REPO_ID).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

export async function getCounters(): Promise<{ nextOffer: bigint; nextRepo: bigint }> {
  const res = await server.getLedgerEntries(contractDataKey(xdr.ScVal.scvLedgerKeyContractInstance()));
  const entry = res.entries[0];
  let nextOffer = 1n;
  let nextRepo = 1n;
  if (entry) {
    const storage = entry.val.contractData().val().instance().storage() ?? [];
    for (const e of storage) {
      const k = scValToNative(e.key());
      if (Array.isArray(k) && k[0] === "NextOfferId") nextOffer = big(scValToNative(e.val()));
      if (Array.isArray(k) && k[0] === "NextRepoId") nextRepo = big(scValToNative(e.val()));
    }
  }
  return { nextOffer, nextRepo };
}

async function readEntries(variant: "Offer" | "Repo", next: bigint): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const ids: bigint[] = [];
  for (let i = 1n; i < next; i++) ids.push(i);
  for (let start = 0; start < ids.length; start += 150) {
    const keys = ids.slice(start, start + 150).map((i) => contractDataKey(dataKey(variant, i)));
    const res = await server.getLedgerEntries(...keys);
    for (const e of res.entries) out.push(scValToNative(e.val.contractData().val()) as Record<string, unknown>);
  }
  return out;
}

const normOffer = (o: Record<string, unknown>): Offer => ({
  id: big(o.id),
  lender: String(o.lender),
  collateral_asset: String(o.collateral_asset),
  principal: big(o.principal),
  apr_bps: big(o.apr_bps),
  term_secs: big(o.term_secs),
  created_at: big(o.created_at),
});

export const normRepo = (r: Record<string, unknown>): Repo => ({
  id: big(r.id),
  offer_id: big(r.offer_id),
  lender: String(r.lender),
  borrower: String(r.borrower),
  collateral_asset: String(r.collateral_asset),
  collateral_amount: big(r.collateral_amount),
  principal: big(r.principal),
  interest: big(r.interest),
  haircut_bps: big(r.haircut_bps),
  start_ts: big(r.start_ts),
  maturity_ts: big(r.maturity_ts),
  margin_call_deadline: r.margin_call_deadline == null ? null : big(r.margin_call_deadline),
  status: (Array.isArray(r.status) ? r.status[0] : r.status) as Status,
  auto_repay: r.auto_repay === true,
});

export async function getBook(): Promise<{ offers: Offer[]; repos: Repo[] }> {
  const { nextOffer, nextRepo } = await getCounters();
  const [o, r] = await Promise.all([readEntries("Offer", nextOffer), readEntries("Repo", nextRepo)]);
  const byIdDesc = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? 1 : -1);
  return { offers: o.map(normOffer).sort(byIdDesc), repos: r.map(normRepo).sort(byIdDesc) };
}
