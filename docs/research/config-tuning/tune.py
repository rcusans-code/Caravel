#!/usr/bin/env python3
"""Reproduce the risk numbers in docs/config-tuning.md from the committed data.

Run from the repo root:  python3 docs/research/config-tuning/tune.py

Stdlib only, offline (reads data/, written by fetch.py). Prints, per asset, the
worst NAV moves found in the data, the minimum safe margin trigger, haircut and
NAV band they imply, and checks the chosen values (CHOSEN below, the same
numbers as scripts/deploy.sh, README and DECISIONS) against those minimums and
against the contract rule discount <= trigger < haircut < 10,000.
Exit code 1 if any check fails.

Model (docs/config-tuning.md section 2):
  lender is whole after a margin call iff the NAV falls less than
  (trigger - discount) between the last good print and the liquidation, so
    min trigger = discount + W(H) + buffer
  where W(H) is the worst fall over H calendar days in the data and
  H = 7: a Friday print is the last good one, Monday's print breaches and the
  call opens, the 3-day window ends Thursday, default and liquidation land
  Friday. That covers print gap + window + grace + liquidation (1+3+1+1 = 6).
    min haircut = chosen trigger + headroom
  headroom = the fall a max-LTV loan must survive in a normal week before it is
  called: the 1st percentile of 7-day returns, at least MIN_HEADROOM_BPS.
    min NAV band = worst move between two consecutive prints (both directions),
  since nav-keeper re-posts every 60 s and the band (DECISIONS #31) looks back
  20 records, so the window holds at most one real NAV change.
"""
import bisect
import csv
import datetime as dt
import math
import pathlib
import sys

DATA = pathlib.Path(__file__).resolve().parent / "data"

# --- assumptions (each is named in docs/config-tuning.md) -------------------
DISCOUNT_BPS = 100        # proposed global liquidation_discount_bps
BUFFER_BPS = 50           # model error, feed lag, rounding; an assumption
H_DAYS = 7                # Fri last good print -> Mon breach + call -> Thu deadline -> Fri liquidation
H_STRESS_DAYS = 10        # H plus a 3-day stall (holiday, stale NAV blocks liquidate #34, no liquidator)
TERM_DAYS = 7             # shortest term (headroom horizon)
HEADROOM_Q = 0.01         # a max-LTV loan is called in at most 1% of 7-day windows
MIN_HEADROOM_BPS = 50     # floor for funds whose NAV never falls in the data
WAM_DAYS = 60             # max weighted average maturity of a short-term MMF (SEC 2a-7, EU MMFR)
SINCE = "2006-01-01"      # 20 years: 2008, 2011, 2015 SNB, 2016, 2020, 2022 hikes

# --- chosen values (keep in sync with scripts/deploy.sh, README, DECISIONS) --
FEE_BPS = 1000
CHOSEN = {
    #          haircut trigger band (bps), cap (USDC), enabled
    "BENJI": dict(haircut=300, trigger=200, band=50, cap=2_000_000, enabled=True),
    "USTBL": dict(haircut=300, trigger=200, band=50, cap=2_000_000, enabled=True),
    "USDY": dict(haircut=300, trigger=200, band=50, cap=2_000_000, enabled=True),
    "EUTBL": dict(haircut=1200, trigger=850, band=500, cap=1_000_000, enabled=True),
    "CETES": dict(haircut=2350, trigger=1850, band=800, cap=500_000, enabled=True),
    "SAFO": dict(haircut=3000, trigger=2000, band=1200, cap=0, enabled=False),  # tSAFO on testnet
}


# --- loading ----------------------------------------------------------------
def d(s):
    return dt.date.fromisoformat(s)


def load_fred(name, since=SINCE):
    out = []
    with open(DATA / f"fred_{name}.csv") as f:
        r = csv.reader(f)
        next(r)
        for day, v in r:
            if v not in ("", ".") and day >= since:
                out.append((d(day), float(v)))
    return out


def load_token(cg_id):
    with open(DATA / f"token_{cg_id}.csv") as f:
        r = csv.reader(f)
        next(r)
        return [(d(day), float(v)) for day, v in r]


def tbill_shadow(since=SINCE):
    """Mark-to-market of a 60-day-WAM bill book on the 3-month rate, no accrual.

    price = 1 - y * WAM / 365, so a rise of dy costs dy * 60/365. Ignoring
    accrual makes every fall larger than a real fund's, i.e. conservative.
    """
    return [(day, 1 - y / 100 * WAM_DAYS / 365) for day, y in load_fred("DTB3", since)]


# --- statistics ---------------------------------------------------------------
def horizon_returns(series, days):
    dates = [x for x, _ in series]
    out = []
    for i, (day, p) in enumerate(series):
        j = bisect.bisect_right(dates, day + dt.timedelta(days=days)) - 1
        if j > i:
            out.append((series[j][1] / p - 1, day))
    return out


def worst_fall_bps(series, days):
    rs = horizon_returns(series, days)
    r, day = min(rs)
    return max(0.0, -r * 1e4), (day if r < 0 else None)


def one_print_bps(series):
    """Largest move, up or down, between consecutive observations."""
    best, when = 0.0, None
    for (d0, p0), (d1, p1) in zip(series, series[1:]):
        m = abs(p1 / p0 - 1) * 1e4
        if m > best:
            best, when = m, d1
    return best, when


def headroom_bps(series):
    rs = sorted(r for r, _ in horizon_returns(series, TERM_DAYS))
    q = rs[int(HEADROOM_Q * len(rs))]
    return max(MIN_HEADROOM_BPS, -q * 1e4)


def stats(series):
    wh, wh_day = worst_fall_bps(series, H_DAYS)
    ws, _ = worst_fall_bps(series, H_STRESS_DAYS)
    w1, w1_day = one_print_bps(series)
    return dict(n=len(series), start=series[0][0], end=series[-1][0], wh=wh, wh_day=wh_day,
                ws=ws, w1=w1, w1_day=w1_day, head=headroom_bps(series))


# --- assets -----------------------------------------------------------------
def assets():
    """(asset, [(label, series, used_for_sizing)]) per asset."""
    fx_eur = load_fred("DEXUSEU")
    fx_mxn = [(day, 1 / v) for day, v in load_fred("DEXMXUS")]
    return [
        ("BENJI", [("token price (CoinGecko via DefiLlama)", load_token("franklin-templeton-benji"), True),
                   ("model: 60-day-WAM bills on DTB3", tbill_shadow(), True)]),
        ("USTBL", [("token price (CoinGecko via DefiLlama)", load_token("spiko-us-t-bills-money-market-fund"), True),
                   ("model: 60-day-WAM bills on DTB3", tbill_shadow(), True)]),
        ("USDY", [("model: 60-day-WAM bills on DTB3", tbill_shadow(), True),
                  ("market price, not NAV (info only)", load_token("ondo-us-dollar-yield"), False)]),
        ("EUTBL", [("FX leg: USD per EUR (FRED DEXUSEU)", fx_eur, True),
                   ("token price, stale steps (info only)", load_token("eutbl"), False)]),
        ("CETES", [("FX leg: USD per MXN (1 / FRED DEXMXUS)", fx_mxn, True),
                   ("token price, 72 sparse points (info only)", load_token("cetes"), False)]),
        ("SAFO", [("token price (CoinGecko via DefiLlama)", load_token("safo"), True),
                  ("stress proxy: S&P 500 (FRED SP500)", load_fred("SP500"), True),
                  ("eurSAFO in USD (info only)", load_token("spiko-amundi-overnight-swap-fund-eur"), False)]),
    ]


def ceil_to(x, step):
    return int(math.ceil(x / step) * step)


def main():
    ok = True
    print(f"discount {DISCOUNT_BPS} bps, buffer {BUFFER_BPS} bps, H {H_DAYS} d (stress {H_STRESS_DAYS} d), "
          f"headroom p{HEADROOM_Q * 100:g} of {TERM_DAYS}-d returns (min {MIN_HEADROOM_BPS}), FX/rates since {SINCE}\n")
    print(f"| Asset | Series | Points | Range | Worst {H_DAYS}-d fall (start) | Worst {H_STRESS_DAYS}-d fall | "
          f"Largest 1-print move (date) | {TERM_DAYS}-d p{HEADROOM_Q * 100:g} fall (headroom) |")
    print("|---|---|---|---|---|---|---|---|")
    summary = []
    for name, series_list in assets():
        used = []
        for label, s, use in series_list:
            st = stats(s)
            tag = "" if use else " *"
            print(f"| {name} | {label}{tag} | {st['n']} | {st['start']} – {st['end']} | "
                  f"{st['wh']:.0f} bps ({st['wh_day'] or '-'}) | {st['ws']:.0f} bps | "
                  f"{st['w1']:.0f} bps ({st['w1_day'] or '-'}) | {st['head']:.0f} bps |")
            if use:
                used.append(st)
        wh = max(s["wh"] for s in used)
        ws = max(s["ws"] for s in used)
        w1 = max(s["w1"] for s in used)
        head = max(s["head"] for s in used)
        min_trigger = DISCOUNT_BPS + wh + BUFFER_BPS
        summary.append((name, wh, ws, w1, head, min_trigger))
    print("\n(* = shown for transparency, not used for sizing; see docs/config-tuning.md)\n")

    print(f"| Asset | W({H_DAYS}d) | Min trigger | Chosen trigger | Spare after W (≥ buffer {BUFFER_BPS}) | "
          f"Spare after W({H_STRESS_DAYS}d) | Min haircut (trigger + headroom) | Chosen haircut | Min band | Chosen band | Checks |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for name, wh, ws, w1, head, min_trigger in summary:
        c = CHOSEN[name]
        min_haircut = c["trigger"] + head
        checks = {
            "discount<=trigger": DISCOUNT_BPS <= c["trigger"],
            "trigger<haircut<10000": c["trigger"] < c["haircut"] < 10_000,
            "trigger>=min": c["trigger"] >= min_trigger,
            "haircut>=min": c["haircut"] >= min_haircut,
            "band>=min": c["band"] >= w1,
            "band>0": c["band"] > 0,
        }
        failed = [k for k, v in checks.items() if not v]
        ok &= not failed
        print(f"| {name} | {wh:.0f} | {ceil_to(min_trigger, 1)} | {c['trigger']} | {c['trigger'] - DISCOUNT_BPS - wh:.0f} | "
              f"{c['trigger'] - DISCOUNT_BPS - ws:.0f} | {ceil_to(min_haircut, 1)} | {c['haircut']} | "
              f"{ceil_to(w1, 1)} | {c['band']} | {'PASS' if not failed else 'FAIL: ' + ', '.join(failed)} |")
    print(f"\nglobal: liquidation_discount_bps {DISCOUNT_BPS}, fee_bps {FEE_BPS}; "
          f"{'all checks pass' if ok else 'SOME CHECKS FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
