import { useCallback, useEffect, useMemo, useState } from "react";
import lockup from "../../design/logos/caravel-lockup.svg";
import {
  ACCOUNTS,
  COLLATERAL,
  DEMO_ENABLED,
  DEMO_ROLES,
  ORACLE_ID,
  REPO_ID,
  TBENJI_SAC,
  assetBySac,
  roleOf,
  type DemoRole,
} from "./config";
import * as chain from "./chain";
import type { AssetConfig, Balances, Nav, Offer, ProtocolConfig, Repo } from "./chain";
import { explain } from "./errors";
import {
  BPS,
  collateralValue,
  fmtAmount,
  fmtCountdown,
  fmtNav,
  fmtPct,
  fmtTerm,
  interest as calcInterest,
  parseAmount,
  protocolFee,
  requiredCollateral,
} from "./format";
import { Alert, DvpReceipt, Field, Live, Skel, StatusPill, TxHash, TxProgress, useFlash, type Leg, type Stamp, type TxState } from "./ui";
import { onPhase } from "./txphase";
import { connectWallet, demoSigner, disconnectWallet, type Signer } from "./wallet";

type Tab = "offers" | "lend" | "positions" | "admin";
type Flash = { tone: "info" | "error" | "margin"; title: string; body: string } | null;
type Receipt = { left: Leg; right: Leg; sentence: string; hash: string; stamp?: Stamp } | null;

const nowSecs = () => Math.floor(Date.now() / 1000);
const fmtAge = (s: number) => {
  const a = Math.max(0, s);
  if (a < 60) return `${a} s ago`;
  if (a < 3600) return `${Math.floor(a / 60)} min ${a % 60} s ago`;
  return `${Math.floor(a / 3600)} h ${Math.floor((a % 3600) / 60)} min ago`;
};

const ACCESS_LIMITED =
  "Access is limited to approved team wallets during the hackathon. Add the tBENJI trustline, then send your address to the team.";
const isAdminNow = (signer: Signer | null, config: ProtocolConfig | null) =>
  !!(signer && config && signer.address === config.admin);
const CONNECT = DEMO_ENABLED ? "Connect a wallet or pick a demo account" : "Connect a wallet";

export default function App() {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [config, setConfig] = useState<ProtocolConfig | null>(null);
  const [asset, setAsset] = useState<AssetConfig | null>(null);
  const [nav, setNav] = useState<Nav | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [liquidatorOk, setLiquidatorOk] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("offers");
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(nowSecs());
  const [tx, setTx] = useState<TxState | null>(null);

  // TxProgress: chain.ts reports sign / submit; prepare is set when a write starts.
  useEffect(() => {
    onPhase((p) => setTx((t) => (t ? { ...t, step: p === "sign" ? 1 : p === "submit" ? 2 : 0 } : t)));
    return () => onPhase(null);
  }, []);

  // --- data ---------------------------------------------------------------------
  const refreshMarket = useCallback(async () => {
    try {
      const [n, book] = await Promise.all([chain.getNav(), chain.getBook()]);
      setNav(n);
      setOffers(book.offers);
      setRepos(book.repos);
      setLoaded(true);
    } catch (e) {
      setFlash({ tone: "error", title: "Could not read testnet", body: explain(e) });
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    if (!signer) return;
    try {
      const [b, l] = await Promise.all([chain.getBalances(signer.address), chain.isLiquidator(signer.address)]);
      setBalances(b);
      setLiquidatorOk(l);
    } catch (e) {
      setFlash({ tone: "error", title: "Could not read balances", body: explain(e) });
    }
  }, [signer]);

  const refreshAll = useCallback(() => Promise.all([refreshMarket(), refreshAccount()]), [refreshMarket, refreshAccount]);

  useEffect(() => {
    Promise.all([chain.getConfig(), chain.getAssetConfig(TBENJI_SAC)])
      .then(([c, a]) => {
        setConfig(c);
        setAsset(a);
      })
      .catch((e) => setFlash({ tone: "error", title: "Could not read the repo contract", body: explain(e) }));
    refreshMarket();
    const t = setInterval(refreshMarket, 10_000);
    const c = setInterval(() => setNow(nowSecs()), 1_000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [refreshMarket]);

  useEffect(() => {
    setBalances(null);
    refreshAccount();
    const t = setInterval(refreshAccount, 10_000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // --- session ------------------------------------------------------------------
  const onConnect = async () => {
    setFlash(null);
    setBusy("connect");
    try {
      setSigner(await connectWallet());
    } catch (e) {
      const raw = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
      if (/closed|dismiss/i.test(raw)) setFlash({ tone: "info", title: "No wallet picked", body: "The wallet picker was closed. Nothing was connected." });
      else setFlash({ tone: "error", title: "Wallet not connected", body: explain(e) });
    } finally {
      setBusy(null);
    }
  };
  const onDemo = (role: DemoRole) => {
    setFlash(null);
    setSigner(demoSigner(role));
    setTab(role === "lender" ? "lend" : role === "admin" ? "admin" : role === "borrower" ? "offers" : "positions");
  };
  const onDisconnect = async () => {
    if (signer?.kind === "wallet") await disconnectWallet();
    setSigner(null);
    setBalances(null);
    setFlash(null);
  };

  // One runner for every write: busy label, error mapping, refresh after.
  const run = async <T,>(key: string, title: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setFlash(null);
    setTx({ key, step: 0, failed: false });
    try {
      const out = await fn();
      setTx(null); // the result (receipt, seal, pill) replaces the stepper
      return out;
    } catch (e) {
      console.error(e);
      setTx((t) => (t && t.key === key ? { ...t, failed: true } : t));
      setTimeout(() => setTx((t) => (t && t.key === key && t.failed ? null : t)), 6000);
      setFlash({ tone: "error", title, body: explain(e) });
      return null;
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  useEffect(() => {
    if (tab === "admin" && !isAdminNow(signer, config)) setTab("offers");
  }, [tab, signer, config]);

  const navAge = nav ? now - Number(nav.timestamp) : null;
  const navStale = !!(config && navAge !== null && navAge > Number(config.max_nav_age_secs));
  const isAdmin = isAdminNow(signer, config);
  // Access gate: writes need an issuer-AUTHORIZED tBENJI trustline. The on-chain
  // flag is the only allowlist (scripts/onboard.sh sets it). Demo burner keys
  // exist only in dev builds (VITE_DEMO_SIGNER=1) and are team accounts.
  const approved = !!signer && (signer.kind === "demo" || !!balances?.tbenjiAuthorized);
  const ctx: Ctx = {
    signer,
    approved,
    config,
    asset,
    nav,
    navStale,
    balances,
    busy,
    tx,
    now,
    run,
    setFlash,
    refreshAll,
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-wrap app-header__inner">
          <a href="/" className="app-brand" aria-label="Caravel home">
            <img src={lockup} alt="Caravel" height={44} />
          </a>
          <span className="caption app-net">Stellar testnet</span>
          <div className="app-header__account">
            {signer ? (
              <AccountChip signer={signer} onDisconnect={onDisconnect} />
            ) : (
              <button
                type="button"
                className="cv-btn cv-btn--primary"
                aria-busy={busy === "connect" ? "true" : undefined}
                onClick={onConnect}
              >
                {busy === "connect" ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="app-wrap app-main">
        {DEMO_ENABLED && (
          <section className="cv-card app-demo" aria-label="Demo account">
            <div className="cv-card__head">
              <span className="cv-eyebrow">Demo account (testnet burner)</span>
              <span className="small app-muted">Signs in this browser with the committed testnet keys. Testnet only.</span>
            </div>
            <div className="cv-row" role="group" aria-label="Demo role">
              {DEMO_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`cv-btn cv-btn--secondary cv-btn--sm${signer?.role === r ? " is-active" : ""}`}
                  aria-pressed={signer?.role === r}
                  onClick={() => onDemo(r)}
                  data-role={r}
                >
                  {r[0].toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
          </section>
        )}

        {signer && (
          <BalancesBar signer={signer} balances={balances} run={run} refresh={refreshAccount} />
        )}

        <NavStrip nav={nav} config={config} now={now} stale={navStale} loaded={loaded} />

        {config && (
          <Alert tone="info" title="Demo time is on">
            1 day runs as {String(config.day_secs)} seconds, so a 7-day repo matures in 7 minutes. NAV older than{" "}
            {Number(config.max_nav_age_secs) / 60} minutes blocks new takes.
          </Alert>
        )}

        {flash && (
          <Alert
            tone={flash.tone}
            title={flash.title}
            action={
              <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={() => setFlash(null)}>
                Dismiss
              </button>
            }
          >
            {flash.body}
          </Alert>
        )}

        <nav className="app-tabs" role="tablist" aria-label="Sections">
          {(
            [
              ["offers", "Offers"],
              ["lend", "Lend"],
              ["positions", "My positions"],
              ...(isAdmin ? [["admin", "Admin"]] : []),
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className="app-tab label"
              onClick={() => setTab(t)}
              data-tab={t}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "offers" && <OffersView ctx={ctx} offers={offers} loaded={loaded} />}
        {tab === "lend" && <LendView ctx={ctx} offers={offers} />}
        {tab === "positions" && <PositionsView ctx={ctx} repos={repos} liquidatorOk={liquidatorOk} loaded={loaded} />}
        {tab === "admin" && isAdmin && <AdminView ctx={ctx} isAdmin={isAdmin} />}
      </main>

      <footer className="app-wrap app-footer small">
        <span>
          Repo <TxHash kind="CONTRACT" value={REPO_ID} /> Oracle <TxHash kind="CONTRACT" value={ORACLE_ID} />
        </span>
        <span className="app-motto">Per aspera ad Stellar</span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------------

interface Ctx {
  signer: Signer | null;
  /** Connected and allowed to send writes (authorized tBENJI trustline). */
  approved: boolean;
  config: ProtocolConfig | null;
  asset: AssetConfig | null;
  nav: Nav | null;
  navStale: boolean;
  balances: Balances | null;
  busy: string | null;
  /** Live transaction steps for the action with this key (TxProgress). */
  tx: TxState | null;
  now: number;
  run: <T>(key: string, title: string, fn: () => Promise<T>) => Promise<T | null>;
  setFlash: (f: Flash) => void;
  refreshAll: () => Promise<unknown>;
}

function AccountChip({ signer, onDisconnect }: { signer: Signer; onDisconnect: () => void }) {
  const role = roleOf(signer.address);
  return (
    <div className="cv-row app-account">
      <span className="small app-muted">
        {signer.kind === "demo" ? `Demo ${signer.label}` : signer.label}
        {signer.kind === "wallet" && role ? ` · ${role}` : ""}
      </span>
      <TxHash kind="ACCOUNT" value={signer.address} />
      <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

function BalancesBar({
  signer,
  balances,
  run,
  refresh,
}: {
  signer: Signer;
  balances: Balances | null;
  run: Ctx["run"];
  refresh: () => Promise<void>;
}) {
  // Lenders only need USDC, so a missing tBENJI line alone is just shown in the
  // figure, except for browser wallets that may want to borrow.
  const missing = balances?.exists
    ? (["USDC", "tBENJI"] as const).filter((c) => (c === "USDC" ? balances.usdc : balances.tbenji) === null)
    : [];
  // Wallets without an issuer-authorized tBENJI line are read-only (access gate).
  const gated = signer.kind === "wallet" && !!balances?.exists && !balances.tbenjiAuthorized;
  const showTrust = !gated && (missing.includes("USDC") || (signer.kind === "wallet" && missing.length > 0));
  return (
    <section className="cv-card app-balances" aria-label="Balances">
      <div className="app-balances__grid">
        <Figure label="XLM" value={balances ? fmtAmount(balances.xlm) : null} />
        <Figure label="USDC" value={balances ? (balances.usdc === null ? "No trustline" : fmtAmount(balances.usdc)) : null} />
        <Figure
          label="tBENJI"
          value={balances ? (balances.tbenji === null ? "No trustline" : fmtAmount(balances.tbenji)) : null}
          hint={balances?.tbenji !== null && balances && !balances.tbenjiAuthorized ? "Not authorized by the issuer" : undefined}
        />
      </div>
      {balances && !balances.exists && (
        <Alert
          tone="margin"
          title="Account not on testnet"
          action={
            <button
              type="button"
              className="cv-btn cv-btn--secondary cv-btn--sm"
              onClick={() => run("fund", "Friendbot failed", () => chain.friendbot(signer.address)).then(refresh)}
            >
              Fund with friendbot
            </button>
          }
        >
          {`${signer.address.slice(0, 4)}… has no XLM yet. Fund it with 10,000 testnet XLM to pay fees.`}
        </Alert>
      )}
      {gated && balances && (
        <Alert
          tone="margin"
          title="Read-only: wallet not approved yet"
          action={
            missing.length > 0 ? (
              <button
                type="button"
                className="cv-btn cv-btn--secondary cv-btn--sm"
                data-action="add-trustline"
                onClick={() => run("trust", "Trustline not added", () => chain.addTrustlines(signer, [...missing]))}
              >
                {`Add ${missing.join(" + ")} trustline${missing.length > 1 ? "s" : ""}`}
              </button>
            ) : undefined
          }
        >
          {ACCESS_LIMITED}{" "}
          {balances.tbenji !== null
            ? `Your tBENJI trustline is in place; the issuer has not authorized ${signer.address.slice(0, 4)}…${signer.address.slice(-4)} yet.`
            : ""}
        </Alert>
      )}
      {showTrust && (
        <Alert
          tone="info"
          title={`No ${missing.join(" or ")} trustline`}
          action={
            <button
              type="button"
              className="cv-btn cv-btn--secondary cv-btn--sm"
              onClick={() => run("trust", "Trustline not added", () => chain.addTrustlines(signer, [...missing]))}
            >
              Add trustline
            </button>
          }
        >
          Lenders need USDC; borrowers need USDC and tBENJI. tBENJI is AUTH_REQUIRED, so the issuer also has to authorize
          the account before it can hold any.
        </Alert>
      )}
    </section>
  );
}

function Figure({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  // null = first load: show a skeleton; afterwards flash the figure when it changes.
  const ref = useFlash(value);
  return (
    <div className="app-figure" aria-busy={value === null ? "true" : undefined}>
      <span className="cv-eyebrow">{label}</span>
      {value === null ? (
        <Skel w={120} h={22} />
      ) : (
        <span className="figure app-flashable" data-balance={label} ref={ref}>
          {value}
        </span>
      )}
      {hint && <span className="cv-field__hint">{hint}</span>}
    </div>
  );
}

const navDir = (a: string, b: string) => (BigInt(b) > BigInt(a) ? "up" : BigInt(b) < BigInt(a) ? "down" : undefined);

function NavStrip({
  nav,
  config,
  now,
  stale,
  loaded,
}: {
  nav: Nav | null;
  config: ProtocolConfig | null;
  now: number;
  stale: boolean;
  loaded: boolean;
}) {
  const age = nav ? now - Number(nav.timestamp) : null;
  const navRef = useFlash(nav ? String(nav.price) : null, navDir);
  if (!loaded)
    return (
      <section className="cv-card app-nav" aria-label="tBENJI NAV" aria-busy="true">
        <div className="app-figure">
          <span className="cv-eyebrow">tBENJI NAV · SEP-40 mock feed</span>
          <Skel kind="figure" />
        </div>
        <div className="app-figure">
          <span className="cv-eyebrow">Feed timestamp</span>
          <Skel w={110} h={22} />
        </div>
        <div className="app-figure">
          <span className="cv-eyebrow">Feed state</span>
          <Skel w={90} h={20} />
        </div>
      </section>
    );
  return (
    <section className="cv-card app-nav" aria-label="tBENJI NAV">
      <div className="app-figure">
        <span className="cv-eyebrow">tBENJI NAV · SEP-40 mock feed</span>
        <span>
          <span className="cv-figure-xl app-flashable" data-testid="nav" ref={navRef}>
            {nav ? fmtNav(nav.price, nav.decimals) : "—"}
          </span>
          <span className="cv-unit">USD</span>
        </span>
      </div>
      <div className="app-figure">
        <span className="cv-eyebrow">Feed timestamp</span>
        <span className="figure">{nav ? new Date(Number(nav.timestamp) * 1000).toLocaleTimeString() : "No price yet"}</span>
        <span className="cv-field__hint">
          {age !== null ? fmtAge(age) : ""}
          {config ? ` · max age ${Number(config.max_nav_age_secs) / 60} min` : ""}
        </span>
      </div>
      <div className="app-figure">
        <span className="cv-eyebrow">Feed state</span>
        {nav ? (
          stale ? (
            <Live state="stale" word="Delayed" meta="takes paused" />
          ) : (
            <Live state="on" word="Live" meta="fresh NAV" />
          )
        ) : (
          <Live state="off" word="No price" meta="push one from Admin" />
        )}
      </div>
    </section>
  );
}

// --- Offers board + take ---------------------------------------------------------

function OffersView({ ctx, offers, loaded }: { ctx: Ctx; offers: Offer[]; loaded: boolean }) {
  const [selected, setSelected] = useState<bigint | null>(null);
  const [receipt, setReceipt] = useState<Receipt>(null);
  const { config, asset } = ctx;
  const offer = offers.find((o) => o.id === selected) ?? null;

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">Offers board</h1>
        <span className="small app-muted">Standing USDC offers, escrowed in the repo contract. Full takes only.</span>
      </div>

      {receipt && <DvpReceipt {...receipt} />}

      {offer && config && asset && (
        <TakePanel ctx={ctx} offer={offer} onClose={() => setSelected(null)} onDone={(r) => { setReceipt(r); setSelected(null); }} />
      )}

      <div className="cv-table-wrap">
        <table className="cv-table" data-testid="offers-table" aria-busy={loaded ? undefined : "true"}>
          <thead>
            <tr>
              <th>Offer</th>
              <th className="r">Amount</th>
              <th className="r">APR</th>
              <th className="r">Term</th>
              <th className="r">Haircut</th>
              <th>Collateral</th>
              <th>Lender</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!loaded &&
              [0, 1, 2].map((i) => (
                <tr key={`skel-${i}`} aria-hidden="true">
                  <td><Skel w={36} h={14} /></td>
                  <td className="r"><Skel w={80} h={14} /></td>
                  <td className="r"><Skel w={48} h={14} /></td>
                  <td className="r"><Skel w={40} h={14} /></td>
                  <td className="r"><Skel w={36} h={14} /></td>
                  <td><Skel w={52} h={14} /></td>
                  <td><Skel w={90} h={14} /></td>
                  <td><Skel w={52} h={18} /></td>
                  <td></td>
                </tr>
              ))}
            {loaded && offers.length === 0 && (
              <tr>
                <td colSpan={9} className="app-empty">
                  No open offers. Post one from Lend.
                </td>
              </tr>
            )}
            {offers.map((o) => (
              <tr key={String(o.id)} data-offer={String(o.id)}>
                <td className="cv-num">#{String(o.id).padStart(3, "0")}</td>
                <td className="r cv-num">{fmtAmount(o.principal)}</td>
                <td className="r cv-num" style={{ color: "var(--brand)" }}>
                  {fmtPct(o.apr_bps)}
                </td>
                <td className="r cv-num">{config ? fmtTerm(o.term_secs, config.day_secs) : "…"}</td>
                <td className="r cv-num">{asset ? fmtPct(asset.haircut_bps, 1) : "…"}</td>
                <td>{assetBySac(o.collateral_asset).code}</td>
                <td>
                  <TxHash kind="ACCOUNT" value={o.lender} />
                </td>
                <td>
                  <span className="cv-pill cv-pill--open">Open</span>
                </td>
                <td className="r">
                  <button
                    type="button"
                    className="cv-btn cv-btn--secondary cv-btn--sm"
                    onClick={() => {
                      setReceipt(null);
                      setSelected(o.id);
                    }}
                  >
                    Take
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TakePanel({ ctx, offer, onClose, onDone }: { ctx: Ctx; offer: Offer; onClose: () => void; onDone: (r: Receipt) => void }) {
  const { config, asset, nav, navStale, balances, signer, busy } = ctx;
  if (!config || !asset) return null;
  const int = calcInterest(offer.principal, offer.apr_bps, offer.term_secs, config.day_secs);
  const debt = offer.principal + int;
  const collateral = nav ? requiredCollateral(debt, nav.price, nav.decimals, asset.haircut_bps) : null;

  let block: string | null = null;
  if (!signer) block = `${CONNECT} to take this offer.`;
  else if (balances && balances.exists && !ctx.approved) block = ACCESS_LIMITED;
  else if (signer.address === offer.lender) block = "This is your own offer. Cancel it from Lend instead.";
  else if (!nav) block = "The oracle has no tBENJI price yet.";
  else if (navStale) block = "NAV is older than 3 minutes. Wait for the next update (or push one from Admin), then try again.";
  else if (balances && !balances.exists) block = "Your account is not on testnet yet. Fund it with friendbot.";
  else if (balances && balances.usdc === null) block = "Add a USDC trustline to receive the loan.";
  else if (balances && (balances.tbenji === null || !balances.tbenjiAuthorized))
    block = "Your account is not authorized to hold tBENJI. The issuer must authorize it first.";
  else if (balances && collateral !== null && (balances.tbenji ?? 0n) < collateral)
    block = `You need ${fmtAmount(collateral)} tBENJI and hold ${fmtAmount(balances.tbenji ?? 0n)} tBENJI.`;

  const take = async () => {
    if (!signer || collateral === null) return;
    const out = await ctx.run("take", `Offer #${offer.id} not taken`, () => chain.takeOffer(signer, offer.id));
    if (out)
      onDone({
        left: { eyebrow: "Borrower delivers", amount: fmtAmount(collateral), unit: "tBENJI", hint: "into escrow" },
        right: { eyebrow: "Borrower receives", amount: fmtAmount(offer.principal), unit: "USDC", hint: `from Offer #${offer.id}` },
        sentence: `Repo #${out.value} opened. Settled atomically in one transaction`,
        hash: out.hash,
        stamp: { word: "Settled", sub: `Repo ${String(out.value).padStart(3, "0")}` },
      });
  };

  return (
    <article className="cv-card app-take" style={{ boxShadow: "var(--shadow-card)" }} aria-label={`Take offer ${offer.id}`}>
      <div className="cv-card__head">
        <span className="cv-eyebrow">Take Offer #{String(offer.id).padStart(3, "0")}</span>
        <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div>
        <span className="cv-figure-xl">{fmtAmount(offer.principal)}</span>
        <span className="cv-unit">USDC</span>
      </div>
      <div className="cv-apr">
        {fmtPct(offer.apr_bps)} APR<span className="cv-unit">fixed</span>
      </div>
      <dl className="cv-terms">
        <div>
          <dt>Term</dt>
          <dd>{fmtTerm(offer.term_secs, config.day_secs)}</dd>
        </div>
        <div>
          <dt>Haircut</dt>
          <dd>{fmtPct(asset.haircut_bps, 1)}</dd>
        </div>
        <div>
          <dt>Repay</dt>
          <dd>{fmtAmount(debt)} USDC</dd>
        </div>
      </dl>
      <div className="app-preview">
        <span className="cv-field__label">Collateral you post</span>
        <span>
          <span className="figure" data-testid="collateral-preview">
            {collateral !== null ? fmtAmount(collateral) : "—"}
          </span>
          <span className="cv-unit">tBENJI</span>
        </span>
        <span className="cv-field__hint">
          {nav
            ? `Debt ${fmtAmount(debt)} USDC ÷ (NAV ${fmtNav(nav.price, nav.decimals)} × (1 − ${fmtPct(asset.haircut_bps, 1)})), rounded up. Haircut is a safety margin: ${fmtPct(asset.haircut_bps, 1)} means you borrow up to ${fmtPct(BPS - asset.haircut_bps, 1)} of collateral value. The contract computes the exact amount at the NAV when the tx lands.`
            : (
              <span className="cv-wait">
                Waiting for NAV
                <span className="cv-wait__dots" aria-hidden="true"><i></i><i></i><i></i></span>
              </span>
            )}
        </span>
      </div>
      {block && <p className="cv-field__hint app-block">{block}</p>}
      <button
        type="button"
        className="cv-btn cv-btn--primary"
        disabled={!!block || !!busy}
        onClick={take}
        data-action="take"
      >
        {busy === "take" ? "Taking offer" : "Take offer"}
      </button>
      {ctx.tx?.key === "take" && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
    </article>
  );
}

// --- Lend --------------------------------------------------------------------------

function LendView({ ctx, offers }: { ctx: Ctx; offers: Offer[] }) {
  const { config, asset, signer, balances, busy } = ctx;
  const [amount, setAmount] = useState("50.00");
  const [days, setDays] = useState("7");
  const [apr, setApr] = useState("5.20");
  const [collateral, setCollateral] = useState(COLLATERAL[0].sac);
  const [posted, setPosted] = useState<{ id: bigint; hash: string } | null>(null);
  const [cancelled, setCancelled] = useState<{ id: bigint; hash: string } | null>(null);

  const principal = parseAmount(amount);
  const dayCount = Number(days);
  const aprNum = Number(apr);
  const errAmount = principal === null || principal <= 0n ? "Enter an amount above 0.00 USDC." : null;
  const errDays = !Number.isFinite(dayCount) || dayCount <= 0 || !/^\d+(\.\d+)?$/.test(days) ? "Enter a term above 0 days." : null;
  const errApr =
    !Number.isFinite(aprNum) || aprNum < 0 || aprNum > 100 || !/^\d+(\.\d{1,2})?$/.test(apr)
      ? "Enter an APR between 0.00% and 100.00%, two decimals at most."
      : null;

  const termSecs = config && !errDays ? BigInt(Math.round(dayCount * Number(config.day_secs))) : 0n;
  const aprBps = errApr ? 0 : Math.round(aprNum * 100);
  const int = config && principal && !errDays && !errApr ? calcInterest(principal, BigInt(aprBps), termSecs, config.day_secs) : 0n;
  const fee = config ? protocolFee(int, config.fee_bps) : 0n;

  let block: string | null = null;
  if (!signer) block = `${CONNECT} to post an offer.`;
  else if (balances && balances.exists && !ctx.approved) block = ACCESS_LIMITED;
  else if (balances && !balances.exists) block = "Your account is not on testnet yet. Fund it with friendbot.";
  else if (balances && balances.usdc === null) block = "Add a USDC trustline first.";
  else if (balances && principal && balances.usdc !== null && balances.usdc < principal)
    block = `You hold ${fmtAmount(balances.usdc)} USDC, less than ${fmtAmount(principal)} USDC.`;
  else if (asset && !asset.enabled) block = "tBENJI is disabled as collateral right now.";

  const post = async () => {
    if (!signer || !principal || errAmount || errDays || errApr) return;
    setPosted(null);
    const out = await ctx.run("post", "Offer not posted", () =>
      chain.createOffer(signer, { collateral, principal, aprBps, termSecs }),
    );
    if (out) setPosted({ id: out.value, hash: out.hash });
  };
  const mine = signer ? offers.filter((o) => o.lender === signer.address) : [];

  return (
    <section className="app-section app-lend">
      <div className="app-section__head">
        <h1 className="title">Post an offer</h1>
        <span className="small app-muted">Your USDC is escrowed in the contract until a borrower takes the offer or you cancel it.</span>
      </div>
      <div className="app-lend__grid">
        <form
          className="cv-card cv-stack"
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
        >
          <Field id="amount" label="Amount to lend" value={amount} onChange={setAmount} suffix="USDC" error={errAmount}
            hint="Escrowed in the contract until a borrower takes the offer." />
          <Field id="term" label="Term" value={days} onChange={setDays} suffix="days" error={errDays}
            hint={config ? `Demo time: 1 day = ${String(config.day_secs)} s, so ${days || "0"} days = ${fmtCountdown(Math.round((Number(days) || 0) * Number(config.day_secs)), 60)}.` : ""} />
          <Field id="apr" label="Rate" value={apr} onChange={setApr} suffix="% APR" error={errApr}
            hint="Fixed for the whole term. The borrower pays full-term interest, even on early repay." />
          <label className="cv-field">
            <span className="cv-field__label">Collateral</span>
            <span className="cv-field__control">
              <select value={collateral} onChange={(e) => setCollateral(e.target.value)} aria-describedby="collat-hint" className="app-select">
                {COLLATERAL.map((a) => (
                  <option key={a.sac} value={a.sac}>
                    {a.code}
                  </option>
                ))}
              </select>
            </span>
            <span className="cv-field__hint" id="collat-hint">
              {asset ? `Haircut ${fmtPct(asset.haircut_bps, 1)}: a safety margin, so the borrower posts collateral worth debt ÷ ${fmtPct(BPS - asset.haircut_bps, 1)}. Set per asset by the protocol.` : ""}
            </span>
          </label>
          <dl className="cv-terms">
            <div>
              <dt>Interest</dt>
              <dd>{fmtAmount(int)} USDC</dd>
            </div>
            <div>
              <dt>Protocol fee</dt>
              <dd>{fmtAmount(fee)} USDC</dd>
            </div>
            <div>
              <dt>You receive</dt>
              <dd>{principal ? fmtAmount(principal + int - fee) : "—"} USDC</dd>
            </div>
          </dl>
          {block && <p className="cv-field__hint app-block">{block}</p>}
          <button
            type="submit"
            className="cv-btn cv-btn--primary"
            disabled={!!block || !!errAmount || !!errDays || !!errApr || !!busy}
            data-action="post"
          >
            {busy === "post" ? "Posting offer" : "Post offer"}
          </button>
          {ctx.tx?.key === "post" && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
          {posted && (
            <p className="cv-row small" data-testid="posted">
              Offer #{String(posted.id)} posted <TxHash kind="TX" value={posted.hash} />
            </p>
          )}
        </form>

        <div className="cv-stack">
          <h2 className="heading">Your open offers</h2>
          {cancelled && (
            <p className="cv-row small">
              Offer #{String(cancelled.id)} cancelled <TxHash kind="TX" value={cancelled.hash} />
            </p>
          )}
          <div className="cv-table-wrap">
            <table className="cv-table">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th className="r">Amount</th>
                  <th className="r">APR</th>
                  <th className="r">Term</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mine.length === 0 && (
                  <tr>
                    <td colSpan={5} className="app-empty">
                      {signer ? "No open offers from this account." : "Connect to see your offers."}
                    </td>
                  </tr>
                )}
                {mine.map((o) => (
                  <tr key={String(o.id)}>
                    <td className="cv-num">#{String(o.id).padStart(3, "0")}</td>
                    <td className="r cv-num">{fmtAmount(o.principal)}</td>
                    <td className="r cv-num" style={{ color: "var(--brand)" }}>
                      {fmtPct(o.apr_bps)}
                    </td>
                    <td className="r cv-num">{config ? fmtTerm(o.term_secs, config.day_secs) : ""}</td>
                    <td className="r">
                      <button
                        type="button"
                        className="cv-btn cv-btn--secondary cv-btn--sm"
                        disabled={!!busy || !ctx.approved}
                        title={ctx.approved ? "" : ACCESS_LIMITED}
                        aria-busy={busy === `cancel-${o.id}` ? "true" : undefined}
                        onClick={async () => {
                          const out = await ctx.run(`cancel-${o.id}`, `Offer #${o.id} not cancelled`, () => chain.cancelOffer(signer!, o.id));
                          if (out) setCancelled({ id: o.id, hash: out.hash });
                        }}
                      >
                        {busy === `cancel-${o.id}` ? "Signing…" : "Cancel offer"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

// --- Positions ---------------------------------------------------------------------

function PositionsView({ ctx, repos, liquidatorOk, loaded }: { ctx: Ctx; repos: Repo[]; liquidatorOk: boolean; loaded: boolean }) {
  const { signer, config } = ctx;
  const [receipt, setReceipt] = useState<Receipt>(null);
  const [notice, setNotice] = useState<{ text: string; hash: string } | null>(null);
  const mine = signer ? repos.filter((r) => r.borrower === signer.address || r.lender === signer.address) : [];
  const live = (r: Repo) => r.status === "Open" || r.status === "MarginCall";
  const firstRepayable = mine.find((r) => live(r) && r.borrower === signer?.address)?.id;
  const showDesk = !!signer && (liquidatorOk || roleOf(signer.address) === "liquidator");

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">My positions</h1>
        <span className="small app-muted">Repos where this account is the borrower or the lender.</span>
      </div>
      {receipt && <DvpReceipt {...receipt} />}
      {notice && (
        <p className="cv-row small">
          {notice.text} <TxHash kind="TX" value={notice.hash} />
        </p>
      )}
      {!signer && <p className="app-empty">{CONNECT} to see positions.</p>}
      {signer && !loaded && (
        <div className="app-cards" aria-busy="true" aria-label="Loading repos">
          <div className="cv-card">
            <div className="cv-card__head"><Skel kind="short" /><Skel w={60} h={22} /></div>
            <Skel kind="figure" />
            <Skel kind="line" />
            <Skel kind="short" />
          </div>
        </div>
      )}
      {signer && loaded && mine.length === 0 && <p className="app-empty">No repos for this account yet.</p>}
      <div className="app-cards">
        {config &&
          mine.map((r) => (
            <PositionCard
              key={String(r.id)}
              ctx={ctx}
              repo={r}
              primary={r.id === firstRepayable}
              onRepaid={(rec) => {
                setNotice(null);
                setReceipt(rec);
              }}
            />
          ))}
      </div>

      {showDesk && config && (
        <div className="cv-stack">
          <h2 className="heading">Liquidator desk</h2>
          <span className="small app-muted">
            Anyone can default a repo after maturity plus {String(config.grace_secs)} s grace. Only whitelisted liquidators can buy
            defaulted collateral at NAV × (1 − {fmtPct(config.liquidation_discount_bps, 1)}).
          </span>
          <div className="cv-table-wrap">
            <table className="cv-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th className="r">Debt</th>
                  <th className="r">Collateral</th>
                  <th className="r">Matures</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {repos.filter((r) => r.status !== "Repaid" && r.status !== "Liquidated").map((r) => {
                  const marginMissed = r.status === "MarginCall" && r.margin_call_deadline !== null && ctx.now > Number(r.margin_call_deadline);
                  const defaultable = live(r) && (ctx.now > Number(r.maturity_ts + config.grace_secs) || marginMissed);
                  return (
                    <tr key={String(r.id)}>
                      <td className="cv-num">#{String(r.id).padStart(3, "0")}</td>
                      <td className="r cv-num">{fmtAmount(r.principal + r.interest)}</td>
                      <td className="r cv-num">{fmtAmount(r.collateral_amount)} tBENJI</td>
                      <td className="r cv-num">{fmtCountdown(Number(r.maturity_ts) - ctx.now, 60)}</td>
                      <td>
                        <StatusPill status={r.status} />
                      </td>
                      <td className="r">
                        {r.status === "Open" && (
                          <button
                            type="button"
                            className="cv-btn cv-btn--secondary cv-btn--sm"
                            style={{ marginRight: 8 }}
                            disabled={!!ctx.busy || ctx.navStale || !ctx.approved}
                            title={ctx.navStale ? "NAV is stale; check_margin needs a fresh price" : "Raise a margin call if cover is below 100%"}
                            onClick={async () => {
                              const out = await ctx.run(`check-${r.id}`, `Repo #${r.id} not checked`, () => chain.checkMargin(signer!, r.id));
                              if (out)
                                setNotice({
                                  text: out.value === "MarginCall" ? `Margin call raised on Repo #${r.id}` : `Repo #${r.id} is above the margin line`,
                                  hash: out.hash,
                                });
                            }}
                          >
                            {ctx.busy === `check-${r.id}` ? "Checking" : "Check margin"}
                          </button>
                        )}
                        {live(r) && (
                          <button
                            type="button"
                            className="cv-btn cv-btn--danger cv-btn--sm"
                            disabled={!defaultable || !!ctx.busy || !ctx.approved}
                            title={defaultable ? "" : "Before maturity plus grace, and no missed margin call"}
                            onClick={async () => {
                              const out = await ctx.run(`default-${r.id}`, `Repo #${r.id} not defaulted`, () => chain.declareDefault(signer!, r.id));
                              if (out) setNotice({ text: `Repo #${r.id} defaulted`, hash: out.hash });
                            }}
                          >
                            Declare default
                          </button>
                        )}
                        {r.status === "Defaulted" && (
                          <button
                            type="button"
                            className="cv-btn cv-btn--danger cv-btn--sm"
                            disabled={!liquidatorOk || !!ctx.busy || ctx.navStale || !ctx.approved}
                            title={ctx.navStale ? "NAV is stale" : ""}
                            onClick={async () => {
                              const out = await ctx.run(`liq-${r.id}`, `Repo #${r.id} not liquidated`, () => chain.liquidate(signer!, r.id));
                              if (out)
                                setReceipt({
                                  left: { eyebrow: "Liquidator delivers", amount: ctx.nav ? fmtAmount((collateralValue(r.collateral_amount, ctx.nav.price, ctx.nav.decimals) * (BPS - config.liquidation_discount_bps) + BPS - 1n) / BPS) : "—", unit: "USDC", hint: "to lender, fee, borrower" },
                                  right: { eyebrow: "Liquidator receives", amount: fmtAmount(r.collateral_amount), unit: "tBENJI", hint: `from Repo #${r.id}` },
                                  sentence: `Repo #${r.id} liquidated in one transaction`,
                                  hash: out.hash,
                                  stamp: { word: "Liquidated", sub: `Repo ${String(r.id).padStart(3, "0")}` },
                                });
                            }}
                          >
                            Liquidate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function PositionCard({ ctx, repo, primary, onRepaid }: { ctx: Ctx; repo: Repo; primary: boolean; onRepaid: (r: Receipt) => void }) {
  const { signer, config, nav, balances, busy, now } = ctx;
  const side = signer?.address === repo.borrower ? "borrowed" : "lent";
  const debt = repo.principal + repo.interest;
  // Cover vs the margin-call line (DECISIONS.md #14): value × (1 − liq discount) ÷ debt.
  // 100% is where check_margin fires; a max-LTV take opens just above it.
  const cover = useMemo(() => {
    if (!nav || !config || debt === 0n) return null;
    const v = collateralValue(repo.collateral_amount, nav.price, nav.decimals);
    return Number((v * (BPS - config.liquidation_discount_bps) * 10_000n) / (debt * BPS)) / 100;
  }, [nav, config, repo, debt]);
  const coverRef = useFlash(cover, (a, b) => (b > a ? "up" : b < a ? "down" : undefined));
  // Top-up to clear a margin call: back to initial margin at the repo's own haircut (DECISIONS.md #20).
  const topUpNeed = useMemo(() => {
    if (!nav) return null;
    const need = requiredCollateral(debt, nav.price, nav.decimals, repo.haircut_bps) - repo.collateral_amount;
    return need > 0n ? need : 0n;
  }, [nav, debt, repo]);
  const [topUpInput, setTopUpInput] = useState<string | null>(null);
  if (!config) return null;
  const live = repo.status === "Open" || repo.status === "MarginCall";
  const inMarginCall = repo.status === "MarginCall";
  const deadline = repo.margin_call_deadline !== null ? Number(repo.margin_call_deadline) : null;
  const toDeadline = deadline !== null ? deadline - now : null;
  const breached = cover !== null && cover < 100;
  const fill = cover === null ? 0 : Math.min(100, Math.max(0, ((cover - 90) / 20) * 100));
  const toMaturity = Number(repo.maturity_ts) - now;
  const canRepay = live && side === "borrowed";
  const short = canRepay && balances?.usdc !== null && balances?.usdc !== undefined && balances.usdc < debt;
  const canTopUp = canRepay && (inMarginCall || breached);
  const topUpText = topUpInput ?? (topUpNeed !== null && topUpNeed > 0n ? fmtAmount(topUpNeed).replace(/,/g, "") : "");
  const topUpAmount = parseAmount(topUpText);
  const topUpErr = topUpAmount === null || topUpAmount <= 0n ? "Enter an amount above 0.00 tBENJI." : null;
  const topUpShort =
    !topUpErr && balances?.tbenji !== null && balances?.tbenji !== undefined && topUpAmount !== null && balances.tbenji < topUpAmount
      ? `You hold ${fmtAmount(balances.tbenji)} tBENJI.`
      : null;

  const doTopUp = async () => {
    if (!signer || topUpAmount === null || topUpErr) return;
    const out = await ctx.run(`topup-${repo.id}`, `Repo #${repo.id} not topped up`, () => chain.topUp(signer, repo.id, topUpAmount));
    if (out) {
      setTopUpInput(null);
      ctx.setFlash({
        tone: "info",
        title: `Topped up Repo #${String(repo.id).padStart(3, "0")}`,
        body: `Added ${fmtAmount(topUpAmount)} tBENJI. ${inMarginCall ? "The margin call clears once collateral is back at the initial margin." : ""}`,
      });
    }
  };

  const doRepay = async () => {
    if (!signer) return;
    const out = await ctx.run(`repay-${repo.id}`, `Repo #${repo.id} not repaid`, () => chain.repay(signer, repo.id));
    if (out)
      onRepaid({
        left: { eyebrow: "Borrower delivers", amount: fmtAmount(debt), unit: "USDC", hint: "principal plus interest" },
        right: { eyebrow: "Borrower receives", amount: fmtAmount(repo.collateral_amount), unit: "tBENJI", hint: `from Repo #${repo.id}` },
        sentence: `Repo #${repo.id} repaid. Settled atomically in one transaction`,
        hash: out.hash,
        stamp: { word: "Repaid", sub: fmtAmount(debt), repaid: true },
      });
  };

  return (
    <article className="cv-card" data-repo={String(repo.id)}>
      <div className="cv-card__head">
        <span className="cv-eyebrow">
          Repo #{String(repo.id).padStart(3, "0")} · {side}
        </span>
        <StatusPill status={repo.status} />
      </div>
      {live && (inMarginCall || breached) && (
        <Alert tone="margin" title={inMarginCall ? `Margin call on Repo #${String(repo.id).padStart(3, "0")}` : "Below the margin-call line"}>
          {`Collateral cover is ${cover !== null ? cover.toFixed(1) : "—"}%. `}
          {side === "borrowed"
            ? topUpNeed !== null && topUpNeed > 0n
              ? `Add ${fmtAmount(topUpNeed)} tBENJI${inMarginCall && toDeadline !== null ? ` within ${fmtCountdown(Math.max(0, toDeadline), Number(config.day_secs))}` : ""} or the repo can be defaulted.`
              : "Repay, or wait for the next NAV."
            : inMarginCall
              ? "The borrower has until the deadline to add collateral; after it, anyone can default the repo."
              : "A margin call can be raised on the next check."}
        </Alert>
      )}
      <div>
        <span className="cv-figure-xl">{fmtAmount(repo.principal)}</span>
        <span className="cv-unit">USDC</span>
      </div>
      <dl className="cv-terms">
        <div>
          <dt>Debt</dt>
          <dd>{fmtAmount(debt)} USDC</dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd>{fmtAmount(repo.collateral_amount)} tBENJI</dd>
        </div>
        <div>
          <dt>Haircut</dt>
          <dd>{fmtPct(repo.haircut_bps, 1)}</dd>
        </div>
      </dl>
      {live && (
        <div className={`cv-health${repo.status === "MarginCall" ? " cv-health--margin" : ""}`}>
          <div className="cv-health__legend">
            <span>Collateral cover</span>
            <span className="cv-num app-flashable" ref={coverRef}>{cover !== null ? `${cover.toFixed(1)}%` : "—"}</span>
          </div>
          <div className="cv-health__bar" role="meter" aria-valuemin={90} aria-valuemax={110} aria-valuenow={cover ?? undefined} aria-label="Collateral cover">
            <div className="cv-health__fill" style={{ width: `${fill}%` }} />
            <div className="cv-health__mark" style={{ left: "50%" }} />
          </div>
          <div className="cv-health__legend">
            <span>Margin call at 100%</span>
            <span>NAV {nav ? fmtNav(nav.price, nav.decimals) : "—"}</span>
          </div>
        </div>
      )}
      <div className="cv-row" style={{ justifyContent: "space-between" }}>
        <span className="cv-countdown">
          <span className="cv-field__hint">
            {!live ? "Closed" : inMarginCall && toDeadline !== null ? (toDeadline > 0 ? "Top up within" : "Margin window over") : toMaturity > 0 ? "Matures in" : "Matured, grace ends in"}
          </span>
          {live && (
            <span className="cv-countdown__time">
              {inMarginCall && toDeadline !== null
                ? fmtCountdown(Math.max(0, toDeadline), Number(config.day_secs))
                : fmtCountdown(toMaturity > 0 ? toMaturity : Number(repo.maturity_ts + config.grace_secs) - now, Number(config.day_secs))}
            </span>
          )}
        </span>
        {canRepay && (
          <button
            type="button"
            className={`cv-btn ${primary && !canTopUp ? "cv-btn--primary" : "cv-btn--secondary"} cv-btn--sm`}
            disabled={!!busy || !!short || !ctx.approved}
            title={ctx.approved ? "" : ACCESS_LIMITED}
            onClick={doRepay}
            data-action="repay"
          >
            {busy === `repay-${repo.id}` ? "Repaying" : "Repay"}
          </button>
        )}
      </div>
      {ctx.tx?.key === `repay-${repo.id}` && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
      {canTopUp && (
        <form
          className="cv-stack app-topup"
          onSubmit={(e) => {
            e.preventDefault();
            doTopUp();
          }}
        >
          <Field
            id={`topup-${repo.id}`}
            label="Add collateral"
            value={topUpText}
            onChange={setTopUpInput}
            suffix="tBENJI"
            error={topUpErr ?? topUpShort}
            hint={
              topUpNeed !== null && nav
                ? `${fmtAmount(topUpNeed)} tBENJI brings the repo back to the initial margin (${fmtPct(repo.haircut_bps, 1)} haircut at NAV ${fmtNav(nav.price, nav.decimals)}), which clears the margin call.`
                : "Waiting for NAV."
            }
          />
          <button
            type="submit"
            className="cv-btn cv-btn--primary"
            disabled={!!busy || !!topUpErr || !!topUpShort || !ctx.approved}
            title={ctx.approved ? "" : ACCESS_LIMITED}
            data-action="top-up"
          >
            {busy === `topup-${repo.id}` ? "Topping up" : "Top up"}
          </button>
          {ctx.tx?.key === `topup-${repo.id}` && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
        </form>
      )}
      {canRepay && (
        <p className="cv-field__hint">
          {short
            ? `Repay needs ${fmtAmount(debt)} USDC; you hold ${fmtAmount(balances!.usdc!)} USDC.`
            : `Repay ${fmtAmount(debt)} USDC to close Repo #${String(repo.id).padStart(3, "0")} and get ${fmtAmount(repo.collateral_amount)} tBENJI back.`}
        </p>
      )}
    </article>
  );
}

// --- Admin: NAV slider ---------------------------------------------------------------

function AdminView({ ctx, isAdmin }: { ctx: Ctx; isAdmin: boolean }) {
  const { nav, signer, busy, config } = ctx;
  const [value, setValue] = useState<number | null>(null);
  const [last, setLast] = useState<{ nav: string; hash: string } | null>(null);
  const current = nav ? Number(nav.price) / 10 ** nav.decimals : 1;
  const v = value ?? current;
  const decimals = nav?.decimals ?? 14;

  const push = async () => {
    if (!signer) return;
    const scaled = BigInt(Math.round(v * 10_000)) * 10n ** BigInt(decimals - 4);
    const out = await ctx.run("nav", "NAV not updated", () => chain.setNav(signer, scaled));
    if (out) {
      setLast({ nav: v.toFixed(4), hash: out.hash });
      setValue(null);
    }
  };

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">Demo NAV</h1>
        <span className="small app-muted">Admin pushes a tBENJI price to the mock SEP-40 oracle with set_price. Takes and liquidations need a price younger than {config ? Number(config.max_nav_age_secs) / 60 : 3} minutes.</span>
      </div>
      {!isAdmin && (
        <Alert tone="info" title="Admin only">
          {`Only the oracle admin ${ACCOUNTS.admin.slice(0, 4)}…${ACCOUNTS.admin.slice(-4)} can set the price.`}{" "}
          {DEMO_ENABLED ? "Pick the Admin demo account above." : ""}
        </Alert>
      )}
      <div className="cv-card cv-stack app-admin">
        <label className="cv-field">
          <span className="cv-field__label">tBENJI NAV</span>
          <span className="app-slider">
            <input
              type="range"
              min={0.9}
              max={1.1}
              step={0.0001}
              value={v}
              onChange={(e) => setValue(Number(e.target.value))}
              aria-describedby="nav-hint"
              data-testid="nav-slider"
            />
            <span className="cv-figure-xl">{v.toFixed(4)}</span>
            <span className="cv-unit">USD</span>
          </span>
          <span className="cv-field__hint" id="nav-hint">
            Current feed {nav ? fmtNav(nav.price, nav.decimals) : "—"}
            {nav ? ` at ${new Date(Number(nav.timestamp) * 1000).toLocaleTimeString()}` : ""}. Pushing the same value refreshes the timestamp.
          </span>
        </label>
        <button
          type="button"
          className="cv-btn cv-btn--primary"
          disabled={!isAdmin || !!busy}
          onClick={push}
          data-action="push-nav"
        >
          {busy === "nav" ? "Pushing NAV" : "Push NAV"}
        </button>
        {ctx.tx?.key === "nav" && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
        {last && (
          <p className="cv-row small">
            NAV set to {last.nav} <TxHash kind="TX" value={last.hash} />
          </p>
        )}
      </div>
    </section>
  );
}
