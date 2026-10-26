// NAV jump guard (flash-crash fixes #2 + #3): hold the keeper's check_margin,
// missed-margin default and liquidate while an asset's NAV has just jumped.
// Pure: no I/O, so it is unit-tested in navguard.test.ts.
//
// The oracle has no bound on a single push, and nav-keeper.sh re-posts the
// current price every ~60 s, so comparing the two newest records never sees a
// jump. Instead the current price is measured against an anchor: the most
// recent earlier price that stood longer than holdSecs.

export interface PriceData {
  price: bigint;
  timestamp: bigint;
}

export interface NavGuardOpts {
  /** Asset id: the latch key. */
  asset: string;
  /** A jump above this holds until the price stood holdSecs (default 200). */
  jumpBps: bigint;
  /** A jump above this holds until a human acks the exact price (default 1000). */
  ackBps: bigint;
  /** How long a jumped price must stand before it is trusted (margin window + 60). */
  holdSecs: bigint;
  /** Acked exact oracle prices (NAV_JUMP_ACK). An acked current price is never held for a jump. */
  acks: ReadonlySet<bigint>;
  /** Clock skew tolerated before the current record counts as future-dated (default 30). */
  futureSkewSecs?: bigint;
  /**
   * Last price this keeper released (navstate.ts, survives a restart). When it
   * has left the 20-record history (keeper down while a bad price was
   * re-posted 20 times), it is the anchor, so the jump is still seen.
   */
  trusted?: bigint;
}

export type HoldReason =
  | "none" // nothing to compare against, or within bounds
  | "acked" // jumped, but the current price is acked
  | "jump" // > jumpBps and has not stood holdSecs
  | "needs-ack" // > ackBps and not acked
  | "latched" // a further unacked price while a needs-ack latch exists (measured against the latch anchor)
  | "future-dated"; // current record timestamped in the future: fail closed

export interface NavHold {
  hold: boolean;
  reason: HoldReason;
  jumpBps: bigint;
  /** Price the current one is measured against; null without an earlier segment. */
  anchor: bigint | null;
  current: bigint | null;
  /** now - first record of the current price (negative when future-dated). */
  stoodSecs: bigint;
  needsAck: boolean;
}

/**
 * Latch: asset id -> the trusted pre-jump `anchor` of the first needs-ack jump
 * and the unacked prices (`bad`) held since. While it exists every price is
 * measured against `anchor`, so a bad price never becomes the anchor. It is
 * dropped on an ack or once no `bad` price is left in the history; `bad` is
 * pruned to the prices still in the history (at most 20). The keeper persists
 * it with the trusted prices (navstate.ts), so a restart keeps it.
 */
export type NavLatch = Map<string, { anchor: bigint; bad: Set<bigint> }>;

interface Segment {
  price: bigint;
  /** Timestamp of the segment's oldest record. */
  firstTs: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * Decide whether to hold NAV-driven keeper actions for one asset.
 * `history` is `prices(asset, 20)`: newest first.
 */
export function navHold(history: readonly PriceData[], now: bigint, opts: NavGuardOpts, latch: NavLatch): NavHold {
  const recs = [...history].sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp > b.timestamp ? -1 : 1));
  if (recs.length === 0) {
    latch.delete(opts.asset);
    return { hold: false, reason: "none", jumpBps: 0n, anchor: null, current: null, stoodSecs: 0n, needsAck: false };
  }

  // Group consecutive identical prices, newest segment first.
  const segs: Segment[] = [];
  for (const r of recs) {
    const s = segs[segs.length - 1];
    if (s && s.price === r.price) s.firstTs = r.timestamp;
    else segs.push({ price: r.price, firstTs: r.timestamp });
  }
  const current = segs[0].price;
  const stoodSecs = now - segs[0].firstTs;
  const acked = opts.acks.has(current);

  // Latch: held until the price is acked or every bad price has left the
  // history (then the history can be trusted again).
  let l = latch.get(opts.asset);
  if (l && (acked || !recs.some((r) => l!.bad.has(r.price)))) {
    latch.delete(opts.asset);
    l = undefined;
  }
  // Keep `bad` bounded: forget bad prices that left the history.
  if (l) for (const p of [...l.bad]) if (!recs.some((r) => r.price === p)) l.bad.delete(p);

  // Anchor: while a latch exists its pre-jump anchor, never a latched price.
  // Otherwise the most recent earlier segment that stood longer than holdSecs;
  // a segment lasts from its first record to the next segment's first record.
  let anchor: bigint | null = null;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i - 1].firstTs - segs[i].firstTs > opts.holdSecs) {
      anchor = segs[i].price;
      break;
    }
  }
  if (anchor === null && segs.length > 1) anchor = recs[recs.length - 1].price;
  // No continuity: the last released price left the history while the keeper
  // was down, so the history alone cannot show the jump (re-posts filled it).
  if (opts.trusted !== undefined && !recs.some((r) => r.price === opts.trusted)) anchor = opts.trusted;
  if (l) anchor = l.anchor;

  let jumpBps = 0n;
  if (anchor !== null) jumpBps = anchor > 0n ? (abs(current - anchor) * 10_000n) / anchor : current === anchor ? 0n : 10_000n;

  const out = (hold: boolean, reason: HoldReason, needsAck = false): NavHold => ({
    hold,
    reason,
    jumpBps,
    anchor,
    current,
    stoodSecs,
    needsAck,
  });

  // A future-dated current record is never trusted, acked or not.
  if (recs[0].timestamp > now + (opts.futureSkewSecs ?? 30n)) return out(true, "future-dated");
  // An ack releases both jump rules for that exact price.
  if (acked) return out(false, jumpBps > opts.jumpBps ? "acked" : "none");
  if (anchor !== null && jumpBps > opts.ackBps) {
    if (l) l.bad.add(current);
    else latch.set(opts.asset, { anchor, bad: new Set([current]) });
    return out(true, l ? "latched" : "needs-ack", true);
  }
  if (anchor !== null && jumpBps > opts.jumpBps && stoodSecs <= opts.holdSecs) return out(true, "jump");
  return out(false, "none");
}

/** One-line reason for the keeper log, e.g. "NAV -50.00% vs 1.00 (stood 45s/180s)". */
export function describeHold(h: NavHold, holdSecs: bigint, decimals: number): string {
  const px = (p: bigint) => (Number(p) / 10 ** decimals).toFixed(2);
  if (h.reason === "future-dated") return `NAV ${h.current === null ? "?" : px(h.current)} has a future-dated record (oracle timestamp ahead of now)`;
  if (h.anchor === null || h.current === null) return "no NAV jump";
  const pct = h.anchor > 0n ? (Number(h.current - h.anchor) * 100) / Number(h.anchor) : 100;
  if (h.reason === "latched") return `NAV ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs ${px(h.anchor)} (latched anchor)`;
  return `NAV ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs ${px(h.anchor)} (stood ${h.stoodSecs}s/${holdSecs}s)`;
}
