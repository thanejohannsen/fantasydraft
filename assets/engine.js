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

/** Which team seat owns an overall pick number.
 *
 * The inverse of the snake arithmetic in myPicks(): odd rounds run 1..teams,
 * even rounds run back down. Knowing this means a tap needs no "was that mine?"
 * question -- the pick number already says whose it is.
 */
export function teamOnClock(pick, teams) {
  const idx = (pick - 1) % teams;                 // 0-based seat within the round
  return roundOf(pick, teams) % 2 === 1 ? idx + 1 : teams - idx;
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
export function survival(player, currentPick, target) {
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

/* --------------------------------------------------------- opponent model */

/** Rebuild each team's roster from the pick log.
 *
 * The seat is derived from the pick number rather than trusted from the log
 * entry, so a corrected pick counter re-attributes cleanly and drafts saved
 * before attribution existed still work.
 */
export function teamRosters(board, league, state) {
  const byId = playerIndex(board);
  const rosters = {};
  for (let t = 1; t <= league.teams; t++) rosters[t] = [];
  for (const h of state.history || []) {
    const p = byId.get(h.id);
    if (p) rosters[teamOnClock(h.pick, league.teams)].push(p);
  }
  return rosters;
}

function playerIndex(board) {
  if (!board._byId) {
    Object.defineProperty(board, '_byId', {
      value: new Map(board.players.map((p) => [p.id, p])), enumerable: false });
  }
  return board._byId;
}

/**
 * How hard each position will be hit before your next pick.
 *
 * ADP alone cannot see a run: it is a season-long average, so it says a
 * quarterback is safe even while the room is taking one every other pick. This
 * compares two things against each other --
 *
 *   demand   what the specific teams picking before your turn still need,
 *            now knowable because every pick is attributed to a seat
 *   baseline what ADP alone expects to go at that position in the same window
 *
 * -- and returns their ratio. Above 1 means a position is going faster than
 * the board thinks, which is precisely the moment to move a player up.
 */
export function upcomingDemand(board, league, state, available) {
  const picks = myPicks(league);
  const next = picks.find((p) => p > state.pick);
  const empty = { window: [], demand: {}, baseline: {}, pressure: {}, recent: {}, next: null };
  if (!next) return empty;

  const window = [];
  for (let pk = state.pick; pk < next; pk++) {
    const seat = teamOnClock(pk, league.teams);
    if (seat !== league.slot) window.push({ pick: pk, seat });
  }
  if (!window.length) return { ...empty, next };

  // Best value still on the board at each position, which is what any team
  // weighs when choosing among the slots it still needs.
  const bestAt = {};
  const replacement = replacementPoints(board, league);
  for (const p of available) {
    const v = vorp(p, replacement);
    if (bestAt[p.pos] === undefined || v > bestAt[p.pos]) bestAt[p.pos] = v;
  }

  const rosters = teamRosters(board, league, state);
  const demand = {};
  for (const pos of POSITIONS) demand[pos] = 0;

  for (const { seat } of window) {
    const { need, flexLeft } = rosterNeed(rosters[seat] || [], league);
    const opts = new Set(POSITIONS.filter((pos) => need[pos] > 0 && bestAt[pos] !== undefined
      && pos !== 'K' && pos !== 'DST'));
    // A team with both starting receivers already is not done taking
    // receivers -- flex and bench depth come overwhelmingly from RB and WR.
    // Treating them as satisfied pinned receiver demand to the floor for the
    // whole draft.
    if (flexLeft > 0 || !opts.size) {
      for (const pos of FLEX_ELIGIBLE) if (bestAt[pos] !== undefined) opts.add(pos);
    }
    for (const pos of ['RB', 'WR']) if (bestAt[pos] !== undefined) opts.add(pos);
    let options = [...opts];
    if (!options.length) options = POSITIONS.filter((pos) => bestAt[pos] !== undefined
      && pos !== 'K' && pos !== 'DST');
    // Among the slots a team still needs, it takes the best value available.
    // Softmax rather than a linear weight, because teams do not spread evenly
    // over their open slots -- everyone "needs" a quarterback from round one
    // and almost nobody takes one there, precisely because the drop from QB1
    // to QB12 is small. A linear weight reads that structural patience as a
    // permanent run.
    const TEMP = 55;
    const top = Math.max(...options.map((pos) => bestAt[pos]));
    const weights = options.map((pos) => Math.exp((bestAt[pos] - top) / TEMP));
    const total = weights.reduce((a, b) => a + b, 0);
    options.forEach((pos, i) => { demand[pos] += weights[i] / total; });
  }

  // What ADP alone would predict for the same number of picks.
  const baseline = {};
  for (const pos of POSITIONS) baseline[pos] = 0;
  available.filter((p) => p.adp).sort((a, b) => a.adp - b.adp)
    .slice(0, window.length).forEach((p) => { baseline[p.pos] += 1; });

  // Observed pace over the last couple of rounds, for display and as a nudge.
  const recent = {};
  for (const pos of POSITIONS) recent[pos] = 0;
  const lookback = (state.history || []).slice(-Math.min(2 * league.teams, 24));
  const byId = playerIndex(board);
  for (const h of lookback) {
    const p = byId.get(h.id);
    if (p) recent[p.pos] += 1;
  }

  // ADP is the prior, not the rival. It already encodes how people actually
  // draft in aggregate; the roster-need model's job is to *update* it for the
  // specific teams picking next, not to replace it. Used alone it drifts badly
  // -- it handed running backs 7.5 of 12 picks where ADP expected 4, which
  // pinned receiver pressure to the floor all draft.
  const PRIOR = 0.55;
  const SMOOTH = 0.10;
  const n = window.length;
  const pressure = {};
  for (const pos of POSITIONS) {
    const dShare = demand[pos] / n;
    const bShare = baseline[pos] / n;
    const blended = PRIOR * bShare + (1 - PRIOR) * dShare;
    const raw = (blended + SMOOTH) / (bShare + SMOOTH);

    // Pace is a read on the room's taste, not on opportunity, and the two can
    // disagree: four teams taking quarterbacks means four teams that no longer
    // need one, so forward demand *falls* exactly when a run is loudest. It
    // therefore adjusts the estimate rather than driving it.
    //
    // Confidence ramps with how much draft there is to read, instead of
    // switching on at a threshold -- gating it at a full round made the most
    // obvious case invisible, five quarterbacks in five picks reading as
    // nothing at all because only five picks had happened.
    const seen = lookback.length;
    const conf = Math.min(1, seen / Math.max(6, league.teams * 0.75));
    const pace = seen >= 4
      ? (recent[pos] / seen) / Math.max(0.02, baseline[pos] / n)
      : 1;
    // Asymmetric on purpose. A burst of picks at one position is real evidence
    // it is hot; the resulting *absence* of picks elsewhere is not evidence
    // those positions are cold, because during a five-pick run on one position
    // nothing else could have gone anyway. Treating the two symmetrically had
    // running backs reading "safe to wait" in the same breath as expecting
    // more of them than ADP does.
    const delta = Math.max(-1, Math.min(2.5, pace - 1));
    const paceBoost = 1 + conf * (delta > 0 ? 0.55 : 0.18) * delta;

    pressure[pos] = Math.max(0.7, Math.min(2.2, raw * paceBoost));
  }
  return { window, demand, baseline, pressure, recent, lookback: lookback.length, next };
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

  // How fast each position is actually going, versus what ADP expects.
  const strategy = upcomingDemand(board, league, state, available);
  const press = (pos) => strategy.pressure[pos] ?? 1;

  // Survival, corrected for the run in progress. ADP says a quarterback is
  // safe for another two rounds; if the room has taken four in the last ten
  // picks, he is not. Raising a probability to a power above 1 pushes it down
  // while keeping it in (0, 1) and preserving the ordering within a position.
  const lasts = (p) => Math.max(0.01, Math.min(0.99,
    survival(p, pick, nextPick) ** press(p.pos)));

  // Best expected value still on the board at each position next turn.
  const bestNext = {};
  if (nextPick) {
    for (const pos of POSITIONS) {
      const pool = available.filter((p) => p.pos === pos).slice(0, 60);
      let acc = 0, missMass = 1;
      for (const p of pool) {
        const s = lasts(p);
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
      survival: nextPick ? lasts(p) : 0,
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
  return {
    list: scored.filter((s) => !s.blocked).slice(0, limit),
    nextPick, replacement, bestNext, strategy,
  };
}

/** One sentence saying why the top pick is the top pick. */
export function explain(top, ctx, board) {
  const p = top.player;
  const posRank = board.players.filter((q) => q.pos === p.pos && q.pts > p.pts).length + 1;
  const bits = [`${p.pos}${posRank} by blended value`];
  const pressure = ctx.strategy?.pressure?.[p.pos] ?? 1;
  if (ctx.nextPick && top.survival < 0.35) {
    bits.push(`only ${Math.round(top.survival * 100)}% likely to last to pick ${ctx.nextPick}`);
  }
  if (pressure >= 1.35) {
    const n = ctx.strategy.demand[p.pos];
    bits.push(`${p.pos} is going ${pressure.toFixed(1)}x faster than normal` +
      (n >= 1 ? ` — about ${Math.round(n)} more before your turn` : ''));
  } else if (pressure <= 0.75) {
    bits.push(`${p.pos} demand is soft right now, so this can wait`);
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
