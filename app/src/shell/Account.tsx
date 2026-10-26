import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { COLLATERAL, TSAFO, roleOf, type Token } from "../config";
import * as chain from "../chain";
import type { Balances } from "../chain";
import { fmtAmount } from "../format";
import { Alert, Skel, TxHash, useFlash } from "../ui";
import { trustlineUi } from "../trustline";
import { ACCESS_LIMITED, collateralBlock, usdcBlock } from "../gates";
import type { Signer } from "../wallet";
import type { Ctx } from "../ctx";

export function AccountChip({ signer, onDisconnect }: { signer: Signer; onDisconnect: () => void }) {
  const role = roleOf(signer.address);
  // The wallet name tags the address chip (one unit, so it never wraps away from it).
  const label = `${signer.kind === "demo" ? `Demo ${signer.label}` : signer.label}${signer.kind === "wallet" && role ? ` · ${role}` : ""}`;
  return (
    <div className="cv-row app-account">
      <TxHash kind="ACCOUNT" tag={label} value={signer.address} />
      <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

export function AccountAlerts({
  signer,
  balances,
  claimable,
  parked,
  busy,
  run,
  refresh,
  setFlash,
}: {
  signer: Signer;
  balances: Balances | null;
  /** Parked USDC payouts for this account (contract claimable()). */
  claimable: bigint;
  /** Parked collateral per token id (contract claimable_collateral()). */
  parked: Record<string, bigint>;
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
          ? { tone: "info", title: "Trustline added", body: `${r.added.join(" + ")} trustline in place.`, hash: r.hash }
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
      setFlash({ tone: "info", title: "USDC claimed", body: `${fmtAmount(r.value)} USDC sent to your account.`, hash: r.hash });
      return r;
    });
  // USDC line frozen by its issuer (Raven AS-04): say so, and claim cannot land.
  const frozen = usdcBlock(balances);
  return (
    <>
      {frozen && (
        <Alert tone="margin" title="USDC frozen by its issuer">
          {frozen}
        </Alert>
      )}
      {claimable > 0n && (
        <Alert
          tone="info"
          title={`${fmtAmount(claimable)} USDC waiting for you`}
          action={
            <button
              type="button"
              className="cv-btn cv-btn--primary cv-btn--sm"
              data-action="claim"
              disabled={!!busy || !!frozen}
              title={frozen ?? undefined}
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
      {COLLATERAL.filter((t) => (parked[t.sac] ?? 0n) > 0n).map((t) => (
        <ParkedCollateral
          key={t.sac}
          signer={signer}
          token={t}
          amount={parked[t.sac]}
          balances={balances}
          busy={busy}
          run={run}
          setFlash={setFlash}
        />
      ))}
      {balances && !balances.exists && (
        <Alert
          tone="margin"
          title="Account not on testnet"
          action={
            <button
              type="button"
              className="cv-btn cv-btn--secondary cv-btn--sm"
              data-action="friendbot"
              // One request at a time (DW-05): a second click used to turn a funded account into "Friendbot failed".
              disabled={!!busy}
              aria-busy={busy === "fund" ? "true" : undefined}
              onClick={() => run("fund", "Friendbot failed", () => chain.friendbot(signer.address)).then(refresh)}
            >
              {busy === "fund" ? "Funding…" : "Fund with friendbot"}
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

/**
 * Collateral an in-kind claim could not push to this account (#38): the token
 * refused it (tSAFO allowlist, frozen tBENJI trustline). claim_collateral sends
 * it here or to a custody account the issuer admits.
 */
function ParkedCollateral({
  signer,
  token,
  amount,
  balances,
  busy,
  run,
  setFlash,
}: {
  signer: Signer;
  token: Token;
  amount: bigint;
  balances: Balances | null;
  busy: string | null;
  run: Ctx["run"];
  setFlash: Ctx["setFlash"];
}) {
  const [to, setTo] = useState("");
  const key = `claim-col-${token.sac}`;
  const dest = to.trim();
  const destErr = dest && !StrKey.isValidEd25519PublicKey(dest) && !StrKey.isValidContract(dest) ? "Enter a G… account or C… contract address." : null;
  // Sending to yourself while the issuer still refuses you would revert: say so before the wallet opens.
  const selfBlocked = !dest && collateralBlock(balances, token);
  const amt = fmtAmount(amount, 2, token.decimals);
  const onClaim = () =>
    run(key, `${token.code} not claimed`, async () => {
      const r = await chain.claimCollateral(signer, token.sac, dest || signer.address);
      setFlash({
        tone: "info",
        title: `${token.code} claimed`,
        body: `${fmtAmount(r.value, 2, token.decimals)} ${token.code} sent to ${dest ? `${dest.slice(0, 4)}…${dest.slice(-4)}` : "your account"}.`,
        hash: r.hash,
      });
      return r;
    });
  return (
    <Alert
      tone="info"
      title={`${amt} ${token.code} parked for you`}
      action={
        <button
          type="button"
          className="cv-btn cv-btn--primary cv-btn--sm"
          data-action="claim-collateral"
          disabled={!!busy || !!destErr}
          aria-busy={busy === key ? "true" : undefined}
          title={selfBlocked || ""}
          onClick={onClaim}
        >
          {busy === key ? "Claiming…" : "Claim"}
        </button>
      }
    >
      An in-kind claim gave you this collateral, but {token.code} refused the transfer to your account
      {token.kind === "spiko" ? " (not on the issuer allowlist)" : " (trustline frozen or not authorized)"}, so the contract holds it for
      you. Claim it to your account once the issuer admits it, or send it to a custody account the issuer admits.
      <label className={`cv-field app-custody${destErr ? " cv-field--error" : ""}`}>
        <span className="cv-field__label">Custody address (optional)</span>
        <span className="cv-field__control">
          <input
            id={`custody-${token.sac}`}
            value={to}
            onChange={(e) => setTo(e.currentTarget.value)}
            placeholder="Empty = your account"
            spellCheck={false}
            autoComplete="off"
            data-testid="custody-address"
          />
        </span>
        {(destErr || selfBlocked) && <span className="cv-field__hint">{destErr ?? selfBlocked}</span>}
      </label>
    </Alert>
  );
}

/** The connected wallet's balances, in the header left of the account chip. */
export function BalanceFigures({ balances, failed = false }: { balances: Balances | null; failed?: boolean }) {
  // Not read (yet): skeletons while loading, dashes once the read has failed.
  const none = failed ? "—" : null;
  return (
    <div className="app-bal" aria-label="Balances">
      <Figure label="XLM" value={balances ? fmtAmount(balances.xlm) : none} />
      <Figure label="USDC" value={balances ? (balances.usdc === null ? "No trustline" : fmtAmount(balances.usdc)) : none} />
      <Figure
        label="tBENJI"
        value={balances ? (balances.tbenji === null ? "No trustline" : fmtAmount(balances.tbenji)) : none}
        hint={balances?.tbenji !== null && balances && !balances.tbenjiAuthorized ? "Not authorized by the issuer" : undefined}
      />
      {TSAFO && (
        <Figure
          label={TSAFO.code}
          value={balances ? fmtAmount(balances.tsafo ?? 0n, 2, TSAFO.decimals) : none}
          hint={balances?.exists && !balances.tsafoAllowed ? "Not on the issuer allowlist" : undefined}
        />
      )}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  // null = first load: show a skeleton; afterwards flash the figure when it changes.
  // A blocked asset (issuer approval) keeps its figure, marked; the reason is on hover and in the page alert.
  const ref = useFlash(value);
  return (
    <span className={`app-bal__fig${hint ? " is-warn" : ""}`} aria-busy={value === null ? "true" : undefined} title={hint}>
      <span className="app-bal__label">{label}</span>
      {value === null ? (
        <Skel w={64} h={13} />
      ) : (
        <b className="app-flashable" data-balance={label} ref={ref}>
          {value}
        </b>
      )}
      {hint && <span className="app-bal__warn" aria-label={hint}>!</span>}
    </span>
  );
}
