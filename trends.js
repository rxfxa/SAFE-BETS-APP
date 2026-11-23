// 📈 Team Trends tab: every team's results by day, week and month (last 7 days, last 30 days, season, each calendar month),
// from trends.json (tools/team_trends.py: football-data.co.uk results + closing odds for soccer, ESPN scores + posted lines for
// the NBA). For the games coming up in the app's feed it flags "upset watch" spots (an underdog beating its prices, or a
// favourite that keeps failing them) and over / under leans, each with its evidence and sample size, and builds one parlay
// from those legs with the app's own card (SB.ticketCard: swap legs + 500,000 runs). Past patterns are not predictions.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('trends.js: window.SB v2 API not found'); return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
  const f1 = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1);
  let TR = null, LOADED = false, IDX = null;
  const isOn = () => !!document.querySelector('#tabs [data-t="trends"].on');
  const load = () => fetch('trends.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { TR = d && Array.isArray(d.teams) ? d : null; IDX = null; LOADED = true; if (isOn()) SB.render(); });
  if (!SB.on) load();  // with SB.on, the 'data' subscription below loads it (a late subscriber is called right away)

  // ---------- matching feed teams to trends teams (the same tokens and rules as tools/team_trends.py) ----------
  const STOP = new Set('fc cf ac afc sc as ssc us bc cfc ud cd rc rcd calcio club de sco osc ogc aj estac fsv sv tsg vfb vfl sk the and'.split(' '));
  const GENERIC = new Set('real united city racing sporting athletic olympique stade borussia inter saint st club town'.split(' '));
  const toks = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t) && !/^\d+$/.test(t));
  function tmatch(a, b) {
    if (!a || !a.length || !b.length) return [0, 0, false];
    let m = 0, strong = false;
    for (const t of a) if (b.some(f => t === f || (t.length >= 5 && f.length >= 5 && (f.startsWith(t) || t.startsWith(f))))) { m++; strong = strong || (t.length >= 3 && !GENERIC.has(t)); }
    return [m / a.length, m / (a.length + b.length - m), strong];
  }
  function index() {
    if (IDX) return IDX;
    const by = new Map(), comp = new Map(), soccer = [], nba = [];
    for (const t of (TR && TR.teams) || []) {
      if (t.abbr) by.set(`${t.sport}|${t.comp}|${t.abbr}`, t);
      if (t.sport === 'soccer') { soccer.push(t); if (!comp.has(t.comp)) comp.set(t.comp, []); comp.get(t.comp).push(t); } else if (t.sport === 'nba') nba.push(t);
    }
    return (IDX = { by, comp, soccer, nba });
  }
  function find(g, side) {
    if (!TR || (g.sport !== 'soccer' && g.sport !== 'nba')) return null;
    const X = index(), tm = g[side] || {}, c = g.sport === 'nba' ? 'NBA' : g.comp, nt = toks(tm.name);
    const hit = X.by.get(`${g.sport}|${c}|${tm.abbr}`);
    if (hit && (g.sport === 'nba' || tmatch(hit.tokens, nt)[0] >= 0.5)) return hit;
    const pool = g.sport === 'nba' ? X.nba : X.comp.get(c), cross = g.sport === 'soccer' && !pool;  // e.g. Champions League: match across leagues
    let best = null, bs = 0, bj = 0;
    for (const t of pool || X.soccer) {
      const [s, j, strong] = tmatch(t.tokens, nt);
      if (!strong || (cross ? s < 1 || j < 0.5 : s < 0.5)) continue;
      if (s > bs || (s === bs && j > bj)) { best = t; bs = s; bj = j; }
    }
    return best;
  }

  // ---------- leans (mirror tools/team_trends.py) ----------
  const MINN = { soccer: 4, nba: 5 }, MIN_DOG = { soccer: 0.15, nba: 0.2 };
  const tag = b => { const t = []; if (b.n < 10) t.push('small sample'); if (b.z != null && Math.abs(b.z) < 2) t.push('could be chance'); return t.length ? ` (${t.join(', ')})` : ''; };
  const W = (t, w) => (t && t.windows && t.windows[w]) || { n: 0 };
  function upsetReasons(dog, fav, sport) {
    const R = [], mn = MINN[sport]; let s = 0, n = 0;
    if (dog) {
      let b = W(dog, 'season').dog || { n: 0 };
      if (b.n >= mn && b.won - b.exp >= 1) { R.push(`${dog.name} as an underdog this season: won ${b.won} of ${b.n}, prices expected ${b.exp.toFixed(1)}${tag(b)}`); s += b.won - b.exp; n += b.n; }
      b = W(dog, 'd30').vp || { n: 0 };
      if (b.n >= mn && b.won - b.exp >= 1) { R.push(`${dog.name} in the last 30 days: won ${b.won} of ${b.n}, prices expected ${b.exp.toFixed(1)}${tag(b)}`); s += (b.won - b.exp) / 2; n = Math.max(n, b.n); }
    }
    if (fav) {
      const b = W(fav, 'season').fav || { n: 0 };
      if (b.n >= mn && b.won - b.exp <= -1) { R.push(`${fav.name} as a favourite this season: won ${b.won} of ${b.n}, prices expected ${b.exp.toFixed(1)}${tag(b)}`); s += b.exp - b.won; n += b.n; }
    }
    return { why: R, strength: s, n };
  }
  function totalLean(teams, sport, line) {
    teams = teams.filter(Boolean);
    const why = []; let side = null, strength = 0, N = 0, H = 0;
    if (!teams.length) return { side, why, n: 0, strength };
    if (sport === 'soccer') {
      let Np = 0, Hp = 0, Ep = 0;
      for (const t of teams) {
        const s = W(t, 'season'), o = s.ov || { n: 0, hit: 0 }, x = s.ovx || { n: 0, hit: 0, exp: 0 };
        N += o.n; H += o.hit; Np += x.n; Hp += x.hit; Ep += x.exp || 0;
        why.push(`${t.name} games: ${o.hit} of ${o.n} over 2.5` + (x.n ? ` (prices expected ${(+x.exp).toFixed(1)} of ${x.n})` : ''));
      }
      const rate = N ? H / N : 0, ex = Hp - Ep;
      if (N >= 10) { if (rate >= 0.6 && (Np < 6 || ex >= 1.5)) side = 'over'; else if (rate <= 0.4 && (Np < 6 || ex <= -1.5)) side = 'under'; }
      strength = Math.abs(rate - 0.5) * 2 + (Np ? Math.abs(ex) / Np : 0);
      why.push(`Together: ${H} of ${N} (${N ? P(rate) : '—'}) over 2.5` + (Np ? `, ${f1(ex)} against the prices` : '') + (N < 20 ? ' (small sample)' : ''));
    } else {
      for (const t of teams) { const b = W(t, 'season').ln || { n: 0, hit: 0 }; N += b.n; H += b.hit; why.push(`${t.name} games: ${b.hit} of ${b.n} went over the posted total`); }
      let rate = N ? H / N : 0;
      if (N >= 12) side = rate >= 0.6 ? 'over' : rate <= 0.4 ? 'under' : null;
      if (N) why.push(`Together: ${H} of ${N} (${P(rate)}) over the line` + (N < 20 ? ' (small sample)' : ''));
      else {  // no posted lines: game totals against each team's own season average, last 30 days
        N = teams.reduce((a, t) => a + ((W(t, 'd30').ov || {}).n || 0), 0); H = teams.reduce((a, t) => a + ((W(t, 'd30').ov || {}).hit || 0), 0);
        rate = N ? H / N : 0; if (N >= 10) side = rate >= 0.65 ? 'over' : rate <= 0.35 ? 'under' : null;
        why.push(`Last 30 days: ${H} of ${N} games went over the teams' own season-average total`);
      }
      const av = teams.filter(t => W(t, 'd30').n).map(t => W(t, 'd30').avgT);
      if (line && av.length) {
        const m = av.reduce((a, b) => a + b, 0) / av.length;
        why.push(`Their last-30-day games averaged ${m.toFixed(1)} points; this game's posted total is ${line}`);
        if ((side === 'over' && m < line - 3) || (side === 'under' && m > line + 3)) { side = null; why.push('The average disagrees with the trend, so no lean'); }
      }
      strength = Math.abs(rate - 0.5) * 2;
    }
    return { side, why, n: N, strength };
  }
  const probs = g => { const p = g.prob; if (!p) return null; const s = (p.home || 0) + (p.draw || 0) + (p.away || 0); return s > 0 ? { h: p.home / s, d: (p.draw || 0) / s, a: p.away / s } : null; };

  // ---------- the next games in the feed ----------
  function analyse() {
    const now = Date.now(), ups = [], tots = [];
    const G = ((SB.DATA && SB.DATA.games) || []).filter(g => (g.sport === 'soccer' || g.sport === 'nba') && SB.openG(g) && SB.startMs(g) - now < 7 * 864e5)
      .sort((a, b) => SB.startMs(a) - SB.startMs(b));
    for (const g of G) {
      const th = find(g, 'home'), ta = find(g, 'away'); if (!th && !ta) continue;
      const q = probs(g);
      if (q && q.h !== q.a) {
        const dogH = q.h < q.a, pd = dogH ? q.h : q.a, pf = dogH ? q.a : q.h;
        if (pd >= MIN_DOG[g.sport]) {
          const r = upsetReasons(dogH ? th : ta, dogH ? ta : th, g.sport);
          if (r.why.length) ups.push({ g, side: dogH ? 'H' : 'A', dog: g[dogH ? 'home' : 'away'].name, fav: g[dogH ? 'away' : 'home'].name, pd, pf, pDraw: q.d, ...r });
        }
      }
      const nx = [th, ta].map(t => t && t.next && t.next.gid === g.id ? t.next.line : null).find(x => x) || null;
      const tl = totalLean([th, ta], g.sport, nx);
      if (tl.side) {
        const key = g.sport === 'soccer' ? (tl.side === 'over' ? 'O2.5' : 'U2.5') : null;
        tots.push({ g, ...tl, key, pModel: key && SB.priced(g) ? SB.p1(g, key) : null, line: nx });
      }
    }
    ups.sort((a, b) => b.strength - a.strength); tots.sort((a, b) => b.strength - a.strength);
    return { ups, tots, games: G.length };
  }
  function parlay(A) {
    const used = new Set(), legs = [];
    const add = (g, key, label) => { if (used.has(g.id) || !SB.priced(g)) return; const p = SB.p1(g, key); if (!(p > 0)) return; legs.push({ gid: g.id, key, label, p, sport: g.sport }); used.add(g.id); };
    for (const u of A.ups) {
      if (legs.length >= 2) break;
      if (u.g.sport === 'soccer') add(u.g, u.side === 'H' ? 'DC1X' : 'DCX2', `${u.dog} or draw (upset watch vs ${u.fav})`);
      else add(u.g, u.side, `${u.dog} to win (upset watch vs ${u.fav})`);
    }
    // NBA totals in the feed are league-average (no game line), so total legs come from soccer games only
    for (const t of A.tots) { if (legs.length >= 6) break; if (t.key) add(t.g, t.key, `${t.g.home.name} vs ${t.g.away.name}: ${t.side} 2.5 goals`); }
    return legs.length >= 2 ? legs : null;
  }

  // ---------- page ----------
  let F = { sport: 'all', comp: 'all' };
  try { F = Object.assign(F, SB.store.get('trends.f', {})); } catch (e) { /* defaults */ }
  const qv = () => ((document.getElementById('q') || {}).value || '').toLowerCase().trim();
  const okSport = s => F.sport === 'all' || F.sport === s;
  const okComp = c => F.comp === 'all' || F.comp === c;
  const sportName = s => (s === 'nba' ? 'NBA' : 'Soccer');
  const gameLine = g => `${esc(g.away.name)} @ ${esc(g.home.name)} · ${esc(g.comp)} · ${esc(SB.when(g))}`;
  function rec(s, sport) { if (!s || !s.n) return '<span class="trdim">no games</span>'; return sport === 'soccer' ? `${s.w}-${s.d}-${s.l}` : `${s.w}-${s.l}`; }
  function cell(s, sport) {
    if (!s || !s.n) return '<div class="trc"><span class="trdim">—</span></div>';
    const o = sport === 'soccer' ? s.ov : (s.ln && s.ln.n ? s.ln : s.ov), vp = s.vp || { n: 0 };
    const d = vp.n ? vp.won - vp.exp : null;
    return `<div class="trc"><b class="mono">${rec(s, sport)}</b><small>${o && o.n ? 'O ' + P(o.hit / o.n) : 'O —'}</small>${d == null ? '' : `<small style="color:${d > 0 ? 'var(--yes)' : d < 0 ? 'var(--no)' : 'var(--dim)'}" title="wins against the prices">${f1(d)} W</small>`}</div>`;
  }
  function detail(t) {
    const S = W(t, 'season'), sp = t.sport, st = t.streak || {};
    const blk = (lab, b) => (b && b.n ? `<li>${lab}: won ${b.won} of ${b.n}, prices expected ${(+b.exp).toFixed(1)}${b.roi != null ? `, flat $1 bets made ${b.roi >= 0 ? '+' : '−'}$${Math.abs(b.roi).toFixed(2)} per bet` : ''}${tag(b)}</li>` : '');
    const ovl = sp === 'soccer' ? (S.ovx && S.ovx.n ? `<li>Over 2.5 goals: ${S.ovx.hit} of ${S.ovx.n} priced games, prices expected ${(+S.ovx.exp).toFixed(1)}</li>` : '')
      : (S.ln && S.ln.n ? `<li>Over the posted total: ${S.ln.hit} of ${S.ln.n} (average line ${S.ln.avgLine})</li>` : '');
    const months = Object.entries(t.months || {}).map(([m, s]) => `<div class="trm"><b>${esc(new Date(m + '-15T12:00:00Z').toLocaleDateString([], { month: 'short', year: 'numeric', timeZone: 'UTC' }))}</b><span class="mono">${rec(s, sp)}</span><span>${(+s.gf).toFixed(sp === 'nba' ? 1 : 2)}–${(+s.ga).toFixed(sp === 'nba' ? 1 : 2)} a game</span><span>O ${s.ov && s.ov.n ? P(s.ov.hit / s.ov.n) : '—'}</span><span>${s.vp && s.vp.n ? f1(s.vp.won - s.vp.exp) + ' vs prices' : 'no prices'}</span></div>`).join('');
    const nx = t.next ? `<li>Next: ${t.next.home ? 'vs' : 'at'} ${esc(t.next.opp)} (${esc(t.next.comp)})${t.next.p != null ? `, priced ${P(t.next.p)} to win` : ''}</li>` : '';
    return `<ul class="trwhy">${blk('As favourite', S.fav)}${blk('As underdog', S.dog)}${ovl}<li>Streak: ${esc(st.res || '—')}${sp === 'soccer' && st.unbeaten != null ? ` · unbeaten in ${st.unbeaten} · winless in ${st.winless}` : ''}${st.ou ? ` · ${st.ou[0] === 'O' ? 'over' : 'under'} in the last ${st.ou.slice(1)}` : ''} · last 5: ${esc(st.last5 || '—')}</li>${nx}</ul>
      <div class="trms">${months || '<span class="trdim">No months yet.</span>'}</div>`;
  }
  function body(el) {
    const A = analyse(), q = qv();
    const ups = A.ups.filter(u => okSport(u.g.sport) && okComp(u.g.comp) && (!q || (u.dog + ' ' + u.fav).toLowerCase().includes(q)));
    const tots = A.tots.filter(t => okSport(t.g.sport) && okComp(t.g.comp) && (!q || (t.g.home.name + ' ' + t.g.away.name).toLowerCase().includes(q)));
    const legs = parlay({ ups, tots });
    const teams = TR.teams.filter(t => okSport(t.sport) && okComp(t.comp) && (!q || (t.name + ' ' + (t.csv || '') + ' ' + (t.abbr || '')).toLowerCase().includes(q)))
      .sort((a, b) => a.sport.localeCompare(b.sport) || a.comp.localeCompare(b.comp) || ((b => (b.n ? b.won - b.exp : -99))(W(b, 'season').vp || {}) - (b => (b.n ? b.won - b.exp : -99))(W(a, 'season').vp || {})));
    const upRow = u => `<div class="tri"><div class="trh"><span class="hit h-mid">${P(u.pd)}</span><div><b>${esc(u.dog)}</b> <span class="trdim">vs ${esc(u.fav)} (${P(u.pf)})</span><small>${gameLine(u.g)}</small></div><span class="trn" title="games behind these reasons">${u.n} games</span></div><ul class="trwhy">${u.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    const totRow = t => `<div class="tri"><div class="trh"><span class="hit ${t.side === 'over' ? 'h-hi' : 'h-lo'}">${t.side === 'over' ? 'OVER' : 'UNDER'}</span><div><b>${esc(t.g.away.name)} @ ${esc(t.g.home.name)}</b><small>${esc(t.g.comp)} · ${esc(SB.when(t.g))}${t.pModel != null ? ` · the app prices ${t.side} 2.5 at ${P(t.pModel)}` : t.line ? ` · posted total ${t.line}` : ''}</small></div><span class="trn" title="games behind this lean">${t.n} games</span></div><ul class="trwhy">${t.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    const W0 = TR.windows || {};
    el.innerHTML = `
      <h2>Upset watch <small>${ups.length} in the next 7 days</small></h2>
      <div class="note">An underdog that has beaten its prices, or a favourite that keeps falling short of them. The % is the feed's chance for the underdog. These are past patterns, not predictions: most underdogs on this list will still lose.</div>
      <div class="panel trlist">${ups.length ? ups.slice(0, 12).map(upRow).join('') : '<div class="why">No upset patterns in the games coming up for this filter.</div>'}</div>
      <h2>Over / under leans <small>${tots.length} games</small></h2>
      <div class="note">${F.sport === 'nba' ? '' : 'Soccer: how often both teams\' games went over 2.5 goals, against what the closing prices expected. '}${F.sport === 'soccer' ? '' : 'NBA: how often both teams\' games went over the posted total.'} A lean needs 60%+ (or 40% or less) over 10+ games; with samples this small it is a nudge, not an edge.</div>
      <div class="panel trlist">${tots.length ? tots.slice(0, 12).map(totRow).join('') : '<div class="why">No over / under leans in the games coming up for this filter.</div>'}</div>
      <h2>Trend parlay <small>from the lists above</small></h2>
      ${legs ? `<div class="grid">${SB.ticketCard('tr-mix', 'Trend parlay', { legs, p: SB.parlayProb(legs).p, n: legs.length }, `Up to two upset-watch legs (the underdog or a draw in soccer) and the strongest over / under leans, one leg per game. Every leg can be swapped (⇄) and the card simulated 500,000 times. The % is the model's from today's prices; the trends only chose the legs.`)}</div>`
        : '<div class="pc"><div class="why">Not enough priced games with a trend for a parlay under this filter.</div></div>'}
      <h2>Team by team <small>${teams.length} teams</small></h2>
      <div class="note">Record, then over rate (O: soccer over 2.5 goals, NBA over the posted total) and wins against the prices (W: +1.5 = won 1.5 games more than the prices expected). Last 7 days from ${esc(W0.d7 || '')}, last 30 days from ${esc(W0.d30 || '')}. Tap a team for months, streaks and favourite / underdog records.</div>
      <div class="panel trtab"><div class="trr trhead"><span>Team</span><span>7 days</span><span>30 days</span><span>Season</span></div>
        ${teams.slice(0, 300).map(t => `<details class="trd"><summary class="trr"><span class="trt"><b>${esc(t.name)}</b><small>${esc(t.comp)}${(W(t, 'season').n || 0) < 10 ? ' · small sample' : ''}</small></span>${cell(W(t, 'd7'), t.sport)}${cell(W(t, 'd30'), t.sport)}${cell(W(t, 'season'), t.sport)}</summary>${detail(t)}</details>`).join('') || '<div class="why">No teams match.</div>'}</div>`;
  }
  function render(main) {
    if (!LOADED) { main.innerHTML = '<h2>📈 Team Trends</h2><div class="pc"><div class="why">Loading team trends…</div></div>'; return; }
    if (!TR) { main.innerHTML = '<h2>📈 Team Trends</h2><div class="pc"><div class="why">The team trends file (trends.json) is not available right now.</div></div>'; return; }
    const sp = [...new Set(TR.teams.map(t => t.sport))];
    if (!['all', ...sp].includes(F.sport)) F.sport = 'all';
    const comps = [...new Set([...TR.teams.filter(t => okSport(t.sport)).map(t => t.comp), ...(((SB.DATA && SB.DATA.games) || []).filter(g => okSport(g.sport) && (g.sport === 'soccer' || g.sport === 'nba')).map(g => g.comp))])].sort();
    if (F.comp !== 'all' && !comps.includes(F.comp)) F.comp = 'all';
    const S = TR.sources || {}, sl = Object.values((S.soccer && S.soccer.leagues) || {}).map(x => x.last).filter(Boolean).sort().pop();
    main.innerHTML = `<div id="trWrap"><h2>📈 Team Trends <small>${TR.teams.length} teams · as of ${esc(TR.asOf || '')}</small></h2>
      <div class="pc"><div class="why" style="margin-top:0">Every team's results by week and month, and what they say about its next game. Past patterns are not guarantees: a team that beat its prices for a month can stop any day, and samples under 10 games are labelled small.</div>
        <div class="trf" role="group" aria-label="Filter by sport">${['all', ...sp].map(s => `<button type="button" class="chip ${F.sport === s ? 'on' : ''}" data-trs="${s}" aria-pressed="${F.sport === s}">${s === 'all' ? 'All' : sportName(s)}</button>`).join('')}
          <select class="trsel" data-trl aria-label="Filter by league"><option value="all">All leagues</option>${comps.map(c => `<option value="${esc(c)}" ${F.comp === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="note">Use the search box at the top to find a team.</div></div>
      <div id="trBody"></div>
      <div class="note">Sources: ${S.soccer ? `soccer results and closing average odds from football-data.co.uk (to ${esc(sl || '?')})${S.soccer.feedResultsAdded ? `, plus ${S.soccer.feedResultsAdded} later results from the app's feed (no prices)` : ''}` : ''}${S.nba ? `; NBA scores and posted lines from ESPN (${S.nba.withLines} of ${S.nba.games} games with lines)` : ''}. Champions League teams use their domestic league record. Updated ${esc((TR.updated || '').slice(0, 16).replace('T', ' '))} UTC; re-run every morning.</div></div>`;
    const wrap = main.querySelector('#trWrap'), bodyEl = main.querySelector('#trBody');
    body(bodyEl);
    const save = () => { try { SB.store.set('trends.f', F); } catch (e) { /* ignore */ } };
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-trs]'); if (!b) return;
      F.sport = b.dataset.trs; F.comp = 'all'; save(); render(main);
      const nb = main.querySelector(`[data-trs="${F.sport}"]`); if (nb) nb.focus();
    });
    wrap.addEventListener('change', e => { if (!e.target.matches('[data-trl]')) return; F.comp = e.target.value; save(); body(bodyEl); });
  }
  const css = document.createElement('style');
  css.textContent = '.trf{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}.trsel{height:40px;border-radius:8px;border:1px solid var(--line);background:var(--soft);color:var(--text);padding:0 10px;font:inherit;font-size:13.5px;max-width:100%;min-width:0}' +
    '.trlist{padding:2px 14px}.tri{padding:10px 0;border-top:1px solid var(--line)}.tri:first-child{border-top:0}.trh{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}.trh>div{min-width:0}.trh small{display:block;color:var(--dim);font-size:12px}' +
    '.trn{font-size:11px;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:2px 8px;white-space:nowrap}.trdim{color:var(--dim)}' +
    '.trwhy{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--mute);line-height:1.45}.trwhy li{margin:2px 0}' +
    '.trtab{padding:2px 10px}.trr{display:grid;grid-template-columns:minmax(0,1fr) 64px 64px 72px;gap:6px;align-items:center;padding:8px 0}.trhead{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}' +
    '.trd{border-top:1px solid var(--line)}.trd summary{cursor:pointer;list-style:none}.trd summary::-webkit-details-marker{display:none}.trt{min-width:0}.trt b{display:block;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trt small{color:var(--dim);font-size:11px}' +
    '.trc{min-width:0;font-size:12px}.trc b{display:block;font-size:12.5px}.trc small{display:block;color:var(--mute);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.trms{display:grid;gap:4px;margin:8px 0 10px}.trm{display:grid;grid-template-columns:64px 52px 1fr auto auto;gap:6px;font-size:11.5px;color:var(--mute)}.trm b{color:var(--text)}' +
    '@media (max-width:400px){.trr{grid-template-columns:minmax(0,1fr) 62px 62px 66px}.trm{grid-template-columns:64px 46px 1fr auto}.trm span:last-child{grid-column:2/-1}}';
  document.head.appendChild(css);
  SB.registerTab({ key: 'trends', label: '📈 Team Trends', after: 'pattern', render });
  SB.on && SB.on('data', () => { IDX = null; load(); });
  window.__trends = { analyse, parlay, find, totalLean, upsetReasons, get TR() { return TR; } };
})();
