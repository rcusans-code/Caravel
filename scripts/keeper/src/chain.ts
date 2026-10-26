// Minimal Soroban helpers shared by the keeper and set-nav: read .env, simulate
// views, send signed invocations. Uses @stellar/stellar-sdk directly so a
// redeploy (new contract IDs in .env) needs no binding rebuild.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { padTransaction } from "./padding.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENV_FILE = process.env.ENV_FILE ?? path.join(ROOT, ".env");
loadEnv({ path: ENV_FILE, quiet: true });

/** Re-read .env over process.env, e.g. after deploy.sh wrote new contract IDs. */
export const reloadEnv = () => loadEnv({ path: ENV_FILE, quiet: true, override: true });

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} not set in .env`);
  return v;
}

export const NETWORK = env("NETWORK", "testnet");
export const PASSPHRASE = NETWORK === "testnet" ? Networks.TESTNET : env("NETWORK_PASSPHRASE");
export const server = new rpc.Server(env("RPC_URL", "https://soroban-testnet.stellar.org"));
// Testnet inclusion fees spike; pay up so keeper txs are not dropped.
const INCLUSION_FEE = process.env.INCLUSION_FEE ?? String(Number(BASE_FEE) * 1000);

export const txLink = (hash: string) => `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;

export const ts = () => new Date().toISOString().slice(11, 19);
export const log = (msg: string) => console.log(`${ts()} ${msg}`);

/** Contract error code from a simulation/tx error string, e.g. "Error(Contract, #9)". */
export class ContractError extends Error {
  constructor(public code: number | null, message: string) {
    super(message);
  }
}
function toContractError(raw: string): ContractError {
  const m = /Error\(Contract, #(\d+)\)/.exec(raw);
  return new ContractError(m ? Number(m[1]) : null, m ? `contract error #${m[1]}` : raw.split("\n")[0]);
}

// ScVal builders for the argument shapes we use.
export const u64 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: "u64" });
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const stellarAsset = (sac: string) =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(sac).toScVal()]);

async function build(source: string, contractId: string, method: string, args: xdr.ScVal[]) {
  const account = await server.getAccount(source);
  return new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
}

/** Simulate a call and return its decoded return value. Throws ContractError. */
export async function view<T = unknown>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  source = env("ADMIN_ADDRESS"),
): Promise<T> {
  const sim = await server.simulateTransaction(await build(source, contractId, method, args));
  if (rpc.Api.isSimulationError(sim)) throw toContractError(sim.error);
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
  const tx = await build(signer.publicKey(), contractId, method, args);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw toContractError(sim.error);
  const prepared = padTransaction(rpc.assembleTransaction(tx, sim).build());
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new SendError(`send ${sent.status}: ${sent.errorResult?.result().switch().name ?? "busy"}`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx ${done.status} ${txLink(sent.hash)}`);
  }
  const ret = (done as rpc.Api.GetSuccessfulTransactionResponse).returnValue;
  return { hash: sent.hash, result: ret ? scValToNative(ret) : undefined };
}

/** Keypair for an .env role: KEY_SECRET, e.g. keypair("ADMIN"). */
export const keypair = (role: string) => Keypair.fromSecret(env(`${role}_SECRET`));

// Contract error codes (contracts/repo/src/errors.rs) and the keeper's reading of them.
export { Err, outcomeOf, type Outcome } from "./errors.js";
