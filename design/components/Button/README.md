# Button
Buttons trigger one action, named verb first in sentence case.

**Provide:** a `<button type="button">` with class `cv-btn` plus one variant: `cv-btn--primary`, `cv-btn--secondary`, `cv-btn--quiet` or `cv-btn--danger`. Add `cv-btn--sm` inside tables. While a wallet signature or transaction is pending, set `aria-busy="true"` and change the label to "Signing…" or "Confirming…".

- **Primary** (`primary` fill, `on-primary` text): the one main action per view: Take offer, Post offer, Repay.
- **Secondary** (`surface`, `line-control` border): supporting actions: Top up, Cancel offer.
- **Quiet** (`primary` text, no border): navigation-like actions: View on explorer, Details.
- **Danger** (`defaulted` text and border): irreversible actions: Liquidate, Declare default.

Motion: every button sits on a second layer offset to the bottom right, sinks into it on press, and releases a water-drop ripple from the pointer (`bundle.js`). Keep the `cv-btn` class on the element itself so the ripple can attach.

Do: one primary per view; 1–3 words. Don't: put russet or gold on a button; disable a button without saying why next to it.
