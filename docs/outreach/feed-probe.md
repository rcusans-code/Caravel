# Feed probe: RedStone BENJI feed on Stellar mainnet

Run 2026-10-26 08:44Z, read-only. Every call is a `--send=no` simulation, so nothing was signed or sent. The raw output is at the bottom.

## Verdict

**FAIL against DECISIONS #39.** As deployed, the feed cannot be Caravel's production BENJI NAV source. There are two separate blockers:

1. **Caravel cannot read it.** BENJI is not in RedStone's SEP-40 contract `CBMGLKUQ…4WYRF`. Its `assets()` lists 21 tokens (USDY, CETES, USTRY, deJTRSY and others), but `lastprice` returns `null` for the BENJI SAC `CCDSDPD7…XQ7A` and for every `Other` symbol tried. BENJI exists only as a MultiFeed contract (`CCDM2U5E…TW5`, feed `BENJI_ETHEREUM_FUNDAMENTAL`). That interface has a U256 price and timestamps in milliseconds, not SEP-40's `lastprice`/`PriceData{i128, u64 secs}`, so Caravel's SEP-40 client cannot read it without an adapter. RedStone's own feed list has a `stellarSep40` row for USDY, CETES, USTRY and others, but only `stellarMultiFeed` rows for BENJI and iBENJI. The Stellar docs list BENJI under "RedStone delivers price feeds for…", but on-chain it is MultiFeed only.
2. **The timestamp is not the NAV publication time.** The latest record's `package_timestamp` is 1792930240000 ms = **Sun 2026-10-25 12:10:40Z**. Franklin's FOBXX page shows **NAV $1.0000 "As of 10/23/2026"** (Friday) and Market (shadow) NAV $1.0000 as of 10/22/2026. The feed wrote records on Sat 24 Oct and Sun 25 Oct, when Franklin publishes nothing, so the timestamp is RedStone's fetch/heartbeat time (heartbeat 24h, deviation 0.1% per RedStone's app). Under #25's 96 h `max_nav_age_secs`, this feed would stay "fresh" while Franklin published nothing. That is the re-posting failure #39 bans: staleness would measure RedStone's liveness, not NAV age, and the #38 outage fallback would never open.

Context that limits the price risk, but does not change the verdict: all 10 stored records are exactly 1.00000000. FOBXX targets a stable $1.00 NAV, and its yield arrives as balance growth, not as a price change (Stellar case study). So a stale BENJI price is unlikely to be a wrong price. The real risk is undetected outage or suspension, which is exactly what #39 protects against.

## What would turn this into a PASS (asks in redstone.md)

- RedStone adds BENJI to the SEP-40 contract, or Caravel ships a thin MultiFeed→SEP-40 adapter (new code; it would need its own card and audit scope).
- The timestamp carries the source's as-of time: Franklin's NAV date, or the update time of the Ethereum value that `ethereum-evm-fetcher-franklin-templeton` reads. Alternatively, RedStone documents a field that does. Until then, any adapter must not pass `package_timestamp` through as NAV time.

## Key numbers

| Item | Value | Source |
|---|---|---|
| SEP-40 contract | `CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF` | [Stellar docs, oracle providers](https://developers.stellar.org/docs/data/oracles/oracle-providers#deployed-redstone-contracts) |
| SEP-40 decimals / base / resolution | 8 / `Other(USD)` / 43,200 s (12 h) | raw §1 |
| BENJI in SEP-40 `assets()` | no (21 assets, none is `CCDSDPD7…`) | raw §1 |
| BENJI MultiFeed contract | `CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5`, feed `BENJI_ETHEREUM_FUNDAMENTAL`, decimals 8 | raw §2; [RedStone app](https://app.redstone.finance/push-feeds/BENJI_ETHEREUM_FUNDAMENTAL/stellarMultiFeed) (1 source: `ethereum-evm-fetcher-franklin-templeton`) |
| Latest BENJI record | price 1.00000000; package 2026-10-25 12:10:40Z; written 12:10:48Z | raw §2 |
| Record times (last 10) | Mon 19, Tue 20, Wed 21 at ~20:27Z; Thu 22 at 09:38 and 09:43Z; Fri 23 at 09:44, 12:04 and 12:10Z; **Sat 24 12:10Z; Sun 25 12:10Z** | raw §3 |
| Franklin published NAV | $1.0000 as of 10/23/2026 | [FOBXX page](https://www.franklintempleton.com/investments/options/money-market-funds/products/29386/SINGLCLASS/franklin-on-chain-u-s-government-money-fund/FOBXX), read 2026-10-26 08:40Z |
| Gap, feed timestamp vs NAV date | about 2 days newer than the NAV it carries | above |
| Spiko (USTBL, SAFO, EUTBL) on RedStone Stellar | none of 64 Stellar push feeds (54 mainnet, 10 testnet) | [RedStone app, Stellar filter](https://app.redstone.finance/push-feeds?networks=stellar), read 2026-10-26 |

Side notes:
- The USDY control read works: price 1.15098169 at ts 1792973490 = Mon 2026-10-26 00:11:30Z. Its SEP-40 timestamps are not floored to `resolution` (1792973490 mod 43200 = 690), so a consumer should not assume SEP-40's `floor(now/resolution)` stamping (see Raven STD-02).
- stellar-cli 28.1.0 cannot pretty-print RedStone's `Sep40PriceData` type name, so the USDY values appear in the error text. The data itself is correct.

## Not verified
- The exact time Franklin strikes the daily NAV, and whether the Ethereum value RedStone reads carries its own as-of time. Both are questions in franklin-templeton.md and redstone.md.
- Whether the MultiFeed `read_price_data` rejects stale data at read time. The Stellar docs say "freshness is enforced at read time", but the threshold was not tested.

## Raw output

```
# Run at 2026-10-26T08:44:18Z (unix 1793004258), stellar-cli 28.1.0, network mainnet-pub = https://mainnet.sorobanrpc.com/
# All calls are simulations (--send=no). Source account = BENJI issuer G-address, used only as a simulation source; nothing is signed or sent.

$ stellar contract id asset --asset BENJI:GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --network mainnet-pub
CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A

## 1. RedStone SEP-40 contract CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF
$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- decimals
8

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- base
{"Other":"USD"}

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- resolution
43200

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- assets
[{"Stellar":"CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"},{"Stellar":"CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"},{"Stellar":"CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV"},{"Stellar":"CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV"},{"Stellar":"CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR"},{"Stellar":"CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2"},{"Stellar":"CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS"},{"Stellar":"CBAECV6UVDS6ZKPMC63MUYY4V7Q3KTHR7NLUFGVVGK7K3AQT475QTETP"},{"Stellar":"CAPW7JXJ6H6SGJ5MVM25356FAYOVT3ICZUIZRT4KGZHLUNMTWNMUI3RM"},{"Stellar":"CCHXOH2JGL6KBO5VOHR6WD4ZQXI6CFMJ5F65XVSZ6P47Y7KVZSQIPN6J"},{"Stellar":"CCQNEBGX5RJQGNLQ25C67DZLOSNM4NFQBANUS3ASALF2X552BSIQ6XCE"},{"Stellar":"CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP"},{"Stellar":"CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN"},{"Stellar":"CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J"},{"Stellar":"CC2RBGYNCFBCVENIDL5BFBWPH4OUZM2UA3OD2K2N54GLMWCC4KWPVAGO"},{"Stellar":"CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"},{"Stellar":"CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL"},{"Stellar":"CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV"},{"Stellar":"CCNOV6XVI2O5BSTA3232GIRUQULDEBV7IWGKM6QKI6II5OIIQTU24JJN"},{"Stellar":"CACSKWC753QVGC4J6YPDBIR2BEHFVWIAE7CBSS3HOVYMN623OAIQYE2M"},{"Stellar":"CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY"}]

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- lastprice --asset {"Stellar":"CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A"}
null

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- lastprice --asset {"Other":"BENJI"}
null

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- lastprice --asset {"Other":"BENJI_FUNDAMENTAL"}
null

$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- lastprice --asset {"Other":"BENJI_ETHEREUM_FUNDAMENTAL"}
null

# control: USDY (listed in assets). The CLI cannot pretty-print RedStone's Sep40PriceData type, so the raw ScVal is in the error text.
$ stellar contract invoke --id CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- lastprice --asset {"Stellar":"CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP"}
❌ error: cannot print result Map(Some(ScMap(VecM([ScMapEntry { key: Symbol(ScSymbol(StringM(price))), val: I128(Int128Parts { hi: 0, lo: 115098169 }) }, ScMapEntry { key: Symbol(ScSymbol(StringM(timestamp))), val: U64(1792973490) }])))): Missing Entry Sep40PriceData

## 2. RedStone MultiFeed BENJI contract CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5
$ stellar contract invoke --id CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5 --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- feed_id
"BENJI_ETHEREUM_FUNDAMENTAL"

$ stellar contract invoke --id CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5 --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- description
"RedStone Price Feed for BENJI_ETHEREUM_FUNDAMENTAL"

$ stellar contract invoke --id CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5 --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- decimals
8

$ stellar contract invoke --id CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5 --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- read_price_data
{"package_timestamp":1792930240000,"price":"100000000","write_timestamp":1792930248000}

$ stellar contract invoke --id CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5 --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- read_price_and_timestamp
["100000000",1792930240000]

## 3. Shared adapter CA526Y2NQWGWVVQ7RFFPGAZMU66PSYJ3UC2MTVAV4ZU7OM5BOPHDXUSG, BENJI history (--limit 20 returns the 10 stored records)
$ stellar contract invoke --id CA526Y2NQWGWVVQ7RFFPGAZMU66PSYJ3UC2MTVAV4ZU7OM5BOPHDXUSG --network mainnet-pub --source-account GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --send=no -- read_price_history --feed_id BENJI_ETHEREUM_FUNDAMENTAL --limit 20
[{"package_timestamp":1792441620000,"price":"100000000","write_timestamp":1792441633000},{"package_timestamp":1792528030000,"price":"100000000","write_timestamp":1792528043000},{"package_timestamp":1792614450000,"price":"100000000","write_timestamp":1792614458000},{"package_timestamp":1792661920000,"price":"100000000","write_timestamp":1792661928000},{"package_timestamp":1792662230000,"price":"100000000","write_timestamp":1792662238000},{"package_timestamp":1792748640000,"price":"100000000","write_timestamp":1792748648000},{"package_timestamp":1792757080000,"price":"100000000","write_timestamp":1792757088000},{"package_timestamp":1792757410000,"price":"100000000","write_timestamp":1792757423000},{"package_timestamp":1792843830000,"price":"100000000","write_timestamp":1792843838000},{"package_timestamp":1792930240000,"price":"100000000","write_timestamp":1792930248000}]

```
