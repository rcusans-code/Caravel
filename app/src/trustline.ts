// Trustline onboarding: which lines are missing, what the Add trustline button
// shows, and the add flow that asks the wallet again once after a decline.
// Pure on purpose (type-only imports): app/test/trustline.test.ts runs it under
// plain `node --test` with no bundler.
import type { Balances } from "./chain";

export type TrustCode = "USDC" | "tBENJI";

/** A wallet that does not answer within this window counts as a failed sign (matches the tx timebound). */
export const SIGN_TIMEOUT_MS = 120_000;

/** Trustlines the account still lacks. Empty until the account exists on testnet. */
export function missingTrustlines(b: Balances | null): TrustCode[] {
  if (!b?.exists) return [];
  return (["USDC", "tBENJI"] as const).filter((c) => (c === "USDC" ? b.usdc : b.tbenji) === null);
}

const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  if (typeof m === "string") return m;
  try {
    return JSON.stringify(e) ?? "";
  } catch {
    return "";
  }
};

/**
 * The wallet declined, cancelled or failed to sign. Keeps the wallet's own words
 * (Freighter rejects with a plain {code, message} object) so explain() still reads them.
 */
export class WalletSignError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(messageOf(original) || "The wallet did not sign the transaction.");
    this.name = "WalletSignError";
    this.original = original;
  }
}

/**
 * Runs one wallet signature. Any wallet failure becomes a WalletSignError. A wallet
 * that never answers fails after `timeoutMs` with a plain Error (no automatic re-prompt:
 * its first popup may still be open), so the UI never stays stuck in "Waiting for wallet".
 */
export async function signOnce<T = string>(
  sign: () => Promise<T>,
  timeoutMs = SIGN_TIMEOUT_MS,
  timeoutText = "The wallet did not answer in time. Nothing was sent. Click Add trustline to try again.",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutText)), timeoutMs);
  });
  try {
    return await Promise.race([
      sign().catch((e) => {
        throw new WalletSignError(e);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The contract-write timeout text: nothing was signed, so nothing was sent. */
export const WRITE_SIGN_TIMEOUT_TEXT = "The wallet did not answer in time. Nothing was sent. Try again.";

/**
 * A contract write's signTransaction with the trustline's time limit (Raven DW-04):
 * a wallet that never answers rejects after `timeoutMs` instead of holding the app's
 * busy state (and so every write button) until reload. 120 s fits inside the 300 s
 * timebound the SDK sets when signing starts. `phase` drives TxProgress.
 */
export function boundedSign<A extends unknown[], T>(
  sign: (...args: A) => Promise<T>,
  phase: (p: "sign" | "submit") => void = () => undefined,
  timeoutMs = SIGN_TIMEOUT_MS,
): (...args: A) => Promise<T> {
  return async (...args: A) => {
    phase("sign");
    const out = await signOnce(() => sign(...args), timeoutMs, WRITE_SIGN_TIMEOUT_TEXT);
    phase("submit");
    return out;
  };
}

export interface TrustDeps {
  /** Fresh balances, read before every attempt so a retry only asks for what is still missing. */
  balances: () => Promise<Balances>;
  /** Builds, signs and submits one changeTrust tx for `which`; resolves to the tx hash. */
  add: (which: TrustCode[]) => Promise<string>;
}

export interface TrustResult {
  /** Lines this call added; empty when they were all in place already. */
  added: TrustCode[];
  hash: string | null;
  /** Signature requests made. */
  attempts: number;
}

/**
 * Adds the `want` trustlines the account still lacks. When the wallet declines or
 * fails to sign, it re-reads the account and asks the wallet again, up to `retries`
 * times (default once); `onRetry` fires before each new request. Other failures
 * (submit errors, no XLM) and the last decline are thrown to the caller.
 */
export async function addTrustlinesWithRetry(
  deps: TrustDeps,
  want: TrustCode[],
  opts: { retries?: number; onRetry?: (err: WalletSignError, todo: TrustCode[]) => void } = {},
): Promise<TrustResult> {
  const retries = opts.retries ?? 1;
  let attempts = 0;
  for (;;) {
    const b = await deps.balances();
    if (!b.exists) throw new Error("The account does not exist on testnet. Fund it with friendbot first.");
    const missing = missingTrustlines(b);
    const todo = want.filter((c) => missing.includes(c));
    if (todo.length === 0) return { added: [], hash: null, attempts };
    attempts++;
    try {
      return { added: todo, hash: await deps.add(todo), attempts };
    } catch (e) {
      if (!(e instanceof WalletSignError) || attempts > retries) throw e;
      opts.onRetry?.(e, todo);
    }
  }
}

export interface TrustUi {
  /** Wallet can hold no collateral: no issuer-authorized tBENJI line and not tSAFO-allowlisted. */
  gated: boolean;
  /** Wallet can borrow against tSAFO (allowlisted) but tBENJI is not authorized yet. */
  tbenjiPending: boolean;
  /** Show the "No … trustline" info alert. */
  showInfo: boolean;
  /** The Add trustline button, or null when no line can be added from here. */
  button: { missing: TrustCode[]; label: string; disabled: boolean } | null;
}

/**
 * What the account alerts show. The button depends only on the on-chain state and
 * whether a trustline request is in flight, never on a past failure, so it stays
 * visible and clickable after any decline or error.
 */
export function trustlineUi(kind: "wallet" | "demo", b: Balances | null, busy: string | null): TrustUi {
  const missing = missingTrustlines(b);
  // Per asset: tBENJI needs an issuer-authorized line, tSAFO the issuer allowlist.
  // Only a wallet approved for neither is told borrowing is not approved.
  const noTbenji = kind === "wallet" && !!b?.exists && !b.tbenjiAuthorized;
  const gated = noTbenji && !b!.tsafoAllowed;
  const tbenjiPending = noTbenji && b!.tsafoAllowed;
  // Lenders only need USDC, so a missing tBENJI line alone is just shown in the
  // figure, except for browser wallets that may want to borrow.
  const showInfo =
    !gated && !tbenjiPending && (missing.includes("USDC") || (kind === "wallet" && missing.length > 0));
  const waiting = busy === "trust";
  // Any write in flight disables it (Raven DW-05): a second tx from the same account
  // would race the first one's sequence number and fail with txBadSeq.
  const button =
    missing.length > 0 && (gated || tbenjiPending || showInfo)
      ? {
          missing,
          label: waiting ? "Waiting for wallet…" : `Add ${missing.join(" + ")} trustline${missing.length > 1 ? "s" : ""}`,
          disabled: busy !== null,
        }
      : null;
  return { gated, tbenjiPending, showInfo, button };
}
