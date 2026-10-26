# Mainnet readiness: what stands between testnet and a mainnet beta

As of 26 Oct 2026, main at `e370b9a`. Every `file:line` below refers to that commit.

Caravel runs end to end on Stellar testnet. The contract logic a mainnet beta needs is mostly built and tested. What is left splits in two:

- **External work** (issuers, a price feed, an audit, legal, liquidators). This is the long pole: only outside parties can finish it, and no issuer, auditor or legal adviser has been engaged yet.
- **Code and ops work** (keys, the deploy profile, keepers, dividends, accounting). The team can do all of it. Several fixes are written and in review, but not on main yet.

Status values: **done** = main proves it (cited); **partial** = the part main proves is cited, the rest is open; **in progress** = a fix is written and in review, not on main; **open** = not started. Owners: team, issuer, auditor, legal. Sizes: **small** = a script or config change, no contract change; **medium** = a contract or keeper change with tests and a redeploy; **large** = waits on an outside party.

## Status today

Done on main and live on testnet:

| What | Evidence |
|---|---|
| Full repo lifecycle in one contract: offer, atomic DvP take, repay, margin call, default, liquidation | `contracts/repo/src/lib.rs:422` (`create_offer`), `:515` (`take_offer`), `:619` (`repay`), `:735` (`check_margin`), `:763` (`default`), `:821` (`liquidate`) |
| Auto-repay at maturity, opt-in per repo | `contracts/repo/src/lib.rs:669`, `:714`; `DECISIONS.md:33` (#27) |
| Claimable payouts: a USDC payout that fails (frozen account, closed trustline) is parked for `claim`, and the settlement still lands | `contracts/repo/src/payout.rs:18-35`; `contracts/repo/src/lib.rs:120-123`, `:165-177`; used at `contracts/repo/src/lib.rs:644-645`, `:865-867` and `contracts/repo/src/autorepay.rs:150-151`. README `Push payouts` (`README.md:300`) predates this. |
| Guardian (tighten only, instant) and timelock (every loosening waits, then expires) | `contracts/repo/src/lib.rs:267-414`; `DECISIONS.md:39` (#33) |
| Per-asset pause switches that never block an exit | `contracts/repo/src/lib.rs:255`; `DECISIONS.md:36` (#30) |
| NAV staleness per asset, NAV sanity band, settle path for a real move | `contracts/repo/src/oracle.rs:79`, `:125`, `:217`; `DECISIONS.md:31` (#25), `:37` (#31), `:47` (#41) |
| Exposure cap per asset | `contracts/repo/src/lib.rs:113`; `DECISIONS.md:38` (#32) |
| NAV outage fallback: the lender claims the collateral in kind, parked for custody if the token refuses the lender | `contracts/repo/src/lib.rs:911`; `DECISIONS.md:44` (#38); `contracts/repo/src/test_spiko.rs:481` |
| Permissioned tokens without `approve` (Spiko model), issuer allowlist and pause respected | `contracts/repo/src/test_spiko.rs:193`, `:365`, `:381`, `:416`, `:449`; `DECISIONS.md:30` (#24) |
| An issuer can authorize a contract as a holder of an AUTH_REQUIRED asset (BENJI model) | `spikes/auth/README.md` |
| Mock feed history cannot be backdated or rewritten | `contracts/oracle/src/lib.rs:10-15`; `DECISIONS.md:46` (#40) |
| Production risk numbers chosen from NAV and FX history and competitor terms | `DECISIONS.md:41` (#35); `docs/config-tuning.md` |
| 309 contract tests pass (18 oracle, 280 repo, 11 Spiko-style token) | `cargo test --workspace` on this commit, the same count as README |
| Live testnet deployment on real Circle testnet USDC | `README.md:280-288`; `deployments/testnet.json` |

## External work

| # | What | Why it blocks mainnet | Owner | Size | Status |
|---|---|---|---|---|---|
| E1 | **BENJI authorization.** Franklin authorizes the Caravel contract and each liquidator on BENJI's AUTH_REQUIRED trustlines. | Without it `take_offer` cannot move BENJI into escrow and no liquidator can receive it. No contract holds BENJI today (`README.md:23`, `:294`). | issuer | large | partial: the mechanism works on testnet (`spikes/auth/README.md`); no issuer approval yet |
| E2 | **Holder of record.** During a repo the contract holds the fund shares. The issuer must accept a contract as a registered holder, and its yield goes to the contract (`README.md:297`). | An issuer that will not register a contract cannot be listed at all. | issuer, legal | large | open |
| E3 | **Spiko allowlist.** Spiko allowlists the contract **and every liquidator**, not only borrowers (`README.md:295`; `DECISIONS.md:35`, #29). USTBL has production terms (`README.md:205`); SAFO stays disabled until due diligence (`DECISIONS.md:32`, #26). | Every Spiko transfer checks the allowlist; a liquidator missing from it cannot liquidate. | issuer | large | partial: the contract path is tested on a Spiko-style mock (`contracts/repo/src/test_spiko.rs:324`, `:381`); no issuer approval yet |
| E4 | **Production NAV feed.** A SEP-40 feed per listed asset whose timestamp is the issuer's NAV publication time, never a keeper's re-post (`DECISIONS.md:45`, #39). Today the feed is a mock written by an admin key (`contracts/oracle/src/lib.rs:10`, `:166`) and re-posted by `scripts/nav-keeper.sh`, both testnet only. No SEP-40 feed covers SAFO yet (`README.md:295`). The contract reads one feed for all assets (`oracle` in the config, `scripts/deploy.sh:206`), so that feed must cover every listed asset, or the contract gains a per-asset feed. | Every freshness rule assumes the timestamp is the NAV's age. A re-posting feeder voids them, and a wrong price can cost the lender principal (`README.md:299`). | issuer, team | large | partial: the contract reads any SEP-40 feed by ID (`contracts/oracle/src/lib.rs:5-8`; `DECISIONS.md:8`, #2) and enforces staleness and the band (`contracts/repo/src/oracle.rs:79`, `:125`); no production feed chosen |
| E5 | **Third-party audit** of the repo contract, with findings fixed and the report public. | The contracts have not been audited (`site/index.html:646`, `:666`). | auditor | large | open. Internal reviews only: the adversarial design review (`docs/design-review.md`) and an internal multi-angle audit whose fixes are in progress |
| E6 | **Legal analysis** per issuer and jurisdiction: fund shares as financial instruments, USDC as an e-money token under MiCA, who may lend and borrow, and what the operator needs (`README.md:302`). | Required before any public offer; the testnet demo is not one. | legal | large | open |
| E7 | **Liquidators.** At least one issuer-approved market maker that can redeem with the issuer and will buy at NAV minus the discount (`README.md:57`, `:298`). On testnet the only liquidator is a team wallet driven by the keeper (`README.md:92`). Launch caps are sized so whitelisted liquidators can absorb a full default (`DECISIONS.md:38`, #32). | Nothing obliges anyone to buy; without a liquidator a defaulted repo waits and the lender is not paid. | issuer, team | large | open |

## Code and ops work

| # | What | Why it blocks mainnet | Owner | Size | Status |
|---|---|---|---|---|---|
| C1 | **Keys out of git, multisig roles.** On testnet the admin, guardian, issuer and oracle keys are burner keys in the tracked `.env` (`README.md:253`; `scripts/deploy.sh:79-81`, `:218-219`; the feed is signed with the admin key, `scripts/nav-keeper.sh:23`), and the treasury defaults to the admin (`scripts/deploy.sh:83`). Mainnet: admin and guardian as multisig accounts, no secret in git, a treasury account of its own, and an oracle feeder key that is not the admin (Raven R10). | Anyone holding a testnet key can act as that role. On mainnet one leaked admin key could price the feed and propose a friendly liquidator. | team | medium | open (testnet keys accepted through judging, README Risks; one-tx emergency rotation in `scripts/README.md`) |
| C2 | **Admin powers without delay.** The liquidator whitelist (`contracts/repo/src/lib.rs:210-214`) and a first asset listing are instant, and the guardian is fixed at deploy (`README.md:299`; `DECISIONS.md:39`, #33). The repo contract has no admin rotation, so rotation goes through the admin account's own signers. Needed: timelocked liquidator additions, role rotation, an event for whitelist changes. | Together with a wrong but fresh price, an instant whitelist change is the main way the admin could hurt a lender (`README.md:299`). | team | medium | done by Raven R6 once merged and redeployed (DECISIONS #47): timelocked liquidator additions, guardian rotation, two-step admin handover, `LiquidatorSet`. Still instant: oracle prices and a first listing (roadmap R10, R12) |
| C3 | **Production deploy profile.** `scripts/deploy.sh` is testnet only: demo timers (`DAY_SECS=60`, `:56`; `TIMELOCK_SECS=120`, `:59`; NAV age 180 s, `:60`; NAV band 2,500 bps, `:62`), friendbot top-ups (`:122-140`) and the testnet passphrase (`:87-89`). Production values are in `README.md:200-216` and `DECISIONS.md:41` (#35). Two contract constants are testnet values too: the instance TTL bump (6 days, marked PRODUCTION, `contracts/repo/src/storage.rs:15-26`) and the timelock floor (60 s, `contracts/repo/src/lib.rs:1118`). | A mainnet contract deployed with demo timers would let a loosening through in two minutes and run a 7-day repo in 7 minutes. | team | medium | open |
| C4 | **Keepers.** One keeper and one nav-keeper run as systemd user services on one server (`scripts/README.md:80`, `:98`, `:157`). `check_margin`, `default` and `auto_repay` are permissionless, so anyone can run them, but on testnet nobody else does (`README.md:92`). Needed: keepers on independent hosts and RPC providers, alerting on every stall, liquidators running their own bots, and no NAV re-posting (E4). | If the only keeper stops, margin calls and defaults stop with it and the lender carries the risk. | team | medium | in progress (RPC timeouts, a tick watchdog and stall alerts: Raven R2, DECISIONS #43; redundancy open, roadmap R14) |
| C5 | **Dividend pass-through.** Real BENJI pays its yield as new tokens to the holder of record, which during a repo is the contract; passing it back to the borrower is not built (`README.md:59`, `:297`). | For an asset that distributes in kind, the borrower would lose the yield while it is held, or the tokens would sit unaccounted in the contract. | team, issuer | medium | open |
| C6 | **Issuer actions on escrowed collateral.** A freeze, pause or de-whitelisting stops repay, top-up and liquidation of that asset (`README.md:294-295`; `contracts/repo/src/test_spiko.rs:416`, `:449`). The contract tracks collateral per repo and does not reconcile it against its own token balance, so a clawback from the contract is not attributed to the repo it hit. Needed: a balance check on every exit and a guardian write-down path; until then a keeper alert. | One clawback could leave a different repo's collateral short. | team | medium | open (keeper `collateral short` alert: Raven R2, DECISIONS #43; contract accounting roadmap R11) |
| C7 | **CI.** Main has only the Pages workflow (`.github/workflows/pages.yml`); the tests run locally (`README.md:194`). Needed: tests, wasm build and snapshot check on every push and PR. | An auditor and every later change need a green, reproducible build. | team | small | done by Raven R1 once merged (`.github/workflows/test.yml`, DECISIONS #42) |
| C8 | **Versioned redeploys and provenance.** The repo contract has no upgrade entry point, so a fix ships as a new contract. Needed: a wind-down script for the old one (pause new repos, cancel offers, let live repos run off) and build metadata naming the source repo and commit. | Users must be able to tell which code holds their funds, and an old contract must not keep taking new risk. | team | small | done by Raven R4 once merged (`scripts/winddown.sh`, SEP-46 meta, `attest.yml`; DECISIONS #45) |
| C9 | **Loss reserve.** There is no insurance fund; a shortfall past the haircut falls on the lender, recorded on-chain (`README.md:293`). The protocol fee goes to a treasury labelled a reserve in production (`README.md:215`). | Does not block a capped beta: caps bound the loss and the shortfall is disclosed. Needed before caps are raised. | team | medium | open |
| C10 | **Deeper testing.** Property tests and fuzzing on the math, keeper decision tests, tests against the real feed contract. | Does not block a beta on its own; the audit will set the bar. | team | medium | open |
| C11 | **Repo features.** README Roadmap: collateral substitution, partial unwind, roll into a new term, a short liquidation delay, selling only enough collateral to cover the debt. | Not needed for a beta. | team | medium | open |

## Mainnet beta definition

Caravel is in mainnet beta when all of these hold:

1. **One Tier 1 asset is listed** (BENJI or USTBL), and its issuer has approved the contract and at least one liquidator (E1 or E3, E2, E7).
2. **That asset has a production NAV feed** that carries the source publication time (E4).
3. **A third-party audit is finished**, its critical and high findings are fixed on main, and the report is public (E5).
4. **A legal analysis covers** the listed issuer's jurisdiction and who may lend and borrow (E6).
5. **Admin and guardian are multisig accounts** with no secret in git, and liquidator additions are timelocked (C1, C2).
6. **The contract runs the production profile**: `day_secs` 86,400 and `timelock_secs` 172,800 (`README.md:202`, `:216`), the asset's production haircut, trigger, NAV age and band (`DECISIONS.md:41`, #35), and the production instance TTL (C3).
7. **Exposure is capped at the launch cap**, $2M for a Tier 1 asset (`DECISIONS.md:38`, #32), until liquidator depth is shown.
8. **Keepers run on independent hosts with alerting**, and the listed asset's dividends are handled (C4, C5).

Outside beta scope: a loss reserve (C9), more assets (EUTBL and eurSAFO need an FX feed, `DECISIONS.md:32`, `:35`), SAFO (disabled until due diligence), and the roadmap features (C11).
