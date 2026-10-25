# Waiting
Shows that something is in progress when you can't yet say how long it will take.

**Provide:**
- Ellipsis on a verb: `<span class="cv-wait">Signing<span class="cv-wait__dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`. Always a present-participle verb ("Signing", "Submitting", "Waiting for NAV"), never "Loading" alone.
- Tide bar: `<div class="cv-tide" role="progressbar" aria-label="Submitting"></div>`, a short block that sweeps along a ruled track with a small russet pennant riding its leading edge, like a ship's flag. `cv-tide--gold` for loading data, default (`primary`) for a transaction you started.
- Busy button: add `aria-busy="true"` to any `.cv-btn`; it dims and carries the tide along its bottom edge. Change the label to the verb in progress ("Taking offer").

Stop the motion the moment the work resolves and replace it with the result (a status pill, a seal stamp, an error alert). If the wait has known steps, use TxProgress instead. Reduced motion: dots stay lit, the tide shows as a static wash with the pennant parked at the end.
