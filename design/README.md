# Caravel design system

Source of truth: the Caravel design system artifact in Claude (tokens, components, logos, guidelines). This folder is a copy for the app. If you change something here, tell Bohdan so the artifact stays in sync.

## Use it in the app

1. Load the fonts once (in `index.html` or the root layout):
   ```html
   <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,500;0,600;1,500&family=Source+Sans+3:wght@400;500;600&family=Source+Code+Pro:wght@400;500&display=swap">
   ```
2. Import `design/tokens.css` globally. It defines every color, font, spacing and frame variable for light and dark (`[data-theme="dark"]`).
3. Pick one way to style:
   - **Tailwind:** `theme: { extend: require('./design/tailwind.tokens.js') }`, then use `bg-surface`, `text-ink-muted`, `border-line-strong`, `shadow-layer`, `font-mono`.
   - **Plain CSS:** import `design/components/bundle.css` and use the `cv-*` classes (`cv-btn`, `cv-card`, `cv-pill`, `cv-table`, `cv-dvp` ...). Each component folder has a `README.md` and a `preview.html` with the exact markup.
4. Load `design/components/bundle.js` after the CSS. It adds the water-drop ripple to every `.cv-btn` and exposes `Caravel.live(el, state, word)`, `Caravel.flash(el, dir)` and `Caravel.stamp(el)` for the status components. Everything respects reduced motion.

## Components

| Group | Components |
|---|---|
| Status | Alert, StatusPill |
| Actions | Button |
| Settlement | DvpReceipt, TxHash |
| Inputs | Field |
| Motion | LiveIndicator, SealStamp, Skeleton, TxProgress, ValueFlash, Waiting |
| Lending | OfferCard, OffersTable, PositionCard |

Each has `components/<Name>/README.md` (when and how to use it) and `preview.html` (exact markup). `components/Cover/preview.html` shows every logo.

## Files

| Path | What it is |
|---|---|
| `tokens.json` | All tokens with usage notes (source for everything else) |
| `tokens.css` | CSS variables, light and dark, plus type classes |
| `tailwind.tokens.js` | Tailwind theme extension that points at the CSS variables |
| `components/bundle.css`, `bundle.js` | `cv-*` component classes and the button ripple |
| `components/<Name>/` | Usage notes and reference markup per component |
| `logos/` | Mark, square mark, reversed, mono and lockups, with rules in `logos/README.md` |

## Five rules to remember

1. Every corner is square. No `rounded-*`.
2. Cards, buttons and tables get the double layer (bottom and right only): `shadow-layer` or `cv-layer`.
3. Numbers people compare are Source Code Pro with tabular figures.
4. No italics in names or large type. Italic only for small accents like *Per aspera ad Stellar*.
5. Motion follows the reader and never loops, except status motion that mirrors a live state (LiveIndicator, Waiting, TxProgress, Skeleton) and stops when the state resolves.

---

Caravel is on-chain term repo for tokenized Treasuries on Stellar: fixed-term, fixed-rate USDC loans against tokenized money-market funds. The interface should feel like a well-run settlement desk: calm, exact, warm paper and ink, with color reserved for money and state.

The palette is Sanzo Wada's *A Dictionary of Color Combinations*, No. 249: **Hay's Russet**, **Ecru**, **Olive Ocher**, **Dark Medici Blue**. The four source colors are kept as `wada-*` tokens. Everything you build uses the role tokens derived from them.

## Content fundamentals

- Write like a desk note from a careful trader: short, specific, no hype. "Repay 971.00 USDC to close Repo #014" beats "Easily settle your loan!".
- Address the user as **you**; the product never says "I". Confirmations are past tense with no adjective: "Repaid", "Offer posted", never "Successfully repaid!".
- Sentence case everywhere: buttons, headings, tabs. Proper nouns keep their case: Stellar, USDC, tBENJI, SEP-40.
- Buttons are verb first, 1–3 words: "Take offer", "Top up", "Repay", "Liquidate".
- Name the money every time. Amounts always carry their unit and two decimals: `970.00 USDC`. Rates: `5.20% APR`. Haircut: `3.0%`. NAV: four decimals, `1.0004`. Terms: `7 days` (demo mode: `7 min` with a "Demo time" caption).
- Status is always a word, never color alone: Open, Margin call, Repaid, Defaulted, Liquidated.
- Errors say what happened and what to do: "NAV is older than 3 minutes. Wait for the next update, then try again." No "Error:" prefix.
- Explain DeFi terms the first time they appear on a screen with a one-line hint under the label (Haircut: "Safety margin. 3% means you borrow up to 97% of collateral value.").
- No emoji in the product.

## Visual foundations

### Color
- Page ground is `bg` (warm paper). Cards and inputs sit on `surface`. Table headers and hash chips use `surface-sunken`.
- Text is `ink`; secondary text and units are `ink-muted`; captions and placeholders `ink-subtle`.
- `primary` (Medici blue) is the only action color. **One primary button per view.** Links are `primary`, underlined on hover.
- `brand` (russet) is for identity and the one key figure per screen: the APR on an offer, the wordmark. Never for buttons or body text.
- `gold` (ocher) marks value: yield bars, the health-meter fill, the featured-offer marker. Gold is never text on a light ground; use `gold-ink` for gold-meaning text.
- Earth tones go in type, rules and small accents. Never fill a large area with russet, ecru or gold: big brown areas read muddy on screen and in video.
- Rules: `line` for card borders and row dividers, `line-strong` (ecru) under table headers and section titles, `line-control` for anything you can click or type into.

### Repo status
| Status | Text | Ground |
|---|---|---|
| Open | `healthy` | `healthy-soft` |
| Margin call | `margin` | `margin-soft` |
| Repaid | `repaid` | `repaid-soft` |
| Defaulted, Liquidated | `defaulted` | `defaulted-soft` |

Every pair holds 4.5:1 or better in both themes. Defaulted and Margin call also differ in lightness, so they never rely on hue alone.

### Type
- `display-xl`, `display` and `title` are set in **EB Garamond** 500: page titles, card titles, deck slides. It is the type of the caravel's own century; keep it for names and titles, one serif heading per region, never in tables, buttons or numbers.
- Everything else is **Source Sans 3**: `heading` for sections, `body` for copy, `label` for field labels, table headers and button text, `small` for hints, `caption` (uppercase, tracked) for eyebrows and status chips.
- Every number that a person compares is **Source Code Pro** with tabular figures: `figure-xl` for the hero amount on a card, `figure` for amounts, rates, NAV and countdowns, `code` for addresses and tx hashes.
- **No italics in names or large type.** Product and brand names, headlines, page titles and any text at `display`, `display-xl` or `title` size stay upright. Emphasis inside a headline uses `brand` color, never italic. Italic is only for small, occasional accents at 22px or below, such as the motto *Per aspera ad Stellar*, at most one per screen.
- Fonts load from Google Fonts. Fallbacks are in `--font-display`, `--font-sans`, `--font-mono`.

### Spacing and layout
- 4px base. `space-4` card padding, `space-6` between cards, `space-8` desktop page gutter, `space-4` on phones.
- Content max width 1120px. Dashboards use a 12-column grid; offer cards sit 3 across on desktop, 1 on phones.
- Align figures right in tables, labels left. Units sit after the number in `ink-muted`.

### Shape: square, double-layered
- **Every corner is square** (`radius` = 0): cards, buttons, fields, status chips, hash chips, health bars, modals. Nothing is rounded except the logo, which is drawn by hand.
- **Containers and buttons carry a double layer**: a second sheet sits `frame-offset` (4px) to the bottom and right, outlined in the same rule as the element, like a certificate stacked on another. Cards, tables and the DvP receipt use `line-strong` (ecru) on a `surface` sheet; a featured offer uses `gold` on `gold-soft`; alerts use their status color on their soft ground; buttons use their own border color.
- Apply it with the component classes, or `cv-layer` on any custom container. Never add it to fields, chips or table rows: at that size it reads as noise.
- Borders, not soft shadows. `shadow-card` only on floating layers (popovers, modals, the take-offer sheet), which keep square corners and the double layer.
- Focus ring: a 2px `primary` outline offset 2px (5:1 on bg, 7.6:1 in dark). Never remove it.

### Motion
- **Motion follows the reader, never loops, except to show live state.** Decoration never moves on a timer: no spinning, drifting, twinkling, marquees or pulsing. Movement is tied to scroll position or to a person's action, plays once per pass, and rests in its final state. Every element is fully readable with motion off. The exceptions are the status elements below, and on marketing pages one ambient element per hero (the water under the ship, the offers ticker).
- **Scroll-paced reveals:** backgrounds shift a few percent as their section scrolls by (parallax), progress lines fill as the reader reaches them, and steps settle in from 10px. Use CSS scroll-driven animations (`animation-timeline: view()`) inside `@supports`, so browsers without them show the final state.
- **Live data may change, decoration may not.** Figures that mirror real state (NAV, a maturity countdown) update in discrete steps, the way the oracle and clock do, never as a smooth wave.
- **Press:** a button sinks 4px into its second layer (`frame-offset`) while held, so the layer disappears under it.
- **Hover:** cards and tiles lift 2px up and left while their second layer grows to 6px, then settle back (220ms).
- **Water drop:** on press, a drop spreads from the exact tap or click point to the button's outer edges, followed 90ms later by a thinner ring, both in the button's text color, fading out over about 0.7s. `components/bundle.js` adds it to every `.cv-btn` automatically, including keyboard presses (from the center). Load `bundle.js` after `bundle.css`.
- Easing: `cubic-bezier(.2,.7,.3,1)` for anything a person triggers; linear for scroll-linked progress.

### Status motion
Motion that mirrors a real, ongoing state is allowed to loop, because it carries information: "this is updating" or "this is still working". Each element is small, sits next to a word that says the same thing, and stops the moment the state resolves. The components are in the **Motion** group.

| State | Component | Motion | Stops when |
|---|---|---|---|
| Feed is live | LiveIndicator `on` | a small wave flows continuously beside the word | the feed goes stale or off |
| Feed delayed / off | LiveIndicator `stale` / `off` | none (amber solid / hollow grey) | n/a |
| Working, unknown duration | Waiting: verb + ellipsis, tide bar, busy button | dots light in turn; a block sweeps a ruled track | the result arrives |
| Working, known steps | TxProgress | done steps fill; active step carries the tide | last step settles or one fails |
| First load | Skeleton | slow sheen across placeholder blocks | content arrives |
| A figure changed | ValueFlash | ground glows once (gold, or healthy / defaulted for direction) | after 1.2s, once |
| Action completed | SealStamp | seal presses in once, settles at a tilt | after 0.5s, once |

- Never show two loops in one region. A busy button and a tide bar for the same action is one too many: pick the one nearest the person's attention.
- Waiting labels are present-participle verbs ("Signing", "Submitting", "Waiting for NAV"), never "Loading…" alone. Results replace waiting states in place: the busy button becomes the seal or the pill.
- `components/bundle.js` exposes `Caravel.live(el, state, word)`, `Caravel.flash(el, dir)` and `Caravel.stamp(el)`.
- With `prefers-reduced-motion`, every status loop rests: the live wave stands still, dots stay lit, tide bars show a static wash, skeletons lose their sheen, flashes and stamps appear without animating, and there is no press travel, hover lift, ripple or scroll animation. The word always remains.


### Imagery
No stock photography, no illustrations of coins or ships. Data is the imagery: health meters, maturity timelines, the DvP transaction drawn as two legs in one box.

## Iconography
No icon set is defined in the sources yet. Until one is chosen, use **Tabler Icons (outline, 1.5px stroke)** at 16 or 20px in `ink-muted`, or `primary` inside links. Flagged: this is a substitute, not a brand decision.

## Logo
The mark is a complete russet C with a conquistador climbing it: cape streaming behind, front foot planted on the C's lower tip, a pole carried up past the C's top end so the flag flies out to the right. Three colors at most: `wada-russet` C, `ink` figure and pole, `wada-medici` flag. Files and rules are in the Logos group.
- Use `caravel-lockup.svg` in page headers and on deck title slides, `caravel-mark.svg` alone for favicons, app icons and avatars.
- On dark grounds use the `-reversed` files; on a `primary` or `brand` fill use `caravel-mark-mono-white.svg`.
- Minimum 24px tall for the mark (below that the figure fills in), 120px wide for the lockup. Clear space on every side equals the flag's height.
- In running text, write the name as **Caravel** set in EB Garamond 500 in `brand`; never redraw or recolor the mark.

## Themes
Light is primary. Dark mode is provided for every token; check new pairs in both. A component that paints its own colors must take them from tokens only.
