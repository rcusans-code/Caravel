# NAV risk review

Commit reviewed: [5faee32](https://github.com/rcusans-code/Caravel/tree/5faee32) (26 Oct 2026; same code as the audited commit 6827168, only `DECISIONS.md` wording differs). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the reviewed commit.

Scope: everything that depends on the fund NAV (net asset value) price: the repo contract's price checks (`contracts/repo/src/oracle.rs`, `margin.rs`, `lib.rs` take, default and liquidate), the mock SEP-40 oracle (`contracts/oracle`), the two keepers (`scripts/keeper`, `scripts/nav-keeper.sh`) and the app's price display (`app/src`). The question was: how well covered are we when the price is wrong, late, missing or moves for real? A discovery pass mapped the risk "sides" across feed integrity, freshness, band logic, keeper operations and UX. Each side then got a scenario test written at the reviewed commit that reproduces the loss (the "before" numbers below), a fix on its own branch, and an independent QA pass that re-ran the before and after tests and tried variants the author had not. One side failed QA (a variant broke the fix) and was reworked before it merged.

Bottom line: the design already handled an honest feed that makes mistakes well: per-asset staleness, a future-timestamp limit, a sanity band over the last 20 feed records, exits (repay, top-up, claim) that are never blocked, and a keeper that holds on a price jump. Every defence, though, trusted whoever posts the price. The feeder could rewrite or flood the band window, our own nav-keeper re-posted a bad price until the band accepted it, and a NAV outage or a real move larger than the band froze liquidation with no way back. All five sides are fixed on main and live on testnet since the redeploy in [b19f4f2](https://github.com/rcusans-code/Caravel/commit/b19f4f2) (the later redeploy [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d) keeps them). Four residuals remain: two have fixes on branches that are not merged yet, and two are production rules, not code.

Amounts are in USDC on a 970 USDC repo with tBENJI collateral at NAV 1.00 unless stated. Testnet settings: band 2,500 bps, NAV age 180 s, feed resolution 60 s.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| NAV-1 | High (production), Medium (testnet) | The feeder can flush or rewrite the 20-record band window | Fixed in [393b471](https://github.com/rcusans-code/Caravel/commit/393b471) |
| NAV-2 | High | nav-keeper re-posts a bad price until the band accepts it; the keeper forgets its hold on restart | Fixed in [602ee42](https://github.com/rcusans-code/Caravel/commit/602ee42) |
| NAV-3 | Medium | A NAV outage locks Defaulted collateral for good | Fixed in [34fe61c](https://github.com/rcusans-code/Caravel/commit/34fe61c) |
| NAV-4 | Medium (High for FX-linked funds) | A real NAV move larger than the band freezes margin calls and liquidation | Fixed in [77a95ab](https://github.com/rcusans-code/Caravel/commit/77a95ab) |
| NAV-5 | Low | The app says "Live" while the contract refuses the price | Fixed in [9123d97](https://github.com/rcusans-code/Caravel/commit/9123d97) |
| NAV-6 | Medium | The outage fallback never opens when the feed has no usable timestamp | Open |
| NAV-7 | Low | The app's hold badge does not know the band settle path | Open |
| NAV-8 | Low | A staircase of sub-10% pushes walks past both keeper guards | Open |
| NAV-9 | Medium | NAV age measures the re-posting keeper, not the fund's publication time | Roadmap (production feed rule) |

Status counts: Fixed 5 · Partly fixed 0 · Roadmap 1 · Won't fix 0 · Open 3.

### NAV-1: The feeder can flush or rewrite the 20-record band window

- Severity: High (production), Medium (testnet)
- Status: Fixed in [393b471](https://github.com/rcusans-code/Caravel/commit/393b471) (DECISIONS #40)
- Location: `contracts/oracle/src/lib.rs:162-164`, `contracts/oracle/src/lib.rs:227-231`, `contracts/repo/src/oracle.rs:108-123`
- Finding: The NAV band (DECISIONS #31) compares a new price with the last 20 feed records, but the feeder decided how fast records appear. `set_price_at` could overwrite any existing timestamp, and every `set_price` call added a record. With a wrong or stolen feeder key, 20 overwrites at 0.50 made the window all 0.50 in one ledger, so the band passed at once: margin call, default and liquidation at 0.50, lender loss 480.37 of 970.84. Twenty back-to-back `set_price(10.00)` calls (100 s) let a take land at an inflated price, lender loss 872.74. Both happen faster than any human can react.
- Repro (reviewed commit, testnet config):
  ```
  S-A: 20 x set_price_at(0.50, ts) on the 20 existing timestamps
       -> fresh_nav = Ok(0.50) in 0 s; liquidated at 0.50; lender -480.3672602
  S-B: set_price(10.00) every 5 s ledger
       -> take lands after 20 posts / 100 s; lender -872.7431506
  ```
- Fix: The oracle stamps every record with ledger time and keeps at most one record per `resolution` slot: a push inside the newest record's slot replaces only that record, a later push appends. `set_price_at` is removed, so there is no backdating, future dating or rewriting of older records. The 20 records now always span more than 18 × `resolution` of ledger time (about 18 minutes on testnet), whatever the key does, and a guardian `no_seize` or `no_new_repos` inside that window holds the loss at 0. After the fix the same flood needs 220 posts / 1,100 s and the one-ledger rewrite leaves 19 of 20 good records (`NavOutOfBand`). Regression tests: `same_slot_push_replaces_only_the_newest_record` and `flooding_posts_add_one_record_per_slot` in `contracts/oracle/src/test.rs`, scenarios in `contracts/repo/src/test_feed_rewrite.rs`. Residual: the guarantee is only as long as the feed's `resolution` (production feeds should use a longer one), and the feeder is still the single admin key until roadmap [R10](../../README.md#production-notes-raven-audit-roadmap) (see UA-03 in [upgrade-admin.md](upgrade-admin.md)).

### NAV-2: nav-keeper re-posts a bad price until the band accepts it; the keeper forgets its hold on restart

- Severity: High
- Status: Fixed in [602ee42](https://github.com/rcusans-code/Caravel/commit/602ee42) (DECISIONS #37)
- Location: `scripts/nav-keeper.sh:84-95`, `scripts/keeper/src/navguard.ts:50-58`, `scripts/keeper/src/navguard.ts:110`, `scripts/keeper/src/navguard.ts:136`
- Finding: No attacker needed. A fat-fingered 0.50 lands on the feed; nav-keeper re-posts the latest price every 60 s with no jump check, so after 20 re-posts the whole band window is 0.50 and the band passes. The main keeper's jump hold lived only in memory: after a restart (crash, unit restart, or the self-exit on a contract redeploy) the pre-jump record had left the history, the hold was released, and the keeper margin-called, defaulted and liquidated at 0.50 (lender loss about 480 of 971).
- Repro (reviewed commit):
  ```
  before restart, bad push seen: hold=true reason=needs-ack jumpBps=5000
  after restart (latch lost):     hold=false reason=none anchor=null
  nav-keeper: 21 pushes, 20 of the bad 0.50; ALERT lines: 0
  ```
- Fix: nav-keeper never re-posts a price more than `NAV_JUMP_ACK_BPS` (10%) from its last post unless that exact price is acknowledged (`NAV_JUMP_ACK`) or pinned; it alerts and lets the price go stale, so after `max_nav_age_secs` the contract refuses NAV-gated calls for every caller. The keeper persists its jump hold and the last released price per oracle, so a restart keeps the hold, and `--refresh-nav` never re-posts a held price. Regression tests: `scripts/keeper/src/launder.test.ts` (restart keeps the hold; keeper down for the whole push still anchors on the trusted price; nav-keeper refuses a 50% jump for 20 rounds and alerts). Residual: the hold binds only our keeper. In the first 180 s, a third party can still call the permissionless `check_margin` or `default` on a bad price that is inside the band; `scripts/README.md` says so.

### NAV-3: A NAV outage locks Defaulted collateral for good

- Severity: Medium
- Status: Fixed in [34fe61c](https://github.com/rcusans-code/Caravel/commit/34fe61c) (DECISIONS #38; app claim UI in [e370b9a](https://github.com/rcusans-code/Caravel/commit/e370b9a))
- Location: `contracts/repo/src/lib.rs:759-760`, `contracts/repo/src/lib.rs:774-778`, `contracts/repo/src/margin.rs:44-45`, `contracts/repo/src/margin.rs:134-135`
- Finding: If the feed dies or the issuer stops publishing, `liquidate`, `check_margin` and the missed-call `default` wait forever on a stale NAV. A repo that defaults at maturity (no NAV needed) then has no lender exit: in the repro, 30 days after default the lender had received 0 of 970.84 owed, 1,000.96 tBENJI stayed locked in the contract, and the debt stayed counted against the asset cap, blocking new borrowers.
- Fix: `liquidate` stays blocked on a stale NAV (selling off a week-old price risks a wrong price). Instead, once the asset's NAV is older than `max_nav_age_secs` + 7 days (11 days after the last print in production, 600 s on testnet), the lender of a Defaulted repo can call `claim_in_kind` and take the collateral itself; the repo becomes Liquidated, the debt leaves the cap and `ClaimedInKind` is emitted. A token that refuses the transfer (permissioned fund, frozen trustline) parks the collateral for `claim_collateral`, which can route it to an allowlisted custody account. Guardian `no_seize` blocks the claim, and the borrower can still repay out of Defaulted until it lands. Regression tests: `outage_defaulted_repo_stays_locked_and_liquidate_stays_stale` and the in-kind tests in `contracts/repo/src/test_nav_outage.rs`, plus `in_kind_claim_refused_by_allowlist_parks_then_routes_to_custody` in `test_spiko.rs`. The case of a feed with no usable timestamp is NAV-6.

### NAV-4: A real NAV move larger than the band freezes margin calls and liquidation

- Severity: Medium (High for FX-linked funds)
- Status: Fixed in [77a95ab](https://github.com/rcusans-code/Caravel/commit/77a95ab) (DECISIONS #41)
- Location: `contracts/repo/src/oracle.rs:108-123`, `contracts/repo/src/margin.rs:158-162`
- Finding: A genuine move past `max_nav_move_bps` (a 2% move on a euro fund with the 150 bps band it had at review time, a distribution, a credit event, or a slow trend that adds up) makes take, margin call, missed-call default, liquidation and top-up clearing return `NavOutOfBand` until the 20-record window rolls: 19 minutes on a 60 s feed, 19 days on a daily NAV. Widening the band waits out the 2-day timelock. Any trend above about 0.08% per record froze the asset for as long as it ran. In a slide test (−2%, then −0.1% a day) the repo defaulted on day 8 but could only be liquidated on day 34, and the lender was short 18.39.
- Fix: The repo keeps its own clock per asset. The permissionless `note_nav(asset)` (the keeper calls it when the level moves) records a new price level and the ledger time it was first seen, never a feed timestamp. A price outside the window band is accepted once its level has stood `band_settle_secs` (production 1 day, testnet 20 minutes), every record since then is within the band of the level, and the price is within the band of each of those records. Floor and ceiling still apply first, the guardian keeps a full day to pause a bad push, and lowering the settle time is timelocked. After the fix the daily 2% drop is frozen 1 day instead of 19, and in the slide test the repo is liquidated on day 8 with the lender whole except the protocol fee. QA found a variant of the first version: after a long drift to the top of the band, one push to the bottom (about 2× the band) was accepted in the same ledger. The merged version adds the "within the band of every record since" rule and the tests `corridor_jump_is_not_accepted_instantly` and `corridor_jump_up_is_refused_by_take_offer` in `contracts/repo/src/test_band_real_move.rs`, next to `real_oracle_daily_resolution_settles_in_a_day` and `bad_push_waits_out_the_settle_time_and_floor_still_holds`.

### NAV-5: The app says "Live" while the contract refuses the price

- Severity: Low (no fund loss; Medium on testnet for user trust)
- Status: Fixed in [9123d97](https://github.com/rcusans-code/Caravel/commit/9123d97) (DECISIONS #36)
- Location: `app/src/App.tsx:208-211`, `app/src/App.tsx:672-677`, `app/src/App.tsx:828-847`, `app/src/App.tsx:1238-1293`
- Finding: The app ran no band check and measured staleness with the browser clock. With an out-of-band NAV it showed "Live, fresh NAV", kept Take, Check margin, Liquidate and the missed-call default enabled, and the user signed into error 18 (`NavOutOfBand`). A borrower in MarginCall was told a top-up clears the call, which it cannot while the price is out of band, so they could over-top-up or stop watching the deadline. Simulation fails before the wallet opens, so nobody paid a fee.
- Fix: The app reads `prices(asset, 20)` and the ledger close time and mirrors the contract's `fresh_nav` and `check_band` in `app/src/gates.ts`, in the same order (no price, future-dated, stale, floor and ceiling, band). An out-of-band NAV shows "Price on hold" with an alert; NAV-gated buttons are disabled with the reason, the maturity default stays enabled, and the MarginCall borrower is told the top-up will not clear the call. Regression tests: `app/test/navhold.test.ts` (badge and Take gate) and `app/test/navband.test.ts` (the contract's band cases, ledger clock).

### NAV-6: The outage fallback never opens when the feed has no usable timestamp

- Severity: Medium
- Status: Open. A fix is on branch [`simon/nav-outage-no-timestamp`](https://github.com/rcusans-code/Caravel/tree/simon/nav-outage-no-timestamp) (fe47998, not merged; needs a repo redeploy, no ABI change).
- Location: `contracts/repo/src/inkind.rs` (`nav_outage`), on main
- Finding: Found by QA of NAV-3. The in-kind clock starts from the feed's last timestamp. If the feed has no price, prints 0, or posts one price dated in the future (for example a millisecond timestamp, `now × 1000`) and stops, there is nothing to start from: 30 days after default `liquidate` returns `NoPrice`, `claim_in_kind` returns `NoNavOutage`, and the collateral stays locked. The oracle keeps its history sorted, so the feeder cannot even correct a future-dated entry. This is no worse than before NAV-3, but it is the same failure the fallback exists to fix.
- Fix: On the branch: when the feed gives no usable timestamp, the same window runs from the repo's `maturity_ts + grace_secs` (a margin default comes before maturity, so this is the later, conservative start). Five tests cover the future-dated, never-priced and zero-price cases at the edge second.

### NAV-7: The app's hold badge does not know the band settle path

- Severity: Low
- Status: Open. A fix is on branch [`simon/app-band-settle`](https://github.com/rcusans-code/Caravel/tree/simon/app-band-settle) (f914e85, not merged; it must be re-applied on the split `App.tsx` before merge; app-only).
- Location: `app/src/gates.ts` (`checkBand`), on main
- Finding: The app's band mirror (NAV-5) predates the settle path (NAV-4). After a real move has settled, the contract accepts the price but the app still shows "Price on hold" and blocks Take until the 20-record window rolls. On testnet the gap is under a minute (the window rolls in about 19 minutes, the settle time is 20 minutes); with production settings (daily NAV, 1-day settle) it would be days.
- Fix: On the branch: `checkBand` reads `band_candidate(asset)` and applies the same settled-level rule as the contract with exact integer maths; a contract without the view behaves as before.

### NAV-8: A staircase of sub-10% pushes walks past both keeper guards

- Severity: Low
- Status: Open (no fix scheduled)
- Location: `scripts/nav-keeper.sh` (`guard_price`), `scripts/keeper/src/navguard.ts`, on main
- Finding: Found by QA of NAV-2. Each guard measures a step against the last accepted price. Pushes of 0.91, then 0.83, then 0.76 are each within 10% of the one before, so nav-keeper re-posts every one, and the keeper's 2-10% hold releases each after 180 s; the trusted price walks down 24%, inside the testnet 2,500 bps band. Making those pushes needs the feeder key or the testnet admin price control, so this is part of the single-feeder trust in NAV-1 rather than a keeper bug, and the production bands (50 to 800 bps per asset, README parameters) refuse a 9% step on-chain.
- Fix: Not built: a cumulative cap that measures each step against the price that stood before the first unacknowledged step (over a day) would close it. The feeder key split is roadmap [R10](../../README.md#production-notes-raven-audit-roadmap).

### NAV-9: NAV age measures the re-posting keeper, not the fund's publication time

- Severity: Medium
- Status: Roadmap (production feed rule, recorded as DECISIONS #39 in [cad70a1](https://github.com/rcusans-code/Caravel/commit/cad70a1))
- Location: `scripts/nav-keeper.sh`, `scripts/keeper/src/keeper.ts` (`--refresh-nav`)
- Finding: On testnet nav-keeper re-posts the last price every 60 s so the 180 s staleness window stays open for the demo. Each re-post gets a fresh ledger timestamp, so the contract's NAV age measures keeper liveness, not how old the fund's NAV is. A re-posting feeder hides a real outage from the NAV-3 fallback (test `outage_reposting_feeder_hides_outage`) and lets takes and liquidations price off a NAV of any age. Separately, the production `max_nav_age_secs` of 96 hours lets a take or liquidation use a NAV up to 4 days old.
- Fix: Rule for mainnet listing (DECISIONS #39): a production feed's `PriceData.timestamp` must be the issuer's NAV publication time, never the time a keeper re-posted it; re-posting is testnet only. Per-asset production NAV ages are roadmap [R12](../../README.md#production-notes-raven-audit-roadmap) (F6 in [ecosystem-prior-art.md](ecosystem-prior-art.md)).

## What was checked

| Check | Result | Finding |
|---|---|---|
| Stale NAV rejected per asset (`max_nav_age_secs`) | pass | NAV-9 for what "age" means |
| Future-dated price rejected (60 s skew) | pass | |
| A margin call raised on a bad push that is later corrected | pass: a missed-call default re-checks a fresh NAV | |
| Exits (repay, top-up, claim) never blocked by the NAV | pass | |
| Band window cannot be rewritten or flooded by the feeder | fail, fixed | NAV-1 |
| Keepers do not launder a bad price into the window | fail, fixed | NAV-2, NAV-8 |
| Liveness when the feed stops | fail, fixed | NAV-3, NAV-6 |
| Liveness when the NAV really moves past the band | fail, fixed | NAV-4 |
| App shows the price state the contract will enforce | fail, fixed | NAV-5, NAV-7 |
| Value maths and decimals (mul-div with explicit rounding, token decimals folded in, overflow headroom about 1e31 at the cap) | pass | |
| A real drop past the buffer | pass: disclosed shortfall, per-asset trigger buffer | |

## Not re-reported

Covered elsewhere and dropped here: the feed's `base()` and a NAV age below the feed resolution (STD-01, STD-02 in [standards-seps.md](standards-seps.md)), a trigger raised on live repos by the guardian or admin (UA-01 in [upgrade-admin.md](upgrade-admin.md)), and the feeder being the admin key (UA-03 in [upgrade-admin.md](upgrade-admin.md)).
