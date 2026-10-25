# Decisions locked before coding

Weak spots from the project brief, turned into day-zero decisions. Changing these at 02:00 costs hours. Propose changes in the team chat, then edit this file.

| # | Decision | Why |
|---|---|---|
| 1 | **Real Circle testnet USDC** via its SAC. Mock USDC only if the faucet fails by 13:00. | Real infra lifts Composed track alignment (20% of score). |
| 2 | **Strict SEP-40 oracle.** Mock implements the full trait (`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`). Same client also reads one live Reflector/RedStone testnet feed. | Proves swapping to RedStone/Chainlink is config-only. |
| 3 | **Fee comes out of interest.** `fee = interest × fee_bps`; lender gets `principal + interest − fee`; then borrower surplus. | Lender must never receive more than the offer terms. |
| 4 | **Explicit shortfall path.** If liquidation proceeds < debt: lender takes all proceeds, borrower 0, emit `Shortfall { repo_id, amount }`. | Buffer is only ~1% (3% haircut vs 2% liquidator discount). Say it before a judge does. |
| 5 | **Time compression via config only.** `term_secs`, `margin_window_secs`, `grace_secs`, `max_nav_age_secs`. Demo profile: 1 day = 60 s, 7-day term = 7 min, margin window 120 s, grace 60 s, NAV age 180 s. | No demo hacks in contract logic. |
| 6 | **Stale NAV** blocks `take_offer` and `liquidate`. Never blocks `repay` or `top_up`. | A borrower can always exit. |
| 7 | **Access:** `check_margin`, `default` callable by anyone (keeper-friendly). `liquidate` whitelisted only. Borrower auth on `take_offer`; lender auth at `create_offer` when USDC is escrowed. | Clear trust model. |
| 8 | **Units:** i128, 7-decimal Stellar units; NAV scaled by oracle `decimals()`. Interest rounds up (lender's favour), LTV rounds down. One `math.rs` with tests. | Avoid off-by-decimals bugs at 03:00. |
| 9 | **AUTH_REQUIRED fallback.** Spike by 13:00. If a contract address can't be authorized, keep the flag for wallets where possible; worst case issue tBENJI without it and enforce the whitelist in-contract, flagged in README as a testnet workaround. | Unlocked track depends on native compliance. |
| 10 | **Target user is active, not passive.** Repo rate above fund yield = negative carry for passive holders. Pitch to traders/MMs whose USDC earns more than the repo costs. | Pre-empt the obvious economics question. |
| 11 | **Commit history starts today.** Small, frequent commits; README "Built during HackMeridian" section. | Hackathon Progress is 10% and judges check git log. |
| 12 | **Smart wallet only after G3 is green.** Freighter first; passkey login (OpenZeppelin smart accounts / Stellar Passport) only if the happy path works on testnet by 00:00. | Stated priority, but not at the cost of the core demo. |
| 13 | **Haircut is per asset, in contract config.** `AssetConfig { oracle_asset, haircut_bps, enabled }`, admin-updatable without redeploy. Offers name the collateral asset but carry no haircut; the UI shows the asset's haircut. Tier numbers tuned later (proposal: docs/collateral-research.md §3). | Agile: re-tier an asset in one call; lenders can't undercut the floor. |
| 14 | **Margin trigger** = `debt > collateral × NAV × (1 − liq_discount_bps)`. At the trigger a liquidation still pays the lender in full. Initial LTV check uses the asset haircut (`debt ≤ value × (1 − haircut_bps)`). Both bps are config; numbers tuned later. | Without a separate trigger, any NAV tick after a max-LTV take fires a margin call. |
| 15 | **Debt = principal + full-term interest**, fixed at `take_offer`. Early repay pays the same amount; no pro-rata. | Repo convention; one number for lender, borrower and margin math. |
| 16 | **Full takes only.** Borrower receives the whole offer principal and posts `collateral = debt / (NAV × (1 − haircut))`, rounded up. | No partial-fill state in `Offer`. |
| 17 | **Stale NAV also blocks `check_margin`** (extends decision 6). `default` on maturity + grace needs no NAV. | No margin call on an old price. |

## Risk register

| Risk | Sev | Mitigation / fallback | Owner | Check by |
|---|---|---|---|---|
| Contract can't be authorized on AUTH_REQUIRED asset | High | Spike first; fallback in decision 9 | I | Sun 13:00 |
| Composed track reads as "mocks only" | High | Real USDC + strict SEP-40 + one live feed; name each tool in README and deck | I / P | Sun 00:00 |
| Liquidation shortfall (NAV moves > ~1%) | Med | Decision 4; README explains buffer + insurance fund roadmap | C | Sun 19:30 |
| Negative carry challenge | Med | Decision 10; carry math on one slide | P | Mon 06:00 |
| Demand doubt | Med | Mentor validation + Binance/Franklin, BUIDL, Aave Horizon evidence | P | Sun 16:00 |
| Testnet RPC/faucet flaky during recording | Med | Seed script, record at 08:00, backup take | I | Mon 08:00 |
| Demo misses a beat on camera | Med | Seed repo near maturity; NAV slider; 2 rehearsals | F | Mon 07:30 |
| Unverified figures in deck | Low | Every number has a source link in README | P | Mon 06:00 |
| Submission platform issues | Low | Submit 11:30; test login Sunday | P | Sun 18:00 |
