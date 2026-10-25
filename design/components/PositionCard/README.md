# PositionCard
An open repo from the borrower's or lender's side: debt, collateral cover, and time left.

**Provide:** repo id and side, principal, status, collateral cover (collateral value × (1 − haircut) ÷ debt) with its NAV, the countdown (to maturity, or to the margin deadline during a margin call) and the next action.

The health meter runs 90–110% with a mark at 100% (the margin-call line). Fill is `gold` while healthy and `margin` during a margin call; the percentage is always printed, so the bar is never the only signal. In margin call, the countdown switches to "Top up within" and the action to Top up.
