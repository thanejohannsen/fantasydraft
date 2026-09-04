"""HTTP clients for the three data sources: Kalshi, ESPN fantasy, ESPN news.

Everything here runs in CI, never in the browser. Two non-obvious constraints,
both found by probing the live APIs and both easy to get wrong:

  * Kalshi returns 403 to any request carrying an ``Origin`` header, and its
    market-list endpoint leaves the legacy integer price fields (``yes_bid``,
    ``last_price``, ``volume``) null. Real prices live in the ``*_dollars`` and
    ``*_fp`` fields, and only the *no* side is quoted, so the yes side has to be
    derived as ``yes_bid = 1 - no_ask``. Read the obvious fields and every
    market looks untraded.
  * ESPN returns 403 to a spoofed browser User-Agent but serves fine with none.
"""

import gzip
import json
import time
import urllib.error
import urllib.request

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
ESPN_FANTASY = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"

# Kalshi rate-limits unauthenticated reads; nine rapid calls is enough to draw a
# 429. This delay plus the backoff below keeps a ~200-call run comfortably under.
THROTTLE_S = 0.4


MAX_THROTTLE_S = 4.0

# A single call must never be able to sit for minutes. Five tries with doubling
# sleeps stacked on a raised throttle could burn ~30s on one request, and 19
# essential ladder calls of that is most of a job timeout.
MAX_RETRY_SLEEP_S = 6.0


class Http:
    """Throttled JSON fetcher with adaptive pacing and backoff on 429/5xx.

    The pacing has to *persist* across calls, not just retry the one that got
    limited. An earlier version backed off within a call and then reset to the
    base delay for the next one, which on a shared CI runner IP just walked
    straight back into the limit -- a run that takes five minutes locally sat
    past twenty minutes on a GitHub runner and was heading for the job timeout.
    So a 429 slows every subsequent request, and success gradually speeds back up.
    """

    def __init__(self, throttle=THROTTLE_S, verbose=True):
        self.base = throttle
        self.throttle = throttle
        self.verbose = verbose
        self._last = 0.0
        self.calls = 0
        self.limited = 0

    def _slow_down(self):
        self.throttle = min(MAX_THROTTLE_S, max(self.throttle * 1.8, self.base * 2))
        self.limited += 1

    def _speed_up(self):
        if self.throttle > self.base:
            self.throttle = max(self.base, self.throttle * 0.92)

    def get(self, url, headers=None, tries=5, timeout=20):
        delay = self.throttle
        for attempt in range(tries):
            wait = self._last + self.throttle - time.time()
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(url, headers=headers or {})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.decompress(raw)
                self._last = time.time()
                self.calls += 1
                self._speed_up()
                return json.loads(raw)
            except urllib.error.HTTPError as e:
                self._last = time.time()
                retryable = e.code == 429 or e.code >= 500
                if e.code == 429:
                    self._slow_down()
                if not retryable or attempt == tries - 1:
                    raise
                delay = min(MAX_RETRY_SLEEP_S, max(delay * 2, self.throttle))
                if self.verbose:
                    print(f"    HTTP {e.code}, backing off {delay:.1f}s "
                          f"(pace now {self.throttle:.1f}s)")
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                self._last = time.time()
                if attempt == tries - 1:
                    raise
                delay = min(MAX_RETRY_SLEEP_S, delay * 2)
                time.sleep(delay)
        raise RuntimeError(f"unreachable: {url}")


def money(x):
    """Kalshi serialises prices as decimal strings; empty/absent means no quote."""
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Kalshi
# --------------------------------------------------------------------------

def kalshi_auth_headers(method, path, key_id, private_key_pem):
    """Kalshi signs requests with RSA-PSS over 'timestamp + METHOD + path'.

    Only used when KALSHI_KEY_ID/KALSHI_PRIVATE_KEY are set. Auth buys nothing
    but higher rate limits here -- every market endpoint this tool reads
    (quotes, order book, trades, candlesticks) is public. Requires the
    'cryptography' package, which is why it stays optional.
    """
    import base64

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    ts = str(int(time.time() * 1000))
    msg = (ts + method.upper() + path).encode()
    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    sig = key.sign(
        msg,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        "KALSHI-ACCESS-TIMESTAMP": ts,
    }


class Kalshi:
    def __init__(self, http, key_id=None, private_key=None):
        self.http = http
        self.key_id = key_id
        self.private_key = private_key
        self.authed = bool(key_id and private_key)

    def _headers(self, path):
        if not self.authed:
            return {"Accept": "application/json"}
        try:
            h = kalshi_auth_headers("GET", "/trade-api/v2" + path, self.key_id, self.private_key)
            h["Accept"] = "application/json"
            return h
        except Exception as e:  # bad key, missing cryptography -> fall back to public
            print(f"  ! Kalshi auth failed ({e}); continuing unauthenticated")
            self.authed = False
            return {"Accept": "application/json"}

    def markets(self, event_ticker):
        path = f"/markets?event_ticker={event_ticker}&limit=200"
        return self.http.get(KALSHI + path, self._headers(path)).get("markets", [])

    def candles(self, series, ticker, days=30):
        """Optional data, so it gets two tries and then gets out of the way."""
        now = int(time.time())
        path = (f"/series/{series}/markets/{ticker}/candlesticks"
                f"?start_ts={now - days * 86400}&end_ts={now}&period_interval=1440")
        try:
            return self.http.get(KALSHI + path, self._headers(path),
                                 tries=2).get("candlesticks", [])
        except Exception:
            return []


def quote(market):
    """Extract the yes-side quote from a Kalshi market.

    Only the no side is quoted in these books, so the yes side is the mirror:
    yes_bid = 1 - no_ask, yes_ask = 1 - no_bid.
    """
    no_bid, no_ask = money(market.get("no_bid_dollars")), money(market.get("no_ask_dollars"))
    if no_bid is None or no_ask is None:
        last = money(market.get("last_price_dollars"))
        return (last, None, 1.0) if last else (None, None, None)
    yes_bid, yes_ask = 1.0 - no_ask, 1.0 - no_bid
    if yes_ask < yes_bid:  # crossed/degenerate book
        return None, None, None
    return (yes_bid + yes_ask) / 2.0, yes_bid, yes_ask - yes_bid


# --------------------------------------------------------------------------
# ESPN
# --------------------------------------------------------------------------

# No User-Agent on purpose: ESPN 403s spoofed browser UAs but serves fine bare.
ESPN_HEADERS = {"Accept": "application/json"}

ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}

ESPN_TEAM = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
    16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI",
    23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR",
    30: "JAX", 33: "BAL", 34: "HOU",
}


def espn_players(http, season, limit=900):
    """Pull the top `limit` players by PPR draft rank, with projections and ADP."""
    hdr = dict(ESPN_HEADERS)
    hdr["x-fantasy-filter"] = json.dumps({
        "players": {
            "limit": limit,
            "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "PPR"},
        }
    })
    url = f"{ESPN_FANTASY}/seasons/{season}/segments/0/leaguedefaults/3?view=kona_player_info"
    return http.get(url, hdr).get("players", [])


def espn_injuries(http):
    """Team-by-team injury report: status plus a beat-writer blurb per player."""
    try:
        data = http.get(f"{ESPN_SITE}/injuries", ESPN_HEADERS)
    except Exception as e:
        print(f"  ! injuries feed unavailable ({e})")
        return {}
    out = {}
    for team in data.get("injuries", []):
        for item in team.get("injuries", []):
            name = (item.get("athlete") or {}).get("displayName")
            if not name:
                continue
            out[name] = {
                "status": item.get("status"),
                "note": (item.get("shortComment") or item.get("longComment") or "")[:280],
            }
    return out


def espn_news(http, limit=40):
    try:
        data = http.get(f"{ESPN_SITE}/news?limit={limit}", ESPN_HEADERS)
    except Exception as e:
        print(f"  ! news feed unavailable ({e})")
        return []
    return [
        {
            "headline": a.get("headline"),
            "description": (a.get("description") or "")[:240],
            "published": (a.get("published") or "")[:10],
            "link": ((a.get("links") or {}).get("web") or {}).get("href"),
        }
        for a in data.get("articles", [])
        if a.get("headline")
    ]


def stat_total(player, source, season):
    """Season total for a player: statSplitTypeId 0 and scoringPeriodId 0.

    The response also carries per-week entries and prior seasons; picking the
    wrong one silently yields a per-game number or 0.0 for some players.
    source 1 = projection, source 0 = actual.
    """
    for s in player.get("stats", []):
        if (s.get("statSourceId") == source and s.get("statSplitTypeId") == 0
                and s.get("seasonId") == season and s.get("scoringPeriodId") == 0):
            return s.get("appliedTotal")
    return None


def bye_week(player, season):
    """A zeroed weekly projection in an otherwise-projected season is the bye."""
    weeks = {
        s.get("scoringPeriodId"): s.get("appliedTotal")
        for s in player.get("stats", [])
        if (s.get("statSourceId") == 1 and s.get("statSplitTypeId") == 1
            and s.get("seasonId") == season)
    }
    if len(weeks) < 10:
        return None
    zeros = [w for w, v in weeks.items() if not v and 1 <= (w or 0) <= 18]
    return zeros[0] if len(zeros) == 1 else None
