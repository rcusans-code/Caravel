# Spiko (USTBL first, SAFO later)

Status: draft only. Misha sends both messages himself, after the demo.

## Main request: already decided, not redrafted
The whitelist request is Decisions #2 in `../kyc-assets/report.md` (§ "Decisions for the team"). It asks for one request, made by a team member, not by an agent, for `WLISTED` on the Caravel contract and the liquidators, through Spiko's shared permission manager `CBGHLRSX…`, which covers USTBL, EUTBL, SAFO and eurSAFO. It lists USTBL first at 3% and SAFO second. SAFO stays disabled on mainnet until due diligence (DECISIONS #26; report Decisions #3). Send that first. The follow-up below adds only the feed and USTBL questions.

## Contact route (public)
- **contact@spiko.io**, linked on https://www.spiko.io/ (page source, 2026-10-26).
- **"Book a meeting"** form on https://www.spiko.io/: https://form.typeform.com/to/GJQvxRVZ. A human submits it, never an agent.
- Help centre https://support.spiko.io/hc/en-us returned 403 to a script. Not checked in a browser.

## The ask (follow-up)
1. **NAV feed.** RedStone's 64 Stellar push feeds (54 mainnet, 10 testnet) include no Spiko token (feed-probe.md). Is there, or will there be, an on-chain USTBL NAV on Stellar (SEP-40 or any other), or a public NAV API whose timestamp is the publication time? Caravel requires the source time (DECISIONS #39).
2. **USTBL NAV calendar.** At what time is the NAV struck and published, and on which days? Caravel's staleness window is 96 h, sized so that a Friday print covers the weekend (DECISIONS #25).
3. **Liquidator redemption.** A liquidator redeems through `token.redeem` and a Spiko operator pays out off-chain (report.md USTBL row). What are the cut-off, the minimum and the settlement time?
4. **Scope of the grant.** Does one `WLISTED` grant on the permission manager cover USTBL now and EUTBL later, as report.md infers from the shared manager?
5. **Custody account.** After an 11-day NAV outage a lender may claim the collateral in kind; a push Spiko's allowlist refuses is parked for an allowlisted custody account (DECISIONS #38; `test_spiko.rs` `in_kind_claim_refused_by_allowlist_parks_then_routes_to_custody`). The main request covers only the contract and liquidators, so ask `WLISTED` for one custody account too.

## What we offer
- USTBL as a launch asset at a 3% haircut and a $2M cap (DECISIONS #35, #32). Lenders deal in USDC, except in the NAV-outage in-kind fallback (#38).
- The issuer controls are tested against a Spiko-style token: take without `approve`, a paused token freezes repay, top-up and liquidate, and a de-whitelisted borrower cannot repay (README Spiko issuer controls; `test_spiko.rs`).
- Spiko credited by name in the README and the app (both already describe the Spiko-style token; no explicit credit line yet). Testnet demo: https://caravel-repo.pages.dev/app/.

## Draft follow-up (≤150 words; send after the main request)

Subject: Caravel × Spiko: NAV feed and USTBL questions

Hello Spiko team,

Following our whitelist request for the Caravel repo contract and liquidators, here are five questions that decide how we list USTBL:

1. Is there, or will there be, an on-chain USTBL NAV on Stellar, or an API whose timestamp is the NAV publication time? Our contract requires the source time, not a re-post time.
2. At what time and on which days is the USTBL NAV published?
3. For a whitelisted liquidator redeeming through `token.redeem`: what are the cut-off, minimum and settlement time?
4. Does one `WLISTED` grant on your permission manager cover USTBL now and EUTBL later?
5. Can one custody account also get `WLISTED`, for our NAV-outage fallback?

Our plan for USTBL is a 3% haircut and a $2M cap. Our tests already cover your pause and allowlist behaviour.

Code: github.com/rcusans-code/Caravel

<name>, Caravel
