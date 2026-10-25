// Assembles the one public site deployed to Cloudflare Pages (project caravel-repo):
//   /      the landing page (../site, copied as is)
//   /app/  the web app (app/dist, built with base "/app/")
// and points the landing's demo CTAs at /app/. site/index.html is re-exported from the
// design canvas, so the links are rewritten here at build time instead of hand-edited there.
// Run after `npm run build:public`; `npm run build:pages` runs both.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "..");
const siteDir = path.join(repoRoot, "site");
const appDist = path.join(appDir, "dist");
const out = path.join(repoRoot, "dist-pages");
const APP_PATH = "/app/";

if (!existsSync(path.join(appDist, "index.html"))) throw new Error("no app/dist; run npm run build:public first");
if (!readFileSync(path.join(appDist, "index.html"), "utf8").includes(`${APP_PATH}assets/`))
  throw new Error(`app/dist was not built with base "${APP_PATH}" (see vite.config.ts)`);

rmSync(out, { recursive: true, force: true });
cpSync(siteDir, out, { recursive: true, filter: (src) => path.basename(src) !== "README.md" });
cpSync(appDist, path.join(out, "app"), { recursive: true });

// Landing links that open the app. Matched by their text, so a re-export that moves them still works.
const CTAS = ["Try the demo", "Borrow against fund shares", "Lend at a fixed rate", "Or try the testnet demo", "Testnet demo"];
const indexFile = path.join(out, "index.html");
let html = readFileSync(indexFile, "utf8");
const hits = Object.fromEntries(CTAS.map((t) => [t, 0]));
html = html.replace(/<a href="#[^"]*"([^>]*)>([^<]+)<\/a>/g, (whole, attrs, text) => {
  const label = text.trim();
  if (!(label in hits)) return whole;
  hits[label] += 1;
  return `<a href="${APP_PATH}"${attrs}>${text}</a>`;
});
writeFileSync(indexFile, html);

const missing = CTAS.filter((t) => hits[t] === 0);
const total = Object.values(hits).reduce((a, b) => a + b, 0);
if (total === 0) throw new Error("build-pages: no landing CTA links to the app; check the labels in CTAS against site/index.html");
if (missing.length) console.warn(`build-pages: warning, CTA text not found in site/index.html: ${missing.join(", ")}`);
console.log(`build-pages: ${path.relative(repoRoot, out)}/ = site/ at /, app/dist at ${APP_PATH}; ${total} landing links -> ${APP_PATH}`);
