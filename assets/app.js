/* UI wiring. All the modelling lives in engine.js and planner.js; this file
   loads the board, keeps draft state in localStorage, and renders. */

import {
  DEFAULT_LEAGUE, POSITIONS, myPicks, roundOf, teamOnClock, recommend, explain,
  rosterNeed,
} from './engine.js';
import { planRounds } from './planner.js';

const $ = (id) => document.getElementById(id);
const STORE = 'ffdraft.v1';

let board = null;
let league = { ...DEFAULT_LEAGUE };
let state = null;      // { pick, taken:Set, roster:[], history:[] }
let plan = [];
let filterPos = null;
let query = '';
let ctx = null;

/* ------------------------------------------------------------ persistence */

function save() {
  if (!state) return;
  try {
    localStorage.setItem(STORE, JSON.stringify({
      league,
      pick: state.pick,
      taken: [...state.taken],
      roster: state.roster.map((p) => p.id),
      history: state.history,
      plan: plan.map((r) => ({ round: r.round, pick: r.pick, pos: r.pos, share: r.share })),
    }));
  } catch { /* private mode: the draft still works, it just won't survive a reload */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ setup */

function chipRow(el, values, current, onPick, label = (v) => v) {
  el.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = label(v);
    b.setAttribute('aria-pressed', String(v === current));
    b.addEventListener('click', () => onPick(v));
    el.appendChild(b);
  }
}

function renderSetup() {
  chipRow($('teamsChips'), [8, 10, 12, 14], league.teams, (v) => {
    league.teams = v;
    if (league.slot > v) league.slot = v;
    renderSetup();
  });
  chipRow($('slotChips'), Array.from({ length: league.teams }, (_, i) => i + 1),
    league.slot, (v) => { league.slot = v; renderSetup(); });
  chipRow($('roundsChips'), [13, 14, 15, 16, 17], league.rounds,
    (v) => { league.rounds = v; renderSetup(); });

  const picks = myPicks(league);
  $('slotHint').textContent = `— your picks: ${picks.slice(0, 4).join(', ')}…`;

  const s = league.starters;
  $('starterSummary').textContent =
    POSITIONS.filter((p) => s[p]).map((p) => `${s[p]}${p}`).join(' ') +
    (s.FLEX ? ` ${s.FLEX}FLEX` : '');

  const grid = $('starterGrid');
  grid.innerHTML = '';
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST']) {
    const row = document.createElement('div');
    row.className = 'starter-row';
    row.innerHTML = `<span>${pos}</span>
      <div class="stepper">
        <button type="button" data-d="-1">−</button><b>${s[pos] || 0}</b><button type="button" data-d="1">+</button>
      </div>`;
    row.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
      const d = Number(btn.dataset.d);
      s[pos] = Math.max(0, Math.min(4, (s[pos] || 0) + d));
      renderSetup();
    }));
    grid.appendChild(row);
  }
}

/* ------------------------------------------------------------------ draft */

function startDraft(resume) {
  if (resume) {
    const saved = load();
    league = saved.league;
    const byId = new Map(board.players.map((p) => [p.id, p]));
    state = {
      pick: saved.pick,
      taken: new Set(saved.taken),
      roster: saved.roster.map((id) => byId.get(id)).filter(Boolean),
      history: saved.history || [],
    };
  } else {
    state = { pick: 1, taken: new Set(), roster: [], history: [] };
  }
  $('setup').hidden = true;
  $('draft').hidden = false;
  chipRow($('posFilter'), ['ALL', ...POSITIONS], filterPos || 'ALL',
    (v) => { filterPos = v === 'ALL' ? null : v; render(); });
  rebuildPlan();
  render();
}

function rebuildPlan() {
  plan = planRounds(board, league, state);
  save();
}

const mineSet = () => new Set(myPicks(league));

function render() {
  ctx = recommend(board, league, state, 120);
  renderBar();
  renderStrip();
  renderRec();
  renderList();
  markRunChips();
  $('undoBtn').disabled = !state.history.length;
  save();
}

function renderBar() {
  const r = roundOf(state.pick, league.teams);
  const onClock = mineSet().has(state.pick);
  const now = $('pickNow');
  now.textContent = `Pick ${state.pick} · Round ${r}`;
  now.classList.toggle('live', onClock);
  const next = myPicks(league).find((p) => p >= state.pick);
  const seat = teamOnClock(state.pick, league.teams);
  $('pickNext').textContent = onClock
    ? "You're on the clock"
    : next ? `Team ${seat} picking · your next is #${next}, ${next - state.pick} away`
           : `Team ${seat} picking · no picks left for you`;
}

function renderStrip() {
  const el = $('roundStrip');
  const cur = roundOf(state.pick, league.teams);
  el.innerHTML = '';
  for (const r of plan) {
    const d = document.createElement('div');
    const past = r.round < cur;
    d.className = 'rd' + (r.round === cur ? ' now' : past ? ' done' : '');
    // Once you've made your pick for a round, show who you took rather than
    // what the plan wanted. Keyed on the pick itself, not on the round being
    // over, since your pick can land early in a round that is still running.
    const taken = state.roster[r.round - 1] || null;
    d.innerHTML = `<b>${taken ? taken.pos : (r.pos || '—')}</b><i>R${r.round}</i>`;
    d.title = taken ? taken.name
      : r.targets?.length ? r.targets.map((p) => p.name).join(', ') : '';
    el.appendChild(d);
  }
  const now = el.querySelector('.rd.now');
  if (now) now.scrollIntoView({ block: 'nearest', inline: 'center' });
}


/* ------------------------------------------------------------- strategy */

/** Which positions are being taken faster than the board expects.
 *
 * The number that matters is pressure: demand from the specific teams picking
 * before your turn, measured against what ADP alone predicts. Above ~1.5 means
 * a run, and the reason a player you were planning to wait on may not be there.
 */
function renderStrategy() {
  const s = ctx.strategy;
  const head = $('stratHead');
  const body = $('stratBody');
  if (!s || !s.next) {
    head.textContent = 'No picks left.';
    body.innerHTML = '';
    $('stratSheet').hidden = false;
    return;
  }

  // A snake window doubles back, so the raw seat list repeats itself.
  const seats = [...new Set(s.window.map((w) => w.seat))].sort((a, b) => a - b);
  head.textContent = `${s.window.length} pick${s.window.length === 1 ? '' : 's'} ` +
    `until your #${s.next} — team${seats.length === 1 ? '' : 's'} ${seats.join(', ')}`;

  const rows = POSITIONS
    .filter((pos) => pos !== 'K' && pos !== 'DST')
    .map((pos) => ({ pos, press: s.pressure[pos] ?? 1, exp: s.demand[pos] ?? 0,
                     adp: s.baseline[pos] ?? 0, seen: s.recent[pos] ?? 0 }))
    .sort((a, b) => b.press - a.press);

  body.innerHTML = rows.map((r) => {
    const pct = Math.min(100, (r.press / 2.2) * 100);
    const tone = r.press >= 1.5 ? 'hot' : r.press <= 0.8 ? 'cold' : '';
    const verdict = r.press >= 1.5 ? 'run — move these up'
      : r.press >= 1.15 ? 'going quicker than usual'
      : r.press <= 0.8 ? 'quiet, safe to wait'
      : 'about normal';
    return `<div class="strat-row">
      <div class="strat-top">
        <b>${r.pos}</b>
        <span class="strat-x ${tone}">${r.press.toFixed(2)}×</span>
      </div>
      <div class="strat-bar"><i class="${tone}" style="width:${pct}%"></i></div>
      <div class="strat-note">${verdict} · about ${r.exp.toFixed(1)} expected vs
        ${r.adp} by ADP · ${r.seen} taken in the last ${s.lookback} picks</div>
    </div>`;
  }).join('');

  $('stratSheet').hidden = false;
}

/** Mark the position filter chips that are currently running hot. */
function markRunChips() {
  const s = ctx.strategy;
  if (!s?.pressure) return;
  for (const chip of $('posFilter').querySelectorAll('.chip')) {
    const pos = chip.textContent.trim();
    const press = s.pressure[pos];
    const hot = press >= 1.5;
    chip.classList.toggle('run', hot);
    chip.title = press ? `${pos} going ${press.toFixed(2)}x vs ADP` : '';
  }
}

function renderRec() {
  const el = $('recCard');
  const onClock = mineSet().has(state.pick);
  const top = ctx.list[0];
  if (!top) { el.innerHTML = ''; return; }
  const p = top.player;

  // Off the clock the card is advice only -- logging a pick is a tap on the
  // player in the list, whoever it belongs to.
  const next = myPicks(league).find((q) => q >= state.pick);
  const head = onClock
    ? '<div class="rec-tag">Take now</div>'
    : `<div class="rec-tag">Leaning toward · pick ${next ?? '—'}</div>`;
  const action = onClock
    ? `<div class="rec-actions">
        <button class="rec-take" data-act="take">Draft ${esc(p.name.split(' ').pop())}</button>
      </div>`
    : '';
  el.innerHTML = `<div class="rec-card">
    ${head}
    <div class="rec-name">${esc(p.name)}</div>
    <div class="rec-sub">${p.pos} · ${esc(p.team)} · ${p.pts} pts projected</div>
    <div class="rec-why">${esc(explain(top, ctx, board))}</div>
    ${action}</div>`;
  el.querySelector('[data-act="take"]')?.addEventListener('click', () => logPick(p));
}

function renderList() {
  const el = $('list');
  const q = query.trim().toLowerCase();
  let rows = ctx.list;
  if (filterPos) rows = rows.filter((s) => s.player.pos === filterPos);
  if (q) rows = rows.filter((s) => s.player.name.toLowerCase().includes(q)
                                || s.player.team.toLowerCase() === q);
  rows = rows.slice(0, 60);

  if (!rows.length) {
    el.innerHTML = '<li class="empty">No players match.</li>';
    return;
  }

  el.innerHTML = '';
  for (const s of rows) {
    const p = s.player;
    const li = document.createElement('li');
    li.className = 'row';

    const meta = [];
    meta.push(`<span>${p.adp ? `ADP ${p.adp}` : 'no ADP'}</span>`);
    if (p.bye) meta.push(`<span>bye ${p.bye}</span>`);
    if (p.p?.['3']) meta.push(`<span class="badge mkt">top3 ${Math.round(p.p['3'] * 100)}%</span>`);
    else if (p.p?.['1']) meta.push(`<span class="badge mkt">top1 ${Math.round(p.p['1'] * 100)}%</span>`);
    if (p.injury && !HEALTHY.has(p.injury)) meta.push(`<span class="badge inj">${esc(shortInjury(p.injury))}</span>`);
    if (p.d7 && Math.abs(p.d7) >= 0.02) {
      const up = p.d7 > 0;
      meta.push(`<span class="badge ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(p.d7 * 100))}c</span>`);
    }

    const surv = ctx.nextPick ? Math.round(s.survival * 100) : null;
    li.innerHTML = `
      <div class="pos ${p.pos}">${p.pos}</div>
      <div class="row-main">
        <div class="row-name">${esc(p.name)} <span style="color:var(--dim);font-weight:400">${esc(p.team)}</span></div>
        <div class="row-meta">${meta.join('')}</div>
      </div>
      <div class="row-right">
        <div class="row-vorp">${s.vorp >= 0 ? '+' : ''}${s.vorp.toFixed(0)}</div>
        ${surv === null ? '' : `<div class="row-surv ${surv < 35 ? 'hot' : ''}">${surv}% lasts</div>`}
        <div class="mix" title="market weight ${Math.round(p.w * 100)}%"><i style="width:${Math.round(p.w * 100)}%"></i></div>
      </div>`;
    attachRowGestures(li, p);
    el.appendChild(li);
  }
}

/* Tap logs the pick; press and hold opens the details sheet.
 *
 * The hold has to swallow the click that follows it, or a long press would
 * both show details and draft the player. Any real movement cancels the hold
 * so scrolling the list never triggers it. */
const HOLD_MS = 450;
const HOLD_SLOP_PX = 10;

function attachRowGestures(li, p) {
  let timer = null;
  let held = false;
  let start = null;

  const cancel = () => { clearTimeout(timer); timer = null; };

  li.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    held = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      held = true;
      timer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      openSheet(p);
    }, HOLD_MS);
  });

  li.addEventListener('pointermove', (e) => {
    if (!timer || !start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > HOLD_SLOP_PX) cancel();
  });

  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    li.addEventListener(ev, cancel);
  }

  li.addEventListener('click', (e) => {
    if (held) { e.preventDefault(); e.stopPropagation(); held = false; return; }
    logPick(p);
  });

  // Long-press on touch otherwise raises the OS text/callout menu.
  li.addEventListener('contextmenu', (e) => e.preventDefault());
}

const HEALTHY = new Set(['ACTIVE', 'HEALTHY', 'NORMAL', '']);

function shortInjury(s) {
  return { INJURY_RESERVE: 'IR', NON_FOOTBALL_INJURY: 'NFI', SUSPENSION: 'SUSP',
           QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'OUT', PUP: 'PUP' }[s] || s;
}

/* ------------------------------------------------------------------ picks */

/** Record a player against whichever seat is on the clock.
 *
 * There is nothing to ask: the pick number determines the team, so a tap is
 * unambiguous. The seat is recomputed here rather than read from the UI so it
 * always matches the counter, including after the counter has been corrected.
 */
function logPick(p) {
  const seat = teamOnClock(state.pick, league.teams);
  const isMine = seat === league.slot;
  state.taken.add(p.id);
  if (isMine) state.roster.push(p);
  state.history.push({ id: p.id, mine: isMine, pick: state.pick, team: seat });
  state.pick++;
  query = '';
  $('search').value = '';
  render();
  toast(isMine ? `Your pick · ${p.name}` : `Team ${seat} · ${p.name}`, undo);
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  state.taken.delete(last.id);
  if (last.mine) state.roster.pop();
  state.pick = last.pick;
  render();
  toast('Undone');
}

/* ----------------------------------------------------------------- sheets */

let sheetPlayer = null;

function openSheet(p) {
  sheetPlayer = p;
  $('sheetName').textContent = p.name;
  const bits = [`${p.pos} · ${p.team}`, `${p.pts} pts`, p.adp ? `ADP ${p.adp}` : null,
    p.bye ? `bye ${p.bye}` : null,
    p.w > 0 ? `${Math.round(p.w * 100)}% market-weighted` : 'projection only'];
  if (p.oi) bits.push(`${p.oi} contracts open`);
  $('sheetMeta').textContent = bits.filter(Boolean).join(' · ');
  $('sheetNote').textContent = p.note || '';
  $('sheetNote').hidden = !p.note;
  $('sheet').hidden = false;
}

function closeSheets() {
  for (const id of ['sheet', 'menu', 'newsSheet', 'stratSheet']) $(id).hidden = true;
}

/** Nudge the pick counter when it has drifted from the real draft.
 *
 * Only the counter moves -- players already marked stay marked. Without this
 * a single missed pick would leave every later pick filed under the wrong
 * team, with no way back.
 */
function nudgePick(delta) {
  const last = league.teams * league.rounds;
  const next = Math.min(last, Math.max(1, state.pick + delta));
  if (next === state.pick) return;
  state.pick = next;
  render();
  renderPickFix();
}

function renderPickFix() {
  const seat = teamOnClock(state.pick, league.teams);
  const mine = seat === league.slot;
  $('pickFixValue').textContent =
    `Pick ${state.pick} · ${mine ? 'you' : `Team ${seat}`} · Round ${roundOf(state.pick, league.teams)}`;
}

function renderMenu() {
  const el = $('myRoster');
  if (!state.roster.length) {
    el.innerHTML = '<div class="roster-empty">No picks yet.</div>';
  } else {
    const { need } = rosterNeed(state.roster, league);
    const unfilled = Object.entries(need).filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}×${n}`).join(', ');
    el.innerHTML = state.roster.map((p) =>
      `<div class="roster-line"><b>${esc(p.name)}</b><span>${p.pos} · ${p.pts}${p.bye ? ` · bye ${p.bye}` : ''}</span></div>`).join('')
      + (unfilled ? `<div class="roster-line"><span>Still needed</span><span>${unfilled}</span></div>` : '');
  }
  renderPickFix();
  $('menu').hidden = false;
}

function renderNews() {
  $('newsList').innerHTML = (board.news || []).map((n) =>
    `<div class="news-item"><b>${esc(n.headline)}</b><p>${esc(n.description || '')}</p></div>`
  ).join('') || '<div class="roster-empty">No news in this snapshot.</div>';
  $('newsSheet').hidden = false;
}

/* ------------------------------------------------------------------ misc */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;

/* A tap commits immediately, so the correction belongs next to the action
   rather than only in the header. */
function toast(msg, onUndo) {
  const t = $('toast');
  t.textContent = '';
  t.append(msg);
  if (onUndo) {
    const b = document.createElement('button');
    b.className = 'toast-undo';
    b.type = 'button';
    b.textContent = 'Undo';
    b.addEventListener('click', () => { t.hidden = true; onUndo(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  try {
    const res = await fetch('data/board.json', { cache: 'no-cache' });
    board = await res.json();
  } catch {
    $('boardStamp').textContent = 'Could not load the board. Check your connection once, then it works offline.';
    return;
  }
  const when = new Date(board.generated_at.replace(' ', 'T'));
  $('boardStamp').textContent =
    `${board.coverage.players} players · ${board.coverage.with_market} market-priced · ` +
    `updated ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
    `${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

  const saved = load();
  if (saved) {
    league = { ...league, ...saved.league };
    $('resumeBtn').hidden = false;
    $('resumeBtn').textContent = `Resume draft — pick ${saved.pick}`;
  }
  renderSetup();

  $('startBtn').addEventListener('click', () => startDraft(false));
  $('resumeBtn').addEventListener('click', () => startDraft(true));
  $('undoBtn').addEventListener('click', undo);
  $('menuBtn').addEventListener('click', renderMenu);
  $('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });

  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet') || e.target.dataset?.act === 'close') closeSheets();
  });

  $('menu').addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (e.target === $('menu') || act === 'close') return closeSheets();
    if (act === 'pick-') return nudgePick(-1);
    if (act === 'pick+') return nudgePick(1);
    if (act === 'replan') { closeSheets(); rebuildPlan(); render(); toast('Round plan updated'); }
    if (act === 'strategy') { $('menu').hidden = true; renderStrategy(); }
    if (act === 'news') { $('menu').hidden = true; renderNews(); }
    if (act === 'reset') {
      if (confirm('Reset this draft? Your picks will be cleared.')) {
        localStorage.removeItem(STORE);
        location.reload();
      }
    }
  });

  for (const id of ['newsSheet', 'stratSheet']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id) || e.target.dataset?.act === 'close') closeSheets();
    });
  }

  // Must be served from the site root: a worker at assets/sw.js would get
  // scope /assets/ and could not control the page it is meant to cache.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
