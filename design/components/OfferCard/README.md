# OfferCard
A lender's standing offer on the offers board: amount, fixed rate and terms, with one action.

**Provide:** offer id, amount and unit, APR, term, haircut, accepted collateral, status, and the action. Structure: `.cv-card` → `.cv-card__head` (eyebrow + pill), `.cv-figure-xl` amount, `.cv-apr` rate, `dl.cv-terms` with exactly three terms, then one button.

The APR is the card's one `brand` figure. Use `cv-card--featured` (gold border, Featured pill) for at most one offer per board. When several cards sit in a row, only the first or the selected one gets the primary button; the rest use secondary.
