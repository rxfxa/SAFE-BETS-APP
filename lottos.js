/* lottos.js — "🎟️ Point Lottos" and "🚑 Injuries" tabs for Safe Bets (window.SB v2 module, loaded after sim.js).

   DATA
   - injuries.json  {updated, note, injuries:[{sport, team, teamName, player, pos, status, injury, detail, returnEst, updated,
                     source, sourceUrl}], unchecked:["nba:NYK",...], partial:[...], notes:{nfl:"..."}}
                     status: out | doubtful | questionable | day-to-day | probable. "unchecked" teams had no report collected,
                     so the UI says "not checked" for them instead of "no injuries".
   - nbaroles.json  {updated, season, teams:{ABBR:[{name, pos, gp, mpg, ppg, rpg, apg, starter}]}}  (top-minutes rotation)
   Both are optional: if one fails to load, the tabs show an honest empty state.

   NBA USAGE-REDISTRIBUTION BOOST (per team, recomputed on every load)
     weight w(status) = out 1 · doubtful .75 · questionable .4 · day-to-day .25 · probable 0
     absent points A  = Σ over injured rotation players of  ppg × w × min(1, gp / G)
                        G = the most games any rotation player has played. The gp/G factor stops double counting: a player who
                        has missed most of the season is already missing from his teammates' averages.
     eligible         = rotation players NOT on the injury list (or probable) with gp ≥ 3 and mpg ≥ 14
     raw boost_i      = R × A × (ppg_i × mpg_i) / Σ_eligible (ppg × mpg)          R = .65 (the rest is lost to pace,
                                                                                    efficiency and the opponent)
     boost_i          = min(raw boost_i, 40% of ppg_i, 9 points)
     projected mean   = ppg_i + boost_i
   LEG PROBABILITY (same points model as the app's player props): sd = .28 × mean + 3, P(≥ T) = 1 − Φ((T − .5 − mean) / sd)
   LOTTO LINES: T = ceil5(ppg) + 5, +10, … kept while 12% ≤ P ≤ 45%.
   PARLAYS: legs from different games (so different teams), never the same player twice, at most one "star" (a team's two
   leading scorers still playing) per parlay; boosted role players ("other players") are ranked first, then boosted stars. Hit chance = product of the legs
   (games treated as independent). Tiers: Small lotto 2 legs, Big lotto 3 legs, Moonshot 4 legs.
   LEG KEYS: "L:<TEAM>-<player-slug>:<threshold>" on the NBA game's gid, registered with SB.registerLegType('L', …).
*/
(function () {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('lottos.js: window.SB v2 API not found'); return; }
const { esc } = SB;

// ---------------- constants ----------------
const W = { out: 1, doubtful: 0.75, questionable: 0.4, 'day-to-day': 0.25, probable: 0 };
const R = 0.65, CAP_PCT = 0.40, CAP_PTS = 9, MIN_GP = 3, MIN_MPG = 14, LEG_MIN = 0.12, LEG_MAX = 0.45;
const TIERS = [
  { id: 'small', name: 'Small lotto', n: 2, target: 0.36, blurb: '2 legs' },
  { id: 'big', name: 'Big lotto', n: 3, target: 0.34, blurb: '3 legs' },
  { id: 'moon', name: 'Moonshot', n: 4, target: 0.33, blurb: '4 legs' },
];
const STATUS_ORDER = ['out', 'doubtful', 'questionable', 'day-to-day', 'probable'];
const STATUS_LABEL = { out: 'OUT', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE', 'day-to-day': 'DAY-TO-DAY', probable: 'PROBABLE' };
const SPORTS = [['all', 'All'], ['nba', 'NBA'], ['nfl', 'NFL'], ['nhl', 'NHL'], ['ncaaf', 'College FB'], ['soccer', 'Soccer']];

// ---------------- helpers ----------------
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const slugOf = s => norm(s).replace(/ /g, '-');
function Phi(z) { // standard normal CDF (Abramowitz-Stegun 26.2.17, |error| < 7.5e-8)
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
const legP = (mean, thr) => { const sd = 0.28 * mean + 3; return 1 - Phi((thr - 0.5 - mean) / sd); };
const pctS = (p, d) => SB.pct(p, d == null ? (p < 0.1 ? 1 : 0) : d);
const money = x => '$' + (x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(2));
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) {} } };
const hitClass = p => p >= .55 ? 'h-hi' : p >= .3 ? 'h-mid' : 'h-lo';
const shortWhen = g => { try { return esc(SB.when(g)); } catch (e) { return ''; } };
const activeTab = () => { const el = document.querySelector('#tabs [aria-current="page"]') || document.querySelector('#tabs .tab.on'); return el ? el.dataset.t : null; };

// ---------------- data ----------------
let INJ = null, ROLES = null, FB = null, LOAD = 'idle', loadedFor = null;
let MODELS = new Map();
async function getJSON(u) { try { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) return null; const j = await r.json(); return j && typeof j === 'object' ? j : null; } catch (e) { return null; } }
async function load(force) {
  const stamp = SB.DATA && SB.DATA.updated;
  if (!force && (LOAD === 'loading' || (LOAD === 'done' && loadedFor === stamp))) return;
  LOAD = 'loading';
  const [inj, roles, fb] = await Promise.all([getJSON('injuries.json'), getJSON('nbaroles.json'), getJSON('firstbasket.json')]);
  if (fb && Array.isArray(fb.picks)) FB = fb;
  if (inj && Array.isArray(inj.injuries)) INJ = inj; else if (!INJ) INJ = null;
  if (roles && roles.teams && typeof roles.teams === 'object') ROLES = roles; else if (!ROLES) ROLES = null;
  MODELS = new Map(); LOAD = 'done'; loadedFor = stamp;
  const t = activeTab(); if (t === 'lottos' || t === 'injuries') SB.render();
  try { SB.renderSlipBar(); } catch (e) {}
}
const unchecked = (sport, team) => !!(INJ && Array.isArray(INJ.unchecked) && INJ.unchecked.includes(sport + ':' + team));
const partial = (sport, team) => !!(INJ && Array.isArray(INJ.partial) && INJ.partial.includes(sport + ':' + team));
function injFor(sport, team) { return INJ ? INJ.injuries.filter(e => e && e.sport === sport && e.team === team && STATUS_ORDER.includes(e.status)) : []; }

// ---------------- the boost model ----------------
function rosterFor(abbr) {
  const r = ROLES && ROLES.teams && ROLES.teams[abbr];
  if (Array.isArray(r) && r.length) return r;
  // fallback: props.json points lines for this team (no minutes known: treat as a 30-minute starter)
  return ((SB.DATA && SB.DATA.players) || []).filter(p => p.stat === 'pts' && p.team === abbr && p.avg > 0)
    .map(p => ({ name: p.name, pos: '', gp: 10, mpg: 30, ppg: +p.avg, fallback: true }));
}
function teamModel(abbr) {
  if (MODELS.has(abbr)) return MODELS.get(abbr);
  const inj = new Map(injFor('nba', abbr).map(e => [norm(e.player), e]));
  const roster = rosterFor(abbr);
  const G = Math.max(1, ...roster.map(p => +p.gp || 0));
  const players = roster.map(p => {
    const e = inj.get(norm(p.name)) || null, w = e ? (W[e.status] ?? 0) : 0;
    return { team: abbr, name: p.name, slug: slugOf(p.name), pos: p.pos || '', gp: +p.gp || 0, mpg: +p.mpg || 0, ppg: +p.ppg || 0,
      inj: e, w, absent: 0, rawBoost: 0, boost: 0, mean: +p.ppg || 0, star: false, starter: p.starter !== false, fallback: !!p.fallback };
  });
  let absent = 0; const missing = [];
  for (const p of players) if (p.w > 0) { p.absent = p.ppg * p.w * Math.min(1, p.gp / G); absent += p.absent; if (p.absent > 0.05) missing.push(p); }
  const elig = players.filter(p => p.w === 0 && p.gp >= MIN_GP && p.mpg >= MIN_MPG);
  const tot = elig.reduce((s, p) => s + p.ppg * p.mpg, 0);
  for (const p of elig) {
    p.rawBoost = tot > 0 ? R * absent * (p.ppg * p.mpg) / tot : 0;
    p.boost = Math.min(p.rawBoost, CAP_PCT * p.ppg, CAP_PTS);
    p.mean = p.ppg + p.boost;
  }
  // stars = the two leading scorers still playing (the team's primary options); everyone else is an "other player"
  [...elig].sort((a, b) => b.ppg - a.ppg).slice(0, 2).forEach(p => { p.star = true; });
  missing.sort((a, b) => b.absent - a.absent);
  const m = { abbr, players, elig, absent, missing, G, checked: !unchecked('nba', abbr), partial: partial('nba', abbr) };
  MODELS.set(abbr, m); return m;
}
function findPlayer(abbr, slug) { const m = teamModel(abbr); return m.players.find(p => p.slug === slug) || null; }
function linesFor(p) {
  const base = Math.ceil(p.ppg / 5) * 5, out = [];
  for (let t = base + 5; t <= base + 40; t += 5) { const q = legP(p.mean, t); if (q < LEG_MIN) break; if (q <= LEG_MAX) out.push({ thr: t, p: q }); }
  return out;
}
const legKey = (p, thr) => `L:${p.team}-${p.slug}:${thr}`;
function parseKey(key) { const m = /^L:([A-Z0-9]+)-([a-z0-9-]+):(\d+)$/.exec(String(key || '')); return m ? { abbr: m[1], slug: m[2], thr: +m[3] } : null; }

SB.registerLegType('L', {
  label(key) {
    const k = parseKey(key); if (!k) return 'Player points';
    const p = ROLES || (SB.DATA && SB.DATA.players) ? findPlayer(k.abbr, k.slug) : null;
    return `${p ? p.name : k.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} ${k.thr}+ points`;
  },
  prob(g, key) {
    const k = parseKey(key); if (!k || !g || g.sport !== 'nba') return 0;
    if (g.home.abbr !== k.abbr && g.away.abbr !== k.abbr) return 0;
    const p = findPlayer(k.abbr, k.slug); if (!p || p.w > 0) return 0;
    return legP(p.mean, k.thr);
  },
});

// ---------------- lotto construction ----------------
function windowGames(win) {
  const now = Date.now(), H = win === '24h' ? 24 : 72;
  return ((SB.DATA && SB.DATA.games) || []).filter(g => g.sport === 'nba' && SB.openG(g) && !(SB.isVoid && SB.isVoid(g)) && SB.startMs(g) - now <= H * 3600e3)
    .sort((a, b) => SB.startMs(a) - SB.startMs(b));
}
function candidates(win) {
  const games = windowGames(win), C = [];
  for (const g of games) for (const side of ['home', 'away']) {
    const t = g[side], o = g[side === 'home' ? 'away' : 'home'], m = teamModel(t.abbr);
    for (const p of m.elig) { const lines = linesFor(p); if (lines.length) C.push({ g, p, opp: o, lines, m }); }
  }
  // "other players" first: boosted role players, then boosted stars, then unboosted role players, then the rest
  const tierOf = p => (p.boost >= 0.5 ? 0 : 2) + (p.star ? 1 : 0);
  C.sort((a, b) => (tierOf(a.p) - tierOf(b.p)) || (b.p.boost - a.p.boost) || (b.p.ppg - a.p.ppg));
  return { games, C };
}
const closest = (lines, target) => lines.reduce((b, l) => (Math.abs(l.p - target) < Math.abs(b.p - target) ? l : b), lines[0]);
function buildTier(C, tier, count = 3) {
  const used = new Set(), out = [];
  for (let k = 0; k < count; k++) {
    const legs = [], games = new Set(), teams = new Set(); let stars = 0;
    for (const c of C) {
      const id = c.p.team + ':' + c.p.slug;
      if (used.has(id) || games.has(c.g.id) || teams.has(c.p.team) || (c.p.star && stars >= 1)) continue;
      legs.push({ ...c, line: closest(c.lines, tier.target) });
      games.add(c.g.id); teams.add(c.p.team); if (c.p.star) stars++;
      if (legs.length === tier.n) break;
    }
    if (legs.length < tier.n) break;
    legs.forEach(l => used.add(l.p.team + ':' + l.p.slug));
    out.push({ id: `${tier.id}${k + 1}`, tier, legs, p: legs.reduce((s, l) => s * l.line.p, 1) });
  }
  return out;
}

// ---------------- first basket (tonight) ----------------
// P(team scores first) = 0.5 + 0.3 x (win chance - 0.5), kept within 35-65% (the tip and the first possessions are close to a
// coin flip). Within a team, the first basket goes to one of the five projected starters (still playing) in proportion to their
// injury-boosted scoring average, with centers x1.15 (tip-off sets and early touches near the rim). P(player) = P(team) x share.
const FB_C = 1.15;
const fbTeamFirst = (g, side) => { const pr = g.prob || {}, w = +(side === 'home' ? pr.home : pr.away); return Math.max(0.35, Math.min(0.65, 0.5 + 0.3 * ((isFinite(w) ? w : 0.5) - 0.5))); };
function fbStarters(m) {
  const a = m.players.filter(p => p.w === 0);
  let s = a.filter(p => p.starter).sort((x, y) => y.mpg - x.mpg).slice(0, 5);
  if (s.length < 5) s = s.concat(a.filter(p => !s.includes(p)).sort((x, y) => y.mpg - x.mpg).slice(0, 5 - s.length));
  return s;
}
function fbSide(g, side) {
  const t = g[side], m = teamModel(t.abbr), S = fbStarters(m), wt = p => Math.max(0.5, p.mean) * (/C/.test(p.pos) ? FB_C : 1);
  const tot = S.reduce((s, p) => s + wt(p), 0) || 1, pt = fbTeamFirst(g, side);
  return { team: t, opp: g[side === 'home' ? 'away' : 'home'], pTeam: pt, m, list: S.map(p => ({ p: pt * wt(p) / tot, player: p })).sort((a, b) => b.p - a.p) };
}
const FB_RE = /^FB:([A-Z0-9]+)-([a-z0-9-]+)$/;
const fbKey = p => `FB:${p.team}-${p.slug}`;
SB.registerLegType('FB', {
  label(key) { const k = FB_RE.exec(String(key)); if (!k) return 'First basket'; const p = ROLES || (SB.DATA && SB.DATA.players) ? findPlayer(k[1], k[2]) : null; return `${p ? p.name : k[2].replace(/-/g, ' ')} first basket`; },
  prob(g, key) { const k = FB_RE.exec(String(key)); if (!k || !g || g.sport !== 'nba') return 0; const side = g.home.abbr === k[1] ? 'home' : g.away.abbr === k[1] ? 'away' : null; if (!side) return 0;
    const r = fbSide(g, side).list.find(x => x.player.slug === k[2]); return r ? r.p : 0; },
});
function fbBoard() {
  const now = Date.now(), names = new Set(((FB && FB.picks) || []).map(norm));
  const games = ((SB.DATA && SB.DATA.games) || []).filter(g => g.sport === 'nba' && SB.openG(g) && !(SB.isVoid && SB.isVoid(g)) && SB.startMs(g) - now <= 24 * 3600e3).sort((a, b) => SB.startMs(a) - SB.startMs(b));
  const rows = [];
  for (const g of games) for (const side of ['away', 'home']) {
    const S = fbSide(g, side), named = S.m.players.filter(p => names.has(norm(p.name)));
    for (const pl of named.length ? named : [null]) {
      const hit = pl ? S.list.find(x => x.player === pl) : null;
      rows.push({ g, side, S, named: pl, pick: hit, rank: hit ? S.list.indexOf(hit) + 1 : null, top: S.list[0] });
    }
  }
  return { games, rows };
}
function fbParlays(pool, n, count, id) { // pool: [{g, player, p, opp, team}] sorted by p; legs from different games
  const out = [], used = new Set();
  for (let k = 0; k < count; k++) {
    const legs = [], gs = new Set();
    for (const c of pool) { const key = c.player.team + c.player.slug; if (used.has(key) || gs.has(c.g.id)) continue; legs.push(c); gs.add(c.g.id); if (legs.length === n) break; }
    if (legs.length < n) break; legs.forEach(c => used.add(c.player.team + c.player.slug));
    out.push({ id: `${id}${k + 1}`, legs, p: legs.reduce((s, c) => s * c.p, 1) });
  }
  return out;
}
function fbCard(P, title, tag) {
  CACHE[P.id] = { fb: true, legs: P.legs, p: P.p, title };
  return `<div class="pc lt-card"><div class="pchead"><span class="pctitle">${esc(title)} ${tag ? `<span class="badge lt-tag">${esc(tag)}</span>` : ''}</span><span class="hit ${hitClass(P.p)}">${pctS(P.p)} to hit</span></div>
    <div class="gauge" style="--p:${Math.max(0, Math.min(1, P.p)).toFixed(3)}" aria-hidden="true"><i></i></div>
    <div style="margin-top:4px">${P.legs.map((c, i) => `<div class="leg"><span class="legdot ${i === 0 ? 'base' : ''}">${i + 1}</span><div class="legtxt"><b>${esc(c.player.name)} first basket</b>
      <span>${esc(c.team.abbr)} vs ${esc(c.opp.abbr)} · ${shortWhen(c.g)}</span><em class="lt-why">${esc(c.team.abbr)} scores first ${pctS(c.pTeam, 0)} · ${esc(c.why || '')}</em></div>
      <span class="legp mono">${pctS(c.p, 1)}<small>${esc(SB.fmtOdds(c.p))}</small></span></div>`).join('')}</div>
    <div class="pcfoot"><div class="odds mono">${esc(SB.fmtOdds(P.p))}<small>Fair odds · $10 pays ${money(10 / P.p)}</small></div></div>
    <div class="lt-btns"><button class="btn" data-lt-build="${esc(P.id)}">Open in builder</button>${hasSim() ? `<button class="btn ghost" data-lt-sim="${esc(P.id)}">Simulate 100k</button>` : ''}</div>
    <div class="note">Bet only at <b class="mono">${esc(SB.fmtOdds(P.p))}</b> or better. First-basket bets settle on the first made field goal; most books void them if the player doesn't start.</div></div>`;
}
function firstBasketSection() {
  if (!FB || !ROLES) return '';
  const { games, rows } = fbBoard(); if (!games.length) return '';
  const picks = rows.filter(r => r.pick).map(r => ({ g: r.g, player: r.pick.player, p: r.pick.p, team: r.S.team, opp: r.S.opp, pTeam: r.S.pTeam,
    why: r.rank === 1 ? 'our top pick on his team too' : `#${r.rank} of the starting five in our model` })).sort((a, b) => b.p - a.p);
  const seenT = new Set(), model = rows.filter(r => r.top && !seenT.has(r.S.team.abbr) && seenT.add(r.S.team.abbr)).map(r => ({ g: r.g, player: r.top.player, p: r.top.p, team: r.S.team, opp: r.S.opp, pTeam: r.S.pTeam, why: 'model\'s top pick on this team' })).sort((a, b) => b.p - a.p);
  const missing = rows.filter(r => r.named && !r.pick);
  const agree = rows.filter(r => r.rank === 1).length, nP = rows.filter(r => r.pick).length;
  let h = `<h2>First basket tonight <small>${games.length} NBA games · from ${esc(FB.source)}'s video</small></h2>
    <div class="note">Pete named ${(FB.picks || []).length} first-basket picks for tonight (one or two per team). Our model prices each one: his team scores first about half the time, then his share of the starting five's scoring. It agrees with ${agree} of his ${nP} picks as the top choice on that team. ${esc(FB.note || '')}</div>`;
  const P2 = fbParlays(picks, 2, 2, 'fbp2_'), P3 = fbParlays(picks, 3, 1, 'fbp3_'), M2 = fbParlays(model, 2, 1, 'fbm2_');
  h += `<div class="grid">${P2.map((P, i) => fbCard(P, `Pete's first-basket double #${i + 1}`, 'FIRST BASKET')).join('')}${P3.map(P => fbCard(P, 'Pete\'s first-basket treble', 'FIRST BASKET')).join('')}${M2.map(P => fbCard(P, 'Model\'s first-basket double', 'MODEL')).join('')}</div>`;
  h += `<h2>Pete's picks vs our model <small>tap to add a pick to your slip</small></h2><div class="pc"><div class="lt-fbt">${picks.map(c => {
    const r = rows.find(x => x.pick && x.pick.player === c.player), key = fbKey(c.player), inS = SB.inSlip(c.g.id, key), alt = r && r.rank !== 1 ? r.top.player.name : null;
    return `<button class="lt-fbr${inS ? ' on' : ''}" data-lt-leg="${esc(c.g.id + '|' + key)}" aria-pressed="${inS}"><span><b>${esc(c.player.name)}</b><small>${esc(c.team.abbr)} vs ${esc(c.opp.abbr)} · ${shortWhen(c.g)}${alt ? ` · model prefers ${esc(alt)}` : ' · model agrees'}</small></span><span class="mono">${pctS(c.p, 1)}<small>${esc(SB.fmtOdds(c.p))}</small></span></button>`; }).join('')}</div>
    ${missing.length ? `<div class="note">Not priced: ${esc(missing.map(r => `${r.named.name} (${r.named.inj ? 'listed ' + r.named.inj.status : 'not in our projected starting five'})`).join(', '))}.</div>` : ''}
    <div class="note">Source: <a href="${esc(FB.url)}" target="_blank" rel="noopener">${esc(FB.source)}, ${esc(FB.date)}</a>. First basket is a long shot: even the best pick in a game hits about 1 time in 5.</div></div>`;
  return h;
}

// ---------------- markup ----------------
const CACHE = {};
function because(m, p) {
  if (!m.missing.length || p.boost < 0.05) return p.star ? 'Lead scorer, no boost' : 'No boost: normal role';
  const names = m.missing.slice(0, 2).map(x => `${x.name.split(' ').slice(-1)[0]} (${(x.inj && x.inj.status) || 'out'})`);
  return `With ${names.join(', ')}${m.missing.length > 2 ? ` +${m.missing.length - 2}` : ''} missing`;
}
function legRow(L, i) {
  const { g, p, opp, line, m } = L;
  const boost = p.boost >= 0.05 ? `<span class="badge lt-boost">+${f1(p.boost)} PTS</span>` : '';
  return `<div class="leg"><span class="legdot ${i === 0 ? 'base' : ''}">${i + 1}</span><div class="legtxt"><b>${esc(p.name)} ${line.thr}+ points ${boost}</b>
    <span>${esc(p.team)} vs ${esc(opp.abbr)} · ${shortWhen(g)}</span>
    <em class="lt-why">Proj ${f1(p.ppg)} → <span class="mono lt-hot">${f1(p.mean)}</span> pts · ${esc(because(m, p))}</em></div>
    <span class="legp mono">${pctS(line.p, 0)}<small>${esc(SB.fmtOdds(line.p))}</small></span></div>`;
}
function hasSim() { return !!document.querySelector('#tabs [data-t="sim"]'); }
function lottoCard(P) {
  CACHE[P.id] = P;
  const edgePx = SB.fmtPrice(1.05 / P.p);
  return `<div class="pc lt-card" data-lt-card="${esc(P.id)}">
    <div class="pchead"><span class="pctitle">${esc(P.tier.name)} #${esc(P.id.slice(-1))} <span class="badge lt-tag">LOTTO</span></span><span class="hit ${hitClass(P.p)}">${pctS(P.p)} to hit</span></div>
    <div class="gauge" style="--p:${Math.max(0, Math.min(1, P.p)).toFixed(3)}" aria-hidden="true"><i></i></div>
    <div style="margin-top:4px">${P.legs.map(legRow).join('')}</div>
    <div class="pcfoot"><div class="odds mono">${esc(SB.fmtOdds(P.p))}<small>Fair odds · $10 pays ${money(10 / P.p)}</small></div></div>
    <div class="lt-btns"><button class="btn" data-lt-build="${esc(P.id)}">Open in builder</button>${hasSim() ? `<button class="btn ghost" data-lt-sim="${esc(P.id)}">Simulate 100k</button>` : ''}</div>
    <div class="note">Bet only at <b class="mono">${esc(SB.fmtOdds(P.p))}</b> or better (${esc(edgePx)} = a 5% edge). A lotto is a long shot: most tickets lose, so stake small.</div></div>`;
}
const emptyCard = (title, msg) => `<div class="pc"><div class="pchead"><span class="pctitle">${esc(title)}</span></div><div class="why">${msg}</div></div>`;
const statusBadge = s => `<span class="badge lt-st lt-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

function boostedBoard(C) {
  const seen = new Set(), rows = [];
  for (const c of C) { if (c.p.boost < 0.5) continue; const id = c.p.team + ':' + c.p.slug; if (seen.has(id)) continue; seen.add(id); rows.push(c); }
  if (!rows.length) return '<div class="note">No boosted players in this window: nobody in these games is listed out with minutes to share.</div>';
  return `<div class="grid">${rows.map(c => {
    const { g, p, opp, m } = c;
    const chips = c.lines.slice(0, 3).map(l => { const key = legKey(p, l.thr), inS = SB.inSlip(g.id, key);
      return `<button class="chip lt-line${inS ? ' on' : ''}" data-lt-leg="${esc(g.id + '|' + key)}" aria-pressed="${inS}">${l.thr}+ <b class="mono">${pctS(l.p, 0)}</b></button>`; }).join('');
    return `<div class="pc lt-player"><div class="pchead"><span class="pctitle">${esc(p.name)} <span class="badge lt-boost">+${f1(p.boost)} PTS</span></span><span class="lt-team">${SB.abBox({ abbr: p.team, name: p.team })}</span></div>
      <div class="why" style="margin-top:4px">${esc(p.team)} vs ${esc(opp.abbr)} · ${shortWhen(g)} · ${esc(because(m, p))}</div>
      <div class="lt-proj"><span>Normal <b class="mono">${f1(p.ppg)}</b></span><span>Boosted <b class="mono lt-hot">${f1(p.mean)}</b></span><span>${f1(p.mpg)} min</span></div>
      <div class="lt-lines">${chips}</div></div>`;
  }).join('')}</div>`;
}

// ---------------- Point Lottos tab ----------------
function renderLottos(main) {
  load();
  const win = store.get('lt.win', '24h') === '3d' ? '3d' : '24h';
  const head = `<div class="lt-intro"><h2>Point Lottos <small>NBA · long shots · separate from every other parlay</small></h2>
    <div class="note">When a player is out, about two thirds of his scoring moves to the teammates still playing. Those boosted players get points lines above their normal and go into long-shot parlays. Every chance here is a model estimate.</div>
    <div class="spnav lt-win" role="tablist" aria-label="Time window">${[['24h', 'Next 24 hours'], ['3d', 'Next 3 days']].map(([k, l]) => `<button class="chip ${win === k ? 'on' : ''}" data-lt-win="${k}" role="tab" aria-selected="${win === k}">${l}</button>`).join('')}</div></div>`;
  if (LOAD !== 'done') { main.innerHTML = head + emptyCard('Loading injury reports…', 'Pulling the latest injury list and player averages.'); return; }
  if (!ROLES && !((SB.DATA && SB.DATA.players) || []).length) { main.innerHTML = head + emptyCard('Player data is missing', 'The player averages file did not load, so lotto lines can\'t be priced right now. Try again after the next refresh.'); return; }
  const { games, C } = candidates(win);
  if (!games.length) { main.innerHTML = head + emptyCard('No NBA games in this window', win === '24h' ? 'Try Next 3 days.' : 'New games appear with the hourly refresh.') + footer(); return; }
  let html = head + firstBasketSection();
  if (!INJ) html += `<div class="note lt-warn">The injury list did not load, so nobody is boosted right now. Lines below use normal averages.</div>`;
  const notChecked = [...new Set(games.flatMap(g => [g.home.abbr, g.away.abbr]).filter(a => unchecked('nba', a)))];
  if (notChecked.length) html += `<div class="note lt-warn">Injury reports not checked yet for ${esc(notChecked.join(', '))}: their players get no boost.</div>`;
  for (const T of TIERS) {
    const P = buildTier(C, T);
    html += `<h2>${esc(T.name)} <small>${esc(T.blurb)} · different games</small></h2>`;
    html += P.length ? `<div class="grid">${P.map(lottoCard).join('')}</div>` : emptyCard(`Not enough games for a ${T.name.toLowerCase()}`, `This needs ${T.n} different games in the window. Try Next 3 days.`);
  }
  html += `<h2>Boosted players <small>tap a line to add it to your slip</small></h2>` + boostedBoard(C);
  main.innerHTML = html + footer();
}
const footer = () => `<div class="note lt-foot">Points use the app's player model: average plus an injury boost, spread ±(28% of the average + 3). Legs come from different games and are treated as independent. ${INJ ? `Injury list updated ${esc(fmtDate(INJ.updated))}.` : ''} Hit chances are model estimates, not guarantees. Bet responsibly. 21+.</div>`;
function fmtDate(s) { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

// ---------------- Injuries tab ----------------
function renderInjuries(main) {
  load();
  const sp = store.get('inj.sp', 'all');
  const now = Date.now();
  const games = ((SB.DATA && SB.DATA.games) || []).filter(g => SB.openG(g) && SB.startMs(g) - now <= 72 * 3600e3).sort((a, b) => SB.startMs(a) - SB.startMs(b));
  const count = s => games.filter(g => s === 'all' || g.sport === s).reduce((n, g) => n + injFor(g.sport, g.home.abbr).length + injFor(g.sport, g.away.abbr).length, 0);
  const head = `<h2>Injury report <small>teams playing in the next 3 days</small></h2>
    <div class="spnav lt-sports" role="tablist" aria-label="Sports">${SPORTS.map(([k, l]) => `<button class="chip ${sp === k ? 'on' : ''}" data-inj-sp="${k}" role="tab" aria-selected="${sp === k}">${esc(l)}${LOAD === 'done' && INJ ? `<span class="n">${count(k)}</span>` : ''}</button>`).join('')}</div>`;
  if (LOAD !== 'done') { main.innerHTML = head + emptyCard('Loading injury reports…', 'Pulling the latest list.'); return; }
  if (!INJ) { main.innerHTML = head + emptyCard('Injury list unavailable', 'The injury file did not load. Check team news before betting, and try again after the next refresh.'); return; }
  const G = games.filter(g => sp === 'all' || g.sport === sp);
  let html = head + `<div class="note">Statuses change fast, often right before tip-off or kickoff. Updated ${esc(fmtDate(INJ.updated))}.${(sp === 'all' || sp === 'nfl') && INJ.notes && INJ.notes.nfl ? ' NFL: ' + esc(INJ.notes.nfl) : ''}</div>`;
  if (!G.length) { main.innerHTML = html + emptyCard('No games in the next 3 days', 'Pick another sport.'); return; }
  html += '<div class="grid">';
  for (const g of G) {
    const team = (t, o) => {
      const L = injFor(g.sport, t.abbr).sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      const rows = L.map(e => `<li class="lt-inj"><div>${statusBadge(e.status)} <b>${esc(e.player)}</b>${e.pos ? ` <span class="lt-pos">${esc(e.pos)}</span>` : ''}</div>
        <div class="lt-injd">${esc(e.injury || '')}${e.detail ? ' · ' + esc(e.detail) : ''}${e.returnEst ? ' · ' + esc(e.returnEst) : ''}</div>
        <div class="lt-src">${esc(e.source || '')}${e.updated ? ' · ' + esc(e.updated) : ''}</div></li>`).join('');
      let gains = '';
      if (g.sport === 'nba') { const m = teamModel(t.abbr); const top = m.elig.filter(p => p.boost >= 0.5).sort((a, b) => b.boost - a.boost).slice(0, 3);
        if (top.length) gains = `<div class="lt-gains"><span>Who gains</span>${top.map(p => `<button class="lt-gain" data-lt-goto="1">${esc(p.name)} <b class="mono">+${f1(p.boost)}</b></button>`).join('')}</div>`; }
      const none = unchecked(g.sport, t.abbr) ? '<div class="note">Report not checked yet. Check team news.</div>'
        : `<div class="note">No notable injuries in the latest check${partial(g.sport, t.abbr) ? ' (partial check)' : ''}.</div>`;
      return `<div class="lt-teamblk"><div class="lt-th">${SB.abBox(t)}<b>${esc(t.name)}</b></div>${L.length ? `<ul class="lt-list">${rows}</ul>` : none}${gains}</div>`;
    };
    html += `<div class="pc lt-game"><div class="mkhead" data-open="${esc(g.id)}"><span class="lg">${esc(g.comp)} · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span><span>${shortWhen(g)}</span></div>${team(g.away, g.home)}${team(g.home, g.away)}</div>`;
  }
  html += '</div>';
  const shown = G.length, withNone = G.filter(g => !injFor(g.sport, g.home.abbr).length && !injFor(g.sport, g.away.abbr).length).length;
  html += `<div class="note lt-foot">${shown} games · ${withNone} with nothing listed. Sources are public injury reports and team news, compiled ${esc(fmtDate(INJ.updated))}. Bet responsibly. 21+.</div>`;
  main.innerHTML = html;
}

// ---------------- events ----------------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-lt-win],[data-lt-build],[data-lt-sim],[data-lt-leg],[data-inj-sp],[data-lt-goto]');
  if (!t || !t.closest('#main')) return;
  if (t.dataset.ltWin) { store.set('lt.win', t.dataset.ltWin); SB.render(); return; }
  if (t.dataset.injSp) { store.set('inj.sp', t.dataset.injSp); SB.render(); return; }
  if (t.dataset.ltGoto) { SB.goTab('lottos', {}); return; }
  if (t.dataset.ltLeg) { const i = t.dataset.ltLeg.indexOf('|'); const added = SB.toggleLeg(t.dataset.ltLeg.slice(0, i), t.dataset.ltLeg.slice(i + 1));
    t.classList.toggle('on', !!added); t.setAttribute('aria-pressed', String(!!added)); return; }
  const P = CACHE[t.dataset.ltBuild || t.dataset.ltSim]; if (!P) return;
  const legs = P.fb ? P.legs.map(c => ({ gid: c.g.id, key: fbKey(c.player) })) : P.legs.map(L => ({ gid: L.g.id, key: legKey(L.p, L.line.thr) }));
  if (t.dataset.ltBuild != null) { (SB.replaceSlip || SB.setSlip)(legs, legs[0].gid + '|' + legs[0].key); SB.openSlip(); return; }
  SB.goTab('sim', { legs, title: P.fb ? P.title : `${P.tier.name} #${P.id.slice(-1)}`, from: 'lottos', p: P.p });
});

// ---------------- styles (tokens only) ----------------
const css = document.createElement('style');
css.textContent = `
.lt-intro .note{margin:-4px 2px 10px}
.lt-win,.lt-sports{margin:6px 0 14px}
.lt-warn{border-left:3px solid var(--amber);padding-left:10px;margin:0 0 12px}
.lt-btns{display:flex;gap:8px;margin-top:10px}.lt-btns .btn{flex:1;padding:11px 8px;font-size:13px;letter-spacing:.02em}
.lt-tag{background:var(--violetbg);color:var(--cyan)}
.lt-boost{background:var(--bluebg);color:var(--blue);margin-left:4px;white-space:nowrap}
.lt-why{display:block;font-style:normal;font-size:12.5px;color:var(--dim);margin-top:2px}
.lt-why .lt-hot{color:var(--ice);font-size:13px}
.lt-card .legp{display:grid;justify-items:end;align-content:start;text-align:right;flex:none}.lt-card .legp small{display:block}
.lt-card .legtxt b .badge{vertical-align:2px}
.lt-card .hit{white-space:nowrap;flex:none}
.lt-player .lt-team .ab{transform:scale(.9)}
.lt-proj{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 2px;font-size:13px;color:var(--mute)}
.lt-proj b{font-size:16px;color:var(--text)}.lt-proj .lt-hot{color:var(--ice)}
.lt-lines{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.lt-line{min-height:44px;gap:6px}.lt-line b{font-size:14px}
.lt-game .mkhead{margin-bottom:6px}
.lt-teamblk{padding:10px 0;border-top:1px solid var(--line)}.lt-teamblk:first-of-type{border-top:0}
.lt-th{display:flex;align-items:center;gap:8px;font-size:15px;margin-bottom:6px}
.lt-list{list-style:none;display:grid;gap:8px}
.lt-inj{display:grid;gap:2px}.lt-inj b{font-size:14.5px}
.lt-pos{font-size:11.5px;color:var(--dim);letter-spacing:.06em}
.lt-injd{font-size:13px;color:var(--mute);line-height:1.4}
.lt-src{font-size:11.5px;color:var(--dim)}
.lt-st{min-width:0;display:inline-block}
.lt-out{background:var(--nobg);color:var(--no)}
.lt-doubtful{background:var(--amberbg);color:var(--amber)}
.lt-questionable{background:transparent;color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber)}
.lt-day-to-day{background:var(--bluebg);color:var(--blue)}
.lt-probable{background:var(--yesbg);color:var(--yes)}
.lt-gains{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.lt-gain{border:1px solid var(--edge);background:var(--card-hi);color:var(--text);border-radius:5px;padding:6px 10px;min-height:36px;font-size:13px;text-transform:none;letter-spacing:0;cursor:pointer}
.lt-gain b{color:var(--ice)}
.lt-foot{margin-top:16px}
.lt-fbt{display:grid;gap:6px}
.lt-fbr{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;min-height:52px;text-align:left;background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:8px 12px;color:var(--text);cursor:pointer;font:inherit}
.lt-fbr.on{border-color:var(--glow);box-shadow:0 0 0 1px var(--glow) inset}
.lt-fbr small{display:block;color:var(--dim);font-size:12px;margin-top:2px}
.lt-fbr>span:last-child{text-align:right;flex:none;font-size:15px}
`;
document.head.appendChild(css);

// ---------------- tabs ----------------
const TAB_L = { key: 'lottos', label: '🎟️ Point Lottos', after: 'soccerparlays', render: renderLottos };
const TAB_I = { key: 'injuries', label: '🚑 Injuries', after: 'ncaaf', render: renderInjuries };
SB.registerTab(TAB_L); SB.registerTab(TAB_I);
SB.on('data', () => { load(); setTimeout(() => { if (!document.querySelector('#tabs [data-t="lottos"]')) SB.registerTab(TAB_L); if (!document.querySelector('#tabs [data-t="injuries"]')) SB.registerTab(TAB_I); }, 0); });

// test/debug hook
window.__lottos = { fbSide, fbBoard, fbKey, get FB() { return FB; }, W, R, CAP_PCT, CAP_PTS, MIN_GP, MIN_MPG, LEG_MIN, LEG_MAX, TIERS, legP, teamModel, linesFor, candidates, buildTier, parseKey, legKey,
  get INJ() { return INJ; }, get ROLES() { return ROLES; }, get LOAD() { return LOAD; }, load };
})();
