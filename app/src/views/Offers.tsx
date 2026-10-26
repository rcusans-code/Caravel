import { useState } from "react";
import * as chain from "../chain";
import type { Offer } from "../chain";
import { COLLATERAL, assetBySac } from "../config";
import { CONNECT, type Ctx, type Receipt } from "../ctx";
import {
  BPS,
  collateralDecimals,
  fmtAmount,
  fmtNav,
  fmtPct,
  fmtTerm,
  interest as calcInterest,
  requiredCollateral,
} from "../format";
import { autoRepayHint, collateralBlock, fmtDuration } from "../gates";
import { Alert, DvpReceipt, Skel, Tip, TxHash, TxProgress } from "../ui";
import { AutoRepayToggle } from "./Positions";

export function OffersView({
  ctx,
  offers,
  loaded,
  selected,
  onSelect,
}: {
  ctx: Ctx;
  offers: Offer[];
  loaded: boolean;
  /** Offer whose take panel is open, from #offer/<id>. */
  selected: bigint | null;
  onSelect: (id: bigint | null, replace?: boolean) => void;
}) {
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
        <TakePanel ctx={ctx} offer={offer} onClose={() => onSelect(null)} onDone={(r) => { setReceipt(r); onSelect(null, true); }} />
      )}
      {selected !== null && !offer && loaded && !receipt && (
        <Alert tone="info" title={`Offer #${String(selected).padStart(3, "0")} is not open`}>
          It was taken or cancelled, or never existed. The open offers are listed below.
        </Alert>
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
                <td className="cv-num">
                  <a href={`#offer/${o.id}`} className="app-idlink" title="Link to this offer">
                    #{String(o.id).padStart(3, "0")}
                  </a>
                </td>
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
                      onSelect(o.id);
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
  const navStale = ctx.stale(offer.collateral_asset);
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
  else if (!nav) block = `The oracle has no ${token.code} price yet.`;
  else if (navStale) block = `The ${token.code} price is more than ${fmtDuration(asset.max_nav_age_secs)} old. Wait for the next update (or push one from Admin), then try again.`;
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
