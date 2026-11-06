# Caravel: Stellar developer friction log (HackMeridian 2026)

Caravel is an on-chain term repo: fixed-term USDC loans against permissioned tokenized Treasury funds, priced off daily NAV, settled with atomic DvP. We built three Soroban contracts (repo, mock SEP-40 NAV oracle, Spiko-style allowlist token), a React app and two TypeScript keepers, all on testnet. AI coding agents wrote most of the code and the team reviewed it, which shapes several points below. Times come from agent session logs and commit timestamps, so treat them as estimates.

## Stellar tools we used

- **Soroban, `soroban-sdk` 29.0.1** (28 in the first spike), with 309 contract tests on `testutils`.
- **Stellar CLI 28.1.0** for keys and funding, `contract build --meta` (SEP-46), deploy, invoke, `contract id asset`, `bindings typescript` and classic `tx` ops, all wrapped in an idempotent `scripts/deploy.sh`.
- **Stellar Asset Contracts**: Circle testnet USDC, plus our own tBENJI (AUTH_REQUIRED, REVOCABLE, CLAWBACK) and tEURC.
- **`@stellar/stellar-sdk` 16** (16.4.1 resolved) in the app and keeper, plus the generated `contract.Client` bindings.
- **Stellar Wallets Kit 2.7.1** (Freighter, xBull, Albedo, Lobstr and others).
- **Stellar RPC** (simulation, `getLedgerEntries`), **Horizon** (balances, trustline auth, paths), **friendbot** and the **testnet SDEX**.
- **Reflector SEP-40 testnet feed** as a live reference price.
- **Stellar Raven MCP** and Stellar's agent skills, for research and a 10-area self-audit (`docs/audits/`).
- **OpenZeppelin Stellar contracts**: reviewed but not adopted (DECISIONS #49). Our pre-event starter kit used the OZ smart account and spending-limit policy.

## Friction points (ranked by cost)

1. **Simulation under-counts write bytes after a rolled-back sub-call.** Transactions passed simulation, then landed `txFailed / invokeHostFunctionResourceLimitExceeded` with `operation byte-write resources exceeds amount specified`. We first hit it on back-to-back oracle pushes (1764 needed, 1684 declared). The next day `default` on an auto-repay repo, whose `try_transfer_from` failed and rolled back, simulated 660 bytes but needed 956. The keeper retried every 20 s, so the lender went unpaid until a teammate noticed. **Cost:** about 1 h of agent time over 3 cards and about 4 h wall-clock, including a redeploy. **Workaround:** pad every write by 2,048 bytes and 0.02 XLM, and check balance and allowance before the pull. *Evidence:* `scripts/README.md`; commits 4518df3, 5b4ed30, d7b36b8.

2. **Immutable contracts meant a redeploy for every fix.** About 19 deploy or redeploy commits in 3 days, and 12 merge-and-redeploy cards took about 4 h of agent time. Each new contract ID meant regenerating the bindings (IDs are embedded), re-running the issuer's `set_authorized`, re-adding allowlist entries (once lost, dccf00b), reseeding, re-syncing keepers and winding down the old contract. Each wasm upload cost about 1,000–1,500 testnet XLM. Skipping upgrades was our choice (DECISIONS #45); the redeploy tooling was ours to build.

3. **Testnet rent and the TTL trap.** With a 30-day instance TTL bump, the first deploy printed `Wrapping transaction with a fee bump transaction due to a fee of 5512.0202383 XLM` and failed with `TxInsufficientBalance`, because extending the instance also extends the code entry. **Cost:** about 10 min and about 7,500 testnet XLM. **Workaround:** a 6-day bump (8bc8467) and friendbot-merge top-ups. Running costs stayed high (about 55 XLM per `take_offer`, about 11,000 XLM a day for the NAV keeper), and an idle week archives the instance (audit DW-09).

4. **The SDK client and generated bindings disagree on reserved words.** The contract method `default` is registered at runtime as `default_`, but the generated typings still say `default`. TypeScript compiled cleanly and the button failed in the browser with `c.default is not a function`. **Cost:** about 10 min, plus one default sent by hand from the CLI (19c597a).

5. **SDK error handling on failed transactions.** On testnet (meta v4), any write that landed FAILED made the generated client throw `TypeError: Cannot read properties of undefined (reading 'switch')`, losing the hash. `rpc.Server` in 16.4.1 ignores `Options.timeout`, so a hung RPC silently stalled the keeper for up to 300 s. **Workaround:** our own `TxError` with `onSubmitted` hash capture, a 15 s `httpClient` timeout and a watchdog (fbd85c4, bb65428). **Cost:** about 1 h (estimate). *Evidence:* audits DW-02 and D-01.

6. **Regulated-asset (AUTH_REQUIRED) onboarding.** The issuer must authorize the contract's own balance after every deploy, and every user needs a trustline *and* issuer approval. One teammate added trustlines at 17:44 but couldn't use the app until 18:26: an unauthorized trustline just looks present. A declined `changeTrust` left users stuck, so we added a re-prompt (ec8cbd6). A treasury without a USDC trustline made every repay with a fee fail (`TrustlineMissing #13`, ba97cf7).

7. **Testnet stablecoins.** We found no scriptable testnet USDC faucet, so `buy-usdc.sh` turns friendbot XLM into USDC with a `path-payment-strict-receive` on the SDEX. On 27 Oct the testnet had no XLM→EURC path at all, so we issued our own tEURC. **Cost:** unclear but small. Teammates kept asking the agent for USDC.

8. **Raven MCP setup for an agent.** OAuth sign-in took three attempts as the callback window expired (partly our harness), and the tools needed an MCP reload we couldn't trigger from mobile. The agent's raw-HTTP fallback hit Cloudflare `Error 1010: Access denied` on its Python user agent. We rolled that back and used native tools only. **Cost:** about 25 min. After setup, Raven worked reliably.

9. **Soroban test snapshots slow down agent workflows.** `cargo test` rewrites 143 JSON snapshots, which caused merge churn, snapshot-only commits (3d02d3b, 7452f5a) and a 233k-character diff over our reviewer tool's 150k limit. **Workaround:** an AGENTS.md rule and a CI drift check. **Cost:** unclear.

**Minor:** binding packages ship their own SDK copy, so `instanceof` broke until a Vite resolver forced one copy. Wallets Kit v2 moved to JSR. A second friendbot call returns 400 `createAccountAlreadyExist`. Reflector prices are 2–10 min old, older than our 180 s staleness limit. To move fast we shared testnet-only burner keys through the repo; the audit flagged it, and the mainnet profile keeps keys out of git.

## What worked well

- **SAC authorization worked exactly as documented.** The AUTH_REQUIRED spike, including freezing a contract-held balance, reached GO in about 7 minutes.
- **The CLI scripts cleanly.** A fresh deploy takes 49 s and a no-op re-run 6 s.
- **SEP-40 is a real interface.** Our mock and Reflector have identical specs, so swapping feeds is a config change.
- **Generated bindings plus simulate-before-sign** kept the app thin. About 10 agent subagents had the core product live on testnet in about 1 h 20 min.
- **Raven playbooks as audit checklists**: 89 findings, 53 fixed within a day.
- **Friendbot and `testutils`** were fast and reliable.

## What would have made building on Stellar easier

1. Simulation that counts entries touched by rolled-back sub-calls, or warns about them, plus an SDK resource-headroom option.
2. Bindings whose typings match runtime names, or a build-time lint for reserved method names.
3. A fix for FAILED-transaction parsing under meta v4, and an `rpc.Server` that honours `timeout`.
4. A CLI max-fee guard for expensive deploys, and docs saying that extending the instance TTL also extends the code entry.
5. A scriptable testnet USDC/EURC faucet or liquid pairs, and an idempotent friendbot.
6. Redeploy tooling: bindings that read IDs from config, and a standard wind-down pattern.
7. Wallets showing "pending issuer authorization" as its own trustline state.
8. Agent-friendly Raven: token auth for headless agents, a longer OAuth window, no blocking of non-browser user agents, and a docs `llms.txt`.
9. Test snapshots off by default in `soroban-sdk`.
