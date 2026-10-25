import {
  Address,
  Asset as ClassicAsset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Client as RepoClient } from "caravel-repo";
import { Client as OracleClient } from "caravel-oracle";
import type { contract } from "caravel-repo";
import { emitPhase } from "./txphase";
import {
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  ORACLE_ID,
  REPO_ID,
  RPC_URL,
  TBENJI,
  TBENJI_SAC,
  USDC,
} from "./config";
import { horizonToUnits } from "./format";
import type { Signer } from "./wallet";

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
}

export interface ProtocolConfig {
  admin: string;
  usdc: string;
  oracle: string;
  treasury: string;
  fee_bps: bigint;
  liquidation_discount_bps: bigint;
  day_secs: bigint;
  margin_window_secs: bigint;
  grace_secs: bigint;
  max_nav_age_secs: bigint;
}

export interface AssetConfig {
  haircut_bps: bigint;
  enabled: boolean;
}

export interface Nav {
  price: bigint;
  decimals: number;
  timestamp: bigint;
}

export interface Balances {
  exists: boolean;
  xlm: bigint;
  usdc: bigint | null; // null = no trustline
  tbenji: bigint | null;
  tbenjiAuthorized: boolean;
}

const big = (v: unknown) => BigInt(v as bigint | number | string);

// --- read-only clients (simulation needs no signer) ----------------------------

const readRepo = new RepoClient({ contractId: REPO_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const readOracle = new OracleClient({ contractId: ORACLE_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const TBENJI_ORACLE_ASSET = { tag: "Stellar" as const, values: [TBENJI_SAC] as const };

export async function getConfig(): Promise<ProtocolConfig> {
  const c = (await readRepo.config()).result;
  return {
    admin: c.admin,
    usdc: c.usdc,
    oracle: c.oracle,
    treasury: c.treasury,
    fee_bps: big(c.fee_bps),
    liquidation_discount_bps: big(c.liquidation_discount_bps),
    day_secs: big(c.day_secs),
    margin_window_secs: big(c.margin_window_secs),
    grace_secs: big(c.grace_secs),
    max_nav_age_secs: big(c.max_nav_age_secs),
  };
}

export async function getAssetConfig(sac: string): Promise<AssetConfig | null> {
  const r = (await readRepo.asset({ asset: sac })).result;
  if (r.isErr()) return null;
  const a = r.unwrap();
  return { haircut_bps: big(a.haircut_bps), enabled: a.enabled };
}

export async function getNav(): Promise<Nav | null> {
  const [last, dec] = await Promise.all([
    readOracle.lastprice({ asset: TBENJI_ORACLE_ASSET }),
    readOracle.decimals(),
  ]);
  const p = last.result;
  if (!p) return null;
  return { price: big(p.price), decimals: Number(dec.result), timestamp: big(p.timestamp) };
}

// --- offers and repos straight from ledger entries ------------------------------
// The contract has no list getter. Ids are sequential counters in instance
// storage (DataKey::NextOfferId / NextRepoId), offers are deleted on take or
// cancel, repos are kept. So: read the counters, then batch-read every
// Offer(i) / Repo(i) persistent entry in one getLedgerEntries call each.

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const dataKey = (variant: string, id?: bigint) =>
  xdr.ScVal.scvVec(id === undefined ? [sym(variant)] : [sym(variant), xdr.ScVal.scvU64(new xdr.Uint64(id))]);

const contractDataKey = (key: xdr.ScVal) =>
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

const normRepo = (r: Record<string, unknown>): Repo => ({
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
});

export async function getBook(): Promise<{ offers: Offer[]; repos: Repo[] }> {
  const { nextOffer, nextRepo } = await getCounters();
  const [o, r] = await Promise.all([readEntries("Offer", nextOffer), readEntries("Repo", nextRepo)]);
  const byIdDesc = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? 1 : -1);
  return { offers: o.map(normOffer).sort(byIdDesc), repos: r.map(normRepo).sort(byIdDesc) };
}

// --- balances (classic trustlines, via Horizon) -------------------------------

export async function getBalances(address: string): Promise<Balances> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) return { exists: false, xlm: 0n, usdc: null, tbenji: null, tbenjiAuthorized: false };
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const acc = (await res.json()) as {
    balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; is_authorized?: boolean }[];
  };
  const find = (code: string, issuer: string) =>
    acc.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
  const native = acc.balances.find((b) => b.asset_type === "native");
  const u = find(USDC.code, USDC.issuer);
  const t = find(TBENJI.code, TBENJI.issuer);
  return {
    exists: true,
    xlm: native ? horizonToUnits(native.balance) : 0n,
    usdc: u ? horizonToUnits(u.balance) : null,
    tbenji: t ? horizonToUnits(t.balance) : null,
    tbenjiAuthorized: !!t?.is_authorized,
  };
}

export async function friendbot(address: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error("Friendbot did not fund the account. Try again in a minute.");
}

// --- writes ---------------------------------------------------------------------

export interface TxOutcome<T> {
  hash: string;
  value: T;
}

const clientOpts = (signer: Signer) => ({
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: signer.address,
  // Report the wallet step to the UI (TxProgress): sign while the signer is open, submit once it returns.
  signTransaction: async (...args: Parameters<Signer["signTransaction"]>) => {
    emitPhase("sign");
    const out = await signer.signTransaction(...args);
    emitPhase("submit");
    return out;
  },
});

type Unwrappable<T> = { isErr(): boolean; unwrap(): T; unwrapErr?(): { message: string } };

async function submit<R>(tx: contract.AssembledTransaction<R>): Promise<TxOutcome<R>> {
  const sim = tx.simulation;
  if (sim && rpc.Api.isSimulationError(sim as rpc.Api.SimulateTransactionResponse)) {
    throw new Error((sim as rpc.Api.SimulateTransactionErrorResponse).error);
  }
  const sent = await tx.signAndSend();
  const hash = sent.getTransactionResponse?.txHash ?? sent.sendTransactionResponse?.hash ?? "";
  return { hash, value: sent.result };
}

function unwrapResult<T>(r: unknown): T {
  const res = r as Unwrappable<T>;
  if (res && typeof res.isErr === "function") {
    if (res.isErr()) throw new Error(res.unwrapErr?.().message ?? "Contract returned an error");
    return res.unwrap();
  }
  return r as T;
}

export async function createOffer(
  signer: Signer,
  args: { collateral: string; principal: bigint; aprBps: number; termSecs: bigint },
): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const tx = await c.create_offer({
    lender: signer.address,
    collateral_asset: args.collateral,
    principal: args.principal,
    apr_bps: args.aprBps,
    term_secs: args.termSecs,
  });
  const out = await submit(tx);
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

export async function cancelOffer(signer: Signer, offerId: bigint): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.cancel_offer({ offer_id: offerId }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

export async function takeOffer(signer: Signer, offerId: bigint): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.take_offer({ borrower: signer.address, offer_id: offerId }));
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

export async function repay(signer: Signer, repoId: bigint): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.repay({ repo_id: repoId }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

/** Adds collateral to a live repo. Clears a margin call once initial margin is restored (DECISIONS.md #20). */
export async function topUp(signer: Signer, repoId: bigint, amount: bigint): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.top_up({ repo_id: repoId, amount }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

/** Anyone can call it (the keeper does). Sets the margin-call deadline on the first breach. */
export async function checkMargin(signer: Signer, repoId: bigint): Promise<TxOutcome<Status>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.check_margin({ repo_id: repoId }));
  const status = unwrapResult<{ tag: Status } | Status>(out.value);
  return { hash: out.hash, value: typeof status === "string" ? status : status.tag };
}

export async function declareDefault(signer: Signer, repoId: bigint): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.default({ repo_id: repoId }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

export async function liquidate(signer: Signer, repoId: bigint): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.liquidate({ liquidator: signer.address, repo_id: repoId }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

export async function isLiquidator(address: string): Promise<boolean> {
  return (await readRepo.is_liquidator({ who: address })).result;
}

/** Admin only: mock oracle `set_price` (contracts/oracle). */
export async function setNav(signer: Signer, price: bigint): Promise<TxOutcome<null>> {
  const c = new OracleClient({ contractId: ORACLE_ID, ...clientOpts(signer) });
  const out = await submit(await c.set_price({ asset: TBENJI_ORACLE_ASSET, price }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

/** Adds the USDC and tBENJI trustlines a fresh wallet needs. */
export async function addTrustlines(signer: Signer, which: ("USDC" | "tBENJI")[]): Promise<TxOutcome<null>> {
  const account = await server.getAccount(signer.address);
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE });
  for (const code of which) {
    const a = code === "USDC" ? USDC : TBENJI;
    b.addOperation(Operation.changeTrust({ asset: new ClassicAsset(a.code, a.issuer) }));
  }
  const tx = b.setTimeout(120).build();
  emitPhase("sign");
  const { signedTxXdr } = await signer.signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: signer.address,
  });
  emitPhase("submit");
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error(`Trustline tx rejected: ${sent.errorResult?.result().switch().name}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 20 });
  if (done.status !== "SUCCESS") throw new Error(`Trustline tx ${done.status}`);
  return { hash: sent.hash, value: null };
}
