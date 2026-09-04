#!/usr/bin/env python3
"""Build data/board.json -- the entire draft board, precomputed.

Runs in CI, never in the browser. Two reasons it has to work this way: Kalshi
rejects any request carrying an Origin header, so a static page cannot call it
at all; and doing the work here means the phone loads one JSON file and does
nothing but arithmetic during the draft.

Usage:
    python3 scripts/fetch_board.py [--fast] [--out data/board.json]

    --fast   skip per-market candlesticks (drops momentum, ~5x quicker)

Optional env for higher Kalshi rate limits (no other benefit -- every market
endpoint this reads is public):
    KALSHI_KEY_ID, KALSHI_PRIVATE_KEY
"""

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model
import sources
from sources import ESPN_POS, ESPN_TEAM, Http, Kalshi

SEASON = int(os.environ.get("FF_SEASON", "2026"))

# Hard ceiling on the whole build. Kalshi is dramatically slower from a shared
# CI runner IP than from a laptop, and an unbounded build just sits until the
# job timeout kills it, producing nothing. Exceeding this raises, which leaves
# the previously committed board in place -- stale data beats no data.
DEADLINE_S = float(os.environ.get("FF_DEADLINE_S", "600"))
_started_at = time.time()


def check_deadline(phase):
    if time.time() - _started_at > DEADLINE_S:
        raise TimeoutError(
            f"build exceeded {DEADLINE_S:.0f}s during {phase}; "
            f"keeping the existing board rather than shipping a partial one")
PRIOR_SEASON = SEASON - 1

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
HARD_OUT = {"OUT", "INJURY_RESERVE", "IR", "SUSPENSION", "SUSPENDED", "PUP",
            "NON_FOOTBALL_INJURY", "DOUBTFUL"}
# Multiplier applied to expected points for structurally unavailable players.
# Only hard, structured statuses move a ranking -- prose is shown, never scored.
STATUS_FACTOR = {"OUT": 0.55, "DOUBTFUL": 0.75, "IR": 0.2, "INJURY_RESERVE": 0.2,
                 "SUSPENSION": 0.35, "SUSPENDED": 0.35, "PUP": 0.35,
                 "NON_FOOTBALL_INJURY": 0.35, "QUESTIONABLE": 0.95}

TEAM_NICKNAMES = {
    "cardinals": "ARI", "falcons": "ATL", "ravens": "BAL", "bills": "BUF",
    "panthers": "CAR", "bears": "CHI", "bengals": "CIN", "browns": "CLE",
    "cowboys": "DAL", "broncos": "DEN", "lions": "DET", "packers": "GB",
    "texans": "HOU", "colts": "IND", "jaguars": "JAX", "chiefs": "KC",
    "raiders": "LV", "chargers": "LAC", "rams": "LAR", "dolphins": "MIA",
    "vikings": "MIN", "patriots": "NE", "saints": "NO", "giants": "NYG",
    "jets": "NYJ", "eagles": "PHI", "steelers": "PIT", "49ers": "SF",
    "niners": "SF", "seahawks": "SEA", "buccaneers": "TB", "titans": "TEN",
    "commanders": "WSH", "football team": "WSH",
}


def norm_name(name):
    """Normalise a player name for cross-source joining.

    Kalshi and ESPN disagree on suffixes and punctuation: 'James Cook III' vs
    'James Cook', "De'Von Achane" vs "De'Von Achane", 'Kyle Pitts Sr.',
    'Harold Fannin Jr.'. Strip both and they line up.
    """
    if not name:
        return ""
    s = name.lower().replace("&", " and ")
    s = re.sub(r"[.’'`\-]", "", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    parts = [p for p in s.split() if p and p not in SUFFIXES]
    return " ".join(parts)


def dst_team(label):
    """Map a D/ST label to a team abbreviation.

    Kalshi writes 'LA Rams D/ST', ESPN writes 'Rams D/ST'; matching on the
    nickname is what makes those meet.
    """
    s = (label or "").lower()
    for nick, abbr in TEAM_NICKNAMES.items():
        if nick in s:
            return abbr
    return None


# --------------------------------------------------------------------------


# A day's candle only counts as a price if real size traded and the book was
# tight enough to mean something. Two traps in this data, both of which invent
# moves that never happened:
#   * a single 7-contract print lands at 0.99 on a market actually worth 0.26
#   * `price.close` is the last *trade*, which in a thin book prints far
#     outside the resting quotes -- CeeDee Lamb closed at 0.36 on a day his
#     book was 0.08 bid / 0.35 ask
# The bid/ask midpoint is the honest daily price, so use that and ignore days
# whose book was too wide to be informative.
MIN_CANDLE_VOLUME = 25.0
MAX_CANDLE_SPREAD = 0.15
MIN_BASELINE_DAYS = 4


def candle_price(candle):
    """Midpoint of the day's closing book, or None if it says nothing."""
    bid = sources.money((candle.get("yes_bid") or {}).get("close_dollars"))
    ask = sources.money((candle.get("yes_ask") or {}).get("close_dollars"))
    if bid is not None and ask is not None and ask >= bid:
        if ask - bid > MAX_CANDLE_SPREAD:
            return None
        return (bid + ask) / 2.0
    return None


def price_momentum(candles):
    """7- and 30-day change in a market's price.

    Returns None unless there is a genuinely older reference price to compare
    against; a market that only started trading three days ago has no weekly
    trend, and guessing one would be worse than showing nothing.
    """
    real = []
    total_volume = 0.0
    for c in candles:
        vol = sources.money(c.get("volume_fp")) or 0.0
        total_volume += vol
        price = candle_price(c)
        ts = c.get("end_period_ts")
        if price is not None and ts and vol >= MIN_CANDLE_VOLUME:
            real.append((ts, price))
    if len(real) < 2:
        return None

    latest_ts, latest = real[-1]
    cutoff = MIN_BASELINE_DAYS * 86400

    def delta(days):
        ref = next((v for t, v in reversed(real) if t <= latest_ts - days * 86400), None)
        if ref is None:
            oldest_ts, oldest = real[0]
            if latest_ts - oldest_ts < cutoff:
                return None
            ref = oldest
        return round(latest - ref, 4)

    return {"d7": delta(7), "d30": delta(30), "vol30": round(total_volume, 1)}


def load_espn(http):
    print("ESPN: pulling players, projections and ADP...")
    raw = sources.espn_players(http, SEASON)
    print(f"  {len(raw)} players")

    players, actuals = {}, defaultdict(list)
    for entry in raw:
        p = entry.get("player") or {}
        pos = ESPN_POS.get(p.get("defaultPositionId"))
        if not pos:
            continue
        name = p.get("fullName")
        proj = sources.stat_total(p, 1, SEASON)
        prior = sources.stat_total(p, 0, PRIOR_SEASON)
        if prior:
            actuals[pos].append(prior)
        own = p.get("ownership") or {}
        adp = own.get("averageDraftPosition")
        key = dst_team(name) if pos == "DST" else norm_name(name)
        if not key:
            continue
        players[(pos, key)] = {
            "name": name,
            "pos": pos,
            "team": ESPN_TEAM.get(p.get("proTeamId"), "FA"),
            "espn_pts": round(proj, 1) if proj else None,
            "prior_pts": round(prior, 1) if prior else None,
            "adp": round(adp, 1) if adp and adp > 0 else None,
            "rostered": round(own.get("percentOwned") or 0, 1),
            "injury": p.get("injuryStatus"),
            "bye": sources.bye_week(p, SEASON),
        }
    print(f"  {len(players)} usable, "
          f"{sum(1 for v in players.values() if v['adp'])} with ADP")
    return players, actuals


def load_kalshi(http, fast=False):
    """Fetch every ladder, then calibrate each position's rank CDFs."""
    k = Kalshi(http, os.environ.get("KALSHI_KEY_ID"),
               os.environ.get("KALSHI_PRIVATE_KEY"))
    print(f"Kalshi: fetching ladders ({'authenticated' if k.authed else 'public'})...")
    ladders_started = time.time()

    raw = defaultdict(lambda: defaultdict(dict))   # pos -> player -> {n: prob}
    meta = defaultdict(dict)                       # pos -> player -> quote info
    ladder_error = defaultdict(dict)               # pos -> n -> |sum - n| / n
    tickers = {}                                   # (pos, player) -> top-1 ticker

    for pos, ladders in model.LADDERS.items():
        for n, event in ladders:
            check_deadline(f"ladder {event}")
            try:
                markets = k.markets(event)
            except Exception as e:
                print(f"  ! {event}: {e}")
                continue
            layer = {}
            for m in markets:
                label = m.get("no_sub_title") or m.get("yes_sub_title")
                if not label:
                    continue
                key = dst_team(label) if pos == "DST" else norm_name(label)
                if not key:
                    continue
                mid, bid, spread = sources.quote(m)
                if mid is None:
                    continue
                layer[key] = mid
                prev = meta[pos].get(key, {})
                oi = sources.money(m.get("open_interest_fp")) or 0.0
                # Keep the tightest quote seen across the ladders as the
                # player's representative book quality.
                if not prev or (spread or 1) < prev.get("spread", 1):
                    meta[pos][key] = {"spread": spread, "oi": oi,
                                      "label": label, "ticker": m.get("ticker")}
                else:
                    prev["oi"] = max(prev.get("oi", 0), oi)
                if n == 1:
                    tickers[(pos, key)] = m.get("ticker")
            if not layer:
                continue
            total = sum(layer.values())
            ladder_error[pos][n] = abs(total - n) / n
            for key, v in layer.items():
                raw[pos][key][n] = v
            print(f"  {event:<30} {len(layer):>3} players  raw sum={total:.2f} (target {n})")

    print(f"  ladders done in {time.time() - ladders_started:.0f}s "
          f"({http.limited} rate-limit hits, pace {http.throttle:.1f}s)")

    cdfs, momentum = {}, {}
    for pos, ladders in model.LADDERS.items():
        ns = [n for n, _ in ladders]
        if raw[pos]:
            cdfs[pos] = model.calibrate_position(raw[pos], ns)

    if not fast:
        # Momentum is a tiebreaker, not the deliverable, so it runs on a clock.
        # Kalshi throttles a shared CI runner IP far harder than a laptop, and a
        # board that ships without trend arrows beats a job that times out with
        # no board at all.
        budget = float(os.environ.get("FF_MOMENTUM_BUDGET_S", "180"))
        started = time.time()

        # Spend the budget on the players it would actually change a decision
        # for: deepest books first, since a thin market contributes no signal
        # anyway and would just burn the clock.
        ranked = sorted(
            ((k_, t) for k_, t in tickers.items() if t),
            key=lambda kt: -(meta[kt[0][0]].get(kt[0][1], {}).get("oi") or 0),
        )
        # Most of these markets are too thin to clear the volume and spread
        # filters anyway -- locally only ~33 of 167 yield usable momentum -- so
        # the long tail is calls spent to learn nothing.
        limit = int(os.environ.get("FF_MOMENTUM_MARKETS", "70"))
        ranked = ranked[:limit]
        print(f"Kalshi: candlesticks for momentum "
              f"({len(ranked)} deepest markets, {budget:.0f}s budget)...")

        done = 0
        for (pos, key), ticker in ranked:
            if time.time() - started > budget:
                print(f"  budget reached after {done}/{len(ranked)}; "
                      f"shipping without momentum for the rest")
                break
            candles = k.candles("KXNFLFFLEADER", ticker)
            done += 1
            if not candles:
                continue
            mom = price_momentum(candles)
            if mom:
                momentum[(pos, key)] = mom
        print(f"  momentum for {len(momentum)} players "
              f"({http.limited} rate-limit hits, pace {http.throttle:.1f}s)")
    return cdfs, meta, ladder_error, momentum, k.authed


def build(fast=False):
    http = Http()
    t0 = time.time()
    espn, actuals = load_espn(http)
    print(f"  [{time.time() - t0:.0f}s elapsed]")
    curves = model.rank_points_curve(actuals)
    print("Rank curve from %d actuals: %s" % (
        sum(len(v) for v in actuals.values()),
        ", ".join(f"{p}1={c[0]:.0f}/{p}12={c[min(11, len(c) - 1)]:.0f}"
                  for p, c in sorted(curves.items()))))

    t1 = time.time()
    cdfs, meta, ladder_error, momentum, authed = load_kalshi(http, fast)
    print(f"  [Kalshi phase {time.time() - t1:.0f}s, total {time.time() - t0:.0f}s]")

    espn_by_pos = defaultdict(dict)
    for (pos, key), rec in espn.items():
        if rec["espn_pts"]:
            espn_by_pos[pos][key] = rec["espn_pts"]

    mkt_pts = {}
    for pos, cdf in cdfs.items():
        if pos in curves:
            ns = [n for n, _ in model.LADDERS[pos]]
            raw_pts = model.market_points(cdf, curves[pos], ns)
            mkt_pts[pos] = model.rescale_to_baseline(raw_pts, espn_by_pos[pos])

    # Ladder error is a position-level quality signal. Weight the Top-1 ladder
    # most heavily -- it is the tightest and most traded of the set.
    pos_error = {}
    for pos, errs in ladder_error.items():
        if not errs:
            continue
        wsum = sum(1.0 / n for n in errs)
        pos_error[pos] = sum(e / n for n, e in errs.items()) / wsum

    players, matched = [], 0
    for (pos, key), rec in espn.items():
        cdf = (cdfs.get(pos) or {}).get(key)
        m = (meta.get(pos) or {}).get(key, {})
        mp = (mkt_pts.get(pos) or {}).get(key)
        mom = momentum.get((pos, key))

        conf = 0.0
        if cdf:
            conf = model.confidence(m.get("spread"), m.get("oi"),
                                    pos_error.get(pos, 0.0),
                                    (mom or {}).get("vol30"))
        pts, w = model.blend(mp, rec["espn_pts"], conf)
        if cdf:
            matched += 1

        status = (rec.get("injury") or "").upper()
        if status in ("ACTIVE", "HEALTHY", "NORMAL"):
            status = ""          # healthy is the default, not a badge
        pts *= STATUS_FACTOR.get(status, 1.0)

        players.append({
            "id": f"{pos}:{key}",
            "name": rec["name"],
            "pos": pos,
            "team": rec["team"],
            "pts": round(pts, 1),
            "espn_pts": rec["espn_pts"],
            "mkt_pts": round(mp, 1) if mp is not None else None,
            "w": round(w, 3),
            "adp": rec["adp"],
            "rostered": rec["rostered"],
            "bye": rec["bye"],
            "injury": status or None,
            "p": {str(n): round(v, 4) for n, v in sorted(cdf.items())} if cdf else None,
            "d7": (mom or {}).get("d7"),
            "d30": (mom or {}).get("d30"),
            "oi": round(m.get("oi", 0)) or None,
        })

    injuries = sources.espn_injuries(http)
    by_norm = {norm_name(n): v for n, v in injuries.items()}
    for p in players:
        hit = by_norm.get(norm_name(p["name"]))
        if hit:
            p["note"] = hit["note"]
            if not p["injury"] and hit["status"]:
                st = hit["status"].upper()
                if st not in ("ACTIVE", "HEALTHY"):
                    p["injury"] = st

    players.sort(key=lambda p: -p["pts"])
    for i, p in enumerate(players, 1):
        p["rank"] = i

    board = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "season": SEASON,
        "scoring": "PPR",
        "source": {
            "market": "Kalshi KXNFLFFLEADER / KXNFLFFLEADERTOP (settles on Sleeper PPR)",
            "baseline": "ESPN fantasy projections + ADP",
            "authenticated": authed,
            "http_calls": http.calls,
        },
        "rank_points": {p: [round(v, 1) for v in c[:60]] for p, c in curves.items()},
        "news": sources.espn_news(http),
        "players": players,
        "coverage": {
            "players": len(players),
            "with_market": matched,
            "with_adp": sum(1 for p in players if p["adp"]),
        },
    }
    return board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="skip candlesticks")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = args.out or os.path.join(root, "data", "board.json")

    start = time.time()
    board = build(args.fast)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(board, f, separators=(",", ":"))

    cov = board["coverage"]
    print(f"\nWrote {out} ({os.path.getsize(out) / 1024:.0f} KB) in {time.time() - start:.0f}s")
    print(f"  {cov['players']} players, {cov['with_market']} with market data, "
          f"{cov['with_adp']} with ADP")
    print("\nTop 15 by blended points:")
    for p in board["players"][:15]:
        src = f"mkt {p['mkt_pts']}" if p["mkt_pts"] else "espn only"
        print(f"  {p['rank']:>2}. {p['name']:<24} {p['pos']:<3} {p['team']:<4} "
              f"{p['pts']:>6.1f}  w={p['w']:.2f}  {src}")


if __name__ == "__main__":
    main()
