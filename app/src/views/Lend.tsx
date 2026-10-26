import { useState } from "react";
import { COLLATERAL, assetBySac } from "../config";
import * as chain from "../chain";
import type { Offer } from "../chain";
import { BPS, fmtAmount, fmtPct, fmtTerm, idRef, interest as calcInterest, parseAmount, protocolFee } from "../format";
import { Field, TxHash, TxSlot } from "../ui";
import { CONNECT, type Ctx } from "../ctx";
import { pauseBlock, usdcBlock } from "../gates";

/** Full 7-decimal USDC, trailing zeros trimmed to 2 dp: the exact figure, on hover. */
const fmtExact = (v: bigint) => fmtAmount(v, 7).replace(/(\.\d\d\d*?)0+$/, "$1");
/** Summary figure: 2 dp like the rest of the app, 4 below 1 USDC so small interest stays visible. Rounded
 *  figures need not add up to the cent, so each carries its exact value in `title`. */
const fmtSummary = (v: bigint) => fmtAmount(v, v < 10_000_000n ? 4 : 2);

export function LendView({ ctx, offers }: { ctx: Ctx; offers: Offer[] }) {
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
  else if (usdcBlock(balances)) block = usdcBlock(balances);
  else if (balances && principal && balances.usdc !== null && balances.usdc < principal)
    block = `You hold ${fmtAmount(balances.usdc)} USDC, less than ${fmtAmount(principal)} USDC.`;
  else if (config && !asset) block = `${token.code} is not registered as collateral on this deployment.`;
  else if (asset && !asset.enabled) block = `${token.code} is disabled as collateral right now.`;
  else if (pauseBlock(token.code, asset)) block = pauseBlock(token.code, asset);

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
              <dd title={`${fmtExact(int)} USDC`}>
                {fmtSummary(int)}
                <span className="cv-unit">USDC</span>
              </dd>
            </div>
            <div>
              <dt>Protocol fee</dt>
              <dd title={`${fmtExact(fee)} USDC`}>
                {fmtSummary(fee)}
                <span className="cv-unit">USDC</span>
              </dd>
            </div>
            <div>
              <dt>Back at maturity</dt>
              <dd title={principal ? `${fmtExact(principal + int - fee)} USDC: principal + interest − fee` : undefined}>
                {principal ? fmtSummary(principal + int - fee) : "—"}
                <span className="cv-unit">USDC</span>
              </dd>
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
          {block && (
            <p className="app-block">
              <span className="app-block__icon" aria-hidden="true">!</span>
              <span>{block}</span>
            </p>
          )}
          <TxSlot tx={ctx.tx} keys={["post"]} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />
          {posted && (
            <p className="cv-row small" data-testid="posted">
              Offer {idRef(posted.id)} posted <TxHash kind="TX" value={posted.hash} />
            </p>
          )}
        </form>

        <div className="cv-stack">
          <h2 className="heading">Your open offers</h2>
          {cancelled && (
            <p className="cv-row small">
              Offer {idRef(cancelled.id)} cancelled <TxHash kind="TX" value={cancelled.hash} />
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
                      {signer ? "No open offers from this account." : `${CONNECT} to see your offers.`}
                    </td>
                  </tr>
                )}
                {mine.map((o) => (
                  <tr key={String(o.id)}>
                    <td className="cv-num">{idRef(o.id)}</td>
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
                        aria-label={`Cancel offer ${idRef(o.id)}`}
                        disabled={!!busy}
                        aria-busy={busy === `cancel-${o.id}` ? "true" : undefined}
                        onClick={async () => {
                          const out = await ctx.run(`cancel-${o.id}`, `Offer ${idRef(o.id)} not cancelled`, () => chain.cancelOffer(signer!, o.id));
                          if (out) setCancelled({ id: o.id, hash: out.hash });
                        }}
                      >
                        {busy === `cancel-${o.id}` ? "Signing…" : "Cancel"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TxSlot tx={ctx.tx} keys={mine.map((o) => `cancel-${o.id}`)} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />
        </div>
      </div>
    </section>
  );
}
