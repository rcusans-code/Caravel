// Borrow requests (contracts/repo/src/request.rs): the borrower posts the loan it
// wants with its collateral escrowed; a lender funds it in one atomic DvP.
//   RequestsBoard: the market board under Offers, with Fund for lenders.
//   RequestView:   the #request tab, "Request a loan" form + the borrower's open requests.
import { useState } from "react";
import { COLLATERAL, assetBySac, roleOf } from "../config";
import * as chain from "../chain";
import type { BorrowRequest } from "../chain";
import {
  BPS,
  collateralDecimals,
  collateralValue,
  fmtAmount,
  fmtNav,
  fmtPct,
  fmtTerm,
  idRef,
  interest as calcInterest,
  parseAmount,
  requiredCollateral,
} from "../format";
import { DvpReceipt, Field, Skel, Tip, TxHash, TxSlot } from "../ui";
import { collateralBlock, pauseBlock, takeNavBlock, usdcBlock } from "../gates";
import { CONNECT, type Ctx, type Receipt } from "../ctx";

/** Debt, collateral needed at the current NAV and the implied LTV of posting `posted` against it. */
function terms(ctx: Ctx, asset: string, principal: bigint, aprBps: bigint, termSecs: bigint, posted: bigint) {
  const { config } = ctx;
  const cfg = ctx.assets[asset] ?? null;
  const nav = ctx.navs[asset] ?? null;
  const token = assetBySac(asset);
  const debt = config ? principal + calcInterest(principal, aprBps, termSecs, config.day_secs) : null;
  const dec = nav ? collateralDecimals(nav.decimals, token.decimals) : 0;
  const required = debt !== null && nav && cfg && nav.price > 0n ? requiredCollateral(debt, nav.price, dec, cfg.haircut_bps) : null;
  const value = nav && nav.price > 0n ? collateralValue(posted, nav.price, dec) : null;
  const ltvBps = debt !== null && value ? (debt * BPS) / value : null;
  return { cfg, nav, token, debt, required, ltvBps, maxLtvBps: cfg ? BPS - cfg.haircut_bps : null };
}

/** Why a lender cannot fund `q` right now, or null. Mirrors fill_request's checks, in its order. */
function fundBlock(ctx: Ctx, q: BorrowRequest, t: ReturnType<typeof terms>): string | null {
  const { signer, balances, openDebt } = ctx;
  const { cfg, token, debt, required } = t;
  if (!signer) return `${CONNECT} to fund a request.`;
  if (signer.address === q.borrower) return "Your own request. Cancel it from Request a loan.";
  if (!cfg || !cfg.enabled) return `${token.code} is disabled as collateral right now.`;
  if (pauseBlock(token.code, cfg)) return pauseBlock(token.code, cfg);
  if (takeNavBlock(token.code, ctx.health(q.collateral_asset), cfg)) return takeNavBlock(token.code, ctx.health(q.collateral_asset), cfg);
  if (required !== null && q.collateral_amount < required)
    return `Collateral short at the current NAV: needs ${fmtAmount(required, 2, token.decimals)} ${token.code}, ${fmtAmount(q.collateral_amount, 2, token.decimals)} posted.`;
  const cap = cfg.max_open_debt;
  const used = openDebt[q.collateral_asset] ?? null;
  if (debt !== null && cap !== null && used !== null && used + debt > cap)
    return `This loan would take ${token.code} past its exposure cap (${fmtAmount(used, 0)} of ${fmtAmount(cap, 0)} USDC used).`;
  if (balances && !balances.exists) return "Your account is not on testnet yet. Fund it with friendbot.";
  if (balances && balances.usdc === null) return "Add a USDC trustline first.";
  if (usdcBlock(balances)) return usdcBlock(balances);
  if (balances && balances.usdc !== null && balances.usdc < q.principal)
    return `You hold ${fmtAmount(balances.usdc)} USDC, less than ${fmtAmount(q.principal)} USDC.`;
  return null;
}

const ltvText = (t: ReturnType<typeof terms>) =>
  t.ltvBps === null ? "—" : `${fmtPct(t.ltvBps, 1)}${t.maxLtvBps !== null ? ` of ${fmtPct(t.maxLtvBps, 1)} max` : ""}`;

export function RequestsBoard({ ctx, requests, loaded }: { ctx: Ctx; requests: BorrowRequest[]; loaded: boolean }) {
  const { config, signer, busy } = ctx;
  const [receipt, setReceipt] = useState<Receipt>(null);
  const role = signer ? roleOf(signer.address) : null;
  const mayBorrow = !signer || !(role === "lender" || role === "liquidator" || role === "admin");

  const fund = async (q: BorrowRequest) => {
    if (!signer) return;
    const token = assetBySac(q.collateral_asset);
    const out = await ctx.run(`fund-${q.id}`, `Request ${idRef(q.id)} not funded`, () => chain.fillRequest(signer, q.id));
    if (out)
      setReceipt({
        left: { eyebrow: "Lender pays", amount: fmtAmount(q.principal), unit: "USDC", hint: "to the borrower" },
        right: { eyebrow: "Collateral held", amount: fmtAmount(q.collateral_amount, 2, token.decimals), unit: token.code, hint: `from Request ${idRef(q.id)}` },
        sentence: `Agreement ${idRef(out.value)} opened. Settled atomically in one transaction`,
        hash: out.hash,
        stamp: { word: "Settled", sub: `Agreement ${idRef(out.value)}` },
        link: { href: `#repo/${out.value}`, label: `View Agreement ${idRef(out.value)} →` },
      });
  };

  return (
    <section className="app-section" aria-label="Borrow requests">
      <div className="app-section__head">
        <h2 className="title">Borrow requests</h2>
        <span className="small app-muted">
          Loans borrowers asked for, at their rate. Each one is funded in full.
          <Tip>
            The borrower&apos;s collateral is already locked in the contract. Funding checks it against the current NAV and
            haircut, then pays your USDC to the borrower and opens the agreement in one transaction.
          </Tip>
        </span>
      </div>

      {receipt && <DvpReceipt {...receipt} onDismiss={() => setReceipt(null)} />}

      <div className="cv-table-wrap">
        <table className="cv-table app-requests" data-testid="requests-table" aria-busy={loaded ? undefined : "true"}>
          <thead>
            <tr>
              <th>Request</th>
              <th className="r">Amount</th>
              <th className="r">APR</th>
              <th className="r">Term</th>
              <th className="r">Collateral posted</th>
              <th className="r">
                LTV now
                <Tip>Debt (principal + full-term interest) over the posted collateral&apos;s value at the current NAV. Funding needs it at or under the max, 100% minus the haircut.</Tip>
              </th>
              <th>Borrower</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!loaded &&
              [0, 1].map((i) => (
                <tr key={`skel-${i}`} aria-hidden="true">
                  <td><Skel w={36} h={14} /></td>
                  <td className="r"><Skel w={80} h={14} /></td>
                  <td className="r"><Skel w={48} h={14} /></td>
                  <td className="r"><Skel w={40} h={14} /></td>
                  <td className="r"><Skel w={90} h={14} /></td>
                  <td className="r"><Skel w={60} h={14} /></td>
                  <td><Skel w={90} h={14} /></td>
                  <td></td>
                </tr>
              ))}
            {loaded && requests.length === 0 && (
              <tr className="app-requests__note">
                <td colSpan={8} className="app-empty">
                  No open borrow requests right now.
                  {mayBorrow && (
                    <>
                      {" "}
                      Post one from <a href="#request">Request a loan</a>.
                    </>
                  )}
                </td>
              </tr>
            )}
            {requests.map((q) => {
              const t = terms(ctx, q.collateral_asset, q.principal, q.apr_bps, q.term_secs, q.collateral_amount);
              const block = fundBlock(ctx, q, t);
              const short = t.required !== null && q.collateral_amount < t.required;
              return (
                <tr key={String(q.id)} data-request={String(q.id)}>
                  <td className="cv-num">{idRef(q.id)}</td>
                  <td className="r cv-num">
                    {fmtAmount(q.principal)} <span className="cv-unit app-phone">USDC</span>
                  </td>
                  <td className="r cv-num" style={{ color: "var(--brand)" }}>
                    {fmtPct(q.apr_bps)} <span className="cv-unit app-phone">APR</span>
                  </td>
                  <td className="r cv-num">{config ? fmtTerm(q.term_secs, config.day_secs) : "…"}</td>
                  <td className="r cv-num">
                    {fmtAmount(q.collateral_amount, 2, t.token.decimals)} <span className="cv-unit">{t.token.code}</span>
                  </td>
                  <td className="r cv-num" style={short ? { color: "var(--defaulted)" } : undefined} data-testid="request-ltv">
                    <span className="cv-unit app-phone">LTV</span> {ltvText(t)}
                  </td>
                  <td>
                    <TxHash kind="ACCOUNT" value={q.borrower} />
                  </td>
                  <td className="r">
                    <button
                      type="button"
                      className="cv-btn cv-btn--secondary cv-btn--sm"
                      disabled={!!block || !!busy}
                      title={block ?? undefined}
                      aria-busy={busy === `fund-${q.id}` ? "true" : undefined}
                      onClick={() => {
                        setReceipt(null);
                        void fund(q);
                      }}
                      data-action="fund"
                    >
                      {busy === `fund-${q.id}` ? "Funding…" : "Fund"}
                    </button>
                    {block && signer && (
                      <span className="small app-muted" style={{ display: "block", maxWidth: 240, marginLeft: "auto", whiteSpace: "normal" }} data-testid="fund-block">
                        {block}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TxSlot tx={ctx.tx} keys={requests.map((q) => `fund-${q.id}`)} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />
    </section>
  );
}

export function RequestView({ ctx, requests }: { ctx: Ctx; requests: BorrowRequest[] }) {
  const { config, signer, balances, busy } = ctx;
  const [collateral, setCollateral] = useState(COLLATERAL[0].sac);
  const token = assetBySac(collateral);
  const [posted, setPostedAmount] = useState("60.00");
  const [amount, setAmount] = useState("50.00");
  const [days, setDays] = useState("7");
  const [apr, setApr] = useState("5.00");
  const [done, setDone] = useState<{ id: bigint; hash: string } | null>(null);
  const [cancelled, setCancelled] = useState<{ id: bigint; hash: string } | null>(null);

  const principal = parseAmount(amount);
  const coll = parseAmount(posted, token.decimals);
  const dayCount = Number(days);
  const aprNum = Number(apr);
  const errAmount = principal === null || principal <= 0n ? "Enter an amount above 0.00 USDC." : null;
  const errColl = coll === null || coll <= 0n ? `Enter a ${token.code} amount above 0.` : null;
  const errDays = !Number.isFinite(dayCount) || dayCount <= 0 || !/^\d+(\.\d+)?$/.test(days) ? "Enter a term above 0 days." : null;
  const errApr =
    !Number.isFinite(aprNum) || aprNum < 0 || aprNum > 100 || !/^\d+(\.\d{1,2})?$/.test(apr)
      ? "Enter an APR between 0.00% and 100.00%, two decimals at most."
      : null;
  const termSecs = config && !errDays ? BigInt(Math.round(dayCount * Number(config.day_secs))) : 0n;
  const aprBps = errApr ? 0 : Math.round(aprNum * 100);
  const valid = !errAmount && !errColl && !errDays && !errApr;
  const t = terms(ctx, collateral, principal ?? 0n, BigInt(aprBps), termSecs, coll ?? 0n);
  const held = balances ? chain.holding(balances, collateral) : null;
  const amt = (v: bigint) => fmtAmount(v, 2, token.decimals);

  let block: string | null = null;
  if (!signer) block = `${CONNECT} to request a loan.`;
  else if (balances && !balances.exists) block = "Your account is not on testnet yet. Fund it with friendbot.";
  else if (balances && balances.usdc === null) block = "Add a USDC trustline to receive the loan.";
  else if (usdcBlock(balances)) block = usdcBlock(balances);
  else if (signer.kind !== "demo" && collateralBlock(balances, token)) block = collateralBlock(balances, token);
  else if (config && !t.cfg) block = `${token.code} is not registered as collateral on this deployment.`;
  else if (t.cfg && !t.cfg.enabled) block = `${token.code} is disabled as collateral right now.`;
  else if (pauseBlock(token.code, t.cfg)) block = pauseBlock(token.code, t.cfg);
  else if (held && coll !== null && (held.amount ?? 0n) < coll) block = `You hold ${amt(held.amount ?? 0n)} ${token.code}, less than ${amt(coll)} ${token.code}.`;
  else if (valid && t.required !== null && coll !== null && coll < t.required)
    block = `Post at least ${amt(t.required)} ${token.code}: below that no lender can fund this at the current NAV.`;

  // Required collateral rounded up to 2 dp, as the form shows it.
  const setToRequired = () => {
    if (t.required === null) return;
    const step = 10n ** BigInt(Math.max(0, token.decimals - 2));
    setPostedAmount(fmtAmount(((t.required + step - 1n) / step) * step, 2, token.decimals).replace(/,/g, ""));
  };

  const post = async () => {
    if (!signer || !valid || principal === null || coll === null) return;
    setDone(null);
    setCancelled(null);
    const out = await ctx.run("request", "Request not posted", () =>
      chain.createRequest(signer, { collateral, collateralAmount: coll, principal, aprBps, termSecs }),
    );
    if (out) setDone({ id: out.value, hash: out.hash });
  };
  const mine = signer ? requests.filter((q) => q.borrower === signer.address) : [];

  return (
    <section className="app-section app-lend">
      <div className="app-section__head">
        <h1 className="title">Request a loan</h1>
        <span className="small app-muted">
          Name your rate. Your collateral stays locked in the contract until a lender funds the request or you cancel it.
        </span>
      </div>
      <div className="app-lend__grid">
        <form
          className="cv-card cv-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <div className="app-lend__fields">
            <label className="cv-field">
              <span className="cv-field__label">Collateral</span>
              <span className="cv-field__control">
                <select value={collateral} onChange={(e) => setCollateral(e.target.value)} className="app-select" data-testid="request-collateral">
                  {COLLATERAL.map((a) => (
                    <option key={a.sac} value={a.sac}>
                      {a.code}
                      {ctx.assets[a.sac] ? ` · ${fmtPct(ctx.assets[a.sac]!.haircut_bps, 0)} haircut` : ""}
                    </option>
                  ))}
                </select>
              </span>
              <span className="cv-field__hint">
                {t.cfg ? `A lender lends up to ${fmtPct(BPS - t.cfg.haircut_bps, 1)} of its value at the NAV when funding.` : ""}
              </span>
            </label>
            <Field id="req-collateral" label="Collateral to lock" value={posted} onChange={setPostedAmount} suffix={token.code} error={errColl}
              hint={held?.amount != null ? `You hold ${amt(held.amount)} ${token.code}.` : "Held in escrow until funded or cancelled."} />
            <Field id="req-amount" label="Amount to borrow" value={amount} onChange={setAmount} suffix="USDC" error={errAmount}
              hint="Paid to you in full when a lender funds it." />
            <Field id="req-term" label="Term" value={days} onChange={setDays} suffix="days" error={errDays}
              hint={config ? `In the demo, ${days || "0"} days run in ${Math.max(1, Math.round(((Number(days) || 0) * Number(config.day_secs)) / 60))} min.` : ""} />
            <Field id="req-apr" label="Rate you offer" value={apr} onChange={setApr} suffix="% APR" error={errApr}
              hint="Fixed. Full interest is owed even if repaid early." />
          </div>
          <div className="app-lend__foot">
            <dl className="cv-terms">
              <div>
                <dt>Repay</dt>
                <dd>
                  {valid && t.debt !== null ? fmtAmount(t.debt) : "—"}
                  <span className="cv-unit">USDC</span>
                </dd>
              </div>
              <div>
                <dt>
                  Needed now
                  <Tip>
                    {t.nav && t.cfg
                      ? `Repay ÷ (NAV ${fmtNav(t.nav.price, t.nav.decimals)} × ${fmtPct(BPS - t.cfg.haircut_bps, 1)}), rounded up. A lender can fund the request while what you lock covers this at the NAV of that moment; if the NAV falls below it, funding fails and the request waits.`
                      : "Waiting for the NAV."}
                  </Tip>
                </dt>
                <dd data-testid="request-required">
                  {valid && t.required !== null ? amt(t.required) : "—"}
                  <span className="cv-unit">{token.code}</span>
                </dd>
              </div>
              <div>
                <dt>
                  LTV now
                  <Tip>All the collateral you lock backs the loan. More than needed is a cushion: fewer margin calls, and it all comes back when you repay.</Tip>
                </dt>
                <dd>{valid ? ltvText(t) : "—"}</dd>
              </div>
            </dl>
            <div className="cv-row">
              <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={setToRequired} disabled={!valid || t.required === null}>
                Lock the minimum
              </button>
              <button
                type="submit"
                className="cv-btn cv-btn--primary"
                disabled={!!block || !valid || !!busy}
                data-action="request"
              >
                {busy === "request" ? "Posting request" : "Post request"}
              </button>
            </div>
          </div>
          {block && (
            <p className="app-block" data-testid="request-block">
              <span className="app-block__icon" aria-hidden="true">!</span>
              <span>{block}</span>
            </p>
          )}
          <TxSlot tx={ctx.tx} keys={["request"]} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />
          {done && (
            <p className="cv-row small" data-testid="request-posted">
              Request {idRef(done.id)} posted <TxHash kind="TX" value={done.hash} />
            </p>
          )}
        </form>

        <div className="cv-stack">
          <h2 className="heading">Your open requests</h2>
          {cancelled && (
            <p className="cv-row small">
              Request {idRef(cancelled.id)} cancelled <TxHash kind="TX" value={cancelled.hash} />
            </p>
          )}
          <div className="cv-table-wrap">
            <table className="cv-table" data-testid="my-requests">
              <thead>
                <tr>
                  <th>Request</th>
                  <th className="r">Amount</th>
                  <th className="r">APR</th>
                  <th className="r">Term</th>
                  <th className="r">Locked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mine.length === 0 && (
                  <tr>
                    <td colSpan={6} className="app-empty">
                      {signer ? "No open requests from this account. Funded ones are in My positions." : `${CONNECT} to see your requests.`}
                    </td>
                  </tr>
                )}
                {mine.map((q) => {
                  const qt = terms(ctx, q.collateral_asset, q.principal, q.apr_bps, q.term_secs, q.collateral_amount);
                  const short = qt.required !== null && q.collateral_amount < qt.required;
                  return (
                    <tr key={String(q.id)}>
                      <td className="cv-num">{idRef(q.id)}</td>
                      <td className="r cv-num">{fmtAmount(q.principal)}</td>
                      <td className="r cv-num" style={{ color: "var(--brand)" }}>
                        {fmtPct(q.apr_bps)}
                      </td>
                      <td className="r cv-num">{config ? fmtTerm(q.term_secs, config.day_secs) : ""}</td>
                      <td className="r cv-num" style={short ? { color: "var(--defaulted)" } : undefined} title={short ? "Short at the current NAV: no lender can fund it until the NAV recovers. Cancel and repost with more." : undefined}>
                        {fmtAmount(q.collateral_amount, 2, qt.token.decimals)} <span className="cv-unit">{qt.token.code}</span>
                      </td>
                      <td className="r">
                        <button
                          type="button"
                          className="cv-btn cv-btn--secondary cv-btn--sm"
                          aria-label={`Cancel request ${idRef(q.id)}`}
                          disabled={!!busy}
                          aria-busy={busy === `cancel-req-${q.id}` ? "true" : undefined}
                          onClick={async () => {
                            setDone(null);
                            setCancelled(null);
                            const out = await ctx.run(`cancel-req-${q.id}`, `Request ${idRef(q.id)} not cancelled`, () => chain.cancelRequest(signer!, q.id));
                            if (out) setCancelled({ id: q.id, hash: out.hash });
                          }}
                        >
                          {busy === `cancel-req-${q.id}` ? "Signing…" : "Cancel"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TxSlot tx={ctx.tx} keys={mine.map((q) => `cancel-req-${q.id}`)} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />
        </div>
      </div>
    </section>
  );
}
