# Franklin Templeton (BENJI / FOBXX)

Status: draft only. Misha sends it; nothing has been sent.

## Contact route (public)
- **Primary:** BenjiHelp@franklintempleton.com, +1 866-821-7516 (Americas). Source: the "Contact Us" panel at https://invest.digitalassets.franklintempleton.com/ ("If your company is interested in learning more about Benji, please contact us"). BENJI on Stellar is the US fund FOBXX, so the Americas desk is the right one.
- Luxembourg/BVI and Singapore desks share OnchainServicingIntl@franklintempleton.com (same source). Use it only for gBENJI or sgBENJI, which are low priority (kyc-assets/report.md).
- No named digital-assets BD contact was found on a public Franklin page. Do not guess one. A warm intro through SDF is the likely faster path (see Next in README.md).

## The ask
1. **Authorize the Caravel repo contract as a BENJI holder** (`set_authorized` on the contract address through the SAC `CCDSDPD7…XQ7A`). Today 0 contracts hold BENJI out of 1,385 authorized trustlines (kyc-assets/report.md, Horizon 2026-10-25).
2. **Approve named liquidators.** They buy defaulted collateral at NAV − 1% and must be able to redeem with Franklin (README "Who liquidates?"; DECISIONS #35). Also approve one custody account for the NAV-outage fallback: after 11 days without a fresh NAV, the lender of a defaulted repo may claim the collateral in kind, and a refused push parks it for an approved custody account (DECISIONS #38).
3. **Dividends while BENJI sits in the contract.** The fund "accrues yield continuously and reflects it in holder balances throughout the day" ([Stellar case study](https://stellar.org/case-studies/franklin-templeton)). During a repo the contract is the holder of record, so the yield lands there. Ask for Franklin's preferred treatment. Pass-through to the borrower is on Caravel's roadmap and not built (README Risks: Dividends).
4. **NAV timing.** Ask when the daily NAV is struck and published, what Franklin treats as the authoritative on-chain NAV source, and its "as-of" time. The FOBXX page showed NAV $1.0000 "As of 10/23/2026" on 26 Oct. Caravel needs a feed whose timestamp is the NAV publication time (DECISIONS #39), and RedStone's current feed does not meet that (feed-probe.md).

## What we offer
- A new on-chain use for BENJI: holders borrow USDC for 7–30 days without redeeming. Lenders put in and take back USDC (README Compliance), except in the NAV-outage in-kind fallback (DECISIONS #38).
- Franklin's controls keep working. Freeze, clawback and de-authorization apply to the contract like any holder. They stop repay, top-up and liquidation, and the guardian can switch on `no_seize` so that no borrower is defaulted because of an issuer action (README FAQ, Risks: Issuer dependence).
- A small, bounded start: a $2M BENJI exposure cap, about 0.5% of BENJI's $434.7M on DefiLlama, 25 Oct 2026 (DECISIONS #32), and a 3% haircut (#35).
- Open code and a working testnet demo: https://github.com/rcusans-code/Caravel and https://caravel-repo.pages.dev/app/.
- A hook from Franklin's own material: the Stellar case study says institutional growth "has scaled through the fund's collateral program".

Caveat for Misha: the same case study says that in 2018 Franklin preferred controls "as features of the protocol itself rather than as add-ons via smart contracts". Expect questions about a contract as holder of record. This draft leans on the native SAC authorization still applying.

## Draft (≤150 words)

Subject: BENJI as repo collateral on Stellar: authorizing one contract

Hello Benji team,

Caravel is an open-source term-repo protocol on Stellar (testnet today). A BENJI holder borrows USDC for 7–30 days against BENJI without redeeming. The debt is fixed, margin is checked against the daily NAV, and a default is sold at NAV minus 1% to a liquidator you have approved.

A mainnet pilot needs four things from you:
1. Authorize the Caravel contract as a BENJI holder.
2. Authorize named liquidators who can redeem with you, plus one custody account for our NAV-outage fallback.
3. Your rule for yield accrued while BENJI sits in the contract.
4. Confirm your NAV publication time and authoritative source.

Your freeze and clawback keep working on the contract. We would start with a $2M cap.

Code: github.com/rcusans-code/Caravel. Could we have 30 minutes with your digital-assets team?

<name>, Caravel
