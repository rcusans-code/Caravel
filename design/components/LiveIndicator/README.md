# LiveIndicator
Shows whether a data feed (fund NAV, the network, the order book) is live, delayed or off.

**Provide:** `<span class="cv-live cv-live--{on|stale|off}" role="status"><span class="cv-live__dot" aria-hidden="true"></span><span class="cv-live__word">Live</span><span class="cv-live__meta">NAV 1.0004</span></span>`. Change state with `Caravel.live(el, "stale", "Delayed")`.

- **on** (`healthy`): a single thin wave line that flows continuously, one crest every 1.4s, fading at both ends. The only looping motion allowed for a feed: it means "this is updating right now".
- **stale** (`margin`): solid amber dot, no motion. Use when the last update is older than expected; put the age in `__meta` ("4 min ago").
- **off** (`ink-subtle`): hollow dot, no motion. Feed is down or paused.

Always show the word; the dot and pulse never carry the state alone. One live indicator per region. With reduced motion the wave stays still.
