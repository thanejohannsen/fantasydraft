#!/usr/bin/env python3
"""Refuse to publish a board that would give bad advice.

Run after fetch_board.py. A silently degraded board -- market data dropped, a
ladder that failed to calibrate, everyone's projection zeroed -- is worse than
a stale one, because nothing on the phone would look wrong.
"""

import json
import os
import sys

MIN_PLAYERS = 400
MIN_MARKET = 120
MIN_ADP = 300

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "data", "board.json")
    board = json.load(open(path))
    players = board["players"]
    problems = []

    cov = board["coverage"]
    if cov["players"] < MIN_PLAYERS:
        problems.append(f"only {cov['players']} players (want >= {MIN_PLAYERS})")
    if cov["with_market"] < MIN_MARKET:
        problems.append(f"only {cov['with_market']} market-priced (want >= {MIN_MARKET})")
    if cov["with_adp"] < MIN_ADP:
        problems.append(f"only {cov['with_adp']} with ADP (want >= {MIN_ADP})")

    for pos in ("QB", "RB", "WR", "TE"):
        n = sum(1 for p in players if p["pos"] == pos and p["pts"] > 0)
        if n < 20:
            problems.append(f"{pos}: only {n} players with points")

    # Every player's Top-N ladder must be non-decreasing; a monotonicity break
    # means calibration diverged and the rank buckets are meaningless.
    for p in players:
        if not p.get("p"):
            continue
        vals = [v for _, v in sorted(p["p"].items(), key=lambda kv: int(kv[0]))]
        if any(b < a - 1e-6 for a, b in zip(vals, vals[1:])):
            problems.append(f"{p['name']}: non-monotone ladder {vals}")
        if any(v < 0 or v > 1 for v in vals):
            problems.append(f"{p['name']}: ladder outside [0,1] {vals}")

    # Momentum is a price delta on a [0,1] contract; anything near a full
    # dollar is a parsing bug, not a market move.
    for p in players:
        for k in ("d7", "d30"):
            v = p.get(k)
            if v is not None and abs(v) > 0.5:
                problems.append(f"{p['name']}: implausible {k}={v}")

    if not any(p["w"] > 0.3 for p in players):
        problems.append("no player carries meaningful market weight")

    if problems:
        print("Board FAILED validation:")
        for p in problems[:25]:
            print("  -", p)
        return 1

    print(f"Board OK: {cov['players']} players, {cov['with_market']} market-priced, "
          f"{sum(1 for p in players if p.get('d7') is not None)} with momentum")
    return 0


if __name__ == "__main__":
    sys.exit(main())
