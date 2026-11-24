/* polymarket.js — "🟣 Polymarket" tab: Polymarket game markets next to the Safe Bets model, value picks, parlays built from
   Polymarket prices, and a 100,000-night slate simulator.

   DATA: polymarket.json, written by tools/polymarket_fetch.py from the public Gamma API (no key). Prices are dollars per $1
   share = the market's implied chance: b = best bid, a = best ask (what you pay to buy), m = mid. A snapshot: the page can't
   reach Polymarket itself (the artifact's network is closed), so it shows the time it was taken.
   MATCHING: each Polymarket game is paired with the feed game of the same sport starting within 6 hours whose team names /
   abbreviations match. Model chances use the app's leg keys, so every pick works in the slip, builder and simulator:
     moneyline SC:ml:H|A|D, spread SC:sp:<side>:<line>, total SC:tot:O|U:<line> (slipcheck.js), NBA points overs
     L:<team>-<player>:<n> (lottos.js), rebounds/assists from props.json P:/U: keys.
   VALUE: EV per $1 when buying at the ask = model chance / ask − 1 (before Polymarket fees). A value pick needs a two-sided quote
   (spread ≤ 12¢), an ask of 15-85¢, EV of 4-30% and the model within 8 points of the mid. Totals get no model when the feed
   has no game total (the engine would sit on a league average).
   SLATE SIMULATOR: one value pick per game, $stake each bought at the ask, 100,000 simulated nights with the model's chances
   (games independent), next to the same slate if the market's mid prices are right.
*/
(function () {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('polymarket.js: window.SB v2 API not found'); return; }
const { esc } = SB;
const SPORTS = [['all', 'All'], ['nba', 'NBA'], ['nfl', 'NFL'], ['nhl', 'NHL'], ['ncaaf', 'College FB'], ['soccer', 'Soccer']];
const WINS = [['24h', 'Next 24 hours', 24], ['3d', 'Next 3 days', 72], ['8d', 'All', 192]];
const MIN_EV = 0.04, MAX_EV = 0.3, MAX_GAP = 0.08, NSIM = 100000;
// a value pick: EV 4-30%, model within 8 points of the market's mid, buy price 15-85¢ (outside that the model is more likely missing
// information the market has than the market being wrong)
const isValue = r => r.ev != null && r.ev >= MIN_EV && r.ev <= MAX_EV && Math.abs(r.p - r.q.m) <= MAX_GAP && r.q.a >= 0.15 && r.q.a <= 0.85;

// ---------------- helpers ----------------
const N = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(fc|cf|sc|afc|ac|cd|club)\b/g, ' ').replace(/\s+/g, ' ').trim();
const nameKey = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const pctS = (p, d) => SB.pct(p, d == null ? (p < 0.1 ? 1 : 0) : d);
const cents = x => (x == null ? '—' : Math.round(x * 100) + '¢');
const signPct = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%';
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) {} } };
const activeTab = () => { const el = document.querySelector('#tabs [aria-current="page"]') || document.querySelector('#tabs .tab.on'); return el ? el.dataset.t : null; };
const live = q => q && q.b != null && q.a != null && q.b > 0 && q.a < 1 && q.a > q.b && q.a - q.b <= 0.12;
const fmtTime = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };

// ---------------- data ----------------
let PM = null, LOAD = 'idle', loadedFor = null, MATCH = new Map(), simOut = null;
async function load() {
  const stamp = SB.DATA && SB.DATA.updated;
  if (LOAD === 'loading' || (LOAD === 'done' && loadedFor === stamp)) return;
  LOAD = 'loading';
  try { const r = await fetch('polymarket.json', { cache: 'no-cache' }); const j = r.ok ? await r.json() : null; if (j && Array.isArray(j.games)) PM = j; } catch (e) {}
  MATCH = new Map(); LOAD = 'done'; loadedFor = stamp;
  if (activeTab() === 'polymarket') SB.render();
}
function teamScore(pt, gt) {
  if (!pt || !gt) return 0;
  if (pt.abbr && gt.abbr && pt.abbr.toUpperCase() === String(gt.abbr).toUpperCase()) return 2;
  const ours = ' ' + N(gt.name) + ' ';
  for (const x of [N(pt.name), N(pt.alias)]) { if (x.length >= 3 && (ours.includes(' ' + x + ' ') || (' ' + x + ' ').includes(ours))) return 2; }
  const w = N(pt.name).split(' ').filter(x => x.length >= 5);
  return w.some(x => ours.includes(' ' + x + ' ')) ? 1 : 0;
}
function matchOf(pg) {
  if (MATCH.has(pg.slug)) return MATCH.get(pg.slug);
  // the Sharp Board's stricter matcher when it is loaded: a bare college nickname ("Broncos") counts only when the
  // Polymarket abbreviation runs through the feed's full name, one side must be identified firmly, and ties don't match
  if (window.__sharp && typeof window.__sharp.match === 'function') {
    let sm = null; try { sm = window.__sharp.match(pg); } catch (e) { sm = null; }
    const m = sm && sm.g ? { g: sm.g, swap: !!sm.swap } : null; MATCH.set(pg.slug, m); return m;
  }
  const t = Date.parse(pg.start); let best = null, bs = 0;
  for (const g of (SB.DATA && SB.DATA.games) || []) {
    if (g.sport !== pg.sport || Math.abs(SB.startMs(g) - t) > 6 * 3600e3) continue;
    const s = teamScore(pg.home, g.home) + teamScore(pg.away, g.away), sx = teamScore(pg.home, g.away) + teamScore(pg.away, g.home);
    const sc = Math.max(s, sx); if (sc > bs) { bs = sc; best = { g, swap: sx > s }; }
  }
  const m = bs >= 3 ? best : null; MATCH.set(pg.slug, m); return m;
}
// a Polymarket outcome -> app leg key + model chance
const sideKey = (swap, side) => (side === 'D' ? 'D' : (side === 'H') !== !!swap ? 'H' : 'A');
const fmtLine = x => (x > 0 ? '+' : '') + x;
function rowsFor(pg) {
  const m = matchOf(pg), g = m && m.g, ok = g && SB.priced(g), rows = [];
  // our totals are only real when the feed carries a game total; otherwise they sit on a league average, so show the market only
  let noTot = false;
  if (ok) { try { const F = SB.fit(g); noTot = (F && F.kind === 'margin' && F.genTotal) || (g.sport === 'nhl' && !(g.total > 0)); } catch (e) { noTot = true; } }
  const add = (type, label, q, key, extra = {}) => {
    let p = null;
    if (ok && key && !(type === 'Total' && noTot)) { try { p = SB.p1(g, key); } catch (e) { p = null; } if (!(p > 0)) p = null; }
    rows.push({ pg, g: g || null, type, label, q, key: p != null ? key : null, p, ev: p != null && live(q) && q.a >= 0.05 && q.a <= 0.95 ? p / q.a - 1 : null, ...extra });
  };
  const H = pg.home.name, A = pg.away.name;
  if (pg.ml.home) add('Moneyline', `${H} to win`, pg.ml.home, `SC:ml:${sideKey(m && m.swap, 'H')}`);
  if (pg.ml.away) add('Moneyline', `${A} to win`, pg.ml.away, `SC:ml:${sideKey(m && m.swap, 'A')}`);
  if (pg.ml.draw) add('Moneyline', 'Draw', pg.ml.draw, 'SC:ml:D');
  for (const s of pg.spreads || []) {
    const hs = sideKey(m && m.swap, 'H'), as = sideKey(m && m.swap, 'A');
    add('Spread', `${H} ${fmtLine(s.hl)}`, s.home, `SC:sp:${hs}:${s.hl}`, { v: s.v });
    add('Spread', `${A} ${fmtLine(-s.hl)}`, s.away, `SC:sp:${as}:${-s.hl}`, { v: s.v });
  }
  for (const t of pg.totals || []) { add('Total', `Over ${t.line}`, t.over, `SC:tot:O:${t.line}`, { v: t.v }); add('Total', `Under ${t.line}`, t.under, `SC:tot:U:${t.line}`, { v: t.v }); }
  if (g && pg.sport === 'nba') for (const pr of pg.props || []) {
    const k = propKey(g, pr); const lbl = `${pr.player} over ${pr.line} ${({ pts: 'points', reb: 'rebounds', ast: 'assists', '3pm': 'threes' })[pr.stat] || pr.stat}`;
    if (k.over) add('Prop', lbl, pr.over, k.over, { v: pr.v, player: pr.player });
    if (k.under) add('Prop', lbl.replace(' over ', ' under '), pr.under, k.under, { v: pr.v, player: pr.player });
  }
  return rows;
}
function propKey(g, pr) {
  const thr = Math.floor(pr.line) + 1, nk = nameKey(pr.player);
  const P = ((SB.DATA && SB.DATA.players) || []).find(x => x.gid === g.id && x.stat === pr.stat && nameKey(x.name) === nk);
  if (P) return { over: `P:${P.id}:${thr}`, under: `U:${P.id}:${pr.line}` };
  if (pr.stat === 'pts' && window.__lottos && window.__lottos.ROLES) {
    for (const t of [g.home.abbr, g.away.abbr]) { const pl = window.__lottos.teamModel(t).players.find(x => nameKey(x.name) === nk); if (pl) return { over: `L:${t}-${pl.slug}:${thr}` }; }
  }
  return {};
}
function games(sp, win) {
  const now = Date.now(), H = (WINS.find(w => w[0] === win) || WINS[0])[2];
  return ((PM && PM.games) || []).filter(pg => { const t = Date.parse(pg.start); return t > now && t - now <= H * 3600e3 && (sp === 'all' || pg.sport === sp); });
}

// ---------------- parlays + simulator ----------------
const CACHE = {};
function pickByGame(rows, n, filter, sortKey) {
  const out = [], seen = new Set();
  for (const r of rows.filter(filter).sort(sortKey)) { const id = r.g ? r.g.id : r.pg.slug; if (seen.has(id)) continue; seen.add(id); out.push(r); if (out.length === n) break; }
  return out;
}
function parlayOf(id, title, legs, blurb) {
  if (legs.length < 2) return null;
  const pm = legs.reduce((s, r) => s * r.q.m, 1), p = legs.every(r => r.p != null) ? legs.reduce((s, r) => s * r.p, 1) : null;
  const P = { id, title, legs, pm, p, blurb }; CACHE[id] = P; return P;
}
function simulate(picks, stake) {
  // 100,000 nights; each pick bought at the ask: win pays stake x (1/ask - 1), loss costs the stake
  const run = probOf => { let seed = 0x9e3779b9 ^ picks.length; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const res = new Float64Array(NSIM); let sum = 0, up = 0;
    for (let i = 0; i < NSIM; i++) { let pl = 0; for (const r of picks) pl += rnd() < probOf(r) ? stake * (1 / r.q.a - 1) : -stake; res[i] = pl; sum += pl; if (pl > 0) up++; }
    const s = Float64Array.from(res).sort(); const q = f => s[Math.min(NSIM - 1, Math.floor(f * NSIM))];
    return { mean: sum / NSIM, up: up / NSIM, p5: q(0.05), p50: q(0.5), p95: q(0.95), min: s[0], max: s[NSIM - 1], res: s }; };
  return { model: run(r => r.p), market: run(r => r.q.m), n: picks.length, stake, risk: stake * picks.length };
}
function histo(sim) {
  const s = sim.model.res, lo = sim.model.min, hi = sim.model.max, B = 24, w = (hi - lo) / B || 1, bins = new Array(B).fill(0);
  for (let i = 0; i < s.length; i++) bins[Math.min(B - 1, Math.floor((s[i] - lo) / w))]++;
  const mx = Math.max(...bins), W = 320, Hh = 90, bw = W / B;
  return `<svg class="pm-hist" viewBox="0 0 ${W} ${Hh + 16}" role="img" aria-label="Distribution of profit over 100,000 simulated nights">
    ${bins.map((c, i) => { const x0 = lo + i * w, h = mx ? c / mx * Hh : 0; return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(Hh - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${x0 + w / 2 >= 0 ? 'var(--yes)' : 'var(--no)'}" opacity=".85"/>`; }).join('')}
    <text x="0" y="${Hh + 13}" fill="var(--dim)" font-size="10">${esc(money(lo))}</text><text x="${W}" y="${Hh + 13}" fill="var(--dim)" font-size="10" text-anchor="end">${esc(money(hi))}</text></svg>`;
}

// ---------------- markup ----------------
const legRow = (r, i) => `<div class="leg"><span class="legdot ${i === 0 ? 'base' : ''}">${i + 1}</span><div class="legtxt"><b>${esc(r.label)}</b>
  <span>${esc(r.pg.away.name)} @ ${esc(r.pg.home.name)} · ${esc(fmtTime(r.pg.start))}</span><em class="pm-why">Market ${pctS(r.q.m, 1)} · ${cents(r.q.a)} to buy · model ${r.p != null ? pctS(r.p, 0) : 'n/a'}${r.ev != null ? ` · ${signPct(r.ev)} EV` : ''}</em></div>
  <span class="legp mono">${r.p != null ? pctS(r.p, 0) : pctS(r.q.m, 1)}<small>${r.p != null ? esc(SB.fmtOdds(r.p)) : 'market'}</small></span></div>`;
function parlayCard(P) {
  const can = P.legs.every(r => r.key), pa = P.legs.every(r => r.q.a > 0) ? P.legs.reduce((s, r) => s * r.q.a, 1) : null;  // cost of buying every leg
  return `<div class="pc pm-card"><div class="pchead"><span class="pctitle">${esc(P.title)} <span class="badge pm-tag">POLYMARKET</span></span><span class="hit ${P.p == null ? 'h-mid' : P.p >= .55 ? 'h-hi' : P.p >= .3 ? 'h-mid' : 'h-lo'}">${pctS(P.p ?? P.pm)} to hit</span></div>
   ${P.blurb ? `<div class="why" style="margin-top:4px">${esc(P.blurb)}</div>` : ''}
   <div style="margin-top:4px">${P.legs.map(legRow).join('')}</div>
   <div class="pm-two"><div><span>Market says</span><b class="mono">${pctS(P.pm)}</b><small>${esc(SB.fmtOdds(P.pm))}</small></div><div><span>Model says</span><b class="mono">${P.p != null ? pctS(P.p) : '—'}</b><small>${P.p != null ? 'fair ' + esc(SB.fmtOdds(P.p)) : 'not priced'}</small></div></div>
   ${can ? `<div class="pm-btns"><button class="btn" data-pm-build="${esc(P.id)}">Open in builder</button>${document.querySelector('#tabs [data-t="sim"]') ? `<button class="btn ghost" data-pm-sim="${esc(P.id)}">Simulate 100k</button>` : ''}</div>` : ''}
   <div class="note">Polymarket prices each game on its own; the market's parlay chance is the product of each leg's market % (the midpoint between its buy and sell price).${pa ? ` Buying the legs at the prices shown costs more: ×${(1 / pa).toFixed(2)} payout, so it has to hit ${pctS(pa, 1)} of the time to break even.` : ''} Use it as a sharp reference for a sportsbook parlay, or buy the legs one by one.</div></div>`;
}
function valueList(rows) {
  const V = rows.filter(isValue).sort((a, b) => b.ev - a.ev).slice(0, 15);
  if (!V.length) return `<div class="pc"><div class="why">No Polymarket price in this window beats our model by ${Math.round(MIN_EV * 100)}% or more (with the model close enough to the market to trust) right now.</div></div>`;
  return `<div class="pc pm-list">${V.map(r => { const inS = r.key && SB.inSlip(r.g.id, r.key);
    return `<button class="pm-row${inS ? ' on' : ''}" data-pm-leg="${esc(r.g.id + '|' + r.key)}" aria-pressed="${!!inS}"><span><b>${esc(r.label)}</b><small>${esc(r.type)} · ${esc(r.pg.away.name)} @ ${esc(r.pg.home.name)} · ${esc(fmtTime(r.pg.start))}${r.v ? ` · $${Math.round(r.v).toLocaleString()} traded` : ''}</small></span>
      <span class="pm-nums"><span>${cents(r.q.a)}<small>buy</small></span><span>${pctS(r.p, 0)}<small>model</small></span><span class="pm-pos">${signPct(r.ev)}<small>EV</small></span></span></button>`; }).join('')}</div>`;
}
function gameCard(pg) {
  const m = matchOf(pg), g = m && m.g, R = rowsFor(pg);
  const main = (type, pred) => { const xs = R.filter(r => r.type === type && pred(r)); return xs; };
  const ml = R.filter(r => r.type === 'Moneyline');
  const sp = pg.spreads[0], to = pg.totals[0];
  const spRows = sp ? R.filter(r => r.type === 'Spread' && (r.q === sp.home || r.q === sp.away)) : [];
  const toRows = to ? R.filter(r => r.type === 'Total' && (r.q === to.over || r.q === to.under)) : [];
  const props = R.filter(r => r.type === 'Prop' && r.p != null).sort((a, b) => (b.v || 0) - (a.v || 0)).slice(0, 4);
  const cell = r => { const inS = r.key && g && SB.inSlip(g.id, r.key);
    return `<button class="pm-cell${inS ? ' on' : ''}" ${r.key && g ? `data-pm-leg="${esc(g.id + '|' + r.key)}" aria-pressed="${!!inS}"` : 'disabled'}><span class="pm-cl">${esc(r.label)}</span><span class="pm-cp mono">${cents(r.q.a)}</span><span class="pm-cm">${r.p != null ? 'model ' + pctS(r.p, 0) : 'market ' + cents(r.q.m)}${isValue(r) ? ' <b class="pm-pos">value</b>' : ''}</span></button>`; };
  return `<div class="pc pm-game"><div class="mkhead"><span class="lg">${esc(pg.comp)}${g ? '' : ' <span class="badge b-est">MARKET ONLY</span>'}</span><span>${esc(fmtTime(pg.start))}</span></div>
    <div class="pm-title"><b>${esc(pg.away.name)} @ ${esc(pg.home.name)}</b><small>$${Math.round(pg.volume || 0).toLocaleString()} traded</small></div>
    <div class="pm-grid c${ml.length}">${ml.map(cell).join('')}</div>
    ${spRows.length ? `<div class="pm-sub">Spread</div><div class="pm-grid c2">${spRows.map(cell).join('')}</div>` : ''}
    ${toRows.length ? `<div class="pm-sub">Total</div><div class="pm-grid c2">${toRows.map(cell).join('')}</div>` : ''}
    ${props.length ? `<div class="pm-sub">Player props</div><div class="pm-grid c1">${props.map(cell).join('')}</div>` : ''}
    <div class="pm-btns">${g && document.querySelector('#tabs [data-t="sim"]') ? `<button class="btn ghost" data-pm-gsim="${esc(g.id)}">Simulate 100k</button>` : ''}<a class="btn ghost" href="${esc(pg.url)}" target="_blank" rel="noopener">Open on Polymarket</a></div></div>`;
}
function render(main) {
  load();
  const sp = store.get('pm.sp', 'all'), win = store.get('pm.win', '24h');
  const chips = (list, cur, attr) => list.map(([k, l]) => `<button class="chip ${cur === k ? 'on' : ''}" data-${attr}="${k}" aria-pressed="${cur === k}">${esc(l)}</button>`).join('');
  let h = `<h2>Polymarket <small>prediction-market prices vs our model</small></h2>
    <div class="note pm-lead">Polymarket prices are what traders pay for a $1 share, so 63¢ means the market gives it 63%. We put our model's chance next to every price, find where buying is +EV, build parlays from the market, and simulate the night 100,000 times.</div>
    <div class="spnav">${chips(SPORTS, sp, 'pm-sp')}</div><div class="spnav pm-win">${chips(WINS.map(w => [w[0], w[1]]), win, 'pm-win')}</div>`;
  if (LOAD !== 'done') { main.innerHTML = h + '<div class="pc"><div class="why">Loading Polymarket prices…</div></div>'; return; }
  if (!PM) { main.innerHTML = h + '<div class="pc"><div class="why">The Polymarket snapshot did not load. Try again after the next refresh.</div></div>'; return; }
  const G = games(sp, win);
  h += `<div class="note">Snapshot from Polymarket's public API at <b>${esc(fmtTime(PM.updated))}</b> · ${G.length} game${G.length === 1 ? '' : 's'} in view · prices move fast, check the live price before you buy. Before Polymarket fees. Check that Polymarket is legal where you live.</div>`;
  if (!G.length) { main.innerHTML = h + '<div class="pc"><div class="why">No Polymarket games in this window. Try another sport or a longer window.</div></div>'; return; }
  const rows = G.flatMap(rowsFor);
  // parlays
  const fav = pickByGame(rows, 3, r => r.type === 'Moneyline' && r.label !== 'Draw' && live(r.q) && r.q.m >= 0.65 && r.q.m <= 0.9, (a, b) => b.q.m - a.q.m);
  const val = pickByGame(rows, 3, r => isValue(r) && r.type !== 'Prop', (a, b) => b.ev - a.ev);
  const flip = pickByGame(rows, 2, r => isValue(r) && r.q.m >= 0.4 && r.q.m <= 0.6, (a, b) => b.ev - a.ev);
  const dis = pickByGame(rows, 3, r => r.p != null && live(r.q) && r.type === 'Moneyline', (a, b) => Math.abs(b.p - b.q.m) - Math.abs(a.p - a.q.m));
  const P = [parlayOf('pm-fav', 'Market favorites treble', fav, 'The three biggest Polymarket favorites (65-90¢) from different games.'),
    parlayOf('pm-val', 'Value treble', val, 'The three best-value game lines vs our model, one per game.'),
    parlayOf('pm-flip', 'Coin-flip value double', flip, 'Two near 50/50 prices where our model leans your way.'),
    parlayOf('pm-dis', 'Model vs market', dis, 'Where our model and the market disagree most on the winner. Read it as a warning as much as a pick.')].filter(Boolean);
  h += `<h2>Best value on Polymarket <small>buy price vs our model · tap to add</small></h2><div class="note">Value means our model rates it higher than the price. A busy market is often right, so treat these as leads to check, not sure things.</div>` + valueList(rows);
  h += `<h2>Polymarket parlays <small>legs from different games</small></h2>` + (P.length ? `<div class="grid">${P.map(parlayCard).join('')}</div>` : '<div class="pc"><div class="why">Not enough games in this window for a parlay.</div></div>');
  // slate simulator
  const picks = pickByGame(rows, 8, isValue, (a, b) => b.ev - a.ev);
  const stake = Math.max(1, +store.get('pm.stake', 10) || 10);
  h += `<h2>Slate simulator <small>${picks.length} value pick${picks.length === 1 ? '' : 's'} · 100,000 nights</small></h2><div class="pc pm-sim">
    ${picks.length ? `<div class="why">Buy each value pick above (one per game, best first) for <label class="pm-stake">$<input id="pmStake" type="number" min="1" step="1" inputmode="decimal" value="${stake}" aria-label="Stake per pick"></label> at the ask, then play the night 100,000 times.</div>
    <div class="pm-btns"><button class="btn" data-pm-run>Run 100,000 nights</button></div>
    ${simOut && simOut.n === picks.length ? `<div class="kpis">${[[money(simOut.model.mean), 'Average result'], [pctS(simOut.model.up, 0), 'Nights in profit'], [money(simOut.model.p5), 'Bad night (5%)'], [money(simOut.model.p95), 'Good night (95%)']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${l}</span></div>`).join('')}</div>
      ${histo(simOut)}
      <div class="note">Risking ${money(simOut.risk)} a night. With our model's chances the average night is ${money(simOut.model.mean)}; if the market's prices are right instead, it's ${money(simOut.market.mean)} (${pctS(simOut.market.up, 0)} of nights in profit). Games are treated as independent; real fills can be worse than the quoted ask.</div>` : ''}` : '<div class="why">No value picks in this window to simulate.</div>'}</div>`;
  h += `<h2>Games <small>Polymarket buy price · our model</small></h2><div class="grid">${G.slice(0, 40).map(gameCard).join('')}</div>`;
  if (G.length > 40) h += `<div class="note">Showing the first 40 of ${G.length} games. Pick a sport to narrow it down.</div>`;
  h += `<div class="note pm-foot">Prices from Polymarket (polymarket.com), a prediction market. Model chances are estimates, not guarantees. Bet responsibly. 21+.</div>`;
  main.innerHTML = h;
}

// ---------------- events ----------------
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-pm-sp],[data-pm-win],[data-pm-leg],[data-pm-build],[data-pm-sim],[data-pm-gsim],[data-pm-run]');
  if (!t || !t.closest('#main')) return;
  const d = t.dataset;
  if (d.pmSp) { store.set('pm.sp', d.pmSp); simOut = null; SB.render(); return; }
  if (d.pmWin) { store.set('pm.win', d.pmWin); simOut = null; SB.render(); return; }
  if (d.pmLeg) { const i = d.pmLeg.indexOf('|'); const added = SB.toggleLeg(d.pmLeg.slice(0, i), d.pmLeg.slice(i + 1)); t.classList.toggle('on', !!added); t.setAttribute('aria-pressed', String(!!added)); return; }
  if (d.pmGsim) { SB.goTab('sim', { gid: d.pmGsim }); return; }
  if (d.pmRun != null) {
    const sp = store.get('pm.sp', 'all'), win = store.get('pm.win', '24h'), rows = games(sp, win).flatMap(rowsFor);
    const picks = pickByGame(rows, 8, isValue, (a, b) => b.ev - a.ev);
    const inp = document.getElementById('pmStake'), stake = Math.max(1, +(inp && inp.value) || 10); store.set('pm.stake', stake);
    t.disabled = true; t.textContent = 'Running…';
    setTimeout(() => { simOut = picks.length ? simulate(picks, stake) : null; SB.render(); }, 30);
    return;
  }
  const P = CACHE[d.pmBuild || d.pmSim]; if (!P) return;
  const legs = P.legs.filter(r => r.key).map(r => ({ gid: r.g.id, key: r.key })); if (!legs.length) return;
  if (d.pmBuild != null) { (SB.replaceSlip || SB.setSlip)(legs, legs[0].gid + '|' + legs[0].key); SB.openSlip(); return; }
  SB.goTab('sim', { legs, title: P.title, from: 'polymarket', p: P.p });
});

// ---------------- styles (tokens only) ----------------
const css = document.createElement('style');
css.textContent = `
.pm-lead{margin:-4px 2px 12px}
.pm-win{margin:-4px 0 12px}
.pm-tag{background:var(--violetbg);color:var(--cyan)}
.pm-why{display:block;font-style:normal;font-size:12.5px;color:var(--dim);margin-top:2px}
.pm-card .legp{display:grid;justify-items:end;align-content:start;text-align:right;flex:none}.pm-card .legp small{display:block}
.pm-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.pm-two div{background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:10px 12px;display:grid;gap:2px}
.pm-two span{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}.pm-two b{font-size:20px}.pm-two small{font-size:12.5px;color:var(--mute)}
.pm-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pm-btns .btn{flex:1 1 140px;min-height:44px;padding:11px 10px;font-size:13.5px;text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.pm-list{display:grid;gap:6px}
.pm-row{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;min-height:56px;text-align:left;background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:8px 12px;color:var(--text);cursor:pointer;font:inherit}
.pm-row.on,.pm-cell.on{border-color:var(--glow);box-shadow:0 0 0 1px var(--glow) inset}
.pm-row small{display:block;color:var(--dim);font-size:12px;margin-top:2px}
.pm-nums{display:flex;gap:12px;flex:none;text-align:right;font-family:var(--f);font-style:italic;font-weight:700;font-variant-numeric:tabular-nums}
.pm-nums small{display:block;font-size:10.5px;font-style:normal;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.pm-pos{color:var(--yes)}
.pm-title{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:6px 0 10px}.pm-title b{font-size:16px}.pm-title small{color:var(--dim);font-size:12px;white-space:nowrap}
.pm-sub{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:10px 0 6px}
.pm-grid{display:grid;gap:6px}.pm-grid.c1{grid-template-columns:1fr}.pm-grid.c1 .pm-cl{white-space:normal}.pm-grid.c2{grid-template-columns:1fr 1fr}.pm-grid.c3{grid-template-columns:1fr 1fr 1fr}
.pm-cell{display:grid;gap:2px;text-align:left;min-height:56px;background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:8px 10px;color:var(--text);cursor:pointer;font:inherit;min-width:0}
.pm-cell:disabled{cursor:default;opacity:.85}
.pm-cl{font-size:13px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-cp{font-size:18px}.pm-cm{font-size:12px;color:var(--dim)}
.pm-sim .kpis{margin-top:12px}
.pm-stake input{width:70px;min-height:36px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:inherit;padding:4px 8px;margin-left:2px}
.pm-hist{width:100%;height:auto;margin-top:12px;display:block}
.pm-foot{margin-top:16px}
@media(max-width:420px){.pm-grid.c3{grid-template-columns:1fr 1fr}.pm-nums{gap:8px}}
`;
document.head.appendChild(css);

const TAB = { key: 'polymarket', label: '🟣 Polymarket', after: 'lottos', render };
SB.registerTab(TAB);
SB.on('data', () => { MATCH = new Map(); load(); setTimeout(() => { if (!document.querySelector('#tabs [data-t="polymarket"]')) SB.registerTab(TAB); }, 0); });
window.__polymarket = { get PM() { return PM; }, get LOAD() { return LOAD; }, matchOf, rowsFor, games, simulate, pickByGame, isValue, MIN_EV };
})();
