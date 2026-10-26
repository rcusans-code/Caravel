# Ecosystem prior art audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: how live Stellar lending protocols build the mechanisms Caravel depends on (oracle staleness, NAV sanity band, margin call, liquidation, auto-repay, allowlisted collateral), and whether Caravel's docs, landing page and pitch describe that landscape correctly. The method was the Stellar Raven (https://raven.stellar.org) scout playbook ([stellar-scout](https://github.com/Stellar-Light/stellar-scout): two-modes, evidence-floor and output-contract sections) with Raven's project, repo, research and SCF directory searches (43 projects typed Lending), plus a read of five public peer repositories at fixed commits. F1 was reproduced with a Rust unit test at the audited commit; the other findings are citation checks against the peers' code and configs. An independent QA pass re-cloned the peers, re-ran the repro and re-checked every citation.

Bottom line: Caravel's design holds up against the peers. No Stellar peer has a margin-call cure window or an allowance-pull auto-repay, and its term, daily-NAV margin and atomic DvP still set it apart. The problems were in how it described itself: one README sentence contradicted the NAV band's behaviour, two landing-page claims about pools were contradicted by the peers' code, the competition slide left out the closest peers, and one stale risk line. All four are fixed on main, and the band block itself is now bounded in time. Two Low contract items are on the roadmap.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| F1 | Medium | NAV band blocks the margin call on the jump it is meant to catch | Fixed in [77a95ab](https://github.com/rcusans-code/Caravel/commit/77a95ab) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| F2 | Medium | Landing page claims about pools are contradicted by the peers' code | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| F3 | Medium | Competition slide and README omit the closest Stellar peers | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) |
| F4 | Low | A feed with no `prices()` history silently disables the move band | Roadmap (R12 Production profile and contract roadmap) |
| F5 | Low | README lists a shipped feature as a future target | Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| F6 | Low | One 96 h production NAV age for every fund | Roadmap (R12 Production profile and contract roadmap) |

Status counts: Fixed 4 · Partly fixed 0 · Roadmap 2 · Won't fix 0 · Open 0.

### F1: NAV band blocks the margin call on the jump it is meant to catch

- Severity: Medium
- Status: Fixed in [77a95ab](https://github.com/rcusans-code/Caravel/commit/77a95ab) (mechanism) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) (README)
- Location: `contracts/repo/src/oracle.rs:108-123` (`check_band`), `contracts/repo/src/oracle.rs:79-90` (`fresh_nav`), `README.md:205`, `README.md:211-212`, `README.md:291`
- Finding: `check_band` compares the latest NAV with every one of the feed's last 20 records, and `check_margin` and `liquidate` both go through it. At the published BENJI launch values (band 50 bps, trigger 250 bps), a single print at 0.99 (−1%, past the trigger) made `check_margin` return `NavOutOfBand`; the call fired only after 20 consecutive 0.99 records, and a matured repo's `liquidate` on a 0.98 print also returned `NavOutOfBand`. On a 60 s feed that is about 20 minutes; on a feed that writes once per daily NAV it is about 20 days. Yet README:291 said this 1% fall "is the event the margin check guards against". XOXNO hit the same failure on its daily-NAV Liqvid listing and wrote it up in its public runbook. QA noted that the block itself was documented design; the contradiction was the README sentence.
- Repro: launch BENJI values, 20 history records at 1.00, a max-LTV take, then one print at 0.99: `check_margin` returns `Err(NavOutOfBand)`; the call fires only after 20 consecutive 0.99 records.
- Fix: the NAV band-settle change ([77a95ab](https://github.com/rcusans-code/Caravel/commit/77a95ab)) adds a per-asset `band_settle_secs`: a new NAV level past the band is accepted once it has stood that long in ledger time, measured by the repo contract through `note_nav` (the keeper calls it each tick). Production is 1 day, so a real move reaches the margin call within a day instead of 20 records, and the guardian gets that day to pause a bad push. Regression tests in `contracts/repo/src/test_band_real_move.rs`, including `real_oracle_daily_resolution_settles_in_a_day` and `bad_push_waits_out_the_settle_time_and_floor_still_holds`. The README "Shortfall" risk now states that at launch values a 1% fall first returns `NavOutOfBand` until the band accepts the new level (after `band_settle_secs`, 20 agreeing records, or a timelocked widening).

### F2: Landing page claims about pools are contradicted by the peers' code

- Severity: Medium
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:413-414`
- Finding: The landing page said floating-rate pools "need a live price every few seconds" and "can force a sale on an outdated or missing price". Blend refuses any price older than 24 h or not positive ([pool.rs](https://github.com/blend-capital/blend-contracts-v2/blob/ba22b48/pool/src/pool/pool.rs)), so a missing price can never force a sale. XOXNO is fail-closed and allows 16 h for its Spiko markets. Caravel itself accepts a NAV up to about 96 h old in production, so "outdated price" cut against Caravel. A reviewer who knows Blend could falsify both bullets.
- Fix: the two bullets now read "Built for assets that trade 24/7: liquidate any hour, at once, to anyone" and "No cure window before a sale"; the two uncontradicted bullets stay. Check: `git grep -n 'Built for assets that trade 24/7' ba3c054 -- site/index.html`; `every few seconds` no longer appears.

### F3: Competition slide and README omit the closest Stellar peers

- Severity: Medium
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) (README and `docs/pitch-deck.md`) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) (pitch deck PDF)
- Location: `docs/pitch-deck.md:18`, `README.md:18-25`, pitch deck slide 10
- Finding: The competition slide listed Blend, Templar, Aave Horizon and centralized exchanges only. It left out XOXNO's "Spiko RWA" spoke (six Spiko markets configured on mainnet, all disabled) and Liqvid X, whose "Stellar RWA Lending Market" ([SCF #45 submission](https://communityfund.stellar.org/submissions/recLauVL3boo779AG), $97,500 build budget) lets verified investors borrow USDC against Liqvid-issued tokens, built as isolated lending markets on Alula. Lending is a crowded cluster, and Caravel's gap is partial, not an open field. QA corrected one detail: Liqvid X and Alula are one stack and belong in one row.
- Fix: the README problem table and `docs/pitch-deck.md` slide 10 gain the row "XOXNO Spiko spoke (disabled) · Liqvid X on Alula (SCF #45): open-ended pool, oracle NAV, liquidated at HF<1"; the README row links its sources. The pitch deck PDF (`docs/caravel-pitch.pdf`) slide 10 has the same row ("XOXNO · Liqvid X on Alula"), its headline no longer says everyone else lends open-ended, and its sources footer names the XOXNO config and the SCF #45 submission. Check: `git show ba3c054:docs/caravel-pitch.pdf > deck.pdf && pdftotext deck.pdf - | grep -n 'XOXNO'`.

### F4: A feed with no `prices()` history silently disables the move band

- Severity: Low
- Status: Roadmap ([R12 Production profile and contract roadmap](../../README.md#production-notes-raven-audit-roadmap))
- Location: `contracts/repo/src/oracle.rs:114-116`, `contracts/repo/src/oracle.rs:105`, `README.md:224`
- Finding: `prices(...)` returning `None` becomes an empty list, so the move band is skipped and only the optional floor and ceiling remain (set only for BENJI). The no-history case was documented; the new point is a future adapter whose `prices()` is unimplemented. Slender's price provider returns an error on an empty set instead. This is unreachable today: the mock and the testnet oracle return `None` only when there is no history at all, and then `lastprice` fails first.
- Fix: planned: treat a missing history as `NavOutOfBand` when `max_nav_move_bps` is set.

### F5: README lists a shipped feature as a future target

- Severity: Low
- Status: Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3)
- Location: `README.md:298`, `README.md:189`, `README.md:172-173`
- Finding: The Risks section said "Push payouts… Target: hold payouts in the contract for each party to claim", while README:189 and the `PayoutParked` / `Claimed` events described the claim path that had already shipped.
- Fix: the bullet is now "Collateral payouts stay direct (DECISIONS #24)": failed USDC payouts are parked for `claim`, and collateral still moves by direct transfer. Check: `git grep -n 'Collateral payouts stay direct' ba3c054 -- README.md`; `Target: hold payouts` no longer appears.

### F6: One 96 h production NAV age for every fund

- Severity: Low
- Status: Roadmap ([R12 Production profile and contract roadmap](../../README.md#production-notes-raven-audit-roadmap))
- Location: `README.md:210`, `DECISIONS.md:31` (#25)
- Finding: The docs give one production `max_nav_age_secs` of about 96 h, stated for BENJI-style funds. XOXNO uses 57,600 s (16 h) on all six Spiko markets, including EUR-denominated EUTBL. For EUTBL against a USDC loan, a 96 h NAV also freezes the EUR/USD leg over a weekend. Whether Spiko publishes NAV on weekends was not established.
- Fix: planned: list per-asset production NAV ages (BENJI 96 h; others from the feed's real cadence).

## Peers compared

Public repositories read at fixed commits. XOXNO's code is PolyForm Noncommercial: it was read, not copied (DECISIONS #32/#33 record the same rule).

| Peer | Source | Staleness | Band or sanity | Margin call / cure window | Liquidation |
|---|---|---|---|---|---|
| Blend v2 | [blend-contracts-v2 @ ba22b48](https://github.com/blend-capital/blend-contracts-v2/tree/ba22b48) | 24 h hard limit, price > 0 | none | none, liquidatable at HF < 1 | partial, Dutch auction (0.5% per block) |
| XOXNO Lending | [rs-lending-xlm @ 30d5990](https://github.com/XOXNO/rs-lending-xlm/tree/30d5990) | 16 h for Spiko, ~24-26 h for a daily-NAV share; fail-closed | asymmetric band sized so the trigger stays inside it, re-centred after each NAV post | none, liquidatable at HF < 1 | partial to a target HF with a bonus curve; bad-debt socialization |
| Slender | [slender @ 2b4aa3c](https://github.com/eq-lab/slender/tree/2b4aa3c) | median of per-feed TWAPs, stale feeds skipped | error on an empty price set | none | no liquidation during a post-unpause grace period |
| Legasi | [borrowing-protocol @ b3c36f6](https://github.com/legasicrypto/borrowing-protocol/tree/b3c36f6) | n/a | n/a | none | admin-attested off-chain venue; in-contract KYC registry |
| Alien Protocol | [Alien-Protocol @ b3201c9](https://github.com/Alien-Protocol/Alien-Protocol/tree/b3201c9) | oracle rejects non-increasing and future timestamps at write time | n/a | none | 50% close factor, 8% bonus |
| Caravel | this repo | per asset, ~96 h production | symmetric band against the last 20 records, floor and ceiling; settles after `band_settle_secs` | trigger, then a margin window, then default | whole-collateral sale at NAV minus a discount to whitelisted, issuer-approved liquidators; borrower cannot self-liquidate |

Not cloned: Liqvid X (no public lending repo; mechanisms taken from its SCF submission), Alula (pool code not identified among its public repos; a Halborn audit is listed for it), Templar (NEAR contracts). No Stellar peer was found with an allowance-pull auto-repay; the search found none, which is not proof that none exists.

## What was checked

| Check | Result | Finding |
|---|---|---|
| "No on-chain lender can hold fund shares" still true (BENJI held by 0 contracts; XOXNO's Spiko markets disabled) | pass | |
| Mechanism docs cite Stellar prior art per mechanism | fail | F1 |
| Gap stated as partial in a crowded Lending cluster | fail | F3 |
| Competitor list covers direct and adjacent peers | fail | F3 |
| SEP-40 / SEP-41 track (RedStone serves `lastprice` / `price` / `prices`) | pass | |
| SCF funding already in this lane noted | pass (info) | F3 |
| Comparative claims in reviewer-facing copy backed by evidence | fail | F2, F5 |
| No unsupported "first" or "only" claims | pass | |
| README problem table rows sourced | pass | |
| Hard questions addressed (band vs margin check) | fail | F1 |
| Landscape mapped, not dismissed | fail | F3 |
| Differentiation surfaced (term, daily NAV, margin window, DvP, issuer admits the contract) | pass | |
| Peer licences respected (no code copied from PolyForm Noncommercial XOXNO) | pass | |
| Self-liquidation guard (a known Blend audit finding, [Stellar Security Portal](https://stellarsecurityportal.com/report/9)) | pass | |
| Band behaviour with a feed that has no history | partial | F4 |
| Production NAV age per asset | partial | F6 |

## Not re-reported

An earlier internal design review had already covered the NAV band's walk-down risk, partial liquidation and a lender claim in kind, and the whole-collateral sale; those are not repeated here.
