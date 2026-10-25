# Skeleton
Grey blocks shaped like the content they replace, shown while figures load.

**Provide:** `<span class="cv-skel"></span>` blocks inside the real container, with `cv-skel--figure` (a big number), `--line` (full width) or `--short` (40%), or an inline width and height. Set `aria-busy="true"` and an `aria-label` on the container.

A slow sheen crosses each block every 1.8s. Keep the real layout (card, padding, rows) so nothing jumps when content arrives. Use only for the first load; for refreshes keep the old figures and flash the ones that change (ValueFlash). Reduced motion: flat blocks, no sheen.
