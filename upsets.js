// 💥 Upset Parlays tab: underdog legs (and soccer draws against a strong favourite) from Polymarket's board, built into
// "crazy" parlays with a legs scroller and a sport mixer. Prices are Polymarket's, so the chance shown is the market's own.
// form.json = each team's current form researched from actual results (unbeaten run, win / losing streak, last 5, table
// position, with sources): shown on every leg, and a second "form-backed" parlay takes only upsets the form supports.
// Every parlay can be simulated 500,000 times: at the market's chances, and at the app's own model where it prices the game.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('upsets.js: window.SB v2 API not found'); return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const C = x => (x == null ? '—' : Math.round(x * 100) + '¢');
  // a long parlay's chance is well under 1%: show two significant figures rather than rounding it to "0%"
  const PP = x => (x == null ? '—' : x >= .095 ? P(x) : x >= .01 ? (x * 100).toFixed(1) + '%' : x >= 1e-4 ? (x * 100).toPrecision(2) + '%' : '<0.01%');
  const SPORTS = [['all', 'All sports'], ['nba', 'NBA'], ['nfl', 'NFL'], ['nhl', 'NHL'], ['ncaaf', 'College FB'], ['soccer', 'Soccer']];
  const ST = { sports: ['all'], legs: 5, hours: 48, seed: 1, stake: '10', mixed: true };
  const board = () => (window.__polymarket && __polymarket.PM && __polymarket.PM.games) || [];
  // ---------------- researched form ----------------
  let FORM = null;
  const nk = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const loadForm = () => fetch('form.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
    if (d && Array.isArray(d.teams)) { FORM = { ...d, by: new Map(d.teams.map(t => [t.sport + '|' + nk(t.name), t])) }; if (document.querySelector('#tabs [data-t="upsets"].on')) SB.render(); }
  });
  loadForm();
  // injury report (injuries.json, the same file the Injuries tab reads), matched to a board team by code or name
  let INJ = null;
  const loadInj = () => fetch('injuries.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => { if (d && Array.isArray(d.injuries)) INJ = d; });
  loadInj();
  const W_INJ = { out: 1, doubtful: .75, questionable: .25, 'day-to-day': .25 };
  function injOf(sport, t) {
    if (!INJ) return [];
    const a = String(t.abbr || '').toUpperCase(), n = nk(t.name);
    return INJ.injuries.filter(e => e && e.sport === sport && W_INJ[e.status] != null && (e.team === a || (n && (nk(e.teamName).endsWith(n) || n.endsWith(nk(e.teamName))))));
  }
  // what a side is missing: NBA = points a game (season averages via lottos.js's team model), else a weighted head count
  function missing(sport, t) {
    const E = injOf(sport, t); if (!E.length) return { w: 0, list: [], pts: null };
    let pts = null;
    if (sport === 'nba' && window.__lottos && __lottos.teamModel) {
      try { const m = __lottos.teamModel(t.abbr); if (m && m.absent > 0) pts = m.absent; } catch (e) {}
    }
    const w = pts != null ? Math.min(3, pts / 10) : Math.min(2, E.reduce((s, e) => s + .5 * W_INJ[e.status], 0));
    return { w, pts, list: E.filter(e => e.status === 'out' || e.status === 'doubtful').map(e => `${e.player} (${e.status})`) };
  }
  const formOf = (sport, name) => (FORM && FORM.by.get(sport + '|' + nk(name))) || null;
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const L5 = f => (f && f.last5 ? f.last5.trim().split(/\s+/).map(r => `<i class="f5 f5${r === 'W' ? 'w' : r === 'D' ? 'd' : 'l'}">${esc(r === 'OTL' ? 'OT' : r)}</i>`).join('') : '');
  // the facts that matter for an upset, in plain words: unbeaten / winning / losing / winless runs and the table
  function formWords(f, sport) {
    if (!f) return '';
    const w = [];
    if (sport === 'soccer' || sport === 'nhl') { if (f.unbeaten >= 3 && f.unbeaten > f.winStreak) w.push(`unbeaten in ${f.unbeaten}`); }
    if (f.winStreak >= 2) w.push(`won ${f.winStreak} straight`);
    if (f.lossStreak >= 2) w.push(`lost ${f.lossStreak} straight`);
    if (sport === 'soccer' && f.winless >= 3 && f.winless > f.lossStreak) w.push(`no win in ${f.winless}`);
    if (f.position && f.of) w.push(`${ord(f.position)} of ${f.of}${f.league ? ' in ' + f.league : ''}`);
    return w.join(' · ');
  }
  // how far the researched form backs an upset: + for an underdog on a run or a favourite in a slump, - the other way
  function formEdge(dog, fav, sport) {
    if (!dog && !fav) return { score: 0, why: [] };
    dog = dog || {}; fav = fav || {};  // use whichever side was researched
    let s = 0; const why = [];
    const run = sport === 'soccer' || sport === 'nhl' ? dog.unbeaten : dog.winStreak;
    if (run >= 4) { s += 1; why.push(`${sport === 'soccer' || sport === 'nhl' ? 'unbeaten in' : 'won'} ${run}${sport === 'soccer' || sport === 'nhl' ? '' : ' straight'}`); }
    if (fav.lossStreak >= 2) { s += 1; why.push(`favourite lost ${fav.lossStreak} straight`); }
    else if (sport === 'soccer' && fav.winless >= 3) { s += 1; why.push(`favourite without a win in ${fav.winless}`); }
    if (fav.position && fav.of && fav.position > fav.of * 2 / 3) { s += .5; why.push(`favourite ${ord(fav.position)} of ${fav.of}`); }
    // a winning run built mostly against bottom-half sides (from the last 5 games and those opponents' table spots)
    if (fav.soft && fav.winStreak >= 3) { s += 1; why.push(`favourite's ${fav.winStreak}-game run came mostly against bottom-half sides (${fav.vsBottom} of ${fav.runKnown})`); }
    if (dog.lossStreak >= 3) { s -= 1; why.push(`but the underdog has lost ${dog.lossStreak} straight`); }
    if (fav.winStreak >= 4 && !fav.soft) { s -= 1; why.push(`but the favourite has won ${fav.winStreak} straight`); }  // a soft run is counted above
    return { score: s, why };
  }
  const loaded = () => !!(window.__polymarket && __polymarket.PM);

  function candidates() {
    const now = Date.now(), out = [];
    for (const pg of board()) {
      if (pg.stale) continue;
      const t = Date.parse(pg.start); if (!(t > now && t - now <= ST.hours * 3600e3)) continue;
      if (!ST.sports.includes('all') && !ST.sports.includes(pg.sport)) continue;
      const ml = pg.ml || {}; if (!ml.home || !ml.away || ml.home.m == null || ml.away.m == null) continue;
      const mk = (kind, label, q, extra) => ({ kind, label, sport: pg.sport, comp: pg.comp, game: pg.slug, url: pg.url, start: pg.start, mid: q.m, ask: q.a, ...extra });
      // underdog to win: priced below its opponent (in 3-way soccer a 47% side can be the favourite), 15-50%, bought at ≤55¢
      for (const side of ['home', 'away']) {
        const q = ml[side], other = ml[side === 'home' ? 'away' : 'home'];
        if (q.m >= .15 && q.m <= .5 && q.m < other.m && q.a != null && q.a <= .55) {
          const team = side === 'home' ? pg.home.name : pg.away.name, vs = side === 'home' ? pg.away.name : pg.home.name;
          const fd = formOf(pg.sport, team), ff = formOf(pg.sport, vs);
          out.push(mk('upset', `${team} to beat ${vs}`, q, { away: side === 'away', fav: other.m, team, vs, fd, ff, edge: formEdge(fd, ff, pg.sport), model: modelP(pg, side === 'home' ? 'H' : 'A') }));
        }
      }
      // soccer: a draw against a strong favourite (a bottom side tying a big one)
      if (pg.sport === 'soccer' && ml.draw && ml.draw.m != null) {
        const fav = Math.max(ml.home.m, ml.away.m);
        if (fav >= .55 && ml.draw.m >= .18 && ml.draw.m <= .35 && ml.draw.a != null && ml.draw.a <= .4)
          out.push(mk('draw', `${pg.home.name} vs ${pg.away.name} ends level`, ml.draw, { fav, team: pg.home.name, vs: pg.away.name, fd: formOf('soccer', pg.home.name), ff: formOf('soccer', pg.away.name), edge: { score: 0, why: [] }, model: modelP(pg, 'D') }));
      }
    }
    return out;
  }

  // the app's own chance for this outcome when the game is in its feed and priced (Polymarket game -> feed game via polymarket.js)
  function modelP(pg, side) {
    try {
      const m = __polymarket.matchOf && __polymarket.matchOf(pg); if (!m || !m.g || !SB.priced(m.g)) return null;
      const key = side === 'D' ? 'D' : (side === 'H') !== !!m.swap ? 'H' : 'A', p = SB.p1(m.g, key);
      return p > 0 && p < 1 ? p : null;
    } catch (e) { return null; }
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
  const CARDS = {}, SIMS = {};  // card id -> legs; card id -> last 500k result (with the legs' signature, so a stale result is never shown)
  const sigOf = legs => legs.map(l => l.game + l.kind + l.label + l.mid + l.ask).join('|');
  const formLine = (name, f, sport) => f ? `<span class="fline">${esc(name)}: ${L5(f)} ${esc(formWords(f, sport) || f.record || '')}</span>` : '';
  function parlayCard(legs, id, title, sub) {
    CARDS[id] = legs;
    const prob = legs.reduce((s, l) => s * l.mid, 1), dec = legs.reduce((s, l) => s * (l.ask > 0 ? 1 / l.ask : 1), 1), st = stakeNum();
    const sports = [...new Set(legs.map(l => l.sport))];
    return `<div class="pc" id="${id}"><div class="pchead"><span class="pctitle">${esc(title || `${legs.length}-leg upset parlay`)}</span><span class="hit h-lo">${PP(prob)} market chance</span></div>
      <div class="why">${sports.length} sport${sports.length === 1 ? '' : 's'} · one leg per game${sub ? ' · ' + esc(sub) : ''}</div>
      <div style="margin:8px 0">${legs.map((l, i) => `<div class="leg"><span class="legdot">${i + 1}</span><div class="legtxt"><b>${esc(l.label)}</b><span>${esc(l.comp)} · ${l.kind === 'draw' ? 'draw' : l.kind === 'edge' ? 'close game' : 'underdog'} · ${C(l.ask)} to buy${l.model != null ? ` · our model ${P(l.model)}` : ''} · <a href="${esc(l.url)}" target="_blank" rel="noopener">Polymarket</a></span>
        ${l.fd || l.ff ? `<div class="fbox2">${formLine(l.team, l.fd, l.sport)}${formLine(l.vs, l.ff, l.sport)}${l.edge && l.edge.why.length ? `<span class="fwhy">${esc(l.edge.why.join(' · '))}</span>` : ''}</div>` : ''}</div><span class="legp mono">${P(l.mid)}</span></div>`).join('')}</div>
      <div class="kpis"><div class="kpi"><b class="mono">${dec ? '×' + dec.toFixed(1) : '—'}</b><span>pays at Polymarket prices</span></div><div class="kpi"><b class="mono">${st && dec ? '$' + (st * dec).toFixed(2) : '—'}</b><span>returns on $${st}</span></div></div>
      <button class="btn full ghost" data-up-sim="${id}" style="margin-top:8px">${SIMS[id] && SIMS[id].sig === sigOf(legs) ? '🎲 Run again' : '🎲 Simulate 500,000 runs'}</button><div class="upsim" data-up-out="${id}">${simHTML(id)}</div>
      <div class="note">Crazy on purpose: most of these lose. The % on each leg is the market's chance; form is shown beside it, not added to it.</div></div>`;
  }
  // ---------------- 500,000-run simulation ----------------
  // One leg per game, so the legs are independent: each run draws every leg once at its chance. Run twice: at the market's
  // chances, and at the app's own model where it prices that game (the market's chance for legs it doesn't).
  const N_SIM = 500000;
  function hashS(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function runSim(legs, ps, seed) {
    const R = mulberry(seed), n = legs.length, legHits = new Array(n).fill(0); let hits = 0;
    for (let r = 0; r < N_SIM; r++) { let all = true; for (let i = 0; i < n; i++) { if (R() < ps[i]) legHits[i]++; else all = false; } if (all) hits++; }
    const rate = hits / N_SIM, se = Math.sqrt(rate * (1 - rate) / N_SIM);
    return { hits, rate, lo: Math.max(0, rate - 1.96 * se), hi: rate + 1.96 * se, legHits: legHits.map(h => h / N_SIM) };
  }
  function simulate(id) {
    const legs = CARDS[id]; if (!legs || !legs.length) return null;
    const seed = hashS(sigOf(legs)), dec = legs.reduce((s, l) => s * (l.ask > 0 ? 1 / l.ask : 1), 1);
    const mkt = runSim(legs, legs.map(l => l.mid), seed), withModel = legs.filter(l => l.model != null).length;
    const mod = withModel ? runSim(legs, legs.map(l => (l.model != null ? l.model : l.mid)), seed ^ 0x9e3779b9) : null;
    return SIMS[id] = { sig: sigOf(legs), dec, mkt, mod, withModel, n: legs.length, at: Date.now() };
  }
  const pctS = x => (x >= .01 ? (x * 100).toFixed(2) : (x * 100).toPrecision(2)) + '%';
  function simHTML(id) {
    const S = SIMS[id], legs = CARDS[id]; if (!S || !legs || S.sig !== sigOf(legs)) return '';
    const st = stakeNum(), row = (name, r) => {
      const ev = r.rate * S.dec - 1;  // per $1 staked, at the price to buy
      return `<div class="kpis" style="margin-top:6px"><div class="kpi"><b class="mono">${r.hits.toLocaleString()}</b><span>hits (${name})</span></div><div class="kpi"><b class="mono">${(N_SIM - r.hits).toLocaleString()}</b><span>misses</span></div><div class="kpi"><b class="mono">${pctS(r.rate)}</b><span>hit rate · 95% ${pctS(r.lo)}–${pctS(r.hi)}</span></div></div>
        <div class="why">At the price to buy (×${S.dec.toFixed(1)}), $${st || 10} would average ${ev >= 0 ? '+' : '−'}$${Math.abs((st || 10) * ev).toFixed(2)} a bet over these runs (${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%).</div>`;
    };
    return `<div class="sec" style="margin-top:10px">500,000 runs</div>${row('market chances', S.mkt)}${S.mod ? row(`our model on ${S.withModel} of ${S.n} legs`, S.mod) : '<div class="note">Our model doesn\'t price any of these games, so only the market run is shown.</div>'}
      <div class="why" style="margin-top:6px">Each leg in the runs: ${legs.map((l, i) => `${esc(l.team || l.label)} ${pctS(S.mkt.legHits[i])}`).join(' · ')}</div>
      <div class="note">The runs repeat the chances they are given; they can't know more than the market or the model. A run of results is shown above each leg, not fed into the chance.</div>`;
  }

  function render(main) {
    if (!loaded()) {  // the board is still loading: draw again shortly, and stop as soon as it is there
      main.innerHTML = '<h2>💥 Upset Parlays</h2><div class="pc"><div class="why">Loading Polymarket prices…</div></div>';
      setTimeout(() => { if (document.querySelector('#tabs [data-t="upsets"].on')) SB.render(); }, 800);
      return;
    }
    const cands = candidates(), legs = cands.length ? build(cands) : [];
    const fdate = FORM && FORM.updated ? new Date(FORM.updated).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
    main.innerHTML = `<h2>💥 Upset Parlays <small>underdogs and draws, today's board</small></h2>
      <div class="note">Picks are underdogs (priced below their opponent, 15–50%) and soccer draws against a 55%+ favourite, from Polymarket's prices. Each leg's % is the market's chance (the midpoint); the payout uses the price to buy. Away underdogs rank first. ${fdate ? `Form (unbeaten runs, streaks, last 5, table) was researched game by game from results on ${esc(fdate)}${FORM.teams.some(t => t.confidence !== 'verified') ? '; teams marked ? could not be confirmed by a second source' : ''}.` : 'Researched form is not loaded yet.'}</div>
      <div class="pc" style="margin-bottom:10px">
        <div class="spnav" role="group" aria-label="Sports">${SPORTS.map(([k, l]) => `<button class="chip ${ST.sports.includes(k) ? 'on' : ''}" data-up-sport="${k}" aria-pressed="${ST.sports.includes(k)}">${esc(l)}</button>`).join('')}</div>
        <label class="fl" style="margin-top:10px"><span>Legs: <b class="mono">${ST.legs}</b></span><input type="range" id="upLegs" min="2" max="10" step="1" value="${ST.legs}" aria-label="Number of legs"></label>
        <div class="pl-row" style="margin-top:8px"><label class="fl" style="margin:0"><span>Stake $</span><input type="number" id="upStake" min="0" step="0.01" inputmode="decimal" value="${esc(ST.stake)}" class="stakein" style="max-width:110px"></label>
          <label class="fl" style="margin:0;flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="upMix" ${ST.mixed ? 'checked' : ''}><span>Mix sports</span></label>
          <button class="btn ghost" id="upNew">🔀 New mix</button></div>
      </div>
      ${legs.length ? parlayCard(legs, 'upMain') : `<div class="pc"><div class="why">Not enough underdogs or draws on the board for these filters right now. Try "All sports" or a longer window.</div></div>`}
      <div class="note">${cands.length} candidate legs from ${new Set(cands.map(c => c.game)).size} games in the next ${ST.hours} hours.</div>
      ${edgeSection()}
      ${formSections(cands)}`;
  }

  // close games (no side over 62%; soccer: neither over 50% and within 15 points) where one side has the edge: home court /
  // ground, and what the other side is missing from the injury report. The pick is that side to win.
  function edgeLegs() {
    const now = Date.now(), out = [];
    for (const pg of board()) {
      if (pg.stale || !(Date.parse(pg.start) > now && Date.parse(pg.start) - now <= ST.hours * 3600e3)) continue;
      if (!ST.sports.includes('all') && !ST.sports.includes(pg.sport)) continue;
      const ml = pg.ml || {}, h = ml.home, a = ml.away; if (!h || !a || h.m == null || a.m == null) continue;
      const close = pg.sport === 'soccer' ? Math.max(h.m, a.m) <= .5 && Math.abs(h.m - a.m) <= .15 : Math.max(h.m, a.m) <= .62 && Math.min(h.m, a.m) >= .38;
      if (!close) continue;
      const mh = missing(pg.sport, pg.home), ma = missing(pg.sport, pg.away);
      const sc = { home: 1 + ma.w - mh.w, away: mh.w - ma.w };  // home +1; each side gains what the other is missing
      const side = sc.home >= sc.away ? 'home' : 'away', diff = Math.abs(sc.home - sc.away); if (diff < 1) continue;
      const me = pg[side], op = pg[side === 'home' ? 'away' : 'home'], mo = side === 'home' ? ma : mh, mm = side === 'home' ? mh : ma, q = ml[side];
      if (q.a == null) continue;
      const why = [];
      if (side === 'home') why.push('at home');
      if (mo.list.length) why.push(`${op.name} missing ${mo.list.slice(0, 4).join(', ')}${mo.list.length > 4 ? ` +${mo.list.length - 4} more` : ''}${mo.pts ? ` (about ${Math.round(mo.pts)} points a game)` : ''}`);
      if (mm.list.length) why.push(`but ${me.name} missing ${mm.list.slice(0, 3).join(', ')}${mm.pts ? ` (about ${Math.round(mm.pts)} points a game)` : ''}`);
      out.push({ kind: 'edge', label: `${me.name} to beat ${op.name}`, sport: pg.sport, comp: pg.comp, game: pg.slug, url: pg.url, start: pg.start, mid: q.m, ask: q.a,
        team: me.name, vs: op.name, fd: formOf(pg.sport, me.name), ff: formOf(pg.sport, op.name), edge: { score: diff, why }, model: modelP(pg, side === 'home' ? 'H' : 'A') });
    }
    return out.sort((x, y) => y.edge.score - x.edge.score || y.mid - x.mid);
  }
  function edgeSection() {
    const E = edgeLegs(), legs = E.slice(0, ST.legs);
    const idate = INJ && INJ.updated ? new Date(INJ.updated).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' }) : null;
    return `<h2>Close games with an edge <small>home side, or the other team short-handed</small></h2>
      <div class="note">Games the market calls close (no side over 62%; soccer: neither side over 50%), where one team plays at home and/or the other is missing players on the injury report${idate ? ` (checked ${esc(idate)})` : ''}. The market already prices home advantage and announced injuries, so these are reasons, not a lock: the % on each leg is still the market's.</div>
      ${legs.length >= 2 ? parlayCard(legs, 'upEdge', `${legs.length}-leg close-game edge parlay`, 'home side or opponent injuries') : ''}
      ${E.length ? `<div class="panel" style="padding:2px 14px">${E.slice(0, 12).map(l => `<div class="mrow"><div class="lbl">${esc(l.label)} <small>${esc(l.comp)} · market ${P(l.mid)}${l.model != null ? ` · our model ${P(l.model)}` : ''} · ${C(l.ask)} to buy</small><span class="fwhy">${esc(l.edge.why.join(' · '))}</span></div></div>`).join('')}${E.length > 12 ? `<div class="note">${E.length - 12} more close games lean to the home side only.</div>` : ''}</div>`
        : `<div class="pc"><div class="why">No close game in this window has a home or injury edge right now${ST.sports.includes('all') ? '' : ' for these sports'}.</div></div>`}`;
  }
  // the upsets the researched form backs (underdog on a run, favourite in a slump), and the runs themselves
  function formSections(cands) {
    if (!FORM) return '';
    const best = new Map();
    for (const c of cands) if (c.kind === 'upset' && c.edge && c.edge.score >= 1) { const p = best.get(c.game); if (!p || c.edge.score + c.mid > p.edge.score + p.mid) best.set(c.game, c); }
    const fl = [...best.values()].sort((a, b) => b.edge.score - a.edge.score || b.mid - a.mid).slice(0, ST.legs);
    const inPlay = new Map();  // team -> {f, sport, opp, chance} for every team on the filtered board
    const now = Date.now();
    for (const pg of board()) {
      if (pg.stale || !(Date.parse(pg.start) > now && Date.parse(pg.start) - now <= ST.hours * 3600e3)) continue;
      if (!ST.sports.includes('all') && !ST.sports.includes(pg.sport)) continue;
      for (const [me, op, q] of [[pg.home, pg.away, pg.ml && pg.ml.home], [pg.away, pg.home, pg.ml && pg.ml.away]]) {
        const f = formOf(pg.sport, me.name); if (f) inPlay.set(pg.sport + me.name, { f, sport: pg.sport, name: me.name, opp: op.name, p: q && q.m, comp: pg.comp, start: pg.start });
      }
    }
    const T = [...inPlay.values()], runLen = x => (x.sport === 'soccer' || x.sport === 'nhl' ? x.f.unbeaten : x.f.winStreak);
    const runs = T.filter(x => runLen(x) >= 3).sort((a, b) => runLen(b) - runLen(a)).slice(0, 12);
    const cold = T.filter(x => x.p != null && x.p > .5 && (x.f.lossStreak >= 2 || (x.sport === 'soccer' && x.f.winless >= 3))).sort((a, b) => Math.max(b.f.lossStreak, b.f.winless) - Math.max(a.f.lossStreak, a.f.winless));
    const q = x => (x.f.confidence === 'verified' ? '' : ' <span title="not confirmed by a second source">?</span>');
    // streak check: every team on a 3+ game winning run, with who the wins came against
    const streaks = T.filter(x => x.f.winStreak >= 3 && Array.isArray(x.f.games) && x.f.games.length).sort((a, b) => (b.f.soft - a.f.soft) || b.f.winStreak - a.f.winStreak);
    const oppF = x => formOf(x.sport, x.opp), spot = f => (f && f.position && f.of ? `${ord(f.position)} of ${f.of}` : 'table spot not known');
    const gameRow = g => `<span class="fline">${esc(g.date || '')} ${g.home === false ? '@' : 'vs'} ${esc(g.opp)}${g.oppPos && g.oppOf ? ` (${ord(g.oppPos)} of ${g.oppOf})` : ''}: <b>${esc(g.result)}</b> ${esc(g.score || '')}</span>`;
    const rowT = (x, what) => `<div class="mrow"><div class="lbl">${esc(x.name)}${q(x)} <small>${esc(what)} · next: ${esc(x.opp)} (${esc(x.comp)}) · market ${P(x.p)}</small><span class="fline">${L5(x.f)} ${esc(x.f.record || '')}${x.f.lastGame ? ' · last: ' + esc(x.f.lastGame) : ''}</span></div></div>`;
    return `<h2>Form-backed upsets <small>underdog on a run or favourite in a slump</small></h2>
      ${fl.length >= 2 ? parlayCard(fl, 'upForm', `${fl.length}-leg form-backed upset parlay`, 'form picks the legs, the market prices them') : `<div class="pc"><div class="why">${fl.length ? 'Only one upset on this board has the form behind it' : 'No upset on this board has the researched form behind it'} right now${ST.sports.includes('all') ? '' : ' for these sports'}.</div></div>`}
      <h2>Unbeaten runs on this board <small>researched from results</small></h2>
      <div class="panel" style="padding:2px 14px">${runs.length ? runs.map(x => rowT(x, x.sport === 'soccer' || x.sport === 'nhl' ? `unbeaten in ${x.f.unbeaten}${x.f.winStreak >= 2 ? `, won the last ${x.f.winStreak}` : ''}` : `won ${x.f.winStreak} straight`)).join('') : '<div class="empty" style="border:0">No team playing in this window is on a run of 3 or more.</div>'}</div>
      <h2>Favourites in a slump <small>priced to win, but losing</small></h2>
      <div class="panel" style="padding:2px 14px">${cold.length ? cold.map(x => rowT(x, x.f.lossStreak >= 2 ? `lost ${x.f.lossStreak} straight` : `no win in ${x.f.winless}`)).join('') : '<div class="empty" style="border:0">No favourite in this window is on a losing or winless run.</div>'}</div>
      <h2>Streak check <small>who the wins came against</small></h2>
      <div class="note">A winning run doesn't make a loss due: each game is decided by who is playing. What can be worth betting against is a run built on weak opponents, priced as if it came against good ones. <b>Soft</b> = most of the run's wins came against bottom-half sides.</div>
      ${streaks.length ? streaks.map(x => { const of = oppF(x); return `<div class="pc"><div class="pchead"><span class="pctitle">${esc(x.name)}${q(x)} · won ${x.f.winStreak} straight</span><span class="hit ${x.f.soft ? 'h-lo' : 'h-mid'}">${x.f.soft ? 'Soft run' : x.f.runKnown ? 'Earned run' : 'Opponents unknown'}</span></div>
        <div class="why">${x.f.runKnown ? `${x.f.vsBottom} of the ${x.f.runKnown} wins we could place came against bottom-half sides.` : 'The opponents\' table spots were not found.'} Next: ${esc(x.opp)} (${esc(spot(of))}) · market gives ${esc(x.name)} ${P(x.p)}.</div>
        <div style="margin-top:6px">${x.f.games.map(gameRow).join('')}</div></div>`; }).join('') : '<div class="pc"><div class="why">No team playing in this window is on a 3+ game winning run with its last 5 games researched.</div></div>'}
      <div class="note">NHL and soccer runs count draws and overtime losses as unbeaten; NBA and NFL runs are straight wins. ${FORM.teams.length} teams researched; teams without researched form show no form line.</div>`;
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
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-up-sim]'); if (!b) return;
    const id = b.dataset.upSim, out = document.querySelector(`[data-up-out="${id}"]`); if (!CARDS[id]) return;
    b.disabled = true; b.textContent = 'Running 500,000…';
    setTimeout(() => { simulate(id); if (out) out.innerHTML = simHTML(id); b.disabled = false; b.textContent = '🎲 Run again'; }, 30);  // let the label paint first
  });
  const css = document.createElement('style');
  css.textContent = '.fbox2{display:flex;flex-direction:column;gap:2px;margin-top:4px}.fline{display:block;font-size:12px;color:var(--mute)}.fwhy{font-size:12px;color:var(--yes);font-weight:700}' +
    '.f5{display:inline-block;min-width:16px;padding:0 3px;margin-right:2px;border-radius:4px;font-style:normal;font-size:10px;font-weight:800;text-align:center;color:#000}.f5w{background:var(--yes)}.f5d{background:#9aa3ad}.f5l{background:var(--no);color:#fff}';
  document.head.appendChild(css);
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
  SB.on && SB.on('data', () => { loadForm(); loadInj(); if (document.querySelector('#tabs [data-t="upsets"].on')) SB.render(); });
  window.__upsets = { formOf, formEdge, formWords, simulate, edgeLegs, missing, get CARDS() { return CARDS; }, get SIMS() { return SIMS; }, N_SIM };
})();
