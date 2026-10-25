// Caravel tokens for Tailwind, generated from design/tokens.json.
// 1. Import design/tokens.css once, globally (it defines the CSS variables, light and dark).
// 2. In tailwind.config.js:  theme: { extend: require('./design/tailwind.tokens.js') }
// Colors point at CSS variables, so dark mode follows [data-theme="dark"] automatically.
module.exports = {
  colors: {
    bg: "var(--bg)",
    surface: { DEFAULT: "var(--surface)", sunken: "var(--surface-sunken)" },
    line: { DEFAULT: "var(--line)", strong: "var(--line-strong)", control: "var(--line-control)" },
    ink: { DEFAULT: "var(--ink)", muted: "var(--ink-muted)", subtle: "var(--ink-subtle)" },
    primary: { DEFAULT: "var(--primary)", hover: "var(--primary-hover)", soft: "var(--primary-soft)", on: "var(--on-primary)" },
    brand: { DEFAULT: "var(--brand)", soft: "var(--brand-soft)" },
    gold: { DEFAULT: "var(--gold)", soft: "var(--gold-soft)", ink: "var(--gold-ink)" },
    healthy: { DEFAULT: "var(--healthy)", soft: "var(--healthy-soft)" },
    margin: { DEFAULT: "var(--margin)", soft: "var(--margin-soft)" },
    defaulted: { DEFAULT: "var(--defaulted)", soft: "var(--defaulted-soft)" },
    repaid: { DEFAULT: "var(--repaid)", soft: "var(--repaid-soft)" },
    wada: { russet: "var(--wada-russet)", ecru: "var(--wada-ecru)", ocher: "var(--wada-ocher)", medici: "var(--wada-medici)" },
  },
  fontFamily: {
    display: ["EB Garamond", "Garamond", "Georgia", "Times New Roman", "serif"],
    sans: ["Source Sans 3", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
    mono: ["Source Code Pro", "ui-monospace", "Menlo", "Consolas", "monospace"],
  },
  borderRadius: { none: "0px", DEFAULT: "0px" }, // every corner is square
  spacing: { "1": "var(--space-1)", "2": "var(--space-2)", "3": "var(--space-3)", "4": "var(--space-4)", "6": "var(--space-6)", "8": "var(--space-8)", "12": "var(--space-12)" },
  boxShadow: {
    card: "var(--shadow-card)",
    // The double layer: a second sheet offset bottom-right. Use with a 1px border in the same color.
    layer: "var(--frame-offset) var(--frame-offset) 0 calc(var(--frame-rule) * -1) var(--surface), var(--frame-offset) var(--frame-offset) 0 0 var(--line-strong)",
  },
};
