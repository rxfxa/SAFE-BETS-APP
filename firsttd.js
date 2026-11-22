/* firsttd.js — "🏈 First TD" tab for Safe Bets (window.SB v2 module).

   DATA
   - firsttd.json  {updated, season, source, sourceUrl, status:{"TEAM|Player":{status,note,src}},
                    teams:{ABBR:{gp, rush, rec, players:[{name,pos,gp,rush,rec}]}}}
                   Season rushing + receiving TDs per player (ESPN team stats). "status" holds game-day calls that are newer
                   than injuries.json and win over it.
   - injuries.json (shared with lottos.js) for everyone else's status.
   - data.json (SB.DATA) for the NFL schedule and win probabilities, so prices move with every hourly refresh.

   MODEL (per game, home team H, away team A)
     λT          = team offensive TDs per game = (rush + rec) / gp
     no TD       = clamp(1.8% · e^(-0.3·(λH + λA − 5)), 0.6%, 4%)          (≈ league rate, lower in high-scoring spots)
     team first  = 55% win-odds view [0.5 + 0.62·(pWin − 0.5)] + 45% TD-rate view [λH / (λH + λA)]
                   (no feed price: win view = 52% home)
     player rate r_i = player TDs / (max(player games, team games / 2) + 2)   (per game played, shrunk so 1 TD in 1 game isn't a star)
     status w     out 0 · doubtful .25 · questionable .7 · day-to-day .92 (no designation yet) · probable .97 · active 1
     share s_i    = r_i·w_i / Σ r_j·w_j  within the team  (injured players' share flows to teammates)
     buckets      D/ST & return TDs 6% of a team's TDs; "any other player" 5% + 25% of the share lost to injuries (≤ 20%)
     FIRST TD     = (1 − noTD) · team first · (1 − D/ST − other) · s_i
     ANYTIME TD   = 1 − e^(−λ_i),  λ_i = λT · (0.85 + 0.3·pWinT) · (1 − D/ST) · s_i
   Leg keys: "TD:F:<TEAM>:<slug>" first TD, "TD:A:<TEAM>:<slug>" anytime, "TD:F:<TEAM>:dst", "TD:F:<TEAM>:field",
   "TD:F:NONE" no TD scorer. Custom legs are priced independently in the parlay engine; two first-TD legs from one game can't
   both win, so the tab keeps only the newest one.
*/
(() => {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('firsttd.js: window.SB v2 API not found'); return; }
const { esc, pct, store } = SB;
const $main = () => document.getElementById('main');
const DAY = 864e5, WINDOW = 8 * DAY;
const DST = 0.06, FIELD = 0.05;
const W = { out: 0, doubtful: .25, questionable: .7, 'day-to-day': .92, probable: .97, active: 1 };

// ---------------- data ----------------
let FT = null, INJ = new Map(), LOAD = 'loading', loading = null;
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = s => norm(s).replace(/ /g, '-');
const getJSON = u => fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
function load() {
  if (loading) return loading;
  loading = Promise.all([getJSON('firsttd.json'), getJSON('injuries.json')]).then(([ft, inj]) => {
    loading = null;
    if (ft && ft.teams && typeof ft.teams === 'object') { FT = ft; LOAD = 'ok'; } else if (!FT) LOAD = 'fail';
    const m = new Map();
    if (inj && Array.isArray(inj.injuries)) for (const x of inj.injuries) if (x && x.sport === 'nfl' && x.team && x.player)
      m.set(x.team + '|' + norm(x.player), { status: String(x.status || '').toLowerCase(), note: x.injury || '', src: x.sourceUrl || '' });
    if (FT && FT.status) for (const [k, v] of Object.entries(FT.status)) { const i = k.indexOf('|'); m.set(k.slice(0, i) + '|' + norm(k.slice(i + 1)), v); }
    INJ = m; MODEL.clear();
    if (document.querySelector('#tabs .tab.on[data-t="firsttd"]')) render($main());
    return FT;
  });
  return loading;
}
const statusOf = (team, name) => INJ.get(team + '|' + norm(name)) || null;
const weightOf = st => st ? (W[st.status] != null ? W[st.status] : 1) : 1;

// ---------------- model ----------------
const MODEL = new Map();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function teamRows(ab) {
  const t = FT && FT.teams[ab]; if (!t) return null;
  const gp = Math.max(1, t.gp), lam = (t.rush + t.rec) / gp;
  const rows = t.players.map(p => {
    const td = p.rush + p.rec, r = td / (Math.max(p.gp || 1, gp / 2) + 2), st = statusOf(ab, p.name), w = weightOf(st);
    return { ...p, team: ab, td, r, st, w, slug: slug(p.name) };
  });
  const full = rows.reduce((s, x) => s + x.r, 0) || 1, live = rows.reduce((s, x) => s + x.r * x.w, 0) || 1;
  const lost = 1 - live / full;
  for (const x of rows) x.s = x.r * x.w / live;
  return { ab, lam, rows, other: Math.min(.2, FIELD + .25 * lost) };
}
function model(g) {
  if (!g || !FT) return null;
  const ck = g.id + '|' + (g.prob ? g.prob.home : '-');
  if (MODEL.has(ck)) return MODEL.get(ck);
  const H = teamRows(g.home.abbr), A = teamRows(g.away.abbr);
  if (!H || !A) { MODEL.set(ck, null); return null; }
  const pw = g.prob && isFinite(g.prob.home) ? g.prob.home : null;
  const winView = pw != null ? .5 + .62 * (pw - .5) : .52;
  const rateView = H.lam / (H.lam + A.lam);
  const homeFirst = clamp(.55 * winView + .45 * rateView, .1, .9);
  const noTD = clamp(.018 * Math.exp(-.3 * (H.lam + A.lam - 5)), .006, .04);
  const side = (T, first, pWin) => {
    const pool = 1 - DST - T.other, lamG = T.lam * (.85 + .3 * pWin);
    const players = T.rows.map(x => ({ ...x, pF: (1 - noTD) * first * pool * x.s, pA: x.w > 0 ? 1 - Math.exp(-lamG * (1 - DST) * x.s) : 0 }))
      .sort((a, b) => b.pF - a.pF || b.td - a.td);
    return { ab: T.ab, first, lam: T.lam, players, dst: (1 - noTD) * first * DST, other: (1 - noTD) * first * T.other };
  };
  const m = { g, noTD, home: side(H, homeFirst, pw != null ? pw : .52), away: side(A, 1 - homeFirst, pw != null ? 1 - pw : .48), priced: pw != null };
  MODEL.set(ck, m); return m;
}
function legProb(g, key) {
  const m = model(g); if (!m) return 0;
  const [, kind, team, who] = String(key).split(':');
  if (team === 'NONE') return kind === 'F' ? m.noTD : 0;
  const S = m.home.ab === team ? m.home : m.away.ab === team ? m.away : null; if (!S) return 0;
  if (kind === 'F' && who === 'dst') return S.dst;
  if (kind === 'F' && who === 'field') return S.other;
  const x = S.players.find(p => p.slug === who); if (!x) return 0;
  return kind === 'F' ? x.pF : x.pA;
}
function legName(g, key) {
  const [, kind, team, who] = String(key).split(':');
  if (team === 'NONE') return 'No TD scorer';
  if (who === 'dst') return `${team} D/ST or return TD first`;
  if (who === 'field') return `Any other ${team} player first TD`;
  const t = FT && FT.teams[team], p = t && t.players.find(x => slug(x.name) === who);
  return `${p ? p.name : who} (${team}) ${kind === 'F' ? 'first TD' : 'anytime TD'}`;
}
SB.registerLegType('TD', {
  label(key, g) { return legName(g, key); },
  prob(g, key) { return legProb(g, key); },
  settle() { return null; }, // graded by hand in My Parlays
});

// ---------------- state ----------------
const st = { view: store.get('ftd.view', 'top'), book: store.get('ftd.book', false) };
let BOOK = store.get('ftd.prices', {});
const save = () => { store.set('ftd.view', st.view); store.set('ftd.book', st.book); };
const games = () => {
  const now = Date.now(), D = SB.DATA && SB.DATA.games || [];
  return D.filter(g => g.sport === 'nfl' && SB.openG(g) && !SB.isVoid(g) && SB.startMs(g) - now < WINDOW && FT && FT.teams[g.home.abbr] && FT.teams[g.away.abbr])
    .sort((a, b) => SB.startMs(a) - SB.startMs(b));
};
const dayShort = g => new Date(g.start).toLocaleDateString([], { weekday: 'short' });

// ---------------- render ----------------
const legId = (g, key) => esc(g.id + '|' + key);
function btn(g, key, p, small) {
  const inS = SB.inSlip(g.id, key), d = p < .1 ? 1 : 0;
  return `<button class="yes${inS ? ' in' : ''}" data-leg="${legId(g, key)}" aria-label="${esc(legName(g, key) + ', ' + pct(p, 1) + ', fair ' + SB.fmtOdds(p))}"><small>${esc(small)} ${pct(p, d)}</small>${esc(SB.fmtOdds(p))}</button>`;
}
function edgeHTML(g, key, p) {
  const raw = BOOK[g.id + '|' + key]; if (!raw) return '';
  const dec = SB.parseOdds(raw); if (!dec || dec <= 1) return `<span class="ft-edge bad">Can't read "${esc(raw)}"</span>`;
  const ev = SB.ev(p, dec);
  return `<span class="ft-edge ${ev >= 0 ? 'pos' : 'neg'}">${ev >= 0 ? '+' : '−'}${Math.abs(ev * 100).toFixed(0)}% ${ev >= 0 ? 'edge' : 'vs fair'}</span>`;
}
function bookInput(g, key) {
  if (!st.book) return '';
  return `<input class="ft-in" type="text" inputmode="decimal" placeholder="Book" value="${esc(BOOK[g.id + '|' + key] || '')}" data-ft-price="${legId(g, key)}" aria-label="${esc('Your book\'s first TD price for ' + legName(g, key))}">`;
}
function stBadge(x) {
  if (!x.st || x.st.status === 'active') return '';
  const s = x.st.status, cls = s === 'out' ? 'b-void' : s === 'doubtful' || s === 'questionable' ? 'b-est' : 'b-tag';
  const lbl = s === 'day-to-day' ? 'No status yet' : s[0].toUpperCase() + s.slice(1);
  return ` <span class="badge ${cls}" title="${esc(x.st.note || '')}">${esc(lbl)}</span>`;
}
function playerRow(g, x) {
  const kF = `TD:F:${x.team}:${x.slug}`, kA = `TD:A:${x.team}:${x.slug}`, out = x.w === 0;
  const tdTxt = `${x.td} TD${x.td === 1 ? '' : 's'}${x.rush && x.rec ? ` · ${x.rush} rush ${x.rec} rec` : x.rush ? ' rushing' : ' receiving'} · ${x.gp} G`;
  return `<div class="ft-row${out ? ' ft-out' : ''}">
    <div class="ft-who"><b>${esc(x.name)}</b><span class="ft-pos">${esc(x.pos)}</span>${stBadge(x)}<small>${esc(tdTxt)}</small>${out ? '' : bookInput(g, kF) + edgeHTML(g, kF, x.pF)}</div>
    ${out ? '<span class="ft-na">Out</span><span></span>' : btn(g, kF, x.pF, 'First') + btn(g, kA, x.pA, 'Any')}
  </div>`;
}
function bucketRow(g, key, title, sub, p) {
  return `<div class="ft-row ft-bucket"><div class="ft-who"><b>${esc(title)}</b><small>${esc(sub)}</small>${bookInput(g, key)}${edgeHTML(g, key, p)}</div>${btn(g, key, p, 'First')}<span></span></div>`;
}
function teamBlock(g, S, team, max) {
  const list = S.players.filter(x => x.w > 0).slice(0, max), outs = S.players.filter(x => x.w === 0);
  return `<div class="ft-team"><div class="ft-th">${SB.abBox(team)}<b>${esc(team.name)}</b><span class="ft-tf">${pct(S.first)} to score first TD</span></div>
    ${list.map(x => playerRow(g, x)).join('')}
    ${bucketRow(g, `TD:F:${S.ab}:field`, 'Any other ' + S.ab + ' player', 'No TD yet this season, or a new role', S.other)}
    ${bucketRow(g, `TD:F:${S.ab}:dst`, S.ab + ' defense / special teams', 'Pick-six, fumble return, kick or punt return', S.dst)}
    ${outs.length ? `<p class="note">Out for this game: ${outs.map(x => esc(x.name)).join(', ')}. Their share went to teammates.</p>` : ''}
  </div>`;
}
function gameCard(g, full) {
  const m = model(g); if (!m) return '';
  const hp = m.home.first;
  return `<div class="mk ft-card">
    <div class="mkhead"><span class="lg">${g.tag ? `<span class="badge b-tag">${esc(g.tag)}</span>` : 'NFL'} · ${esc(SB.when(g))}</span>${m.priced ? '' : '<span class="badge b-est">No win price yet</span>'}</div>
    <div class="ft-split" role="img" aria-label="${esc(`${g.away.name} ${pct(1 - hp)}, ${g.home.name} ${pct(hp)} to score the first touchdown`)}">
      <span><b>${esc(g.away.abbr)}</b> ${pct(1 - hp)}</span>
      <div class="bar"><div style="width:${((1 - hp) * 100).toFixed(1)}%;background:var(--s-away)"></div><div style="width:${(hp * 100).toFixed(1)}%;background:var(--s-home)"></div></div>
      <span>${pct(hp)} <b>${esc(g.home.abbr)}</b></span>
    </div>
    ${teamBlock(g, m.away, g.away, full ? 12 : 4)}
    ${teamBlock(g, m.home, g.home, full ? 12 : 4)}
    ${bucketRow(g, 'TD:F:NONE', 'No touchdown scored', 'Whole game, both teams', m.noTD)}
    ${full ? '' : `<button type="button" class="btn ghost full" data-ft-view="${esc(g.id)}">All ${esc(g.away.abbr)} @ ${esc(g.home.abbr)} players</button>`}
  </div>`;
}
function topBoard(gs) {
  const all = [];
  for (const g of gs) { const m = model(g); if (!m) continue; for (const S of [m.home, m.away]) for (const x of S.players) if (x.w > 0) all.push({ g, x }); }
  all.sort((a, b) => b.x.pF - a.x.pF);
  const top = all.slice(0, 15);
  if (!top.length) return '';
  return `<div class="mk ft-card"><div class="mkhead"><span class="lg">Best first-TD shots on the slate</span></div>
    ${top.map(({ g, x }) => {
      const kF = `TD:F:${x.team}:${x.slug}`, kA = `TD:A:${x.team}:${x.slug}`, opp = x.team === g.home.abbr ? '@ ' + g.away.abbr : 'vs ' + g.home.abbr;
      return `<div class="ft-row"><div class="ft-who"><b>${esc(x.name)}</b><span class="ft-pos">${esc(x.team)} ${esc(x.pos)}</span>${stBadge(x)}<small>${esc((x.team === g.home.abbr ? 'vs ' + g.away.abbr : '@ ' + g.home.abbr) + ' · ' + dayShort(g) + ' · ' + x.td + ' TDs in ' + x.gp + ' G')}</small>${bookInput(g, kF)}${edgeHTML(g, kF, x.pF)}</div>${btn(g, kF, x.pF, 'First')}${btn(g, kA, x.pA, 'Any')}</div>`;
    }).join('')}
  </div>`;
}
function render(el) {
  if (!el) return;
  if (LOAD === 'loading' && !FT) { el.innerHTML = '<div class="loading" aria-busy="true">Loading touchdown data…</div>'; load(); return; }
  if (!FT) { el.innerHTML = '<div class="empty">First TD data didn\'t load. Pull to refresh or try again in a minute.</div>'; return; }
  const gs = games();
  if (st.view !== 'top' && !gs.some(g => g.id === st.view)) st.view = 'top';
  const nav = `<div class="ft-nav" role="tablist" aria-label="Games">
      <button class="chip${st.view === 'top' ? ' on' : ''}" data-ft-view="top" role="tab" aria-selected="${st.view === 'top'}">Top picks</button>
      ${gs.map(g => `<button class="chip${st.view === g.id ? ' on' : ''}" data-ft-view="${esc(g.id)}" role="tab" aria-selected="${st.view === g.id}">${esc(g.away.abbr)} @ ${esc(g.home.abbr)} · ${esc(dayShort(g))}</button>`).join('')}
    </div>`;
  const head = `<h2>First TD Scorer<small>NFL · fair prices from season TD shares, win odds and injuries</small>
      <button type="button" class="linkbtn" data-ft-book>${st.book ? 'Hide book prices' : 'Compare my book'}</button></h2>`;
  let body;
  if (!gs.length) body = '<div class="empty">No upcoming NFL games with touchdown data right now.</div>';
  else if (st.view === 'top') body = topBoard(gs) + `<h2>Game by game<small>Top 4 per team · tap a game for everyone</small></h2><div class="grid">${gs.map(g => gameCard(g, false)).join('')}</div>`;
  else body = gameCard(gs.find(g => g.id === st.view), true);
  const book = st.book ? '<div class="lineup"><span>Type your sportsbook\'s <b>first TD</b> price under any player (+650, 7.5 or 13/2). Positive edge means the book pays more than the fair price.</span></div>' : '';
  el.innerHTML = head + nav + book + body + `
    <details class="method"><summary>How these are priced</summary>
      <p class="note">Each team's chance to score the first TD blends its win chance from the game feed (55%) with how often it scores TDs (45%).
      That goes to its players by each one's share of the team's rushing and receiving TDs per game played. Injured players' shares
      go to teammates. Defense and special teams get 6%, and players who haven't scored yet get at least 5%. The no-TD chance is about 2%,
      lower when both offenses score a lot. Anytime TD uses the same shares with the team's expected TDs. Picks are graded by hand
      in My Parlays. A first-TD pick and its team's moneyline are correlated, and the slip treats them as independent, so a combined
      price will look slightly long.</p>
      <p class="note">TD data: <a href="${esc(FT.sourceUrl || '#')}" target="_blank" rel="noopener">${esc(FT.source || 'ESPN')}</a>, ${esc(new Date(FT.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}. Injury status from the app's injury report plus game-day calls. Statuses change fast, so check before you bet.</p>
    </details>`;
  const on = el.querySelector('.ft-nav .chip.on'); if (on) { const r = on.parentElement; r.scrollLeft = Math.max(0, on.offsetLeft - r.offsetLeft - 40); }
}

// ---------------- events ----------------
document.addEventListener('click', e => {
  const v = e.target.closest('[data-ft-view]');
  if (v) { st.view = v.dataset.ftView; save(); render($main()); window.scrollTo(0, 0); return; }
  if (e.target.closest('[data-ft-book]')) { st.book = !st.book; save(); render($main()); }
});
document.addEventListener('change', e => {
  const i = e.target.closest('[data-ft-price]'); if (!i) return;
  const k = i.dataset.ftPrice, v = i.value.trim();
  if (v) BOOK[k] = v; else delete BOOK[k];
  store.set('ftd.prices', BOOK);
  const s = k.indexOf('|'), g = SB.gameById(k.slice(0, s)), key = k.slice(s + 1);
  const cell = i.parentElement, old = cell.querySelector('.ft-edge'); if (old) old.remove();
  if (g) i.insertAdjacentHTML('afterend', edgeHTML(g, key, legProb(g, key)));
});
// Only one first-TD outcome per game can win: keep the newest first-TD leg from each game.
let lastSlip = [];
SB.on('slip', slip => {
  const isF = L => /^TD:F:/.test(L.key);
  const added = slip.filter(L => isF(L) && !lastSlip.some(P => P.gid === L.gid && P.key === L.key));
  lastSlip = slip.map(L => ({ gid: L.gid, key: L.key }));
  for (const A of added) for (const L of slip) if (L !== A && L.gid === A.gid && isF(L)) {
    SB.toggleLeg(L.gid, L.key);
    SB.toast('Only one first touchdown per game. Swapped in ' + esc(A.label || legName(null, A.key)) + '.');
    break;
  }
  for (const b of document.querySelectorAll('#main .ft-row [data-leg]')) { const s = b.dataset.leg, i = s.indexOf('|'); b.classList.toggle('in', SB.inSlip(s.slice(0, i), s.slice(i + 1))); }
});

// ---------------- styles ----------------
const css = document.createElement('style'); css.id = 'firsttd-css';
css.textContent = `
.ft-nav{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;margin:0 -16px 12px;padding:2px 16px 4px}
.ft-nav::-webkit-scrollbar{display:none}
.ft-card{margin-bottom:12px;min-width:0} /* a grid item: without this its nowrap rows widen the card past a phone screen */
.ft-split{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;margin:10px 0 2px;font-size:13px;color:var(--mute);font-variant-numeric:tabular-nums}
.ft-split b{color:var(--text);font-style:italic}
.ft-split .bar{margin:0}
.ft-team{margin-top:14px}
.ft-th{display:flex;align-items:center;gap:9px;padding-bottom:6px;border-bottom:1px solid var(--edge)}
.ft-th b{font-style:italic;font-weight:800;font-stretch:108%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ft-tf{margin-left:auto;font-size:12px;color:var(--dim);font-weight:600;white-space:nowrap}
.ft-row{display:grid;grid-template-columns:minmax(0,1fr) 74px 74px;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.ft-th+.ft-row{border-top:0}
.ft-row .yes{width:74px;padding:6px 0;font-size:13px;line-height:1.2}
.ft-row .yes small{display:block;font-size:10.5px;font-weight:600;font-style:normal;opacity:.85}
.ft-who{min-width:0}
.ft-who b{font-size:15px;font-weight:650}
.ft-who small{display:block;font-size:12px;color:var(--dim);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ft-pos{font-size:11px;color:var(--dim);font-weight:700;letter-spacing:.06em;margin-left:6px}
.ft-who .badge{margin-left:4px;vertical-align:1px}
.ft-bucket .ft-who b{font-size:14px;font-weight:600;color:var(--mute)}
.ft-out{opacity:.55}
.ft-na{font-size:12px;color:var(--no);font-weight:700;font-style:italic;text-align:center}
.ft-in{margin-top:6px;max-width:110px;padding:7px 9px!important;font-size:14px!important}
.ft-edge{display:inline-block;margin:6px 0 0 8px;font-size:12px;font-weight:800;font-style:italic;font-variant-numeric:tabular-nums}
.ft-edge.pos{color:var(--yes)}.ft-edge.neg{color:var(--no)}.ft-edge.bad{color:var(--amber);font-weight:600}
@media(min-width:1080px){.ft-nav{margin:0 0 12px;padding:2px 0 4px}}
`;
document.head.appendChild(css);

// ---------------- tab ----------------
const TAB = { key: 'firsttd', label: '🏈 First TD', after: 'props', render };
SB.registerTab(TAB);
SB.on('data', () => { MODEL.clear(); load(); setTimeout(() => { if (!document.querySelector('#tabs [data-t="firsttd"]')) SB.registerTab(TAB); }, 0); });
load();

window.__firsttd = { model, legProb, teamRows, get FT() { return FT; }, get INJ() { return INJ; }, load };
})();
