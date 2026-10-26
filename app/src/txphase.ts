// Live transaction phase, so the UI can show TxProgress with real steps
// (design/components/TxProgress). chain.ts reports "sign" when it asks the
// signer and "submit" once it has the signature, then "submit" again with the
// tx hash as soon as the network accepts it (Raven DW-02); App.tsx reports
// "prepare" (simulation) at the start and clears the state when the result lands.
export type Phase = "prepare" | "sign" | "submit";

type Listener = (p: Phase, hash?: string) => void;
let listener: Listener | null = null;

export function onPhase(l: Listener | null) {
  listener = l;
}

export function emitPhase(p: Phase, hash?: string) {
  listener?.(p, hash);
}
