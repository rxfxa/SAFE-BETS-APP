// ask.js: the Chat screen (key 'ask'), Safe Bets' research assistant.
//  - Empty state: the orb, "Ask Safe Bets", suggestion chips built from today's slate (fantasy questions in fantasy mode) and
//    a composer that stays at the bottom ("Ask Safe Bets anything", send, and Scan a slip -> Slip Check).
//  - Answers: Claude through the artifact's `sample` capability, called ONLY when the viewer sends. Claude gets page tools that
//    run the app's own engine (find_players, prop_report, game_report, build_parlay, price_parlay, top_props, start_sit) and
//    read this season's data for breakdowns (player_stats: any player's season and recent games; review_player: what went
//    right or wrong in one game; review_parlay: a parlay leg by leg, from the app's graded picks, My Parlays or typed legs;
//    team_report; leaders; track_record). Its words stream in as text (a small markdown subset built with textContent, never
//    innerHTML), and the cards under the answer are drawn from the engine's numbers and the box scores, never from Claude's
//    words. Breakdowns keep facts (from the data) apart from possibilities, say how close it was, and what that says.
//  - Offline (no window.claude, use() resolves null, the viewer said no, the account has no Claude): a local parser reads the
//    question (player names, stat words, a line, an American price, "parlay" + legs + sport, "best props", start / sit, "how
//    did X do", "X stats", "what went wrong with my parlay / yesterday's picks", "how did your picks do", "who leads ...",
//    "TEAM record"), runs the same tools and shows the same cards with a short templated sentence, plus a quiet note.
//  - History: the last 20 messages (text + card specs) in localStorage 'fm2.chat'. Cards are re-priced from the live slate
//    each time they are drawn. Params: {q} fills the box; {q, send: true} asks it (only from a viewer's click).
// Every chance is a model estimate; the app has no sportsbook prop prices, so cards show fair odds unless the viewer gives a price.
(function () {
  'use strict';
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('ask.js: window.SB v2 API (with SB.ui) not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'ask';
  const num = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pc = p => (!num(p) ? '—' : p > 0 && p < .01 ? '<1%' : p > .99 && p < 1 ? '>99%' : Math.round(p * 100) + '%');
  const f1 = x => (num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const sg = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1);
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  const nmOf = s => norm(s).split(' ').filter(w => w && !SUFFIX.has(w)).join(' ');
  const fmtLine = x => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const amOf = dec => SB.fmtAm(SB.dec2am(dec));
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'college football', nhl: 'NHL', soccer: 'soccer' };
  const TOT = { nba: 228, nfl: 44, ncaaf: 52 };  // the engine's league-average game totals (index.html TOTDEF)
  const ST_NAME = { pts: 'points', reb: 'rebounds', ast: 'assists', rec: 'receptions', ryd: 'rushing yards', recyd: 'receiving yards', pyd: 'passing yards', sog: 'shots on goal', td: 'anytime TD' };
  const ST_TITLE = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', rec: 'Receptions', ryd: 'Rushing yards', recyd: 'Receiving yards', pyd: 'Passing yards', sog: 'Shots on goal', td: 'Touchdowns' };
  const ST_SHORT = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'rec', ryd: 'rush yds', recyd: 'rec yds', pyd: 'pass yds', sog: 'SOG', td: 'TD' };

  // ---------------------------------------------------------------- season box scores (season.json, loaded once)
  let SEASON = null, SIDX = null, seasonP = null, SEASON_DONE = false;
  function loadSeason() {
    if (!seasonP) seasonP = Promise.resolve(typeof SB.season === 'function' ? SB.season() : null).catch(() => null).then(d => { SEASON = d && d.sports ? d : null; SIDX = null; SEASON_DONE = true; return SEASON; });
    return seasonP;
  }
  function sIndex() {
    if (SIDX || !SEASON) return SIDX;
    SIDX = {};
    for (const [sp, S] of Object.entries(SEASON.sports || {})) {
      if (!S || typeof S !== 'object') continue;
      const m = new Map();
      for (const p of Array.isArray(S.players) ? S.players : []) { if (!p || typeof p.n !== 'string' || !p.n) continue; const k = E.nameKey(p.n); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
      const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
      const teams = obj(S.teams), results = obj(S.results);
      SIDX[sp] = { sp, m, fields: Array.isArray(S.fields) ? S.fields : [], teams, results, byTeam: new Map(Object.entries(teams).map(([ab, nm]) => [E.nameKey(nm), ab])), rc: new Map() };
    }
    return SIDX;
  }
  // box-score logs are dated by the game's UTC start date (a 4 PM PT game on Nov 22 is logged 2026-11-23). A logged game
  // counts when its date is before the priced game's UTC date and not after today's UTC date (so last night's game stays in
  // on a back-to-back, and nothing logged later than the game being priced leaks in).
  function logCut(g) {
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    const gd = g ? (typeof g.start === 'string' && g.start.length >= 10 ? g.start.slice(0, 10) : num(SB.startMs(g)) ? new Date(SB.startMs(g)).toISOString().slice(0, 10) : null) : null;
    return d => { d = String(d || '').slice(0, 10); return !!d && (!gd || d < gd) && d <= today; };
  }
  function seasonOf(sp, name, team, g) {
    const X = sIndex(), S = X && X[sp]; if (!S) return null;
    const L = S.m.get(E.nameKey(name)); if (!L || !L.length) return null;
    const t = String(team || '').toUpperCase();
    const p = L.find(x => x.t === t) || L.slice().sort((a, b) => (b.gp || 0) - (a.gp || 0))[0];
    const ok = logCut(g);
    return { p, S, rows: (p.log || []).filter(r => ok(r[0])).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
  }
  const val = (S, row, f) => { const i = S.fields.indexOf(f); if (i < 0) return null; const v = Number(row[3 + i]); return isFinite(v) ? v : null; };
  const sumF = (S, row, fs) => fs.reduce((s, f) => s + (val(S, row, f) || 0), 0);

  // ---------------------------------------------------------------- players on the slate (from the live DATA)
  const COMMON = new Set('will best over under point points game games start score more less good take tonight today week green white young brown black love king hill price rice power smart strong swift cash ball case line lines bets prop props team time what when where which with about should would could there their this that them then than have from into your house field ford banks shot shots yards long short wood woods bell page wells hunt stone park chase james jordan allen more most hope rich bush lamb cook mills fields gay'.split(' '));
  const TEAMSTOP = new Set('real city united club sporting athletic racing inter saint state college university north south east west new york los angeles team football calcio olympique stade borussia atletico deportivo union olympic central eastern western northern southern'.split(' '));
  const ABSTOP = new Set('IT OR AT IN ON TO US ME MY NO SO UP AN AS BE BY DO GO HE IF IS OF OK WE TD TDS NBA NFL NHL MLS PPR QB RB WR TE SGP AI ML OT VS AM PM FC'.split(' '));
  let PX = null;
  function pIndex() {
    const D = SB.DATA; if (PX && PX.D === D) return PX;
    const by = new Map(), nextG = new Map();
    for (const g of D.games || []) {
      if (!SB.openG(g) || SB.isVoid(g)) continue;
      for (const t of [g.home.abbr, g.away.abbr]) { const k = g.sport + '|' + t, o = nextG.get(k); if (!o || SB.startMs(g) < SB.startMs(o)) nextG.set(k, g); }
    }
    for (const pl of D.players || []) {
      if (!pl || !pl.name || !ST_NAME[pl.stat]) continue;
      const g = SB.gameById(pl.gid); if (!g || !SB.openG(g) || SB.isVoid(g)) continue;
      const k = E.nameKey(pl.name), st = SB.startMs(g); let e = by.get(k);
      if (e && e.sport !== g.sport) continue;
      if (!e || st < e.start) { e = { k, name: pl.name, nm: nmOf(pl.name), team: pl.team, pos: pl.pos || null, sport: g.sport, gid: g.id, start: st, stats: {}, td: e ? e.td : null }; by.set(k, e); }
      if (g.id !== e.gid) continue;
      if (!e.stats[pl.stat] || (e.stats[pl.stat].status !== 'active' && pl.status === 'active')) e.stats[pl.stat] = pl;
      if (!e.pos && pl.pos) e.pos = pl.pos;
    }
    const TD = E.nflByTd;
    if (TD) for (const [tk, x] of TD) {
      const i = tk.indexOf('|'), team = tk.slice(0, i), slug = tk.slice(i + 1), g = nextG.get('nfl|' + team); if (!g || !x || !x.name) continue;
      const k = E.nameKey(x.name); let e = by.get(k);
      if (!e) { e = { k, name: x.name, nm: nmOf(x.name), team, pos: x.pos || null, sport: 'nfl', gid: g.id, start: SB.startMs(g), stats: {}, td: null }; by.set(k, e); }
      if (e.sport !== 'nfl' || e.team !== team || e.gid !== g.id) continue;
      e.td = { gid: g.id, key: `TD:A:${team}:${slug}` }; if (!e.pos) e.pos = x.pos || null;
    }
    const list = [...by.values()];
    // name keys: the full name, a surname of 2+ words ("gilgeous alexander", "st brown"), the last word and each part of a
    // hyphenated surname, and a first name ("lebron") that only one slate player has and nobody has as a surname
    const K = { full: new Map(), sur: new Map(), last: new Map(), first: new Map() };
    const add = (M, k, e) => { if (!k) return; if (!M.has(k)) M.set(k, []); const L = M.get(k); if (!L.includes(e)) L.push(e); };
    for (const e of list) {
      const words = lcName(e.name).split(/\s+/).filter(w => w && !SUFFIX.has(w.replace(/-/g, '')));
      e.lc = lcName(e.name); e.first = norm(words[0] || '');
      const sur = norm(words.slice(1).join(' ')), st = sur.split(' ');
      add(K.full, e.nm, e);
      if (st.length >= 2) add(K.sur, sur, e);
      if (st[st.length - 1]) add(K.last, st[st.length - 1], e);
      for (const w of words.slice(1)) if (w.includes('-')) for (const part of w.split('-')) { const p = norm(part); if (p.length >= 4) add(K.last, p, e); }
      if (e.first && !e.first.includes(' ')) add(K.first, e.first, e);
    }
    const teamW = new Set();
    for (const g of D.games || []) for (const t of [g.home, g.away]) for (const w of norm(t && t.name).split(' ')) if (w.length >= 4) teamW.add(w);
    return (PX = { D, by, list, K, teamW, nextG });
  }
  // lower case, accents and apostrophes / dots dropped, hyphens kept ("Shai Gilgeous-Alexander" -> "shai gilgeous-alexander")
  function lcName(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`.]/g, ''); }
  // the sport a question points at, from its words: league names first, then the stat named
  function hintOf(lc) {
    const sp = sportOf(lc); if (sp) return [sp];
    const st = statFrom(lc);
    if (st === 'pts' || st === 'reb' || st === 'ast') return ['nba'];
    if (st && st !== 'sog') return ['nfl', 'ncaaf'];
    return null;
  }
  // names in a question. Every key that appears is a candidate; the longest wins where two overlap (so "Alexander-Walker"
  // is never read as Gilgeous-Alexander plus a Walker). A last or first name alone must not be an everyday word or a team
  // word, and a hyphenated word must belong to that player ("alexander-walker" is not Shai Gilgeous-Alexander).
  // Two players with that surname: a first name in the question decides, else the sport / stat named, else the bigger
  // role; the answer then says who it picked (amb).
  function matchPlayers(lc) {
    const X = pIndex(), qn = ' ' + lc.replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const spans = key => {  // where a key ("lj phillips") sits in the question: dots between letters and any separator between words allowed
      const rx = new RegExp('(^|[^a-z0-9])(' + key.split(' ').map(w => w.split('').join('\\.?')).join('[^a-z0-9]+') + ')(?![a-z0-9])', 'g');
      const r = []; let m; while ((m = rx.exec(lc))) { r.push({ at: m.index + m[1].length, len: m[2].length }); if (!m[2].length) break; } return r;
    };
    const compound = (at, len) => { let s = at, t = at + len; while (s > 0 && /[a-z-]/.test(lc[s - 1])) s--; while (t < lc.length && /[a-z-]/.test(lc[t])) t++; return lc.slice(s, t).replace(/^-+|-+$/g, ''); };
    const C = [];
    const cand = (type, w, M, ok) => { for (const [k, L] of M) if (ok(k, L) && qn.includes(' ' + k + ' ')) for (const s of spans(k)) C.push({ type, w, k, L, at: s.at, len: s.len }); };
    cand('full', 3, X.K.full, k => k.length >= 5);
    cand('sur', 2, X.K.sur, () => true);
    const solo = k => k.length >= 4 && !COMMON.has(k) && !TEAMSTOP.has(k) && !X.teamW.has(k);
    cand('last', 1, X.K.last, solo);
    cand('first', 0, X.K.first, (k, L) => L.length === 1 && k.length >= 5 && solo(k) && !X.K.last.has(k));
    C.sort((a, b) => b.len - a.len || b.w - a.w || a.at - b.at);
    const taken = [], out = new Map();
    for (const c of C) {
      if (taken.some(t => c.at < t.at + t.len && t.at < c.at + c.len)) continue;
      let L = c.L.filter(e => !out.has(e.k));
      if (c.type === 'last' || c.type === 'first') { const cp = compound(c.at, c.len); if (/[a-z]-[a-z]/.test(cp)) L = L.filter(e => e.lc.includes(cp)); }
      if (!L.length) continue;
      let pick = L[0], amb = null;
      if (L.length > 1) {
        const byFirst = L.filter(e => e.first && qn.includes(' ' + e.first + ' '));
        if (byFirst.length === 1) pick = byFirst[0];
        else {
          const hint = hintOf(lc), st = statFrom(lc);
          let pool = hint ? L.filter(e => hint.includes(e.sport)) : L; if (!pool.length) pool = L;
          const size = e => { const s = st && e.stats[st]; if (s) return s.avg || 0; const m = e.sport === 'nba' ? e.stats.pts : e.stats.recyd || e.stats.ryd || e.stats.pyd; return m ? (m.avg || 0) / (e.sport === 'nba' ? 1 : 4) : 0; };
          pick = pool.slice().sort((a, b) => size(b) - size(a) || a.start - b.start)[0];
          amb = L.filter(e => e !== pick);
        }
      }
      out.set(pick.k, { e: pick, at: c.at, len: c.len, word: lc.slice(c.at, c.at + c.len), amb });
      taken.push(c);
    }
    if (!out.size) {  // "Ja Marr Chase" / "JaMarr Chase": spacing that differs from the feed's
      const sq = qn.replace(/ /g, '');
      for (const e of X.list) { const n = e.nm.replace(/ /g, ''); if (n.length >= 9 && sq.includes(n)) out.set(e.k, { e, at: 0, len: n.length }); }
    }
    return [...out.values()].sort((a, b) => a.at - b.at);
  }
  const ambNote = p => (p && p.amb && p.amb.length ? `Reading "${p.word}" as ${p.e.name} (${p.e.team}). Also on the slate: ${p.amb.slice(0, 3).map(e => `${e.name} (${e.team})`).join(', ')}. Use the full name for another player.` : '');
  function seasonByName(text, sport) {
    const X = sIndex(); if (!X) return null; const k = E.nameKey(text);
    for (const sp of sport ? [sport] : ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer']) { const S = X[sp]; const L = S && S.m.get(k); if (L && L.length) return { sp, p: L.slice().sort((a, b) => (b.gp || 0) - (a.gp || 0))[0] }; }
    return null;
  }
  function seasonInText(lc) {  // a full name of a player who has no game on the slate (season box scores only)
    const X = sIndex(); if (!X) return null; const qn = ' ' + lc.replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    for (const sp of ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer']) { const S = X[sp]; if (!S) continue; for (const L of S.m.values()) { const p = L[0], n = nmOf(p.n); if (n.length >= 6 && n.includes(' ') && qn.includes(' ' + n + ' ')) return { sp, p }; } }
    return null;
  }
  function resolvePlayer(text, sport) {
    const X = pIndex(), t = String(text || '').trim(); if (!t) return null;
    const e0 = X.by.get(E.nameKey(t)); if (e0 && (!sport || e0.sport === sport)) return { e: e0 };
    const lc = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`.]/g, '');
    const hit = matchPlayers(lc).find(x => !sport || x.e.sport === sport); if (hit) return { e: hit.e };
    const w = nmOf(t).split(' ').filter(x => x.length >= 3);
    if (w.length) { const c = X.list.filter(e => (!sport || e.sport === sport) && w.every(x => (' ' + e.nm + ' ').includes(' ' + x))); if (c.length) return { e: c.sort((a, b) => a.start - b.start)[0] }; }
    const s = seasonByName(t, sport); return s ? { s } : null;
  }

  // ---------------------------------------------------------------- breakdowns: the data (any player or team this season, the app's graded picks, My Parlays)
  // season.json keeps every football game and the last 15 for the NBA, NHL and soccer, while `gp` and `tot` cover the whole
  // season: season averages come from tot / gp, splits and game logs from the logged games (the answer says when that is fewer).
  // Box-score and result dates are each game's UTC start date (a US evening game is logged the next day).
  const SF = { min: 'minutes', pts: 'points', reb: 'rebounds', ast: 'assists', pa: 'pass attempts', pyd: 'passing yards', ptd: 'passing TDs', ra: 'carries', ryd: 'rushing yards', rtd: 'rushing TDs',
    tgt: 'targets', rec: 'receptions', recyd: 'receiving yards', ctd: 'receiving TDs', td: 'touchdowns', g: 'goals', a: 'assists', hpts: 'points', sog: 'shots on goal', sot: 'shots on target', sh: 'shots' };
  const SF1 = { min: 'minute', pts: 'point', reb: 'rebound', ast: 'assist', pa: 'pass attempt', pyd: 'passing yard', ptd: 'passing TD', ra: 'carry', ryd: 'rushing yard', rtd: 'rushing TD',
    tgt: 'target', rec: 'reception', recyd: 'receiving yard', ctd: 'receiving TD', td: 'touchdown', g: 'goal', a: 'assist', hpts: 'point', sog: 'shot on goal', sot: 'shot on target', sh: 'shot' };
  const SFS = { min: 'MIN', pts: 'PTS', reb: 'REB', ast: 'AST', pa: 'ATT', pyd: 'PASS YDS', ptd: 'PASS TD', ra: 'CAR', ryd: 'RUSH YDS', rtd: 'RUSH TD', tgt: 'TGT', rec: 'REC', recyd: 'REC YDS', ctd: 'REC TD', td: 'TD', g: 'G', a: 'A', hpts: 'PTS', sog: 'SOG', sot: 'SOT', sh: 'SH' };
  const unitOf = (f, n) => (Math.abs(n) === 1 ? SF1[f] : SF[f]) || f;
  const todayU = () => new Date(Date.now()).toISOString().slice(0, 10);
  const dAdd = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtD = d => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${MON[+String(d).slice(5, 7) - 1]} ${+String(d).slice(8, 10)}` : String(d || ''));
  const gidDate = gid => { const m = /(\d{4}-\d{2}-\d{2})$/.exec(String(gid || '')); return m ? m[1] : ''; };
  const legDate = L => (typeof L.start === 'string' && isFinite(Date.parse(L.start)) ? new Date(Date.parse(L.start)).toISOString().slice(0, 10) : gidDate(L.gid));
  const BLOWN = { nba: 15, nfl: 17, ncaaf: 21, nhl: 4, soccer: 3 }, CLOSEN = { nba: 5, nfl: 8, ncaaf: 8, nhl: 1, soccer: 1 };
  const NEARM = { nba: 3, nfl: 3, ncaaf: 3, nhl: 1, soccer: 1 }, NEART = { nba: 4, nfl: 3, ncaaf: 3, nhl: 1, soccer: 1 };
  const PTW = { nba: 'points', nfl: 'points', ncaaf: 'points', nhl: 'goals', soccer: 'goals' };
  const fN = x => (!num(x) ? '—' : Number.isInteger(x) ? String(x) : f1(x));
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const POS = p => String(p || '').toUpperCase();
  const SP_ORDER = ['nba', 'nfl', 'nhl', 'soccer', 'ncaaf'];
  const COVER = 'NFL, college football, the NBA, the NHL and 5 soccer leagues (Premier League, La Liga, Serie A, Bundesliga, Ligue 1), from this season\'s ESPN box scores';
  const UTCNOTE = 'Dates are each game\'s UTC start date, so a US evening game shows the next day.';
  const httpsOnly = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>\\]+$/i.test(u) ? u : null);
  // "about 3 times in 10" / "about 1 time in 7": how often a chance q comes up
  const freqW = q => (!num(q) ? '' : q <= .005 ? 'almost never' : q >= .995 ? 'almost every time' : q < .15 ? `about 1 time in ${Math.round(1 / q)}` : `about ${Math.round(q * 10)} times in 10`);

  const xOf = sp => { const X = sIndex(); return X && X[sp] ? X[sp] : null; };
  function hasF(sp, f) { const X = xOf(sp); if (!X) return false; const F = X.fields; return f === 'td' ? F.includes('rtd') && F.includes('ctd') : f === 'hpts' ? sp === 'nhl' && F.includes('g') : F.includes(f); }
  function rv(sp, r, f) { const X = xOf(sp); if (!X) return 0; if (f === 'td') return (val(X, r, 'rtd') || 0) + (val(X, r, 'ctd') || 0); if (f === 'hpts') return (val(X, r, 'g') || 0) + (val(X, r, 'a') || 0); return val(X, r, f) || 0; }
  function tv(sp, tot, f) { const X = xOf(sp); if (!X) return 0; const g = k => { const i = X.fields.indexOf(k); return i < 0 ? 0 : +((tot || [])[i]) || 0; }; return f === 'td' ? g('rtd') + g('ctd') : f === 'hpts' ? g('g') + g('a') : g(f); }
  function showF(sp, pos) {
    if (sp === 'nba') return ['pts', 'reb', 'ast', 'min'];
    if (sp === 'nhl') return ['g', 'a', 'hpts', 'sog'];
    if (sp === 'soccer') return ['g', 'sot', 'sh'];
    const P = POS(pos); return P === 'QB' ? ['pyd', 'ptd', 'pa', 'ryd'] : P === 'RB' ? ['ryd', 'ra', 'td', 'rec', 'recyd'] : ['rec', 'recyd', 'tgt', 'td'];
  }
  function mainF(P) { const sp = P.sp, p = POS(P.pos); if (sp === 'nba') return 'pts'; if (sp === 'nhl') return 'hpts'; if (sp === 'soccer') return tv(sp, P.tot, 'g') >= 2 ? 'g' : 'sot'; return p === 'QB' ? 'pyd' : p === 'RB' ? 'ryd' : 'recyd'; }
  // the workload behind a stat: [fields, label] (minutes, pass attempts, carries, targets, shots)
  function useOf(sp, pos, f) {
    if (sp === 'nba') return f === 'min' ? null : [['min'], 'minutes'];
    if (sp === 'nhl') return f === 'sog' ? null : [['sog'], 'shots on goal'];
    if (sp === 'soccer') return f === 'sh' ? null : [['sh'], 'shots'];
    if (f === 'pa' || f === 'ra' || f === 'tgt') return null;
    if (f === 'pyd' || f === 'ptd') return [['pa'], 'pass attempts'];
    if (f === 'ryd' || f === 'rtd') return [['ra'], 'carries'];
    if (f === 'td') return POS(pos) === 'WR' || POS(pos) === 'TE' ? [['tgt'], 'targets'] : [['ra', 'tgt'], 'carries + targets'];
    return [['tgt'], 'targets'];
  }
  // a stat named in words -> a season.json field for that sport ("rushing touchdowns" -> rtd, "points" -> hpts in the NHL)
  const SFRX = [[/\bminutes?\b|\bmins\b/, () => 'min'], [/\bpass(ing)? (tds?|touchdowns?)\b|\btd pass(es)?\b/, () => 'ptd'], [/\brush(ing)? (tds?|touchdowns?)\b/, () => 'rtd'], [/\b(receiving|rec) (tds?|touchdowns?)\b/, () => 'ctd'],
    [/\bpass(ing)? attempts?\b|\bthrows\b/, () => 'pa'], [/\b(carries|rush(ing)? attempts?|rushes)\b/, () => 'ra'], [/\btargets?\b|\btargeted\b/, () => 'tgt'],
    [/\bshots? on target\b|\bsot\b/, () => 'sot'], [/\bshots? on goal\b|\bsog\b/, sp => (sp === 'soccer' ? 'sot' : 'sog')], [/\bshots?\b/, sp => (sp === 'soccer' ? 'sh' : 'sog')], [/\bgoals?\b/, () => 'g'],
    [/\b(touchdowns?|tds?|scor(e|es|ed|ing|ers?))\b/, (sp, P) => (sp === 'nba' ? 'pts' : sp === 'nhl' ? 'hpts' : sp === 'soccer' ? 'g' : P === 'QB' ? 'ptd' : 'td')],
    [/\brush(ing)?( yards| yds)?\b|\bran for\b/, () => 'ryd'], [/\b(receiving( yards| yds)?|rec ?yds|rec yards)\b/, () => 'recyd'], [/\bpassing( yards| yds)?\b|\bpass ?(yards|yds)\b|\bthrew for\b/, () => 'pyd'],
    [/\b(receptions?|catch(es)?|caught|rec)\b/, () => 'rec'], [/\b(rebounds?|boards?|rebs?)\b/, () => 'reb'], [/\b(assists?|asts?|dimes)\b/, sp => (sp === 'nhl' ? 'a' : 'ast')],
    [/\b(points?|pts)\b/, sp => (sp === 'nhl' ? 'hpts' : 'pts')], [/\b(yards?|yds)\b/, (sp, P) => (P === 'QB' ? 'pyd' : P === 'RB' ? 'ryd' : 'recyd')]];
  function sfFrom(text, sp, pos) {
    const s = ' ' + String(text || '').toLowerCase() + ' ', P = POS(pos); let best = null;
    for (const [rx, f] of SFRX) { const m = rx.exec(s); if (m && (!best || m.index < best.i || (m.index === best.i && m[0].length > best.n))) best = { i: m.index, n: m[0].length, f: f(sp, P) }; }
    return best && hasF(sp, best.f) ? best.f : null;
  }
  function sfNorm(s, sp, pos) {
    if (s == null || s === '') return null; const t = String(s).toLowerCase().trim();
    if (sp === 'nhl' && (t === 'pts' || t === 'points')) return 'hpts';
    if (sp === 'nhl' && (t === 'ast' || t === 'assists')) return 'a';
    if (t === 'goal') return hasF(sp, 'g') ? 'g' : null;
    if (SF[t] && hasF(sp, t)) return t;
    return sfFrom(t, sp, pos);
  }

  // ---- any player this season
  const ALLX = {};
  function allOf(sp) { const X = xOf(sp); if (!X) return []; if (ALLX[sp] && ALLX[sp].X === X) return ALLX[sp].L; const L = []; for (const ps of X.m.values()) for (const p of ps) L.push({ p, nm: nmOf(p.n) }); ALLX[sp] = { X, L }; return L; }
  // a name (full, or words of it) -> {sp, p, others}: an exact name first, then every word, then word starts; a team given or a
  // player on the slate breaks ties, then the sport order and games played
  function seasonFind(text, sport, team) {
    const X = sIndex(); if (!X) return null;
    const t = String(text || '').trim(); if (!t) return null;
    const sps = (sport && SPORTS.includes(sport) ? [sport] : SP_ORDER).filter(sp => X[sp]);
    const k = E.nameKey(t), w = nmOf(t).split(' ').filter(x => x.length >= 2);
    const C = [];
    for (const sp of sps) for (const p of X[sp].m.get(k) || []) C.push({ sp, p, q: 3 });
    if (!C.length && w.length) for (const sp of sps) for (const x of allOf(sp)) { const n = ' ' + x.nm + ' '; if (w.every(y => n.includes(' ' + y + ' '))) C.push({ sp, p: x.p, q: 2 }); }
    if (!C.length && w.length && w.join('').length >= 4) for (const sp of sps) for (const x of allOf(sp)) { const n = ' ' + x.nm; if (w.every(y => n.includes(' ' + y))) C.push({ sp, p: x.p, q: 1 }); }
    if (!C.length) return null;
    const T = String(team || '').toUpperCase(), slate = pIndex().by;
    const rank = c => (T && c.p.t === T ? 100 : 0) + c.q * 10 + (slate.has(E.nameKey(c.p.n)) && slate.get(E.nameKey(c.p.n)).sport === c.sp ? 5 : 0) - SP_ORDER.indexOf(c.sp) * .5 + Math.min(4, (+c.p.gp || 0) / 5);
    C.sort((a, b) => rank(b) - rank(a));
    const top = C[0], seen = new Set([top.sp + '|' + E.nameKey(top.p.n)]), others = [];
    for (const c of C.slice(1)) { const key = c.sp + '|' + E.nameKey(c.p.n); if (seen.has(key)) continue; seen.add(key); others.push(c); }
    return { sp: top.sp, p: top.p, others: others.slice(0, 3), exact: top.q === 3 };
  }
  // one player's season: logged games up to today (UTC) across his teams (a traded pro is one player; college names repeat)
  function seasonPlayer(sp, p) {
    const X = xOf(sp), today = todayU();
    const ents = sp === 'ncaaf' || !X ? [p] : (X.m.get(E.nameKey(p.n)) || [p]);
    const rows = [], tot = new Array(X ? X.fields.length : 0).fill(0); let gp = 0;
    for (const e of ents) {
      gp += +e.gp || (Array.isArray(e.log) ? e.log.length : 0);
      (Array.isArray(e.tot) ? e.tot : []).forEach((v, i) => { if (i < tot.length) tot[i] += +v || 0; });
      for (const r of Array.isArray(e.log) ? e.log : []) { if (!Array.isArray(r)) continue; const d = String(r[0] || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) rows.push({ d, opp: String(r[1] || ''), home: +r[2] === 1, t: String(e.t || ''), r }); }
    }
    rows.sort((a, b) => a.d.localeCompare(b.d));
    const team = rows.length ? rows[rows.length - 1].t : String(p.t || '');
    return { sp, name: p.n, pos: String(p.pos || ''), team, teams: [...new Set(ents.map(e => String(e.t || '')))], rows, gp, tot, trunc: rows.length < gp };
  }
  const pgOf = (P, f) => (P.gp ? tv(P.sp, P.tot, f) / P.gp : null);
  // the game a question means: a date (a US date the viewer named, or the UTC date a tool listed: exact), an opponent, else the latest
  function rowFor(P, o) {
    const R = P.rows; o = o || {}; if (!R.length) return -1;
    let idx = R.map((_, i) => i);
    if (o.opp) idx = idx.filter(i => R[i].opp === o.opp);
    if (o.d) {
      const pref = o.exact || !(P.sp === 'nba' || P.sp === 'nhl') ? [o.d, dAdd(o.d, 1)] : [dAdd(o.d, 1), o.d];
      for (const d of pref) { const j = idx.filter(i => R[i].d === d); if (j.length) return j[j.length - 1]; }
      return -1;
    }
    return idx.length ? idx[idx.length - 1] : -1;
  }

  // ---- teams and results
  let ESPNC = new Map(), ESPNK = null;
  // feed team -> ESPN abbreviation: the same abbreviation when it names the same team, else by name; soccer has no names in
  // season.json, so there a results abbreviation is all there is
  function espnOf(sp, ab, name) {
    const X = xOf(sp); if (!X || !ab) return null;
    if (ESPNK !== SIDX || ESPNC.N !== SIDE.news || ESPNC.D !== SB.DATA) { ESPNC = new Map(); ESPNK = SIDX; ESPNC.N = SIDE.news; ESPNC.D = SB.DATA; }
    const ck = sp + '|' + ab + '|' + (name || ''); if (ESPNC.has(ck)) return ESPNC.get(ck);
    if (!name) name = feedNameOf(sp, ab);  // a saved leg keeps only the abbreviation: the feed's name for it, when the team is still listed
    const T = X.teams, last = s => { const a = E.nameKey(s).split('-'); return a[a.length - 1]; }, nk = name ? E.nameKey(name) : '';
    let out = null;
    if (T[ab] && (!name || last(T[ab]) === last(name))) out = ab;
    else if (nk && X.byTeam.has(nk)) out = X.byTeam.get(nk);
    else if (nk) { for (const [k, a] of X.byTeam) if (k.length > 4 && (k.startsWith(nk) || nk.startsWith(k))) { out = a; break; } }
    if (sp === 'soccer') { const M = socMap(); out = M && M.f2e.has(ab) ? M.f2e.get(ab) : X.results[ab] ? ab : null; }
    ESPNC.set(ck, out); return out;
  }
  const BIG5 = new Set(['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1']);
  function feedNameOf(sp, ab) { for (const g of SB.DATA.games || []) if (g.sport === sp) { if (g.home.abbr === ab) return g.home.name; if (g.away.abbr === ab) return g.away.name; } return null; }
  function teamName(sp, ab) {
    const X = xOf(sp); if (X && X.teams[ab]) return String(X.teams[ab]);
    if (sp === 'soccer') { const M = socMap(), f = M && M.e2f.get(ab); if (f) return M.feed.get(f).name; if (M && M.ename.has(ab)) return String(M.ename.get(ab)); }
    return String(ab || '');
  }
  // soccer: the feed and ESPN use different club codes, and one code can be two clubs (the feed's MUN is Manchester United,
  // ESPN's is Bayern). A feed club takes an ESPN code only when it is the same code in the same league (the league most of
  // the ESPN club's opponents play in, by the feed), or when one of its finished league or European games matches one ESPN
  // game exactly (date, home side, score, and the other club where that one is known).
  let SOC = null;
  function socMap() {
    const X = xOf('soccer'); if (!X) return null;
    if (SOC && SOC.X === X && SOC.D === SB.DATA && SOC.N === SIDE.news) return SOC;
    const feed = new Map(), closed = [];
    for (const g of SB.DATA.games || []) {
      if (g.sport !== 'soccer') continue;
      for (const t of [g.home, g.away]) { let f = feed.get(t.abbr); if (!f) feed.set(t.abbr, (f = { name: String(t.name), comps: new Set() })); if (BIG5.has(g.comp)) f.comps.add(g.comp); }
      if (SB.isFinal(g) && (BIG5.has(g.comp) || /champions league|europa|conference league/i.test(String(g.comp)))) closed.push({ d: new Date(SB.startMs(g)).toISOString().slice(0, 10), H: g.home.abbr, A: g.away.abbr, h: +g.score.home, a: +g.score.away });
    }
    const league = ab => { const c = {}; for (const r of resRows('soccer', ab)) { const f = feed.get(r.opp); if (f) for (const x of f.comps) c[x] = (c[x] || 0) + 1; } const b = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return b ? b[0] : null; };
    const f2e = new Map(), taken = new Set();
    for (const [fab, f] of feed) { if (!X.results[fab]) continue; const L = league(fab); if (!L || !f.comps.size || f.comps.has(L)) { f2e.set(fab, fab); taken.add(fab); } }
    for (let pass = 0; pass < 2; pass++) for (const c of closed) {
      if (f2e.has(c.H) && f2e.has(c.A)) continue;
      const C = [];
      for (const ab of Object.keys(X.results)) for (const r of resRows('soccer', ab)) if (r.home && r.d === c.d && r.pf === c.h && r.pa === c.a && (!f2e.has(c.H) || f2e.get(c.H) === ab) && (!f2e.has(c.A) || f2e.get(c.A) === r.opp)) C.push([ab, r.opp]);
      if (C.length !== 1) continue;
      const [eh, ea] = C[0];
      if (!f2e.has(c.H) && !taken.has(eh)) { f2e.set(c.H, eh); taken.add(eh); }
      if (!f2e.has(c.A) && !taken.has(ea)) { f2e.set(c.A, ea); taken.add(ea); }
    }
    // ESPN headlines name clubs with ESPN's codes: a feed club of the same name takes that code when it is still free
    const ename = new Map();
    for (const it of (SIDE.news && SIDE.news.items) || []) if (it && it.sport === 'soccer' && Array.isArray(it.teams)) for (const t of it.teams) if (t && typeof t.abbr === 'string' && X.results[t.abbr] && typeof t.name === 'string' && !ename.has(t.abbr)) ename.set(t.abbr, t.name);
    for (const [ab, nm] of ename) { if (taken.has(ab)) continue; const k = E.nameKey(nm); for (const [fab, f] of feed) if (!f2e.has(fab) && E.nameKey(f.name) === k) { f2e.set(fab, ab); taken.add(ab); break; } }
    for (const fab of feed.keys()) if (!f2e.has(fab)) f2e.set(fab, null);
    const e2f = new Map(); for (const [fab, e] of f2e) if (e && !e2f.has(e)) e2f.set(e, fab);
    return (SOC = { X, D: SB.DATA, N: SIDE.news, feed, f2e, e2f, ename });
  }
  function resRows(sp, ab) {
    const X = xOf(sp); if (!X || !ab) return [];
    const today = todayU(), ck = ab + '|' + today; if (X.rc.has(ck)) return X.rc.get(ck);
    const L = Array.isArray(X.results[ab]) ? X.results[ab] : [];
    const out = L.filter(Array.isArray).map(r => ({ d: String(r[0] || '').slice(0, 10), opp: String(r[1] || ''), home: +r[2] === 1, pf: +r[3], pa: +r[4] }))
      .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && x.d <= today && isFinite(x.pf) && isFinite(x.pa)).sort((a, b) => a.d.localeCompare(b.d));
    X.rc.set(ck, out); return out;
  }
  const resOn = (sp, ab, d, opp) => resRows(sp, ab).find(x => x.d === d && (!opp || x.opp === opp)) || null;
  const wlOf = x => (x.pf > x.pa ? 'W' : x.pf < x.pa ? 'L' : 'D');
  const resTxt = (x, ab) => `${ab ? ab + ' ' : ''}${{ W: 'won', L: 'lost', D: 'drew' }[wlOf(x)]} ${x.pf}-${x.pa} ${x.home ? 'vs' : 'at'} ${x.opp}`;
  function scriptOf(sp, x) {  // a final margin in words: blowout / close / neither
    const m = Math.abs(x.pf - x.pa), u = m === 1 ? PTW[sp].replace(/s$/, '') : PTW[sp];
    if (m === 0) return { m, k: 'draw', txt: 'a draw' };
    if (m >= BLOWN[sp]) return { m, k: 'blowout', txt: `by ${m} ${u}, a blowout (${BLOWN[sp]}+)` };
    if (m <= CLOSEN[sp]) return { m, k: 'close', txt: `by ${m} ${u}, a close game` };
    return { m, k: '', txt: `by ${m} ${u}` };
  }
  // points (goals) a team allowed a game and its rank, 1 = fewest (teams with 3+ results)
  function allowedOf(sp, ab) {
    const X = xOf(sp); if (!X) return null;
    if (!X.al || X.al.d !== todayU()) { const L = []; for (const t of Object.keys(X.results)) { const R = resRows(sp, t); if (R.length >= 3) L.push({ t, pa: mean(R.map(x => x.pa)) }); } X.al = { d: todayU(), L: L.sort((a, b) => a.pa - b.pa) }; }
    const i = X.al.L.findIndex(x => x.t === ab); return i < 0 ? null : { pa: X.al.L[i].pa, rank: i + 1, of: X.al.L.length };
  }
  function nextGameOf(sp, ab) {
    let best = null;
    for (const g of SB.DATA.games || []) {
      if (g.sport !== sp || !SB.openG(g) || SB.isVoid(g)) continue;
      const h = espnOf(sp, g.home.abbr, g.home.name) === ab, a = !h && espnOf(sp, g.away.abbr, g.away.name) === ab;
      if ((h || a) && (!best || SB.startMs(g) < SB.startMs(best.g))) best = { g, home: h };
    }
    return best;
  }
  // a team named in text -> {sp, ab, name, amb}: the full name, the place ("Michigan State"), the nickname ("Lakers"; pro teams
  // before college), or the abbreviation in capitals
  const NICK2 = new Set('trail blazers|maple leafs|red wings|blue jackets|golden knights|crimson tide|blue devils|tar heels|golden gophers|fighting irish|yellow jackets|red raiders|horned frogs|sun devils|golden bears|demon deacons|nittany lions|mean green|golden flashes|scarlet knights|red wolves|rainbow warriors|green wave|black knights|golden eagles|blue raiders|ragin cajuns|fighting illini|thundering herd|blue hens|red storm|golden hurricane|black bears|golden lions|red foxes'.split('|'));
  let TIDX = null;
  function teamIdx() {
    const X = sIndex(); if (!X) return [];
    if (TIDX && TIDX.X === X && TIDX.D === SB.DATA && TIDX.N === SIDE.news) return TIDX.L;
    // ab: the code shown; eab: the ESPN code its results are under (null: none); fab: the feed's code (soccer)
    const mk = (sp, ab, name, eab, fab) => { const nm = norm(name), w = nm.split(' '), two = w.length >= 3 && NICK2.has(w.slice(-2).join(' ')); return { sp, ab, eab, fab: fab || null, name, nm, nick: two ? w.slice(-2).join(' ') : w[w.length - 1], place: w.slice(0, w.length - (two ? 2 : 1)).join(' '), feed: !eab }; };
    const L = [];
    for (const sp of ['nba', 'nfl', 'nhl', 'ncaaf']) { const S = X[sp]; if (!S) continue; for (const [ab, name] of Object.entries(S.teams)) if (sp !== 'ncaaf' || S.results[ab]) L.push(mk(sp, ab, String(name), ab)); }
    const M = socMap();
    if (M) {
      for (const [fab, f] of M.feed) L.push(mk('soccer', fab, f.name, M.f2e.get(fab), fab));
      for (const ab of Object.keys(X.soccer.results)) if (!M.e2f.has(ab)) L.push(mk('soccer', ab, ab, ab));
    }
    TIDX = { X, D: SB.DATA, N: SIDE.news, L }; return L;
  }
  const TALIAS = [[/ man (united|utd) /, ' manchester united '], [/ man city /, ' manchester city '], [/ barca /, ' barcelona '], [/ psg /, ' paris saint germain '], [/ (atleti|atletico) /, ' atletico madrid ']];
  function findTeam(text, sport) {
    const raw = String(text || ''), L = teamIdx(), C = [];
    let qn = ' ' + norm(raw) + ' '; for (const [rx, to] of TALIAS) qn = qn.replace(rx, to);
    for (const t of L) {
      if (sport && t.sp !== sport) continue;
      let s = 0, len = 0;
      const has = ph => ph && qn.includes(' ' + ph + ' ');
      if (t.nm !== norm(t.ab) && has(t.nm)) { s = 10; len = t.nm.length; }
      else {
        if (t.place.length >= 4 && !TEAMSTOP.has(t.place) && has(t.place)) { s = 7; len = t.place.length; }
        if (t.nick.length >= 4 && !TEAMSTOP.has(t.nick) && !COMMON.has(t.nick) && has(t.nick)) { const v = t.sp === 'ncaaf' ? 5 : 8; if (v > s || (v === s && t.nick.length > len)) { s = v; len = t.nick.length; } }
        const ab = String(t.ab || '');
        if (!s && ab.length >= (t.sp === 'ncaaf' ? 3 : 2) && ab === ab.toUpperCase() && !ABSTOP.has(ab) && new RegExp('(^|[^A-Za-z0-9])' + ab.replace(/[^A-Z0-9]/g, '') + '([^A-Za-z0-9]|$)').test(raw)) { s = 6; len = ab.length; }
      }
      if (s) C.push({ t, s: s + len / 100 - (t.feed ? .5 : 0) });
    }
    if (!C.length) return null;
    const games = t => (t.eab ? resRows(t.sp, t.eab).length : 0);
    C.sort((a, b) => b.s - a.s || SP_ORDER.indexOf(a.t.sp) - SP_ORDER.indexOf(b.t.sp) || games(b.t) - games(a.t));
    const top = C[0], amb = C.slice(1).filter(c => Math.abs(c.s - top.s) < .3 && c.t.ab !== top.t.ab).slice(0, 3).map(c => c.t);
    return { sp: top.t.sp, ab: top.t.ab, eab: top.t.eab, fab: top.t.fab, name: top.t.name, feed: top.t.feed, amb };
  }

  // ---- the side files the breakdowns read (the app's own JSON, fetched once when a breakdown needs them)
  const SIDE = { form: null, trends: null, news: null }; let sideP = null, SIDE_DONE = false;
  function loadSides() {
    if (!sideP) sideP = Promise.all(['form', 'trends', 'news'].map(n => fetch(n + '.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)))
      .then(([f, t, n]) => { SIDE.form = f && Array.isArray(f.teams) ? f : null; SIDE.trends = t && Array.isArray(t.teams) ? t : null; SIDE.news = n && Array.isArray(n.items) ? n : null; SIDE_DONE = true; });
    return sideP;
  }
  function newsFor(test, n) {
    const N = SIDE.news; if (!N) return [];
    return N.items.filter(x => x && typeof x.headline === 'string' && x.headline && test(x)).sort((a, b) => String(b.published || '').localeCompare(String(a.published || ''))).slice(0, n || 3)
      .map(x => ({ h: x.headline.slice(0, 200), d: String(x.published || '').slice(0, 10), link: httpsOnly(x.link) }));
  }
  const newsOfPlayer = name => { const k = E.nameKey(name); return newsFor(x => Array.isArray(x.athletes) && x.athletes.some(a => E.nameKey(a) === k)); };
  const newsOfTeam = (sp, ab, name) => { const k = E.nameKey(name); return newsFor(x => x.sport === sp && Array.isArray(x.teams) && x.teams.some(t => t && (E.nameKey(t.name) === k || (sp !== 'ncaaf' && sp !== 'soccer' && t.abbr === ab)))); };
  const FORM_COMP = { nba: ['NBA'], nfl: ['NFL'], nhl: ['NHL'], ncaaf: ['College Football'] };
  function formOf(sp, name) {
    const F = SIDE.form; if (!F || !name) return null;
    const tk = nmOf(name), tl = tk.split(' ').pop(); let best = null;
    for (const t of F.teams) {
      if (!t || typeof t.name !== 'string') continue;
      if (FORM_COMP[sp] ? !FORM_COMP[sp].includes(t.comp) : Object.values(FORM_COMP).some(c => c.includes(t.comp))) continue;
      const fk = nmOf(t.name), s = fk === tk ? 3 : tk.endsWith(' ' + fk) || fk.endsWith(' ' + tk) ? 2 : sp !== 'ncaaf' && sp !== 'soccer' && fk.split(' ').pop() === tl ? 1 : 0;
      if (s && (!best || s > best.s || (s === best.s && String(t.asOf || '') > String(best.t.asOf || '')))) best = { t, s };
    }
    return best ? best.t : null;
  }
  function trendsOf(sp, ab, name) {
    const T = SIDE.trends; if (!T) return null; const tk = nmOf(name || '');
    return T.teams.find(t => t && t.sport === sp && ((sp === 'nba' && (t.espn === ab || t.abbr === ab)) || (tk && typeof t.name === 'string' && nmOf(t.name) === tk))) || null;
  }
  function injuryOf(name, sp) {
    try { const I = E.injuries, L = I && Array.isArray(I.injuries) ? I.injuries : [], k = E.nameKey(name); const x = L.find(r => r && E.nameKey(r.player) === k && (!r.sport || r.sport === sp));
      return x ? { status: String(x.status || 'listed'), injury: String(x.injury || '').slice(0, 60), updated: String(x.updated || '').slice(0, 10) } : null; } catch (e) { return null; }
  }
  function injuriesOfTeam(sp, ab, name) {
    try { const I = E.injuries, L = I && Array.isArray(I.injuries) ? I.injuries : [], k = E.nameKey(name);
      return L.filter(r => r && r.sport === sp && r.player && (E.nameKey(r.teamName) === k || espnOf(sp, String(r.team || ''), r.teamName) === ab)).slice(0, 8)
        .map(r => ({ player: String(r.player), pos: String(r.pos || ''), status: String(r.status || 'listed'), injury: String(r.injury || '').slice(0, 60), updated: String(r.updated || '').slice(0, 10) })); } catch (e) { return []; }
  }

  // ---- the app's graded picks (recs.json, loaded by the app as DATA.recs) and the viewer's My Parlays
  const recsD = () => { const R = SB.DATA && SB.DATA.recs; return R && Array.isArray(R.days) ? R : null; };
  // the same groups as the app's "How our parlays did" (index.html REC_TYPE), so the numbers match that page
  const REC_TYPE = id => (/^mp-exact/.test(id) ? 'Exact score' : /^mp-sgp|^sgp/.test(id) ? 'Same game' : /^mp-mixed/.test(id) ? '10-leg mix' : /^mp-nba/.test(id) ? 'NBA props (picks)' : /^mp-dog|^up/.test(id) ? 'Underdogs / upsets'
    : /^stk/.test(id) ? 'Duo / trio stacks' : /^mega/.test(id) ? '20-leg combo' : /^pt-/.test(id) ? 'Weekend patterns' : /^fantasy$/.test(id) ? 'Fantasy' : /^hy/.test(id) ? 'High yield' : /^p[sh]\d|^fs/.test(id) ? 'NBA props tickets' : 'Other');
  const REC_NAME = [[/^fsday/, 'Safest games combined'], [/^fs\d/, 'Highest-floor legs (one game)'], [/^ps\d/, 'Safer prop ticket'], [/^ph\d/, 'High-yield prop ticket'], [/^hy\d/, 'High-yield fantasy ticket'], [/^mega/, '20-leg safest combo'],
    [/^stk/, 'Duo / trio stack'], [/^rec4/, '4-leg reception parlay'], [/^sgp$/, 'Fantasy same game parlay'], [/^fantasy$/, 'Fantasy ticket'], [/^pairs/, 'Paired parlay (legs that help each other)'], [/^trend/, 'Team trends parlay'],
    [/^pt-crazy3/, 'Weekend patterns: 3-upset lotto'], [/^pt-crazy5/, 'Weekend patterns: full chaos 5'], [/^pt-runs/, 'Weekend patterns: unbeaten runs end'], [/^pt-steady/, 'Weekend patterns: the steady weekend']];
  function recTitle(P) {
    const id = String(P.id || ''), t = String(P.title || '');
    if (t && t !== id) return t.slice(0, 80);
    const x = REC_NAME.find(([rx]) => rx.test(id)); return `${x ? x[1] : REC_TYPE(id)} · ${(P.legs || []).length} legs`;
  }
  // the app's own legs for a player on one UTC date (its pre-game line and chance)
  function recLegsFor(name, d) {
    const R = recsD(); if (!R || !d) return [];
    const k = E.nameKey(name), out = [], seen = new Set();
    for (const day of R.days) for (const P of Array.isArray(day.parlays) ? day.parlays : []) for (const L of Array.isArray(P.legs) ? P.legs : []) {
      if (!L || !L.player || typeof L.player.name !== 'string' || E.nameKey(L.player.name) !== k || legDate(L) !== d || seen.has(L.key)) continue;
      seen.add(L.key); out.push({ L, P, day: day.day });
    }
    return out;
  }
  const recInfo = L => { const st = String(L.player.stat || ''), thr = +L.player.thr, under = !!L.player.under; return { f: st, line: num(thr) ? (under ? thr : thr - .5) : null, under, p: num(+L.p) && +L.p > 0 ? +L.p : null }; };
  // a date named in words -> {d: 'YYYY-MM-DD'} (a US calendar date) or {rel: 'last'} ("last night", "yesterday")
  const MONX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const WDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function dateIn(s) {
    s = String(s || '').toLowerCase();
    let m = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(s); if (m) return { d: `${m[1]}-${m[2]}-${m[3]}` };
    const today = E.dayOf(Date.now()), y0 = +today.slice(0, 4);
    const mk = (mo, da) => { if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null; const d = `${y0}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`; return d > today ? `${y0 - 1}-${d.slice(5)}` : d; };
    m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(s); if (m) { const d = mk(MONX[m[1]], +m[2]); if (d) return { d }; }
    m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b/.exec(s); if (m) { const d = mk(MONX[m[2]], +m[1]); if (d) return { d }; }
    m = /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})\b/.exec(s); if (m) { const d = mk(+m[1], +m[2]); if (d) return { d }; }
    if (/\b(last night|yesterday|last game|most recent|latest|last time out)\b/.test(s)) return { rel: 'last' };
    m = /\b(?:on|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(s);
    if (m) { const dow = new Date(today + 'T12:00:00Z').getUTCDay(); return { d: dAdd(today, -((dow - WDAY.indexOf(m[1]) + 7) % 7)) }; }
    return {};
  }

  // ---------------------------------------------------------------- reading a question
  // the stat named first in the text ("Maxey over 20.5 points and Brunson over 5.5 assists" -> points for Maxey's part)
  const STAT_RX = [[/\b(touchdowns?|tds?|anytime|end ?zone)\b/, 'td'], [/\brush(ing)?( yards| yds)?\b/, 'ryd'], [/\b(receiving( yards| yds)?|rec ?yds|rec yards)\b/, 'recyd'],
    [/\bpassing( yards| yds)?\b|\bpass ?(yards|yds)\b/, 'pyd'], [/\b(receptions?|catch(es)?|rec)\b/, 'rec'], [/\b(rebounds?|boards?|rebs?)\b/, 'reb'], [/\b(assists?|asts?|dimes)\b/, 'ast'],
    [/\b(points?|pts)\b/, 'pts'], [/\b(shots? on goal|sog|shots?)\b/, 'sog'], [/\b(yards?|yds)\b/, 'yds']];
  function statFrom(s) {
    s = ' ' + String(s || '').toLowerCase() + ' ';
    let best = null;
    for (const [rx, st] of STAT_RX) { const m = rx.exec(s); if (m && (!best || m.index < best.i || (m.index === best.i && m[0].length > best.n))) best = { i: m.index, n: m[0].length, st }; }
    return best ? best.st : null;
  }
  const yardsFor = e => { const p = String(e.pos || '').toUpperCase(); const pref = p === 'QB' ? ['pyd', 'ryd'] : p === 'RB' ? ['ryd', 'recyd'] : ['recyd', 'rec', 'ryd']; return pref.find(s => e.stats[s]) || ['recyd', 'ryd', 'pyd'].find(s => e.stats[s]) || null; };
  // markets the app has no line for: named so the answer can say so instead of quietly pricing another stat
  const UNSUP = [[/\b(threes?|3s|treys?|three[- ]pointers?|3[- ]?pointers?|3pm|3pt)\b/, 'three-pointers made'], [/\bsteals?\b/, 'steals'], [/\bblocks?\b/, 'blocks'], [/\bturnovers?\b/, 'turnovers'],
    [/\bpra\b|\b(pts|points|reb|rebs|rebounds|ast|asts|assists|p|r|a)\s*\+\s*(pts|points|reb|rebs|rebounds|ast|asts|assists|p|r|a)\b|\bpoints,? rebounds,? (and|&) assists\b/, 'combined points / rebounds / assists'],
    [/\b(double|triple)[- ]doubles?\b/, 'double-doubles'], [/\bsacks?\b/, 'sacks'], [/\b(interceptions?|ints)\b/, 'interceptions'], [/\bcompletions?\b/, 'completions'], [/\blongest\b/, 'longest plays'], [/\bfirst basket\b/, 'first basket']];
  const unsupOf = s => { for (const [rx, n] of UNSUP) if (rx.test(s)) return n; return null; };
  // the stat for one player: the words he was asked with, else his main market
  function pickStat(e, seg, all, hasLine) {
    let s = statFrom(seg) || statFrom(all);
    const un = unsupOf(seg) || (statFrom(seg) ? null : unsupOf(all));
    const score = /\bscor(e|es|ing)\b/.test(seg) || /\bscor(e|es|ing)\b/.test(all);
    if (!s && !un && score) s = e.sport === 'nfl' || e.sport === 'ncaaf' ? 'td' : e.sport === 'nba' ? 'pts' : null;
    if (s === 'yds') s = yardsFor(e);
    if (!un) {
      if (s === 'td' && e.td) return { stat: 'td' };
      if (s && e.stats[s]) return { stat: s };
    } else if (s && s !== 'td' && e.stats[s]) return { stat: s, missing: un };
    const missing = un || s;
    let d = null;
    if (e.sport === 'nba') d = ['pts', 'reb', 'ast'].find(x => e.stats[x]);
    else if (e.sport === 'nfl' || e.sport === 'ncaaf') d = !hasLine && e.td ? 'td' : yardsFor(e) || (e.stats.rec ? 'rec' : e.td ? 'td' : null);
    else d = Object.keys(e.stats)[0] || null;
    return { stat: d, missing };
  }
  function priceOf(lc) {
    const m = /(?:^|[\s(@:,=])([+\-−–]\s?\d{3,5})(?![\d.])/.exec(lc); if (!m) return null;
    const s = m[1].replace(/[−–]/, '-').replace(/\s/g, ''); if (Math.abs(+s) < 100) return null;
    return { s, at: m.index, len: m[0].length };
  }
  // the first line named in the text: "over 24.5", "25+", "25 or more", "6 or fewer", "30 points", "score 30", "24.5"
  const LINE_RX = [[/\b(?:over|under|o|u)\s*(\d+(?:\.\d+)?)(?![\d])/, v => v], [/(\d+(?:\.\d+)?)\s*\+/, v => v - 0.5], [/\b(\d+(?:\.\d+)?)\s*(?:or more|plus)\b/, v => v - 0.5],
    [/\b(\d+(?:\.\d+)?)\s*(?:or (?:less|fewer))\b/, v => v + 0.5], [/\b(\d+(?:\.\d+)?)\s*(?:points?|pts|rebounds?|boards?|assists?|asts?|receptions?|catch(?:es)?|rec|yards?|yds|shots?|sog)\b/, v => (v % 1 ? v : v - 0.5)],
    [/\bscore\s+(\d{1,3})\b/, v => v - 0.5], [/\b(\d{1,3}\.5)\b/, v => v]];
  function lineOf(seg) {
    let best = null;
    for (const [rx, f] of LINE_RX) { const m = rx.exec(seg); if (m && (!best || m.index < best.i)) best = { i: m.index, v: f(+m[1]) }; }
    return best && best.v > 0 ? best.v : null;
  }
  function topStat(lc) {
    if (/\b(receivers?|wrs?|tight ends?|tes?)\b/.test(lc)) return 'recyd';
    if (/\b(rushers?|running backs?|backs?|rbs?)\b/.test(lc)) return 'ryd';
    if (/\b(qbs?|quarterbacks?)\b/.test(lc)) return 'pyd';
    if (/\b(td scorers?|touchdowns?|tds?)\b/.test(lc)) return 'td';
    const s = statFrom(lc); return s === 'yds' ? null : s;
  }
  const isUnder = s => /\bunder\b|\bless than\b|\bfewer than\b|\bor less\b|\bor fewer\b|\bno more than\b/.test(s);
  const WORDN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  function sportOf(lc) {
    if (/\b(nba|basketball)\b/.test(lc)) return 'nba';
    if (/\b(college|ncaaf|cfb|ncaa)\b/.test(lc)) return 'ncaaf';
    if (/\b(nfl|football)\b/.test(lc)) return 'nfl';
    if (/\b(nhl|hockey)\b/.test(lc)) return 'nhl';
    if (/\b(soccer|premier league|champions league|la liga|serie a|bundesliga|ligue 1|mls|epl)\b/.test(lc)) return 'soccer';
    return null;
  }
  // 1 for the full name, the nickname (last word) or the abbreviation; .6 for another word of the name ("Houston", "Memphis")
  function teamHit(t, qn, raw) {
    const nm = norm(t.name); if (nm && qn.includes(' ' + nm + ' ')) return 1;
    const toks = nm.split(' ').filter(w => w.length >= 4 && !TEAMSTOP.has(w));
    if (toks.length && qn.includes(' ' + toks[toks.length - 1] + ' ')) return 1;
    const ab = String(t.abbr || '');
    if (ab.length >= 2 && ab === ab.toUpperCase() && !ABSTOP.has(ab) && new RegExp('(^|[^A-Za-z])' + ab.replace(/[^A-Z0-9]/g, '') + '([^A-Za-z]|$)').test(raw)) return 1;
    return toks.slice(0, -1).some(w => qn.includes(' ' + w + ' ')) ? .6 : 0;
  }
  function matchGames(text) {
    const raw = String(text || ''), qn = ' ' + norm(raw) + ' ', now = Date.now(), out = [];
    for (const g of SB.DATA.games || []) {
      if (!SB.openG(g) || SB.isVoid(g) || SB.startMs(g) > now + 8 * 864e5) continue;
      const s = teamHit(g.home, qn, raw) + teamHit(g.away, qn, raw);
      if (s) out.push({ g, s });
    }
    return out.sort((a, b) => b.s - a.s || SB.startMs(a.g) - SB.startMs(b.g)).map(x => x.g);
  }
  // the words that mark a breakdown question
  const REVIEW_RX = /\b(went wrong|go wrong|went right|what happened|why did|why .{0,40}\b(miss|lose|lost|fail|bust)|break ?down|review|grade|how did|how'?d|did (it|they|my|this|that|he|she) (hit|cash|win|lose|miss)|miss(ed)?|lost|bust(ed)?|cash(ed)?)\b/;
  const PICKS_RX = /\b(your|the app'?s|apps|safe bets'?|our|yesterday'?s|todays?|recommended)\b[^?]{0,30}\b(picks?|parlays?|recommendations?|mix|sgp|same game|exact scores?|underdogs?|nba props)\b|\bmy parlay picks\b/;
  const TRACK_RX = /\btrack record\b|\bhit rate\b|\bhow (good|accurate) (are|is|have been) (your|the app'?s|the) (picks|parlays|model)\b|\bhow (did|do|have|are|were) (your|the app'?s|safe bets'?|our|the) (picks|parlays|recommendations)\b/;
  const MINE_RX = /\bmy (last |latest |most recent |saved |recent )?(parlay|slip|ticket|bet|parlays|bets|sgp)\b/;
  const TITLE_STOP = /\b(what|went|go|wrong|right|with|why|did|do|does|how|happened|break|down|breakdown|review|yesterdays?|todays?|picks?|recommended|recommendations?|miss(ed)?|lost|lose|hit|your|the|apps?|safe|bets|our|parlays?|on|for|from|of|last|night)\b/g;
  const LEAD_RX = /\bwho (leads|has the most|is leading|has led|tops)\b|\bleaders?\b|\bleads the\b|\bleading (rusher|passer|receiver|scorer|rebounder|goal ?scorer|tackler)s?\b|\bmost (\w+ ){0,2}(points|rebounds|assists|yards|touchdowns|tds|goals|receptions|catches|shots|carries|targets)\b/;
  const RVP_RX = /\bhow did\b|\bhow'?d\b|\bwhy did\b|\bwhat happened\b|\bbreak ?down\b|\blast night\b|\byesterday\b|\bdid (he|she)\b|\b(hit|miss|cover)(ed)? (his|her|the)\b|\bhow (was|were) (he|she|his)\b/;
  const STP_RX = /\b(stats?|statistics|this season|season (stats|averages?|totals?|numbers|so far)|averag(e|es|ing)|game ?logs?|last (\d{1,2}|five|ten|few|three)( games)?|numbers|splits?|per game)\b|\bhow (is|has) .{2,40} (doing|done|played|been playing)\b/;
  const TEAM_RX = /\b(record|doing|form|standings?|streak|results|last \d+ games|season so far|how (are|is|have|did|were) the)\b/;
  const QSTOP = new Set('how did does doing last night yesterday stats season games points rebounds assists yards touchdowns goals shots record leaders against what happened miss missed play played looks tonight today their this that with from over under break breakdown review average averages split splits numbers why lately recently'.split(' '));
  // a player named in the text who has no game on the slate: a full name, else a surname of 5+ letters that isn't an everyday or
  // team word (the stat words named pick the sport; then the bigger season)
  // the longest full name (two words or more) of any player in this season's box scores that the text contains
  function seasonFullIn(lc, sport) {
    const X = sIndex(); if (!X) return null;
    const qn = ' ' + lc.replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ', sps = sport ? [sport] : SP_ORDER;
    let best = null;
    for (const sp of sps) for (const x of allOf(sp)) if (x.nm.length >= 6 && x.nm.includes(' ') && qn.includes(' ' + x.nm + ' ') && (!best || x.nm.length > best.nm.length || (x.nm.length === best.nm.length && (+x.p.gp || 0) > (+best.p.gp || 0)))) best = { sp, p: x.p, nm: x.nm };
    return best ? { name: best.p.n, sp: best.sp, team: best.p.t, nm: best.nm, at: qn.indexOf(' ' + best.nm + ' ') } : null;
  }
  function seasonNamesIn(lc, sport) {
    const X = sIndex(); if (!X) return null;
    const qn = ' ' + lc.replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ', sps = sport ? [sport] : SP_ORDER;
    const full = seasonFullIn(lc, sport); if (full) return full;
    const nicks = new Set(teamIdx().map(t => t.nick));
    const words = qn.trim().split(' ').filter(w => w.length >= 5 && !COMMON.has(w) && !TEAMSTOP.has(w) && !QSTOP.has(w) && !nicks.has(w) && !nicks.has(w.replace(/s$/, '')));
    if (!words.length) return null;
    const ws = new Set(words), hint = hintOf(lc), C = [];
    for (const sp of sps) for (const x of allOf(sp)) { const t = x.nm.split(' '); if (t.length >= 2 && ws.has(t[t.length - 1])) C.push({ sp, p: x.p, w: t[t.length - 1] }); }
    if (!C.length) return null;
    const med = sp => { const S = xOf(sp), L = S ? Object.values(S.results).map(r => (Array.isArray(r) ? r.length : 0)).filter(Boolean).sort((a, b) => a - b) : []; return L.length ? L[Math.floor(L.length / 2)] : 10; };
    const M = {}; for (const sp of SP_ORDER) M[sp] = med(sp);
    C.sort((a, b) => (hint ? (hint.includes(b.sp) ? 1 : 0) - (hint.includes(a.sp) ? 1 : 0) : 0) || (+b.p.gp || 0) / M[b.sp] - (+a.p.gp || 0) / M[a.sp] || SP_ORDER.indexOf(a.sp) - SP_ORDER.indexOf(b.sp));
    const top = C[0], also = C.slice(1).filter(c => E.nameKey(c.p.n) !== E.nameKey(top.p.n)).slice(0, 3);
    return { name: top.p.n, sp: top.sp, team: top.p.t, at: Math.max(0, qn.indexOf(' ' + top.w + ' ')), amb: also.length ? `Reading "${top.w}" as ${top.p.n} (${top.p.t}, ${SPN[top.sp]}). Also in the box scores: ${also.map(c => `${c.p.n} (${c.p.t}, ${SPN[c.sp]})`).join(', ')}. Use the full name for another player.` : '' };
  }
  // players with their stat and line in a typed parlay ("my parlay: Maxey over 24.5 points and Siakam over 20.5 points")
  function typedLegsIn(lc, clean, players) {
    const out = [];
    if (players.length) players.slice(0, 10).forEach((p, i) => { const seg = clean.slice(p.at, i + 1 < players.length ? players[i + 1].at : clean.length), line = lineOf(seg); out.push({ player: p.e.name, stat: (statFrom(seg) && statFrom(seg) !== 'yds' ? ST_NAME[statFrom(seg)] : null) || seg.slice(0, 60), line: line == null ? undefined : line, side: isUnder(seg) ? 'under' : undefined }); });
    else { const s = seasonNamesIn(lc, null); if (s && lineOf(clean.slice(s.at || 0)) != null) { const seg = clean.slice(s.at || 0); out.push({ player: s.name, stat: seg.slice(0, 60), line: lineOf(seg), side: isUnder(seg) ? 'under' : undefined }); } }
    return out.filter(x => x.line != null);
  }
  function leadIntent(lc, sport) {
    const pos = /\b(qbs?|quarterbacks?|passers?)\b/.test(lc) ? 'QB' : /\b(rbs?|running backs?)\b/.test(lc) ? 'RB' : /\b(tes?|tight ends?)\b/.test(lc) ? 'TE' : /\b(wrs?|wide receivers?)\b/.test(lc) ? 'WR'
      : /\bguards?\b/.test(lc) ? 'G' : /\bcent(er|re)s?\b/.test(lc) ? 'C' : /\bdefensem[ae]n\b/.test(lc) ? 'D' : null;
    const t = lc.replace(/\b(leading )?rushers?\b/, ' rushing yards ').replace(/\b(leading )?passers?\b/, ' passing yards ').replace(/\b(leading )?receivers?\b/, ' receiving yards ').replace(/\brebounders?\b/, ' rebounds ').replace(/\bgoal ?scorers?\b/, ' goals ');
    let sp = sport;
    if (!sp) { const h = hintOf(t.replace(/\bscor(ing|ers?)\b/, ' points ')); sp = /\bgoals?\b|\bshots? on goal\b/.test(t) ? 'nhl' : /\bshots? on target\b/.test(t) ? 'soccer' : h ? h[0] : /\bscor(ing|ers?)\b/.test(t) ? 'nba' : null; }
    if (!sp) return null;
    const f = sfFrom(t.replace(/\bscor(ing|ers?)\b/, sp === 'nfl' || sp === 'ncaaf' ? ' touchdowns ' : sp === 'soccer' ? ' goals ' : ' points '), sp, pos);
    if (!f) return null;
    return { kind: 'leaders', sp, f, pos, pg: /\bper game\b|\ba game\b|\baverag/.test(lc) };
  }
  function parseIntent(q) {
    const raw = String(q || '');
    const lc = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '');
    const price = priceOf(lc);
    const blank = (s, i, n) => s.slice(0, i) + ' '.repeat(n) + s.slice(i + n);  // keeps every position in place
    let clean = price ? blank(lc, price.at, price.len) : lc;
    const lm = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:legs?|legger|teams?|picks?|pieces?)\b/.exec(clean);
    const nLegs = lm ? (WORDN[lm[1]] || +lm[1]) : null;
    if (lm) clean = blank(clean, lm.index, lm[0].length);
    clean = clean.replace(/\b\d{1,2}:\d{2}\b/g, m => ' '.repeat(m.length));
    // a slate player matched by one word ("Cunningham") gives way to a longer full name of someone else in the box scores
    // ("Cade Cunningham", who has no game on the slate)
    const sport = sportOf(lc), full = seasonFullIn(lc, null), players = matchPlayers(lc).filter(p => !(full && p.word && p.e.k !== E.nameKey(full.name) && full.nm.length > p.len && (' ' + full.nm + ' ').includes(' ' + nmOf(p.word) + ' ')));
    const risk = /\b(safe|safest|safer|low risk|conservative)\b/.test(lc) ? 'safe' : /\b(risky|long ?shots?|lotto|big payout|plus money|high risk|aggressive)\b/.test(lc) ? 'risky' : 'balanced';
    const when = /\b(tonight|today|this evening)\b/.test(lc) ? 'tonight' : /\b(this week|week|weekend)\b/.test(lc) ? 'week' : null;
    const legOf = (i, solo) => {
      const p = players[i], seg = solo ? clean : clean.slice(p.at, i + 1 < players.length ? players[i + 1].at : clean.length);
      const line = lineOf(seg);
      const st = pickStat(p.e, seg, clean, line != null);
      const L = { e: p.e, stat: st.stat, missing: st.missing, line: st.stat === 'td' ? null : line, under: isUnder(seg), amb: ambNote(p), tdNote: '' };
      if (st.stat === 'td') {  // the app prices an anytime TD (1 or more) only
        if (/\b(2|two|3|three)\s*\+?\s*(or more )?(tds?|touchdowns?)\b|\bmultiple (tds?|touchdowns?)\b/.test(seg)) L.tdNote = 'The app prices an anytime TD (one or more). Two or more touchdowns is much less likely than the chance shown.';
        else if (/\b(first|1st) (td|touchdown)\b|\bfirst to score\b/.test(seg)) L.tdNote = 'This is the anytime TD chance. Scoring the first TD of the game is far less likely (see the First TD tab).';
      }
      return L;
    };
    const isParlay = /\b(parlay|parley|sgp|same game|ticket|accumulator|acca)\b/.test(lc);
    // ---- breakdowns: the app's picks and track record, a saved or typed parlay, league leaders, one player's game or season
    const dt = dateIn(lc), reviewW = REVIEW_RX.test(lc), trackW = TRACK_RX.test(lc);
    if (PICKS_RX.test(lc) || trackW) {
      const dayW = dt.d || (/\b(yesterday|last night)\b/.test(lc) ? 'yesterday' : /\btoday'?s?\b/.test(lc) ? 'today' : null);
      if (trackW && !dayW && !/\b(went wrong|go wrong|what happened|break ?down|why)\b/.test(lc)) { const m = /\blast (\d{1,2}) days\b/.exec(lc); return { kind: 'track', days: m ? clamp(+m[1], 1, 30) : 7 }; }
      if (reviewW || trackW || (dayW && dayW !== 'today' && !/\b(build|make|give|create|generate)\b/.test(lc))) return { kind: 'rparlay', src: 'picks', day: dayW, title: lc.replace(TITLE_STOP, ' ') };
    }
    if (MINE_RX.test(lc) && (reviewW || /\bhow (did|is|was)\b/.test(lc))) {
      const legs = typedLegsIn(lc, clean, players);
      return legs.length ? { kind: 'rparlay', src: 'legs', legs } : { kind: 'rparlay', src: 'saved' };
    }
    if (LEAD_RX.test(lc) && !players.length && !/\b(props?|bets?|parlays?|tonight|this week)\b/.test(lc)) { const L = leadIntent(lc, sport); if (L) return L; }
    if (!isParlay && !price) {
      const rvP = RVP_RX.test(lc) || !!dt.d || !!dt.rel, stP = STP_RX.test(lc), oppM = /\b(?:vs\.?|versus|against)\s+(?:the\s+)?([a-z0-9 .&'-]{3,40})/.exec(lc);
      let who = players.length ? { name: players[0].e.name, sp: players[0].e.sport, team: null, amb: ambNote(players[0]), at: players[0].at } : null;
      if (!who && (rvP || stP)) who = seasonNamesIn(lc, sport);
      if (who && (rvP || stP || (oppM && findTeam(oppM[1], who.sp)))) {
        const seg = clean.slice(who.at || 0), oppText = oppM ? oppM[1] : null;
        if (stP && !dt.d && !dt.rel && !/\b(why|miss(ed)?|hit)\b/.test(lc) || (!rvP && oppM)) {
          const lm2 = /\blast (\d{1,2}|three|five|ten|few)\b/.exec(lc), n = lm2 ? WORDN[lm2[1]] || (lm2[1] === 'few' ? 5 : +lm2[1]) : null;
          const venue = /\b(at home|home games)\b/.test(lc) ? 'home' : /\b(on the road|away games|road games)\b/.test(lc) ? 'away' : null;
          return { kind: 'pstats', name: who.name, sp: who.sp, team: who.team, n, oppText, venue, statText: seg, amb: who.amb || '' };
        }
        return { kind: 'rplayer', name: who.name, sp: who.sp, team: who.team, statText: seg, line: lineOf(seg), under: isUnder(seg) ? true : lineOf(seg) != null ? false : undefined, d: dt.d, oppText, amb: who.amb || '' };
      }
    }
    if (/\b(this|my) (parlay|slip|ticket|bet)\b/.test(lc) && !players.length) return { kind: 'slipq' };
    if (/\b(start|sit|flex|bench)\b/.test(lc) && players.length) return { kind: 'startsit', names: players.slice(0, 4).map(p => p.e.name) };
    const build = /\b(build|make|give|create|generate|suggest|find|need|want)\b/.test(lc);
    if (isParlay && players.length && (players.length >= 2 || !build)) return { kind: 'price', legs: players.slice(0, 10).map((_, i) => legOf(i, players.length === 1)), price: price && price.s };
    if (isParlay) return { kind: 'parlay', n: clamp(nLegs || 3, 2, 10), sport, risk, when };
    if (players.length) return { kind: 'prop', ...legOf(0, players.length === 1), price: price && price.s };
    if (TEAM_RX.test(lc)) { const T = findTeam(raw, sport); if (T) return { kind: 'team', sp: T.sp, ab: T.ab, eab: T.eab, fab: T.fab, name: T.name, amb: T.amb }; }
    // a named player with no game on the slate ("Is X a good bet?") is answered as such, never as a list of other props
    const so = seasonInText(lc); if (so) return { kind: 'seasononly', sp: so.sp, p: so.p };
    const ranked = /\b(best|top|safest|strongest)\b/.test(lc) || lineOf(clean) == null;  // "a good bet over 24.5" is about one bet
    if (ranked && (/\b(best|top|good|safest|strongest|favou?rite|smart)\b[^?]*\b(props?|bets?|plays?|picks?|overs?|legs?|receivers?|rushers?|backs?|qbs?|quarterbacks?|scorers?|tight ends?|wrs?|rbs?|tes?)\b/.test(lc) || /\bwho should i bet\b|\bwhat should i bet\b/.test(lc)))
      return { kind: 'top', sport: sport || (/\b(receivers?|rushers?|backs?|qbs?|quarterbacks?|tight ends?|wrs?|rbs?|tes?)\b/.test(lc) ? 'nfl' : null), stat: topStat(lc), when };
    const gs = matchGames(raw); if (gs.length) return { kind: 'game', gid: gs[0].id };
    return { kind: 'help' };
  }

  // ---------------------------------------------------------------- the prop analysis (one market for one player)
  function defaultLine(pl, under) {
    let best = null;
    for (const t of E.LADDER[pl.stat] || []) { const q = under ? 1 - E.playerP(pl, t) : E.playerP(pl, t); const d = Math.abs(q - .65); if (!best || d < best.d) best = { t, d }; }
    return best ? best.t - 0.5 : Math.max(0.5, Math.round(pl.avg || 1) - 0.5);
  }
  function verdictOf(p, dec) {
    if (!num(p)) return null;
    if (num(dec) && dec > 1) {
      const imp = 1 / dec, edge = (p - imp) * 100;
      if (edge >= 3 && p >= .5) return { tone: 'take', title: 'Take this bet', kicker: 'Safe Bets verdict · vs your price', edge, imp };
      if (edge >= 0) return { tone: 'lean', title: 'Lean', kicker: 'Safe Bets verdict · vs your price', edge, imp };
      return { tone: 'pass', title: 'Pass', kicker: 'Safe Bets verdict · vs your price', edge, imp };
    }
    // no price: a read of the chance only, so the kicker says the price it needs (a 75% leg at -500 is still a bad bet)
    const k = `Safe Bets verdict · only at ${U.fair(p)} or better`;
    if (p >= .7) return { tone: 'take', title: 'Strong lean', kicker: k };
    if (p >= .58) return { tone: 'lean', title: 'Lean', kicker: k };
    if (p >= .45) return { tone: 'coin', title: 'Coin flip', kicker: k };
    return { tone: 'pass', title: 'Long shot', kicker: k };
  }
  const FLIP = { good: 'bad', bad: 'good', mid: 'mid' };
  const FLIPS = { Favorable: 'Unfavorable', Unfavorable: 'Favorable', Hot: 'Hot (hurts the under)', Cold: 'Cold (helps the under)', Rising: 'Rising (hurts the under)', Falling: 'Falling (helps the under)', 'Close game': 'Close game (hurts the under)', 'Blowout risk': 'Blowout risk (helps the under)' };
  const flipF = f => ({ ...f, tone: FLIP[f.tone] || f.tone, status: FLIPS[f.status] || f.status });
  const marketOf = (stat, line, under) => (stat === 'td' ? 'Anytime TD' : `${under ? 'Under' : 'Over'} ${fmtLine(line)} ${ST_NAME[stat]}`);
  function injuryNote(e, pl) {
    if (!pl || !pl.status || pl.status === 'active') return null;
    let det = '';
    try { const I = E.injuries, L = I && Array.isArray(I.injuries) ? I.injuries : []; const x = L.find(r => r && E.nameKey(r.player) === e.k); if (x && x.injury) det = ` (${String(x.injury).slice(0, 60)})`; } catch (er) { /* the report is optional */ }
    return `Listed ${pl.status} on the injury report${det}. Check his status before betting.`;
  }
  function analyzeProp(spec) {
    const X = pIndex(), e = X.by.get(spec.k), name = spec.name || 'This player';
    const gone = why => ({ ok: false, name, mk: spec.mk || '', why });
    if (!e) return gone(`${name} has no game left on the app's board (it may have started).`);
    const td = spec.stat === 'td';
    if (td && !e.td) return gone(`The app has no anytime-TD model for ${e.name}.`);
    const gid = td ? e.td.gid : e.gid;
    if (spec.gid && spec.gid !== gid) return gone(`${e.name}'s game has started, so this card is closed.`);
    const g = SB.gameById(gid); if (!g || !SB.openG(g)) return gone(`${e.name}'s game has started, so this card is closed.`);
    const pl = td ? null : e.stats[spec.stat];
    if (!td && !pl) return gone(`The app has no ${ST_NAME[spec.stat] || 'model'} line for ${e.name}.`);
    const sp = g.sport, home = g.home.abbr === e.team, opp = home ? g.away : g.home;
    const sea = SEASON ? seasonOf(sp, e.name, e.team, g) : null;
    const pos = e.pos || (sea && sea.p.pos) || null;
    let line, under = !!spec.under && !td, p, key, proj = null, M = null, pushAt = null, defaulted = false;
    if (td) {
      line = 0.5; key = e.td.key; p = SB.p1(g, key);
      if (!(p > 0)) return gone(`${e.name} has no touchdown chance in the app's model right now (he may be ruled out).`);
    } else {
      line = num(spec.line) ? spec.line : null;
      if (line == null || line <= 0) { line = defaultLine(pl, under); defaulted = true; }
      if (spec.dl) defaulted = true;
      const whole = Number.isInteger(line); if (whole) pushAt = line;
      const thr = under ? (whole ? line : Math.ceil(line)) : (whole ? line + 1 : Math.ceil(line));
      p = under ? 1 - E.playerP(pl, thr) : E.playerP(pl, thr);
      key = under ? `U:${pl.id}:${whole ? line - 0.5 : line}` : `P:${pl.id}:${thr}`;
      M = E.playerMeans(pl); proj = (1 - M.pb) * M.an + M.pb * M.ab;
    }
    const dec = spec.price != null ? SB.parseOdds(String(spec.price), 'american') : null;
    const price = num(dec) && dec > 1.001 && dec < 1001 ? dec : null;
    const V = verdictOf(p, price);
    // recent games vs the line: ESPN box scores (season.json); NBA falls back to the morning form file and the last-4 box scores
    let log = null, rowsAll = null;
    if (sea && sea.rows.length) {
      rowsAll = sp === 'nba' ? sea.rows.filter(r => (val(sea.S, r, 'min') || 0) > 0) : sea.rows;
      const rows = rowsAll.slice(-5);
      const vals = rows.map(r => (td ? sumF(sea.S, r, ['rtd', 'ctd']) : val(sea.S, r, spec.stat))).map(v => (num(v) ? v : 0));
      if (rows.length) log = { vals, labels: rows.map(r => String(r[1] || '')), src: 'ESPN box scores' };
    }
    if ((!log || log.vals.length < 3) && sp === 'nba' && pl) {
      const rf = E.recentOf(pl);
      if (rf && rf.last5 && rf.last5.length >= 3) log = { vals: rf.last5.map(Number), labels: (rf.opp5 || []).map(String), src: 'box scores (morning form check)' };
      else { const l4 = E.last4Of(e.team, e.name), ok = logCut(g); const rr = l4 ? l4.rows.filter(r => ok(r.date) && !r.dnp && num(r[spec.stat])) : []; if (rr.length) log = { vals: rr.map(r => r[spec.stat]), labels: rr.map(r => String(r.opp || '')), src: 'last 4 box scores' }; }
    }
    if (log) {
      log.hits = log.vals.map(v => (td ? v >= 1 : under ? v < line : v > line));
      const h = log.hits.filter(Boolean).length, n = log.vals.length;
      log.title = `${ST_TITLE[spec.stat]} · last ${n}`;
      log.summary = td ? `${h} of ${n} with a TD` : `${h} of ${n} ${under ? 'under' : 'over'} ${fmtLine(line)}`;
      log.h = h; log.n = n;
    }
    const factors = factorsOf({ e, g, pl, td, sp, home, opp, line, under, log, sea, rowsAll, stat: spec.stat, M });
    const notes = [];
    const inj = injuryNote(e, pl); if (inj) notes.push(inj);
    if (defaulted) notes.push(`No line given, so this is the app's ladder line nearest a 65% chance. Add your book's line and price (like "over ${fmtLine(line)} at -110") for an edge read.`);
    if (pushAt != null) notes.push(`Exactly ${pushAt} would be a push (stake back); the chance shown is for a win.`);
    if (log && log.n < 10) notes.push(`Recent games: ${log.n} played (a small sample). Source: ${log.src}.`);
    return { ok: true, e, g, pl, td, sp, team: e.team, opp, home, pos, line, under, p, key, proj, M, price, V, log, factors, notes, stat: spec.stat, market: marketOf(spec.stat, line, under), fair: U.fair(p), defaulted };
  }
  function factorsOf(o) {
    const { e, g, pl, td, sp, home, line, under, log, sea, rowsAll, stat, M } = o;
    const F = [];
    // Matchup: the team's expected points from the game's price (total and spread) vs a typical team
    const c = E.teamCtx(g, e.team);
    if (c && TOT[sp]) {
      const m = SB.fit(g), tp = m && num(m.T) ? (m.T + c.mu) / 2 : null, avg = TOT[sp] / 2;
      const sc = Math.round(clamp(50 + 250 * (c.tf - 1) - 60 * Math.max(0, c.pb - .15), 0, 100));
      F.push({ name: 'Matchup', tone: sc >= 60 ? 'good' : sc < 40 ? 'bad' : 'mid', status: sc >= 60 ? 'Favorable' : sc < 40 ? 'Unfavorable' : 'Neutral',
        why: `${e.team} are expected to score ${f1(tp)} points from the game's total and spread, ${sg(((tp || avg) / avg - 1) * 100)}% vs a typical team (${f1(avg)}). Matchup score ${sc} of 100 (model estimate${c.gen ? '; no posted total, so a league-average total is used' : ''}).` });
    } else if (TOT[sp] && !SB.priced(g)) F.push({ name: 'Matchup', tone: 'mid', status: 'Unknown', why: `The feed has no price for ${g.away.abbr} @ ${g.home.abbr} yet, so ${e.team}'s expected points are unknown. ${td ? 'The TD model uses an even game (52% home).' : `The chance uses his season average${M && M.rf ? ' and recent form (30%)' : ''} only.`}` });
    else F.push({ name: 'Matchup', tone: 'mid', status: 'Unknown', why: `The app has no team-points read for this ${SPN[sp] || sp} game, so the matchup is not scored. The chance uses his season average${M && M.rf ? ' and recent form (30%)' : ''}.` });
    // Trends: his recent games vs his season
    if (log && log.n) {
      if (td) {
        const all = rowsAll || [], sh = sea ? all.filter(r => sumF(sea.S, r, ['rtd', 'ctd']) >= 1).length : null, sn = all.length;
        const rr = log.h / log.n, sr = sn ? sh / sn : null;
        const tone = sr == null ? 'mid' : rr >= sr + .15 ? 'good' : rr <= sr - .15 ? 'bad' : 'mid';
        F.push({ name: 'Trends', tone, status: tone === 'good' ? 'Hot' : tone === 'bad' ? 'Cold' : 'Steady', why: `A TD in ${log.h} of his last ${log.n} games${sn ? ` vs ${sh} of ${sn} this season` : ''} (a small sample).` });
      } else {
        const r = mean(log.vals), s = pl && num(pl.avg) ? pl.avg : sea && rowsAll && rowsAll.length ? mean(rowsAll.map(x => val(sea.S, x, stat) || 0)) : null;
        const rel = s ? r / s : 1, tone = rel >= 1.1 ? 'good' : rel <= .9 ? 'bad' : 'mid';
        F.push({ name: 'Trends', tone, status: tone === 'good' ? 'Hot' : tone === 'bad' ? 'Cold' : 'Steady', why: `Last ${log.n} games: ${f1(r)} ${ST_NAME[stat]} a game${s != null ? ` vs ${f1(s)} this season (${sg(r - s)})` : ''}. ${log.summary}. ${log.n} games is a small sample.` });
      }
    } else F.push({ name: 'Trends', tone: 'mid', status: 'No recent games', why: `No recent box scores for ${e.name} in the app's data.` });
    // Game script: the team's result for TDs and rushing; blowout / close-game risk for the rest
    const pr = SB.priced(g);
    if (td || stat === 'ryd') {
      const pw = pr ? SB.p1(g, home ? 'H' : 'A') : null;
      if (num(pw)) F.push({ name: 'Game script', tone: pw >= .6 ? 'good' : pw <= .4 ? 'bad' : 'mid', status: pw >= .6 ? 'Favored' : pw <= .4 ? 'Underdog' : 'Even game',
        why: `${e.team} win chance ${pc(pw)} from the feed's price. Teams that lead tend to run more and score more touchdowns; backs' yards and TDs moved with their team's win in this season's box scores.` });
      else F.push({ name: 'Game script', tone: 'mid', status: 'Unknown', why: `No price for this game in the feed yet, so the app can't say whether ${e.team} are likely to lead.` });
    } else {
      const pb = c ? c.pb : null, cl = E.closeOf(g), bl = (E.BLOW || {})[sp];
      if (pb == null && !cl) F.push({ name: 'Game script', tone: 'mid', status: 'Unknown', why: 'No price for this game in the feed yet, so blowout and close-game chances are unknown.' });
      else {
        const bench = pl && pl.mpg > 0 && pl.mpg < 20;
        const tone = pb != null && pb >= .25 ? (bench ? 'good' : 'bad') : cl && cl.p >= .45 ? 'good' : 'mid';
        const status = pb != null && pb >= .25 ? 'Blowout risk' : cl && cl.p >= .45 ? 'Close game' : 'Neutral';
        const parts = [];
        if (pb != null && bl) parts.push(`Blowout chance ${pc(pb)} (a ${bl}+ point margin in the game's simulations); ${bench ? 'bench players get more minutes' : 'starters sit late'} in those, and the model counts it.`);
        if (cl) parts.push(`Chance it stays within 8: ${pc(cl.p)} (${cl.src === 'model' ? 'model' : 'from Polymarket'}).`);
        F.push({ name: 'Game script', tone, status, why: parts.join(' ') });
      }
    }
    // Usage: minutes, targets, carries or shots, recent vs season
    let uf = null, ul = null;
    if (sp === 'nba') { uf = ['min']; ul = 'Minutes'; }
    else if (sp === 'nfl' || sp === 'ncaaf') { const P = String((o.e.pos || (sea && sea.p.pos) || '')).toUpperCase(); if (td || P === 'RB') { uf = ['ra', 'tgt']; ul = 'Touches (carries + targets)'; } else if (P === 'QB' || stat === 'pyd') { uf = ['pa']; ul = 'Pass attempts'; } else { uf = ['tgt']; ul = 'Targets'; } }
    else if (sp === 'nhl') { uf = ['sog']; ul = 'Shots on goal'; }
    if (uf && sea && rowsAll && rowsAll.length >= 2) {
      const rec = rowsAll.slice(-3), r = mean(rec.map(x => sumF(sea.S, x, uf))), s = mean(rowsAll.map(x => sumF(sea.S, x, uf)));
      const rel = s ? r / s : 1, tone = rel >= 1.1 ? 'good' : rel <= .9 ? 'bad' : 'mid';
      F.push({ name: 'Usage', tone, status: tone === 'good' ? 'Rising' : tone === 'bad' ? 'Falling' : 'Steady', why: `${ul}: ${f1(r)} a game in his last ${rec.length} vs ${f1(s)} this season (${rowsAll.length} games, ESPN box scores).` });
    } else if (sp === 'nba' && pl && num(pl.mpg) && pl.mpg > 0) {
      const l4 = E.last4Of(e.team, e.name), ok = logCut(g), mins = l4 ? l4.rows.filter(r => ok(r.date) && !r.dnp && r.min > 0).map(r => r.min) : [];
      if (mins.length) { const r = mean(mins), rel = r / pl.mpg, tone = rel >= 1.08 ? 'good' : rel <= .92 ? 'bad' : 'mid'; F.push({ name: 'Usage', tone, status: tone === 'good' ? 'Rising' : tone === 'bad' ? 'Falling' : 'Steady', why: `Minutes: ${f1(r)} a game in his last ${mins.length} vs ${f1(pl.mpg)} this season.` }); }
      else F.push({ name: 'Usage', tone: 'mid', status: 'Steady', why: `Minutes: ${f1(pl.mpg)} a game this season; no recent box scores in the app's data.` });
    } else F.push({ name: 'Usage', tone: 'mid', status: 'Unknown', why: `No usage numbers for ${e.name} in the app's box scores.` });
    return under ? F.map(flipF) : F;
  }

  // ---------------------------------------------------------------- games, parlays, lists, start / sit
  function bestLeg(pl, lo, hi, target) {
    let b = null;
    for (const t of E.LADDER[pl.stat] || []) { const p = E.playerP(pl, t); if (p < lo || p > hi) continue; const d = Math.abs(p - target); if (!b || d < b.d) b = { t, p, d }; }
    return b;
  }
  function analyzeGame(gid) {
    const g = SB.gameById(gid); if (!g || !SB.openG(g)) return { ok: false, why: 'This game has started or left the board, so this card is closed.' };
    const pr = SB.priced(g), m = pr ? SB.fit(g) : null;
    const pH = pr ? SB.p1(g, 'H') : null, pA = pr ? SB.p1(g, 'A') : null, pD = pr && g.sport === 'soccer' ? SB.p1(g, 'D') : null;
    let spread = null, total = null, xg = null;
    if (m && m.kind === 'margin') { spread = `${m.mu >= 0 ? g.home.abbr : g.away.abbr} −${f1(Math.abs(m.mu))}`; total = f1(m.T); }
    else if (m && m.kind === 'goals') { const S = SB.scoreMatrix(g); if (S) { total = f1(S.eh + S.ea); xg = `${f1(S.eh)} – ${f1(S.ea)}`; } }
    const props = [], X = pIndex();
    for (const e of X.list) {
      if (e.gid !== g.id) continue;
      for (const [st, pl] of Object.entries(e.stats)) { if (pl.status !== 'active') continue; const b = bestLeg(pl, .5, .9, .7); if (b) props.push({ e, stat: st, line: b.t - .5, p: b.p, key: `P:${pl.id}:${b.t}`, score: b.p + (E.STAT_PREF[st] || 0) }); }
      if (e.td && e.td.gid === g.id) { const p = SB.p1(g, e.td.key); if (p >= .3) props.push({ e, stat: 'td', line: .5, p, key: e.td.key, score: p }); }
    }
    const seen = new Set(), top = props.sort((a, b) => b.score - a.score).filter(x => (seen.has(x.e.k) ? false : seen.add(x.e.k))).slice(0, 4);
    return { ok: true, g, pr, pH, pA, pD, spread, total, xg, props: top };
  }
  function parlayOf(spec) {
    const legs = [], gone = [];
    for (const L of spec.legs || []) {
      const g = SB.gameById(L.gid), p = g ? SB.p1(g, L.key) : 0;
      let ok = !!g && SB.openG(g) && p > 0; if (ok && !/:/.test(L.key)) ok = SB.priced(g);
      if (!ok) { gone.push(L); continue; }
      legs.push({ gid: L.gid, key: L.key, label: SB.legLabel({ gid: L.gid, key: L.key, label: L.label }), p, sport: g.sport });
    }
    const pr = legs.length ? SB.parlayProb(legs) : { p: 0, indep: 0 };
    return { legs, gone, p: pr.p, indep: pr.indep };
  }
  const PPR = { pyd: .04, ptd: 4, ryd: .1, rtd: 6, rec: 1, recyd: .1, ctd: 6 };
  const pprRow = (S, r) => Object.entries(PPR).reduce((s, [f, w]) => s + (val(S, r, f) || 0) * w, 0);
  function analyzeSS(names) {
    const out = [];
    for (const nm of (names || []).slice(0, 4)) {
      const r = resolvePlayer(nm);
      const e = r && r.e, sp = e ? e.sport : r && r.s ? r.s.sp : null, name = e ? e.name : r && r.s ? r.s.p.n : String(nm);
      if (!r || (sp !== 'nfl' && sp !== 'ncaaf')) { out.push({ ok: false, name, why: `${name} isn't an NFL or college football player in the app's data.` }); continue; }
      const team = e ? e.team : r.s.p.t, g = e ? SB.gameById(e.gid) : pIndex().nextG.get(sp + '|' + team) || null, sea = seasonOf(sp, name, team, g);
      if (!sea || !sea.rows.length) { out.push({ ok: false, name, why: `No box scores for ${name} this season.` }); continue; }
      const pts = sea.rows.map(x => pprRow(sea.S, x)), seasonPPR = mean(pts), last3 = mean(pts.slice(-3));
      const ctx = g ? E.teamCtx(g, team) : null, adj = ctx ? 1 + .5 * (ctx.tf - 1) : 1;
      const tdp = e && e.td ? SB.p1(SB.gameById(e.td.gid), e.td.key) : null;
      out.push({ ok: true, name, team, pos: (e && e.pos) || sea.p.pos || '', sp, g, seasonPPR, last3, proj: (.7 * seasonPPR + .3 * last3) * adj, adj, tdp: tdp > 0 ? tdp : null, gp: sea.rows.length });
    }
    const ok = out.filter(x => x.ok).sort((a, b) => b.proj - a.proj);
    let V = null;
    if (ok.length >= 2) { const d = ok[0].proj - ok[1].proj; V = d < 1.5 ? { tone: 'coin', title: 'Close call', d } : { tone: d >= 4 ? 'take' : 'lean', title: `Start ${ok[0].name}`, d }; }
    else if (ok.length === 1) V = { tone: ok[0].proj >= 12 ? 'lean' : 'coin', title: ok[0].proj >= 12 ? `Start ${ok[0].name}` : `${ok[0].name}: a flex-level start`, d: null };
    return { rows: out, ok, V };
  }

  // ---------------------------------------------------------------- breakdowns: the analysis
  const statLine = (P, row, F) => F.map(f => `${fN(rv(P.sp, row.r, f))} ${SFS[f]}`).join(', ');
  const oppLbl = row => `${row.home ? 'vs' : '@'} ${row.opp}`;
  // the app's lines for a player on the slate (the ladder line nearest a 65% chance per market), for his next game
  function appLinesOf(name, sp) {
    const e = pIndex().by.get(E.nameKey(name)); if (!e || e.sport !== sp) return { e: null, lines: [] };
    const lines = [];
    for (const [st, pl] of Object.entries(e.stats)) { if (pl.status !== 'active') continue; const L = defaultLine(pl, false), thr = Math.ceil(L), p = E.playerP(pl, thr); if (num(p)) lines.push({ st, line: L, p, key: `P:${pl.id}:${thr}`, gid: e.gid }); }
    if (e.td) { const g = SB.gameById(e.td.gid), p = g ? SB.p1(g, e.td.key) : 0; if (p > 0) lines.push({ st: 'td', line: .5, p, key: e.td.key, gid: e.td.gid }); }
    return { e, lines: lines.sort((a, b) => (b.st === 'pts') - (a.st === 'pts') || b.p - a.p).slice(0, 4) };
  }
  // everything player_stats and the player card show: season per-game numbers, the last N games (with the team's result),
  // splits from the logged games, the next game and the app's lines, injury report, headlines
  function playerData(P, o) {
    o = o || {}; const sp = P.sp, F = showF(sp, P.pos), mf = o.st && hasF(sp, o.st) ? o.st : mainF(P);
    let rows = P.rows; const filt = [];
    if (o.opp) { rows = rows.filter(r => r.opp === o.opp); filt.push(`vs ${o.opp}`); }
    if (o.venue === 'home' || o.venue === 'away') { rows = rows.filter(r => r.home === (o.venue === 'home')); filt.push(o.venue === 'home' ? 'at home' : 'away'); }
    const n = clamp(Math.round(+o.n || 5), 1, 15), last = rows.slice(-n).map(r => ({ r, res: resOn(sp, r.t, r.d, r.opp) }));
    const avg = (rs, f) => (rs.length ? mean(rs.map(r => rv(sp, r.r, f))) : null);
    const L = P.rows, home = L.filter(r => r.home), away = L.filter(r => !r.home), l5 = L.slice(-5);
    const per = F.map(f => [f, pgOf(P, f)]);
    const nx = nextGameOf(sp, P.team), AL = appLinesOf(P.name, sp);
    return { P, sp, F, mf, n, filt, rows, last, per, avg,
      split: { home: { n: home.length, v: avg(home, mf) }, away: { n: away.length, v: avg(away, mf) }, l5: { n: l5.length, v: avg(l5, mf) }, sel: filt.length ? { n: rows.length, v: avg(rows, mf), lbl: filt.join(', ') } : null },
      nx, lines: AL.lines, slate: AL.e, inj: injuryOf(P.name, sp), news: newsOfPlayer(P.name) };
  }
  // how far off still counts as a near miss; a yes / no leg (an anytime TD, a goal, a point: line under 1.5) has none
  const nearTol = (f, line) => (Math.abs(line) < 1.5 ? 0 : /yd$/.test(f) ? Math.max(5, Math.round(Math.abs(line) * .1)) : f === 'pts' || f === 'min' ? Math.max(1, Math.round(Math.abs(line) * .08)) : 1);
  // one game for one player: the stat vs the line (or vs his average in his other games), how close, the workload, the game's
  // result, and reasons: facts from the data, and possibilities named as possibilities
  function reviewOf(P, i, f, line, under) {
    const sp = P.sp, row = P.rows[i], v = rv(sp, row.r, f), others = P.gp - 1;
    const avgO = g => (others > 0 ? (tv(sp, P.tot, g) - rv(sp, row.r, g)) / others : null);
    const ao = avgO(f);
    let verdict = 'none', short = null, spare = null, needed = null, cap = null;
    if (num(line)) {
      if (under) { cap = Number.isInteger(line) ? line - 1 : Math.floor(line); verdict = v < line ? 'hit' : v === line ? 'push' : 'miss'; if (verdict === 'miss') short = v - cap; else if (verdict === 'hit') spare = cap - v; }
      else { needed = Number.isInteger(line) ? line + 1 : Math.ceil(line); verdict = v > line ? 'hit' : v === line ? 'push' : 'miss'; if (verdict === 'miss') short = needed - v; else if (verdict === 'hit') spare = v - needed; }
    }
    const tol = num(line) ? nearTol(f, line) : 0, near = verdict === 'miss' && short <= tol, barely = verdict === 'hit' && spare < tol;
    const u = n => unitOf(f, n);
    let closeTxt = '';
    if (verdict === 'miss') closeTxt = under ? `${fN(short)} ${u(short)} too many (needed ${fN(cap)} or fewer)${near ? ', a near miss' : ''}` : `${fN(short)} ${u(short)} short (needed ${fN(needed)})${near ? ', a near miss' : ''}`;
    else if (verdict === 'hit') closeTxt = spare === 0 ? `exactly the ${fN(under ? cap : needed)}${under ? ' or fewer' : ''} needed, no room to spare` : `${fN(spare)} ${u(spare)} to spare${barely ? ' (close)' : ''}`;
    else if (verdict === 'push') closeTxt = `exactly the line: a push (stake back at most books)`;
    else if (num(ao)) closeTxt = `${sg(v - ao)} vs his average of ${f1(ao)} in his other ${others} games`;
    const res = resOn(sp, row.t, row.d, row.opp), scr = res ? scriptOf(sp, res) : null;
    const facts = [], maybe = [];
    // workload
    const U0 = useOf(sp, P.pos, f); let use = null;
    if (U0) {
      const uv = U0[0].reduce((s, g) => s + rv(sp, row.r, g), 0), ua = U0[0].reduce((s, g) => s + (avgO(g) || 0), 0);
      if (others > 0 && ua > 0) {
        const rel = uv / ua, dn = rel <= .85 && ua - uv >= (sp === 'nba' ? 4 : 1), up = rel >= 1.15 && uv - ua >= (sp === 'nba' ? 4 : 1);
        use = { lbl: U0[1], v: uv, a: ua, dn, up };
        facts.push(sp === 'nba' ? `Played ${fN(uv)} minutes vs ${f1(ua)} a game in his other ${others} games${dn ? ' (well down)' : up ? ' (up)' : ' (his usual workload)'}.` : `${fN(uv)} ${U0[1]} vs ${f1(ua)} a game in his other ${others} games${dn ? ' (well down)' : up ? ' (up)' : ' (his usual workload)'}.`);
        // output per unit of work, when the work was there
        if (uv > 0 && !dn && f !== 'min' && (sp === 'nba' || /yd$/.test(f) || f === 'rec')) {
          const per = v / uv, perA = (ao || 0) / ua, unit = sp === 'nba' ? 'a minute' : U0[1] === 'targets' ? 'a target' : U0[1] === 'carries' ? 'a carry' : U0[1] === 'pass attempts' ? 'an attempt' : 'a touch';
          if (perA > 0 && Math.abs(per / perA - 1) >= .25) facts.push(`${per < perA ? 'Less' : 'More'} per ${unit.replace(/^an? /, '')} than usual: ${per.toFixed(2)} ${SF[f]} ${unit} vs ${perA.toFixed(2)} in his other games, so the ${verdict === 'miss' || v < (ao || 0) ? 'shortfall came from what he did with his time, not from playing time' : 'gain came from what he did with his time'}.`);
        }
      }
    }
    // the game's result and margin
    if (res) {
      const won = res.pf > res.pa;
      facts.push(`${P.team} ${res.pf === res.pa ? 'drew' : won ? 'won' : 'lost'} ${res.pf}-${res.pa} ${row.home ? 'at home vs' : 'at'} ${row.opp}${scr && scr.k !== 'draw' ? `, ${scr.txt}` : ''}.`);
      if (scr && scr.k === 'blowout' && (sp === 'nba' || sp === 'nhl') && use && use.dn) maybe.push(`Starters often sit late in blowouts; his minutes being down fits that, but the box score doesn't say why he sat.`);
      else if (scr && scr.k === 'blowout' && (sp === 'nba' || sp === 'nhl') && (verdict === 'miss' || verdict === 'none')) maybe.push(`A blowout can change how a team plays late; his minutes were close to normal, so it may not explain much here.`);
      if (scr && scr.k === 'blowout' && !won && (f === 'ryd' || f === 'ra') && (sp === 'nfl' || sp === 'ncaaf')) maybe.push(`Teams that trail by a lot usually throw more, which can cut a back's carries (a possibility, not shown by the box score).`);
      if (scr && scr.k === 'blowout' && won && (f === 'pyd' || f === 'pa') && (sp === 'nfl' || sp === 'ncaaf')) maybe.push(`Teams with a big lead usually run the ball more, which can cut passing (a possibility).`);
    }
    // the rest of his line: a big night elsewhere
    if (others > 0) for (const g of showF(sp, P.pos)) {
      if (g === f || g === 'min' || (use && use.lbl.includes(SF[g] || '~'))) continue;
      const gv = rv(sp, row.r, g), ga = avgO(g); if (!num(ga)) continue;
      if (gv >= ga * 1.5 && gv - ga >= (sp === 'nba' ? 3 : /yd$/.test(g) ? 25 : 2)) {
        facts.push(`He had ${fN(gv)} ${unitOf(g, gv)} vs ${f1(ga)} a game in his other games.`);
        if (verdict === 'miss' || (verdict === 'none' && v < (ao || 0))) maybe.push(`A bigger share of ${SF[g]} may have come at the cost of ${SF[f]}; the data can't show that directly.`);
        break;
      }
    }
    // form coming in, venue, the opponent's defence
    const before = P.rows.slice(Math.max(0, i - 5), i);
    if (before.length >= 3) { const bm = mean(before.map(r => rv(sp, r.r, f))), sa = pgOf(P, f); facts.push(`Coming in, he averaged ${f1(bm)} ${SF[f]} in his previous ${before.length} games (season ${f1(sa)}).`); }
    const hm = P.rows.filter((r, j) => j !== i && r.home), aw = P.rows.filter((r, j) => j !== i && !r.home);
    if (hm.length >= 3 && aw.length >= 3) { const a1 = mean(hm.map(r => rv(sp, r.r, f))), a2 = mean(aw.map(r => rv(sp, r.r, f))); if (Math.max(a1, a2) > 0 && Math.abs(a1 - a2) / Math.max(a1, a2) >= .15) facts.push(`He averages ${f1(a1)} at home and ${f1(a2)} away in his other logged games; this one was ${row.home ? 'at home' : 'away'}.`); }
    if (/^(pts|pyd|ryd|recyd|rec|td|g|hpts|sog|sot)$/.test(f)) { const al = allowedOf(sp, row.opp); if (al) facts.push(`${row.opp} allow ${f1(al.pa)} ${PTW[sp]} a game this season (${ord(al.rank)} fewest of ${al.of}).`); }
    const inj = injuryOf(P.name, sp);
    if (inj) maybe.push(`He is listed ${inj.status}${inj.injury ? ` (${inj.injury})` : ''} on the app's current injury report${inj.updated ? ` (updated ${fmtD(inj.updated)})` : ''}; whether that affected this game isn't in the data.`);
    return { P, i, row, f, v, line: num(line) ? line : null, under: !!under, verdict, short, spare, needed, cap, near, barely, closeTxt, ao, others, res, scr, use, facts: facts.slice(0, 6), maybe: maybe.slice(0, 3) };
  }
  // the player, the game and the line one review is about (shared by the tool, the offline answer and the card)
  function reviewSpec(P, o) {  // o: {st, line, under, d, exact, opp, lineSrc}
    const i = rowFor(P, { d: o.d, exact: o.exact, opp: o.opp }); if (i < 0) return { i };
    const row = P.rows[i], recs = recLegsFor(P.name, row.d);
    let f = o.st && hasF(P.sp, o.st) ? o.st : null, line = num(o.line) ? o.line : null, under = !!o.under, src = line != null ? (o.lineSrc || 'you') : '', p = null, recT = '';
    const pickRec = recs.find(x => { const I = recInfo(x.L); return (!f || I.f === f) && (line == null || Math.abs(I.line - line) < .01) && (o.under == null || I.under === under); }) || (f || line != null ? null : recs[0]);
    if (pickRec) { const I = recInfo(pickRec.L); if (!f && hasF(P.sp, I.f)) f = I.f; if (f === I.f && line == null) { line = I.line; under = I.under; src = 'app'; } if (f === I.f && Math.abs((line || 0) - (I.line || 0)) < .01) { p = I.p; recT = `${recTitle(pickRec.P)} (${fmtD(pickRec.day)})`; } }
    if (!f) f = mainF(P);
    return { i, f, line, under, src, p, recT };
  }
  // ---- a parlay leg, graded from box scores (players) and final scores (games)
  const LBL_P = /^(.+?) (\d+(?:\.\d+)?)\+ (points|rebounds|assists|receptions|rushing yards|receiving yards|passing yards|shots on goal|shots on target)$/i;
  const LBL_U = /^(.+?) under (\d+(?:\.\d+)?) (points|rebounds|assists|receptions|rushing yards|receiving yards|passing yards|shots on goal|shots on target)$/i;
  const WORD_F = { points: 'pts', rebounds: 'reb', assists: 'ast', receptions: 'rec', 'rushing yards': 'ryd', 'receiving yards': 'recyd', 'passing yards': 'pyd', 'shots on goal': 'sog', 'shots on target': 'sot' };
  function legPlayerInfo(L, sp) {
    const fx = st => (sp === 'nhl' && (st === 'pts' || st === 'hpts') ? 'hpts' : st);
    if (L.player && typeof L.player.name === 'string') { const I = recInfo(L); return { name: L.player.name, team: String(L.player.team || ''), f: fx(I.f), line: I.line, under: I.under }; }
    const k = String(L.key || '');
    if (/^[PU]:/.test(k)) {
      const i = E.pLegInfo(k); if (i && i.pl) return { name: i.pl.name, team: i.pl.team, f: fx(i.pl.stat), line: i.under ? i.thr : i.thr - .5, under: !!i.under };
      const lb = String(L.label || ''), mp = LBL_P.exec(lb), mu = mp ? null : LBL_U.exec(lb), m = mp || mu;
      if (m) return { name: m[1], team: '', f: fx(WORD_F[m[3].toLowerCase()]), line: mu ? +m[2] : +m[2] - .5, under: !!mu };
    }
    if (/^TD:A:/.test(k)) { const parts = k.split(':'), m = /^(.+?) \(([A-Za-z0-9]+)\) anytime TD$/.exec(String(L.label || '')), x = E.nflByTd && E.nflByTd.get(parts[2] + '|' + parts[3]); const name = m ? m[1] : x && x.name; if (name) return { name, team: parts[2], f: 'td', line: .5, under: false }; }
    return null;
  }
  const isUndecidable = k => /^(TD:F|G|L|FB|SC|X|SIM|SX):/.test(String(k || ''));
  function settleKey(key, h, a) {
    const k = String(key || ''); let m;
    if (k === 'H') return h > a; if (k === 'A') return a > h; if (k === 'D') return h === a;
    if ((m = /^([HA])(\d+(?:\.\d+)?)$/.exec(k))) return (m[1] === 'H' ? h - a : a - h) > (Number.isInteger(+m[2]) ? +m[2] - .5 : +m[2]);  // H2: by 2+; H5.5: by 6+
    if ((m = /^([HA])\+(\d+(?:\.\d+)?)$/.exec(k))) return (m[1] === 'H' ? h - a : a - h) > -m[2];
    if ((m = /^([OU])(\d+(?:\.\d+)?)$/.exec(k))) return m[1] === 'O' ? h + a > +m[2] : h + a < +m[2];
    if ((m = /^CS(\d+)-(\d+)$/.exec(k))) return h === +m[1] && a === +m[2];
    if (k === 'BTTS') return h > 0 && a > 0;
    return null;
  }
  function gameClose(sp, key, h, a, hab, aab, ok) {
    const k = String(key || ''); let m;
    if ((m = /^([HA])(\d+(?:\.\d+)?)?$/.exec(k))) {
      const side = m[1] === 'H' ? hab : aab, mg = m[1] === 'H' ? h - a : a - h, need = m[2] ? (Number.isInteger(+m[2]) ? +m[2] - .5 : +m[2]) : 0;
      const t = mg > 0 ? `${side} won by ${mg}` : mg < 0 ? `${side} lost by ${-mg}` : 'a draw';
      return { txt: need ? `${t} (needed more than ${fmtLine(need)})` : t, near: !ok && Math.abs(mg - need) <= NEARM[sp], barely: ok && mg - need <= (NEARM[sp] || 1) };
    }
    if ((m = /^([HA])\+(\d+(?:\.\d+)?)$/.exec(k))) {
      const side = m[1] === 'H' ? hab : aab, mg = m[1] === 'H' ? h - a : a - h, n = +m[2];
      return { txt: `${side} ${mg > 0 ? `won by ${mg}` : mg < 0 ? `lost by ${-mg}` : 'drew'} (+${fmtLine(n)} needed ${n < 1 ? 'a win' : `no worse than a ${Math.floor(n)}-${PTW[sp] === 'goals' ? 'goal' : 'point'} loss`})`, near: !ok && Math.abs(mg + n) <= NEARM[sp], barely: ok && mg + n <= (NEARM[sp] || 1) };
    }
    if ((m = /^([OU])(\d+(?:\.\d+)?)$/.exec(k))) { const tot = h + a, ln = +m[2], d = m[1] === 'O' ? tot - ln : ln - tot; return { txt: `total ${tot} vs ${fmtLine(ln)} (${sg(tot - ln)})`, near: !ok && Math.abs(d) <= NEART[sp], barely: ok && Math.abs(d) <= NEART[sp] }; }
    if ((m = /^CS(\d+)-(\d+)$/.exec(k))) { const off = Math.abs(h - m[1]) + Math.abs(a - m[2]); return { txt: `final ${h}-${a} vs the ${m[1]}-${m[2]} picked`, near: !ok && off === 1, barely: false }; }
    return { txt: '', near: false, barely: false };
  }
  function gradeLeg(L, saved) {
    const gsp = String(L.sport || String(L.gid || '').split('-')[0]), sp = SPORTS.includes(gsp) ? gsp : null, d = legDate(L);
    const p = num(+L.p) && +L.p > 0 ? +L.p : num(+L.p1) && +L.p1 > 0 ? +L.p1 : null;
    const G = { label: String(L.label || L.key || 'Leg').slice(0, 120), sp, d, p, gid: String(L.gid || ''), key: String(L.key || '') };
    const rec = L.res === true || L.res === false ? { res: L.res, actual: L.actual != null ? String(L.actual).slice(0, 60) : '' } : null;
    const fromRec = (base, why) => ({ ...base, status: rec.res ? 'hit' : 'miss', actual: rec.actual, detail: why || 'graded by the app\'s morning run' });
    const info = sp ? legPlayerInfo(L, sp) : null;
    if (info) {
      const base = { ...G, kind: 'player', name: info.name, f: info.f, line: info.line, under: info.under };
      const R = seasonFind(info.name, sp, info.team);
      if (!R) return rec ? fromRec(base) : { ...base, status: 'unknown', detail: `${info.name} isn't in this season's box scores.` };
      const P = seasonPlayer(R.sp, R.p); Object.assign(base, { name: P.name, team: P.team, pos: P.pos, P });
      const i = d ? P.rows.findIndex(r => r.d === d) : -1;
      if (i < 0 || !hasF(P.sp, info.f)) {
        if (rec) return fromRec(base);
        const st = Date.parse(L.start || '');
        if ((isFinite(st) && st > Date.now()) || (d && d > todayU())) return { ...base, status: 'pending', detail: 'not played yet' };
        return { ...base, status: 'unknown', detail: d && resOn(P.sp, P.team, d) ? `no box-score line for him on ${fmtD(d)}: he didn't play (or had 0 minutes)` : 'no box score for this game in the app\'s data yet' };
      }
      const V = reviewOf(P, i, info.f, info.line, info.under);
      return { ...base, i, V, status: V.verdict === 'none' ? 'unknown' : V.verdict, actual: `${fN(V.v)} ${SFS[info.f]}`, near: V.near, barely: V.barely, detail: V.closeTxt, gk: G.gid || `${P.sp}|${V.row.d}|${[P.team, V.row.opp].sort().join('-')}` };
    }
    if (isUndecidable(G.key)) return rec ? fromRec({ ...G, kind: 'other' }) : { ...G, kind: 'other', status: 'unknown', detail: /^TD:F/.test(G.key) ? 'a first-TD leg: the box scores don\'t say who scored first' : 'the app can\'t grade this kind of leg from box scores' };
    const g = G.gid ? SB.gameById(G.gid) : null, hab = String(L.home || (g && g.home.abbr) || ''), aab = String(L.away || (g && g.away.abbr) || '');
    let h = null, a = null, src = '';
    if (g && SB.isFinal(g)) { h = +g.score.home; a = +g.score.away; src = 'the feed\'s final score'; }
    if (h == null && saved && saved.res && saved.res[G.gid]) { const r = saved.res[G.gid]; if (isFinite(+r.h) && isFinite(+r.a)) { h = +r.h; a = +r.a; src = 'the final score saved with your parlay'; } }
    if (h == null && sp && hab) { const eh = espnOf(sp, hab, g && g.home.name), ea = espnOf(sp, aab, g && g.away.name), x = eh ? resOn(sp, eh, d, ea || null) : null; if (x && x.home) { h = x.pf; a = x.pa; src = 'ESPN results'; } }
    if (h == null) {
      if (rec) return fromRec({ ...G, kind: 'game' });
      const st = Date.parse(L.start || (g && g.start) || '');
      return { ...G, kind: 'game', status: 'pending', detail: isFinite(st) && st > Date.now() ? 'not played yet' : 'no final score in the app\'s data yet' };
    }
    const stub = g || { id: G.gid || 'x', sport: sp, comp: String(L.comp || ''), start: String(L.start || ''), home: { abbr: hab, name: hab }, away: { abbr: aab, name: aab }, status: 'closed', score: { home: h, away: a } };
    let r = null; try { r = SB.evalMarket(stub, G.key, h, a); } catch (e) { r = null; }
    if (r == null) r = settleKey(G.key, h, a);
    if (r == null && rec) r = rec.res;
    const C = gameClose(sp, G.key, h, a, hab, aab, r === true);
    const side = /^(H|A)/.test(G.key) && !/^(HO|AO|HCS|ACS)/.test(G.key) ? (G.key[0] === 'H' ? hab : aab) : null;
    return { ...G, kind: 'game', status: r == null ? 'unknown' : r ? 'hit' : 'miss', actual: `${hab} ${h}-${a} ${aab}`, h, a, near: r === false && C.near, barely: r === true && C.barely, detail: C.txt, src,
      team: side ? espnOf(sp, side, g && (side === hab ? g.home.name : g.away.name)) || side : null, total: /^[OU]\d/.test(G.key) ? G.key[0] : null, gk: G.gid || `${sp}|${d}|${[hab, aab].sort().join('-')}` };
  }
  // a leg the viewer typed: {player, stat, line, side, date} or {team, market: win | cover | over | under, line, date}
  function gradeTyped(x) {
    const dt = x.date ? dateIn(String(x.date)) : {}, exact = !!x.exact;
    if (x.player) {
      const R = seasonFind(String(x.player)); if (!R) return { label: String(x.player).slice(0, 60), kind: 'player', status: 'unknown', detail: `no player named "${String(x.player).slice(0, 40)}" in this season's box scores` };
      const P = seasonPlayer(R.sp, R.p), f = sfNorm(x.stat, P.sp, P.pos) || mainF(P), under = /under/i.test(String(x.side || ''));
      const line = x.line != null && x.line !== '' && isFinite(+x.line) && +x.line >= 0 ? +x.line : null;
      const label = `${P.name} ${line != null ? `${under ? 'under' : 'over'} ${fmtLine(line)} ` : ''}${SF[f]}`;
      const base = { label, kind: 'player', sp: P.sp, name: P.name, team: P.team, pos: P.pos, f, line, under, P, p: null };
      const i = rowFor(P, { d: dt.d, exact });
      if (i < 0) return { ...base, status: dt.d && dt.d >= E.dayOf(Date.now()) ? 'pending' : 'unknown', detail: dt.d ? `no game for him on ${fmtD(dt.d)} in the box scores` : 'no games in the box scores' };
      const V = reviewOf(P, i, f, line, under), rl = recLegsFor(P.name, V.row.d).map(y => recInfo(y.L)).find(I => I.f === f && line != null && Math.abs(I.line - line) < .01 && I.under === under);
      return { ...base, d: V.row.d, i, V, p: rl ? rl.p : null, status: V.verdict === 'none' ? 'unknown' : V.verdict, actual: `${fN(V.v)} ${SFS[f]}`, near: V.near, barely: V.barely,
        detail: V.verdict === 'none' ? `${oppLbl(V.row)} ${fmtD(V.row.d)}: ${V.closeTxt || 'no line given'}` : `${oppLbl(V.row)} ${fmtD(V.row.d)}: ${V.closeTxt}`, gk: `${P.sp}|${V.row.d}|${[P.team, V.row.opp].sort().join('-')}` };
    }
    const T = findTeam(String(x.team || ''), spNorm(x.sport)); const mk = String(x.market || 'win').toLowerCase();
    if (!T) return { label: String(x.team || 'Team').slice(0, 60), kind: 'game', status: 'unknown', detail: 'no team by that name in the app\'s results' };
    const R = T.eab ? resRows(T.sp, T.eab) : []; let j = R.length - 1;
    if (dt.d) { const pref = exact || !(T.sp === 'nba' || T.sp === 'nhl') ? [dt.d, dAdd(dt.d, 1)] : [dAdd(dt.d, 1), dt.d]; j = -1; for (const d of pref) { const k = R.findIndex(r => r.d === d); if (k >= 0) { j = k; break; } } }
    const line = x.line != null && x.line !== '' && isFinite(+x.line) ? +x.line : null;
    const label = mk === 'cover' ? `${T.name} ${line != null ? (line > 0 ? '+' : '') + fmtLine(line) : 'spread'}` : mk === 'over' || mk === 'under' ? `${T.name} game ${mk} ${line != null ? fmtLine(line) : ''}`.trim() : `${T.name} to win`;
    const base = { label, kind: 'game', sp: T.sp, team: mk === 'win' || mk === 'cover' ? T.eab : null, mk, p: null, total: mk === 'over' ? 'O' : mk === 'under' ? 'U' : null };
    if (j < 0) return { ...base, status: 'unknown', detail: dt.d ? `no ${T.name} game on ${fmtD(dt.d)} in the results` : 'no results for this team in the app\'s data' };
    const r = R[j], mg = r.pf - r.pa, tot = r.pf + r.pa, gk = `${T.sp}|${r.d}|${[T.eab, r.opp].sort().join('-')}`, act = `${T.eab} ${r.pf}-${r.pa} ${r.opp} (${fmtD(r.d)})`;
    if (mk === 'cover' || mk === 'over' || mk === 'under') {
      if (line == null) return { ...base, d: r.d, gk, status: 'unknown', actual: act, detail: `${mk === 'cover' ? 'a spread' : 'a total'} needs a line to grade` };
      const dd = mk === 'cover' ? mg + line : mk === 'over' ? tot - line : line - tot, st = dd > 0 ? 'hit' : dd < 0 ? 'miss' : 'push';
      return { ...base, d: r.d, gk, status: st, actual: act, near: st === 'miss' && Math.abs(dd) <= (mk === 'cover' ? NEARM : NEART)[T.sp], barely: st === 'hit' && Math.abs(dd) <= (mk === 'cover' ? NEARM : NEART)[T.sp],
        detail: mk === 'cover' ? `${mg > 0 ? 'won' : mg < 0 ? 'lost' : 'drew'} by ${Math.abs(mg)} vs ${line > 0 ? '+' : ''}${fmtLine(line)}: ${st === 'push' ? 'a push' : `${st === 'hit' ? 'covered' : 'missed'} by ${fmtLine(Math.abs(dd))}`}` : `total ${tot} vs ${fmtLine(line)}`, team: mk === 'cover' ? T.eab : null };
    }
    const st = mg > 0 ? 'hit' : 'miss';
    return { ...base, d: r.d, gk, status: st, actual: act, near: st === 'miss' && Math.abs(mg) <= NEARM[T.sp], barely: st === 'hit' && mg <= NEARM[T.sp], detail: mg > 0 ? `won by ${mg}` : mg < 0 ? `lost by ${-mg}` : 'a draw' };
  }
  // links between graded legs (pairs.json via engine.legRho): metas built from the graded legs, since past games have left the feed
  const PAIRF = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'rec', recyd: 'recyd', ryd: 'ryd', pyd: 'pyd', ptd: 'ptd', td: 'td', hpts: 'point', sog: 'sog', sot: 'sot', g: 'goal' };
  function metaOf(G) {
    if (G.kind === 'player' && PAIRF[G.f] && G.team) return { who: G.team + '|' + E.nameKey(G.name), name: G.name, team: G.team, stat: PAIRF[G.f], pos: /^(nfl|ncaaf)$/.test(G.sp) ? POS(G.pos) || null : null, sport: G.sp, flip: !!G.under };
    if (G.kind === 'game' && G.team && /^[HA](\d+(\.\d+)?|\+\d+(\.\d+)?|WN)?$/.test(G.key || 'H')) return { stat: 'win', team: G.team, sport: G.sp, game: true };
    if (G.kind === 'game' && G.total) return { stat: 'over', sport: G.sp, game: true, flip: G.total === 'U' };
    return null;
  }
  const kindOf = G => (G.kind === 'player' ? (G.f === 'td' ? null : E.legKind({ key: G.under ? 'U:x:1' : 'P:x:1', player: { stat: G.f } })) : G.kind === 'game' && G.key ? E.legKind({ key: G.key })
    : G.kind === 'game' && G.total ? (G.total === 'O' ? 'over total' : 'under total') : G.kind === 'game' && G.mk === 'win' ? 'moneyline' : null);
  function parlayReview(spec) {
    let title = '', day = '', legsIn = [], p = null, pSrc = '', saved = null, typed = false;
    if (spec.src === 'picks') {
      const R = recsD(); if (!R) return { ok: false, why: 'The app\'s graded picks (recs.json) aren\'t loaded on this page.' };
      const D = R.days.find(x => x && x.day === spec.day), P = D && (D.parlays || []).find(x => x && x.id === spec.id);
      if (!P || !Array.isArray(P.legs)) return { ok: false, why: 'That parlay is no longer in the app\'s saved picks (it keeps 30 days).' };
      title = recTitle(P); day = D.day; legsIn = P.legs; p = num(+P.p) && +P.p > 0 ? +P.p : null; pSrc = 'when the app made it';
    } else if (spec.src === 'saved') {
      const s = (SB.savedParlays || []).find(x => x && +x.at === +spec.at);
      if (!s || !Array.isArray(s.legs) || !s.legs.length) return { ok: false, why: 'That parlay is no longer in My Parlays on this device.' };
      saved = s; title = `Your ${s.legs.length}-leg parlay${s.book ? ' · ' + String(s.book).slice(0, 30) : ''}`; day = E.dayOf(+s.at || Date.now()); legsIn = s.legs; p = num(+s.p) && +s.p > 0 ? +s.p : null; pSrc = 'when you saved it';
    } else { typed = true; title = `Your ${(spec.legs || []).length}-leg parlay`; legsIn = (spec.legs || []).slice(0, 12); }
    const G = typed ? legsIn.map(gradeTyped) : legsIn.slice(0, 25).map(L => gradeLeg(L || {}, saved));
    const by = s => G.filter(x => x.status === s), hit = by('hit'), miss = by('miss'), push = by('push'), pend = G.filter(x => x.status === 'pending' || x.status === 'unknown');
    const status = miss.length ? 'miss' : pend.length ? 'pending' : 'hit';
    let pInd = null; if (p == null && G.length && G.every(x => num(x.p))) pInd = G.reduce((s, x) => s * x.p, 1);
    // legs that worked for or against each other (same game only)
    const links = [];
    for (let i = 0; i < G.length; i++) for (let j = i + 1; j < G.length; j++) {
      const A = G[i], B = G[j]; if (!A.gk || A.gk !== B.gk) continue;
      const ma = metaOf(A), mb = metaOf(B); if (!ma || !mb) continue;
      let r = null; try { r = E.legRho(ma, mb, null); } catch (e) { r = null; }
      if (!r || !num(r.r) || Math.abs(r.r) < .15) continue;
      const both = A.status === 'hit' && B.status === 'hit', none = A.status === 'miss' && B.status === 'miss', w = r.row || {};
      const unit = ma.who && ma.who === mb.who ? 'player-games' : ma.game || mb.game ? 'player-games' : 'team-games';
      links.push({ a: A.label, b: B.label, r: r.r, txt: `${A.label} + ${B.label}: ${r.r > 0 ? 'these work together' : 'these work against each other'} (link ${r.r > 0 ? '+' : '−'}${Math.abs(r.r).toFixed(2)}${w.n ? `, ${Number(w.n).toLocaleString('en-US')} ${unit} this season` : ''}). ${both ? 'Both landed.' : none ? 'Both missed.' : A.status === 'hit' || B.status === 'hit' ? `Here only ${A.status === 'hit' ? A.label : B.label} landed.` : 'Not graded yet.'}` });
    }
    // the app's track record for these kinds of legs (Lessons: each kind's hit rate vs what the model expected)
    const LS = (() => { try { return (E.lessons() || []).filter(x => x && x.n >= 4); } catch (e) { return []; } })(), kinds = [...new Set(G.map(kindOf).filter(k => k && k !== 'other'))];
    const lessons = kinds.map(k => LS.find(x => x.k === k)).filter(Boolean).map(x => ({ k: x.k, txt: `${x.k} legs: hit ${x.w} of ${x.n} (${pc(x.rate)}) vs ${pc(x.expRate)} the model expected${x.n < 10 ? ' (a small sample)' : ''}` }));
    const surprise = miss.filter(x => num(x.p)).sort((a, b) => b.p - a.p)[0] || null;
    const pp = p != null ? p : pInd;
    const says = [];
    if (pp != null) says.push(`Before the games it had a ${pc(pp)} chance${p != null ? ` (${pSrc}, model estimate)` : ' if the legs were unrelated (each leg\'s model chance multiplied)'}: a parlay like this ${status === 'miss' ? 'misses' : status === 'hit' ? 'hits' : 'lands'} ${freqW(status === 'miss' ? 1 - pp : pp)} even when every leg is priced right.`);
    if (surprise) says.push(`The biggest surprise: ${surprise.label} (${pc(surprise.p)} before the game); a ${pc(surprise.p)} leg misses ${freqW(1 - surprise.p)}.`);
    if (typed && !legsIn.some(x => x && x.date) && new Set(G.map(x => x.d).filter(Boolean)).size > 1) says.push('No date was given, so each leg is graded on that player\'s or team\'s most recent game, and those are on different days here. Add the date for one night.');
    if (G.length >= 4) says.push(`One parlay is a tiny sample: judge the picks by many days (track record), not by this one.`);
    return { ok: true, title, day, src: spec.src, legs: G, status, hit, miss, push, pend, p, pInd, pSrc, links: links.slice(0, 4), lessons: lessons.slice(0, 4), says, near: miss.filter(x => x.near), barely: hit.filter(x => x.barely), surprise };
  }
  // which of the app's saved parlays a question means: a day ('YYYY-MM-DD', 'yesterday', 'today') and words of a title; with no
  // title, the closest loss of the day's My Parlay Picks (fewest missed legs, then the highest chance)
  const missN = P => (P.legs || []).filter(L => L && L.res === false).length;
  function pickRecP(dayArg, titleArg) {
    const R = recsD(); if (!R) return { error: 'The app\'s graded picks (recs.json) aren\'t loaded on this page, so there are no picks to review.' };
    const days = R.days.filter(d => d && typeof d.day === 'string' && Array.isArray(d.parlays) && d.parlays.length);
    if (!days.length) return { error: 'The app has no saved picks yet.' };
    const today = E.dayOf(Date.now()), da = String(dayArg || '').toLowerCase().trim();
    const want = /^\d{4}-\d{2}-\d{2}$/.test(da) ? da : da === 'yesterday' ? dAdd(today, -1) : da === 'today' ? today : da ? dateIn(da).d || null : null;
    let D = null;
    if (want) { D = days.find(d => d.day === want); if (!D) return { error: `The app has no saved picks for ${fmtD(want)}. Days kept: ${days.slice(-10).map(d => fmtD(d.day)).join(', ')}.` }; }
    else D = [...days].reverse().find(d => d.parlays.some(P => P && (P.result === 'won' || P.result === 'lost'))) || days[days.length - 1];
    const pool = D.parlays.filter(P => P && Array.isArray(P.legs) && P.legs.length);
    let P = null;
    const tw = nmOf(String(titleArg || '').replace(/\bsgp\b/gi, 'same game').replace(/\bprops?\b/gi, 'props')).split(' ').filter(w => w.length >= 2 && !/^(the|a|my|your|parlay|parlays|pick|picks|legs?|leg|of|and|app|yesterday|today|s)$/.test(w));
    if (tw.length) { let best = 0; for (const x of pool) { const hay = ' ' + nmOf(`${recTitle(x)} ${REC_TYPE(String(x.id))} ${x.id}`) + ' '; const s = tw.filter(w => hay.includes(' ' + w)).length; if (s > best) { best = s; P = x; } } }
    if (!P) { const picks = pool.filter(x => x.tab === 'picks'), L = picks.length ? picks : pool, lost = L.filter(x => x.result === 'lost'); P = lost.length ? lost.slice().sort((a, b) => missN(a) - missN(b) || (+b.p || 0) - (+a.p || 0))[0] : L.find(x => x.result === 'won') || L[0]; }
    return { D, P, pool };
  }
  function daySummary(D) {
    const L = (D.parlays || []).filter(P => P && P.tab === 'picks' && Array.isArray(P.legs));
    return L.map(P => { const miss = P.legs.filter(x => x && x.res === false); return `${recTitle(P)}: ${P.result === 'won' ? 'hit' : P.result === 'lost' ? `missed (${miss.length} of ${P.legs.length} legs: ${miss.slice(0, 3).map(x => `${String(x.label).slice(0, 50)}${x.actual != null ? ` (${String(x.actual).slice(0, 30)})` : ''}`).join('; ')}${miss.length > 3 ? '; …' : ''})` : 'not graded yet'}${num(+P.p) && +P.p > 0 ? `, ${pc(+P.p)} before` : ''}`; });
  }
  // a team this season: results from season.json (soccer teams ESPN doesn't cover: the feed's finished games), researched form,
  // trends vs prices, injuries, the next game, headlines
  function teamData(sp, ab, name, eab, fab) {
    if (eab === undefined) eab = ab;
    let R = eab ? resRows(sp, eab) : [], src = 'ESPN results this season';
    if (!R.length && sp === 'soccer' && fab) { R = (SB.DATA.games || []).filter(g => g.sport === 'soccer' && SB.isFinal(g) && (g.home.abbr === fab || g.away.abbr === fab)).map(g => { const h = g.home.abbr === fab; return { d: new Date(SB.startMs(g)).toISOString().slice(0, 10), opp: h ? g.away.abbr : g.home.abbr, home: h, pf: +(h ? g.score.home : g.score.away), pa: +(h ? g.score.away : g.score.home) }; }).sort((a, b) => a.d.localeCompare(b.d)); src = 'the feed\'s finished games (the last few days only)'; }
    const recOf = rs => { const w = rs.filter(x => x.pf > x.pa).length, l = rs.filter(x => x.pf < x.pa).length, d = rs.length - w - l; return sp === 'soccer' ? `${w}-${d}-${l}` : d ? `${w}-${l}-${d}` : `${w}-${l}`; };
    let streak = ''; if (R.length) { const k = wlOf(R[R.length - 1]); let n = 0; for (let i = R.length - 1; i >= 0 && wlOf(R[i]) === k; i--) n++; streak = `${k}${n}`; }
    const home = R.filter(x => x.home), away = R.filter(x => !x.home);
    let nx = eab ? nextGameOf(sp, eab) : null;
    if (!nx && fab) for (const g of SB.DATA.games || []) if (g.sport === sp && SB.openG(g) && !SB.isVoid(g) && (g.home.abbr === fab || g.away.abbr === fab) && (!nx || SB.startMs(g) < SB.startMs(nx.g))) nx = { g, home: g.home.abbr === fab };
    let nxp = null; if (nx && SB.priced(nx.g)) { const v = SB.p1(nx.g, nx.home ? 'H' : 'A'); if (num(v) && v > 0) nxp = v; }
    return { sp, ab, name, R, src, rec: recOf(R), home: recOf(home), away: recOf(away), nh: home.length, na: away.length, pf: R.length ? mean(R.map(x => x.pf)) : null, pa: R.length ? mean(R.map(x => x.pa)) : null,
      last10: R.slice(-10), streak, form: formOf(sp, name), tr: trendsOf(sp, eab || ab, name), inj: injuriesOfTeam(sp, eab || ab, name), nx, nxp, news: newsOfTeam(sp, eab || ab, name), al: eab ? allowedOf(sp, eab) : null };
  }
  const recNote = sp => (sp === 'soccer' ? 'W-D-L' : sp === 'nhl' ? 'W-L, overtime and shootouts counted as the final score' : 'W-L');
  function trendLines(T) {
    if (!T || !T.windows || !T.windows.season) return [];
    const s = T.windows.season, out = [], x = (o, w) => (o && o.n ? `${w}: won ${o.won} of ${o.n} (the prices expected ${f1(o.exp)})` : '');
    out.push(x(s.fav, 'As favourite'), x(s.dog, 'As underdog'));
    if (s.ln && s.ln.n) out.push(`Over the posted total in ${s.ln.hit} of ${s.ln.n} games (the prices expected ${f1(s.ln.exp)})`);
    else if (s.ov && s.ov.n) out.push(`Over 2.5 goals in ${s.ov.hit} of ${s.ov.n} games`);
    const nl = T.next && T.next.lean; if (nl) { for (const w of [].concat((nl.upset && nl.upset.flag && nl.upset.why) || [], (nl.total && nl.total.side && nl.total.why) || [])) if (typeof w === 'string') out.push(`Next game: ${w}`); }
    return out.filter(Boolean).slice(0, 5);
  }
  function formLines(F) {
    if (!F) return [];
    const out = [];
    if (F.record || F.position) out.push(`${F.record ? `Record ${F.record}` : ''}${F.position && F.of ? `${F.record ? ', ' : ''}${ord(+F.position)} of ${F.of}${F.league ? ` (${F.league})` : ''}` : ''}`);
    if (F.last5) out.push(`Last 5: ${F.last5}${F.winStreak ? ` · won ${F.winStreak} in a row` : F.lossStreak ? ` · lost ${F.lossStreak} in a row` : ''}${F.unbeaten >= 3 ? ` · unbeaten in ${F.unbeaten}` : ''}`);
    const beat = (Array.isArray(F.games) ? F.games : []).filter(g => g && g.result === 'W' && g.oppPos).slice(-3).map(g => `${g.opp} (${ord(+g.oppPos)})`);
    if (beat.length) out.push(`Recent wins over: ${beat.join(', ')}`);
    if (F.lastGame) out.push(`Last game: ${String(F.lastGame).slice(0, 90)}`);
    if (F.absences) out.push(`Absences: ${String(F.absences).slice(0, 220)}`);
    return out.slice(0, 5);
  }
  // league leaders from season totals (a traded pro counted once; college names repeat, so by team there)
  function leadersOf(sp, f, o) {
    const X = xOf(sp); if (!X || !hasF(sp, f)) return null; o = o || {};
    const by = new Map();
    for (const ps of X.m.values()) for (const p of ps) {
      const k = sp === 'ncaaf' ? E.nameKey(p.n) + '|' + p.t : E.nameKey(p.n); let e = by.get(k);
      if (!e) { e = { name: p.n, team: String(p.t || ''), pos: String(p.pos || ''), gp: 0, v: 0, last: '' }; by.set(k, e); }
      e.gp += +p.gp || 0; e.v += tv(sp, p.tot, f);
      const ld = Array.isArray(p.log) && p.log.length ? String(p.log[p.log.length - 1][0]) : ''; if (ld > e.last) { e.last = ld; e.team = String(p.t || ''); }
    }
    const tg = Object.values(X.results).map(r => (Array.isArray(r) ? r.length : 0)).filter(Boolean).sort((a, b) => a - b), med = tg.length ? tg[Math.floor(tg.length / 2)] : 10;
    const mg = num(+o.mg) && +o.mg >= 1 ? Math.round(+o.mg) : o.pg ? Math.max(2, Math.ceil(med / 2)) : 1, pos = o.pos ? POS(o.pos) : null;
    const pm = e => !pos || POS(e.pos) === pos || POS(e.pos).startsWith(pos + '-') || (sp === 'nhl' && pos === 'F' && ['C', 'LW', 'RW'].includes(POS(e.pos)));
    const L = [...by.values()].filter(e => e.gp >= mg && e.gp > 0 && pm(e)).map(e => ({ ...e, x: o.pg ? e.v / e.gp : e.v })).sort((a, b) => b.x - a.x || a.gp - b.gp || a.name.localeCompare(b.name));
    return { sp, f, pg: !!o.pg, mg, med, pos, rows: L.slice(0, clamp(Math.round(+o.n || 10), 1, 25)), total: L.length };
  }
  // how the app's recommended parlays did (graded parlays in the last N graded days), the legs that broke them, the lessons
  function trackOf(nDays, kind) {
    const R = recsD(); if (!R) return null;
    const days = R.days.filter(d => d && Array.isArray(d.parlays) && d.parlays.some(P => P && (P.result === 'won' || P.result === 'lost'))).slice(-clamp(Math.round(+nDays || 7), 1, 30));
    const kw = kind ? nmOf(String(kind)) : '', keep = P => !kw || (' ' + nmOf(`${REC_TYPE(String(P.id))} ${recTitle(P)} ${P.tab || ''}`) + ' ').includes(' ' + kw);
    const tally = new Map(), brk = new Map(); let w = 0, n = 0, exp = 0, legsN = 0, legsW = 0;
    for (const d of days) for (const P of d.parlays) {
      if (!P || (P.result !== 'won' && P.result !== 'lost') || !keep(P)) continue;
      const t = REC_TYPE(String(P.id)), x = tally.get(t) || { t, w: 0, n: 0, exp: 0 }; x.n++; n++; if (P.result === 'won') { x.w++; w++; } x.exp += +P.p || 0; exp += +P.p || 0; tally.set(t, x);
      for (const L of P.legs || []) { if (!L || (L.res !== true && L.res !== false)) continue; legsN++; if (L.res) legsW++; }
      if (P.result === 'lost') for (const k of new Set((P.legs || []).filter(L => L && L.res === false).map(L => { try { return E.legKind(L); } catch (e) { return 'other'; } }))) brk.set(k, (brk.get(k) || 0) + 1);
    }
    const LS = (() => { try { return (E.lessons() || []).filter(x => x && x.n >= 4); } catch (e) { return []; } })();
    return { days: days.map(d => d.day), tally: [...tally.values()].sort((a, b) => b.n - a.n), w, n, exp, legsN, legsW, brk: [...brk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), lessons: LS.slice(0, 6), kind: kind || '' };
  }

  // ---------------------------------------------------------------- the tools (Claude's page functions; the offline parser runs them too)
  const SPORTS = ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'];
  const spNorm = s => { s = String(s || '').toLowerCase(); return SPORTS.includes(s) ? s : sportOf(s); };
  function statNorm(s, e) {
    if (s == null || s === '') return null; const t = String(s).toLowerCase();
    if (ST_NAME[t]) return t;
    const x = statFrom(t); return x === 'yds' ? (e ? yardsFor(e) : 'recyd') : x;
  }
  // said: the viewer's own messages, set only when Claude calls the tools. A price or line Claude passes must come from them
  // (or, for a line, from the app's own lines), so a card never shows a number that only Claude wrote.
  function mkCtx(a, q, signal, said) {
    return {
      card(spec) { if (signal && signal.aborted) return; const sig = JSON.stringify(spec); if (a.cards.length >= 4 || a.cards.some(c => JSON.stringify(c) === sig)) return; a.cards.push(spec); },
      step(s) { if (signal && signal.aborted) return; a.step = s; paintMsg(a); },
      q, said,
    };
  }
  const PRICE_RX = /(?:^|[\s(@:,=])([+\-−–]\s?\d{3,5})(?![\d.])/g;
  const pricesIn = t => { const r = []; for (const m of String(t || '').toLowerCase().matchAll(PRICE_RX)) { const v = +m[1].replace(/[−–]/, '-').replace(/\s/g, ''); if (Math.abs(v) >= 100) r.push(v); } if (/\b(even money|evens)\b/i.test(t)) r.push(100); return r; };
  const amNum = s => { const v = +String(s).replace(/[−–]/, '-').replace(/\s/g, ''); return isFinite(v) ? v : NaN; };
  function priceSaid(ctx, price) { return !ctx || !ctx.said || ctx.said.some(t => pricesIn(t).includes(amNum(price))); }
  function lineSaid(ctx, line, stat) {
    if (!ctx || !ctx.said) return true;
    if (ctx.said.some(t => (String(t).match(/\d+(?:\.\d+)?/g) || []).some(n => Math.abs(+n - line) <= .5))) return true;
    if ((E.LADDER[stat] || []).some(t => Math.abs(t - .5 - line) < 1e-9)) return true;  // one of the app's own lines
    return ST.msgs.some(m => (m.cards || []).some(c => c.line === line || (c.items || []).some(x => x.line === line)));
  }
  const factorLine = f => `${f.name}: ${f.status}. ${f.why}`.slice(0, 260);
  function propResult(A) {
    const r = { player: A.e.name, team: A.team, position: A.pos || undefined, game: `${A.g.away.abbr} @ ${A.g.home.abbr}, ${SB.when(A.g)}`, market: A.market,
      model_chance: pc(A.p), fair_odds: A.fair, verdict: `${A.V.title} (model estimate)` };
    if (A.proj != null) r.model_average = `${f1(A.proj)} ${ST_NAME[A.stat]}${A.M && A.M.rf ? ' (season average with recent form counting 30%)' : ''}`;
    if (A.price) { r.your_price = amOf(A.price); r.implied_chance = pc(1 / A.price); r.edge = `${sg(A.V.edge)} percentage points`; }
    if (A.log) r.last_games = `${A.log.summary}: ${A.log.vals.map((v, i) => `${v}${A.log.labels[i] ? ' vs ' + A.log.labels[i] : ''}`).join(', ')}`;
    r.factors = A.factors.map(factorLine);
    if (A.notes.length) r.notes = A.notes;
    return r;
  }
  async function tFindPlayers(a) {
    await loadSeason();
    const q = String(a.query || '').trim(), sport = spNorm(a.sport); if (!q) return { error: 'Give a name to search for.' };
    const w = nmOf(q).split(' ').filter(Boolean), X = pIndex(), out = [];
    for (const e of X.list) { if (sport && e.sport !== sport) continue; if (w.every(x => (' ' + e.nm + ' ').includes(' ' + x) || e.nm.split(' ').some(t => t.startsWith(x)))) out.push(e); }
    const rows = out.sort((x, y) => x.start - y.start).slice(0, 8).map(e => { const g = SB.gameById(e.gid); return { name: e.name, team: e.team, position: e.pos || undefined, sport: SPN[e.sport], game: g ? `${g.away.abbr} @ ${g.home.abbr}, ${SB.when(g)}` : undefined,
      markets: [...Object.keys(e.stats).map(s => `${ST_NAME[s]} (season avg ${f1(e.stats[s].avg)})`), ...(e.td ? ['anytime TD'] : [])] }; });
    if (rows.length < 3) { const s = seasonByName(q, sport); if (s && !rows.some(r => E.nameKey(r.name) === E.nameKey(s.p.n))) rows.push({ name: s.p.n, team: s.p.t, position: s.p.pos, sport: SPN[s.sp], game: 'no game on the app\'s slate', markets: [] }); }
    return rows.length ? { players: rows } : { error: `No player matching "${q}" on the app's slate.` };
  }
  async function tPropReport(a, ctx) {
    await loadSeason();
    const who = String(a.player || '').trim(); if (!who) return { error: 'Say which player.' };
    const r = resolvePlayer(who, spNorm(a.sport));
    if (!r) return { error: `No player named "${who}" on the app's slate. Try find_players.` };
    if (!r.e) { const s = r.s; return { error: `${s.p.n} (${s.p.t}, ${SPN[s.sp]}) has no game with a model line on the app's slate, so there is no chance to give. Season box scores: ${s.p.gp} games.` }; }
    const e = r.e; let stat = statNorm(a.stat, e);
    if (stat === 'td' && !e.td) return { error: `The app has no anytime-TD model for ${e.name}${e.sport === 'ncaaf' ? ' (college players have yards and catches only)' : ''}.` };
    if (!stat) stat = pickStat(e, '', '', a.line != null).stat;
    if (stat !== 'td' && !e.stats[stat]) return { error: `The app has no ${ST_NAME[stat] || String(a.stat)} line for ${e.name}. It has: ${[...Object.keys(e.stats).map(s => ST_NAME[s]), ...(e.td ? ['anytime TD'] : [])].join(', ') || 'nothing'}.` };
    let line = a.line != null && a.line !== '' && isFinite(+a.line) && +a.line > 0 ? +a.line : null;
    const under = String(a.side || '').toLowerCase() === 'under';
    let price = a.price != null && String(a.price).trim() ? String(a.price).trim() : null;
    const dropped = [];
    if (price != null && !priceSaid(ctx, price)) { dropped.push(`price ${price} ignored: the viewer did not give it, so there is no edge read`); price = null; }
    if (line != null && stat !== 'td' && !lineSaid(ctx, line, stat)) { dropped.push(`line ${line} ignored: not from the viewer or the app, so the app's own line is used`); line = null; }
    const spec = { t: 'prop', k: e.k, gid: stat === 'td' ? e.td.gid : e.gid, stat, line, under, price, name: e.name, mk: marketOf(stat, line == null ? 0 : line, under) };
    if (ctx) ctx.step(`Pricing ${e.name} · ${stat === 'td' ? 'anytime TD' : ST_NAME[stat]}`);
    const A = analyzeProp(spec);
    if (!A.ok) return { error: A.why };
    spec.line = stat === 'td' ? null : A.line; spec.mk = A.market; if (A.defaulted && stat !== 'td') spec.dl = 1;
    if (ctx) ctx.card(spec);
    const res = propResult(A);
    if (dropped.length) res.ignored = dropped;
    return res;
  }
  async function tGameReport(a, ctx) {
    await loadSeason();
    const q = String(a.query || a.team || '').trim(); if (!q) return { error: 'Say which team or game.' };
    const gs = matchGames(q); if (!gs.length) return { error: `No game on the app's slate (next 8 days) matches "${q}".` };
    const g = gs[0]; if (ctx) ctx.step(`Reading ${g.away.abbr} @ ${g.home.abbr}`);
    const G = analyzeGame(g.id); if (!G.ok) return { error: G.why };
    if (ctx) ctx.card({ t: 'game', gid: g.id, label: `${g.away.abbr} @ ${g.home.abbr}` });
    const r = { game: `${g.away.name} @ ${g.home.name}`, league: g.comp, start: SB.when(g) };
    if (G.pr) { r.win_chance = { [g.home.name]: pc(G.pH), [g.away.name]: pc(G.pA) }; if (G.pD != null) r.win_chance.draw = pc(G.pD); }
    else r.note = 'The feed has no price for this game yet, so win chances are unknown.';
    if (G.spread) r.model_spread = G.spread; if (G.total) r.model_total = G.total; if (G.xg) r.expected_goals = G.xg;
    r.key_props = G.props.map(x => `${x.e.name}: ${marketOf(x.stat, x.line, false)}, ${pc(x.p)} (fair ${U.fair(x.p)})`);
    return r;
  }
  async function tBuildParlay(a, ctx) {
    const n = clamp(Math.round(+a.legs || 3), 2, 10), sport = spNorm(a.sport);
    const risk = ['safe', 'balanced', 'risky'].includes(String(a.risk)) ? String(a.risk) : 'balanced';
    const R = { safe: { minP: .72 }, balanced: { minP: .6, target: .7 }, risky: { minP: .35, target: .5 } }[risk];
    const sports = sport ? [sport] : SPORTS;
    if (ctx) ctx.step(`Building a ${n}-leg ${sport ? SPN[sport] + ' ' : ''}parlay`);
    let gids = null;
    if (/tonight|today/.test(String(a.when || ''))) { const d = E.dayOf(Date.now()); gids = SB.DATA.games.filter(g => SB.openG(g) && sports.includes(g.sport) && E.dayOf(SB.startMs(g)) === d).map(g => g.id); if (!gids.length) gids = null; }
    const base = { n, sports, minP: R.minP, target: R.target, perPlayer: 1, propsOnly: sport === 'nba' };
    let T = E.buildTicket({ ...base, perGame: 1, gids });
    if (T.legs.length < n) T = E.buildTicket({ ...base, perGame: 2, gids });
    if (T.legs.length < n && gids) T = E.buildTicket({ ...base, perGame: 2 });
    if (!T.legs.length) return { error: `No ${sport ? SPN[sport] + ' ' : ''}legs qualify on the app's slate right now.` };
    const title = `${T.legs.length}-leg ${sport ? SPN[sport] : 'mixed'} parlay`;
    if (ctx) ctx.card({ t: 'parlay', title, legs: T.legs.map(L => ({ gid: L.gid, key: L.key, label: L.label })), sub: risk });
    const pr = SB.parlayProb(T.legs);
    return { title, risk, legs: T.legs.map(L => { const g = SB.gameById(L.gid); return `${L.label} (${g.away.abbr} @ ${g.home.abbr}): ${pc(L.p)}`; }), joint_chance: pc(pr.p), if_unrelated: pc(pr.indep), fair_odds: U.fair(pr.p),
      note: T.legs.length < n ? `Only ${T.legs.length} legs qualified.` : 'Same-game legs are priced together from the game simulations.' };
  }
  function resolveLeg(x, ctx) {
    x = x || {};
    if (x.player) {
      const r = resolvePlayer(String(x.player)); if (!r || !r.e) return { error: `No slate player "${x.player}".` };
      const e = r.e; let stat = statNorm(x.stat, e) || pickStat(e, '', '', x.line != null).stat;
      if (stat === 'td' && !e.td) stat = pickStat(e, '', '', true).stat;
      if (!stat || (stat !== 'td' && !e.stats[stat])) return { error: `No ${ST_NAME[stat] || 'model'} line for ${e.name}.` };
      let line = x.line != null && x.line !== '' && +x.line > 0 ? +x.line : null;
      if (line != null && stat !== 'td' && !lineSaid(ctx, line, stat)) line = null;  // a line only Claude named: the app's own line instead
      const A = analyzeProp({ t: 'prop', k: e.k, stat, line, under: String(x.side || '').toLowerCase() === 'under', name: e.name });
      if (!A.ok) return { error: A.why };
      return { gid: A.g.id, key: A.key, label: `${e.name} ${A.market}`, p: A.p, sport: A.sp };
    }
    if (x.team) {
      const gs = matchGames(String(x.team)); if (!gs.length) return { error: `No game for "${x.team}".` };
      const g = gs[0]; if (!SB.priced(g)) return { error: `No price for ${g.away.abbr} @ ${g.home.abbr} yet.` };
      const res = String(x.result || 'win').toLowerCase();
      const raw = String(x.team), qn = ' ' + norm(raw) + ' ', hH = teamHit(g.home, qn, raw), isHome = hH > 0 && hH >= teamHit(g.away, qn, raw);
      const key = res === 'draw' ? 'D' : isHome ? 'H' : 'A';
      if (key === 'D' && g.sport !== 'soccer') return { error: 'Draws are priced for soccer only.' };
      return { gid: g.id, key, label: key === 'D' ? `${g.home.abbr}–${g.away.abbr} draw` : `${(key === 'H' ? g.home : g.away).name} to win`, p: SB.p1(g, key), sport: g.sport };
    }
    return { error: 'Each leg needs a player (with a stat) or a team.' };
  }
  async function tPriceParlay(a, ctx) {
    await loadSeason();
    const raw = Array.isArray(a.legs) ? a.legs.slice(0, 12) : [];
    if (ctx) ctx.step(`Pricing ${raw.length} legs together`);
    const legs = [], miss = [];
    for (const x of raw) { const r = resolveLeg(x, ctx); if (r.error) miss.push(r.error); else if (!legs.some(L => L.gid === r.gid && L.key === r.key)) legs.push(r); }
    if (!legs.length) return { error: `None of those legs matched a bet on the app's slate. ${miss.join(' ')}`.trim() };
    const title = `Your ${legs.length}-leg parlay`;
    if (ctx) ctx.card({ t: 'parlay', title, legs: legs.map(L => ({ gid: L.gid, key: L.key, label: L.label })), sub: 'yours' });
    const pr = SB.parlayProb(legs);
    const r = { title, legs: legs.map(L => `${L.label}: ${pc(L.p)}`), joint_chance: pc(pr.p), if_unrelated: pc(pr.indep), fair_odds: U.fair(pr.p) };
    if (miss.length) r.unmatched = miss;
    return r;
  }
  async function tTopProps(a, ctx) {
    await loadSeason();
    const sport = spNorm(a.sport), n = clamp(Math.round(+a.n || 5), 1, 10), stat = a.stat ? statNorm(a.stat) : null;
    if (ctx) ctx.step(`Ranking ${sport ? SPN[sport] + ' ' : ''}props`);
    const X = pIndex(), now = Date.now(), today = E.dayOf(now), C = [];
    for (const e of X.list) {
      if (sport && e.sport !== sport) continue;
      const g = SB.gameById(e.gid); if (!g) continue;
      for (const [st, pl] of Object.entries(e.stats)) {
        if ((stat && st !== stat) || pl.status !== 'active') continue;
        let b = null; for (const t of E.LADDER[st] || []) { const p = E.playerP(pl, t); if (p >= .65 && p <= .9) b = { t, p }; }
        if (b) C.push({ e, g, stat: st, line: b.t - .5, p: b.p, score: b.p + (E.STAT_PREF[st] || 0) });
      }
      if (e.td && (!stat || stat === 'td')) { const gt = SB.gameById(e.td.gid), p = gt ? SB.p1(gt, e.td.key) : 0; if (p >= .45) C.push({ e, g: gt, stat: 'td', line: .5, p, score: p - .1 }); }
    }
    const tonight = C.filter(x => E.dayOf(SB.startMs(x.g)) === today), soon = C.filter(x => SB.startMs(x.g) - now < 36 * 3600e3);
    const wk = String(a.when || '') === 'week', pool = !wk && tonight.length >= n ? tonight : !wk && soon.length >= n ? soon : C;
    const label = pool === tonight ? 'tonight' : pool === soon ? 'in the next 36 hours' : 'this week';
    // recent hit rate (box scores) breaks near-ties among the best 30
    const top = pool.sort((x, y) => y.score - x.score).slice(0, 30);
    for (const x of top) { const sea = SEASON ? seasonOf(x.g.sport, x.e.name, x.e.team, x.g) : null; if (!sea) continue; let rows = x.g.sport === 'nba' ? sea.rows.filter(r => (val(sea.S, r, 'min') || 0) > 0) : sea.rows; rows = rows.slice(-5); if (!rows.length) continue;
      const h = rows.filter(r => (x.stat === 'td' ? sumF(sea.S, r, ['rtd', 'ctd']) >= 1 : (val(sea.S, r, x.stat) || 0) > x.line)).length; x.score += .05 * (h / rows.length - .5); }
    const seen = new Set(), pick = top.sort((x, y) => y.score - x.score).filter(x => (seen.has(x.e.k) ? false : seen.add(x.e.k))).slice(0, n);
    if (!pick.length) return { error: `No ${sport ? SPN[sport] + ' ' : ''}props on the app's slate clear a 65% model chance right now.` };
    const items = pick.map(x => ({ t: 'prop', k: x.e.k, gid: x.stat === 'td' ? x.e.td.gid : x.e.gid, stat: x.stat, line: x.stat === 'td' ? null : x.line, under: false, name: x.e.name, mk: marketOf(x.stat, x.line, false) }));
    const title = `Top ${items.length} ${sport ? SPN[sport] + ' ' : ''}props ${label}`;
    if (ctx) ctx.card({ t: 'list', title, items });
    return { title, ranked_by: 'model chance at the highest ladder line with a 65%+ chance; points legs get a small preference (the owner\'s rule) and recent box scores break near-ties. The app has no sportsbook prop prices, so there is no edge figure.',
      props: pick.map(x => `${x.e.name} (${x.e.team}) ${marketOf(x.stat, x.line, false)}: ${pc(x.p)}, fair ${U.fair(x.p)}`) };
  }
  async function tStartSit(a, ctx) {
    await loadSeason();
    const names = (Array.isArray(a.players) ? a.players : String(a.players || '').split(/,| or | vs\.? /i)).map(s => String(s).trim()).filter(Boolean).slice(0, 4);
    if (!names.length) return { error: 'Name the players to compare.' };
    if (ctx) ctx.step(`Comparing ${names.join(' and ')}`);
    const R = analyzeSS(names);
    if (!R.ok.length) return { error: R.rows.map(r => r.why).join(' ') };
    if (ctx) ctx.card({ t: 'ss', names: R.ok.map(r => r.name) });
    return { verdict: R.V ? `${R.V.title} (model estimate)` : undefined, method: 'Projection = 70% season PPR points a game + 30% last 3 games, nudged by the team\'s expected points when the game is priced. No turnover data.',
      players: R.rows.map(r => (r.ok ? `${r.name} (${r.team} ${r.pos}): projection ${f1(r.proj)} PPR; season ${f1(r.seasonPPR)} a game in ${r.gp}; last 3 ${f1(r.last3)}${r.tdp ? `; anytime TD ${pc(r.tdp)}` : ''}${r.g ? `; next game ${r.g.away.abbr} @ ${r.g.home.abbr} ${SB.when(r.g)}` : '; no game found this week'}` : r.why)) };
  }
  // ---- breakdown tools: any player or team this season, one game, a parlay, leaders, the app's track record
  const NOSEASON = { error: 'This season\'s box scores (season.json) did not load, so the app has no player or team stats to give right now.' };
  const notFound = who => ({ error: `No player named "${who}" in this season's box scores. The app covers ${COVER}.` });
  const pTeam = P => { const n = teamName(P.sp, P.team); return n && n !== P.team ? `${n} (${P.team})` : P.team; };
  const FAPP = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'rec', ryd: 'ryd', recyd: 'recyd', pyd: 'pyd', sog: 'sog', sot: 'sot', hpts: 'hpts' };
  const POSW = [[/^(qb|quarterbacks?)$/, 'QB'], [/^(rb|running ?backs?|backs?)$/, 'RB'], [/^(wr|wide ?receivers?|receivers?)$/, 'WR'], [/^(te|tight ?ends?)$/, 'TE'], [/^(g|guards?)$/, 'G'], [/^(f|forwards?)$/, 'F'], [/^(c|centers?|centres?)$/, 'C'], [/^(d|defensem[ae]n)$/, 'D'], [/^(lw|left wings?)$/, 'LW'], [/^(rw|right wings?)$/, 'RW']];
  const posNorm = s => { const t = norm(s); if (!t) return null; const x = POSW.find(([rx]) => rx.test(t)); return x ? x[1] : t.length <= 4 ? t.toUpperCase() : null; };
  const lineTxt = x => `${marketOf(x.st, x.line, false)}: ${pc(x.p)} (fair ${U.fair(x.p)}), model estimate`;
  function psResult(D, notes, R) {
    const P = D.P, sp = P.sp, F = D.F, r = { player: P.name, team: pTeam(P), sport: SPN[sp], position: P.pos || undefined, games_this_season: P.gp };
    r.per_game = Object.fromEntries(D.per.map(([f, v]) => [SF[f], num(v) ? +v.toFixed(1) : null]));
    r.season_totals = Object.fromEntries(F.map(f => [SF[f], tv(sp, P.tot, f)]));
    r[`last_${D.last.length}_games${D.filt.length ? ' (' + D.filt.join(', ') + ')' : ''}`] = D.last.map(x => `${fmtD(x.r.d)} ${oppLbl(x.r)}: ${statLine(P, x.r, F)}${x.res ? ` · ${P.team} ${wlOf(x.res)} ${x.res.pf}-${x.res.pa}` : ''}`).reverse();
    const s = D.split, m = SF[D.mf], sv = o => (num(o.v) ? `${f1(o.v)} ${m} a game in ${o.n} logged games` : 'no games');
    r.splits = { home: sv(s.home), away: sv(s.away), last_5_vs_season: num(s.l5.v) ? `${f1(s.l5.v)} vs ${f1(pgOf(P, D.mf))} ${m} a game (5 games is a small sample)` : undefined };
    if (s.sel) r.splits[s.sel.lbl] = sv(s.sel);
    r.next_game = D.nx ? `${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr}, ${SB.when(D.nx.g)}` : 'none on the app\'s slate (next 8 days)';
    if (D.lines.length) r.app_lines_next_game = D.lines.map(lineTxt);
    r.injury_report = D.inj ? `${D.inj.status}${D.inj.injury ? ` (${D.inj.injury})` : ''}${D.inj.updated ? `, updated ${fmtD(D.inj.updated)}` : ''}` : 'not on the app\'s injury report';
    if (D.news.length) r.headlines = D.news.map(x => `${fmtD(x.d)}: ${x.h}`);
    const nt = notes.slice();
    if (P.trunc) nt.push(`Splits and the game log use his last ${P.rows.length} logged games (the file keeps the last 15 for the ${SPN[sp]}); season numbers cover all ${P.gp}.`);
    if (P.gp < 10) nt.push(`${P.gp} games is a small sample.`);
    if ((sp === 'nfl' || sp === 'ncaaf') && F.includes('td')) nt.push('Touchdowns here are rushing + receiving.');
    if (R && R.others && R.others.length) nt.push(`Also matching that name: ${R.others.map(c => `${c.p.n} (${c.p.t}, ${SPN[c.sp]})`).join(', ')}.`);
    nt.push(`Source: ESPN box scores. ${UTCNOTE}`);
    r.notes = nt;
    return r;
  }
  async function tPlayerStats(a, ctx) {
    await loadSeason(); if (!SEASON) return NOSEASON; await loadSides();
    const who = String(a.player || '').trim().slice(0, 80); if (!who) return { error: 'Say which player.' };
    const R = seasonFind(who, spNorm(a.sport), a.team ? String(a.team).toUpperCase() : null); if (!R) return notFound(who);
    const P = seasonPlayer(R.sp, R.p); if (!P.gp && !P.rows.length) return { error: `${P.name} has no games in this season's box scores yet.` };
    const notes = []; let opp = null;
    if (a.opponent) { const T = findTeam(String(a.opponent).slice(0, 60), P.sp); if (T && T.eab) opp = T.eab; else notes.push(`No ${SPN[P.sp]} team matching "${String(a.opponent).slice(0, 40)}", so every game is shown.`); }
    const venue = ['home', 'away'].includes(String(a.venue || '').toLowerCase()) ? String(a.venue).toLowerCase() : null;
    const st = a.stat ? sfNorm(a.stat, P.sp, P.pos) : null;
    if (ctx) ctx.step(`Reading ${P.name}'s box scores`);
    const D = playerData(P, { n: a.last, opp, venue, st });
    if (ctx) ctx.card({ t: 'pstat', sp: P.sp, n: P.name, tm: P.team, last: D.n, opp: opp || undefined, venue: venue || undefined, st: st || undefined });
    return psResult(D, notes, R);
  }
  function rvResult(V, S, extra) {
    const P = V.P, sp = P.sp, row = V.row, F = showF(sp, P.pos), r = { player: P.name, team: pTeam(P), game: `${fmtD(row.d)} ${oppLbl(row)} (UTC date)` };
    if (V.res) { r.final_score = resTxt(V.res, P.team); if (V.scr && V.scr.k !== 'draw') r.margin = V.scr.txt; }
    r.what_happened = `${fN(V.v)} ${unitOf(V.f, V.v)} (${statLine(P, row, F)})${V.line != null ? ` vs ${S.src === 'app' ? 'the app\'s' : 'a'} line of ${V.under ? 'under ' : ''}${fmtLine(V.line)}` : num(V.ao) ? ` vs his average of ${f1(V.ao)} in his other ${V.others} games` : ''}`;
    r.result = V.verdict === 'none' ? 'no line given: compared with his average' : V.verdict;
    r.how_close = V.closeTxt || undefined;
    r.why_facts = V.facts; r.why_possibilities = V.maybe;
    r.pre_game = S.p ? `The app gave this leg ${pc(S.p)} before the game (model estimate) in ${S.recT}.` : 'The app did not price this leg before the game (no saved pick for it).';
    const says = [];
    if (S.p && V.verdict === 'miss') says.push(`A ${pc(S.p)} leg misses ${freqW(1 - S.p)}, so one miss says little about the model.`);
    if (S.p && V.verdict === 'hit') says.push(`A ${pc(S.p)} leg hits ${freqW(S.p)}.`);
    says.push('One game is a small sample: look at his recent games and season numbers before drawing a conclusion.');
    r.what_it_says = says;
    if (P.trunc) r.note = `The file keeps his last ${P.rows.length} games for the ${SPN[sp]}; season averages cover all ${P.gp}.`;
    return Object.assign(r, extra || {});
  }
  async function tReviewPlayer(a, ctx) {
    await loadSeason(); if (!SEASON) return NOSEASON;
    const who = String(a.player || '').trim().slice(0, 80); if (!who) return { error: 'Say which player.' };
    const R = seasonFind(who, spNorm(a.sport)); if (!R) return notFound(who);
    const P = seasonPlayer(R.sp, R.p), extra = {}, ign = [];
    const dt = a.date ? dateIn(String(a.date)) : {};
    let opp = null; if (a.opponent) { const T = findTeam(String(a.opponent).slice(0, 60), P.sp); if (T && T.eab) opp = T.eab; }
    const st = a.stat ? sfNorm(a.stat, P.sp, P.pos) : null;
    if (a.stat && !st) extra.note_stat = `The box scores have no "${String(a.stat).slice(0, 30)}" for ${SPN[P.sp]}; this is his ${SF[mainF(P)]}.`;
    let line = a.line != null && a.line !== '' && isFinite(+a.line) && +a.line >= 0 ? +a.line : null;
    if (line != null && !lineSaid(ctx, line, FAPP[st] || st)) { ign.push(`line ${line} ignored: the viewer did not give it, so the app's own line (or his average) is used`); line = null; }
    const side = String(a.side || '').toLowerCase(), under = side === 'under' ? true : side === 'over' ? false : undefined;
    const S = reviewSpec(P, { st, line, under, d: dt.d, exact: !a._us, opp, lineSrc: 'you' });  // _us: a US date the viewer typed (offline parser)
    if (S.i < 0) return { error: `${P.name} has no game ${dt.d ? `on ${fmtD(dt.d)} ` : ''}${opp ? `vs ${opp} ` : ''}in this season's logged box scores${P.trunc ? ` (the file keeps his last ${P.rows.length} games)` : ''}.` };
    if (ctx) ctx.step(`Reviewing ${P.name}, ${fmtD(P.rows[S.i].d)}`);
    const V = reviewOf(P, S.i, S.f, S.line, S.under);
    if (ctx) ctx.card({ t: 'prev', sp: P.sp, n: P.name, tm: P.team, d: V.row.d, st: S.f, line: S.line == null ? undefined : S.line, under: S.under || undefined, src: S.src || undefined });
    if (ign.length) extra.ignored = ign;
    return rvResult(V, S, extra);
  }
  const ICO = { hit: '✓', miss: '✗', push: '=', pending: '•', unknown: '?' };
  function prResult(V, extra) {
    const r = { parlay: V.title, day: V.day ? fmtD(V.day) : undefined, result: V.status === 'miss' ? `missed: ${V.miss.length} of ${V.legs.length} legs` : V.status === 'hit' ? `hit: all ${V.legs.length} legs` : `not finished: ${V.hit.length} of ${V.legs.length} legs hit so far, ${V.pend.length} to grade` };
    r.legs = V.legs.map(G => `${ICO[G.status] || '?'} ${G.label}: ${G.actual || '—'}${G.detail ? ` (${G.detail})` : ''}${num(G.p) ? `; ${pc(G.p)} before the game` : ''}`);
    if (V.miss.length) r.broke_it = V.miss.map(G => G.label);
    const why = V.miss.filter(G => G.V).slice(0, 3).map(G => `${G.label}: ${[...G.V.facts.slice(0, 2), ...G.V.maybe.slice(0, 1).map(x => 'Possibility: ' + x)].join(' ')}`);
    if (why.length) r.why_they_missed = why;
    if (V.near.length) r.near_misses = V.near.map(G => `${G.label}: ${G.detail}`);
    if (V.barely.length) r.barely_hit = V.barely.map(G => `${G.label}: ${G.detail}`);
    if (V.links.length) r.linked_legs = V.links.map(x => x.txt);
    if (V.lessons.length) r.track_record_for_these_kinds_of_legs = V.lessons.map(x => x.txt);
    r.what_it_says = V.says;
    r.notes = [`Player legs from ESPN box scores, game legs from final scores. ${UTCNOTE}`];
    return Object.assign(r, extra || {});
  }
  const cleanLegs = (legs, ctx, ign) => (Array.isArray(legs) ? legs : []).slice(0, 12).map(x => {
    x = x && typeof x === 'object' ? x : {}; const s = v => (v == null || v === '' ? undefined : String(v).slice(0, 60));
    const o = x.player ? { player: s(x.player), stat: s(x.stat), side: /under/i.test(String(x.side || '')) ? 'under' : undefined } : x.team ? { team: s(x.team), market: ['win', 'cover', 'over', 'under'].includes(String(x.market)) ? String(x.market) : 'win' } : null;
    if (!o) return null;
    if (x.date) o.date = s(x.date); if (x.sport) o.sport = s(x.sport);
    if (x.line != null && x.line !== '' && isFinite(+x.line)) { const ln = +x.line; if (lineSaid(ctx, Math.abs(ln), FAPP[String(x.stat || '')] || '')) o.line = ln; else ign.push(`line ${ln} for ${o.player || o.team} ignored: the viewer did not give it`); }
    return o;
  }).filter(Boolean);
  async function tReviewParlay(a, ctx) {
    await loadSeason(); if (!SEASON) return NOSEASON;
    const src = ['picks', 'saved', 'legs'].includes(String(a.source)) ? String(a.source) : Array.isArray(a.legs) && a.legs.length ? 'legs' : 'picks';
    let spec = null; const extra = {}, ign = [];
    if (src === 'picks') {
      const X = pickRecP(a.day, a.title); if (X.error) return { error: X.error };
      spec = { t: 'prv', src, day: X.D.day, id: String(X.P.id) };
      if (!a.title) extra.that_day = daySummary(X.D);
    } else if (src === 'saved') {
      const S = (SB.savedParlays || []).filter(s => s && Array.isArray(s.legs) && s.legs.length).sort((x, y) => (+y.at || 0) - (+x.at || 0));
      if (!S.length) return { error: 'The viewer has no saved parlays in My Parlays on this device. They can type the legs instead (source "legs").' };
      let s = S[0]; const t = String(a.title || '').trim();
      if (/^\d+$/.test(t)) s = S[clamp(+t, 1, S.length) - 1];
      else if (t) { const tw = nmOf(t).split(' ').filter(w => w.length >= 3 && !/^(parlay|last|latest|saved|my)$/.test(w)); const h = tw.length && S.find(x => { const hay = nmOf(x.legs.map(L => L && L.label).join(' ')); return tw.every(w => hay.includes(w)); }); if (h) s = h; }
      spec = { t: 'prv', src, at: +s.at };
      if (S.length > 1) extra.saved_parlays = `${S.length} saved; this is ${s === S[0] ? 'the most recent' : `number ${S.indexOf(s) + 1} (most recent first)`}`;
    } else {
      const legs = cleanLegs(a.legs, ctx, ign); if (!legs.length) return { error: 'Give the legs: each a player with a stat and line, or a team with win / cover / over / under.' };
      spec = { t: 'prv', src, legs };
    }
    if (ctx) ctx.step('Grading the parlay leg by leg');
    const V = parlayReview(spec); if (!V.ok) return { error: V.why };
    if (ctx) ctx.card(spec);
    if (ign.length) extra.ignored = ign;
    return prResult(V, extra);
  }
  function tmResult(D, T) {
    const r = { team: `${D.name}${D.name !== D.ab ? ` (${D.ab})` : ''}`, sport: SPN[D.sp] };
    if (D.R.length) {
      Object.assign(r, { record: `${D.rec} (${recNote(D.sp)})`, games: D.R.length, home: D.home, away: D.away, [`${PTW[D.sp]}_for_a_game`]: +f1(D.pf), [`${PTW[D.sp]}_against_a_game`]: +f1(D.pa), streak: D.streak });
      r.last_10 = D.last10.slice().reverse().map(x => `${fmtD(x.d)} ${x.home ? 'vs' : '@'} ${x.opp}: ${wlOf(x)} ${x.pf}-${x.pa}`);
      if (D.al) r.defence = `${ord(D.al.rank)} fewest ${PTW[D.sp]} allowed of ${D.al.of}`;
    } else r.record = 'no results in the app\'s data';
    const fl = formLines(D.form); if (fl.length) r.researched_form = [...fl, `(form.json, as of ${fmtD(String(D.form.asOf || '').slice(0, 10)) || 'unknown'})`];
    const tl = trendLines(D.tr); if (tl.length) r.trends = [...tl, 'Past patterns, not predictions; small samples.'];
    if (D.inj.length) r.injuries = D.inj.map(x => `${x.player}${x.pos ? ` (${x.pos})` : ''}: ${x.status}${x.injury ? `, ${x.injury}` : ''}`);
    r.next_game = D.nx ? `${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr}, ${SB.when(D.nx.g)}${D.nxp != null ? `; the app's win chance ${pc(D.nxp)} (model estimate)` : '; no price yet'}` : 'none on the app\'s slate (next 8 days)';
    if (D.news.length) r.headlines = D.news.map(x => `${fmtD(x.d)}: ${x.h}`);
    const nt = [`Results: ${D.src}. ${UTCNOTE}`]; if (T.amb && T.amb.length) nt.push(`Also matching: ${T.amb.map(t => `${t.name} (${SPN[t.sp]})`).join(', ')}.`);
    if (D.R.length && D.R.length < 10) nt.push(`${D.R.length} games is a small sample.`);
    r.notes = nt;
    return r;
  }
  async function tTeamReport(a, ctx) {
    await loadSeason(); if (!SEASON) return NOSEASON; await loadSides();
    const q = String(a.team || '').trim().slice(0, 80); if (!q) return { error: 'Say which team.' };
    const T = findTeam(q, spNorm(a.sport)); if (!T) return { error: `No team matching "${q}" in the app's data. The app covers ${COVER}.` };
    if (ctx) ctx.step(`Reading ${T.name}'s season`);
    const D = teamData(T.sp, T.ab, T.name, T.eab, T.fab);
    if (!D.R.length && !D.form && !D.nx) return { error: `The app has no results for ${T.name} this season.` };
    if (ctx) ctx.card({ t: 'team', sp: T.sp, ab: T.ab, name: T.name, eab: T.eab || undefined, fab: T.fab || undefined });
    return tmResult(D, T);
  }
  const leadTitle = L => `${SPN[L.sp]} ${L.pos ? L.pos + ' ' : ''}leaders · ${SF[L.f]}${L.pg ? ' a game' : ''}`;
  const leadRule = L => (L.pg ? `per game, at least ${L.mg} games played (half the typical team's ${L.med})` : `season totals${L.mg > 1 ? `, at least ${L.mg} games` : ''}`);
  async function tLeaders(a, ctx) {
    await loadSeason(); if (!SEASON) return NOSEASON;
    const sp = spNorm(a.sport); if (!sp) return { error: 'Say which sport: nfl, ncaaf, nba, nhl or soccer.' };
    const pos = a.position ? posNorm(a.position) : null, f = sfNorm(a.stat, sp, pos);
    if (!f) return { error: `The box scores have no "${String(a.stat || '').slice(0, 30)}" for ${SPN[sp]}. They have: ${Object.keys(SF).filter(k => hasF(sp, k)).map(k => SF[k]).join(', ')}.` };
    const L = leadersOf(sp, f, { pos, pg: a.per_game === true || a.per_game === 'true', n: a.n, mg: a.min_games });
    if (!L || !L.rows.length) return { error: `No ${SPN[sp]} players qualify${pos ? ` at ${pos}` : ''}.` };
    if (ctx) ctx.card({ t: 'lead', sp, st: f, pos: pos || undefined, pg: L.pg ? 1 : undefined, n: L.rows.length, mg: L.mg });
    return { title: leadTitle(L), rule: leadRule(L), leaders: L.rows.map((e, i) => `${i + 1}. ${e.name} (${e.team}${e.pos ? ' ' + e.pos : ''}): ${L.pg ? f1(e.x) : bigN(e.x)}${L.pg ? ' a game' : ''} in ${e.gp} games`),
      notes: [`From this season's ESPN box scores (${L.total} players qualify). A traded player is counted once with his latest team${sp === 'ncaaf' ? '; college players with the same name are kept apart by team' : ''}.`, ...(f === 'td' ? ['Touchdowns are rushing + receiving.'] : [])] };
  }
  async function tTrackRecord(a, ctx) {
    const T = trackOf(a.days, a.kind); if (!T) return { error: 'The app\'s graded picks (recs.json) aren\'t loaded on this page.' };
    if (!T.n) return { error: T.kind ? `No graded "${String(T.kind).slice(0, 30)}" parlays in the app's track record yet.` : 'No graded parlays yet: the first graded day shows the morning after.' };
    if (ctx) ctx.card({ t: 'track', days: clamp(Math.round(+a.days || 7), 1, 30), kind: T.kind ? String(T.kind).slice(0, 40) : undefined });
    return { span: `${T.days.length} graded day${T.days.length === 1 ? '' : 's'} (${fmtD(T.days[0])} to ${fmtD(T.days[T.days.length - 1])})`, parlays: `won ${T.w} of ${T.n}; the model expected ${f1(T.exp)}`, legs: `${T.legsW} of ${T.legsN} graded legs hit`,
      by_kind: T.tally.map(x => `${x.t}: won ${x.w} of ${x.n} (the model expected ${f1(x.exp)})`), legs_that_broke_parlays_most: T.brk.map(([k, c]) => `${k}: missed in ${c} lost parlay${c === 1 ? '' : 's'}`),
      lessons: T.lessons.map(x => `${x.k} legs: hit ${x.w} of ${x.n} (${pc(x.rate)}) vs ${pc(x.expRate)} the model expected${x.n < 10 ? ', a small sample' : ''}`),
      note: 'Long parlays lose most of the time even when priced right: compare the wins with what the model expected, over many days.' };
  }
  const TOOL_FN = { find_players: tFindPlayers, prop_report: tPropReport, game_report: tGameReport, build_parlay: tBuildParlay, price_parlay: tPriceParlay, top_props: tTopProps, start_sit: tStartSit,
    player_stats: tPlayerStats, review_player: tReviewPlayer, review_parlay: tReviewParlay, team_report: tTeamReport, leaders: tLeaders, track_record: tTrackRecord };
  const S_STAT = { type: 'string', description: 'points, rebounds, assists, receptions, rushing yards, receiving yards, passing yards, or anytime TD' };
  const TOOL_DEF = [
    ['find_players', 'Search the app\'s slate for players by name. Returns each match\'s team, next game and the markets the app models. Use it when a name is unclear.',
      { type: 'object', properties: { query: { type: 'string' }, sport: { type: 'string', enum: SPORTS } }, required: ['query'] }],
    ['prop_report', 'Price one player prop with the app\'s model: model chance, fair odds, projection, his recent games vs the line, four factors (matchup, trends, game script, usage) and a verdict. Pass the viewer\'s book price (American, like -110) to get the edge. Adds a prop card under your answer.',
      { type: 'object', properties: { player: { type: 'string' }, stat: S_STAT, line: { type: 'number', description: 'the book line, like 24.5; omit to use the app\'s line' }, side: { type: 'string', enum: ['over', 'under'] }, price: { type: 'string', description: 'American odds the viewer was offered, like -110 or +150' } }, required: ['player'] }],
    ['game_report', 'One game: win chances from the feed\'s price, the model spread and total, and key props. Query by team name or "Team A vs Team B". Adds a game card.',
      { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }],
    ['build_parlay', 'Build a parlay with the app\'s builder and price it jointly from its simulations (same-game legs priced together). Adds a parlay card with swap legs and a 500,000-run check.',
      { type: 'object', properties: { legs: { type: 'integer', minimum: 2, maximum: 10 }, sport: { type: 'string', enum: SPORTS }, risk: { type: 'string', enum: ['safe', 'balanced', 'risky'] }, when: { type: 'string', enum: ['tonight', 'week'] } }, required: ['legs'] }],
    ['price_parlay', 'Price the viewer\'s own legs together: each leg\'s chance, the joint chance and what it would be if the legs were unrelated. Adds a parlay card.',
      { type: 'object', properties: { legs: { type: 'array', maxItems: 12, items: { type: 'object', properties: { player: { type: 'string' }, stat: S_STAT, line: { type: 'number' }, side: { type: 'string', enum: ['over', 'under'] }, team: { type: 'string' }, result: { type: 'string', enum: ['win', 'draw'] } } } } }, required: ['legs'] }],
    ['top_props', 'The best props on the slate by model chance (no sportsbook prices, so no edge). Adds a list card.',
      { type: 'object', properties: { sport: { type: 'string', enum: SPORTS }, n: { type: 'integer', minimum: 1, maximum: 10 }, stat: S_STAT, when: { type: 'string', enum: ['tonight', 'week'] } } }],
    ['start_sit', 'Fantasy football start / sit: compares players\' projected PPR points (season, last 3 games, the game\'s price) and TD chances. Adds a comparison card.',
      { type: 'object', properties: { players: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, required: ['players'] }],
    ['player_stats', 'Any player in this season\'s ESPN box scores (NFL, college football, NBA, NHL, 5 soccer leagues), on the slate or not: team, position, games, season totals and per-game averages, his last N games (stat line + his team\'s result), splits (home / away, vs an opponent, last 5 vs season), his next game and the app\'s lines for it, injury report and recent headlines. Use it for any question about a player\'s season or recent games. Adds a player card.',
      { type: 'object', properties: { player: { type: 'string' }, sport: { type: 'string', enum: SPORTS }, last: { type: 'integer', minimum: 1, maximum: 15, description: 'how many recent games to list (default 5)' }, opponent: { type: 'string', description: 'only games vs this team' }, venue: { type: 'string', enum: ['home', 'away'] }, stat: { type: 'string', description: 'the stat to chart, e.g. rebounds, carries, shots on goal' } }, required: ['player'] }],
    ['review_player', 'What happened in one game for one player (default: his most recent): the stat vs the line (or vs his average when there is no line), hit or miss and by how much, minutes / targets / carries / shots vs his average, the final score and margin, and the app\'s pre-game chance when it priced that leg. Returns facts and possibilities separately. Adds a review card. Pass line only if the viewer typed it.',
      { type: 'object', properties: { player: { type: 'string' }, sport: { type: 'string', enum: SPORTS }, stat: { type: 'string', description: 'e.g. points, rebounds, rushing yards, receptions, shots on goal' }, line: { type: 'number' }, side: { type: 'string', enum: ['over', 'under'] }, date: { type: 'string', description: 'YYYY-MM-DD: the date as player_stats lists it (UTC), or the US date the viewer named' }, opponent: { type: 'string' } }, required: ['player'] }],
    ['review_parlay', 'Breaks a parlay down leg by leg: each leg\'s result from box scores and final scores, actual vs line and how close, the pre-game chances, which legs broke it, near misses, legs that worked for or against each other, and the app\'s track record for those kinds of legs. source: "picks" = the app\'s recommended parlays (graded each morning; give day and words of the title, e.g. "same game"), "saved" = the viewer\'s My Parlays (title "1" = most recent), "legs" = legs the viewer typed. Adds a parlay review card.',
      { type: 'object', properties: { source: { type: 'string', enum: ['picks', 'saved', 'legs'] }, day: { type: 'string', description: 'YYYY-MM-DD, "yesterday" or "today" (picks)' }, title: { type: 'string' },
        legs: { type: 'array', maxItems: 12, items: { type: 'object', properties: { player: { type: 'string' }, stat: { type: 'string' }, line: { type: 'number' }, side: { type: 'string', enum: ['over', 'under'] }, team: { type: 'string' }, market: { type: 'string', enum: ['win', 'cover', 'over', 'under'] }, date: { type: 'string' }, sport: { type: 'string', enum: SPORTS } } } } } }],
    ['team_report', 'A team this season: record, home / away, points (goals) for and against a game, the last 10 results with scores, researched form (last 5, streaks, table position, absences), trends vs the prices, injuries, the next game with the app\'s win chance, and recent headlines. Adds a team card.',
      { type: 'object', properties: { team: { type: 'string' }, sport: { type: 'string', enum: SPORTS } }, required: ['team'] }],
    ['leaders', 'League leaders for one stat from this season\'s box scores (season totals, or per game with a minimum-games rule that the result states), optionally by position (QB, RB, WR, TE; G, F, C; D). Adds a list card.',
      { type: 'object', properties: { sport: { type: 'string', enum: SPORTS }, stat: { type: 'string' }, position: { type: 'string' }, per_game: { type: 'boolean' }, n: { type: 'integer', minimum: 1, maximum: 25 }, min_games: { type: 'integer', minimum: 1 } }, required: ['sport', 'stat'] }],
    ['track_record', 'How the app\'s own recommended parlays did lately (graded each morning from final scores and box scores): wins by kind vs what the model expected, the kinds of legs that broke parlays most, and the lessons (each kind of leg\'s hit rate vs the model). Adds a card.',
      { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 }, kind: { type: 'string', description: 'e.g. same game, exact score, NBA props, underdogs, fantasy' } } }],
  ];
  // most useful first, so a view that allows fewer tools (limits().tools.maxCount) keeps the ones that draw cards
  const TOOL_RANK = ['prop_report', 'player_stats', 'review_parlay', 'review_player', 'build_parlay', 'game_report', 'team_report', 'top_props', 'price_parlay', 'leaders', 'track_record', 'find_players', 'start_sit'];
  function toolsFor(a, q, signal) {
    const said = [q, ...ST.msgs.filter(m => m.role === 'user').map(m => m.text)];
    const defs = TOOL_DEF.slice().sort((x, y) => TOOL_RANK.indexOf(x[0]) - TOOL_RANK.indexOf(y[0])).slice(0, ST.maxTools || TOOL_DEF.length);
    return defs.map(([name, description, inputSchema]) => ({ name, description, inputSchema, async execute(input, c) {
      const sig = (c && c.signal) || signal;
      if ((sig && sig.aborted) || (signal && signal.aborted)) throw new Error('Stopped by the viewer.');
      const ctx = mkCtx(a, q, { get aborted() { return !!((sig && sig.aborted) || (signal && signal.aborted)); } }, said);
      const r = await TOOL_FN[name](input && typeof input === 'object' ? input : {}, ctx);
      if (!(signal && signal.aborted)) { a.step = ''; paintMsg(a); }
      if (r && r.error) throw new Error(r.error);
      return r;
    } }));
  }

  // ---------------------------------------------------------------- local answers (offline mode, and the data for a tool-less view)
  const OFFNOTE = {
    off: 'AI answers aren\'t available in this view, so this is the app\'s own read of the numbers.',
    checking: 'Claude isn\'t ready yet, so this is the app\'s own read of the numbers.',
    not_granted: 'Claude wasn\'t allowed for this page, so this is the app\'s own read of the numbers.',
    sampling_disabled: 'Claude isn\'t available on this account, so this is the app\'s own read of the numbers.',
    tools_unavailable: 'This view can\'t run the app\'s tools for Claude, so this is the app\'s own read. Ask again for a Claude answer built on these numbers.',
    bug: 'Claude couldn\'t take this question, so this is the app\'s own read of the numbers.',
  };
  async function runLocal(a, q) {
    await loadSeason();
    const ctx = mkCtx(a, q), I = parseIntent(q);
    const fail = r => ({ data: r, text: r.error });
    if (I.kind === 'prop') {
      const r = await tPropReport({ player: I.e.name, stat: I.stat, line: I.line, side: I.under ? 'under' : 'over', price: I.price }, ctx); if (r.error) return fail(r);
      const A = analyzeProp(a.cards[a.cards.length - 1]);
      let t = `**${A.e.name} · ${A.market}**: model chance **${pc(A.p)}** (fair odds ${A.fair})`;
      t += A.price ? `. Your price ${amOf(A.price)} implies ${pc(1 / A.price)}, an edge of ${sg(A.V.edge)} percentage points. Verdict: **${A.V.title}** (model estimate).`
        : `. Verdict: **${A.V.title}** (model estimate), worth it only at ${A.fair} or better. Add your book's price for an edge read.`;
      if (I.missing && I.missing !== A.stat) t += `\n\nThe app has no ${ST_NAME[I.missing] || I.missing} line for him, so this is his ${A.stat === 'td' ? 'anytime TD' : ST_NAME[A.stat]} market.`;
      if (I.tdNote) t += `\n\n${I.tdNote}`;
      if (I.amb) t += `\n\n${I.amb}`;
      const b = [];
      if (A.log) b.push(`Recent: ${A.log.summary} (a small sample).`);
      if (A.proj != null) b.push(`Model average: ${f1(A.proj)} ${ST_NAME[A.stat]}${A.M && A.M.rf ? ', recent form counting 30%' : ''}.`);
      const fm = A.factors.find(f => f.name === 'Matchup'); if (fm) b.push(`Matchup: ${fm.status.toLowerCase()}.`);
      if (b.length) t += '\n\n' + b.map(x => '- ' + x).join('\n');
      return { data: r, text: t };
    }
    if (I.kind === 'parlay') {
      const r = await tBuildParlay({ legs: I.n, sport: I.sport, risk: I.risk, when: I.when || '' }, ctx); if (r.error) return fail(r);
      return { data: r, text: `Here's a **${r.title}** from the app's builder: joint chance **${r.joint_chance}** (fair odds ${r.fair_odds}), priced together from the game simulations; ${r.if_unrelated} if the legs were unrelated. ${I.risk !== 'balanced' ? `Built ${I.risk}. ` : ''}Swap any leg with ⇄ or run it 500,000 times on the card.` };
    }
    if (I.kind === 'price') {
      const legs = I.legs.map(L => ({ player: L.e.name, stat: L.stat, line: L.line, side: L.under ? 'under' : 'over' }));
      const r = await tPriceParlay({ legs }, ctx); if (r.error) return fail(r);
      const one = r.legs.length === 1 ? '\n\n- Only one leg matched a player with a game on the app\'s slate; players without a game can\'t be priced.' : '';
      const amb = I.legs.map(L => L.amb).filter(Boolean).join(' ');
      return { data: r, text: `**${r.title}**: joint chance **${r.joint_chance}** (fair odds ${r.fair_odds}), vs ${r.if_unrelated} if the legs were unrelated.${one}${r.unmatched ? `\n\n- Not matched: ${r.unmatched.join(' ')}` : ''}${amb ? `\n\n${amb}` : ''}` };
    }
    if (I.kind === 'top') {
      const r = await tTopProps({ sport: I.sport, n: 5, stat: I.stat, when: I.when || '' }, ctx); if (r.error) return fail(r);
      return { data: r, text: `**${r.title}** are on the card, ranked by model chance. The app has no book prices for props, so they show fair odds, not an edge.\n\n- Top of the list: ${r.props[0]}.` };
    }
    if (I.kind === 'startsit') {
      const r = await tStartSit({ players: I.names }, ctx); if (r.error) return fail(r);
      const R = analyzeSS(I.names);
      const t = R.ok.length >= 2 ? `**${R.V.title}** (model estimate): ${R.ok[0].name} projects ${f1(R.ok[0].proj)} PPR points vs ${R.ok[1].name}'s ${f1(R.ok[1].proj)}.` : `**${R.ok[0].name}** projects ${f1(R.ok[0].proj)} PPR points (model estimate).`;
      return { data: r, text: t + '\n\n- Projection: 70% season, 30% last 3 games, nudged by the game\'s price. No turnover data.' };
    }
    if (I.kind === 'game') {
      const g = SB.gameById(I.gid), r = await tGameReport({ query: `${g.home.name} vs ${g.away.name}` }, ctx); if (r.error) return fail(r);
      const G = analyzeGame(I.gid);
      const t = G.pr ? `**${g.away.name} @ ${g.home.name}** (${SB.when(g)}): ${g.home.abbr} win chance **${pc(G.pH)}**, ${g.away.abbr} ${pc(G.pA)}${G.pD != null ? `, draw ${pc(G.pD)}` : ''}.${G.spread ? ` Model spread ${G.spread}, total ${G.total}.` : G.total ? ` Expected goals ${G.xg} (total ${G.total}).` : ''} Key props are on the card.`
        : `**${g.away.name} @ ${g.home.name}** (${SB.when(g)}): the feed has no price yet, so win chances are unknown.${G.props.length ? ' Key props from season averages are on the card.' : ''}`;
      return { data: r, text: t };
    }
    if (I.kind === 'pstats') {
      const T = I.oppText ? findTeam(I.oppText, I.sp) : null;
      const r = await tPlayerStats({ player: I.name, sport: I.sp, team: I.team || undefined, last: I.n || undefined, opponent: T && T.eab ? T.eab : undefined, venue: I.venue || undefined, stat: sfFrom(I.statText, I.sp, '') || undefined }, ctx); if (r.error) return fail(r);
      const c = a.cards[a.cards.length - 1], R = seasonFind(c.n, c.sp, c.tm), P = seasonPlayer(R.sp, R.p), D = playerData(P, { n: c.last, opp: c.opp, venue: c.venue, st: c.st });
      const per = D.per.filter(([, v]) => num(v)), main = per.find(([f]) => f === D.mf) || per[0];
      let t = `**${P.name}** (${pTeam(P)}${P.pos ? ', ' + P.pos : ''}) this season: ${main ? `**${f1(main[1])} ${SF[main[0]]}**` : ''}${per.filter(x => x !== main).map(([f, v]) => `, ${f1(v)} ${SF[f]}`).join('')} a game over ${P.gp} games (ESPN box scores).`;
      const b = [];
      if (D.split.sel) b.push(`${D.split.sel.lbl}: ${num(D.split.sel.v) ? `${f1(D.split.sel.v)} ${SF[D.mf]} a game in ${D.split.sel.n} logged game${D.split.sel.n === 1 ? '' : 's'}` : 'no logged games'}${D.split.sel.n < 5 ? ' (a small sample)' : ''}.`);
      if (num(D.split.l5.v)) b.push(`Last ${D.split.l5.n}: ${f1(D.split.l5.v)} ${SF[D.mf]} a game (a small sample).`);
      const lg = D.last[D.last.length - 1]; if (lg) b.push(`Last game: ${fmtD(lg.r.d)} ${oppLbl(lg.r)}: ${statLine(P, lg.r, D.F)}${lg.res ? ` · ${P.team} ${wlOf(lg.res)} ${lg.res.pf}-${lg.res.pa}` : ''}.`);
      if (D.nx) b.push(`Next: ${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr}, ${SB.when(D.nx.g)}${D.lines.length ? `; the app's line: ${lineTxt(D.lines[0])}` : ''}.`);
      if (D.inj) b.push(`Injury report: ${D.inj.status}${D.inj.injury ? ` (${D.inj.injury})` : ''}.`);
      t += '\n\n' + b.map(x => '- ' + x).join('\n');
      if (I.amb) t += `\n\n${I.amb}`;
      return { data: r, text: t + `\n\nGame log and splits are on the card. ${UTCNOTE}` };
    }
    if (I.kind === 'rplayer') {
      const R0 = seasonFind(I.name, I.sp, I.team); if (!R0) return fail(notFound(I.name));
      const P0 = seasonPlayer(R0.sp, R0.p), T = I.oppText ? findTeam(I.oppText, P0.sp) : null;
      const r = await tReviewPlayer({ player: P0.name, sport: P0.sp, stat: sfFrom(I.statText, P0.sp, P0.pos) || undefined, line: I.line == null ? undefined : I.line, side: I.under === true ? 'under' : I.under === false ? 'over' : undefined, date: I.d || undefined, opponent: T && T.eab ? T.eab : undefined, _us: true }, ctx); if (r.error) return fail(r);
      const c = a.cards[a.cards.length - 1], P = seasonPlayer(R0.sp, R0.p), i = P.rows.findIndex(x => x.d === c.d), V = reviewOf(P, i, c.st, c.line == null ? null : c.line, !!c.under);
      const vt = V.verdict === 'hit' ? `**hit** (${V.closeTxt})` : V.verdict === 'miss' ? `**missed**, ${V.closeTxt}` : V.verdict === 'push' ? '**a push**' : num(V.ao) ? `${sg(V.v - V.ao)} vs his average of ${f1(V.ao)}` : '';
      let t = `**${P.name}** ${oppLbl(V.row)} (${fmtD(V.row.d)}, UTC date): **${fN(V.v)} ${unitOf(V.f, V.v)}**${V.line != null ? ` vs ${c.src === 'app' ? 'the app\'s' : 'a'} line of ${V.under ? 'under ' : ''}${fmtLine(V.line)}` : ''}: ${vt}.`;
      const b = [...V.facts.slice(0, 4).map(x => 'Fact: ' + x), ...V.maybe.slice(0, 2).map(x => 'Possible: ' + x)];
      if (r.pre_game && /gave this leg/.test(r.pre_game)) b.push(r.pre_game + (r.what_it_says[0] && !/small sample/.test(r.what_it_says[0]) ? ' ' + r.what_it_says[0] : ''));
      t += '\n\n' + b.map(x => '- ' + x).join('\n') + '\n\nOne game is a small sample: the card has his game log.';
      if (I.amb) t += `\n\n${I.amb}`;
      return { data: r, text: t };
    }
    if (I.kind === 'rparlay') {
      const r = await tReviewParlay(I.src === 'picks' ? { source: 'picks', day: I.day || undefined, title: I.title && I.title.trim() ? I.title : undefined } : I.src === 'saved' ? { source: 'saved' } : { source: 'legs', legs: I.legs }, ctx);
      if (r.error && I.src === 'saved') return { data: r, text: 'You have no saved parlays in **My Parlays** on this device. Type the legs (for example "what went wrong with my parlay: Maxey over 24.5 points and Siakam over 20.5 points") and I\'ll grade each one from the box scores.' };
      if (r.error) return fail(r);
      const V = parlayReview(a.cards[a.cards.length - 1]);
      const head = V.status === 'miss' ? `**missed on ${V.miss.length} of ${V.legs.length} leg${V.legs.length === 1 ? '' : 's'}**` : V.status === 'hit' ? `**hit: all ${V.legs.length} legs**` : `**not finished**: ${V.hit.length} of ${V.legs.length} legs hit so far`;
      let t = `**${V.title}**${V.src === 'picks' ? ` (the app's pick for ${fmtD(V.day)})` : ''}: ${head}.`;
      const b = [];
      if (V.miss.length) b.push(`Broke it: ${V.miss.map(G => `${G.label} (${G.actual || '—'}${G.detail ? ', ' + G.detail : ''}${num(G.p) ? `; ${pc(G.p)} before` : ''})`).join('; ')}.`);
      if (V.near.length) b.push(`Near miss${V.near.length > 1 ? 'es' : ''}: ${V.near.map(G => G.label).join('; ')}.`);
      if (V.barely.length) b.push(`Barely made it: ${V.barely.map(G => G.label).join('; ')}.`);
      if (V.links.length) b.push(V.links[0].txt);
      if (V.lessons.length) b.push(`Track record: ${V.lessons[0].txt}.`);
      for (const x of V.says.slice(0, 2)) b.push(x);
      t += '\n\n' + b.map(x => '- ' + x).join('\n');
      if (r.that_day && r.that_day.length > 1) t += `\n\nThat day's ${r.that_day.length} picks: ${r.that_day.filter(x => / hit/.test(x.split(':')[1] || '')).length} hit. Ask about one by name (for example "what went wrong with yesterday's same game parlay").`;
      return { data: r, text: t };
    }
    if (I.kind === 'track') {
      const r = await tTrackRecord({ days: I.days }, ctx); if (r.error) return fail(r);
      const T = trackOf(I.days);
      const b = [...T.tally.slice(0, 4).map(x => `${x.t}: won ${x.w} of ${x.n} (the model expected ${f1(x.exp)})`)];
      if (T.brk.length) b.push(`Broke parlays most: ${T.brk.slice(0, 3).map(([k, c]) => `${k} legs (in ${c})`).join(', ')}.`);
      const low = T.lessons.filter(x => x.gap < -.1)[0]; if (low) b.push(`Lesson: ${low.k} legs hit ${pc(low.rate)} vs ${pc(low.expRate)} expected${low.n < 10 ? ' (a small sample)' : ''}.`);
      return { data: r, text: `**The app's parlays, ${r.span}: won ${T.w} of ${T.n}**; the model expected ${f1(T.exp)}. ${T.legsW} of ${T.legsN} graded legs hit.\n\n${b.map(x => '- ' + x).join('\n')}\n\n${r.note}` };
    }
    if (I.kind === 'leaders') {
      const r = await tLeaders({ sport: I.sp, stat: I.f, position: I.pos || undefined, per_game: I.pg }, ctx); if (r.error) return fail(r);
      return { data: r, text: `**${r.title}** (${r.rule}, ESPN box scores):\n\n${r.leaders.slice(0, 5).map(x => '- ' + x).join('\n')}\n\nThe full list is on the card.` };
    }
    if (I.kind === 'team') {
      const r = await tTeamReport({ team: I.name, sport: I.sp }, ctx); if (r.error) return fail(r);
      const c = a.cards[a.cards.length - 1], D = teamData(c.sp, c.ab, c.name, c.sp === 'soccer' ? c.eab || null : c.ab, c.fab || null), w = PTW[c.sp];
      let t = D.R.length ? `**${D.name}** (${SPN[I.sp]}): **${D.rec}** this season (${recNote(I.sp)}), ${D.home} at home and ${D.away} away, scoring ${f1(D.pf)} and allowing ${f1(D.pa)} ${w} a game. Streak: ${D.streak}.` : `**${D.name}** (${SPN[I.sp]}): no results in the app's season data.`;
      const b = [];
      if (D.last10.length) { const L = D.last10, w10 = L.filter(x => x.pf > x.pa).length, l10 = L.filter(x => x.pf < x.pa).length, x = L[L.length - 1]; b.push(`Last ${L.length}: ${w10}-${l10}${L.length - w10 - l10 ? '-' + (L.length - w10 - l10) : ''}; most recent ${fmtD(x.d)} ${x.home ? 'vs' : '@'} ${x.opp}: ${wlOf(x)} ${x.pf}-${x.pa}.`); }
      const fl = formLines(D.form); if (fl[1]) b.push(`Researched form: ${fl[1]}.`);
      if (D.nx) b.push(`Next: ${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr}, ${SB.when(D.nx.g)}${D.nxp != null ? `; the app's win chance ${pc(D.nxp)} (model estimate)` : ''}.`);
      if (D.inj.length) b.push(`Injury report: ${D.inj.slice(0, 3).map(x => `${x.player} (${x.status})`).join(', ')}${D.inj.length > 3 ? ', …' : ''}.`);
      if (b.length) t += '\n\n' + b.map(x => '- ' + x).join('\n');
      if (I.amb && I.amb.length) t += `\n\nAlso matching: ${I.amb.map(x => `${x.name} (${SPN[x.sp]})`).join(', ')}. Name the sport for another team.`;
      return { data: r, text: t };
    }
    if (I.kind === 'seasononly') return { data: null, text: I.sp === 'nhl' || I.sp === 'soccer'
      ? `**${I.p.n}** (${I.p.t}): the app has no ${SPN[I.sp]} player lines, so there is no chance to give. It prices ${SPN[I.sp]} games (win, draw, totals): ask about his team's game instead.`
      : `**${I.p.n}** (${I.p.t}) has no game with a model line on the app's slate right now, so there is no chance to give. The app covers NFL, college football, NBA, NHL and soccer games in the feed.` };
    if (I.kind === 'slipq') return { data: null, text: 'Type the legs (for example "price a parlay: Maxey over 24.5 points and Brunson over 5.5 assists") and I\'ll price them together, or use **Scan a slip** for a screenshot.' };
    const ex = suggestions().slice(0, 3).map(s => '- ' + s).join('\n');
    return { data: null, text: `I couldn't match that to a player, team or bet in the app's data (${COVER}). Try:\n${ex}\n- How did your picks do?` };
  }
  async function offlineAnswer(a, q, why) {
    a.cards = []; a.text = ''; a.step = 'Reading the slate';
    paintMsg(a);
    const r = await runLocal(a, q);
    a.text = r.text || 'No answer.'; a.note = OFFNOTE[why] || OFFNOTE.off;
  }

  // ---------------------------------------------------------------- Claude (the `sample` capability)
  const ST = { msgs: [], busy: false, ctl: null, draft: '', ai: 'checking', toolsOk: true, maxTools: 0, offWhy: '', seq: 0, live: '', gen: 0 };
  let sampleFn = null, aiInit = null;
  function initAI() {
    if (aiInit) return aiInit;
    aiInit = (async () => {
      try {
        if (!window.claude || typeof window.claude.use !== 'function') { ST.ai = 'off'; return; }
        const f = await window.claude.use('sample');
        if (typeof f !== 'function') { ST.ai = 'off'; return; }
        sampleFn = f; ST.ai = 'ready';
        if (typeof f.limits === 'function') {  // cheap and local: no usage, no prompt
          const lim = await Promise.resolve().then(() => f.limits()).catch(() => null);
          if (lim && typeof lim === 'object') { if (!lim.tools) ST.toolsOk = false; else if (num(lim.tools.maxCount)) { ST.maxTools = Math.max(0, Math.floor(lim.tools.maxCount)); if (ST.maxTools < 1) ST.toolsOk = false; } }
        }
      } catch (e) { ST.ai = 'off'; }
    })().then(() => { if (SB.tab === KEY) paintFoot(); });
    return aiInit;
  }
  function slateLine() {
    const now = Date.now(), cnt = {};
    for (const g of SB.DATA.games || []) { if (!SB.openG(g) || SB.isVoid(g)) continue; const h = (SB.startMs(g) - now) / 36e5; if (h > (g.sport === 'nfl' || g.sport === 'ncaaf' ? 192 : 36)) continue; cnt[g.sport] = (cnt[g.sport] || 0) + 1; }
    return Object.entries(cnt).map(([s, n]) => `${SPN[s]} ${n} game${n > 1 ? 's' : ''}`).join(', ');
  }
  function rules() {
    const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return [
      'You are the Safe Bets research assistant inside the Safe Bets app (sports betting and fantasy research on NFL, college football, NBA, NHL and soccer).',
      `Today is ${day} (Los Angeles time). The viewer is in ${SB.mode === 'fantasy' ? 'fantasy football' : 'betting'} mode. On the app's slate (NBA / NHL / soccer next 36 hours, football next 8 days): ${slateLine() || 'no open games'}.`,
      `What the app knows (through the tools): this season's ESPN box scores for every player in ${COVER}; every team's results with scores; the slate with the app's model chances; researched team form, team trends vs the prices, the injury report and ESPN headlines; the app's own recommended parlays, graded each morning (its track record); and the viewer's saved parlays (My Parlays). ${UTCNOTE}`,
      'How to answer:',
      '- Use the tools for every current-season number: stats, averages, game logs, scores, records, chances, odds, lines, projections, injuries. Never state a current-season stat, score, injury, line or price that a tool did not return.',
      '- Pick the tool: player_stats for any player question (season, recent games, splits, next game); review_player for why one player hit or missed in a game; review_parlay for a parlay breakdown (the app\'s picks, the viewer\'s saved parlays, or legs the viewer types); team_report for a team; leaders for "who leads the league in ..."; track_record for how the app\'s picks have done; prop_report / top_props / build_parlay / price_parlay / game_report / start_sit for bets on the slate.',
      '- General knowledge is allowed only for background: the rules of a sport, how a stat or bet works, history, a player\'s career before this season. Label it "general knowledge (may be out of date)", keep it in its own sentence, and never mix it into this season\'s numbers or use it for a current stat, roster, injury or result.',
      '- If a player, team or game isn\'t in the app\'s data, say so plainly and say what the app covers (NFL, college football, the NBA, the NHL and 5 soccer leagues, from this season\'s ESPN box scores). Don\'t fill the gap from memory.',
      '- Breakdowns (what went right or wrong for a player or a parlay) go in this order: 1) what happened: the facts from the box score; 2) why it likely happened: only the reasons a tool returned as facts, and anything else called a possibility, never a cause; 3) how close it was; 4) what that says: variance (a 70% leg misses about 3 times in 10) and sample size (one game, or a few, is a small sample).',
      '- No hindsight: never say a result was obvious, predictable or a sure thing, and never say a player, team or bet is due.',
      '- Chances are model estimates from the app\'s own simulations. Say so. Never call a bet guaranteed, a lock or due; a 90% chance can still miss.',
      '- The app has no sportsbook prices for player props; it shows fair odds from the model chance. If the viewer gives their book\'s price, pass it to prop_report as price to get the edge.',
      '- If a tool returns an error or no data, say so plainly and suggest something the app can answer.',
      '- Pass a price or line only when the viewer typed it (or a tool returned that line); the app ignores any other and says so in "ignored".',
      '- Call samples under 10 games small.',
      '- Each tool call adds a card under your answer (charts, game logs, legs with ✓ / ✗, buttons). Point to the cards instead of repeating every number.',
      '- Keep it short, under about 170 words: the answer first, then 2-5 short bullets with the key numbers. Plain text with **bold** and "- " bullets only: no tables, headings or links.',
    ].join('\n');
  }
  const CARD_LBL = { pstat: c => `${c.n} season stats`, prev: c => `review of ${c.n} on ${c.d}${c.line != null ? ` (${SF[c.st] || c.st} vs ${c.line})` : ''}`, prv: c => (c.src === 'picks' ? `parlay review: the app's ${c.id} pick of ${c.day}` : c.src === 'saved' ? 'parlay review: a saved parlay' : `parlay review: ${(c.legs || []).length} typed legs`),
    team: c => `team ${c.name || c.ab}`, lead: c => `leaders ${SPN[c.sp] || c.sp} ${SF[c.st] || c.st}`, track: () => 'the app\'s track record' };
  const cardsLine = m => ((m.cards || []).length ? `\n[Cards shown: ${m.cards.map(c => (c.t === 'prop' ? `${c.name} ${c.mk}` : c.t === 'game' ? `game ${c.label}` : c.t === 'ss' ? `start/sit ${(c.names || []).join(' vs ')}` : CARD_LBL[c.t] ? CARD_LBL[c.t](c) : c.title || c.t)).join('; ')}]` : '');
  function historyTurns(a) {
    const i = ST.msgs.indexOf(a), prev = ST.msgs.slice(0, Math.max(0, i - 1));
    return prev.filter(m => !m.busy && ((m.text || '').trim() || (m.cards || []).length)).slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.role === 'assistant' ? (m.text || '(cards only)') + cardsLine(m) : m.text).slice(0, 1500) }));
  }
  // one sample call per answer, with the AbortController made for this answer (answer() creates it); tools mean no cache option
  async function aiAnswer(a, q, ctl) {
    const input = [{ role: 'user', content: rules() }, ...historyTurns(a), { role: 'user', content: q }];
    const onText = ({ text }) => { if (ctl.signal.aborted) return; a.text = text; paintMsg(a); };
    let opts;
    if (ST.toolsOk) opts = { signal: ctl.signal, tools: toolsFor(a, q, ctl.signal), onText };
    else {  // this view can't run page tools: gather the numbers here and send them with the question
      const loc = await runLocal(a, q);
      if (ctl.signal.aborted) { a.note = 'Stopped.'; return; }
      a.step = 'Writing the answer';
      input[input.length - 1] = { role: 'user', content: `${q}\n\nThe app's numbers for this question (from its own model; the cards under your answer show them):\n${JSON.stringify(loc.data || { note: loc.text }).slice(0, 6000)}` };
      opts = { signal: ctl.signal, cache: false, onText };
    }
    try {
      const r = await sampleFn(input, opts);
      a.text = r && typeof r.text === 'string' ? r.text : a.text;
      if (r && r.truncated) a.note = 'The answer was cut short. Ask for less at a time.';
    } catch (e) { await onErr(a, q, e); }
  }
  async function onErr(a, q, e) {
    const code = e && typeof e.code === 'string' ? e.code : 'upstream_error', keep = e && typeof e.text === 'string' ? e.text : '';
    switch (code) {
      case 'cancelled': a.text = keep; a.note = 'Stopped.'; return;
      case 'not_granted': case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
        ST.ai = 'off'; ST.offWhy = code; return offlineAnswer(a, q, code === 'not_granted' || code === 'sampling_disabled' ? code : 'off');
      case 'tools_unavailable': ST.toolsOk = false; return offlineAnswer(a, q, 'tools_unavailable');
      case 'rate_limited': a.text = keep; a.err = e.reason === 'usage_limit' ? 'You\'ve reached your Claude usage limit, so Claude can\'t answer right now. Try again later.' : 'Too many questions at once. Wait a moment, then send again.'; ST.draft = q; return;
      case 'session_expired': a.text = keep; a.err = 'Your Claude sign-in expired. Sign in again, then send your question again.'; ST.draft = q; return;
      case 'refused': a.text = ''; a.err = 'Claude declined this question. Try asking it a different way.'; return;
      case 'empty_completion': a.text = ''; a.err = 'No answer came back. Try a shorter or simpler question.'; return;
      case 'prompt_too_large': a.text = keep; a.err = 'This chat is too long for one answer. Start a new chat and ask again.'; return;
      case 'invalid_request': case 'transform_error': case 'queue_overflow': console.warn('ask.js sample:', code, e && e.message); return offlineAnswer(a, q, 'bug');
      default: a.text = keep; a.err = keep ? 'The answer was interrupted.' : 'Claude couldn\'t be reached.'; a.retry = true;
    }
  }
  const nid = () => { let id; do id = 'm' + Date.now().toString(36) + (++ST.seq).toString(36) + Math.random().toString(36).slice(2, 6); while (ST.msgs.some(m => m.id === id)); return id; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function ask(q) {
    q = String(q || '').trim().slice(0, 600); if (!q || ST.busy) return;
    const u = { id: nid(), role: 'user', text: q, at: Date.now() };
    const a = { id: nid(), role: 'assistant', text: '', cards: [], busy: true, step: '', at: Date.now() };
    ST.msgs.push(u, a); ST.draft = '';
    await answer(a, q, true);
  }
  async function answer(a, q, fresh) {
    const gen = ST.gen, ctl = new AbortController();  // a new controller for every answer: Stop works from the first moment
    ST.busy = true; ST.ctl = ctl; a.busy = true; a.err = ''; a.note = ''; a.retry = false; a.step = '';
    save(); redraw(fresh ? 'bottom' : 'keep');
    try {
      if (ST.ai === 'checking') { initAI(); await Promise.race([aiInit, wait(10000), new Promise(r => ctl.signal.addEventListener('abort', r, { once: true }))]); }
      if (ctl.signal.aborted) a.note = 'Stopped.';
      else if (ST.ai === 'ready' && sampleFn) await aiAnswer(a, q, ctl);
      else await offlineAnswer(a, q, ST.ai === 'checking' ? 'checking' : 'off');
    } catch (e) { console.error(e); if (!a.text) a.err = 'Something went wrong building this answer.'; }
    a.busy = false; a.step = '';
    if (gen !== ST.gen) return;  // New chat was pressed meanwhile: this answer is gone and a newer one may be running
    ST.busy = false; ST.ctl = null;
    ST.live = a.err ? 'The answer could not finish.' : 'Answer ready.';
    save(); redraw('answer:' + a.id);
  }
  function retry(id) {
    const i = ST.msgs.findIndex(m => m.id === id); if (i < 1 || ST.busy) return;
    const u = ST.msgs[i - 1]; if (!u || u.role !== 'user') return;
    const a = ST.msgs[i]; a.text = ''; a.cards = [];
    answer(a, u.text, false);
  }
  function newChat() {
    if (ST.ctl) try { ST.ctl.abort(); } catch (e) { /* already settled */ }
    ST.gen++; ST.msgs = []; ST.busy = false; ST.ctl = null; ST.draft = ''; ST.live = ''; save(); redraw('focus');
  }

  // ---------------------------------------------------------------- history (localStorage 'fm2.chat')
  const CARD_T = new Set(['prop', 'list', 'game', 'parlay', 'ss', 'pstat', 'prev', 'prv', 'team', 'lead', 'track']);
  const strOk = x => typeof x === 'string' && x.length > 0 && x.length <= 120;
  const legOk = x => x && typeof x === 'object' && (strOk(x.player) || strOk(x.team)) && Object.values(x).every(v => v == null || typeof v === 'string' || (typeof v === 'number' && isFinite(v)));
  // a breakdown card saved in this browser: the fields it is drawn from, with the right types (anything else is dropped)
  function bdOk(c) {
    const sp = SPORTS.includes(c.sp);
    if (c.t === 'pstat') return sp && strOk(c.n);
    if (c.t === 'prev') return sp && strOk(c.n) && /^\d{4}-\d{2}-\d{2}$/.test(String(c.d)) && (c.line == null || (typeof c.line === 'number' && isFinite(c.line)));
    if (c.t === 'prv') return c.src === 'picks' ? strOk(c.day) && strOk(c.id) : c.src === 'saved' ? isFinite(+c.at) : c.src === 'legs' && Array.isArray(c.legs) && c.legs.length <= 12 && c.legs.every(legOk);
    if (c.t === 'team') return sp && strOk(c.ab) && (c.name == null || strOk(c.name)) && (c.eab == null || strOk(c.eab)) && (c.fab == null || strOk(c.fab));
    if (c.t === 'lead') return sp && strOk(c.st);
    if (c.t === 'track') return c.days == null || isFinite(+c.days);
    return true;
  }
  function save() {
    const keep = ST.msgs.slice(-20).map(m => ({ id: m.id, role: m.role, text: String(m.text || '').slice(0, 4000), cards: m.role === 'assistant' ? (m.cards || []).slice(0, 4) : undefined,
      note: m.note || undefined, err: m.err || undefined, busy: m.busy || undefined, retry: m.retry || undefined, at: m.at }));
    SB.store.set('chat', { v: 1, msgs: keep });
  }
  function restore() {
    let d = null; try { d = SB.store.get('chat', null); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.msgs)) return;
    const okCard = c => c && typeof c === 'object' && CARD_T.has(c.t) && (c.t !== 'list' || Array.isArray(c.items)) && (c.t !== 'parlay' || Array.isArray(c.legs)) && (c.t !== 'ss' || Array.isArray(c.names)) && bdOk(c);
    ST.msgs = d.msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && typeof m.id === 'string').slice(-20).map(m => {
      const x = { id: m.id, role: m.role, text: m.text, at: +m.at || 0, note: typeof m.note === 'string' ? m.note : '', err: typeof m.err === 'string' ? m.err : '', retry: !!m.retry };
      if (m.role === 'assistant') x.cards = Array.isArray(m.cards) ? m.cards.filter(okCard).slice(0, 4) : [];
      if (m.busy) { x.err = 'This answer was interrupted (the page was closed or reloaded).'; x.retry = true; }
      return x;
    });
    const seen = new Set(); for (const m of ST.msgs) { if (!/^[a-z0-9-]{1,40}$/i.test(m.id)) m.id = 'r' + (++ST.seq); if (seen.has(m.id)) m.id = m.id + '-' + (++ST.seq); seen.add(m.id); }
  }

  // ---------------------------------------------------------------- suggestions from today's slate
  function suggestions() {
    const D = SB.DATA, now = Date.now(), today = E.dayOf(now), out = [];
    const anyToday = (D.games || []).some(g => SB.openG(g) && E.dayOf(SB.startMs(g)) === today);
    const tn = anyToday ? ' tonight' : '';
    if (SB.mode === 'fantasy') {
      const X = pIndex(), wr = X.list.filter(e => e.sport === 'nfl' && e.stats.recyd && /WR|TE/.test(e.pos || '') && e.stats.recyd.status === 'active').sort((a, b) => b.stats.recyd.avg - a.stats.recyd.avg).slice(0, 12);
      let pair = null; for (let i = 0; i + 1 < wr.length; i++) { const d = wr[i].stats.recyd.avg - wr[i + 1].stats.recyd.avg; if (!pair || d < pair.d) pair = { a: wr[i], b: wr[i + 1], d }; }
      if (pair) out.push(`Who should I start at flex: ${pair.a.name} or ${pair.b.name}?`);
      const rb = X.list.filter(e => e.sport === 'nfl' && e.td && e.stats.ryd && e.stats.ryd.status === 'active').sort((a, b) => b.stats.ryd.avg - a.stats.ryd.avg)[0];
      if (rb) out.push(`Will ${rb.name} score a TD this week?`);
      const te = X.list.filter(e => e.sport === 'nfl' && e.stats.rec && /TE/.test(e.pos || '')).sort((a, b) => b.stats.rec.avg - a.stats.rec.avg)[0];
      if (te) out.push(`How many catches will ${te.name} have?`);
      out.push('Top NFL receivers this week?');
      return out;
    }
    const nba = (D.players || []).filter(p => p.stat === 'pts' && p.status === 'active' && (() => { const g = SB.gameById(p.gid); return g && g.sport === 'nba' && SB.openG(g); })());
    if (nba.length) {
      const day = nba.map(p => E.dayOf(SB.startMs(SB.gameById(p.gid)))).sort()[0];
      const top = nba.filter(p => E.dayOf(SB.startMs(SB.gameById(p.gid))) === day).sort((a, b) => b.avg - a.avg)[0];
      if (top) out.push(`Is ${top.name} a good over${day === today ? ' tonight' : ''}?`);
    }
    const X = pIndex(), rb = X.list.filter(e => e.sport === 'nfl' && e.td && e.stats.ryd && e.stats.ryd.status === 'active').sort((a, b) => a.start - b.start || b.stats.ryd.avg - a.stats.ryd.avg);
    if (rb.length) { const first = rb.filter(e => e.start === rb[0].start).sort((a, b) => b.stats.ryd.avg - a.stats.ryd.avg)[0]; out.push(`Should I take ${first.name} to score a TD?`); }
    out.push(`Build me a 3-leg parlay for${tn || ' this week'}`.replace('for this week', 'this week'));
    out.push(`Best props${tn}?`);
    const g = (D.games || []).filter(x => SB.openG(x) && (x.sport === 'nba' || x.sport === 'nfl') && SB.startMs(x) - now < 36 * 3600e3).sort((x, y) => SB.startMs(x) - SB.startMs(y))[0];
    if (g) { const nick = t => { const w = String(t.name).split(' '); return w[w.length - 1]; }; out.push(`How does ${nick(g.away)} @ ${nick(g.home)} look?`); }
    return out.slice(0, 5);
  }

  // ---------------------------------------------------------------- safe markdown (paragraphs, **bold**, bullet lists) with textContent only
  function inline(node, s) {
    for (const part of String(s).split(/(\*\*[^*\n]+\*\*)/g)) {
      if (!part) continue;
      const m = /^\*\*([^*\n]+)\*\*$/.exec(part);
      if (m) { const b = document.createElement('strong'); b.textContent = m[1]; node.appendChild(b); }
      else node.appendChild(document.createTextNode(part.replace(/\*\*/g, '').replace(/`/g, '')));
    }
  }
  function mdInto(el, text) {
    if (!el) return;
    el.textContent = '';
    let list = null, para = [];
    const flush = () => { if (para.length) { const p = document.createElement('p'); inline(p, para.join(' ')); el.appendChild(p); para = []; } };
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const li = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
      if (li) { flush(); if (!list) { list = document.createElement('ul'); el.appendChild(list); } const x = document.createElement('li'); inline(x, li[1]); list.appendChild(x); continue; }
      if (!line.trim()) { flush(); list = null; continue; }
      list = null;
      const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) { flush(); const p = document.createElement('p'), b = document.createElement('strong'); b.textContent = h[1].replace(/\*\*/g, ''); p.appendChild(b); el.appendChild(p); continue; }
      para.push(line.trim());
    }
    flush();
  }

  // ---------------------------------------------------------------- cards (HTML strings, every value escaped)
  // SB.ui.gameLog colours a bar green at or above the line; for an under (and a push on a whole line) that is backwards,
  // so the bars take their colour from the hits counted in the summary
  function logHTML(A) {
    let i = 0;
    return U.gameLog({ title: A.log.title, summary: A.log.summary, vals: A.log.vals, labels: A.log.labels, line: A.line })
      .replace(/class="b (hit|miss)"/g, () => `class="b ${A.log.hits[i++] ? 'hit' : 'miss'}"`);
  }
  const slipBtn = (gid, key, label) => { const on = SB.inSlip(gid, key); return `<button type="button" class="${on ? 'ui-ghost' : 'ui-cta'} sm" data-ask-slip="${esc(gid + '|' + key)}" aria-pressed="${on}" aria-label="${esc((on ? 'Remove from slip: ' : 'Add to slip: ') + label)}">${on ? '✓ In slip' : '+ Slip'}</button>`; };
  function propCardHTML(spec) {
    if (!SEASON_DONE) return `<div class="ask-card ask-wait" aria-busy="true">Loading box scores for ${esc(spec.name || 'this player')}…</div>`;
    const A = analyzeProp(spec);
    if (!A.ok) return `<div class="ask-card ask-gone"><b>${esc(spec.name || 'Prop')}${spec.mk ? ' · ' + esc(spec.mk) : ''}</b><span>${esc(A.why)}</span></div>`;
    const odds = A.price ? amOf(A.price) : A.fair;
    const tiles = [['Model chance', pc(A.p)], ['Fair odds', A.fair]];
    if (A.proj != null) tiles.push(['Model average', `${f1(A.proj)} ${ST_SHORT[A.stat]}`]);
    if (A.price) tiles.push(['Your price', amOf(A.price)], ['Implied', pc(1 / A.price)], ['Edge', `${sg(A.V.edge)}%`, A.V.edge >= 3]);
    const an = A.td ? { name: A.e.name, stat: 'td' } : { id: A.pl.id, line: A.line, under: A.under };
    return `<article class="ask-pc" aria-label="${esc(A.e.name + ', ' + A.market)}">
  <header class="ask-pc-hd">${U.team(A.team, true)}<div class="ask-pc-id">
    <div class="ask-pc-nm"><b>${esc(A.e.name)}</b>${A.pos ? `<span class="ask-pos">${esc(A.pos)}</span>` : ''}</div>
    <div class="ask-pc-mk"><span>${esc(A.market)}</span><span class="ask-od" title="${A.price ? 'your price' : 'fair odds from the model chance'}">${esc(odds)}</span><small>${A.price ? 'your price' : 'fair'}</small></div>
    <div class="ask-pc-mu">${A.home ? 'vs' : '@'} <b>${esc(A.opp.abbr)}</b> · ${esc(SB.when(A.g))}</div></div></header>
  ${U.verdict({ tone: A.V.tone, kicker: A.V.kicker, title: A.V.title, tag: 'Model estimate' })}
  <div class="ask-pc-bd">
    ${A.log ? logHTML(A) : '<p class="ui-note">No recent box scores for him in the app\'s data.</p>'}
    ${U.factors(A.factors)}
    ${U.tiles(tiles)}
    ${A.notes.map(n => `<p class="ui-note">${esc(n)}</p>`).join('')}
    <div class="ask-act">${slipBtn(A.g.id, A.key, A.e.name + ' ' + A.market)}<button type="button" class="ui-ghost sm" data-ask-an="${esc(JSON.stringify(an))}">Analyze</button><button type="button" class="ui-ghost sm" data-ask-fu="${esc(`${A.e.name} ${A.market}`)}">Ask a follow-up</button></div>
  </div>
</article>`;
  }
  function listCardHTML(spec) {
    if (!SEASON_DONE) return `<div class="ask-card ask-wait" aria-busy="true">Loading box scores…</div>`;
    const rows = (spec.items || []).slice(0, 10).map(it => {
      const A = analyzeProp(it);
      if (!A.ok) return `<li class="ask-lr gone"><span>${esc(it.name || '')}${it.mk ? ' · ' + esc(it.mk) : ''}</span><small>${esc(A.why)}</small></li>`;
      const q = A.td ? `Should I take ${A.e.name} to score a TD?` : `Is ${A.e.name} ${A.market.toLowerCase()} a good bet?`;
      return `<li class="ask-lr">${U.team(A.team)}<div class="t"><button type="button" class="ask-lname" data-ask-q="${esc(q)}">${esc(A.e.name)}</button><span>${esc(A.market)} · ${A.home ? 'vs' : '@'} ${esc(A.opp.abbr)} · ${esc(SB.when(A.g))}</span>${A.log ? `<span class="d">${U.dots(A.log.hits)}<small>${esc(A.log.summary)}</small></span>` : ''}</div>
        <div class="p"><b>${esc(pc(A.p))}</b><small>fair ${esc(A.fair)}</small></div>${slipBtn(A.g.id, A.key, A.e.name + ' ' + A.market).replace('+ Slip', '+').replace('✓ In slip', '✓')}</li>`;
    }).join('');
    return `<article class="ask-card ask-list"><div class="ask-lh"><b>${esc(spec.title || 'Top props')}</b><span class="ui-note">Model chance at the app's line; no book prices, so fair odds, not an edge. Tap a name for the full card.</span></div><ul>${rows}</ul></article>`;
  }
  function gameCardHTML(spec) {
    const G = analyzeGame(spec.gid);
    if (!G.ok) return `<div class="ask-card ask-gone"><b>${esc(spec.label || 'Game')}</b><span>${esc(G.why)}</span></div>`;
    const g = G.g, tm = (t, p) => `<div class="tm">${U.team(t.abbr, true)}<b>${esc(t.name)}</b><span class="ui-big">${G.pr ? esc(pc(p)) : '—'}</span></div>`;
    const tiles = G.pr ? [[`${g.home.abbr} win`, pc(G.pH)], [`${g.away.abbr} win`, pc(G.pA)]] : [['Win chances', 'No price yet']];
    if (G.pD != null) tiles.push(['Draw', pc(G.pD)]);
    if (G.spread) tiles.push(['Model spread', G.spread], ['Model total', G.total]);
    else if (G.xg) tiles.push(['Expected goals', G.xg]);
    const props = G.props.map(x => { const mk = marketOf(x.stat, x.line, false); return `<li class="ask-lr">${U.team(x.e.team)}<div class="t"><b>${esc(x.e.name)}</b><span>${esc(mk)}</span></div><div class="p"><b>${esc(pc(x.p))}</b><small>fair ${esc(U.fair(x.p))}</small></div>${slipBtn(g.id, x.key, x.e.name + ' ' + mk).replace('+ Slip', '+').replace('✓ In slip', '✓')}</li>`; }).join('');
    return `<article class="ask-card ask-gc" aria-label="${esc(g.away.name + ' at ' + g.home.name)}">
  <div class="ask-gc-hd">${tm(g.away, G.pA)}<div class="at"><span>@</span><small>${esc(g.comp)}</small><small>${esc(SB.when(g))}</small></div>${tm(g.home, G.pH)}</div>
  ${U.tiles(tiles)}
  ${G.pr ? '' : '<p class="ui-note">The feed has no price for this game yet, so win chances, spread and total are unknown.</p>'}
  ${props ? `<div class="ui-lbl">Key props · model chance</div><ul>${props}</ul>` : ''}
  <div class="ask-act"><button type="button" class="ui-ghost sm" data-ask-open="${esc(g.id)}">Open game</button></div>
</article>`;
  }
  function parlayCardHTML(spec, cid) {
    const P = parlayOf(spec);
    if (!P.legs.length) return `<div class="ask-card ask-gone"><b>${esc(spec.title || 'Parlay')}</b><span>Its games have started, so this card is closed. Ask for a new one.</span></div>`;
    const T = { legs: P.legs, p: P.p, n: P.legs.length };
    const sub = esc(`Priced together from the app's simulations (model estimate). If the legs were unrelated: ${pc(P.indep)}.${P.gone.length ? ` ${P.gone.length} leg${P.gone.length > 1 ? 's have' : ' has'} started and ${P.gone.length > 1 ? 'were' : 'was'} dropped.` : ''}`);
    return `<div class="ask-tc">${SB.ticketCard(cid, esc(spec.title || `${T.n}-leg parlay`), T, sub)}</div>`;
  }
  function ssCardHTML(spec) {
    if (!SEASON_DONE) return `<div class="ask-card ask-wait" aria-busy="true">Loading box scores…</div>`;
    const R = analyzeSS(spec.names);
    if (!R.ok.length) return `<div class="ask-card ask-gone"><b>Start / sit</b><span>${esc(R.rows.map(r => r.why).join(' '))}</span></div>`;
    const col = r => `<div class="ask-ss-c${R.ok[0] === r ? ' top' : ''}">${U.team(r.team, true)}<b>${esc(r.name)}</b><span>${esc([r.team, r.pos].filter(Boolean).join(' · '))}${r.g ? ` · ${esc(r.g.away.abbr)} @ ${esc(r.g.home.abbr)}` : ' · no game found'}</span>
      ${U.tiles([['Projection', f1(r.proj), R.ok[0] === r && R.ok.length > 1], ['Season', f1(r.seasonPPR)], ['Last 3', f1(r.last3)], ['Anytime TD', r.tdp ? pc(r.tdp) : '—']])}</div>`;
    return `<article class="ask-card ask-ss">${R.V ? U.verdict({ tone: R.V.tone, kicker: R.V.d != null ? `Safe Bets verdict · ${f1(R.V.d)} PPR points apart` : 'Safe Bets verdict', title: R.V.title, tag: 'Model estimate' }) : ''}
  <div class="ask-ss-g">${R.ok.map(col).join('')}</div>
  <p class="ui-note">PPR points a game (no turnovers in the data). Projection = 70% season + 30% last 3 games, nudged by the team's expected points when the game is priced. ${R.ok.some(r => r.gp < 10) ? 'Under 10 games is a small sample.' : ''}</p>
  ${R.rows.filter(r => !r.ok).map(r => `<p class="ui-note">${esc(r.why)}</p>`).join('')}
</article>`;
  }
  // ---- breakdown cards (redrawn from the data each time, like the others)
  const waitHTML = what => `<div class="ask-card ask-wait" aria-busy="true">Loading this season's box scores${what ? ' for ' + esc(what) : ''}…</div>`;
  const goneHTML = (title, why) => `<div class="ask-card ask-gone"><b>${esc(title)}</b><span>${esc(why)}</span></div>`;
  const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  const bigN = x => (Number.isInteger(x) ? x.toLocaleString('en-US') : f1(x));
  const newsHTML = L => (L.length ? `<div class="ask-sec"><div class="ui-lbl">Headlines · ESPN</div><ul class="ask-news">${L.map(x => `<li>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.h)}</a>` : `<span>${esc(x.h)}</span>`}<small>${esc(fmtD(x.d))}</small></li>`).join('')}</ul></div>` : '');
  const whyHTML = (facts, maybe) => (facts.length || maybe.length ? `<ul class="ask-why">${facts.map(x => `<li><span class="ask-tag fact">Fact</span><span>${esc(x)}</span></li>`).join('')}${maybe.map(x => `<li><span class="ask-tag maybe">Possible</span><span>${esc(x)}</span></li>`).join('')}</ul>` : '');
  const seasonPx = (n, sp, tm) => { const R = SEASON ? seasonFind(n, sp, tm) : null; return R && R.exact ? seasonPlayer(R.sp, R.p) : null; };
  // the log chart with one game picked out (the reviewed game)
  function selLog(html, k) { let i = -1; return html.replace(/class="b (hit|miss|)"/g, (m, c) => (++i === k ? `class="b ${c} sel"` : m)); }
  function pstatCardHTML(spec) {
    if (!SEASON_DONE) return waitHTML(spec.n);
    const P = seasonPx(spec.n, spec.sp, spec.tm); if (!P) return goneHTML(spec.n || 'Player', 'This player is no longer in the app\'s season box scores.');
    const sp = P.sp, D = playerData(P, { n: spec.last, opp: spec.opp, venue: spec.venue, st: spec.st }), avg = pgOf(P, D.mf);
    const tiles = [['Games', String(P.gp)], ...D.per.filter(([, v]) => num(v)).map(([f, v]) => [`${SFS[f]} a game`, f1(v), f === D.mf])];
    const ch = D.rows.slice(-Math.min(10, Math.max(D.n, 5)));
    const chart = ch.length ? U.gameLog({ title: `${cap(SF[D.mf])} · last ${ch.length}${D.filt.length ? ' ' + D.filt.join(', ') : ''}`, summary: `line = season average ${f1(avg)}`, vals: ch.map(r => rv(sp, r.r, D.mf)), labels: ch.map(r => r.opp), line: num(avg) ? Math.round(avg * 10) / 10 : null }) : '';
    const cols = [{ k: 'd', label: 'Date', sort: false }, { k: 'o', label: 'Opp', sort: false }, ...D.F.map(f => ({ k: f, label: SFS[f], sort: false })), { k: 'res', label: P.team || 'Result', sort: false }];
    const rows = D.last.slice().reverse().map(x => { const o = { d: fmtD(x.r.d), o: oppLbl(x.r), res: x.res ? `${wlOf(x.res)} ${x.res.pf}-${x.res.pa}` : '—' }; for (const f of D.F) o[f] = fN(rv(sp, x.r.r, f)); return o; });
    const s = D.split, sv = o => (num(o.v) ? f1(o.v) : '—'), gl = (l, o) => `${l} · ${o.n} g`, splits = [[gl('Home', s.home), sv(s.home)], [gl('Away', s.away), sv(s.away)], [gl('Last', s.l5), sv(s.l5)]];
    if (s.sel) splits.push([gl(s.sel.lbl, s.sel), sv(s.sel)]);
    const nx = D.nx ? `<div class="ask-sec"><div class="ui-lbl">Next game</div><p class="ask-p">${esc(`${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr} · ${SB.when(D.nx.g)}`)}</p>${D.lines.length ? `<ul class="ask-kv">${D.lines.map(x => { const mk = marketOf(x.st, x.line, false); return `<li><button type="button" class="ask-lname" data-ask-q="${esc(x.st === 'td' ? `Should I take ${P.name} to score a TD?` : `Is ${P.name} ${mk.toLowerCase()} a good bet?`)}">${esc(mk)}</button><span><b>${esc(pc(x.p))}</b> · fair ${esc(U.fair(x.p))} · model estimate</span></li>`; }).join('')}</ul>` : ''}</div>` : '';
    const notes = [UTCNOTE]; if (P.trunc) notes.unshift(`Splits and the log use his last ${P.rows.length} logged games; season numbers cover all ${P.gp}.`); if (P.gp < 10) notes.unshift(`${P.gp} games is a small sample.`); if ((sp === 'nfl' || sp === 'ncaaf') && D.F.includes('td')) notes.push('TD = rushing + receiving.');
    const an = D.slate ? JSON.stringify({ name: P.name, stat: D.mf === 'td' ? 'td' : FAPP[D.mf] || 'pts' }) : null;
    return `<article class="ask-card ask-ps" aria-label="${esc(P.name + ', season stats')}">
  <header class="ask-hd">${U.team(P.team, true)}<div class="id"><div class="nm"><b>${esc(P.name)}</b>${P.pos ? `<span class="ask-pos">${esc(P.pos)}</span>` : ''}</div><div class="ask-hsub">${esc(`${teamName(sp, P.team)} · ${SPN[sp]} · this season`)}</div></div></header>
  ${U.tiles(tiles)}
  ${chart}
  <div class="ask-sec"><div class="ui-lbl">Last ${D.last.length} game${D.last.length === 1 ? '' : 's'}${D.filt.length ? ' · ' + esc(D.filt.join(', ')) : ''}</div>${rows.length ? U.table({ name: 'ask-gl', cols, rows }) : '<p class="ui-note">No logged games for this filter.</p>'}</div>
  <div class="ask-sec"><div class="ui-lbl">${esc(cap(SF[D.mf]))} a game · splits (g = logged games)</div>${U.tiles(splits)}</div>
  ${nx}
  ${D.inj ? `<p class="ask-p"><span class="ask-tag maybe">Injury report</span> ${esc(`${D.inj.status}${D.inj.injury ? ` (${D.inj.injury})` : ''}${D.inj.updated ? `, updated ${fmtD(D.inj.updated)}` : ''}`)}</p>` : ''}
  ${newsHTML(D.news)}
  ${notes.map(n => `<p class="ui-note">${esc(n)}</p>`).join('')}
  <div class="ask-act"><button type="button" class="ui-ghost sm" data-ask-q="${esc(`How did ${P.name} do in his last game?`)}">Review his last game</button>${an ? `<button type="button" class="ui-ghost sm" data-ask-an="${esc(an)}">Analyze</button>` : ''}<button type="button" class="ui-ghost sm" data-ask-fu="${esc(P.name)}">Ask a follow-up</button></div>
</article>`;
  }
  function prevCardHTML(spec) {
    if (!SEASON_DONE) return waitHTML(spec.n);
    const P = seasonPx(spec.n, spec.sp, spec.tm); if (!P) return goneHTML(spec.n || 'Player', 'This player is no longer in the app\'s season box scores.');
    const S = reviewSpec(P, { st: spec.st, line: num(spec.line) ? spec.line : null, under: spec.line != null ? !!spec.under : undefined, d: spec.d, exact: true, lineSrc: spec.src });
    if (S.i < 0 || P.rows[S.i].d !== spec.d) return goneHTML(`${P.name} · ${fmtD(spec.d)}`, 'That game is no longer in his logged box scores.');
    const V = reviewOf(P, S.i, S.f, S.line, S.under), sp = P.sp, row = V.row, u = unitOf(V.f, V.v), ln = V.line != null ? `${V.under ? 'under ' : ''}${fmtLine(V.line)}` : '';
    const tone = V.verdict === 'hit' ? 'take' : V.verdict === 'miss' ? 'pass' : V.verdict === 'push' ? 'coin' : num(V.ao) && V.v >= V.ao ? 'lean' : 'coin';
    const title = V.verdict === 'hit' ? `Hit: ${fN(V.v)} ${u} vs ${ln}` : V.verdict === 'miss' ? `Missed: ${fN(V.v)} ${u} vs ${ln}` : V.verdict === 'push' ? `Push: ${fN(V.v)} ${u}` : `${fN(V.v)} ${u}${num(V.ao) ? `, ${sg(V.v - V.ao)} vs his average` : ''}`;
    const kick = `What happened · ${P.team} ${oppLbl(row)} · ${fmtD(row.d)}${V.line == null ? ' · no line given' : S.src === 'app' ? ' · the app\'s line' : ''}`;
    const F = showF(sp, P.pos), avgO = g => (V.others > 0 ? (tv(sp, P.tot, g) - rv(sp, row.r, g)) / V.others : null);
    const tiles = F.map(g => [`${SFS[g]}${num(avgO(g)) ? ` · avg ${f1(avgO(g))}` : ''}`, fN(rv(sp, row.r, g)), g === V.f]);
    const k0 = Math.max(0, S.i - 7), win = P.rows.slice(k0, S.i + 1), lineV = V.line != null ? V.line : num(V.ao) ? Math.round(V.ao * 10) / 10 : null;
    const vals = win.map(r => rv(sp, r.r, V.f)), hits = vals.map(v => (V.line != null ? (V.under ? v < V.line : v > V.line) : lineV != null && v >= lineV));
    const chart = vals.length ? selLog(U.gameLog({ title: `${cap(SF[V.f])} · his last ${vals.length} to this game`, summary: V.line != null ? `line ${ln}` : 'line = his average', vals, labels: win.map(r => r.opp), line: lineV, hits }), vals.length - 1) : '';
    const pre = S.p ? `The app gave this leg ${pc(S.p)} before the game (model estimate) in ${S.recT}. A ${pc(S.p)} leg ${V.verdict === 'miss' ? 'misses' : 'hits'} ${freqW(V.verdict === 'miss' ? 1 - S.p : S.p)}.` : '';
    return `<article class="ask-card ask-rv" aria-label="${esc(`${P.name}, ${fmtD(row.d)} review`)}">
  ${U.verdict({ tone, kicker: kick, title, tag: 'Box score' })}
  <header class="ask-hd">${U.team(P.team)}<div class="id"><div class="nm"><b>${esc(P.name)}</b>${P.pos ? `<span class="ask-pos">${esc(P.pos)}</span>` : ''}</div><div class="ask-hsub">${esc(V.res ? `${resTxt(V.res, P.team)}${V.scr && V.scr.k !== 'draw' ? ' · ' + V.scr.txt : ''}` : `${oppLbl(row)} · no final score in the results`)}</div></div></header>
  ${V.closeTxt ? `<p class="ask-p"><b>How close:</b> ${esc(V.closeTxt)}.</p>` : ''}
  ${U.tiles(tiles)}
  ${V.facts.length || V.maybe.length ? `<div class="ask-sec"><div class="ui-lbl">Why · facts from the data, possibilities named as such</div>${whyHTML(V.facts, V.maybe)}</div>` : ''}
  ${chart}
  <div class="ask-sec"><div class="ui-lbl">What it says</div><p class="ask-p">${esc(`${pre ? pre + ' ' : ''}One game is a small sample; his season numbers say more than this night.`)}</p></div>
  <p class="ui-note">${esc(`ESPN box score. ${UTCNOTE}${P.trunc ? ` Averages cover all ${P.gp} games; the chart uses his logged games.` : ''}`)}</p>
  <div class="ask-act"><button type="button" class="ui-ghost sm" data-ask-q="${esc(`${P.name} stats this season`)}">Season stats</button><button type="button" class="ui-ghost sm" data-ask-fu="${esc(`${P.name} on ${fmtD(row.d)}`)}">Ask a follow-up</button></div>
</article>`;
  }
  function prvCardHTML(spec) {
    if (!SEASON_DONE) return waitHTML('');
    const V = parlayReview(spec); if (!V.ok) return goneHTML('Parlay review', V.why);
    const tone = V.status === 'miss' ? 'pass' : V.status === 'hit' ? 'take' : 'coin', n = V.legs.length;
    const title = V.status === 'miss' ? `Missed: ${V.miss.length} of ${n} leg${n === 1 ? '' : 's'}` : V.status === 'hit' ? `Hit: all ${n} legs` : `${V.hit.length} of ${n} hit so far`;
    const cls = { hit: 'hit', miss: 'miss brk', push: 'push', pending: 'pend', unknown: 'pend' };
    const legs = V.legs.map(G => `<li class="${cls[G.status] || 'pend'}"><span class="ic" aria-hidden="true">${ICO[G.status] || '?'}</span><div class="t"><b>${esc(G.label)}</b>${G.near ? '<span class="ask-badge">Near miss</span>' : G.barely ? '<span class="ask-badge ok">Close call</span>' : ''}<span>${esc(`${G.actual || (G.status === 'pending' ? 'Pending' : '—')}${G.detail ? ' · ' + G.detail : ''}`)}</span></div>${num(G.p) ? `<span class="pp">${esc(pc(G.p))}<small>before</small></span>` : ''}<span class="ask-vh">${esc({ hit: 'hit', miss: 'missed', push: 'push', pending: 'not graded yet', unknown: 'not graded' }[G.status] || '')}</span></li>`).join('');
    const pp = V.p != null ? V.p : V.pInd, tiles = [['Chance before', pp != null ? pc(pp) : '—'], ['Legs hit', `${V.hit.length} of ${n}`], ['Missed', String(V.miss.length)], ['Near misses', String(V.near.length)]];
    const whyM = V.miss.filter(G => G.V).slice(0, 3).map(G => `<li><b>${esc(G.label)}</b>${whyHTML(G.V.facts.slice(0, 2), G.V.maybe.slice(0, 1))}</li>`).join('');
    const sec = (lbl, items) => (items.length ? `<div class="ask-sec"><div class="ui-lbl">${esc(lbl)}</div><ul class="ask-kv">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    return `<article class="ask-card ask-pr" aria-label="${esc(`Parlay review: ${V.title}`)}">
  ${U.verdict({ tone, kicker: `Parlay review · ${V.title}${V.day && V.src !== 'legs' ? ' · ' + fmtD(V.day) : ''}`, title, tag: 'Box scores' })}
  ${U.tiles(tiles)}
  <ul class="ask-legs">${legs}</ul>
  ${whyM ? `<div class="ask-sec"><div class="ui-lbl">Why the breaking leg${V.miss.length > 1 ? 's' : ''} missed</div><ul class="ask-kv ask-whym">${whyM}</ul></div>` : ''}
  ${sec('Legs that worked for or against each other', V.links.map(x => x.txt))}
  ${sec('The app\'s track record for these kinds of legs', V.lessons.map(x => x.txt))}
  ${sec('What it says', V.says)}
  <p class="ui-note">${esc(`Player legs from ESPN box scores, game legs from final scores${V.src === 'picks' ? ' (the app grades its picks each morning)' : ''}. ${UTCNOTE}`)}</p>
  ${V.src === 'picks' ? '<div class="ask-act"><button type="button" class="ui-ghost sm" data-ask-q="How did your picks do?">Track record</button></div>' : ''}
</article>`;
  }
  function teamCardHTML(spec) {
    if (!SEASON_DONE) return waitHTML(spec.name || spec.ab);
    const eab = spec.sp === 'soccer' ? (typeof spec.eab === 'string' ? spec.eab : null) : spec.ab;
    const D = teamData(spec.sp, spec.ab, String(spec.name || teamName(spec.sp, spec.ab)), eab, typeof spec.fab === 'string' ? spec.fab : null), w = PTW[spec.sp];
    if (!D.R.length && !D.form && !D.nx) return goneHTML(D.name, 'The app has no results for this team this season.');
    const tiles = D.R.length ? [['Record', D.rec], ['Home', D.home], ['Away', D.away], ['Scored / game', f1(D.pf)], ['Allowed / game', f1(D.pa)], ['Streak', D.streak]] : [];
    const L = D.last10.slice().reverse(), dots = U.dots(L.map(x => (x.pf > x.pa ? true : x.pf < x.pa ? false : null)));
    const table = L.length ? U.table({ name: 'ask-tl', cols: [{ k: 'd', label: 'Date', sort: false }, { k: 'o', label: 'Opp', sort: false }, { k: 'r', label: 'Result', sort: false }], rows: L.map(x => ({ d: fmtD(x.d), o: `${x.home ? 'vs' : '@'} ${x.opp}`, r: `${wlOf(x)} ${x.pf}-${x.pa}` })) }) : '';
    const fl = formLines(D.form), tl = trendLines(D.tr), sec = (lbl, items, note) => (items.length ? `<div class="ask-sec"><div class="ui-lbl">${esc(lbl)}</div><ul class="ask-kv">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${note ? `<p class="ui-note">${esc(note)}</p>` : ''}</div>` : '');
    const nx = D.nx ? `<div class="ask-sec"><div class="ui-lbl">Next game</div><p class="ask-p">${esc(`${D.nx.g.away.abbr} @ ${D.nx.g.home.abbr} · ${SB.when(D.nx.g)}`)}${D.nxp != null ? ` · <b>${esc(pc(D.nxp))}</b> ${esc(`${spec.ab} win chance (model estimate)`)}` : ' · no price yet'}</p><div class="ask-act"><button type="button" class="ui-ghost sm" data-ask-open="${esc(D.nx.g.id)}">Open game</button></div></div>` : '';
    return `<article class="ask-card ask-tm" aria-label="${esc(D.name + ', season')}">
  <header class="ask-hd">${U.team(spec.ab, true)}<div class="id"><div class="nm"><b>${esc(D.name)}</b></div><div class="ask-hsub">${esc(`${SPN[spec.sp]} · ${D.R.length ? `${D.rec} (${recNote(spec.sp)})` : 'no results in the season data'}`)}</div></div></header>
  ${tiles.length ? U.tiles(tiles) : ''}
  ${L.length ? `<div class="ask-sec"><div class="ui-lbl">Last ${L.length} · newest first ${dots}</div>${table}</div>` : ''}
  ${D.al ? `<p class="ask-p">${esc(`${ord(D.al.rank)} fewest ${w} allowed of ${D.al.of} teams.`)}</p>` : ''}
  ${!SIDE_DONE ? '<p class="ui-note">Loading researched form and trends…</p>' : ''}
  ${sec('Researched form', fl, D.form ? `form.json, as of ${fmtD(String(D.form.asOf || '').slice(0, 10)) || 'unknown'}` : '')}
  ${sec('Trends vs the prices', tl, tl.length ? 'Past patterns, not predictions; small samples.' : '')}
  ${sec('Injury report', D.inj.map(x => `${x.player}${x.pos ? ` (${x.pos})` : ''}: ${x.status}${x.injury ? `, ${x.injury}` : ''}`))}
  ${nx}
  ${newsHTML(D.news)}
  <p class="ui-note">${esc(`Results: ${D.src}. ${UTCNOTE}${D.R.length && D.R.length < 10 ? ` ${D.R.length} games is a small sample.` : ''}`)}</p>
</article>`;
  }
  function leadCardHTML(spec) {
    if (!SEASON_DONE) return waitHTML('');
    const L = leadersOf(spec.sp, spec.st, { pos: spec.pos, pg: !!spec.pg, n: spec.n, mg: spec.mg }); if (!L || !L.rows.length) return goneHTML('Leaders', 'No players qualify.');
    const rows = L.rows.map((e, i) => `<li class="ask-lr"><span class="rk">${i + 1}</span>${U.team(e.team)}<div class="t"><button type="button" class="ask-lname" data-ask-q="${esc(`${e.name} stats this season`)}">${esc(e.name)}</button><span>${esc(`${e.team}${e.pos ? ' · ' + e.pos : ''} · ${e.gp} games`)}</span></div><div class="p"><b>${esc(L.pg ? f1(e.x) : bigN(e.x))}</b><small>${L.pg ? 'a game' : 'total'}</small></div></li>`).join('');
    return `<article class="ask-card ask-list ask-ld"><div class="ask-lh"><b>${esc(leadTitle(L))}</b><span class="ui-note">${esc(`${cap(leadRule(L))}. ESPN box scores; ${L.total} players qualify. Tap a name for his season.`)}</span></div><ol>${rows}</ol></article>`;
  }
  function trackCardHTML(spec) {
    const T = trackOf(spec.days, spec.kind); if (!T || !T.n) return goneHTML('Track record', 'No graded parlays yet.');
    const row = (l, s, v, tone) => `<li class="ask-lr"><div class="t"><b>${esc(l)}</b><span>${esc(s)}</span></div><div class="p"><b class="${tone || ''}">${esc(v)}</b></div></li>`;
    return `<article class="ask-card ask-list ask-tr"><div class="ask-lh"><b>How the app's parlays did${T.kind ? ' · ' + esc(T.kind) : ''}</b><span class="ui-note">${esc(`${T.days.length} graded day${T.days.length === 1 ? '' : 's'}, ${fmtD(T.days[0])} to ${fmtD(T.days[T.days.length - 1])}; graded each morning from final scores and box scores.`)}</span></div>
  ${U.tiles([['Parlays won', `${T.w} of ${T.n}`], ['Model expected', f1(T.exp)], ['Legs hit', `${T.legsW} of ${T.legsN}`]])}
  <div class="ui-lbl" style="margin-top:12px">By kind</div><ul>${T.tally.map(x => row(x.t, `won ${x.w} of ${x.n} · the model expected ${f1(x.exp)}`, `${x.w}/${x.n}`)).join('')}</ul>
  ${T.brk.length ? `<div class="ui-lbl" style="margin-top:12px">Legs that broke parlays most</div><ul>${T.brk.map(([k, c]) => row(`${cap(k)} legs`, `missed in ${c} lost parlay${c === 1 ? '' : 's'}`, String(c))).join('')}</ul>` : ''}
  ${T.lessons.length ? `<div class="ui-lbl" style="margin-top:12px">Lessons · each kind of leg vs the model</div><ul>${T.lessons.map(x => row(`${cap(x.k)} legs`, `hit ${x.w} of ${x.n} (${pc(x.rate)}) vs ${pc(x.expRate)} expected${x.n < 10 ? ' · small sample' : ''}`, (Math.round(x.gap * 100) === 0 ? '0' : `${x.gap > 0 ? '+' : '−'}${Math.abs(Math.round(x.gap * 100))}`), x.gap < -.1 ? 'bad' : x.gap > .05 ? 'good' : '')).join('')}</ul>` : ''}
  <p class="ui-note">Long parlays lose most of the time even when priced right: compare the wins with what the model expected, over many days.</p>
</article>`;
  }
  function cardHTML(spec, cid) {
    try {
      if (spec.t === 'prop') return propCardHTML(spec);
      if (spec.t === 'list') return listCardHTML(spec);
      if (spec.t === 'game') return gameCardHTML(spec);
      if (spec.t === 'parlay') return parlayCardHTML(spec, cid);
      if (spec.t === 'ss') return ssCardHTML(spec);
      if (spec.t === 'pstat') return pstatCardHTML(spec);
      if (spec.t === 'prev') return prevCardHTML(spec);
      if (spec.t === 'prv') return prvCardHTML(spec);
      if (spec.t === 'team') return teamCardHTML(spec);
      if (spec.t === 'lead') return leadCardHTML(spec);
      if (spec.t === 'track') return trackCardHTML(spec);
    } catch (e) { console.error(e); return '<div class="ask-card ask-gone">This card could not be drawn.</div>'; }
    return '';
  }

  // ---------------------------------------------------------------- the screen
  const ICON = {
    send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
    cam: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg>',
  };
  const orb = cls => `<span class="ask-orb${cls ? ' ' + cls : ''}" aria-hidden="true"><i></i></span>`;
  function footText() {
    if (ST.ai === 'off') return 'AI answers aren\'t available in this view: answers come from the app\'s own numbers';
    if (ST.ai === 'ready') return 'Claude answers from the app\'s numbers · model estimates, not guarantees';
    return 'Chances are model estimates, not guarantees';
  }
  function dockHTML() {
    return `<div class="ask-dock"><form class="ask-compose" novalidate>
  <button type="button" class="ask-scan" data-ask-scan aria-label="Scan a slip (opens Slip Check)" title="Scan a slip">${ICON.cam}<span>Scan a slip</span></button>
  <textarea class="ask-input" rows="1" maxlength="600" placeholder="Ask Safe Bets anything" aria-label="Ask Safe Bets anything" enterkeyhint="send">${esc(ST.draft)}</textarea>
  ${ST.busy ? `<button type="button" class="ask-send ask-stop" data-ask-stop aria-label="Stop">${ICON.stop}</button>` : `<button type="submit" class="ask-send" aria-label="Send">${ICON.send}</button>`}
</form><p class="ask-foot">${esc(footText())}</p></div>`;
  }
  function statusHTML(a) {
    if (!a.busy) return '';
    const live = a.step || (!a.text ? '' : null);
    if (live === null) return '';
    const res = a.step || (a.cards || []).length;
    return `<div class="ask-busy">${orb('sm live')}<div><div class="k">${res ? 'Researching…' : 'Thinking…'}</div><div class="s">${esc(a.step || ((a.cards || []).length ? 'Writing your breakdown…' : 'Building your breakdown…'))}</div><div class="bar"><i></i></div></div></div>`;
  }
  function msgHTML(m) {
    if (m.role === 'user') return `<div class="ask-u"><div class="ask-ub">${esc(m.text)}</div></div>`;
    const cards = (m.cards || []).map((c, i) => cardHTML(c, `ask-${m.id}-${i}`)).join('');
    return `<div class="ask-a" data-mid="${esc(m.id)}"><div class="ask-ah">${orb('sm')}<span class="ask-who">Safe Bets</span></div>
  <div class="ask-st">${statusHTML(m)}</div><div class="ask-text"></div>
  <div class="ask-cards" data-n="${(m.cards || []).length}">${cards}</div>
  <div class="ask-meta">${m.err ? `<p class="ask-err" role="alert">${esc(m.err)}${m.retry ? ` <button type="button" class="ui-link" data-ask-retry="${esc(m.id)}">Try again</button>` : ''}</p>` : ''}${m.note ? `<p class="ask-note">${esc(m.note)}</p>` : ''}</div></div>`;
  }
  function emptyHTML() {
    const chips = suggestions().map(s => `<button type="button" class="ask-chip" data-ask-q="${esc(s)}">${esc(s)}</button>`).join('');
    const fan = SB.mode === 'fantasy';
    return `<div class="ask-hero">${U.page({ kicker: 'Ask Safe Bets · scan a bet slip', title: fan ? 'Start, sit, trade.' : 'Ask about any player, prop or game.', accent: 'Get the numbers.',
      sub: fan ? 'Who to start, who scores, how many catches: every answer is built on this season\'s box scores and the app\'s model, with chances shown as estimates.' : 'Props, parlays, matchups, any player\'s season, and why a bet hit or missed. Every answer comes with the numbers behind it: the app\'s own model, this season\'s box scores, and chances shown as estimates.' })}
  <p class="ask-cov">Coverage: NFL · college football · NBA · NHL · soccer</p></div>
<section class="ask-panel" aria-label="Chat">${orb('')}<p class="ask-h" role="heading" aria-level="2">Ask Safe Bets</p><p class="ask-sub">${fan ? 'Fantasy questions answered from the app\'s numbers.' : 'Straight answers with the numbers behind them.'}</p>
  <div class="ask-chips" role="group" aria-label="Suggested questions">${chips}</div>${dockHTML()}</section>`;
  }
  function threadHTML() {
    return `<div class="ask-top"><span class="ui-kick">Ask Safe Bets</span><button type="button" class="ui-ghost sm" data-ask-new>New chat</button></div>
<div class="ask-thread">${ST.msgs.map(msgHTML).join('')}</div>${dockHTML()}<p class="ask-sr" aria-live="polite"></p>`;
  }
  let MAIN = null;
  function render(main, params) {
    MAIN = main; css(); initAI();
    if (!SEASON_DONE) loadSeason().then(() => { if (SB.tab === KEY && MAIN && ST.msgs.some(m => (m.cards || []).length)) redraw(); });
    if (!SIDE_DONE && ST.msgs.some(m => (m.cards || []).some(c => c.t === 'pstat' || c.t === 'team'))) loadSides().then(() => { if (SB.tab === KEY && MAIN) redraw(); });
    params = params || {};
    if (params.q && !params._seen) { params._seen = true; ST.draft = String(params.q).slice(0, 600); if (params.send && !ST.busy) { const q = ST.draft; setTimeout(() => ask(q), 0); } }
    const empty = !ST.msgs.length;
    main.innerHTML = `<div class="ui-page ask${empty ? ' is-empty' : ''}">${empty ? emptyHTML() : threadHTML()}</div>`;
    for (const m of ST.msgs) if (m.role === 'assistant') mdInto(main.querySelector(`.ask-a[data-mid="${CSS.escape(m.id)}"] .ask-text`), m.text);
    wire(main.querySelector('.ask'));
    const ta = main.querySelector('.ask-input'); if (ta) grow(ta);
    // the live region is drawn empty and filled a moment later, so screen readers hear the change
    const sr = main.querySelector('.ask-sr');
    if (sr && ST.live) { const t = ST.live; ST.live = ''; setTimeout(() => { if (sr.isConnected) sr.textContent = t; }, 150); }
  }
  function redraw(how) {
    if (SB.tab !== KEY || !MAIN || !document.body.contains(MAIN)) return;
    const ta0 = MAIN.querySelector('.ask-input'), ae = document.activeElement, had = ta0 && ae === ta0;
    // a button that is redrawn away (Send / Stop, a suggestion, a name in a list, Try again) hands focus to the new Send / Stop
    const hadBtn = !had && ae && ae !== document.body && MAIN.contains(ae) && ae.matches('.ask-send,.ask-chip,[data-ask-q],[data-ask-retry]');
    render(MAIN, {});
    const ta = MAIN.querySelector('.ask-input');
    if (how === 'focus' || (had && ta)) { try { ta.focus({ preventScroll: how !== 'focus' }); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* not focusable */ } }
    else if (hadBtn) { const b = MAIN.querySelector('.ask-send'); if (b) b.focus({ preventScroll: true }); }
    if (how === 'bottom') requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
    else if (how && how.startsWith('answer:')) {
      const el = MAIN.querySelector(`.ask-a[data-mid="${CSS.escape(how.slice(7))}"]`);
      if (el) requestAnimationFrame(() => { const r = el.getBoundingClientRect(), top = window.scrollY + r.top - 84; if (r.top < 60 || r.top > window.innerHeight * .6) window.scrollTo(0, Math.max(0, top)); });
    }
  }
  function paintMsg(a) {
    if (SB.tab !== KEY || !MAIN) return;
    const el = MAIN.querySelector(`.ask-a[data-mid="${CSS.escape(a.id)}"]`); if (!el) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
    el.querySelector('.ask-st').innerHTML = statusHTML(a);
    mdInto(el.querySelector('.ask-text'), a.text);
    const cw = el.querySelector('.ask-cards');
    if (+cw.dataset.n !== a.cards.length) { cw.innerHTML = a.cards.map((c, i) => cardHTML(c, `ask-${a.id}-${i}`)).join(''); cw.dataset.n = a.cards.length; }
    if (nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  }
  function paintFoot() { if (!MAIN) return; const f = MAIN.querySelector('.ask-foot'); if (f) f.textContent = footText(); }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; }
  function wire(root) {
    if (!root) return;
    const form = root.querySelector('.ask-compose'), ta = root.querySelector('.ask-input');
    form.addEventListener('submit', e => { e.preventDefault(); if (!ST.busy) ask(ta.value); });
    ta.addEventListener('input', () => { ST.draft = ta.value; grow(ta); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!ST.busy) ask(ta.value); } });
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-ask-q],[data-ask-scan],[data-ask-stop],[data-ask-new],[data-ask-slip],[data-ask-an],[data-ask-fu],[data-ask-retry],[data-ask-open]'); if (!t) return;
      const d = t.dataset;
      if (d.askQ != null) { if (!ST.busy) ask(d.askQ); return; }
      if (d.askScan != null) { SB.goTab('slipcheck', {}); return; }
      if (d.askStop != null) { if (ST.ctl) ST.ctl.abort(); return; }
      if (d.askNew != null) { newChat(); return; }
      if (d.askRetry != null) { retry(d.askRetry); return; }
      if (d.askOpen != null) { SB.openGame(d.askOpen); return; }
      if (d.askSlip != null) {
        const i = d.askSlip.indexOf('|'), gid = d.askSlip.slice(0, i), key = d.askSlip.slice(i + 1), had = SB.inSlip(gid, key);
        const r = SB.toggleLeg(gid, key);
        if (!had && !r && !SB.inSlip(gid, key)) SB.toast('This leg can\'t be added (its game may have started).');
        refreshSlipBtns(); return;
      }
      if (d.askAn != null) { let p = {}; try { p = JSON.parse(d.askAn); } catch (er) { p = {}; } SB.goTab('propan', p); return; }
      if (d.askFu != null) { ST.draft = `About ${d.askFu}: `; ta.value = ST.draft; grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
  }
  function refreshSlipBtns() {
    if (!MAIN) return;
    MAIN.querySelectorAll('[data-ask-slip]').forEach(b => {
      const s = b.dataset.askSlip, i = s.indexOf('|'), on = SB.inSlip(s.slice(0, i), s.slice(i + 1)), small = !/slip/i.test(b.textContent);
      b.textContent = small ? (on ? '✓' : '+') : on ? '✓ In slip' : '+ Slip'; b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('ui-cta', !on); b.classList.toggle('ui-ghost', on);
      const lbl = (b.getAttribute('aria-label') || '').replace(/^(Add to slip|Remove from slip): /, ''); b.setAttribute('aria-label', (on ? 'Remove from slip: ' : 'Add to slip: ') + lbl);
    });
  }
  if (typeof SB.on === 'function') SB.on('slip', () => { if (SB.tab === KEY) refreshSlipBtns(); });

  function css() {
    if (document.getElementById('ask-css')) return;
    const s = document.createElement('style'); s.id = 'ask-css';
    s.textContent = `
.ask{position:relative;max-width:1180px;margin:0 auto;padding-top:10px}
.ask .ui-head{margin:0}
.ask .ui-title{font-size:clamp(30px,4.6vw,52px)}
.ask-cov{margin-top:14px;font:500 11px var(--fmono);letter-spacing:.18em;text-transform:uppercase;color:#ffffff6b}
.ask.is-empty{display:grid;grid-template-columns:minmax(0,1fr);gap:22px;align-items:start}
.ask-hero,.ask-panel{min-width:0}
@media(min-width:1100px){.ask.is-empty{grid-template-columns:minmax(0,1fr) minmax(400px,470px);gap:56px;align-items:center;min-height:calc(100vh - 110px)}}
@media(max-width:599px){.ask-hero .ui-subt{font-size:14.5px}.ask-cov{display:none}.ask.is-empty{gap:16px}}
.ask-panel{position:relative;display:flex;flex-direction:column;gap:12px;padding:22px 16px 14px;border-radius:24px;border:1px solid var(--hair2);
 background:radial-gradient(130% 80% at 20% -10%,rgba(var(--acc-rgb),.12),transparent 60%),linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01))}
.ask-orb{flex:none;position:relative;width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle,rgba(var(--acc-rgb),.28),rgba(var(--acc-rgb),.05) 72%);
 box-shadow:0 0 0 1px rgba(var(--acc-rgb),.4),0 0 30px rgba(var(--acc-rgb),.45)}
.ask-orb i{width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 50% 50%,#fff 0 17%,#c6f5ff 29%,var(--acc2) 58%,#1366e8 100%);box-shadow:0 0 18px var(--acc2)}
.ask-orb.sm{width:30px;height:30px}.ask-orb.sm i{width:17px;height:17px;box-shadow:0 0 10px var(--acc2)}
.ask-orb.live i{animation:askPulse 1.3s ease-in-out infinite}
@keyframes askPulse{50%{transform:scale(.78);opacity:.75}}
@media (prefers-reduced-motion:reduce){.ask-orb.live i{animation:none}.ask-busy .bar i{animation:none}}
.ask-h{font:700 26px/1.1 'Rubik',sans-serif;letter-spacing:-.01em;color:#fff;margin-top:2px}
.ask-sub{font:400 14.5px/1.45 var(--fui);color:#ffffffa6;margin-top:-6px}
.ask-chips{display:flex;flex-direction:column;align-items:flex-start;gap:9px;margin:4px 0 4px}
.ask-chip{max-width:100%;min-height:42px;padding:9px 15px;border-radius:14px;border:1px solid var(--hair2);background:rgba(255,255,255,.055);color:#f4f8ff;font:600 14.5px/1.3 var(--fui);text-align:left;cursor:pointer;overflow-wrap:anywhere}
.ask-chip:hover,.ask-chip:focus-visible{border-color:rgba(var(--acc-rgb),.6);background:rgba(var(--acc-rgb),.09)}
.ask-dock{position:sticky;bottom:0;z-index:6;padding:10px 0 calc(10px + env(safe-area-inset-bottom,0px));background:linear-gradient(180deg,rgba(0,5,19,0),#000513 34%)}
.ask-panel .ask-dock{padding-bottom:calc(4px + env(safe-area-inset-bottom,0px));background:linear-gradient(180deg,rgba(6,11,24,0),#060b18 34%);margin:0 -4px;padding-left:4px;padding-right:4px}
body:has(#slipbar.on) .ask-dock{bottom:76px}
.ask-compose{display:flex;align-items:flex-end;gap:8px;padding:7px;border-radius:22px;border:1px solid rgba(var(--acc-rgb),.4);background:rgba(8,13,25,.94);
 box-shadow:0 0 0 4px rgba(var(--acc-rgb),.05),0 18px 50px -24px rgba(var(--acc-rgb),.65)}
.ask-compose:focus-within{border-color:var(--acc)}
.ask-input{flex:1;min-width:0;height:42px;min-height:42px;max-height:160px;resize:none;border:0;background:none;color:#fff;font:400 16px/1.4 var(--fui);padding:10px 4px;outline:none;overflow-y:auto}
.ask-input::placeholder{color:#ffffff73}
.ask-send{flex:none;width:42px;height:42px;border-radius:50%;border:0;display:grid;place-items:center;background:var(--acc2);color:var(--acc-ink);cursor:pointer;box-shadow:0 0 18px -4px var(--acc2)}
.ask-send.ask-stop{background:#f4f8ff;color:#030712;box-shadow:none}
.ask-scan{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:42px;height:42px;padding:0 10px;border-radius:15px;border:1px solid var(--hair2);background:rgba(255,255,255,.04);color:#ffffffcc;font:600 13px var(--fui);cursor:pointer;white-space:nowrap}
.ask-scan:hover{color:#fff;border-color:rgba(var(--acc-rgb),.5)}
.ask-scan span{display:none}
@media(min-width:600px){.ask-scan span{display:inline}}
.ask-foot{margin-top:7px;text-align:center;font:400 11.5px/1.4 var(--fui);color:#ffffff6b}
.ask-top{display:flex;align-items:center;gap:10px;max-width:780px;width:100%;margin:0 auto}
.ask-top .ui-kick{flex:1}
.ask-thread{display:flex;flex-direction:column;gap:20px;width:100%;max-width:780px;margin:0 auto}
.ask:not(.is-empty) .ask-dock{max-width:780px;width:100%;margin:0 auto}
.ask-u{display:flex;justify-content:flex-end}
.ask-ub{max-width:min(86%,540px);padding:12px 16px;border-radius:18px 18px 6px 18px;border:1px solid rgba(var(--acc-rgb),.55);background:linear-gradient(180deg,rgba(var(--acc-rgb),.13),rgba(var(--acc-rgb),.05));
 color:#f4f8ff;font:400 15.5px/1.45 var(--fui);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 10px 40px -22px rgba(var(--acc-rgb),.8)}
.ask-a{display:flex;flex-direction:column;gap:10px;min-width:0}
.ask-ah{display:flex;align-items:center;gap:10px}.ask-who{font:700 14px var(--fui);color:#fff}
.ask-busy{display:flex;align-items:flex-start;gap:12px;padding:4px 0}
.ask-busy .k{font:700 17px/1.2 'Rubik',sans-serif;color:var(--acc2)}.ask-busy .s{margin-top:3px;font:400 13.5px var(--fui);color:#ffffffa6}
.ask-busy .bar{position:relative;width:200px;max-width:60vw;height:2px;margin-top:9px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
.ask-busy .bar i{position:absolute;inset:0 auto 0 0;width:40%;border-radius:2px;background:var(--acc2);animation:askBar 1.6s ease-in-out infinite}
@keyframes askBar{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
.ask-text{font:400 15.5px/1.55 var(--fui);color:#e6edf7;overflow-wrap:anywhere}
.ask-text:empty{display:none}
.ask-text p+p,.ask-text p+ul,.ask-text ul+p{margin-top:9px}
.ask-text ul{margin:6px 0 0;padding-left:20px}.ask-text li{margin:4px 0}.ask-text li::marker{color:var(--acc2)}
.ask-text strong{color:#fff;font-weight:700}
.ask-cards{display:flex;flex-direction:column;gap:14px;min-width:0}.ask-cards:empty{display:none}
.ask-meta:empty{display:none}
.ask-note{font:400 12.5px/1.45 var(--fui);color:#ffffff80}
.ask-err{font:500 13.5px/1.45 var(--fui);color:#ff7ab8}
.ask-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ask-card{border-radius:22px;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012));padding:14px;min-width:0}
.ask-wait{color:#ffffffa6;font:500 13.5px var(--fui)}
.ask-gone{display:flex;flex-direction:column;gap:4px;color:#ffffffa6;font:400 13.5px/1.45 var(--fui)}.ask-gone b{color:#fff;font-weight:700}
.ask-pc{border-radius:24px;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012));overflow:hidden;min-width:0;box-shadow:0 30px 70px -40px rgba(0,0,0,.9)}
.ask-pc-hd{display:flex;gap:14px;align-items:center;padding:16px 16px 14px}
.ask-pc-id{min-width:0;flex:1}
.ask-pc-nm{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ask-pc-nm b{font:700 21px/1.12 'Rubik',sans-serif;letter-spacing:-.01em;color:#fff;overflow-wrap:anywhere}
.ask-pos{display:inline-grid;place-items:center;min-width:26px;height:20px;padding:0 6px;border-radius:6px;background:rgba(var(--acc-rgb),.18);color:var(--acc2);font:800 11px var(--fui)}
.ask-pc-mk{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin-top:5px;font:700 15.5px/1.25 var(--fui);color:#fff}
.ask-od{color:var(--acc2);font-variant-numeric:tabular-nums}.ask-pc-mk small{font:500 11.5px var(--fui);color:#ffffff80}
.ask-pc-mu{margin-top:4px;font:500 13px var(--fui);color:#ffffffa6}.ask-pc-mu b{color:#ffffffd9}
.ask-pc>.ui-verdict{border-radius:0;border-left:0;border-right:0}
.ask-pc-bd{display:flex;flex-direction:column;gap:12px;padding:14px}
.ask-pc-bd>.ui-card{padding:12px 12px 6px;border-radius:18px}
.ask-pc .ui-tiles{grid-template-columns:repeat(auto-fit,minmax(128px,1fr))}
.ask-pc,.ask-list,.ask-gc,.ask-ss,.ask-tc{width:100%;max-width:620px}
.ask-pc .ui-log{justify-content:space-evenly}
.ask-act{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.ask-list ul,.ask-gc ul{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column}
.ask-lh{display:flex;flex-direction:column;gap:3px}.ask-lh b{font:700 17px 'Rubik',sans-serif;color:#fff}
.ask-lr{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--hair)}
.ask-lr:first-child{border-top:0}
.ask-lr .t{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ask-lr .t b,.ask-lname{font:700 14.5px var(--fui);color:#fff}
.ask-lname{all:unset;cursor:pointer;font:700 14.5px var(--fui);color:#fff;display:inline-flex;align-items:center;align-self:flex-start;min-height:40px;margin:-8px 0 -6px;text-decoration:underline;text-decoration-color:rgba(var(--acc-rgb),.45);text-underline-offset:3px}
.ask-lname:focus-visible{outline:2px solid var(--acc2);outline-offset:2px;border-radius:4px}
.ask-lr .t>span{font:500 12.5px var(--fui);color:#ffffffa6;overflow-wrap:anywhere}
.ask-lr .d{display:flex;align-items:center;gap:8px}.ask-lr .d small{font:500 11.5px var(--fui);color:#ffffff80}
.ask-lr .p{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px}.ask-lr .p b{font:800 17px 'Rubik',sans-serif;color:#fff;font-variant-numeric:tabular-nums}.ask-lr .p small{font:500 11.5px var(--fui);color:#ffffff80}
.ask-lr [data-ask-slip]{flex:none;width:40px;min-width:40px;padding:0}
.ask-lr.gone{flex-direction:column;align-items:flex-start;color:#ffffffa6;font:500 13px var(--fui)}
.ask-gc{display:flex;flex-direction:column;gap:12px}
.ask-gc-hd{display:grid;grid-template-columns:1fr auto 1fr;align-items:start;gap:8px}
.ask-gc-hd .tm{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;min-width:0}.ask-gc-hd .tm b{font:700 14px/1.2 var(--fui);color:#fff;overflow-wrap:anywhere}
.ask-gc-hd .at{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:16px;color:#ffffff80;font:500 11.5px var(--fui);text-align:center}.ask-gc-hd .at span{font:800 20px 'Rubik',sans-serif;color:#ffffffb3}
.ask-ss{display:flex;flex-direction:column;gap:12px}
.ask-ss-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}
.ask-ss-c{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:18px;border:1px solid var(--hair);background:rgba(255,255,255,.02)}
.ask-ss-c.top{border-color:rgba(var(--acc-rgb),.45)}.ask-ss-c b{font:700 17px 'Rubik',sans-serif;color:#fff}.ask-ss-c>span{font:500 12.5px var(--fui);color:#ffffffa6}
.ask-tc .pc{margin:0}
.ask-vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ask-ps,.ask-rv,.ask-pr,.ask-tm,.ask-ld,.ask-tr{width:100%;max-width:620px}
.ask-ps,.ask-rv,.ask-pr,.ask-tm{display:flex;flex-direction:column;gap:12px}
.ask-rv>.ui-verdict,.ask-pr>.ui-verdict{margin:-14px -14px 0;border-radius:21px 21px 0 0;border-left:0;border-right:0;border-top:0}
.ask-rv .ui-verdict .t,.ask-pr .ui-verdict .t{font-size:19px;overflow-wrap:anywhere}
.ask-rv .ui-verdict>div,.ask-pr .ui-verdict>div{min-width:0}
.ask-hd{display:flex;gap:12px;align-items:center;min-width:0}
.ask-hd .id{min-width:0;flex:1}
.ask-hd .nm{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ask-hd .nm b{font:700 20px/1.15 'Rubik',sans-serif;letter-spacing:-.01em;color:#fff;overflow-wrap:anywhere}
.ask-hd .ask-hsub{margin-top:3px;font:500 13px/1.4 var(--fui);color:#ffffffa6;overflow-wrap:anywhere}
.ask-sec{display:flex;flex-direction:column;gap:7px;min-width:0}
.ask-sec .ui-lbl{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ask-p{font:400 14px/1.5 var(--fui);color:#e6edf7;overflow-wrap:anywhere}.ask-p b{color:#fff}
.ask-kv{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.ask-kv>li{font:400 13.5px/1.45 var(--fui);color:#e6edf7;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px}
.ask-kv>li b{color:#fff}.ask-kv>li>span{color:#ffffffb3}
.ask-kv .ask-lname{margin:-6px 0}
.ask-whym>li{display:block}.ask-whym>li>b{display:block;margin-bottom:4px}
.ask-why{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.ask-why li{display:flex;gap:8px;align-items:baseline;font:400 13.5px/1.45 var(--fui);color:#e6edf7;overflow-wrap:anywhere}.ask-why li>span:last-child{min-width:0}
.ask-tag{flex:none;display:inline-block;padding:1px 7px;border-radius:999px;font:700 10px/1.6 var(--fmono);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
.ask-tag.fact{background:rgba(var(--acc-rgb),.16);color:var(--acc2)}
.ask-tag.maybe{background:rgba(255,184,0,.14);color:#ffcf5a}
.ask-legs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ask-legs>li{position:relative;display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--hair)}
.ask-legs>li:first-child{border-top:0}
.ask-legs>li.brk{background:rgba(241,30,132,.08);border:1px solid rgba(241,30,132,.28);border-radius:14px;padding:10px;margin:2px 0}
.ask-legs>li.brk+li{border-top:0}
.ask-legs .ic{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:800 13px var(--fui);background:rgba(255,255,255,.08);color:#ffffffa6}
.ask-legs .hit .ic{background:rgba(0,212,146,.18);color:#3defb6}.ask-legs .miss .ic{background:rgba(241,30,132,.2);color:#ff7ab8}
.ask-legs .t{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.ask-legs .t b{font:700 14px/1.3 var(--fui);color:#fff;overflow-wrap:anywhere}
.ask-legs .t>span:not(.ask-badge){font:500 12.5px/1.4 var(--fui);color:#ffffffa6;overflow-wrap:anywhere}
.ask-legs .pp{flex:none;display:flex;flex-direction:column;align-items:flex-end;font:700 13.5px var(--fui);color:#ffffffd9;font-variant-numeric:tabular-nums}.ask-legs .pp small{font:500 10.5px var(--fui);color:#ffffff80}
.ask-badge{align-self:flex-start;display:inline-block;padding:0 6px;border-radius:6px;background:rgba(255,184,0,.16);color:#ffcf5a;font:700 10.5px/1.7 var(--fui);white-space:nowrap}
.ask-badge.ok{background:rgba(0,212,146,.14);color:#3defb6}
.ask-rv .ui-log .b.sel .bar{box-shadow:0 0 0 2px #fff,0 0 14px rgba(255,255,255,.35)}
.ask-rv .ui-log .b.sel .o{color:#fff;font-weight:800}
.ask-ps .ui-tiles,.ask-rv .ui-tiles,.ask-pr .ui-tiles,.ask-tm .ui-tiles,.ask-tr .ui-tiles{grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}
.ask-ps .ui-tile b,.ask-rv .ui-tile b,.ask-pr .ui-tile b,.ask-tm .ui-tile b,.ask-tr .ui-tile b{font:700 17px 'Rubik',sans-serif;color:#fff;font-variant-numeric:tabular-nums}
.ask-ps .ui-tile.hl,.ask-rv .ui-tile.hl{border-color:rgba(var(--acc-rgb),.5)}
.ask-ps .ui-card,.ask-rv .ui-card{padding:12px 12px 6px;border-radius:18px}
.ask-ps .ui-table,.ask-tm .ui-table{font-size:13px}.ask-ps .ui-table td,.ask-tm .ui-table td{padding:9px 7px}.ask-ps .ui-table th,.ask-tm .ui-table th{padding:10px 7px}
.ask-ps .ui-log,.ask-rv .ui-log{padding-right:46px}
.ask-pr .ui-tiles{grid-template-columns:repeat(auto-fit,minmax(min(100%,128px),1fr))}
.ask-news{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ask-news li{display:flex;flex-direction:column;gap:1px;padding:6px 0;border-top:1px solid var(--hair)}.ask-news li:first-child{border-top:0}
.ask-news a{display:inline-flex;align-items:center;min-height:40px;color:#f4f8ff;font:600 14px/1.35 var(--fui);text-decoration:underline;text-decoration-color:rgba(var(--acc-rgb),.45);text-underline-offset:3px;overflow-wrap:anywhere}
.ask-news small{font:500 11.5px var(--fui);color:#ffffff80}
.ask-ld ol,.ask-tr ul{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column}
.ask-ld .rk{flex:none;width:22px;text-align:right;font:800 14px 'Rubik',sans-serif;color:#ffffff80;font-variant-numeric:tabular-nums}
.ask-tr .p b.bad{color:#ff7ab8}.ask-tr .p b.good{color:#3defb6}
.ask-tm .ui-dots{margin-left:2px}
`;
    document.head.appendChild(s);
  }

  restore();
  SB.registerTab({ key: KEY, label: 'Chat', render });
  window.__ask = { parseIntent, analyzeProp, logCut, tools: TOOL_FN, rules, parlayReview, seasonFind, dateIn, get state() { return ST; } };  // for tests and debugging
})();
