// Wallet network checks shared by connect and session restore (Raven DW-06).
// Pure (no local imports) so app/test/session.test.ts runs it under plain node --test.

export class WrongNetworkError extends Error {}

export type GetNetwork = () => Promise<{ networkPassphrase?: string } | undefined | null>;

/**
 * True only when the wallet reports a network other than `expected`. A wallet
 * that cannot say (Albedo, xBull PWA: getNetwork throws or omits it) passes:
 * every signature pins the testnet passphrase anyway.
 */
export async function onOtherNetwork(getNetwork: GetNetwork, expected: string): Promise<boolean> {
  try {
    const net = await getNetwork();
    return !!net?.networkPassphrase && net.networkPassphrase !== expected;
  } catch {
    return false;
  }
}

export interface RestoreKit {
  getAddress(): Promise<{ address: string }>;
  getNetwork: GetNetwork;
  disconnect(): Promise<unknown>;
}

/**
 * Restores the stored wallet with no popup, then runs the same network check as
 * connect: a wallet that moved off `expected` since the last visit is disconnected
 * (so the next reload does not restore it either) and WrongNetworkError is thrown
 * for the app to flash.
 */
export async function restoreWallet(kit: RestoreKit, expected: string): Promise<string> {
  const { address } = await kit.getAddress();
  if (await onOtherNetwork(() => kit.getNetwork(), expected)) {
    await kit.disconnect().catch(() => undefined);
    throw new WrongNetworkError(
      "Your wallet is no longer on Testnet, so it was disconnected. Switch it to Testnet, then connect again.",
    );
  }
  return address;
}
