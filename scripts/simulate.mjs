/* End-to-end check of the draft engine against the real board.
 *
 *   node scripts/simulate.mjs [slot] [teams]
 *
 * Drafts a full roster by always taking the engine's top recommendation while
 * opponents pick by ADP, then asserts the roster is actually legal: every
 * starting slot filled, no position over its cap, no kicker in round 3. */

import { readFileSync } from 'fs';
import {
  DEFAULT_LEAGUE, POSITIONS, myPicks, recommend, explain, rosterNeed, roundOf,
} from '../assets/engine.js';
import { planRounds, lineupPoints } from '../assets/planner.js';

const board = JSON.parse(readFileSync(new URL('../data/board.json', import.meta.url)));
const slot = Number(process.argv[2] || 6);
const teams = Number(process.argv[3] || 12);
const league = { ...DEFAULT_LEAGUE, teams, slot };

const byAdp = board.players.filter((p) => p.adp).sort((a, b) => a.adp - b.adp);
const mine = new Set(myPicks(league));
const taken = new Set();
const roster = [];
let cursor = 0;
const log = [];

for (let pick = 1; pick <= teams * league.rounds; pick++) {
  if (!mine.has(pick)) {
    while (cursor < byAdp.length && taken.has(byAdp[cursor].id)) cursor++;
    if (cursor < byAdp.length) taken.add(byAdp[cursor++].id);
    continue;
  }
  const ctx = recommend(board, league, { taken, roster, pick }, 5);
  if (!ctx.list.length) { console.error(`no candidates at pick ${pick}`); break; }
  const top = ctx.list[0];
  taken.add(top.player.id);
  roster.push(top.player);
  log.push({ pick, round: roundOf(pick, teams), p: top.player, why: explain(top, ctx, board) });
}

console.log(`\n=== slot ${slot} of ${teams}, ${league.rounds} rounds ===`);
for (const e of log) {
  const p = e.p;
  console.log(
    `R${String(e.round).padStart(2)} #${String(e.pick).padStart(3)}  ` +
    `${p.pos.padEnd(3)} ${p.name.padEnd(23)} ${String(p.pts).padStart(6)}pts  ` +
    `w=${p.w.toFixed(2)}  ${e.why}`);
}

/* ------------------------------------------------------------- assertions */
let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);

console.log('\n--- checks ---');
const { need, counts } = rosterNeed(roster, league);
const unfilled = Object.entries(need).filter(([, n]) => n > 0);
unfilled.length ? fail(`unfilled starters: ${unfilled.map(([p, n]) => `${p}x${n}`).join(', ')}`)
                : pass('every starting slot filled');

const caps = { QB: 2, TE: 2, K: 1, DST: 1, RB: 6, WR: 6 };
const over = Object.entries(counts).filter(([p, n]) => n > caps[p]);
over.length ? fail(`over cap: ${over.map(([p, n]) => `${p}=${n}`).join(', ')}`)
            : pass('no position over its cap');

const earlyKD = log.filter((e) => (e.p.pos === 'K' || e.p.pos === 'DST') && e.round <= league.rounds - 3);
earlyKD.length ? fail(`K/DST drafted early: ${earlyKD.map((e) => `R${e.round} ${e.p.name}`).join(', ')}`)
               : pass('no K/DST before the last rounds');

roster.length === league.rounds ? pass(`roster is ${roster.length} deep`)
                                : fail(`roster is ${roster.length}, expected ${league.rounds}`);

const dupes = roster.length - new Set(roster.map((p) => p.id)).size;
dupes ? fail(`${dupes} duplicate picks`) : pass('no duplicate picks');

console.log(`\nStarting lineup: ${lineupPoints(roster, league).toFixed(0)} pts`);
console.log('Roster:', POSITIONS.map((p) => `${p}${counts[p] || 0}`).join(' '));

/* ------------------------------------------------------------- round plan */
console.log('\n--- round plan (fresh draft) ---');
const t0 = Date.now();
const plan = planRounds(board, league);
console.log(`computed in ${Date.now() - t0}ms`);
console.log(plan.map((r) => `R${r.round}:${r.pos || '-'}`).join(' '));
for (const r of plan.slice(0, 6)) {
  console.log(`  R${r.round} pick #${r.pick}  ${r.pos} (${Math.round(r.share * 100)}%)` +
    (r.alt ? ` else ${r.alt.pos}` : '') +
    `  targets: ${r.targets.map((p) => p.name).join(', ')}`);
}

process.exit(failures ? 1 : 0);
