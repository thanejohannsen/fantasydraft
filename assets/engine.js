/* Draft engine: VORP, survival, pick scoring, and the round-by-round plan.
 *
 * Everything here is arithmetic over the precomputed board. No network calls,
 * no heavy work -- the expensive part (fetching and blending market data)
 * already happened in CI. */

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
export const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export const DEFAULT_LEAGUE = {
  teams: 12,
  slot: 6,
  rounds: 15,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

/* ---------------------------------------------------------------- snake */

/** Overall pick numbers belonging to `slot` in a snake draft. */
export function myPicks(league) {
  const { teams, slot, rounds } = league;
  const picks = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound = r % 2 === 1 ? slot : teams - slot + 1;
    picks.push((r - 1) * teams + inRound);
  }
  return picks;
}

export function roundOf(pick, teams) {
  return Math.floor((pick - 1) / teams) + 1;
}

/* ------------------------------------------------------------ replacement */

/** Roster slots consumed leaguewide at each position, flex included.
 *
 * Flex is shared across RB/WR/TE, so it is split by how often each position
 * actually fills it rather than evenly -- RB and WR carry it far more than TE. */
export function replacementRanks(league) {
  const { teams, starters } = league;
  const flexShare = { RB: 0.45, WR: 0.45, TE: 0.1 };
  const out = {};
  for (const pos of POSITIONS) {
    const base = starters[pos] || 0;
    const flex = FLEX_ELIGIBLE.includes(pos) ? (starters.FLEX || 0) * flexShare[pos] : 0;
    // One bench spot's worth of depth beyond the starters is what a team
    // realistically reaches for, so replacement sits a little past the
    // last starter rather than exactly on it.
    out[pos] = Math.max(1, Math.round(teams * (base + flex) + (base > 0 ? teams * 0.25 : 0)));
  }
  // Kickers and defences are streamed off waivers all season, so the real
  // alternative to the best one is not the 15th-best but whatever is free --
  // effectively the bottom of the pool. Setting replacement that deep is what
  // keeps a +34 VORP defence from outranking a genuine skill-position pick.
  for (const pos of ['K', 'DST']) {
    if (starters[pos]) out[pos] = Math.max(out[pos], Math.round(teams * 2.5));
  }
  return out;
}

/** Points a replacement-level player at each position is worth. */
export function replacementPoints(board, league) {
  const ranks = replacementRanks(league);
  const byPos = {};
  for (const p of board.players) (byPos[p.pos] ||= []).push(p);
  const out = {};
  for (const pos of POSITIONS) {
    const list = (byPos[pos] || []).slice().sort((a, b) => b.pts - a.pts);
    if (!list.length) { out[pos] = 0; continue; }
    out[pos] = list[Math.min(ranks[pos], list.length) - 1].pts;
  }
  return out;
}

export function vorp(player, replacement) {
  return player.pts - (replacement[player.pos] ?? 0);
}

/* --------------------------------------------------------------- survival */

/* ADP is a mean, not a certainty. Spread grows with ADP because the field
 * agrees far more about pick 3 than about pick 140. */
function adpSigma(adp) {
  return Math.max(4, adp * 0.28);
}

function normCdf(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** P(player is still on the board at overall pick `target`). */
export function survival(player, currentPick, target, takenCount) {
  if (!player.adp) return 0.35;                 // unknown ADP: coin-flip-ish
  const sigma = adpSigma(player.adp);
  // Condition on having lasted this long: a player past his ADP is being
  // passed over, which makes him likelier to keep lasting.
  const pGone = (pick) => normCdf((pick - player.adp) / sigma);
  const now = pGone(currentPick - 1);
  const then = pGone(target - 1);
  if (now >= 0.999) return 0.02;
  return Math.max(0.01, Math.min(0.99, (1 - then) / (1 - now)));
}

/* ------------------------------------------------------------ roster need */

/** Remaining starter slots by position, and whether a position is saturated. */
export function rosterNeed(roster, league) {
  const { starters } = league;
  const counts = {};
  for (const p of roster) counts[p.pos] = (counts[p.pos] || 0) + 1;

  const need = {};
  let flexLeft = starters.FLEX || 0;
  for (const pos of POSITIONS) {
    const have = counts[pos] || 0;
    need[pos] = Math.max(0, (starters[pos] || 0) - have);
  }
  // Surplus RB/WR/TE fill flex before counting as bench depth.
  for (const pos of FLEX_ELIGIBLE) {
    const surplus = (counts[pos] || 0) - (starters[pos] || 0);
    if (surplus > 0) flexLeft = Math.max(0, flexLeft - surplus);
  }
  return { need, flexLeft, counts };
}

/* Hard caps: drafting a third QB or a second kicker is never right. */
const MAX_AT_POS = { QB: 2, TE: 2, K: 1, DST: 1, RB: 6, WR: 6 };

export function needMultiplier(pos, roster, league, picksLeft) {
  const { need, flexLeft, counts } = rosterNeed(roster, league);
  const { starters } = league;
  const have = counts[pos] || 0;
  if (have >= (MAX_AT_POS[pos] ?? 6)) return 0;

  // K and DST come first, before any need check. They are needed all draft
  // long, so a plain "do I still need one?" test would happily spend round 7
  // on a kicker; the point is that the drop-off between the best kicker and
  // the twentieth is worth less than one more swing at a skill position.
  if (pos === 'K' || pos === 'DST') {
    const slotsForKD = (starters.K || 0) + (starters.DST || 0);
    return picksLeft <= slotsForKD && need[pos] > 0 ? 1.0 : 0.02;
  }

  const unfilled = Object.entries(need)
    .filter(([p2, n]) => n > 0 && p2 !== 'K' && p2 !== 'DST');
  const mustFill = unfilled.reduce((a, [, n]) => a + n, 0) + flexLeft
    + (starters.K || 0) + (starters.DST || 0);

  // Late in the draft, unfilled starting slots dominate everything else.
  if (picksLeft <= mustFill && need[pos] > 0) return 2.2;
  if (picksLeft <= mustFill && need[pos] === 0) return 0.15;

  if (need[pos] > 0) return 1.0;
  if (FLEX_ELIGIBLE.includes(pos) && flexLeft > 0) return 0.9;
  return 0.55;                                   // pure bench depth
}

/* --------------------------------------------------------- recommendation */

/**
 * Score every available player for the pick at hand.
 *
 * The criterion is not raw value but value *relative to what survives*: a
 * player is worth taking now to the extent that his position's board will be
 * worse when you next pick. That is what makes the tool respond to positional
 * runs instead of just reading down a ranking.
 */
export function recommend(board, league, state, limit = 40) {
  const { taken, roster, pick } = state;
  const replacement = replacementPoints(board, league);
  const picks = myPicks(league);
  const nextPick = picks.find((p) => p > pick) ?? null;
  const picksLeft = picks.filter((p) => p >= pick).length;

  const available = board.players.filter((p) => !taken.has(p.id));

  // Best expected value still on the board at each position next turn.
  const bestNext = {};
  if (nextPick) {
    for (const pos of POSITIONS) {
      const pool = available.filter((p) => p.pos === pos).slice(0, 60);
      let acc = 0, missMass = 1;
      for (const p of pool) {
        const s = survival(p, pick, nextPick, taken.size);
        acc += missMass * s * vorp(p, replacement);
        missMass *= 1 - s;
        if (missMass < 0.01) break;
      }
      bestNext[pos] = acc;
    }
  }

  const scored = available.map((p) => {
    const v = vorp(p, replacement);
    const gain = nextPick ? v - (bestNext[p.pos] ?? 0) : v;
    const mult = needMultiplier(p.pos, roster, league, picksLeft);
    // Momentum is a tiebreaker only: a market moving against a player is a
    // signal, but never one that outweighs value.
    const drift = (p.d7 || 0) * (p.w || 0) * 12;
    return {
      player: p,
      vorp: v,
      gain,
      survival: nextPick ? survival(p, pick, nextPick, taken.size) : 0,
      base: v * 0.35 + gain * 0.65 + drift,
      mult,
      blocked: mult === 0,
    };
  });

  // Shift onto a non-negative scale before applying the roster-need
  // multiplier. Late in a draft every remaining player is below replacement,
  // and scaling a negative number by 0.02 makes it *larger* -- which would
  // turn the kicker penalty into a kicker bonus.
  const live = scored.filter((s) => !s.blocked);
  const floor = live.length ? Math.min(...live.map((s) => s.base)) : 0;
  for (const s of scored) s.score = (s.base - floor) * s.mult;

  scored.sort((a, b) => b.score - a.score);
  return { list: scored.filter((s) => !s.blocked).slice(0, limit), nextPick, replacement, bestNext };
}

/** One sentence saying why the top pick is the top pick. */
export function explain(top, ctx, board) {
  const p = top.player;
  const posRank = board.players.filter((q) => q.pos === p.pos && q.pts > p.pts).length + 1;
  const bits = [`${p.pos}${posRank} by blended value`];
  if (ctx.nextPick && top.survival < 0.35) {
    bits.push(`only ${Math.round(top.survival * 100)}% likely to last to pick ${ctx.nextPick}`);
  }
  if (top.gain > 12) bits.push(`the ${p.pos} board drops off hard before your next turn`);
  if (p.w >= 0.4) bits.push('market-backed');
  else if (p.w === 0) bits.push('projection only, no market coverage');
  if (p.d7 && p.w > 0.2) {
    bits.push(p.d7 > 0.01 ? 'market trending up this week'
      : p.d7 < -0.01 ? 'market cooling this week' : null);
  }
  return bits.filter(Boolean).join(' · ');
}
