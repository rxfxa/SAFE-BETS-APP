/* soccer.js — "⚽ Soccer Parlays" tab for Safe Bets. A module on the window.SB v2 API (see the comment block in index.html).
   Owns: the league / section navigation, auto-built soccer parlays per market type, per-match market boards, and two custom
   leg types:
     G:<playerId>       anytime goalscorer          G:1st:<playerId>   first goalscorer
     SX:<HU|AU><line>   team under (e.g. SX:HU1.5 = home team scores at most 1) — the engine has team overs but no team unders.
   Every price is a model estimate. Same-game joints are exact sums over the engine's score grid (SB.scoreMatrix).

   ---------------- GOALSCORER MODEL ----------------
   Inputs per player (scorers.json): league goals, pos, status, optional mins / apps / pens, optional previous league season
   prevG + prevMins | prevApps; per team optional teamGoals / teamMatches, prevTeamGoals / prevTeamMatches, aliases, lastChecked.
   Per fixture, the engine's Dixon-Coles grid gives P(h,a), whose team marginals are Poisson(eh), Poisson(ea) (approximately,
   for the few lopsided fits that need the draw factor).

   1. Minutes played so far  mins = p.mins || p.apps*78 || p.starts*85 || teamMatches*90*0.85 (matches = team.teamMatches or
      the league's matchday at data time, LG_MP).
   2. Team goals per 90  tg90 = teamGoals/teamMatches when known, else sqrt(LG_GPM[league] * this fixture's model goals for the
      team), a half-way house: the fixture alone is circular (a weak opponent inflates it and deflates every share).
   3. Raw on-pitch share  r = (goals*90/mins) / tg90.
   4. Shrink toward a prior:  sOn = (r*mins + prior*w) / (mins + w)
        prior = the player's previous-season share (prevG*90/prevMins)/team rate, clamped to [PRIOR[pos], SON_CAP[pos]],
                with w = min(prevMins, 1800), when scorers.json has it (proven scorers who start slowly: Kane, Haaland...);
        else  prior = PRIOR[pos] (FW .22, AM .14, MF .08, DF .04, GK .002) with w = PRIOR_W[pos] (FW 900, AM 1200, MF 1800,
                DF 3000, GK 5000 minutes: a defender's 3 goals in 5 games say little).
      + PEN_BUMP (.025) for a penalty taker, then capped by position, SON_CAP = FW .6, AM .4, MF .25, DF .12, GK .01.
      A player with no goal total uses the prior only (shown, never auto-picked).
   5. Effective share of team goals  e = sOn * MINS[pos]   (expected share of the match he is on the pitch when he plays:
      FW .84, AM .84, MF .88, DF .93), x .75 for a "doubtful" player (fitness / rotation risk as fewer minutes). If a team's
      listed players add up to more than .9, all are scaled down to .9.
   6. Settlement basis: most books void an anytime / first-scorer bet on a player who takes no part (a void leg drops out of a
      parlay), so every price is P(... | he plays): there is no availability factor. "out" players are excluded entirely;
      doubtful players, defenders and keepers are never auto-picked into parlays (they stay on the board).

   Given the team scores k goals and the players play, each goal is attributed independently to player i with prob e_i
   (multinomial; the rest go to unlisted players / own goals). So
        P(i scores | k)              = 1 - (1-e_i)^k
        P(all of set S score | k)    = sum over B ⊆ S of (-1)^|B| (1 - sum_{j in B} e_j)^k      (inclusion-exclusion)
        P(i scores first | h,a)      = e_i * h/(h+a)                     (first goal is a uniformly random one of the h+a)
        P(i first & S score | h,a)   = e_i * h/(h+a) * IE_{S\{i}}(h-1) * IE_{S_away}(a)   (i on the home side; mirror for away)
   The engine sums these conditionals
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
ALIAS.set('bundesliga 1', ALIAS.get('bundesliga')); ALIAS.set('laliga santander', ALIAS.get('laliga'));
// Feed comps come in many spellings ("MLS Cup Playoffs", "Champions League, League Phase", "England - Premier League",
// "Serie A 2026/27"). After an exact alias miss: drop season / stage / sponsor words and the league's OWN country word, then retry.
// A foreign country word is never dropped, so "Brazil Serie A", "Egyptian Premier League", "Austrian Bundesliga" stay "Other".
const NOT_TOP = /\b(women\w*|feminine|u\d{2}|youth|reserves?|qualif\w*|qualifying|conference|afc|caf|concacaf|ofc|asian|african|next pro|2 bundesliga|premier league 2)\b/;
const SEASON = /\b(19|20)\d{2}( \d{2,4})?\b/g;
const STAGE = /\b(league phase|league stage|group stage|group [a-h]|matchday \d+|md \d+|cup playoffs?|playoffs?|play offs?|knockout( round| stage| phase)?|round of \d+|wild card|regular season|semi finals?|quarter finals?)\b/g;
const SPONSOR = /\b(santander|ea sports|betclic|mcdonalds|uber eats|enilive|tim|barclays|vriendenloterij|nos)\b/g;
const OWN_COUNTRY = { epl: /\b(england|english)\b/, laliga: /\b(spain|spanish)\b/, seriea: /\b(italy|italian)\b/, bundesliga: /\b(germany|german)\b/,
  ligue1: /\b(france|french)\b/, eredivisie: /\b(netherlands|dutch|holland)\b/, primeira: /\b(portugal|portuguese)\b/, mls: /\b(usa|us|united states)\b/ };
const sq = s => s.replace(/\s+/g, ' ').trim();
function leagueOf(comp) {
  const raw = normC(comp), other = { id: 'x-' + raw.replace(/ /g, '-'), name: String(comp || 'Other'), other: true };
  if (ALIAS.has(raw)) return ALIAS.get(raw);
  if (!raw || NOT_TOP.test(raw)) return other;
  const s = sq(raw.replace(SEASON, ' ').replace(STAGE, ' ').replace(SPONSOR, ' '));
  if (ALIAS.has(s)) return ALIAS.get(s);
  for (const L of LEAGUES) { const re = OWN_COUNTRY[L.id]; if (re && re.test(s)) { const t = sq(s.replace(re, ' ')); if (ALIAS.get(t) === L) return L; } }
  if (/\b(uefa )?champions league\b/.test(s)) return ALIAS.get('ucl');
  if (/\b(uefa )?europa league\b/.test(s)) return ALIAS.get('uel');
  if (/\bmls\b|\bmajor league soccer\b/.test(s)) return ALIAS.get('mls');
  return other;
}
const UEFA = /champions|europa|conference|nations/;
// model constants by domestic league: average goals per team per match and league matches played when the data was taken
const LG_GPM = { epl: 1.4, laliga: 1.3, seriea: 1.3, bundesliga: 1.55, ligue1: 1.35, mls: 1.55, eredivisie: 1.6, primeira: 1.35, 'x-liga-mx': 1.4, 'x-eliteserien': 1.55, 'x-super-lig': 1.45, 'x-austrian-bundesliga': 1.55 };
const LG_MP = { epl: 11, laliga: 12, seriea: 11, bundesliga: 10, ligue1: 11, mls: 34, eredivisie: 12, primeira: 11, 'x-liga-mx': 16, 'x-eliteserien': 28, 'x-super-lig': 12, 'x-austrian-bundesliga': 13 };
const PRIOR = { FW: .22, AM: .14, MF: .08, DF: .04, GK: .002 }, MINS = { FW: .84, AM: .84, MF: .88, DF: .93, GK: .98 };
// prior weight in minutes (a defender needs far more evidence than a striker before a hot start moves him) and share caps
const PRIOR_W = { FW: 900, AM: 1200, MF: 1800, DF: 3000, GK: 5000 }, SON_CAP = { FW: .6, AM: .4, MF: .25, DF: .12, GK: .01 };
const PEN_BUMP = .025, PREV_W_MAX = 1800, DOUBT_MINS = .75, TEAM_CAP = .9, STALE_DAYS = 10;

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
  // aliases ("Lyon", "FC Koln", "Inter") after every real name, so an alias never overrides another club's own name
  for (const t of sc.teams) if (t && t.team && Array.isArray(t.players) && Array.isArray(t.aliases))
    for (const a of t.aliases) { const k = normT(a); if (k && !byName.has(k)) byName.set(k, t); }
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
function sideModel(g, s, M) {
  const T = g[s], team = teamFor(T, g), out = { side: s, abbr: T.abbr, name: T.name, team, players: [], out: [] };
  if (!team) return out;
  const lg = domestic(team), mp = +team.teamMatches > 0 ? +team.teamMatches : (LG_MP[lg] || 12), lgAvg = LG_GPM[lg] || 1.4;
  // team goals per 90: the club's real rate when scorers.json has it; otherwise the geometric mean of the league average and
  // this fixture's model goals (the fixture alone would be circular: a weak opponent would inflate the rate and shrink shares)
  const fx = M ? (s === 'home' ? M.eh : M.ea) : lgAvg;
  const hasTG = +team.teamGoals > 0 && +team.teamMatches > 0;
  const tg90 = hasTG ? team.teamGoals / team.teamMatches : Math.sqrt(lgAvg * Math.min(3.5, Math.max(.5, fx)));
  const tgPrev = +team.prevTeamGoals > 0 && +team.prevTeamMatches > 0 ? team.prevTeamGoals / team.prevTeamMatches : tg90;
  out.tg90 = tg90; out.tgSrc = hasTG ? 'team' : 'blend';
  for (const p of team.players) {
    if (!p || !p.id) continue;
    const st = String(p.status || 'active').toLowerCase();
    if (st === 'out' || st === 'injured' || st === 'suspended') { out.out.push(p); continue; }
    const pos = PRIOR[p.pos] != null ? p.pos : 'MF', cap = SON_CAP[pos];
    // prior: the player's own previous league season when known (weight up to 1800 min), else the position average
    let prior = PRIOR[pos], w = PRIOR_W[pos], prev = false;
    const pm = +p.prevMins > 0 ? +p.prevMins : +p.prevApps > 0 ? p.prevApps * 80 : 0;
    if (typeof p.prevG === 'number' && p.prevG >= 0 && pm >= 450) {
      prior = Math.min(cap, Math.max(PRIOR[pos], (p.prevG * 90 / pm) / tgPrev)); w = Math.min(pm, PREV_W_MAX); prev = true;
    }
    const hasG = typeof p.goals === 'number' && isFinite(p.goals) && p.goals >= 0;
    const mins = +p.mins > 0 ? +p.mins : +p.apps > 0 ? p.apps * 78 : +p.starts > 0 ? p.starts * 85 : mp * 90 * .85;
    let sOn = hasG ? ((p.goals * 90 / mins) / tg90 * mins + prior * w) / (mins + w) : prior;
    if (p.pens === true) sOn += PEN_BUMP;
    sOn = Math.min(sOn, cap);
    const doubt = st === 'doubtful';
    // doubtful: priced as if he plays (books void scorer bets on a non-starter that never comes on), with fewer expected minutes
    out.players.push({ id: String(p.id), name: p.name || p.id, pos, goals: hasG ? p.goals : null, pens: p.pens === true, est: !!p.est,
      status: doubt ? 'doubtful' : 'active', note: p.note || '', priorOnly: !hasG, prev, prevG: prev ? p.prevG : null, sOn, e: sOn * MINS[pos] * (doubt ? DOUBT_MINS : 1),
      side: s, abbr: T.abbr, gid: g.id });
  }
  const tot = out.players.reduce((a, x) => a + x.e, 0);
  if (tot > TEAM_CAP) for (const x of out.players) x.e *= TEAM_CAP / tot;
  return out;
}
function gm(g) {
  if (!g || g.sport !== 'soccer') return null;
  if (MODEL.has(g)) return MODEL.get(g);
  const M = SB.scoreMatrix(g), r = { M, home: sideModel(g, 'home', M), away: sideModel(g, 'away', M), byId: new Map() };
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
  const any = { home: [], away: [] }, firsts = [];
  for (const k of keys) {
    const { first, id } = parseG(k), x = R.byId.get(id); if (!x) return () => 0;
    if (first) firsts.push(x); else any[x.side].push(x);
  }
  if (firsts.length > 1) return () => 0; // two different players cannot both score the first goal
  // Settlement basis: P(legs hit | the players take part). Books void a scorer bet on a player who doesn't play (a void leg
  // drops out of a parlay), so there is deliberately no availability factor here.
  const n = R.M.n - 1, F = firsts[0] || null;
  const TH = ieTable(any.home.filter(x => !F || x.id !== F.id).map(x => x.e), n);
  const TA = ieTable(any.away.filter(x => !F || x.id !== F.id).map(x => x.e), n);
  if (!F) return (h, a) => TH[h] * TA[a];
  if (F.side === 'home') return (h, a) => h > 0 ? F.e * h / (h + a) * TH[h - 1] * TA[a] : 0;
  return (h, a) => a > 0 ? F.e * a / (h + a) * TH[h] * TA[a - 1] : 0;
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
  { id: 'scorers', label: 'Goalscorers', intro: 'Anytime and first goalscorers from season goal shares and each match\'s expected goals. Prices assume the player takes part: most books void a scorer bet if he doesn\'t play.' },
  { id: 'btts', label: 'BTTS', intro: 'Both teams to score, yes or no, and BTTS & over 2.5.' },
  { id: 'results', label: 'Results', intro: 'Win / draw / win and double chance (1X2), settled on 90 minutes plus stoppage time: a level playoff or cup game counts as a draw here, whatever happens in extra time or penalties.' },
  { id: 'mega', label: 'League Mega Mix', intro: 'One leg per match from any market: in each tier, the main-line leg closest to the middle of its chance band.' },
];
const SECMAP = Object.fromEntries(SECS.map(s => [s.id, s]));
// Safer stops at 86%: above that sit the 1.05-1.12 "padding" legs (team over 0.5, under 4.5) that add little but risk
const TIERS = [
  { name: 'Safer', lo: .72, hi: .86, min: 2, max: 3 },
  { name: 'Balanced', lo: .55, hi: .72, min: 2, max: 3 },
  { name: 'Long shot', lo: .3, hi: .55, min: 2, max: 3 },
];
const MEGA_TIERS = [
  { name: 'Safer', lo: .72, hi: .86, min: 3, max: 4 },
  { name: 'Balanced', lo: .56, hi: .74, min: 3, max: 4 },
  { name: 'Long shot', lo: .35, hi: .6, min: 3, max: 4 }, // legs near the band middle (~47%): 4 legs ≈ 5%
];
// padding legs: near-certain lines used only when no main-line leg of that match fits the tier's band
const PAD = new Set(['O0.5', 'HO0.5', 'AO0.5', 'U4.5', 'SX:HU2.5', 'SX:AU2.5']);
function mkLeg(g, key, why, fam, ord) { return { gid: g.id, key, label: SB.legLabel({ gid: g.id, key }), p: SB.p1(g, key), why, fam, ord, pad: PAD.has(key) }; }
// auto-picked scorers: players with a real goal tally, not doubtful, and not defenders / keepers (kept on the board)
function eligibleScorers(g) { const R = gm(g); if (!R || !R.M) return []; return [...R.home.players, ...R.away.players].filter(x => !x.priorOnly && x.status === 'active' && x.pos !== 'DF' && x.pos !== 'GK'); }
function scorerWhy(g, x) { const X = xg(g); return `${x.goals} league goal${x.goals === 1 ? '' : 's'}${x.prev ? ` (${x.prevG} last season)` : ''} · ~${pct(x.e)} of ${x.abbr} goals when he plays · ${x.abbr} exp. goals ${f2(x.side === 'home' ? X.eh : X.ea)}${x.est ? ' · tally unconfirmed' : ''}`; }
const CAND = {
  overs(g) { const X = xg(g), w = `Exp. goals ${f2(X.t)} (${g.home.abbr} ${f2(X.eh)} · ${g.away.abbr} ${f2(X.ea)})`;
    return ['O0.5', 'O1.5', 'O2.5', 'O3.5', 'O4.5', 'HO0.5', 'HO1.5', 'HO2.5', 'AO0.5', 'AO1.5', 'AO2.5'].map((k, i) => mkLeg(g, k, w, 'goals', i)); },
  unders(g) { const X = xg(g), w = `Exp. goals ${f2(X.t)} (${g.home.abbr} ${f2(X.eh)} · ${g.away.abbr} ${f2(X.ea)})`;
    return ['U1.5', 'U2.5', 'U3.5', 'U4.5', 'SX:HU0.5', 'SX:HU1.5', 'SX:HU2.5', 'SX:AU0.5', 'SX:AU1.5', 'SX:AU2.5'].map((k, i) => mkLeg(g, k, w, 'unders', i)); },
  btts(g) { const w = `${g.home.abbr} score ${pct(SB.p1(g, 'HO0.5'))} · ${g.away.abbr} score ${pct(SB.p1(g, 'AO0.5'))}`;
    return ['BTTS', 'BTTSN', 'BTTS&O2.5'].map((k, i) => mkLeg(g, k, w, 'btts', i)); },
  results(g) { const P = g.prob, t = P.home + P.away + (P.draw || 0), src = g.src === 'Sportradar' ? 'Sportradar' : 'Safe Bets estimate';
    const w = `${src}: ${g.home.abbr} ${pct(P.home / t)} · draw ${pct((P.draw || 0) / t)} · ${g.away.abbr} ${pct(P.away / t)}`;
    return ['H', 'D', 'A', 'DC1X', 'DCX2', 'DC12'].map((k, i) => mkLeg(g, k, w, 'result', i)); },
  exact(g) { return topScores(g, 1).map((c, i) => mkLeg(g, c.key, `Most likely score of this match${c.next ? ` · next: ${c.next}` : ''}`, 'cs', i)); },
  // the favourite's most likely WINNING score, for matches with a clear favourite (win chance 55%+)
  favScore(g) {
    const M = SB.scoreMatrix(g); if (!M) return [];
    const pH = SB.p1(g, 'H'), pA = SB.p1(g, 'A'), side = pH >= .55 ? 'H' : pA >= .55 ? 'A' : null; if (!side) return [];
    let best = null; for (let h = 0; h <= 4; h++) for (let a = 0; a <= 4; a++) { if (side === 'H' ? h <= a : a <= h) continue;
      const p = M.P[h * M.n + a]; if (!best || p > best.p + 1e-15) best = { h, a, p }; }
    const fav = side === 'H' ? g.home.abbr : g.away.abbr;
    return best ? [mkLeg(g, `CS${best.h}-${best.a}`, `${fav} ${pct(side === 'H' ? pH : pA)} to win; ${best.h}-${best.a} is their most likely winning score`, 'cs', 0)] : [];
  },
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
// One leg per match, deterministic tie-breaks. Default ranking: each match's strongest leg inside the band, strongest matches
// first (used by exact scores and scorers). opts.rank === 'mid': the leg closest to the band's middle, preferring main lines
// over padding legs (PAD) when the match has any main line in the band. opts.uniq(c) -> keys that may appear only once per parlay
// (scorers: the same player or club in two matches). opts.diverse: at most two legs of one market family when there is an
// alternative almost as good.
function buildTier(games, cands, T, opts = {}) {
  const mid = (T.lo + T.hi) / 2, mode = opts.rank === 'mid', d = c => mode ? Math.abs(c.p - mid) : -c.p, per = [];
  for (const g of games) {
    let cs = cands(g).filter(c => c.p >= T.lo && c.p <= T.hi && c.p > 0);
    if (mode && cs.some(c => !c.pad)) cs = cs.filter(c => !c.pad);
    cs.sort((a, b) => d(a) - d(b) || a.ord - b.ord);
    if (cs.length) per.push({ g, cs });
  }
  per.sort((a, b) => d(a.cs[0]) - d(b.cs[0]) || SB.startMs(a.g) - SB.startMs(b.g) || cmpId(a.g.id, b.g.id));
  const legs = [], fams = {}, used = new Set();
  for (const { cs } of per) {
    if (legs.length >= T.max) break;
    const free = opts.uniq ? cs.filter(x => !opts.uniq(x).some(k => used.has(k))) : cs;
    if (!free.length) continue;
    let c = free[0];
    if (opts.diverse) { const alt = free.find(x => (fams[x.fam] || 0) < 2 && d(x) <= d(free[0]) + .05); if (alt) c = alt; }
    legs.push(c); fams[c.fam] = (fams[c.fam] || 0) + 1;
    if (opts.uniq) for (const k of opts.uniq(c)) used.add(k);
  }
  if (legs.length < T.min) return null;
  return legs;
}
// a scorer leg's player and club (one Mbappe per parlay, and not two Real Madrid scorers from different matches)
const scorerUniq = c => { const R = gm(SB.gameById(c.gid)), x = R && R.byId.get(parseG(c.key).id); return [c.key.replace('G:1st:', 'G:'), 'club:' + (x ? x.abbr : c.gid)]; };
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
      const xs = R[s].players.filter(x => !x.priorOnly && x.status === 'active' && x.pos !== 'DF' && x.pos !== 'GK').map(x => ({ x, p: SB.p1(g, 'G:' + x.id) })).sort((a, b) => b.p - a.p || cmpId(a.x.id, b.x.id));
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
    const dbl = buildTier(games, CAND.exact, { lo: 0, hi: 1, min: 2, max: 2 }) || [];
    out.push(finish(pre + '-2', 'Most likely scores · double', dbl, { lottery: true }));
    // built from a different family (never a draw) and never reusing a leg of the double
    const fav = buildTier(games, g => CAND.favScore(g).filter(c => !dbl.some(L => L.gid === c.gid && L.key === c.key)), { lo: 0, hi: 1, min: 2, max: 3 });
    out.push(finish(pre + '-fav', `Favourites' winning scores · ${fav && fav.length === 3 ? 'treble' : 'double'}`, fav, { lottery: true }));
  } else if (sec === 'scorers') {
    out.push(finish(pre + '-2', 'Anytime scorer double', buildTier(games, CAND.scorers, { lo: .3, hi: .8, min: 2, max: 2 }, { uniq: scorerUniq })));
    out.push(finish(pre + '-3', 'Anytime scorer treble', buildTier(games, CAND.scorers, { lo: .3, hi: .8, min: 3, max: 3 }, { uniq: scorerUniq })));
    out.push(finish(pre + '-sgp', 'Scorer + team win · same game', sgpScorerWin(games), { sgp: true }));
  } else {
    const tiers = sec === 'mega' ? MEGA_TIERS : TIERS;
    for (const T of tiers) out.push(finish(`${pre}-${T.name.replace(/ /g, '').toLowerCase()}`, `${sec === 'mega' ? 'Mega Mix' : S.label} · ${T.name}`, buildTier(games, CAND[sec], T, { diverse: sec === 'mega', rank: 'mid', uniq: sec === 'mega' ? c => c.key.startsWith('G:') ? scorerUniq(c) : [] : null }), { tier: T.name }));
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
    <div class="gauge" style="--p:${Math.max(0, Math.min(1, +P.p || 0)).toFixed(3)}" aria-hidden="true"><i></i></div>
    <div style="margin-top:4px">${legs}</div>
    <div class="pcfoot"><div class="odds mono">${esc(SB.fmtOdds(P.p))}<small>Fair odds · $10 pays ${money(10 / P.p)}${boost > 1.02 ? ` · same-game boost +${pct(boost - 1)}` : ''}</small></div></div>
    <div class="spbtns"><button class="btn" data-sp-build="${esc(P.id)}">Open in builder</button>${hasSim() ? `<button class="btn ghost" data-sp-sim="${esc(P.id)}">Simulate 100k</button>` : ''}</div>
    <div class="note">Bet only at <b class="mono">${esc(SB.fmtOdds(P.p))}</b> or better (${esc(edgePx)} = a 5% edge). ${P.lottery ? 'Correct scores miss far more often than they land; stake small.' : 'Hit chance is a model estimate, not a promise.'}</div></div>`;
}
const emptyCard = (title, msg) => `<div class="pc sp-empty"><div class="pchead"><span class="pctitle">${esc(title)}</span></div><div class="why">${msg}</div></div>`;
function cell(g, key, short, opts = {}) {
  const p = SB.p1(g, key), id = g.id + '|' + key, can = SB.priced(g) && p > 0, inS = SB.inSlip(g.id, key);
  const st2 = opts.heat != null ? ` style="background:color-mix(in srgb,var(--heat) ${Math.round(8 + 62 * opts.heat)}%,var(--card))"` : '';
  return `<button class="spc${opts.heat != null ? ' heat' : ''}${inS ? ' in' : ''}" data-leg="${esc(id)}" ${can ? '' : 'disabled'}${st2} title="${esc(SB.legLabel({ gid: g.id, key }) + ' · ' + pct(p, 1) + ' · fair ' + SB.fmtOdds(p))}" aria-label="${esc(SB.legLabel({ gid: g.id, key }) + ', ' + pct(p, 1) + ', fair price ' + SB.fmtOdds(p))}"><i>${esc(short)}</i><b>${pct(p, p < .1 ? 1 : 0)}</b><span>${esc(SB.fmtOdds(p))}</span></button>`;
}
// knockout / playoff fixtures where a level game goes to extra time or penalties. The feed's comp for this week's MLS Cup
// Playoffs is plain "MLS", so MLS games from November on count too (the regular season ends in October).
const KO_RE = /playoff|play off|knockout|final|cup|round of|wild card/i;
function isKnockout(g) { const d = new Date(SB.startMs(g)); return KO_RE.test(`${g.comp || ''} ${g.tag || ''}`) || (leagueOf(g.comp).id === 'mls' && d.getUTCMonth() >= 10); }
const EXPG_TIP = 'Model expected goals implied by the match\'s win chances (not shot-based xG)';
function matchHead(g) {
  const X = xg(g), est = g.src !== 'Sportradar' ? ' <span class="badge b-est">EST</span>' : '';
  const ko = isKnockout(g) ? ' <span class="badge b-tag" title="Settles on 90 minutes plus stoppage time; extra time and penalties don\'t count">90-MIN RESULT</span>' : '';
  const eg = v => SB.priced(g) ? `<small class="mono" title="${EXPG_TIP}">Exp. goals ${f2(v)}</small>` : '';
  return `<div class="mkhead" data-open="${esc(g.id)}"><span class="lg">${esc(g.comp)}${est}${ko}</span><span>${shortWhen(g)}</span></div>
   <div class="spteams" data-open="${esc(g.id)}"><div>${SB.abBox(g.home)}<span class="tn">${esc(g.home.name)}</span>${eg(X.eh)}</div><div>${SB.abBox(g.away)}<span class="tn">${esc(g.away.name)}</span>${eg(X.ea)}</div></div>`;
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
    const stale = S.team && staleDays(S.team, g) > STALE_DAYS ? ' <span class="badge b-est">OLD DATA</span>' : '';
    html += `<div class="spteam"><span>${esc(S.name)}${stale}</span> <small title="${EXPG_TIP}">Exp. goals ${f2(s === 'home' ? X.eh : X.ea)}</small></div>`;
    if (!S.team) { html += `<div class="note" style="margin:2px 0 6px">No scorer data for ${esc(S.name)} yet. Use team goal markets instead.</div>`; continue; }
    const rows = S.players.map(x => ({ x, p: SB.p1(g, 'G:' + x.id) })).sort((a, b) => b.p - a.p || cmpId(a.x.id, b.x.id));
    html += rows.map(({ x, p }) => {
      const flags = [x.status === 'doubtful' ? '<span class="warnflag" title="Priced as if he plays: the bet is void if he doesn\'t">DOUBTFUL</span>' : '', x.priorOnly ? '<span class="warnflag">NO GOAL DATA</span>' : '', x.est ? '<span class="badge b-est">UNCONFIRMED</span>' : '', x.pens ? '<span class="badge b-tag">PENS</span>' : ''].join('');
      const meta = `${x.pos} · ${x.priorOnly ? 'position average only' : x.goals + ' league goal' + (x.goals === 1 ? '' : 's')} · ~${pct(x.e)} of team goals${x.status === 'doubtful' ? ' · void if he doesn\'t play' : ''}`;
      const k1 = 'G:' + x.id, k2 = 'G:1st:' + x.id, p2 = SB.p1(g, k2);
      return `<div class="sprow"><div class="spname"><b>${esc(x.name)}</b>${flags}<small>${esc(meta)}</small></div>
        <button class="yes ${SB.inSlip(g.id, k1) ? 'in' : ''}" data-leg="${esc(g.id + '|' + k1)}" aria-label="${esc(x.name + ' to score, ' + pct(p) + ', fair ' + SB.fmtOdds(p))}"><small>Anytime ${pct(p)}</small>${esc(SB.fmtOdds(p))}</button>
        <button class="yes ${SB.inSlip(g.id, k2) ? 'in' : ''}" data-leg="${esc(g.id + '|' + k2)}" aria-label="${esc(x.name + ' first goalscorer, ' + pct(p2, 1) + ', fair ' + SB.fmtOdds(p2))}"><small>First ${pct(p2, p2 < .1 ? 1 : 0)}</small>${esc(SB.fmtOdds(p2))}</button></div>`;
    }).join('');
    if (S.out.length) html += `<div class="note" style="margin:2px 0 6px">Left out (listed as out): ${esc(S.out.map(p => p.name).join(', '))}.</div>`;
  }
  return html;
}
// days between a team's lastChecked date (scorers.json) and kickoff; 0 when unknown
function staleDays(t, g) { const c = Date.parse(t.lastChecked || ''); return isFinite(c) ? (SB.startMs(g) - c) / DAY : 0; }
function scorerFreshness() {
  const sc = SB.DATA.scorers;
  if (!sc) return `<div class="lineup"><span>⚠️</span><div><b>Scorer data isn't loaded.</b> Goalscorer markets need scorers.json; the other sections still work.</div></div>`;
  const u = sc.updated ? new Date(sc.updated) : null;
  return `<div class="lineup"><span>📋</span><div><b>Lineups are not confirmed.</b> Check team news before betting a scorer. Data compiled ${u ? esc(u.toLocaleString([], { month: 'short', day: 'numeric' })) : '—'}${sc.asOf ? `; ${esc(sc.asOf.replace(/^Goal totals/, 'goal totals'))}` : ''}. Out players are excluded. Scorer bets are void (stake back) at most books if the player doesn't play, so prices here assume he plays; doubtful players get fewer expected minutes and are never auto-picked, nor are defenders. Like every market here, scorer prices cover 90 minutes plus stoppage time; shootout goals never count.</div></div>`;
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
    const n = pmCount(L.id);
    html += `<div class="empty sp-empty" style="margin-top:14px"><b>${esc(L.name)}</b><br>No ${esc(L.name)} fixtures in the app's game feed right now, so there is nothing to price here.${n ? ` Polymarket lists ${n} ${esc(L.name)} game${n === 1 ? '' : 's'} in the next 8 days: <button type="button" class="linkbtn" data-gotab="polymarket">see them in the Polymarket tab</button>.` : ''}</div>`;
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
  html += `<div class="note" style="margin-top:14px">All soccer markets settle on 90 minutes plus stoppage time; extra time and penalty shootouts don't count (shootout goals never count for scorers). Percentages are model estimates from each match's win chances (exact score grid; scorers from season goal shares), not guarantees. Fair odds have no bookmaker margin: only bet when your book pays more. Leagues in the feed now: ${esc(LL.top.filter(x => x.n).map(x => x.name).join(', ') || 'none')}${LL.more.length ? ', plus ' + esc(LL.more.map(x => x.name).join(', ')) : ''}.${LL.top.some(x => !x.n) ? ` No fixtures in the feed for ${esc(LL.top.filter(x => !x.n).map(x => x.name).join(', '))}.` : ''}</div>`;
  main.innerHTML = html;
  lastMs = performance.now() - t0;
}
// Polymarket can list a league the game feed doesn't carry (Europa League, Eredivisie, Primeira Liga today): count its games in
// the next 8 days (the Polymarket tab's longest window) so an empty league says where they are instead of promising a refresh
function pmCount(id) {
  const pm = window.__polymarket && window.__polymarket.PM, now = nowMs();
  return ((pm && pm.games) || []).filter(pg => pg.sport === 'soccer' && leagueOf(pg.comp).id === id && Date.parse(pg.start) > now && Date.parse(pg.start) - now <= 8 * DAY).length;
}
function groupBy(arr, f) { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m]; }

// ---------------- events ----------------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sp-lg],[data-sp-sec],[data-sp-build],[data-sp-sim]'); if (!t) return;
  if (t.dataset.spLg != null) { st.lg = t.dataset.spLg; if (st.lg !== 'all' && st.sec === 'best') st.sec = 'overs'; save(); renderTab($main()); keepChipVisible(); return; }
  if (t.dataset.spSec != null) { st.sec = t.dataset.spSec; save(); renderTab($main()); keepChipVisible(); return; }
  const P = CACHE[t.dataset.spBuild || t.dataset.spSim]; if (!P) return;
  const legs = P.legs.map(L => ({ gid: L.gid, key: L.key, label: L.label, sport: 'soccer' }));
  if (t.dataset.spBuild != null) { (SB.replaceSlip || SB.setSlip)(legs, legs[0].gid + "|" + legs[0].key); SB.openSlip(); return; }
  SB.goTab('sim', { legs, title: P.title, from: 'soccerparlays', p: P.p });
});
function keepChipVisible() { for (const el of document.querySelectorAll('#main .spnav .chip.on')) { const r = el.parentElement; const x = el.offsetLeft - r.offsetLeft; if (x < r.scrollLeft || x + el.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = Math.max(0, x - 40); } }
// keep in-slip highlights in sync when the slip changes elsewhere (builder sheet, other tabs)
SB.on('slip', () => { for (const b of document.querySelectorAll('#main .spc[data-leg], #main .sprow [data-leg]')) { const s = b.dataset.leg, i = s.indexOf('|'); b.classList.toggle('in', SB.inSlip(s.slice(0, i), s.slice(i + 1))); } });

// ---------------- styles ----------------
const css = `
.spnav{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;margin:10px -16px 0;padding:2px 16px 4px}
.spnav::-webkit-scrollbar{display:none}
.spnav .chip .n{display:inline-block;min-width:18px;margin-left:7px;padding:0 5px;border-radius:3px;background:var(--soft2);color:var(--mute);font-size:11.5px;font-weight:700;font-style:italic;text-align:center;line-height:17px;font-variant-numeric:tabular-nums}
.spnav .chip.on .n{background:color-mix(in srgb,var(--bg) 28%,transparent);color:var(--on-blue)}
.spnav .chip.zero{opacity:.6}
.spnav .more{flex:none;align-self:center;font-size:10.5px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.16em;padding:0 0 0 6px}
.spsecs{margin-top:4px}
@media(min-width:760px){.spnav{flex-wrap:wrap;overflow:visible;margin:10px 0 0;padding:2px 0 4px}}
.spcard .hit{white-space:nowrap;flex:none}
.spcard .badge,.spname .badge,.spname .warnflag{white-space:nowrap;display:inline-block}
.spsecs .chip{padding:6px 12px;font-size:13px;border-radius:5px}
.spcard .legtxt .spwhy{display:block;font-style:normal;font-size:12px;color:var(--mute);font-weight:450;margin-top:2px;line-height:1.35}
.spcard .legp{text-align:right}.spcard .legp small{display:block;font-size:11.5px;color:var(--dim);font-weight:600;font-style:normal}
.spbtns{display:flex;gap:8px;margin-top:10px}.spbtns .btn{flex:1;padding:11px 8px;font-size:13px;letter-spacing:.02em}
.spteams{display:grid;gap:6px;margin:10px 0 4px;cursor:pointer}
.spteams>div{display:flex;align-items:center;gap:9px;min-width:0}
.spteams .tn{font-size:15.5px;flex:1;min-width:0}
.spteams small{font-size:12px;color:var(--dim);font-weight:600;flex:none}
.spcells{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:6px;margin-top:8px}
.spcells.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
.spcells.c5{grid-template-columns:repeat(5,minmax(0,1fr))}
.spcells.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
.spduo{display:grid;grid-template-columns:1fr;gap:0}
.spduo .spcells{margin-top:6px}
@media(min-width:520px){.spduo{grid-template-columns:1fr 1fr;gap:10px}}
.spsub{font-size:10.5px;font-weight:700;font-style:italic;color:var(--dim);text-transform:uppercase;letter-spacing:.14em;margin:12px 0 0}
.sp2{grid-template-columns:minmax(0,1fr) auto auto}
.sp2 .spname small{margin:0 0 1px;text-transform:uppercase;font-weight:700;letter-spacing:.1em}
.sp2 .spname b{font-size:14.5px;display:block}
.sppct{font-weight:800;font-size:15px}
.sp2 .yes{padding:8px 0}
.spcells.c-wide{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}
.spc{border:1px solid var(--line);background:var(--soft);border-radius:5px;padding:6px 2px;text-align:center;cursor:pointer;color:var(--text);font-family:inherit;min-width:0;transition:border-color .15s,background .15s}
.spc:hover:not(:disabled){border-color:var(--glow)}
.spc i{display:block;font-style:normal;font-size:11px;font-weight:600;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
.spc b{display:block;font-size:15px;font-weight:800;font-style:italic;font-stretch:108%;font-variant-numeric:tabular-nums}
.spc span{display:block;font-size:11px;font-weight:600;font-style:italic;color:var(--mute);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spc.heat i,.spc.heat span{color:var(--heat-ink)}
.spc.in{outline:2px solid var(--ice);outline-offset:-2px;box-shadow:0 0 12px color-mix(in srgb,var(--ice) 45%,transparent)}
.spc.in:not(.heat){background:linear-gradient(180deg,var(--blue-top) 0,var(--blue-fill) 22%,var(--blue-deep));border-color:var(--ice);color:var(--on-blue)}
.spc.in:not(.heat) i,.spc.in:not(.heat) span{color:var(--on-blue)}
.spc:disabled{opacity:.5;cursor:default}
.spteam{font-size:12.5px;font-weight:800;font-style:italic;font-stretch:110%;color:var(--chrome);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 2px;display:flex;justify-content:space-between}
.spteam small{font-weight:600;font-style:normal;font-stretch:100%;color:var(--dim);text-transform:none;letter-spacing:0;flex:none;margin-left:8px}
.spteam .badge{margin-left:4px}
.mkhead .lg .badge{margin-left:4px}
.sprow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.spname{min-width:0}.spname b{font-size:15px;font-weight:650;margin-right:2px}
.spname small{display:block;font-size:11.5px;color:var(--dim);font-weight:500;margin-top:1px}
.sprow .yes{width:74px;padding:6px 0;font-size:13px;line-height:1.2}
.sprow .yes small{display:block;font-size:10.5px;font-weight:600;font-style:normal;opacity:.85}
.splink{color:var(--blue);font-weight:700;cursor:pointer}
.splink:hover{color:var(--ice)}
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
  ieTable, cands: (sec, gid) => CAND[sec](SB.gameById(gid)), PAD, isKnockout, get state() { return { ...st }; }, get lastMs() { return lastMs; }, render: () => renderTab($main()) };
})();
