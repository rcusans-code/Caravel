# RedStone (BENJI NAV feed on Stellar)

Status: draft only. Misha sends it; nothing has been sent and no form was submitted.

## Contact route (public)
- **https://www.redstone.finance/contact**. Pick "INSTITUTIONAL & BD — Partnerships, RWA" or "CORE ENGINEERING — Custom adapters". The form asks for name, email, project website, role and needs (page read 2026-10-26).
- Developer channels linked from the same page: Discord https://discord.gg/redstonedefi and Telegram https://t.me/redstonefinance.
- The Stellar docs' "Request a custom feed → Contact RedStone" points to https://www.redstone.finance/ ([oracle providers](https://developers.stellar.org/docs/data/oracles/oracle-providers#request-a-custom-feed)).

## The ask
1. **Add BENJI to the SEP-40 contract** `CBMGLKUQ…4WYRF`. Today BENJI and iBENJI are MultiFeed only (`CCDM2U5E…TW5`), and the SEP-40 `lastprice` returns null for BENJI (feed-probe.md).
2. **Timestamp semantics.** `package_timestamp` advances on weekends while Franklin's NAV stays "as of" Friday (feed-probe.md). Can the feed carry the source as-of time, either the update time of Franklin's Ethereum value or the NAV date? Caravel needs that (DECISIONS #39).
3. **SLA.** BENJI runs a 24 h heartbeat, 0.1% deviation and 1 source (`ethereum-evm-fetcher-franklin-templeton`). Ask about uptime terms, incident notice, and what happens on-chain if the Ethereum source stops updating. The app shows the answer as "1.00 ratio" while naming the pair "BENJI_ETHEREUM_FUNDAMENTAL/USD" (feed page, read 2026-10-26). Confirm the unit.
4. **Coverage.** None of the 64 Stellar feeds (54 mainnet, 10 testnet) is a Spiko token. Are USTBL, SAFO or EUTBL planned?

## What we offer
- A new consumer of RedStone's RWA feeds on Stellar: a term-repo protocol whose launch assets are BENJI, USTBL and USDY (DECISIONS #35). USDY is already in the SEP-40 contract.
- RedStone named as the production feed in the README and app once BENJI reads as SEP-40 with a source-time timestamp (a #39 feed cannot be named before that), plus open-source integration code.
- Concrete feedback from a NAV consumer (feed-probe.md). We are open to discussing a custom-feed arrangement, but no budget has been committed.

## Draft (≤150 words)

Subject: Caravel: BENJI on your Stellar SEP-40 contract + NAV timestamps

Hello RedStone team,

Caravel is an open-source term-repo protocol on Stellar: borrowers post BENJI, USTBL or USDY and borrow USDC against the daily NAV. Our contract reads SEP-40 and rejects any NAV whose timestamp is older than the issuer's publication allows.

From a read-only probe of your mainnet contracts:
1. BENJI is MultiFeed-only (`CCDM2U5E…`), so SEP-40 `lastprice` returns null. Could BENJI and iBENJI be added to `CBMGLKUQ…`?
2. `package_timestamp` advanced on Saturday and Sunday while Franklin's NAV stayed "as of" Friday. Can a feed carry the source's as-of time?
3. What uptime and incident terms apply to the BENJI feed, and what happens if the Ethereum source stalls?
4. Are Spiko tokens (USTBL, SAFO) on your Stellar roadmap?

If these are resolved, we would name RedStone as our production feed. Code: github.com/rcusans-code/Caravel.

<name>, Caravel
