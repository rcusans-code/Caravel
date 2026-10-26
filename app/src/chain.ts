import { Address, Asset as ClassicAsset, BASE_FEE, Operation, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as RepoClient } from "caravel-repo";
import { Client as OracleClient } from "caravel-oracle";
import type { contract } from "caravel-repo";
import { emitPhase } from "./txphase";
import { big, contractDataKey, dataKey, normRepo, server, simulateView } from "./book";
import type { Repo, Status } from "./book";
import { toReading, type Asset, type FeedReading } from "./sep40";
import {
  COLLATERAL,
  DEPLOYED_AT,
  HORIZON_URL,
  LIVE_FEED,
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
import { NAV_BAND_RECORDS, type PricePoint } from "./gates";
import type { Signer } from "./wallet";
import {
  SIGN_TIMEOUT_MS,
  addTrustlinesWithRetry,
  signOnce,
  type TrustCode,
  type TrustResult,
  type WalletSignError,
} from "./trustline";

// The order book reads live in book.ts (shared with the landing page's live deals).
export { getBook, getCounters, server } from "./book";
export type { Offer, Repo, Status } from "./book";
export type { FeedReading } from "./sep40";

// --- types (normalised from on-chain structs, contracts/repo/src/types.rs) ----

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
  /** Margin call once debt > value × (1 − this) (DECISIONS.md #26); null = contract predates #26 (trigger = liquidation discount). */
  margin_trigger_bps: bigint | null;
  enabled: boolean;
  /** NAV older than this blocks take / check_margin / liquidate (per asset, DECISIONS.md #25). */
  max_nav_age_secs: bigint;
  /** Exposure cap: max debt of live repos on this asset, USDC units (DECISIONS.md #32). 0 = no new repos; null = contract predates #32. */
  max_open_debt: bigint | null;
  /** NAV sanity band (DECISIONS.md #31): max move in bps against the feed's last 20 records; null = contract predates #31. */
  max_nav_move_bps: bigint | null;
  /** Optional hard NAV bounds in the oracle feed's scale (#31); null = unset. */
  nav_floor: bigint | null;
  nav_ceiling: bigint | null;
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

// --- read-only clients (simulation needs no signer) ----------------------------

const readRepo = new RepoClient({ contractId: REPO_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const readOracle = new OracleClient({ contractId: ORACLE_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
const oracleAsset = (sac: string) => ({ tag: "Stellar" as const, values: [sac] as const });

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
  // (deployed before #25, #31 or #32). Error #8 = AssetNotSupported.
  let a: {
    haircut_bps: unknown;
    margin_trigger_bps?: unknown;
    enabled: boolean;
    max_nav_age_secs?: unknown;
    max_open_debt?: unknown;
    max_nav_move_bps?: unknown;
    nav_floor?: unknown;
    nav_ceiling?: unknown;
  };
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
    margin_trigger_bps: a.margin_trigger_bps === undefined ? null : big(a.margin_trigger_bps),
    enabled: a.enabled,
    max_nav_age_secs: big(maxAge),
    max_open_debt: a.max_open_debt === undefined ? null : big(a.max_open_debt),
    max_nav_move_bps: a.max_nav_move_bps === undefined ? null : big(a.max_nav_move_bps),
    // Option<i128>: None decodes as null (absent on a pre-#31 contract).
    nav_floor: a.nav_floor == null ? null : big(a.nav_floor),
    nav_ceiling: a.nav_ceiling == null ? null : big(a.nav_ceiling),
  };
}

/** Debt of live repos on this collateral (#32); null on a contract without open_debt(). */
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

const sep40AssetScVal = (a: Asset): xdr.ScVal =>
  "Stellar" in a
    ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(a.Stellar).toScVal()])
    : xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(a.Other)]);

/**
 * The live reference feed (config LIVE_FEED): SEP-40 `lastprice` + `decimals`,
 * the two calls the repo contract makes on its own oracle, simulated with no
 * wallet. Throws when the feed is not configured or the RPC read fails; null
 * when the feed has no price for the asset.
 */
export async function getLiveFeed(): Promise<FeedReading | null> {
  if (!LIVE_FEED) throw new Error("Live feed not configured (LIVE_ORACLE_ID / LIVE_ORACLE_ASSET in .env)");
  const [last, dec] = await Promise.all([
    simulateView<{ price: bigint; timestamp: bigint } | null>(LIVE_FEED.oracle, "lastprice", sep40AssetScVal(LIVE_FEED.asset)),
    simulateView<number>(LIVE_FEED.oracle, "decimals"),
  ]);
  return toReading(last, dec);
}

/** The feed's last `NAV_BAND_RECORDS` prices for `sac`, newest first: what `check_band` reads (#31). */
export async function getNavHistory(sac: string = TBENJI_SAC): Promise<PricePoint[]> {
  const r = (await readOracle.prices({ asset: oracleAsset(sac), records: NAV_BAND_RECORDS })).result;
  return (r ?? []).map((p) => ({ price: big(p.price), timestamp: big(p.timestamp) }));
}

/**
 * Close time (unix seconds) of the latest ledger. The contract measures NAV
 * age against ledger time, so the app does too. Read from a lookup of an
 * unknown tx hash: the reply is a few hundred bytes and carries
 * latestLedgerCloseTime, unlike getLatestLedger (~500 KB with ledger meta).
 */
export async function getLedgerTime(): Promise<number> {
  const r = await server.getTransaction("0".repeat(64));
  const t = Number(r.latestLedgerCloseTime);
  if (!Number.isFinite(t) || t <= 0) throw new Error("RPC returned no ledger close time");
  return t;
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
  const sent = await padWrites(tx).signAndSend();
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

/**
 * `default` on a missed margin call or past maturity + grace. On a missed call
 * the contract first re-checks the breach at a fresh NAV: a recovered repo
 * comes back `Open` with the call cleared (#20). Returns the resulting status.
 */
export async function declareDefault(signer: Signer, repoId: bigint): Promise<TxOutcome<Status>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  // The SDK's Client appends "_" to JS reserved words when it registers spec
  // methods (stellar-sdk bindings sanitizeIdentifier), so the runtime method is
  // `default_` even though the generated typings still say `default`.
  const callDefault = (c as unknown as { default_: RepoClient["default"] }).default_.bind(c);
  const out = await submit(await callDefault({ repo_id: repoId }));
  const status = unwrapResult<{ tag: Status } | Status>(out.value);
  return { hash: out.hash, value: typeof status === "string" ? status : status.tag };
}

/**
 * The lender's "Declare default" once a repo is past maturity + grace (#31):
 * sends `default` only. The contract's `default` tries auto-repay first for an
 * opted-in borrower (repo -> Repaid), else marks it Defaulted for liquidation.
 * A repo that is no longer live throws "already settled" (keeper raced us).
 */
export async function declareDefaultPastGrace(signer: Signer, repo: Repo): Promise<TxOutcome<Status>> {
  try {
    const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
    // `default_` at runtime: see declareDefault.
    const callDefault = (c as unknown as { default_: RepoClient["default"] }).default_.bind(c);
    const out = await submit(await callDefault({ repo_id: repo.id }));
    const status = unwrapResult<{ tag: Status } | Status>(out.value);
    return { hash: out.hash, value: typeof status === "string" ? status : status.tag };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // InvalidStatus (#7) in simulation, or a tx that lost the race on-chain:
    // either way, if the repo is no longer live someone else settled it.
    const settledElsewhere =
      /Error\(Contract, #7\)/.test(msg) || (await getRepoStatus(repo.id).catch(() => null))?.match(/^(Repaid|Defaulted|Liquidated)$/);
    if (settledElsewhere)
      throw new Error(`Repo #${repo.id} is already settled: the keeper or another wallet got there first. The card now shows the result.`);
    throw e;
  }
}

async function getRepoStatus(id: bigint): Promise<Status | null> {
  const res = await server.getLedgerEntries(contractDataKey(dataKey("Repo", id)));
  const e = res.entries[0];
  return e ? normRepo(scValToNative(e.val.contractData().val()) as Record<string, unknown>).status : null;
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

/** USDC parked for `address` because a payout to it failed (frozen account, no trustline); 0 on a contract without claimable(). */
export async function getClaimable(address: string): Promise<bigint> {
  try {
    return big((await readRepo.claimable({ who: address })).result);
  } catch {
    return 0n;
  }
}

/** Pays the signer its whole parked USDC balance. Returns the amount. */
export async function claim(signer: Signer): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.claim({ who: signer.address }));
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

// --- NAV outage fallback: in-kind claim (DECISIONS.md #38) ------------------------

/**
 * Lender only: takes a Defaulted repo's whole collateral in kind once its NAV
 * has been stale for 7 contract days past max_nav_age_secs. Returns the
 * collateral amount. A push the token refuses is parked for claimCollateral.
 */
export async function claimInKind(signer: Signer, repoId: bigint): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.claim_in_kind({ repo_id: repoId }));
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

/**
 * Adds write-byte and fee headroom to every simulated write (submit). When a
 * token call fails inside `try_transfer`/`try_transfer_from` and is rolled
 * back (a parked payout, a failed auto-repay pull), testnet simulation
 * under-counts write bytes, so the tx fails on chain with
 * RESOURCE_LIMIT_EXCEEDED (claim_in_kind: simulated 3,024, needed 3,248).
 * Same numbers as the keeper's scripts/keeper/src/headroom.ts; runbook:
 * scripts/README.md "Under-simulated write bytes". Only the write-byte share
 * of the extra fee is kept; the refundable rest comes back. sign() rebuilds
 * from this cached transactionData.
 */
function padWrites<R>(tx: contract.AssembledTransaction<R>, bytes = 2048, fee = 200_000n): contract.AssembledTransaction<R> {
  const sim = tx.simulation;
  if (!sim || !rpc.Api.isSimulationSuccess(sim as rpc.Api.SimulateTransactionResponse)) return tx;
  const data = tx.simulationData.transactionData;
  const r = data.resources();
  r.writeBytes(r.writeBytes() + bytes);
  data.resourceFee(xdr.Int64.fromString((data.resourceFee().toBigInt() + fee).toString()));
  return tx;
}

/** Collateral parked for `address` per collateral token id (in-kind claims the token refused); 0 on a contract without it. */
export async function getClaimableCollateral(address: string): Promise<Record<string, bigint>> {
  const amounts = await Promise.all(
    COLLATERAL.map((a) =>
      readRepo.claimable_collateral({ who: address, asset: a.sac }).then(
        (r) => big(r.result),
        () => 0n,
      ),
    ),
  );
  return Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, amounts[i]]));
}

/** Sends the signer's parked `asset` to `to` (itself, or an allowlisted custody account). Returns the amount. */
export async function claimCollateral(signer: Signer, asset: string, to: string): Promise<TxOutcome<bigint>> {
  const c = new RepoClient({ contractId: REPO_ID, ...clientOpts(signer) });
  const out = await submit(await c.claim_collateral({ who: signer.address, asset, to }));
  return { hash: out.hash, value: big(unwrapResult(out.value)) };
}

/** A `ClaimedInKind` event: the lender took the collateral itself, no sale. */
export interface InKindClaim {
  repoId: bigint;
  lender: string;
  amount: bigint;
  /** The token refused the push, so the collateral waits for claim_collateral. */
  parked: boolean;
  /** The stale NAV the outage was measured from. */
  navTimestamp: bigint;
}

/**
 * Every `ClaimedInKind` event the RPC still holds for the repo contract, by
 * repo id. Repo state is `Liquidated` for a sale and an in-kind claim alike;
 * only the event tells them apart. RPC scans at most ~10,000 ledgers per
 * call, so the scan starts near the deploy (DEPLOYED_AT, ledgers ≥ 4 s
 * apart, so this overshoots back) and follows the cursor to the latest
 * ledger. Testnet keeps about 7 days of events.
 */
export async function getInKindClaims(): Promise<Map<string, InKindClaim>> {
  const t = await server.getTransaction("0".repeat(64));
  const sinceDeploy = Math.max(0, Number(t.latestLedgerCloseTime) - Date.parse(DEPLOYED_AT) / 1000);
  const startLedger = Math.max(t.oldestLedger, t.latestLedger - Math.ceil(sinceDeploy / 4));
  const topics = [[xdr.ScVal.scvSymbol("claimed_in_kind").toXDR("base64"), "*", "*"]];
  const filters = [{ type: "contract" as const, contractIds: [REPO_ID], topics }];
  const out = new Map<string, InKindClaim>();
  let page = await server.getEvents({ startLedger, filters, limit: 100 });
  for (let i = 0; i < 30; i++) {
    for (const e of page.events) {
      const id = big(scValToNative(e.topic[1]));
      const d = scValToNative(e.value) as { collateral_amount: bigint; parked: boolean; nav_timestamp: bigint };
      out.set(String(id), {
        repoId: id,
        lender: String(scValToNative(e.topic[2])),
        amount: big(d.collateral_amount),
        parked: d.parked === true,
        navTimestamp: big(d.nav_timestamp),
      });
    }
    // Cursor = toid: ledger sequence in the high 32 bits.
    const cursorLedger = page.cursor ? Number(BigInt(page.cursor.split("-")[0]) >> 32n) : Infinity;
    if (!page.cursor || cursorLedger >= page.latestLedger) break;
    page = await server.getEvents({ cursor: page.cursor, filters, limit: 100 });
  }
  return out;
}

/** Admin only: mock oracle `set_price` (contracts/oracle) for collateral `sac`. */
export async function setNav(signer: Signer, price: bigint, sac: string = TBENJI_SAC): Promise<TxOutcome<null>> {
  const c = new OracleClient({ contractId: ORACLE_ID, ...clientOpts(signer) });
  const out = await submit(await c.set_price({ asset: oracleAsset(sac), price }));
  unwrapResult(out.value);
  return { hash: out.hash, value: null };
}

/** Adds the USDC and tBENJI trustlines a fresh wallet needs. A wallet decline throws WalletSignError. */
export async function addTrustlines(signer: Signer, which: TrustCode[]): Promise<TxOutcome<null>> {
  const account = await server.getAccount(signer.address);
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE });
  for (const code of which) {
    const a = code === "USDC" ? USDC : TBENJI;
    b.addOperation(Operation.changeTrust({ asset: new ClassicAsset(a.code, a.issuer) }));
  }
  const tx = b.setTimeout(SIGN_TIMEOUT_MS / 1000).build();
  emitPhase("sign");
  const signedTxXdr = await signOnce(async () =>
    (await signer.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address: signer.address }))
      .signedTxXdr,
  );
  emitPhase("submit");
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error(`Trustline tx rejected: ${sent.errorResult?.result().switch().name}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 20 });
  if (done.status !== "SUCCESS") throw new Error(`Trustline tx ${done.status}`);
  return { hash: sent.hash, value: null };
}

/**
 * Adds whichever of `want` the account still lacks. If the wallet declines or fails
 * to sign, re-reads the account and asks once more (`onRetry` fires first).
 */
export function ensureTrustlines(
  signer: Signer,
  want: TrustCode[],
  onRetry?: (err: WalletSignError, todo: TrustCode[]) => void,
): Promise<TrustResult> {
  return addTrustlinesWithRetry(
    {
      balances: () => getBalances(signer.address),
      add: async (which) => (await addTrustlines(signer, which)).hash,
    },
    want,
    { onRetry },
  );
}
