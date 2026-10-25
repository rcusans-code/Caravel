// Live transaction phase, so the UI can show TxProgress with real steps
// (design/components/TxProgress). chain.ts reports "sign" when it asks the
// signer and "submit" once it has the signature; App.tsx reports "prepare"
// (simulation) at the start and clears the state when the result lands.
export type Phase = "prepare" | "sign" | "submit";

type Listener = (p: Phase) => void;
let listener: Listener | null = null;

export function onPhase(l: Listener | null) {
  listener = l;
}

export function emitPhase(p: Phase) {
  listener?.(p);
}
