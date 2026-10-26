import { useEffect, useMemo, useState } from "react";
import { assetBySac, roleOf } from "../config";
import * as chain from "../chain";
import type { InKindClaim, ProtocolConfig, Repo, Status } from "../chain";
import { BPS, collateralDecimals, collateralValue, coverPct, effectiveTriggerBps, fmtAmount, fmtCountdown, fmtNav, fmtOwed, fmtPct, idRef, parseAmount, requiredCollateral } from "../format";
import { Alert, DvpReceipt, Field, Skel, StatusPill, Tip, TxHash, TxSlot, displayState, useFlash } from "../ui";
import { NAV_OUTAGE_DAYS, collateralBlock, fmtDuration, inKindWindow, navBlock, topUpHoldText, usdcBlock } from "../gates";
import { CONNECT, type Ctx, type Receipt } from "../ctx";

export function PositionsView({
  ctx,
  repos,
  liquidatorOk,
  loaded,
  linked,
}: {
  ctx: Ctx;
  repos: Repo[];
  liquidatorOk: boolean;
  loaded: boolean;
  /** Agreement to scroll to, from #repo/<id>. */
  linked: bigint | null;
}) {
  const { signer, config } = ctx;
  const [receipt, setReceipt] = useState<Receipt>(null);
  // The agreement a repay just settled stays on screen (muted) until its receipt is dismissed.
  const [settled, setSettled] = useState<bigint | null>(null);
  const [notice, setNotice] = useState<{ text: string; hash: string } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const mine = signer ? repos.filter((r) => r.borrower === signer.address || r.lender === signer.address) : [];
  // #repo/<id>: show it even if closed, then scroll to it once (not again on every 10 s refresh).
  const linkedRepo = linked === null ? undefined : mine.find((r) => r.id === linked);
  const linkedClosed = !!linkedRepo && isClosed(linkedRepo);
  const [scrolledTo, setScrolledTo] = useState<string | null>(null);
  useEffect(() => {
    if (linkedClosed) setShowClosed(true);
  }, [linkedClosed]);
  useEffect(() => {
    if (linked === null || scrolledTo === String(linked) || !config) return;
    const el = document.querySelector(`[data-repo="${linked}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setScrolledTo(String(linked));
  });
  const live = (r: Repo) => r.status === "Open" || r.status === "MarginCall";
  // Closed = settled with nothing left to do (Repaid, Liquidated). Defaulted stays: the lender is still waiting on liquidation.
  const closedCount = mine.filter(isClosed).length;
  const shown = showClosed ? mine : mine.filter((r) => !isClosed(r) || r.id === settled);
  // One primary button per view: a margin call's Top up outranks every Repay.
  const anyMarginCall = mine.some((r) => r.status === "MarginCall" && r.borrower === signer?.address);
  const firstRepayable = anyMarginCall ? undefined : mine.find((r) => (live(r) || r.status === "Defaulted") && r.borrower === signer?.address)?.id;
  const showDesk = !!signer && (liquidatorOk || roleOf(signer.address) === "liquidator");
  // A liquidator with no agreements of its own opens on the desk, not on an empty list.
  const deskFirst = showDesk && loaded && mine.length === 0;
  const demo = signer?.kind === "demo";
  const daySecs = config ? Number(config.day_secs) : 60;
  const deskRepos = repos.filter((r) => r.status !== "Repaid" && r.status !== "Liquidated");

  const desk = showDesk && config && (
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
              <th>Agreement</th>
              <th className="r">Debt</th>
              <th className="r">Collateral</th>
              <th className="r">Matures</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {deskRepos.length === 0 && (
              <tr>
                <td colSpan={6} className="app-empty">
                  No open agreements to watch.
                </td>
              </tr>
            )}
            {deskRepos.map((r) => {
              const token = assetBySac(r.collateral_asset);
              const rNav = ctx.navs[r.collateral_asset] ?? null;
              // check_margin, liquidate and a missed-call default all need a NAV the contract accepts.
              const rBlock = navBlock(token.code, ctx.health(r.collateral_asset), ctx.assets[r.collateral_asset] ?? null);
              const graceEnd = Number(r.maturity_ts + config.grace_secs);
              const marginMissed = r.status === "MarginCall" && r.margin_call_deadline !== null && ctx.now > Number(r.margin_call_deadline);
              const matured = ctx.now > graceEnd;
              const defaultable = live(r) && (matured || marginMissed);
              // Maturity defaults never read the NAV; a missed-call default re-checks it (#20).
              const defaultBlock = defaultable && !matured ? rBlock : null;
              // The contract wants now > grace end (or > the margin deadline): the first second it accepts.
              const defaultAt = Math.min(graceEnd + 1, r.status === "MarginCall" && r.margin_call_deadline !== null ? Number(r.margin_call_deadline) + 1 : Infinity);
              const toMaturity = Number(r.maturity_ts) - ctx.now;
              const ref = idRef(r.id);
              return (
                <tr key={String(r.id)}>
                  <td className="cv-num">{ref}</td>
                  <td className="r cv-num">{fmtOwed(r.principal + r.interest, r.interest)}</td>
                  <td className="r cv-num">
                    {fmtAmount(r.collateral_amount, 2, token.decimals)}
                    <span className="cv-unit">{token.code}</span>
                  </td>
                  <td className="r cv-num">
                    {toMaturity > 0
                      ? fmtCountdown(toMaturity, daySecs)
                      : matured
                        ? `Overdue ${fmtCountdown(ctx.now - graceEnd, daySecs)}`
                        : `Grace ${fmtCountdown(graceEnd - ctx.now, daySecs)}`}
                  </td>
                  <td>
                    <StatusPill status={displayState(r, config.grace_secs, ctx.now)} />
                  </td>
                  <td className="r">
                    <span className="cv-row app-desk__acts">
                      {r.status === "Open" && (
                        <button
                          type="button"
                          className="cv-btn cv-btn--secondary cv-btn--sm"
                          disabled={!!ctx.busy || !!rBlock || !ctx.approved}
                          title={rBlock ?? "Raise a margin call if cover is below 100%"}
                          onClick={async () => {
                            const out = await ctx.run(`check-${r.id}`, `Agreement ${ref} not checked`, () => chain.checkMargin(signer!, r.id));
                            if (out)
                              setNotice({
                                text: out.value === "MarginCall" ? `Margin call raised on Agreement ${ref}` : `Agreement ${ref} is above the margin line`,
                                hash: out.hash,
                              });
                          }}
                        >
                          {ctx.busy === `check-${r.id}` ? "Checking" : "Check margin"}
                        </button>
                      )}
                      {live(r) && !defaultable && (
                        <span className="small app-muted" data-hint="defaultable-in">
                          Defaultable in {fmtCountdown(defaultAt - ctx.now, daySecs)}
                        </span>
                      )}
                      {live(r) && defaultable && (
                        <button
                          type="button"
                          className="cv-btn cv-btn--danger cv-btn--sm"
                          disabled={!!defaultBlock || !!ctx.busy || !ctx.approved}
                          title={defaultBlock ?? ""}
                          onClick={async () => {
                            const out = await ctx.run(`default-${r.id}`, `Agreement ${ref} not defaulted`, () => chain.declareDefault(signer!, r.id));
                            if (out)
                              setNotice({
                                text: out.value === "Open" ? `Agreement ${ref} margin call cleared: NAV back above the margin line` : `Agreement ${ref} defaulted`,
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
                            const out = await ctx.run(`liq-${r.id}`, `Agreement ${ref} not liquidated`, () => chain.liquidate(signer!, r.id));
                            if (out)
                              setReceipt({
                                left: { eyebrow: "Liquidator delivers", amount: rNav ? fmtAmount((collateralValue(r.collateral_amount, rNav.price, collateralDecimals(rNav.decimals, token.decimals)) * (BPS - config.liquidation_discount_bps) + BPS - 1n) / BPS) : "—", unit: "USDC", hint: "to lender, fee, borrower" },
                                right: { eyebrow: "Liquidator receives", amount: fmtAmount(r.collateral_amount, 2, token.decimals), unit: token.code, hint: `from Agreement ${ref}` },
                                sentence: `Agreement ${ref} liquidated in one transaction`,
                                hash: out.hash,
                                stamp: { word: "Liquidated", sub: `Agreement ${ref}` },
                              });
                          }}
                        >
                          Liquidate
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TxSlot tx={ctx.tx} keys={deskRepos.flatMap((r) => [`check-${r.id}`, `default-${r.id}`, `liq-${r.id}`])} demo={demo} dismiss={ctx.dismissTx} />
    </div>
  );

  return (
    <section className="app-section">
      <div className="app-section__head">
        <div className="app-section__titlerow">
          <h1 className="title">My positions</h1>
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
        <span className="small app-muted">Repurchase agreements you have borrowed or lent.</span>
      </div>
      {receipt && (
        <DvpReceipt
          {...receipt}
          onDismiss={() => {
            setReceipt(null);
            setSettled(null);
          }}
        />
      )}
      {notice && (
        <p className="cv-row small">
          {notice.text} <TxHash kind="TX" value={notice.hash} />
        </p>
      )}
      {deskFirst && desk}
      {!signer && <p className="app-empty">{CONNECT} to see your positions.</p>}
      {signer && !loaded && ctx.readError && (
        <p className="app-empty app-retry">
          Could not load your positions.
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={ctx.retry}>
            Retry
          </button>
        </p>
      )}
      {signer && !loaded && !ctx.readError && (
        <div className="app-cards" aria-busy="true" aria-label="Loading repurchase agreements">
          <div className="cv-card">
            <div className="cv-card__head"><Skel kind="short" /><Skel w={60} h={22} /></div>
            <Skel kind="figure" />
            <Skel kind="line" />
            <Skel kind="short" />
          </div>
        </div>
      )}
      {signer && loaded && linked !== null && !linkedRepo && (
        <Alert tone="info" title={`Agreement ${idRef(linked)} is not one of yours`}>
          The linked repurchase agreement is not borrowed or lent by the connected account.
        </Alert>
      )}
      {signer && loaded && mine.length === 0 && !deskFirst && <p className="app-empty">No repurchase agreements for this account yet.</p>}
      {signer && loaded && mine.length > 0 && shown.length === 0 && (
        <p className="app-empty">No open repurchase agreements. Closed ones are hidden.</p>
      )}
      {shown.length > 0 && (
        <div className="app-cards">
          {config &&
            shown.map((r) => (
              <PositionCard
                key={String(r.id)}
                ctx={ctx}
                repo={r}
                primary={r.id === firstRepayable}
                linked={r.id === linked}
                onRepaid={(rec) => {
                  setNotice(null);
                  setReceipt(rec);
                  setSettled(r.id);
                }}
              />
            ))}
        </div>
      )}

      {!deskFirst && desk}
    </section>
  );
}

function isClosed(r: Repo) {
  return r.status === "Repaid" || r.status === "Liquidated";
}

function PositionCard({
  ctx,
  repo,
  primary,
  linked,
  onRepaid,
}: {
  ctx: Ctx;
  repo: Repo;
  primary: boolean;
  /** Opened via #repo/<id>: outlined. */
  linked: boolean;
  onRepaid: (r: Receipt) => void;
}) {
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
  // 4 dp when the interest is under 0.01 USDC, so a small loan's debt does not read as the principal.
  const owed = fmtOwed(debt, repo.interest);
  const ref = idRef(repo.id);
  const agreement = `Agreement ${ref}`;
  // Cover vs the asset's margin-call line (DECISIONS.md #14, #26); a pre-#26
  // contract triggers on the liquidation discount.
  const assetTriggerBps = ctx.assets[repo.collateral_asset]?.margin_trigger_bps ?? config?.liquidation_discount_bps ?? null;
  const triggerBps = assetTriggerBps === null ? null : effectiveTriggerBps(assetTriggerBps, repo.haircut_bps);
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
  const slot = (key: string) => <TxSlot tx={ctx.tx} keys={[key]} demo={signer?.kind === "demo"} dismiss={ctx.dismissTx} />;
  // NAV outage fallback (#38): liquidate needs a fresh NAV; after 7 stale days the lender may take the collateral in kind.
  const assetCfg = ctx.assets[repo.collateral_asset] ?? null;
  const win = repo.status === "Defaulted" ? inKindWindow(nav, assetCfg, config.day_secs, now) : null;
  const outageOpen = win?.state === "open";
  const outageWaiting = win?.state === "waiting";
  const opensAtText =
    win?.opensAt != null ? new Date(win.opensAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "";
  const outageSpan = `${NAV_OUTAGE_DAYS} ${Number(config.day_secs) >= 86_400 ? "days" : "demo days"}`;
  const navAgeText = assetCfg ? fmtDuration(assetCfg.max_nav_age_secs) : "its maximum age";
  // undefined = sold; null = events not read, so the card does not guess.
  const claimedInKind = repo.status !== "Liquidated" ? undefined : ctx.inKind === null ? null : ctx.inKind.get(String(repo.id));
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
  // A frozen USDC line cannot pay the debt (Raven AS-04).
  const frozen = canRepay ? usdcBlock(balances) : null;
  const canTopUp = live && canRepay && (inMarginCall || breached);
  const topUpText = topUpInput ?? (topUpNeed !== null && topUpNeed > 0n ? amt(topUpNeed).replace(/,/g, "") : "");
  const topUpAmount = parseAmount(topUpText, token.decimals);
  const topUpErr = topUpAmount === null || topUpAmount <= 0n ? `Enter an amount above 0.00 ${token.code}.` : null;
  const topUpShort =
    !topUpErr && held !== null && topUpAmount !== null && held < topUpAmount ? `You hold ${amt(held)} ${token.code}.` : null;

  const doTopUp = async () => {
    if (!signer || topUpAmount === null || topUpErr) return;
    const out = await ctx.run(`topup-${repo.id}`, `${agreement} not topped up`, () => chain.topUp(signer, repo.id, topUpAmount));
    if (out) {
      setTopUpInput(null);
      ctx.setFlash({
        tone: "info",
        title: `Topped up ${agreement}`,
        body: `Added ${amt(topUpAmount)} ${token.code}. ${inMarginCall ? (topUpHold ?? "The margin call clears once collateral is back at the initial margin.") : ""}`,
        hash: out.hash,
      });
    }
  };

  const toggleAuto = async (enabled: boolean) => {
    if (!signer) return;
    const out = await ctx.run(`auto-${repo.id}`, `Auto-repay not ${enabled ? "turned on" : "turned off"}`, () =>
      chain.setAutoRepay(signer, repo.id, enabled),
    );
    if (out)
      ctx.setFlash({
        tone: "info",
        title: `Auto-repay ${enabled ? "on" : "off"} for ${agreement}`,
        body: enabled ? `At maturity ${owed} USDC is pulled from this wallet.` : "Repay by hand before maturity plus grace.",
        hash: out.hash,
      });
  };

  const doDeclareDefault = async () => {
    if (!signer) return;
    const out = await ctx.run(`declare-${repo.id}`, `${agreement} not defaulted`, () => chain.declareDefaultPastGrace(signer, repo));
    if (out)
      ctx.setFlash({
        tone: "info",
        title: out.value === "Repaid" ? `${agreement} repaid` : `${agreement} defaulted`,
        body:
          out.value === "Repaid"
            ? `The borrower had auto-repay on: it pulled ${owed} USDC from them and your loan is repaid.`
            : `Marked defaulted. A whitelisted liquidator can now buy the ${token.code}.`,
        hash: out.hash,
      });
  };

  const doClaimInKind = async () => {
    if (!signer) return;
    const out = await ctx.run(`inkind-${repo.id}`, `${agreement} not claimed in kind`, () => chain.claimInKind(signer, repo.id));
    if (!out) return;
    // The claim lands even when the token refuses the push: then it is parked for claim_collateral.
    const parkedNow = (await chain.getClaimableCollateral(signer.address).catch(() => ({}) as Record<string, bigint>))[repo.collateral_asset] ?? 0n;
    ctx.setFlash({
      tone: "info",
      title: `${agreement} claimed in kind`,
      body:
        parkedNow > 0n
          ? `${amt(out.value)} ${token.code} is yours, but ${token.code} refused the transfer to this account, so the contract parked it: claim it above, to this account or to a custody account. The debt is closed.`
          : `${amt(out.value)} ${token.code} sent to your account instead of USDC. No sale and no fee; the ${owed} USDC debt is closed.`,
      hash: out.hash,
    });
  };

  const doRepay = async () => {
    if (!signer) return;
    const out = await ctx.run(`repay-${repo.id}`, `${agreement} not repaid`, () => chain.repay(signer, repo.id));
    if (out)
      onRepaid({
        left: { eyebrow: "Borrower delivers", amount: owed, unit: "USDC", hint: `${fmtAmount(repo.principal)} principal + ${fmtOwed(repo.interest, repo.interest)} interest` },
        right: { eyebrow: "Borrower receives", amount: amt(repo.collateral_amount), unit: token.code, hint: `from ${agreement}` },
        sentence: `${agreement} repaid. Settled atomically in one transaction`,
        hash: out.hash,
        stamp: { word: "Repaid", sub: owed, repaid: true },
      });
  };

  return (
    <article
      className={`cv-card${isClosed(repo) ? " app-card--closed" : ""}${linked ? " app-card--linked" : ""}`}
      data-repo={String(repo.id)}
    >
      <div className="cv-card__head">
        <span className="cv-eyebrow">
          <a href={`#repo/${repo.id}`} className="app-idlink" title="Link to this agreement">
            {agreement}
          </a>{" "}
          · {side}
        </span>
        <StatusPill status={displayState(repo, config.grace_secs, now)} />
      </div>
      {live && (inMarginCall || breached) && (
        <Alert tone="margin" title={inMarginCall ? `Margin call on ${agreement}` : "Below the margin-call line"}>
          {`Collateral cover is ${cover !== null ? cover.toFixed(1) : "—"}%. `}
          {side === "borrowed"
            ? topUpNeed !== null && topUpNeed > 0n
              ? inMarginCall
                ? `Add ${amt(topUpNeed)} ${token.code}${toDeadline !== null ? ` within ${fmtCountdown(Math.max(0, toDeadline), Number(config.day_secs))}` : ""} or the agreement can be defaulted.`
                : `Add ${amt(topUpNeed)} ${token.code} now to stay clear of a margin call.`
              : "Repay, or wait for the next NAV."
            : inMarginCall
              ? "The borrower has until the deadline to add collateral; after it, anyone can default the agreement."
              : "A margin call can be raised on the next check."}
          {inMarginCall && side === "borrowed" && topUpHold && <span data-hint="topup-hold"> {topUpHold}</span>}
          {inMarginCall && side !== "borrowed" && defaultHold && (
            <span data-hint="default-hold"> Until the price is accepted again the missed call cannot be defaulted; a default at maturity still works.</span>
          )}
        </Alert>
      )}
      {repo.status === "Defaulted" && !outageOpen && !outageWaiting && (
        <Alert tone="info" title="Awaiting liquidation">
          {side === "lent"
            ? `The borrower did not repay. A whitelisted liquidator buys the collateral at NAV less ${fmtPct(config.liquidation_discount_bps, 1)}, and that USDC pays you first, up to the ${owed} USDC debt. Until then the borrower can still repay you in full.`
            : `This agreement was defaulted. Until a whitelisted liquidator buys the collateral you can still repay ${owed} USDC and get it all back; after a liquidation, any surplus over the debt comes back to you.`}
        </Alert>
      )}
      {outageWaiting && (
        <Alert tone="margin" title="Liquidation blocked: stale NAV">
          {`The ${token.code} price is over ${navAgeText} old, so no liquidator can buy the collateral. `}
          {side === "lent"
            ? `If it stays stale, you can claim all ${amt(repo.collateral_amount)} ${token.code} in kind from ${opensAtText}, ${outageSpan} after the NAV went stale. The borrower can still repay you until then.`
            : `If it stays stale, from ${opensAtText} the lender can take all ${amt(repo.collateral_amount)} ${token.code} in kind, with no surplus back to you. Repay ${fmtAmount(debt)} USDC before then to get it back.`}
        </Alert>
      )}
      {outageOpen && (
        <Alert tone="margin" title={side === "lent" ? "Claim the collateral in kind" : "The lender can take your collateral in kind"}>
          {`The ${token.code} NAV has been stale for over ${outageSpan}, so liquidation stays blocked. `}
          {side === "lent"
            ? `You can take all ${amt(repo.collateral_amount)} ${token.code} instead of USDC: no sale, no fee, and the ${fmtAmount(debt)} USDC debt closes. The borrower can still repay you until you claim.`
            : `The lender can now take all ${amt(repo.collateral_amount)} ${token.code}, with no surplus back to you. Repay ${fmtAmount(debt)} USDC now to get it back.`}
        </Alert>
      )}
      <div>
        <span className="cv-figure-xl">{fmtAmount(repo.principal)}</span>
        <span className="cv-unit">USDC</span>
      </div>
      <dl className="cv-terms cv-terms--fit">
        <div>
          <dt>Debt</dt>
          <dd>
            {owed}
            <span className="cv-unit">USDC</span>
          </dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd>
            {amt(repo.collateral_amount)}
            <span className="cv-unit">{token.code}</span>
          </dd>
        </div>
        <div>
          <dt>Haircut</dt>
          <dd>{fmtPct(repo.haircut_bps, 1)}</dd>
        </div>
      </dl>
      {live && (
        // Below 100% the bar turns margin-coloured even before a keeper raises the call.
        <div className={`cv-health${inMarginCall || breached ? " cv-health--margin" : ""}`}>
          <div className="cv-health__legend">
            <span>
              Collateral cover at NAV <span className="cv-num">{nav ? fmtNav(nav.price, nav.decimals) : "—"}</span>
            </span>
            <span className="cv-num app-flashable" ref={coverRef}>{cover !== null ? `${cover.toFixed(1)}%` : "—"}</span>
          </div>
          <div className="cv-health__bar" role="meter" aria-valuemin={90} aria-valuemax={110} aria-valuenow={cover ?? undefined} aria-label="Collateral cover">
            <div className="cv-health__fill" style={{ width: `${fill}%` }} />
            <div className="cv-health__mark" style={{ left: "50%" }} />
          </div>
          <div className="cv-health__legend app-health__scale" aria-hidden="true">
            <span>90%</span>
            <span>Margin call 100%</span>
            <span>110%</span>
          </div>
        </div>
      )}
      <div className="cv-row" style={{ justifyContent: "space-between" }}>
        <span className="cv-countdown">
          <span className="cv-field__hint">
            {repo.status === "Defaulted" ? (outageOpen ? "In-kind claim open" : outageWaiting ? "In-kind claim opens in" : "Liquidation pending") : !live ? "Closed" : inMarginCall && toDeadline !== null ? (toDeadline > 0 ? "Top up within" : "Margin window over") : toMaturity > 0 ? "Matures in" : pastGrace ? "Grace over" : "Matured, grace ends in"}
          </span>
          {outageWaiting && win?.opensAt != null && (
            <span className="cv-countdown__time">{fmtCountdown(win.opensAt - now, Number(config.day_secs))}</span>
          )}
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
            disabled={!!busy || !!short || !mayHold || !!frozen}
            title={frozen ?? (mayHold ? "" : holdBlock)}
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
            title="Sends default: if the borrower opted in to auto-repay it pulls the debt first, else the agreement is marked defaulted for liquidation"
            onClick={doDeclareDefault}
            data-action="declare-default"
          >
            {busy === `declare-${repo.id}` ? "Declaring" : "Declare default"}
          </button>
        )}
        {outageOpen && side === "lent" && (
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            disabled={!!busy}
            title={`Sends claim_in_kind: the ${token.code} comes to you and the agreement closes as Liquidated`}
            onClick={doClaimInKind}
            data-action="claim-in-kind"
          >
            {busy === `inkind-${repo.id}` ? "Claiming" : "Claim collateral in kind"}
          </button>
        )}
      </div>
      {slot(`inkind-${repo.id}`)}
      {slot(`repay-${repo.id}`)}
      {slot(`declare-${repo.id}`)}
      {pastGrace && side === "borrowed" && (
        <p className="cv-field__hint app-hint--warn" data-hint="grace-over">
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
          {slot(`topup-${repo.id}`)}
        </form>
      )}
      {canRepay && (
        <p className={`cv-field__hint${frozen || short ? " app-hint--warn" : ""}`}>
          {frozen
            ? frozen
            : short
            ? `Repay needs ${owed} USDC; you hold ${fmtAmount(balances!.usdc!)} USDC.`
            : `Repay ${owed} USDC to close ${agreement} and get ${amt(repo.collateral_amount)} ${token.code} back.`}
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
                ? `On, but this wallet is short: hold ${owed} USDC by maturity or the agreement defaults.`
                : `On: at maturity ${owed} USDC is pulled from this wallet and your ${token.code} comes back.`
              : `Off: if you do not repay by maturity plus ${String(config.grace_secs)} s grace, your ${token.code} is sold at NAV − ${fmtPct(config.liquidation_discount_bps, 1)}.`
          }
        />
      )}
      {slot(`auto-${repo.id}`)}
      {!repayable && side === "borrowed" && <p className="cv-field__hint">{OUTCOME[repo.status]?.(repo, config, claimedInKind)}</p>}
      {repo.status === "Liquidated" && side === "lent" && <p className="cv-field__hint">{lenderLiquidated(repo, config, claimedInKind)}</p>}
    </article>
  );
}

/** What a settled agreement meant for the borrower, so a closed card never just says "Closed". `k` = its ClaimedInKind event, if any. */
const OUTCOME: Partial<Record<Status, (r: Repo, c: ProtocolConfig, k?: InKindClaim | null) => string>> = {
  Repaid: (r) => `Repaid. ${fmtAmount(r.collateral_amount, 2, assetBySac(r.collateral_asset).decimals)} ${assetBySac(r.collateral_asset).code} returned to this wallet.`,
  Liquidated: (r, c, k) =>
    k === null
      ? "Liquidated: not repaid in time."
      : k
      ? `Claimed in kind: not repaid in time while the ${assetBySac(r.collateral_asset).code} NAV was stale, so the lender took the collateral itself. There was no sale, so no surplus came back.`
      : `Liquidated: not repaid in time, so the ${assetBySac(r.collateral_asset).code} was sold at NAV − ${fmtPct(c.liquidation_discount_bps, 1)}. The surplus over the debt was paid to this wallet.`,
};

/** The lender's line on a Liquidated agreement: sold for USDC, or taken in kind (#38). */
function lenderLiquidated(r: Repo, c: ProtocolConfig, k?: InKindClaim | null): string {
  const t = assetBySac(r.collateral_asset);
  if (k === null) return "Liquidated: the borrower did not repay in time.";
  if (!k) return `Liquidated: the ${t.code} was sold at NAV − ${fmtPct(c.liquidation_discount_bps, 1)} and the USDC paid you first, up to the debt.`;
  const amt = `${fmtAmount(k.amount, 2, t.decimals)} ${t.code}`;
  return k.parked
    ? `Claimed in kind: ${amt} is yours instead of USDC. ${t.code} refused the transfer to this account, so it was parked for you to claim.`
    : `Claimed in kind: ${amt} went to this wallet instead of USDC. No sale, no fee; the debt is closed.`;
}

export function AutoRepayToggle({ checked, disabled, busy, onChange, hint }: { checked: boolean; disabled?: boolean; busy?: boolean; onChange: (v: boolean) => void; hint: string }) {
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
