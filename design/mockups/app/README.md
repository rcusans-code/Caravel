# App mockups (Design canvas source)

Source files of the **Caravel App** design canvas, where the app screens are reviewed with comments:
https://claude.ai/artifact/Ffm9CtbdGP9UqQea1y6DEc (private; ask Bohdan Che for access).

| File | Screen |
|---|---|
| `Main.dc.html` | Offers board (borrower), "About this demo" popover open |
| `Take.dc.html` / `Signing.dc.html` / `Settled.dc.html` | Take an offer: panel, signing steps, DvP receipt |
| `Lend.dc.html` | Post an offer (compact 2×2 form) |
| `Positions.dc.html` / `PositionsPhone.dc.html` | My positions, including a margin call; phone at 390 px |
| `Liquidator.dc.html` | Liquidator desk |
| `Admin.dc.html` | Demo NAV slider |

Each artboard links `ds/caravel/tokens.css` and `components/bundle.*` (same files as `design/`) and inlines the app layout CSS. The logo points to a canvas blob, so open the files in the canvas, not straight from disk.

The agreed changes are already in `app/src/App.tsx` and `app/src/app.css`:

- Header: "Stellar testnet" left, logo centred, an "i" button (About this demo) and the account right.
- One status bar replaces the demo, balances and NAV cards: Demo as · XLM / USDC / tBENJI · tBENJI NAV with the live state.
- Demo-time notice moved from a banner into the "i" popover.
- Explainers are one plain sentence; the technical detail sits behind a small "i" tooltip (`Tip` in `App.tsx`).
- Take panel full width, two columns and compact; the Lend form is 2×2 with the summary and button on one row.

Screenshots of the built app (mock chain): `docs/media/app-*.png`.
