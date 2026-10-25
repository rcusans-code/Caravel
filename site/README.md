# Landing page

Static export of the landing page (V3) from the Caravel Landing design canvas in Claude. No build step: open `index.html`, or deploy the folder as is.

```sh
npx -y wrangler@4 pages deploy site --project-name caravel-site --branch main
```

Or automatically: `.github/workflows/site.yml` deploys on every push to `main` that touches `site/`, once the repo has the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Without them it skips.

- `assets/`: the engravings, logo and icons used on the page (file names are the canvas asset ids).
- `ds/`: a copy of `design/tokens.css` and `design/components/bundle.{css,js}`. After a design system change, copy those three files here again.
- The live example card (NAV, coverage, countdown) is a few lines of plain JS at the end of `index.html`; it shows example numbers, not testnet data.

When re-exporting, keep the `<style id="pin-light">` block in `<head>`: it holds the page in its light theme when a viewer is in dark mode.

The canvas is the source of truth. Edit there, then re-export, rather than hand-editing `index.html`.

