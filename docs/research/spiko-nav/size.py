#!/usr/bin/env python3
"""Size eurSAFO's NAV-feed settings from Spiko's real published history.

Run from the repo root:  python3 docs/research/spiko-nav/size.py

Stdlib only, offline: reads data/eursafo.json (written by fetch.py) and the
FRED series in ../config-tuning/data. Prints the measured numbers behind each
chosen value (CHOSEN, the same numbers as scripts/deploy.sh SPIKO_* defaults,
README and docs/numbers.md) and checks them. Exit 1 if a check fails.

What the feed posts (scripts/keeper/src/spiko.ts, DECISIONS #39 draft):
  price     = Spiko eurSAFO NAV (EUR) x Spiko EUR/USD rate dated the same day
  timestamp = the older of the two `updatedAt` publication times
one record per NAV day, never re-posted. So, unlike the re-posting testnet
feed that config-tuning.md sized the #31 band for ("the window holds at most
one real NAV change"), the 20-record band window here holds 20 business days
of real moves:
  band      >= the largest move between the latest print and any of the 19
               before it (else a real FX drift freezes takes, margin calls and
               liquidations until the #41 settle path accepts it), and
            >= the largest one-day EUR/USD move since 2006 (473 bps, the
               EUTBL band rule of DECISIONS #35)
  max age   :  the gaps between consecutive publications; a gap above it is
               a stale window (takes, margin calls, liquidations wait; repay
               and top-up never do)
  trigger   >= discount + worst 7-day fall + 50 bps buffer (#35 rule), on the
               stress proxy S&P 500 x EUR/USD (SAFO's swap basket priced in
               dollars; config-tuning.md 3.4 uses the S&P alone for SAFO)
  haircut   >= trigger + the 1st-percentile 7-day fall of the same proxy
"""
import bisect
import csv
import datetime as dt
import json
import pathlib
import sys
from decimal import Decimal as D

HERE = pathlib.Path(__file__).resolve().parent
FRED = HERE.parent / "config-tuning" / "data"

DISCOUNT_BPS = 100
BUFFER_BPS = 50
H_DAYS = 7
HEADROOM_Q = 0.01
BAND_WINDOW = 20          # records the repo's band reads (oracle.rs NAV_BAND_RECORDS)
EURUSD_ONE_DAY_BPS = 473  # largest one-day EUR/USD move since 2006 (config-tuning.md 3.2)
RECENT_DAYS = 60

CHOSEN = dict(
    max_nav_move_bps=500,
    max_nav_age_secs=345_600,  # 96 h (DECISIONS #25)
    band_settle_secs=86_400,   # 1 day (DECISIONS #41 production)
    margin_trigger_bps=2_050,
    haircut_bps=3_000,
)


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_points():
    data = json.loads((HERE / "data" / "eursafo.json").read_text())
    rows = data["rows"]
    pts = [
        (r["day"], D(r["nav"]) * D(r["fx"]), min(ts(r["nav_updated_at"]), ts(r["fx_updated_at"])))
        for r in rows
        if r["fx"] is not None
    ]
    no_fx = [r["day"] for r in rows if r["fx"] is None]
    return data, rows, pts, no_fx


def bps(a, b):
    return float(abs(a / b - 1)) * 1e4


def one_print(pts):
    return max((bps(b[1], a[1]), b[0]) for a, b in zip(pts, pts[1:]))


def window_spread(pts):
    return max(
        (bps(pts[i][1], pts[j][1]), pts[j][0], pts[i][0])
        for i in range(len(pts))
        for j in range(max(0, i - (BAND_WINDOW - 1)), i)
    )


def window_freezes(pts, band):
    return [
        pts[i][0]
        for i in range(len(pts))
        if any(bps(pts[i][1], pts[j][1]) > band for j in range(max(0, i - (BAND_WINDOW - 1)), i))
    ]


def gaps(pts):
    return sorted((((b[2] - a[2]).total_seconds(), a[0], b[0]) for a, b in zip(pts, pts[1:])), reverse=True)


def load_fred(name):
    out = {}
    with open(FRED / f"fred_{name}.csv") as f:
        r = csv.reader(f)
        next(r)
        for day, v in r:
            if v not in ("", "."):
                out[dt.date.fromisoformat(day)] = float(v)
    return out


def horizon_returns(series, days):
    dates = [x for x, _ in series]
    out = []
    for i, (day, p) in enumerate(series):
        j = bisect.bisect_right(dates, day + dt.timedelta(days=days)) - 1
        if j > i:
            out.append((series[j][1] / p - 1, day))
    return out


def main():
    data, rows, pts, no_fx = load_points()
    end = dt.date.fromisoformat(pts[-1][0])
    recent = [p for p in pts if p[0] >= (end - dt.timedelta(days=RECENT_DAYS)).isoformat()]
    fails = []

    print(f"eurSAFO (Spiko Public API, fetched {data['fetched_at']}): {len(rows)} NAV days "
          f"{rows[0]['day']} .. {rows[-1]['day']}, {len(pts)} with a same-day EUR/USD rate")
    print(f"  NAV days with no same-day rate anywhere (feeder waits a day): {', '.join(no_fx) or 'none'}")
    own = sum(1 for r in rows if r["fx_fund"] == "own")
    print(f"  rate from the SAFO fund itself: {own}; from another Spiko fund (USTBL): {len(pts) - own}")
    navs = [D(r["nav"]) for r in rows]
    falls = [n1 for n0, n1 in zip(navs, navs[1:]) if n1 < n0]
    print(f"  EUR NAV fell on {len(falls)} of {len(navs) - 1} prints; largest EUR NAV step "
          f"{max(bps(b, a) for a, b in zip(navs, navs[1:])):.2f} bps (weekend accrual)")
    hours = sorted(p[2].hour + p[2].minute / 60 for p in pts)
    print(f"  publication time (older of NAV/FX updatedAt), UTC: earliest {hours[0]:.2f} h, "
          f"median {hours[len(hours) // 2]:.2f} h, latest {hours[-1]:.2f} h")

    # Band
    print("\nNAV band (max_nav_move_bps, #31), USD price = NAV x FX:")
    for label, s in (("all", pts), (f"last {RECENT_DAYS} days", recent)):
        o, od = one_print(s)
        w, w0, w1 = window_spread(s)
        print(f"  {label:<13} n={len(s):>3}  largest one-print move {o:6.1f} bps ({od}); "
              f"largest 20-record window spread {w:6.1f} bps ({w0} -> {w1})")
    for band in (150, 200, 300, 400, CHOSEN["max_nav_move_bps"]):
        f_all, f_recent = window_freezes(pts, band), window_freezes(recent, band)
        print(f"  band {band:>4}: window path out of band on {len(f_all):>3} prints (last {RECENT_DAYS} d: {len(f_recent)})")
    w_all = window_spread(pts)[0]
    need_band = max(w_all, EURUSD_ONE_DAY_BPS)
    ok = CHOSEN["max_nav_move_bps"] > need_band
    print(f"  chosen {CHOSEN['max_nav_move_bps']} > max(window spread {w_all:.0f}, EUR/USD one day since 2006 "
          f"{EURUSD_ONE_DAY_BPS}) = {need_band:.0f}: {'OK' if ok else 'FAIL'}")
    if not ok:
        fails.append("band")

    # Staleness
    age = CHOSEN["max_nav_age_secs"]
    g = gaps(pts)
    over = [x for x in g if x[0] > age]
    print(f"\nNAV age (max_nav_age_secs, #25), gaps between consecutive publications:")
    for secs, a, b in g[:5]:
        print(f"  {secs / 3600:6.1f} h  {a} -> {b}")
    print(f"  chosen {age} s ({age / 3600:.0f} h): stale on {len(over)} gaps in {len(pts) - 1}: "
          + ", ".join(f"{a}->{b} for {(s - age) / 3600:.1f} h" for s, a, b in over))
    print(f"  a {g[0][0] / 3600:.0f} h limit would never have gone stale; 96 h keeps the DECISIONS #25 value "
          f"(stale only blocks take, check_margin, liquidate; never repay or top_up)")
    upcoming = [d for d in data["non_operating_days"] if d > rows[-1]["day"]]
    print(f"  SAFO non-operating days ahead: {', '.join(upcoming)}")
    # Spiko's history must not have a gap the 96 h limit misses by more than a day.
    if over and max(s for s, _, _ in over) - age > 86_400:
        fails.append("age")

    # Trigger / haircut on the stress proxy
    sp, eu = load_fred("SP500"), load_fred("DEXUSEU")
    days = sorted(set(sp) & set(eu))
    proxy = [(x, sp[x] * eu[x]) for x in days]
    r7 = horizon_returns(proxy, H_DAYS)
    worst, worst_day = min(r7)
    q = sorted(r for r, _ in r7)[int(HEADROOM_Q * len(r7))]
    w7, head = -worst * 1e4, max(50.0, -q * 1e4)
    spiko_w7 = min(horizon_returns([(dt.date.fromisoformat(p[0]), float(p[1])) for p in pts], H_DAYS))
    min_trigger = DISCOUNT_BPS + w7 + BUFFER_BPS
    min_haircut = CHOSEN["margin_trigger_bps"] + head
    print(f"\nTrigger and haircut, stress proxy S&P 500 x EUR/USD (FRED SP500 x DEXUSEU, {days[0]} .. {days[-1]}):")
    print(f"  worst 7-day fall {w7:.0f} bps (from {worst_day}); 1st-percentile 7-day fall {head:.0f} bps")
    print(f"  Spiko's own USD price: worst 7-day fall {-spiko_w7[0] * 1e4:.0f} bps (from {spiko_w7[1]})")
    t_ok = CHOSEN["margin_trigger_bps"] >= min_trigger
    h_ok = min_haircut <= CHOSEN["haircut_bps"] < 10_000
    print(f"  trigger {CHOSEN['margin_trigger_bps']} >= {DISCOUNT_BPS} + {w7:.0f} + {BUFFER_BPS} = {min_trigger:.0f}: "
          f"{'OK' if t_ok else 'FAIL'}")
    print(f"  haircut {CHOSEN['haircut_bps']} >= {CHOSEN['margin_trigger_bps']} + {head:.0f} = {min_haircut:.0f}: "
          f"{'OK' if h_ok else 'FAIL'}")
    if not (DISCOUNT_BPS < CHOSEN["margin_trigger_bps"] < CHOSEN["haircut_bps"]):
        fails.append("discount < trigger < haircut")
    if not t_ok:
        fails.append("trigger")
    if not h_ok:
        fails.append("haircut")

    print("\nchecks:", "all OK" if not fails else "FAILED: " + ", ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
