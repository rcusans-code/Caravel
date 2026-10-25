import {
  Account,
  Address,
  Asset as ClassicAsset,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  contract as sdkContract,
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
  TSAFO,
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
  auto_repay: boolean;
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
}

export interface AssetConfig {
  haircut_bps: bigint;
  enabled: boolean;
  /** NAV older than this blocks take / check_margin / liquidate (per asset, DECISIONS.md #25). */
  max_nav_age_secs: bigint;
  /** Exposure cap: max debt of live repos on this asset, USDC units (DECISIONS.md #31). 0 = no new repos; null = contract predates #31. */
  max_open_debt: bigint | null;
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
  /** tSAFO units (5 decimals); null when tSAFO is not deployed. No trustline. */
  tsafo: bigint | null;
  /** On the tSAFO issuer allowlist (Spiko-style, checked on every transfer). */
  tsafoAllowed: boolean;
}

/** Balance and issuer permission for one collateral token. */
export function holding(b: Balances, sac: string): { amount: bigint | null; allowed: boolean } {
  if (TSAFO && sac === TSAFO.sac) return { amount: b.tsafo, allowed: b.tsafoAllowed };
  return { amount: b.tbenji, allowed: b.tbenjiAuthorized };
}

const big = (v: unknown) => BigInt(v as bigint | number | string);

// --- read-only clients (simulation needs no signer) ----------------------------

const readRepo = new RepoClient({ contractId: REPO_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const readOracle = new OracleClient({ contractId: ORACLE_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const oracleAsset = (sac: string) => ({ tag: "Stellar" as const, values: [sac] as const });

// Read-only call on a contract without TS bindings (the tSAFO mock), from the
// all-zero source account the SDK's own read-only simulations use.
async function simulateView<T>(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<T> {
  const tx = new TransactionBuilder(new Account(sdkContract.NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const ret = sim.result?.retval;
  return (ret ? scValToNative(ret) : undefined) as T;
}

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
  };
}

export async function getAssetConfig(sac: string): Promise<AssetConfig | null> {
  // Raw read, not the typed binding: the binding decodes AssetConfig by
  // position, so it throws on a contract whose struct has fewer fields
  // (deployed before #25 or #31). Error #8 = AssetNotSupported.
  let a: { haircut_bps: unknown; enabled: boolean; max_nav_age_secs?: unknown; max_open_debt?: unknown };
  try {
    a = await simulateView(REPO_ID, "asset", new Address(sac).toScVal());
  } catch (e) {
    if (/Error\(Contract, #8\)/.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
  // Contracts deployed before DECISIONS.md #25 keep max_nav_age_secs in config().
  const maxAge =
    a.max_nav_age_secs ?? ((await readRepo.config()).result as unknown as { max_nav_age_secs: unknown }).max_nav_age_secs;
  return {
    haircut_bps: big(a.haircut_bps),
    enabled: a.enabled,
    max_nav_age_secs: big(maxAge),
    max_open_debt: a.max_open_debt === undefined ? null : big(a.max_open_debt),
  };
}

/** Debt of live repos on this collateral (#31); null on a contract without open_debt(). */
export async function getOpenDebt(sac: string): Promise<bigint | null> {
  try {
    return big((await readRepo.open_debt({ asset: sac })).result);
  } catch {
    return null;
  }
}

export async function getNav(sac: string = TBENJI_SAC): Promise<Nav | null> {
  const [last, dec] = await Promise.all([
    readOracle.lastprice({ asset: oracleAsset(sac) }),
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
  auto_repay: r.auto_repay === true,
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
  if (res.status === 404)
    return { exists: false, xlm: 0n, usdc: null, tbenji: null, tbenjiAuthorized: false, tsafo: TSAFO ? 0n : null, tsafoAllowed: false };
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const acc = (await res.json()) as {
    balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; is_authorized?: boolean }[];
  };
  const find = (code: string, issuer: string) =>
    acc.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
  const native = acc.balances.find((b) => b.asset_type === "native");
  const u = find(USDC.code, USDC.issuer);
  const t = find(TBENJI.code, TBENJI.issuer);
  const who = new Address(address).toScVal();
  const [tsafo, tsafoAllowed] = TSAFO
    ? await Promise.all([
        simulateView<bigint>(TSAFO.sac, "balance", who).then(BigInt),
        simulateView<boolean>(TSAFO.sac, "is_whitelisted", who),
      ])
    : [null, false];
  return {
    exists: true,
    xlm: native ? horizonToUnits(native.balance) : 0n,
    usdc: u ? horizonToUnits(u.balance) : null,
    tbenji: t ? horizonToUnits(t.balance) : null,
    tbenjiAuthorized: !!t?.is_authorized,
    tsafo,
    tsafoAllowed,
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

/** `autoRepay` also signs a USDC allowance so the debt is pulled at maturity (DECISIONS.md #27). */
export async function takeOffer(signer: Signer, offerId: bigint, autoRepay: boolean): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.take_offer({ borrower: signer.address, offer_id: offerId, auto_repay: autoRepay }));
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

export async function setAutoRepay(signer: Signer, repoId: bigint, enabled: boolean): Promise<TxOutcome<null>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.set_auto_repay({ repo_id: repoId, enabled }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
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
  // The SDK's Client appends "_" to JS reserved words when it registers spec
  // methods (stellar-sdk bindings sanitizeIdentifier), so the runtime method is
  // `default_` even though the generated typings still say `default`.
  const callDefault = (c as unknown as { default_: RepoClient["default"] }).default_.bind(c);
  const out = await submit(await callDefault({ repo_id: repoId }));
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

/** Admin only: mock oracle `set_price` (contracts/oracle) for collateral `sac`. */
export async function setNav(signer: Signer, price: bigint, sac: string = TBENJI_SAC): Promise<TxOutcome<null>> {
  const c = new OracleClient({ contractId: ORACLE_ID, ...clientOpts(signer) });
  const out = await submit(await c.set_price({ asset: oracleAsset(sac), price }));
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
