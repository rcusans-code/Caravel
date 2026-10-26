import { useCallback, useEffect, useRef, useState } from "react";
import lockup from "../../design/logos/caravel-lockup.svg";
import { COLLATERAL, DEMO_ENABLED, DEMO_ROLES, ORACLE_ID, REPO_ID, assetBySac, type DemoRole } from "./config";
import * as chain from "./chain";
import type { AssetConfig, Balances, FeedReading, InKindClaim, Nav, Offer, ProtocolConfig, Repo } from "./chain";
import { explain } from "./errors";
import { Alert, TxHash, type TxState } from "./ui";
import { onPhase } from "./txphase";
import { txHashOf } from "./txerror";
import { collateralBlock, ledgerNow, navHealth, navHoldText, type BandCandidate, type PricePoint } from "./gates";
import { connectWallet, demoSigner, disconnectWallet, restoreSession, type Signer } from "./wallet";
import { demoTab, parseHash, shownTab, toHash, type Route, type Tab } from "./route";
import type { Ctx, Flash } from "./ctx";
import { AccountAlerts, AccountChip, BalanceFigures } from "./shell/Account";
import { DemoInfo, LiveFeedStatus, NavStatus } from "./shell/Status";
import { AdminView } from "./views/Admin";
import { LendView } from "./views/Lend";
import { OffersView } from "./views/Offers";
import { PositionsView } from "./views/Positions";

const nowSecs = () => Math.floor(Date.now() / 1000);

const isAdminNow = (signer: Signer | null, config: ProtocolConfig | null) =>
  !!(signer && config && signer.address === config.admin);
/** Marketing landing page (site/), served at the root of the same Pages site; the app lives under /app/. */
const LANDING_URL = "/";

export default function App() {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [config, setConfig] = useState<ProtocolConfig | null>(null);
  // Per collateral token (config.ts COLLATERAL), keyed by token contract id.
  const [assets, setAssets] = useState<Record<string, AssetConfig | null>>({});
  const [navs, setNavs] = useState<Record<string, Nav | null>>({});
  // Live SEP-40 reference feed: undefined = loading, null = feed has no price, Error = read failed.
  const [live, setLive] = useState<FeedReading | null | Error | undefined>(undefined);
  // The feed's last 20 prices per collateral (oracle `prices`), for the NAV band check (#31).
  const [histories, setHistories] = useState<Record<string, PricePoint[] | null>>({});
  // The repo's band settle level per collateral (band_candidate); null = none / contract without the view.
  const [candidates, setCandidates] = useState<Record<string, BandCandidate | null>>({});
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
  // Collateral an in-kind claim could not push to this account, per token id, waiting for claim_collateral().
  const [parked, setParked] = useState<Record<string, bigint>>({});
  // ClaimedInKind events by repo id (#38): null = not read yet (or the read failed), so closed cards say neither "sold" nor "in kind".
  const [inKind, setInKind] = useState<Map<string, InKindClaim> | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Tab in the URL hash (route.ts, issue #37): read on load, followed on back/forward and hand edits.
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash).route);
  // restoreSession() has answered, so a reload on #admin is not bounced before the admin wallet is back.
  const [restored, setRestored] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(nowSecs());
  // Ledger time, not the browser clock: the contract judges NAV age, maturity
  // and margin deadlines against the ledger close time.
  const now = ledgerNow(tick, ledger);
  const [tx, setTx] = useState<TxState | null>(null);
  // Hash of the write in flight, from the moment the network accepts it (DW-02).
  const submitted = useRef<string | null>(null);

  // TxProgress: chain.ts reports sign / submit; prepare is set when a write starts.
  useEffect(() => {
    onPhase((p, hash) => {
      if (hash) submitted.current = hash;
      setTx((t) => (t ? { ...t, step: p === "sign" ? 1 : p === "submit" ? 2 : 0, ...(hash ? { hash } : {}) } : t));
    });
    return () => onPhase(null);
  }, []);

  // --- data ---------------------------------------------------------------------
  const refreshMarket = useCallback(async () => {
    // Read apart from the book: a failing reference feed must not flag testnet as down.
    chain.getLiveFeed().then(setLive, (e) => setLive(e instanceof Error ? e : new Error(String(e))));
    try {
      const [n, book, d, h, bc] = await Promise.all([
        Promise.all(COLLATERAL.map((a) => chain.getNav(a.sac))),
        chain.getBook(),
        Promise.all(COLLATERAL.map((a) => chain.getOpenDebt(a.sac))),
        // Band and clock reads never block the board: on failure the app falls
        // back to the last price only and the browser clock.
        Promise.all(COLLATERAL.map((a) => chain.getNavHistory(a.sac).catch(() => null))),
        Promise.all(COLLATERAL.map((a) => chain.getBandCandidate(a.sac))),
        chain
          .getLedgerTime()
          .then((closeTime) => setLedger({ closeTime, at: nowSecs() }))
          .catch(() => undefined),
      ]);
      setNavs(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, n[i]])));
      setHistories(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, h[i]])));
      setCandidates(Object.fromEntries(COLLATERAL.map((a, i) => [a.sac, bc[i]])));
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
      const [b, l, c, p] = await Promise.all([
        chain.getBalances(signer.address),
        chain.isLiquidator(signer.address),
        chain.getClaimable(signer.address),
        chain.getClaimableCollateral(signer.address),
      ]);
      setBalances(b);
      setLiquidatorOk(l);
      setClaimable(c);
      setParked(p);
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

  // Sale or in-kind claim? Only the event says; re-read when a repo turns Liquidated (retry on a failed read).
  const liquidatedKey = repos.filter((r) => r.status === "Liquidated").map((r) => String(r.id)).join(",");
  const [inKindTry, setInKindTry] = useState(0);
  useEffect(() => {
    if (!liquidatedKey) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    chain.getInKindClaims().then(setInKind, (e) => {
      console.warn("ClaimedInKind events not read", e);
      retry = setTimeout(() => setInKindTry((n) => n + 1), 20_000);
    });
    return () => clearTimeout(retry);
  }, [liquidatedKey, inKindTry]);

  useEffect(() => {
    setBalances(null);
    setClaimable(0n);
    setParked({});
    refreshAccount();
    const t = setInterval(refreshAccount, 10_000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // --- session ------------------------------------------------------------------
  // Page reload: pick the last wallet or demo account back up without a popup.
  useEffect(() => {
    restoreSession()
      .then((s) => s && setSigner((cur) => cur ?? s))
      // The restored wallet moved off Testnet: it is disconnected, say so (Raven DW-06).
      .catch((e) => setFlash({ tone: "error", title: "Wallet disconnected", body: e instanceof Error ? e.message : String(e) }))
      .finally(() => setRestored(true));
  }, []);

  // --- route (URL hash) ---------------------------------------------------------
  // Tab clicks push a history entry, so back returns to the previous tab; automatic
  // moves (fallbacks, closing after a take) replace the current one.
  const navigate = useCallback((r: Route, replace = false) => {
    const h = toHash(r);
    if (location.hash !== h) history[replace ? "replaceState" : "pushState"](null, "", h);
    setRoute(r);
  }, []);
  useEffect(() => {
    const follow = () => {
      const { route: r, known } = parseHash(location.hash);
      if (!known) history.replaceState(null, "", toHash(r)); // unknown hash -> #offers
      setRoute(r);
    };
    follow();
    // pushState entries fire popstate on back/forward; a typed or <a href="#…"> hash fires hashchange.
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("popstate", follow);
    };
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
    navigate({ tab: demoTab(role) });
  };
  const onDisconnect = async () => {
    await disconnectWallet(); // also forgets the demo role, so reload stays logged out
    setSigner(null);
    setBalances(null);
    setClaimable(0n);
    setParked({});
    setFlash(null);
  };

  // One runner for every write: busy label, error mapping, refresh after.
  // The hash of a tx that reached the network stays on screen after a failure (DW-02).
  const run = async <T,>(key: string, title: string, fn: () => Promise<T>): Promise<T | null> => {
    submitted.current = null;
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
      setFlash({ tone: "error", title, body: explain(e, navAges), hash: txHashOf(e) ?? submitted.current });
      return null;
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  // #admin for a non-admin falls back to #offers once the session and config are known
  // (until then shownTab already renders Offers).
  useEffect(() => {
    if (route.tab === "admin" && restored && config && !isAdminNow(signer, config)) navigate({ tab: "offers" }, true);
  }, [route.tab, restored, signer, config, navigate]);

  // NAV state per asset, in the contract's order: no price, future-dated,
  // stale (#25, per asset; getAssetConfig falls back to config().max_nav_age_secs
  // on contracts deployed before it), outside the sanity band (#31).
  // The settle path (band_candidate held band_settle_secs) passes a level the window still refuses.
  const health = (sac: string) =>
    navHealth(navs[sac] ?? null, histories[sac] ?? null, assets[sac] ?? null, now, candidates[sac] ?? null);
  const isAdmin = isAdminNow(signer, config);
  const tab = shownTab(route, isAdmin);
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
    candidates,
    openDebt,
    health,
    balances,
    busy,
    tx,
    now,
    run,
    setFlash,
    refreshAll,
    inKind,
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
            <LiveFeedStatus live={live} now={now} />
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
            parked={parked}
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
            {flash.hash && (
              <>
                {" "}
                <TxHash kind="TX" value={flash.hash} />
              </>
            )}
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
              onClick={() => navigate({ tab: t })}
              data-tab={t}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "offers" && (
          <OffersView
            ctx={ctx}
            offers={offers}
            loaded={loaded}
            selected={route.tab === "offers" ? route.offer ?? null : null}
            onSelect={(id, replace) => navigate(id === null ? { tab: "offers" } : { tab: "offers", offer: id }, replace)}
          />
        )}
        {tab === "lend" && <LendView ctx={ctx} offers={offers} />}
        {tab === "positions" && (
          <PositionsView ctx={ctx} repos={repos} liquidatorOk={liquidatorOk} loaded={loaded} linked={route.tab === "positions" ? route.repo ?? null : null} />
        )}
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
