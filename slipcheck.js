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
  ['double_chance', 'Double chance'], ['draw', 'Draw'], ['passing_yards', 'Passing yards'], ['rushing_yards', 'Rushing yards'], ['receiving_yards', 'Receiving yards'], ['receptions', 'Receptions'], ['anytime_td', 'Anytime touchdown'], ['player_other', 'Other player prop'], ['other', 'Other']];
const BOOK_PROP = new Set(['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'anytime_td']);  // priced from the odds typed on the slip when we have no model
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
// how well a player's name fits the pick text: 2 = the pick is just his name; 1 + length = his full name (two words or more) appears
// as whole words inside it, e.g. "25+ | Kaelon Black Rushing Yards"; 0 = no fit. A longer name wins over a shorter one it contains.
function nameFit(name, text) {
  const n = nameKey(name), t = typeof text === 'string' ? text : ''; if (!n || !t) return 0;
  if (n === t) return 1e6;
  return n.includes(' ') && (' ' + t + ' ').includes(' ' + n + ' ') ? n.length : 0;
}
function bestByName(items, nameOf, pick) { // the item whose name fits the pick text best, or null
  const t = nameKey(pick); let best = null, bs = 0;
  for (const it of items) { const s = nameFit(nameOf(it), t); if (s > bs) { bs = s; best = it; } }
  return best;
}
function findPlayer(name, stat) {
  const t = nameKey(name); if (!t) return null;
  const all = (SB.DATA && SB.DATA.players) || [], top = bestByName(all, p => p.name, name); if (!top) return null;
  const k = nameKey(top.name), P = all.filter(p => nameKey(p.name) === k);
  return P.find(p => p.stat === stat) || P[0] || null;
}
function findRotation(name) { // NBA rotation player via lottos.js (team model), for points lines not in props.json
  const L = window.__lottos; if (!L || !L.ROLES) return null; if (!nameKey(name)) return null;
  let best = null, bs = 0;
  for (const abbr of Object.keys(L.ROLES.teams || {})) { const m = L.teamModel(abbr); for (const x of m.players) { const s = nameFit(x.name, nameKey(name)); if (s > bs) { bs = s; best = x; } } if (bs >= 1e6) break; }
  return best;
}
// "25+" printed on a slip means 25 or more: over 24.5. Returns { side, line } for the leg, read from the pick text when it has "N+".
function plusLine(leg, side, line) {
  const m = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*\+(?![\d])/.exec(String(leg.pick ?? '')); if (!m || side === 'U') return { side, line };
  const n = parseFloat(m[1]);
  if (line == null || Math.abs(line - n) < 1e-9) return { side: 'O', line: Number.isInteger(n) ? n - 0.5 : n };
  return { side: side || 'O', line };
}
function psPlayer(pick) { // the playerstats.json entry [name, stats] named in the pick text, or null
  return PS && PS.players ? bestByName(Object.entries(PS.players), e => e[0], str(pick)) : null;
}
function playerName(leg) { // the clean player name for a label: from playerstats.json or the props feed, else the pick as typed
  const h = psPlayer(leg.pick); if (h) return h[0];
  const p = findPlayer(leg.pick); return p ? p.name : str(leg.pick);
}
// Polymarket's own board: the snapshot keeps a game for a while after it starts, so its last prices stay available
function pmGameFor(g) {
  const P = window.__polymarket; if (!P || !P.PM) return null;
  for (const pg of P.PM.games || []) { try { const m = P.matchOf(pg); if (m && m.g && m.g.id === g.id) return { pg, swap: !!m.swap }; } catch (e) { /* skip */ } }
  return null;
}
function pmPriceFor(g, side) { // side 'H' or 'A' (our game's sides): the last Polymarket moneyline price we have for that team
  const m = pmGameFor(g); if (!m || !m.pg.ml) return null;
  const key = (side === 'H') !== m.swap ? 'home' : 'away', q = m.pg.ml[key];
  return q && q.m != null ? { price: q.m, seen: m.pg.seen || null, stale: !!m.pg.stale } : null;
}
function findPM(leg) { // a Polymarket game named in this leg (for the message when our feed doesn't have the game)
  const P = window.__polymarket; if (!P || !P.PM) return null;
  const text = N(`${leg.event} ${leg.pick} ${leg.sel || ''}`);
  return (P.PM.games || []).find(pg => teamScore(pg.home, text) + teamScore(pg.away, text) >= 4) || null;
}
function pmSeenText(x) { return x.stale && x.seen ? `as of ${new Date(x.seen).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} before tip-off` : 'live'; }
function startedWhy(g, key) {
  const m = /^SC:ml:([HA])$/.exec(key || ''), pm = m ? pmPriceFor(g, m[1]) : null;
  if (pm) return `Started. Last Polymarket price for this team: ${Math.round(pm.price * 100)}¢ (${pmSeenText(pm)}). No live price here, so it can't be scored yet.`;
  return 'Game already started: no pre-game price, and no Polymarket price saved for it';
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
function bookLeg(out, g, leg, mk, side, line, dec, pOverride) { // a leg priced from the odds on the slip, or from the player model
  out.g = g; out.bookOnly = true;
  const sideTxt = side === 'O' ? 'over' : side === 'U' ? 'under' : '';
  const who = STAT[mk] || mk === 'player_other' || BOOK_PROP.has(mk) ? playerName(leg) : str(leg.pick);
  out.label = [who, sideTxt, line != null ? String(line) : '', mk === 'player_other' ? 'prop' : marketName(mk)].filter(Boolean).join(' ');
  out.key = `B:${mk}:${side || '-'}:${line != null ? line : '-'}:${N(str(leg.pick)).replace(/\s+/g, '-')}`;
  if (mk === 'moneyline') { const sd = sideOf(g, `${str(leg.pick)} ${str(leg.sel)}`); if (sd) out.gameKey = `SC:ml:${sd}`; }
  out.p = pOverride != null ? pOverride : Math.min(0.999, 1 / dec);
  out.status = 'matched';
  return out;
}
// chance a player leg hits from the player model alone (yards: normal; touchdown: Poisson), or null when there is no model
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function playerProb(leg, g, side, line) {
  const key = `B:${leg.market}:${side || '-'}:${line != null ? line : 0}:x`;
  if (line == null && leg.market !== 'anytime_td') return null;  // a yards leg needs its line
  const pm = playerModel({ src: leg, g, key }); if (!pm) return null;
  if (pm.td) return Math.min(0.999, 1 - Math.exp(-pm.mean));
  const z = (pm.line - pm.mean) / Math.max(1e-6, pm.sd), underCdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return Math.min(0.999, Math.max(0.001, pm.over ? 1 - underCdf : underCdf));
}
function matchLeg(leg) {
  const out = { status: 'none', g: null, key: null, label: '', p: 0, why: '' };
  const mk = MARKET_IDS.includes(leg.market) ? leg.market : 'other';
  let side = /^under$/i.test(leg.side) ? 'U' : /^over$/i.test(leg.side) ? 'O' : null;
  let line = num(leg.line);
  // player props
  if (STAT[mk] || mk === 'player_other' || BOOK_PROP.has(mk)) {
    if (mk !== 'anytime_td') ({ side, line } = plusLine(leg, side, line));
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
    if (!out.key) {
      const g = out.g || findGame(leg), dec = bookDec(leg.odds);
      const pmv = g ? playerProb(leg, g, side, line) : null;
      if (g && pmv != null) return bookLeg(out, g, leg, mk, side, line, dec, pmv);  // no odds needed: our player model prices it
      if (g && dec) return bookLeg(out, g, leg, mk, side, line, dec);  // no model: the book's price on the slip prices it
      out.g = g; out.status = g ? 'game' : 'none';
      if (g && !dec && (BOOK_PROP.has(mk) || mk === 'player_other')) out.why = 'No model for this prop. Type the book\'s odds (e.g. +150) to price it.';
      return out;
    }
  } else {
    const g = findGame(leg); out.g = g;
    if (!g) { out.why = findPM(leg) ? 'On Polymarket, but not in our games feed yet. Try again after the feed refreshes.' : 'Game not found in our games feed or on Polymarket'; return out; }
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
  if (!SB.priced(out.g) && !/^[PUL]:/.test(out.key) && mk === 'moneyline' && pmPriceFor(out.g, sideOf(out.g, `${leg.pick} ${leg.sel || ''}`))) {
    const sd = sideOf(out.g, `${leg.pick} ${leg.sel || ''}`), pm = pmPriceFor(out.g, sd);
    const r0 = bookLeg(out, out.g, leg, mk, null, null, null, pm.price); r0.gameKey = `SC:ml:${sd}`;
    r0.why = pm.stale ? `Priced by Polymarket (${pmSeenText(pm)}); the feed hasn't priced this game yet.` : 'Priced by Polymarket; the feed hasn\'t priced this game yet.';
    return r0;
  }
  if (!SB.priced(out.g) && !/^[PUL]:/.test(out.key)) { out.status = 'game'; out.why = SB.started(out.g) ? startedWhy(out.g, out.key) : 'No price for this game yet'; return out; }
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
      if (GOALS.has(g.sport) && !rs.some(r => /^B:/.test(r.key))) { try { gp = SB.probOf(g, rs.map(r => r.key)); } catch (e) { gp = indep; } }
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
  // a priced leg keeps only a note about where its price came from, never an old "not priced" message
  const rows = slip.legs.map((L, i) => { const m = matchLeg(L); return { ...m, why: m.status === 'matched' && !/^Priced by Polymarket/.test(m.why || '') ? '' : m.why, i, src: L, dec: bookDec(L.odds), text: legText(L) }; });
  // Fallback, so no leg is left blank: a leg with no stats and no odds gets the chance left over from the slip's own parlay price
  // after the legs we could price (parlay chance ÷ the priced legs, spread evenly over the rest). Labelled as a fallback.
  { const anyG = rows.find(r => r.g), stub = r => r.g || { id: `fallback-${r.i}`, sport: 'other', comp: '', start: anyG ? anyG.g.start : new Date().toISOString(), home: { abbr: '—', name: '' }, away: { abbr: '—', name: '' } };
    for (const r of rows) if (r.status !== 'matched' && bookDec(r.src.odds)) {  // its own odds on the slip
      r.status = 'matched'; r.p = Math.min(0.999, 1 / bookDec(r.src.odds)); r.bookOnly = true; r.ownOdds = true; r.label = r.label || r.text; r.key = r.key || `X:odds:${r.i}`; r.g = stub(r);
      r.why = 'Priced from its own odds on the slip: no stats for this leg';
    }
    const tot = bookDec(slip.totalOdds), rest = rows.filter(r => r.status !== 'matched');
    if (tot && rest.length) {
      const known = rows.filter(r => r.status === 'matched').reduce((x, r) => x * r.p, 1);
      const pf = Math.min(0.95, Math.max(0.02, Math.pow((1 / tot) / Math.max(known, 1e-9), 1 / rest.length)));
      for (const r of rest) {
        r.status = 'matched'; r.p = pf; r.bookOnly = true; r.fallback = true; r.label = r.label || r.text; r.key = r.key || `X:fallback:${r.i}`; r.g = stub(r);
        r.why = `Fallback: worked out from the slip's ${str(slip.totalOdds)} after the legs we could price, because there are no stats or odds for this leg`;
      }
    } }
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
    if (r.fallback) not.push(`${r.label}: estimated from the slip's total price (no stats or odds for this leg)`);
    else if (r.ownOdds) not.push(`${r.label}: priced from its own odds only (no stats for this leg)`);
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
const st = { img: null, imgURL: null, slip: store.get('sc.draft', null), phase: 'idle', err: '', A: null, ctl: null, take: '', takeState: 'idle', takeCtl: null, simRes: null, simBusy: false };
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
 "legs": [{"sport": "nba"|"nfl"|"ncaaf"|"nhl"|"soccer"|"mlb"|"mma"|"other", "event": "Away Team @ Home Team or Team A vs Team B as printed", "market": "moneyline"|"spread"|"total"|"player_points"|"player_rebounds"|"player_assists"|"passing_yards"|"rushing_yards"|"receiving_yards"|"receptions"|"anytime_td"|"player_other"|"player_other"|"btts"|"correct_score"|"double_chance"|"draw"|"other", "selection": "the pick as printed", "team": string|null, "player": string|null, "side": "over"|"under"|null, "line": number|null, "odds": string|null (as printed), "confidence": number between 0 and 1}],
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
    // legs our engine can settle grade themselves; legs priced from a player model, their own odds or the fallback are graded by hand
    if (r.status === 'matched' && !/^(B|X):/.test(r.key)) return { gid: g.id, key: r.key, label: r.label, p1: r.p, ...base, bookOdds: r.src.odds || null };
    const real = g && !/^fallback-/.test(g.id);
    return { gid: real ? g.id : `x-${now}-${i}`, key: xKey(r.text), label: r.label || r.text, custom: true, ...(r.status === 'matched' ? { p1: r.p } : {}), ...(real ? base : {}), bookOdds: r.src.odds || null };
  });
  const dec = A.bookTot || null;
  const ok = SB.saveParlay ? SB.saveParlay({ legs, p: A.M.length ? A.p : null, odds: dec ? SB.dec2am(dec) : null, dec, stake: A.stake, book: st.slip.book || null, src: 'slipcheck', partial: !A.full }) : false;
  SB.toast(ok ? `Tracking in My Parlays${st.slip.book ? ' · ' + esc(st.slip.book) : ''}` : 'Couldn\'t save this bet');
}
function builderLegs() { return st.A ? st.A.M.filter(r => !/^(B|X):/.test(r.key) && !SB.started(r.g)).map(r => ({ gid: r.g.id, key: r.key })) : []; }  // only legs the builder can price

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
// ---------------- simulate the slip: 500,000 runs ----------------
const SIM_RUNS = 500000, MARGIN_SPORTS = new Set(['nba', 'nfl', 'ncaaf']);
const PSTAT = { passing_yards: 'passing_yards', rushing_yards: 'rushing_yards', receiving_yards: 'receiving_yards', anytime_td: 'anytime_td' };
let PS = null;  // playerstats.json: per-game averages and each team's defence (see the file's note)
fetch('playerstats.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => { PS = d; });
// A player leg's model: his average, scaled by the opponent's defence against that stat (league average = 1) and by the game's total
// in each run. Returns null when the player or the stat isn't in the file.
function playerModel(r) {
  if (!PS || !PS.players || !r.src) return null;
  const hit = psPlayer(r.src.pick);
  // "Other player prop" takes the stat from the player's entry; the named markets must match it
  const mk = r.src.market === 'player_other' ? (hit && hit[1].stat) : r.src.market;
  if (!hit || !PSTAT[mk] || hit[1].stat !== mk) return null;
  const [name, p] = hit, opp = p.team === r.g.home.abbr ? r.g.away.abbr : r.g.home.abbr, D = PS.defense && PS.defense[opp], L = PS.league;
  if (!D || !L) return null;
  const passF = D.passYdsAllowed / L.passYds, rushF = D.rushYdsAllowed / L.rushYds;
  const dfac = p.stat === 'rushing_yards' ? rushF : p.stat === 'anytime_td' ? (passF + rushF) / 2 : passF;  // defence used for each stat
  const parts = str(r.key).split(':'), side = parts[2], line = parseFloat(parts[3]);
  // injuries: out = he doesn't play, doubtful = a quarter of his usual output, questionable = 85%
  const INJ = window.__lottos && window.__lottos.INJ, inj = INJ && (INJ.injuries || []).find(x => nameKey(x.player) === nameKey(name));
  const injF = !inj ? 1 : inj.status === 'out' ? 0 : inj.status === 'doubtful' ? 0.25 : inj.status === 'questionable' ? 0.85 : 1;
  return { name, mean: p.mean * dfac * injF, sd: p.sd * (injF > 0 ? Math.sqrt(injF) : 0), td: p.stat === 'anytime_td', rush: p.stat === 'rushing_yards', over: side !== 'U', line: isFinite(line) ? line : 0,
    opp, dfac, inj: inj ? String(inj.status) : '', home: p.team === r.g.home.abbr, sport: r.g.sport };
}
// the game model: from the feed's prices, or from Polymarket's moneyline and total when the feed hasn't priced the game yet
function simModelGame(g, N) {
  if (g.prob) return SB.simGame(g, N);
  const m = pmGameFor(g); if (!m || !m.pg.ml || !m.pg.ml.home || !m.pg.ml.away) return null;
  const hq = m.swap ? m.pg.ml.away : m.pg.ml.home, aq = m.swap ? m.pg.ml.home : m.pg.ml.away;
  if (!(hq.m > 0) || !(aq.m > 0)) return null;
  const tot = (m.pg.totals || []).slice().sort((x, y) => (y.v || 0) - (x.v || 0))[0];
  return SB.simGame({ ...g, prob: { home: hq.m, away: aq.m }, total: tot && tot.line > 0 ? tot.line : undefined }, N);
}
// Each run plays the game once: a leg with a game model (moneyline, spread, total in the margin sports) is read from that run,
// so legs from the same game move together. A player leg with a model is simulated from his average, the opponent's defence and that
// run's game total. Other legs (book prices, soccer, NHL) are drawn at their own chance each run. Unpriced legs aren't in the run.
function simulateSlip(A, N = SIM_RUNS) {
  const legs = (A.M || []).filter(r => r.g);
  if (!legs.length) return null;
  const games = new Map(), gameOf = r => (MARGIN_SPORTS.has(r.g.sport) ? games.get(r.g.id) || null : null);
  const pms = legs.map(r => (MARGIN_SPORTS.has(r.g.sport) && !/^SC:/.test(r.key) ? playerModel(r) : null));
  for (let k = 0; k < legs.length; k++) {
    const r = legs[k], gk = r.gameKey || r.key, isGame = MARGIN_SPORTS.has(r.g.sport) && /^SC:(ml|sp|tot):/.test(gk);
    if (!(isGame || pms[k])) continue;
    if (!games.has(r.g.id)) { const S = simModelGame(r.g, N); games.set(r.g.id, S ? { S, legs: [], fns: [] } : null); }
    const G = games.get(r.g.id);
    if (G && isGame) { G.legs.push(r); G.fns.push(scCore(gk)); }
  }
  const meta = legs.map((r, k) => {
    const G = gameOf(r);
    if (G && G.legs.includes(r)) return { type: 'game', S: G.S, f: G.fns[G.legs.indexOf(r)] };
    if (G && pms[k]) return { type: 'player', S: G.S, pm: pms[k], avgT: G.S.tt.reduce((x, y) => x + y, 0) / N };
    if (pms[k]) return { type: 'player', S: null, pm: pms[k], avgT: 1 };  // the game has no model: no game-total swings
    return null;
  });
  const rnd = SB.rng(0x51ab + legs.length * 7919), legHits = new Array(legs.length).fill(0);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let hits = 0;
  for (let i = 0; i < N; i++) {
    let ok = true;
    for (let k = 0; k < legs.length; k++) {
      const mt = meta[k]; let pass;
      if (mt && mt.type === 'game') { const v = mt.f(mt.S.mg[i], mt.S.tt[i]); pass = v === null || v === 1; }
      else if (mt && mt.type === 'player') {
        const pm = mt.pm; let scale = mt.S ? mt.S.tt[i] / mt.avgT : 1;   // this run's game total relative to the average game
        if (mt.S) {  // blowouts: the leading side's starters sit late; the trailing side throws more and runs less
          const lead = pm.home ? mt.S.mg[i] : -mt.S.mg[i], big = pm.sport === 'nba' ? 20 : 17;
          if (lead >= big) scale *= pm.td ? 1 : 0.8;
          else if (lead <= -big) scale *= pm.td ? 1 : pm.rush ? 0.85 : 1.1;
        }
        if (pm.td) pass = rnd() < 1 - Math.exp(-pm.mean * scale);
        else { const v = Math.max(0, pm.mean * scale + pm.sd * gauss()); pass = pm.over ? v > pm.line : v < pm.line; }
      } else pass = rnd() < legs[k].p;
      if (pass) legHits[k]++; else ok = false;
    }
    if (ok) hits++;
  }
  const rate = hits / N, simmed = [...games.values()].filter(Boolean).length;
  return { N, hits, rate, ci: 1.96 * Math.sqrt(rate * (1 - rate) / N), sig: A.rows.map(r => r.text).join('|'),
    joint: A.p, book: A.decCmp ? 1 / A.decCmp : null, gamesSimmed: simmed, unpriced: (A.U || []).length,
    legs: legs.map((r, k) => {
      const mt = meta[k];
      const how = !mt ? 'drawn at its own chance (no model)' : mt.type === 'game' ? 'game simulation'
        : `${!mt.S ? 'no game model yet · ' : ''}${mt.pm.inj ? `listed ${mt.pm.inj.toUpperCase()} · ` : ''}${mt.pm.name}: average ${mt.pm.mean.toFixed(1)}${mt.pm.td ? ' TDs' : ' yds'} vs ${mt.pm.opp} (${Math.round(mt.pm.dfac * 100)}% of league average defence)`;
      return { label: r.label, rate: legHits[k] / N, how };
    }) };
}
function simBlock(A) {
  const sig = A.rows.map(r => r.text).join('|'), R = st.simRes && st.simRes.sig === sig ? st.simRes : null;
  const busy = st.simBusy, ready = A.M.length > 0;
  const btn = `<button class="btn" data-sc-simrun ${busy || !ready ? 'disabled' : ''}>${busy ? 'Simulating 500,000 runs…' : R ? 'Run 500,000 again' : 'Simulate 500,000 runs'}</button>`;
  let body = ready ? '' : '<div class="why">Add priced legs first: the simulation needs at least one leg we can price.</div>';
  if (R) body = `<div class="kpis"><div class="kpi"><b class="mono">${pctS(R.rate, 2)}</b><span>sim hit rate</span></div>
      <div class="kpi"><b class="mono">±${(R.ci * 100).toFixed(2)}</b><span>95% range, points</span></div>
      <div class="kpi"><b class="mono">${pctS(R.joint)}</b><span>our analytic estimate</span></div>
      <div class="kpi"><b class="mono">${R.book != null ? pctS(R.book) : '—'}</b><span>book price implies</span></div></div>
    <div class="kvs"><div class="kv kpos"><span>Hit: all legs landed</span><b>${R.hits.toLocaleString()} of ${R.N.toLocaleString()} runs</b></div><div class="kv kneg"><span>Missed: at least one leg lost</span><b>${(R.N - R.hits).toLocaleString()} of ${R.N.toLocaleString()} runs</b></div></div>
    <div class="sc-tbl">${R.legs.map(l => `<div class="sc-tr"><span><b>${esc(l.label)}</b><small>${esc(l.how)}</small></span><span class="mono">${pctS(l.rate, 1)}</span></div>`).join('')}</div>
    <div class="note">${R.gamesSimmed} game${R.gamesSimmed === 1 ? '' : 's'} simulated ${R.N.toLocaleString()} times each.${R.unpriced ? ` ${R.unpriced} leg${R.unpriced === 1 ? '' : 's'} we couldn't price ${R.unpriced === 1 ? 'is' : 'are'} not in this run.` : ''} This is how often the slip lands in the simulation, not a guarantee.</div>`;
  return `<div class="pc sc-sim"><div class="pchead"><span class="pctitle">Simulate the slip</span>${btn}</div>${body}</div>`;
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
      <span>${esc(`${r.g.away.abbr} @ ${r.g.home.abbr}`)} · ${esc(SB.when(r.g))}</span>${r.inj ? `<em class="sc-inj">🚑 ${esc(r.inj)}</em>` : ''}${r.bookOnly ? '<em class="sc-inj">Priced from the odds on your slip: no model for this prop yet</em>' : ''}</div><span class="legp mono">${pctS(r.p, 0)}<small>${esc(SB.fmtOdds(r.p))}</small></span></div>`).join('') || '<div class="why">No priced legs yet.</div>'}
    ${A.corr.map(c => `<div class="note">${esc(`${c.g.away.abbr} @ ${c.g.home.abbr}`)}: ${c.n} legs from the same game, ${c.ratio > 1.02 ? 'they tend to hit together' : c.ratio < 0.98 ? 'they work against each other' : 'close to unrelated'} (${pctS(A.groups.find(G => G.g === c.g).p)} together vs ${pctS(A.groups.find(G => G.g === c.g).indep)} if unrelated).</div>`).join('')}</div>`;
  const why = `<h2>3 · Why it will or won't hit</h2><div class="sc-why"><div class="pc"><div class="pctitle sc-wt sc-pos">Why it can hit</div><ul>${R.can.map(x => `<li>${esc(x)}</li>`).join('') || '<li>Nothing stands out in its favour.</li>'}</ul></div>
    <div class="pc"><div class="pctitle sc-wt sc-neg">Why it might not</div><ul>${R.not.map(x => `<li>${esc(x)}</li>`).join('') || '<li>No clear weak spot.</li>'}</ul></div></div>`;
  const bl = builderLegs();
  const act = `<h2>4 · Track it here <small>all your bets in one app</small></h2><div class="pc"><div class="sc-btns">
    <button class="btn" data-sc-track>Track this bet</button>
    <button class="btn ghost" data-sc-build ${bl.length ? '' : 'disabled'}>Open in builder</button>
    ${document.querySelector('#tabs [data-t="sim"]') && bl.length ? '<button class="btn ghost" data-sc-sim>Open in game simulator</button>' : ''}</div>
    <div class="note">Track saves the whole slip to My Parlays with ${st.slip.book ? esc(st.slip.book) + "'s" : 'the book\'s'} odds and your stake. Legs we price grade themselves when games finish; the others get ✓ / ✗ buttons. My Parlays is saved on this device.</div></div>`;
  return cmp + simBlock(A) + verdict + legsA + injuryWorry(A) + why + act;
}
// ---------------- injury worry: who is out or doubtful in the games on this slip ----------------
function injuryWorry(A) {
  const L = window.__lottos, INJ = L && L.INJ;
  const games = [...new Set((A.groups || []).map(G => G.g).filter(Boolean))];
  if (!games.length) return '';
  const hrs = INJ && INJ.updated ? (Date.now() - Date.parse(INJ.updated)) / 3600e3 : null;
  const fresh = !INJ ? 'The injury file did not load, so there is no injury check.'
    : hrs != null && hrs <= 24 ? `Injury file updated ${esc(new Date(INJ.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}.`
    : `Injury file last updated ${esc(INJ ? new Date(INJ.updated).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '')}, so it may be out of date. Check today's reports before you bet.`;
  const legNames = (A.M || []).map(r => String(r.label || '').toLowerCase());
  const cards = games.map(g => {
    const teams = [g.home, g.away].map(t => ({ t, xs: INJ ? INJ.injuries.filter(x => x.sport === g.sport && x.team === t.abbr && (x.status === 'out' || x.status === 'doubtful')) : [] }));
    const n = teams.reduce((s, x) => s + x.xs.length, 0), big = teams.some(x => x.xs.length >= 3);
    const level = big ? ['High', 'h-lo'] : n ? ['Watch', 'h-mid'] : ['Clear', 'h-hi'];
    const onSlip = x => legNames.some(l => l.includes(String(x.player).toLowerCase()));
    return `<div class="pc sc-worry"><div class="pchead"><span class="pctitle">${esc(`${g.away.abbr} @ ${g.home.abbr}`)}</span><span class="hit ${level[1]}">${level[0]} worry</span></div>
      ${teams.map(({ t, xs }) => `<div class="why"><b>${esc(t.abbr)}</b>: ${xs.length ? xs.map(x => `${esc(x.player)} (${esc(x.pos || '')}) ${esc(String(x.status).toUpperCase())}${x.injury ? ' · ' + esc(x.injury) : ''}${x.returnEst ? ' · ' + esc(x.returnEst) : ''}${onSlip(x) ? ' <span class="sc-neg">⚠ on your slip</span>' : ''}`).join('<br>') : 'nobody listed out or doubtful'}</div>`).join('')}
    </div>`;
  }).join('');
  return `<h2>2b · Injury worry <small>who is out or doubtful</small></h2><div class="sc-why"><div class="note" style="margin:0 0 8px">${fresh} Opponent form and benching against weaker teams aren't in our data yet, so that part is only as good as the research done for this slip.</div>${cards}</div>`;
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
  const t = e.target.closest && e.target.closest('[data-sc-read],[data-sc-stop],[data-sc-manual],[data-sc-add],[data-sc-del],[data-sc-go],[data-sc-track],[data-sc-build],[data-sc-sim],[data-sc-simrun],[data-sc-take],[data-sc-take-stop]');
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
  if (d.scSimrun != null) { if (st.simBusy) return; st.simBusy = true; rerender(); setTimeout(() => { const A = analyze(st.slip); st.simRes = simulateSlip(A); st.simBusy = false; rerender(); }, 30); return; }
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
window.__slipcheck = { analyze, matchLeg, cleanSlip, bookDec, scProb, scCore, opinion, reasons, injuryWorry, simulateSlip, playerProb, setPlayerStats: d => { PS = d; }, PROMPT, get state() { return st; }, get ai() { return aiState; } };
})();
