import { useState } from "react";
import * as chain from "../chain";
import { ACCOUNTS, COLLATERAL, DEMO_ENABLED, assetBySac } from "../config";
import type { Ctx } from "../ctx";
import { fmtNav } from "../format";
import { Alert, Tip, TxHash, TxProgress } from "../ui";

export function AdminView({ ctx, isAdmin }: { ctx: Ctx; isAdmin: boolean }) {
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

  const push = async () => {
    if (!signer) return;
    const scaled = BigInt(Math.round(v * 10_000)) * 10n ** BigInt(decimals - 4);
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
