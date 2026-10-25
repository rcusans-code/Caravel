# Caravel in 5 minutes

Read this first. Then [DECISIONS.md](DECISIONS.md), then your tasks in [TASKS.md](TASKS.md).

## What we're building
A pawnshop for government bonds, on the blockchain, with a fixed return date.

Someone holds a token that represents US Treasury bills (a "tokenized fund"). They need cash (dollars) for a week but don't want to sell the bonds, because the bonds earn interest. Caravel lets them lock the bonds as a deposit, get dollars instantly, and get the bonds back when they repay.

Banks have done this for decades. It's called a **repo** (sale and repurchase). We're bringing it on-chain on **Stellar**.

## Why it matters
- About **$2.4B** of these fund tokens already live on Stellar (DefiLlama, 25 Oct). The biggest issuers are Spiko (≈$1.78B) and Franklin Templeton (BENJI, $475M).
- Almost none of it can be borrowed against. Lending pools that accept them hold about **$2M**.
- Reason: existing crypto lending sells your deposit the moment its price dips, 24/7. Bond funds only publish a price once a day and markets close on weekends. The models don't fit.
- Our fix: **fixed-term loans** that only check the price once a day. Like a bank, not like a crypto exchange.

## How it works (one example)
1. **Lender** offers: "1,000 USDC for 7 days at 5% a year." Their USDC sits in our contract.
2. **Borrower** accepts: receives the 1,000 USDC and locks about $1,032 of bond tokens (3% haircut: the loan is at most 97% of the deposit). Both happen in **one transaction**. Either both move or neither does.
3. **Daily check:** if the bonds' price drops so the deposit no longer covers the loan, the borrower gets a **margin call**: add more bonds within a time window.
4. **Day 7:** borrower repays 1,000 USDC + interest, gets the bonds back. Done.
5. **If the borrower doesn't pay:** an approved buyer (**liquidator**) buys the bonds at a 2% discount. The lender is paid in full from that. Anything left goes back to the borrower.

## Who's who
| Role | Wants | Gives |
|---|---|---|
| Borrower | Dollars now, keep earning bond interest | Bond tokens as deposit + interest |
| Lender | A safe fixed return on idle dollars | USDC for a fixed term |
| Liquidator | A ~2% near-riskless profit | Buys bonds if a borrower defaults |
| Issuer (e.g. Franklin Templeton) | More people using their token | Approves who may hold it |

## Words you'll hear
- **USDC**: a token worth exactly $1.
- **RWA**: real-world asset as a token (here: a Treasury-bill fund).
- **NAV**: the fund's official price per token, published once a day.
- **Haircut**: safety margin. 3% haircut = deposit $1,000, borrow at most $970.
- **LTV**: loan-to-value, the loan divided by the deposit value (here 97% max).
- **Margin call**: "your deposit fell in value, top it up."
- **Liquidation**: selling the deposit because the borrower didn't pay.
- **DvP**: delivery versus payment. Deposit and money swap in one atomic step.
- **Stellar**: the blockchain we use. Fast, fees under a cent.
- **Soroban**: Stellar's smart contracts, written in Rust.
- **SAC**: Stellar Asset Contract. Lets our contract move Stellar's built-in tokens (USDC, bond tokens) directly.
- **Trustline / AUTH_REQUIRED**: on Stellar you must opt in to hold a token, and the issuer can require approval. That's how compliance works without us building KYC.
- **Oracle / SEP-40**: a contract that publishes prices. SEP-40 is Stellar's standard format for it.
- **Testnet**: Stellar's free practice network. Everything we deploy lives there.

## What the demo shows (2–3 min video)
1. The problem in one slide: $4B of bonds vs $2M usable.
2. Lender posts offer → borrower takes it → one transaction moves both sides.
3. Price drops → margin call → borrower tops up.
4. Day 7 → repay → bonds returned.
5. Second loan: borrower defaults → liquidator buys → lender paid in full.
6. Close: "Repo, like banks do it, but 24/7, atomic and open."

To make this fit in a video, **1 day = 60 seconds** in the demo. That's just settings, not special code.

## How we work for the next 24 hours
- **Hard deadline: Mon 12:00. We submit at 11:30.**
- Judges review the video, deck, repo and README without us in the room. A clear README is half the score.
- Work is split into time **gates** in [TASKS.md](TASKS.md). If a gate slips more than an hour, we cut features from the cut list. We never cut the demo flow above.
- **Feature freeze Mon 08:00.** After that, only fixes and polish.
- Commit small and often. Judges check that the work happened during the hackathon.
- Stuck for more than 30 minutes? Say it in the team chat. Mentors from Stellar are on site.

## Who does what
- **Den · Contracts (Rust/Soroban):** the loan contract flows and their tests.
- **Misha · Integration:** test tokens, price oracle, margin-call logic, keeper, deploy and demo scripts.
- **Bohdan Che · Design + frontend:** design system and the web app for lender, borrower, liquidator, plus a demo price slider.
- **Bohdan Koldun · Pitch, docs + QA:** story, README, deck, video, submission, mentor feedback, UI testing.

Task lists and handoff times per person: [DEVS.md](DEVS.md).
