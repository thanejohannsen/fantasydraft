/* Round-by-round positional plan.
 *
 * Answers "what should I be taking in round 4?" by simulating the draft many
 * times: opponents pick near their ADP with noise, you pick greedily for
 * starting-lineup value, and the positions you end up taking at each of your
 * picks are tallied. Runs in the browser in well under a second and is cached,
 * so the board file stays small and there is still no backend. */

import {
  POSITIONS, FLEX_ELIGIBLE, myPicks, replacementPoints, vorp,
  needMultiplier, roundOf,
} from './engine.js';

/* Box-Muller, so opponent picks scatter around ADP instead of following it
 * exactly -- a plan built on ADP being obeyed to the pick is worthless. */
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points from the best legal starting lineup a roster can field.
 *
 * `value` lets the caller score the lineup in VORP rather than raw points.
 * That distinction decides the whole plan: in raw points the best QB outscores
 * the best RB, so a naive optimiser spends the first round on a quarterback --
 * ignoring that the QB you can still get in round 11 is nearly as good, while
 * the RB you can get then is not. */
export function lineupPoints(roster, league, value = (p) => p.pts) {
  const { starters } = league;
  const pool = roster.slice().sort((a, b) => value(b) - value(a));
  const used = new Set();
  let total = 0;
  for (const pos of POSITIONS) {
    let slots = starters[pos] || 0;
    for (const p of pool) {
      if (slots <= 0) break;
      if (used.has(p) || p.pos !== pos) continue;
      used.add(p); total += value(p); slots--;
    }
  }
  let flex = starters.FLEX || 0;
  for (const p of pool) {
    if (flex <= 0) break;
    if (used.has(p) || !FLEX_ELIGIBLE.includes(p.pos)) continue;
    used.add(p); total += value(p); flex--;
  }
  return total;
}

/**
 * Simulate `sims` drafts and report, per round, how often each position was
 * the right pick. `startState` lets the plan be re-run mid-draft so it
 * reflects the board as it actually is, not as it was at setup.
 */
export function planRounds(board, league, startState = null, sims = 260, seed = 7) {
  const rng = mulberry32(seed);
  const replacement = replacementPoints(board, league);
  const val = (p) => vorp(p, replacement);
  const mine = myPicks(league);
  const totalPicks = league.teams * league.rounds;

  const pool = board.players
    .filter((p) => p.adp)
    .slice()
    .sort((a, b) => a.adp - b.adp)
    .slice(0, Math.max(totalPicks + 60, 240));

  const startPick = startState?.pick ?? 1;
  const preTaken = startState?.taken ?? new Set();
  const preRoster = startState?.roster ?? [];

  const tally = new Map();   // round -> pos -> count
  const names = new Map();   // round -> pos -> Map(id -> {player, n})

  for (let s = 0; s < sims; s++) {
    const taken = new Set(preTaken);
    const roster = preRoster.slice();
    // Opponent draft order for this sim: ADP plus noise, re-sorted.
    const order = pool
      .filter((p) => !taken.has(p.id))
      .map((p) => ({ p, k: p.adp + gauss(rng) * Math.max(4, p.adp * 0.25) }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.p);
    let cursor = 0;

    for (let pick = startPick; pick <= totalPicks; pick++) {
      const isMine = mine.includes(pick);
      if (!isMine) {
        while (cursor < order.length && taken.has(order[cursor].id)) cursor++;
        if (cursor < order.length) taken.add(order[cursor++].id);
        continue;
      }
      const picksLeft = mine.filter((m) => m >= pick).length;
      const baseLineup = lineupPoints(roster, league, val);

      // Score candidates on raw value first, then shift onto a non-negative
      // scale before applying the roster-need multiplier -- exactly as the
      // live engine does, and for the same reason. Late in a draft every
      // remaining player is below replacement, and scaling negative numbers
      // by 0.02 makes them bigger, which would turn the kicker penalty into a
      // kicker bonus and put a K in round 11.
      const cands = [];
      let seen = 0;
      for (const p of order) {
        if (taken.has(p.id)) continue;
        const mult = needMultiplier(p.pos, roster, league, picksLeft);
        if (mult === 0) continue;
        // Marginal value: what this player adds to the best lineup we can
        // already field, plus a discounted credit for bench depth.
        const lineupGain = lineupPoints(roster.concat(p), league, val) - baseLineup;
        cands.push({ p, base: lineupGain + val(p) * 0.3, mult });
        if (++seen >= 50) break;   // deeper than any pick realistically reaches
      }
      if (!cands.length) continue;
      const floor = Math.min(...cands.map((c) => c.base));
      let best = null, bestGain = -Infinity;
      for (const c of cands) {
        const gain = (c.base - floor) * c.mult;
        if (gain > bestGain) { bestGain = gain; best = c.p; }
      }
      if (!best) continue;
      taken.add(best.id);
      roster.push(best);

      const r = roundOf(pick, league.teams);
      if (!tally.has(r)) { tally.set(r, {}); names.set(r, {}); }
      const t = tally.get(r);
      t[best.pos] = (t[best.pos] || 0) + 1;
      const n = names.get(r);
      (n[best.pos] ||= new Map());
      const cur = n[best.pos].get(best.id) || { player: best, n: 0 };
      cur.n++; n[best.pos].set(best.id, cur);
    }
  }

  const plan = [];
  for (let r = 1; r <= league.rounds; r++) {
    const t = tally.get(r) || {};
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    if (!total) { plan.push({ round: r, pos: null, share: 0, targets: [] }); continue; }
    const ranked = Object.entries(t).sort((a, b) => b[1] - a[1]);
    const [pos, count] = ranked[0];
    const targets = [...((names.get(r) || {})[pos] || new Map()).values()]
      .sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.player);
    plan.push({
      round: r,
      pick: mine[r - 1],
      pos,
      share: count / total,
      alt: ranked[1] ? { pos: ranked[1][0], share: ranked[1][1] / total } : null,
      targets,
    });
  }
  return plan;
}
