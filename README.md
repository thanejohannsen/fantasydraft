# Fantasy Draft Board

A phone-first draft assistant that ranks players using **prediction market
odds** from Kalshi, backfilled with ESPN projections where the markets are thin.
Tell it your league size and draft slot, tap players off as they go, and it
tells you who to take — and what position to target in each round.

Static site, no backend. Everything is precomputed by a GitHub Action, so
during the draft your phone loads one JSON file and does arithmetic.

## Why prediction markets

Kalshi runs season-long markets on **fantasy finish by position** —
`KXNFLFFLEADER` (Top 1) and `KXNFLFFLEADERTOP` (Top 3 / 5 / 10) for QB, RB, WR,
TE, K and D/ST. Their rules settle on *Sleeper's PPR scoring*, which is exactly
what a full-PPR league scores, so the prices transfer directly rather than
needing translation.

That gives, for each of ~190 players, a real probability distribution over where
he finishes at his position — priced by people with money at risk, and updated
continuously. It is a genuinely different signal from a ranking someone typed.

## How a price becomes a draft ranking

1. **Rank CDF.** The ladders give `P(top1) ≤ P(top3) ≤ P(top5) ≤ P(top10)` —
   four points on each player's finish distribution.
2. **Calibrate.** Mid-prices carry the bid/ask overround, so raw ladders sum
   high (the RB Top-1 ladder sums to 1.25, Top-10 to 11.70). Exactly N players
   finish in the top N, so each ladder is rescaled to sum to N via a power
   transform that preserves ordering, then clamped monotone per player. The two
   projections are alternated until they agree.
3. **Points.** The CDF is split into finish buckets and weighted by the actual
   PPR points of those finishes, taken from last season's real results (pulled
   from ESPN, not hardcoded). Players outside the top N are spread across the
   remaining ranks in CDF order.
4. **Rescale.** Market points are matched to the ESPN scale before blending.
   The rank-curve method prices in bust risk a point projection ignores — Gibbs
   comes out at 327 against ESPN's 365 — and blending raw would penalise every
   market-covered player against uncovered ones. The market's signal is its
   *ordering*, so that is what gets kept.
5. **Blend.** `pts = w·market + (1−w)·espn`, where `w` reflects how much the
   market is worth believing: bid/ask spread, open interest, recent traded
   volume, and how far the raw ladder sat from its target. Tight, liquid
   markets reach `w ≈ 0.65`; junk collapses to `w = 0`.

The last part is what makes "supplement when the market isn't liquid enough"
work as a dial rather than a switch. The kicker Top-1 ladder sums to 3.05 with
quotes like `[0.03 / 0.84]` — that is noise, it scores `w ≈ 0`, and kickers ride
on ESPN alone. Each row in the app shows its market/projection mix as a small
bar, so you can always see which source is driving a recommendation.

## How it picks

Raw value ranks players; it doesn't draft well. The engine scores each player on
**value now versus what will still be there at your next pick**:

```
score = 0.35·VORP + 0.65·(VORP − E[best available at that position next turn])
```

Survival comes from ESPN ADP with variance that widens deeper into the draft
(the field agrees about pick 3, not about pick 140). VORP is measured against
replacement level derived from your actual roster settings. The result responds
to positional runs on its own: a player gets recommended precisely when his
position's board will be worse by the time you pick again.

Kickers and defences are held back until the end, and replacement level for them
is set at the bottom of the pool — they're streamable off waivers all season, so
the best one is worth barely more than the twentieth.

## Round-by-round plan

At setup the browser runs a few hundred simulated drafts — opponents pick near
ADP with noise, you pick to maximise starting-lineup VORP — and tallies which
position you ended up taking in each round. That's the strip across the top:

```
R1 RB · R2 RB · R3 RB · R4 TE · R5 QB · R6 WR · … · R14 DST · R15 K
```

Recompute it any time from the menu and it re-plans against the board as it
actually is, so a run on QBs shows up as the plan moving QB earlier.

## Setup

1. **Enable Pages**: Settings → Pages → *Deploy from a branch* → this branch,
   root. Your site appears at `https://<user>.github.io/fantasydraft/`.
2. Open it on your phone and **Add to Home Screen**. It caches itself, so it
   works with no signal at the draft venue.
3. Before the draft, force a fresh board: Actions → *Refresh draft board* →
   *Run workflow*.

The board otherwise refreshes every 6 hours on its own.

### Optional: a Kalshi API key

Not needed. Every market endpoint this reads — quotes, order book, trades,
30-day candlesticks — is public; only `/portfolio/*` requires auth, and this
tool never touches it. A key buys exactly one thing: **higher rate limits**.
Unauthenticated, the candlestick pass draws 429s and has to back off.

To use one, add repository secrets `KALSHI_KEY_ID` and `KALSHI_PRIVATE_KEY`
(the PEM contents). The fetcher picks them up automatically and falls back to
public access if they're absent or invalid. Kalshi signs with RSA-PSS, so the
workflow installs `cryptography` only on that path.

**The key never reaches the site.** This is a public static page — anything
shipped to the browser is readable by anyone. It is used only inside the Action.

## Local use

```bash
python3 scripts/fetch_board.py          # full build (~3 min, rate-limited)
python3 scripts/fetch_board.py --fast   # skip candlesticks (~30s)
python3 scripts/check_board.py          # validate before publishing
node scripts/simulate.mjs 6 12          # simulate a draft from slot 6 of 12
python3 -m http.server 8000             # then open localhost:8000
```

`simulate.mjs` drafts a full roster by always taking the engine's top
recommendation and asserts the result is legal — every starting slot filled, no
position over its cap, no kicker before the last rounds.

## What it does not do

- **The board is a snapshot.** Season-long markets barely move during a
  three-hour draft, so this costs nothing in practice — but refresh before you
  start.
- **~190 of 900 players have market data.** The rest ride on ESPN projections
  and are labelled *projection only* in the app. That's the intended design, not
  a gap: the markets simply don't price a WR6.
- **News is shown, not scored.** ESPN's injury feed carries a beat-writer note
  per player and it appears on the player card. Only hard structured statuses
  (Out, IR, PUP, suspended, doubtful) actually move a ranking. Reading value out
  of prose is unreliable, and a tool that silently misreads a headline is worse
  than one that hands you the sentence.
- **K and D/ST market signal is weak.** Those books are thin and wide, so they
  fall back to projections. They're last-round picks; the cost is near zero.

## Layout

```
index.html              app shell
assets/app.js           UI, draft state, localStorage
assets/engine.js        VORP, survival, pick scoring
assets/planner.js       Monte Carlo round plan
sw.js                   offline cache (must sit at the root for scope)
scripts/fetch_board.py  build data/board.json
scripts/sources.py      Kalshi + ESPN clients
scripts/model.py        calibration, rank curve, blending
scripts/check_board.py  pre-publish validation
scripts/simulate.mjs    engine test harness
data/board.json         the precomputed board
```
