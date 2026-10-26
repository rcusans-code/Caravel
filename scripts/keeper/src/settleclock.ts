// Band settle clock (nav-review side band-real-move): the repo accepts a NAV
// outside the #31 window band once its level has stood
// `AssetConfig.band_settle_secs` of ledger time, measured from the first
// `note_nav` that saw it. The keeper calls `note_nav` as soon as a level
// moves, so the clock starts one tick after the feed prints. Pure: no I/O,
// so it is unit-tested in settleclock.test.ts.

/** `BandCandidate` from the repo contract: the level and when it was first noted. */
export interface BandCandidate {
  price: bigint;
  since: bigint;
}

/**
 * True when `note_nav` would write: no level stored yet, or the simulated
 * call returns a different level (a restart). An unchanged level is not sent,
 * so a quiet feed costs no transactions.
 */
export function noteNeeded(stored: BandCandidate | null | undefined, simulated: BandCandidate): boolean {
  return !stored || stored.price !== simulated.price || stored.since !== simulated.since;
}

/** A simulation error from a contract deployed before `note_nav` existed. */
export function noteUnsupported(message: string): boolean {
  return /non-existent contract function|MissingValue/i.test(message);
}
