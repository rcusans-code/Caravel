// spiko-nav: production-shaped NAV feed for a Spiko share class (DECISIONS #39
// draft). Posts the latest NAV from the Spiko Public API, converted to USD at
// the EUR/USD rate Spiko dated the same day, with `set_price_at`, stamped with
// Spiko's publication time (the older of the two), once per NAV day. It never
// re-posts: on a weekend or holiday nothing new is published, so nothing is
// sent and the on-chain age keeps growing, which is what the repo's staleness
// rules (#25, #34, #38) are meant to see.
// On an oracle whose base() is the NAV's own currency (the EUR market's EUR
// feed, DECISIONS #52) it posts the NAV unconverted at Spiko's NAV
// publication time and fetches no rate.
//
//   npm run spiko-nav -- eurSAFO --once --dry-run   # print what it would post
//   npm run spiko-nav -- eurSAFO --once             # one tick, then exit
//   npm run spiko-nav -- eurSAFO                    # every 300 s (--interval N)
//
// .env: ORACLE_ID; SPIKO_NAV_ASSET, the oracle asset to feed (Stellar:C… or
// Other:SYMBOL, default Stellar:$TSAFO_ID, the testnet eurSAFO mirror); the
// asset must be source-timed on the oracle (`set_source_timed`, deploy.sh
// SPIKO_FEED=1). Signs with FEEDER_SECRET, else ADMIN_SECRET (the oracle
// admin). SPIKO_MAX_AGE_SECS (default 345600 = 96 h, the asset's
// max_nav_age_secs): an on-chain record older than that ALERTs. NAV_JUMP_ACK_BPS
// (default 1000) / NAV_JUMP_ACK: a print more than 10% from the last record is
// held for a human, like nav-keeper.sh (#37).
// An API or RPC error posts nothing; ALERT_AFTER (2) failed ticks in a row
// ALERT (journal line + ALERT_CMD), repeated every ALERT_REPEAT_SECS (1800).
// --once exits 1 on an error or a held jump.
import { readFileSync } from "node:fs";
import { parse as parseEnv } from "dotenv";
import { sendAlert } from "./alert.js";
import { ENV_FILE, env, i128, invoke, keypair, log, reloadEnv, txLink, u64, view } from "./chain.js";
import { assetLabel, assetToScVal, parseAsset } from "./sep40.js";
import { feederTick, fetchSpiko, type OnChainRecord } from "./spiko.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: number) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const SYMBOL = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--interval") ?? "eurSAFO";
const ONCE = flag("--once");
const DRY = flag("--dry-run");
const INTERVAL_MS = opt("--interval", 300) * 1000;
const ALERT_AFTER = Number(process.env.ALERT_AFTER || 2);
const ALERT_REPEAT_MS = Number(process.env.ALERT_REPEAT_SECS || 1800) * 1000;

const ORACLE_ID = env("ORACLE_ID");
const ASSET = parseAsset(process.env.SPIKO_NAV_ASSET || `Stellar:${env("TSAFO_ID")}`);
const fileOracleId = () => {
  try {
    return parseEnv(readFileSync(ENV_FILE)).ORACLE_ID ?? null;
  } catch {
    return null;
  }
};
const startOracleId = fileOracleId();

const pending: Promise<void>[] = [];
const lastAlert = new Map<string, number>();
function alert(key: string, msg: string) {
  const now = Date.now();
  const prev = lastAlert.get(key);
  if (!ONCE && prev !== undefined && now - prev < ALERT_REPEAT_MS) return;
  lastAlert.set(key, now);
  log(`ALERT ${msg}`);
  pending.push(sendAlert(`caravel-spiko-nav: ${msg}`, log));
}

const acks = () =>
  new Set(
    (process.env.NAV_JUMP_ACK ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(BigInt),
  );

async function main() {
  const decimals = Number(await view<number>(ORACLE_ID, "decimals"));
  // The oracle's quote currency: SEP-40 base() is Other("USD") or Other("EUR") (#52).
  const base = await view<unknown>(ORACLE_ID, "base");
  const quote = Array.isArray(base) && base[0] === "Other" ? String(base[1]) : "USD";
  const sourceTimed = await view<boolean>(ORACLE_ID, "source_timed", [assetToScVal(ASSET)]).catch(() => null);
  const signer = DRY ? null : process.env.FEEDER_SECRET ? keypair("FEEDER") : keypair("ADMIN");
  log(
    `spiko-nav ${SYMBOL} -> oracle ${ORACLE_ID} ${assetLabel(ASSET)} (${decimals} dec, base ${quote})` +
      `${signer ? ` signer ${signer.publicKey()}` : ""} ${ONCE ? "once" : `every ${INTERVAL_MS / 1000}s`}${DRY ? " DRY-RUN (no tx sent)" : ""}` +
      `, alerts ${process.env.ALERT_CMD ? `via ${process.env.ALERT_CMD}` : "journal only (no ALERT_CMD)"}`,
  );
  if (sourceTimed !== true) {
    const why =
      sourceTimed === null
        ? `oracle ${ORACLE_ID.slice(0, 8)}… has no source_timed (deployed before source-timed feeds): set_price_at would fail`
        : `${assetLabel(ASSET)} is not source-timed on oracle ${ORACLE_ID.slice(0, 8)}…: run set_source_timed (deploy.sh SPIKO_FEED=1)`;
    if (!DRY) {
      alert("setup", why);
      await Promise.all(pending);
      process.exit(1);
    }
    log(`WARN ${why}`);
  }

  let errors = 0;
  for (;;) {
    reloadEnv(); // NAV_JUMP_ACK edits apply without a restart
    if (!ONCE && fileOracleId() !== startOracleId) {
      log(`ORACLE_ID changed in ${ENV_FILE} (redeploy): exiting so systemd restarts on the new oracle`);
      process.exit(0);
    }
    const r = await feederTick({
      symbol: SYMBOL,
      read: () => fetchSpiko(SYMBOL, { quote }),
      lastRecord: () => view<OnChainRecord | null>(ORACLE_ID, "lastprice", [assetToScVal(ASSET)]),
      post: async (price, timestamp) => {
        const { hash } = await invoke(signer!, ORACLE_ID, "set_price_at", [assetToScVal(ASSET), i128(price), u64(timestamp)]);
        return txLink(hash);
      },
      log,
      alert,
      opts: {
        decimals,
        now: Math.floor(Date.now() / 1000),
        jumpAckBps: BigInt(process.env.NAV_JUMP_ACK_BPS || 1000),
        acks: acks(),
        quote,
      },
      dryRun: DRY,
      staleAfterSecs: Number(process.env.SPIKO_MAX_AGE_SECS || 345_600),
    });
    if (r.outcome === "error") {
      errors++;
      if (ONCE || errors >= ALERT_AFTER) {
        alert("error", `${SYMBOL} feed failed ${errors} tick(s) in a row, nothing posted: ${r.error}`);
      }
    } else {
      errors = 0;
      lastAlert.delete("error");
    }
    if (ONCE) {
      await Promise.all(pending);
      process.exit(r.outcome === "error" || r.outcome === "hold" ? 1 : 0);
    }
    pending.length = 0;
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
}

main().catch((e) => {
  log(`spiko-nav startup failed: ${(e as Error).message}`);
  process.exit(1);
});
