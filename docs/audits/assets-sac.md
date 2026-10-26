# Stellar assets, SAC and trustlines audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: how the repo contract, the deploy and onboarding scripts and the app handle USDC (Circle's testnet issuer, AUTH_REVOCABLE), tBENJI (a team-issued SAC asset with AUTH_REQUIRED, AUTH_REVOCABLE and AUTH_CLAWBACK_ENABLED) and tSAFO (a Spiko-style allowlist token): SAC derivation, issuer flags, trustlines, freezes and clawback. The method was the Stellar Raven (https://raven.stellar.org) assets playbook from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill) (sections on the Stellar Asset Contract, asset flags, trustlines, SEP standards for assets and best practices), cross-checked against the [SAC docs](https://developers.stellar.org/docs/tokens/stellar-asset-contract). Every issuer power was traced through each contract path; the two contract findings were reproduced with Rust unit tests at the audited commit, and the issuer-key finding with a live testnet simulation that sent nothing. An independent QA pass re-ran every repro and re-rated severity.

Bottom line after QA: the contract talks to every token through the SEP-41 interface, reads decimals from the token, validates the issuer and not just the code, and parks USDC payouts that a frozen account cannot receive. The real gaps were clawback on the pooled collateral balance (the loss lands on the last repo out), public issuer keys on the live demo, and missing freeze checks in the contract and the app. The freeze checks and deploy guards are fixed on main and live since the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d); clawback has a keeper alert and corrected docs, with contract accounting on the roadmap (R11).

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| AS-01 | Medium | The tBENJI issuer key is public and can claw back all live collateral | Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| AS-02 | Medium | Clawback on pooled collateral lands on the last repo to settle | Partly fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| AS-03 | Low | A frozen lender's offer can still be taken | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| AS-04 | Low | The app does not show a frozen USDC trustline | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| AS-05 | Low | Deploy never checks that each SAC ID derives from its asset | Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232) |
| AS-06 | Low | Deploy continues when authorizing the repo contract fails | Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232) |
| AS-07 | Low | No record of the issuer's controls before listing; mock issuer hygiene | Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| AS-08 | Low | Contract (C-address) wallets cannot be onboarded | Roadmap (R14 Client and RPC robustness) |

Status counts: Fixed 4 · Partly fixed 3 · Roadmap 1 · Won't fix 0 · Open 0.

### AS-01: The tBENJI issuer key is public and can claw back all live collateral

- Severity: Medium (reported High; lowered on QA review)
- Status: Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The README risk line, an emergency rotation runbook and the listing checklist landed; moving the keys out of git is roadmap R10.
- Location: `.env` (tracked, public repo), `scripts/deploy.sh:94`, `scripts/deploy.sh:184`, `scripts/deploy.sh:306`, `scripts/onboard.sh:99`, `scripts/onboard.sh:133`
- Finding: The tracked `.env` in the public repo holds the tBENJI issuer secret, and the same key is the tSAFO admin. Simulated on testnet with that key (nothing sent), `clawback` of the repo contract's whole tBENJI balance (1,036,011,863 units, about 103.6 tBENJI of live collateral) and `set_authorized(repo, false)` both returned Success. QA added that the key can also mint unlimited tBENJI and take every open USDC offer with it, and lowered the severity: only testnet assets are at stake, a burner-key acceptance already covered part of it, and the admin key is equally public (UA-04), so rotating the issuer key alone would not change the demo's exposure.
- Fix: Landed (team decision: accept public burner keys through judging): the README "Public testnet keys" risk names the issuer's clawback and freeze powers, and `scripts/README.md` "Emergency key rotation (testnet)" gives a one-transaction rotation (an off-repo signer, master weight 0; same asset, SAC and contract IDs). DECISIONS #50 records the live issuer flags and signers. Roadmap ([R10](../../README.md#production-notes-raven-audit-roadmap)): privileged keys move to an untracked file at the next redeploy.

### AS-02: Clawback on pooled collateral lands on the last repo to settle

- Severity: Medium
- Status: Partly fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The keeper alert and the README wording landed; clawback-safe accounting in the contract is roadmap R11. CS-02 in [contract-security.md](contract-security.md) has the same root cause.
- Location: `contracts/repo/src/lib.rs:568-572`, `contracts/repo/src/lib.rs:787-791`, `contracts/repo/src/autorepay.rs:133-139`, `contracts/repo/src/storage.rs`, `README.md:292`
- Finding: `repay` and `liquidate` push each repo's full `collateral_amount` out of one pooled SAC balance, and storage keeps no per-asset total. A contract balance is clawback-enabled when the issuer has `AUTH_CLAWBACK_ENABLED`, as the live tBENJI issuer does. In the repro, two repos held 10,009,589,042 units each and the issuer clawed back one repo's amount from the contract: borrower 1 repaid and got the full amount back, borrower 2's `repay` failed, and after default `liquidate` on repo 2 failed too, so lender 2 went unpaid. The loss lands on whoever settles last, not on the targeted borrower. The README said only that a clawback "stops repay and liquidation".
- Repro:
  ```
  pool = 20019178084   (two repos, 10009589042 each)
  issuer clawback(repo contract, 10009589042)
  repay(r1) -> Ok, borrower 1 gets 10009589042 back
  repay(r2) -> Err;  default(r2); liquidate(r2) -> Err
  ```
- Fix: Landed: each keeper tick compares the contract's balance of each collateral token with the collateral of its Open, MarginCall and Defaulted repos and ALERTs `collateral short` from the second tick in a row; `scripts/README.md` has a guardian runbook (`no_new_repos`, so new repos do not refill the pool). The README "Issuer dependence" risk now describes the pooled-balance effect. Known limit: collateral parked for a refused push counts as surplus, so a clawback smaller than it is not seen. Roadmap ([R11](../../README.md#production-notes-raven-audit-roadmap)): a per-asset collateral total checked against the contract balance on every exit, blocking exits when short until the guardian writes the loss down.

### AS-03: A frozen lender's offer can still be taken

- Severity: Low (reported Medium; lowered on QA review)
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/lib.rs:437-505`, `contracts/repo/src/lib.rs:397-409`
- Finding: `take_offer` never checks the lender's USDC authorization. In the repro the lender's USDC was frozen after posting an offer: the lender's `cancel_offer` failed, but `take_offer` succeeded and the borrower received 970 USDC from the escrow. A frozen (for example sanctioned) lender's escrow keeps being lent out, and repayments accrue to its claimable balance. QA lowered it: no party loses funds the freeze does not already lock, so this is a compliance gap.
- Fix: `take_offer` returns `OfferNotFound` when the USDC SAC reports `authorized(lender) == false`; the offer stays stored and becomes takeable again after re-authorization. Regression test: `as03_frozen_lender_offer_cannot_be_taken` in `contracts/repo/src/test_raven_guards.rs`.

### AS-04: The app does not show a frozen USDC trustline

- Severity: Low
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/chain.ts:70-80`, `app/src/chain.ts:177-191`, `app/src/trustline.ts:13-16`, `app/src/errors.ts:45`
- Finding: The app reads `is_authorized` only for tBENJI. A wallet with a frozen USDC line saw no alert, counted the line as present, and Lend or Repay then failed with a SAC error text that blamed tBENJI.
- Fix: Balances carry `usdcAuthorized` from Horizon; a frozen line shows "USDC frozen by its issuer" and disables Lend, Take, Repay and Claim; the SAC authorization error text is asset-neutral. Regression test: "AS-04 a frozen USDC line blocks lend/take/repay/claim with its own text" in `app/test/raven-r3.test.ts`.

### AS-05: Deploy never checks that each SAC ID derives from its asset

- Severity: Low
- Status: Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232)
- Location: `scripts/deploy.sh:77-80`, `scripts/deploy.sh:285`, `scripts/deploy.sh:361`, `app/src/config.ts:30-31`
- Finding: The deploy script reads `*_SAC` and the optional `*_ASSET` independently. Today's IDs match, but a mismatched `.env` would let the app check trustlines on one asset while the contract moves another, and an unset `USDC_ASSET` wrote an empty string that the app then split into an undefined issuer.
- Fix: Both `*_ASSET` values are required, and step 0 derives each SAC ID with `stellar contract id asset` and stops on a mismatch before any build or transaction (`--preflight` runs only these guards). Regression checks in `scripts/test/deploy-guards.test.sh`: "AS-05 mismatched TBENJI_ASSET refused", "AS-05 mismatched USDC_ASSET refused", "AS-05 missing USDC_ASSET refused".

### AS-06: Deploy continues when authorizing the repo contract fails

- Severity: Low
- Status: Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232)
- Location: `scripts/deploy.sh:301-309`
- Finding: The `|| log "WARN ..."` meant for G-accounts without a trustline also swallowed a failed `set_authorized` for the repo contract itself. The deploy would report success and every tBENJI take would then fail with a SAC authorization error.
- Fix: The repo contract goes through `authorize_holder` as required: a failed `set_authorized`, or `authorized` still false afterwards, stops the deploy; borrower and liquidator accounts keep the warning. Regression checks: "AS-06 failed set_authorized on the repo stops the deploy", "AS-06 authorized(repo) still false stops the deploy", "AS-06 G-account failure stays a WARN".

### AS-07: No record of the issuer's controls before listing; mock issuer hygiene

- Severity: Low
- Status: Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The listing checklist landed; the mock issuer's distribution account and `stellar.toml` are roadmap R15.
- Location: `scripts/onboard.sh:103-108`, `scripts/deploy.sh:184`, `contracts/repo/src/lib.rs:161`
- Finding: For revocable and clawback-enabled assets the playbook says to confirm the issuer's master weight and identify who holds the admin roles before listing. Neither the code nor a runbook recorded the issuer's flags, lock state and roles before `set_asset`. The mock issuer also pays (mints) directly, one key is both the tBENJI issuer and the tSAFO admin, and the issuer has no home domain.
- Fix: DECISIONS #50 is a listing checklist (issuer flags, master weight, signers and thresholds, home domain and `stellar.toml`, SAC or token admin, who can pause, freeze, allowlist, mint and claw back, the NAV feed) with the testnet record taken from Horizon. Roadmap ([R15](../../README.md#production-notes-raven-audit-roadmap)): a distribution account and a `stellar.toml` for the mock issuer.

### AS-08: Contract (C-address) wallets cannot be onboarded

- Severity: Low
- Status: Roadmap (R14 Client and RPC robustness)
- Location: `scripts/onboard.sh:41`, `app/src/chain.ts:166-195`, `app/src/trustline.ts`
- Finding: Onboarding accepts only G-addresses, and the app reads balances from Horizon accounts, where a C-address reads as "not funded". Smart-wallet borrowers therefore cannot be onboarded, although the SAC supports contract holders (under AUTH_REQUIRED they need `set_authorized`, not a trustline). QA corrected the source: the SAC docs on balance authorization, not SEP-45.
- Fix: Planned: accept C-addresses in onboarding (skip the trustline, keep `set_authorized`) and read SAC `balance` and `authorized` over RPC for them. See [R14](../../README.md#production-notes-raven-audit-roadmap).

## What was checked

| Check | Result | Finding |
|---|---|---|
| Talk to SACs through the SEP-41 token interface | pass | |
| SAC address equals the derivation of code and issuer | pass live, no guard | AS-05 |
| Read `decimals()` from the token | pass | |
| Under AUTH_REQUIRED, authorize every holder including the contract | pass live, weak guard | AS-06 |
| A revocable USDC holder cannot trap the counterparty (payouts parked) | pass | |
| Revocable collateral legs (direct push, accepted design) | accepted, not re-reported | |
| Accounting survives clawback | fail | AS-02 |
| USDC clawback | pass (disabled on the Circle testnet issuer) | |
| Contract checks frozen or deauthorized status | fail | AS-03 |
| Check the trustline exists before paying | pass | |
| Trustline creation in the onboarding flow | pass | |
| Respect trustline limits | pass | |
| App checks trustline `is_authorized` | fail for USDC, pass for tBENJI | AS-04 |
| Validate the asset issuer, not just the code | pass | |
| Separate issuing and distribution accounts | fail (mock) | AS-07 |
| Lock the issuer or use multisig | fail | AS-01, AS-07 |
| Publish `stellar.toml` (SEP-1) | fail (mock) | AS-07 |
| Before listing a revocable or clawback asset, know the master weight and admin roles | fail | AS-01 |
| Use well-known issuers for common tokens | pass | |
| Contract (C...) accounts as holders | fail | AS-08 |
| Spiko-style token: contract and every liquidator allowlisted | pass live | |
| No allowance pulls on the collateral token | pass | |
| SAC error codes that collide with Caravel error codes decoded by emitting contract | pass in the app (raw clients mis-decode; note only) | |

## Not re-reported

Already fixed or accepted before this audit, and re-checked at the audited commit: USDC payouts to a frozen or missing trustline are parked for the owner's `claim`; an auto-repay that cannot return collateral refunds the USDC; collateral moves by direct push on purpose (DECISIONS #24), so a de-authorized receiver blocks that repay or liquidation until re-authorized; an issuer freeze of the repo contract halts the asset (stated in the README risks); and Spiko's allowlist and pause powers over tSAFO are documented.
