// statx.js: Stat Explorer ('statx', docs/pro-interface.md screen 8) on the window.SB v2 API.
//  - Season leaderboards from this season's ESPN box scores (season.json via SB.season(); tools/season_tables.py).
//  - Sport pills (NFL, NBA, NHL, College); Season, Rows (25 / 50 / 100 / All), Games (all, last 3 / 5 / 10), Per game, and the
//    fantasy scoring switch (All / PPR / Half / Std) for football.
//  - Position chips: football QB, RB, WR, TE, Receiving, Rushing, Team Offense, Team Defense (team tables are added up from the
//    player box lines per game; defense = what opponents gained); NBA All / Guards / Forwards / Centers; NHL Forwards / Defense.
//  - Filters: player search, team, vs team and home / away, recomputed from the game logs.
//  - A sortable heat table: rank, player (team in the accent colour, position), GP and the stats, sorted by the main stat.
// Everything here is what happened this season, not a projection. Fantasy points use our box-score fields only (no interceptions,
// fumbles or two-point conversions), and the footnote says so.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui) { console.warn('statx.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, esc = U.esc, KEY = 'statx';
  const num = x => typeof x === 'number' && isFinite(x);
  const store = SB.store || { get: (k, d) => d, set() {} };
  const nameKey = s => {
    const E = SB.engine;
    if (E && typeof E.nameKey === 'function') { try { return E.nameKey(s); } catch (e) { /* fall through */ } }
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  // ---------- sports, positions, columns ----------
  const SPORTS = ['nfl', 'nba', 'nhl', 'ncaaf'];
  const SPN = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL', ncaaf: 'College' };
  const SPLONG = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL', ncaaf: 'College football' };
  const DOT = { nfl: '#ff6432', nba: '#ff8a3d', nhl: '#8b7bff', ncaaf: '#ffb800' };
  const FOOT = s => s === 'nfl' || s === 'ncaaf';
  // pos: ESPN positions kept; need(v): the row needs some volume in the sample; main: the default sort
  const FB_VIEWS = [
    { k: 'qb', ab: 'QB', label: 'Quarterback', title: 'Quarterbacks', pos: ['QB'], need: v => v.pa > 0, main: 'pyd' },
    { k: 'rb', ab: 'RB', label: 'Running Back', title: 'Running Backs', pos: ['RB'], need: v => v.ra + v.tgt + v.rec > 0, main: 'ryd' },
    { k: 'wr', ab: 'WR', label: 'Wide Receiver', title: 'Wide Receivers', pos: ['WR'], need: v => v.tgt + v.rec > 0, main: 'recyd' },
    { k: 'te', ab: 'TE', label: 'Tight End', title: 'Tight Ends', pos: ['TE'], need: v => v.tgt + v.rec > 0, main: 'recyd', nflOnly: true },
    { k: 'rcv', ab: 'RCV', label: 'Receiving', title: 'Receiving', pos: null, need: v => v.tgt + v.rec > 0, main: 'recyd' },
    { k: 'rush', ab: 'RUSH', label: 'Rushing', title: 'Rushing', pos: null, need: v => v.ra > 0, main: 'ryd' },
    { k: 'off', ab: 'Offense', label: 'Team Offense', title: 'Team Offense', team: 'off', main: 'tyd' },
    { k: 'def', ab: 'Defense', label: 'Team Defense', title: 'Team Defense', team: 'def', main: 'tyd' },
  ];
  const VIEWS = {
    nfl: FB_VIEWS,
    ncaaf: FB_VIEWS.filter(v => !v.nflOnly),  // college positions are guessed from usage: no tight end split
    nba: [
      { k: 'all', ab: 'Player', label: 'All Positions', title: 'All Players', pos: null, need: v => v.min > 0, main: 'pts', short: 'All' },
      { k: 'g', ab: 'Guard', label: 'Guards', title: 'Guards', pos: ['G'], need: v => v.min > 0, main: 'pts', short: 'Guards' },
      { k: 'f', ab: 'Forward', label: 'Forwards', title: 'Forwards', pos: ['F'], need: v => v.min > 0, main: 'pts', short: 'Forwards' },
      { k: 'c', ab: 'Center', label: 'Centers', title: 'Centers', pos: ['C'], need: v => v.min > 0, main: 'pts', short: 'Centers' },
    ],
    nhl: [
      { k: 'f', ab: 'F', label: 'Forwards', title: 'Forwards', pos: ['C', 'LW', 'RW'], need: () => true, main: 'hpts', short: 'Forwards' },
      { k: 'd', ab: 'D', label: 'Defense', title: 'Defensemen', pos: ['D'], need: () => true, main: 'hpts', short: 'Defense' },
    ],
  };
  const DEFPOS = { nfl: 'qb', ncaaf: 'qb', nba: 'all', nhl: 'f' };
  const ALIAS = {
    quarterback: 'qb', quarterbacks: 'qb', qbs: 'qb', 'running back': 'rb', 'running backs': 'rb', rbs: 'rb', 'wide receiver': 'wr', 'wide receivers': 'wr', wrs: 'wr',
    'tight end': 'te', 'tight ends': 'te', tes: 'te', receiving: 'rcv', receivers: 'rcv', rec: 'rcv', rushing: 'rush', rushers: 'rush', offense: 'off', 'team offense': 'off',
    team_offense: 'off', defense: 'def', 'team defense': 'def', team_defense: 'def', player: 'all', players: 'all', 'all positions': 'all', guard: 'g', guards: 'g',
    forward: 'f', forwards: 'f', center: 'c', centers: 'c', defenseman: 'd', defensemen: 'd',
  };
  const MING = { nfl: 3, ncaaf: 3, nba: 5, nhl: 5 };  // per-game tables: fewest games a row needs (capped at half the most anyone has)
  const C = (k, label, kind = 'n', o = {}) => ({ k, label, kind, ...o });
  const SCORE = { ppr: 1, half: 0.5, std: 0 };
  const SCLAB = { ppr: 'PPR', half: 'Half', std: 'Std' };

  // ---------- state (sport / position / rows / per game / scoring are remembered on this device) ----------
  const saved = (() => { try { return store.get('sx.prefs', {}) || {}; } catch (e) { return {}; } })();
  const st = {
    sport: SPORTS.includes(saved.sport) ? saved.sport : 'nfl',
    pos: { ...DEFPOS, ...(saved.pos && typeof saved.pos === 'object' ? saved.pos : {}) },
    rows: [25, 50, 100, 0].includes(saved.rows) ? saved.rows : 50,
    per: saved.per === true,
    scoring: ['all', 'ppr', 'half', 'std'].includes(saved.scoring) ? saved.scoring : 'all',
    last: 0, q: '', team: 'all', vs: 'all', ha: 'all', sort: null,
  };
  for (const sp of SPORTS) if (!VIEWS[sp].some(v => v.k === st.pos[sp])) st.pos[sp] = DEFPOS[sp];
  const remember = () => store.set('sx.prefs', { sport: st.sport, pos: st.pos, rows: st.rows, per: st.per, scoring: st.scoring });
  const showing = () => SB.tab === KEY;
  const drawn = () => showing() && !!document.querySelector('#main .sx-root');

  // ---------- season.json ----------
  let SEAS = null, SEAS_ST = 'idle';
  function needSeason() {
    if (SEAS_ST !== 'idle') return;
    SEAS_ST = 'loading';
    Promise.resolve(typeof SB.season === 'function' ? SB.season() : null)
      .then(d => { SEAS = d && d.sports && typeof d.sports === 'object' ? d : null; SEAS_ST = SEAS ? 'ok' : 'none'; })
      .catch(() => { SEAS = null; SEAS_ST = 'none'; })
      .then(() => { TIDX = {}; OPTS = {}; HAS = {}; if (showing()) SB.render(); });
  }
  const sportData = sp => {
    const S = SEAS && SEAS.sports && SEAS.sports[sp];
    return S && Array.isArray(S.players) && Array.isArray(S.fields) ? S : null;
  };
  const teamsOf = S => (S && S.teams && typeof S.teams === 'object' && !Array.isArray(S.teams) ? S.teams : {});
  const teamName = (S, ab) => String(teamsOf(S)[ab] || ab || '');
  const viewOf = sp => VIEWS[sp].find(v => v.k === st.pos[sp]) || VIEWS[sp][0];

  // which fields carry anything (college box scores have no targets)
  let HAS = {};
  function has(sp, f) {
    if (!HAS[sp]) {
      const S = sportData(sp), h = {};
      if (S) S.fields.forEach((x, i) => { h[x] = S.players.some(P => Array.isArray(P.tot) && +P.tot[i] !== 0); });
      HAS[sp] = h;
    }
    return !!HAS[sp][f];
  }

  // team and opponent lists for the selects (full names, A-Z)
  let OPTS = {};
  function opts(sp) {
    if (OPTS[sp]) return OPTS[sp];
    const S = sportData(sp), team = new Set(), opp = new Set();
    if (S) for (const P of S.players) { if (P.t) team.add(P.t); for (const r of P.log || []) if (r && r[1]) opp.add(r[1]); }
    const list = set => [...set].map(ab => [ab, teamName(S, ab)]).sort((a, b) => a[1].localeCompare(b[1]));
    return (OPTS[sp] = { team: list(team), opp: list(opp) });
  }

  // ---------- team tables: every team's games, added up from its players' box lines ----------
  let TIDX = {};
  const fpStd = v => 0.04 * v.pyd + 4 * v.ptd + 0.1 * v.ryd + 6 * v.rtd + 0.1 * v.recyd + 6 * v.ctd;
  function teamIndex(sp) {
    if (TIDX[sp]) return TIDX[sp];
    const S = sportData(sp), F = S ? S.fields : [], off = new Map();
    const iRec = F.indexOf('rec');
    if (S) for (const P of S.players) {
      if (!P || !P.t) continue;
      for (const r of P.log || []) {
        if (!Array.isArray(r)) continue;
        let m = off.get(P.t); if (!m) off.set(P.t, (m = new Map()));
        let g = m.get(r[0]);
        if (!g) m.set(r[0], (g = { d: r[0], opp: r[1], home: r[2] ? 1 : 0, s: F.map(() => 0), fp: { QB: [0, 0], RB: [0, 0], WR: [0, 0], TE: [0, 0] } }));
        const v = {};
        F.forEach((f, i) => { const x = +r[3 + i] || 0; g.s[i] += x; v[f] = x; });
        const e = g.fp[P.pos];
        if (e) { e[0] += fpStd(fill(v)); e[1] += iRec >= 0 ? v.rec : 0; }
      }
    }
    const def = new Map();  // what each team's opponents gained against it (home flipped to the defending team's side)
    for (const [t, m] of off) for (const g of m.values()) {
      if (!g.opp) continue;
      let dm = def.get(g.opp); if (!dm) def.set(g.opp, (dm = new Map()));
      dm.set(g.d, { d: g.d, opp: t, home: g.home ? 0 : 1, s: g.s, fp: g.fp });
    }
    return (TIDX[sp] = { off, def, F });
  }
  const FB_F = ['pa', 'pyd', 'ptd', 'ra', 'ryd', 'rtd', 'tgt', 'rec', 'recyd', 'ctd'];
  function fill(v) { for (const f of FB_F) if (!num(v[f])) v[f] = 0; return v; }

  // ---------- the sample: season totals, or recomputed from the logs when a filter is on ----------
  const filtered = () => st.vs !== 'all' || st.ha !== 'all' || st.last > 0;
  function sampleOf(log) {
    let L = Array.isArray(log) ? log.filter(Array.isArray) : [];
    if (st.vs !== 'all') L = L.filter(r => r[1] === st.vs);
    if (st.ha !== 'all') L = L.filter(r => (r[2] ? 1 : 0) === (st.ha === 'home' ? 1 : 0));
    if (st.last > 0) L = L.slice(-st.last);
    return L;
  }

  function columns(sp, view) {
    const sc = st.scoring;
    const fp = FOOT(sp) ? (sc === 'all' ? [C('ppr', 'PPR', 'fp'), C('half', 'Half', 'fp'), C('std', 'Std', 'fp')] : [C(sc, SCLAB[sc], 'fp')]) : [];
    const tg = has(sp, 'tgt');
    if (view.team) {
      const s = sc === 'all' ? 'ppr' : sc, x = view.team === 'def' ? ' vs' : '';
      const pos = sp === 'nfl' ? ['QB', 'RB', 'WR', 'TE'] : ['QB', 'RB', 'WR'];
      return [C('tyd', 'Tot yds' + x), C('pyd', 'Pass yds' + x), C('ryd', 'Rush yds' + x), C('ttd', 'Tot TD' + x), C('ptd', 'Pass TD' + x), C('rtd', 'Rush TD' + x),
        C('pa', 'Pass att' + x), C('ra', 'Rush att' + x), C('ypp', 'Yds/play' + x, 'r2')]
        .concat(pos.map(p => C('fp' + p, `${p} ${SCLAB[s]}${x}`, 'fp')));
    }
    if (sp === 'nba') return [C('min', 'Min'), C('pts', 'Pts'), C('reb', 'Reb'), C('ast', 'Ast'), C('pra', 'PRA'), C('pr', 'P+R'), C('pa2', 'P+A')];
    if (sp === 'nhl') return [C('g', 'G'), C('a', 'A'), C('hpts', 'Pts'), C('sog', 'SOG'), C('shp', 'SH%', 'pct')];
    const recv = [tg && C('tgt', 'Tgt'), C('rec', 'Rec'), C('recyd', view.k === 'rb' ? 'Rec yds' : 'Yds'), C('ctd', view.k === 'rb' ? 'Rec TD' : 'TD'), tg && C('cth', 'Cth%', 'pct'), tg && C('ytgt', 'Y/Tgt', 'r2'), C('yrec', 'Y/Rec', 'r2')];
    if (view.k === 'qb') return [C('pa', 'Att'), C('pyd', 'Yds'), C('ya', 'Y/A', 'r2'), C('ptd', 'TD'), C('ra', 'Rush att'), C('ryd', 'Rush yds'), C('rtd', 'Rush TD')].concat(fp);
    if (view.k === 'rb') return [C('ra', 'Att'), C('ryd', 'Yds'), C('ypc', 'YPC', 'r2'), C('rtd', 'TD'), tg && C('tgt', 'Tgt'), C('rec', 'Rec'), C('recyd', 'Rec yds'), C('ctd', 'Rec TD')].filter(Boolean).concat(fp);
    if (view.k === 'rush') return [C('ra', 'Att'), C('ryd', 'Yds'), C('ypc', 'YPC', 'r2'), C('rtd', 'TD'), C('rec', 'Rec'), C('recyd', 'Rec yds')].concat(fp);
    return recv.filter(Boolean).concat([C('ryd', 'Rush yds')]).concat(fp);  // WR, TE, Receiving
  }

  // raw sums -> every value the columns read (counting stats and fantasy points per game when Per game is on)
  function derive(v, gp, cols) {
    const o = { gp };
    const d = { ...v };
    d.ya = v.pa ? v.pyd / v.pa : null; d.ypc = v.ra ? v.ryd / v.ra : null; d.cth = v.tgt ? v.rec / v.tgt : null;
    d.ytgt = v.tgt ? v.recyd / v.tgt : null; d.yrec = v.rec ? v.recyd / v.rec : null;
    if ('pyd' in v) { const s = fpStd(v); d.std = s; d.half = s + 0.5 * v.rec; d.ppr = s + v.rec; }
    if ('pts' in v) { d.pra = v.pts + v.reb + v.ast; d.pr = v.pts + v.reb; d.pa2 = v.pts + v.ast; }
    if ('g' in v && 'a' in v) { d.hpts = v.g + v.a; d.shp = v.sog ? v.g / v.sog : null; }
    for (const c of cols) {
      const x = d[c.k];
      o[c.k] = !num(x) ? null : (st.per && (c.kind === 'n' || c.kind === 'fp') && gp > 0 ? x / gp : x);
    }
    return o;
  }

  // ---------- rows ----------
  function playerRows(sp, view, cols) {
    const S = sportData(sp), F = S.fields, out = [], q = nameKey(st.q), f = filtered();
    for (const P of S.players) {
      if (!P || !P.n) continue;
      if (view.pos && !view.pos.includes(P.pos)) continue;
      if (st.team !== 'all' && P.t !== st.team) continue;
      if (q && !nameKey(P.n).includes(q)) continue;
      let gp, sums;
      if (!f) { gp = +P.gp || 0; sums = F.map((x, i) => +(P.tot || [])[i] || 0); }
      else { const L = sampleOf(P.log); gp = L.length; sums = F.map((x, i) => L.reduce((a, r) => a + (+r[3 + i] || 0), 0)); }
      if (!gp) continue;
      const v = {}; F.forEach((x, i) => { v[x] = sums[i]; });
      if (FOOT(sp)) fill(v);
      if (view.need && !view.need(v)) continue;
      out.push({ n: P.n, t: P.t, pos: P.pos || '', tn: teamName(S, P.t), ...derive(v, gp, cols) });
    }
    return out;
  }
  function teamRows(sp, view, cols) {
    const S = sportData(sp), X = teamIndex(sp), src = view.team === 'def' ? X.def : X.off, out = [];
    const sc = st.scoring === 'all' ? 'ppr' : st.scoring, mult = SCORE[sc];
    for (const t of X.off.keys()) {  // team tables list the teams that have players in our tables
      if (st.team !== 'all' && t !== st.team) continue;
      const m = src.get(t); if (!m) continue;
      let G = [...m.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      if (st.vs !== 'all') G = G.filter(g => g.opp === st.vs);
      if (st.ha !== 'all') G = G.filter(g => g.home === (st.ha === 'home' ? 1 : 0));
      if (st.last > 0) G = G.slice(-st.last);
      if (!G.length) continue;
      const v = {}; X.F.forEach((f, i) => { v[f] = G.reduce((a, g) => a + g.s[i], 0); });
      fill(v);
      const d = { tyd: v.pyd + v.ryd, pyd: v.pyd, ryd: v.ryd, ttd: v.ptd + v.rtd, ptd: v.ptd, rtd: v.rtd, pa: v.pa, ra: v.ra, ypp: v.pa + v.ra ? (v.pyd + v.ryd) / (v.pa + v.ra) : null };
      for (const p of ['QB', 'RB', 'WR', 'TE']) d['fp' + p] = G.reduce((a, g) => a + g.fp[p][0] + mult * g.fp[p][1], 0);
      const o = { gp: G.length };
      for (const c of cols) { const x = d[c.k]; o[c.k] = !num(x) ? null : (st.per && (c.kind === 'n' || c.kind === 'fp') ? x / G.length : x); }
      out.push({ n: teamName(S, t), t, pos: view.team === 'def' ? 'Team defense' : 'Team offense', tn: view.team === 'def' ? 'Team defense' : 'Team offense', team: true, ...o });
    }
    return out;
  }
  function sortRows(rows, k, dir) {
    return rows.sort((a, b) => {
      const x = a[k], y = b[k];
      const nx = !num(x), ny = !num(y);
      if (nx || ny) return nx && ny ? (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) : nx ? 1 : -1;  // no value: always last
      return (x - y) * dir || b.gp - a.gp || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0);
    });
  }
  // the whole table model for the current settings
  function model() {
    const sp = st.sport, S = sportData(sp);
    if (!S) return null;
    const view = viewOf(sp), cols = columns(sp, view);
    if (!st.sort || (st.sort.k !== 'gp' && !cols.some(c => c.k === st.sort.k))) st.sort = { k: view.main, dir: -1 };
    let rows = view.team ? teamRows(sp, view, cols) : playerRows(sp, view, cols);
    const maxGp = rows.reduce((a, r) => Math.max(a, r.gp), 0);
    let minG = 1;
    if (st.per && !view.team && rows.length) { minG = Math.max(1, Math.min(MING[sp], Math.ceil(maxGp / 2))); rows = rows.filter(r => r.gp >= minG); }
    sortRows(rows, st.sort.k, st.sort.dir);
    const shown = st.rows > 0 ? rows.slice(0, st.rows) : rows;
    return { sp, S, view, cols, rows, shown, maxGp, minG };
  }

  // ---------- formatting ----------
  const fInt = x => Math.round(x).toLocaleString('en-US');
  const f1 = x => (Math.round(x * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fmtOf(c) {
    if (c.kind === 'pct') return v => (num(v) ? (Math.round(v * 1000) / 10).toFixed(1) + '%' : '—');
    if (c.kind === 'r2') return v => (num(v) ? v.toFixed(2) : '—');
    if (c.kind === 'fp') return v => (num(v) ? f1(v) : '—');
    return v => (num(v) ? (st.per ? f1(v) : fInt(v)) : '—');
  }
  const seasonLabel = sp => {
    const t = Date.parse(SEAS && SEAS.updated); const d = isFinite(t) ? new Date(t) : new Date(), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (sp === 'nba' || sp === 'nhl') { const a = m >= 8 ? y : y - 1; return `${a}-${String(a + 1).slice(2)}`; }
    return String(m >= 3 ? y : y - 1);
  };
  const updatedTxt = () => {
    const t = Date.parse(SEAS && SEAS.updated);
    return isFinite(t) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(new Date(t)) : '';
  };

  // ---------- HTML ----------
  const ICO_CSV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/></svg>';
  const ICO_Q = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
  function barHTML() {
    const sp = st.sport, S = sportData(sp), view = viewOf(sp);
    const pills = U.pills(SPORTS.map(s => ({ k: s, label: SPN[s], dot: DOT[s] })), sp, 'sx-sport');
    const sel = [
      U.select({ label: 'Season', value: 'cur', options: [['cur', seasonLabel(sp)]], name: 'sx-season' }),
      U.select({ label: 'Rows', value: String(st.rows), options: [['25', '25'], ['50', '50'], ['100', '100'], ['0', 'All']], name: 'sx-rows' }),
      U.select({ label: 'Games', value: String(st.last), options: [['0', 'All'], ['3', 'Last 3'], ['5', 'Last 5'], ['10', 'Last 10']], name: 'sx-last' }),
      `<button type="button" class="sx-per" role="switch" aria-checked="${st.per}" data-sx-per="1" aria-label="Per game"><span class="l">Per</span><span class="v">Game</span><span class="sw" aria-hidden="true"></span></button>`,
      FOOT(sp) ? `<div class="sx-scoring" role="group" aria-label="Fantasy scoring">${U.seg([{ k: 'all', label: 'All' }, { k: 'ppr', label: 'PPR' }, { k: 'half', label: 'Half' }, { k: 'std', label: 'Std' }], st.scoring, 'sx-scoring')}</div>` : '',
      S ? `<button type="button" class="ui-ghost sm sx-csv" data-sx-csv="1" aria-label="Copy this table as CSV">${ICO_CSV}CSV</button>` : '',
    ].join('');
    const chips = S ? `<div class="sx-chips" role="group" aria-label="Position">${VIEWS[sp].map(v => `<button type="button" class="sx-chip${v.k === view.k ? ' on' : ''}${v.short ? ' lbl' : ''}" data-sx-pos="${esc(v.k)}" aria-pressed="${v.k === view.k}"><b>${esc(v.ab)}</b><span class="lg">${esc(v.label)}</span>${v.short ? `<span class="sh">${esc(v.short)}</span>` : ''}</button>`).join('')}</div>` : '';
    let filt = '';
    if (S) {
      const O = opts(sp);
      const any = st.q || st.team !== 'all' || st.vs !== 'all' || st.ha !== 'all' || st.last > 0;
      filt = `<div class="sx-filt">
        ${view.team ? '' : `<label class="sx-q"><span class="l">Player</span>${ICO_Q}<input id="sx-q" type="search" autocomplete="off" spellcheck="false" placeholder="All" aria-label="Search players" value="${esc(st.q)}"></label>`}
        ${U.select({ label: 'Team', value: st.team, options: [['all', 'All teams']].concat(O.team), name: 'sx-team' })}
        ${U.select({ label: 'vs Team', value: st.vs, options: [['all', 'All']].concat(O.opp), name: 'sx-vs' })}
        ${U.select({ label: 'Home / Away', value: st.ha, options: [['all', 'All'], ['home', 'Home'], ['away', 'Away']], name: 'sx-ha' })}
        ${any ? '<button type="button" class="ui-link sx-reset" data-sx-reset="1">Clear filters</button>' : ''}
      </div>`;
    }
    return `<div class="sx-bar${FOOT(sp) ? ' fb' : ''}"><div class="sx-sports">${pills}</div><div class="sx-opts">${sel}</div></div>${chips}${filt}`;
  }
  // "Whole season", "Last 5 home games vs Dallas Cowboys", ...
  function sampleTxt(sp) {
    const ha = st.ha === 'home' || st.ha === 'away' ? st.ha : '';
    let s = st.last > 0 ? `Last ${st.last}${ha ? ' ' + ha : ''} games` : ha ? (ha === 'home' ? 'Home games' : 'Away games') : '';
    if (st.vs !== 'all') s = (s || 'Games') + ' vs ' + teamName(sportData(sp), st.vs);
    return s || 'Whole season';
  }
  function outHTML() {
    if (SEAS_ST === 'idle' || SEAS_ST === 'loading') return `<div aria-busy="true">${U.empty("Loading this season's box scores…")}</div>`;
    if (SEAS_ST === 'none') return U.empty("Season stats did not load: season.json is missing or empty, so there are no tables to show right now. The other screens still work; try again after the next data refresh.");
    const M = model();
    if (!M) return U.empty(`No ${SPLONG[st.sport]} tables in our data right now (season.json has no ${SPN[st.sport]} section).`);
    const { sp, S, view, cols, rows, shown, maxGp, minG } = M;
    const team = st.team === 'all' ? 'All teams' : teamName(S, st.team);
    const what = view.team ? (view.team === 'def' ? 'What opponents gained' : 'Added up from player box lines') : '';
    const unit = view.team ? 'teams' : 'players';
    const meta = [
      `<b>${esc(seasonLabel(sp))} ${esc(SPLONG[sp])} season</b>`, what ? esc(what) : '', esc(team), esc(sampleTxt(sp)), st.per ? 'Per game' : 'Totals',
      esc(shown.length < rows.length ? `${shown.length} of ${rows.length.toLocaleString('en-US')} ${unit}` : `${rows.length.toLocaleString('en-US')} ${unit}`),
      minG > 1 ? `Min ${minG} games` : '',
      filtered() && rows.length && maxGp <= 3 ? '<span class="sx-small">Small samples: 3 games or fewer each</span>' : '',
      filtered() && (sp === 'nba' || sp === 'nhl') ? "From each player's last 15 games (what our logs keep)" : '',
    ].filter(Boolean).join(' · ');
    const tcols = [{ k: 'n', label: view.team ? '# Team' : '# Player & team', sort: false }, { k: 'gp', label: 'GP', fmt: v => (num(v) ? String(v) : '—') }]
      .concat(cols.map(c => ({ k: c.k, label: c.label, heat: true, fmt: fmtOf(c) })));
    const trows = shown.map((r, i) => {
      // phones show the team's abbreviation (the full name stays in the button's label); wider screens the full name
      const sub = r.team ? esc(r.tn) : `<span class="tf">${esc(r.tn)}</span><span class="ta">${esc(r.t)}</span>${r.pos ? ' · ' + esc(r.pos) : ''}`;
      const nm = r.team ? `<span class="sx-nm"><span class="pn">${esc(r.n)}</span><span class="pt">${sub}</span></span>`
        : `<button type="button" class="sx-nm" data-sx-player="${esc(r.n)}" title="Open ${esc(r.n)}'s player page (${esc(r.tn)})"><span class="pn">${esc(r.n)}</span><span class="pt">${sub}</span></button>`;
      return { ...r, html: `<div class="sx-cell"><span class="sx-rk">${i + 1}</span>${nm}</div>` };
    });
    // leaders read bold and the low end dim, as in the reference (reads the heat alpha ui.table writes; a no-op if that changes)
    const table = rows.length ? U.table({ cols: tcols, rows: trows, sort: st.sort, name: 'sx' })
      .replace(/<td style="background:rgba\(var\(--acc-rgb\),(0\.\d+)\)">/g, (m, a) => (+a >= 0.38 ? m.replace('<td ', '<td class="hi" ') : +a < 0.16 ? m.replace('<td ', '<td class="lo" ') : m))
      .replace('<th class="on" scope="col">', `<th class="on" scope="col" aria-sort="${st.sort.dir < 0 ? 'descending' : 'ascending'}">`)
      : `${U.empty(view.team ? 'No team games match these filters.' : 'No players match these filters.')}<p class="sx-reset-row"><button type="button" class="ui-link sx-reset" data-sx-reset="1">Clear filters</button></p>`;
    return `<div class="sx-th"><h2 class="sx-h">${esc(view.title)}</h2><p class="sx-meta">${meta}</p></div>${table}${footHTML(sp, view)}`;
  }
  function footHTML(sp, view) {
    const n = [];
    const src = `Source: ESPN box scores for this season${updatedTxt() ? ` (updated ${updatedTxt()})` : ''}. These are what happened, not projections.`;
    n.push(src);
    if (FOOT(sp)) {
      n.push('Not in our data: completions, interceptions, sacks, air yards, yards after the catch, fumbles and snaps, so those columns are missing.');
      n.push('Fantasy points: 0.04 a passing yard, 4 a passing TD, 0.1 a rushing or receiving yard, 6 a rushing or receiving TD, plus 1 (PPR), 0.5 (Half) or 0 (Std) a catch. No interceptions, fumbles or two-point conversions (not in our data), so quarterbacks read a little high.');
      if (view.team) n.push(`Team tables are added up from player box lines per game (the quarterbacks, backs and receivers in our tables), not official team stats. Total yards = passing + rushing yards; passing yards are before sacks.${view.team === 'def' ? ' Defense = what opponents gained against the team.' : ''}${sp === 'nfl' ? '' : ' Team fantasy columns by position: QB, RB, WR.'}`);
      if (sp === 'ncaaf') n.push('College tables keep players with 150+ yards this season; positions are guessed from usage (no tight end split), and college box scores have no targets. Team totals for small schools run low.');
    } else if (sp === 'nba') n.push('Not in our data: shooting splits, 3-pointers, steals, blocks, turnovers and usage.');
    else if (sp === 'nhl') n.push('Not in our data: time on ice, hits, blocks, plus-minus and power-play points. Goalies are left out.');
    n.push('Situations come from the game logs: opponent, home / away and recent games. There is no play-by-play, so no quarter, down, field-position or score situations.');
    if (sp === 'nba' || sp === 'nhl') n.push('Season totals use every game; opponent, home / away and recent-game splits use the last 15 games we keep for each player.');
    return `<div class="ui-note sx-foot">${n.map(x => `<p>${esc(x)}</p>`).join('')}</div>`;
  }

  // ---------- CSS ----------
  function css() {
    if (document.getElementById('statx-css')) return;
    const s = document.createElement('style'); s.id = 'statx-css';
    s.textContent = `
.sx-root{gap:16px}
.sx-root .sx-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;padding-bottom:16px;border-bottom:1px solid var(--hair)}
.sx-root .sx-sports .ui-pills{display:inline-flex;border-color:var(--hair2);background:rgba(255,255,255,.025)}
.sx-root .sx-sports .ui-pill{min-height:42px;padding:0 16px}
.sx-root .sx-sports .ui-pill:not(.on) .dot{opacity:.5}
.sx-root .sx-opts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}
.sx-root .sx-opts .ui-sel{min-height:42px}
.sx-root .sx-per{position:relative;display:inline-flex;align-items:center;gap:9px;min-height:42px;padding:0 12px 0 14px;border:1px solid var(--hair2);border-radius:12px;background:rgba(255,255,255,.03);color:#fff;cursor:pointer}
.sx-root .sx-per .l{font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.sx-root .sx-per .v{font:700 14px var(--fui)}
.sx-root .sx-per .sw{position:relative;width:34px;height:20px;border-radius:999px;background:rgba(255,255,255,.16);transition:background .15s}
.sx-root .sx-per .sw::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#ffffffcc;transition:transform .15s}
.sx-root .sx-per[aria-checked="true"]{border-color:rgba(var(--acc-rgb),.55)}
.sx-root .sx-per[aria-checked="true"] .sw{background:var(--acc)}.sx-root .sx-per[aria-checked="true"] .sw::after{transform:translateX(14px);background:#fff}
.sx-root .sx-scoring .ui-seg{border-radius:12px;padding:3px}
.sx-root .sx-scoring .ui-seg button{min-height:40px;border-radius:9px;font:600 13px var(--fui);letter-spacing:0;text-transform:none;padding:0 13px}
.sx-root .sx-scoring .ui-seg button.on{background:rgba(var(--acc-rgb),.16);color:var(--acc);box-shadow:inset 0 0 0 1px rgba(var(--acc-rgb),.45)}
.sx-root .sx-csv{min-height:42px;border-radius:12px;gap:6px}
.sx-root .sx-opts .ui-sel,.sx-root .sx-per,.sx-root .sx-csv,.sx-root .sx-scoring .ui-seg{height:46px}
.sx-root .sx-chips{display:flex;flex-wrap:wrap;gap:8px}
.sx-root .sx-chip{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--hair2);background:rgba(255,255,255,.03);color:#ffffffb3;font:500 14px var(--fui);cursor:pointer;white-space:nowrap}
.sx-root .sx-chip b{font:700 14px var(--fui);color:#ffffffe6}
.sx-root .sx-chip .sh{display:none}
.sx-root .sx-chip:hover{background:rgba(255,255,255,.06)}
.sx-root .sx-chip.on{color:var(--acc);border-color:rgba(var(--acc-rgb),.75);background:rgba(var(--acc-rgb),.09);box-shadow:0 0 0 1px rgba(var(--acc-rgb),.25),0 0 22px -8px rgba(var(--acc-rgb),.9)}
.sx-root .sx-chip.on b{color:var(--acc)}
.sx-root .sx-filt{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}
.sx-root .sx-q{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:42px;padding:0 12px 0 14px;border:1px solid var(--hair2);border-radius:12px;background:rgba(255,255,255,.03);color:#ffffff80}
.sx-root .sx-q .l{font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.sx-root .sx-q input{width:150px;min-width:0;min-height:40px;border:0;background:none;color:#fff;font:700 16px var(--fui);outline:none}
.sx-root .sx-q input::placeholder{color:#fff}
.sx-root .sx-q:focus-within{border-color:var(--acc)}
.sx-root .sx-filt .ui-sel .v{max-width:180px;overflow:hidden;text-overflow:ellipsis}
.sx-root .sx-out{display:flex;flex-direction:column;gap:12px;min-width:0}
.sx-root .sx-th{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:1px solid var(--hair)}
.sx-root .sx-h{display:block;font:700 26px/1.15 'Rubik',sans-serif!important;letter-spacing:-.01em;margin-top:10px}
.sx-root .sx-h::before{display:none!important}
.sx-root .sx-meta{font:400 13px/1.5 var(--fui);color:#ffffffa6}.sx-root .sx-meta b{color:#fff;font-weight:700}
.sx-root .sx-small{color:var(--mid)}
.sx-root .ui-table th button{min-height:40px}
.sx-root .ui-table th button:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
.sx-root .ui-table td{padding:10px 12px}
.sx-root .ui-table td:first-child{white-space:normal;min-width:172px;max-width:46vw;padding-left:10px}
.sx-root .sx-cell{display:flex;align-items:center;gap:10px}
.sx-root .sx-rk{flex:none;min-width:18px;text-align:right;font:500 12px var(--fmono);color:#ffffff73}
.sx-root .sx-nm{all:unset;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;min-height:40px;min-width:0;cursor:pointer}
.sx-root button.sx-nm:hover .pn{color:var(--acc2)}
.sx-root button.sx-nm:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.sx-root .sx-nm .pn{overflow-wrap:anywhere}
.sx-root .ui-table td.hi{font-weight:700;color:#fff}.sx-root .ui-table td.lo{color:#ffffffa6}
.sx-root .pt .ta{display:none}
.sx-root .sx-live{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sx-root .sx-foot{display:flex;flex-direction:column;gap:6px;padding:2px 2px 8px}
.sx-root .sx-reset{min-height:40px}
.sx-root .sx-reset-row{margin-top:-4px;text-align:center}
.sx-csvbox{width:100%;min-height:220px;margin-top:10px;padding:10px;border-radius:12px;border:1px solid var(--hair2);background:#050a14;color:#fff;font:500 12px/1.4 var(--fmono)}
@media(max-width:640px){
 .sx-root .sx-opts{margin-left:0}
 .sx-root .sx-chip:not(.lbl) .lg{display:none}
 .sx-root .sx-chip.lbl b,.sx-root .sx-chip.lbl .lg{display:none}
 .sx-root .sx-chip.lbl .sh{display:inline}
 .sx-root .sx-chip{padding:0 14px}
 .sx-root .sx-filt{justify-content:flex-start}
 .sx-root .sx-q{flex:1 1 100%}.sx-root .sx-q input{flex:1;width:auto}
 .sx-root .sx-h{font-size:22px!important}
 .sx-root .pt .tf{display:none}.sx-root .pt .ta{display:inline}
 .sx-root .ui-table td:first-child{min-width:176px}
 .sx-root .ui-table .pn{font-size:12.5px}
}
@media(min-width:900px){.sx-root .ui-table td:first-child{min-width:240px;max-width:320px}}
.sx-root .sx-bar.fb .sx-sports{flex:1 0 100%}.sx-root .sx-bar.fb .sx-opts{margin-left:0}
`;
    document.head.appendChild(s);
  }

  // ---------- render ----------
  let seenP = null;
  function applyParams(prm) {
    // a plain menu click passes a fresh {} (nothing to apply); a goTab call's params apply once
    if (!prm || typeof prm !== 'object' || !Object.keys(prm).length || prm === seenP) return;
    seenP = prm;
    let sp = typeof prm.sport === 'string' ? prm.sport.toLowerCase().trim() : '';
    if (sp === 'college' || sp === 'cfb' || sp === 'college football') sp = 'ncaaf';
    if (SPORTS.includes(sp) && sp !== st.sport) setSport(sp);
    if (typeof prm.pos === 'string' && prm.pos.trim()) {
      const p = prm.pos.toLowerCase().trim(), V = VIEWS[st.sport];
      let hit = V.find(v => v.k === p || v.ab.toLowerCase() === p || v.label.toLowerCase() === p || v.title.toLowerCase() === p);
      if (!hit && ALIAS[p]) hit = V.find(v => v.k === ALIAS[p]) || (st.sport === 'nhl' && ALIAS[p] === 'def' ? V.find(v => v.k === 'd') : null);
      if (hit) { st.pos[st.sport] = hit.k; st.sort = null; }
    }
    remember();
  }
  function setSport(sp) { st.sport = sp; st.team = 'all'; st.vs = 'all'; st.q = ''; st.sort = null; }
  function render(main, params) {
    css(); needSeason(); applyParams(params);
    main.innerHTML = `<div class="ui-page sx-root" data-sx-sport="${esc(st.sport)}" data-sx-pos="${esc(viewOf(st.sport).k)}">
${U.page({ kicker: 'Stat explorer · this season', title: 'Season', accent: 'leaderboards', sub: "Every player and team from this season's box scores. Pick a position, sort any column, and split by opponent, home / away or the last few games." })}
${barHTML()}
<p class="sx-live" role="status" aria-live="polite"></p>
<section class="sx-out" aria-label="Table">${outHTML()}</section>
</div>`;
  }
  function paintOut() {
    const o = document.querySelector('#main .sx-root .sx-out'); if (!o) return;
    o.innerHTML = outHTML();
    const live = document.querySelector('#main .sx-root .sx-live'), M = SEAS_ST === 'ok' ? model() : null;
    if (live && M) live.textContent = M.rows.length ? `Showing ${M.shown.length} of ${M.rows.length} ${M.view.team ? 'teams' : 'players'}` : 'Nothing matches these filters';
    const r = document.querySelector('#main .sx-root .sx-filt'); const any = st.q || st.team !== 'all' || st.vs !== 'all' || st.ha !== 'all' || st.last > 0;
    if (r) { const b = r.querySelector('.sx-reset'); if (any && !b) r.insertAdjacentHTML('beforeend', '<button type="button" class="ui-link sx-reset" data-sx-reset="1">Clear filters</button>'); else if (!any && b) b.remove(); }
  }
  function rerender(sel) {
    SB.render();
    if (!sel) return;
    try { const el = document.querySelector('#main .sx-root ' + sel); if (el) el.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
  }
  const attrSel = (a, v) => `[${a}="${String(v).replace(/["\\]/g, '\\$&')}"]`;

  // ---------- CSV (copy; when the clipboard is blocked, a sheet with the text to copy by hand) ----------
  function csvText() {
    const M = model(); if (!M) return '';
    const q = s => { const t = String(s == null ? '' : s); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const head = ['Rank', M.view.team ? 'Team' : 'Player', 'Team', 'Pos', 'GP'].concat(M.cols.map(c => c.label));
    const lines = [head.map(q).join(',')];
    M.shown.forEach((r, i) => {
      const vals = M.cols.map(c => { const v = r[c.k]; if (!num(v)) return ''; if (c.kind === 'pct') return (Math.round(v * 1000) / 10).toFixed(1); if (c.kind === 'r2') return v.toFixed(2); if (c.kind === 'fp' || st.per) return (Math.round(v * 10) / 10).toFixed(1); return String(Math.round(v)); });
      lines.push([i + 1, r.n, r.team ? r.n : r.tn, r.team ? '' : r.pos, r.gp].concat(vals).map(q).join(','));
    });
    return lines.join('\n');
  }
  function copyCSV() {
    const txt = csvText(); if (!txt) return;
    const rows = txt.split('\n').length - 1;
    const sheet = () => {
      if (typeof SB.openSheet !== 'function') return;
      SB.openSheet(`<div class="sx-csvsheet"><h2 style="font:700 20px 'Rubik',sans-serif">Table as CSV</h2><p class="ui-muted">Copying is blocked here, so select the text below and copy it (${rows} rows).</p><textarea class="sx-csvbox" readonly aria-label="CSV text">${esc(txt)}</textarea></div>`, { label: 'Table as CSV' });
      setTimeout(() => { const t = document.querySelector('.sx-csvbox'); if (t) { try { t.focus(); t.select(); } catch (e) { /* ok */ } } }, 50);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => SB.toast && SB.toast(`Copied ${rows} rows as CSV`), sheet);
      else sheet();
    } catch (e) { sheet(); }
  }

  // ---------- events ----------
  document.addEventListener('click', ev => {
    const root = ev.target.closest && ev.target.closest('.sx-root'); if (!root) return;
    const t = ev.target.closest('button'); if (!t || !root.contains(t)) return;
    const pill = t.getAttribute('data-ui-pill');
    if (pill && pill.startsWith('sx-sport|')) { const k = pill.split('|')[1]; if (SPORTS.includes(k) && k !== st.sport) { setSport(k); remember(); } rerender(attrSel('data-ui-pill', pill)); return; }
    if (t.hasAttribute('data-sx-pos')) {
      const k = t.getAttribute('data-sx-pos');
      if (VIEWS[st.sport].some(v => v.k === k) && st.pos[st.sport] !== k) { st.pos[st.sport] = k; st.sort = null; remember(); }
      rerender(attrSel('data-sx-pos', k)); return;
    }
    const seg = t.getAttribute('data-ui-seg');
    if (seg && seg.startsWith('sx-scoring|')) { const k = seg.split('|')[1]; if (SCORE[k] != null || k === 'all') { st.scoring = k; remember(); } rerender(attrSel('data-ui-seg', seg)); return; }
    if (t.hasAttribute('data-sx-per')) { st.per = !st.per; remember(); rerender('[data-sx-per]'); return; }
    const so = t.getAttribute('data-ui-sort');
    if (so && so.startsWith('sx|')) {
      const k = so.slice(3);
      st.sort = st.sort && st.sort.k === k ? { k, dir: -st.sort.dir } : { k, dir: -1 };
      paintOut();
      try { const el = root.querySelector(attrSel('data-ui-sort', so)); if (el) el.focus({ preventScroll: true }); } catch (e) { /* ok */ }
      return;
    }
    if (t.hasAttribute('data-sx-player')) { SB.goTab('players', { name: t.getAttribute('data-sx-player'), sport: st.sport }); return; }
    if (t.hasAttribute('data-sx-csv')) { copyCSV(); return; }
    if (t.hasAttribute('data-sx-reset')) { st.q = ''; st.team = 'all'; st.vs = 'all'; st.ha = 'all'; st.last = 0; rerender('#sx-q'); }
  });
  document.addEventListener('change', ev => {
    const s = ev.target; if (!s || !s.matches || !s.matches('.sx-root select[data-ui-select]')) return;
    const n = s.getAttribute('data-ui-select'), v = s.value;
    if (n === 'sx-rows') { st.rows = [25, 50, 100, 0].includes(+v) ? +v : 50; remember(); }
    else if (n === 'sx-last') st.last = [0, 3, 5, 10].includes(+v) ? +v : 0;
    else if (n === 'sx-team') st.team = v === 'all' || opts(st.sport).team.some(x => x[0] === v) ? v : 'all';
    else if (n === 'sx-vs') st.vs = v === 'all' || opts(st.sport).opp.some(x => x[0] === v) ? v : 'all';
    else if (n === 'sx-ha') st.ha = ['all', 'home', 'away'].includes(v) ? v : 'all';
    else return;
    rerender(attrSel('data-ui-select', n));
  });
  document.addEventListener('input', ev => {
    const s = ev.target; if (!s || s.id !== 'sx-q' || !s.closest || !s.closest('.sx-root')) return;
    st.q = String(s.value || '').slice(0, 60); paintOut();
  });

  SB.registerTab({ key: KEY, label: 'Stat Explorer', render });
  // read-only hooks for tests
  window.__statx = { model, csvText, get state() { return JSON.parse(JSON.stringify(st)); }, get seasonState() { return SEAS_ST; } };
})();
