// builder.js: the Parlay screen ('builder', docs/pro-interface.md screen 3) on the window.SB v2 API.
// Two ways to a slip:
//  - Swipe: a deck of the day's prop cards (the same props the Insights board shows: one line per player at the ladder line nearest
//    65%, plus NFL anytime touchdowns), read from insights.js (window.__insights.board) with a small fallback of our own. The top
//    card is the flip card (SB.ui.propCard): name, position, matchup, market, fair odds, hit-rate dots and the matchup score.
//    ✕ Pass / ✓ Add to slip, the Left / Right keys, or drag / swipe past a threshold (ADD / PASS labels while dragging; no fly-out
//    animation with prefers-reduced-motion). Legs already in the slip are skipped. Undo last puts the card back (and takes the leg
//    out of the slip if it was added).
//  - Generate: sport, legs (2-10) and risk go to the engine's own builder (SB.engine.buildTicket); the result is the app's parlay
//    card (SB.ticketCard: swap legs, 500,000 runs) and "Use this slip" puts its legs in the slip (SB.replaceSlip, with Undo).
//    Risk mapping (buildTicket options):
//      Safer      {minP: .75}               floor mode: every leg 75%+ (model), the surest legs first
//      Balanced   {minP: .55, target: .62}  legs as close to 62% as the slate allows
//      Long shot  {minP: .30, target: .45}  legs near 45% (player legs start at 50%, so a long shot leans on game legs)
//    "Players only" = propsOnly; perPlayer 1; perGame 3 for one sport, else 2; "Build another" changes the seed.
// The slip panel (the app's one slip, SB.slip) sits beside the deck when there is room and below it on phones: each leg's model
// chance and fair odds, the joint chance (SB.parlayProb: same-game legs priced together) next to the "if unrelated" product, fair
// odds and payout, which legs help or work against each other (engine.legRho / helpWhy), Save to My Parlays, Check slip, Copy slip.
// We have no sportsbook prop prices and no book connection: every chance is a model estimate and bets are placed at your own book.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('builder.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc;
  const num = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pct = p => (!num(p) ? '—' : p > 0 && p < 0.001 ? '<0.1%' : p < 0.1 ? (p * 100).toFixed(1) + '%' : Math.round(p * 100) + '%');
  const f1 = x => (num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());
  const store = SB.store || { get: (k, d) => d, set() {} };
  const KEY = 'builder';
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'College FB', nhl: 'NHL', soccer: 'Soccer' };
  const SPS = { nba: 'NBA', nfl: 'NFL', ncaaf: 'CFB', nhl: 'NHL', soccer: 'SOC' };
  const SPORDER = ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'];
  const MKT = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', rec: 'Receptions', ryd: 'Rushing yards', recyd: 'Receiving yards', pyd: 'Passing yards', hpts: 'Points', sog: 'Shots on goal', sot: 'Shots on target', td: 'Anytime TD' };
  const UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', rec: 'catches', ryd: 'yds', recyd: 'yds', pyd: 'yds', hpts: 'pts', sog: 'shots', sot: 'shots', td: 'TDs' };
  const RISK = {
    safer: { label: 'Safer', minP: 0.75, target: null, note: 'Every leg 75%+ by the model, the surest legs first.' },
    balanced: { label: 'Balanced', minP: 0.55, target: 0.62, note: 'Legs as close to 62% each as the slate allows.' },
    long: { label: 'Long shot', minP: 0.3, target: 0.45, note: 'Legs near 45% each. Player lines start at 50%, so this leans on game legs.' },
  };
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const whenOf = g => tFmt.format(new Date(SB.startMs(g))) + ' PT';
  const dFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const dayLabel = day => { const t = Date.parse(day + 'T12:00:00Z'); return isFinite(t) ? dFmt.format(new Date(t)) : day; };
  const dayKey = which => { const t = E.dayOf(Date.now()); return which === 'tomorrow' ? E.nextDay(t) : t; };
  const reduced = () => { try { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
  const showing = () => SB.tab === KEY;

  // ---------- state (settings kept on the device; the deck lives for the session) ----------
  const st = {
    mode: store.get('bld.mode', 'swipe') === 'gen' ? 'gen' : 'swipe',
    day: 'today', sport: 'all',
    n: clamp(Math.round(+store.get('bld.n', 4)) || 4, 2, 10),
    risk: RISK[store.get('bld.risk', 'balanced')] ? store.get('bld.risk', 'balanced') : 'balanced',
    props: store.get('bld.props', false) === true,
    seed: 0, T: null, opts: null, cardId: null, gone: false,
    decks: new Map(),          // day|sport -> {done: Map(id -> 'add'|'pass'), hist: [{id, act, gid, key, added, name}], pin}
    copyFail: null,            // the slip text, shown in a box when the clipboard is blocked
  };
  const saveSet = () => { store.set('bld.mode', st.mode); store.set('bld.n', st.n); store.set('bld.risk', st.risk); store.set('bld.props', st.props); };
  const deckOf = () => { const k = dayKey(st.day) + '|' + st.sport; if (!st.decks.has(k)) st.decks.set(k, { done: new Map(), hist: [], pin: null }); return st.decks.get(k); };

  // ---------- the deck: the Insights board (one line per player near 65%, NFL anytime TDs) ----------
  function matchupOf(g, team) {
    let c = null; try { c = E.teamCtx(g, team); } catch (e) { c = null; }
    if (!c || !num(c.tf)) return null;
    const pb = num(c.pb) ? c.pb : 0, s = Math.round(clamp(50 + 250 * (c.tf - 1) - 60 * Math.max(0, pb - 0.15), 0, 100));
    return { s, tf: c.tf, pb, label: s >= 60 ? 'Soft matchup' : s < 40 ? 'Tough' : 'Neutral' };
  }
  const splitName = n => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 ? [w[0], w.slice(1).join(' ')] : ['', w[0] || '']; };
  // used only when insights.js is missing: player props at the line nearest 65%, recent form from playerform
  let FB = { data: null, m: new Map() };
  function fallbackItems(day) {
    if (FB.data !== SB.DATA) FB = { data: SB.DATA, m: new Map() };
    if (FB.m.has(day)) return FB.m.get(day);
    const games = E.dayGames(day), G = new Map(games.map(g => [g.id, g])), out = [], seen = new Set();
    for (const pl of (SB.DATA && SB.DATA.players) || []) {
      const g = G.get(pl && pl.gid); if (!g || !E.LADDER[pl.stat] || pl.status === 'out') continue;
      const dk = g.id + '|' + E.nameKey(pl.name) + '|' + pl.stat; if (seen.has(dk)) continue;
      let legs = []; try { legs = E.playerLegs(pl); } catch (e) { legs = []; }
      if (!legs.length) continue; seen.add(dk);
      const L = legs.reduce((a, b) => (Math.abs(b.p - 0.65) < Math.abs(a.p - 0.65) ? b : a));
      let rf = null; try { rf = E.recentOf(pl); } catch (e) { rf = null; }
      const vals = rf && Array.isArray(rf.last5) ? rf.last5.map((v, i) => ({ v: +v, o: (rf.opp5 || [])[i] || '' })).filter(x => num(x.v)) : [];
      const [first, last] = splitName(pl.name);
      out.push({ td: false, pl, g, gid: g.id, sp: g.sport, stat: pl.stat, name: pl.name, first, last, team: pl.team, pos: pl.pos || '', log: { vals, src: vals.length ? 'recent form' : '' },
        M: null, mu: matchupOf(g, pl.team), inj: null, savg: num(pl.avg) ? pl.avg : null, start: SB.startMs(g), matchup: `${g.away.abbr} @ ${g.home.abbr}`, when: whenOf(g),
        id: g.id + '|' + L.key, key: L.key, thr: L.thr, p: L.p, market: MKT[pl.stat] || E.STATN[pl.stat] || pl.stat, marketEm: L.thr + '+' });
    }
    FB.m.set(day, out); return out;
  }
  function boardItems(day) {
    const I = window.__insights;
    if (I && typeof I.board === 'function') { try { const B = I.board(day); if (B && Array.isArray(B.items)) return B.items; } catch (e) { /* fall through */ } }
    return fallbackItems(day);
  }
  // the Insights default order: model chance, then recent hit rate, then tip-off
  const rate = x => (x.n5 ? x.h5 / x.n5 : -1);
  const byChance = (a, b) => b.p - a.p || rate(b) - rate(a) || a.start - b.start || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let SORTC = { src: null, sport: null, out: [] };
  function deckList() {
    const items = boardItems(dayKey(st.day));
    if (SORTC.src !== items || SORTC.sport !== st.sport) SORTC = { src: items, sport: st.sport, out: (st.sport === 'all' ? items.slice() : items.filter(x => x.sp === st.sport)).sort(byChance) };
    return SORTC.out;
  }
  // the deck without games that kicked off since the board was built (the board is cached per feed load)
  const liveList = () => deckList().filter(it => { const g = it.g || SB.gameById(it.gid); return !!g && SB.openG(g); });
  function queue(list) {
    const D = deckOf(), q = (list || liveList()).filter(it => !D.done.has(it.id) && !SB.inSlip(it.gid, it.key));
    if (D.pin) { const i = q.findIndex(x => x.id === D.pin); if (i > 0) q.unshift(q.splice(i, 1)[0]); }
    return q;
  }
  // season box scores and touchdown prices load on demand. insights.js indexes season.json only once its own tab has been shown,
  // so until then its board has no NFL / college / NHL / soccer box scores (and no season TDs). We read the same file (SB.season(),
  // fetched once by the app) and count each card's recent games ourselves (logFor), matching the player by name and team (ESPN
  // abbreviation first, then the team name) the way the Insights board does.
  let ftAsked = false, SEA = { st: 'idle', d: null, ix: {} };
  const SLOG = new Map();
  function needSide() {
    const I = window.__insights, F = window.__firsttd;
    if (I && typeof I.needSeason === 'function') { try { I.needSeason(); } catch (e) { /* optional */ } }
    if (SEA.st === 'idle' && typeof SB.season === 'function') {
      SEA.st = 'loading';
      Promise.resolve(SB.season()).then(d => { SEA = { st: d && d.sports ? 'ok' : 'none', d: d && d.sports ? d : null, ix: {} }; }, () => { SEA = { st: 'none', d: null, ix: {} }; })
        .then(() => { SLOG.clear(); if (showing()) safeRender(); });
    }
    if (!ftAsked && F && !F.FT && typeof F.load === 'function') {
      ftAsked = true;
      Promise.resolve(F.load()).then(() => { if (showing()) safeRender(); }).catch(() => {});
    }
  }
  function seaIdx(sp) {
    if (!SEA.d) return null;
    if (SEA.ix[sp] !== undefined) return SEA.ix[sp];
    const S = SEA.d.sports[sp];
    if (!S || !Array.isArray(S.players)) return (SEA.ix[sp] = null);
    const fi = {}; (S.fields || []).forEach((f, i) => { fi[f] = 3 + i; });
    const byName = new Map();
    for (const p of S.players) if (p && p.n && Array.isArray(p.log)) { const k = E.nameKey(p.n); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
    const teams = S.teams && typeof S.teams === 'object' && !Array.isArray(S.teams) ? S.teams : {};
    return (SEA.ix[sp] = { fi, byName, teams, byTeam: new Map(Object.entries(teams).map(([ab, nm]) => [E.nameKey(nm), ab])) });
  }
  function seaPlayer(sp, name, abbr, teamName) {
    const X = seaIdx(sp); if (!X) return null;
    const c = X.byName.get(E.nameKey(name)); if (!c || !c.length) return null;
    const nk = E.nameKey(teamName), last = s => { const a = E.nameKey(s).split('-'); return a[a.length - 1]; };
    let ab = null;
    if (X.teams[abbr] && (!teamName || last(X.teams[abbr]) === last(teamName))) ab = abbr;
    else if (nk && X.byTeam.has(nk)) ab = X.byTeam.get(nk);
    else if (nk) { for (const [k, a] of X.byTeam) if (k.length > 4 && (k.startsWith(nk) || nk.startsWith(k))) { ab = a; break; } }
    if (!ab && X.teams[abbr]) ab = abbr;
    const same = c.find(p => p.t === ab); if (same) return same;
    return c.length === 1 && (sp !== 'ncaaf' || !ab) ? c[0] : null;   // college names repeat, so there the team must match
  }
  // the card's recent games, oldest first [{d, o, v}], plus season TDs for touchdown cards. We count them ourselves (not from the
  // Insights board) because box-score logs (season.json and nbalast4.json) are dated by the game's UTC start date: a game counts
  // when its date is before the priced game's UTC date and not after today's UTC date. Cutting at the Los Angeles day would drop
  // last night's game on a back-to-back (a 7 PM PT game on Nov 22 is dated Nov 23). With no box scores, the board's own recent
  // form (playerform last 5) stays.
  const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
  function logFor(it) {
    if (SLOG.has(it.id)) return SLOG.get(it.id);
    const own = { vals: it.log && Array.isArray(it.log.vals) ? it.log.vals : [], src: (it.log && it.log.src) || '', stot: it.stot != null ? it.stot : null, sgp: it.sgp != null ? it.sgp : null };
    let out = own;
    try {
      const g = it.g || SB.gameById(it.gid);
      if (g) {
        const cut = utcDay(SB.startMs(g)), today = utcDay(Date.now()), ok = d => /^\d{4}-\d\d-\d\d/.test(d) && d.slice(0, 10) < cut && d.slice(0, 10) <= today;
        const by = new Map(), X = seaIdx(it.sp), me = g.home.abbr === it.team ? g.home : g.away;
        const P = X ? seaPlayer(it.sp, it.name, it.team, me.name) : null;
        let stot = null, sgp = null;
        if (P) {
          const f = X.fi, fv = r => (it.td ? (+r[f.rtd] || 0) + (+r[f.ctd] || 0) : it.stat === 'hpts' ? (+r[f.g] || 0) + (+r[f.a] || 0) : f[it.stat] != null ? +r[f[it.stat]] : NaN);
          for (const r of P.log) { if (!Array.isArray(r) || !ok(String(r[0]))) continue; const v = fv(r); if (num(v)) by.set(String(r[0]).slice(0, 10), { d: String(r[0]).slice(0, 10), o: r[1], v }); }
          if (it.td && Array.isArray(P.tot) && f.rtd != null) { stot = (+P.tot[f.rtd - 3] || 0) + (+P.tot[f.ctd - 3] || 0); sgp = P.gp; }
        }
        if (it.sp === 'nba' && (it.stat === 'pts' || it.stat === 'reb' || it.stat === 'ast')) {
          let L = null; try { L = E.last4Of(it.team, it.name); } catch (e) { L = null; }
          if (L && Array.isArray(L.rows)) for (const r of L.rows) { const d = String((r && r.date) || '').slice(0, 10); if (r && !r.dnp && num(r[it.stat]) && ok(d) && !by.has(d)) by.set(d, { d, o: r.opp, v: r[it.stat] }); }
        }
        const vals = [...by.values()].sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
        if (vals.length) out = { vals, src: 'box scores', stot: stot != null ? stot : own.stot, sgp: stot != null ? sgp : own.sgp };
        else if (stot != null) out = Object.assign({}, own, { stot, sgp });
      }
    } catch (e) { out = own; }
    SLOG.set(it.id, out); return out;
  }

  // ---------- the top card ----------
  function hitsOf(it) {
    const vals = logFor(it).vals.slice(-10), thr = it.td ? 1 : it.thr;
    const hits = vals.map(x => x.v >= thr), h = hits.filter(Boolean).length, n = hits.length;
    return { hits, h, n, label: n ? `L${n} · ${h} of ${n}` + (n < 5 ? ' (few games)' : '') : 'No recent games logged' };
  }
  function backOf(it, H) {
    const mu = it.mu, b = E.BLOW && E.BLOW[it.sp], u = UNIT[it.stat] || '', M = it.M, LG = logFor(it);
    const rows = [], l5 = LG.vals.slice(-5), a5 = l5.length ? l5.reduce((s, x) => s + x.v, 0) / l5.length : null;
    if (it.td) { rows.push(['Season TDs', LG.stot != null ? `${LG.stot} in ${LG.sgp} game${LG.sgp === 1 ? '' : 's'}` : '—']); rows.push([`Last ${H.n || 10}`, H.n ? `scored in ${H.h} of ${H.n}` : '—']); }
    else {
      rows.push(['Projection', M && num(M.an) ? `${f1(M.an)} ${u}` + (num(M.pb) && M.pb > 0.02 && num(M.ab) && Math.abs(M.ab - M.an) > 0.05 ? ` · ${f1(M.ab)} if a blowout` : '') : '—']);
      rows.push(['Season avg', it.savg != null ? `${f1(it.savg)} ${u}` : '—']);
      rows.push(['Last 5 avg', a5 != null ? `${f1(a5)} ${u} (${l5.length} game${l5.length === 1 ? '' : 's'})` : '—']);
    }
    rows.push(['Team points', mu ? `${mu.tf >= 1 ? '+' : '−'}${Math.abs(Math.round((mu.tf - 1) * 100))}% vs league avg` : 'No game price yet']);
    rows.push(['Blowout risk', mu && b ? `${pct(mu.pb)} (${b}+ pts)` : '—']);
    rows.push(['Injury report', it.inj ? cap(it.inj.status) + (it.inj.injury ? ' · ' + it.inj.injury : '') : 'Not listed']);
    const ln = it.td ? 'a TD' : it.thr + '+';
    const note = H.n >= 3 ? `Model ${pct(it.p)} against ${H.h} of ${H.n} lately at ${ln}. ${H.n < 10 ? 'A small sample: weigh both.' : 'Past games are a guide, not a promise.'}`
      : H.n ? `Only ${H.n} recent game${H.n > 1 ? 's' : ''} logged, too few to judge.` : 'No recent box scores for him in our logs.';
    return { rows, note: (it.inj && it.inj.status && !/^active$/i.test(it.inj.status) ? `Listed ${String(it.inj.status).toLowerCase()}: check his status before you bet. ` : '') + note };
  }
  // the front's strip of his last games against this line (oldest first)
  function stripOf(it) {
    const l5 = logFor(it).vals.slice(-5), thr = it.td ? 1 : it.thr, ln = it.td ? 'a TD' : it.thr + '+';
    if (!l5.length) return `<div class="bld-l5"><span class="ui-lbl">Last games</span><span class="none">No recent games logged for him</span></div>`;
    const lab = `His last ${l5.length} against ${ln}: ` + l5.map(x => `${x.v}${x.o ? ' vs ' + x.o : ''}`).join(', ');
    return `<div class="bld-l5" role="img" aria-label="${esc(lab)}"><span class="ui-lbl">Last ${l5.length} · vs ${esc(ln)}</span><span class="g">${l5.map(x => `<span class="${x.v >= thr ? 'h' : 'm'}"><b>${esc(Number.isInteger(x.v) ? x.v : f1(x.v))}</b><i>${esc(String(x.o || '').slice(0, 4))}</i></span>`).join('')}</span></div>`;
  }
  const legName = it => `${it.name} ${it.td ? 'anytime TD' : it.thr + '+ ' + (E.STATN[it.stat] || it.stat)}`;
  function cardHTML(it, cls, attrs) {
    const H = hitsOf(it), B = backOf(it, H);
    const html = U.propCard({
      id: 'bld|' + it.id, first: it.first, last: it.last, team: it.team, pos: it.pos, matchup: it.matchup, when: it.when,
      market: it.market, marketEm: it.marketEm, chance: it.p, hits: H.hits, hitLabel: H.label,
      matchupScore: it.mu ? it.mu.s : null, matchupLabel: it.mu ? it.mu.label : 'No game price yet',
      back: B, flipLabel: 'Flip for the full matchup', actions: [],
    });
    return `<div class="${cls}"${attrs || ''}>${html.replace('<div class="ft">', () => stripOf(it) + '<div class="ft">')}</div>`;   // the first .ft is the front face's footer
  }

  // ---------- the slip ----------
  const legSig = L => L.gid + '|' + L.key;
  function legView(L) {
    const g = SB.gameById(L.gid), k = String(L.key || '');
    let label = L.label || k; try { label = SB.legLabel(L) || label; } catch (e) { /* keep the stored label */ }
    let name = label, mkt = '', team = null;
    if (E.isP(k)) {
      const i = E.pLegInfo(k);
      if (i && i.pl) { name = i.pl.name; team = i.pl.team; mkt = i.under ? `Under ${i.thr} ${E.STATN[i.pl.stat] || i.pl.stat}` : `${i.thr}+ ${MKT[i.pl.stat] || E.STATN[i.pl.stat] || i.pl.stat}`; }
    } else if (/^TD:A:/.test(k)) {
      const [, , tm, slug] = k.split(':'), x = E.nflByTd && typeof E.nflByTd.get === 'function' ? E.nflByTd.get(tm + '|' + slug) : null;
      name = x && x.name ? x.name : label.replace(/\s*(to score|anytime).*$/i, '') || slug; team = tm; mkt = 'Anytime TD';
    } else {
      let m = null; try { m = E.legMeta(L); } catch (e) { m = null; }
      team = m && m.team ? m.team : null;
    }
    let p = null; try { p = g ? SB.p1(g, k) : null; } catch (e) { p = null; }
    const open = !!g && SB.openG(g);
    return { L, g, label, name, mkt, team, p: num(p) ? p : null, open, game: g ? `${g.away.abbr} @ ${g.home.abbr}` : 'Game no longer listed', when: g ? whenOf(g) : '' };
  }
  function slipState() {
    const views = (SB.slip || []).map(legView), live = views.filter(v => v.open);
    let pr = { p: null, indep: null };
    if (live.length) { try { pr = SB.parlayProb(live.map(v => v.L)); } catch (e) { pr = { p: null, indep: null }; } }
    const help = [], hurt = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const A = live[i].L, B = live[j].L; if (A.gid !== B.gid) continue;
      let r = null; try { r = E.legRho(E.legMeta(A), E.legMeta(B), A.gid); } catch (e) { r = null; }
      if (!r || !num(r.r) || Math.abs(r.r) < 0.1) continue;
      let why = ''; try { why = E.helpWhy(r, A, B); } catch (e) { why = ''; }
      (r.r > 0 ? help : hurt).push({ a: live[i].label, b: live[j].label, r: r.r, why });
    }
    const sameGame = live.some((v, i) => live.some((w, j) => j > i && w.L.gid === v.L.gid));
    return { views, live, p: pr.p, indep: pr.indep, help, hurt, sameGame };
  }
  function slipText(S) {
    if (!S.live.length) return '';
    const lines = [`Safe Bets slip (${S.live.length} leg${S.live.length === 1 ? '' : 's'})`];
    S.live.forEach((v, i) => lines.push(`${i + 1}. ${v.label} · ${v.game}, ${v.when} · model ${pct(v.p)}, fair odds ${U.fair(v.p)}`));
    lines.push(`Together: model ${pct(S.p)} (${pct(S.indep)} if unrelated) · fair odds ${U.fair(S.p)}${U.pays(S.p) ? ' · ' + U.pays(S.p) + ' at fair odds' : ''}`);
    lines.push('Model estimates, not book prices. Bet only at the fair odds or better, at your own book.');
    return lines.join('\n');
  }
  function slipHTML() {
    const S = slipState(), n = S.live.length, stale = S.views.length - n;
    if (st.copyFail && st.copyFail !== slipText(S)) st.copyFail = null;   // the hand-copy box only ever shows the current slip
    const legs = S.views.map((v, i) => `<div class="bld-leg${v.open ? '' : ' off'}" data-bld-leg="${esc(legSig(v.L))}">
      ${U.team(v.team || SPS[v.g ? v.g.sport : ''] || '?')}
      <div class="bl-t"><b class="bl-n">${esc(v.name)}</b><span class="bl-m">${esc([v.mkt, v.game].filter(Boolean).join(' · '))}</span>${v.open ? '' : '<span class="bl-s">Started: left out of the math</span>'}</div>
      <div class="bl-o"><b>${esc(v.open ? U.fair(v.p) : '—')}</b><small>${esc(v.open ? pct(v.p) : '')}</small></div>
      <button type="button" class="bl-x" data-bld-rm="${esc(legSig(v.L))}" aria-label="${esc('Remove ' + v.label + ' from your slip')}" data-bld-i="${i}">✕</button></div>`).join('');
    const sum = n ? `<div class="bld-sum" data-p="${esc(S.p)}" data-indep="${esc(S.indep)}">
      <span class="ui-lbl">${n} leg${n === 1 ? '' : 's'}</span>
      <div class="bld-price"><b class="bld-big" title="fair odds of the model's joint chance">${esc(U.fair(S.p))}</b><span>${esc(U.pays(S.p) ? U.pays(S.p) + ' at fair odds' : '')}</span></div>
      <div class="bld-chance">Model chance <b data-bld-p>${esc(pct(S.p))}</b> together · <b data-bld-indep>${esc(pct(S.indep))}</b> if unrelated</div>
      ${S.p === 0 ? '<div class="bld-warn">These legs can\'t all win together. Remove one.</div>' : ''}</div>` : '';
    let links = '';
    if (n > 1) {
      const li = (x, good) => `<li class="${good ? 'good' : 'bad'}"><b>${esc(x.a)} + ${esc(x.b)}</b><span>${esc(x.why || (good ? 'these legs tend to land together' : 'these legs tend to pull apart'))}</span></li>`;
      links = `<div class="bld-links">${S.help.length ? `<div class="ui-lbl">Legs that help each other</div><ul>${S.help.slice(0, 4).map(x => li(x, true)).join('')}</ul>` : ''}${S.hurt.length ? `<div class="ui-lbl">Legs that work against each other</div><ul>${S.hurt.slice(0, 4).map(x => li(x, false)).join('')}</ul>` : ''}${!S.help.length && !S.hurt.length ? `<p class="bld-nolink">${S.sameGame ? 'No measured link between your same-game legs: they are priced as unrelated.' : 'Legs on different games are priced as unrelated.'}</p>` : ''}</div>`;
    }
    const fail = st.copyFail ? `<label class="bld-copyfail"><span class="ui-lbl">Your slip as text: select it and copy</span><textarea readonly rows="${Math.min(10, st.copyFail.split('\n').length + 1)}" data-bld-copytxt>${esc(st.copyFail)}</textarea></label>` : '';
    return `<div class="bld-sh"><div class="bld-h" id="bld-slip-h" role="heading" aria-level="2" tabindex="-1">Your slip</div>${S.views.length ? '<button type="button" class="ui-link" data-bld-clear="1">Clear</button>' : ''}</div>
      ${S.views.length ? `<div class="bld-legs">${legs}</div>` : '<div class="bld-none">No legs yet. Add cards from the deck, or let the generator build a slip.</div>'}
      ${stale ? `<p class="bld-nolink">${stale} leg${stale === 1 ? ' has' : 's have'} started and ${stale === 1 ? 'is' : 'are'} left out of the chance below.</p>` : ''}
      ${sum}${links}
      <button type="button" class="ui-cta bld-copy" data-bld-copy="1"${n ? '' : ' disabled'}>Copy slip</button>
      <div class="bld-two"><button type="button" class="ui-ghost sm" data-bld-save="1"${n ? '' : ' disabled'}>Save to My Parlays</button><button type="button" class="ui-ghost sm" data-bld-check="1">Check slip</button></div>
      ${fail}
      <p class="bld-book">Bets are placed at your own book. Safe Bets has no book connection: copy the slip, enter it there, and bet only at the fair odds or better.</p>`;
  }

  // ---------- views ----------
  function sportItems() {
    if (st.mode === 'swipe') {
      const items = boardItems(dayKey(st.day)), n = {};
      for (const x of items) n[x.sp] = (n[x.sp] || 0) + 1;
      const out = [{ k: 'all', label: 'All', n: items.length }].concat(SPORDER.filter(s => n[s]).map(s => ({ k: s, label: SPN[s], n: n[s] })));
      if (st.sport !== 'all' && !n[st.sport]) out.push({ k: st.sport, label: SPN[st.sport] || st.sport, n: 0 });
      return out;
    }
    const have = genSports(), out = [{ k: 'all', label: 'All' }].concat(have.map(s => ({ k: s, label: SPN[s] })));
    if (st.sport !== 'all' && !have.includes(st.sport)) out.push({ k: st.sport, label: SPN[st.sport] || st.sport });
    return out;
  }
  // sports with a leg to build from in the next week: player props on open games, or priced games
  let GS = { data: null, out: [] };
  function genSports() {
    if (GS.data === SB.DATA) return GS.out;
    const D = SB.DATA || {}, lim = Date.now() + 7 * 864e5, s = new Set();
    for (const pl of D.players || []) { const g = pl && SB.gameById(pl.gid); if (g && SB.openG(g) && SB.startMs(g) <= lim) s.add(g.sport); }
    for (const g of D.games || []) if (SB.priced(g) && SB.startMs(g) <= lim) s.add(g.sport);
    GS = { data: SB.DATA, out: SPORDER.filter(x => s.has(x)) };
    return GS.out;
  }
  function deckHTML() {
    const list = liveList(), q = queue(list), total = list.length, D = deckOf(), day = dayKey(st.day);
    const hist = D.hist.length;
    const undo = `<button type="button" class="ui-link bld-undo" data-bld-act="undo"${hist ? '' : ' disabled'} aria-label="${esc(hist ? 'Undo last: ' + D.hist[hist - 1].name : 'Undo last')}">↺ Undo last</button>`;
    if (!q.length) {
      const other = st.day === 'today' && boardItems(dayKey('tomorrow')).length;
      const msg = !total ? `No ${st.sport === 'all' ? '' : (SPN[st.sport] || st.sport) + ' '}player props ${st.day === 'tomorrow' ? 'tomorrow' : 'left today'} in our feed.` : `That's the deck: all ${total} prop${total === 1 ? '' : 's'} for ${dayLabel(day)} seen.`;
      return `<div class="bld-done">${U.empty(msg)}<div class="ui-row bld-center">${total ? '<button type="button" class="ui-ghost" data-bld-restart="1">Start over</button>' : ''}${other ? '<button type="button" class="ui-ghost" data-bld-day="tomorrow">See tomorrow</button>' : ''}${st.sport !== 'all' ? '<button type="button" class="ui-ghost" data-ui-pill="bld-sport|all">All sports</button>' : ''}<button type="button" class="ui-cta" data-ui-seg="bld-mode|gen">Generate a parlay</button></div><div class="bld-acts">${undo}</div></div>`;
    }
    const top = q[0], pos = total - q.length + 1, nm = legName(top);
    const under = q.slice(1, 3).map((it, i) => cardHTML(it, `bld-under u${i + 1}`, ' aria-hidden="true" inert')).reverse().join('');
    return `<div class="bld-deckhead"><span class="ui-lbl bld-pos"><b>${pos}</b> of ${total}</span><span class="bld-prog" aria-hidden="true"><i style="width:${(100 * (pos - 1) / Math.max(1, total)).toFixed(1)}%"></i></span>${undo}</div>
      <div class="bld-stage"><span class="bld-bg pass" aria-hidden="true">Pass</span><span class="bld-bg add" aria-hidden="true">Add</span>
        <div class="bld-stack">${under}${cardHTML(top, 'bld-top', ` data-bld-id="${esc(top.id)}" role="group" aria-roledescription="prop card" aria-label="${esc(`Card ${pos} of ${total}: ${nm}, model ${pct(top.p)}, fair odds ${U.fair(top.p)}`)}"`).replace('<article', '<span class="bld-stamp add" aria-hidden="true">Add to slip</span><span class="bld-stamp pass" aria-hidden="true">Pass</span><article')}</div></div>
      <div class="bld-acts"><button type="button" class="bld-pass" data-bld-act="pass" aria-label="${esc('Pass on ' + nm)}"><span aria-hidden="true">✕</span> Pass</button><button type="button" class="ui-cta bld-add" data-bld-act="add" aria-label="${esc('Add ' + nm + ' to your slip')}"><span aria-hidden="true">✓</span> Add to slip</button></div>
      <p class="bld-hint">Swipe or drag right to add, left to pass.<span class="bld-keys"> Keys: <kbd>←</kbd> pass, <kbd>→</kbd> add.</span></p>`;
  }
  function genHTML() {
    const R = RISK[st.risk];
    const ctl = `<div class="ui-card bld-gen">
      <div class="bld-field"><span class="ui-lbl" id="bld-n-l">Legs</span><span class="bld-step" role="group" aria-labelledby="bld-n-l"><button type="button" data-bld-n="-1" aria-label="Fewer legs"${st.n <= 2 ? ' disabled' : ''}>−</button><output aria-live="polite" data-bld-nv>${st.n}</output><button type="button" data-bld-n="1" aria-label="More legs"${st.n >= 10 ? ' disabled' : ''}>+</button></span></div>
      <div class="bld-field"><span class="ui-lbl">Risk</span>${U.seg(Object.keys(RISK).map(k => ({ k, label: RISK[k].label })), st.risk, 'bld-risk')}</div>
      <div class="bld-field"><span class="ui-lbl" id="bld-props-l">Players only</span><button type="button" class="bld-sw" role="switch" aria-checked="${st.props}" aria-labelledby="bld-props-l" data-bld-props="1"><span aria-hidden="true"></span></button></div>
      <p class="bld-map"><b>${esc(R.label)}:</b> ${esc(R.note)} ${st.props ? 'Player props only.' : 'Player props and game legs (winners, totals).'}</p>
      <button type="button" class="ui-cta bld-build" data-bld-build="1">${st.T ? 'Build another' : 'Build my parlay'}</button></div>`;
    let out = '';
    if (st.gone && !st.T) out = U.empty('Those legs moved on (a game started or the feed changed). Build again.');
    else if (st.T) {
      const T = st.T, ok = T.legs.length >= T.n, sp = st.sport === 'all' ? 'all sports' : (SPN[st.sport] || st.sport);
      const title = `${T.n}-leg ${R.label.toLowerCase()} parlay · ${sp}`;   // when fewer fit, the card itself says how many qualify
      const sub = `${R.note} Built from the model's own chances; swap any leg (⇄) or run it 500,000 times.`;
      let card = ''; try { card = SB.ticketCard(st.cardId, esc(title), { legs: T.legs, p: T.p, n: T.n }, esc(sub)); } catch (e) { card = U.empty('This parlay could not be drawn. Build again.'); }
      out = `<div class="bld-ticket">${card}</div><div class="ui-row bld-use"><button type="button" class="ui-cta" data-bld-use="1"${ok ? '' : ' disabled'}>Use this slip</button><button type="button" class="ui-ghost" data-bld-again="1">Build another</button></div>` +
        (ok ? '' : `<p class="ui-note">Only ${T.legs.length} leg${T.legs.length === 1 ? '' : 's'} fit right now. Try fewer legs, another sport, a different risk, or turn off Players only.</p>`);
    } else out = `<div class="bld-ph">${U.empty('Pick the sport, the number of legs and the risk, then build. Safe Bets picks the legs from its own model and prices them together.')}</div>`;
    return ctl + out;
  }
  function css() {
    if (document.getElementById('builder-css')) return;
    const s = document.createElement('style'); s.id = 'builder-css';
    s.textContent = `
.bld-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.bld-root .bld-ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.bld-root .ui-seg button{min-height:40px;padding:0 18px}
.bld-root .bld-wrap{container-type:inline-size}
.bld-root .bld-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
@container (min-width:640px){.bld-root .bld-grid{grid-template-columns:minmax(0,1fr) minmax(290px,360px)}.bld-root .bld-slip{position:sticky;top:18px;max-height:calc(100vh - 36px);overflow:auto}}
.bld-root .bld-main{display:flex;flex-direction:column;gap:14px;min-width:0}
.bld-root .bld-deckhead{display:flex;align-items:center;gap:12px;width:100%;max-width:400px;margin:0 auto}
.bld-root .bld-pos{white-space:nowrap}.bld-root .bld-pos b{color:#fff;font-size:12px}
.bld-root .bld-prog{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden}
.bld-root .bld-prog i{display:block;height:100%;background:var(--acc);border-radius:2px}
.bld-root .bld-stage{position:relative;display:flex;justify-content:center;padding:4px 0 30px;min-width:0}
.bld-root .bld-bg{position:absolute;font:900 italic 76px/1 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:-.02em;pointer-events:none;user-select:none;display:none}
.bld-root .bld-bg.pass{left:-24px;top:50%;transform:translateY(-50%) rotate(-90deg);color:rgba(241,30,132,.11)}
.bld-root .bld-bg.add{right:6px;top:-6px;color:rgba(var(--acc-rgb),.09)}
@container (min-width:900px){.bld-root .bld-bg{display:block}}
.bld-root .bld-stack{position:relative;display:grid;width:100%;max-width:400px}
.bld-root .bld-stack>div{grid-area:1/1;min-width:0}
.bld-root .bld-under{pointer-events:none;transform-origin:50% 0}
.bld-root .bld-under.u1{transform:translateY(14px) scale(.95);opacity:.45}
.bld-root .bld-under.u2{transform:translateY(28px) scale(.9);opacity:.2}
.bld-root .bld-top{position:relative;z-index:2;touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none;transition:transform .24s cubic-bezier(.3,.7,.2,1),opacity .24s}
.bld-root .bld-top .ui-prop>.f{box-shadow:0 30px 70px -30px rgba(0,0,0,.9),0 0 60px -30px rgba(var(--acc-rgb),.7)}
.bld-root .bld-top.dragging{transition:none;cursor:grabbing}
.bld-root .bld-top .ui-prop .ln{font-size:27px}
.bld-root .bld-top .ui-prop .ft{justify-content:center;background:rgba(var(--acc-rgb),.06);border-top:1px solid var(--hair)}
.bld-root .bld-stamp{position:absolute;z-index:4;top:30px;padding:6px 14px;border-radius:12px;border:3px solid currentColor;background:rgba(3,7,18,.78);font:900 italic 22px/1 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:.01em;opacity:0;pointer-events:none}
.bld-root .bld-stamp.add{left:14px;color:var(--acc2);transform:rotate(-9deg)}
.bld-root .bld-stamp.pass{right:14px;color:#ff5aa8;transform:rotate(9deg)}
.bld-root .bld-l5{margin:12px 14px 0;padding-top:10px;border-top:1px solid var(--hair);display:flex;flex-direction:column;gap:7px}
.bld-root .bld-l5 .g{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.bld-root .bld-l5 .g>span{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 0 4px;border-radius:9px;background:rgba(0,212,146,.1);border:1px solid rgba(0,212,146,.28)}
.bld-root .bld-l5 .g>span.m{background:rgba(241,30,132,.09);border-color:rgba(241,30,132,.3)}
.bld-root .bld-l5 .g b{font:700 15px/1.1 'Rubik',sans-serif;color:var(--good);font-variant-numeric:tabular-nums}.bld-root .bld-l5 .g .m b{color:#ff5aa8}
.bld-root .bld-l5 .g i{font:600 9.5px var(--fmono);font-style:normal;letter-spacing:.06em;color:#ffffff80}
.bld-root .bld-l5 .none{font:400 12.5px var(--fui);color:#ffffff80}
.bld-root .bld-acts{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.bld-root .bld-acts .bld-pass,.bld-root .bld-acts .bld-add{flex:1 1 0;max-width:195px;justify-content:center}
.bld-root .bld-acts{flex-wrap:nowrap;width:100%;max-width:400px;margin:0 auto}
.bld-root .bld-pass{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:0 22px;border-radius:999px;border:1.5px solid rgba(241,30,132,.6);background:rgba(241,30,132,.08);color:#ff5aa8;font:700 15px var(--fui);cursor:pointer}
.bld-root .bld-pass:hover{background:rgba(241,30,132,.16)}
.bld-root .bld-add{min-height:48px;padding:0 24px;font-size:15px}
.bld-root .bld-undo{min-height:40px;font-size:13px;white-space:nowrap}.bld-root .bld-undo:disabled{color:#ffffff59;cursor:default}
.bld-root .bld-hint{text-align:center;font:400 12.5px var(--fui);color:#ffffff80}
.bld-root kbd{display:inline-block;min-width:20px;padding:0 5px;border:1px solid var(--hair2);border-radius:5px;font:600 11px var(--fmono);color:#ffffffcc}
.bld-root .bld-center{justify-content:center;margin-top:12px}
.bld-root .bld-done .bld-acts{margin-top:10px;justify-content:center}
.bld-root .bld-slip{display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:22px;background:#070c16;border-color:rgba(var(--acc-rgb),.3);box-shadow:0 0 70px -34px rgba(var(--acc-rgb),.7)}
.bld-root .bld-sh{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px}
.bld-root .bld-h{font:700 11px var(--fmono);letter-spacing:.2em;text-transform:uppercase;color:#ffffffb3}
.bld-root .bld-legs{display:flex;flex-direction:column;gap:8px}
.bld-root .bld-leg{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:8px 2px 8px 10px;border-radius:14px;border:1px solid rgba(var(--acc-rgb),.32);background:rgba(255,255,255,.03)}
.bld-root .bld-leg.off{opacity:.55;border-color:var(--hair2)}
.bld-root .bld-leg .ui-team{width:36px;height:36px;font-size:10px}
.bld-root .bld-leg .bl-t{min-width:0;display:flex;flex-direction:column;gap:2px}
.bld-root .bld-leg .bl-n{font:700 15px/1.2 'Rubik',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bld-root .bld-leg .bl-m{font:500 12px/1.3 var(--fui);color:#ffffffa6;overflow-wrap:anywhere}
.bld-root .bld-leg .bl-s{font:600 11.5px var(--fui);color:var(--mid)}
.bld-root .bld-leg .bl-o{text-align:right;font-variant-numeric:tabular-nums}
.bld-root .bld-leg .bl-o b{display:block;font:800 15px var(--fui);color:var(--acc2)}
.bld-root .bld-leg .bl-o small{font:600 11.5px var(--fui);color:#ffffff99}
.bld-root .bld-leg .bl-x{width:40px;height:40px;border:0;border-radius:50%;background:none;color:#ffffff8c;font:600 15px var(--fui);cursor:pointer}
.bld-root .bld-leg .bl-x:hover{background:rgba(255,255,255,.07);color:#fff}
.bld-root .bld-none{padding:18px 14px;border:1px dashed var(--hair2);border-radius:14px;font:400 13.5px/1.5 var(--fui);color:#ffffffa6;text-align:center}
.bld-root .bld-sum{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.bld-root .bld-price{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px}
.bld-root .bld-price span{font:500 13.5px var(--fui);color:#ffffffcc}
.bld-root .bld-big{font:900 italic 44px/1 'Rubik',sans-serif;letter-spacing:-.02em;background:var(--acc-grad);-webkit-background-clip:text;background-clip:text;color:transparent;padding-right:.08em;font-variant-numeric:tabular-nums}
.bld-root .bld-chance{font:500 13px var(--fui);color:#ffffffb3}.bld-root .bld-chance b{color:#fff}
.bld-root .bld-warn{font:600 13px var(--fui);color:#ff5aa8}
.bld-root .bld-links{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--hair)}
.bld-root .bld-links ul{list-style:none;margin:0 0 4px;padding:0;display:flex;flex-direction:column;gap:6px}
.bld-root .bld-links li{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border-left:3px solid var(--good);background:rgba(0,212,146,.06);font:400 12.5px/1.4 var(--fui);color:#ffffffb3}
.bld-root .bld-links li.bad{border-left-color:var(--mid);background:rgba(255,184,0,.06)}
.bld-root .bld-links li b{font:600 13px/1.35 var(--fui);color:#fff}
.bld-root .bld-nolink{font:400 12.5px/1.45 var(--fui);color:#ffffff8c;margin:0}
.bld-root .bld-copy{width:100%;min-height:50px;font-size:15.5px}
.bld-root .bld-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bld-root .bld-two button{width:100%;padding:0 8px;white-space:normal;line-height:1.2}
.bld-root .bld-copyfail{display:flex;flex-direction:column;gap:6px}
.bld-root .bld-copyfail textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:12px;border:1px solid var(--hair2);background:#030712;color:#fff;font:500 12.5px/1.45 var(--fmono);resize:vertical}
.bld-root .bld-book{margin:0;font:400 12.5px/1.5 var(--fui);color:#ffffff99}
.bld-root .bld-gen{display:flex;flex-direction:column;gap:14px}
.bld-root .bld-field{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.bld-root .bld-step{display:inline-flex;align-items:center;gap:6px;padding:3px;border:1px solid var(--hair2);border-radius:999px;background:rgba(255,255,255,.03)}
.bld-root .bld-step button{width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,.07);color:#fff;font:700 20px/1 var(--fui);cursor:pointer}
.bld-root .bld-step button:disabled{opacity:.35;cursor:default}
.bld-root .bld-step output{min-width:42px;text-align:center;font:800 italic 24px/1 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.bld-root .bld-sw{position:relative;width:56px;height:40px;border:0;background:none;cursor:pointer;padding:0}
.bld-root .bld-sw span{position:absolute;left:2px;top:5px;width:52px;height:30px;border-radius:999px;background:rgba(255,255,255,.14);transition:background .2s}
.bld-root .bld-sw span::after{content:"";position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;background:#fff;transition:transform .2s}
.bld-root .bld-sw[aria-checked="true"] span{background:var(--acc)}.bld-root .bld-sw[aria-checked="true"] span::after{transform:translateX(22px)}
.bld-root .bld-map{margin:0;font:400 13px/1.5 var(--fui);color:#ffffffb3}.bld-root .bld-map b{color:#fff}
.bld-root .bld-build{align-self:flex-start;min-height:48px;padding:0 26px}
.bld-root .bld-ticket .pc{margin:0}
.bld-root .bld-use .ui-cta,.bld-root .bld-use .ui-ghost{min-height:46px}
.bld-root :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
@media (max-width:420px){.bld-root .bld-gen .ui-seg{width:100%;justify-content:space-between}.bld-root .bld-gen .ui-seg button{flex:1;padding:0 8px}.bld-root .bld-build{align-self:stretch}}
@media (prefers-reduced-motion:reduce){.bld-root .bld-top{transition:none}}
@media (hover:none),(pointer:coarse){.bld-root .bld-keys{display:none}}
body:has(.bld-root.bld-side) #slipbar{display:none!important}
`;
    document.head.appendChild(s);
  }

  // ---------- render ----------
  let seenP = null;
  function applyParams(p) {
    // render() passes the same params object until the next goTab: apply each one once
    if (!p || typeof p !== 'object' || seenP === p || !Object.keys(p).length) return; seenP = p;
    const raw = typeof p.sport === 'string' ? p.sport.trim().toLowerCase() : '', sp = { cfb: 'ncaaf', college: 'ncaaf', 'college fb': 'ncaaf' }[raw] || raw;
    if (sp) st.sport = SPN[sp] ? sp : 'all';
    const m = typeof p.mode === 'string' ? p.mode.toLowerCase() : '';
    if (m === 'gen' || m === 'generate') st.mode = 'gen'; else if (m === 'swipe') st.mode = 'swipe';
    if (st.T && sp) { st.T = null; st.gone = false; }
  }
  // a built ticket whose games started or left the feed is dropped (the card would price legs that can't be bet)
  function checkTicket() {
    if (!st.T) return;
    if (st.T.legs.some(L => { const g = SB.gameById(L.gid); return !g || !SB.openG(g); })) { st.T = null; st.gone = true; }
  }
  function render(main, params) {
    css(); applyParams(params); needSide(); checkTicket();
    const head = U.page({ kicker: 'Parlay builder', title: 'Pick your legs,', accent: 'or let the model pick',
      sub: 'Swipe through the slate one prop at a time, or set the sport, legs and risk and Safe Bets builds the slip. Every leg shows the model\'s chance and its fair odds.' });
    const ctrl = `<div class="bld-ctrl">${U.seg([{ k: 'swipe', label: 'Swipe' }, { k: 'gen', label: 'Generate' }], st.mode, 'bld-mode')}${st.mode === 'swipe' ? U.select({ label: 'Day', value: st.day, options: [['today', 'Today'], ['tomorrow', 'Tomorrow']], name: 'bld-day' }) : ''}</div>${U.pills(sportItems(), st.sport, 'bld-sport')}`;
    let body = ''; try { body = st.mode === 'swipe' ? deckHTML() : genHTML(); } catch (e) { console.error(e); body = U.empty('This part could not load. Try the other view.'); }
    main.innerHTML = `<div class="ui-page bld-root" data-mode="${st.mode}">${head}${ctrl}
      <div class="bld-wrap"><div class="bld-grid"><section class="bld-main" aria-label="${st.mode === 'swipe' ? 'Prop deck' : 'Parlay generator'}">${body}</section><aside class="ui-card bld-slip" aria-labelledby="bld-slip-h">${slipHTML()}</aside></div></div>
      <p class="ui-note">Every chance is a model estimate: season averages with recent form, the game's price and blowout risk. Fair odds are what that chance is worth, not a book price; we have no sportsbook prop prices, so there is no edge against a book here. Hit rate counts his logged recent games at the card's line, and a few games are a small sample.</p></div>`;
    sideMode();
  }
  // with the slip panel beside the deck (sticky), the app's floating slip bar would only cover the panel: hide it on this screen
  function sideMode() {
    const r = document.querySelector('.bld-root'), sl = r && r.querySelector('.bld-slip');
    if (sl) r.classList.toggle('bld-side', getComputedStyle(sl).position === 'sticky');
  }
  let rzT = 0;
  window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (showing()) sideMode(); }, 120); });
  let pending = false;
  function safeRender(focusSel) {
    if (!showing()) return;
    if (drag || busy) { pending = true; return; }
    pending = false;
    const sy = window.scrollY;
    SB.render();
    if (Math.abs(window.scrollY - sy) > 2) window.scrollTo(0, sy);
    if (focusSel) {
      try {
        let el = document.querySelector('.bld-root ' + focusSel);
        // the deck ran out (or the button left): keep focus in the deck instead of dropping it on the page
        if ((!el || el.disabled) && /data-bld-act/.test(focusSel)) el = document.querySelector('.bld-root .bld-main [data-bld-restart], .bld-root .bld-main button:not([disabled])');
        if (el && !el.disabled) el.focus({ preventScroll: true });
      } catch (e) { /* focus is a nicety */ }
    }
  }
  const focusedAct = () => { const a = document.activeElement; if (!a || !a.closest || !a.closest('.bld-root')) return null; for (const at of ['data-bld-act', 'data-ui-seg', 'data-ui-pill', 'data-bld-n', 'data-bld-props', 'data-bld-build', 'data-bld-again', 'data-bld-use']) if (a.hasAttribute(at)) return `[${at}="${String(a.getAttribute(at)).replace(/["\\]/g, '\\$&')}"]`; return null; };
  let LIVE = null;
  function say(t) {
    if (!LIVE) { LIVE = document.createElement('div'); LIVE.className = 'bld-sr'; LIVE.setAttribute('role', 'status'); LIVE.setAttribute('aria-live', 'polite'); document.body.appendChild(LIVE); }
    LIVE.textContent = ''; setTimeout(() => { LIVE.textContent = t; }, 40);
  }

  // ---------- deck actions ----------
  let busy = false, finishNow = null, self = false;
  function decide(act) {
    if (finishNow) finishNow();   // a card still flying out: finish it now so quick presses are never lost
    const q = queue(), it = q[0]; if (!it) return;
    const D = deckOf(), el = document.querySelector(`.bld-root .bld-top[data-bld-id="${CSS.escape(it.id)}"]`), nm = legName(it);
    let added = false;
    if (act === 'add') {
      self = true;
      try { if (!SB.inSlip(it.gid, it.key)) { SB.toggleLeg(it.gid, it.key); added = SB.inSlip(it.gid, it.key); } } finally { self = false; }
      if (!added && !SB.inSlip(it.gid, it.key)) { SB.toast(esc('This leg can no longer be added (its game may have started).')); act = 'pass'; }
    }
    D.done.set(it.id, act); D.hist.push({ id: it.id, act, gid: it.gid, key: it.key, added, name: nm }); if (D.pin === it.id) D.pin = null;
    say(act === 'add' ? `Added ${nm} to your slip. ${SB.slip.length} leg${SB.slip.length === 1 ? '' : 's'}.` : `Passed on ${nm}.`);
    const sel = focusedAct();
    const finish = () => { finishNow = null; busy = false; safeRender(sel); };
    if (!el || reduced()) { finish(); return; }
    busy = true; finishNow = finish;
    const sgn = act === 'add' ? 1 : -1;
    el.classList.remove('dragging');
    void el.offsetWidth;   // start the fly-out from where the card is now
    el.style.transform = `translateX(${sgn * 130}%) rotate(${sgn * 16}deg)`; el.style.opacity = '0';
    const s = el.querySelector(act === 'add' ? '.bld-stamp.add' : '.bld-stamp.pass'); if (s) s.style.opacity = '1';
    setTimeout(() => { if (finishNow === finish) finish(); }, 240);
  }
  function undo() {
    if (finishNow) finishNow();
    const D = deckOf(), e = D.hist.pop(); if (!e) return;
    D.done.delete(e.id); D.pin = e.id;
    if (e.act === 'add' && e.added && SB.inSlip(e.gid, e.key)) { self = true; try { SB.toggleLeg(e.gid, e.key); } finally { self = false; } }
    say(`Undone: ${e.name} is back on top${e.act === 'add' && e.added ? ' and out of your slip' : ''}.`);
    safeRender(D.hist.length ? '[data-bld-act="undo"]' : '[data-bld-act="add"]');
  }

  // ---------- drag / swipe ----------
  let drag = null, eatClick = 0;   // eatClick: when a drag ended; the click that ends a drag must not flip the card
  const thresh = el => Math.min(120, Math.max(60, el.getBoundingClientRect().width * 0.28));
  document.addEventListener('pointerdown', e => {
    eatClick = 0;
    const el = e.target.closest && e.target.closest('.bld-root .bld-top'); if (!el || busy || (e.button != null && e.button > 0)) return;
    drag = { el, id: el.getAttribute('data-bld-id'), x0: e.clientX, y0: e.clientY, dx: 0, on: false, pid: e.pointerId };
    if (e.pointerType === 'mouse') e.preventDefault();   // no text selection while dragging with a mouse (a click still fires)
  });
  document.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { drag.on = true; drag.el.classList.add('dragging'); try { drag.el.setPointerCapture(drag.pid); } catch (er) { /* fine without capture */ } }
      else if (Math.abs(dy) > 10) { drag = null; return; }   // a vertical move is a page scroll
      else return;
    }
    drag.dx = dx; e.preventDefault();
    const t = thresh(drag.el), el = drag.el;
    el.style.transform = reduced() ? `translateX(${dx}px)` : `translateX(${dx}px) rotate(${clamp(dx / 18, -14, 14)}deg)`;
    const a = el.querySelector('.bld-stamp.add'), p = el.querySelector('.bld-stamp.pass');
    if (a) a.style.opacity = String(clamp(dx / t, 0, 1)); if (p) p.style.opacity = String(clamp(-dx / t, 0, 1));
    el.classList.toggle('go-add', dx >= t); el.classList.toggle('go-pass', dx <= -t);
  }, { passive: false });
  function endDrag(e, cancel) {
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    const d = drag; drag = null;
    if (!d.on) return;
    eatClick = Date.now();
    const t = thresh(d.el);
    if (!cancel && Math.abs(d.dx) >= t && queue()[0] && queue()[0].id === d.id) { decide(d.dx > 0 ? 'add' : 'pass'); return; }
    d.el.classList.remove('dragging', 'go-add', 'go-pass'); d.el.style.transform = '';
    for (const s of d.el.querySelectorAll('.bld-stamp')) s.style.opacity = '';
    if (pending) safeRender();
  }
  document.addEventListener('pointerup', e => endDrag(e, false));
  document.addEventListener('pointercancel', e => endDrag(e, true));
  // a drag must not also flip the card
  document.addEventListener('click', e => { if (eatClick && Date.now() - eatClick < 300) { eatClick = 0; if (e.target.closest && e.target.closest('.bld-root .bld-top, .bld-root .bld-stage')) { e.stopPropagation(); e.preventDefault(); } } }, true);
  document.addEventListener('keydown', e => {
    if (!showing() || st.mode !== 'swipe' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const a = document.activeElement;
    if (a && a.matches && a.matches('input,select,textarea,[contenteditable="true"],[role="slider"]')) return;
    const sh = document.getElementById('sheet'), side = document.getElementById('side');
    if ((sh && sh.classList.contains('on')) || (side && side.classList.contains('open') && getComputedStyle(side).position === 'fixed' && window.innerWidth < 900)) return;
    if (!document.querySelector('.bld-root .bld-top')) return;
    e.preventDefault(); decide(e.key === 'ArrowRight' ? 'add' : 'pass');
  });

  // ---------- generator ----------
  function optsFor(risk, n, sport, props, seed) {
    const R = RISK[risk] || RISK.balanced, sports = sport === 'all' ? SPORDER.slice() : [sport];
    const o = { n, sports, minP: R.minP, propsOnly: !!props, perPlayer: 1, perGame: sports.length === 1 ? 3 : 2, seed: seed || 0 };
    if (R.target != null) o.target = R.target;
    return o;
  }
  function generate() {
    const o = optsFor(st.risk, st.n, st.sport, st.props, st.seed);
    let T = null; try { T = E.buildTicket(o); } catch (e) { console.error(e); T = null; }
    st.opts = o; st.gone = false;
    st.T = T && Array.isArray(T.legs) ? { legs: T.legs, p: T.p, n: o.n } : { legs: [], p: 0, n: o.n };
    st.cardId = `bld-${st.sport}-${st.n}-${st.risk}-${st.props ? 1 : 0}-${st.seed}`;
    say(st.T.legs.length >= o.n ? `Built a ${o.n}-leg parlay: model chance ${pct(st.T.p)}, fair odds ${U.fair(st.T.p)}.` : `Only ${st.T.legs.length} legs fit right now.`);
  }
  function useTicket() {
    if (!st.T || !st.T.legs.length) return;
    const C = window.__fm2 && window.__fm2.autoCache && window.__fm2.autoCache[st.cardId];   // the card's legs after any swaps
    const src = C && Array.isArray(C.legs) && C.legs.length ? C.legs : st.T.legs;
    const legs = src.map(L => ({ gid: L.gid, key: L.key, label: L.label, sport: L.sport }));
    const had = (SB.slip || []).length;
    self = true; try { (typeof SB.replaceSlip === 'function' ? SB.replaceSlip : SB.setSlip)(legs); } finally { self = false; }
    if (!had) SB.toast(esc(`Your slip now has these ${SB.slip.length} legs`));   // replacing a slip shows the app's own toast with Undo
    say(`Your slip now has ${SB.slip.length} legs.`);
    safeRender('[data-bld-use]');
    const panel = document.querySelector('.bld-root .bld-slip');
    if (panel && panel.getBoundingClientRect().top > window.innerHeight - 80) panel.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------- slip actions ----------
  function copySlip() {
    const S = slipState(), txt = slipText(S); if (!txt) return;
    const fail = () => { st.copyFail = txt; safeRender('[data-bld-copytxt]'); const ta = document.querySelector('.bld-root [data-bld-copytxt]'); if (ta) try { ta.select(); } catch (e) { /* ok */ } SB.toast(esc("Couldn't copy: your browser blocked the clipboard. The slip is in the box under the buttons; select it and copy."), 5000); };
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { fail(); return; }
      navigator.clipboard.writeText(txt).then(() => { if (st.copyFail) { st.copyFail = null; safeRender('[data-bld-copy]'); } SB.toast(esc(`Copied your ${S.live.length}-leg slip with fair odds`)); }, fail);
    } catch (e) { fail(); }
  }
  function saveIt() {
    const S = slipState(); if (!S.live.length) return;
    const legs = S.live.map(v => { const g = v.g || {}; return { gid: v.L.gid, key: v.L.key, label: v.label, sport: g.sport, comp: g.comp, home: g.home && g.home.abbr, away: g.away && g.away.abbr, start: g.start, p1: v.p }; });
    const sig = a => a.map(L => L.gid + '|' + L.key).sort().join(',');
    if ((SB.savedParlays || []).some(x => x && Array.isArray(x.legs) && sig(x.legs) === sig(legs))) { SB.toast('Already in My Parlays'); return; }
    const ok = SB.saveParlay({ legs, p: S.p, src: 'builder' });
    SB.toast(ok ? esc('Saved to My Parlays: it grades itself as the games finish') : 'Could not save these legs');
  }

  // ---------- events (delegated, scoped to this screen) ----------
  document.addEventListener('click', e => {
    const root = e.target.closest && e.target.closest('.bld-root'); if (!root) return;
    const t = e.target.closest('button'); if (!t || t.disabled) return;
    const seg = t.getAttribute('data-ui-seg'), pill = t.getAttribute('data-ui-pill');
    if (seg) {
      const [n, k] = seg.split('|');
      if (n === 'bld-mode' && (k === 'swipe' || k === 'gen')) { st.mode = k; saveSet(); safeRender(`[data-ui-seg="bld-mode|${k}"]`); }
      else if (n === 'bld-risk' && RISK[k]) { st.risk = k; saveSet(); if (st.T) generate(); safeRender(`[data-ui-seg="bld-risk|${k}"]`); }
      return;
    }
    if (pill) { const [n, k] = pill.split('|'); if (n === 'bld-sport') { st.sport = SPN[k] ? k : 'all'; if (st.mode === 'gen' && st.T) generate(); safeRender(`[data-ui-pill="bld-sport|${st.sport}"]`); } return; }
    const act = t.getAttribute('data-bld-act');
    if (act === 'add' || act === 'pass') { decide(act); return; }
    if (act === 'undo') { undo(); return; }
    if (t.hasAttribute('data-bld-restart')) { const D = deckOf(); D.done.clear(); D.hist = []; D.pin = null; safeRender('[data-bld-act="add"]'); return; }
    if (t.hasAttribute('data-bld-day')) { st.day = t.getAttribute('data-bld-day') === 'tomorrow' ? 'tomorrow' : 'today'; safeRender('[data-bld-act="add"]'); return; }
    if (t.hasAttribute('data-bld-n')) { st.n = clamp(st.n + (+t.getAttribute('data-bld-n') || 0), 2, 10); saveSet(); if (st.T) generate(); safeRender(`[data-bld-n="${t.getAttribute('data-bld-n')}"]`); return; }
    if (t.hasAttribute('data-bld-props')) { st.props = !st.props; saveSet(); if (st.T) generate(); safeRender('[data-bld-props]'); return; }
    if (t.hasAttribute('data-bld-build')) { if (st.T) st.seed++; generate(); safeRender('[data-bld-build]'); return; }
    if (t.hasAttribute('data-bld-again')) { st.seed++; generate(); safeRender('[data-bld-again]'); return; }
    if (t.hasAttribute('data-bld-use')) { useTicket(); return; }
    if (t.hasAttribute('data-bld-rm')) {
      const v = t.getAttribute('data-bld-rm'), i = v.indexOf('|'), idx = +t.getAttribute('data-bld-i') || 0;
      self = true; try { if (SB.inSlip(v.slice(0, i), v.slice(i + 1))) SB.toggleLeg(v.slice(0, i), v.slice(i + 1)); } finally { self = false; }
      const n = (SB.slip || []).length; say(`Removed. ${n} leg${n === 1 ? '' : 's'} left.`);
      safeRender(n ? `.bld-leg:nth-child(${Math.min(idx, n - 1) + 1}) .bl-x` : '#bld-slip-h'); return;
    }
    if (t.hasAttribute('data-bld-clear')) { self = true; try { SB.setSlip([]); } finally { self = false; } say('Slip cleared.'); safeRender('#bld-slip-h'); return; }
    if (t.hasAttribute('data-bld-copy')) { copySlip(); return; }
    if (t.hasAttribute('data-bld-save')) { saveIt(); return; }
    if (t.hasAttribute('data-bld-check')) { SB.goTab('slipcheck', {}); return; }
  });
  document.addEventListener('change', e => {
    const s = e.target; if (!s || !s.matches || !s.matches('.bld-root select[data-ui-select="bld-day"]')) return;
    st.day = s.value === 'tomorrow' ? 'tomorrow' : 'today'; safeRender('[data-ui-select="bld-day"]');
  });
  if (typeof SB.on === 'function') {
    // the slip changed somewhere else (a sheet, another screen): redraw the panel and skip legs now in the slip
    SB.on('slip', () => { if (!self && showing()) safeRender(); });
    SB.on('data', () => { SORTC = { src: null, sport: null, out: [] }; GS = { data: null, out: [] }; SLOG.clear(); ftAsked = false; checkTicket(); });
  }

  SB.registerTab({ key: KEY, label: 'Parlay', render });
  // read-only hooks for tests
  window.__builder = { RISK, optsFor, get state() { return { mode: st.mode, sport: st.sport, day: st.day, n: st.n, risk: st.risk, props: st.props, seed: st.seed, opts: st.opts, T: st.T, cardId: st.cardId }; },
    deck: () => queue().map(x => x.id), list: () => liveList().map(x => x.id), item: id => deckList().find(x => x.id === id) || null, slipText: () => slipText(slipState()),
    hits: id => { const it = deckList().find(x => x.id === id); return it ? hitsOf(it) : null; }, log: id => { const it = deckList().find(x => x.id === id); return it ? logFor(it) : null; },
    get seasonState() { return SEA.st; } };
})();
