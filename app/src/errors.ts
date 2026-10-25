import { TBENJI_SAC, TSAFO, USDC_SAC, ORACLE_ID } from "./config";

// contracts/repo/src/errors.rs
const REPO_ERRORS: Record<number, string> = {
  1: "This action is not built into the contract yet.",
  2: "The contract rejected the configuration.",
  3: "Amount and term must be above zero.",
  4: "These terms overflow the contract math. Use a smaller amount or term.",
  5: "This offer is gone: it was taken or cancelled. The board has been refreshed.",
  6: "Repo not found.",
  7: "This repo is no longer open, so it cannot change state that way.",
  8: "This collateral asset is not enabled right now.",
  9: "NAV is older than 3 minutes. Wait for the next update (or push one from Admin), then try again.",
  10: "The collateral does not cover the debt at the current NAV.",
  11: "Only whitelisted liquidators can liquidate.",
  12: "This repo cannot be defaulted yet: it is before maturity plus grace.",
  13: "The oracle has no price for this collateral yet. Push one from Admin.",
  14: "Auto-repay is off for this repo.",
  15: "Auto-repay runs from maturity, not before.",
  16: "Auto-repay could not pull the debt: this wallet holds too little USDC. Top up USDC and repay before grace ends.",
  17: "This collateral asset is paused for this action. Repay and top-up always work.",
  18: "The NAV jumped outside this asset's sanity band, so new loans, margin calls and liquidations are paused. Repay and top-up still work.",
};

// contracts/spiko-mock SpikoError: codes from 100 so they never read as repo errors.
const SPIKO_ERRORS: Record<number, string> = {
  100: "An account in this transfer is not on the issuer's allowlist. Spiko must allowlist the borrower, the repo contract and the liquidator.",
  101: "The issuer has paused the token. Transfers resume when it unpauses.",
  102: "Amounts must be positive.",
  103: "Not enough balance for this transfer.",
};

// Built-in Stellar Asset Contract errors (soroban-env-host ContractError).
const TOKEN_ERRORS: Record<number, string> = {
  6: "The account does not exist on testnet. Fund it with friendbot first.",
  8: "Amounts must be positive.",
  10: "Not enough balance for this transfer.",
  11: "This account is not authorized to hold the asset. tBENJI is AUTH_REQUIRED: the issuer must authorize the account.",
  13: "The account has no trustline for this asset. Add the trustline, then try again.",
};

const assetName = (id: string) => (id === USDC_SAC ? "USDC" : id === TBENJI_SAC ? "tBENJI" : null);

/** Turns SDK, RPC, wallet and contract failures into one desk-note sentence. */
export function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const msg = raw ?? "";

  if (/declin|reject|denied|cancel+ed|user closed|not allowed/i.test(msg))
    return "You rejected the request in your wallet. Nothing was sent.";
  if (/network passphrase|wrong network|networkPassphrase/i.test(msg))
    return "Your wallet is on a different network. Switch it to Testnet, then try again.";
  if (/txInsufficientBalance|insufficient.?fee|tx_insufficient_balance/i.test(msg))
    return "Not enough XLM to pay the network fee. Fund the account with friendbot.";

  // Root cause = the oldest error event. The log is "newest first", so the
  // last "contract:C…, topics:[error, Error(Contract, #N)]" is where it began
  // (e.g. the USDC SAC), the earlier ones are the repo contract re-raising it.
  const events = [...msg.matchAll(/contract:(C[A-Z2-7]{55}),\s*topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  const ev = /newest first/i.test(msg) ? events[events.length - 1] : events[0];
  if (ev) {
    const [, id, codeStr] = ev;
    const code = Number(codeStr);
    if (TSAFO && id === TSAFO.sac) return `${TSAFO.code}: ${SPIKO_ERRORS[code] ?? `token error #${code}.`}`;
    const token = assetName(id);
    if (token) {
      const who = msg.match(/trustline entry is missing for account", (G[A-Z2-7]{55})/)?.[1];
      if (code === 13 && who)
        return `${token}: account ${who.slice(0, 4)}…${who.slice(-4)} has no ${token} trustline, so the transfer to it failed.`;
      return `${token}: ${TOKEN_ERRORS[code] ?? `token error #${code}.`}`;
    }
    if (id === ORACLE_ID) return `Oracle error #${code}.`;
    if (REPO_ERRORS[code]) return REPO_ERRORS[code];
  }
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m && REPO_ERRORS[Number(m[1])]) return REPO_ERRORS[Number(m[1])];
  if (m && SPIKO_ERRORS[Number(m[1])]) return SPIKO_ERRORS[Number(m[1])];
  if (/trustline entry is missing|TrustlineMissing/i.test(msg))
    return "The account has no trustline for this asset. Add the trustline, then try again.";
  if (/Account not found|account not found|MissingValue.*account/i.test(msg))
    return "The account does not exist on testnet. Fund it with friendbot first.";
  if (/Failed to fetch|NetworkError|ECONN|timeout/i.test(msg))
    return "Testnet RPC did not answer. Check your connection and try again.";
  return msg.split("\n")[0].slice(0, 280) || "The transaction failed.";
}
