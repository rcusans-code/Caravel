# SealStamp
A round seal that presses onto the page once when a transaction completes: "Settled", "Repaid".

**Provide:** `<span class="cv-stamp" role="status"><span><b>Settled</b>Repo 014</span></span>`; `cv-stamp--repaid` for repayment (Medici blue). Replay with `Caravel.stamp(el)` if the same seal is reused.

It drops in at 1.6× and settles at a slight tilt in 0.5s, then stays still. One per confirmation, placed beside the result it confirms (a DvP receipt, a closed position), never as decoration. Only for completed, irreversible events; failures use an Alert. Reduced motion: it appears in place without the press.
