# Field
A labelled numeric input with a unit suffix, a hint and an error state.

**Provide:** a `label.cv-field` wrapping `.cv-field__label`, `.cv-field__control` (the `input` plus a `.cv-field__suffix` unit), and `.cv-field__hint` linked with `aria-describedby`. Add `cv-field--error` and `aria-invalid="true"` when invalid; the hint then states the exact requirement and how to fix it.

Amounts are typed in mono with tabular figures. Every field shows its unit (USDC, tBENJI, %, days). Border is `line-control` (3:1); focus shows the `primary` ring.
