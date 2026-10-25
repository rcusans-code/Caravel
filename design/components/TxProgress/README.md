# TxProgress
A short stepper for an on-chain action whose steps are known: Sign → Submit → Settled.

**Provide:** `<ol class="cv-txprog" style="--steps:3">` with one `<li class="cv-txprog__step">` per step holding `__label` and `__meta`. Mark finished steps `is-done`, the current one `is-active` plus `aria-current="step"`, a failed one `is-failed`.

Done steps fill in `primary`; the active step's rule carries the tide sweep; a failed step turns `defaulted` and the motion stops. Keep labels to one word and put timing or place in `__meta` ("in wallet", "≈5 s"). When the last step completes, show the result (a SealStamp or a pill) and remove the stepper. Reduced motion: the active rule shows half-filled, still.
