#!/usr/bin/env python3
"""Record eurSAFO's published NAV history and the dated EUR/USD rate for each
NAV day from the Spiko Public API (no auth), for size.py.

Run from the repo root:  python3 docs/research/spiko-nav/fetch.py

Writes data/eursafo.json: one row per NAV day with Spiko's NAV, its
publication time (`updatedAt`), and the EUR/USD rate Spiko published for the
same day, taken the way scripts/keeper/src/spiko.ts takes it live: the SAFO
fund's own rate first, else another Spiko fund's rate dated the same day
(USTBL publishes one too), else none (the feeder would not post that day).
Also writes the SAFO fund's nonOperatingDays.
Stdlib only. The API sits behind a WAF that refuses Python's default
User-Agent (403), so the requests name themselves.
"""
import concurrent.futures as cf
import datetime as dt
import json
import pathlib
import urllib.request

API = "https://public-api.spiko.io/v0"
SYMBOL = "eurSAFO"
START = "2026-01-01"  # the fund's first NAV is 2026-03-02
OUT = pathlib.Path(__file__).resolve().parent / "data" / "eursafo.json"
UA = {"User-Agent": "caravel-research/1.0 (+https://github.com/rcusans-code/Caravel)", "Accept": "application/json"}


def get(path):
    with urllib.request.urlopen(urllib.request.Request(API + path, headers=UA), timeout=20) as r:
        return json.load(r)


def main():
    share = get(f"/share-classes/{SYMBOL}")
    funds = get("/funds/")
    own = share["fundId"]
    fund_ids = [own] + [f["id"] for f in funds if f["id"] != own]
    navs = get(f"/net-asset-values/{SYMBOL}?startDay={START}")

    def fx_for(day):
        # latestUpdateDate = next midnight: the newest rate published before it.
        upto = (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()
        for fid in fund_ids:
            try:
                r = get(f"/exchange-rates/latest?fundId={fid}&baseCurrency=EUR&quoteCurrency=USD&latestUpdateDate={upto}")
            except Exception:
                continue
            if r["day"][:10] == day:
                return r
        return None

    days = [n["day"][:10] for n in navs]
    with cf.ThreadPoolExecutor(4) as ex:
        fxs = list(ex.map(fx_for, days))
    rows = []
    for n, f in zip(navs, fxs):
        rows.append(
            {
                "day": n["day"][:10],
                "nav": n["amount"]["value"],
                "nav_currency": n["amount"]["currency"],
                "nav_updated_at": n["updatedAt"],
                "fx": f["fxRate"] if f else None,
                "fx_kind": f.get("kind") if f else None,
                "fx_fund": ("own" if f["fundId"] == own else f["fundId"]) if f else None,
                "fx_updated_at": f["updatedAt"] if f else None,
            }
        )
    safo = next(f for f in funds if f["id"] == own)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": API,
                "symbol": SYMBOL,
                "isin": share.get("isin"),
                "fund": {"slug": safo["slug"], "id": own, "timezone": safo["timezone"]},
                "non_operating_days": sorted(d[:10] for d in safo["nonOperatingDays"]),
                "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "rows": rows,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"{len(rows)} NAV days, {sum(r['fx'] is None for r in rows)} without a same-day rate -> {OUT}")


if __name__ == "__main__":
    main()
