"""Turning Kalshi Top-N probabilities into expected fantasy points.

The markets say "P(this player finishes Top-N at his position)". Drafting needs
expected points. The bridge is a rank distribution: the Top-1/3/5/10 ladders are
four points on each player's CDF over positional finish, and a table of points
by positional finish converts that CDF into points.
"""

import math

# Ladder tickers, per position, as (N, event_ticker). QB/RB/WR carry the full
# Top-1/3/5/10 set; TE has no Top-5; K and DST stop at Top-3.
LADDERS = {
    "QB":  [(1, "KXNFLFFLEADER-27QB"),  (3, "KXNFLFFLEADERTOP-27QBT3"),
            (5, "KXNFLFFLEADERTOP-27QBT5"), (10, "KXNFLFFLEADERTOP-27QBT10")],
    "RB":  [(1, "KXNFLFFLEADER-27RB"),  (3, "KXNFLFFLEADERTOP-27RBT3"),
            (5, "KXNFLFFLEADERTOP-27RBT5"), (10, "KXNFLFFLEADERTOP-27RBT10")],
    "WR":  [(1, "KXNFLFFLEADER-27WR"),  (3, "KXNFLFFLEADERTOP-27WRT3"),
            (5, "KXNFLFFLEADERTOP-27WRT5"), (10, "KXNFLFFLEADERTOP-27WRT10")],
    "TE":  [(1, "KXNFLFFLEADER-27TE"),  (3, "KXNFLFFLEADERTOP-27TET3"),
            (10, "KXNFLFFLEADERTOP-27TET10")],
    "K":   [(1, "KXNFLFFLEADER-27K"),   (3, "KXNFLFFLEADERTOP-27KT3")],
    "DST": [(1, "KXNFLFFLEADER-27DST"), (3, "KXNFLFFLEADERTOP-27DSTT3")],
}

SERIES_OF = {"KXNFLFFLEADER": "KXNFLFFLEADER", "KXNFLFFLEADERTOP": "KXNFLFFLEADERTOP"}


def calibrate_ladder(probs, n, iterations=12):
    """Scale a Top-N ladder so its probabilities sum to exactly N.

    Mid-prices carry the bid/ask overround, so raw sums run high -- the RB Top-1
    ladder sums to 1.26 and the RB Top-10 ladder to 11.70. Exactly N players
    finish in the top N, so N is the correct target. Scaling multiplicatively
    would push probabilities above 1, so this uses a power transform, which
    preserves ordering and stays inside [0, 1].
    """
    if not probs:
        return {}
    keys = list(probs)
    vals = [min(max(probs[k], 1e-6), 1 - 1e-6) for k in keys]
    total = sum(vals)
    if total <= 0:
        return {k: 0.0 for k in keys}
    if abs(total - n) < 1e-9:
        return dict(zip(keys, vals))

    # Find the exponent a for which sum(p**a) == n. Larger a shrinks, smaller
    # a inflates; sum is monotone decreasing in a, so bisect.
    lo, hi = 0.05, 20.0
    for _ in range(60):
        mid = (lo + hi) / 2
        s = sum(v ** mid for v in vals)
        if s > n:
            lo = mid
        else:
            hi = mid
    a = (lo + hi) / 2
    return {k: min(v ** a, 1.0) for k, v in zip(keys, vals)}


def enforce_monotone(cdf_by_player, ns):
    """Clamp each player's ladder so P(top1) <= P(top3) <= P(top5) <= P(top10)."""
    out = {}
    for player, cdf in cdf_by_player.items():
        running = 0.0
        fixed = {}
        for n in ns:
            if n in cdf:
                running = max(running, min(cdf[n], 1.0))
                fixed[n] = running
        out[player] = fixed
    return out


def calibrate_position(raw, ns, rounds=4):
    """Alternate ladder-normalisation and per-player monotonicity until stable.

    Each projection breaks the other slightly; a few passes converge.
    `raw` is {player: {n: prob}}; returns the same shape, calibrated.
    """
    cdf = {p: dict(v) for p, v in raw.items()}
    for _ in range(rounds):
        for n in ns:
            layer = {p: c[n] for p, c in cdf.items() if n in c}
            if not layer:
                continue
            fixed = calibrate_ladder(layer, n)
            for p, v in fixed.items():
                cdf[p][n] = v
        cdf = enforce_monotone(cdf, ns)
    return cdf


def rank_points_curve(actuals_by_pos, smooth=True):
    """Points by positional finish rank, from last season's actual PPR totals.

    Returns {pos: [pts_for_rank1, pts_for_rank2, ...]}. Lightly smoothed, since
    an individual season's rank curve is noisy at the tail.
    """
    curves = {}
    for pos, totals in actuals_by_pos.items():
        vals = sorted((v for v in totals if v and v > 0), reverse=True)
        if len(vals) < 5:
            continue
        if smooth and len(vals) >= 7:
            sm = []
            for i in range(len(vals)):
                lo, hi = max(0, i - 1), min(len(vals), i + 2)
                sm.append(sum(vals[lo:hi]) / (hi - lo))
            vals = sm
        curves[pos] = vals
    return curves


def _bucket_mean(curve, lo, hi):
    """Mean points over finish ranks lo..hi inclusive (1-indexed)."""
    lo_i, hi_i = lo - 1, min(hi, len(curve))
    if lo_i >= len(curve) or lo_i >= hi_i:
        return curve[-1] if curve else 0.0
    seg = curve[lo_i:hi_i]
    return sum(seg) / len(seg)


def market_points(cdf_by_player, curve, ns):
    """Expected fantasy points implied by a calibrated rank CDF.

    Splits the CDF into finish buckets, weights each by the mean points of the
    ranks it covers, and handles the open-ended tail by spreading players who
    miss the top N across the remaining ranks in CDF order.
    """
    if not curve:
        return {}
    top = max(ns)

    # Expected tail rank for players outside the top N: order by their CDF at
    # the deepest ladder and lay their leftover mass end to end starting at
    # rank top+1, so a near-miss star lands above a deep flier.
    tail_rank = {}
    ordered = sorted(cdf_by_player.items(), key=lambda kv: -kv[1].get(top, 0.0))
    cursor = 0.0
    for player, cdf in ordered:
        mass = max(0.0, 1.0 - cdf.get(top, 0.0))
        tail_rank[player] = top + cursor + mass / 2.0 + 1.0
        cursor += mass

    out = {}
    for player, cdf in cdf_by_player.items():
        pts, prev_p, prev_n = 0.0, 0.0, 0
        for n in ns:
            if n not in cdf:
                continue
            pts += (cdf[n] - prev_p) * _bucket_mean(curve, prev_n + 1, n)
            prev_p, prev_n = cdf[n], n
        rank = int(round(tail_rank[player]))
        pts += (1.0 - prev_p) * _bucket_mean(curve, rank, rank)
        out[player] = pts
    return out


def confidence(spread, open_interest, ladder_error, candle_volume=None):
    """How much to trust the market for one player, in [0, 1].

    Four signals, multiplied so any one can veto:
      spread        -- a book quoted [0.03, 0.84] carries no information
      open_interest -- real money at risk
      ladder_error  -- |raw sum - N| / N. Calibration already removes ordinary
                       bid/ask overround, so this is forgiving up to 50% and
                       only bites on genuine junk: the kicker Top-1 ladder sums
                       to 3.05 against a target of 1.0, a 205% error.
      candle_volume -- recent trading, not just resting quotes. Neutral when
                       candlesticks were not fetched (--fast), rather than
                       penalising every player for missing data.
    """
    if spread is None:
        return 0.0
    s = math.exp(-max(0.0, spread - 0.03) / 0.10)          # ~1 at 3c, ~0.4 at 12c
    oi = (open_interest or 0.0) / (120.0 + (open_interest or 0.0))
    le = math.exp(-max(0.0, ladder_error - 0.5) / 0.5)
    if candle_volume is None:
        vol = 1.0
    else:
        vol = 0.6 + 0.4 * (candle_volume / (100.0 + candle_volume))
    return max(0.0, min(1.0, s * oi * le * vol))


def rescale_to_baseline(market_pts, espn_pts, min_n=6):
    """Put market-implied points on the same scale as the ESPN projections.

    The rank-curve method values a player at the mean of his whole finish
    distribution, so it prices in bust risk that a point projection ignores --
    Gibbs comes out at 327 against ESPN's 365. That difference is real, but it
    is a *level* difference that applies only to market-covered players, and
    blending the two raw would hand every uncovered player a free advantage.

    The market's signal is its ordering within a position, not its absolute
    level, so match mean and spread to the baseline over the overlapping
    players and keep the ordering intact.
    """
    common = [k for k in market_pts if espn_pts.get(k)]
    if len(common) < min_n:
        return dict(market_pts)
    m = [market_pts[k] for k in common]
    e = [espn_pts[k] for k in common]
    mm, me = sum(m) / len(m), sum(e) / len(e)
    sm = (sum((x - mm) ** 2 for x in m) / len(m)) ** 0.5
    se = (sum((x - me) ** 2 for x in e) / len(e)) ** 0.5
    if sm < 1e-6:
        return {k: me for k in market_pts}
    scale = se / sm
    return {k: me + (v - mm) * scale for k, v in market_pts.items()}


def blend(market_pts, espn_pts, conf, cap=0.7):
    """Blend market-implied and ESPN-projected points.

    Capped at `cap` so ESPN always retains a floor weight: it covers ~400
    players against the market's ~190, and it is the only source with a
    consistent scale across every position.
    """
    if market_pts is None or conf <= 0:
        return (espn_pts or 0.0), 0.0
    if espn_pts is None:
        return market_pts, 1.0
    w = min(cap, conf * cap)
    return w * market_pts + (1 - w) * espn_pts, w
