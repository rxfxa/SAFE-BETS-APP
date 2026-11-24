// insights.js: two research screens on the window.SB v2 API (docs/pro-interface.md, screens 4 and 9).
//  - Insights ('insights'): the day's board of player prop cards (SB.ui.propCard, the flip card). One card per player prop at the
//    line where the model's chance is nearest 65% (engine.playerLegs / LADDER), plus NFL anytime touchdowns (engine.nflByTd).
//    Front: market, fair odds from the model chance, his real recent games against THIS line (hit rate + dots, sample named) and
//    the matchup score. Back: projection, season and last-5 averages, three ladder lines, team points, blowout risk, injury report.
//  - Prop Explorer ('explorer'): the same slate as one sortable heat table with filters, a HIT % / MATCHUP ranking and Copy table.
// Recent games: season.json box-score logs (SB.season()), NBA joined with engine.last4Of, else playerform's last 5.
// We have no sportsbook prop prices, so there is no "edge": every number is a model estimate, shown with its fair odds.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('insights.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc;
  const num = x => typeof x === 'number' && isFinite(x);
  const pct = p => (num(p) ? Math.round(p * 100) + '%' : '—');
  const f1 = x => (num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());
  const store = SB.store || { get: (k, d) => d, set() {} };
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const whenOf = g => tFmt.format(new Date(SB.startMs(g))) + ' PT';
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'College FB', nhl: 'NHL', soccer: 'Soccer' };
  const SPORDER = ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'];
  const MKT = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', rec: 'Receptions', ryd: 'Rushing yards', recyd: 'Receiving yards', pyd: 'Passing yards', hpts: 'Points', sog: 'Shots on goal', sot: 'Shots on target', td: 'Anytime TD' };
  const UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'catches', ryd: 'yds', recyd: 'yds', pyd: 'yds', hpts: 'pts', sog: 'shots', sot: 'shots', td: 'TDs' };
  const TDMIN = 0.12;   // anytime-TD cards below this model chance are left off the board (depth players)
  const PAGE = 24;

  // ---------- state (per viewer, kept on the device) ----------
  const st = {
    day: 'today', sport: 'all', sort: store.get('ins.sort', 'p'), shown: PAGE,
    x: Object.assign({ day: 'today', sport: 'all', stat: 'all', team: 'all', minp: 0, rows: 25, lines: 'main', sort: { k: 'hit', dir: -1 } }, store.get('ins.x', {}) || {}),
  };
  if (!['p', 'hit', 'mu', 'time'].includes(st.sort)) st.sort = 'p';
  if (![25, 50, 100].includes(+st.x.rows)) st.x.rows = 25;
  if (!st.x.sort || typeof st.x.sort.k !== 'string') st.x.sort = { k: 'hit', dir: -1 };
  st.x.sport = 'all'; st.x.team = 'all'; st.x.day = 'today';   // filters that depend on the slate start fresh each visit
  const saveX = () => store.set('ins.x', { stat: st.x.stat, minp: st.x.minp, rows: st.x.rows, lines: st.x.lines, sort: st.x.sort });
  const showing = () => SB.tab === 'insights' || SB.tab === 'explorer';
  const dFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const dayLabel = day => { const t = Date.parse(day + 'T12:00:00Z'); return isFinite(t) ? dFmt.format(new Date(t)) : day; };
  const dayKey = which => { const t = E.dayOf(Date.now()); return which === 'tomorrow' ? E.nextDay(t) : t; };

  // ---------- season.json game logs (loaded once, on first visit) ----------
  let SEAS = null, SEAS_ST = 'idle';
  function needSeason() {
    if (SEAS_ST !== 'idle') return;
    SEAS_ST = 'loading';
    Promise.resolve(typeof SB.season === 'function' ? SB.season() : null).then(d => { SEAS = d ? indexSeason(d) : null; SEAS_ST = SEAS ? 'ok' : 'none'; })
      .catch(() => { SEAS = null; SEAS_ST = 'none'; })
      .then(() => { if (showing()) SB.render(); });
  }
  function indexSeason(d) {
    if (!d || !d.sports) return null;
    const out = {};
    for (const [sp, S] of Object.entries(d.sports)) {
      if (!S || !Array.isArray(S.players)) continue;
      const fi = {}; (S.fields || []).forEach((f, i) => { fi[f] = 3 + i; });
      const ti = {}; (S.fields || []).forEach((f, i) => { ti[f] = i; });
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
    const nk = E.nameKey(name), last = s => { const a = E.nameKey(s).split('-'); return a[a.length - 1]; };
    if (X.teams[abbr] && (!name || last(X.teams[abbr]) === last(name))) return abbr;
    if (nk && X.byTeam.has(nk)) return X.byTeam.get(nk);
    if (nk) for (const [k, ab] of X.byTeam) if (k.length > 4 && (k.startsWith(nk) || nk.startsWith(k))) return ab;
    return X.teams[abbr] ? abbr : null;
  }
  function seasonPlayer(sp, name, abbr, teamName) {
    const X = SEAS && SEAS[sp]; if (!X) return null;
    const c = X.byName.get(E.nameKey(name)); if (!c || !c.length) return null;
    const ab = espnAbbr(X, abbr, teamName);
    const same = c.find(p => p.t === ab); if (same) return same;
    // one player of that name: a pro who changed teams, or a team we could not map; college names repeat, so it must match there
    return c.length === 1 && (sp !== 'ncaaf' || !ab) ? c[0] : null;
  }
  const fieldVal = (X, row, stat) => {
    const f = X.fi;
    if (stat === 'td') return (+row[f.rtd] || 0) + (+row[f.ctd] || 0);
    if (stat === 'hpts') return (+row[f.g] || 0) + (+row[f.a] || 0);
    return f[stat] != null ? +row[f[stat]] : NaN;
  };
  // his games before the day being priced, oldest first: [{d, o, v}]
  function logOf(sp, name, abbr, teamName, stat, day, pl) {
    const by = new Map(); let src = '';
    const P = seasonPlayer(sp, name, abbr, teamName), X = SEAS && SEAS[sp];
    if (P) {
      for (const r of P.log) { if (!Array.isArray(r) || !(String(r[0]) < day)) continue; const v = fieldVal(X, r, stat); if (num(v)) by.set(r[0], { d: r[0], o: r[1], v }); }
      if (by.size) src = 'box scores';
    }
    if (sp === 'nba' && (stat === 'pts' || stat === 'reb' || stat === 'ast')) {
      let L = null; try { L = E.last4Of(abbr, name); } catch (e) { L = null; }
      if (L && Array.isArray(L.rows)) for (const r of L.rows) if (r && !r.dnp && num(r[stat]) && String(r.date) < day && !by.has(r.date)) by.set(r.date, { d: r.date, o: r.opp, v: r[stat] });
      if (by.size && !src) src = 'box scores';
    }
    let vals = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (!vals.length && pl) {
      let rf = null; try { rf = E.recentOf(pl); } catch (e) { rf = null; }
      if (rf && Array.isArray(rf.last5)) { vals = rf.last5.map((v, i) => ({ d: null, o: (rf.opp5 || [])[i] || '', v: +v })).filter(x => num(x.v)); src = 'recent form'; }
    }
    return { vals, src, P };
  }

  // ---------- injuries, matchup, names ----------
  let INJX = null, INJD = null;
  function injOf(sp, team, name, pl, slug) {
    const F = window.__firsttd;
    if (!slug && sp === 'nfl' && typeof E.tdSlug === 'function') slug = E.tdSlug(name);   // game-day calls kept by the First TD tab
    if (slug && F && F.INJ && typeof F.INJ.get === 'function') { const s = F.INJ.get(team + '|' + slug.replace(/-/g, ' ')); if (s && s.status) return { status: s.status, injury: s.note || '' }; }
    const I = E.injuries;
    if (INJD !== I) { INJD = I; INJX = new Map(); for (const x of (I && Array.isArray(I.injuries) ? I.injuries : [])) if (x && x.player) { const k = x.sport + '|' + E.nameKey(x.player); if (!INJX.has(k)) INJX.set(k, []); INJX.get(k).push(x); } }
    const c = INJX.get(sp + '|' + E.nameKey(name)) || [];
    const hit = c.find(x => x.team === team) || (c.length === 1 ? c[0] : null);
    if (hit) return { status: String(hit.status || ''), injury: hit.injury || '' };
    if (pl && pl.status && pl.status !== 'active') return { status: pl.note || pl.status, injury: '' };
    return null;
  }
  const isOut = inj => !!(inj && /^out\b/i.test(String(inj.status || '')));
  // matchup score (0-100, an estimate): 50 + 250·(tf − 1) − 60·max(0, pb − 0.15); unknown without a game price
  function matchupOf(g, team) {
    let c = null; try { c = E.teamCtx(g, team); } catch (e) { c = null; }
    if (!c || !num(c.tf)) return null;
    const pb = num(c.pb) ? c.pb : 0, s = Math.round(clamp(50 + 250 * (c.tf - 1) - 60 * Math.max(0, pb - 0.15), 0, 100));
    return { s, tf: c.tf, pb, label: s >= 60 ? 'Soft matchup' : s < 40 ? 'Tough' : 'Neutral' };
  }
  const splitName = n => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 ? [w[0], w.slice(1).join(' ')] : ['', w[0] || '']; };
  function posOf(sp, team, name, pl, P) {
    if (pl && pl.pos) return pl.pos;
    const D = SB.DATA; if (D && D.nflpos instanceof Map) { const p = D.nflpos.get(team + '|' + E.nameKey(name)); if (p) return p; }
    return P && P.pos ? P.pos : '';
  }

  // ---------- the board for one Los Angeles day (cached per DATA) ----------
  let CACHE = { data: null, m: new Map() };
  let ftWait = false;
  const tdReady = () => { const F = window.__firsttd; return !F || !!F.FT; };
  function needFT() {
    const F = window.__firsttd;
    if (!F || F.FT || ftWait || typeof F.load !== 'function') return;
    ftWait = true;
    Promise.resolve(F.load()).then(() => { if (F.FT && showing()) SB.render(); }).catch(() => {});
  }
  function board(day) {
    if (CACHE.data !== SB.DATA) CACHE = { data: SB.DATA, m: new Map() };
    const ck = day + '|' + SEAS_ST + '|' + (tdReady() ? 1 : 0);
    if (!CACHE.m.has(ck)) CACHE.m.set(ck, compute(day));
    return CACHE.m.get(ck);
  }
  function hitsFor(vals, thr) {
    const l5 = vals.slice(-5), l10 = vals.slice(-10), ok = x => x.v >= thr;
    const h5 = l5.filter(ok).length, h10 = l10.filter(ok).length;
    return { hits5: l5.map(ok), h5, n5: l5.length, h10, n10: l10.length, avg5: l5.length ? l5.reduce((a, x) => a + x.v, 0) / l5.length : null };
  }
  function compute(day) {
    const D = SB.DATA || {}, games = E.dayGames(day), G = new Map(games.map(g => [g.id, g]));
    const items = [], all = [], seen = new Set();
    for (const pl of D.players || []) {
      const g = G.get(pl && pl.gid); if (!g || !E.LADDER[pl.stat] || pl.status === 'out') continue;
      const dk = g.id + '|' + E.nameKey(pl.name) + '|' + pl.stat; if (seen.has(dk)) continue;
      let legs; try { legs = E.playerLegs(pl); } catch (e) { legs = []; }
      if (!legs.length) continue;
      seen.add(dk);
      const inj = injOf(g.sport, pl.team, pl.name, pl); if (isOut(inj)) continue;   // ruled out: the prop would be void
      const main = legs.reduce((a, b) => (Math.abs(b.p - 0.65) < Math.abs(a.p - 0.65) ? b : a));
      const me = g.home.abbr === pl.team ? g.home : g.away, sp = g.sport;
      const log = logOf(sp, pl.name, pl.team, me.name, pl.stat, day, pl);
      let M = null; try { M = E.playerMeans(pl); } catch (e) { M = null; }
      const [first, last] = splitName(pl.name);
      const base = {
        td: false, pl, g, gid: g.id, sp, stat: pl.stat, name: pl.name, first, last, team: pl.team, opp: me === g.home ? g.away.abbr : g.home.abbr,
        pos: posOf(sp, pl.team, pl.name, pl, log.P), log, M, mu: matchupOf(g, pl.team), inj, savg: num(pl.avg) ? pl.avg : null,
        start: SB.startMs(g), matchup: `${g.away.abbr} @ ${g.home.abbr}`, when: whenOf(g),
      };
      for (const L of legs) {
        const it = Object.assign({}, base, hitsFor(log.vals, L.thr), { id: g.id + '|' + L.key, key: L.key, thr: L.thr, p: L.p, main: L === main, lineTxt: L.thr + '+', marketEm: L.thr + '+', market: MKT[pl.stat] || E.STATN[pl.stat] || pl.stat });
        all.push(it); if (it.main) items.push(it);
      }
    }
    // NFL anytime touchdowns (firsttd.js prices them; a 1+ TD line against his rushing + receiving TDs per game)
    const T = E.nflByTd, F = window.__firsttd;
    if (T && typeof T.entries === 'function' && F && F.FT) {
      for (const g of games) {
        if (g.sport !== 'nfl') continue;
        for (const me of [g.home, g.away]) {
          for (const [k, v] of T) {
            if (!k.startsWith(me.abbr + '|')) continue;
            const slug = k.slice(me.abbr.length + 1), key = `TD:A:${me.abbr}:${slug}`, name = (v && v.name) || slug;
            if (seen.has(g.id + '|' + key)) continue; seen.add(g.id + '|' + key);
            let p = 0; try { p = SB.p1(g, key); } catch (e) { p = 0; }
            if (!(p >= TDMIN) || p >= 0.995) continue;
            const inj = injOf('nfl', me.abbr, name, null, slug); if (isOut(inj)) continue;
            const log = logOf('nfl', name, me.abbr, me.name, 'td', day, null), [first, last] = splitName(name);
            const P = log.P, X = SEAS && SEAS.nfl;
            const it = Object.assign({
              td: true, pl: null, g, gid: g.id, sp: 'nfl', stat: 'td', name, first, last, team: me.abbr, opp: me === g.home ? g.away.abbr : g.home.abbr, slug,
              pos: (v && v.pos) || (P && P.pos) || '', log, M: null, mu: matchupOf(g, me.abbr), inj,
              savg: P && X && P.gp ? ((+P.tot[X.ti.rtd] || 0) + (+P.tot[X.ti.ctd] || 0)) / P.gp : null, stot: P && X ? (+P.tot[X.ti.rtd] || 0) + (+P.tot[X.ti.ctd] || 0) : null, sgp: P ? P.gp : null,
              start: SB.startMs(g), matchup: `${g.away.abbr} @ ${g.home.abbr}`, when: whenOf(g),
            }, hitsFor(log.vals, 1), { id: g.id + '|' + key, key, thr: 1, p, main: true, lineTxt: 'Yes', marketEm: 'Yes', market: 'Anytime TD' });
            items.push(it); all.push(it);
          }
        }
      }
    }
    return { items, all, byId: new Map(all.map(x => [x.id, x])), games };
  }

  // ---------- sorting ----------
  const nl = (a, b, f) => { const x = f(a), y = f(b); return x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : y - x; };
  const rate5 = x => (x.n5 ? x.h5 / x.n5 : null), rate10 = x => (x.n10 ? x.h10 / x.n10 : null), muS = x => (x.mu ? x.mu.s : null);
  const tie = (a, b) => b.p - a.p || a.start - b.start || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const SORTS = {
    p: (a, b) => b.p - a.p || nl(a, b, rate5) || tie(a, b),
    hit: (a, b) => nl(a, b, rate5) || b.n5 - a.n5 || tie(a, b),
    mu: (a, b) => nl(a, b, muS) || tie(a, b),
    time: (a, b) => a.start - b.start || tie(a, b),
  };

  // ---------- module styles (injected once) ----------
  function css() {
    if (document.getElementById('insights-css')) return;
    const s = document.createElement('style'); s.id = 'insights-css';
    s.textContent = `
.ins-root .ins-ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ins-root .ins-honest{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid rgba(var(--acc-rgb),.26);border-radius:14px;background:rgba(var(--acc-rgb),.06);font:400 13px/1.5 var(--fui);color:#ffffffcc}
.ins-root .ins-honest b{color:#fff;font-weight:600}
.ins-root .ins-honest .i{flex:none;width:20px;height:20px;margin-top:1px;border-radius:50%;display:grid;place-items:center;background:rgba(var(--acc-rgb),.18);color:var(--acc2);font:800 12px var(--fui)}
.ins-root .ins-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 14px;font:600 11px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80}
.ins-root .ins-meta .ui-link{font:600 14px var(--fui);letter-spacing:0;text-transform:none}
.ins-root .ins-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,318px),1fr));gap:16px;align-items:start}
.ins-root .ui-prop .ft{gap:6px}
.ins-root .ui-prop .ft .ui-link{margin-right:auto;font-size:13.5px}
.ins-root .ui-prop .ft .ui-cta.sm,.ins-root .ui-prop .ft .ui-ghost.sm{padding:0 13px}
.ins-root .ui-prop .rows div{padding:5px 0;font-size:13px}
.ins-root .ui-prop .rows div b{font-variant-numeric:tabular-nums}
.ins-root .ins-nomu .st2>div:nth-child(2) .ui-muted{color:#ffffff80}
.ins-root .ins-l5{margin:12px 14px 0;padding-top:10px;border-top:1px solid var(--hair);display:flex;flex-direction:column;gap:7px}
.ins-root .ins-l5 .g{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.ins-root .ins-l5 .g>span{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 0 4px;border-radius:9px;background:rgba(0,212,146,.1);border:1px solid rgba(0,212,146,.28)}
.ins-root .ins-l5 .g>span.m{background:rgba(241,30,132,.09);border-color:rgba(241,30,132,.3)}
.ins-root .ins-l5 .g b{font:700 15px/1.1 'Rubik',sans-serif;color:var(--good);font-variant-numeric:tabular-nums}.ins-root .ins-l5 .g .m b{color:#ff5aa8}
.ins-root .ins-l5 .g i{font:600 9.5px var(--fmono);font-style:normal;letter-spacing:.06em;color:#ffffff80}
.ins-root .ins-l5 .none{font:400 12.5px var(--fui);color:#ffffff80}
.ins-root .ui-prop .back .mu{display:none}
.ins-root .ins-more{display:flex;justify-content:center;margin:4px 0 8px}
.ins-root .ins-tcard{padding:14px 12px 12px}
.ins-root .ins-tbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:0 2px 12px}
.ins-root .ins-tbar .ui-lbl{letter-spacing:.2em}
.ins-root .ui-seg button{min-height:40px}
.ins-root .ins-tbar .n{font:500 12px var(--fui);color:#ffffff80;margin-left:8px;letter-spacing:0;text-transform:none}
.ins-root .ins-pbtn{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;justify-content:center;min-height:40px;max-width:210px;white-space:normal}
.ins-root .ins-pbtn .pn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ins-root .ins-pbtn:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.ins-root .ui-table tbody tr{cursor:pointer}
.ins-root .ui-table td{padding-top:7px;padding-bottom:7px}
.ins-root .ins-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
@media(max-width:520px){.ins-root .ui-sel{flex:1 1 auto;min-width:0}.ins-root .ui-sel .v{overflow:hidden;text-overflow:ellipsis}}
`;
    document.head.appendChild(s);
  }

  // ---------- shared pieces ----------
  const honest = () => `<div class="ins-honest" role="note"><span class="i" aria-hidden="true">i</span><span><b>No sportsbook prop prices in our feed.</b> Each prop shows the model's chance and its fair odds, so bet only at that price or better. Every chance is a model estimate, and a player's last 5 games are a small sample.</span></div>`;
  const dayOpts = () => [['today', 'Today'], ['tomorrow', 'Tomorrow']];
  function sportPills(list, active, name) {
    const n = {}; for (const x of list) n[x.sp] = (n[x.sp] || 0) + 1;
    const items = [{ k: 'all', label: 'All', n: list.length }].concat(SPORDER.filter(s => n[s]).map(s => ({ k: s, label: SPN[s], n: n[s] })));
    if (active !== 'all' && !n[active]) items.push({ k: active, label: SPN[active] || active, n: 0 });
    return U.pills(items, active, name);
  }
  const slipOn = id => { const i = id.indexOf('|'); return SB.inSlip(id.slice(0, i), id.slice(i + 1)); };
  function syncSlip(root) {
    for (const b of (root || document).querySelectorAll('.ins-root [data-ins-slip]')) {
      const on = slipOn(b.getAttribute('data-ins-slip'));
      b.textContent = on ? '✓ In slip' : '+ Slip';
      b.classList.toggle('ui-cta', !on); b.classList.toggle('ui-ghost', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', (on ? 'Remove from slip: ' : 'Add to slip: ') + (b.getAttribute('data-ins-name') || ''));
    }
  }

  // ---------- Insights: the card board ----------
  function ladderTxt(it) {
    const L = E.LADDER[it.stat]; if (!it.pl || !L) return '—';
    let i = L.indexOf(it.thr); if (i < 0) return '—';
    i = clamp(i - 1, 0, Math.max(0, L.length - 3));
    return L.slice(i, i + 3).map(t => { let p = null; try { p = E.playerP(it.pl, t); } catch (e) { p = null; } return `${t}+ ${pct(p)}`; }).join(' · ');
  }
  function gameRows(it) {
    const mu = it.mu, b = E.BLOW && E.BLOW[it.sp];
    return [
      ['Team points', mu ? `${mu.tf >= 1 ? '+' : '−'}${Math.abs(Math.round((mu.tf - 1) * 100))}% vs league avg` : 'No game price yet'],
      ['Blowout risk', mu && b ? `${pct(mu.pb)} (${b}+ pts)` : '—'],
      ['Injury report', it.inj ? cap(it.inj.status) + (it.inj.injury ? ' · ' + it.inj.injury : '') : 'Not listed'],
    ];
  }
  function noteOf(it) {
    const out = [], ln = it.td ? 'a TD' : `${it.thr}+`;
    if (it.inj && it.inj.status && !/^active$/i.test(it.inj.status)) out.push(`Listed ${String(it.inj.status).toLowerCase()}: check his status before you bet.`);
    if (it.n5 >= 3) {
      const r = it.h5 / it.n5;
      if (it.td) out.push(`Scored in ${it.h5} of his last ${it.n5}` + (it.stot != null ? `; ${it.stot} TDs in ${it.sgp} games this season.` : '.'));
      else if (r >= 0.8 && it.p >= 0.6) out.push(`Cleared ${ln} in ${it.h5} of his last ${it.n5}, and the model agrees (${pct(it.p)}).`);
      else if (r <= 0.4 && it.p >= 0.55) out.push(`The model says ${pct(it.p)}, but he cleared ${ln} in only ${it.h5} of his last ${it.n5}. Small samples swing; weigh both.`);
      else out.push(`Model ${pct(it.p)} against ${it.h5} of ${it.n5} lately at ${ln}.`);
    } else out.push(it.n5 ? `Only ${it.n5} recent game${it.n5 > 1 ? 's' : ''} logged, too few to judge.` : 'No recent box scores for him in our logs.');
    if (it.mu && it.mu.pb >= 0.2 && !it.td) out.push(`${pct(it.mu.pb)} blowout chance: starters can sit late.`);
    return out.join(' ');
  }
  function backOf(it) {
    if (it.td) return [
      ['Model chance', pct(it.p)],
      ['Fair odds', U.fair(it.p)],
      ['Season TDs', it.stot != null ? `${it.stot} in ${it.sgp} games` : '—'],
      ['Last 10', it.n10 ? `scored in ${it.h10} of ${it.n10}` : '—'],
    ].concat(gameRows(it));
    const M = it.M, u = UNIT[it.stat] || '';
    const proj = M && num(M.an) ? `${f1(M.an)} ${u}` + (num(M.pb) && M.pb > 0.02 && Math.abs(M.ab - M.an) > 0.05 ? ` · ${f1(M.ab)} if a blowout` : '') : '—';
    return [
      ['Projection', proj],
      ['Season avg', it.savg != null ? `${f1(it.savg)} ${u}` : '—'],
      ['Last 5 avg', it.avg5 != null ? `${f1(it.avg5)} ${u} (${it.n5} game${it.n5 === 1 ? '' : 's'})` : '—'],
      ['Ladder', ladderTxt(it)],
    ].concat(gameRows(it));
  }
  function hitLabel(it) {
    if (it.n5) return `L${it.n5} · ${it.h5} of ${it.n5}` + (it.n5 < 5 ? ' (few games)' : '');
    return SEAS_ST === 'loading' || SEAS_ST === 'idle' ? 'Loading game log…' : 'No game log';
  }
  // the front's strip of his last games against this line (oldest first), like a mini game log
  function stripOf(it) {
    const l5 = it.log.vals.slice(-5), ln = it.td ? 'a TD' : it.thr + '+';
    if (!l5.length) return `<div class="ins-l5"><span class="ui-lbl">Last games</span><span class="none">${esc(hitLabel(it))}</span></div>`;
    const lab = `His last ${l5.length} against ${ln}: ` + l5.map(x => `${x.v}${x.o ? ' vs ' + x.o : ''}`).join(', ');
    return `<div class="ins-l5" role="img" aria-label="${esc(lab)}"><span class="ui-lbl">Last ${l5.length} · vs ${esc(ln)}</span><span class="g">${l5.map(x => `<span class="${x.v >= it.thr ? 'h' : 'm'}"><b>${esc(Number.isInteger(x.v) ? x.v : f1(x.v))}</b><i>${esc(String(x.o || '').slice(0, 4))}</i></span>`).join('')}</span></div>`;
  }
  function cardHTML(it) {
    const html = U.propCard({
      id: it.id, first: it.first, last: it.last, team: it.team, pos: it.pos, matchup: it.matchup, when: it.when,
      market: it.market, marketEm: it.marketEm, chance: it.p, hits: it.hits5, hitLabel: hitLabel(it),
      matchupScore: it.mu ? it.mu.s : null, matchupLabel: it.mu ? it.mu.label : 'No game price yet',
      back: { rows: backOf(it), note: noteOf(it) }, flipLabel: 'Full matchup',
      actions: [{ label: '+ Slip', attr: 'ins-slip', value: it.id, cta: true }, { label: 'Analyze', attr: 'ins-an', value: it.id }],
    });
    const nm = esc(`${it.name} ${it.td ? 'anytime TD' : it.thr + '+ ' + (E.STATN[it.stat] || it.stat)}`);
    return html.replace('class="ui-prop"', `class="ui-prop${it.mu ? '' : ' ins-nomu'}" data-sport="${esc(it.sp)}" data-key="${esc(it.key)}"`)
      .replace('<div class="ft">', stripOf(it) + '<div class="ft">')   // the first .ft is the front face's footer
      .replace(/data-ins-slip="/g, `data-ins-name="${nm}" data-ins-slip="`);
  }
  function renderInsights(main, params) {
    css(); applyParams('insights', params); needSeason(); needFT();
    const day = dayKey(st.day), B = board(day);
    let list = B.items.slice();
    if (st.sport !== 'all') list = list.filter(x => x.sp === st.sport);
    list.sort(SORTS[st.sort] || SORTS.p);
    const shown = list.slice(0, st.shown), nGames = new Set(list.map(x => x.gid)).size;
    const isT = st.day === 'tomorrow';
    const head = U.page({ kicker: 'Model picks & prop board', title: isT ? "Tomorrow's player" : "Today's player", accent: 'prop board',
      sub: 'Every player prop on the slate at the line our model rates near 65%, checked against his real recent games and the matchup. Flip a card for the numbers behind it.' });
    const ctrl = `<div class="ins-ctrl">${U.select({ label: 'Day', value: st.day, options: dayOpts(), name: 'ins-day' })}${U.select({ label: 'Sort', value: st.sort, options: [['p', 'Model chance'], ['hit', 'Hit rate'], ['mu', 'Matchup'], ['time', 'Tip-off']], name: 'ins-sort' })}</div>${sportPills(B.items, st.sport, 'ins-sport')}`;
    const meta = `<div class="ins-meta"><span>${list.length} prop${list.length === 1 ? '' : 's'} · ${nGames} game${nGames === 1 ? '' : 's'} · ${esc(dayLabel(day))}</span><button type="button" class="ui-link" data-ins-go="explorer">Open Prop Explorer →</button></div>`;
    let body;
    if (!shown.length) {
      const other = !isT && board(dayKey('tomorrow')).items.length;
      body = U.empty(st.sport !== 'all' ? `No ${SPN[st.sport] || st.sport} player props ${isT ? 'tomorrow' : 'today'} in our feed.` : `No player props ${isT ? 'tomorrow' : 'left today'} in our feed.`) +
        `<div class="ins-more">${st.sport !== 'all' ? `<button type="button" class="ui-ghost" data-ui-pill="ins-sport|all">Show all sports</button>` : ''}${other ? `<button type="button" class="ui-ghost" data-ins-day="tomorrow">See tomorrow</button>` : ''}</div>`;
    } else {
      body = `<div class="ins-grid">${shown.map(cardHTML).join('')}</div>` +
        (list.length > shown.length ? `<div class="ins-more"><button type="button" class="ui-ghost" data-ins-more="1">Show more (${list.length - shown.length} left)</button></div>` : '');
    }
    main.innerHTML = `<div class="ui-page ins-root" data-ins="insights">${head}${ctrl}${honest()}${meta}${body}<p class="ui-note">Hit rate: his games this season from ESPN box scores (NBA joined with the latest four box scores), counted against the card's line; a missed game is not counted. Matchup: 50 + 250 × (team's expected points vs league average − 1), minus a blowout penalty, from the game's price; "—" where the game has no price yet.</p></div>`;
    syncSlip(main);
  }

  // ---------- Prop Explorer: the heat table ----------
  const COLS = [
    { k: 'name', label: 'Player', dir: 1 },
    { k: 'game', label: 'Game', dir: 1, fmt: (v, r) => r.gameTxt },
    { k: 'market', label: 'Market', dir: 1 },
    { k: 'line', label: 'Line', fmt: (v, r) => r.lineTxt },
    { k: 'p', label: 'Model %', heat: true, fmt: v => pct(v) },
    { k: 'fair', label: 'Fair odds', fmt: v => U.fair(v) },
    { k: 'hit', label: 'Hit L5 · L10', heat: true, fmt: (v, r) => (r.n5 ? `${r.h5}/${r.n5} · ${r.h10}/${r.n10}` : '—') },
    { k: 'avg5', label: 'Avg L5', fmt: v => f1(v) },
    { k: 'savg', label: 'Season avg', fmt: v => f1(v) },
    { k: 'mu', label: 'Matchup', heat: true, fmt: (v, r) => (v == null ? '—' : `${v} ${r.muLabel}`) },
  ];
  const colDir = k => { const c = COLS.find(x => x.k === k); return c && c.dir ? c.dir : -1; };
  function rowOf(it, i) {
    return {
      html: `<button type="button" class="ins-pbtn" data-ins-row="${i}" aria-label="${esc(`Analyze ${it.name} ${it.td ? 'anytime TD' : it.thr + '+ ' + (E.STATN[it.stat] || it.stat)}`)}"><span class="pn">${esc(it.name)}</span><span class="pt">${esc(it.team)}${it.pos ? ' · ' + esc(it.pos) : ''} · ${esc(SPN[it.sp] || it.sp)}</span></button>`,
      name: it.name, game: it.start, gameTxt: it.matchup, market: it.market, line: it.td ? 0.5 : it.thr, lineTxt: it.lineTxt, p: it.p, fair: it.p,
      hit: rate10(it), h5: it.h5, n5: it.n5, h10: it.h10, n10: it.n10, avg5: it.avg5, savg: it.savg, mu: muS(it), muLabel: it.mu ? it.mu.label.replace(' matchup', '') : '', it,
    };
  }
  function sortRows(rows, s) {
    const k = s.k, d = s.dir < 0 ? -1 : 1;
    const v = r => (k === 'hit' ? r.hit : r[k]);
    return rows.sort((a, b) => {
      const x = v(a), y = v(b);
      if (x == null || y == null || x === y) { if (x == null && y != null) return 1; if (y == null && x != null) return -1; }
      else { const c = typeof x === 'string' ? x.localeCompare(y) : x - y; if (c) return c * d; }
      if (k === 'hit' && a.n10 !== b.n10) return b.n10 - a.n10;
      return b.p - a.p || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
  }
  let EXROWS = [];
  function explorerRows() {
    const x = st.x, B = board(dayKey(x.day));
    const base = x.lines === 'all' ? B.all : B.items;
    const bySport = x.sport === 'all' ? base : base.filter(it => it.sp === x.sport);
    const stats = [...new Set(bySport.map(it => it.stat))];
    const teams = [...new Set(bySport.map(it => it.team))].sort();
    const stat = stats.includes(x.stat) ? x.stat : 'all', team = teams.includes(x.team) ? x.team : 'all';
    let list = bySport.filter(it => (stat === 'all' || it.stat === stat) && (team === 'all' || it.team === team) && it.p >= (+x.minp || 0));
    const rows = sortRows(list.map(rowOf), x.sort);
    return { B, base, rows, stats, teams, stat, team };
  }
  function renderExplorer(main, params) {
    css(); applyParams('explorer', params); needSeason(); needFT();
    const x = st.x, R = explorerRows(), view = R.rows.slice(0, +x.rows || 25);
    EXROWS = view;
    view.forEach((r, i) => { r.html = r.html.replace(/data-ins-row="\d+"/, `data-ins-row="${i}"`); });
    const head = U.page({ kicker: 'Prop explorer · the whole slate', title: 'Every prop on the slate,', accent: 'ranked',
      sub: 'The whole slate in one table: the model chance and its fair odds, how often he cleared this line lately, and the matchup. Sort any column; tap a player to analyze the prop.' });
    const statOpts = [['all', 'All stats']].concat(R.stats.sort((a, b) => (MKT[a] || a).localeCompare(MKT[b] || b)).map(s => [s, MKT[s] || s]));
    const ctrl = `<div class="ins-ctrl">${U.select({ label: 'Day', value: x.day, options: dayOpts(), name: 'exp-day' })}${U.select({ label: 'Stat', value: R.stat, options: statOpts, name: 'exp-stat' })}${U.select({ label: 'Team', value: R.team, options: [['all', 'All teams']].concat(R.teams.map(t => [t, t])), name: 'exp-team' })}${U.select({ label: 'Min chance', value: String(+x.minp || 0), options: [['0', 'Any'], ['0.5', '50%+'], ['0.6', '60%+'], ['0.7', '70%+'], ['0.8', '80%+']], name: 'exp-minp' })}${U.select({ label: 'Lines', value: x.lines, options: [['main', 'Main line'], ['all', 'Every line']], name: 'exp-lines' })}${U.select({ label: 'Rows', value: String(x.rows), options: [['25', '25'], ['50', '50'], ['100', '100']], name: 'exp-rows' })}</div>${sportPills(R.base, x.sport, 'exp-sport')}`;
    const seg = U.seg([{ k: 'hit', label: 'Hit %' }, { k: 'mu', label: 'Matchup' }], x.sort.k === 'mu' ? 'mu' : x.sort.k === 'hit' ? 'hit' : '', 'exp-rank');
    const table = view.length ? U.table({ cols: COLS, rows: view, sort: x.sort, name: 'exp' }) : U.empty('No props match these filters.');
    main.innerHTML = `<div class="ui-page ins-root" data-ins="explorer">${head}${ctrl}${honest()}
<section class="ui-card ins-tcard" aria-label="Prop table"><div class="ins-tbar"><span class="ui-lbl">Analyze props<span class="n">${R.rows.length} prop${R.rows.length === 1 ? '' : 's'}</span></span>${seg}</div>${table}
<div class="ins-foot"><span class="ui-note">Showing ${view.length} of ${R.rows.length}${R.rows.length > view.length ? ' · raise Rows to see more' : ''}. Hit: games cleared at this line, last 5 · last 10 (n shown).</span><span class="ui-row"><button type="button" class="ui-ghost sm" data-ins-copy="1">Copy table</button><button type="button" class="ui-link" data-ins-go="insights">Card board →</button></span></div></section>
<p class="ui-note">Model % is a model estimate (season average with recent form at 30%, the game's price and blowout risk). Fair odds are what that chance is worth, not a book price. Matchup "—": no game price yet.</p></div>`;
  }
  function copyTable() {
    const head = ['Player', 'Team', 'Game', 'Market', 'Line', 'Model %', 'Fair odds', 'Hit L5', 'Hit L10', 'Avg L5', 'Season avg', 'Matchup'];
    const lines = [head.join('\t')].concat(EXROWS.map(r => [r.name, r.it.team, r.gameTxt, r.market, r.lineTxt, pct(r.p), U.fair(r.p), r.n5 ? `${r.h5}/${r.n5}` : '', r.n10 ? `${r.h10}/${r.n10}` : '', f1(r.avg5), f1(r.savg), r.mu == null ? '' : `${r.mu} ${r.muLabel}`].join('\t')));
    const fail = () => SB.toast("Couldn't copy: your browser blocked the clipboard. Select the table and copy it instead.", 4000);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { fail(); return; }
      navigator.clipboard.writeText(lines.join('\n')).then(() => SB.toast(`Copied ${EXROWS.length} row${EXROWS.length === 1 ? '' : 's'}`), fail);
    } catch (e) { fail(); }
  }

  // ---------- params (applied once per goTab) ----------
  const seenP = { insights: null, explorer: null };
  function applyParams(key, p) {
    // render() passes a fresh {} when no params were given, so only a non-empty params object (one goTab call) is applied, once
    if (!p || typeof p !== 'object' || !Object.keys(p).length || seenP[key] === p) return; seenP[key] = p;
    const sp = typeof p.sport === 'string' ? p.sport.toLowerCase() : '';
    if (key === 'insights') { st.shown = PAGE; if (sp) st.sport = SPN[sp] ? sp : 'all'; if (p.day === 'tomorrow' || p.day === 'today') st.day = p.day; }
    else { if (sp) st.x.sport = SPN[sp] ? sp : 'all'; if (p.day === 'tomorrow' || p.day === 'today') st.x.day = p.day; }
  }
  function analyze(it) {
    if (!it) return;
    if (it.td) SB.goTab('propan', { name: it.name, stat: 'td', team: it.team, gid: it.gid });
    else SB.goTab('propan', { id: it.pl.id, line: it.thr });
  }
  const itemById = id => { for (const v of CACHE.m.values()) { const it = v.byId.get(id); if (it) return it; } return null; };

  // re-render, then put keyboard focus back on the control that was used (the old node is gone after the redraw)
  function rerender(sel) {
    SB.render();
    if (!sel) return;
    try { const el = document.querySelector('.ins-root ' + sel); if (el) el.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
  }
  const attrSel = (a, v) => `[${a}="${String(v).replace(/["\\]/g, '\\$&')}"]`;
  // ---------- events (delegated, scoped to this module's root) ----------
  document.addEventListener('click', e => {
    const root = e.target.closest && e.target.closest('.ins-root'); if (!root) return;
    const t = e.target.closest('button,[data-ins-row],tr'); if (!t) return;
    const pill = t.getAttribute('data-ui-pill');
    if (pill) {
      const [n, k] = pill.split('|');
      if (n === 'ins-sport') { st.sport = k; st.shown = PAGE; rerender(attrSel('data-ui-pill', pill)); }
      else if (n === 'exp-sport') { st.x.sport = k; rerender(attrSel('data-ui-pill', pill)); }
      return;
    }
    const seg = t.getAttribute('data-ui-seg');
    if (seg && seg.startsWith('exp-rank|')) { st.x.sort = { k: seg.split('|')[1], dir: -1 }; saveX(); rerender(attrSel('data-ui-seg', seg)); return; }
    const so = t.getAttribute('data-ui-sort');
    if (so && so.startsWith('exp|')) { const k = so.split('|')[1]; st.x.sort = st.x.sort.k === k ? { k, dir: -st.x.sort.dir } : { k, dir: colDir(k) }; saveX(); rerender(attrSel('data-ui-sort', so)); return; }
    if (t.hasAttribute('data-ins-slip')) {
      const id = t.getAttribute('data-ins-slip'), i = id.indexOf('|'), gid = id.slice(0, i), key = id.slice(i + 1);
      const was = SB.inSlip(gid, key), r = SB.toggleLeg(gid, key);
      if (!was && !r && !SB.inSlip(gid, key)) SB.toast('This leg can no longer be added (its game may have started).');
      syncSlip(); return;
    }
    if (t.hasAttribute('data-ins-an')) { analyze(itemById(t.getAttribute('data-ins-an'))); return; }
    if (t.hasAttribute('data-ins-more')) { const n = st.shown; st.shown += PAGE; rerender(`.ins-grid > .ui-prop:nth-child(${n + 1}) .front [data-ui-flip]`); return; }
    if (t.hasAttribute('data-ins-day')) { st.day = t.getAttribute('data-ins-day'); st.shown = PAGE; SB.render(); return; }
    if (t.hasAttribute('data-ins-go')) { SB.goTab(t.getAttribute('data-ins-go'), {}); return; }
    if (t.hasAttribute('data-ins-copy')) { copyTable(); return; }
    const row = t.matches('[data-ins-row]') ? t : (t.tagName === 'TR' && t.closest('tbody') ? t.querySelector('[data-ins-row]') : null);
    if (row) { const r = EXROWS[+row.getAttribute('data-ins-row')]; if (r) analyze(r.it); }
  });
  document.addEventListener('change', e => {
    const s = e.target; if (!s || !s.matches || !s.matches('.ins-root select[data-ui-select]')) return;
    const n = s.getAttribute('data-ui-select'), v = s.value;
    if (n === 'ins-day') { st.day = v === 'tomorrow' ? 'tomorrow' : 'today'; st.shown = PAGE; }
    else if (n === 'ins-sort') { st.sort = SORTS[v] ? v : 'p'; st.shown = PAGE; store.set('ins.sort', st.sort); }
    else if (n === 'exp-day') st.x.day = v === 'tomorrow' ? 'tomorrow' : 'today';
    else if (n === 'exp-stat') st.x.stat = v;
    else if (n === 'exp-team') st.x.team = v;
    else if (n === 'exp-minp') st.x.minp = clamp(+v || 0, 0, 0.95);
    else if (n === 'exp-lines') st.x.lines = v === 'all' ? 'all' : 'main';
    else if (n === 'exp-rows') st.x.rows = [25, 50, 100].includes(+v) ? +v : 25;
    else return;
    saveX(); rerender(attrSel('data-ui-select', n));
  });
  if (typeof SB.on === 'function') {
    SB.on('slip', () => syncSlip());
    SB.on('data', () => { CACHE = { data: null, m: new Map() }; ftWait = false; });
  }

  SB.registerTab({ key: 'insights', label: 'Insights', render: renderInsights });
  SB.registerTab({ key: 'explorer', label: 'Prop Explorer', render: renderExplorer });
  // read-only hooks for tests and other screens
  window.__insights = { board: day => board(day || dayKey('today')), dayKey, matchupOf, hitsFor, get seasonState() { return SEAS_ST; }, get rows() { return EXROWS; } };
})();
