// Landing CTAs that open the app (used by build-pages.mjs, tested in test/landing-ctas.test.ts).
// site/index.html is a design-canvas export whose demo links are href="#launch"; they are
// matched by their text, so a re-export that moves them still works.
// "Lend at a fixed rate" opens the Lend tab (/app/#lend, issue #37); the rest open /app/ (Offers).

/** CTA text -> hash appended to the app path ("" = Offers, the app's default tab). */
export const CTAS = {
  "Try the demo": "",
  "Borrow against fund shares": "",
  "Lend at a fixed rate": "#lend",
  "Or try the testnet demo": "",
  "Testnet demo": "",
};

/** Rewrites the CTA links in html to point at appPath; returns the new html and hits per CTA text. */
export function rewriteCtas(html, appPath) {
  const hits = Object.fromEntries(Object.keys(CTAS).map((t) => [t, 0]));
  const out = html.replace(/<a href="#[^"]*"([^>]*)>([^<]+)<\/a>/g, (whole, attrs, text) => {
    const label = text.trim();
    if (!(label in hits)) return whole;
    hits[label] += 1;
    return `<a href="${appPath}${CTAS[label]}"${attrs}>${text}</a>`;
  });
  return { html: out, hits };
}
