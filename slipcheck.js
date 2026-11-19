/* slipcheck.js — "📸 Slip Check": read a bet slip screenshot from another sportsbook app, compare it with the Safe Bets
   model, analyze every leg, give a direct verdict with reasons, and track the same bet in My Parlays.

   READING: the artifact `sample` capability (manifest: capabilities {sample:{images:true}}). claude.use('sample') resolves
   the function or null; null, a declined consent (not_granted) or any failure falls back to typing the legs in by hand.
   Claude only READS the slip (sample.json with the image). Every number on this tab comes from the app's own model;
   "Claude's take" only words an opinion from the numbers this page passes it.

   PRICING ANY PRINTED LINE: a new leg type "SC:<type>:<side>:<line>" prices game lines the board may not list:
     SC:ml:H|A|D              winner (soccer = 90-minute result; NHL incl. OT/SO; NBA/NFL/NCAAF final margin)
     SC:sp:H|A:<line>         spread for that side (e.g. SC:sp:A:+5.5)
     SC:tot:O|U:<line>        game total
     SC:btts:Y|N, SC:cs:<h>-<a>, SC:dc:1X|X2|12   soccer
   Margin sports read the 100,000 seeded simulations (SB.simGame); soccer/NHL sum the exact score grid (SB.outcomes).
   A push (whole-number line landing exactly) is excluded: chance = P(win) / (1 - P(push)).
   Player lines map to "P:<id>:<n>" / "U:<id>:<line>" (props.json) or "L:<team>-<slug>:<n>" (lottos.js, NBA points).
   Legs we can't price are kept as "X:<text>" (graded by hand in My Parlays).
*/
(function () {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('slipcheck.js: window.SB v2 API not found'); return; }
const { esc } = SB;
const MARGIN = new Set(['nba', 'nfl', 'ncaaf']), GOALS = new Set(['soccer', 'nhl']);
const MARKETS = [['moneyline', 'Winner / moneyline'], ['spread', 'Spread'], ['total', 'Total (over/under)'], ['player_points', 'Player points'],
  ['player_rebounds', 'Player rebounds'], ['player_assists', 'Player assists'], ['btts', 'Both teams to score'], ['correct_score', 'Correct score'],
  ['double_chance', 'Double chance'], ['draw', 'Draw'], ['player_other', 'Other player prop'], ['other', 'Other']];
const MARKET_IDS = MARKETS.map(m => m[0]);
const STAT = { player_points: 'pts', player_rebounds: 'reb', player_assists: 'ast' };
const GENERIC = new Set(['city', 'united', 'state', 'club', 'real', 'sporting', 'athletic', 'saint', 'team', 'the', 'fc', 'sc', 'cf', 'ac', 'de', 'la']);

// ---------------- small helpers ----------------
const N = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
const nameKey = s => N(s).replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const str = (v, n = 120) => (v == null ? '' : String(v)).slice(0, n).trim();
const num = v => { if (v == null || v === '') return null; const x = parseFloat(String(v).replace(/[^0-9.+-]/g, '')); return isFinite(x) ? x : null; };
const pctS = (p, d) => SB.pct(p, d == null ? (p < 0.1 ? 1 : 0) : d);
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const signPct = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%';
const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) {} } };
const activeTab = () => { const el = document.querySelector('#tabs [aria-current="page"]') || document.querySelector('#tabs .tab.on'); return el ? el.dataset.t : null; };
const rerender = () => { if (activeTab() === 'slipcheck') SB.render(); };
function bookDec(s) { // odds exactly as printed on the slip -> decimal price, or null
  s = str(s, 24); if (!s) return null;
  if (/^(evens?|ev|even money)$/i.test(s)) return 2;
  const ct = /^(\d+(?:\.\d+)?)\s*¢$/.exec(s); if (ct) { const x = parseFloat(ct[1]); return x > 0 && x < 100 ? 100 / x : null; } // Polymarket share price in cents
  if (/^0?\.\d+$/.test(s)) { const x = parseFloat(s); return x > 0 && x < 1 ? 1 / x : null; } // share price as a fraction of $1
  const fmt = /^[+−-]\s*\d/.test(s) ? 'american' : /\d\s*\/\s*\d/.test(s) ? 'fractional' : (/^\d+[.,]\d+$/.test(s) && parseFloat(s.replace(',', '.')) < 30) ? 'decimal' : 'american';
  try { const d = SB.parseOdds(s.replace('−', '-'), fmt); return d && d > 1 ? d : null; } catch (e) { return null; }
}

// ---------------- leg types: SC (game lines at any printed number) and X (kept as text) ----------------
function scParse(key) { const p = String(key).split(':'); return { t: p[1], a: p[2], L: p.length > 3 ? parseFloat(p[3]) : NaN }; }
function scCore(key) { // (m = home margin, s = total, h, a) -> 1 | 0 | null (push)
  const { t, a, L } = scParse(key);
  switch (t) {
    case 'ml': return m => (a === 'H' ? +(m > 0) : a === 'A' ? +(m < 0) : +(m === 0));
    case 'sp': return m => { const v = (a === 'H' ? m : -m) + L; return v > 1e-9 ? 1 : v < -1e-9 ? 0 : null; };
    case 'tot': return (m, s) => { const v = s - L; return Math.abs(v) < 1e-9 ? null : (a === 'O' ? +(v > 0) : +(v < 0)); };
    case 'btts': return (m, s, h, x) => +((h > 0 && x > 0) === (a === 'Y'));
    case 'cs': { const [ch, ca] = String(a).split('-').map(Number); return (m, s, h, x) => +(h === ch && x === ca); }
    case 'dc': return m => (a === '1X' ? +(m >= 0) : a === 'X2' ? +(m <= 0) : +(m !== 0));
  }
  return null;
}
function scProb(g, key) {
  const f = scCore(key); if (!f || !g || !SB.priced(g)) return 0;
  let win = 0, push = 0;
  if (MARGIN.has(g.sport)) {
    if (!['ml', 'sp', 'tot'].includes(scParse(key).t)) return 0;
    const S = SB.simGame(g); if (!S) return 0;
    for (let i = 0; i < S.N; i++) { const r = f(S.mg[i], S.tt[i]); if (r === 1) win++; else if (r === null) push++; }
    return S.N - push > 0 ? win / (S.N - push) : 0;
  }
  const O = SB.outcomes(g); if (!O) return 0;
  for (let i = 0; i < O.n; i++) { const h = O.h[i], x = O.a[i], r = f(h - x, h + x, h, x); if (r === 1) win += O.p[i]; else if (r === null) push += O.p[i]; }
  return 1 - push > 1e-12 ? win / (1 - push) : 0;
}
function scLabel(key, g) {
  const { t, a, L } = scParse(key), tm = s => (g ? (s === 'H' ? g.home.name : g.away.name) : s);
  const ln = isFinite(L) ? (L > 0 ? '+' + L : String(L)) : '';
  switch (t) {
    case 'ml': return a === 'D' ? 'Draw' : `${tm(a)} to win`;
    case 'sp': return `${tm(a)} ${ln}`;
    case 'tot': return `${a === 'O' ? 'Over' : 'Under'} ${L} total`;
    case 'btts': return a === 'Y' ? 'Both teams to score' : 'Both teams to score: No';
    case 'cs': return `Correct score ${a}`;
    case 'dc': return a === '1X' ? `${tm('H')} or draw` : a === 'X2' ? `${tm('A')} or draw` : 'Either team to win';
  }
  return 'Game line';
}
SB.registerLegType('SC', {
  label: (key, g) => scLabel(key, g),
  prob: (g, key) => scProb(g, key),
  cond: (g, key) => { if (!GOALS.has(g && g.sport)) return null; const f = scCore(key); return (h, a) => { const r = f(h - a, h + a, h, a); return r === null ? 0 : r; }; },
  settle: (g, key, h, a) => { const f = scCore(key); if (!f) return null; const r = f(h - a, h + a, h, a); return r === null ? null : r === 1; },
});
const xKey = text => 'X:' + encodeURIComponent(str(text, 90) || 'Leg');
SB.registerLegType('X', {
  label: key => { try { return decodeURIComponent(String(key).slice(2)); } catch (e) { return 'Leg'; } },
  prob: () => 0,
  settle: () => null,
});

// ---------------- matching a slip leg to the board ----------------
function teamTokens(t) {
  const name = N(t.name), w = name.split(' ');
  return { name, nick1: w[w.length - 1], nick2: w.length > 2 ? w.slice(-2).join(' ') : '', city: w.slice(0, -1).join(' '), abbr: N(t.abbr),
    words: w.filter(x => x.length >= 5 && !GENERIC.has(x)) };
}
function teamScore(t, text) {
  if (!text) return 0;
  const k = teamTokens(t), T = ' ' + text + ' '; let s = 0;
  if (k.name && T.includes(' ' + k.name + ' ')) s = 4;
  if (k.nick2 && k.nick2.length > 6 && T.includes(' ' + k.nick2 + ' ')) s = Math.max(s, 3);
  if (k.nick1 && k.nick1.length >= 4 && !GENERIC.has(k.nick1) && T.includes(' ' + k.nick1 + ' ')) s = Math.max(s, 2.5);
  if (k.city && k.city.length >= 4 && T.includes(' ' + k.city + ' ')) s = Math.max(s, 1.6);
  if (k.abbr && k.abbr.length >= 2 && T.includes(' ' + k.abbr + ' ')) s = Math.max(s, 1.3);
  if (!s && k.words.some(x => T.includes(' ' + x + ' '))) s = 1;
  return s;
}
const SPORT_ALIAS = { basketball: 'nba', nba: 'nba', football: 'nfl', nfl: 'nfl', ncaaf: 'ncaaf', 'college football': 'ncaaf', cfb: 'ncaaf',
  hockey: 'nhl', nhl: 'nhl', soccer: 'soccer', futbol: 'soccer' };
function boardGames() {
  const now = Date.now();
  return ((SB.DATA && SB.DATA.games) || []).filter(g => { const t = SB.startMs(g); return isFinite(t) && t > now - 30 * 3600e3 && t < now + 10 * 86400e3; });
}
function findPlayer(name, stat) {
  const k = nameKey(name); if (!k) return null;
  const P = ((SB.DATA && SB.DATA.players) || []).filter(p => nameKey(p.name) === k);
  return P.find(p => p.stat === stat) || P[0] || null;
}
function findRotation(name) { // NBA rotation player via lottos.js (team model), for points lines not in props.json
  const L = window.__lottos; if (!L || !L.ROLES) return null; const k = nameKey(name);
  for (const abbr of Object.keys(L.ROLES.teams || {})) { const m = L.teamModel(abbr); const p = m.players.find(x => nameKey(x.name) === k); if (p) return p; }
  return null;
}
function findGame(leg, teamHint) {
  const text = N(`${leg.event} ${leg.pick} ${leg.sel || ''}`), sport = SPORT_ALIAS[N(leg.sport)] || null;
  let best = null, bs = 0;
  for (const g of boardGames()) {
    let s = teamScore(g.home, text) + teamScore(g.away, text);
    if (teamHint && (g.home.abbr === teamHint || g.away.abbr === teamHint)) s += 3;
    if (sport && g.sport === sport) s += 0.8; else if (sport && sport !== g.sport) s -= 1;
    if (!SB.started(g)) s += 0.2;
    if (s > bs) { bs = s; best = g; }
  }
  return bs >= 2 ? best : null;
}
function sideOf(g, text) { const t = N(text); const h = teamScore(g.home, t), a = teamScore(g.away, t); return h > a ? 'H' : a > h ? 'A' : null; }
function matchLeg(leg) {
  const out = { status: 'none', g: null, key: null, label: '', p: 0, why: '' };
  const mk = MARKET_IDS.includes(leg.market) ? leg.market : 'other', side = /^under$/i.test(leg.side) ? 'U' : /^over$/i.test(leg.side) ? 'O' : null;
  const line = num(leg.line);
  // player props
  if (STAT[mk] || mk === 'player_other') {
    const stat = STAT[mk];
    const pr = stat ? findPlayer(leg.pick, stat) : null;
    if (pr && pr.stat === stat && line != null && side) {
      const g = SB.gameById(pr.gid);
      out.g = g; out.key = side === 'O' ? `P:${pr.id}:${Math.floor(line) + 1}` : `U:${pr.id}:${line}`;
    } else if (stat === 'pts' && side === 'O' && line != null) {
      const rp = findRotation(leg.pick); const g = rp ? findGame(leg, rp.team) : null;
      if (rp && g && (g.home.abbr === rp.team || g.away.abbr === rp.team)) { out.g = g; out.key = `L:${rp.team}-${rp.slug}:${Math.floor(line) + 1}`; }
      else out.why = rp ? 'Player found, but his game is not on the board' : 'Player not in our data';
    } else out.why = mk === 'player_other' ? 'We only price points, rebounds and assists' : !side ? 'Pick over or under' : line == null ? 'Add the line' : 'Player not in our props';
    if (!out.key) { out.g = out.g || findGame(leg); out.status = out.g ? 'game' : 'none'; return out; }
  } else {
    const g = findGame(leg); out.g = g;
    if (!g) { out.why = 'Game not found on our board'; return out; }
    const pick = `${leg.pick} ${leg.sel || ''}`, s = sideOf(g, pick);
    if (mk === 'moneyline') { if (/\b(draw|tie)\b/i.test(pick) && g.sport === 'soccer') out.key = 'SC:ml:D'; else if (s) out.key = `SC:ml:${s}`; else out.why = 'Which team?'; }
    else if (mk === 'draw') out.key = g.sport === 'soccer' ? 'SC:ml:D' : null;
    else if (mk === 'spread') { if (s && line != null) out.key = `SC:sp:${s}:${line}`; else out.why = !s ? 'Which team?' : 'Add the line'; }
    else if (mk === 'total') { if (sideOf(g, leg.pick) && !/\b(game|match|total)\b/i.test(leg.pick)) out.why = 'Team totals are not priced yet';
      else if (side && line != null) out.key = `SC:tot:${side}:${line}`; else out.why = !side ? 'Pick over or under' : 'Add the line'; }
    else if (mk === 'btts' && g.sport === 'soccer') out.key = /\b(no|n)\b/i.test(pick) ? 'SC:btts:N' : 'SC:btts:Y';
    else if (mk === 'correct_score' && g.sport === 'soccer') { const m = /(\d+)\s*[-:]\s*(\d+)/.exec(pick); if (m) { let [h, a] = [+m[1], +m[2]]; if (s === 'A') [h, a] = [a, h]; out.key = `SC:cs:${h}-${a}`; } else out.why = 'Add the score, e.g. 2-1'; }
    else if (mk === 'double_chance' && g.sport === 'soccer') { const dr = /\b(draw|x)\b/i.test(pick); out.key = dr && s === 'H' ? 'SC:dc:1X' : dr && s === 'A' ? 'SC:dc:X2' : 'SC:dc:12'; }
    else out.why = 'This bet type is not priced yet';
    if (!out.key) { out.status = 'game'; return out; }
  }
  out.p = out.g ? SB.p1(out.g, out.key) : 0;
  out.label = SB.legLabel({ gid: out.g.id, key: out.key });
  if (!SB.priced(out.g) && !/^[PUL]:/.test(out.key)) { out.status = 'game'; out.why = SB.started(out.g) ? 'Game already started: no pre-game price' : 'No price for this game yet'; return out; }
  if (!(out.p > 0)) { out.status = 'game'; out.why = /^L:/.test(out.key) ? 'Player is listed out or not in the rotation' : 'Could not price this line'; return out; }
  out.status = 'matched';
  return out;
}

// ---------------- analysis ----------------
function injuryNote(r) {
  const L = window.__lottos, INJ = L && L.INJ; if (!INJ || !r.g) return '';
  const g = r.g;
  if (/^[PUL]:/.test(r.key || '')) {
    const nm = nameKey(String(r.label).replace(/\s+(under\s+)?[\d.]+\+?\s.*$/i, ''));
    const e = INJ.injuries.find(x => x.sport === g.sport && nameKey(x.player) === nm);
    return e ? `${e.player} is listed ${String(e.status).toUpperCase()} (${e.injury || 'injury'})` : '';
  }
  const team = abbr => INJ.injuries.filter(x => x.sport === g.sport && x.team === abbr && (x.status === 'out' || x.status === 'doubtful'));
  const parts = [];
  for (const t of [g.home, g.away]) { const xs = team(t.abbr); if (xs.length) parts.push(`${t.abbr}: ${xs.slice(0, 2).map(x => x.player).join(', ')}${xs.length > 2 ? ` +${xs.length - 2}` : ''} out`); }
  return parts.join(' · ');
}
function jointFor(rows) { // model chance that all matched legs hit, with same-game correlation
  const byG = new Map(); for (const r of rows) { if (!byG.has(r.g.id)) byG.set(r.g.id, []); byG.get(r.g.id).push(r); }
  let p = 1; const groups = [];
  for (const [gid, rs] of byG) {
    const g = rs[0].g, indep = rs.reduce((s, r) => s * r.p, 1); let gp = indep;
    if (rs.length > 1) {
      if (GOALS.has(g.sport)) { try { gp = SB.probOf(g, rs.map(r => r.key)); } catch (e) { gp = indep; } }
      else if (MARGIN.has(g.sport)) { const sc = rs.filter(r => r.key.startsWith('SC:')), other = rs.filter(r => !r.key.startsWith('SC:'));
        if (sc.length > 1) { const S = SB.simGame(g), F = sc.map(r => scCore(r.key)); let win = 0, tot = 0;
          for (let i = 0; i < S.N; i++) { let ok = true, push = false; for (const f of F) { const v = f(S.mg[i], S.tt[i]); if (v === null) { push = true; break; } if (v === 0) { ok = false; break; } } if (push) continue; tot++; if (ok) win++; }
          gp = (tot ? win / tot : 0) * other.reduce((s, r) => s * r.p, 1); } }
    }
    p *= gp; groups.push({ g, rows: rs, p: gp, indep });
  }
  return { p, groups };
}
function analyze(slip) {
  const rows = slip.legs.map((L, i) => { const m = matchLeg(L); return { ...m, i, src: L, dec: bookDec(L.odds), text: legText(L) }; });
  for (const r of rows) { r.inj = r.status !== 'none' ? injuryNote(r) : ''; r.edge = r.status === 'matched' && r.dec ? r.p * r.dec - 1 : null; }
  const M = rows.filter(r => r.status === 'matched'), U = rows.filter(r => r.status !== 'matched');
  const J = M.length ? jointFor(M) : { p: 0, groups: [] };
  const indep = M.reduce((s, r) => s * r.p, 1);
  const printed = bookDec(slip.totalOdds);
  const legDecs = rows.every(r => r.dec) ? rows.reduce((s, r) => s * r.dec, 1) : null;
  const bookTot = printed || legDecs || (slip.stake > 0 && slip.payout > slip.stake ? slip.payout / slip.stake : null);
  // when some legs can't be priced, compare only the priced part against the book's prices for those legs
  const full = !U.length;
  const decCmp = full ? bookTot : (M.length && M.every(r => r.dec) ? M.reduce((s, r) => s * r.dec, 1) : null);
  const ev = M.length && decCmp ? J.p * decCmp - 1 : null;
  let verdict, tone;
  if (!M.length) { verdict = 'Can\'t grade'; tone = 'mid'; }
  else if (ev == null) { verdict = J.p < 0.1 ? 'Long shot' : 'No price to compare'; tone = 'mid'; }
  else if (ev >= 0.05) { verdict = 'Value bet'; tone = 'hi'; }
  else if (ev > -0.05) { verdict = 'Fair price'; tone = 'mid'; }
  else { verdict = 'Overpriced'; tone = 'lo'; }
  const long = M.length && J.p < 0.1;
  const weakest = M.length ? M.reduce((b, r) => (r.p < b.p ? r : b), M[0]) : null;
  const corr = J.groups.filter(G => G.rows.length > 1).map(G => ({ g: G.g, ratio: G.indep > 0 ? G.p / G.indep : 1, n: G.rows.length }));
  return { rows, M, U, p: J.p, indep, groups: J.groups, bookTot, decCmp, full, ev, verdict, tone, long, weakest, corr, stake: slip.stake > 0 ? slip.stake : null };
}
const legText = L => [L.pick, L.side, L.line != null && L.line !== '' ? L.line : '', marketName(L.market) !== 'Other' && !STAT[L.market] ? '' : '', L.event ? `(${L.event})` : ''].filter(Boolean).join(' ').trim() || 'Leg';
const marketName = id => (MARKETS.find(m => m[0] === id) || [, 'Other'])[1];
function opinion(A) {
  if (!A.M.length) return 'We can\'t match any of these legs to games we price, so there is no honest number to give. Fix the team or player names below, or check that the games are on the board.';
  const hit = `It hits about ${pctS(A.p)} of the time in our model (fair ${SB.fmtOdds(A.p)})`;
  const part = A.full ? '' : ` That covers ${A.M.length} of ${A.rows.length} legs; the rest we can't price.`;
  if (A.ev == null) return `${hit}.${part} No book price was read, so bet it only at ${SB.fmtOdds(A.p)} or better.`;
  const pays = `The book pays ${SB.fmtPrice(A.decCmp)}`;
  const per = A.ev >= 0 ? `about ${(A.ev * 100).toFixed(0)}¢ of profit per $1 over the long run` : `you give up about ${Math.abs(A.ev * 100).toFixed(0)}¢ per $1 over the long run`;
  const wk = A.weakest && A.M.length > 1 ? ` The weakest link is ${A.weakest.label} at ${pctS(A.weakest.p, 0)}.` : '';
  const head = { 'Value bet': 'Worth it.', 'Fair price': 'Close to fair.', Overpriced: 'Pass at this price.' }[A.verdict] || '';
  return `${head} ${pays}; ${hit.charAt(0).toLowerCase() + hit.slice(1)}, so ${per}.${wk}${part}${A.long ? ' It\'s a long shot: keep the stake small.' : ''}`.trim();
}
function reasons(A) {
  const can = [], not = [];
  for (const r of A.M) {
    if (r.p >= 0.6) can.push(`${r.label}: ${pctS(r.p, 0)} in our model`);
    if (r.edge != null && r.edge >= 0.03) can.push(`${r.label} is priced better than fair (${signPct(r.edge)} edge)`);
    if (/^L:/.test(r.key)) can.push(`${r.label}: boosted by a teammate's injury`);
    if (r.p < 0.4) not.push(`${r.label} is only ${pctS(r.p, 0)} to hit`);
    if (r.edge != null && r.edge <= -0.08) not.push(`${r.label} is overpriced (${signPct(r.edge)} vs fair)`);
    if (r.inj) not.push(`Injuries: ${r.inj}`);
  }
  for (const c of A.corr) {
    if (c.ratio > 1.05) can.push(`Same-game legs in ${c.g.away.abbr} @ ${c.g.home.abbr} tend to win together (${signPct(c.ratio - 1)} vs unrelated)`);
    else if (c.ratio < 0.95) not.push(`Same-game legs in ${c.g.away.abbr} @ ${c.g.home.abbr} work against each other (${signPct(c.ratio - 1)} vs unrelated)`);
  }
  if (A.weakest && A.M.length > 1 && !not.some(x => x.startsWith(A.weakest.label))) not.push(`Weakest leg: ${A.weakest.label} at ${pctS(A.weakest.p, 0)}`);
  if (A.rows.length >= 4) not.push(`${A.rows.length} legs: every one has to hit`);
  if (A.ev != null && A.ev < 0) not.push(`The price is short of fair: the book implies ${pctS(1 / A.decCmp)}, the model says ${pctS(A.p)}`);
  if (A.ev != null && A.ev >= 0.05) can.push(`The payout beats the fair price (${signPct(A.ev)} expected value)`);
  for (const r of A.U) not.push(`Not priced: ${r.text}${r.why ? ` (${r.why.toLowerCase()})` : ''}`);
  return { can: [...new Set(can)].slice(0, 6), not: [...new Set(not)].slice(0, 7) };
}

// ---------------- state ----------------
const blankLeg = () => ({ event: '', market: 'moneyline', pick: '', side: '', line: '', odds: '', sport: '', sel: '' });
const st = { img: null, imgURL: null, slip: store.get('sc.draft', null), phase: 'idle', err: '', A: null, ctl: null, take: '', takeState: 'idle', takeCtl: null };
if (st.slip && !Array.isArray(st.slip.legs)) st.slip = null;
if (st.slip) st.phase = 'read';
let sampleFn = null, aiImages = false, aiState = 'checking';
(async () => {
  try { if (window.claude && typeof window.claude.use === 'function') { sampleFn = await window.claude.use('sample');
    if (sampleFn) { const lim = await sampleFn.limits().catch(() => null); aiImages = !!(lim && lim.images); } } } catch (e) { sampleFn = null; }
  aiState = sampleFn && aiImages ? 'ready' : 'off'; rerender();
})();
const saveDraft = () => store.set('sc.draft', st.slip);
function cleanSlip(r) {
  const legs = (Array.isArray(r && r.legs) ? r.legs : []).slice(0, 15).map(l => {
    const market = MARKET_IDS.includes(l && l.market) ? l.market : 'other', sel = str(l && l.selection);
    let side = /^over$/i.test(l && l.side) ? 'Over' : /^under$/i.test(l && l.side) ? 'Under' : '';
    if (!side && /\b(over|o)\s*\d/i.test(sel)) side = 'Over'; else if (!side && /\b(under|u)\s*\d/i.test(sel)) side = 'Under';
    const pick = STAT[market] || market === 'player_other' ? str(l.player || sel) : market === 'total' ? str(l.team || '') : str(l.team || sel);
    return { event: str(l && l.event), market, pick, side, line: num(l && l.line) ?? '', odds: str(l && l.odds, 16), sport: str(l && l.sport, 20), sel,
      conf: Math.max(0, Math.min(1, +((l && l.confidence) ?? 1) || 0)) };
  });
  return { book: str(r && r.book, 40), betType: str(r && r.betType, 20), stake: num(r && r.stake), totalOdds: str(r && r.totalOdds, 16), payout: num(r && r.payout),
    legs: legs.length ? legs : [blankLeg()], notes: str(r && r.notes, 300), byAI: true };
}
const PROMPT = `This image is a screenshot of a sports bet slip from a sportsbook or fantasy app (DraftKings, FanDuel, bet365, BetMGM, Caesars, PrizePicks, etc.).
Read it exactly as shown. Do not guess values that are not visible.
Reply with ONLY one JSON object:
{"book": string|null, "betType": "parlay"|"single"|"sgp"|"teaser"|"other", "stake": number|null, "totalOdds": string|null (exactly as printed, e.g. "+650" or "7.50"), "payout": number|null (total return or to-win as printed),
 "legs": [{"sport": "nba"|"nfl"|"ncaaf"|"nhl"|"soccer"|"mlb"|"mma"|"other", "event": "Away Team @ Home Team or Team A vs Team B as printed", "market": "moneyline"|"spread"|"total"|"player_points"|"player_rebounds"|"player_assists"|"player_other"|"btts"|"correct_score"|"double_chance"|"draw"|"other", "selection": "the pick as printed", "team": string|null, "player": string|null, "side": "over"|"under"|null, "line": number|null, "odds": string|null (as printed), "confidence": number between 0 and 1}],
 "notes": "anything unclear, or empty"}
It may be a Polymarket screenshot (one position, a combo/parlay, or the portfolio list). Then book = "Polymarket", every market (or combo leg) is a leg, selection = the outcome bought (Yes / No / a team), odds = the average price exactly as shown in cents (for example "63¢"), stake = the cost, payout = the "to win" or shares value if shown. A player market like "LeBron James: Points O/U 24.5" bought Yes is market player_points, side over, line 24.5; bought No is side under.
If the image is not a bet slip, reply {"error": "not a bet slip"}.`;
const ERR = { not_granted: 'The AI reader wasn\'t allowed, so enter the legs by hand below.', sampling_disabled: 'AI reading isn\'t available on this account. Enter the legs by hand.',
  images_unavailable: 'AI image reading isn\'t available here. Enter the legs by hand.', rate_limited: 'Too many AI requests right now. Try again in a minute, or enter the legs by hand.',
  image_rejected: 'That image couldn\'t be read. Try a PNG or JPG screenshot.', invalid_json: 'The slip couldn\'t be read clearly. Try a sharper screenshot or enter the legs by hand.',
  empty_completion: 'The slip couldn\'t be read clearly. Try a sharper screenshot or enter the legs by hand.', refused: 'That image couldn\'t be read. Try a different screenshot.',
  session_expired: 'Sign in to Claude again to use the AI reader.' };
async function readSlip() {
  if (!sampleFn || !st.img || st.phase === 'reading') return;
  st.phase = 'reading'; st.err = ''; st.ctl = new AbortController(); rerender();
  try {
    const r = await sampleFn.json(PROMPT, { images: [st.img], signal: st.ctl.signal });
    if (!r || typeof r !== 'object' || r.error) { st.phase = st.slip ? 'read' : 'idle'; st.err = 'That image doesn\'t look like a bet slip. Try a clearer screenshot, or enter the legs by hand.'; }
    else { st.slip = cleanSlip(r); saveDraft(); st.A = analyze(st.slip); st.take = ''; st.takeState = 'idle'; st.phase = 'read'; }
  } catch (e) {
    st.phase = st.slip ? 'read' : 'idle';
    const c = e && e.code; if (c === 'not_granted' || c === 'sampling_disabled' || c === 'images_unavailable') aiState = 'off';
    st.err = c === 'cancelled' ? '' : (ERR[c] || 'Something went wrong reading the slip. Try again, or enter the legs by hand.');
  }
  st.ctl = null; rerender();
}
async function claudeTake() {
  if (!sampleFn || !st.A || !st.A.M.length || st.takeState === 'busy') return;
  const A = st.A, facts = {
    book: st.slip.book || null, legs: A.rows.map(r => ({ leg: r.status === 'matched' ? r.label : r.text, modelHitChance: r.status === 'matched' ? +r.p.toFixed(3) : null,
      bookOdds: r.src.odds || null, edgeVsFair: r.edge == null ? null : +r.edge.toFixed(3), injuries: r.inj || null, priced: r.status === 'matched' })),
    parlayModelHitChance: +A.p.toFixed(4), fairOdds: SB.fmtOdds(A.p), bookPays: A.decCmp ? SB.fmtPrice(A.decCmp) : null,
    expectedValuePerDollar: A.ev == null ? null : +A.ev.toFixed(3), verdict: A.verdict, weakestLeg: A.weakest ? A.weakest.label : null };
  const prompt = `You are a blunt, honest sports-betting analyst. Using ONLY the numbers below from the Safe Bets model (do not add any stats, injuries, form or facts that are not listed), give a direct opinion on this bet slip in 3 to 4 short sentences: is it worth betting at this price, the main reason it can win, the main reason it can lose, and the price to wait for. Plain words, no hype, no guarantees, no emojis.\n\n${JSON.stringify(facts)}`;
  st.takeState = 'busy'; st.take = ''; st.takeCtl = new AbortController(); rerender();
  try {
    const { text } = await sampleFn(prompt, { modelTier: 'quick', signal: st.takeCtl.signal, onText: ({ text }) => { st.take = text; const el = document.getElementById('scTake'); if (el) el.textContent = text; } });
    st.take = text; st.takeState = 'done';
  } catch (e) { st.takeState = 'idle'; if (e && e.code !== 'cancelled') st.take = (e && e.text) || (ERR[e && e.code] || 'Claude couldn\'t answer right now. The verdict above still stands.'); if (e && e.code === 'not_granted') aiState = 'off'; }
  st.takeCtl = null; rerender();
}
function track() {
  const A = st.A; if (!A) return;
  const now = Date.now();
  const legs = A.rows.map((r, i) => {
    const g = r.g;
    const base = g ? { sport: g.sport, comp: g.comp, home: g.home.abbr, away: g.away.abbr, start: g.start } : {};
    if (r.status === 'matched') return { gid: g.id, key: r.key, label: r.label, p1: r.p, ...base, bookOdds: r.src.odds || null };
    return { gid: g ? g.id : `x-${now}-${i}`, key: xKey(r.text), label: r.text, custom: true, ...base, bookOdds: r.src.odds || null };
  });
  const dec = A.bookTot || null;
  const ok = SB.saveParlay ? SB.saveParlay({ legs, p: A.M.length ? A.p : null, odds: dec ? SB.dec2am(dec) : null, dec, stake: A.stake, book: st.slip.book || null, src: 'slipcheck', partial: !A.full }) : false;
  SB.toast(ok ? `Tracking in My Parlays${st.slip.book ? ' · ' + esc(st.slip.book) : ''}` : 'Couldn\'t save this bet');
}
function builderLegs() { return st.A ? st.A.M.filter(r => !SB.started(r.g)).map(r => ({ gid: r.g.id, key: r.key })) : []; }

// ---------------- markup ----------------
function uploadPanel() {
  const ai = aiState === 'ready', checking = aiState === 'checking';
  return `<div class="pc sc-up">
    <label class="sc-drop${st.imgURL ? ' has' : ''}" for="scFile">
      ${st.imgURL ? `<img src="${esc(st.imgURL)}" alt="Your bet slip screenshot">` : `<span class="sc-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg></span>
      <b>Add a bet slip screenshot</b><span>Tap to choose, drop it here, or paste it</span>`}
      <input type="file" id="scFile" accept="image/*">
    </label>
    <div class="sc-btns">
      ${ai ? `<button class="btn" data-sc-read ${st.img && st.phase !== 'reading' ? '' : 'disabled'}>${st.phase === 'reading' ? 'Reading…' : 'Read slip with AI'}</button>` : ''}
      <button class="btn ghost" data-sc-manual>${st.slip ? 'Start over by hand' : 'Enter legs by hand'}</button>
    </div>
    ${st.phase === 'reading' ? `<div class="sc-status" role="status">Claude is reading your slip. This can take up to a minute. <button class="sc-link" data-sc-stop>Stop</button></div>` : ''}
    ${st.err ? `<div class="sc-status sc-err" role="alert">${esc(st.err)}</div>` : ''}
    <div class="note">${ai ? 'Claude reads the screenshot; you check what it read. The first time, you\'re asked to allow the AI reader.' : checking ? 'Checking whether the AI reader is available…' : 'The AI reader isn\'t available in this view. Enter the legs by hand: the comparison and analysis work the same.'}</div>
  </div>`;
}
function editor() {
  const S = st.slip; if (!S) return '';
  const A = st.A, mOf = i => A && A.rows[i];
  const opt = (v, cur) => `<option value="${esc(v[0])}" ${v[0] === cur ? 'selected' : ''}>${esc(v[1])}</option>`;
  const legs = S.legs.map((L, i) => { const m = mOf(i);
    const tag = !m ? '' : m.status === 'matched' ? `<span class="sc-m ok">✓ ${esc(m.label)} · ${pctS(m.p, 0)}</span>` : `<span class="sc-m no">${m.status === 'game' ? 'Game found, not priced' : 'Not on our board'}${m.why ? ': ' + esc(m.why) : ''}</span>`;
    return `<div class="sc-leg" data-i="${i}">
      <div class="sc-r1"><span class="legdot">${i + 1}</span><input class="sc-in" id="sc-ev-${i}" data-sc-f="event" value="${esc(L.event)}" placeholder="Game, e.g. Jazz @ Lakers" aria-label="Leg ${i + 1} game">
        <button class="sc-x" data-sc-del="${i}" aria-label="Remove leg ${i + 1}">✕</button></div>
      <div class="sc-r2">
        <select class="sc-in" id="sc-mk-${i}" data-sc-f="market" aria-label="Leg ${i + 1} bet type">${MARKETS.map(v => opt(v, L.market)).join('')}</select>
        <input class="sc-in" id="sc-pk-${i}" data-sc-f="pick" value="${esc(L.pick)}" placeholder="Team, player or Yes/No" aria-label="Leg ${i + 1} pick">
        <select class="sc-in sc-sm" id="sc-sd-${i}" data-sc-f="side" aria-label="Leg ${i + 1} over or under"><option value="">–</option>${['Over', 'Under'].map(x => `<option ${L.side === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input class="sc-in sc-sm" id="sc-ln-${i}" data-sc-f="line" value="${esc(L.line)}" placeholder="Line" inputmode="decimal" aria-label="Leg ${i + 1} line">
        <input class="sc-in sc-sm" id="sc-od-${i}" data-sc-f="odds" value="${esc(L.odds)}" placeholder="Odds" aria-label="Leg ${i + 1} odds">
      </div>${tag ? `<div class="sc-r3">${tag}${L.conf != null && L.conf < 0.7 && S.byAI ? ' <span class="badge b-est">CHECK</span>' : ''}</div>` : ''}</div>`; }).join('');
  return `<h2>What the slip says <small>${S.byAI ? 'read by AI · fix anything it got wrong' : 'enter each leg'}</small></h2>
   <div class="pc sc-ed">
    <div class="sc-top">
      <label>Sportsbook<input class="sc-in" id="sc-book" data-sc-s="book" value="${esc(S.book)}" placeholder="e.g. DraftKings"></label>
      <label>Stake ($)<input class="sc-in" id="sc-stake" data-sc-s="stake" value="${S.stake ?? ''}" inputmode="decimal" placeholder="10"></label>
      <label>Total odds<input class="sc-in" id="sc-tot" data-sc-s="totalOdds" value="${esc(S.totalOdds)}" placeholder="+650"></label>
    </div>
    ${S.notes ? `<div class="note">AI note: ${esc(S.notes)}</div>` : ''}
    ${legs}
    <div class="sc-btns"><button class="btn ghost" data-sc-add>+ Add leg</button><button class="btn" data-sc-go>Compare and analyze</button></div>
   </div>`;
}
function results() {
  const A = st.A; if (!A) return '';
  const R = reasons(A), cls = { hi: 'h-hi', mid: 'h-mid', lo: 'h-lo' }[A.tone];
  const kpi = (v, l) => `<div class="kpi"><b class="mono">${v}</b><span>${l}</span></div>`;
  const evStake = A.ev != null && A.stake ? `<div class="note">On your ${money(A.stake)} stake that's about ${money(A.ev * A.stake)} expected over the long run${A.ev < 0 ? ' (a loss)' : ''}.</div>` : '';
  const verdict = `<div class="pc sc-verdict"><div class="pchead"><span class="pctitle">Our verdict</span><span class="hit ${cls}">${esc(A.verdict)}${A.long && A.verdict !== 'Long shot' ? ' · long shot' : ''}</span></div>
    ${A.M.length ? `<div class="gauge" style="--p:${Math.max(0, Math.min(1, A.p)).toFixed(3)}" aria-hidden="true"><i></i></div>` : ''}
    <p class="sc-op">${esc(opinion(A))}</p>
    ${A.M.length ? `<div class="kpis">${kpi(pctS(A.p), 'Model hit chance')}${kpi(A.decCmp ? pctS(1 / A.decCmp) : '—', 'Book implies')}${kpi(esc(SB.fmtOdds(A.p)), 'Fair odds')}${kpi(A.decCmp ? esc(SB.fmtPrice(A.decCmp)) : '—', 'Book pays')}${kpi(A.ev == null ? '—' : signPct(A.ev), 'Expected value')}</div>${evStake}` : ''}
    ${sampleFn && aiState === 'ready' && A.M.length ? `<div class="sc-take"><button class="btn ghost" data-sc-take ${st.takeState === 'busy' ? 'disabled' : ''}>${st.takeState === 'busy' ? 'Thinking…' : st.take ? 'Ask Claude again' : 'Claude\'s take'}</button>${st.takeState === 'busy' ? '<button class="sc-link" data-sc-take-stop>Stop</button>' : ''}
      <p id="scTake" class="sc-op sc-ai" aria-live="polite">${esc(st.take)}</p></div>` : ''}
  </div>`;
  const cmp = `<h2>1 · Compare <small>book price vs our fair price</small></h2><div class="pc sc-cmp"><div class="sc-tbl" role="table">
    <div class="sc-tr sc-th" role="row"><span role="columnheader">Leg</span><span role="columnheader">Book</span><span role="columnheader">Model</span><span role="columnheader">Fair</span><span role="columnheader">Edge</span></div>
    ${A.rows.map(r => r.status === 'matched'
      ? `<div class="sc-tr" role="row"><span role="cell"><b>${esc(r.label)}</b><small>${r.g ? esc(`${r.g.away.abbr} @ ${r.g.home.abbr}`) : ''}</small></span><span role="cell" class="mono">${r.dec ? esc(SB.fmtPrice(r.dec)) : '—'}</span><span role="cell" class="mono">${pctS(r.p, 0)}</span><span role="cell" class="mono">${esc(SB.fmtOdds(r.p))}</span><span role="cell" class="mono ${r.edge == null ? '' : r.edge >= 0.03 ? 'sc-pos' : r.edge <= -0.03 ? 'sc-neg' : ''}">${r.edge == null ? '—' : signPct(r.edge)}</span></div>`
      : `<div class="sc-tr sc-un" role="row"><span role="cell"><b>${esc(r.text)}</b><small>${esc(r.why || 'Not on our board')}</small></span><span role="cell" class="mono">${r.dec ? esc(SB.fmtPrice(r.dec)) : '—'}</span><span role="cell">—</span><span role="cell">—</span><span role="cell">—</span></div>`).join('')}
    <div class="sc-tr sc-tf" role="row"><span role="cell"><b>Parlay${A.full ? '' : ` (${A.M.length} priced legs)`}</b></span><span role="cell" class="mono">${A.decCmp ? esc(SB.fmtPrice(A.decCmp)) : '—'}</span><span role="cell" class="mono">${A.M.length ? pctS(A.p) : '—'}</span><span role="cell" class="mono">${A.M.length ? esc(SB.fmtOdds(A.p)) : '—'}</span><span role="cell" class="mono ${A.ev == null ? '' : A.ev >= 0.03 ? 'sc-pos' : A.ev <= -0.03 ? 'sc-neg' : ''}">${A.ev == null ? '—' : signPct(A.ev)}</span></div>
  </div><div class="note">Edge = how much better (+) or worse (−) the book's price is than our fair price. ${A.M.length ? `Bet only at <b class="mono">${esc(SB.fmtOdds(A.p))}</b> or better (${esc(SB.fmtPrice(1.05 / A.p))} = a 5% edge).` : ''}</div></div>`;
  const legsA = `<h2>2 · The legs <small>hit chance, links and injuries</small></h2><div class="pc sc-legs">${A.M.map((r, i) => `<div class="leg"><span class="legdot ${r === A.weakest && A.M.length > 1 ? 'base' : ''}">${i + 1}</span><div class="legtxt"><b>${esc(r.label)}${r === A.weakest && A.M.length > 1 ? ' <span class="badge b-live">WEAKEST</span>' : ''}</b>
      <span>${esc(`${r.g.away.abbr} @ ${r.g.home.abbr}`)} · ${esc(SB.when(r.g))}</span>${r.inj ? `<em class="sc-inj">🚑 ${esc(r.inj)}</em>` : ''}</div><span class="legp mono">${pctS(r.p, 0)}<small>${esc(SB.fmtOdds(r.p))}</small></span></div>`).join('') || '<div class="why">No priced legs yet.</div>'}
    ${A.corr.map(c => `<div class="note">${esc(`${c.g.away.abbr} @ ${c.g.home.abbr}`)}: ${c.n} legs from the same game, ${c.ratio > 1.02 ? 'they tend to hit together' : c.ratio < 0.98 ? 'they work against each other' : 'close to unrelated'} (${pctS(A.groups.find(G => G.g === c.g).p)} together vs ${pctS(A.groups.find(G => G.g === c.g).indep)} if unrelated).</div>`).join('')}</div>`;
  const why = `<h2>3 · Why it will or won't hit</h2><div class="sc-why"><div class="pc"><div class="pctitle sc-wt sc-pos">Why it can hit</div><ul>${R.can.map(x => `<li>${esc(x)}</li>`).join('') || '<li>Nothing stands out in its favour.</li>'}</ul></div>
    <div class="pc"><div class="pctitle sc-wt sc-neg">Why it might not</div><ul>${R.not.map(x => `<li>${esc(x)}</li>`).join('') || '<li>No clear weak spot.</li>'}</ul></div></div>`;
  const bl = builderLegs();
  const act = `<h2>4 · Track it here <small>all your bets in one app</small></h2><div class="pc"><div class="sc-btns">
    <button class="btn" data-sc-track>Track this bet</button>
    <button class="btn ghost" data-sc-build ${bl.length ? '' : 'disabled'}>Open in builder</button>
    ${document.querySelector('#tabs [data-t="sim"]') && bl.length ? '<button class="btn ghost" data-sc-sim>Simulate 100k</button>' : ''}</div>
    <div class="note">Track saves the whole slip to My Parlays with ${st.slip.book ? esc(st.slip.book) + "'s" : 'the book\'s'} odds and your stake. Legs we price grade themselves when games finish; the others get ✓ / ✗ buttons. My Parlays is saved on this device.</div></div>`;
  return verdict + cmp + legsA + why + act;
}
function render(main) {
  const head = `<h2>Slip Check <small>bring a bet from any app</small></h2>
    <div class="note sc-lead">Upload a screenshot of a bet slip from Polymarket, DraftKings, FanDuel, bet365, PrizePicks or any other app. The Safe Bets model compares the prices, grades every leg, gives you a straight verdict, and tracks the bet here with the rest of yours.</div>`;
  main.innerHTML = head + uploadPanel() + editor() + results();
}

// ---------------- events ----------------
function setImage(file) {
  if (!file || !/^image\//.test(file.type)) { st.err = 'That file isn\'t an image. Use a screenshot (PNG or JPG).'; rerender(); return; }
  if (st.imgURL) try { URL.revokeObjectURL(st.imgURL); } catch (e) {}
  st.img = file; st.imgURL = URL.createObjectURL(file); st.err = ''; rerender();
}
document.addEventListener('change', e => {
  const t = e.target; if (!t.closest || !t.closest('#main')) return;
  if (t.id === 'scFile') { setImage(t.files && t.files[0]); return; }
  if (t.dataset && t.dataset.scF && st.slip) { const i = +t.closest('.sc-leg').dataset.i; st.slip.legs[i][t.dataset.scF] = t.value; saveDraft(); }
});
document.addEventListener('input', e => {
  const t = e.target; if (!t.closest || !t.closest('#main') || !st.slip) return;
  if (t.dataset.scF) { const i = +t.closest('.sc-leg').dataset.i; st.slip.legs[i][t.dataset.scF] = t.value; saveDraft(); }
  else if (t.dataset.scS) { const k = t.dataset.scS; st.slip[k] = k === 'stake' ? num(t.value) : t.value; saveDraft(); }
});
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-sc-read],[data-sc-stop],[data-sc-manual],[data-sc-add],[data-sc-del],[data-sc-go],[data-sc-track],[data-sc-build],[data-sc-sim],[data-sc-take],[data-sc-take-stop]');
  if (!t || !t.closest('#main')) return;
  const d = t.dataset;
  if (d.scRead != null) { readSlip(); return; }
  if (d.scStop != null) { if (st.ctl) st.ctl.abort(); return; }
  if (d.scTakeStop != null) { if (st.takeCtl) st.takeCtl.abort(); return; }
  if (d.scManual != null) { st.slip = { book: '', betType: 'parlay', stake: null, totalOdds: '', payout: null, legs: [blankLeg()], notes: '', byAI: false }; st.A = null; st.take = ''; st.err = ''; st.phase = 'read'; saveDraft(); rerender();
    setTimeout(() => { const el = document.getElementById('sc-ev-0'); if (el) el.focus(); }, 0); return; }
  if (d.scAdd != null) { st.slip.legs.push(blankLeg()); saveDraft(); rerender(); const n = st.slip.legs.length - 1; setTimeout(() => { const el = document.getElementById('sc-ev-' + n); if (el) el.focus(); }, 0); return; }
  if (d.scDel != null) { st.slip.legs.splice(+d.scDel, 1); if (!st.slip.legs.length) st.slip.legs.push(blankLeg()); st.A = st.A ? analyze(st.slip) : null; saveDraft(); rerender(); return; }
  if (d.scGo != null) { st.A = analyze(st.slip); st.take = ''; st.takeState = 'idle'; rerender(); setTimeout(() => { const v = document.querySelector('#main .sc-verdict'); if (v) v.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 0); return; }
  if (d.scTrack != null) { track(); return; }
  if (d.scBuild != null) { const L = builderLegs(); if (!L.length) return; (SB.replaceSlip || SB.setSlip)(L, L[0].gid + '|' + L[0].key); SB.openSlip(); return; }
  if (d.scSim != null) { const L = builderLegs(); if (L.length) SB.goTab('sim', { legs: L, title: `${st.slip.book || 'Slip'} check`, from: 'slipcheck', p: st.A.p }); return; }
  if (d.scTake != null) { claudeTake(); return; }
});
document.addEventListener('dragover', e => { const z = e.target.closest && e.target.closest('.sc-drop'); if (z) { e.preventDefault(); z.classList.add('over'); } });
document.addEventListener('dragleave', e => { const z = e.target.closest && e.target.closest('.sc-drop'); if (z) z.classList.remove('over'); });
document.addEventListener('drop', e => { const z = e.target.closest && e.target.closest('.sc-drop'); if (!z) return; e.preventDefault(); z.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setImage(f); });
document.addEventListener('paste', e => { if (activeTab() !== 'slipcheck') return; const it = [...((e.clipboardData && e.clipboardData.items) || [])].find(x => x.kind === 'file' && /^image\//.test(x.type)); if (it) { e.preventDefault(); setImage(it.getAsFile()); } });
SB.on('data', () => { if (st.A && st.slip) { st.A = analyze(st.slip); rerender(); } });

// ---------------- styles (tokens only) ----------------
const css = document.createElement('style');
css.textContent = `
.sc-lead{margin:-4px 2px 12px}
.sc-up{display:grid;gap:12px}
.sc-drop{position:relative;display:grid;place-items:center;gap:6px;text-align:center;min-height:150px;padding:18px;border:1.5px dashed var(--edge);border-radius:8px;background:var(--card-hi);cursor:pointer;color:var(--mute)}
.sc-drop:hover,.sc-drop.over{border-color:var(--glow);background:var(--bluebg)}
.sc-drop:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.sc-drop b{color:var(--text);font-size:16px;font-style:italic}
.sc-drop span{font-size:13px}
.sc-drop.has{min-height:0;padding:8px}
.sc-drop img{max-height:340px;max-width:100%;border-radius:6px;display:block}
.sc-drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}
.sc-ico svg{width:34px;height:34px;fill:none;stroke:var(--cyan);stroke-width:1.6;stroke-linejoin:round}
.sc-btns{display:flex;gap:8px;flex-wrap:wrap}.sc-btns .btn{flex:1 1 140px;min-height:44px;padding:11px 10px;font-size:13.5px}
.sc-status{font-size:14px;color:var(--blue-ink)}.sc-err{color:var(--no)}
.sc-link{background:none;border:0;color:var(--blue);text-decoration:underline;font:inherit;cursor:pointer;min-height:32px;padding:0 6px}
.sc-ed{display:grid;gap:12px}
.sc-top{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:8px}
.sc-top label{display:grid;gap:4px;font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;min-width:0}
.sc-in{width:100%;min-width:0;min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:500 15px var(--f);padding:8px 10px}
.sc-in:focus{border-color:var(--glow);outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--glow) 35%,transparent)}
.sc-leg{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--line)}
.sc-r1{display:flex;gap:8px;align-items:center}.sc-r1 .sc-in{flex:1}
.sc-r2{display:grid;grid-template-columns:1.2fr 1.4fr .7fr .8fr .8fr;gap:6px}
.sc-r3{font-size:13px}
.sc-m.ok{color:var(--yes)}.sc-m.no{color:var(--amber)}
.sc-x{flex:none;width:44px;height:44px;border:1px solid var(--line);background:var(--card);color:var(--mute);border-radius:5px;cursor:pointer}
.sc-op{font-size:15px;line-height:1.5;margin-top:10px;color:var(--text)}
.sc-ai{color:var(--blue-ink);white-space:pre-wrap}.sc-ai:empty{display:none}
.sc-take{margin-top:12px;display:grid;gap:6px;justify-items:start}
.sc-verdict .kpis{margin-top:12px}
.sc-tbl{display:grid;font-size:13.5px;overflow-x:auto}
.sc-tr{display:grid;grid-template-columns:minmax(0,2.4fr) repeat(4,minmax(52px,.8fr));gap:6px;padding:9px 0;border-top:1px solid var(--line);align-items:center}
.sc-tr>span:not(:first-child){text-align:right}
.sc-tr small{display:block;color:var(--dim);font-size:12px}
.sc-th{border-top:0;color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.08em}
.sc-tf{border-top:1px solid var(--edge)}
.sc-un b{color:var(--mute)}
.sc-pos{color:var(--yes)}.sc-neg{color:var(--no)}
.sc-inj{display:block;font-style:normal;font-size:12.5px;color:var(--amber);margin-top:2px}
.sc-why{display:grid;gap:12px}@media(min-width:700px){.sc-why{grid-template-columns:1fr 1fr}}
.sc-why ul{margin:8px 0 0 18px;display:grid;gap:6px;font-size:14px;color:var(--mute)}
.sc-wt{font-size:15px}
.sc-legs .legp{display:grid;justify-items:end;align-content:start;text-align:right;flex:none}.sc-legs .legp small{display:block}
@media(max-width:520px){.sc-r2{grid-template-columns:1fr 1fr 1fr}.sc-r2 .sc-in:nth-child(1),.sc-r2 .sc-in:nth-child(2){grid-column:span 3}.sc-top{grid-template-columns:1fr 1fr}.sc-top label:first-child{grid-column:span 2}}
`;
document.head.appendChild(css);

const TAB = { key: 'slipcheck', label: '📸 Slip Check', after: 'mine', render };
SB.registerTab(TAB);
SB.on('data', () => setTimeout(() => { if (!document.querySelector('#tabs [data-t="slipcheck"]')) SB.registerTab(TAB); }, 0));
window.__slipcheck = { analyze, matchLeg, cleanSlip, bookDec, scProb, scCore, opinion, reasons, PROMPT, get state() { return st; }, get ai() { return aiState; } };
})();
