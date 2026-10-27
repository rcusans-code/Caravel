# Caravel mainnet outreach pack

2026-10-26. These are drafts only: nothing has been sent, no form submitted, no transaction signed. Misha sends each message himself.

## What Misha needs to decide
1. **The BENJI price feed is not mainnet-ready (feed-probe.md: FAIL against DECISIONS #39).** RedStone publishes BENJI on Stellar only as a MultiFeed contract, not in its SEP-40 contract. Its timestamp is RedStone's daily heartbeat (it ticked on Sat and Sun), not Franklin's NAV date (Fri 23 Oct). Default: send the RedStone ask and do not wire the feed until RedStone answers. A MultiFeed→SEP-40 adapter would be new contract scope and would need its own card.
2. **Send order.** Default:
   1. Spiko main request (already drafted in kyc-assets, after the demo).
   2. Franklin.
   3. RedStone.
   4. Spiko follow-up.
   5. Auditors, once one issuer answers. A quote is cheaper to act on once mainnet is likely.
3. **The Franklin draft asks for a custody account as well as the contract and liquidators**, because the #38 in-kind fallback can send BENJI to a lender or custody account. Without it, "lenders never hold fund shares" would be a promise the code does not keep.

## Parties

| Party | File | Contact route (public) | Core ask |
|---|---|---|---|
| Franklin Templeton (BENJI) | [franklin-templeton.md](franklin-templeton.md) | BenjiHelp@franklintempleton.com, from the Contact Us panel on invest.digitalassets.franklintempleton.com | Authorize the contract, the liquidators and a custody account; rule for yield in the contract; NAV timing |
| Spiko | [spiko.md](spiko.md) | contact@spiko.io; "Book a meeting" typeform on spiko.io | Main `WLISTED` request = kyc-assets/report.md Decisions #2 (not redrafted); follow-up on NAV feed, USTBL calendar, redemption, grant scope, and `WLISTED` for one custody account (#38 in-kind fallback) |
| RedStone | [redstone.md](redstone.md) | redstone.finance/contact form (Institutional & BD or Core Engineering) | BENJI in the SEP-40 contract; a source-time timestamp; SLA; Spiko coverage |
| Auditors (Veridise, Certora, Runtime Verification, Zellic, OtterSec) | [auditors.md](auditors.md) | One quote route per firm; all are SDF Audit Bank partners | Quote for `contracts/repo` (~2.6k lines) |
| Feed probe | [feed-probe.md](feed-probe.md) | — | Raw `--send=no` output and the #39 verdict |

Every draft is at most 150 words, including subject and sign-off. Sign-offs read `<name>, Caravel`; fill in the name before sending.

## Not done
- No named person at Franklin, Spiko or RedStone; only public desk routes. No contact was guessed.
- I did not check whether Caravel has an SCF award, which decides Audit Bank eligibility (auditors.md).
- The Spiko help centre returned 403 to a script.

## Next
- Ask SDF (the Stellar case study names Franklin's "collateral program") for a warm intro to Franklin's digital-assets team. It is likely faster than the help desk.
- Once RedStone answers: either a card to wire BENJI's SEP-40 feed with a source-time check, or an adapter card.
