import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import lockup from "../../design/logos/caravel-lockup.svg";
import {
  ACCOUNTS,
  COLLATERAL,
  DEMO_ENABLED,
  TSAFO,
  DEMO_ROLES,
  ORACLE_ID,
  REPO_ID,
  assetBySac,
  roleOf,
  type DemoRole,
  type Token,
} from "./config";
import * as chain from "./chain";
import type { AssetConfig, Balances, Nav, Offer, ProtocolConfig, Repo, Status } from "./chain";
import { explain } from "./errors";
import {
  BPS,
  collateralDecimals,
  collateralValue,
  coverPct,
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
import { trustlineUi } from "./trustline";
import {
  ACCESS_LIMITED,
  autoRepayHint,
  checkBand,
  collateralBlock,
  ledgerNow,
  navBadge,
  navBlock,
  navHealth,
  navHoldText,
  takeNavBlock,
  topUpHoldText,
  type NavHealth,
  type PricePoint,
} from "./gates";
import { connectWallet, demoSigner, disconnectWallet, restoreSession, type Signer } from "./wallet";

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

const isAdminNow = (signer: Signer | null, config: ProtocolConfig | null) =>
  !!(signer && config && signer.address === config.admin);
/** Marketing landing page (site/), served at the root of the same Pages site; the app lives under /app/. */
const LANDING_URL = "/";
const CONNECT = DEMO_ENABLED ? "Connect a wallet or pick a demo account" : "Connect a wallet";

export default function App() {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [config, setConfig] = useState<ProtocolConfig | null>(null);
  // Per collateral token (config.ts COLLATERAL), keyed by token contract id.
  const [assets, setAssets] = useState<Record<string, AssetConfig | null>>({});
  const [navs, setNavs] = useState<Record<string, Nav | null>>({});
  // The feed's last 20 prices per collateral (oracle `prices`), for the NAV band check (#31).
  const [histories, setHistories] = useState<Record<string, PricePoint[] | null>>({});
  // Latest ledger close time and the browser second it was read: `now` is ledger time.
  const [ledger, setLedger] = useState<{ closeTime: number; at: number } | null>(null);
  // Debt of live repos per collateral token, counted against max_open_debt (#32).
  const [openDebt, setOpenDebt] = useState<Record<string, bigint | null>>({});
  const [offers, setOffers] = useState<Offer[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [liquidatorOk, setLiquidatorOk] = useState(false);
  // USDC a settlement could not push to this account, waiting for claim().
  const [claimable, setClaimable] = useState(0n);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("offers");
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(nowSecs());
  // Ledger time, not the browser clock: the contract judges NAV age, maturity
  // and margin deadlines against the ledger close time.
  const now = ledgerNow(tick, ledger);
  const [tx, setTx] = useState<TxState | null>(null);

  // TxProgress: chain.ts reports sign / submit; prepare is set when a write starts.
  useEffect(() => {
    onPhase((p) => setTx((t) => (t ? { ...t, step: p === "sign" ? 1 : p === "submit" ? 2 : 0 } : t)));
    return () => onPhase(null);
  }, []);

  // --- data ---------------------------------------------------------------------
  const refreshMarket = useCallback(async () => {
    try {
      const [n, book, d, h] = await Promise.all([
        Promise.all(COLLATERAL.map((a) => chain.getNav(a.sac))),
        chain.getBook(),
        Promise.all(COLLATERAL.map((a) => chain.getOpenDebt(a.sac))),
        // Band and clock reads never block the board: on failure the app falls
        // back to the last price only and the browser clock.
        Promise.all(COLLATERAL.map((a) => chain.getNavHistory(a.sac).catch(() => null))),
        chain
          .getLedgerTime()
          .then((closeTime) => setLedger({ closeTime, at: nowSecs() }))
          .catch(() => undefined),
      ]);
      setNavs(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, n[i]])));
      setHistories(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, h[i]])));
      setOpenDebt(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, d[i]])));
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
      const [b, l, c] = await Promise.all([
        chain.getBalances(signer.address),
        chain.isLiquidator(signer.address),
        chain.getClaimable(signer.address),
      ]);
      setBalances(b);
      setLiquidatorOk(l);
      setClaimable(c);
    } catch (e) {
      setFlash({ tone: "error", title: "Could not read balances", body: explain(e) });
    }
  }, [signer]);

  const refreshAll = useCallback(() => Promise.all([refreshMarket(), refreshAccount()]), [refreshMarket, refreshAccount]);

  useEffect(() => {
    Promise.all([chain.getConfig(), Promise.all(COLLATERAL.map((a) => chain.getAssetConfig(a.sac)))])
      .then(([c, a]) => {
        setConfig(c);
        setAssets(Object.fromEntries(COLLATERAL.map((t, i) => [t.sac, a[i]])));
      })
      .catch((e) => setFlash({ tone: "error", title: "Could not read the repo contract", body: explain(e) }));
    refreshMarket();
    const t = setInterval(refreshMarket, 10_000);
    const c = setInterval(() => setTick(nowSecs()), 1_000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [refreshMarket]);

  useEffect(() => {
    setBalances(null);
    setClaimable(0n);
    refreshAccount();
    const t = setInterval(refreshAccount, 10_000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // --- session ------------------------------------------------------------------
  // Page reload: pick the last wallet or demo account back up without a popup.
  useEffect(() => {
    restoreSession().then((s) => s && setSigner((cur) => cur ?? s));
  }, []);

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
    await disconnectWallet(); // also forgets the demo role, so reload stays logged out
    setSigner(null);
    setBalances(null);
    setClaimable(0n);
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
      const navAges = COLLATERAL.flatMap((t) => {
        const a = assets[t.sac];
        return a ? [{ code: t.code, secs: a.max_nav_age_secs }] : [];
      });
      setFlash({ tone: "error", title, body: explain(e, navAges) });
      return null;
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  useEffect(() => {
    if (tab === "admin" && !isAdminNow(signer, config)) setTab("offers");
  }, [tab, signer, config]);

  // NAV state per asset, in the contract's order: no price, future-dated,
  // stale (#25, per asset; getAssetConfig falls back to config().max_nav_age_secs
  // on contracts deployed before it), outside the sanity band (#31).
  const health = (sac: string) => navHealth(navs[sac] ?? null, histories[sac] ?? null, assets[sac] ?? null, now);
  const isAdmin = isAdminNow(signer, config);
  // Access gate, per collateral asset: holding tBENJI needs an issuer-AUTHORIZED
  // trustline, tSAFO the issuer allowlist (scripts/onboard.sh sets both). Lending
  // needs neither. Keeper-style writes (check margin, default) need a wallet the
  // issuer approved for at least one asset. Demo burner keys exist only in dev
  // builds (VITE_DEMO_SIGNER=1) and are team accounts.
  const canHold = (sac: string) =>
    !!signer && (signer.kind === "demo" || collateralBlock(balances, assetBySac(sac)) === null);
  const approved = !!signer && (signer.kind === "demo" || COLLATERAL.some((t) => canHold(t.sac)));
  const ctx: Ctx = {
    signer,
    approved,
    canHold,
    config,
    assets,
    navs,
    histories,
    openDebt,
    health,
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
          <a href={LANDING_URL} className="app-brand" aria-label="Caravel home: landing page">
            <img src={lockup} alt="Caravel" height={44} />
          </a>
          <span className="caption app-net">Stellar testnet</span>
          <div className="app-header__end">
          {config && assets[COLLATERAL[0].sac] && <DemoInfo config={config} asset={assets[COLLATERAL[0].sac]!} />}
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
        </div>
      </header>

      <main className="app-wrap app-main">
        <section
          className={`cv-card app-status${DEMO_ENABLED ? "" : " app-status--public"}`}
          aria-label={DEMO_ENABLED ? "Demo account, balances and NAV" : "Balances and NAV"}
        >
          {DEMO_ENABLED && (
            <div className="app-status__group" role="group" aria-label="Demo account (testnet burner)">
              <span className="app-status__label">Demo as</span>
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
          )}
          {signer ? (
            <BalanceFigures balances={balances} />
          ) : (
            !DEMO_ENABLED && <span className="app-status__group small app-muted">Connect a wallet to see your balances.</span>
          )}
          {/* All NAV groups sit in one cluster (app-status__navs) so they stay together when the bar wraps. */}
          <div className="app-status__navs">
            {COLLATERAL.map((t) => (
              <NavStatus
                key={t.sac}
                token={t}
                nav={navs[t.sac] ?? null}
                health={health(t.sac)}
                hold={navHoldText(t.code, health(t.sac), assets[t.sac] ?? null)}
                loaded={loaded}
              />
            ))}
          </div>
        </section>

        {COLLATERAL.map((t) => {
          const text = loaded ? navHoldText(t.code, health(t.sac), assets[t.sac] ?? null) : null;
          return text ? (
            <Alert key={t.sac} tone="info" title={`${t.code} price on hold`}>
              {text}
            </Alert>
          ) : null;
        })}

        {signer && (
          <AccountAlerts
            signer={signer}
            balances={balances}
            claimable={claimable}
            busy={busy}
            run={run}
            refresh={refreshAccount}
            setFlash={setFlash}
          />
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
  /** Connected and approved by the issuer of at least one collateral asset. */
  approved: boolean;
  /** Connected and allowed to hold this collateral (tBENJI authorized / tSAFO allowlisted). */
  canHold: (sac: string) => boolean;
  config: ProtocolConfig | null;
  /** Asset config per collateral token id; null = not registered with set_asset. */
  assets: Record<string, AssetConfig | null>;
  navs: Record<string, Nav | null>;
  /** Oracle `prices(asset, 20)` per collateral, newest first; null = not read. */
  histories: Record<string, PricePoint[] | null>;
  /** Debt of live repos per collateral token (#32); null = contract has no open_debt(). */
  openDebt: Record<string, bigint | null>;
  /** NAV state for this collateral as the contract would see it. */
  health: (sac: string) => NavHealth;
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

function AccountAlerts({
  signer,
  balances,
  claimable,
  busy,
  run,
  refresh,
  setFlash,
}: {
  signer: Signer;
  balances: Balances | null;
  /** Parked USDC payouts for this account (contract claimable()). */
  claimable: bigint;
  busy: string | null;
  run: Ctx["run"];
  refresh: () => Promise<void>;
  setFlash: Ctx["setFlash"];
}) {
  // Per-asset access gate: a wallet approved for neither collateral is read-only;
  // a tSAFO-allowlisted wallet without tBENJI authorization can still borrow tSAFO.
  // The button depends only on chain state + in-flight request, so it survives any failure.
  const { gated, tbenjiPending, showInfo: showTrust, button } = trustlineUi(signer.kind, balances, busy);
  const tsafoCode = TSAFO?.code ?? "tSAFO";
  const missing = button?.missing ?? [];
  // A wallet decline re-prompts once (chain.ensureTrustlines); a second decline or any
  // other failure lands in the flash and the button stays for another try.
  const addTrust = () =>
    run("trust", "Trustline not added. Click the Add trustline button to try again", async () => {
      const r = await chain.ensureTrustlines(signer, [...missing], (_e, todo) => {
        setFlash({
          tone: "info",
          title: "Wallet declined the trustline",
          body: `Nothing was sent. Asking your wallet again for ${todo.join(" + ")}: approve it to finish.`,
        });
        void refresh();
      });
      setFlash(
        r.added.length > 0
          ? { tone: "info", title: "Trustline added", body: `${r.added.join(" + ")} trustline in place.` }
          : null,
      );
      return r;
    });
  const trustButton = button && (
    <button
      type="button"
      className="cv-btn cv-btn--secondary cv-btn--sm"
      data-action="add-trustline"
      disabled={button.disabled}
      aria-busy={button.disabled ? "true" : undefined}
      onClick={addTrust}
    >
      {button.label}
    </button>
  );
  const onClaim = () =>
    run("claim", "USDC not claimed", async () => {
      const r = await chain.claim(signer);
      setFlash({ tone: "info", title: "USDC claimed", body: `${fmtAmount(r.value)} USDC sent to your account.` });
      return r;
    });
  return (
    <>
      {claimable > 0n && (
        <Alert
          tone="info"
          title={`${fmtAmount(claimable)} USDC waiting for you`}
          action={
            <button
              type="button"
              className="cv-btn cv-btn--primary cv-btn--sm"
              data-action="claim"
              disabled={busy === "claim"}
              aria-busy={busy === "claim" ? "true" : undefined}
              onClick={onClaim}
            >
              {busy === "claim" ? "Claiming…" : "Claim"}
            </button>
          }
        >
          A repay or liquidation could not send this USDC to your account (frozen by the issuer or no USDC trustline), so
          the contract kept it for you. Claim it once your account can receive USDC.
        </Alert>
      )}
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
          title="Borrowing not approved yet"
          action={trustButton || undefined}
        >
          You can lend USDC now. Borrowing needs the collateral issuer&apos;s approval. {ACCESS_LIMITED}{" "}
          {balances.tbenji !== null
            ? `Your tBENJI trustline is in place; the issuer has not authorized ${signer.address.slice(0, 4)}…${signer.address.slice(-4)} yet.`
            : ""}
        </Alert>
      )}
      {tbenjiPending && balances && (
        <Alert tone="info" title="tBENJI borrowing not approved yet" action={trustButton || undefined}>
          {`${tsafoCode} borrowing is open to you: this wallet is on the ${tsafoCode} issuer allowlist. `}
          {balances.tbenji !== null
            ? `Your tBENJI trustline is in place; the issuer has not authorized ${signer.address.slice(0, 4)}…${signer.address.slice(-4)} yet.`
            : "Borrowing against tBENJI also needs a tBENJI trustline and the issuer's authorization."}
          {balances.usdc === null ? " Add a USDC trustline to lend or receive loan proceeds." : ""}
        </Alert>
      )}
      {showTrust && (
        <Alert
          tone="info"
          title={`No ${missing.join(" or ")} trustline`}
          action={trustButton || undefined}
        >
          {`Lenders need USDC. Borrowers need USDC plus approved collateral: tBENJI is AUTH_REQUIRED, so the issuer has to authorize the trustline${TSAFO ? `; ${tsafoCode} needs no trustline, only the issuer allowlist` : ""}.`}
        </Alert>
      )}
    </>
  );
}

function BalanceFigures({ balances }: { balances: Balances | null }) {
  return (
    <div className="app-status__group" aria-label="Balances">
      <Figure label="XLM" value={balances ? fmtAmount(balances.xlm) : null} />
      <Figure label="USDC" value={balances ? (balances.usdc === null ? "No trustline" : fmtAmount(balances.usdc)) : null} />
      <Figure
        label="tBENJI"
        value={balances ? (balances.tbenji === null ? "No trustline" : fmtAmount(balances.tbenji)) : null}
        hint={balances?.tbenji !== null && balances && !balances.tbenjiAuthorized ? "Not authorized by the issuer" : undefined}
      />
      {TSAFO && (
        <Figure
          label={TSAFO.code}
          value={balances ? fmtAmount(balances.tsafo ?? 0n, 2, TSAFO.decimals) : null}
          hint={balances?.exists && !balances.tsafoAllowed ? "Not on the issuer allowlist" : undefined}
        />
      )}
    </div>
  );
}

/** Bell in the header: demo notices live in a popover, not a banner in the page. The dot clears once opened. */
function DemoInfo({ config, asset }: { config: ProtocolConfig; asset: AssetConfig }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  const daySecs = Number(config.day_secs);
  const dayWord = daySecs === 60 ? "1 minute" : `${daySecs} seconds`;
  const maxAgeMin = Number(asset.max_nav_age_secs) / 60;
  return (
    <div className="app-notify">
      <button
        type="button"
        className="app-bell"
        aria-label={seen ? "Notifications" : "Notifications, 1 new"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setSeen(true);
        }}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20.5h4" />
        </svg>
        {!seen && <span className="app-bell__dot" />}
      </button>
      {open && (
        <div className="app-pop" role="dialog" aria-label="Notifications">
          <div className="app-pop__head">
            <span>Notifications</span>
            <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="app-pop__item">
            <span className="app-pop__icon" aria-hidden="true">i</span>
            <span>
              <b>Demo time</b>1 day lasts {dayWord} here, so a 7-day loan ends in {daySecs === 60 ? "7 minutes" : `${7 * daySecs} seconds`}. New
              loans need a price updated in the last {maxAgeMin} minutes.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Plain-language line + this: the technical detail opens on hover or keyboard focus. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <span className="app-tip">
      <button type="button" className="app-tip__btn" aria-label="More info">
        i
      </button>
      <span className="app-tip__pop" role="tooltip">
        {children}
      </span>
    </span>
  );
}

function Figure({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  // null = first load: show a skeleton; afterwards flash the figure when it changes.
  const ref = useFlash(value);
  return (
    <span className="app-status__fig" aria-busy={value === null ? "true" : undefined} title={hint}>
      <span>{label}</span>
      {value === null ? (
        <Skel w={70} h={14} />
      ) : (
        <b className="app-flashable" data-balance={label} ref={ref}>
          {value}
        </b>
      )}
      {hint && <span className="cv-field__hint">{hint}</span>}
    </span>
  );
}

const navDir = (a: string, b: string) => (BigInt(b) > BigInt(a) ? "up" : BigInt(b) < BigInt(a) ? "down" : undefined);

function NavStatus({
  token,
  nav,
  health,
  hold,
  loaded,
}: {
  token: Token;
  nav: Nav | null;
  health: NavHealth;
  /** Why the contract holds this price (band / future timestamp), shown on hover. */
  hold: string | null;
  loaded: boolean;
}) {
  const age = health.age;
  const badge = navBadge(health);
  const navRef = useFlash(nav ? String(nav.price) : null, navDir);
  return (
    <div
      className="app-status__group"
      aria-label={`${token.code} NAV`}
      aria-busy={loaded ? undefined : "true"}
      title={hold ?? undefined}
      data-nav-state={loaded ? health.state : undefined}
    >
      <span className="app-status__label">{token.code} NAV</span>
      {!loaded ? (
        <Skel w={90} h={14} />
      ) : (
        <>
          <span className="app-status__nav app-flashable" data-testid={token.kind === "sac" ? "nav" : `nav-${token.code}`} ref={navRef}>
            {nav ? fmtNav(nav.price, nav.decimals) : "—"}
          </span>
          <Live state={badge.state} word={badge.word} meta={badge.meta} />
          {age !== null && <span className="cv-field__hint">{fmtAge(age)}</span>}
        </>
      )}
    </div>
  );
}

// --- Offers board + take ---------------------------------------------------------

function OffersView({ ctx, offers, loaded }: { ctx: Ctx; offers: Offer[]; loaded: boolean }) {
  const [selected, setSelected] = useState<bigint | null>(null);
  const [receipt, setReceipt] = useState<Receipt>(null);
  const [filter, setFilter] = useState<string>("all");
  const { config, assets, openDebt } = ctx;
  const offer = offers.find((o) => o.id === selected) ?? null;
  const shown = filter === "all" ? offers : offers.filter((o) => o.collateral_asset === filter);
  // Exposure cap per asset (#32); hidden on a contract deployed before it.
  const caps = COLLATERAL.flatMap((a) => {
    const cap = assets[a.sac]?.max_open_debt;
    const used = openDebt[a.sac];
    return cap != null && used != null ? [{ ...a, cap, used }] : [];
  });

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">Offers board</h1>
        <span className="small app-muted">
          Open USDC loan offers. Each one is taken in full.
          <Tip>The lender&apos;s USDC is already locked in the contract, so taking an offer pays you out right away.</Tip>
        </span>
        {caps.length > 0 && (
          <span className="small app-muted" data-testid="exposure-caps">
            Exposure cap used:{" "}
            {caps.map((a, i) => (
              <span key={a.sac} data-testid={`cap-${a.code}`}>
                {i > 0 ? " · " : ""}
                {a.code} <span className="cv-num">{fmtAmount(a.used, 0)} / {fmtAmount(a.cap, 0)}</span> USDC
              </span>
            ))}
            <Tip>The most USDC that can be owed (principal + interest) on live loans against each collateral. At the cap new loans pause; repaying, topping up and liquidating always work.</Tip>
          </span>
        )}
      </div>

      {COLLATERAL.length > 1 && (
        <label className="cv-field app-filter">
          <span className="cv-field__label">Collateral</span>
          <span className="cv-field__control">
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="app-select" data-testid="offers-collateral">
              <option value="all">All assets</option>
              {COLLATERAL.map((a) => (
                <option key={a.sac} value={a.sac}>
                  {a.code}
                  {assets[a.sac] ? ` · ${fmtPct(assets[a.sac]!.haircut_bps, 0)} haircut` : ""}
                </option>
              ))}
            </select>
          </span>
        </label>
      )}

      {receipt && <DvpReceipt {...receipt} />}

      {offer && config && assets[offer.collateral_asset] && (
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
            {loaded && shown.length === 0 && (
              <tr>
                <td colSpan={9} className="app-empty">
                  {offers.length === 0 ? "No open offers. Post one from Lend." : `No open ${assetBySac(filter).code} offers.`}
                </td>
              </tr>
            )}
            {shown.map((o) => (
              <tr key={String(o.id)} data-offer={String(o.id)}>
                <td className="cv-num">#{String(o.id).padStart(3, "0")}</td>
                <td className="r cv-num">{fmtAmount(o.principal)}</td>
                <td className="r cv-num" style={{ color: "var(--brand)" }}>
                  {fmtPct(o.apr_bps)}
                </td>
                <td className="r cv-num">{config ? fmtTerm(o.term_secs, config.day_secs) : "…"}</td>
                <td className="r cv-num">{assets[o.collateral_asset] ? fmtPct(assets[o.collateral_asset]!.haircut_bps, 1) : "…"}</td>
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
  const { config, balances, signer, busy } = ctx;
  const token = assetBySac(offer.collateral_asset);
  const asset = ctx.assets[offer.collateral_asset];
  const nav = ctx.navs[offer.collateral_asset] ?? null;
  const navH = ctx.health(offer.collateral_asset);
  const [autoRepay, setAutoRepay] = useState(true);
  if (!config || !asset) return null;
  const int = calcInterest(offer.principal, offer.apr_bps, offer.term_secs, config.day_secs);
  const debt = offer.principal + int;
  const collateral = nav
    ? requiredCollateral(debt, nav.price, collateralDecimals(nav.decimals, token.decimals), asset.haircut_bps)
    : null;
  const held = balances ? chain.holding(balances, offer.collateral_asset) : null;
  const amt = (v: bigint) => fmtAmount(v, 2, token.decimals);
  const cap = asset.max_open_debt;
  const used = ctx.openDebt[offer.collateral_asset] ?? null;

  let block: string | null = null;
  if (!signer) block = `${CONNECT} to take this offer.`;
  else if (signer.kind !== "demo" && collateralBlock(balances, token)) block = collateralBlock(balances, token);
  else if (signer.address === offer.lender) block = "This is your own offer. Cancel it from Lend instead.";
  else if (!asset.enabled) block = `${token.code} is disabled as collateral right now.`;
  else if (takeNavBlock(token.code, navH, asset)) block = takeNavBlock(token.code, navH, asset);
  else if (cap !== null && used !== null && used + debt > cap)
    block =
      cap === 0n
        ? `New ${token.code} loans are paused: its exposure cap is 0.`
        : `This loan would take ${token.code} past its exposure cap: ${fmtAmount(used, 0)} of ${fmtAmount(cap, 0)} USDC used, this loan adds ${fmtAmount(debt)}.`;
  else if (balances && !balances.exists) block = "Your account is not on testnet yet. Fund it with friendbot.";
  else if (balances && balances.usdc === null) block = "Add a USDC trustline to receive the loan.";
  else if (held && collateral !== null && (held.amount ?? 0n) < collateral)
    block = `You need ${amt(collateral)} ${token.code} and hold ${amt(held.amount ?? 0n)} ${token.code}.`;

  const take = async () => {
    if (!signer || collateral === null) return;
    const out = await ctx.run("take", `Offer #${offer.id} not taken`, () => chain.takeOffer(signer, offer.id, autoRepay));
    if (out)
      onDone({
        left: { eyebrow: "Borrower delivers", amount: amt(collateral), unit: token.code, hint: "into escrow" },
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
      <div className="app-take__body">
        <div className="app-take__terms">
          <div className="app-take__head">
            <div>
              <span className="cv-figure-xl">{fmtAmount(offer.principal)}</span>
              <span className="cv-unit">USDC</span>
            </div>
            <div className="cv-apr">
              {fmtPct(offer.apr_bps)} APR<span className="cv-unit">fixed</span>
            </div>
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
        </div>
        <div className="app-take__act">
          <div className="app-preview">
            <span className="cv-field__label">Collateral you post</span>
            <span>
              <span className="figure" data-testid="collateral-preview">
                {collateral !== null ? amt(collateral) : "—"}
              </span>
              <span className="cv-unit">{token.code}</span>
            </span>
            <span className="cv-field__hint">
              {nav ? (
                <>
                  Locked as security for {fmtAmount(debt)} USDC.
                  <Tip>
                    You can borrow up to {fmtPct(BPS - asset.haircut_bps, 1)} of your collateral&apos;s value; the{" "}
                    {fmtPct(asset.haircut_bps, 1)} haircut is a safety buffer. Amount = debt ÷ (NAV {fmtNav(nav.price, nav.decimals)} ×{" "}
                    {fmtPct(BPS - asset.haircut_bps, 1)}), rounded up. The final figure uses the price when the transaction lands.
                  </Tip>
                </>
              ) : (
                <span className="cv-wait">
                  Waiting for NAV
                  <span className="cv-wait__dots" aria-hidden="true"><i></i><i></i><i></i></span>
                </span>
              )}
            </span>
          </div>
          <AutoRepayToggle
            checked={autoRepay}
            disabled={!!busy}
            onChange={setAutoRepay}
            hint={autoRepayHint({
              on: autoRepay,
              debt: fmtAmount(debt),
              code: token.code,
              graceSecs: config.grace_secs,
              discount: fmtPct(config.liquidation_discount_bps, 1),
            })}
          />
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
        </div>
      </div>
    </article>
  );
}

// --- Lend --------------------------------------------------------------------------

function LendView({ ctx, offers }: { ctx: Ctx; offers: Offer[] }) {
  const { config, signer, balances, busy } = ctx;
  const [amount, setAmount] = useState("50.00");
  const [days, setDays] = useState("7");
  const [apr, setApr] = useState("5.20");
  const [collateral, setCollateral] = useState(COLLATERAL[0].sac);
  const asset = ctx.assets[collateral] ?? null;
  const token = assetBySac(collateral);
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
  else if (balances && !balances.exists) block = "Your account is not on testnet yet. Fund it with friendbot.";
  else if (balances && balances.usdc === null) block = "Add a USDC trustline first.";
  else if (balances && principal && balances.usdc !== null && balances.usdc < principal)
    block = `You hold ${fmtAmount(balances.usdc)} USDC, less than ${fmtAmount(principal)} USDC.`;
  else if (config && !asset) block = `${token.code} is not registered as collateral on this deployment.`;
  else if (asset && !asset.enabled) block = `${token.code} is disabled as collateral right now.`;

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
        <span className="small app-muted">Your USDC stays locked in the contract until someone takes the offer or you cancel it.</span>
      </div>
      <div className="app-lend__grid">
        <form
          className="cv-card cv-stack"
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
        >
          <div className="app-lend__fields">
          <Field id="amount" label="Amount to lend" value={amount} onChange={setAmount} suffix="USDC" error={errAmount}
            hint="Held in escrow until a borrower takes it." />
          <Field id="term" label="Term" value={days} onChange={setDays} suffix="days" error={errDays}
            hint={config ? `In the demo, ${days || "0"} days run in ${Math.max(1, Math.round(((Number(days) || 0) * Number(config.day_secs)) / 60))} min.` : ""} />
          <Field id="apr" label="Rate" value={apr} onChange={setApr} suffix="% APR" error={errApr}
            hint="Fixed. Full interest is owed even if repaid early." />
          <label className="cv-field">
            <span className="cv-field__label">Collateral</span>
            <span className="cv-field__control">
              <select value={collateral} onChange={(e) => setCollateral(e.target.value)} aria-describedby="collat-hint" className="app-select">
                {COLLATERAL.map((a) => (
                  <option key={a.sac} value={a.sac}>
                    {a.code}
                    {ctx.assets[a.sac] ? ` · ${fmtPct(ctx.assets[a.sac]!.haircut_bps, 0)} haircut` : ""}
                  </option>
                ))}
              </select>
            </span>
            <span className="cv-field__hint" id="collat-hint">
              {asset ? `Borrowers get up to ${fmtPct(BPS - asset.haircut_bps, 1)} of collateral value.` : ""}
              {token.kind === "spiko"
                ? ` ${token.code} is a Spiko-style fund token: only issuer-allowlisted wallets can hold it, and the issuer can pause transfers, which also freezes repay and liquidation until it unpauses.`
                : ""}
            </span>
          </label>
          </div>
          <div className="app-lend__foot">
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
          <button
            type="submit"
            className="cv-btn cv-btn--primary"
            disabled={!!block || !!errAmount || !!errDays || !!errApr || !!busy}
            data-action="post"
          >
            {busy === "post" ? "Posting offer" : "Post offer"}
          </button>
          </div>
          {block && <p className="cv-field__hint app-block">{block}</p>}
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
                  <th>Collateral</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mine.length === 0 && (
                  <tr>
                    <td colSpan={6} className="app-empty">
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
                    <td>{assetBySac(o.collateral_asset).code}</td>
                    <td className="r">
                      <button
                        type="button"
                        className="cv-btn cv-btn--secondary cv-btn--sm"
                        disabled={!!busy}
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
  const [showClosed, setShowClosed] = useState(false);
  const mine = signer ? repos.filter((r) => r.borrower === signer.address || r.lender === signer.address) : [];
  const live = (r: Repo) => r.status === "Open" || r.status === "MarginCall";
  // Closed = settled with nothing left to do (Repaid, Liquidated). Defaulted stays: the lender is still waiting on liquidation.
  const closedCount = mine.filter(isClosed).length;
  const shown = showClosed ? mine : mine.filter((r) => !isClosed(r));
  // One primary button per view: a margin call's Top up outranks every Repay.
  const anyMarginCall = mine.some((r) => r.status === "MarginCall" && r.borrower === signer?.address);
  const firstRepayable = anyMarginCall ? undefined : mine.find((r) => (live(r) || r.status === "Defaulted") && r.borrower === signer?.address)?.id;
  const showDesk = !!signer && (liquidatorOk || roleOf(signer.address) === "liquidator");

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">My positions</h1>
        <span className="small app-muted">Loans you have borrowed or lent.</span>
        {closedCount > 0 && (
          <button
            type="button"
            className={`cv-btn cv-btn--secondary cv-btn--sm app-section__toggle${showClosed ? " is-active" : ""}`}
            aria-pressed={showClosed}
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? `Hide closed (${closedCount})` : `Show closed (${closedCount})`}
          </button>
        )}
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
      {signer && loaded && mine.length > 0 && shown.length === 0 && <p className="app-empty">No open repos. Closed repos are hidden.</p>}
      <div className="app-cards">
        {config &&
          shown.map((r) => (
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
            Once a loan is {String(config.grace_secs)} s overdue, anyone can mark it defaulted. Approved liquidators can then buy its
            collateral at a {fmtPct(config.liquidation_discount_bps, 1)} discount.
            <Tip>
              Price paid = NAV × (1 − {fmtPct(config.liquidation_discount_bps, 1)}). The lender is repaid first; anything left goes back to
              the borrower.
            </Tip>
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
                  const token = assetBySac(r.collateral_asset);
                  const rNav = ctx.navs[r.collateral_asset] ?? null;
                  // check_margin, liquidate and a missed-call default all need a NAV the contract accepts.
                  const rBlock = navBlock(token.code, ctx.health(r.collateral_asset), ctx.assets[r.collateral_asset] ?? null);
                  const marginMissed = r.status === "MarginCall" && r.margin_call_deadline !== null && ctx.now > Number(r.margin_call_deadline);
                  const matured = ctx.now > Number(r.maturity_ts + config.grace_secs);
                  const defaultable = live(r) && (matured || marginMissed);
                  // Maturity defaults never read the NAV; a missed-call default re-checks it (#20).
                  const defaultBlock = defaultable && !matured ? rBlock : null;
                  return (
                    <tr key={String(r.id)}>
                      <td className="cv-num">#{String(r.id).padStart(3, "0")}</td>
                      <td className="r cv-num">{fmtAmount(r.principal + r.interest)}</td>
                      <td className="r cv-num">{fmtAmount(r.collateral_amount, 2, token.decimals)} {token.code}</td>
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
                            disabled={!!ctx.busy || !!rBlock || !ctx.approved}
                            title={rBlock ?? "Raise a margin call if cover is below 100%"}
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
                            disabled={!defaultable || !!defaultBlock || !!ctx.busy || !ctx.approved}
                            title={!defaultable ? "Before maturity plus grace, and no missed margin call" : (defaultBlock ?? "")}
                            onClick={async () => {
                              const out = await ctx.run(`default-${r.id}`, `Repo #${r.id} not defaulted`, () => chain.declareDefault(signer!, r.id));
                              if (out)
                                setNotice({
                                  text: out.value === "Open" ? `Repo #${r.id} margin call cleared: NAV back above the margin line` : `Repo #${r.id} defaulted`,
                                  hash: out.hash,
                                });
                            }}
                          >
                            Declare default
                          </button>
                        )}
                        {r.status === "Defaulted" && (
                          <button
                            type="button"
                            className="cv-btn cv-btn--danger cv-btn--sm"
                            disabled={!liquidatorOk || !!ctx.busy || !!rBlock || !ctx.canHold(r.collateral_asset)}
                            title={rBlock ?? (token.kind === "spiko" ? `${token.code} only moves to allowlisted wallets: the issuer must allowlist you` : "")}
                            onClick={async () => {
                              const out = await ctx.run(`liq-${r.id}`, `Repo #${r.id} not liquidated`, () => chain.liquidate(signer!, r.id));
                              if (out)
                                setReceipt({
                                  left: { eyebrow: "Liquidator delivers", amount: rNav ? fmtAmount((collateralValue(r.collateral_amount, rNav.price, collateralDecimals(rNav.decimals, token.decimals)) * (BPS - config.liquidation_discount_bps) + BPS - 1n) / BPS) : "—", unit: "USDC", hint: "to lender, fee, borrower" },
                                  right: { eyebrow: "Liquidator receives", amount: fmtAmount(r.collateral_amount, 2, token.decimals), unit: token.code, hint: `from Repo #${r.id}` },
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

function isClosed(r: Repo) {
  return r.status === "Repaid" || r.status === "Liquidated";
}

function PositionCard({ ctx, repo, primary, onRepaid }: { ctx: Ctx; repo: Repo; primary: boolean; onRepaid: (r: Receipt) => void }) {
  const { signer, config, balances, busy, now } = ctx;
  const token = assetBySac(repo.collateral_asset);
  // Repay, top-up and auto-repay move this repo's collateral: gate on its issuer only.
  const mayHold = ctx.canHold(repo.collateral_asset);
  const holdBlock = collateralBlock(ctx.balances, token) ?? "";
  const nav = ctx.navs[repo.collateral_asset] ?? null;
  const navH = ctx.health(repo.collateral_asset);
  // top_up clears a call only on an in-band NAV (#31); a missed-call default needs a fresh, in-band one (#20).
  const topUpHold = topUpHoldText(token.code, navH);
  const defaultHold = navBlock(token.code, navH, ctx.assets[repo.collateral_asset] ?? null);
  const dec = nav ? collateralDecimals(nav.decimals, token.decimals) : 0;
  const amt = (v: bigint) => fmtAmount(v, 2, token.decimals);
  const held = balances ? chain.holding(balances, repo.collateral_asset).amount : null;
  const side = signer?.address === repo.borrower ? "borrowed" : "lent";
  const debt = repo.principal + repo.interest;
  // Cover vs the asset's margin-call line (DECISIONS.md #14, #26); a pre-#26
  // contract triggers on the liquidation discount.
  const triggerBps = ctx.assets[repo.collateral_asset]?.margin_trigger_bps ?? config?.liquidation_discount_bps ?? null;
  const cover = useMemo(() => {
    if (!nav || triggerBps === null) return null;
    return coverPct(collateralValue(repo.collateral_amount, nav.price, dec), debt, triggerBps);
  }, [nav, dec, triggerBps, repo, debt]);
  const coverRef = useFlash(cover, (a, b) => (b > a ? "up" : b < a ? "down" : undefined));
  // Top-up to clear a margin call: back to initial margin at the repo's own haircut (DECISIONS.md #20).
  const topUpNeed = useMemo(() => {
    if (!nav) return null;
    const need = requiredCollateral(debt, nav.price, dec, repo.haircut_bps) - repo.collateral_amount;
    return need > 0n ? need : 0n;
  }, [nav, dec, debt, repo]);
  const [topUpInput, setTopUpInput] = useState<string | null>(null);
  if (!config) return null;
  const live = repo.status === "Open" || repo.status === "MarginCall";
  // repay also works out of Defaulted until a liquidation lands; top-up and auto-repay do not.
  const repayable = live || repo.status === "Defaulted";
  const inMarginCall = repo.status === "MarginCall";
  const deadline = repo.margin_call_deadline !== null ? Number(repo.margin_call_deadline) : null;
  const toDeadline = deadline !== null ? deadline - now : null;
  const breached = cover !== null && cover < 100;
  const fill = cover === null ? 0 : Math.min(100, Math.max(0, ((cover - 90) / 20) * 100));
  const toMaturity = Number(repo.maturity_ts) - now;
  const canRepay = repayable && side === "borrowed";
  // Past maturity + grace (strict, as in the contract) the repo waits for a keeper tx (#31).
  const pastGrace = live && now > Number(repo.maturity_ts + config.grace_secs);
  // Only the lender declares default; the contract's `default` auto-repays an opted-in borrower first.
  const canDeclareDefault = pastGrace && !!signer && side === "lent";
  const short = canRepay && balances?.usdc !== null && balances?.usdc !== undefined && balances.usdc < debt;
  const canTopUp = live && canRepay && (inMarginCall || breached);
  const topUpText = topUpInput ?? (topUpNeed !== null && topUpNeed > 0n ? amt(topUpNeed).replace(/,/g, "") : "");
  const topUpAmount = parseAmount(topUpText, token.decimals);
  const topUpErr = topUpAmount === null || topUpAmount <= 0n ? `Enter an amount above 0.00 ${token.code}.` : null;
  const topUpShort =
    !topUpErr && held !== null && topUpAmount !== null && held < topUpAmount ? `You hold ${amt(held)} ${token.code}.` : null;

  const doTopUp = async () => {
    if (!signer || topUpAmount === null || topUpErr) return;
    const out = await ctx.run(`topup-${repo.id}`, `Repo #${repo.id} not topped up`, () => chain.topUp(signer, repo.id, topUpAmount));
    if (out) {
      setTopUpInput(null);
      ctx.setFlash({
        tone: "info",
        title: `Topped up Repo #${String(repo.id).padStart(3, "0")}`,
        body: `Added ${amt(topUpAmount)} ${token.code}. ${inMarginCall ? (topUpHold ?? "The margin call clears once collateral is back at the initial margin.") : ""}`,
      });
    }
  };

  const toggleAuto = async (enabled: boolean) => {
    if (!signer) return;
    await ctx.run(`auto-${repo.id}`, `Auto-repay not ${enabled ? "turned on" : "turned off"}`, () => chain.setAutoRepay(signer, repo.id, enabled));
  };

  const doDeclareDefault = async () => {
    if (!signer) return;
    const out = await ctx.run(`declare-${repo.id}`, `Repo #${repo.id} not defaulted`, () => chain.declareDefaultPastGrace(signer, repo));
    if (out)
      ctx.setFlash({
        tone: "info",
        title: out.value === "Repaid" ? `Repo #${String(repo.id).padStart(3, "0")} repaid` : `Repo #${String(repo.id).padStart(3, "0")} defaulted`,
        body:
          out.value === "Repaid"
            ? `The borrower had auto-repay on: it pulled ${fmtAmount(debt)} USDC from them and your loan is repaid.`
            : `Marked defaulted. A whitelisted liquidator can now buy the ${token.code}.`,
      });
  };

  const doRepay = async () => {
    if (!signer) return;
    const out = await ctx.run(`repay-${repo.id}`, `Repo #${repo.id} not repaid`, () => chain.repay(signer, repo.id));
    if (out)
      onRepaid({
        left: { eyebrow: "Borrower delivers", amount: fmtAmount(debt), unit: "USDC", hint: "principal plus interest" },
        right: { eyebrow: "Borrower receives", amount: amt(repo.collateral_amount), unit: token.code, hint: `from Repo #${repo.id}` },
        sentence: `Repo #${repo.id} repaid. Settled atomically in one transaction`,
        hash: out.hash,
        stamp: { word: "Repaid", sub: fmtAmount(debt), repaid: true },
      });
  };

  return (
    <article className={`cv-card${isClosed(repo) ? " app-card--closed" : ""}`} data-repo={String(repo.id)}>
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
              ? inMarginCall
                ? `Add ${amt(topUpNeed)} ${token.code}${toDeadline !== null ? ` within ${fmtCountdown(Math.max(0, toDeadline), Number(config.day_secs))}` : ""} or the repo can be defaulted.`
                : `Add ${amt(topUpNeed)} ${token.code} now to stay clear of a margin call.`
              : "Repay, or wait for the next NAV."
            : inMarginCall
              ? "The borrower has until the deadline to add collateral; after it, anyone can default the repo."
              : "A margin call can be raised on the next check."}
          {inMarginCall && side === "borrowed" && topUpHold && <span data-hint="topup-hold"> {topUpHold}</span>}
          {inMarginCall && side !== "borrowed" && defaultHold && (
            <span data-hint="default-hold"> Until the price is accepted again the missed call cannot be defaulted; a default at maturity still works.</span>
          )}
        </Alert>
      )}
      {repo.status === "Defaulted" && (
        <Alert tone="info" title="Awaiting liquidation">
          {side === "lent"
            ? `The borrower did not repay. A whitelisted liquidator buys the collateral at NAV less ${fmtPct(config.liquidation_discount_bps, 1)}, and that USDC pays you first, up to the ${fmtAmount(debt)} USDC debt. Until then the borrower can still repay you in full.`
            : `This repo was defaulted. Until a whitelisted liquidator buys the collateral you can still repay ${fmtAmount(debt)} USDC and get it all back; after a liquidation, any surplus over the debt comes back to you.`}
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
          <dd>{amt(repo.collateral_amount)} {token.code}</dd>
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
            {repo.status === "Defaulted" ? "Liquidation pending" : !live ? "Closed" : inMarginCall && toDeadline !== null ? (toDeadline > 0 ? "Top up within" : "Margin window over") : toMaturity > 0 ? "Matures in" : pastGrace ? "Grace over" : "Matured, grace ends in"}
          </span>
          {live && !(pastGrace && !inMarginCall) && (
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
            disabled={!!busy || !!short || !mayHold}
            title={mayHold ? "" : holdBlock}
            onClick={doRepay}
            data-action="repay"
          >
            {busy === `repay-${repo.id}` ? "Repaying" : "Repay"}
          </button>
        )}
        {canDeclareDefault && (
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            disabled={!!busy}
            title="Sends default: if the borrower opted in to auto-repay it pulls the debt first, else the repo is marked defaulted for liquidation"
            onClick={doDeclareDefault}
            data-action="declare-default"
          >
            {busy === `declare-${repo.id}` ? "Declaring" : "Declare default"}
          </button>
        )}
      </div>
      {ctx.tx?.key === `repay-${repo.id}` && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
      {ctx.tx?.key === `declare-${repo.id}` && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
      {pastGrace && side === "borrowed" && (
        <p className="cv-field__hint" data-hint="grace-over">
          Grace is over. Repay now to keep your collateral.
        </p>
      )}
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
            suffix={token.code}
            error={topUpErr ?? topUpShort}
            hint={
              inMarginCall && topUpHold
                ? "Accepted, but it does not clear the margin call while the price is on hold."
                : topUpNeed !== null && nav
                ? (
                    <>
                      Add {amt(topUpNeed)} {token.code} to {inMarginCall ? "clear the margin call" : "restore the starting buffer"}.
                      <Tip>
                        This brings the loan back to its starting safety buffer: a {fmtPct(repo.haircut_bps, 1)} haircut at today&apos;s price
                        (NAV {fmtNav(nav.price, nav.decimals)}).
                      </Tip>
                    </>
                  )
                : "Waiting for NAV."
            }
          />
          <button
            type="submit"
            className={`cv-btn ${inMarginCall ? "cv-btn--primary" : "cv-btn--secondary"}`}
            disabled={!!busy || !!topUpErr || !!topUpShort || !mayHold}
            title={mayHold ? "" : holdBlock}
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
            : `Repay ${fmtAmount(debt)} USDC to close Repo #${String(repo.id).padStart(3, "0")} and get ${amt(repo.collateral_amount)} ${token.code} back.`}
        </p>
      )}
      {live && canRepay && (
        <AutoRepayToggle
          checked={repo.auto_repay}
          disabled={!!busy || !mayHold}
          busy={busy === `auto-${repo.id}`}
          onChange={toggleAuto}
          hint={
            repo.auto_repay
              ? short
                ? `On, but this wallet is short: hold ${fmtAmount(debt)} USDC by maturity or the repo defaults.`
                : `On: at maturity ${fmtAmount(debt)} USDC is pulled from this wallet and your ${token.code} comes back.`
              : `Off: if you do not repay by maturity plus ${String(config.grace_secs)} s grace, your ${token.code} is sold at NAV − ${fmtPct(config.liquidation_discount_bps, 1)}.`
          }
        />
      )}
      {ctx.tx?.key === `auto-${repo.id}` && <TxProgress tx={ctx.tx} demo={signer?.kind === "demo"} />}
      {!repayable && side === "borrowed" && <p className="cv-field__hint">{OUTCOME[repo.status]?.(repo, config)}</p>}
    </article>
  );
}

/** What a settled repo meant for the borrower, so a closed card never just says "Closed". */
const OUTCOME: Partial<Record<Status, (r: Repo, c: ProtocolConfig) => string>> = {
  Repaid: (r) => `Repaid. ${fmtAmount(r.collateral_amount, 2, assetBySac(r.collateral_asset).decimals)} ${assetBySac(r.collateral_asset).code} returned to this wallet.`,
  Liquidated: (r, c) =>
    `Liquidated: not repaid in time, so the ${assetBySac(r.collateral_asset).code} was sold at NAV − ${fmtPct(c.liquidation_discount_bps, 1)}. The surplus over the debt was paid to this wallet.`,
};

function AutoRepayToggle({ checked, disabled, busy, onChange, hint }: { checked: boolean; disabled?: boolean; busy?: boolean; onChange: (v: boolean) => void; hint: string }) {
  return (
    <label className="app-check" aria-busy={busy || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} data-action="auto-repay" />
      <span>
        <span className="app-check__label">{busy ? "Updating auto-repay" : "Auto-repay at maturity"}</span>
        <span className="cv-field__hint">{hint}</span>
      </span>
    </label>
  );
}

// --- Admin: NAV slider ---------------------------------------------------------------

function AdminView({ ctx, isAdmin }: { ctx: Ctx; isAdmin: boolean }) {
  const { signer, busy } = ctx;
  const [sac, setSac] = useState(COLLATERAL[0].sac);
  const token = assetBySac(sac);
  const nav = ctx.navs[sac] ?? null;
  const asset = ctx.assets[sac] ?? null;
  const [value, setValue] = useState<number | null>(null);
  const [last, setLast] = useState<{ nav: string; hash: string } | null>(null);
  const current = nav ? Number(nav.price) / 10 ** nav.decimals : 1;
  const v = value ?? current;
  const decimals = nav?.decimals ?? 14;
  const scaledV = BigInt(Math.round(v * 10_000)) * 10n ** BigInt(decimals - 4);
  // After the push the band window is this price plus the 19 newest records (#31).
  const willHold =
    asset && value !== null ? !checkBand(scaledV, (ctx.histories[sac] ?? []).slice(0, 19), asset).ok : false;

  const push = async () => {
    if (!signer) return;
    const scaled = scaledV;
    const out = await ctx.run("nav", "NAV not updated", () => chain.setNav(signer, scaled, sac));
    if (out) {
      setLast({ nav: `${token.code} ${v.toFixed(4)}`, hash: out.hash });
      setValue(null);
    }
  };

  return (
    <section className="app-section">
      <div className="app-section__head">
        <h1 className="title">Demo NAV</h1>
        <span className="small app-muted">
          Set the test price of a collateral token. New loans and liquidations only work if its price was updated in the last{" "}
          {asset ? Number(asset.max_nav_age_secs) / 60 : 3} minutes.
          <Tip>
            Sends the price to the mock price feed (SEP-40, set_price). On mainnet this comes from the fund&apos;s published NAV, not
            from an admin.
          </Tip>
        </span>
      </div>
      {!isAdmin && (
        <Alert tone="info" title="Admin only">
          {`Only the oracle admin ${ACCOUNTS.admin.slice(0, 4)}…${ACCOUNTS.admin.slice(-4)} can set the price.`}{" "}
          {DEMO_ENABLED ? "Pick the Admin demo account above." : ""}
        </Alert>
      )}
      <div className="cv-card cv-stack app-admin">
        {COLLATERAL.length > 1 && (
          <label className="cv-field">
            <span className="cv-field__label">Asset</span>
            <span className="cv-field__control">
              <select
                value={sac}
                onChange={(e) => {
                  setSac(e.target.value);
                  setValue(null);
                }}
                className="app-select"
                data-testid="nav-asset"
              >
                {COLLATERAL.map((a) => (
                  <option key={a.sac} value={a.sac}>
                    {a.code}
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}
        <label className="cv-field">
          <span className="cv-field__label">{token.code} NAV</span>
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
            Last update: {nav ? fmtNav(nav.price, nav.decimals) : "—"}
            {nav ? ` at ${new Date(Number(nav.timestamp) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Push the
            same price again to keep it fresh.
          </span>
          {willHold && (
            <span className="cv-field__hint app-block" data-hint="push-hold">
              This price is outside the {token.code} sanity band against its recent prices: pushing it puts the price on hold, pausing new
              loans, margin checks and liquidations.
            </span>
          )}
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
