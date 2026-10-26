#!/usr/bin/env python3
"""Download the raw price history behind docs/config-tuning.md into data/.

Run from the repo root:  python3 docs/research/config-tuning/fetch.py

Stdlib only. Overwrites data/*.csv and data/SOURCES.json. tune.py reads the
committed files, so re-fetching is only needed to refresh the numbers; a
re-fetch changes the latest rows (and DefiLlama may revise history).
"""
import csv
import datetime as dt
import json
import pathlib
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"

# FRED daily series (no key needed for the graph CSV endpoint).
FRED = {
    "DEXUSEU": "USD per EUR, noon buying rate (EUTBL FX leg)",
    "DEXMXUS": "MXN per USD, noon buying rate (CETES FX leg)",
    "DTB3": "3-month T-bill secondary market rate, % (T-bill fund shadow-NAV model)",
    "SP500": "S&P 500 index (SAFO swap-counterparty stress proxy; FRED keeps 10 years)",
}

# CoinGecko ids, read through DefiLlama's coins API (no key, 500 points a call).
TOKENS = {
    "franklin-templeton-benji": "BENJI (Franklin OnChain U.S. Government Money Fund)",
    "spiko-us-t-bills-money-market-fund": "USTBL (Spiko US T-Bills MMF)",
    "ondo-us-dollar-yield": "USDY (Ondo US Dollar Yield) - market price, not Ondo's NAV oracle",
    "eutbl": "EUTBL (Spiko EU T-Bills MMF), in USD",
    "cetes": "CETES (Etherfuse), in USD",
    "safo": "SAFO (Spiko Amundi Overnight Swap Fund, USD class)",
    "spiko-amundi-overnight-swap-fund-eur": "eurSAFO (same fund, EUR class), in USD",
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "caravel-config-tuning"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def fetch_fred(series):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
    (DATA / f"fred_{series}.csv").write_text(get(url))
    return url


def fetch_token(cg_id):
    now = int(time.time())
    points = {}
    base = "https://coins.llama.fi/chart/coingecko:{id}?start={start}&span=500&period=1d&searchWidth=600"
    for k in range(3):  # three 499-day windows back from today
        url = base.format(id=cg_id, start=now - (k + 1) * 499 * 86400)
        body = json.loads(get(url))
        for p in body["coins"].get(f"coingecko:{cg_id}", {}).get("prices", []):
            points[p["timestamp"]] = p["price"]
    with open(DATA / f"token_{cg_id}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "usd_price"])
        for ts in sorted(points):
            w.writerow([dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat(), points[ts]])
    return base.format(id=cg_id, start="<now - k*499 days>") + "  (k = 1..3)"


def main():
    DATA.mkdir(exist_ok=True)
    fetched = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    sources = {"fetched_at": fetched, "files": {}}
    for s, what in FRED.items():
        sources["files"][f"fred_{s}.csv"] = {"what": what, "url": fetch_fred(s),
                                             "page": f"https://fred.stlouisfed.org/series/{s}"}
    for cg_id, what in TOKENS.items():
        sources["files"][f"token_{cg_id}.csv"] = {"what": what, "url": fetch_token(cg_id),
                                                  "page": f"https://www.coingecko.com/en/coins/{cg_id}"}
    (DATA / "SOURCES.json").write_text(json.dumps(sources, indent=2) + "\n")
    print(f"fetched {len(sources['files'])} files into {DATA}")


if __name__ == "__main__":
    main()
