# StatusPill
A pill shows the lifecycle state of a repo or offer as a word with a dot.

**Provide:** `<span class="cv-pill cv-pill--{state}">Word</span>`. States map one-to-one to the contract: `open` → Open, `margin` → Margin call, `repaid` → Repaid, `defaulted` → Defaulted or Liquidated. `featured` marks a highlighted offer (gold), never a state.

Always write the word; color alone never carries the state. Text and ground come from the status token pairs (`healthy`/`healthy-soft` and so on), all above 4.5:1 in both themes.
