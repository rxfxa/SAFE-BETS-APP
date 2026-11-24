// ask.js: the Chat screen (key 'ask'), Safe Bets' research assistant.
//  - Empty state: the orb, "Ask Safe Bets", suggestion chips built from today's slate (fantasy questions in fantasy mode) and
//    a composer that stays at the bottom ("Ask Safe Bets anything", send, and Scan a slip -> Slip Check).
//  - Answers: Claude through the artifact's `sample` capability, called ONLY when the viewer sends. Claude gets page tools that
//    run the app's own engine (find_players, prop_report, game_report, build_parlay, price_parlay, top_props, start_sit). Its
//    words stream in as text (a small markdown subset built with textContent, never innerHTML), and the cards under the
//    answer are drawn from the engine's numbers, never from Claude's words.
//  - Offline (no window.claude, use() resolves null, the viewer said no, the account has no Claude): a local parser reads the
//    question (player names, stat words, a line, an American price, "parlay" + legs + sport, "best props", start / sit), runs
//    the same tools and shows the same cards with a short templated sentence, plus a quiet note.
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
      const m = new Map();
      for (const p of S.players || []) { if (!p || !p.n) continue; const k = E.nameKey(p.n); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
      SIDX[sp] = { m, fields: S.fields || [] };
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
    const sport = sportOf(lc), players = matchPlayers(lc);
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
    if (/\b(this|my) (parlay|slip|ticket|bet)\b/.test(lc) && !players.length) return { kind: 'slipq' };
    if (/\b(start|sit|flex|bench)\b/.test(lc) && players.length) return { kind: 'startsit', names: players.slice(0, 4).map(p => p.e.name) };
    const build = /\b(build|make|give|create|generate|suggest|find|need|want)\b/.test(lc);
    if (isParlay && players.length && (players.length >= 2 || !build)) return { kind: 'price', legs: players.slice(0, 10).map((_, i) => legOf(i, players.length === 1)), price: price && price.s };
    if (isParlay) return { kind: 'parlay', n: clamp(nLegs || 3, 2, 10), sport, risk, when };
    if (players.length) return { kind: 'prop', ...legOf(0, players.length === 1), price: price && price.s };
    if (/\b(best|top|good|safest|strongest|favou?rite|smart)\b[^?]*\b(props?|bets?|plays?|picks?|overs?|legs?|receivers?|rushers?|backs?|qbs?|quarterbacks?|scorers?|tight ends?|wrs?|rbs?|tes?)\b/.test(lc) || /\bwho should i bet\b|\bwhat should i bet\b/.test(lc))
      return { kind: 'top', sport: sport || (/\b(receivers?|rushers?|backs?|qbs?|quarterbacks?|tight ends?|wrs?|rbs?|tes?)\b/.test(lc) ? 'nfl' : null), stat: topStat(lc), when };
    const gs = matchGames(raw); if (gs.length) return { kind: 'game', gid: gs[0].id };
    const so = seasonInText(lc); if (so) return { kind: 'seasononly', sp: so.sp, p: so.p };
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
  const TOOL_FN = { find_players: tFindPlayers, prop_report: tPropReport, game_report: tGameReport, build_parlay: tBuildParlay, price_parlay: tPriceParlay, top_props: tTopProps, start_sit: tStartSit };
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
  ];
  // most useful first, so a view that allows fewer tools (limits().tools.maxCount) keeps the ones that draw cards
  const TOOL_RANK = ['prop_report', 'build_parlay', 'game_report', 'top_props', 'price_parlay', 'find_players', 'start_sit'];
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
    if (I.kind === 'seasononly') return { data: null, text: I.sp === 'nhl' || I.sp === 'soccer'
      ? `**${I.p.n}** (${I.p.t}): the app has no ${SPN[I.sp]} player lines, so there is no chance to give. It prices ${SPN[I.sp]} games (win, draw, totals): ask about his team's game instead.`
      : `**${I.p.n}** (${I.p.t}) has no game with a model line on the app's slate right now, so there is no chance to give. The app covers NFL, college football, NBA, NHL and soccer games in the feed.` };
    if (I.kind === 'slipq') return { data: null, text: 'Type the legs (for example "price a parlay: Maxey over 24.5 points and Brunson over 5.5 assists") and I\'ll price them together, or use **Scan a slip** for a screenshot.' };
    const ex = suggestions().slice(0, 3).map(s => '- ' + s).join('\n');
    return { data: null, text: `I couldn't match that to a player, team or bet on the app's slate. Try:\n${ex}` };
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
      'How to answer:',
      '- Use the tools for every number: chances, odds, averages, lines, projections, records. Never state a stat, injury, line or price that a tool did not return, and do not use outside knowledge for them.',
      '- Chances are model estimates from the app\'s own simulations. Say so. Never call a bet guaranteed, a lock or due; a 90% chance can still miss.',
      '- The app has no sportsbook prices for player props; it shows fair odds from the model chance. If the viewer gives their book\'s price, pass it to prop_report as price to get the edge.',
      '- If a tool returns an error or no data, say so plainly and suggest something the app can answer.',
      '- Pass a price or line only when the viewer typed it (or a tool returned that line); the app ignores any other and says so in "ignored".',
      '- Call samples under 10 games small.',
      '- The app shows a card under your answer for each prop_report, game_report, build_parlay, price_parlay, top_props and start_sit call (chart, factors, buttons). Point to the card instead of repeating every number.',
      '- Keep it under about 150 words: the verdict first, then 2-4 short bullets with the key numbers. Plain text with **bold** and "- " bullets only: no tables, headings or links.',
    ].join('\n');
  }
  const cardsLine = m => ((m.cards || []).length ? `\n[Cards shown: ${m.cards.map(c => (c.t === 'prop' ? `${c.name} ${c.mk}` : c.t === 'game' ? `game ${c.label}` : c.t === 'ss' ? `start/sit ${(c.names || []).join(' vs ')}` : c.title || c.t)).join('; ')}]` : '');
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
  const CARD_T = new Set(['prop', 'list', 'game', 'parlay', 'ss']);
  function save() {
    const keep = ST.msgs.slice(-20).map(m => ({ id: m.id, role: m.role, text: String(m.text || '').slice(0, 4000), cards: m.role === 'assistant' ? (m.cards || []).slice(0, 4) : undefined,
      note: m.note || undefined, err: m.err || undefined, busy: m.busy || undefined, retry: m.retry || undefined, at: m.at }));
    SB.store.set('chat', { v: 1, msgs: keep });
  }
  function restore() {
    let d = null; try { d = SB.store.get('chat', null); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.msgs)) return;
    const okCard = c => c && typeof c === 'object' && CARD_T.has(c.t) && (c.t !== 'list' || Array.isArray(c.items)) && (c.t !== 'parlay' || Array.isArray(c.legs)) && (c.t !== 'ss' || Array.isArray(c.names));
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
  function cardHTML(spec, cid) {
    try {
      if (spec.t === 'prop') return propCardHTML(spec);
      if (spec.t === 'list') return listCardHTML(spec);
      if (spec.t === 'game') return gameCardHTML(spec);
      if (spec.t === 'parlay') return parlayCardHTML(spec, cid);
      if (spec.t === 'ss') return ssCardHTML(spec);
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
      sub: fan ? 'Who to start, who scores, how many catches: every answer is built on this season\'s box scores and the app\'s model, with chances shown as estimates.' : 'Props, parlays, matchups and tonight\'s slate. Every answer comes with the numbers behind it: the app\'s own model, this season\'s box scores, and chances shown as estimates.' })}
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
`;
    document.head.appendChild(s);
  }

  restore();
  SB.registerTab({ key: KEY, label: 'Chat', render });
  window.__ask = { parseIntent, analyzeProp, logCut, tools: TOOL_FN, get state() { return ST; } };  // for tests and debugging
})();
