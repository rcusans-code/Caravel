// Transaction failures that keep their hash and their reason (Raven R3: DW-01,
// DW-02, DW-05). Only package imports, no local ones: app/test/txerror.test.ts
// runs it under plain `node --test` with no bundler.
import { StrKey, type xdr } from "@stellar/stellar-sdk";

/** rejected = the network refused it (never applied); failed = applied and FAILED; pending = fate unknown. */
export type TxStage = "rejected" | "failed" | "pending";

/** A write that got past the wallet. Carries the tx hash so the UI can link it even on failure. */
export class TxError extends Error {
  readonly hash: string | null;
  readonly stage: TxStage;
  /** Tx- or operation-level result code, e.g. txTooLate, changeTrustLowReserve. */
  readonly code: string | null;
  constructor(message: string, o: { hash: string | null; stage: TxStage; code?: string | null }) {
    super(message);
    this.name = "TxError";
    this.hash = o.hash;
    this.stage = o.stage;
    this.code = o.code ?? null;
  }
}

export const txHashOf = (e: unknown): string | null => (e instanceof TxError ? e.hash : null);

export const PENDING_TEXT =
  "The network has not confirmed this transaction yet. Open the hash and check it before you retry, so it is not sent twice.";

// Result codes, most specific first (an op code explains a txFailed better than txFailed does).
const CODE_TEXT: [RegExp, string][] = [
  [/LowReserve/, "Not enough XLM for the reserve: every trustline locks 0.5 XLM. Fund the account with friendbot, then try again."],
  [
    /ResourceLimitExceeded|ExceededLimit|ResourceFeeExceeded|InsufficientRefundableFee/,
    "The transaction ran past its resource budget, usually because the ledger changed after the preview. Try again.",
  ],
  [/\btxTooLate\b|\btxTooEarly\b/, "The transaction expired before it reached the network. Nothing was charged: sign it again."],
  [/\btxBadSeq\b/, "Another transaction from this account went first. Nothing was charged: try again."],
  [/\btxInsufficientBalance\b/, "Not enough XLM to pay the network fee. Fund the account with friendbot."],
  [/\btxInsufficientFee\b/, "The network is busy and the fee was too low. Try again in a moment."],
  [/\btryAgainLater\b/, "The network is busy and did not take the transaction. Nothing was charged: try again in a moment."],
  [/\btxNoAccount\b/, "The account does not exist on testnet. Fund it with friendbot first."],
  [/\btxBadAuth\b/, "The signature does not match this account. Check that the wallet is on Testnet and signs with this account."],
];

/**
 * A tx-level code (txTooLate, txBadSeq …) or a pending/expired state in a failure
 * message, as one sentence; null when the message carries none (contract errors,
 * wallet declines and plain text are left to explain()). Runs before explain()'s
 * wallet-decline check, so a refused tx is never told it was rejected in the wallet.
 */
export function txText(err: unknown): string | null {
  if (err instanceof TxError && err.stage === "pending") return PENDING_TEXT;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/Error\(Contract, #\d+\)/.test(msg)) return null;
  for (const [re, text] of CODE_TEXT) if (re.test(msg)) return text;
  return null;
}

// --- decoding a FAILED / ERROR result ------------------------------------------------

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Codes in a TransactionResult: the tx code, then each operation's own code (opInner -> its result arm). */
export function resultCodes(r: xdr.TransactionResult | undefined | null): string[] {
  if (!r) return [];
  try {
    const res = r.result();
    const tx = res.switch().name;
    if (tx !== "txFailed" && tx !== "txSuccess") return [tx];
    const ops = res.results().map((o) => (o.switch().name === "opInner" ? o.tr().value().switch().name : o.switch().name));
    return [tx, ...ops];
  } catch {
    return [];
  }
}

/** Error events of a failed Soroban tx, oldest first, in the log form explain() parses. */
export function errorEvents(evs: xdr.DiagnosticEvent[] | undefined | null): string[] {
  const out: string[] = [];
  for (const d of evs ?? []) {
    try {
      const ev = d.event();
      const topics = ev.body().v0().topics();
      if (topics[0]?.switch().name !== "scvSymbol" || topics[0].sym().toString() !== "error") continue;
      if (topics[1]?.switch().name !== "scvError") continue;
      const e = topics[1].error();
      const what =
        e.switch().name === "sceContract"
          ? `Error(Contract, #${e.contractCode()})`
          : `Error(${e.switch().name.replace(/^sce/, "")}, ${e.code().name.replace(/^scec/, "")})`;
      const id = ev.contractId();
      const line = `contract:${id ? StrKey.encodeContract(id as unknown as Buffer) : "?"}, topics:[error, ${what}]`;
      if (!out.includes(line)) out.push(line);
    } catch {
      // an event this SDK cannot read: skip it, the codes still explain the failure
    }
  }
  return out;
}

interface GetTx {
  status: string;
  txHash?: string;
  resultXdr?: xdr.TransactionResult;
  diagnosticEventsXdr?: xdr.DiagnosticEvent[];
}

/** A getTransaction response that is not SUCCESS, as a TxError with its hash and decoded reason. */
export function notSuccess(g: GetTx | undefined, hash: string | null, what = "Transaction"): TxError {
  if (!g || g.status === "NOT_FOUND") return new TxError(`${what} still pending`, { hash, stage: "pending" });
  const codes = resultCodes(g.resultXdr);
  const code = codes[codes.length - 1] ?? null;
  const events = errorEvents(g.diagnosticEventsXdr);
  const head = `${what} failed on-chain${codes.length ? ` (${codes.join(", ")})` : ""}`;
  return new TxError([head, ...events].join("\n"), { hash: g.txHash ?? hash, stage: "failed", code });
}

/** The code in an SDK SendFailed message (JSON of the sendTransaction response). */
export function sendFailedCode(msg: string): string | null {
  if (/"status":\s*"TRY_AGAIN_LATER"/.test(msg)) return "tryAgainLater";
  if (/"status":\s*"DUPLICATE"/.test(msg)) return "duplicate";
  return msg.match(/"name":\s*"(tx[A-Za-z]+)"/)?.[1] ?? null;
}

// --- Soroban writes (generated contract.Client) ----------------------------------------

/** What sendAssembled needs from a contract.AssembledTransaction (duck-typed for the tests). */
export interface AssembledLike<R> {
  signed?: { hash(): Uint8Array };
  sign(): Promise<void>;
  send(watcher?: { onSubmitted?: (r: { hash: string }) => void }): Promise<{ getTransactionResponse?: GetTx; result: R }>;
}

/**
 * Signs, submits and waits for an AssembledTransaction. The hash is reported as
 * soon as the network accepts the tx (`onSubmitted`) and rides on every failure
 * after signing. The status is checked before `result` is read: a FAILED tx on
 * meta v4 has no returnValue and the generated parser throws a TypeError on it.
 * Wallet failures (decline, timeout) propagate as they are: nothing was sent.
 */
export async function sendAssembled<R>(tx: AssembledLike<R>, onSubmitted?: (hash: string) => void): Promise<{ hash: string; value: R }> {
  await tx.sign();
  const hash = tx.signed ? hex(tx.signed.hash()) : null;
  let sent: Awaited<ReturnType<AssembledLike<R>["send"]>>;
  try {
    sent = await tx.send({ onSubmitted: (r) => onSubmitted?.(r.hash) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Sending the transaction to the network failed/.test(msg)) {
      const code = sendFailedCode(msg);
      if (code === "duplicate") throw new TxError("Transaction already submitted", { hash, stage: "pending", code });
      throw new TxError(`Transaction not accepted by the network: ${code ?? "unknown"}`, { hash, stage: "rejected", code });
    }
    // Poll timeout (TransactionStillPending) or the RPC dropped mid-flight: the tx may still land.
    throw new TxError(`Transaction still pending: ${msg.split("\n")[0]}`, { hash, stage: "pending" });
  }
  const g = sent.getTransactionResponse;
  if (g?.status !== "SUCCESS") throw notSuccess(g, hash);
  return { hash: g.txHash ?? hash ?? "", value: sent.result };
}

// --- classic writes (changeTrust) -----------------------------------------------------

export interface ClassicServer {
  sendTransaction(tx: never): Promise<{ status: string; hash: string; errorResult?: xdr.TransactionResult }>;
  pollTransaction(hash: string, opts: { attempts: number }): Promise<GetTx>;
}

/** Submits a signed classic tx and waits for it, with the same hash-keeping failures as sendAssembled. */
export async function sendClassic(
  server: ClassicServer,
  signed: { hash(): Uint8Array },
  what = "Trustline tx",
  onSubmitted?: (hash: string) => void,
): Promise<string> {
  const hash = hex(signed.hash());
  let sent: Awaited<ReturnType<ClassicServer["sendTransaction"]>>;
  try {
    sent = await server.sendTransaction(signed as never);
  } catch (e) {
    throw new TxError(`${what} still pending: ${e instanceof Error ? e.message : String(e)}`, { hash, stage: "pending" });
  }
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    const code = sent.status === "ERROR" ? resultCodes(sent.errorResult)[0] ?? "unknown" : "tryAgainLater";
    throw new TxError(`${what} not accepted: ${code}`, { hash, stage: "rejected", code });
  }
  onSubmitted?.(hash);
  let done: GetTx;
  try {
    done = await server.pollTransaction(hash, { attempts: 20 });
  } catch (e) {
    throw new TxError(`${what} still pending: ${e instanceof Error ? e.message : String(e)}`, { hash, stage: "pending" });
  }
  if (done.status !== "SUCCESS") throw notSuccess(done, hash, what);
  return hash;
}

// --- friendbot ------------------------------------------------------------------------

/** Friendbot's answer to an account that already exists (a second click while the first funds it). */
export const friendbotAlreadyFunded = (status: number, body: string) =>
  status === 400 && /createAccountAlreadyExist|op_already_exists/.test(body);
