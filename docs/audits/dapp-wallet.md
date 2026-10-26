# dApp, wallet and transaction UX audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: the web app (`app/src/*.ts(x)`, `app/vite.config.ts`) on `@stellar/stellar-sdk` 16.4.1 and `@creit.tech/stellar-wallets-kit` 2.7.1. The method was the Stellar Raven (https://raven.stellar.org) dApp playbook from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill): the transaction UX checklist, wallet integration, transaction building, transaction submission, data fetching and React sections. Findings were reproduced by running the app's real `explain()` on the exact error strings the app and the SDK throw, plus free testnet simulations, one real FAILED testnet transaction and a live friendbot double click on a throwaway account. An independent QA pass re-ran every repro and re-checked every cited line.

Bottom line: the happy path matches the playbook: generated `contract.Client` bindings, simulation before any wallet prompt, the network passphrase pinned on every signature, bounded polling and a clear reason on every blocked button. The gaps were all in the unhappy path: failures that lost the transaction hash or showed the wrong message, no signing timeout on contract writes, and three buttons outside the double-submit guard. The five Medium findings and the Low session-restore finding are fixed on main (app only, no contract change). Four Low robustness items are on the roadmap.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| DW-01 | Medium | Trustline submit errors are shown as a wallet decline | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-02 | Medium | Failed or expired writes lose the tx hash and show raw SDK text | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-03 | Medium | Five writes never show their tx hash | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-04 | Medium | No signing timeout on contract writes | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-05 | Medium | Friendbot, Claim and Add trustline escape the double-submit guard | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-06 | Low | Restored wallet session skips the network check | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |
| DW-07 | Low | Desk actions show no progress and no liquidation price | Roadmap (R14 Client and RPC robustness) |
| DW-08 | Low | Inclusion fee is always the base fee | Roadmap (R14 Client and RPC robustness) |
| DW-09 | Low | No automatic restore of archived contract state | Roadmap (R14 Client and RPC robustness) |
| DW-10 | Low | Wallet kit installed from npm, not JSR | Roadmap (R14 Client and RPC robustness) |

Status counts: Fixed 6 · Partly fixed 0 · Roadmap 4 · Won't fix 0 · Open 0.

### DW-01: Trustline submit errors are shown as a wallet decline

- Severity: Medium
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/chain.ts:403`, `app/src/chain.ts:405`, `app/src/errors.ts:60`
- Finding: Every trustline submit error was thrown as "Trustline tx rejected: <code>", and `explain()` tests a `/reject/` pattern first. So txInsufficientBalance, txBadSeq and txTooLate all showed "You rejected the request in your wallet. Nothing was sent." A changeTrust that landed FAILED (for example on low reserve) showed "Trustline tx FAILED" with no reason and no hash. This is the first transaction a new user's own wallet sends. QA added that the 120 s timebound started before the wallet prompt, so a slow signature landed as txTooLate and was then shown as a decline.
- Fix: trustlines go through `sendClassic` in `app/src/txerror.ts`. A network refusal becomes "Trustline tx not accepted: <code>" with the hash; a FAILED changeTrust decodes its op code (low reserve maps to "every trustline locks 0.5 XLM"); `explain()` maps transaction codes before the decline pattern. The trustline timebound is now 180 s, above the 120 s signing limit. Regression tests in `app/test/raven-r3.test.ts`: "DW-01 trustline submit ERROR keeps its code and hash and is never read as a wallet decline" and "DW-01 a FAILED changeTrust decodes the low-reserve op code and passes the hash through". QA confirmed it live with a real low-reserve changeTrust on testnet.

### DW-02: Failed or expired writes lose the tx hash and show raw SDK text

- Severity: Medium
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/chain.ts:224-232`, `app/src/errors.ts:93-95`
- Finding: `submit()` read `sent.result` inside its return, so any failure after submission dropped the hash the app already knew. SendFailed with txTooLate or txBadSeq showed "Sending the transaction to the network failed!", and a poll timeout showed the raw "Waited 300 seconds…". QA found it was worse on current testnet (meta v4): a transaction that lands FAILED makes the generated client throw `TypeError: Cannot read properties of undefined (reading 'switch')` for all ten writes. The user could not open the transaction in an explorer and might retry one that had landed.
- Fix: a typed `TxError` carries the hash, the stage and the code. `sendAssembled` signs, takes the hash from the signed envelope and shows it at submit time through the SDK's `onSubmitted` hook. It checks `getTransactionResponse.status` before reading `.result`, and decodes FAILED op codes and diagnostic events. txTooLate maps to "expired … sign it again", txBadSeq to "another transaction from this account went first", and still-pending to "check the hash before you retry". Every error flash carries the hash. Regression tests: "DW-02 SendFailed txTooLate / txBadSeq / txInsufficientBalance: mapped text plus the hash", "DW-02 meta-v4 FAILED: the status is checked before .result (no TypeError), contract error kept", and three more DW-02 tests in the same file.

### DW-03: Five writes never show their tx hash

- Severity: Medium
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/App.tsx:446-450` (trustline), `app/src/App.tsx:466-470` (claim), `app/src/App.tsx:1376-1386` (top-up), `app/src/App.tsx:1389-1392` (auto-repay), `app/src/App.tsx:1394-1406` (lender default)
- Finding: These five writes returned a hash, but their flash or result showed none, and auto-repay showed nothing at all. The other eight writes did show a TxHash, so the gap was inconsistent and hid the on-chain record for the affected flows.
- Fix: `Flash` has an optional `hash` (`app/src/ctx.ts`), rendered as `<TxHash kind="TX">` in the flash alert. The hash is set on trustline, claim, top-up, auto-repay (which now sets a flash), lender Declare default, and the newer in-kind claim and collateral-claim paths. Checked by reading the diff and by `git grep -n 'hash: out.hash\|hash: r.hash' ba3c054 -- app/src`.

### DW-04: No signing timeout on contract writes

- Severity: Medium
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/chain.ts:209-220`, `app/src/App.tsx:178-199`, `app/src/trustline.ts:48-66`
- Finding: Contract writes awaited the wallet with no time limit, and `run()` held the global `busy` flag. A wallet that never answered left every write button disabled until a page reload. A 120 s `signOnce` helper already existed, but only the trustline flow used it.
- Fix: `clientOpts.signTransaction` is wrapped in `boundedSign` (`signOnce`, 120 s, "The wallet did not answer in time. Nothing was sent. Try again."), which fits inside the SDK's 300 s timebound. Regression test "DW-04 a contract write whose wallet never answers fails after the limit with a generic message".

### DW-05: Friendbot, Claim and Add trustline escape the double-submit guard

- Severity: Medium
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/App.tsx:499-505` (friendbot), `app/src/App.tsx:482` (claim), `app/src/trustline.ts:139-146` (trustline)
- Finding: The friendbot button had no `disabled` state and no busy label on a 3-4 s call. In the repro a second click 300 ms after the first returned 400 `createAccountAlreadyExist`, so the app showed "Friendbot failed" over a successful funding. Claim and trustline were disabled only on their own key, so they could run beside another write from the same account, clash on the sequence number and overwrite the shared progress state.
- Fix: all three buttons are disabled while any write is in flight, with a "Funding…" label on friendbot. A 400 `createAccountAlreadyExist` counts as funded. Regression test "DW-05 friendbot 400 createAccountAlreadyExist counts as funded; other failures do not". QA re-ran the live double click: both clicks report success and the account holds 10,000 XLM.

### DW-06: Restored wallet session skips the network check

- Severity: Low
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/wallet.ts:102-120`, `app/src/App.tsx:147-149`
- Finding: Connecting checked the wallet's network, but a page reload restored the stored address without calling `getNetwork`, unlike the playbook's `checkConnection`. A wallet switched to another network then failed only at signing. The impact was limited because every signature pins the testnet passphrase and passphrase errors are mapped.
- Fix: connect and restore share `restoreWallet` in `app/src/session.ts`. On another network the kit disconnects and the app flashes "Wallet disconnected"; a wallet that cannot report its network keeps the session. Regression tests "DW-06 restore on another network disconnects and throws WrongNetworkError" and "DW-06 restore on testnet, or a wallet that cannot report its network, keeps the session". A re-check on window focus was not added; it is optional.

### DW-07: Desk actions show no progress and no liquidation price

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `app/src/App.tsx:1251-1308`
- Finding: The liquidator desk's Check margin, Declare default and Liquidate render no step progress, and Liquidate and Declare default have no busy label. Liquidate shows the debt and the collateral but not the USDC price paid until the receipt.
- Fix: planned: add step progress and labels to the desk, and show "You pay about X USDC" from NAV times (1 − discount) before the click.

### DW-08: Inclusion fee is always the base fee

- Severity: Low (QA: a robustness note rather than a playbook failure; the playbook sets no fee rule and its own examples use `BASE_FEE`)
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `app/src/chain.ts:389`; SDK default in `assembled_transaction.js:326`
- Finding: Every write pays the 100-stroop base inclusion fee, with no `getFeeStats` bump. Under surge pricing writes would lag or expire. Testnet rarely surges.
- Fix: planned: pass a fee from `server.getFeeStats()` (for example p70) in the client options and in the trustline builder.

### DW-09: No automatic restore of archived contract state

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `app/src/chain.ts:209-220`, `contracts/repo/src/storage.rs:20`
- Finding: The clients do not set `restore: true`. The repo contract's instance TTL bump is 6 days on testnet, so after a quiet week every write would fail with the raw "You need to restore some contract state…" message. QA added that an archived instance also breaks the simulated reads, so `restore: true` alone fixes writes only.
- Fix: planned: `restore: true` in the client options, or map the expired-state message to a plain sentence.

### DW-10: Wallet kit installed from npm, not JSR

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `app/src/wallet.ts:3-5`, `app/package.json:18`
- Finding: The app uses `@creit.tech/stellar-wallets-kit` 2.7.1 from npm. The kit's v2 moved to JSR under `@creit-tech/…`, and its maintainers say npm updates will eventually stop. It works today.
- Fix: planned: switch to `jsr:@creit-tech/stellar-wallets-kit` at the next kit update.

## What was checked

| Check | Result | Finding |
|---|---|---|
| Loading state during wallet signing | partial | DW-04, DW-07 |
| Tx hash shown right after submission | fail | DW-02, DW-03 |
| Confirmation tracked (pending, success, failed) | partial | DW-02 |
| "Wallet not connected" message | pass | |
| "User rejected" message | partial | DW-01 |
| "Insufficient XLM for fees" message | partial | DW-01 |
| "Account not funded" message with friendbot | pass | |
| Network mismatch detected | partial | DW-06 |
| Tx timeout and expiry mapped | fail | DW-02, DW-04 |
| Double submission prevented | partial | DW-05 |
| Destination and amount shown before signing | pass (Liquidate price missing) | DW-07 |
| One wallet kit, initialised once, picker modal | pass | |
| Session restored with no prompt | partial | DW-06 |
| Network checked after connect; disconnect clears state | pass | |
| Sign with `networkPassphrase`; wallet error text surfaced | pass | |
| Wallet kit v2 installed from JSR | fail | DW-10 |
| Invoke via generated `contract.Client` | pass | |
| Simulate before any wallet prompt | pass | |
| Every tx has a timebound | pass | |
| Fee control | note | DW-08 |
| Submission errors thrown with their result; bounded polling | partial | DW-01, DW-02 |
| Archived state restored | not handled | DW-09 |
| Unfunded account reads as not found; read-only calls simulated with no signer | pass | |
| Errors shown to the user, not only the console | pass | |
| Demo signer only on testnet; public build clears it and runs a secrets check | pass | |

## Not re-reported

An earlier internal review had already fixed three app gaps before this audit: the auto-repay hint, the collateral block reason and the stale-NAV text on the borrow and lend screens.
