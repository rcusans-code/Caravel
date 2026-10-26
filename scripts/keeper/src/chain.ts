// Minimal Soroban helpers shared by the keeper and set-nav: read .env, simulate
// views, send signed invocations. Uses @stellar/stellar-sdk directly so a
// redeploy (new contract IDs in .env) needs no binding rebuild.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  contract as sdkContract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { errName, txFailReason } from "./errors.js";
import { padWrites } from "./headroom.js";
import { padTransaction } from "./padding.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENV_FILE = process.env.ENV_FILE ?? path.join(ROOT, ".env");
loadEnv({ path: ENV_FILE, quiet: true });

/** Re-read .env over process.env, e.g. after deploy.sh wrote new contract IDs. */
export const reloadEnv = () => loadEnv({ path: ENV_FILE, quiet: true, override: true });

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} not set in ${ENV_FILE} (set ENV_FILE to the keeper's .env, e.g. ~/.local/lib/caravel/.env)`);
  return v;
}

export const NETWORK = env("NETWORK", "testnet");
export const PASSPHRASE = NETWORK === "testnet" ? Networks.TESTNET : env("NETWORK_PASSPHRASE");
export const RPC_URL = env("RPC_URL", "https://soroban-testnet.stellar.org");
// Plain http only for a local RPC (tests, a local quickstart node).
export const server = new rpc.Server(RPC_URL, { allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL) });
// Bound every RPC request (Raven D-01). The SDK ignores an Options.timeout
// and its HTTP client otherwise waits ~300 s on an RPC that accepts and
// never answers, which freezes the keeper with no log line.
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 15_000);
server.httpClient.defaults.timeout = RPC_TIMEOUT_MS;

/** Called after every RPC answer (the keeper's tick watchdog listens). */
let rpcAnswered: () => void = () => {};
export const onRpcAnswer = (fn: () => void) => {
  rpcAnswered = fn;
};
// Testnet inclusion fees spike; pay up so keeper txs are not dropped.
const INCLUSION_FEE = process.env.INCLUSION_FEE ?? String(Number(BASE_FEE) * 1000);
// NO_WRITE_PAD=1 sends the bare simulated resources (only to reproduce the under-count).
const NO_PAD = process.env.NO_WRITE_PAD === "1";

export const txLink = (hash: string) => `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;

export const ts = () => new Date().toISOString().slice(11, 19);
export const log = (msg: string) => console.log(`${ts()} ${msg}`);

/** Contract error code from a simulation/tx error string, e.g. "Error(Contract, #9)". */
export class ContractError extends Error {
  constructor(public code: number | null, message: string) {
    super(message);
  }
}
/**
 * "contract error #7 InvalidStatus". The name comes from the repo contract's
 * table, so it is added only for calls to REPO_ID: the oracle and token
 * contracts number their errors differently.
 */
function toContractError(raw: string, contractId?: string): ContractError {
  const m = /Error\(Contract, #(\d+)\)/.exec(raw);
  if (!m) return new ContractError(null, raw.split("\n")[0]);
  const code = Number(m[1]);
  const name = contractId && contractId === process.env.REPO_ID ? errName(code) : "";
  return new ContractError(code, `contract error #${code}${name ? ` ${name}` : ""}`);
}

// ScVal builders for the argument shapes we use.
export const u64 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: "u64" });
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const stellarAsset = (sac: string) =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(sac).toScVal()]);

/** Simulation source for views: a well-known address with no ledger entry. */
export const NULL_ACCOUNT = sdkContract.NULL_ACCOUNT;

function build(account: Account, contractId: string, method: string, args: xdr.ScVal[]) {
  return new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
}

/**
 * Simulate a call and return its decoded return value. Throws ContractError.
 * The source needs no ledger entry (simulation never checks the sequence),
 * so no getAccount round trip: half the RPC calls, and an RPC outage reads as
 * the RPC error instead of "Account not found: G<admin>" (Raven D-04; the app
 * does the same in book.ts).
 */
export async function view<T = unknown>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  source: string = NULL_ACCOUNT,
): Promise<T> {
  const sim = await server.simulateTransaction(build(new Account(source, "0"), contractId, method, args));
  rpcAnswered();
  if (rpc.Api.isSimulationError(sim)) throw toContractError(sim.error, contractId);
  const ret = sim.result?.retval;
  return (ret ? scValToNative(ret) : undefined) as T;
}

/**
 * Simulate, sign, send and wait. Returns the tx hash and decoded return value.
 * Retries a rejected send (TRY_AGAIN_LATER, bad sequence when another process
 * signs with the same key) with a fresh sequence number.
 */
export async function invoke(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  attempts = 3,
): Promise<{ hash: string; result: unknown }> {
  for (let i = 1; ; i++) {
    try {
      return await invokeOnce(signer, contractId, method, args);
    } catch (e) {
      if (e instanceof ContractError || !(e instanceof SendError) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

class SendError extends Error {}

async function invokeOnce(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<{ hash: string; result: unknown }> {
  // A real send needs the signer's sequence number: the only getAccount call.
  const tx = build(await server.getAccount(signer.publicKey()), contractId, method, args);
  const sim = await server.simulateTransaction(tx);
  rpcAnswered();
  if (rpc.Api.isSimulationError(sim)) throw toContractError(sim.error, contractId);
  // Simulation under-counts write bytes when a token try_call is rolled back
  // (parked payout, failed auto-repay pull): send with headroom (headroom.ts),
  // then the general resource padding (padding.ts).
  if (rpc.Api.isSimulationSuccess(sim) && !NO_PAD) sim.transactionData = new SorobanDataBuilder(padWrites(sim.transactionData.build()));
  const assembled = rpc.assembleTransaction(tx, sim).build();
  const prepared = NO_PAD ? assembled : padTransaction(assembled);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  rpcAnswered();
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new SendError(`send ${sent.status}: ${sent.errorResult?.result().switch().name ?? "busy"}`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  rpcAnswered();
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    // A FAILED tx landed and was charged: say why (e.g. txFailed/invokeHostFunctionResourceLimitExceeded).
    const why = done.status === rpc.Api.GetTransactionStatus.FAILED ? txFailReason(done.resultXdr) : "";
    throw new Error(`tx ${done.status}${why ? ` (${why})` : ""} ${txLink(sent.hash)}`);
  }
  const ret = (done as rpc.Api.GetSuccessfulTransactionResponse).returnValue;
  return { hash: sent.hash, result: ret ? scValToNative(ret) : undefined };
}

/** Keypair for an .env role: KEY_SECRET, e.g. keypair("ADMIN"). */
export const keypair = (role: string) => Keypair.fromSecret(env(`${role}_SECRET`));

// Contract error codes (contracts/repo/src/errors.rs) and the keeper's reading of them.
export { Err, outcomeOf, type Outcome } from "./errors.js";
