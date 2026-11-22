// 💥 Upset Parlays tab: underdog legs (and soccer draws against a strong favourite) from Polymarket's board, built into
// "crazy" parlays with a legs scroller and a sport mixer. Prices are Polymarket's: no model here, so the chance shown is the
// market's own. Unbeaten runs and league tables are not in the app's feeds yet; the tab says so.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('upsets.js: window.SB v2 API not found'); return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const C = x => (x == null ? '—' : Math.round(x * 100) + '¢');
  const SPORTS = [['all', 'All sports'], ['nba', 'NBA'], ['nfl', 'NFL'], ['nhl', 'NHL'], ['ncaaf', 'College FB'], ['soccer', 'Soccer']];
  const ST = { sports: ['all'], legs: 5, hours: 48, seed: 1, stake: '10', mixed: true };
  const board = () => (window.__polymarket && __polymarket.PM && __polymarket.PM.games) || [];
  const loaded = () => !!(window.__polymarket && __polymarket.PM);

  function candidates() {
    const now = Date.now(), out = [];
    for (const pg of board()) {
      if (pg.stale) continue;
      const t = Date.parse(pg.start); if (!(t > now && t - now <= ST.hours * 3600e3)) continue;
      if (!ST.sports.includes('all') && !ST.sports.includes(pg.sport)) continue;
      const ml = pg.ml || {}; if (!ml.home || !ml.away || ml.home.m == null || ml.away.m == null) continue;
      const mk = (kind, label, q, extra) => ({ kind, label, sport: pg.sport, comp: pg.comp, game: pg.slug, url: pg.url, start: pg.start, mid: q.m, ask: q.a, ...extra });
      // underdog to win: the side priced between 15% and 50%, bought at no more than 55¢
      for (const side of ['home', 'away']) {
        const q = ml[side], other = ml[side === 'home' ? 'away' : 'home'];
        if (q.m >= .15 && q.m <= .5 && q.a != null && q.a <= .55) {
          const team = side === 'home' ? pg.home.name : pg.away.name, vs = side === 'home' ? pg.away.name : pg.home.name;
          out.push(mk('upset', `${team} to beat ${vs}`, q, { away: side === 'away', fav: other.m }));
        }
      }
      // soccer: a draw against a strong favourite (a bottom side tying a big one)
      if (pg.sport === 'soccer' && ml.draw && ml.draw.m != null) {
        const fav = Math.max(ml.home.m, ml.away.m);
        if (fav >= .55 && ml.draw.m >= .18 && ml.draw.m <= .35 && ml.draw.a != null && ml.draw.a <= .4)
          out.push(mk('draw', `${pg.home.name} vs ${pg.away.name} ends level`, ml.draw, { fav }));
      }
    }
    return out;
  }

  // one leg per game; the mixer round-robins across sports so the slip isn't all one league; "New mix" changes the seed
  function build(cands) {
    const bestPerGame = new Map();
    for (const c of cands) {
      const score = c.mid + (c.away ? .03 : 0) + (c.kind === 'draw' ? .02 : 0);  // away underdogs and draws first
      const prev = bestPerGame.get(c.game); if (!prev || score > prev.score) bestPerGame.set(c.game, { ...c, score });
    }
    let pool = [...bestPerGame.values()].sort((a, b) => b.score - a.score);
    let rnd = mulberry(ST.seed * 9301 + 49297);
    if (ST.mixed) {
      const bySport = new Map();
      for (const c of pool) { if (!bySport.has(c.sport)) bySport.set(c.sport, []); bySport.get(c.sport).push(c); }
      for (const xs of bySport.values()) xs.sort(() => rnd() - .5);
      const lists = [...bySport.values()], out = [];
      while (out.length < ST.legs && lists.some(xs => xs.length)) for (const xs of lists) if (xs.length && out.length < ST.legs) out.push(xs.shift());
      return out;
    }
    pool = pool.map(c => ({ c, r: c.score + (rnd() - .5) * .08 })).sort((a, b) => b.r - a.r).map(x => x.c);
    return pool.slice(0, ST.legs);
  }
  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  const stakeNum = () => Math.max(0, +ST.stake || 0);
  function parlayCard(legs) {
    const prob = legs.reduce((s, l) => s * l.mid, 1), dec = legs.reduce((s, l) => s * (l.ask > 0 ? 1 / l.ask : 1), 1), st = stakeNum();
    const sports = [...new Set(legs.map(l => l.sport))];
    return `<div class="pc"><div class="pchead"><span class="pctitle">${legs.length}-leg upset parlay</span><span class="hit h-lo">${P(prob)} market chance</span></div>
      <div class="why">${sports.length} sport${sports.length === 1 ? '' : 's'} · one leg per game · market prices only, no model</div>
      <div style="margin:8px 0">${legs.map((l, i) => `<div class="leg"><span class="legdot">${i + 1}</span><div class="legtxt"><b>${esc(l.label)}</b><span>${esc(l.comp)} · ${l.kind === 'draw' ? 'draw' : 'underdog'} at ${C(l.ask)} · <a href="${esc(l.url)}" target="_blank" rel="noopener">Polymarket</a></span></div><span class="legp mono">${P(l.mid)}</span></div>`).join('')}</div>
      <div class="kpis"><div class="kpi"><b class="mono">${dec ? '×' + dec.toFixed(1) : '—'}</b><span>pays at Polymarket prices</span></div><div class="kpi"><b class="mono">${st && dec ? '$' + (st * dec).toFixed(2) : '—'}</b><span>returns on $${st}</span></div></div>
      <div class="note">Crazy on purpose: most of these lose. Model estimates are not in this tab yet.</div></div>`;
  }

  function render(main) {
    if (!loaded()) {  // the board is still loading: draw again shortly, and stop as soon as it is there
      main.innerHTML = '<h2>💥 Upset Parlays</h2><div class="pc"><div class="why">Loading Polymarket prices…</div></div>';
      setTimeout(() => { if (document.querySelector('#tabs [data-t="upsets"].on')) SB.render(); }, 800);
      return;
    }
    const cands = candidates(), legs = cands.length ? build(cands) : [];
    main.innerHTML = `<h2>💥 Upset Parlays <small>underdogs and draws, today's board</small></h2>
      <div class="note">Who has a long unbeaten run or sits near the bottom of a table isn't in our feeds yet, so the picks come from Polymarket's prices: underdogs priced 15–50% and soccer draws against a 55%+ favourite. Away underdogs rank first.</div>
      <div class="pc" style="margin-bottom:10px">
        <div class="spnav" role="group" aria-label="Sports">${SPORTS.map(([k, l]) => `<button class="chip ${ST.sports.includes(k) ? 'on' : ''}" data-up-sport="${k}" aria-pressed="${ST.sports.includes(k)}">${esc(l)}</button>`).join('')}</div>
        <label class="fl" style="margin-top:10px"><span>Legs: <b class="mono">${ST.legs}</b></span><input type="range" id="upLegs" min="2" max="10" step="1" value="${ST.legs}" aria-label="Number of legs"></label>
        <div class="pl-row" style="margin-top:8px"><label class="fl" style="margin:0"><span>Stake $</span><input type="number" id="upStake" min="0" step="0.01" inputmode="decimal" value="${esc(ST.stake)}" class="stakein" style="max-width:110px"></label>
          <label class="fl" style="margin:0;flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="upMix" ${ST.mixed ? 'checked' : ''}><span>Mix sports</span></label>
          <button class="btn ghost" id="upNew">🔀 New mix</button></div>
      </div>
      ${legs.length ? parlayCard(legs) : `<div class="pc"><div class="why">Not enough underdogs or draws on the board for these filters right now. Try "All sports" or a longer window.</div></div>`}
      <div class="note">${cands.length} candidate legs from ${new Set(cands.map(c => c.game)).size} games in the next ${ST.hours} hours.</div>`;
  }

  // controls
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-up-sport],#upNew');
    if (!b || !document.getElementById('upLegs') || !document.getElementById('main').contains(b)) return;
    if (b.id === 'upNew') { ST.seed++; SB.render(); return; }
    const k = b.dataset.upSport;
    if (k === 'all') ST.sports = ['all'];
    else { let s = ST.sports.filter(x => x !== 'all'); s = s.includes(k) ? s.filter(x => x !== k) : [...s, k]; ST.sports = s.length ? s : ['all']; }
    SB.render();
  });
  document.addEventListener('input', e => {
    if (!e.target || !document.getElementById('main') || !document.getElementById('main').contains(e.target)) return;
    if (e.target.id === 'upLegs') { ST.legs = +e.target.value; e.target.parentNode.querySelector('b').textContent = ST.legs; }
    if (e.target.id === 'upStake') ST.stake = e.target.value;  // the return is drawn when the box loses focus
  });
  document.addEventListener('change', e => {
    if (e.target && e.target.id === 'upLegs') SB.render();
    if (e.target && e.target.id === 'upStake') SB.render();
    if (e.target && e.target.id === 'upMix') { ST.mixed = e.target.checked; SB.render(); }
  });

  SB.registerTab({ key: 'upsets', label: '💥 Upset Parlays', after: 'polymarket', render });
  // the board arrives with Polymarket's data: redraw when it does
  SB.on && SB.on('data', () => { if (document.querySelector('#tabs [data-t="upsets"].on')) SB.render(); });
})();
