// Mock NAV next to one live SEP-40 feed, read through the same code
// (DECISIONS.md #2: swapping feeds is config only).
//
//   npm run feeds            # one reading of each
//   npm run feeds -- --json  # machine-readable
//
// Mock:  ORACLE_ID,      Stellar(TBENJI_SAC), Stellar(TSAFO_ID) when set
// Live:  LIVE_ORACLE_ID, LIVE_ORACLE_ASSET (e.g. Reflector testnet CEX/DEX feed, Other:USDC)
import { env, NETWORK } from "./chain.js";
import { assetLabel, parseAsset, readFeed, type FeedReading } from "./sep40.js";

const LIVE = { label: "live feed", oracle: env("LIVE_ORACLE_ID"), asset: parseAsset(env("LIVE_ORACLE_ASSET")) };
const feeds = [
  { label: "mock NAV  tBENJI", oracle: env("ORACLE_ID"), asset: parseAsset(`Stellar:${env("TBENJI_SAC")}`) },
  ...(process.env.TSAFO_ID
    ? [{ label: "mock NAV  tSAFO", oracle: env("ORACLE_ID"), asset: parseAsset(`Stellar:${env("TSAFO_ID")}`) }]
    : []),
  LIVE,
];

const readings: FeedReading[] = await Promise.all(feeds.map((f) => readFeed(f.oracle, f.asset)));
const now = Math.floor(Date.now() / 1000);

if (process.argv.includes("--json")) {
  const out = readings.map((r, i) => ({ label: feeds[i].label, ...r, raw: r.raw?.toString() ?? null, age_secs: r.timestamp === null ? null : now - r.timestamp }));
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [i, r] of readings.entries()) {
    const label = feeds[i] === LIVE ? `${feeds[i].label} ${assetLabel(r.asset)}` : feeds[i].label;
    if (r.price === null || r.timestamp === null) {
      console.log(`${label.padEnd(28)} no price  (${r.oracle})`);
      continue;
    }
    const at = new Date(r.timestamp * 1000).toISOString().slice(0, 19) + "Z";
    console.log(
      `${label.padEnd(28)} ${r.price.toFixed(6).padStart(14)} ${r.base}  raw ${r.raw} @ 10^${r.decimals}  ` +
        `ts ${at} (age ${now - r.timestamp}s, resolution ${r.resolution}s)`,
    );
  }
  for (const r of readings) console.log(`  https://stellar.expert/explorer/${NETWORK}/contract/${r.oracle}`);
}
