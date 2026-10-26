# Caravel protocol mechanics, from first principles (v2)

Status: v2, 2026-10-25. v1 was attacked from nine standpoints; [design-review.md](design-review.md) holds every finding and verdict. This version applies the 34 accepted findings. Each change is marked inline as `[v2 F-nn]`; unmarked text is unchanged from v1 (the v1 draft is not kept in the repo; its quotes sit in design-review.md). This is working material for the README sections "Insight", "How it works" and "Contract spec" ([README.md:17-27](../README.md#L17-L27)) and "Risks and limits" ([README.md:38](../README.md#L38)); [design-review.md §8](design-review.md#8-what-each-doc-feeds-in-the-readme) maps sections to README sections.

Source of truth: the repo. Written against commit 9e2cf7b (DECISIONS rows 1-17); every citation was re-checked against origin/main at 306c650. Rows 18-22 landed after the draft; [design-review.md §7](design-review.md#7-findings-that-need-a-decisionsmd-change) says where they meet v2. Citations are `file:line`, linked to the line. `D#n` = row n of DECISIONS.md (rows sit at [DECISIONS.md:7-23](../DECISIONS.md#L7-L23), so D#n = line n+6).
Numbers come from repo files. Exceptions, labelled where used: the fee example (10%) comes from the team's business-model notes (outside the repo), the demo NAV of 1.00 is an assumption (O7), and the fund-yield figures (3.87%, dividends as new tokens) come from [docs/collateral-research.md:58](collateral-research.md#L58) and Franklin's own description of BENJI.
Arithmetic is in 7-decimal stroops (D#8) and was recomputed in exact rational arithmetic. `[v2 F-32]` Liquidation proceeds now round up (the liquidator pays the extra stroop), so §6.4-6.7 differ from v1 by one stroop.

Five items change a locked decision or a demo plan and are listed for the team in §14. v2 applies their defaults so the document is consistent; each is marked `[decision n]`.

---

## 1. Insight (README "Insight")

A tokenized Treasury fund share is a safe asset with a slow exit. The underlying T-bills are close to risk-free, but the token has a price only once a day, can be turned into cash only on business days, and can be held only by holders the issuer approves ([docs/collateral-research.md:9-13](collateral-research.md#L9-L13)).

24/7 DeFi lending prices collateral continuously and lets anyone liquidate it instantly. With this asset it fails on all three counts. Between NAV prints there is no new price to react to. A seized share can't be redeemed until the next business day. A permissionless liquidation bot can't even receive the token, because AUTH_REQUIRED stops it ([INTRO.md:45](../INTRO.md#L45)).

Caravel uses the model money markets already use for this asset: a **fixed-term repo**. Debt is fixed up front, margin is checked against daily NAV, the borrower gets a window to post more collateral before default, and liquidation goes to issuer-approved buyers at NAV minus a fixed discount. Each mechanic below follows from one of the asset facts.

`[v2 F-06]` For the first collateral, a stable-$1.00 government money-market fund, the price does not drift: yield arrives as new tokens, and the only way NAV falls is the fund "breaking the buck" or a feed fault. So for this asset the margin check is a guard against those two events, not the main protection. The protections that do the daily work are the fixed term, atomic settlement, the haircut and issuer-approved liquidation. The margin window becomes the main mechanism for collateral whose price does move (euro funds against a USDC loan, Tier 3 in [docs/collateral-research.md:37](collateral-research.md#L37)).

`[v2 F-15]` One design fact carries most of the compliance weight: **lenders never hold fund shares**. In every path the lender receives USDC only. Only the contract, the borrower and the liquidators need the issuer's approval, which is the same split Aave Horizon uses ([docs/research/rwa-collateral-gap-analysis.md:138](research/rwa-collateral-gap-analysis.md#L138)).

## 2. The asset: four facts every mechanic rests on

| # | Fact | Evidence |
|---|---|---|
| A1 | **Daily NAV.** The price is set by the fund once a day (business days), not by a market. A DEX price can be meaningless. | [INTRO.md:15](../INTRO.md#L15), [36](../INTRO.md#L36); [docs/research/rwa-collateral-gap-analysis.md:221](research/rwa-collateral-gap-analysis.md#L221); YieldBlox loss from DEX-priced USTRY: [docs/research/backing-chain-map.md:261](research/backing-chain-map.md#L261) |
| A2 | **Business-day redemption, approved holders only.** BENJI redeems "only during normal business hours on business days". Secondary depth is thin: Aquarius loses ≈20% on a 250K USTRY sale. | [backing-chain-map.md:82](research/backing-chain-map.md#L82); [collateral-research.md:64](collateral-research.md#L64) |
| A3 | **Issuer allowlist with freeze and clawback.** BENJI is auth_required + revocable + clawback. Every holder, including our contract and every liquidator, needs issuer authorization. The issuer can freeze a contract balance. | [backing-chain-map.md:79](research/backing-chain-map.md#L79); [spikes/auth/README.md:3](../spikes/auth/README.md#L3), [12](../spikes/auth/README.md#L12), [15-16](../spikes/auth/README.md#L15-L16) |
| A4 | **Stable, T-bill-terminal value.** FOBXX "seeks a stable $1.00" and holds ≥99.5% government paper. `[v2 F-06, F-07]` The price is pinned at 1.00; yield is paid as a daily dividend in new BENJI tokens sent to the holder of record. A 1% NAV fall is a break-the-buck event, not drift. The tail risks are jump risk, freeze and exit, not volatility. | [backing-chain-map.md:80](research/backing-chain-map.md#L80), [248](research/backing-chain-map.md#L248); Franklin's BENJI description (dividends as new tokens) |

How the facts map to mechanics:

| Fact | Mechanic it forces |
|---|---|
| A1 daily NAV | NAV-based valuation with a feed-liveness rule (§4.14), daily-cadence margin check (§4.5), a margin *window* instead of instant liquidation (§4.6) |
| A2 slow exit | Fixed term and fixed debt (§4.3, §4.7), liquidator discount sized for time-to-cash (§4.10), haircut > discount (§4.4), grace period (§4.8) |
| A3 allowlist | Whitelisted liquidators (§4.10), contract must be issuer-authorized before launch (§4.2), full escrow and atomic DvP so no party relies on another's goodwill (§4.1-4.2), freeze risk on payouts (§4.14, §12) |
| A4 stable value | A small buffer can be enough (§4.4); the margin check is a break-the-buck and feed-fault guard (§4.5); `[v2 F-07]` dividend tokens accrue on the contract during the term (§4.7, §12) |

## 3. How it works (README "How it works")

Demo numbers from [INTRO.md:19-23](../INTRO.md#L19-L23) and D#4, D#5. A 10% fee is used for illustration (O1). `[v2 F-24]` Rounded to cents here; exact stroops are in §6.

1. **Offer.** The lender posts "1,000 USDC, 7 days, 5% APR, collateral tBENJI". The 1,000 USDC moves into the contract now (D#7). `[v2 F-22]` The offer carries an expiry; after it, only the lender can cancel and reclaim.
2. **Take (DvP).** The borrower takes the whole offer (D#16). In one transaction the contract pulls about 1,031.92 tBENJI from the borrower (3% haircut) and pays out 1,000 USDC. Debt is fixed at 1,000.96 USDC (D#15). Either both legs settle or neither does.
3. **Daily margin.** Anyone can call `check_margin` against a fresh NAV. `[v2 F-20, decision 1]` If NAV falls more than about 1% (to 0.9898), the repo goes into MarginCall and the borrower has a window (2 days; 120 s in the demo) to add collateral back to the 3% line. `[v2 F-09]` The contract tells the borrower the exact amount. `[v2 F-12]` If the next print shows the repo healthy again, the call clears. `[v2 F-06]` For a stable-$1 fund this is a stress guard; on a normal day NAV is 1.00.
4. **Maturity.** The borrower repays 1,000.96 USDC and gets all collateral back. The lender receives 1,000.86 (net 4.50% after the 10% fee on interest, `[v2 F-29]` shown as the net rate on the offer) and the fee reserve 0.10 (D#3). `[v2 F-30]` Repaying early costs the same; there is no rebate and no partial repay, so pick the shortest term that covers the need.
5. **Default.** If the borrower hasn't repaid by maturity plus 1 day of grace, or misses the margin deadline, anyone can mark the repo Defaulted (D#7, D#17). `[v2 F-10]` The borrower can still repay the same 1,000.96 until a liquidator acts. Being liquidated instead costs 1% of all the collateral (about 10.32 USDC here), not 1% of the debt.
6. **Liquidation.** A whitelisted, issuer-approved liquidator buys the collateral at NAV − 1%. Proceeds pay the lender's terms first, then the fee, then any surplus to the borrower. `[v2 F-16]` If proceeds don't cover the debt, the lender takes everything, bears the difference, and a `Shortfall` event records it on-chain (D#3, D#4). The lender is paid first, not "in full" in every case.

## 4. Mechanics

Each mechanic has the rule, why it exists, what breaks without it, and its owner.

### 4.1 Offer and escrow
- **Rule.** `create_offer` requires the lender's auth and moves the full principal into the contract. `cancel_offer` returns it while the offer is untaken (D#7; [TASKS.md:26](../TASKS.md#L26)). An offer names the collateral asset, principal, term and APR, but no haircut (D#13; [TASKS.md:30](../TASKS.md#L30)). `[v2 F-22]` An offer also names `expires_at`; `take_offer` reverts after it, `cancel_offer` always works, and the UI keeps a cancel button (defaults: 24 h).
- **Why.** Escrow lets the borrower complete the DvP with only their own signature. The lender has committed in advance, so no lender action is needed at take time. That is what makes an order-book repo possible with one lender and one borrower. `[v2 F-22]` Without an expiry the escrowed USDC earns nothing for as long as nobody takes the offer, and a forgotten offer can be taken weeks later at an out-of-date rate.
- **Without it.** Take becomes a two-signature handshake, and a lender who signed an offer can fail to fund it: the borrower posts collateral and gets nothing, or the transaction needs off-chain coordination.
- **Owner.** D#7 (auth); D#13 (no haircut on offer). Silent on: term per offer vs global (O4). `[v2 F-22]` O22 (expiry) resolved.

### 4.2 `take_offer`: atomic DvP
- **Rule.** Borrower auth. In one invocation: read a fresh NAV, compute debt and collateral, check initial LTV, pull collateral in, push escrowed USDC out. Reject if NAV is stale, the asset is wrong, `AssetConfig.enabled` is false or the offer has expired ([TASKS.md:27](../TASKS.md#L27); D#6; D#13). Before launch the issuer must call `set_authorized(repo_contract, true)` on tBENJI ([spikes/auth/README.md:15](../spikes/auth/README.md#L15)). `[v2 F-13]` That call is the central compliance assumption of the project, not a deploy step: no smart contract holds BENJI today (0 contracts, [backing-chain-map.md:79](research/backing-chain-map.md#L79)), and the issuer's transfer agent decides whether a contract address can be a shareholder of record. The README states it as an assumption, with the Aave Horizon precedent, and says the testnet uses a team-issued tBENJI.
- **Why.** Delivery versus payment removes settlement risk: no state exists where one side has delivered and the other hasn't. On Stellar a Soroban invocation is atomic, so this costs nothing extra. Borrower auth covers the token transfer, so no `approve` is needed, which matters for Spiko tokens that lack one ([collateral-research.md:52](collateral-research.md#L52)).
- **Without it.** Two-step settlement leaves one party exposed in between. That is the risk repo desks pay custodians and tri-party agents to remove.
- **Owner.** D#7 (borrower auth), D#6 (stale NAV), D#16 (full take), D#9 (AUTH_REQUIRED fallback, not needed: [spikes/auth/README.md:17](../spikes/auth/README.md#L17)).

### 4.3 Debt formula
- **Rule.** `[v2 F-01, decision 3]` `interest = principal × apr_bps × term_secs / (10_000 × year_secs)`, rounded up (D#8), where `year_secs` is config: demo 21,900 (365 × 60 s days), production 31,536,000. `debt = principal + interest`, fixed at `take_offer`. Early repayment pays the same amount; nothing is pro-rata (D#15). `[v2 F-30]` There is no partial repay and no rebate; the README tells users to pick the shortest term that covers the need.
- **Why.** A daily-NAV, business-day asset can't support a meaningful intraday accrual clock (A1, A2), and repo convention fixes the repurchase price up front. One fixed number serves the lender's return, the borrower's payoff and the margin check. `repay` then needs no clock and no price, which is what lets it work on stale NAV (D#6). `[v2 F-01]` `year_secs` keeps D#5's config names and makes the demo's 420-second term earn the same interest a real 7-day term would; without it demo interest is 1/1440 of the intended amount and the fee beat is invisible.
- **Without it.** Accrual math needs a time source at every call. Early repayment cuts the lender's yield and leaves them reinvestment risk. The margin threshold drifts every second.
- **Owner.** D#15, D#8, D#5 (`year_secs` added). Open: the day count (O6, 365 kept; ACT/360 is one config value away).

### 4.4 Haircut (initial LTV)
- **Rule.** At take: `debt ≤ value_down(collateral × NAV × (1 − haircut_bps))` (D#14). `haircut_bps` is per asset in `AssetConfig { oracle_asset, haircut_bps, enabled }`, and the admin can update it without a redeploy (D#13). Collateral posted = `ceil(debt / (NAV × (1 − haircut)))` (D#16). Demo haircut is 3% ([INTRO.md:20](../INTRO.md#L20); D#4). The proposed Tier 1 range is 3–5% ([collateral-research.md:35](collateral-research.md#L35)).
- **Why.** The haircut has to cover time-to-cash × price move, plus the chance the issuer freezes the collateral or refuses the liquidator ([backing-chain-map.md:248](research/backing-chain-map.md#L248)). It sits above the liquidation discount, and the gap is the NAV drop the lender can absorb (§4.11). Haircuts are per asset, not per offer, so "lenders can't undercut the floor" (D#13; [collateral-research.md:41](collateral-research.md#L41)).
- **Without it.** If haircut ≤ discount, a max-LTV take is already under water on a liquidation basis the moment it settles. With per-offer haircuts, lenders compete by thinning the safety margin.
- **Owner.** D#13, D#14, D#16, D#8. Resolved: the offers board listing a "haircut" column ([TASKS.md:30](../TASKS.md#L30); [docs/board.html:255](board.html#L255)) is settled by D#13 (the UI shows the asset's haircut). Open: whether a haircut change hits open repos (O11).

### 4.5 Margin trigger
- **Rule.** `[v2 F-20, decision 1]` A repo is in breach when `debt > collateral × NAV × (1 − margin_trigger_bps)`, with `margin_trigger_bps` a config value between the haircut and the liquidation discount (demo 200 for tBENJI, D#35; haircut 300; discount 100). `check_margin` may be called by anyone (D#7) and needs a fresh NAV (D#17). The first breach sets `margin_call_deadline = now + margin_window_secs` and `[v2 F-09]` stores `required_collateral = ceil(debt / (NAV_call × (1 − haircut_bps)))`; repeat calls don't move the deadline ([TASKS.md:38](../TASKS.md#L38)). `[v2 F-12]` A `check_margin` on a repo already in MarginCall, with a fresh NAV that no longer shows a breach, clears the call and returns the repo to Open. A keeper calls it every 10 s ([TASKS.md:41](../TASKS.md#L41)). That is harmless, because only a new NAV print can change the outcome (A1).
- **Why separate from the haircut.** If the trigger used the haircut, a max-LTV take would sit exactly on the line, and any downward NAV tick would fire a call (D#14 "Why"). `[v2 F-20]` Why in front of the liquidation discount: v1 put the trigger exactly where a liquidation still pays the lender in full, so every uncured call was already a lender loss at the call NAV, and every further tick through the window and liquidation latency added to it. A 2% trigger (D#35) fires at NAV < 0.97/0.98 = 0.98980 (a 1.02% fall) and a liquidation just under it (0.9897) still pays 1,011.07, leaving about 10.21 USDC per 1,000 of cushion before the lender is touched (§4.11, §6.4).
- **What it means for a stable-$1 fund.** `[v2 F-06]` NAV is 1.00 every day by construction, so a call fires only on a break-the-buck print or a feed fault. In the first case the fund suspends redemptions and nobody can cure or liquidate at NAV; in the second the call should clear on the next correct print (F-12). The README says this plainly instead of presenting the margin loop as the daily protection.
- **Without it.** Either constant false alarms (trigger = haircut), margin calls on prices that are already wrong (no fresh-NAV rule), or a call that arrives after the lender is already losing (trigger = discount).
- **Owner.** D#14 (proposed change: add `margin_trigger_bps`), D#17, D#7. Disagreement: the UI health definition at [docs/board.html:268](board.html#L268) uses the haircut; health should be `C × NAV × (1 − trigger) / debt`, with the haircut line shown as "take limit" (O12b).

### 4.6 Margin window
- **Rule.** After a call the borrower has `margin_window_secs` to `top_up` (demo 120 s = 2 days at 60 s/day; D#5). `[v2 F-09]` `top_up` accepts any amount, reads no NAV, and clears the call once `collateral ≥ required_collateral` (the 3% line at the call NAV). `required_top_up(repo)` is a read method that returns `required_collateral − collateral`, and the UI pre-fills it. A missed deadline lets anyone call `default` ([docs/board.html:261](board.html#L261)). `[v2 F-19]` Production intent for the window is 3 days (259,200 s) so a Friday call survives to Monday's print.
- **Why.** NAV changes once a day (A1), so liquidating seconds after a call gains nothing. The next price won't arrive before tomorrow. The borrower may also need a business day to subscribe more fund shares or move them across (A2). The window gives one or two NAV cycles to cure. `[v2 F-09]` The cure target is the haircut line, not the trigger line: a cure to the trigger line re-breaches on the next tick and each cure would buy a fresh window.
- **Without it.** You get the 24/7 instant-liquidation model that Caravel exists to replace ([INTRO.md:15-16](../INTRO.md#L15-L16)).
- **Owner.** D#5 (parameter). `[v2]` O13 resolved (F-09); O14 resolved: a margin-deadline default needs no NAV (deadline passed and `collateral < required_collateral`). O20 production values set (F-19).
- **Code, rule #20 change (2026-10-25).** As built, `check_margin` never clears a call (it only raises one), and `top_up` clears it at the haircut line on the last known NAV. A recovery now clears it at `default`: after the deadline and before maturity + grace, `default` reads a fresh, in-band NAV and, if the repo is no longer in breach at the trigger (`margin_breached`, the same test `check_margin` uses), returns it to Open with no deadline and emits `MarginCleared` instead of defaulting ([contracts/repo/src/lib.rs](../contracts/repo/src/lib.rs) `default`, [margin.rs](../contracts/repo/src/margin.rs) `recovered`). A stale, missing or out-of-band NAV cannot clear it, so the default goes ahead as before (liquidation still needs a fresh NAV). A maturity + grace default never reads the NAV. The clear runs before auto-repay and is not blocked by `no_seize`. Effect: an absent borrower called on a price that is corrected before the deadline keeps the loan instead of losing the 1% discount (flash-crash S2b/S3a, -10.01 USDC on 970; -20.02 at the old 2%). The DECISIONS.md #20 row is not yet updated; the new text goes to team chat first.

### 4.7 Maturity
- **Rule.** `maturity = take_time + term`. `repay` pays exactly `debt`, at any time until a liquidator acts (D#15; `[v2 F-10]` extended into Defaulted). It moves collateral back in full and is never blocked by stale NAV (D#6). `[v2 F-26]` The lender's USDC leg is paid with a `try_` transfer; if it fails (for example the lender removed its USDC trustline), the amount is credited to an in-contract balance the lender can `claim()` later, and `repay` still succeeds (roadmap; hardening gate at the earliest).
- **Dividends during the term.** `[v2 F-07]` Real BENJI pays a daily dividend as new tokens to the holder of record, which during the term is the contract: about 0.77 tBENJI per 1,031.92 shares per 7 days. The demo tBENJI pays no dividends. v1 of the contract returns exactly the posted collateral and does not pass dividend tokens through; the README says that the dividends belong to the borrower and that pass-through (return `C + (contract balance − ΣC) × C / ΣC` at close) is on the roadmap. Whether the transfer agent sends dividends to a contract address at all needs checking with the issuer.
- **Why.** A fixed term lets both sides plan around business-day cash flows (A2) and matches repo convention. The target borrower is 7–30 days.
- **Without it.** You have a perpetual loan, which needs continuous pricing and rate resets. That doesn't fit A1.
- **Owner.** D#15, D#6, D#5 (`term_secs`). Open: term per offer vs global (O4).

### 4.8 Grace
- **Rule.** `default` for non-payment can't run before `maturity + grace_secs` (demo 60 s = 1 day; D#5). It needs no NAV (D#17). `[v2 F-48 deferred]` Debt does not grow during grace, so grace is a free extra day; the README says a 7-day term is in effect "7 + 1 days" and a late fee per grace day is on the roadmap.
- **Why.** The borrower's repayment USDC may come off-chain on business-day rails (A2). Grace also keeps a keeper from racing the borrower at maturity + 1 second.
- **Without it.** A single late block turns a solvent borrower into a defaulter and costs them 2% of the whole collateral (§6.5). `[v2 F-10]` With repay allowed in Defaulted, the late borrower's loss is bounded by whether a liquidator acts first, not by the grace clock alone.
- **Auto-repay (D#27).** A borrower can opt in at `take_offer` or later with `set_auto_repay`; the app opts in by default. The borrower signs a USDC allowance for the debt, and from maturity anyone (the keeper) can call `auto_repay`, which pulls the debt and settles exactly as `repay`. `default` tries the same pull first, so nobody can race an opted-in, solvent borrower into default. A borrower who is short of USDC still defaults.
- **Owner.** D#5, D#17, D#7, D#27.

### 4.9 Default
- **Rule.** Anyone may call `default` (D#7) when (a) `now > maturity + grace` (no NAV needed, D#17) or (b) the repo is in MarginCall, `now > margin_call_deadline` and `collateral < required_collateral` (no NAV needed). Status moves to Defaulted. No funds move. `[v2 F-10]` In Defaulted, `repay` at the same `debt` is still allowed until `liquidate` lands; it returns all collateral and pays the lender full terms, so the lender is better off than with a discounted sale. The remaining race is a liquidator landing in the same ledger as a late repay; a `liq_delay_secs` after default (demo 0, production 1 day) is the roadmap fix.
- **Why split default from liquidation.** Default is a pure time fact, so anyone can establish it without a price. Liquidation needs a price and an approved buyer (A1, A3). Splitting them lets the keeper set state while the liquidator acts once NAV is fresh.
- **Without it.** Liquidation would have to check time and price at once. A stale NAV would then block even recognising a missed payment.
- **Owner.** D#7, D#17. `[v2]` O15 resolved (F-10), O14 resolved (§4.6).

### 4.10 Liquidation
- **Rule.** `liquidate` is for whitelisted liquidators only (D#7) and needs a fresh NAV (D#6). `[v2 F-11]` It reverts if the liquidator is the repo's borrower. The liquidator pays `collateral × NAV × (1 − liq_discount)` in USDC (`[v2 F-32]` rounded up) and receives all of the collateral ([TASKS.md:39](../TASKS.md#L39); [INTRO.md:23](../INTRO.md#L23)). Demo discount is 1% (D#35; 2% before it, D#4; [INTRO.md:30](../INTRO.md#L30)). Proceeds run through the waterfall (§4.12). The one-command deploy must also have the issuer authorize each liquidator on tBENJI ([TASKS.md:40](../TASKS.md#L40)), and `[v2 F-25]` `add_liquidator` checks the asset's `authorized(liquidator)` at add time.
- **Why whitelisted.** A seized share can only be held by an issuer-approved account (A3), redeemed only by approved holders on business days (A2), and has no DEX depth ([collateral-research.md:62-65](collateral-research.md#L62-L65)). The liquidator therefore has to be an approved redeemer; this is not a demo shortcut. Aave Horizon uses the same model ([rwa-collateral-gap-analysis.md:139](research/rwa-collateral-gap-analysis.md#L139)). `[v2 F-25]` The sale at NAV − d is a transfer of fund shares for value between two approved holders; the issuer has a veto over the whitelist and must permit such transfers (needs issuer confirmation). `[v2 F-11]` The whitelist is a vetting list, not a non-affiliation list: a borrower who controls a liquidator has a free option against the lender (self-liquidate whenever it beats repaying; §6.5). The one-line guard stops the naive case; the README states that liquidators are assumed unaffiliated with borrowers.
- **Why a fixed discount, not an auction.** A fixed price at NAV makes the lender's recovery deterministic and keeps DEX prices out of it (A1). The discount pays the liquidator for carrying the share until redemption. A Dutch auction is on the cut list ([TASKS.md:79](../TASKS.md#L79)). `[v2 F-21, decision 2]` 1% (D#35, down from 2%) is still ample for this asset: carry on 1,031.92 shares at 3.87% is 0.109 USDC a day, so a Friday-to-Monday hold costs 0.33 USDC while the liquidator is paid 10.32. Going from 2% to 1% lifted the lender's buffer from 1.02% to 2.02% at no cost to the lender (§4.11). The discount also has to cover freeze risk and the liquidator's capital, so 50 bps is a floor.
- **If no liquidator acts.** `[v2 F-27]` Nothing obliges a whitelisted liquidator to buy, and a whole-collateral sale needs ≈ 0.99 × collateral in USDC per default. A repo can sit in Defaulted with the lender's principal and the borrower's surplus stuck. The README names this as a risk and lists the liquidator count; roadmap: after `liquidator_timeout_secs` an issuer-authorized lender may `claim_in_kind` (collateral up to debt at NAV, remainder in kind to the borrower), and a debt-sized sale instead of whole-collateral.
- **Without it.** Nobody can legally take the collateral, or it gets dumped into a 20%-slippage pool.
- **Owner.** D#7, D#6, D#4. Silent: liquidation-price rounding resolved (F-32); whitelist vs issuer allowlist (O24, F-25). Open: whole-collateral vs debt-sized sale (O18, roadmap).

### 4.11 The buffer derivation
For a max-LTV take at NAV N₀: `debt = C × N₀ × (1 − h)`. A liquidation at NAV N pays `C × N × (1 − d)`. The lender is whole iff

    C × N × (1 − d) ≥ C × N₀ × (1 − h)   ⇔   N / N₀ ≥ (1 − h) / (1 − d) = 0.97 / 0.99 = 0.9797979…

so the NAV can fall **2.0202%** between take and liquidation before the lender is short. That is the "~2% (3% haircut vs 1% liquidator discount)" in D#4 (~1% at the original 2% discount). It is a little more than 2% because the ratio is relative. The fee adds a cushion of `fee / debt` = 0.0958904 / 1,000.9589042 ≈ 0.0096%, which is negligible.

`[v2 F-20]` The margin call fires at `N / N₀ < (1 − h) / (1 − t)` with t = `margin_trigger_bps`: 0.97 / 0.98 = 0.989796, a 1.0204% fall (D#35's 2%). Between the call and the shortfall line there is 0.9898 − 0.9798 = 1.0% of NAV, about 10.31 USDC per 1,000 of debt at the trigger NAV itself (10.21 at 0.9897, §6.4), which is the cushion the margin window and liquidation latency consume before the lender loses anything.

`[v2 F-21]` With d = 0.5% the shortfall line would move to 0.97 / 0.995 = 0.974874, a 2.51% fall, and the cushion after a 2% call would become 0.9898 − 0.9749 = 1.5% of NAV.

For a stable-$1.00 government MMF (A4), a 1% NAV fall is a "breaking the buck" event. The buffer is therefore sized against a jump, not daily drift. It doesn't cover freeze, clawback or a wrong feed (§12).

### 4.12 Fee and waterfall
- **Rule.** `fee = interest × fee_bps`; the lender gets `principal + interest − fee`; then the borrower gets any surplus (D#3). The fee goes to the fee address on repay. On liquidation the same order applies. `[v2 F-29]` The offer form and the README show the lender's net rate after the fee (5% offer, 10% fee → 4.50% net).
- **Why.** The fee is carved from interest, so the lender's maximum is fixed by their own offer terms (D#3 "Why"), and the borrower pays exactly `debt` either way.
- **Where the fee goes.** `[v2 F-28]` The demo fee of 10% is illustrative; the team's business plan (outside the repo) launches at 0% for the first months. The fee address is labelled "reserve" in the README with the insurance-fund roadmap, because a lender paying 10% of interest will ask what backstop it buys (one 3% event costs 208 repos' worth of fees).
- **Without it.** A fee on principal or on collateral would change one side's terms after they signed.
- **Owner.** D#3. Open: no fee number in the repo (O1); conflict with D#4 in a narrow band (O2); fee rounding (O19, fee rounds down).

### 4.13 Shortfall
- **Rule.** If liquidation proceeds < debt, the lender takes all proceeds, the borrower gets 0, and `Shortfall { repo_id, amount }` is emitted (D#4). It is a medium-severity risk, and the README must explain the buffer and the insurance-fund roadmap ([DECISIONS.md:40](../DECISIONS.md#L40); [docs/board.html:228](board.html#L228)). The insurance fund itself is on the cut list ([TASKS.md:81](../TASKS.md#L81)). `[v2 F-16]` README copy says "the lender is paid first; a shortfall is possible and is recorded on-chain", never "paid in full".
- **Why.** With a ~2% buffer (§4.11), shortfall is a reachable state, so it needs a defined outcome rather than a panic or a negative transfer.
- **Without it.** The contract would revert, or try to pay borrower surplus it doesn't have, and the defaulted repo would be stuck.
- **Owner.** D#4. Open: the definition of `amount` and the band conflict with D#3 (O2, O3).

### 4.14 Stale NAV and the oracle
- **Rule.** A NAV is stale when `now − oracle_timestamp > max_nav_age_secs`, set per asset in `AssetConfig` (D#25) (demo 180 s = 3 days; D#5; production ≈ 96 h = 345,600 s (D#25), so a Friday print covers the weekend; `[v2 F-19]` had proposed 5 days = 432,000 s to also cover a US holiday Monday). Stale NAV blocks `take_offer`, `liquidate` (D#6) and `check_margin` (D#17). It never blocks `repay` or `top_up` (D#6). `default` needs no NAV (D#17). The oracle is strict SEP-40 (`lastprice` returns price and timestamp). `[v2 F-17, decision 4]` Swapping between SEP-40 feeds (Reflector, RedStone) is config only; Chainlink's Stellar oracle has its own interface and needs a thin SEP-40 adapter ([docs/research/rwa-collateral-gap-analysis.md:58](research/rwa-collateral-gap-analysis.md#L58)). `oracle_asset` is the SEP-40 `Asset` enum (a Stellar address or a symbol such as `BENJI_FUNDAMENTAL/USD`), and `decimals()` is read on every call, never cached.
- **What the staleness rule measures.** `[v2 F-18]` `oracle_timestamp` is when the feed last wrote, not the fund's as-of date. Push feeds re-post on a heartbeat even when the price is unchanged, and a $1.00 fund's price never changes, so the rule is a feed-liveness guard: it catches a dead relayer, not a fund that stopped publishing. Roadmap: require a strictly newer record per repo, or a feed that carries the as-of date.
- **Who writes the price.** `[v2 F-08]` On testnet the mock oracle's admin `set_price` can set any price, and the same admin key holds the liquidator whitelist. A bad print of 0.90 with a fresh timestamp plus three permissionless calls lets a friendly liquidator buy 1,031.92 shares for 910.15 and leaves the lender short 90.71. This is a stated trust assumption in the README (one key today; split keys and a timelock on oracle and whitelist changes are the target; the deploy script already uses separate oracle-admin and whitelist-admin keys). Roadmap: per-asset NAV bounds typed by asset kind: for a stable fund accept only a band (0.995–1.005) and treat a print below it as "disable new takes" (`enabled = false`, `NavBreak` event), not as a top-up request; for an accumulating fund reject any decrease. A single "max move per print" bound is the wrong shape: it passes a slow fake drift and rejects the one real jump.
- **Issuer action.** `[v2 F-14]` Issuer freeze, clawback and de-authorization of a trustline take precedence over every contract path, including `repay` and `liquidate`. The contract does not route around them, and lenders bear collateral-freeze risk. The spike shows a frozen contract balance cannot move ([spikes/auth/README.md:12](../spikes/auth/README.md#L12)); clawback was not tested.
- **Why.** A stale price can be wrong in either direction. Stale-high lets a borrower over-borrow at take, or makes the liquidator overpay. Stale-low fires false margin calls or hands collateral away. `repay` and `top_up` only move a position toward safety and use no price, so the borrower can always exit as far as the contract is concerned (D#6 "Why").
- **Without it.** A weekend or a dead feed turns into wrong-price takes and liquidations.
- **Owner.** D#6, D#17, D#2 (proposed wording change), D#5. Open: O21 (bounds, roadmap), O17 (clawback, risk-register row).

## 5. Contract spec (README "Contract spec")

### 5.1 States

Offer: `Listed → Taken | Cancelled | Expired` (`[v2 F-22]` Expired is implicit: a Listed offer past `expires_at` can only be cancelled).
Repo ([README.md:27](../README.md#L27)): `Open`, `MarginCall`, `Repaid`, `Defaulted`, `Liquidated`.

    create_offer ──► [Listed] ──cancel_offer──► (Cancelled)
                        │
                    take_offer (fresh NAV, not expired, DvP)
                        ▼
                     [Open] ◄─── top_up (C ≥ required) ───────────┐
                      │  │  ◄─── check_margin (fresh NAV, healthy) ┤   [v2 F-12]
                      │  └── check_margin (fresh NAV, breach) ──► [MarginCall]
                      │                                               │   │
                      ├── repay ──► (Repaid) ◄──── repay ─────────────┘   │
                      │                ▲                                  │
                      └── default (now > maturity+grace) ─┐               │
                                       │                  ▼               │
                                       │  default (deadline passed, C < required) ──► [Defaulted]
                                       │                                                │
                                       └──────── repay (same debt) ─────────────────────┤   [v2 F-10]
                                                                                        │
                                                            liquidate (whitelisted, ≠ borrower, fresh NAV)
                                                                                        ▼
                                                                                  (Liquidated)

Terminal states: Cancelled, Repaid, Liquidated. Defaulted is not terminal: it exits through `repay` (F-10) or `liquidate`. It can sit there while NAV is stale or while no liquidator acts (F-27).

### 5.2 Methods

`[v2 F-33, F-34]` Every method that touches an offer or repo checks its status first and reverts with a named error on any other state (double default, top-up on Defaulted, cancel on Taken, liquidate on Open), and extends the entry's storage lifetime.

| Method | Caller / auth | From → to | Fresh NAV? | Funds moved | Owner |
|---|---|---|---|---|---|
| `init` / `set_asset_config` / `add_liquidator` (checks issuer `authorized()`) / oracle / params | admin | — | no | — | D#13, D#7, D#2, D#5; F-25 |
| `create_offer(asset, principal, term, apr, expires_at)` | lender auth | → Listed | no | lender USDC → contract | D#7, D#13; F-22 |
| `cancel_offer(id)` | offer's lender (auth) | Listed → Cancelled | no | contract USDC → lender | [TASKS.md:26](../TASKS.md#L26) |
| `take_offer(id)` | borrower auth | Listed → Taken; repo → Open | **yes** | borrower collateral → contract; contract USDC → borrower | D#6, D#14-16 |
| `repay(repo)` | payer auth: borrower, or anyone under O23's default | Open / MarginCall / Defaulted → Repaid, until `liquidate` lands | no | borrower `debt` → lender `P+I−fee` (claimable on failure, F-26), fee address `fee`; collateral → borrower | D#3, D#6, D#15; F-10 |
| `top_up(repo, amount)` | payer auth: borrower, or anyone under O23's default | Open / MarginCall → Open when C ≥ `required_collateral` | no | borrower collateral → contract | D#6; F-09 |
| `required_top_up(repo)` (read) | anyone | — | no | none | F-09 |
| `check_margin(repo)` | anyone, no auth | Open → MarginCall (deadline and `required_collateral` set once); MarginCall → Open when healthy | **yes** | none | D#7, D#14, D#17; F-12, F-20 |
| `set_auto_repay(repo, enabled)` | borrower auth | — | no | USDC allowance for `debt` granted / withdrawn | D#27 |
| `auto_repay(repo)` | anyone, no auth, from maturity or a missed margin deadline | Open / MarginCall → Repaid | no | as `repay`, via the allowance; nothing on failure | D#27 |
| `default(repo)` | anyone, no auth | Open / MarginCall → Defaulted, or → Repaid when an auto-repay pull succeeds | no | none, or as `auto_repay` | D#7, D#17, D#27 |
| `liquidate(repo)` | whitelisted liquidator auth, ≠ borrower | Defaulted → Liquidated | **yes** | liquidator USDC → lender / fee address / borrower; collateral → liquidator | D#4, D#6, D#7; F-11 |
| `claim()` (roadmap, F-26) | lender auth | — | no | contract USDC → lender | — |

### 5.3 Events
The repo specifies only `Shortfall { repo_id, amount }` (D#4). [README.md:27](../README.md#L27) asks for an events list, but none is defined (O25). A minimal set: `OfferCreated`, `OfferCancelled`, `RepoOpened`, `MarginCalled { required_collateral, deadline }`, `MarginCleared`, `Repaid`, `Defaulted { reason }`, `Liquidated`, `Shortfall`; roadmap `NavBreak`.

### 5.4 Units and rounding (D#8)
Amounts are i128 in 7-decimal Stellar units. NAV is scaled by the oracle's `decimals()`. Rounding in the lender's favour: interest up; collateral required up (D#16); collateral value for LTV and trigger down; `[v2 F-32]` liquidation proceeds up (the liquidator pays the extra stroop); fee down (the lender keeps the extra stroop); shortfall amount up. This replaces v1's "proceeds down", which favoured the liquidator by a stroop and contradicted O19.

## 6. Worked example

Inputs: principal P = 1,000 USDC, APR 5% (500 bps), term 7 days ([INTRO.md:19](../INTRO.md#L19)). Haircut 3% (D#4) and liquidation discount 1% (D#35; 2% in D#4). `[v2 F-20]` Margin trigger 2% (D#35). Fee 10% = 1,000 bps (illustration only, O1). NAV₀ = 1.0000000 (assumed from FOBXX's stable $1.00, [backing-chain-map.md:80](research/backing-chain-map.md#L80); O7). Day count 7/365 (O6). 1 USDC = 10,000,000 stroops.

### 6.1 Take
- interest = 10,000,000,000 × 500 × 7 / (10,000 × 365) = 9,589,041.0958… → **9,589,042** (rounded up) = 0.9589042 USDC. `[v2 F-01]` In the demo the same number comes from 500 × 420 / (10,000 × 21,900).
- debt D = 10,009,589,042 = **1,000.9589042 USDC**
- collateral C = ceil(D / (1.00 × 0.97)) = ceil(10,319,163,960.82…) = **10,319,163,961 = 1,031.9163961 tBENJI**. This matches [INTRO.md:20](../INTRO.md#L20)'s "about $1,032".
- LTV check: floor(C × 1.00 × 0.97) = floor(10,009,589,042.17) = 10,009,589,042 ≥ D ✓ (exactly at the limit, as intended)

### 6.2 Repay at maturity
- borrower pays D = 1,000.9589042
- fee = floor(9,589,042 × 0.10) = 958,904 = **0.0958904** → fee address
- lender gets P + I − fee = **1,000.8630138** → net 4.50% APR (0.8630138 / 1,000 × 365/7). That is the 5% offer less the 10% fee share, and never more than the offer terms (D#3).
- collateral 1,031.9163961 tBENJI → borrower
- `[v2 F-07]` Carry check (D#10), corrected: over 7 days the fund pays ≈ 1,031.92 × 3.87% × 7/365 = 0.7659 USDC of dividends as new tokens, to the contract. If they are passed back (roadmap), the borrower's net cost is 0.9589 − 0.7659 ≈ 0.19 USDC. Until then the borrower's cost is 0.9589 + 0.7659 = 1.7248 USDC per 7 days ≈ 9.0% APR. The slide must use whichever the contract does.
- `[v2 F-23]` Lender's comparison on 1,000 USDC for 7 days: Caravel net 0.8630; a variable-rate USDC pool at 6.69% 1.2830; T-bills at 3.87% 0.7422. The README states what the 2.2% gap buys (fixed term, fixed rate, T-bill collateral, issuer-approved borrower) and who the lender is (cash that cannot sit in a pool: T-bill 3.87% → 4.50% net).

### 6.3 Margin trigger `[v2 F-20, F-09]`
- call iff D > C × NAV × 0.98 ⇔ NAV < D / (C × 0.98) = **0.98979592**, a **1.0204%** fall
- NAV 0.9900: C × 0.99 × 0.98 = 1,001.1652874 ≥ D → no call
- NAV 0.9890: C × 0.989 × 0.98 = 1,000.1540094 < D → **MarginCall**
- demo preset NAV 0.9850 (§11): C × 0.985 × 0.98 = 996.1088971 < D → **MarginCall**, deadline = now + 2 days (120 s in demo), `required_collateral` = ceil(D / (0.985 × 0.97)) = 1,047.6308590 tBENJI; `required_top_up` = **15.7144629** tBENJI
- shortfall line for reference: NAV < D / (C × 0.99) = 0.97979798 (−2.0202%)
- a call clears if the next fresh print shows C × NAV × 0.98 ≥ D again (F-12), or once C ≥ `required_collateral`

### 6.4 Liquidation around the call `[v2 F-20, F-32]`
- liquidated at NAV 0.9897 (just under the trigger): proceeds = ceil(C × 0.9897 × 0.99) = **1,011.0747807**; lender terms 1,000.8630138 → whole, with **10.2117669** of cushion; surplus to borrower 10.1158765
- uncured call, liquidated at the demo NAV 0.985: proceeds = ceil(C × 0.985 × 0.99) = **1,006.2732737** → lender whole with 5.4102599 to spare, surplus to borrower 5.3143695; only a fall past NAV 0.9798 before the sale reaches the lender (§6.6): post-call NAV moves beyond the cushion are lender loss, said plainly in the README
- v1's case (call and liquidation at 0.989) for comparison: proceeds 1,000.1540095, lender short 0.7090043

### 6.5 Default at maturity, NAV unchanged (surplus case) `[v2 F-32]`
- proceeds = ceil(C × 1.00 × 0.99) = **1,021.5972322** USDC, paid by the liquidator
- lender 1,000.8630138; fee address 0.0958904; borrower surplus **20.6383280**
- liquidator gets collateral worth 1,031.9163961 for 1,021.5972322: a gross spread of **10.3191639** (1% of all the collateral, O18)
- the borrower's cost of defaulting instead of repaying = C − surplus − P = 1,031.9163961 − 20.6383280 − 1,000 = 11.2780681, against 0.9589042 interest if they repaid
- `[v2 F-11]` if the borrower controls the liquidator the cost is 0 (it pays 1,021.60 and gets 20.64 back, net exactly D); at NAV 0.97 self-liquidation pays 990.9493, the lender takes it all, and the borrower keeps shares worth 1,000.96: 10.0095890 better than repaying. That is why `liquidate` rejects the borrower and the README states the non-affiliation assumption.
- `[v2 F-10]` at P = 5,000,000 the same day-late default costs 56,390.34 USDC against 4,794.52 of interest; repay in Defaulted exists so that a late wire is not a 12× penalty

### 6.6 Shortfall case `[v2 F-32]`
- NAV falls 3% to 0.9700 before liquidation (no top-up)
- proceeds = ceil(C × 0.97 × 0.99) = **990.9493152**
- under D#4: the lender takes all 990.9493152; borrower 0; fee address 0; `Shortfall.amount` = D − proceeds = **10.0095890** (if measured against debt, O3)
- the lender's loss against principal = 9.0506848; against offer terms = 9.9136986

### 6.7 Demo-sized variant `[v2 F-02, decision 5]`
Testnet balances are lender 500 USDC, borrower 1,000 tBENJI + 100 USDC, liquidator 500 USDC ([TASKS.md:90](../TASKS.md#L90)). The 1,000 USDC example needs a 1,000 USDC lender, 1,031.92 tBENJI and a liquidator with ≥ 1,021.60 USDC (O8). The demo runs two repos at once (the on-camera one and the seeded one near maturity), so the lender's 500 USDC must escrow both: v1's 480 fits one repo only. Both demo repos use P = 240:
- interest 0.2301370 (240 × 500 × 420 / (10,000 × 21,900) = 2,301,369.86… rounded up); D = 240.2301370; C = 247.6599351 tBENJI; fee 0.0230137; lender terms 240.2071233
- two repos: escrow 480 ≤ 500 USDC; collateral 495.3198702 ≤ 1,000 tBENJI, 504.68 spare for top-up
- margin call at the demo preset 0.985 (trigger 0.98980); `required_top_up` = ceil(D / (0.985 × 0.97)) − C = **3.7714711** tBENJI
- surplus liquidation at NAV 1.00 costs the liquidator 245.1833358 ≤ 500 ✓; surplus 4.9531988
- liquidation at 0.985 pays 241.5055858 ≥ terms 240.2071233 → lender whole (1.2984625 to spare), no Shortfall; "paid in full" needs NAV ≥ 0.9798; the runbook still restores NAV to 1.00 before beat 6 so the surplus shown is the headline one
- shortfall at NAV 0.97: proceeds 237.8278357, short 2.3792876 vs terms
- balances drift by 245.18 USDC and 247.66 tBENJI per liquidation, so the reset script moves them back (§11)

## 7. Parameters

"Production intent" divides demo seconds by the demo's 60 s per day (D#5), except where a finding set a different value (marked).

| Name | Scope | Demo value | Production intent | Unit | Source |
|---|---|---|---|---|---|
| `term` (`term_secs`) | per offer? (O4) | 420 | 7 days = 604,800; product range 7-30 days | s | D#5; [INTRO.md:19](../INTRO.md#L19) |
| `year_secs` `[v2 F-01]` | global | 21,900 | 31,536,000 (365 d; ACT/360 = 31,104,000 is one value away) | s | F-01; O6 |
| `margin_window_secs` | global | 120 | `[v2 F-19]` 3 days = 259,200 (a Friday call survives to Monday's print) | s | D#5; F-19 |
| `grace_secs` | global | 60 | 1 day = 86,400 | s | D#5 |
| `max_nav_age_secs` | per asset (D#25) | 180 | ≈ 96 h = 345,600 (a Friday print covers the weekend; D#25) | s | D#5; D#25; F-19 |
| `liq_delay_secs` (roadmap, F-10) | global | 0 | 1 day = 86,400 | s | F-10 |
| `expires_at` `[v2 F-22]` | per offer | UI default now + 24 h | lender's choice | s | F-22 |
| `apr_bps` | per offer | 500 | market; quoted as spread over T-bill floor 3.87%; UI shows net after fee (F-29) | bps/yr | [INTRO.md:19](../INTRO.md#L19); [collateral-research.md:58-60](collateral-research.md#L58-L60) |
| `haircut_bps` | per asset (`AssetConfig`) | 300 | USTBL/BENJI/USDY 300, EUTBL 1,200, CETES 2,350 (D#35, [config-tuning.md](config-tuning.md)) | bps | D#4, D#13, D#35 |
| `margin_trigger_bps` `[v2 F-20, decision 1]` | per asset | 200 (tBENJI), 2,000 (tSAFO) | USTBL/BENJI/USDY 200, EUTBL 850, CETES 1,850 (D#35) | bps | F-20, D#35 |
| `liq_discount_bps` | global or per asset? (O10) | 100 (deploy.sh and live testnet since the 26 Oct redeploy) | 100 (D#35; 3 days of carry ≈ 0.03%; capital and freeze risk on top); Dutch auction on cut list | bps | D#4, D#14; F-21; D#35 |
| `fee_bps` | global | 1,000 | 1,000 (D#35; same as Aave Horizon and XOXNO); a 0% launch promotion is a go-to-market option; fee address labelled "reserve" (F-28) | bps of interest | D#3; O1; D#35 |
| `AssetConfig.enabled` | per asset | true (tBENJI) | issuer partnership required; set false on a NAV break (roadmap, F-08) | bool | D#13 |
| `oracle_asset` `[v2 F-17]` | per asset | SEP-40 `Asset` (mock tBENJI) | SEP-40 `Asset::Other("BENJI_FUNDAMENTAL/USD")` or similar; Chainlink via adapter | enum | D#2, D#13; F-17 |
| `nav_min` / `nav_max` (roadmap, F-08) | per asset | — | stable fund: 0.995 / 1.005; accumulating fund: no decrease | NAV | F-08 |
| amount decimals | global | 7 | 7 | — | D#8 |
| NAV decimals | oracle | `decimals()`, value not set (O7) | feed's `decimals()`, read every call | — | D#8; F-17 |
| demo NAV₀ | oracle | not set; 1.00 assumed (O7) | live NAV | USDC/share | [backing-chain-map.md:80](research/backing-chain-map.md#L80) |
| keeper interval | off-chain | 10 s `check_margin`; `[v2 F-04]` 60 s NAV re-post | once per NAV print is enough | s | [TASKS.md:41](../TASKS.md#L41); F-04 |

## 8. Invariants

Each is a test target for `math.rs` and the contract tests ([TASKS.md:18](../TASKS.md#L18), [59](../TASKS.md#L59)).

1. **Lender never receives more than offer terms.** Lender payout ≤ P + I − fee in every path (D#3). Today this breaks in the O2 band.
2. **Lender is never worse off at repay than at offer terms.** Repay pays exactly P + I − fee (D#3; [TASKS.md:28](../TASKS.md#L28)).
3. **No one-legged settlement.** USDC leaves escrow only in the same invocation that collateral enters (D#7; [TASKS.md:27](../TASKS.md#L27)).
4. **Debt is constant.** `repo.debt` never changes after take (D#15).
5. **Initial LTV.** At take, floor(C × NAV × (1 − h)) ≥ D, with NAV fresh (D#6, D#14, D#16).
6. `[v2 F-14, F-26]` **The contract never blocks the borrower's exit; the issuer can.** `repay` and `top_up` never read the oracle, never fail on staleness, and (roadmap) never fail because the lender's USDC leg cannot be delivered. An issuer freeze, clawback or de-authorization of the collateral overrides this, by design: the contract does not route around issuer action.
7. **No action on an old price.** `take_offer`, `check_margin` and `liquidate` revert on stale NAV (D#6, D#17).
8. **One offer, at most one repo.** Full takes only, double-take guard (D#16; [TASKS.md:59](../TASKS.md#L59)).
9. **One margin deadline per call.** While in MarginCall, `check_margin` never moves the deadline; it can only clear the call (F-12).
10. `[v2 F-07]` **Conservation at close.** Repay: D = lender + fee. Liquidation: proceeds = lender + fee + borrower surplus. The contract's collateral balance ≥ Σ C over Open, MarginCall and Defaulted repos; the excess is dividend tokens (real BENJI only) that v1 does not attribute. Clawback can break the inequality (O17).
11. **Fee ≤ interest, and the fee is paid only after the lender's terms are met** (D#3, D#4).
12. `[v2 F-11]` **Only whitelisted liquidators other than the repo's borrower receive seized collateral, and only at NAV × (1 − d)** (D#7; [TASKS.md:39](../TASKS.md#L39)).
13. **Rounding never favours the borrower or the liquidator over the lender** (D#8 direction; F-32 makes proceeds round up).
14. `[v2 F-10, F-27]` **Every repo can reach Repaid or Liquidated.** Defaulted is never terminal: the borrower can always repay out of it, and a liquidator can always buy out of it. Reaching Liquidated needs a fresh NAV and a funded, willing liquidator; the README names both as assumptions.
15. `[v2 F-34]` **Every state-changing method checks status first** and reverts with a named error on any other state.

## 9. OPEN

Files disagree or are silent. Each item carries a suggested default. `[v2]` Items touched by the review carry their finding.

- **O1. No `fee_bps` value in the repo.** D#3 gives the formula only. 10% comes from the team's business-model notes (outside the repo); 0% at launch. *Default:* config value 1,000 bps; demo 1,000 labelled illustrative (F-28).
- **O2. D#3 and D#4 conflict when D − fee ≤ proceeds < D.** D#4 gives the lender *all* proceeds whenever proceeds < debt. In that band the lender gets more than P + I − fee, which breaks D#3. The band is 0.0958904 USDC wide in §6. *Default:* lender gets min(proceeds, P + I − fee); fee address gets min(rest, fee); borrower gets the remainder; Shortfall only when proceeds < P + I − fee.
- **O3. `Shortfall.amount` undefined.** D − proceeds or lender terms − proceeds? §6.6 gives 20.0191780 vs 19.9232876. *Default:* lender terms − proceeds, consistent with O2.
- **O4. Term is per offer or global.** D#5 lists `term_secs` as config; the offers board and INTRO show a per-offer term. *Default:* per-offer `term_secs`; `year_secs` global (F-01).
- **O5. RESOLVED by F-01.** `year_secs` config (demo 21,900).
- **O6. Day count.** 365 or 360? *Default:* 365; ACT/360 rejected for the demo (design-review F-47), one config value later.
- **O7. Demo NAV and oracle decimals not set.** *Default:* NAV₀ = 1.00; decimals = 7 to match amounts; read `decimals()` every call (F-17).
- **O8. RESOLVED by F-02.** Both demo repos at P = 240; transfer-only reset script.
- **O9. RESOLVED (kept for traceability).** Haircut per offer vs per asset: settled by D#13.
- **O10. `liq_discount_bps` scope.** `AssetConfig` has no discount field. *Default:* per asset, next to `haircut_bps` and `margin_trigger_bps`. Exit time differs by issuer (A2).
- **O11. Admin parameter changes hit open repos.** *Default:* snapshot `haircut_bps`, `margin_trigger_bps`, `liq_discount_bps`, `margin_window_secs`, `grace_secs` and `fee_bps` into `Repo` at take.
- **O12. RESOLVED by F-20 (decision 1).** Trigger at `margin_trigger_bps` in front of the shortfall line. **O12b** (UI health uses the haircut): health = C × NAV × (1 − trigger) / D, haircut line shown as "take limit".
- **O13. RESOLVED by F-09.** `required_collateral` stored at call time; `top_up` cures on C ≥ required without a NAV read; `required_top_up` read method.
- **O14. RESOLVED.** A margin-deadline default needs no NAV: deadline passed and C < `required_collateral`.
- **O15. RESOLVED by F-10.** `repay` allowed in Defaulted until `liquidate` lands. Roadmap: `liq_delay_secs`.
- **O16. Push payouts can make `repay` revert.** Circle USDC is auth_revocable; the lender can also simply remove its USDC trustline (F-26). *Default:* `try_` transfer on the lender leg, claimable balance on failure (F-26, after submission). Fund-share legs are never routed around an issuer freeze (F-14).
- **O17. Issuer freeze or clawback of the contract's own balance.** The spike shows a frozen contract can't move tBENJI; clawback was not tested. *Default:* risk-register row; README "Risks and limits": issuer action halts repay and liquidation, the haircut can't cover it, lenders bear it (F-14).
- **O18. Liquidation sells all the collateral.** On a healthy default the borrower loses 1% of everything (10.32 USDC in §6.5), and the liquidator needs USDC ≈ 0.99 × full collateral value. *Default:* keep for the demo; roadmap: sell only ceil(D / (NAV × (1 − d))) and return the rest in kind; lender as liquidator of last resort after a timeout (F-27).
- **O19. RESOLVED by F-32.** Fee down; proceeds up; shortfall amount up.
- **O20. Business-day calendar is not modelled.** *Default:* demo unaffected; production `max_nav_age_secs` ≈ 96 h per asset (D#25) and `margin_window_secs` 3 days (F-19); roadmap: window counted in NAV prints newer than the call.
- **O21. No NAV bounds or circuit breaker.** *Default:* README names the oracle admin and the whitelist admin as one trust assumption; roadmap: per-asset typed bounds (F-08).
- **O22. RESOLVED by F-22.** `expires_at` on the offer.
- **O23. Who may call `repay` and `top_up`.** *Default:* anyone may pay. Collateral and surplus always go to the recorded borrower.
- **O24. Liquidator whitelist and issuer allowlist can diverge.** *Default:* `add_liquidator` checks `authorized(liquidator)` at add time; the issuer has a veto over the list (F-25).
- **O25. Events list undefined.** *Default:* the set in §5.3.
- **O26. Market-size figures disagree.** INTRO.md said $4B; [collateral-research.md](collateral-research.md) says $3.75B (rwa.xyz); the team's business notes (outside the repo) say ~$3B. **Resolved 25 Oct:** [numbers.md](numbers.md) owns market figures: $3.03B DefiLlama Active AUM, 25 Oct 2026; quote $3.75B only with "rwa.xyz" attached.

## 10. DECISIONS coverage

| D# | Where used | `[v2]` Proposed change |
|---|---|---|
| 1 Real USDC | §4.1, O16 | — |
| 2 SEP-40 | §4.14, §7 | Wording: SEP-40 feeds config-only; Chainlink via adapter; `oracle_asset` is the SEP-40 `Asset` enum (F-17, decision 4) |
| 3 Fee from interest | §4.12, §6.2, §6.5, inv. 1, 2, 11, O1, O2 | Fee address labelled "reserve" in README (F-28) |
| 4 Shortfall | §4.11, §4.13, §6.6, O2, O3 | README wording: "paid first", never "paid in full" (F-16); production discount intent 50-100 bps (F-21, decision 2) |
| 5 Time config | §4.3, §4.6-4.8, §4.14, §7, O4, O20 | Add `year_secs` (F-01, decision 3); production NAV age ≈ 96 h per asset (D#25), 3-day window (F-19) |
| 6 Stale NAV (take, liquidate) | §4.2, §4.7, §4.10, §4.14, §5.2, inv. 6, 7 | "Why" gains the issuer-action caveat (F-14); repay also allowed in Defaulted (F-10) |
| 7 Access | §4.1, §4.2, §4.5, §4.9, §4.10, §5.2, O23, O24 | `liquidate` rejects the borrower (F-11); `add_liquidator` checks issuer authorization (F-25) |
| 8 Units and rounding | §4.3, §4.4, §5.4, §6, O19 | Rounding list extended: proceeds up, fee down, shortfall up (F-32) |
| 9 AUTH fallback | §4.2 | — |
| 10 Active user | §6.2 carry | Carry slide uses the dividend-corrected numbers (F-07, F-23) |
| 13 Per-asset haircut | §4.1, §4.4, §7, O9, O10, O11 | `AssetConfig` gains `margin_trigger_bps` (F-20) |
| 14 Margin trigger | §4.4, §4.5, §4.11, §6.3, O12 | Trigger = `margin_trigger_bps`, not the liquidation discount (F-20, decision 1) |
| 15 Fixed debt | §4.3, §4.7, §6.1, inv. 4 | — (interest through grace deferred, design-review F-48) |
| 16 Full takes | §4.2, §4.4, §6.1, inv. 8 | — |
| 17 Stale NAV blocks check_margin | §4.5, §4.8, §4.9, §4.14 | — |
| Risk register | — | New rows: issuer authorizes a contract as holder of record (F-13); oracle admin and whitelist admin are one key (F-08); no liquidator shows up (F-27) |

## 11. Demo runbook `[v2 F-02, F-03, F-04, F-05]` (README "Run it")

Demo profile: 1 day = 60 s; term 420 s; margin window 120 s; grace 60 s; NAV age 180 s; `year_secs` 21,900. Balances: lender 500 USDC, borrower 1,000 tBENJI + 100 USDC, liquidator 500 USDC.

1. **Size.** Both repos (the on-camera one and the seeded one near maturity) at P = 240 USDC (§6.7). The 1,000 USDC worked example stays in the README; it does not run on the funded balances.
2. **Seed.** Deploy oracle and repo contract; issuer `set_authorized` for the contract and each liquidator; `add_liquidator` (which checks it); set NAV 1.00; create two offers; take one and advance it near maturity. If the reset redeploys the contract, re-run the issuer authorization and preflight `authorized(contract) == true`.
3. **Keeper.** Calls `check_margin` on open repos every 10 s and **re-posts the current NAV every 60 s** so the 180 s staleness clock never bites during narration or a pause. It never calls `default`; that is a human button in beat 5.
4. **Beat 3 (margin call).** Slider preset **0.985** (0.99 does not fire; the trigger is 0.98980 at D#35's 2%, 0.99487 at v2's 2.5%). Both open repos get called within 10 s; narrate that. `required_top_up` for the P = 240 repo at 0.985 is 3.7714711 tBENJI; the UI pre-fills it.
5. **Beat 4 (top-up).** 50-60 s of the 120 s window go on detection, signing and narration. Never pause a rehearsal while a repo is in MarginCall.
6. **Beat 5-6 (default, liquidate).** Set NAV back to **1.00** right before `liquidate`: at 0.985 the P = 240 liquidation pays 241.51 against terms 240.21 (whole since D#35's 1% discount; at 2% it paid 239.07 and showed a `Shortfall`), but at 1.00 the beat shows the full 4.95 surplus. The UI shows the NAV timestamp and age next to the price.
7. **Reset.** Transfer-only: liquidator's tBENJI back to the borrower; USDC back to 500 / 100 / 500. Each liquidation moves 245.18 USDC and 247.66 tBENJI; the balances do not survive a second run without it.

## 12. Trust assumptions and compliance `[v2 F-08, F-13, F-14, F-15, F-16, F-25]` (README "Risks and limits")

Plain statements the README should carry, each in one or two sentences:

- **The issuer authorizes the contract.** The whole design rests on the fund issuer calling `set_authorized` on a contract address, making it a shareholder of record. No contract holds BENJI today. Aave Horizon's issuers did this on Ethereum. The testnet uses a team-issued tBENJI. (F-13)
- **Lenders never hold fund shares.** They receive USDC only, so the lender side is open to anyone with USDC. Borrowers and liquidators are issuer-approved holders. (F-15)
- **Issuer action overrides the contract.** Freeze, clawback and de-authorization stop `repay` and `liquidate` wherever the shares are; the contract does not route around them; lenders bear collateral-freeze risk; the haircut does not cover it. (F-14)
- **Dividends.** Real BENJI pays daily dividends as new tokens to the holder of record, which during a repo is the contract. They belong to the borrower; v1 does not pass them through; the demo token pays none. Needs checking with the issuer whether a contract address receives them. (F-07)
- **The margin check is a stress guard for stable-$1 collateral.** NAV is 1.00 on a normal day; a call means the fund broke the buck or the feed is wrong. (F-06)
- **One admin key.** It sets the oracle address and the liquidator whitelist. A wrong price with a fresh timestamp plus a friendly liquidator can take the lender's principal (0.90 print → lender short 90.71 per 1,000). Target: split keys and a timelock; roadmap: per-asset NAV bounds. (F-08)
- **Liquidators.** Issuer-approved; the issuer has a veto over the list; transfers at NAV − d must be permitted by the fund (needs confirmation); assumed unaffiliated with borrowers (the contract rejects the borrower itself); nothing obliges a liquidator to buy, so a defaulted repo can wait. (F-11, F-25, F-27)
- **Shortfall.** The lender is paid first. If NAV falls more than the buffer between the call and the sale, the lender takes the loss and `Shortfall` records it. There is no insurance fund yet; the fee address is a reserve in name only. (F-16, F-28)
- **Staleness is feed liveness.** The rule catches a dead feed, not a fund that stopped publishing; the as-of date is not checked. (F-18)
- **Regulatory scope.** Testnet demo, no public offer. Tokenized fund shares are financial instruments (MiFID II), USDC is an e-money token (MiCA), FOBXX is a US fund: a live deployment from Lisbon needs a MiFID/CMVM analysis and issuer-specific distribution checks; gBENJI (Luxembourg UCITS class) is likely the EU-relevant share. All "needs checking". (F-15)
- **Lender economics.** 5% offer → 4.50% net after the fee; a variable-rate USDC pool paid 6.69%; T-bills 3.87%. What the lender buys for the gap: fixed term, fixed rate, T-bill collateral, an issuer-KYC'd borrower, and a product permissioned cash can use. (F-23, F-29)
- **Borrower economics.** No rebate on early repay, no partial repay; grace is a free day; being liquidated costs 1% of all collateral (11.28 per 1,000 at NAV 1.00; ≈ 56,000 on 5,000,000), so repay in Defaulted exists. (F-10, F-30, F-48)

## 13. Roadmap (post-hackathon, from accepted findings)

1. Dividend pass-through at close (F-07).
2. Per-asset typed NAV bounds; `NavBreak` disables new takes (F-08).
3. `try_` transfer on the lender's USDC leg with a claimable balance (F-26).
4. `liq_delay_secs` after default so a late repay cannot be raced in the same ledger (F-10).
5. Lender as liquidator of last resort after `liquidator_timeout_secs`; debt-sized sale with the remainder returned in kind (F-27, O18).
6. Margin window counted in NAV prints newer than the call; per-repo "strictly newer record" check (F-18, F-19).
7. Split admin keys and timelock on oracle and whitelist changes (F-08).
8. Collateral substitution, partial unwind, roll, lender termination on an issuer event; late fee per grace day; lender-optional minimum term with pro-rata after it (F-31, F-48, F-30).
9. Chainlink SEP-40 adapter (F-17).

## 14. Decisions for the team (max 5, each with a default applied in this document)

1. **Maintenance trigger** (F-20): add `margin_trigger_bps` between the haircut and the liquidation discount; changes D#14. Default: yes, demo 250 bps (call at NAV < 0.99487; ≈ 5.26 USDC cushion per 1,000 before any lender loss). If refused, the README must say post-call NAV risk is 100% the lender's.
2. **Liquidation discount in production** (F-21): demo keeps 2%; name a production intent. Default: 50-100 bps with the carry arithmetic in the parameter table; D#4 unchanged.
3. **`year_secs`** (F-01): add to D#5. Default: demo 21,900, production 31,536,000.
4. **Oracle swap wording** (F-17): reword D#2 to "SEP-40 feeds are config-only; Chainlink needs a thin adapter"; `oracle_asset` is the SEP-40 `Asset` enum. Default: yes.
5. **Demo sizing** (F-02): both demo repos at 240 USDC with a transfer-only reset, or top up the test accounts to run the 1,000 USDC intro example. Default: 240 USDC.

Applied without a decision (additive: each extends a row without contradicting it; the rows they touch are listed in §10 and still go through team chat as wording changes): stored cure target and `required_top_up` (F-09); repay allowed in Defaulted (F-10); `liquidate` rejects the borrower (F-11); a call clears on recovery (F-12); `expires_at` (F-22); proceeds round up (F-32); status guards and TTL bumps (F-33, F-34).
