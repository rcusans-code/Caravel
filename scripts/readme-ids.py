#!/usr/bin/env python3
"""Write the README "Testnet deployment" table from deployments/testnet.json.

  scripts/readme-ids.py           # rewrite the block between the testnet-ids markers
  scripts/readme-ids.py --check   # exit 1 if the block is stale or README.md names
                                  # a contract id that is not in testnet.json

deploy.sh runs it in step 7, right after it writes testnet.json, so a redeploy
commit carries the new ids in the README too.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
DEPLOYMENT = ROOT / "deployments" / "testnet.json"
START = "<!-- testnet-ids:start: written by scripts/readme-ids.py from deployments/testnet.json; edits here are overwritten -->"
END = "<!-- testnet-ids:end -->"
ROWS = [
    ("repo", "Repo (Caravel)"),
    ("oracle", "Price feed (mock SEP-40)"),
    ("usdc", "USDC SAC (Circle testnet USDC)"),
    ("tbenji", "tBENJI SAC (AUTH_REQUIRED)"),
    ("tsafo", "tSAFO (Spiko-style mock, 5 decimals)"),
]
CONTRACT_ID = re.compile(r"\bC[A-Z2-7]{55}\b")


def block(dep: dict) -> str:
    net = dep.get("network", "testnet")
    lines = [START, "| Contract | ID |", "|---|---|"]
    for key, label in ROWS:
        cid = dep["contracts"][key]
        lines.append(f"| {label} | [`{cid}`](https://stellar.expert/explorer/{net}/contract/{cid}) |")
    lines += [
        "",
        f"Deployed {dep['deployedAt']}. The app and the keeper read the same ids from"
        " [deployments/testnet.json](deployments/testnet.json) and `.env`.",
        END,
    ]
    return "\n".join(lines)


def main() -> int:
    dep = json.loads(DEPLOYMENT.read_text())
    text = README.read_text()
    pattern = re.compile(re.escape(START.split(":")[0]) + r".*?" + re.escape(END), re.S)
    if not pattern.search(text):
        print("readme-ids: testnet-ids markers not found in README.md", file=sys.stderr)
        return 1
    new = pattern.sub(lambda _: block(dep), text, count=1)
    if "--check" in sys.argv[1:]:
        known = set(dep["contracts"].values())
        unknown = sorted(set(CONTRACT_ID.findall(text)) - known)
        if unknown:
            print(f"readme-ids: README.md ids not in testnet.json: {', '.join(unknown)}", file=sys.stderr)
        if new != text:
            print("readme-ids: README table is stale; run scripts/readme-ids.py", file=sys.stderr)
        return 1 if unknown or new != text else 0
    if new != text:
        README.write_text(new)
        print("readme-ids: README.md testnet table updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
