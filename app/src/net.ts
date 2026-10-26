// Time limits on every network read and write (Raven Q-01): a hung RPC or Horizon
// must fail with an error the app can show, not leave stale data on screen while
// the 10 s refresh stacks new reads. Pure (no local imports) for plain node --test.

/** Per RPC request (simulate, send, getTransaction, getLedgerEntries). */
export const RPC_TIMEOUT_MS = 15_000;
/** Horizon account read and friendbot. */
export const HORIZON_TIMEOUT_MS = 10_000;
export const FRIENDBOT_TIMEOUT_MS = 30_000;

/** Sets the per-request timeout on an rpc.Server's HTTP client, and returns the server. */
export function bounded<S extends { httpClient: { defaults: { timeout?: number } } }>(server: S, ms = RPC_TIMEOUT_MS): S {
  server.httpClient.defaults.timeout = ms;
  return server;
}

/** fetch() that gives up after `ms` (AbortSignal.timeout rejects with a TimeoutError). */
export const fetchWithin = (url: string, ms: number) => fetch(url, { signal: AbortSignal.timeout(ms) });
