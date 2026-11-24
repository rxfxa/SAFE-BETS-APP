// propan.js: Prop Analyzer ('propan', docs/pro-interface.md screen 10) on the window.SB v2 API.
// Pick any player and market on the slate (DATA.players, plus NFL anytime touchdowns from the First TD model) and see in one view:
//  - the model's projection (engine.playerMeans: a normal game and a blowout, weighted by the blowout chance),
//  - its chance at the line (engine.playerP), the fair odds, and the edge against the viewer's own price when one is typed,
//  - his recent games against the line (season.json box scores; NBA joined with the last-4 box scores, else playerform's last 5),
//  - splits (season, last 5, home / away, vs this opponent, each with its sample size), four factor tiles and the full ladder.
// Line rule: lines are half points. Over L = ceil(L) or more (slip key P:<id>:<ceil(L)>); Under L = floor(L) or fewer
// (slip key U:<id>:<L>, which the engine prices as 1 − P(ceil(L)+)). So over + under = 1 at every line. A whole number N, from
// a param or typed into the box, is read as "N or more", i.e. the line N − 0.5: the same as the app's "N+" legs.
// There are no sportsbook prop prices in our feed: every chance here is a model estimate, shown with its fair odds.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('propan.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'propan';
  const num = x => typeof x === 'number' && isFinite(x);
  const pct = p => (num(p) ? Math.round(p * 100) + '%' : '—');
  const pct1 = p => (num(p) ? (Math.round(p * 1000) / 10).toFixed(1) + '%' : '—');
  const f1 = x => (num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const sg = x => (num(x) ? (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1) : '—');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const store = SB.store || { get: (k, d) => d, set() {} };
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const whenOf = g => tFmt.format(new Date(SB.startMs(g))) + ' PT';
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'College FB', nhl: 'NHL', soccer: 'Soccer' };
  const MKT = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', rec: 'Receptions', ryd: 'Rushing yards', recyd: 'Receiving yards', pyd: 'Passing yards', hpts: 'Points', sog: 'Shots on goal', sot: 'Shots on target', td: 'Anytime TD' };
  const UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'rec', ryd: 'yds', recyd: 'yds', pyd: 'yds', hpts: 'pts', sog: 'SOG', sot: 'SOT', td: 'TD' };
  const WORD = { pts: 'points', reb: 'rebounds', ast: 'assists', rec: 'receptions', ryd: 'rushing yards', recyd: 'receiving yards', pyd: 'passing yards', hpts: 'points', sog: 'shots on goal', sot: 'shots on target', td: 'touchdowns' };
  const MORDER = ['pts', 'reb', 'ast', 'rec', 'recyd', 'ryd', 'pyd', 'hpts', 'sog', 'sot', 'td'];
  const STEP = { pts: 1, reb: 1, ast: 1, rec: 1, hpts: 1, sog: 1, sot: 1, ryd: 5, recyd: 5, pyd: 5 };
  const TOT = { nba: 228, nfl: 44, ncaaf: 52 };   // the engine's league-average game totals (index.html TOTDEF)
  const TDMIN = 0.3;                               // anytime-TD props below this model chance stay off the empty-state top list
  const TOPN = 8;

  // ---------- the line rule (see the header) ----------
  function normLine(v) {
    v = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : +v;
    if (!num(v) || v <= 0) return null;
    return Number.isInteger(v) ? Math.max(0.5, v - 0.5) : Math.floor(v) + 0.5;
  }
  const fmtL = L => String(L);

  // ---------- state ----------
  const st = { pk: null, stat: null, line: null, under: false, price: '', sort: store.get('pa.sort', 'hit'), miss: null, q: '', sugI: 0 };
  if (st.sort !== 'hit' && st.sort !== 'mu') st.sort = 'hit';
  let seenP = null;
  const showing = () => SB.tab === KEY;

  // ---------- season.json game logs (loaded once, on first visit) ----------
  let SEAS = null, SEAS_ST = 'idle';
  function needSeason() {
    if (SEAS_ST !== 'idle') return;
    SEAS_ST = 'loading';
    Promise.resolve(typeof SB.season === 'function' ? SB.season() : null).then(d => { SEAS = d ? indexSeason(d) : null; SEAS_ST = SEAS ? 'ok' : 'none'; })
      .catch(() => { SEAS = null; SEAS_ST = 'none'; })
      .then(() => { TOP = null; if (showing()) SB.render(); });
  }
  function indexSeason(d) {
    if (!d || !d.sports) return null;
    const out = {};
    for (const [sp, S] of Object.entries(d.sports)) {
      if (!S || !Array.isArray(S.players) || !Array.isArray(S.fields)) continue;
      const fi = {}, ti = {}; S.fields.forEach((f, i) => { fi[f] = 3 + i; ti[f] = i; });
      const byName = new Map();
      for (const p of S.players) { if (!p || !p.n || !Array.isArray(p.log)) continue; const k = E.nameKey(p.n); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
      const teams = S.teams && !Array.isArray(S.teams) && typeof S.teams === 'object' ? S.teams : {};
      const byTeam = new Map(Object.entries(teams).map(([ab, nm]) => [E.nameKey(nm), ab]));
      out[sp] = { fi, ti, byName, teams, byTeam };
    }
    return out;
  }
  // feed team -> ESPN abbreviation (abbreviation first, then the team name)
  function espnAbbr(X, abbr, name) {
    if (!X) return null;
    const nk = E.nameKey(name), last = s => { const a = E.nameKey(s).split('-'); return a[a.length - 1]; };
    if (X.teams[abbr] && (!name || last(X.teams[abbr]) === last(name))) return abbr;
    if (nk && X.byTeam.has(nk)) return X.byTeam.get(nk);
    if (nk) for (const [k, ab] of X.byTeam) if (k.length > 4 && (k.startsWith(nk) || nk.startsWith(k))) return ab;
    return X.teams[abbr] ? abbr : abbr || null;
  }
  function seasonPlayer(sp, name, abbr, teamName) {
    const X = SEAS && SEAS[sp]; if (!X) return null;
    const c = X.byName.get(E.nameKey(name)); if (!c || !c.length) return null;
    const ab = espnAbbr(X, abbr, teamName);
    const same = c.find(p => p.t === ab); if (same) return same;
    // one player of that name: a pro who changed teams; college names repeat, so the team must match there
    return c.length === 1 && sp !== 'ncaaf' ? c[0] : null;
  }
  const fval = (X, row, f) => { const i = X.fi[f]; if (i == null) return null; const v = +row[i]; return num(v) ? v : null; };
  const tval = (X, P, f) => { const i = X.ti[f]; if (i == null || !Array.isArray(P.tot)) return null; const v = +P.tot[i]; return num(v) ? v : null; };
  const statTot = (X, P, stat) => (stat === 'td' ? (tval(X, P, 'rtd') || 0) + (tval(X, P, 'ctd') || 0) : stat === 'hpts' ? (tval(X, P, 'g') || 0) + (tval(X, P, 'a') || 0) : tval(X, P, stat));
  const statVal = (X, row, stat) => (stat === 'td' ? (fval(X, row, 'rtd') || 0) + (fval(X, row, 'ctd') || 0) : stat === 'hpts' ? (fval(X, row, 'g') || 0) + (fval(X, row, 'a') || 0) : fval(X, row, stat));

  // ---------- the First TD model (prices NFL anytime touchdowns) ----------
  let ftWait = false;
  const ftOk = () => { const F = window.__firsttd; return !!(F && F.FT); };
  function needFT() {
    const F = window.__firsttd;
    if (!F || F.FT || ftWait || typeof F.load !== 'function') return;
    ftWait = true;
    Promise.resolve(F.load()).then(() => { IDX = null; TOP = null; if (F.FT && showing()) SB.render(); }).catch(() => {});
  }

  // ---------- injuries ----------
  let INJX = null, INJD = null;
  function injOf(sp, team, name, pl) {
    const F = window.__firsttd;
    if (sp === 'nfl' && F && F.INJ && typeof F.INJ.get === 'function' && typeof E.tdSlug === 'function') {
      const s = F.INJ.get(team + '|' + E.tdSlug(name).replace(/-/g, ' ')); if (s && s.status) return { status: s.status, injury: s.note || '' };
    }
    const I = E.injuries;
    if (INJD !== I || !INJX) { INJD = I; INJX = new Map(); for (const x of (I && Array.isArray(I.injuries) ? I.injuries : [])) if (x && x.player) { const k = x.sport + '|' + E.nameKey(x.player); if (!INJX.has(k)) INJX.set(k, []); INJX.get(k).push(x); } }
    const c = INJX.get(sp + '|' + E.nameKey(name)) || [];
    const hit = c.find(x => x.team === team) || (c.length === 1 ? c[0] : null);
    if (hit) return { status: String(hit.status || ''), injury: hit.injury || '' };
    if (pl && pl.status && pl.status !== 'active') return { status: pl.note || pl.status, injury: '' };
    return null;
  }
  const isOut = inj => !!(inj && /^out\b/i.test(String(inj.status || '')));

  // ---------- the slate: one entry per player per open game ----------
  let IDX = null;
  function slate() {
    const D = SB.DATA || {}, ft = ftOk();
    if (IDX && IDX.data === D && IDX.ft === ft) return IDX;
    const people = new Map();
    const entry = (g, team, name) => {
      const pk = g.id + '|' + team + '|' + E.nameKey(name);
      let p = people.get(pk);
      if (!p) {
        const home = g.home.abbr === team, me = home ? g.home : g.away, op = home ? g.away : g.home;
        p = { pk, name, team, teamName: me.name, opp: op.abbr, oppName: op.name, home, gid: g.id, g, sp: g.sport, start: SB.startMs(g), stats: {}, td: null, pos: '' };
        people.set(pk, p);
      }
      return p;
    };
    for (const pl of D.players || []) {
      if (!pl || !E.LADDER[pl.stat]) continue;
      const g = SB.gameById(pl.gid); if (!g || !SB.openG(g) || (g.home.abbr !== pl.team && g.away.abbr !== pl.team)) continue;
      const p = entry(g, pl.team, pl.name);
      if (!p.stats[pl.stat]) p.stats[pl.stat] = pl;    // the first record wins (posted props come before season estimates)
      if (!p.pos && pl.pos) p.pos = pl.pos;
    }
    const T = E.nflByTd;
    if (ft && T && typeof T.entries === 'function') {
      for (const g of D.games || []) {
        if (g.sport !== 'nfl' || !SB.openG(g)) continue;
        for (const me of [g.home, g.away]) for (const [k, v] of T) {
          if (!k.startsWith(me.abbr + '|')) continue;
          const slug = k.slice(me.abbr.length + 1), name = (v && v.name) || slug, key = `TD:A:${me.abbr}:${slug}`;
          let p0 = 0; try { p0 = SB.p1(g, key); } catch (e) { p0 = 0; }
          if (!(p0 > 0) || p0 >= 0.995) continue;
          const p = entry(g, me.abbr, name); p.td = { key, slug }; if (!p.pos && v && v.pos) p.pos = v.pos;
        }
      }
    }
    const nflpos = D.nflpos instanceof Map ? D.nflpos : null;
    for (const p of people.values()) if (!p.pos && nflpos) p.pos = nflpos.get(p.team + '|' + E.nameKey(p.name)) || '';
    const list = [...people.values()].filter(p => markets(p).length).sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : 1));
    IDX = { data: D, ft, people, list };
    return IDX;
  }
  const markets = p => MORDER.filter(s => (s === 'td' ? !!p.td : !!p.stats[s]));
  const tdP = p => { if (!p.td) return null; let x = 0; try { x = SB.p1(p.g, p.td.key); } catch (e) { x = 0; } return x > 0 ? x : null; };
  function overAt(p, stat, line) {
    if (stat === 'td') return tdP(p);
    const pl = p.stats[stat]; if (!pl) return null;
    return E.playerP(pl, Math.ceil(line));
  }
  function chance(p, stat, line, under) { const o = overAt(p, stat, line); return o == null ? null : under ? 1 - o : o; }
  function legKey(p, stat, line, under) {
    if (stat === 'td') return under ? null : p.td.key;   // the app has no "no touchdown" leg
    const id = p.stats[stat].id;
    return under ? `U:${id}:${fmtL(line)}` : `P:${id}:${Math.ceil(line)}`;
  }
  // the ladder line nearest a 65% chance (the line Insights shows on its card for the same prop)
  function defaultLine(p, stat) {
    if (stat === 'td') return 0.5;
    const pl = p.stats[stat], L = E.LADDER[stat] || [1];
    const rows = L.map(t => ({ t, p: E.playerP(pl, t) })), inR = rows.filter(r => r.p >= 0.5 && r.p <= 0.97);
    const best = (inR.length ? inR : rows).reduce((a, b) => (Math.abs(b.p - 0.65) < Math.abs(a.p - 0.65) ? b : a));
    return best.t - 0.5;
  }
  function projOf(p, stat) {
    if (stat === 'td') { const x = tdP(p); return x != null && x < 1 ? { v: -Math.log(1 - x), td: true } : null; }
    let M = null; try { M = E.playerMeans(p.stats[stat]); } catch (e) { M = null; }
    if (!M || !num(M.an)) return null;
    return { v: (1 - M.pb) * M.an + M.pb * M.ab, M };
  }
  function posOf(p, P) { return p.pos || (P && P.pos) || ''; }
  // matchup score (0-100, an estimate): 50 + 250·(tf − 1) − 60·max(0, pb − 0.15); unknown without a game price
  function matchupOf(g, team) {
    let c = null; try { c = E.teamCtx(g, team); } catch (e) { c = null; }
    if (!c || !num(c.tf)) return null;
    const pb = num(c.pb) ? c.pb : 0, s = Math.round(clamp(50 + 250 * (c.tf - 1) - 60 * Math.max(0, pb - 0.15), 0, 100));
    return { s, c, label: s >= 60 ? 'Soft matchup' : s < 40 ? 'Tough' : 'Neutral' };
  }

  // ---------- his games before this one, oldest first: [{d, o, h, v, row}] ----------
  // Box-score logs (season.json, nbalast4.json) are dated by the game's UTC start date, not the Los Angeles day (a 4 PM PT game
  // on Nov 22 is logged 2026-11-23). So a logged game counts when its date is before the priced game's UTC date and not after
  // today's UTC date; cutting at the LA day would drop last night's game for a team on a back-to-back.
  const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
  function cutOf(g) { const gd = utcDay(SB.startMs(g)), nd = utcDay(Date.now()); return d => { d = String(d); return d < gd && d <= nd; }; }
  function logOf(p, stat) {
    const ok = cutOf(p.g), X = SEAS && SEAS[p.sp];
    const P = seasonPlayer(p.sp, p.name, p.team, p.teamName);
    const by = new Map(); let src = '';
    if (P && X) {
      for (const r of P.log) {
        if (!Array.isArray(r) || !ok(r[0])) continue;
        if (p.sp === 'nba' && !((fval(X, r, 'min') || 0) > 0)) continue;   // a DNP is not a game played
        const v = statVal(X, r, stat); if (num(v)) by.set(r[0], { d: r[0], o: String(r[1] || ''), h: r[2] === 1 ? 1 : r[2] === 0 ? 0 : null, v, row: r });
      }
      if (by.size) src = 'ESPN box scores';
    }
    if (p.sp === 'nba' && (stat === 'pts' || stat === 'reb' || stat === 'ast')) {
      let L = null; try { L = E.last4Of(p.team, p.name); } catch (e) { L = null; }
      if (L && Array.isArray(L.rows)) for (const r of L.rows) if (r && !r.dnp && num(r[stat]) && ok(r.date) && !by.has(r.date)) by.set(r.date, { d: r.date, o: String(r.opp || ''), h: null, v: r[stat], row: null, min: r.min });
      if (by.size && !src) src = 'ESPN box scores (last 4)';
    }
    let rows = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (!rows.length && stat !== 'td' && p.stats[stat]) {
      let rf = null; try { rf = E.recentOf(p.stats[stat]); } catch (e) { rf = null; }
      if (rf && Array.isArray(rf.last5)) { rows = rf.last5.map((v, i) => ({ d: null, o: String((rf.opp5 || [])[i] || ''), h: null, v: +v, row: null })).filter(x => num(x.v)); src = 'the morning form check'; }
    }
    return { rows, src, P, X, oppE: X ? espnAbbr(X, p.opp, p.oppName) : null };
  }

  // ---------- the analysis of one prop ----------
  function verdictOf(p, dec) {
    if (!num(p)) return null;
    if (num(dec) && dec > 1) {
      const imp = 1 / dec, edge = (p - imp) * 100;
      if (edge >= 3 && p >= 0.5) return { tone: 'take', title: 'Take this bet', edge, imp };
      if (edge >= 0) return { tone: 'lean', title: 'Lean', edge, imp };
      return { tone: 'pass', title: 'Pass', edge, imp };
    }
    if (p >= 0.7) return { tone: 'take', title: 'Strong lean' };
    if (p >= 0.58) return { tone: 'lean', title: 'Lean' };
    if (p >= 0.45) return { tone: 'coin', title: 'Coin flip' };
    return { tone: 'pass', title: 'Long shot' };
  }
  function parsePrice(s) {
    s = String(s || '').trim(); if (!s) return null;
    if (/^\d{1,2}$/.test(s)) return NaN;   // "50" is not an American price (parseOdds would read it as decimal 50.0)
    let d = null; try { d = SB.parseOdds(s, 'american'); } catch (e) { d = null; }
    return num(d) && d > 1.001 && d < 1001 ? d : NaN;
  }
  const amOf = dec => (num(dec) && dec > 1 ? SB.fmtAm(SB.dec2am(dec)) : '—');
  const FLIPS = { 'Soft matchup': 'Soft matchup (hurts the under)', Tough: 'Tough (helps the under)', Hot: 'Hot (hurts the under)', Cold: 'Cold (helps the under)', Rising: 'Rising (hurts the under)', Falling: 'Falling (helps the under)', 'Close game': 'Close game (hurts the under)', 'Blowout risk': 'Blowout risk (helps the under)', Favored: 'Favored (hurts the under)', Underdog: 'Underdog (helps the under)' };
  function factorsOf(p, stat, line, under, L, pl) {
    const F = [], td = stat === 'td', g = p.g, sp = p.sp, rows = L.rows;
    const mu = matchupOf(g, p.team);
    if (mu && TOT[sp]) {
      let m = null; try { m = SB.fit(g); } catch (e) { m = null; }
      const tp = m && num(m.T) ? (m.T + mu.c.mu) / 2 : null, avg = TOT[sp] / 2;
      F.push({ name: 'Matchup', tone: mu.s >= 60 ? 'good' : mu.s < 40 ? 'bad' : 'mid', status: mu.label,
        why: `${p.team} are expected to score ${f1(tp)} points from the game's price (total and spread), ${sg(((tp || avg) / avg - 1) * 100)}% vs a typical team (${f1(avg)}). Matchup score ${mu.s} of 100, a model estimate${mu.c.gen ? '; with no posted total, a league-average total is used' : ''}.` });
    } else {
      F.push({ name: 'Matchup', tone: 'mid', status: 'Unknown', why: `The feed has no price for ${g.away.abbr} @ ${g.home.abbr} yet, so ${p.team}'s expected points are unknown. ${td ? 'The touchdown model uses a near-even game.' : `The chance uses his season average${pl && E.recentOf(pl) ? ' and recent form (30%)' : ''} only.`}` });
    }
    // Trends: his last 5 against his season
    if (rows.length) {
      const l5 = rows.slice(-5), r5 = mean(l5.map(x => x.v));
      if (td) {
        const rr = l5.filter(x => x.v >= 1).length / l5.length, sr = rows.filter(x => x.v >= 1).length / rows.length;
        const tone = rows.length > l5.length ? (rr >= sr + 0.15 ? 'good' : rr <= sr - 0.15 ? 'bad' : 'mid') : 'mid';
        F.push({ name: 'Trends', tone, status: tone === 'good' ? 'Hot' : tone === 'bad' ? 'Cold' : 'Steady', why: `A touchdown in ${l5.filter(x => x.v >= 1).length} of his last ${l5.length} games vs ${rows.filter(x => x.v >= 1).length} of ${rows.length} this season (${L.src}; a small sample).` });
      } else {
        const s = rows.length > l5.length ? mean(rows.map(x => x.v)) : pl && num(pl.avg) ? pl.avg : null;
        const rel = s ? r5 / s : 1, tone = rel >= 1.1 ? 'good' : rel <= 0.9 ? 'bad' : 'mid';
        F.push({ name: 'Trends', tone, status: tone === 'good' ? 'Hot' : tone === 'bad' ? 'Cold' : 'Steady', why: `Last ${l5.length} games: ${f1(r5)} ${WORD[stat]} a game${s != null ? ` vs ${f1(s)} ${rows.length > l5.length ? `over his ${rows.length} games` : 'season average (feed)'} (${sg(r5 - s)})` : ''}. ${l5.length} games is a small sample.` });
      }
    } else F.push({ name: 'Trends', tone: 'mid', status: 'No recent games', why: `No recent box scores for ${p.name} in the app's data.` });
    // Game script: the team's result for touchdowns and rushing; blowout / close-game risk for the rest
    let c = null; try { c = E.teamCtx(g, p.team); } catch (e) { c = null; }
    if (td || stat === 'ryd') {
      const pw = SB.priced(g) ? SB.p1(g, p.home ? 'H' : 'A') : null;
      if (num(pw)) F.push({ name: 'Game script', tone: pw >= 0.6 ? 'good' : pw <= 0.4 ? 'bad' : 'mid', status: pw >= 0.6 ? 'Favored' : pw <= 0.4 ? 'Underdog' : 'Even game',
        why: `${p.team} win chance ${pct(pw)} from the feed's price. Teams that lead tend to run more; backs' yards and touchdowns moved with their team's win in this season's box scores.` });
      else F.push({ name: 'Game script', tone: 'mid', status: 'Unknown', why: `No price for this game in the feed yet, so the app can't say whether ${p.team} are likely to lead.` });
    } else {
      const pb = c ? c.pb : null; let cl = null; try { cl = E.closeOf(g); } catch (e) { cl = null; }
      const bl = (E.BLOW || {})[sp];
      if (pb == null && !cl) F.push({ name: 'Game script', tone: 'mid', status: 'Unknown', why: 'No price for this game in the feed yet, so blowout and close-game chances are unknown.' });
      else {
        const bench = pl && pl.mpg > 0 && pl.mpg < 20;
        const tone = pb != null && pb >= 0.25 ? (bench ? 'good' : 'bad') : cl && cl.p >= 0.45 ? 'good' : 'mid';
        const status = pb != null && pb >= 0.25 ? 'Blowout risk' : cl && cl.p >= 0.45 ? 'Close game' : 'Neutral';
        const parts = [];
        if (pb != null && bl) parts.push(`Blowout chance ${pct(pb)} (a ${bl}+ point margin in the game's simulations); ${bench ? 'bench players get more minutes' : 'starters sit late'} in those, and the projection counts it.`);
        if (cl && num(cl.p)) parts.push(`Chance it stays within 8: ${pct(cl.p)} (${cl.src === 'model' ? 'model' : 'from Polymarket'}).`);
        F.push({ name: 'Game script', tone, status, why: parts.join(' ') || 'No blowout or close-game read for this game.' });
      }
    }
    // Usage: minutes, touches, targets or attempts, recent vs season
    const X = L.X, pos = String(posOf(p, L.P) || '').toUpperCase();
    let uf = null, ul = null;
    if (sp === 'nba') { uf = ['min']; ul = 'Minutes'; }
    else if (sp === 'nfl' || sp === 'ncaaf') { if (td || pos === 'RB' || stat === 'ryd') { uf = ['ra', 'tgt']; ul = 'Touches (carries + targets)'; } else if (pos === 'QB' || stat === 'pyd') { uf = ['pa']; ul = 'Pass attempts'; } else { uf = ['tgt']; ul = 'Targets'; } }
    const sr = X ? rows.filter(x => x.row) : [];
    if (uf && X && sr.length >= 2) {
      const sum = r => uf.reduce((s, f) => s + (fval(X, r.row, f) || 0), 0);
      const rec = sr.slice(-3), r = mean(rec.map(sum)), s = mean(sr.map(sum)), rel = s ? r / s : 1, tone = rel >= 1.1 ? 'good' : rel <= 0.9 ? 'bad' : 'mid';
      F.push({ name: 'Usage', tone, status: tone === 'good' ? 'Rising' : tone === 'bad' ? 'Falling' : 'Steady', why: `${ul}: ${f1(r)} a game in his last ${rec.length} vs ${f1(s)} over his ${sr.length} games (ESPN box scores).` });
    } else if (sp === 'nba' && pl && num(pl.mpg) && pl.mpg > 0) {
      let l4 = null; try { l4 = E.last4Of(p.team, p.name); } catch (e) { l4 = null; }
      const mins = l4 ? l4.rows.filter(r => !r.dnp && r.min > 0).map(r => r.min) : [];
      if (mins.length) { const r = mean(mins), rel = r / pl.mpg, tone = rel >= 1.08 ? 'good' : rel <= 0.92 ? 'bad' : 'mid'; F.push({ name: 'Usage', tone, status: tone === 'good' ? 'Rising' : tone === 'bad' ? 'Falling' : 'Steady', why: `Minutes: ${f1(r)} a game in his last ${mins.length} vs ${f1(pl.mpg)} this season.` }); }
      else F.push({ name: 'Usage', tone: 'mid', status: 'Steady', why: `Minutes: ${f1(pl.mpg)} a game this season; no recent box scores in the app's data.` });
    } else F.push({ name: 'Usage', tone: 'mid', status: 'Unknown', why: `No usage numbers for ${p.name} in the app's box scores.` });
    if (!under) return F;
    return F.map(f => ({ ...f, tone: f.tone === 'good' ? 'bad' : f.tone === 'bad' ? 'good' : 'mid', status: FLIPS[f.status] || f.status }));
  }
  function splitsOf(L, line, under, pl, stat) {
    const hit = v => (under ? v < line : v > line), rows = L.rows, out = [];
    const mk = (label, rs, extra) => ({ label, n: rs.length, avg: mean(rs.map(r => r.v)), h: rs.filter(r => hit(r.v)).length, extra });
    // season.json keeps every football game but only the last 15 for the NBA, NHL and soccer; its totals cover the whole season
    const P = L.P, X = L.X, sea = !!(P && X && L.src === 'ESPN box scores'), trunc = sea && P.gp > P.log.length;
    if (sea && trunc) { const t = statTot(X, P, stat); if (num(t) && P.gp > 0) out.push({ label: 'Season', n: P.gp, avg: t / P.gp, h: null, extra: null }); out.push(mk(`Last ${rows.length}`, rows)); }
    else if (rows.length) out.push(mk(sea ? 'Season' : `Last ${rows.length}`, rows));
    else if (pl && num(pl.avg)) out.push({ label: 'Season', n: null, avg: pl.avg, h: null, extra: 'feed average' });
    if (rows.length > 5) out.push(mk('Last 5', rows.slice(-5)));
    if (rows.length > 10) out.push(mk('Last 10', rows.slice(-10)));
    const hm = rows.filter(r => r.h === 1), aw = rows.filter(r => r.h === 0);
    if (hm.length) out.push(mk('Home', hm));
    if (aw.length) out.push(mk('Away', aw));
    if (L.oppE) { const vs = rows.filter(r => r.o === L.oppE); if (vs.length) out.push(mk('vs ' + L.oppE, vs)); }
    return out;
  }
  function analyze(p, stat, line, under, priceStr) {
    const td = stat === 'td', pl = td ? null : p.stats[stat];
    const P = chance(p, stat, line, under), over = overAt(p, stat, line);
    const L = logOf(p, stat), pr = projOf(p, stat), dec = parsePrice(priceStr);
    const V = verdictOf(P, num(dec) ? dec : null);
    const inj = injOf(p.sp, p.team, p.name, pl);
    return { p, stat, td, pl, line, under, P, over, L, pr, dec, V, inj, key: legKey(p, stat, line, under), mu: matchupOf(p.g, p.team), pos: posOf(p, L.P) };
  }

  // ---------- the top props on the slate (the empty state) ----------
  let TOP = null;
  function topProps() {
    const X = slate(), ck = X.data === (TOP && TOP.data) && X.ft === TOP.ft && SEAS_ST === TOP.seas && st.sort === TOP.sort;
    if (TOP && ck) return TOP.list;
    const today = E.dayOf(Date.now()), days = new Set([today, E.nextDay(today)]);
    const best = [];
    for (const p of X.list) {
      if (!days.has(E.dayOf(p.start))) continue;
      let top = null;
      for (const stat of markets(p)) {
        const pl = stat === 'td' ? null : p.stats[stat];
        if (isOut(injOf(p.sp, p.team, p.name, pl))) break;
        const line = defaultLine(p, stat), ch = chance(p, stat, line, false);
        if (!num(ch) || (stat === 'td' ? ch < TDMIN : ch < 0.5 || ch > 0.97)) continue;
        const L = logOf(p, stat), l10 = L.rows.slice(-10), h = l10.filter(r => r.v > line).length;
        const rate = l10.length >= 5 ? h / l10.length : null, mu = matchupOf(p.g, p.team);
        const it = { p, stat, line, ch, hits: l10.map(r => r.v > line), h, n: l10.length, rate, mu };
        const sc = st.sort === 'mu' ? [mu ? mu.s : -1, ch] : [rate == null ? -1 : rate + ((E.STAT_PREF || {})[stat] || 0), ch];
        it.sc = sc;
        if (!top || sc[0] > top.sc[0] || (sc[0] === top.sc[0] && sc[1] > top.sc[1])) top = it;
      }
      if (top) best.push(top);
    }
    best.sort((a, b) => b.sc[0] - a.sc[0] || b.sc[1] - a.sc[1] || a.p.start - b.p.start);
    TOP = { data: X.data, ft: X.ft, seas: SEAS_ST, sort: st.sort, list: best.slice(0, TOPN) };
    return TOP.list;
  }

  // ---------- params ----------
  function applyParams(prm) {
    if (!prm || typeof prm !== 'object' || !Object.keys(prm).length || seenP === prm) return;
    seenP = prm; st.miss = null; st.price = '';
    const X = slate();
    if (typeof prm.id === 'string' && prm.id) {
      const pl = E.playerById(prm.id), p = pl && X.list.find(x => x.stats[pl.stat] && x.stats[pl.stat].id === pl.id);
      if (!p) { st.pk = null; st.miss = pl ? `${pl.name}'s game is no longer open` : 'That prop is not on the slate'; return; }
      select(p, pl.stat, prm.line, !!prm.under); return;
    }
    if (typeof prm.name === 'string' && prm.name.trim()) {
      const nk = E.nameKey(prm.name), stat = typeof prm.stat === 'string' ? prm.stat : null;
      let c = X.list.filter(x => E.nameKey(x.name) === nk);
      if (prm.gid) { const c2 = c.filter(x => x.gid === prm.gid); if (c2.length) c = c2; }
      if (prm.team) { const c2 = c.filter(x => x.team === prm.team); if (c2.length) c = c2; }
      const p = c.find(x => stat && markets(x).includes(stat)) || c[0];
      if (!p) { st.pk = null; st.miss = `${prm.name} has no prop on the slate right now`; return; }
      select(p, stat && markets(p).includes(stat) ? stat : null, prm.line, !!prm.under);
    }
  }
  function select(p, stat, line, under) {
    const M = markets(p);
    st.pk = p.pk; st.stat = stat && M.includes(stat) ? stat : M[0];
    st.under = st.stat === 'td' ? false : !!under;
    const L = line != null ? normLine(line) : null;
    st.line = st.stat === 'td' ? 0.5 : L != null ? L : defaultLine(p, st.stat);
    st.q = p.name; st.miss = null;
  }
  const current = () => { if (!st.pk) return null; const p = slate().people.get(st.pk); return p && markets(p).includes(st.stat) ? p : null; };

  // ---------- search ----------
  function searchList(q) {
    const nk = E.nameKey(q); if (!nk) return [];
    const out = [];
    for (const p of slate().list) {
      const k = E.nameKey(p.name), i = k.indexOf(nk);
      if (i < 0) continue;
      out.push({ p, s: (i === 0 ? 0 : k[i - 1] === '-' ? 1 : 2) });
    }
    out.sort((a, b) => a.s - b.s || a.p.start - b.p.start || (a.p.name < b.p.name ? -1 : 1));
    return out.slice(0, 8).map(x => x.p);
  }
  const optId = i => 'pa-o-' + i;
  function sugHTML(list) {
    if (!list.length) return `<div class="pa-none">No player on the slate matches. Coverage: NBA, NFL and college football props in our feed.</div>`;
    return list.map((p, i) => `<div class="pa-opt" role="option" id="${optId(i)}" aria-selected="${i === st.sugI}" data-pa-pick="${esc(p.pk)}">${U.team(p.team)}<span><b>${esc(p.name)}</b><small>${esc(SPN[p.sp] || p.sp)} · ${esc(p.home ? 'vs' : '@')} ${esc(p.opp)} · ${esc(whenOf(p.g))} · ${esc(markets(p).map(s => MKT[s]).join(', '))}</small></span></div>`).join('');
  }
  let SUG = [];
  function showSug(root, q) {
    const box = root.querySelector('#pa-sug'), inp = root.querySelector('#pa-q'); if (!box || !inp) return;
    SUG = searchList(q); st.sugI = 0;
    if (!String(q || '').trim()) { box.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); return; }
    box.innerHTML = sugHTML(SUG); box.hidden = false; inp.setAttribute('aria-expanded', 'true');
    if (SUG.length) inp.setAttribute('aria-activedescendant', optId(0)); else inp.removeAttribute('aria-activedescendant');
  }
  function moveSug(root, d) {
    if (!SUG.length) return;
    st.sugI = (st.sugI + d + SUG.length) % SUG.length;
    root.querySelectorAll('#pa-sug .pa-opt').forEach((o, i) => o.setAttribute('aria-selected', String(i === st.sugI)));
    const inp = root.querySelector('#pa-q'); if (inp) inp.setAttribute('aria-activedescendant', optId(st.sugI));
    const o = root.querySelector('#' + optId(st.sugI)); if (o && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
  }

  // ---------- module styles (injected once) ----------
  function css() {
    if (document.getElementById('propan-css')) return;
    const s = document.createElement('style'); s.id = 'propan-css';
    s.textContent = `
.pa-root .pa-q{display:flex;flex-direction:column;gap:12px;padding:14px}
.pa-root .pa-sbox{position:relative}
.pa-root .pa-in{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 6px 0 16px;border:1px solid var(--hair2);border-radius:999px;background:rgba(255,255,255,.03)}
.pa-root .pa-in:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--acc-rgb),.18)}
.pa-root .pa-in svg{flex:none;color:#ffffff99}
.pa-root .pa-in input{flex:1;min-width:0;height:50px;border:0;background:none;color:#fff;font:500 16px var(--fui);outline:none}
.pa-root .pa-in input::placeholder{color:#ffffff73}
.pa-root .pa-in .pa-x{flex:none;width:40px;height:40px;border-radius:50%;border:0;background:rgba(255,255,255,.06);color:#fff;font:600 16px var(--fui);cursor:pointer}
.pa-root .pa-sug{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 6px);max-height:min(60vh,430px);overflow:auto;padding:6px;border:1px solid var(--hair2);border-radius:18px;background:#0a101c;box-shadow:0 24px 60px -18px #000}
.pa-root .pa-opt{display:flex;align-items:center;gap:12px;min-height:52px;padding:6px 10px;border-radius:12px;cursor:pointer}
.pa-root .pa-opt[aria-selected="true"],.pa-root .pa-opt:hover{background:rgba(var(--acc-rgb),.12)}
.pa-root .pa-opt>span{min-width:0}
.pa-root .pa-opt b{display:block;font:600 15px var(--fui)}
.pa-root .pa-opt small{display:block;font:500 12px/1.35 var(--fui);color:#ffffff99}
.pa-root .pa-none{padding:14px;font:400 13.5px/1.45 var(--fui);color:#ffffffa6}
.pa-root .pa-ctl{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px}
.pa-root .pa-ctl>.ui-sel,.pa-root .pa-ctl>.pa-price{grid-column:1/-1}
.pa-root .pa-step input{flex:1 1 auto;min-width:0}
@media(max-width:430px){.pa-root .pa-step .l{display:none}.pa-root .pa-step input{width:52px}}
.pa-root .pa-step{display:inline-flex;align-items:center;min-height:42px;border:1px solid var(--hair2);border-radius:12px;background:rgba(255,255,255,.03)}
.pa-root .pa-step .l{padding:0 4px 0 12px;font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.pa-root .pa-step button{width:42px;height:42px;border:0;background:none;color:#fff;font:600 21px/1 var(--fui);cursor:pointer;border-radius:10px}
.pa-root .pa-step button:hover{background:rgba(255,255,255,.06)}.pa-root .pa-step button:disabled{opacity:.35;cursor:default}
.pa-root .pa-step input{width:66px;height:40px;text-align:center;border:0;background:none;color:#fff;font:700 16px var(--fui);font-variant-numeric:tabular-nums}
.pa-root .pa-price{display:inline-flex;align-items:center;gap:8px;min-height:42px;padding:0 4px 0 12px;border:1px solid var(--hair2);border-radius:12px;background:rgba(255,255,255,.03)}
.pa-root .pa-price:focus-within,.pa-root .pa-step:focus-within{border-color:var(--acc)}
.pa-root .pa-price .l{font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80;white-space:nowrap}
.pa-root .pa-price input{flex:1 1 auto;width:84px;height:40px;border:0;background:none;color:#fff;font:700 16px var(--fui)}
.pa-root .pa-price input::placeholder{color:#ffffff59;font-weight:500}
.pa-root .pa-meaning{font:500 13px var(--fui);color:#ffffffa6}
.pa-root .pa-meaning b{color:#fff}
.pa-root .pa-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
.pa-root .pa-col{display:flex;flex-direction:column;gap:14px;min-width:0}
@media(min-width:1100px){.pa-root .pa-grid{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}}
.pa-root .pa-hero{padding:0;overflow:hidden}
.pa-root .pa-hd{display:flex;gap:14px;align-items:center;padding:16px;background:linear-gradient(135deg,hsl(var(--h) 60% 22%),#0b1220 72%)}
.pa-root .pa-hd>div{min-width:0}
.pa-root .pa-nm{font:800 26px/1.05 'Rubik',sans-serif;letter-spacing:-.01em;overflow-wrap:anywhere}
.pa-root .pa-mu{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;font:600 13px var(--fui);color:#ffffffcc}
.pa-root .pa-mu .pos{display:inline-grid;place-items:center;min-width:28px;height:20px;padding:0 6px;border-radius:6px;background:rgba(255,255,255,.14);font:800 10.5px var(--fui)}
.pa-root .pa-mk{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 14px 0;padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--hair)}
.pa-root .pa-mk .t{font:700 19px/1.15 'Rubik',sans-serif;min-width:0}.pa-root .pa-mk .t em{font-style:normal;color:var(--acc2)}
.pa-root .pa-mk .odds{flex:none;padding:4px 10px;border-radius:999px;background:rgba(var(--acc-rgb),.14);color:var(--acc2);font:800 14px var(--fui);font-variant-numeric:tabular-nums}
.pa-root .pa-nums{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px 16px 16px}
.pa-root .pa-nums .ui-big{font-size:40px;margin-top:6px}
.pa-root .pa-nums p{margin-top:6px;font:500 12.5px/1.45 var(--fui);color:#ffffffa6}
.pa-root .pa-px{padding:0 16px 16px}
.pa-root .pa-inj{margin:0 16px 16px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,184,0,.4);background:rgba(255,184,0,.08);font:500 13px/1.45 var(--fui);color:#ffe2a3}
.pa-root .pa-verd p{margin-top:8px;font:400 13.5px/1.5 var(--fui);color:#ffffffbf}
.pa-root .pa-h3{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 10px;font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.pa-root .pa-h3 b{font:600 12.5px var(--fui);letter-spacing:0;text-transform:none;color:var(--acc2)}
.pa-root .pa-splits{display:grid;grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:10px}
.pa-root .pa-sp{padding:12px 13px;border-radius:14px;border:1px solid var(--hair2);background:rgba(255,255,255,.03);min-width:0}
.pa-root .pa-sp .ui-lbl{display:block}
.pa-root .pa-sp b{display:block;margin-top:6px;font:700 21px 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.pa-root .pa-sp b small{font:600 11px var(--fui);color:#ffffff80;margin-left:3px}
.pa-root .pa-sp span.r{display:block;margin-top:4px;font:600 12px var(--fui)}
.pa-root .pa-sp span.n{display:block;margin-top:2px;font:500 11.5px var(--fui);color:#ffffff80}
.pa-root .pa-act{display:flex;flex-wrap:wrap;gap:8px}.pa-root .pa-act>*{flex:1 1 auto}
@media(min-width:700px){.pa-root .pa-act>*{flex:0 1 auto}.pa-root .pa-ctl{display:flex;flex-wrap:wrap}}
.pa-root .pa-lb{all:unset;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;min-height:40px;justify-content:center;text-align:left}
.pa-root .pa-lb .a{font:700 14px var(--fui);color:#fff}.pa-root .pa-lb .b{font:600 10.5px var(--fmono);letter-spacing:.1em;color:#ffffff80}
.pa-root .pa-lb:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
/* the app's older .hit (pill) and .bar (strip) rules also match ui.js's game-log bars: undo them here */
.pa-root .ui-log .b{padding:0;border-radius:0;box-shadow:none;background:none;font:inherit;white-space:normal}
.pa-root .ui-log .bar{display:block;margin:0}
.pa-root tr.cur td{background:rgba(var(--acc-rgb),.1)!important}
.pa-root tr.cur .pa-lb .a{color:var(--acc2)}
.pa-root .pa-notice{padding:12px 14px;border-radius:14px;border:1px solid rgba(255,184,0,.4);background:rgba(255,184,0,.07);font:500 13.5px/1.45 var(--fui);color:#ffe2a3}
.pa-root .pa-honest{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid rgba(var(--acc-rgb),.26);border-radius:14px;background:rgba(var(--acc-rgb),.06);font:400 13px/1.5 var(--fui);color:#ffffffcc}
.pa-root .pa-honest .i{flex:none;width:20px;height:20px;margin-top:1px;border-radius:50%;display:grid;place-items:center;background:rgba(var(--acc-rgb),.18);color:var(--acc2);font:800 12px var(--fui)}
.pa-root .pa-top{padding:16px 14px 10px}
.pa-root .pa-tophd{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.pa-root .pa-tophd .ui-lbl{color:#ffffffcc;letter-spacing:.2em}
.pa-root .pa-cols{display:none}
.pa-root .pa-trow{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:44px minmax(0,1fr) auto;grid-template-areas:"tm who hit" "dots dots mu";gap:6px 12px;align-items:center;width:100%;margin-top:10px;padding:12px 14px;border-radius:18px;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01))}
.pa-root .pa-trow:hover{border-color:rgba(var(--acc-rgb),.45)}
.pa-root .pa-trow:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.pa-root .pa-trow:first-of-type{border-color:rgba(var(--acc-rgb),.5);box-shadow:0 0 40px -18px rgba(var(--acc-rgb),.8)}
.pa-root .pa-trow .ui-team{grid-area:tm;width:44px;height:44px}
.pa-root .pa-trow .who{grid-area:who;min-width:0}
.pa-root .pa-trow .who b{display:block;font:700 16px/1.2 'Rubik',sans-serif;overflow-wrap:anywhere}
.pa-root .pa-trow .who small{display:block;margin-top:2px;font:600 12px/1.35 var(--fui);color:#ffffffa6}
.pa-root .pa-trow .dots{grid-area:dots;min-width:0}
.pa-root .pa-trow .hit{grid-area:hit;justify-self:end;text-align:right;padding:0;border-radius:0;box-shadow:none;background:none;white-space:nowrap;font:900 italic 28px/1 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.pa-root .pa-trow .hit em{display:block;margin-top:4px;font:600 11px var(--fui);font-style:normal;color:#ffffff99}
.pa-root .pa-trow .hit small{font:700 .5em 'Rubik',sans-serif;font-style:normal;color:#ffffffa6;margin-left:1px}
.pa-root .pa-trow .mu{grid-area:mu;display:flex;align-items:center;gap:8px;justify-self:end;width:118px}
.pa-root .pa-trow .mu b{font:800 15px var(--fui);min-width:22px;text-align:right}
@media(min-width:760px){
 .pa-root .pa-cols{display:grid;grid-template-columns:minmax(0,1fr) 150px 96px 150px;gap:12px;padding:0 14px 0 70px;font:700 10px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff73}
 .pa-root .pa-trow{grid-template-columns:44px minmax(0,1fr) 150px 96px 150px;grid-template-areas:"tm who dots hit mu";padding:14px}
 .pa-root .pa-trow .dots,.pa-root .pa-cols .c-dots{justify-self:start}
 .pa-root .pa-trow .hit,.pa-root .pa-cols .c-hit{justify-self:end}
 .pa-root .pa-trow .mu{width:150px}
 .pa-root .pa-trow .who b,.pa-root .pa-trow .who small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
`;
    document.head.appendChild(s);
  }

  // ---------- rendering ----------
  const ICON_SEARCH = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const lineWords = (stat, line, under) => (stat === 'td' ? 'Anytime touchdown (1 or more)' : under ? `Under ${fmtL(line)}: ${Math.floor(line)} or fewer ${WORD[stat]}` : `Over ${fmtL(line)}: ${Math.ceil(line)} or more ${WORD[stat]}`);
  function queryHTML(p) {
    const M = p ? markets(p) : [], stat = p ? st.stat : null, td = stat === 'td';
    const ctl = p ? `<div class="pa-ctl">
      ${U.select({ label: 'Market', value: stat, options: M.map(s => [s, MKT[s]]), name: 'pa-mkt' })}
      <div class="pa-step" role="group" aria-label="Line"><span class="l">Line</span><button type="button" data-pa-step="-1" aria-label="Lower the line"${td || st.line <= 0.5 ? ' disabled' : ''}>−</button><input id="pa-line" inputmode="decimal" autocomplete="off" aria-label="Line (half points)" value="${esc(fmtL(st.line))}"${td ? ' disabled' : ''}><button type="button" data-pa-step="1" aria-label="Raise the line"${td ? ' disabled' : ''}>+</button></div>
      ${td ? U.seg([{ k: 'over', label: 'Yes' }], 'over', 'pa-ou') : U.seg([{ k: 'over', label: 'Over' }, { k: 'under', label: 'Under' }], st.under ? 'under' : 'over', 'pa-ou')}
      <label class="pa-price"><span class="l">Your price</span><input id="pa-price" inputmode="text" autocomplete="off" placeholder="−110" aria-label="Your book's price, American odds (optional)" value="${esc(st.price)}"></label>
    </div><div class="pa-meaning" aria-live="polite"><b>${esc(lineWords(stat, st.line, st.under))}</b>${td ? '' : ' · half-point lines, so over + under = 100%'}</div>` : '';
    return `<section class="ui-card pa-q" aria-label="Choose a prop">
    <div class="pa-sbox"><div class="pa-in">${ICON_SEARCH}<input id="pa-q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="pa-sug" autocomplete="off" spellcheck="false" placeholder="Search a player, e.g. ${esc(examplePlayer())}" aria-label="Search a player" value="${esc(st.q)}">${st.pk ? '<button type="button" class="pa-x" data-pa-clear="1" aria-label="Clear the player">✕</button>' : ''}</div>
    <div class="pa-sug" id="pa-sug" role="listbox" aria-label="Players on the slate" hidden></div></div>${ctl}</section>`;
  }
  function examplePlayer() { const t = topProps()[0]; return t ? t.p.name : 'a player'; }
  function heroHTML(A) {
    const p = A.p, stat = A.stat, hu = U.hue(p.team), V = A.V;
    const mk = stat === 'td' ? `<em>Yes</em> Anytime TD` : `<em>${A.under ? 'Under' : 'Over'} ${esc(fmtL(A.line))}</em> ${esc(MKT[stat])}`;
    const pr = A.pr;
    const projTxt = !pr ? '—' : stat === 'td' ? (Math.round(pr.v * 100) / 100).toFixed(2) : f1(pr.v);
    let projNote = '';
    if (pr && pr.td) projNote = `Expected touchdowns implied by the First TD model's anytime chance (his share of ${p.team}'s scoring), not a box-score average.`;
    else if (pr && pr.M) {
      const M = pr.M, bl = (E.BLOW || {})[p.sp];
      projNote = M.c ? (bl && M.pb > 0 ? `Normal game ${f1(M.an)} · blowout ${f1(M.ab)} · blowout chance ${pct(M.pb)} (${bl}+ points)` : `Normal game ${f1(M.an)} · from the game's price`) : 'No game price yet, so no game-script adjustment';
      projNote += M.rf ? '. Season average with recent form counting 30%.' : '. From his season average.';
    }
    const tiles = [];
    if (num(A.dec)) tiles.push(['Your price', amOf(A.dec)], ['Implied', pct1(1 / A.dec)], ['Edge', `${sg(V.edge)} pts`, V.edge >= 3]);
    else if (A.dec !== null && st.price.trim()) tiles.push(['Your price', 'not read']);
    const inj = A.inj ? `<div class="pa-inj">Injury report: ${esc(A.inj.status)}${A.inj.injury ? ' · ' + esc(A.inj.injury) : ''}.${isOut(A.inj) ? ' If he is out, the prop would be void.' : ''}</div>` : '';
    return `<section class="ui-card pa-hero" style="--h:${hu}" aria-label="${esc(p.name + ', ' + (stat === 'td' ? 'anytime TD' : (A.under ? 'under ' : 'over ') + fmtL(A.line) + ' ' + WORD[stat]))}">
      <div class="pa-hd">${U.team(p.team, true)}<div><div class="pa-nm">${esc(p.name)}</div>
        <div class="pa-mu">${A.pos ? `<span class="pos">${esc(A.pos)}</span>` : ''}<span>${esc(p.teamName)}</span><span>· ${esc(p.g.away.abbr)} @ ${esc(p.g.home.abbr)}</span><span style="color:#ffffff99">· ${esc(whenOf(p.g))}</span></div></div></div>
      <div class="pa-mk"><span class="t">${mk}</span><span class="odds" title="fair odds from the model's chance">${esc(U.fair(A.P))}</span></div>
      <div class="pa-nums">
        <div><span class="ui-lbl">Projection</span><div class="ui-big" data-pa-proj>${esc(projTxt)}<small>${esc(UNIT[stat])}</small></div><p>${esc(projNote)}</p></div>
        <div><span class="ui-lbl">Model chance</span><div class="ui-big" data-pa-chance>${A.P == null ? '—' : Math.round(A.P * 100)}<small>%</small></div><p>Fair odds ${esc(U.fair(A.P))}${A.P != null ? ' · ' + esc(U.pays(A.P)) : ''}</p></div>
      </div>
      ${tiles.length ? `<div class="pa-px">${U.tiles(tiles)}</div>` : ''}${inj}
    </section>`;
  }
  function verdictHTML(A) {
    const V = A.V; if (!V) return '';
    const fair = U.fair(A.P);
    let why;
    if (num(A.dec)) why = `Model ${pct1(A.P)} vs ${pct1(1 / A.dec)} implied by ${amOf(A.dec)}: an edge of ${sg(V.edge)} points. ${V.tone === 'take' ? 'Worth it by this estimate.' : V.tone === 'lean' ? (V.edge >= 3 ? 'Value by this estimate, but it loses more often than it wins.' : 'A thin edge; small model errors would erase it.') : 'Your price pays less than the model thinks it should.'}${V.edge >= 10 ? ' An edge this big is rare against a real book: it more often means the model is missing news (minutes, role, injury) than that the line is wrong. Check before you bet.' : ''}`;
    else why = `Model chance ${pct(A.P)}. Fair odds ${fair}: bet only at ${fair} or better. Type your book's price above for the edge.`;
    return `<div class="pa-verd">${U.verdict({ tone: V.tone, kicker: num(A.dec) ? 'Safe Bets verdict · vs your price' : 'Safe Bets verdict', title: V.title, tag: 'Model estimate' })}<p>${esc(why)}</p></div>`;
  }
  function logHTML(A) {
    const rows = A.L.rows.slice(-10);
    if (!rows.length) return `<div class="ui-card"><div class="pa-h3">Recent games</div><p class="ui-muted">No recent box scores for ${esc(A.p.name)} in the app's data${SEAS_ST === 'loading' ? ' yet (loading the season box scores…)' : SEAS_ST === 'none' ? ' (the season box scores did not load)' : ''}.</p></div>`;
    const hit = v => (A.td ? v >= 1 : A.under ? v < A.line : v > A.line), h = rows.filter(r => hit(r.v)).length;
    let html = U.gameLog({ title: `${MKT[A.stat]} · last ${rows.length}`, summary: A.td ? `${h} of ${rows.length} with a TD` : `${h} of ${rows.length} ${A.under ? 'under' : 'over'} ${fmtL(A.line)}`,
      vals: rows.map(r => r.v), labels: rows.map(r => r.o.slice(0, 4)), line: A.line });
    if (A.under) html = html.replace(/class="b (hit|miss)"/g, (m, c) => `class="b ${c === 'hit' ? 'miss' : 'hit'}"`);   // green = the under won
    return html.replace('<div class="ui-card">', '<div class="ui-card" data-pa-log>');
  }
  function splitsHTML(A) {
    const S = splitsOf(A.L, A.line, A.under, A.pl, A.stat);
    if (!S.length) return '';
    const word = A.td ? 'with a TD' : A.under ? 'under' : 'over';
    const tile = s => {
      const avg = A.td && s.h != null ? `${s.n ? Math.round(s.h / s.n * 100) : 0}<small>% TD</small>` : `${esc(A.td ? (Math.round(s.avg * 100) / 100).toFixed(2) : f1(s.avg))}<small>${esc(A.td ? 'TD/g' : UNIT[A.stat])}</small>`;
      const r = s.h == null ? '' : `<span class="r tone-${s.n && s.h / s.n >= 0.6 ? 'good' : s.n && s.h / s.n < 0.4 ? 'bad' : 'mid'}">${s.h} of ${s.n} ${esc(word)}${A.td ? '' : ' ' + esc(fmtL(A.line))}</span>`;
      const n = s.n == null ? `<span class="n">${esc(s.extra || '')}</span>` : `<span class="n">${s.n} game${s.n === 1 ? '' : 's'}${s.h == null ? ' · season totals' : ''}${s.n < 5 ? ' · small sample' : ''}</span>`;
      return `<div class="pa-sp" data-pa-split="${esc(s.label)}"><span class="ui-lbl">${esc(s.label)}</span><b>${avg}</b>${r}${n}</div>`;
    };
    return `<div class="ui-card"><div class="pa-h3"><span>Splits</span><b>${esc(A.L.src || 'feed average')}</b></div><div class="pa-splits">${S.map(tile).join('')}</div></div>`;
  }
  function ladderHTML(A) {
    const p = A.p, stat = A.stat;
    if (stat === 'td') {
      const y = A.over;
      return `<div class="ui-card"><div class="pa-h3"><span>Ladder</span><b>Anytime TD</b></div>${U.table({ name: 'pa-lad', cols: [{ k: 'l', label: 'Market', sort: false }, { k: 'po', label: 'Yes', sort: false }, { k: 'fo', label: 'Fair', sort: false }, { k: 'pu', label: 'No', sort: false }, { k: 'fu', label: 'Fair', sort: false }],
        rows: [{ html: '<span class="pa-lb"><span class="a">1+ touchdown</span><span class="b">ANYTIME</span></span>', po: pct(y), fo: U.fair(y), pu: pct(1 - y), fu: U.fair(1 - y) }] })}<p class="ui-note" style="margin-top:8px">The app has no "no touchdown" leg, so only Yes can go on a slip.</p></div>`;
    }
    const lines = (E.LADDER[stat] || []).map(t => t - 0.5);
    if (!lines.includes(A.line)) lines.push(A.line);
    lines.sort((a, b) => a - b);
    const rows = lines.map(L => { const o = overAt(p, stat, L); return { L, cur: L === A.line, html: `<button type="button" class="pa-lb" data-pa-line="${esc(fmtL(L))}" aria-label="Use the line ${esc(fmtL(L))}"><span class="a">${esc(fmtL(L))}</span><span class="b">${esc(Math.ceil(L) + '+')}${L === A.line ? ' · NOW' : ''}</span></button>`, po: o, fo: U.fair(o), pu: 1 - o, fu: U.fair(1 - o) }; });
    let html = U.table({ name: 'pa-lad', cols: [{ k: 'L', label: 'Line', sort: false }, { k: 'po', label: 'Over', sort: false, heat: true, fmt: v => pct(v) }, { k: 'fo', label: 'Fair', sort: false }, { k: 'pu', label: 'Under', sort: false, fmt: v => pct(v) }, { k: 'fu', label: 'Fair', sort: false }], rows });
    const ci = rows.findIndex(r => r.cur);
    if (ci >= 0) { let i = -1; html = html.replace(/<tr>/g, m => (i++ === ci ? '<tr class="cur">' : m)); }
    return `<div class="ui-card" data-pa-ladder><div class="pa-h3"><span>Ladder</span><b>tap a line to use it</b></div>${html}</div>`;
  }
  function actionsHTML(A) {
    const p = A.p, key = A.key, on = key ? SB.inSlip(p.gid, key) : false;
    const q = `${p.name} ${A.td ? 'anytime TD' : (A.under ? 'under ' : 'over ') + fmtL(A.line) + ' ' + WORD[A.stat]}${num(A.dec) ? ' at ' + amOf(A.dec) : ''}`;
    const slip = key ? `<button type="button" class="${on ? 'ui-ghost' : 'ui-cta'}" data-pa-slip="${esc(p.gid + '|' + key)}" aria-pressed="${on}">${on ? '✓ In slip' : '+ Slip'}</button>` : '';
    return `<div class="pa-act">${slip}<button type="button" class="ui-ghost" data-pa-ask="${esc(q)}">Ask about this</button><button type="button" class="ui-ghost" data-pa-player="${esc(JSON.stringify({ name: p.name, sport: p.sp }))}">Player page</button></div>`;
  }
  function notesHTML(A) {
    const n = [];
    const r = A.L.rows.length;
    if (r) n.push(`Recent games: ${r} from ${A.L.src}${r < 10 ? ' (a small sample)' : ''}. Past games are not a promise of the next one.`);
    if (!A.td && A.pl && A.pl.est) n.push("No posted prop for this player in our feed: his line is priced from his season average.");
    n.push('No sportsbook prop prices in our feed, so every chance here is a model estimate and the odds shown are fair odds, not a book\'s price. Type your book\'s price to see the edge against it.');
    if (!A.td) n.push(`Lines are half points: over ${fmtL(A.line)} means ${Math.ceil(A.line)} or more, under ${fmtL(A.line)} means ${Math.floor(A.line)} or fewer, so the two add up to 100%. A whole number N is read as "N or more" (N − 0.5).`);
    return n.map(x => `<p class="ui-note">${esc(x)}</p>`).join('');
  }
  function topHTML() {
    const T = topProps();
    if (!T.length) return U.empty('No player props left on today\'s or tomorrow\'s slate in our feed. Search any player above.');
    const rows = T.map((t, i) => {
      const p = t.p, mu = t.mu, rate = t.n ? Math.round(t.h / t.n * 100) : null;
      const sub = `${t.stat === 'td' ? 'Yes TD' : 'O ' + fmtL(t.line) + ' ' + UNIT[t.stat].toUpperCase()} · fair ${U.fair(t.ch)} · ${p.home ? 'vs' : '@'} ${p.opp}`;
      return `<button type="button" class="pa-trow" data-pa-top="${i}" aria-label="${esc(`Analyze ${p.name} ${t.stat === 'td' ? 'anytime TD' : 'over ' + fmtL(t.line) + ' ' + WORD[t.stat]}: model ${pct(t.ch)}, hit ${t.n ? t.h + ' of ' + t.n : 'no recent games'}, matchup ${mu ? mu.s : 'unknown'}`)}">
        ${U.team(p.team)}<span class="who"><b>${esc(p.name)}</b><small>${esc(sub)}</small></span>
        <span class="dots">${U.dots(t.hits)}</span>
        <span class="hit">${rate == null ? '—' : rate}<small>${rate == null ? '' : '%'}</small>${t.n ? `<em>${t.h} of ${t.n}</em>` : ''}</span>
        <span class="mu">${U.meter(mu ? mu.s : null, 8)}<b class="tone-${U.tone(mu ? mu.s : null)}">${mu ? mu.s : '—'}</b></span></button>`;
    }).join('');
    return `<section class="ui-card pa-top" aria-label="Top props on the slate"><div class="pa-tophd"><span class="ui-lbl">Analyze props · top ${T.length}</span>${U.seg([{ k: 'hit', label: 'Hit %' }, { k: 'mu', label: 'Matchup' }], st.sort, 'pa-sort')}</div>
      <div class="pa-cols" aria-hidden="true"><span>Player</span><span class="c-dots">Last 10</span><span class="c-hit">Hit rate</span><span>Matchup</span></div>${rows}
      <p class="ui-note" style="margin-top:12px">One prop per player at the line our model rates nearest 65%, from today's and tomorrow's slate. Hit rate: his last ${10} games against that line (${SEAS_ST === 'ok' ? 'ESPN box scores' : SEAS_ST === 'loading' ? 'loading the box scores…' : 'box scores unavailable, so it shows the model chance order'}); fewer than 5 games are not ranked by hit rate. Matchup: a 0-100 estimate from the game's price, "—" where the game has no price yet.</p></section>`;
  }

  const RMS = { last: 0, max: 0, n: 0 };
  function render(main, params) {
    const t0 = performance.now();
    try { draw(main, params); } finally { const ms = performance.now() - t0; RMS.last = ms; RMS.max = Math.max(RMS.max, ms); RMS.n++; }
  }
  function draw(main, params) {
    css(); needSeason(); needFT(); applyParams(params);
    const head = U.page({ kicker: 'Prop deep-dive', title: 'Prop', accent: 'Analyzer', sub: 'Pick any player prop on the slate and see the whole picture: recent games against the line, splits, the matchup, the model\'s projection and its chance, and the edge against your own price.' });
    let p = current();
    if (st.pk && !p) { st.miss = st.miss || 'That player\'s game has started or left the feed'; st.pk = null; }
    let body = '';
    const notice = st.miss ? `<div class="pa-notice" role="status">${esc(st.miss)}. Pick another player below.</div>` : '';
    if (!p) {
      body = `${notice}${topHTML()}`;
    } else {
      if (st.line == null || !num(st.line)) st.line = defaultLine(p, st.stat);
      const A = analyze(p, st.stat, st.line, st.under, st.price);
      LAST = A;
      body = `<div class="pa-grid"><div class="pa-col">${heroHTML(A)}${verdictHTML(A)}${logHTML(A)}</div>
        <div class="pa-col">${splitsHTML(A)}<div><div class="pa-h3" style="margin-bottom:8px"><span>Factors</span><b>tap a tile for the numbers</b></div>${U.factors(factorsOf(p, A.stat, A.line, A.under, A.L, A.pl))}</div>${ladderHTML(A)}${actionsHTML(A)}</div></div>${notesHTML(A)}`;
    }
    const honest = p ? '' : `<div class="pa-honest"><span class="i" aria-hidden="true">i</span><span><b>No sportsbook prop prices in our feed.</b> The chance and the fair odds are model estimates; type your book's price on any prop to see the edge against it. Coverage: NBA, NFL and college football props, plus NFL anytime touchdowns.</span></div>`;
    // removing a focused, edited input fires its 'change' while innerHTML is being replaced: the guard keeps that from re-rendering
    busy = true;
    try { main.innerHTML = `<div class="ui-page pa-root" data-pa="${p ? 'prop' : 'empty'}">${head}${queryHTML(p)}${honest}${body}</div>`; } finally { busy = false; }
  }
  let LAST = null, busy = false;

  // re-render, then put keyboard focus back (the old nodes are gone after the redraw): on `sel` when given, else on whatever
  // control of this screen had focus (so a debounced redraw never pulls focus back to a box the viewer has left)
  const FOCUS_ATTRS = ['data-ui-seg', 'data-ui-select', 'data-pa-step', 'data-pa-line', 'data-pa-slip', 'data-pa-ask', 'data-pa-player', 'data-pa-clear', 'data-pa-top'];
  function focusSel(el) {
    if (!el || !el.closest || !el.closest('.pa-root')) return null;
    if (el.id) return '#' + el.id;
    for (const a of FOCUS_ATTRS) if (el.hasAttribute(a)) return attrSel(a, el.getAttribute(a));
    return null;
  }
  let pending = false, ptrDown = false, ptrT = null;
  function rerender(sel, caret) {
    pending = false;
    if (sel === undefined) { const a = document.activeElement; sel = focusSel(a); if (sel && caret == null && a && (a.id === 'pa-price' || a.id === 'pa-q')) caret = a.selectionStart; }
    SB.render();
    if (!sel) return;
    try {
      const el = document.querySelector('.pa-root ' + sel); if (!el) return;
      el.focus({ preventScroll: true });
      if (caret != null && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret);
    } catch (e) { /* focus is a nicety */ }
  }
  const attrSel = (a, v) => `[${a}="${String(v).replace(/["\\]/g, '\\$&')}"]`;
  // A box that loses focus fires 'change' on mousedown, before the click: redrawing then would swap the control under the
  // pointer and the click would be lost. So a redraw asked for while a pointer is down waits for its release (the clicked
  // control's own handler usually redraws first, with the new line already in the state).
  function later() {
    if (!showing()) { pending = false; return; }
    if (ptrDown) { pending = true; clearTimeout(ptrT); ptrT = setTimeout(() => { ptrDown = false; if (pending) later(); }, 1500); return; }
    rerender();
  }
  document.addEventListener('pointerdown', () => { ptrDown = true; }, true);
  const ptrUp = () => setTimeout(() => { ptrDown = false; clearTimeout(ptrT); if (pending) later(); }, 0);
  document.addEventListener('pointerup', ptrUp, true);
  document.addEventListener('pointercancel', ptrUp, true);
  function pick(pk, stat) {
    const p = slate().people.get(pk); if (!p) return;
    select(p, stat || null, null, false); st.price = '';
    rerender('select[data-ui-select="pa-mkt"]');
  }
  function setLine(v) {
    const p = current(); if (!p || st.stat === 'td') return;
    const L = normLine(v); if (L == null) return;
    st.line = clamp(L, 0.5, 2000);
  }

  // ---------- events (delegated, scoped to this module's root) ----------
  document.addEventListener('click', e => {
    const root = e.target.closest && e.target.closest('.pa-root');
    if (!root) return;
    if (!e.target.closest('.pa-sbox')) { const b = root.querySelector('#pa-sug'); if (b && !b.hidden) { b.hidden = true; const i = root.querySelector('#pa-q'); if (i) i.setAttribute('aria-expanded', 'false'); } }
    const t = e.target.closest('button,[data-pa-pick]'); if (!t) return;
    if (t.hasAttribute('data-pa-pick')) { pick(t.getAttribute('data-pa-pick')); return; }
    const seg = t.getAttribute('data-ui-seg');
    if (seg) {
      const [n, k] = seg.split('|');
      if (n === 'pa-ou') { st.under = k === 'under' && st.stat !== 'td'; rerender(attrSel('data-ui-seg', seg)); }
      else if (n === 'pa-sort') { st.sort = k === 'mu' ? 'mu' : 'hit'; store.set('pa.sort', st.sort); rerender(attrSel('data-ui-seg', seg)); }
      return;
    }
    if (t.hasAttribute('data-pa-step')) {
      const d = +t.getAttribute('data-pa-step'), s = STEP[st.stat] || 1;
      if (num(st.line)) { st.line = clamp(st.line + d * s, 0.5, 2000); rerender(attrSel('data-pa-step', d)); }
      return;
    }
    if (t.hasAttribute('data-pa-line')) { setLine(+t.getAttribute('data-pa-line')); rerender(attrSel('data-pa-line', t.getAttribute('data-pa-line'))); return; }
    if (t.hasAttribute('data-pa-top')) { const it = topProps()[+t.getAttribute('data-pa-top')]; if (it) { select(it.p, it.stat, it.line, false); st.price = ''; rerender('select[data-ui-select="pa-mkt"]'); window.scrollTo(0, 0); } return; }
    if (t.hasAttribute('data-pa-clear')) { st.pk = null; st.q = ''; st.miss = null; st.price = ''; rerender('#pa-q'); return; }
    if (t.hasAttribute('data-pa-slip')) {
      const id = t.getAttribute('data-pa-slip'), i = id.indexOf('|'), gid = id.slice(0, i), key = id.slice(i + 1);
      const was = SB.inSlip(gid, key); inToggle = true; let r = false;
      try { r = SB.toggleLeg(gid, key); } finally { inToggle = false; }
      if (!was && !r && !SB.inSlip(gid, key)) SB.toast('This leg can no longer be added (its game may have started).');
      rerender(attrSel('data-pa-slip', id)); return;
    }
    if (t.hasAttribute('data-pa-ask')) { SB.goTab('ask', { q: t.getAttribute('data-pa-ask') }); return; }
    if (t.hasAttribute('data-pa-player')) { let o = {}; try { o = JSON.parse(t.getAttribute('data-pa-player')); } catch (er) { o = {}; } SB.goTab('players', o); }
  });
  document.addEventListener('change', e => {
    const s = e.target; if (busy || !s || !s.isConnected || !s.closest || !s.closest('.pa-root')) return;
    if (s.matches('select[data-ui-select="pa-mkt"]')) {
      const p = current(); if (!p || !markets(p).includes(s.value)) return;
      st.stat = s.value; st.line = defaultLine(p, st.stat); if (st.stat === 'td') st.under = false;
      rerender('select[data-ui-select="pa-mkt"]'); return;
    }
    if (s.id === 'pa-line') {
      const L = normLine(s.value);
      if (L == null || L === st.line) { s.value = fmtL(st.line); return; }   // unreadable, or the same line: show the line in use
      setLine(s.value); setTimeout(later, 0);   // after the blur, so focus stays where the viewer moved it (Tab or a click)
    }
  });
  let priceT = null;
  document.addEventListener('input', e => {
    const s = e.target; if (!s || !s.closest) return;
    const root = s.closest('.pa-root'); if (!root) return;
    if (s.id === 'pa-q') { st.q = s.value; showSug(root, s.value); return; }
    if (s.id === 'pa-price') {
      st.price = s.value.slice(0, 12);
      clearTimeout(priceT);
      priceT = setTimeout(later, 260);
    }
  });
  document.addEventListener('keydown', e => {
    const s = e.target; if (!s || !s.closest) return;
    const root = s.closest('.pa-root'); if (!root) return;
    if (s.id === 'pa-q') {
      const box = root.querySelector('#pa-sug'), open = box && !box.hidden;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!open) showSug(root, s.value); else moveSug(root, e.key === 'ArrowDown' ? 1 : -1); e.preventDefault(); }
      else if (e.key === 'Enter') { const p = SUG[st.sugI] || (open ? null : searchList(s.value)[0]); if (p && String(s.value).trim()) { e.preventDefault(); pick(p.pk); } }
      else if (e.key === 'Escape' && open) { box.hidden = true; s.setAttribute('aria-expanded', 'false'); e.preventDefault(); }
      return;
    }
    if (s.id === 'pa-line' && e.key === 'Enter') { e.preventDefault(); setLine(s.value); rerender('#pa-line'); return; }
    if (s.id === 'pa-line' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); const p = current(); if (p && num(st.line) && st.stat !== 'td') { st.line = clamp(st.line + (e.key === 'ArrowUp' ? 1 : -1) * (STEP[st.stat] || 1), 0.5, 2000); rerender('#pa-line'); } return; }
    if (s.id === 'pa-price' && e.key === 'Enter') { e.preventDefault(); clearTimeout(priceT); st.price = s.value.slice(0, 12); rerender('#pa-price', st.price.length); }
  });
  let inToggle = false;
  const drawn = () => showing() && !!document.querySelector('#main .pa-root');
  if (typeof SB.on === 'function') {
    SB.on('slip', () => { if (!inToggle && drawn() && current()) rerender(); });
    SB.on('data', () => { IDX = null; TOP = null; ftWait = false; if (drawn()) SB.render(); });
  }

  SB.registerTab({ key: KEY, label: 'Prop Analyzer', render });
  // read-only hooks for tests and other screens
  window.__propan = { normLine, chance: (pk, stat, line, under) => { const p = slate().people.get(pk); return p ? chance(p, stat, line, under) : null; }, slate, topProps, get state() { return { ...st }; }, get last() { return LAST; }, get seasonState() { return SEAS_ST; }, get renderMs() { return { ...RMS }; } };
})();
