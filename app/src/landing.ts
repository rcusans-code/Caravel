// Live deals on the landing page (site/index.html, served at /). Bundled by
// scripts/build-pages.mjs into dist-pages/assets/live-deals-*.js and loaded
// with `defer`, so site/index.html (a design-canvas export) is never edited.
//
// On load it reads the testnet book over RPC (book.ts, the same reader the app
// uses) and replaces the hardcoded ticker rows and the hero "Sample loan" card
// with real ones. On an RPC error, a 5 s timeout or an empty book it leaves the
// static samples in place, labelled "Sample".
import { Buffer } from "buffer";
import { Address, xdr } from "@stellar/stellar-sdk";
import { big, getBook, simulateView } from "./book";
import type { BorrowRequest, Offer, Repo, Status } from "./book";
import { ORACLE_ID, REPO_ID, TBENJI_SAC, assetBySac } from "./config";
import { BPS, collateralDecimals, collateralValue, coverPct, effectiveTriggerBps, fmtAmount, fmtCountdown, fmtNav, fmtPct } from "./format";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer = g.Buffer ?? Buffer;

const APP_URL = "/app/";
const TIMEOUT_MS = 5_000;
const REFRESH_MS = 30_000;
const TICKER_MAX = 8;
/** Below this many open offers and live agreements the ticker keeps its labelled sample rows. */
const TICKER_MIN_LIVE = 3;
/** Rows per ticker half, so a short book still fills a wide screen before the loop repeats. */
const TICKER_MIN_ROWS = 6;

/** One id format everywhere (app and landing): #003. */
const pad = (id: bigint) => String(id).padStart(3, "0");

interface Nav {
  price: bigint;
  decimals: number;
}

interface Live {
  offers: Offer[];
  /** Open borrow requests, labelled "Request" on the ticker. */
  requests: BorrowRequest[];
  repos: Repo[];
  daySecs: bigint;
  /** Margin trigger of the hero repo's asset (DECISIONS.md #26). */
  triggerBps: bigint;
  hero: Repo | null;
  /** NAV of the hero repo's collateral. */
  nav: Nav | null;
  /** tBENJI NAV, for the header's "Fund NAV". */
  benjiNav: Nav | null;
}

// --- chain reads -----------------------------------------------------------------

async function readNav(sac: string): Promise<Nav | null> {
  const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(sac).toScVal()]);
  const [last, dec] = await Promise.all([
    simulateView<{ price: bigint } | null | undefined>(ORACLE_ID, "lastprice", asset),
    simulateView<number>(ORACLE_ID, "decimals"),
  ]);
  return last ? { price: big(last.price), decimals: Number(dec) } : null;
}

const isLive = (s: Status) => s === "Open" || s === "MarginCall";

async function load(): Promise<Live> {
  const [book, cfg, benjiNav] = await Promise.all([
    getBook(),
    simulateView<Record<string, unknown>>(REPO_ID, "config"),
    readNav(TBENJI_SAC),
  ]);
  // Newest live repo; repos come sorted by id, newest first.
  const hero = book.repos.find((r) => isLive(r.status)) ?? null;
  const nav = !hero ? null : hero.collateral_asset === TBENJI_SAC ? benjiNav : await readNav(hero.collateral_asset);
  // A contract deployed before #26 has no per-asset trigger: it calls on the liquidation discount.
  const heroAsset = hero
    ? await simulateView<{ margin_trigger_bps?: unknown }>(REPO_ID, "asset", new Address(hero.collateral_asset).toScVal()).catch(() => null)
    : null;
  const triggerBps = big(heroAsset?.margin_trigger_bps ?? cfg.liquidation_discount_bps);
  return { ...book, daySecs: big(cfg.day_secs), triggerBps, hero, nav, benjiNav };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer from RPC in ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

// --- derived figures (same math as the app, App.tsx PositionCard) ---------------------

/** APR of a repo, from its interest (math.rs interest() rounds up; the nearest bps recovers the offer's rate). */
function repoAprBps(r: Repo, daySecs: bigint): bigint {
  const term = r.maturity_ts - r.start_ts;
  if (r.principal <= 0n || term <= 0n) return 0n;
  const den = r.principal * term;
  return (r.interest * BPS * 365n * daySecs + den / 2n) / den;
}

/** Cover vs the repo's margin-call line (DECISIONS.md #14, #26; clamped as in margin.rs), in %. */
function repoCoverPct(r: Repo, nav: Nav, triggerBps: bigint): number | null {
  const value = collateralValue(r.collateral_amount, nav.price, collateralDecimals(nav.decimals, assetBySac(r.collateral_asset).decimals));
  return coverPct(value, r.principal + r.interest, effectiveTriggerBps(triggerBps, r.haircut_bps));
}

/** Term in demo days (1 day = day_secs seconds; 60 s on testnet, DECISIONS.md #5). */
function termDays(termSecs: bigint, daySecs: bigint): string {
  const d = Number(termSecs) / Number(daySecs);
  return Number.isInteger(d) ? String(d) : d.toFixed(2);
}

// --- ticker ------------------------------------------------------------------------

const STATUS: Record<Status | "Offer" | "Request", [string, string]> = {
  Offer: ["Available", "#efe7da"],
  Request: ["Request", "#efe7da"],
  Open: ["Open", "#8db57f"],
  MarginCall: ["Margin call", "#e4c766"],
  Repaid: ["Repaid", "#a6bec4"],
  Defaulted: ["Defaulted", "#e3907d"],
  Liquidated: ["Liquidated", "#e3907d"],
};

interface Row {
  label: string;
  amount: string;
  apr: string;
  term: string;
  status: Status | "Offer" | "Request";
  ts: bigint;
  id: bigint;
}

function tickerRows(live: Live): Row[] {
  const { daySecs } = live;
  const offers: Row[] = live.offers.map((o) => ({
    label: `Offer #${pad(o.id)}`,
    amount: `${fmtAmount(o.principal)} USDC`,
    apr: fmtPct(o.apr_bps),
    term: `${termDays(o.term_secs, daySecs)}d · ${assetBySac(o.collateral_asset).code}`,
    status: "Offer",
    ts: o.created_at,
    id: o.id,
  }));
  // Borrowers' open requests: a lender can fund them from the app.
  const requests: Row[] = live.requests.map((q) => ({
    label: `Request #${pad(q.id)}`,
    amount: `${fmtAmount(q.principal)} USDC`,
    apr: fmtPct(q.apr_bps),
    term: `${termDays(q.term_secs, daySecs)}d · ${assetBySac(q.collateral_asset).code}`,
    status: "Request",
    ts: q.created_at,
    id: q.id,
  }));
  // Only what can still be taken or is running: closed agreements (Repaid, Liquidated, Defaulted) stay off the ticker.
  const repos: Row[] = live.repos.filter((r) => isLive(r.status)).map((r) => ({
    label: `Agreement #${pad(r.id)}`,
    amount: `${fmtAmount(r.principal)} USDC`,
    apr: fmtPct(repoAprBps(r, daySecs)),
    term: `${termDays(r.maturity_ts - r.start_ts, daySecs)}d · ${assetBySac(r.collateral_asset).code}`,
    status: r.status,
    ts: r.start_ts,
    id: r.id,
  }));
  return [...offers, ...requests, ...repos].sort((a, b) => (a.ts === b.ts ? Number(b.id - a.id) : a.ts < b.ts ? 1 : -1)).slice(0, TICKER_MAX);
}

/** The ticker's static rows: one half, then a `display: contents` copy (aria-hidden) for the CSS loop. */
function tickerParts() {
  const run = document.querySelector<HTMLElement>(".ticker-run");
  if (!run) return null;
  const rows = Array.from(run.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.style.display !== "contents");
  const template = rows.find((el) => el.querySelectorAll("span").length >= 5);
  return template ? { run, template } : null;
}

/** First cell of each ticker half: "Live on testnet" or "Sample deals". */
function tagCell(template: HTMLElement, text: string, color: string): HTMLElement {
  const cell = template.cloneNode(false) as HTMLElement;
  const statusSpan = template.querySelectorAll("span")[4];
  const tag = (statusSpan?.cloneNode(false) as HTMLElement) ?? document.createElement("span");
  tag.style.color = color;
  tag.textContent = text;
  cell.appendChild(tag);
  cell.dataset.liveTag = "";
  return cell;
}

function rowCell(template: HTMLElement, row: Row): HTMLElement {
  const cell = template.cloneNode(true) as HTMLElement;
  const s = cell.querySelectorAll("span");
  const [word, color] = STATUS[row.status];
  s[0].textContent = row.label;
  s[1].textContent = row.amount;
  s[2].textContent = row.apr;
  s[3].textContent = row.term;
  s[4].textContent = word;
  s[4].style.color = color;
  return cell;
}

function renderTicker(rows: Row[]) {
  const parts = tickerParts();
  if (!parts) return;
  const { run, template } = parts;
  sampleTicker ??= run.innerHTML;
  const tag = tagCell(template, "● Live on testnet", "#8db57f");
  tag.dataset.liveRow = "";
  const cells = rows.map((r) => rowCell(template, r));
  // A short book repeats as a whole set (never single rows) so one half still fills a wide screen;
  // repeats are hidden from screen readers.
  const half: HTMLElement[] = [tag, ...cells];
  while (half.length < TICKER_MIN_ROWS + 1) {
    for (const c of cells) {
      const r = c.cloneNode(true) as HTMLElement;
      r.setAttribute("aria-hidden", "true");
      half.push(r);
    }
  }
  const copy = document.createElement("div");
  copy.style.display = "contents";
  copy.setAttribute("aria-hidden", "true");
  for (const c of half) copy.appendChild(c.cloneNode(true));
  run.replaceChildren(...half, copy);
  run.closest("section")?.setAttribute("aria-label", "Latest offers, borrow requests and loans on the Stellar testnet");
}

/** The page's static sample rows, kept so a book that thins out below TICKER_MIN_LIVE can go back to them. */
let sampleTicker: string | null = null;

function labelTickerSample() {
  const shown = document.querySelector<HTMLElement>(".ticker-run");
  if (shown && sampleTicker !== null && shown.querySelector("[data-live-row]")) shown.innerHTML = sampleTicker;
  const parts = tickerParts();
  if (!parts || parts.run.querySelector("[data-live-tag]")) return;
  const { run, template } = parts;
  const copy = Array.from(run.children).find((el) => el instanceof HTMLElement && el.style.display === "contents");
  run.insertBefore(tagCell(template, "Sample deals", "#b4a797"), run.firstChild);
  copy?.insertBefore(tagCell(template, "Sample deals", "#b4a797"), copy.firstChild);
}

// --- hero card -----------------------------------------------------------------------

let heroTimer: number | undefined;
let heroShown = false;

function renderHero(live: Live) {
  const card = document.querySelector<HTMLElement>(".hero-card");
  const r = live.hero;
  if (!card || !r) return;
  const token = assetBySac(r.collateral_asset);
  const q = <T extends Element = HTMLElement>(sel: string) => card.querySelector<T>(sel);

  // Take the live fields away from the page's sample animation (it updates [data-live] every second).
  const field = (name: string) => {
    const el = card.querySelector<HTMLElement>(`[data-live="${name}"], [data-chain="${name}"]`);
    if (el?.dataset.live) {
      el.removeAttribute("data-live");
      el.dataset.chain = name;
    }
    return el;
  };
  heroShown = true;
  card.querySelector(".cv-health")?.classList.toggle("cv-health--margin", r.status === "MarginCall");
  const coverEl = field("cover");
  const fillEl = field("fill");
  const navEl = field("nav");
  const countdownEl = field("countdown");

  const eyebrow = q(".cv-eyebrow");
  if (eyebrow) {
    const a = document.createElement("a");
    a.href = APP_URL;
    a.textContent = `Live agreement #${pad(r.id)}`;
    a.style.color = "inherit";
    a.title = "Open the testnet app";
    eyebrow.replaceChildren(a);
  }
  card.style.cursor = "pointer";
  card.onclick = (e) => {
    if (!(e.target as Element).closest("a")) location.href = APP_URL;
  };

  const pill = q(".cv-pill");
  if (pill) {
    pill.className = `cv-pill cv-pill--${r.status === "MarginCall" ? "margin" : "open"}`;
    pill.textContent = STATUS[r.status][0];
  }
  const fig = q(".cv-figure-xl");
  if (fig) fig.textContent = fmtAmount(r.principal);
  const apr = q(".cv-apr");
  if (apr) {
    apr.textContent = `${fmtPct(repoAprBps(r, live.daySecs))} fixed`;
    const note = apr.nextElementSibling as HTMLElement | null;
    if (note) {
      note.textContent = `${termDays(r.maturity_ts - r.start_ts, live.daySecs)}-day term · testnet`;
      note.title = `On testnet one loan day lasts ${live.daySecs} s, so loans mature in minutes.`;
    }
  }

  const cover = live.nav ? repoCoverPct(r, live.nav, live.triggerBps) : null;
  if (coverEl) coverEl.textContent = cover === null ? "—" : cover.toFixed(1);
  if (fillEl) fillEl.style.width = `${cover === null ? 0 : Math.max(4, Math.min(96, 50 + (cover - 100) * 12)).toFixed(1)}%`;
  if (navEl) navEl.textContent = live.nav ? fmtNav(live.nav.price, live.nav.decimals) : "—";

  // Terms list: Collateral, Haircut, Matures in (matched by label, not position).
  for (const row of card.querySelectorAll(".cv-terms > div")) {
    const dt = row.querySelector("dt")?.textContent?.trim().toLowerCase();
    const dd = row.querySelector("dd");
    if (!dd) continue;
    if (dt === "collateral") dd.textContent = `${fmtAmount(r.collateral_amount, 2, token.decimals)} ${token.code}`;
    if (dt === "haircut") dd.textContent = fmtPct(r.haircut_bps, 1);
  }

  window.clearInterval(heroTimer);
  const tick = () => {
    if (!countdownEl) return;
    const left = Number(r.maturity_ts) - Math.floor(Date.now() / 1000);
    countdownEl.textContent = left > 0 ? fmtCountdown(left, Number(live.daySecs)) : "Matured";
  };
  tick();
  heroTimer = window.setInterval(tick, 1000);
}

function labelHeroSample() {
  if (heroShown) return; // a loan shown live stays until the next live one
  const eyebrow = document.querySelector<HTMLElement>(".hero-card .cv-eyebrow");
  if (eyebrow && !/sample/i.test(eyebrow.textContent ?? "")) eyebrow.textContent = `Sample ${eyebrow.textContent}`;
}

/** Header "Fund NAV": the live tBENJI price instead of the page's sample steps. */
function renderHeaderNav(nav: Nav | null) {
  if (!nav) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-live="nav"], [data-chain="nav"]')) {
    if (el.closest(".hero-card")) continue;
    el.removeAttribute("data-live");
    el.dataset.chain = "nav";
    el.textContent = fmtNav(nav.price, nav.decimals);
  }
}

// --- main ------------------------------------------------------------------------------

let shownTicker = "";
let liveShown = false;

const key = (rows: Row[]) => JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function render(live: Live) {
  const rows = tickerRows(live);
  if (rows.length < TICKER_MIN_LIVE) {
    // A thin book reads as broken when looped: show the labelled sample deals instead.
    labelTickerSample();
    shownTicker = "";
  } else if (key(rows) !== shownTicker) {
    renderTicker(rows);
    shownTicker = key(rows);
  }
  renderHeaderNav(live.benjiNav);
  if (live.hero) renderHero(live);
  else labelHeroSample();
  liveShown = true;
}

async function refresh() {
  try {
    render(await withTimeout(load(), TIMEOUT_MS));
  } catch (e) {
    if (liveShown) return; // keep the last live view on a failed refresh
    labelTickerSample();
    labelHeroSample();
    console.info(`Caravel: showing sample deals (${e instanceof Error ? e.message : String(e)})`);
  }
}

// Compact section menu (site/index.html .navmenu, ≤900px): close it once a section link is picked.
for (const a of document.querySelectorAll<HTMLAnchorElement>(".navmenu a"))
  a.addEventListener("click", () => a.closest("details")?.removeAttribute("open"));

void refresh();
window.setInterval(() => void refresh(), REFRESH_MS);
