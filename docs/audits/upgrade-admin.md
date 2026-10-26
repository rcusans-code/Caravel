# Upgradeability and admin-key model audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: who can change what in the repo contract, the mock oracle and the tSAFO mock (admin, guardian, oracle admin, liquidator whitelist, issuer), what a redeploy does to open positions, and the deploy script that wires the keys. The method was the Stellar Raven (https://raven.stellar.org) OpenZeppelin upgrade playbook ([openzeppelin-skills](https://github.com/OpenZeppelin/openzeppelin-skills), `upgrade-stellar-contracts`: sections on the Soroban upgrade model, upgrade safety and access control). Findings were reproduced with a scratch Rust integration test at the audited commit (3 attack scenarios) and a read-only simulation of the superseded testnet contracts; signer setups were read from Horizon. An independent QA pass re-ran every repro and re-rated severity.

Bottom line after QA: the contracts are immutable (no upgrade entry point), and every admin and guardian entry point checks auth on the configured key. The weak points were the roles themselves: a guardian could veto a clear of its own pause forever, a tighten-only change could margin-call live repos at par, no role could be rotated without a redeploy, and a redeploy left offers stranded in the old contract. Those are fixed on main and live on testnet since the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d). Key custody (keys out of git, multisig, a separate oracle feeder key) is roadmap R10.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| UA-01 | Medium | A guardian or admin trigger raise can margin-call live repos at par | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| UA-02 | High | Guardian veto can lock collateral for good, and the guardian cannot be replaced | Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| UA-03 | High | One admin key prices the oracle and whitelists liquidators, with no delay | Partly fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| UA-04 | Medium | Admin and guardian secrets are public in the tracked `.env` | Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| UA-05 | Medium | A redeploy strands offers and repos in the old contract | Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232) |
| UA-06 | Medium | No role can be rotated; oracle `set_admin` is one step | Partly fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| UA-07 | Low | Production timelock and instance TTL hold only by convention | Roadmap (R12 Production profile and contract roadmap) |
| UA-08 | Low | Docs claimed separate oracle-admin and whitelist-admin keys | Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| UA-09 | Low | A first listing is instant and can reuse another asset's feed | Roadmap (R12 Production profile and contract roadmap) |

Status counts: Fixed 4 · Partly fixed 3 · Roadmap 2 · Won't fix 0 · Open 0.

### UA-01: A guardian or admin trigger raise can margin-call live repos at par

- Severity: Medium (reported High; lowered on QA review)
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae). OZ-01 in [openzeppelin-patterns.md](openzeppelin-patterns.md) has the same root cause.
- Location: `contracts/repo/src/lib.rs:194-206`, `contracts/repo/src/lib.rs:850-858`, `contracts/repo/src/margin.rs:59`, `contracts/repo/src/margin.rs:142`, `contracts/repo/src/margin.rs:175`
- Finding: `asset_tightens` counts a margin-trigger raise as a tightening, so the guardian (or the admin) can apply it instantly, and the margin checks read the asset's current trigger on live repos. In the repro the guardian alone set haircut 9,999 and trigger 9,998 at NAV 1.00: `check_margin` returned MarginCall, a top-up that doubled the collateral did not clear it, and 121 s later the repo defaulted and was liquidated, costing the borrower 40.02 USDC (2% of collateral) against repaying. QA lowered it: a trigger that binds live repos is a deliberate design choice, only the unbounded value is the defect, the borrower can still repay until a liquidation lands, the lender is paid in full, and it needs a trusted key.
- Fix: The trigger is clamped per repo: `margin::effective_trigger = min(asset.margin_trigger_bps, repo.haircut_bps - 1)`, used in `check_margin`, the default recovery check and the top-up clear (team decision: clamp, rather than snapshot the trigger). The app's cover figure mirrors the clamp. Regression tests: `ua01_oz01_tightening_cannot_margin_call_at_par` and `oz01b_admin_tightening_cannot_force_a_sale` in `contracts/repo/src/test_raven_guards.rs`; a real NAV dip still margin-calls. DECISIONS #46 records it.

### UA-02: Guardian veto can lock collateral for good, and the guardian cannot be replaced

- Severity: High
- Status: Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). OZ-02 in [openzeppelin-patterns.md](openzeppelin-patterns.md) has the same root cause.
- Location: `contracts/repo/src/lib.rs:209-213`, `contracts/repo/src/lib.rs:271-279`, `contracts/repo/src/lib.rs:328-336`, `contracts/repo/src/lib.rs:953-960`, `contracts/repo/src/types.rs:3`
- Finding: The guardian can switch `no_seize` on instantly and cancel every admin proposal to clear it, without limit, and `Config` has no setter, so the guardian cannot be replaced. In the repro, over 5 rounds of admin `propose_pause(clear)` and guardian `cancel_pause`, `execute_pause` always returned NoProposal and `default` stayed Paused; the repo was still Open 666 s past maturity with 1,000.96 tBENJI locked against 970.93 USDC owed to the lender. The same veto holds any guardian tightening in place (for example a NAV age of 1 s, which also blocks `liquidate`). A second path found while auditing the OpenZeppelin patterns: a guardian re-assert of the same pause silently dropped the pending clear. Only a voluntary repay or a redeploy broke the lock, and on testnet the guardian key is public (UA-04).
- Repro:
  ```
  guardian_set_pause(asset, no_seize = true)
  repeat 5x: propose_pause(clear) -> guardian cancel_pause -> execute_pause = NoProposal
  default(repo) -> Paused   (repo still Open past maturity)
  ```
- Fix: The guardian can cancel or supersede each proposed change once; if the admin re-proposes it unchanged, the guardian gets `VetoSpent` (27) and the change executes after the timelock. A guardian re-assert of the setting in force is a no-op and drops nothing. The admin rotates the guardian behind the timelock (`propose_guardian`, `execute_guardian`; only the admin can `cancel_guardian`). Regression tests in `contracts/repo/src/test_governance.rs`: `ua02_oz02_guardian_cancel_veto_is_spent_on_the_reproposed_clear`, `qa_guardian_reassert_pause_drops_clear_proposal`, `ua02_guardian_tightening_supersedes_a_proposal_once`, `ua02_admin_rotates_guardian_and_the_guardian_cannot_cancel`. Residual by design, stated in the README: a hostile guardian can re-pause `no_seize` after each executed clear; the remedy is the rotation, one timelock.

### UA-03: One admin key prices the oracle and whitelists liquidators, with no delay

- Severity: High (production; known before this audit as [F-08](../design-review.md#f-08) in the design review)
- Status: Partly fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). Liquidator additions are now timelocked; splitting the oracle feeder key from the admin is roadmap R10.
- Location: `scripts/deploy.sh:158-160`, `scripts/deploy.sh:278`, `contracts/repo/src/lib.rs:138-142`, `contracts/oracle/src/lib.rs:155-164`
- Finding: The deploy script makes the repo admin the mock oracle's admin too, and `set_liquidator` is instant. With the deployed parameters (a 2,500 bps NAV band) the admin key alone whitelisted a new liquidator, printed NAV 0.80, and 122 s later that liquidator paid 784.75 USDC for 1,000.96 tBENJI; the lender got 784.75 of the 970.84 due. No proposal was ever queued, so neither the timelock nor the guardian's cancel came into play. This shared-key trust assumption was already stated in the README; the new point was that the docs' reason for accepting it ("a stolen admin key cannot add risk instantly") did not hold (UA-08).
- Fix: Landed: liquidator additions go `propose_liquidator`, then `execute_liquidator` after the timelock, cancellable by the guardian; removal stays instant. The deploy script whitelists through propose, wait and execute. Regression test: `ua03_new_liquidator_cannot_act_before_the_timelock` (`set_liquidator(attacker, true)` now fails with `Loosens`). With the demo timelock of 120 s a stolen key still needs only about 2 minutes, but the addition is public and cancellable. Roadmap ([R10](../../README.md#production-notes-raven-audit-roadmap)): a separate oracle feeder key, moved with the oracle's new two-step `set_admin`, and narrow production bands.

### UA-04: Admin and guardian secrets are public in the tracked `.env`

- Severity: Medium (demo integrity during judging; Low on testnet value alone)
- Status: Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The README risk line and an emergency rotation runbook landed; moving the keys out of git is roadmap R10.
- Location: `.env` (tracked), `scripts/deploy.sh:216-217`
- Finding: The tracked `.env` holds 7 testnet secret keys, the admin and guardian among them, and the repo is public; the on-chain `config()` admin and guardian match those keys. A separate guardian therefore gives no independence on testnet: anyone can run UA-01, UA-02 or UA-03 against the live demo. Only testnet value is at stake.
- Fix: Landed (team decision: accept through judging): the README "Public testnet keys" risk says anyone can act as these keys on testnet and that mainnet keys are multisig and never in git, and `scripts/README.md` "Emergency key rotation (testnet)" gives a one-transaction rotation per key (an off-repo signer, master weight 0, same contract IDs, no redeploy), tested on testnet with throwaway accounts. Roadmap ([R10](../../README.md#production-notes-raven-audit-roadmap)): the deploy writes privileged keys to an untracked file; the tracked `.env` keeps only demo wallets.

### UA-05: A redeploy strands offers and repos in the old contract

- Severity: Medium
- Status: Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232)
- Location: `scripts/deploy.sh:238-247`, `scripts/keeper/src/keeper.ts:85-88`, `app/src/chain.ts:90`, `contracts/repo/src/storage.rs:20`
- Finding: Every fix ships as a new contract with empty storage, and the app and keeper serve only the current contract ID. Nothing paused or drained the old one. The three contracts superseded on 25 Oct still escrowed 1,050 testnet USDC in 11 open offers that no UI showed. With a 7-day term, a mid-term redeploy would have orphaned live repos. The funds were not lost (`cancel_offer`, `repay` and `claim` still work by hand), but the immutable model needs a wind-down to be complete.
- Fix: New `scripts/winddown.sh`: on each superseded contract it sets `no_new_repos` on every listed asset, cancels the offers whose lender key the team holds, and lists other lenders' offers and live repos. `deploy.sh` records replaced IDs in `deployments/testnet.json` (`superseded`) and winds down the contract it replaces. Regression checks in `scripts/test/deploy-guards.test.sh` (for example "UA-05 winddown refuses the live repo"). At the redeploy it ran on all 12 superseded contracts: every listed asset is paused for new repos and 11 offers returned 1,100 USDC; offers owned by another team wallet need that wallet to cancel them. The mainnet choice (stay immutable, versioned redeploys with wind-down) is DECISIONS #45, in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3).

### UA-06: No role can be rotated; oracle `set_admin` is one step

- Severity: Medium
- Status: Partly fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). The contract half (two-step handover, guardian rotation) landed; multisig admin and guardian accounts are roadmap R10.
- Location: `contracts/repo/src/types.rs:3-35`, `contracts/oracle/src/lib.rs:171-175`
- Finding: `Config` (admin, guardian, oracle, treasury, timelock) is set once at deploy with no setter, so a lost or leaked key is removed only by a redeploy. The oracle's `set_admin` moves control in one step with no acceptance, so a mistyped address loses the feed. Admin and guardian are single-signer accounts.
- Fix: Repo: `transfer_admin(new, live_until_ledger)` plus `accept_admin()` signed by the new admin, with the pending entry in temporary storage and an expiry; guardian rotation as in UA-02; a `roles()` view. Oracle: `set_admin` only names a pending admin and `accept_admin` moves the role, with `AdminSet` events. Regression tests: `ua06_transfer_admin_needs_the_new_admins_acceptance`, `ua06_admin_handover_expires_cancels_and_validates` (repo) and `r6_set_admin_is_two_step_and_only_the_named_admin_accepts` (oracle). Roadmap ([R10](../../README.md#production-notes-raven-audit-roadmap)): admin and guardian become multisig accounts.

### UA-07: Production timelock and instance TTL hold only by convention

- Severity: Low
- Status: Roadmap (R12 Production profile and contract roadmap)
- Location: `contracts/repo/src/lib.rs:964`, `contracts/repo/src/lib.rs:972`, `contracts/repo/src/storage.rs:19-24`
- Finding: `MIN_TIMELOCK_SECS` is 60 and testnet runs a 120 s timelock; the production instance bump is a code comment. A mainnet deploy that copies the demo profile would ship a 1-2 minute timelock, permanently, since the timelock is fixed at deploy.
- Fix: Planned: a production build that sets a timelock floor of at least 1 day and the 30-day instance bump, and a deploy guard that refuses demo values outside testnet. See [R12](../../README.md#production-notes-raven-audit-roadmap).

### UA-08: Docs claimed separate oracle-admin and whitelist-admin keys

- Severity: Low
- Status: Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3)
- Location: `DECISIONS.md:39`, `docs/mechanics.md:153`, `docs/design-review.md:192`, `docs/design-review.md:607`
- Finding: DECISIONS #33 justified the design with "a stolen admin key cannot add risk before lenders and borrowers can react", and two docs said the deploy script already used separate oracle-admin and whitelist-admin keys. Both were false at the audited commit: the deploy script uses one key for both, and UA-03 adds risk with no delay. The README already stated it correctly.
- Fix: DECISIONS #33 now lists what is not covered (one key with no delay on oracle prices and first listings until R10); `docs/mechanics.md` and `docs/design-review.md` state one key, whitelist additions timelocked since R6, feeder split on the roadmap. `git grep "separate oracle-admin and whitelist-admin"` on main returns nothing.

### UA-09: A first listing is instant and can reuse another asset's feed

- Severity: Low
- Status: Roadmap (R12 Production profile and contract roadmap)
- Location: `contracts/repo/src/lib.rs:161-174`, `contracts/repo/src/lib.rs:833-845`
- Finding: The tighten check runs only when the asset already exists, so the admin can list a new token instantly, priced off any feed (for example tBENJI's). Exposure is small (no offer can exist on a new asset yet, and lenders choose the collateral), and the README already names listing as an instant admin power.
- Fix: Planned: timelocked first listings, or require the oracle asset to match the listed asset unless proposed.

## What was checked

| Check | Result | Finding |
|---|---|---|
| Upgradeability is opt-in; no upgrade function means immutable | pass (no `update_current_contract_wasm` in any contract) | |
| Migration runs atomically with an upgrade | N/A | |
| Constructor not re-run on upgrade, so state needs a migration (redeploy analogue: wind-down of the old instance) | fail | UA-05 |
| V2 keeps an upgrade mechanism | N/A (immutable by design) | |
| Storage compatibility across versions | N/A under redeploy; would matter if an upgrade path is added | |
| Version tracking in wasm metadata (SEP-49) | fail (Low, no separate finding): no binary version; builds now carry SEP-46 `source_repo` and `commit_sha` meta, see STD-05 in [standards-seps.md](standards-seps.md) | |
| Upgrade path tested (redeploy analogue: old positions stay serviceable) | fail | UA-05 |
| Only authorized callers reach privileged functions | pass | |
| Auth defined explicitly on every admin path | pass | |
| Role model fits the powers | fail | UA-01, UA-02, UA-03 |
| Multisig or governance for value-bearing roles | fail | UA-04, UA-06 |
| Role transfer and rotation | fail | UA-02, UA-06 |
| Manual review | pass (this report) | |
