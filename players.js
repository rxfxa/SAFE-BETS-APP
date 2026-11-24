// players.js: Players ('players', docs/pro-interface.md screen 11) on the window.SB v2 API.
//  - Search any player: this season's ESPN box-score tables (season.json, every sport) plus the players on the slate (DATA.players
//    and NFL anytime-touchdown players).
//  - Sport chips with counts; per sport a "Top" row of cards (NFL: PPR fantasy points a game; NBA: points a game; NHL: points a
//    game; college: yards a game; soccer: goals); one sport opens the full sortable table.
//  - A player page (in-page, with Back): header, season averages, the last 10 games, his props on the slate (ladder with model
//    chances, + Slip, Analyze) and Ask.
// Averages are what happened this season (season totals ÷ games in ESPN's box scores), not projections. If season.json does not
// load, the screen says so and keeps the slate parts.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('players.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'players';
  const num = x => typeof x === 'number' && isFinite(x);
  const pct = p => (num(p) ? Math.round(p * 100) + '%' : '—');
  const f1 = x => (num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const fN = x => (num(x) ? (Number.isInteger(x) ? String(x) : f1(x)) : '—');
  const store = SB.store || { get: (k, d) => d, set() {} };
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const whenOf = g => tFmt.format(new Date(SB.startMs(g))) + ' PT';
  const dFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const dateTxt = d => { const t = Date.parse(String(d) + 'T12:00:00Z'); return isFinite(t) ? dFmt.format(new Date(t)) : String(d || ''); };
  const SPORTS = ['nfl', 'nba', 'nhl', 'ncaaf', 'soccer'];
  const SPN = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL', ncaaf: 'College', soccer: 'Soccer' };
  const SPLONG = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL', ncaaf: 'College football', soccer: 'Soccer' };
  const MKT = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', rec: 'Receptions', ryd: 'Rushing yards', recyd: 'Receiving yards', pyd: 'Passing yards', hpts: 'Points', sog: 'Shots on goal', sot: 'Shots on target', td: 'Anytime TD' };
  const MORDER = ['pts', 'reb', 'ast', 'rec', 'recyd', 'ryd', 'pyd', 'hpts', 'sog', 'sot'];
  const FLAB = { min: 'Min', pts: 'Pts', reb: 'Reb', ast: 'Ast', pa: 'Pass att', pyd: 'Pass yds', ptd: 'Pass TD', ra: 'Car', ryd: 'Rush yds', rtd: 'Rush TD', tgt: 'Tgt', rec: 'Rec', recyd: 'Rec yds', ctd: 'Rec TD', g: 'G', a: 'A', sog: 'SOG', sot: 'SOT', sh: 'Shots' };
  // the "Top" metric per sport: [label, unit, min games, fn(tot getter, games)]
  const TOP = {
    nfl: { kick: 'Top PPR fantasy scorers', note: 'PPR points a game from yards, touchdowns and catches (our box scores have no interceptions or fumbles, so QBs read a little high).', unit: 'PPR/G', min: 4,
      f: (T, gp) => (0.04 * T('pyd') + 4 * T('ptd') + 0.1 * T('ryd') + 6 * T('rtd') + T('rec') + 0.1 * T('recyd') + 6 * T('ctd')) / gp },
    nba: { kick: 'Top scorers', note: 'Points a game this season.', unit: 'PPG', min: 5, f: (T, gp) => T('pts') / gp },
    nhl: { kick: 'Top point getters', note: 'Goals plus assists a game this season.', unit: 'P/G', min: 8, f: (T, gp) => (T('g') + T('a')) / gp },
    ncaaf: { kick: 'Top yardage', note: 'Passing, rushing and receiving yards a game this season.', unit: 'YDS/G', min: 4, f: (T, gp) => (T('pyd') + T('ryd') + T('recyd')) / gp },
    soccer: { kick: 'Top goal scorers', note: 'Goals in the matches our box scores cover (Europe\'s big leagues, the Champions League and MLS).', unit: 'GOALS', min: 1, f: T => T('g') },
  };
  // the full-table columns per sport (k: a per-game or total key computed in index())
  const COLS = {
    nfl: [['gp', 'GP'], ['top', 'PPR/G'], ['pydg', 'Pass yds/G'], ['rydg', 'Rush yds/G'], ['recg', 'Rec/G'], ['recydg', 'Rec yds/G'], ['tds', 'TD']],
    ncaaf: [['gp', 'GP'], ['top', 'Yds/G'], ['pydg', 'Pass/G'], ['rydg', 'Rush/G'], ['recydg', 'Rec yds/G'], ['tds', 'TD']],
    nba: [['gp', 'GP'], ['ming', 'Min'], ['top', 'Pts'], ['rebg', 'Reb'], ['astg', 'Ast']],
    nhl: [['gp', 'GP'], ['gt', 'G'], ['at', 'A'], ['ptst', 'Pts'], ['sogt', 'SOG'], ['top', 'P/G']],
    soccer: [['gp', 'GP'], ['top', 'G'], ['sott', 'SOT'], ['sht', 'Shots']],
  };
  const PAGE = 50;

  // ---------- state ----------
  const st = { sport: 'all', view: null, pending: null, miss: null, q: '', sugI: 0, sort: null, shown: PAGE, min: +store.get('pl.min', 3) || 3, back: 0 };
  if (![1, 3, 5, 10].includes(st.min)) st.min = 3;
  let seenP = null;
  const showing = () => SB.tab === KEY;
  const drawn = () => showing() && !!document.querySelector('#main .pl-root');

  // ---------- season.json (loaded once, on first visit) ----------
  let SEAS = null, SEAS_ST = 'idle';
  function needSeason() {
    if (SEAS_ST !== 'idle') return;
    SEAS_ST = 'loading';
    Promise.resolve(typeof SB.season === 'function' ? SB.season() : null).then(d => { SEAS = d && d.sports ? d : null; SEAS_ST = SEAS ? 'ok' : 'none'; })
      .catch(() => { SEAS = null; SEAS_ST = 'none'; })
      .then(() => { IDX = null; if (drawn() || (showing() && st.pending)) SB.render(); });
  }
  let ftWait = false;
  const ftOk = () => { const F = window.__firsttd; return !!(F && F.FT); };
  function needFT() {
    const F = window.__firsttd;
    if (!F || F.FT || ftWait || typeof F.load !== 'function') return;
    ftWait = true;
    Promise.resolve(F.load()).then(() => { IDX = null; if (F.FT && drawn()) SB.render(); }).catch(() => {});
  }

  // ---------- the index: season players + slate players, joined ----------
  let IDX = null;
  function espnAbbr(S, abbr, name) {
    const teams = S && S.teams && typeof S.teams === 'object' && !Array.isArray(S.teams) ? S.teams : {};
    const nk = E.nameKey(name), last = s => { const a = E.nameKey(s).split('-'); return a[a.length - 1]; };
    if (teams[abbr] && (!name || last(teams[abbr]) === last(name))) return abbr;
    for (const [ab, nm] of Object.entries(teams)) { const k = E.nameKey(nm); if (k === nk || (k.length > 4 && nk && (k.startsWith(nk) || nk.startsWith(k)))) return ab; }
    return abbr;
  }
  function slatePeople() {
    const D = SB.DATA || {}, people = new Map();
    const entry = (g, team, name) => {
      const pk = g.id + '|' + team + '|' + E.nameKey(name);
      let p = people.get(pk);
      if (!p) { const home = g.home.abbr === team, me = home ? g.home : g.away, op = home ? g.away : g.home; p = { pk, name, team, teamName: me.name, opp: op.abbr, home, gid: g.id, g, sp: g.sport, start: SB.startMs(g), stats: {}, td: null, pos: '' }; people.set(pk, p); }
      return p;
    };
    for (const pl of D.players || []) {
      if (!pl || !E.LADDER[pl.stat]) continue;
      const g = SB.gameById(pl.gid); if (!g || !SB.openG(g) || (g.home.abbr !== pl.team && g.away.abbr !== pl.team)) continue;
      const p = entry(g, pl.team, pl.name); if (!p.stats[pl.stat]) p.stats[pl.stat] = pl; if (!p.pos && pl.pos) p.pos = pl.pos;
    }
    const T = E.nflByTd;
    if (ftOk() && T && typeof T.entries === 'function') for (const g of D.games || []) {
      if (g.sport !== 'nfl' || !SB.openG(g)) continue;
      for (const me of [g.home, g.away]) for (const [k, v] of T) {
        if (!k.startsWith(me.abbr + '|')) continue;
        const slug = k.slice(me.abbr.length + 1), name = (v && v.name) || slug, key = `TD:A:${me.abbr}:${slug}`;
        let p0 = 0; try { p0 = SB.p1(g, key); } catch (e) { p0 = 0; }
        if (!(p0 > 0) || p0 >= 0.995) continue;
        const p = entry(g, me.abbr, name); p.td = { key, slug }; if (!p.pos && v && v.pos) p.pos = v.pos;
      }
    }
    const nflpos = D.nflpos instanceof Map ? D.nflpos : null;
    for (const p of people.values()) if (!p.pos && nflpos) p.pos = nflpos.get(p.team + '|' + E.nameKey(p.name)) || '';
    return [...people.values()].filter(p => Object.keys(p.stats).length || p.td).sort((a, b) => a.start - b.start);
  }
  function index() {
    const D = SB.DATA, ft = ftOk();
    if (IDX && IDX.data === D && IDX.ft === ft && IDX.seas === SEAS_ST) return IDX;
    const all = [], byId = new Map(), bySp = {}, counts = {};
    const slate = slatePeople(), slateBy = new Map();
    for (const p of slate) { const k = p.sp + '|' + E.nameKey(p.name); if (!slateBy.has(k)) slateBy.set(k, []); slateBy.get(k).push(p); }
    const used = new Set();
    for (const sp of SPORTS) {
      bySp[sp] = []; counts[sp] = 0;
      const S = SEAS && SEAS.sports && SEAS.sports[sp];
      if (!S || !Array.isArray(S.players) || !Array.isArray(S.fields)) continue;
      const ti = {}, fi = {}; S.fields.forEach((f, i) => { ti[f] = i; fi[f] = 3 + i; });
      const nameCount = new Map(); for (const P of S.players) if (P && P.n) { const k = E.nameKey(P.n); nameCount.set(k, (nameCount.get(k) || 0) + 1); }
      const teams = S.teams && typeof S.teams === 'object' && !Array.isArray(S.teams) ? S.teams : {};
      S.players.forEach((P, i) => {
        if (!P || !P.n || !Array.isArray(P.log)) return;
        const T = f => { const j = ti[f]; const v = j == null || !Array.isArray(P.tot) ? 0 : +P.tot[j]; return num(v) ? v : 0; };
        const gp = num(+P.gp) && +P.gp > 0 ? +P.gp : P.log.length;
        if (!gp) return;
        const nk = E.nameKey(P.n), cand = slateBy.get(sp + '|' + nk) || [];
        const mine = cand.filter(p => espnAbbr(S, p.team, p.teamName) === P.t || (cand.length && nameCount.get(nk) === 1 && sp !== 'ncaaf'));
        mine.forEach(p => used.add(p.pk));
        const e = { id: sp + ':' + i, sp, name: P.n, nk, team: P.t, teamName: teams[P.t] || '', pos: P.pos || (mine[0] && mine[0].pos) || '', gp, P, S, fi, ti, T, slate: mine };
        e.top = TOP[sp].f(T, gp);
        const g1 = x => T(x) / gp;
        Object.assign(e, { pydg: g1('pyd'), rydg: g1('ryd'), recg: g1('rec'), recydg: g1('recyd'), tds: T('rtd') + T('ctd'), ming: g1('min'), rebg: g1('reb'), astg: g1('ast'), gt: T('g'), at: T('a'), ptst: T('g') + T('a'), sogt: T('sog'), sott: T('sot'), sht: T('sh') });
        bySp[sp].push(e); all.push(e); byId.set(e.id, e); counts[sp]++;
      });
    }
    // slate players with no season line (or no season file): their own entries
    const seen = new Map();
    for (const p of slate) {
      if (used.has(p.pk) || !bySp[p.sp]) continue;
      const k = p.sp + '|' + p.team + '|' + E.nameKey(p.name);
      let e = seen.get(k);
      if (!e) { e = { id: 'slate:' + p.pk, sp: p.sp, name: p.name, nk: E.nameKey(p.name), team: p.team, teamName: p.teamName, pos: p.pos || '', gp: null, P: null, slate: [], top: null }; seen.set(k, e); bySp[p.sp].push(e); all.push(e); byId.set(e.id, e); counts[p.sp]++; }
      e.slate.push(p);
    }
    IDX = { data: D, ft, seas: SEAS_ST, all, byId, bySp, counts, total: all.length, slate };
    return IDX;
  }
  const onSlate = e => e.slate && e.slate.length > 0;

  // ---------- params ----------
  function applyParams(prm) {
    // render() passes a fresh {} when no params were given, so only a non-empty params object (one goTab call) is applied, once;
    // a click on the Players item in the menu goes back to the list (the capture listener below)
    if (!prm || typeof prm !== 'object' || !Object.keys(prm).length || seenP === prm) return;
    seenP = prm;
    if (typeof prm.sport === 'string' && (SPORTS.includes(prm.sport.toLowerCase()) || prm.sport === 'all')) { st.sport = prm.sport.toLowerCase(); st.sort = null; st.shown = PAGE; st.view = null; st.miss = null; }
    if (typeof prm.name === 'string' && prm.name.trim()) { st.pending = { name: prm.name.trim(), sport: typeof prm.sport === 'string' ? prm.sport.toLowerCase() : null }; st.view = null; st.miss = null; }
  }
  function resolvePending() {
    if (!st.pending || SEAS_ST === 'loading' || SEAS_ST === 'idle') return;
    const { name, sport } = st.pending; st.pending = null;
    const X = index(), nk = E.nameKey(name);
    let c = X.all.filter(e => e.nk === nk && (!sport || !SPORTS.includes(sport) || e.sp === sport));
    if (!c.length) c = X.all.filter(e => e.nk === nk);
    c.sort((a, b) => (onSlate(b) ? 1 : 0) - (onSlate(a) ? 1 : 0) || (b.gp || 0) - (a.gp || 0));
    if (c[0]) { st.view = c[0].id; st.miss = null; } else st.miss = `No player named ${name} in our data`;
  }

  // ---------- search ----------
  function searchList(q) {
    const nk = E.nameKey(q); if (!nk) return [];
    const out = [];
    for (const e of index().all) {
      const i = e.nk.indexOf(nk); if (i < 0) continue;
      out.push({ e, s: i === 0 ? 0 : e.nk[i - 1] === '-' ? 1 : 2 });
    }
    out.sort((a, b) => a.s - b.s || (onSlate(b.e) ? 1 : 0) - (onSlate(a.e) ? 1 : 0) || (b.e.gp || 0) - (a.e.gp || 0) || (a.e.name < b.e.name ? -1 : 1));
    return out.slice(0, 10).map(x => x.e);
  }
  let SUG = [];
  const optId = i => 'pl-o-' + i;
  function sugHTML(list) {
    if (!list.length) return `<div class="pl-none">No player matches.${SEAS_ST === 'none' ? ' Only players on the slate can be searched right now (the season box scores did not load).' : ''}</div>`;
    return list.map((e, i) => `<div class="pl-opt" role="option" id="${optId(i)}" aria-selected="${i === st.sugI}" data-pl-open="${esc(e.id)}">${U.team(e.team)}<span><b>${esc(e.name)}</b><small>${esc(SPN[e.sp])} · ${esc(e.team)}${e.pos ? ' · ' + esc(e.pos) : ''}${e.gp ? ' · ' + e.gp + ' games' : ''}${onSlate(e) ? ' · on the slate' : ''}</small></span></div>`).join('');
  }
  function showSug(root, q) {
    const box = root.querySelector('#pl-sug'), inp = root.querySelector('#pl-q'); if (!box || !inp) return;
    SUG = searchList(q); st.sugI = 0;
    if (!String(q || '').trim()) { box.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); return; }
    box.innerHTML = sugHTML(SUG); box.hidden = false; inp.setAttribute('aria-expanded', 'true');
    if (SUG.length) inp.setAttribute('aria-activedescendant', optId(0)); else inp.removeAttribute('aria-activedescendant');
  }
  function moveSug(root, d) {
    if (!SUG.length) return;
    st.sugI = (st.sugI + d + SUG.length) % SUG.length;
    root.querySelectorAll('#pl-sug .pl-opt').forEach((o, i) => o.setAttribute('aria-selected', String(i === st.sugI)));
    const inp = root.querySelector('#pl-q'); if (inp) inp.setAttribute('aria-activedescendant', optId(st.sugI));
    const o = root.querySelector('#' + optId(st.sugI)); if (o && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
  }

  // ---------- styles (injected once) ----------
  function css() {
    if (document.getElementById('players-css')) return;
    const s = document.createElement('style'); s.id = 'players-css';
    s.textContent = `
.pl-root .pl-sbox{position:relative;max-width:640px}
.pl-root .pl-in{display:flex;align-items:center;gap:12px;min-height:58px;padding:0 8px 0 20px;border:1px solid var(--hair2);border-radius:999px;background:rgba(255,255,255,.03)}
.pl-root .pl-in:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--acc-rgb),.18)}
.pl-root .pl-in svg{flex:none;color:#ffffffb3}
.pl-root .pl-in input{flex:1;min-width:0;height:56px;border:0;background:none;color:#fff;font:400 17px var(--fui);outline:none}
.pl-root .pl-in input::placeholder{color:#ffffff80}
.pl-root .pl-sug{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 6px);max-height:min(60vh,460px);overflow:auto;padding:6px;border:1px solid var(--hair2);border-radius:18px;background:#0a101c;box-shadow:0 24px 60px -18px #000}
.pl-root .pl-opt{display:flex;align-items:center;gap:12px;min-height:52px;padding:6px 10px;border-radius:12px;cursor:pointer}
.pl-root .pl-opt[aria-selected="true"],.pl-root .pl-opt:hover{background:rgba(var(--acc-rgb),.12)}
.pl-root .pl-opt>span{min-width:0}.pl-root .pl-opt b{display:block;font:600 15px var(--fui)}.pl-root .pl-opt small{display:block;font:500 12px var(--fui);color:#ffffff99}
.pl-root .pl-none{padding:14px;font:400 13.5px/1.45 var(--fui);color:#ffffffa6}
.pl-root .pl-chips{overflow-x:auto;scrollbar-width:none;margin:0 -2px;padding:2px}
.pl-root .pl-chips::-webkit-scrollbar{display:none}
.pl-root .pl-chips .ui-pills{flex-wrap:nowrap;width:max-content;border:0;background:none;padding:0;gap:8px}
.pl-root .pl-chips .ui-pill{min-height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--hair2);background:rgba(255,255,255,.02);color:#fff}
.pl-root .pl-chips .ui-pill.on{border-color:rgba(var(--acc-rgb),.7);background:rgba(var(--acc-rgb),.12);box-shadow:none}
.pl-root .pl-sec{display:flex;flex-direction:column;gap:14px;margin-top:22px}
.pl-root .pl-sechd{display:flex;align-items:flex-end;justify-content:space-between;gap:10px 16px;flex-wrap:wrap}
.pl-root .pl-h{font:900 italic clamp(32px,5vw,46px)/.95 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:-.015em}
.pl-root .pl-k{margin-top:8px;font:500 11.5px var(--fmono);letter-spacing:.2em;text-transform:uppercase;color:#ffffffb3}
.pl-root .pl-k2{margin-top:6px;font:500 11px/1.6 var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80;max-width:78ch}
.pl-root .pl-all{font-size:15px}
.pl-root .pl-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(164px,1fr);align-items:stretch;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:4px;scrollbar-width:thin}
.pl-root .pl-card{all:unset;box-sizing:border-box;cursor:pointer;scroll-snap-align:start;align-self:stretch;display:flex;flex-direction:column;justify-content:flex-start;min-width:0;border-radius:20px;border:1px solid var(--hair2);overflow:hidden;background:#0a101c;transition:border-color .15s,transform .15s}
.pl-root .pl-card:hover{border-color:rgba(var(--acc-rgb),.55);transform:translateY(-2px)}
.pl-root .pl-card:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.pl-root .pl-art{position:relative;height:118px;overflow:hidden;border-bottom:1px solid var(--hair);background:radial-gradient(120% 95% at 50% 118%,hsl(var(--h) 80% 48% / .95),hsl(var(--h) 65% 22% / .9) 55%,#0b1220 100%)}
.pl-root .pl-art::before{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.16) 1px,transparent 1.3px);background-size:9px 9px;-webkit-mask-image:linear-gradient(180deg,transparent,#000 70%);mask-image:linear-gradient(180deg,transparent,#000 70%)}
.pl-root .pl-art .wm{position:absolute;right:-6px;bottom:-12px;font:900 italic 78px/1 'Rubik',sans-serif;letter-spacing:-.03em;color:transparent;-webkit-text-stroke:1.2px rgba(255,255,255,.26);white-space:nowrap}
.pl-root .pl-art .rk{position:absolute;left:12px;top:10px;font:700 11px var(--fmono);letter-spacing:.14em;color:#ffffffb3}
.pl-root .pl-art .sl{position:absolute;right:10px;top:10px;padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.4);font:700 10.5px var(--fui);color:var(--acc2)}
.pl-root .pl-body{display:flex;flex-direction:column;flex:1;padding:14px 16px 16px}
.pl-root .pl-nm{font:800 16.5px/1.2 'Rubik',sans-serif;overflow-wrap:anywhere}
.pl-root .pl-tp{margin-top:6px;font:500 11px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff99}
.pl-root .pl-val{margin-top:auto;padding-top:18px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.pl-root .pl-val b{font:900 italic 30px/1 'Rubik',sans-serif;letter-spacing:-.01em;background:var(--acc-grad);-webkit-background-clip:text;background-clip:text;color:transparent;padding-right:.06em;font-variant-numeric:tabular-nums}
.pl-root .pl-val small{font:500 11px var(--fmono);letter-spacing:.14em;color:#ffffffa6}
.pl-root .pl-notice{padding:12px 14px;border-radius:14px;border:1px solid rgba(255,184,0,.4);background:rgba(255,184,0,.07);font:500 13.5px/1.45 var(--fui);color:#ffe2a3}
.pl-root .pl-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pl-root .pl-pn{all:unset;cursor:pointer;display:block;text-align:left;min-height:40px}
.pl-root .pl-pn:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.pl-root .pl-more{display:flex;justify-content:center}
.pl-root .pl-back{align-self:flex-start}
.pl-root .pl-hero{padding:0;overflow:hidden}
.pl-root .pl-hd{display:flex;gap:16px;align-items:center;padding:18px;background:linear-gradient(135deg,hsl(var(--h) 60% 22%),#0b1220 72%)}
.pl-root .pl-hd>div{min-width:0}
.pl-root .pl-tn{font:800 21px/1.15 'Rubik',sans-serif;overflow-wrap:anywhere}
.pl-root .pl-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;font:600 13.5px var(--fui);color:#ffffffcc}
.pl-root .pl-meta .m+.m::before{content:"·";margin-right:10px;color:#ffffff59}.pl-root .pl-meta .nx{color:var(--acc2)}
.pl-root .pl-meta .pos{display:inline-grid;place-items:center;min-width:28px;height:21px;padding:0 7px;border-radius:6px;background:rgba(255,255,255,.14);font:800 11px var(--fui)}
.pl-root .pl-hact{display:flex;flex-wrap:wrap;gap:8px;padding:14px 18px 18px}
.pl-root .pl-h3{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 10px;font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.pl-root .pl-h3 b{font:600 12.5px var(--fui);letter-spacing:0;text-transform:none;color:var(--acc2)}
.pl-root .pl-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
@media(min-width:1100px){.pl-root .pl-grid{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}}
.pl-root .pl-col{display:flex;flex-direction:column;gap:14px;min-width:0}
.pl-root .pl-mk{padding:12px 0;border-top:1px solid var(--hair)}
.pl-root .pl-mk:first-of-type{border-top:0;padding-top:2px}
.pl-root .pl-mkh{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:6px}
.pl-root .pl-mkh b{font:700 16px 'Rubik',sans-serif}.pl-root .pl-mkh span{font:500 12.5px var(--fui);color:#ffffffa6}
.pl-root .pl-lad{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px 10px;align-items:center;padding:6px 0;border-top:1px dashed var(--hair)}
.pl-root .pl-lad:first-of-type{border-top:0}
.pl-root .pl-lad .ln{display:flex;align-items:center;gap:10px;min-width:0}
.pl-root .pl-lad .ln b{font:700 15px var(--fui);min-width:48px}
.pl-root .pl-lad .ln .bar{position:relative;flex:1;max-width:120px;height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
.pl-root .pl-lad .ln .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--acc2)}
.pl-root .pl-lad .ln .p{font:700 14px var(--fui);font-variant-numeric:tabular-nums;min-width:38px;text-align:right}
.pl-root .pl-lad .fo{font:600 12.5px var(--fui);color:#ffffffa6;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.pl-root .pl-lad .bt{display:flex;gap:6px}
.pl-root .pl-lad .bt .ui-cta.sm,.pl-root .pl-lad .bt .ui-ghost.sm{padding:0 12px}
@media(max-width:430px){.pl-root .pl-lad{grid-template-columns:minmax(0,1fr) auto}.pl-root .pl-lad .fo{display:none}.pl-root .pl-lad .ln .bar{display:none}}
`;
    document.head.appendChild(s);
  }

  // ---------- pieces ----------
  const ICON_SEARCH = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const fmtTop = (sp, v) => (sp === 'soccer' ? String(Math.round(v)) : f1(v));
  function card(e, i) {
    const T = TOP[e.sp];
    return `<button type="button" class="pl-card" data-pl-open="${esc(e.id)}" style="--h:${U.hue(e.team)}" aria-label="${esc(`${e.name}, ${e.team}${e.pos ? ' ' + e.pos : ''}: ${fmtTop(e.sp, e.top)} ${T.unit}. Open his page`)}">
      <span class="pl-art" aria-hidden="true"><span class="rk">#${i + 1}</span>${onSlate(e) ? '<span class="sl">On the slate</span>' : ''}<span class="wm">${esc(String(e.team || '').slice(0, 4))}</span></span>
      <span class="pl-body"><span class="pl-nm">${esc(e.name)}</span><span class="pl-tp">${esc(e.team)}${e.pos ? ' · ' + esc(e.pos) : ''}</span>
      <span class="pl-val"><b>${esc(fmtTop(e.sp, e.top))}</b><small>${esc(T.unit)}</small></span></span></button>`;
  }
  function topList(sp, n) {
    const X = index(), T = TOP[sp];
    return X.bySp[sp].filter(e => e.P && num(e.top) && e.gp >= T.min).sort((a, b) => b.top - a.top || a.gp - b.gp || (a.name < b.name ? -1 : 1)).slice(0, n);
  }
  // with no season file: the slate's players by the feed's season average for one stat
  function slateTop(sp, n) {
    const X = index(), stat = sp === 'nba' ? 'pts' : null;
    const val = e => { const pl = e.slate[0] && e.slate[0].stats; if (!pl) return null; if (stat) return pl.pts ? pl.pts.avg : null; return ['pyd', 'ryd', 'recyd'].reduce((s, k) => s + (pl[k] && num(pl[k].avg) ? pl[k].avg : 0), 0) || null; };
    return X.bySp[sp].map(e => ({ e, v: val(e) })).filter(x => num(x.v)).sort((a, b) => b.v - a.v).slice(0, n);
  }
  function slateCard(x, i, sp) {
    const e = x.e, unit = sp === 'nba' ? 'PPG (FEED)' : 'YDS/G (FEED)';
    return `<button type="button" class="pl-card" data-pl-open="${esc(e.id)}" style="--h:${U.hue(e.team)}"><span class="pl-art" aria-hidden="true"><span class="rk">#${i + 1}</span><span class="sl">On the slate</span><span class="wm">${esc(String(e.team || '').slice(0, 4))}</span></span>
      <span class="pl-body"><span class="pl-nm">${esc(e.name)}</span><span class="pl-tp">${esc(e.team)}${e.pos ? ' · ' + esc(e.pos) : ''}</span><span class="pl-val"><b>${esc(f1(x.v))}</b><small>${esc(unit)}</small></span></span></button>`;
  }
  function sectionHTML(sp, full) {
    const X = index(), T = TOP[sp], n = X.counts[sp];
    if (!n) return '';
    let row, kick = T.kick, note = T.note;
    if (SEAS_ST === 'ok') {
      const L = topList(sp, 6); if (!L.length) return '';
      row = L.map(card).join('');
    } else {
      const L = slateTop(sp, 6); if (!L.length) return '';
      row = L.map((x, i) => slateCard(x, i, sp)).join('');
      kick = sp === 'nba' ? 'Top scorers on the slate' : 'Most yards on the slate'; note = 'Season averages from the game feed (the box-score file did not load).';
    }
    const all = full ? '' : `<button type="button" class="ui-link pl-all" data-ui-pill="pl-sport|${esc(sp)}">All ${n.toLocaleString('en-US')} ${esc(SPLONG[sp])} players →</button>`;
    return `<section class="pl-sec" data-pl-sec="${esc(sp)}" aria-label="${esc(SPLONG[sp])}"><div class="pl-sechd"><div><div class="pl-h" role="heading" aria-level="2">${esc(SPN[sp])}</div><div class="pl-k">${esc(kick)}</div><div class="pl-k2">${esc(note)}</div></div>${all}</div><div class="pl-row">${row}</div></section>`;
  }
  function tableHTML(sp) {
    const X = index(), cols = COLS[sp];
    if (SEAS_ST !== 'ok') {
      const rows = X.bySp[sp].filter(onSlate);
      if (!rows.length) return '';
      return `<div class="pl-sec"><div class="pl-h3"><span>On the slate · ${rows.length}</span></div>${U.table({ name: 'pl-tab', cols: [{ k: 'n', label: 'Player', sort: false }, { k: 'g', label: 'Game', sort: false }, { k: 'm', label: 'Props', sort: false }],
        rows: rows.map(e => ({ html: `<button type="button" class="pl-pn" data-pl-open="${esc(e.id)}"><span class="pn">${esc(e.name)}</span><span class="pt">${esc(e.team)}${e.pos ? ' · ' + esc(e.pos) : ''}</span></button>`, g: `${e.slate[0].home ? 'vs' : '@'} ${e.slate[0].opp} · ${whenOf(e.slate[0].g)}`, m: [...new Set(e.slate.flatMap(p => Object.keys(p.stats).map(s => MKT[s]).concat(p.td ? ['Anytime TD'] : [])))].join(', ') })) })}</div>`;
    }
    const so = st.sort && cols.some(c => c[0] === st.sort.k) ? st.sort : { k: 'top', dir: -1 };
    let list = X.bySp[sp].filter(e => e.P && e.gp >= st.min);
    list.sort((a, b) => { const x = a[so.k], y = b[so.k]; return ((num(x) ? x : -1e9) - (num(y) ? y : -1e9)) * so.dir || b.gp - a.gp || (a.name < b.name ? -1 : 1); });
    const shown = list.slice(0, st.shown);
    const tcols = [{ k: 'name', label: 'Player', sort: false }].concat(cols.map(([k, label]) => ({ k, label, heat: k !== 'gp', fmt: v => (k === 'gp' || /t$|tds/.test(k) ? fN(v) : f1(v)) })));
    const rows = shown.map(e => Object.assign({ html: `<button type="button" class="pl-pn" data-pl-open="${esc(e.id)}"><span class="pn">${esc(e.name)}</span><span class="pt">${esc(e.team)}${e.pos ? ' · ' + esc(e.pos) : ''}${onSlate(e) ? ' · on the slate' : ''}</span></button>` }, Object.fromEntries(cols.map(([k]) => [k, e[k]]))));
    const minSel = U.select({ label: 'Min games', value: st.min, options: [[1, '1+'], [3, '3+'], [5, '5+'], [10, '10+']], name: 'pl-min' });
    return `<div class="pl-sec" data-pl-table="${esc(sp)}"><div class="pl-sechd"><div class="pl-h3" style="margin:0"><span>All ${esc(SPLONG[sp])} players · ${list.length.toLocaleString('en-US')}</span></div><div class="pl-ctl">${minSel}</div></div>
      ${U.table({ name: 'pl-tab', cols: tcols, rows, sort: so })}
      ${list.length > shown.length ? `<div class="pl-more"><button type="button" class="ui-ghost" data-pl-more="1">Show more (${(list.length - shown.length).toLocaleString('en-US')} left)</button></div>` : ''}
      <p class="ui-note">Per game: season totals ÷ games in ESPN's box scores. Tap a column to sort.</p></div>`;
  }

  // ---------- the player page ----------
  function tilesOf(e) {
    const T = e.T, gp = e.gp, g = f => T(f) / gp, sp = e.sp, t = [['Games', String(gp)]];
    if (sp === 'nba') t.push(['Minutes', f1(g('min'))], ['Points', f1(g('pts')), true], ['Rebounds', f1(g('reb'))], ['Assists', f1(g('ast'))], ['Pts+Reb+Ast', f1(g('pts') + g('reb') + g('ast'))]);
    else if (sp === 'nhl') t.push(['Goals', fN(T('g'))], ['Assists', fN(T('a'))], ['Points', fN(T('g') + T('a')), true], ['Shots/G', f1(g('sog'))], ['Points/G', f1((T('g') + T('a')) / gp)]);
    else if (sp === 'soccer') t.push(['Goals', fN(T('g')), true], ['Shots on target', fN(T('sot'))], ['Shots', fN(T('sh'))], ['On target/G', f1(g('sot'))]);
    else {
      if (T('pa') > 0) t.push(['Pass yds/G', f1(g('pyd')), e.pos === 'QB'], ['Pass TD', fN(T('ptd'))]);
      if (T('ra') > 0) t.push(['Rush yds/G', f1(g('ryd')), e.pos === 'RB'], ['Carries/G', f1(g('ra'))], ['Rush TD', fN(T('rtd'))]);
      if (T('tgt') > 0 || T('rec') > 0) t.push(['Catches/G', f1(g('rec')), e.pos === 'WR' || e.pos === 'TE'], ['Rec yds/G', f1(g('recyd'))], ['Targets/G', f1(g('tgt'))], ['Rec TD', fN(T('ctd'))]);
      if (sp === 'nfl') t.push(['PPR/G', f1(e.top)]); else t.push(['Yards/G', f1(e.top)]);
    }
    return t;
  }
  function logFields(e) {
    const F = e.S.fields;
    if (e.sp === 'nba') return F.filter(f => ['min', 'pts', 'reb', 'ast'].includes(f));
    if (e.sp === 'nhl' || e.sp === 'soccer') return F.slice();
    return F.filter(f => e.T(f) > 0);
  }
  const MAIN = e => (e.sp === 'nba' ? 'pts' : e.sp === 'nhl' ? 'sog' : e.sp === 'soccer' ? 'sh' : e.pos === 'QB' || e.T('pa') > e.T('ra') + e.T('tgt') ? 'pyd' : e.T('ra') > e.T('tgt') ? 'ryd' : 'recyd');
  function logHTML(e) {
    if (!e.P) return `<div class="ui-card"><div class="pl-h3"><span>Game log</span></div><p class="ui-muted">${SEAS_ST === 'none' ? 'The season box scores did not load, so there is no game log right now.' : SEAS_ST === 'loading' ? 'Loading the season box scores…' : `No box scores for ${esc(e.name)} in our season file.`}</p></div>`;
    const rows = e.P.log.slice(-10).reverse(), fs = logFields(e), fi = e.fi;
    const cols = [{ k: 'd', label: 'Date', sort: false }, { k: 'o', label: 'Opp', sort: false }].concat(fs.map(f => ({ k: f, label: FLAB[f] || f, sort: false })));
    const trs = rows.map(r => Object.assign({ html: `<span class="pn" style="text-transform:none">${esc(dateTxt(r[0]))}</span>`, o: `${r[2] === 1 ? 'vs' : '@'} ${r[1]}` }, Object.fromEntries(fs.map(f => [f, fN(+r[fi[f]])]))));
    const mf = MAIN(e), chart = e.P.log.slice(-10);
    const gl = U.gameLog({ title: `${FLAB[mf] || mf} · last ${chart.length}`, summary: `avg ${f1(chart.reduce((s, r) => s + (+r[fi[mf]] || 0), 0) / Math.max(1, chart.length))}`, vals: chart.map(r => +r[fi[mf]] || 0), labels: chart.map(r => String(r[1] || '').slice(0, 4)), line: null });
    const trunc = e.P.gp > e.P.log.length;
    return `${gl}<div class="ui-card" data-pl-log><div class="pl-h3"><span>Last ${rows.length} games</span><b>ESPN box scores${trunc ? ` · the file keeps his last ${e.P.log.length} of ${e.P.gp}` : ''}</b></div>${U.table({ name: 'pl-log', cols, rows: trs })}${rows.length < 5 ? '<p class="ui-note" style="margin-top:8px">A small sample.</p>' : ''}</div>`;
  }
  function propsHTML(e) {
    if (!onSlate(e)) return `<div class="ui-card"><div class="pl-h3"><span>Props on the slate</span></div><p class="ui-muted">${esc(e.name)} has no game with props in our feed right now${e.sp === 'nhl' || e.sp === 'soccer' ? ` (we price ${esc(SPLONG[e.sp])} player props only as game legs)` : ''}.</p></div>`;
    const out = [];
    for (const p of e.slate) {
      const blocks = [];
      for (const stat of MORDER) {
        const pl = p.stats[stat]; if (!pl) continue;
        let M = null; try { M = E.playerMeans(pl); } catch (er) { M = null; }
        const proj = M ? (1 - M.pb) * M.an + M.pb * M.ab : null;
        const lines = (E.LADDER[stat] || []).map(t => ({ t, p: E.playerP(pl, t) })).filter(x => x.p >= 0.05 && x.p <= 0.97);
        if (!lines.length) continue;
        blocks.push(`<div class="pl-mk" data-pl-mkt="${esc(stat)}"><div class="pl-mkh"><b>${esc(MKT[stat])}</b><span>projection ${esc(f1(proj))}${pl.est ? ' · from his season average' : ''}</span></div>${lines.map(x => ladRow(p, `P:${pl.id}:${x.t}`, `${x.t}+`, x.p, JSON.stringify({ id: pl.id, line: x.t }), `${e.name} ${x.t}+ ${MKT[stat].toLowerCase()}`)).join('')}</div>`);
      }
      if (p.td) { let tp = 0; try { tp = SB.p1(p.g, p.td.key); } catch (er) { tp = 0; } if (tp > 0) blocks.push(`<div class="pl-mk" data-pl-mkt="td"><div class="pl-mkh"><b>Anytime TD</b><span>First TD model</span></div>${ladRow(p, p.td.key, 'Yes', tp, JSON.stringify({ name: p.name, stat: 'td', team: p.team, gid: p.gid }), `${e.name} anytime TD`)}</div>`); }
      if (blocks.length) out.push(`<div class="ui-card" data-pl-props="${esc(p.gid)}"><div class="pl-h3"><span>Props · ${esc(p.home ? 'vs' : '@')} ${esc(p.opp)} · ${esc(whenOf(p.g))}</span><b>model chances</b></div>${blocks.join('')}</div>`);
    }
    if (!out.length) return '';
    return out.join('') + '<p class="ui-note">Chances are model estimates with their fair odds; our feed has no sportsbook prop prices. Lines shown: 5% to 97%.</p>';
  }
  function ladRow(p, key, label, pr, an, aria) {
    const on = SB.inSlip(p.gid, key);
    return `<div class="pl-lad"><span class="ln"><b>${esc(label)}</b><span class="bar"><i style="width:${Math.round(pr * 100)}%"></i></span><span class="p">${esc(pct(pr))}</span></span><span class="fo" title="fair odds">${esc(U.fair(pr))}</span>
      <span class="bt"><button type="button" class="${on ? 'ui-ghost' : 'ui-cta'} sm" data-pl-slip="${esc(p.gid + '|' + key)}" aria-pressed="${on}" aria-label="${esc((on ? 'Remove from slip: ' : 'Add to slip: ') + aria)}">${on ? '✓ In slip' : '+ Slip'}</button><button type="button" class="ui-ghost sm" data-pl-an="${esc(an)}" aria-label="${esc('Analyze ' + aria)}">Analyze</button></span></div>`;
  }
  function pageHTML(e) {
    const hu = U.hue(e.team), s0 = e.slate[0];
    const meta = [`<span class="m">${esc(SPLONG[e.sp])}</span>`];
    if (e.pos) meta.unshift(`<span class="pos">${esc(e.pos)}</span>`);
    meta.push(`<span class="m">${e.gp ? `${e.gp} game${e.gp === 1 ? '' : 's'} this season` : 'no season box scores'}</span>`);
    if (s0) meta.push(`<span class="m nx">Next: ${esc(s0.home ? 'vs' : '@')} ${esc(s0.opp)} · ${esc(whenOf(s0.g))}</span>`);
    const q = `How has ${e.name} played lately?`;
    const hero = `<section class="ui-card pl-hero" style="--h:${hu}" aria-label="${esc(e.name)}"><div class="pl-hd">${U.team(e.team, true)}<div><div class="pl-tn" data-pl-team>${esc(e.teamName || (s0 && s0.teamName) || e.team)}</div><div class="pl-meta">${meta.join('')}</div></div></div>
      <div class="pl-hact"><button type="button" class="ui-cta" data-pl-ask="${esc(q)}">Ask about ${esc(e.name.split(' ')[0])}</button>${s0 ? `<button type="button" class="ui-ghost" data-pl-an="${esc(JSON.stringify(Object.keys(s0.stats).length ? { id: s0.stats[MORDER.find(k => s0.stats[k])].id } : { name: s0.name, stat: 'td', team: s0.team, gid: s0.gid }))}">Open in Prop Analyzer</button>` : ''}</div></section>`;
    const avg = e.P ? `<div class="ui-card" data-pl-avgs><div class="pl-h3"><span>Season averages</span><b>${e.P.gp > e.P.log.length ? 'season totals ÷ games' : 'ESPN box scores'}</b></div>${U.tiles(tilesOf(e))}${e.gp < 5 ? '<p class="ui-note" style="margin-top:8px">Fewer than 5 games: a small sample.</p>' : ''}</div>` : '';
    return `${hero}<div class="pl-grid"><div class="pl-col">${avg}${logHTML(e)}</div><div class="pl-col">${propsHTML(e)}</div></div>`;
  }

  // ---------- render ----------
  function render(main, params) {
    css(); needSeason(); needFT(); applyParams(params); resolvePending();
    const X = index();
    const total = X.total;
    const e = st.view ? X.byId.get(st.view) : null;
    if (st.view && !e) st.view = null;
    let head;
    if (e && !st.pending) { const w = e.name.split(' '), first = w.length > 1 ? w[0] : '', rest = w.length > 1 ? w.slice(1).join(' ') : e.name; head = U.page({ kicker: `Player page · ${SPLONG[e.sp]} · ${e.team}`, title: first, accent: rest }); }
    else head = U.page({ kicker: SEAS_ST === 'ok' ? `${total.toLocaleString('en-US')} players · ${SPORTS.filter(s => X.counts[s]).length} sports` : SEAS_ST === 'none' ? `${total.toLocaleString('en-US')} players on the slate` : 'Players · loading the box scores', title: 'Season stats', accent: '& props',
      sub: 'This season\'s box scores for the NFL, college football, NBA, NHL and soccer, and every player\'s props on the slate. Averages show what happened; they are not projections.' });
    const notice = SEAS_ST === 'none' ? `<div class="pl-notice" role="status">The season box scores (season.json) did not load, so there are no season numbers or game logs right now. Players on the slate and their props still work.</div>` : '';
    const miss = st.miss ? `<div class="pl-notice" role="status">${esc(st.miss)}.</div>` : '';
    let body;
    if (st.pending) body = `<div class="ui-empty" aria-busy="true">Loading ${esc(st.pending.name)}…</div>`;
    else if (e) body = pageHTML(e);
    else {
      const search = `<div class="pl-sbox"><div class="pl-in">${ICON_SEARCH}<input id="pl-q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="pl-sug" autocomplete="off" spellcheck="false" placeholder="Search any player" aria-label="Search any player" value="${esc(st.q)}"></div><div class="pl-sug" id="pl-sug" role="listbox" aria-label="Players" hidden></div></div>`;
      const items = [{ k: 'all', label: 'All sports', n: total ? total.toLocaleString('en-US') : null }].concat(SPORTS.map(sp => ({ k: sp, label: SPN[sp], n: X.counts[sp].toLocaleString('en-US') })));
      const chips = `<div class="pl-chips">${U.pills(items, st.sport, 'pl-sport')}</div>`;
      let secs;
      if (SEAS_ST === 'loading' || SEAS_ST === 'idle') secs = `<div class="ui-empty" aria-busy="true">Loading this season's box scores…</div>`;
      else if (st.sport === 'all') secs = SPORTS.map(sp => sectionHTML(sp, false)).join('') || U.empty('No players to show yet.');
      else secs = (sectionHTML(st.sport, true) + tableHTML(st.sport)) || U.empty(`No ${SPLONG[st.sport]} players in our data right now.`);
      body = `${search}${chips}${secs}`;
    }
    const back = e && !st.pending ? '<button type="button" class="ui-link pl-back" data-pl-back="1">← All players</button>' : '';
    main.innerHTML = `<div class="ui-page pl-root" data-pl="${e && !st.pending ? 'page' : 'list'}">${back}${head}${notice}${miss}${body}</div>`;
  }

  function rerender(sel) {
    SB.render();
    if (!sel) return;
    try { const el = document.querySelector('.pl-root ' + sel); if (el) el.focus({ preventScroll: true }); } catch (er) { /* focus is a nicety */ }
  }
  const attrSel = (a, v) => `[${a}="${String(v).replace(/["\\]/g, '\\$&')}"]`;
  function openPlayer(id) {
    if (!index().byId.has(id)) return;
    st.back = window.scrollY || 0; st.view = id; st.miss = null; st.q = '';
    rerender('[data-pl-back]'); window.scrollTo(0, 0);
  }

  // ---------- events ----------
  let inToggle = false;
  document.addEventListener('click', ev => {
    const root = ev.target.closest && ev.target.closest('.pl-root'); if (!root) return;
    if (!ev.target.closest('.pl-sbox')) { const b = root.querySelector('#pl-sug'); if (b && !b.hidden) { b.hidden = true; const i = root.querySelector('#pl-q'); if (i) i.setAttribute('aria-expanded', 'false'); } }
    const t = ev.target.closest('button,[data-pl-open]'); if (!t) return;
    if (t.hasAttribute('data-pl-open')) { openPlayer(t.getAttribute('data-pl-open')); return; }
    const pill = t.getAttribute('data-ui-pill');
    if (pill && pill.startsWith('pl-sport|')) {
      const k = pill.split('|')[1]; st.sport = k === 'all' || SPORTS.includes(k) ? k : 'all'; st.sort = null; st.shown = PAGE;
      const fromLink = t.classList.contains('pl-all');
      rerender(attrSel('data-ui-pill', pill)); if (fromLink) { const c = document.querySelector('.pl-root .pl-chips'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'start' }); }
      return;
    }
    const so = t.getAttribute('data-ui-sort');
    if (so && so.startsWith('pl-tab|')) { const k = so.split('|')[1]; st.sort = st.sort && st.sort.k === k ? { k, dir: -st.sort.dir } : { k, dir: -1 }; rerender(attrSel('data-ui-sort', so)); return; }
    if (t.hasAttribute('data-pl-more')) { st.shown += PAGE; SB.render(); return; }
    if (t.hasAttribute('data-pl-back')) { st.view = null; const y = st.back; SB.render(); window.scrollTo(0, y); const q = document.querySelector('.pl-root #pl-q'); if (q) q.focus({ preventScroll: true }); return; }
    if (t.hasAttribute('data-pl-slip')) {
      const id = t.getAttribute('data-pl-slip'), i = id.indexOf('|'), gid = id.slice(0, i), key = id.slice(i + 1);
      const was = SB.inSlip(gid, key); inToggle = true; let r = false;
      try { r = SB.toggleLeg(gid, key); } finally { inToggle = false; }
      if (!was && !r && !SB.inSlip(gid, key)) SB.toast('This leg can no longer be added (its game may have started).');
      const y = window.scrollY; rerender(attrSel('data-pl-slip', id)); window.scrollTo(0, y); return;
    }
    if (t.hasAttribute('data-pl-an')) { let o = {}; try { o = JSON.parse(t.getAttribute('data-pl-an')); } catch (er) { o = {}; } SB.goTab('propan', o); return; }
    if (t.hasAttribute('data-pl-ask')) { SB.goTab('ask', { q: t.getAttribute('data-pl-ask') }); }
  });
  document.addEventListener('click', ev => {
    const nav = ev.target.closest && ev.target.closest('[data-t="players"]');
    if (nav && !nav.closest('.pl-root')) { st.view = null; st.miss = null; st.pending = null; }
  }, true);
  document.addEventListener('change', ev => {
    const s = ev.target; if (!s || !s.matches || !s.matches('.pl-root select[data-ui-select="pl-min"]')) return;
    st.min = [1, 3, 5, 10].includes(+s.value) ? +s.value : 3; store.set('pl.min', st.min); st.shown = PAGE;
    rerender('select[data-ui-select="pl-min"]');
  });
  document.addEventListener('input', ev => {
    const s = ev.target; if (!s || s.id !== 'pl-q' || !s.closest) return;
    const root = s.closest('.pl-root'); if (!root) return;
    st.q = s.value; showSug(root, s.value);
  });
  document.addEventListener('keydown', ev => {
    const s = ev.target; if (!s || s.id !== 'pl-q' || !s.closest) return;
    const root = s.closest('.pl-root'); if (!root) return;
    const box = root.querySelector('#pl-sug'), open = box && !box.hidden;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { if (!open) showSug(root, s.value); else moveSug(root, ev.key === 'ArrowDown' ? 1 : -1); ev.preventDefault(); }
    else if (ev.key === 'Enter') { const e = SUG[st.sugI] || searchList(s.value)[0]; if (e && String(s.value).trim()) { ev.preventDefault(); openPlayer(e.id); } }
    else if (ev.key === 'Escape' && open) { box.hidden = true; s.setAttribute('aria-expanded', 'false'); ev.preventDefault(); }
  });
  if (typeof SB.on === 'function') {
    SB.on('slip', () => { if (!inToggle && drawn() && st.view) { const y = window.scrollY; SB.render(); window.scrollTo(0, y); } });
    SB.on('data', () => { IDX = null; ftWait = false; if (drawn()) SB.render(); });
  }

  SB.registerTab({ key: KEY, label: 'Players', render });
  // read-only hooks for tests
  window.__players = { index, topList, searchList, get state() { return { ...st }; }, get seasonState() { return SEAS_ST; } };
})();
