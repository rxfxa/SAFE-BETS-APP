/* soccer.js — "⚽ Soccer Parlays" tab for Safe Bets. A module on the window.SB v2 API (see the comment block in index.html).
   Owns: the league / section navigation, auto-built soccer parlays per market type, per-match market boards, and two custom
   leg types:
     G:<playerId>       anytime goalscorer          G:1st:<playerId>   first goalscorer
     SX:<HU|AU><line>   team under (e.g. SX:HU1.5 = home team scores at most 1) — the engine has team overs but no team unders.
   Every price is a model estimate. Same-game joints are exact sums over the engine's score grid (SB.scoreMatrix).

   ---------------- GOALSCORER MODEL ----------------
   Inputs per player (scorers.json): league goals, pos, status, optional mins / apps / pens; per team optional teamGoals /
   teamMatches. Per fixture, the engine's Dixon-Coles grid gives P(h,a), whose team marginals are Poisson(eh), Poisson(ea).

   1. Minutes played so far  mins = p.mins || p.apps*78 || teamMatches*90*0.85 (matches = team.teamMatches or the league's
      matchday at data time, LG_MP).
   2. Team goals per 90  tg90 = teamGoals/teamMatches when known, else the league average per team (LG_GPM).
   3. Raw on-pitch share  r = (goals*90/mins) / tg90.
   4. Shrink toward a position prior with 900 minutes of prior weight:
        sOn = (r*mins + PRIOR[pos]*900) / (mins + 900)          PRIOR = FW .22, AM .14, MF .08, DF .04, GK .002
      + PEN_BUMP (.025) for a penalty taker, capped at .6. A player with no goal total uses the prior only (shown, never auto-picked).
   5. Effective share of team goals  e = sOn * MINS[pos]   (expected share of the match he is on the pitch when he plays:
      FW .84, AM .84, MF .88, DF .93). If a team's listed players add up to more than .9, all are scaled down to .9.
   6. Availability  q = .92 if "active" (lineups not confirmed), .5 if "doubtful", 0 if "out" (excluded entirely).

   Given the team scores k goals and the players play, each goal is attributed independently to player i with prob e_i
   (multinomial; the rest go to unlisted players / own goals). So
        P(i scores | k)              = 1 - (1-e_i)^k
        P(all of set S score | k)    = sum over B ⊆ S of (-1)^|B| (1 - sum_{j in B} e_j)^k      (inclusion-exclusion)
        P(i scores first | h,a)      = e_i * h/(h+a)                     (first goal is a uniformly random one of the h+a)
        P(i first & S score | h,a)   = e_i * h/(h+a) * IE_{S\{i}}(h-1) * IE_{S_away}(a)   (i on the home side; mirror for away)
   and every factor is multiplied by the product of q over the distinct players involved. The engine sums these conditionals
   against P(h,a) (condMany), so any mix of scorer legs with match markets in one game is priced exactly under this model.
   Note on sign: given k, two teammates compete for the same goals (P(both|k) < P(A|k)·P(B|k)). Unconditionally the grid's
   team goals are Poisson, and Poisson thinning makes teammates' goal counts independent, so the joint ≈ the product of
   singles. Scorer + his team winning is strongly positive. */
(() => {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2)) { console.warn('soccer.js: window.SB v2 not found; Soccer Parlays disabled'); return; }
const { esc, pct, store } = SB;
const $main = () => document.getElementById('main');
const DAY = 864e5, WINDOW = 7 * DAY;

// ---------------- leagues ----------------
const normC = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LEAGUES = [
  { id: 'ucl', name: 'Champions League', aliases: ['champions league', 'uefa champions league', 'ucl'] },
  { id: 'epl', name: 'Premier League', aliases: ['premier league', 'english premier league', 'epl', 'barclays premier league'] },
  { id: 'laliga', name: 'La Liga', aliases: ['la liga', 'laliga', 'laliga ea sports', 'la liga ea sports', 'primera division', 'liga ea sports'] },
  { id: 'seriea', name: 'Serie A', aliases: ['serie a', 'serie a tim', 'serie a enilive', 'italian serie a'] },
  { id: 'bundesliga', name: 'Bundesliga', aliases: ['bundesliga', '1 bundesliga', 'german bundesliga'] },
  { id: 'ligue1', name: 'Ligue 1', aliases: ['ligue 1', 'ligue 1 mcdonalds', 'ligue 1 uber eats', 'french ligue 1'] },
  { id: 'uel', name: 'Europa League', aliases: ['europa league', 'uefa europa league', 'uel'] },
  { id: 'eredivisie', name: 'Eredivisie', aliases: ['eredivisie', 'dutch eredivisie', 'vriendenloterij eredivisie'] },
  { id: 'primeira', name: 'Primeira Liga', aliases: ['primeira liga', 'liga portugal', 'liga portugal betclic', 'liga nos', 'portuguese primeira liga'] },
  { id: 'mls', name: 'MLS', aliases: ['mls', 'major league soccer'] },
];
const ALIAS = new Map(); for (const L of LEAGUES) for (const a of L.aliases) ALIAS.set(normC(a), L);
const leagueOf = comp => ALIAS.get(normC(comp)) || { id: 'x-' + normC(comp).replace(/ /g, '-'), name: String(comp || 'Other'), other: true };
const UEFA = /champions|europa|conference|nations/;
// model constants by domestic league: average goals per team per match and league matches played when the data was taken
const LG_GPM = { epl: 1.4, laliga: 1.3, seriea: 1.3, bundesliga: 1.55, ligue1: 1.35, mls: 1.55, eredivisie: 1.6, primeira: 1.35, 'x-liga-mx': 1.4, 'x-eliteserien': 1.55, 'x-super-lig': 1.45, 'x-austrian-bundesliga': 1.55 };
const LG_MP = { epl: 11, laliga: 12, seriea: 11, bundesliga: 10, ligue1: 11, mls: 34, eredivisie: 12, primeira: 11, 'x-liga-mx': 16, 'x-eliteserien': 28, 'x-super-lig': 12, 'x-austrian-bundesliga': 13 };
const PRIOR = { FW: .22, AM: .14, MF: .08, DF: .04, GK: .002 }, MINS = { FW: .84, AM: .84, MF: .88, DF: .93, GK: .98 };
const PEN_BUMP = .025, PRIOR_MIN = 900, Q_ACTIVE = .92, Q_DOUBT = .5, TEAM_CAP = .9;

// ---------------- scorers.json index + team matching ----------------
const normT = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ssc', 'as', 'us', 'cd', 'ud', 'rc', 'rcd', 'sk', 'fk', 'bc', 'calcio', 'club', 'de', 'del', 'la', 'le', 'real', 'united', 'city', 'sporting', 'olympique', 'stade', 'racing', 'borussia', 'deportivo', 'atletico', 'inter', 'saint', 'st', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'cfc', 'sco', 'osc', 'and', 'the', 'hotspur', 'albion']);
const sig = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
let IDX = null, IDXsrc;
function idx() {
  const sc = SB.DATA.scorers; if (IDXsrc === sc) return IDX; IDXsrc = sc; IDX = null;
  if (!sc || !Array.isArray(sc.teams)) return null;
  const byName = new Map(), byAbbr = new Map(), players = new Map();
  for (const t of sc.teams) {
    if (!t || !t.team || !Array.isArray(t.players)) continue;
    byName.set(normT(t.team), t);
    const ab = String(t.abbr || '').toUpperCase(); if (!byAbbr.has(ab)) byAbbr.set(ab, []); byAbbr.get(ab).push(t);
    for (const p of t.players) if (p && p.id) players.set(String(p.id), { p, t });
  }
  return IDX = { byName, byAbbr, players, teams: sc.teams.filter(t => t && t.team && Array.isArray(t.players)) };
}
function teamFor(T, g) {
  const I = idx(); if (!I || !T) return null;
  const n = normT(T.name); if (I.byName.has(n)) return I.byName.get(n);
  const toks = sig(T.name), ab = I.byAbbr.get(String(T.abbr || '').toUpperCase()) || [];
  for (const t of ab) if (sig(t.team).some(x => toks.includes(x))) return t;   // same abbr + a shared name word
  const lg = leagueOf(g.comp).id, same = ab.filter(t => (t.comp || []).some(c => leagueOf(c).id === lg));
  if (same.length === 1) return same[0];                                         // same abbr in the same competition
  const tk = I.teams.filter(t => sig(t.team).some(x => x.length >= 5 && toks.includes(x)));
  return tk.length === 1 ? tk[0] : null;                                         // one unique distinctive word
}
const domestic = t => { const c = (t.comp || []).find(c => !UEFA.test(normC(c))) || (t.comp || [])[0] || ''; return leagueOf(c).id; };

// ---------------- per-game scorer model (cached per game object; game objects are replaced on every data load) ----------------
const MODEL = new WeakMap();
function sideModel(g, s) {
  const T = g[s], team = teamFor(T, g), out = { side: s, abbr: T.abbr, name: T.name, team, players: [], out: [] };
  if (!team) return out;
  const lg = domestic(team), mp = +team.teamMatches > 0 ? +team.teamMatches : (LG_MP[lg] || 12);
  const tg90 = +team.teamGoals > 0 && +team.teamMatches > 0 ? team.teamGoals / team.teamMatches : (LG_GPM[lg] || 1.4);
  for (const p of team.players) {
    if (!p || !p.id) continue;
    const st = String(p.status || 'active').toLowerCase();
    if (st === 'out' || st === 'injured' || st === 'suspended') { out.out.push(p); continue; }
    const pos = PRIOR[p.pos] != null ? p.pos : 'MF', prior = PRIOR[pos];
    const hasG = typeof p.goals === 'number' && isFinite(p.goals) && p.goals >= 0;
    const mins = +p.mins > 0 ? +p.mins : +p.apps > 0 ? p.apps * 78 : +p.starts > 0 ? p.starts * 85 : mp * 90 * .85;
    let sOn = hasG ? ((p.goals * 90 / mins) / tg90 * mins + prior * PRIOR_MIN) / (mins + PRIOR_MIN) : prior;
    if (p.pens === true) sOn += PEN_BUMP;
    sOn = Math.min(sOn, .6);
    out.players.push({ id: String(p.id), name: p.name || p.id, pos, goals: hasG ? p.goals : null, pens: p.pens === true, est: !!p.est,
      status: st === 'doubtful' ? 'doubtful' : 'active', note: p.note || '', priorOnly: !hasG, sOn, e: sOn * MINS[pos],
      q: st === 'doubtful' ? Q_DOUBT : Q_ACTIVE, side: s, abbr: T.abbr, gid: g.id });
  }
  const tot = out.players.reduce((a, x) => a + x.e, 0);
  if (tot > TEAM_CAP) for (const x of out.players) x.e *= TEAM_CAP / tot;
  return out;
}
function gm(g) {
  if (!g || g.sport !== 'soccer') return null;
  if (MODEL.has(g)) return MODEL.get(g);
  const M = SB.scoreMatrix(g), r = { M, home: sideModel(g, 'home'), away: sideModel(g, 'away'), byId: new Map() };
  for (const s of ['home', 'away']) for (const x of r[s].players) r.byId.set(x.id, x);
  MODEL.set(g, r); return r;
}
// IE table: T[k] = P(every player in the set scores | team scores k goals, all of them play)
function ieTable(es, n) {
  const T = new Float64Array(n + 1), m = Math.min(es.length, 14);
  for (let mask = 0; mask < (1 << m); mask++) {
    let s = 0, b = 0; for (let j = 0; j < m; j++) if (mask & (1 << j)) { s += es[j]; b++; }
    const sign = b & 1 ? -1 : 1, base = Math.max(0, 1 - s);
    let pw = 1; for (let k = 0; k <= n; k++) { T[k] += sign * pw; pw *= base; }
  }
  return T;
}
const parseG = key => { const r = String(key).slice(2); return r.startsWith('1st:') ? { first: true, id: r.slice(4) } : { first: false, id: r }; };
function gCondMany(g, keys) {
  const R = gm(g); if (!R || !R.M) return () => 0;
  const any = { home: [], away: [] }, firsts = [], used = new Map();
  for (const k of keys) {
    const { first, id } = parseG(k), x = R.byId.get(id); if (!x) return () => 0;
    used.set(id, x); if (first) firsts.push(x); else any[x.side].push(x);
  }
  if (firsts.length > 1) return () => 0; // two different players cannot both score the first goal
  let q = 1; for (const x of used.values()) q *= x.q;
  const n = R.M.n - 1, F = firsts[0] || null;
  const TH = ieTable(any.home.filter(x => !F || x.id !== F.id).map(x => x.e), n);
  const TA = ieTable(any.away.filter(x => !F || x.id !== F.id).map(x => x.e), n);
  if (!F) return (h, a) => q * TH[h] * TA[a];
  if (F.side === 'home') return (h, a) => h > 0 ? q * F.e * h / (h + a) * TH[h - 1] * TA[a] : 0;
  return (h, a) => a > 0 ? q * F.e * a / (h + a) * TH[h] * TA[a - 1] : 0;
}
function gridSum(g, f) { // sum over the score grid of P(h,a)·f(h,a)
  const M = SB.scoreMatrix(g); if (!M) return 0; const n = M.n, P = M.P; let s = 0;
  for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) { const p = P[h * n + a]; if (p > 0) s += p * f(h, a); }
  return Math.max(0, Math.min(1, s));
}
const G_HANDLER = {
  label(key, g) {
    const { first, id } = parseG(key), R = gm(g), x = R && R.byId.get(id);
    const I = idx(), rec = I && I.players.get(id), name = x ? x.name : rec ? rec.p.name : id, ab = x ? x.abbr : rec ? rec.t.abbr : '';
    return `${name}${ab ? ' (' + ab + ')' : ''} ${first ? 'first goalscorer' : 'to score'}`;
  },
  prob(g, key) { return gridSum(g, gCondMany(g, [key])); },
  condMany(g, keys) { return gCondMany(g, keys); },
  cond(g, key) { return gCondMany(g, [key]); },
};
// team unders (engine has team overs only)
const SXF = {};
for (const L of [.5, 1.5, 2.5]) { SXF['HU' + L] = (h) => h < L; SXF['AU' + L] = (h, a) => a < L; }
const SX_HANDLER = {
  label(key, g) { const k = String(key).slice(3), f = SXF[k]; if (!f || !g) return key; return `${k[0] === 'H' ? g.home.abbr : g.away.abbr} under ${k.slice(2)} goals`; },
  prob(g, key) { const f = SXF[String(key).slice(3)]; return f ? gridSum(g, (h, a) => f(h, a) ? 1 : 0) : 0; },
  cond(g, key) { const f = SXF[String(key).slice(3)]; return f ? (h, a) => f(h, a) ? 1 : 0 : () => 0; },
  settle(g, key, h, a) { const f = SXF[String(key).slice(3)]; return f ? !!f(h, a) : null; },
};
SB.registerLegType('G', G_HANDLER);
SB.registerLegType('SX', SX_HANDLER);

// ---------------- fixtures ----------------
const nowMs = () => Date.now();
function soccerGames() { return SB.DATA.games.filter(g => g.sport === 'soccer'); }
function upcoming() { return soccerGames().filter(g => SB.openG(g)).sort((a, b) => SB.startMs(a) - SB.startMs(b) || (a.id < b.id ? -1 : 1)); }
const inWindow = g => SB.priced(g) && SB.startMs(g) - nowMs() <= WINDOW;
function leagueList(up) {
  const counts = new Map(); for (const g of up) { const L = leagueOf(g.comp); counts.set(L.id, (counts.get(L.id) || 0) + 1); }
  const others = new Map(); for (const g of soccerGames()) { const L = leagueOf(g.comp); if (L.other && !others.has(L.id)) others.set(L.id, L); }
  return { top: LEAGUES.map(L => ({ ...L, n: counts.get(L.id) || 0 })), more: [...others.values()].map(L => ({ ...L, n: counts.get(L.id) || 0 })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)), counts };
}
const xg = g => { const M = SB.scoreMatrix(g); return M ? { eh: M.eh, ea: M.ea, t: M.eh + M.ea } : { eh: 0, ea: 0, t: 0 }; };
const f2 = x => x.toFixed(2);

// ---------------- sections ----------------
const SECS = [
  { id: 'overs', label: 'Overs', intro: 'Match and team goal overs. Hit chances come from the exact score grid fitted to each match\'s win chances.' },
  { id: 'unders', label: 'Unders', intro: 'Match and team unders. Strongest when both sides have low expected goals.' },
  { id: 'exact', label: 'Exact Score', intro: 'Correct scores. Even the most likely score lands only about 1 time in 8, so treat these as small-stake, lottery-style bets.' },
  { id: 'scorers', label: 'Goalscorers', intro: 'Anytime and first goalscorers from season goal shares and each match\'s expected goals.' },
  { id: 'btts', label: 'BTTS', intro: 'Both teams to score, yes or no, and BTTS & over 2.5.' },
  { id: 'results', label: 'Results', intro: 'Win / draw / win and double chance (1X2).' },
  { id: 'mega', label: 'League Mega Mix', intro: 'One leg per match from any market, picked by the same rules: strongest leg in each tier\'s chance band.' },
];
const SECMAP = Object.fromEntries(SECS.map(s => [s.id, s]));
const TIERS = [
  { name: 'Safer', lo: .72, hi: .9, min: 2, max: 3 },
  { name: 'Balanced', lo: .55, hi: .72, min: 2, max: 3 },
  { name: 'Long shot', lo: .3, hi: .55, min: 2, max: 3 },
];
const MEGA_TIERS = [
  { name: 'Safer', lo: .74, hi: .9, min: 3, max: 4 },
  { name: 'Balanced', lo: .56, hi: .74, min: 3, max: 4 },
  { name: 'Long shot', lo: .35, hi: .6, min: 3, max: 6 },
];
function mkLeg(g, key, why, fam, ord) { return { gid: g.id, key, label: SB.legLabel({ gid: g.id, key }), p: SB.p1(g, key), why, fam, ord }; }
function eligibleScorers(g) { const R = gm(g); if (!R || !R.M) return []; return [...R.home.players, ...R.away.players].filter(x => !x.priorOnly && x.status === 'active'); }
function scorerWhy(g, x) { const X = xg(g); return `${x.goals} league goal${x.goals === 1 ? '' : 's'} · ~${pct(x.e)} of ${x.abbr} goals when he plays · ${x.abbr} xG ${f2(x.side === 'home' ? X.eh : X.ea)}${x.est ? ' · older data' : ''}`; }
const CAND = {
  overs(g) { const X = xg(g), w = `xG ${f2(X.t)} (${g.home.abbr} ${f2(X.eh)} · ${g.away.abbr} ${f2(X.ea)})`;
    return ['O0.5', 'O1.5', 'O2.5', 'O3.5', 'O4.5', 'HO0.5', 'HO1.5', 'HO2.5', 'AO0.5', 'AO1.5', 'AO2.5'].map((k, i) => mkLeg(g, k, w, 'goals', i)); },
  unders(g) { const X = xg(g), w = `xG ${f2(X.t)} (${g.home.abbr} ${f2(X.eh)} · ${g.away.abbr} ${f2(X.ea)})`;
    return ['U1.5', 'U2.5', 'U3.5', 'U4.5', 'SX:HU0.5', 'SX:HU1.5', 'SX:HU2.5', 'SX:AU0.5', 'SX:AU1.5', 'SX:AU2.5'].map((k, i) => mkLeg(g, k, w, 'unders', i)); },
  btts(g) { const w = `${g.home.abbr} score ${pct(SB.p1(g, 'HO0.5'))} · ${g.away.abbr} score ${pct(SB.p1(g, 'AO0.5'))}`;
    return ['BTTS', 'BTTSN', 'BTTS&O2.5'].map((k, i) => mkLeg(g, k, w, 'btts', i)); },
  results(g) { const P = g.prob, t = P.home + P.away + (P.draw || 0), src = g.src === 'Sportradar' ? 'Sportradar' : 'Safe Bets estimate';
    const w = `${src}: ${g.home.abbr} ${pct(P.home / t)} · draw ${pct((P.draw || 0) / t)} · ${g.away.abbr} ${pct(P.away / t)}`;
    return ['H', 'D', 'A', 'DC1X', 'DCX2', 'DC12'].map((k, i) => mkLeg(g, k, w, 'result', i)); },
  exact(g) { return topScores(g, 1).map((c, i) => mkLeg(g, c.key, `Most likely score of this match${c.next ? ` · next: ${c.next}` : ''}`, 'cs', i)); },
  scorers(g) { return eligibleScorers(g).map((x, i) => mkLeg(g, 'G:' + x.id, scorerWhy(g, x), 'scorer', i)); },
  mega(g) {
    const L = [...CAND.results(g).filter(c => c.key !== 'D'), ...CAND.overs(g).filter(c => ['O1.5', 'O2.5', 'O3.5', 'HO0.5', 'AO0.5', 'HO1.5', 'AO1.5'].includes(c.key)),
      ...CAND.unders(g).filter(c => ['U2.5', 'U3.5', 'U4.5'].includes(c.key)), ...CAND.btts(g).filter(c => c.key !== 'BTTS&O2.5'), ...CAND.scorers(g)];
    return L.map((c, i) => ({ ...c, ord: i }));
  },
};
function topScores(g, n) {
  const M = SB.scoreMatrix(g); if (!M) return [];
  const c = []; for (let h = 0; h <= 4; h++) for (let a = 0; a <= 4; a++) c.push({ h, a, key: `CS${h}-${a}`, p: M.P[h * M.n + a] });
  c.sort((x, y) => y.p - x.p || x.h - y.h || x.a - y.a);
  return c.slice(0, n).map((x, i) => ({ ...x, next: c[i + 1] ? `${c[i + 1].h}-${c[i + 1].a} (${pct(c[i + 1].p, 1)})` : '' }));
}
const cmpId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// one leg per match: each match's strongest leg inside the band, then the strongest matches first (deterministic tie-breaks)
function buildTier(games, cands, T, opts = {}) {
  const per = [];
  for (const g of games) {
    const cs = cands(g).filter(c => c.p >= T.lo && c.p <= T.hi && c.p > 0).sort((a, b) => b.p - a.p || a.ord - b.ord);
    if (cs.length) per.push({ g, cs });
  }
  per.sort((a, b) => b.cs[0].p - a.cs[0].p || SB.startMs(a.g) - SB.startMs(b.g) || cmpId(a.g.id, b.g.id));
  const legs = [], fams = {};
  for (const { cs } of per) {
    if (legs.length >= T.max) break;
    let c = cs[0];
    if (opts.diverse) { const alt = cs.find(x => (fams[x.fam] || 0) < 2 && x.p >= cs[0].p - .05); if (alt) c = alt; }
    legs.push(c); fams[c.fam] = (fams[c.fam] || 0) + 1;
  }
  if (legs.length < T.min) return null;
  return legs;
}
function finish(id, title, legs, extra = {}) {
  if (!legs || !legs.length) return null;
  const pr = SB.parlayProb(legs.map(L => ({ gid: L.gid, key: L.key })));
  return { id, title, legs, p: pr.p, indep: pr.indep, ...extra };
}
function sgpScorerWin(games) {
  let best = null;
  for (const g of games) {
    const R = gm(g); if (!R || !R.M) continue;
    for (const [s, k] of [['home', 'H'], ['away', 'A']]) {
      const pw = SB.p1(g, k); if (pw < .45) continue;
      const xs = R[s].players.filter(x => !x.priorOnly && x.status === 'active').map(x => ({ x, p: SB.p1(g, 'G:' + x.id) })).sort((a, b) => b.p - a.p || cmpId(a.x.id, b.x.id));
      if (!xs.length) continue;
      const x = xs[0].x, j = SB.probOf(g, ['G:' + x.id, k]);
      if (j < .2 || j > .75) continue;
      if (!best || j > best.j + 1e-12 || (Math.abs(j - best.j) <= 1e-12 && SB.startMs(g) < SB.startMs(best.g))) best = { g, x, k, j };
    }
  }
  if (!best) return null;
  const { g, x, k } = best;
  return [mkLeg(g, 'G:' + x.id, scorerWhy(g, x), 'scorer', 0),
    mkLeg(g, k, `Same game: ${x.name} scoring and ${k === 'H' ? g.home.abbr : g.away.abbr} winning tend to happen together`, 'result', 1)];
}
// parlays for one section over a set of games (already filtered to the parlay window)
function sectionParlays(sec, games, scope) {
  const pre = `${scope}-${sec}`, S = SECMAP[sec], out = [];
  if (sec === 'exact') {
    out.push(finish(pre + '-2', 'Correct-score double', buildTier(games, CAND.exact, { lo: 0, hi: 1, min: 2, max: 2 }), { lottery: true }));
    out.push(finish(pre + '-3', 'Correct-score treble', buildTier(games, CAND.exact, { lo: 0, hi: 1, min: 3, max: 3 }), { lottery: true }));
  } else if (sec === 'scorers') {
    out.push(finish(pre + '-2', 'Anytime scorer double', buildTier(games, CAND.scorers, { lo: .3, hi: .8, min: 2, max: 2 })));
    out.push(finish(pre + '-3', 'Anytime scorer treble', buildTier(games, CAND.scorers, { lo: .3, hi: .8, min: 3, max: 3 })));
    out.push(finish(pre + '-sgp', 'Scorer + team win · same game', sgpScorerWin(games), { sgp: true }));
  } else {
    const tiers = sec === 'mega' ? MEGA_TIERS : TIERS;
    for (const T of tiers) out.push(finish(`${pre}-${T.name.replace(/ /g, '').toLowerCase()}`, `${sec === 'mega' ? 'Mega Mix' : S.label} · ${T.name}`, buildTier(games, CAND[sec], T, { diverse: sec === 'mega' }), { tier: T.name }));
  }
  const seen = new Set();
  return out.filter(P => { if (!P) return false; const k = P.legs.map(L => L.gid + '|' + L.key).sort().join(','); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------- state ----------------
let st = Object.assign({ lg: 'all', sec: 'best' }, store.get('socp', {}));
const save = () => store.set('socp', { lg: st.lg, sec: st.sec });
const CACHE = {}; let lastMs = 0;
const hasSim = () => !!document.querySelector('#tabs [data-t="sim"]');

// ---------------- rendering ----------------
const hitClass = p => p >= .55 ? 'h-hi' : p >= .3 ? 'h-mid' : 'h-lo';
const money = x => '$' + (x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(2));
const shortWhen = g => esc(SB.when(g));
function parlayCardHTML(P) {
  CACHE[P.id] = P;
  const boost = P.indep > 0 ? P.p / P.indep : 1, legsJson = JSON.stringify(P.legs.map(L => ({ gid: L.gid, key: L.key })));
  const legs = P.legs.map((L, i) => { const g = SB.gameById(L.gid); if (!g) return '';
    const same = i > 0 && P.legs.slice(0, i).some(M => M.gid === L.gid);
    return `<div class="leg"><span class="legdot ${i === 0 ? 'base' : ''}">${i + 1}</span><div class="legtxt"><b>${esc(L.label)}${same ? '<span class="link">SAME GAME</span>' : ''}${g.src !== 'Sportradar' ? ' <span class="badge b-est">EST</span>' : ''}</b><span>${esc(g.home.abbr)} v ${esc(g.away.abbr)} · ${shortWhen(g)}</span><em class="spwhy">${esc(L.why || '')}</em></div><span class="legp mono">${pct(L.p, L.p < .1 ? 1 : 0)}<small>${esc(SB.fmtOdds(L.p))}</small></span></div>`; }).join('');
  const edgePx = SB.fmtPrice(1.05 / P.p);
  return `<div class="pc spcard" data-sp-card="${esc(P.id)}" data-sp-p="${P.p}" data-sp-legs="${esc(legsJson)}">
    <div class="pchead"><span class="pctitle">${esc(P.title)}${P.lottery ? ' <span class="badge b-est">LOTTERY-STYLE</span>' : ''}</span><span class="hit ${hitClass(P.p)}">${pct(P.p, P.p < .1 ? 1 : 0)} to hit</span></div>
    <div style="margin-top:6px">${legs}</div>
    <div class="pcfoot"><div class="odds mono">${esc(SB.fmtOdds(P.p))}<small>Fair odds · $10 pays ${money(10 / P.p)}${boost > 1.02 ? ` · same-game boost +${pct(boost - 1)}` : ''}</small></div></div>
    <div class="spbtns"><button class="btn" data-sp-build="${esc(P.id)}">Open in builder</button>${hasSim() ? `<button class="btn ghost" data-sp-sim="${esc(P.id)}">Simulate 100k</button>` : ''}</div>
    <div class="note">Bet only at <b class="mono">${esc(SB.fmtOdds(P.p))}</b> or better (${esc(edgePx)} = a 5% edge). ${P.lottery ? 'Correct scores miss far more often than they land; stake small.' : 'Hit chance is a model estimate, not a promise.'}</div></div>`;
}
const emptyCard = (title, msg) => `<div class="pc sp-empty"><div class="pchead"><span class="pctitle">${esc(title)}</span></div><div class="why">${msg}</div></div>`;
function cell(g, key, short, opts = {}) {
  const p = SB.p1(g, key), id = g.id + '|' + key, can = SB.priced(g) && p > 0, inS = SB.inSlip(g.id, key);
  const st2 = opts.heat != null ? ` style="background:color-mix(in srgb,var(--accent2) ${Math.round(8 + 62 * opts.heat)}%,var(--card))"` : '';
  return `<button class="spc${opts.heat != null ? ' heat' : ''}${inS ? ' in' : ''}" data-leg="${esc(id)}" ${can ? '' : 'disabled'}${st2} title="${esc(SB.legLabel({ gid: g.id, key }) + ' · ' + pct(p, 1) + ' · fair ' + SB.fmtOdds(p))}" aria-label="${esc(SB.legLabel({ gid: g.id, key }) + ', ' + pct(p, 1) + ', fair price ' + SB.fmtOdds(p))}"><i>${esc(short)}</i><b>${pct(p, p < .1 ? 1 : 0)}</b><span>${esc(SB.fmtOdds(p))}</span></button>`;
}
function matchHead(g) {
  const X = xg(g), est = g.src !== 'Sportradar' ? ' <span class="badge b-est">EST</span>' : '';
  return `<div class="mkhead" data-open="${esc(g.id)}"><span class="lg">${esc(g.comp)}${est}</span><span>${shortWhen(g)}</span></div>
   <div class="spteams" data-open="${esc(g.id)}"><div>${SB.abBox(g.home)}<span class="tn">${esc(g.home.name)}</span>${SB.priced(g) ? `<small class="mono">xG ${f2(X.eh)}</small>` : ''}</div><div>${SB.abBox(g.away)}<span class="tn">${esc(g.away.name)}</span>${SB.priced(g) ? `<small class="mono">xG ${f2(X.ea)}</small>` : ''}</div></div>`;
}
function boardBody(sec, g) {
  const H = g.home.abbr, A = g.away.abbr;
  if (!SB.priced(g)) return `<div class="note">Prices post closer to kickoff; the feed refreshes hourly.</div>`;
  const team = (pre, side) => `<div class="spcells c3">${['0.5', '1.5', '2.5'].map(L => cell(g, pre + L, `${side} ${pre.endsWith('O') ? 'o' : 'u'}${L}`)).join('')}</div>`;
  if (sec === 'overs') return `<div class="spsub">Match total</div><div class="spcells c5">${['0.5', '1.5', '2.5', '3.5', '4.5'].map(L => cell(g, 'O' + L, 'O' + L)).join('')}</div>
    <div class="spsub">Team goals</div><div class="spduo">${team('HO', H)}${team('AO', A)}</div>`;
  if (sec === 'unders') return `<div class="spsub">Match total</div><div class="spcells c4">${['1.5', '2.5', '3.5', '4.5'].map(L => cell(g, 'U' + L, 'U' + L)).join('')}</div>
    <div class="spsub">Team goals</div><div class="spduo">${team('SX:HU', H)}${team('SX:AU', A)}</div>`;
  if (sec === 'btts') return `<div class="spcells">${cell(g, 'BTTS', 'BTTS yes')}${cell(g, 'BTTSN', 'BTTS no')}${cell(g, 'BTTS&O2.5', 'Yes & o2.5')}</div>`;
  if (sec === 'results') return `<div class="spcells c3">${cell(g, 'H', H + ' win')}${cell(g, 'D', 'Draw')}${cell(g, 'A', A + ' win')}${cell(g, 'DC1X', H + ' or X')}${cell(g, 'DCX2', 'X or ' + A)}${cell(g, 'DC12', 'No draw')}</div>`;
  if (sec === 'exact') { const T = topScores(g, 5);
    return `<div class="spcells c5">${T.map(c => cell(g, c.key, `${H} ${c.h}-${c.a}`, { heat: Math.min(1, c.p / .15) })).join('')}</div><div class="note">Top 5 of the score grid. <a class="splink" data-open="${esc(g.id)}">Full grid ›</a></div>`; }
  if (sec === 'scorers') return scorerBoard(g);
  if (sec === 'mega') {
    const fams = [['result', 'Result'], ['goals', 'Goals'], ['unders', 'Unders'], ['btts', 'BTTS'], ['scorer', 'Scorer']], C = CAND.mega(g), out = [];
    for (const [f, lbl] of fams) { const c = C.filter(x => x.fam === f && x.p >= .5 && x.p <= .92).sort((a, b) => b.p - a.p || a.ord - b.ord)[0] || C.filter(x => x.fam === f && x.p <= .92).sort((a, b) => b.p - a.p || a.ord - b.ord)[0]; if (c) out.push(lineRow(g, c.key, lbl)); }
    return `<div class="spsub">Strongest leg per market type (50-92% band)</div>${out.join('')}`;
  }
  return '';
}
function lineRow(g, key, fam) {
  const p = SB.p1(g, key), lbl = SB.legLabel({ gid: g.id, key });
  return `<div class="sprow sp2"><div class="spname"><small>${esc(fam)}</small><b>${esc(lbl)}</b></div><span class="mono sppct">${pct(p)}</span>
    <button class="yes ${SB.inSlip(g.id, key) ? 'in' : ''}" data-leg="${esc(g.id + '|' + key)}" ${SB.priced(g) ? '' : 'disabled'} aria-label="${esc(lbl + ', ' + pct(p) + ', fair ' + SB.fmtOdds(p))}">${esc(SB.fmtOdds(p))}</button></div>`;
}
function scorerBoard(g) {
  const R = gm(g); let html = '';
  for (const s of ['home', 'away']) {
    const S = R[s], X = xg(g);
    html += `<div class="spteam">${esc(S.name)} <small>xG ${f2(s === 'home' ? X.eh : X.ea)}</small></div>`;
    if (!S.team) { html += `<div class="note" style="margin:2px 0 6px">No scorer data for ${esc(S.name)} yet. Use team goal markets instead.</div>`; continue; }
    const rows = S.players.map(x => ({ x, p: SB.p1(g, 'G:' + x.id) })).sort((a, b) => b.p - a.p || cmpId(a.x.id, b.x.id));
    html += rows.map(({ x, p }) => {
      const flags = [x.status === 'doubtful' ? '<span class="warnflag">DOUBTFUL</span>' : '', x.priorOnly ? '<span class="warnflag">NO GOAL DATA</span>' : '', x.est ? '<span class="badge b-est">OLD DATA</span>' : '', x.pens ? '<span class="badge b-tag">PENS</span>' : ''].join('');
      const meta = `${x.pos} · ${x.priorOnly ? 'position average only' : x.goals + ' league goal' + (x.goals === 1 ? '' : 's')} · ~${pct(x.e)} of team goals`;
      const k1 = 'G:' + x.id, k2 = 'G:1st:' + x.id, p2 = SB.p1(g, k2);
      return `<div class="sprow"><div class="spname"><b>${esc(x.name)}</b>${flags}<small>${esc(meta)}</small></div>
        <button class="yes ${SB.inSlip(g.id, k1) ? 'in' : ''}" data-leg="${esc(g.id + '|' + k1)}" aria-label="${esc(x.name + ' to score, ' + pct(p) + ', fair ' + SB.fmtOdds(p))}"><small>Anytime ${pct(p)}</small>${esc(SB.fmtOdds(p))}</button>
        <button class="yes ${SB.inSlip(g.id, k2) ? 'in' : ''}" data-leg="${esc(g.id + '|' + k2)}" aria-label="${esc(x.name + ' first goalscorer, ' + pct(p2, 1) + ', fair ' + SB.fmtOdds(p2))}"><small>First ${pct(p2, p2 < .1 ? 1 : 0)}</small>${esc(SB.fmtOdds(p2))}</button></div>`;
    }).join('');
    if (S.out.length) html += `<div class="note" style="margin:2px 0 6px">Left out (listed as out): ${esc(S.out.map(p => p.name).join(', '))}.</div>`;
  }
  return html;
}
function scorerFreshness() {
  const sc = SB.DATA.scorers;
  if (!sc) return `<div class="lineup"><span>⚠️</span><div><b>Scorer data isn't loaded.</b> Goalscorer markets need scorers.json; the other sections still work.</div></div>`;
  const u = sc.updated ? new Date(sc.updated) : null;
  return `<div class="lineup"><span>📋</span><div><b>Lineups are not confirmed.</b> Check team news before betting a scorer. Data compiled ${u ? esc(u.toLocaleString([], { month: 'short', day: 'numeric' })) : '—'}${sc.asOf ? `; ${esc(sc.asOf.replace(/^Goal totals/, 'goal totals'))}` : ''}. Out players are excluded; doubtful players count at half and are never auto-picked.</div></div>`;
}
function nav(LL) {
  const chip = (L) => `<button class="chip ${st.lg === L.id ? 'on' : ''} ${L.n ? '' : 'zero'}" data-sp-lg="${esc(L.id)}">${esc(L.name === 'Friendly' ? 'Friendlies' : L.name)}<span class="n">${L.n}</span></button>`;
  const total = LL.top.reduce((a, L) => a + L.n, 0) + LL.more.reduce((a, L) => a + L.n, 0);
  const lg = `<div class="spnav" role="tablist" aria-label="Leagues"><button class="chip ${st.lg === 'all' ? 'on' : ''}" data-sp-lg="all">All leagues<span class="n">${total}</span></button>${LL.top.map(chip).join('')}${LL.more.length ? `<span class="more">More</span>${LL.more.map(chip).join('')}` : ''}</div>`;
  const secs = (st.lg === 'all' ? [{ id: 'best', label: 'Best of each' }, ...SECS] : SECS);
  const sc = `<div class="spnav spsecs" role="tablist" aria-label="Sections">${secs.map(S => `<button class="chip ${st.sec === S.id ? 'on' : ''}" data-sp-sec="${S.id}">${esc(S.label)}</button>`).join('')}</div>`;
  return lg + sc;
}
function updatedLine() { const u = SB.DATA.updated ? new Date(SB.DATA.updated) : null;
  return `<div class="updated"><i></i>Feed updated ${u ? esc(u.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : '—'} · new fixtures appear with the hourly refresh</div>`; }
function renderTab(main, params) {
  const t0 = performance.now(); main = main || $main(); if (!main) return;
  if (params && params.league) { const L = String(params.league); const f = LEAGUES.find(x => x.id === L || normC(x.name) === normC(L)); st.lg = f ? f.id : L; }
  if (params && params.section && (SECMAP[params.section] || params.section === 'best')) st.sec = params.section;
  const up = upcoming(), LL = leagueList(up);
  const known = st.lg === 'all' || LL.top.some(L => L.id === st.lg) || LL.more.some(L => L.id === st.lg);
  if (!known) st.lg = 'all';
  if (!SECMAP[st.sec] && !(st.lg === 'all' && st.sec === 'best')) st.sec = st.lg === 'all' ? 'best' : 'overs';
  save();
  for (const k in CACHE) delete CACHE[k];
  let html = updatedLine() + nav(LL);
  const all = st.lg === 'all', L = all ? { id: 'all', name: 'All leagues' } : (LL.top.find(x => x.id === st.lg) || LL.more.find(x => x.id === st.lg));
  const games = all ? up : up.filter(g => leagueOf(g.comp).id === st.lg);
  const pg = games.filter(inWindow);
  if (!games.length) {
    html += `<div class="empty sp-empty" style="margin-top:14px"><b>${esc(L.name)}</b><br>No fixtures in the feed yet; they appear automatically when the hourly refresh adds them.</div>`;
  } else if (all && st.sec === 'best') {
    html += `<h2>Best parlay of each type <small>${pg.length} matches · next 7 days</small></h2><div class="note" style="margin:-4px 2px 10px">The top pick from each section, built across every league in the feed. Tap a section above for all tiers and the match boards.</div><div class="grid">`;
    for (const S of SECS) {
      const ps = sectionParlays(S.id, pg, 'all');
      html += ps.length ? parlayCardHTML({ ...ps[0], title: ps[0].title.startsWith(S.label) ? ps[0].title : `${S.label}: ${ps[0].title}` }) : emptyCard(S.label, 'No parlay fits the rules in the next 7 days. Bet a single instead.');
    }
    html += `</div>`;
  } else {
    const S = SECMAP[st.sec];
    html += `<h2>${esc(L.name)} · ${esc(S.label)} <small>${pg.length} match${pg.length === 1 ? '' : 'es'} · next 7 days</small></h2><div class="note" style="margin:-4px 2px 10px">${esc(S.intro)}</div>`;
    if (S.id === 'scorers') html += scorerFreshness();
    const ps = sectionParlays(S.id, pg, st.lg);
    html += `<div class="grid">${ps.length ? ps.map(parlayCardHTML).join('') : emptyCard(`${S.label} parlays`, pg.length < 2 ? 'Fewer than two priced matches in the next 7 days, so there is nothing to combine. Bet a single from the board below.' : 'No combination fits the tier rules right now. Bet a single from the board below, or try another section.')}</div>`;
    html += `<h2>Match board <small>tap a price to add it</small></h2>`;
    const byL = all ? groupBy(games, g => leagueOf(g.comp).name) : [[L.name, games]];
    for (const [ln, gs] of byL) {
      if (all) html += `<div class="sec">${esc(ln)}</div>`;
      html += `<div class="grid">${gs.map(g => `<div class="mk spboard">${matchHead(g)}${boardBody(S.id, g)}</div>`).join('')}</div>`;
    }
  }
  html += `<div class="note" style="margin-top:14px">Percentages are model estimates from each match's win chances (exact score grid; scorers from season goal shares), not guarantees. Fair odds have no bookmaker margin: only bet when your book pays more. Leagues: ${esc(LEAGUES.map(x => x.name).join(', '))}${LL.more.length ? ', plus ' + esc(LL.more.map(x => x.name).join(', ')) : ''}.</div>`;
  main.innerHTML = html;
  lastMs = performance.now() - t0;
}
function groupBy(arr, f) { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m]; }

// ---------------- events ----------------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sp-lg],[data-sp-sec],[data-sp-build],[data-sp-sim]'); if (!t) return;
  if (t.dataset.spLg != null) { st.lg = t.dataset.spLg; if (st.lg !== 'all' && st.sec === 'best') st.sec = 'overs'; save(); renderTab($main()); keepChipVisible(); return; }
  if (t.dataset.spSec != null) { st.sec = t.dataset.spSec; save(); renderTab($main()); keepChipVisible(); return; }
  const P = CACHE[t.dataset.spBuild || t.dataset.spSim]; if (!P) return;
  const legs = P.legs.map(L => ({ gid: L.gid, key: L.key, label: L.label, sport: 'soccer' }));
  if (t.dataset.spBuild != null) { SB.setSlip(legs, legs[0].gid + '|' + legs[0].key); SB.openSlip(); return; }
  SB.goTab('sim', { legs, title: P.title, from: 'soccerparlays', p: P.p });
});
function keepChipVisible() { for (const el of document.querySelectorAll('#main .spnav .chip.on')) { const r = el.parentElement; const x = el.offsetLeft - r.offsetLeft; if (x < r.scrollLeft || x + el.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = Math.max(0, x - 40); } }
// keep in-slip highlights in sync when the slip changes elsewhere (builder sheet, other tabs)
SB.on('slip', () => { for (const b of document.querySelectorAll('#main .spc[data-leg], #main .sprow [data-leg]')) { const s = b.dataset.leg, i = s.indexOf('|'); b.classList.toggle('in', SB.inSlip(s.slice(0, i), s.slice(i + 1))); } });

// ---------------- styles ----------------
const css = `
.spnav{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;margin:10px -16px 0;padding:2px 16px 4px}
.spnav::-webkit-scrollbar{display:none}
.spnav .chip .n{display:inline-block;min-width:18px;margin-left:6px;padding:0 5px;border-radius:9px;background:var(--soft);color:var(--mute);font-size:11.5px;font-weight:800;text-align:center;line-height:17px}
.spnav .chip.on .n{background:rgba(0,0,0,.14);color:#000}
.spnav .chip.zero{opacity:.6}
.spnav .more{flex:none;align-self:center;font-size:11px;font-weight:800;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;padding:0 0 0 6px}
.spsecs{margin-top:4px}
@media(min-width:760px){.spnav{flex-wrap:wrap;overflow:visible;margin:10px 0 0;padding:2px 0 4px}}
.spcard .hit{white-space:nowrap;flex:none}
.spcard .badge,.spname .badge,.spname .warnflag{white-space:nowrap;display:inline-block}
.spsecs .chip{padding:6px 12px;font-size:13px;border-radius:9px}
.spcard .legtxt .spwhy{display:block;font-style:normal;font-size:12px;color:var(--mute);font-weight:500;margin-top:2px;line-height:1.35}
.spcard .legp{text-align:right}.spcard .legp small{display:block;font-size:11.5px;color:var(--dim);font-weight:700}
.spbtns{display:flex;gap:8px;margin-top:10px}.spbtns .btn{flex:1;padding:11px 10px;font-size:14.5px}
.spteams{display:grid;gap:6px;margin:10px 0 4px;cursor:pointer}
.spteams>div{display:flex;align-items:center;gap:9px;min-width:0}
.spteams .tn{font-size:15.5px;flex:1;min-width:0}
.spteams small{font-size:12px;color:var(--dim);font-weight:700;flex:none}
.spcells{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:6px;margin-top:8px}
.spcells.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
.spcells.c5{grid-template-columns:repeat(5,minmax(0,1fr))}
.spcells.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
.spduo{display:grid;grid-template-columns:1fr;gap:0}
.spduo .spcells{margin-top:6px}
@media(min-width:520px){.spduo{grid-template-columns:1fr 1fr;gap:10px}}
.spsub{font-size:11px;font-weight:800;color:var(--dim);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 0}
.sp2{grid-template-columns:minmax(0,1fr) auto auto}
.sp2 .spname small{margin:0 0 1px;text-transform:uppercase;font-weight:800;letter-spacing:.3px}
.sp2 .spname b{font-size:14.5px;display:block}
.sppct{font-weight:800;font-size:14px}
.sp2 .yes{padding:8px 0}
.spcells.c-wide{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}
.spc{border:1px solid var(--line);background:var(--soft);border-radius:9px;padding:6px 2px;text-align:center;cursor:pointer;color:var(--text);font-family:inherit;min-width:0}
.spc i{display:block;font-style:normal;font-size:11px;font-weight:800;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
.spc b{display:block;font-size:14px;font-weight:800}
.spc span{display:block;font-size:11px;font-weight:700;color:var(--mute);font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spc.heat i,.spc.heat span{color:var(--text)}
.spc.in{outline:2.5px solid var(--text);outline-offset:-2px}
.spc.in:not(.heat){background:var(--accent2);border-color:var(--accent2);color:#000}
.spc.in:not(.heat) i,.spc.in:not(.heat) span{color:#000}
.dark .spc.in:not(.heat){background:var(--accent)}
.spc:disabled{opacity:.5;cursor:default}
.spteam{font-size:12.5px;font-weight:800;color:var(--mute);text-transform:uppercase;letter-spacing:.4px;margin:12px 0 2px;display:flex;justify-content:space-between}
.spteam small{font-weight:700;color:var(--dim);text-transform:none;letter-spacing:0}
.sprow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.spname{min-width:0}.spname b{font-size:15px;margin-right:2px}
.spname small{display:block;font-size:11.5px;color:var(--dim);font-weight:600;margin-top:1px}
.sprow .yes{width:74px;padding:6px 0;font-size:13px;line-height:1.2}
.sprow .yes small{display:block;font-size:10.5px;font-weight:700;opacity:.8}
.splink{color:var(--accent2);font-weight:700;cursor:pointer}
.dark .splink{color:var(--accent)}
.spboard{min-width:0}
`;
const style = document.createElement('style'); style.id = 'soccer-css'; style.textContent = css; document.head.appendChild(style);

const TAB = { key: 'soccerparlays', label: '⚽ Soccer Parlays', after: 'trending', render: renderTab };
SB.registerTab(TAB);
// Workaround: index.html draws the tab bar once before modules load and its first render() does not redraw it, so a tab
// registered before boot has no button until something else redraws the bar. Once booted, register again if it is missing
// (registerTab after boot redraws the bar, and the view when this tab is active).
SB.on('data', () => setTimeout(() => { if (!document.querySelector('#tabs [data-t="soccerparlays"]')) SB.registerTab(TAB); }, 0));

// test / debug hooks
window.__soccer = { LEAGUES, leagueOf, teamFor, model: gid => gm(SB.gameById(gid)), modelOf: g => gm(g), sectionParlays: (lg, sec) => {
  const up = upcoming().filter(inWindow); return sectionParlays(sec, lg === 'all' ? up : up.filter(g => leagueOf(g.comp).id === lg), lg); },
  ieTable, get state() { return { ...st }; }, get lastMs() { return lastMs; }, render: () => renderTab($main()) };
})();
