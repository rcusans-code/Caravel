# Landing page

Static export of the landing page (V3) from the Caravel Landing design canvas in Claude. No build step of its own: open `index.html`, or let the app's build publish it.

Live at **https://caravel-repo.pages.dev/** (the `/` of Cloudflare Pages project `caravel-repo`). The web app is published by the same project at **https://caravel-repo.pages.dev/app/**. To build and deploy both:

```sh
cd app
npm ci
npm run build:pages     # → ../dist-pages: site/ at /, the app at /app/
npm run deploy:pages    # build:pages + wrangler pages deploy ../dist-pages --project-name caravel-repo
```

Or automatically: `.github/workflows/pages.yml` deploys on every push to `main` that touches `site/`, `app/`, `design/`, `packages/` or `deployments/`, once the repo has the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Without them it skips. (The `caravel-site` Pages subdomain belongs to someone else; never link it.)

- `assets/`: the engravings, logo and icons used on the page (file names are the canvas asset ids).
- `ds/`: a copy of `design/tokens.css` and `design/components/bundle.{css,js}`. After a design system change, copy those three files here again.
- The live example card (NAV, coverage, countdown) is a few lines of plain JS at the end of `index.html`; it shows example numbers, not testnet data.
- Keep asset and stylesheet paths relative (`assets/…`, `ds/…`): the page is served from `/`, next to the app's `/app/`.

**Links to the app.** In `index.html` the demo buttons point to `#launch`. The deploy build (`app/scripts/build-pages.mjs`) rewrites the ones labelled *Try the demo*, *Borrow against fund shares*, *Lend at a fixed rate*, *Or try the testnet demo* and *Testnet demo* to `/app/` in the published copy, so nothing needs hand-editing here. If a re-export renames those buttons, update the `CTAS` list in that script (the build fails if none match and warns for each missing one).

When re-exporting, keep the `<style id="pin-light">` block in `<head>`: it holds the page in its light theme when a viewer is in dark mode.

The canvas is the source of truth. Edit there, then re-export, rather than hand-editing `index.html`.
