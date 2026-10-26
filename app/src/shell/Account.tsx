import { ACCESS_LIMITED } from "../gates";
import * as chain from "../chain";
import type { Balances } from "../chain";
import { TSAFO, roleOf } from "../config";
import type { Ctx } from "../ctx";
import { fmtAmount } from "../format";
import { trustlineUi } from "../trustline";
import { Alert, Skel, TxHash, useFlash } from "../ui";
import type { Signer } from "../wallet";

export function AccountChip({ signer, onDisconnect }: { signer: Signer; onDisconnect: () => void }) {
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

export function AccountAlerts({
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

export function BalanceFigures({ balances }: { balances: Balances | null }) {
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
