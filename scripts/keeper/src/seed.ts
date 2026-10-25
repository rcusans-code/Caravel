// Seed a demo state on the deployed repo contract:
//   2 open tBENJI offers from LENDER (+ 1 tSAFO offer when TSAFO_ID is set)
//   + 1 repo taken by BORROWER that matures soon (default -> liquidation demo)
//   + 1 long auto-repay repo (30 demo days), so the positions table is never empty.
// Then it funds LIQUIDATOR up to the funding floor (funding.ts) of every live
// repo plus the open offers, so a default can always be liquidated.
//
//   npm run seed              # seed the contract in .env
//   npm run seed -- --reset   # scripts/deploy.sh --fresh first (new oracle + repo), then seed
//
// Before seeding it tops up balances: tBENJI is minted to BORROWER by the
// issuer (SAC admin), USDC is bought with XLM on the testnet DEX (Circle's
// USDC cannot be minted by us), XLM comes from friendbot. Then it posts
// NAV 1.00 (fresh, so take_offer passes the staleness check).
//
// Overrides: SEED_PRINCIPAL (USDC per offer, default 100),
// SEED_NEAR_DAYS (term of the taken repo in demo days, default 3),
// SEED_LONG_DAYS (term of the auto-repay repo, default 30),
// LIQ_FLOOR_MARGIN_BPS (margin over the liquidator floor, default 1000).
import { spawn } from "node:child_process";
import path from "node:path";
import {
  Address,
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { ContractError, Err, NETWORK, PASSPHRASE, ROOT, env, i128, invoke, keypair, reloadEnv, txLink, u64, view } from "./chain.js";
import { type Exposure, FLOOR_STATUSES, liquidatorFloor, marginFromEnv } from "./funding.js";
import { setNav, toUnits } from "./set-nav.js";

const RESET = process.argv.includes("--reset");
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(0).padStart(3);
const say = (msg: string) => console.error(`[${secs()}s] seed: ${msg}`);

const UNIT = 10_000_000n; // USDC and tBENJI both have 7 decimals
const PRINCIPAL = BigInt(process.env.SEED_PRINCIPAL ?? "100") * UNIT;
const NEAR_DAYS = Number(process.env.SEED_NEAR_DAYS ?? "3");
// Two open offers (different term/APR) and the one the borrower takes.
const OPEN_OFFERS = [
  { days: 7, aprBps: 500 },
  { days: 30, aprBps: 600 },
];
const TAKEN = { days: NEAR_DAYS, aprBps: 500 };
// Taken with auto-repay on: repaid by the keeper at maturity from the
// borrower's USDC, so a live position stays on screen for the whole demo.
const LONG = { days: Number(process.env.SEED_LONG_DAYS ?? "30"), aprBps: 500 };

const horizon = new Horizon.Server(env("HORIZON_URL", "https://horizon-testnet.stellar.org"));
const CLASSIC_FEE = "100000"; // 0.01 XLM, testnet fees spike
const MIN_XLM = 1500;

const addr = (a: string) => new Address(a).toScVal();
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const fmt = (units: bigint) => (Number(units) / Number(UNIT)).toFixed(2);
const parseAsset = (s: string) => {
  const [code, issuer] = s.split(":");
  return new Asset(code, issuer);
};
const usdcAsset = () => parseAsset(env("USDC_ASSET"));
const tbenjiAsset = () => parseAsset(env("TBENJI_ASSET"));

// --- balances (classic, via Horizon) -------------------------------------------

async function balance(account: string, asset: Asset | "XLM"): Promise<number> {
  const acc = await horizon.loadAccount(account);
  for (const b of acc.balances) {
    if (asset === "XLM" ? b.asset_type === "native"
      : "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer()) {
      return Number(b.balance);
    }
  }
  if (asset === "XLM") return 0;
  throw new Error(`${account} has no ${asset.getCode()} trustline`);
}

async function submitClassic(signer: Keypair, ops: ReturnType<typeof Operation.payment>[]) {
  const acc = await horizon.loadAccount(signer.publicKey());
  const b = new TransactionBuilder(acc, { fee: CLASSIC_FEE, networkPassphrase: PASSPHRASE }).setTimeout(60);
  ops.forEach((op) => b.addOperation(op));
  const tx = b.build();
  tx.sign(signer);
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

/** Fund a throwaway account with friendbot and merge it into `dest` (+~10k XLM). */
async function friendbotInto(dest: string) {
  const gas = Keypair.random();
  const r = await fetch(`https://friendbot.stellar.org?addr=${gas.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
  await submitClassic(gas, [Operation.accountMerge({ destination: dest })]);
}

async function ensureXlm(role: string, min: number) {
  const who = env(`${role}_ADDRESS`);
  for (let i = 0; i < 3 && (await balance(who, "XLM")) < min; i++) {
    say(`${role} XLM < ${min}, merging a friendbot account in`);
    await friendbotInto(who);
  }
}

/** Buy USDC with XLM on the testnet DEX (path payment to self) until `role` holds `min`. */
async function ensureUsdc(role: string, min: number) {
  const who = env(`${role}_ADDRESS`);
  const have = await balance(who, usdcAsset());
  if (have >= min) return say(`${role} has ${have.toFixed(2)} USDC (need ${min})`);
  const want = (Math.ceil(min - have) + 10).toFixed(7);
  const paths = await horizon.strictReceivePaths([Asset.native()], usdcAsset(), want).call();
  const best = paths.records.sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
  if (!best) throw new Error(`no XLM->USDC path on the DEX; top ${role} up at https://faucet.circle.com`);
  const sendMax = Number(best.source_amount) * 1.05;
  await ensureXlm(role, sendMax + MIN_XLM);
  const hash = await submitClassic(keypair(role), [
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: sendMax.toFixed(7),
      destination: who,
      destAsset: usdcAsset(),
      destAmount: want,
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    }),
  ]);
  say(`${role} bought ${want} USDC for ~${Number(best.source_amount).toFixed(0)} XLM  ${txLink(hash)}`);
}

/** Issuer mints tBENJI (SAC mint) to `role` up to `target` when below `min`. */
async function ensureTbenji(role: string, min: number, target: number) {
  const who = env(`${role}_ADDRESS`);
  const have = await balance(who, tbenjiAsset());
  if (have >= min) return say(`${role} has ${have.toFixed(2)} tBENJI (need ${min})`);
  const amount = BigInt(Math.ceil(target - have)) * UNIT;
  const { hash } = await invoke(keypair("ISSUER"), env("TBENJI_SAC"), "mint", [addr(who), i128(amount)]);
  say(`issuer minted ${fmt(amount)} tBENJI to ${role}  ${txLink(hash)}`);
}

// --- deploy --------------------------------------------------------------------

function deployFresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    say("scripts/deploy.sh --fresh");
    const p = spawn("bash", [path.join(ROOT, "scripts/deploy.sh"), "--fresh"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"], // its log goes to stderr, IDs land in .env
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`deploy.sh exited ${code}`))));
  });
}

// --- seed ----------------------------------------------------------------------

interface Row {
  kind: string;
  id: bigint;
  principal: bigint;
  aprBps: number;
  termSecs: number;
  days: number;
  note: string;
  hash: string;
}

async function createOffer(
  repoId: string,
  days: number,
  aprBps: number,
  daySecs: number,
  collateral = env("TBENJI_SAC"),
): Promise<Row> {
  const termSecs = days * daySecs;
  const { hash, result } = await invoke(keypair("LENDER"), repoId, "create_offer", [
    addr(env("LENDER_ADDRESS")),
    addr(collateral),
    i128(PRINCIPAL),
    u32(aprBps),
    u64(termSecs),
  ]);
  const id = result as bigint;
  const tsafo = collateral === process.env.TSAFO_ID;
  say(`offer ${id}: ${fmt(PRINCIPAL)} USDC, ${days} d, ${aprBps / 100}%${tsafo ? ", tSAFO collateral" : ""}`);
  return { kind: "offer", id, principal: PRINCIPAL, aprBps, termSecs, days, note: tsafo ? "open (tSAFO)" : "open", hash };
}

/** Walk repo ids until RepoNotFound; the live ones as funding-floor exposures. */
async function liveExposures(repoId: string): Promise<Exposure[]> {
  const out: Exposure[] = [];
  for (let id = 1n; ; id++) {
    let r: { status: unknown; principal: bigint; interest: bigint; collateral_asset: string; haircut_bps: number };
    try {
      r = await view(repoId, "repo", [u64(id)]);
    } catch (e) {
      if (e instanceof ContractError && e.code === Err.RepoNotFound) return out;
      throw e;
    }
    const status = String(Array.isArray(r.status) ? r.status[0] : r.status);
    if (FLOOR_STATUSES.includes(status)) out.push({ asset: r.collateral_asset, debt: r.principal + r.interest, haircutBps: r.haircut_bps });
  }
}

/** Buy USDC for LIQUIDATOR up to the floor of every live repo plus the open offers (as if taken at max LTV). */
async function fundLiquidator(repoId: string, offers: Row[], discountBps: bigint) {
  const tsafo = process.env.TSAFO_ID;
  const haircut = async (token: string) =>
    (await view<{ haircut_bps: number }>(repoId, "asset", [addr(token)])).haircut_bps;
  const tbenjiHaircut = await haircut(env("TBENJI_SAC"));
  const tsafoHaircut = tsafo ? await haircut(tsafo) : 0;
  const exposures = [
    ...(await liveExposures(repoId)),
    ...offers.map((o) =>
      o.note.includes("tSAFO") && tsafo
        ? { asset: tsafo, debt: o.principal, haircutBps: tsafoHaircut }
        : { asset: env("TBENJI_SAC"), debt: o.principal, haircutBps: tbenjiHaircut },
    ),
  ];
  const floor = liquidatorFloor(exposures, discountBps, marginFromEnv(process.env.LIQ_FLOOR_MARGIN_BPS));
  say(`liquidator funding floor ${fmt(floor.total)} USDC (${exposures.length} live repos + open offers)`);
  await ensureUsdc("LIQUIDATOR", Math.ceil(Number(floor.total) / Number(UNIT)));
}

async function main() {
  const totalUsdc = Number(PRINCIPAL / UNIT) * (OPEN_OFFERS.length + 2 + (process.env.TSAFO_ID ? 1 : 0));
  // ~debt / (NAV × (1 − haircut)) for the two taken repos, plus room for a top-up demo.
  const needTbenji = Math.ceil((2 * Number(PRINCIPAL / UNIT) * 1.02) / 0.97) + 100;

  // 1. deploy (optional) while the lender/borrower buy USDC (different signers).
  await Promise.all([
    RESET ? deployFresh() : Promise.resolve(),
    ensureUsdc("LENDER", totalUsdc),
    ensureUsdc("BORROWER", 20), // interest + fee to repay the near-maturity repo
    ensureXlm("BORROWER", MIN_XLM),
  ]);
  reloadEnv();
  const REPO_ID = env("REPO_ID");
  const ORACLE_ID = env("ORACLE_ID");
  const cfg = await view<{ day_secs: bigint; grace_secs: bigint; liquidation_discount_bps: number }>(REPO_ID, "config");
  const daySecs = Number(cfg.day_secs);
  say(`repo ${REPO_ID}, 1 day = ${daySecs} s`);

  // 2. fresh NAV, collateral, and the offer the borrower will take (3 signers in parallel).
  const decimals = await view<number>(ORACLE_ID, "decimals");
  const [navTx, , near] = await Promise.all([
    setNav(toUnits("1.00", decimals)),
    ensureTbenji("BORROWER", needTbenji, needTbenji + 400),
    createOffer(REPO_ID, TAKEN.days, TAKEN.aprBps, daySecs),
  ]);
  say(`NAV 1.00 posted  ${txLink(navTx.hash)}`);

  // 3. borrower takes it while the lender posts the long offer and the open ones.
  // Auto-repay off: this repo exists to show default → liquidation on camera.
  const takeP = invoke(keypair("BORROWER"), REPO_ID, "take_offer", [
    addr(env("BORROWER_ADDRESS")),
    u64(near.id),
    nativeToScVal(false),
  ]);
  const longOffer = await createOffer(REPO_ID, LONG.days, LONG.aprBps, daySecs);
  const open: Row[] = [];
  for (const o of OPEN_OFFERS) open.push(await createOffer(REPO_ID, o.days, o.aprBps, daySecs));
  // Collateral #2 (issue #20): one open tSAFO offer, priced fresh. deploy.sh
  // already allowlisted the borrower and minted it tSAFO.
  const tsafoId = process.env.TSAFO_ID;
  if (tsafoId) {
    const { hash } = await setNav(toUnits("1.00", decimals), tsafoId);
    say(`tSAFO NAV 1.00 posted  ${txLink(hash)}`);
    open.push(await createOffer(REPO_ID, 7, 650, daySecs, tsafoId));
  }
  const take = await takeP;
  const repoId = take.result as bigint;
  say(`repo ${repoId} taken (offer ${near.id})`);
  // Same signer as the first take, so only after it landed. Auto-repay on: the
  // contract sets the borrower's USDC allowance to the debt (DECISIONS #27).
  const longTake = await invoke(keypair("BORROWER"), REPO_ID, "take_offer", [
    addr(env("BORROWER_ADDRESS")),
    u64(longOffer.id),
    nativeToScVal(true),
  ]);
  const longId = longTake.result as bigint;
  say(`repo ${longId} taken with auto-repay (offer ${longOffer.id})`);
  type RepoView = { collateral_amount: bigint; interest: bigint; maturity_ts: bigint };
  const [repo, longRepo] = await Promise.all([
    view<RepoView>(REPO_ID, "repo", [u64(repoId)]),
    view<RepoView>(REPO_ID, "repo", [u64(longId)]),
  ]);
  const maturity = Number(repo.maturity_ts);
  const inSecs = maturity - Math.floor(Date.now() / 1000);
  const hhmmss = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);

  // 4. liquidator funded for every live repo and every open offer.
  await fundLiquidator(REPO_ID, open, BigInt(cfg.liquidation_discount_bps));

  // 5. summary.
  const rows: Row[] = [
    ...open,
    {
      ...near,
      kind: "repo",
      id: repoId,
      note:
        `coll ${fmt(repo.collateral_amount)} tBENJI, debt ${fmt(PRINCIPAL + repo.interest)}; ` +
        `matures ${hhmmss(maturity)}Z (in ${inSecs}s), defaultable after ${hhmmss(maturity + Number(cfg.grace_secs))}Z`,
      hash: take.hash,
    },
    {
      ...longOffer,
      kind: "repo",
      id: longId,
      note:
        `coll ${fmt(longRepo.collateral_amount)} tBENJI, debt ${fmt(PRINCIPAL + longRepo.interest)}; ` +
        `auto-repay at ${hhmmss(Number(longRepo.maturity_ts))}Z`,
      hash: longTake.hash,
    },
  ];
  const elapsed = ((Date.now() - T0) / 1000).toFixed(1);
  const x = `https://stellar.expert/explorer/${NETWORK}`;
  console.log(`\nCaravel demo seeded in ${elapsed}s${RESET ? " (incl. deploy.sh --fresh)" : ""}`);
  console.log(`repo contract   ${REPO_ID}  ${x}/contract/${REPO_ID}`);
  console.log(`oracle contract ${ORACLE_ID}  ${x}/contract/${ORACLE_ID}  (tBENJI NAV 1.00)\n`);
  console.log("kind   id  principal  apr    term            state                                         tx");
  for (const r of rows) {
    const term = `${r.days} d (${r.termSecs} s)`;
    console.log(
      `${r.kind.padEnd(6)} ${String(r.id).padStart(2)}  ${fmt(r.principal).padStart(9)}  ${(r.aprBps / 100 + "%").padEnd(5)}  ` +
        `${term.padEnd(14)}  ${r.note.padEnd(44)}  ${x}/tx/${r.hash}`,
    );
  }
}

main().catch((e) => {
  say(`FAILED: ${e?.response?.data?.extras?.result_codes ? JSON.stringify(e.response.data.extras.result_codes) : e.message}`);
  process.exit(1);
});
