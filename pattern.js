// 📅 Weekend Patterns tab: tests the claim "there are weekends when all the big teams lose, and weekends that are 80% draws -
// follow the pattern" on the last 90 days of real results (pattern.json, written by tools/weekend_pattern.py from
// football-data.co.uk results + closing odds), tracks the current round live against its prices, and builds a mix of
// parlays for the next round from what the 90 days actually showed. The parlay cards are the app's own (SB.ticketCard), so
// every leg can be swapped and every card simulated 500,000 times.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('pattern.js: window.SB v2 API not found'); return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(1) + '%';
  let PT = null, LOADED = false;
  const load = () => fetch('pattern.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { PT = d && Array.isArray(d.weeks) ? d : null; LOADED = true; if (document.querySelector('#tabs [data-t="pattern"].on')) SB.render(); });
  load();

  // rounds: Friday-Monday is a weekend (keyed by its Saturday), Tuesday-Thursday a midweek round (keyed by its Wednesday)
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  function roundOf(ms) {
    const d = new Date(ms), wd = d.getUTCDay(), off = wd === 5 ? 1 : wd === 6 ? 0 : wd === 0 ? -1 : wd === 1 ? -2 : 3 - wd;
    return (wd >= 2 && wd <= 4 ? 'M ' : 'W ') + day(ms + off * 864e5);
  }
  const soccer = () => ((SB.DATA && SB.DATA.games) || []).filter(g => g.sport === 'soccer' && g.prob);
  const probs = g => { const p = g.prob, s = (p.home || 0) + (p.draw || 0) + (p.away || 0); return s > 0 ? { h: p.home / s, d: (p.draw || 0) / s, a: p.away / s } : null; };
  const favOf = g => { const q = probs(g); if (!q) return null; return q.h >= q.a ? { side: 'H', p: q.h, team: g.home, opp: g.away, q } : { side: 'A', p: q.a, team: g.away, opp: g.home, q }; };

  // ---------- this round, live against its prices ----------
  function liveRound() {
    const now = Date.now(), G = soccer(), cur = roundOf(now);
    let key = cur, inRound = G.filter(g => roundOf(SB.startMs(g)) === key);
    if (!inRound.some(g => !SB.isFinal(g))) {  // this round is over: track the next one
      const next = G.filter(g => SB.startMs(g) > now).sort((a, b) => SB.startMs(a) - SB.startMs(b))[0];
      if (next) { key = roundOf(SB.startMs(next)); inRound = G.filter(g => roundOf(SB.startMs(g)) === key); }
    }
    let favs = 0, fails = 0, expF = 0, done = 0, draws = 0, expD = 0, left = 0;
    for (const g of inRound) {
      const f = favOf(g); if (!f) continue;
      if (SB.isFinal(g)) {
        done++; const h = g.score.home, a = g.score.away, r = h > a ? 'H' : h < a ? 'A' : 'D';
        if (r === 'D') draws++; expD += f.q.d;
        if (f.p >= .6) { favs++; expF += 1 - f.p; if (r !== f.side) fails++; }
      } else left++;
    }
    return { key, done, left, favs, fails, expF, draws, expD, games: inRound.length };
  }

  // ---------- parlays for the next round ----------
  function nextGames() {
    const now = Date.now(), open = soccer().filter(g => SB.priced(g) && SB.startMs(g) > now).sort((a, b) => SB.startMs(a) - SB.startMs(b));
    if (!open.length) return { key: null, games: [] };
    const key = roundOf(SB.startMs(open[0]));
    return { key, games: open.filter(g => roundOf(SB.startMs(g)) === key) };
  }
  const calOf = comp => (PT && PT.calibration || []).find(c => c.comp === comp) || null;
  const leg = (g, key, label) => ({ gid: g.id, key, label, p: SB.p1(g, key), sport: 'soccer' });
  function parlays() {
    const { key, games } = nextGames(); if (!games.length) return { key, cards: [] };
    const F = games.map(g => ({ g, f: favOf(g) })).filter(x => x.f);
    const big = F.filter(x => x.f.p >= .6).sort((a, b) => b.f.p - a.f.p);
    // leagues where favourites beat their prices over the 90 days first (still one leg per game)
    const backed = [...big].sort((a, b) => ((calOf(b.g.comp) || {}).favRoi > 0) - ((calOf(a.g.comp) || {}).favRoi > 0) || b.f.p - a.f.p);
    const even = F.filter(x => Math.abs(x.f.q.h - x.f.q.a) < .2).sort((a, b) => b.f.q.d - a.f.q.d);
    const win = x => leg(x.g, x.f.side, `${x.f.team.name} to win`);
    const safe = x => leg(x.g, x.f.side === 'H' ? 'DC1X' : 'DCX2', `${x.f.team.name} win or draw`);
    const chaos = x => leg(x.g, x.f.side === 'H' ? 'DCX2' : 'DC1X', `${x.f.opp.name} or draw (against ${x.f.team.name})`);
    const draw = x => leg(x.g, 'D', `${x.g.home.name} vs ${x.g.away.name}: draw`);
    const card = (id, title, legs, sub) => { legs = legs.filter(l => l.p > 0); return legs.length >= 2 ? { id, title, sub, legs } : null; };
    const used = new Set(), take = (xs, n, f) => { const out = []; for (const x of xs) { if (out.length >= n) break; if (used.has(x.g.id)) continue; out.push(f(x)); used.add(x.g.id); } return out; };
    const cards = [
      card('pt-fav', 'Back the big favourites', backed.slice(0, 5).map(win), 'What the 90 days paid: big favourites won more often than their prices said. Leagues where they beat their prices go first.'),
      card('pt-safe', 'Big favourites, win or draw', big.slice(0, 6).map(safe), 'The same idea with a cushion: each favourite only has to avoid losing.'),
      card('pt-chaos', "The tweet's chaos weekend", big.slice(0, 4).map(chaos), "Every big favourite drops points. This is what the tweet bets on; over the 90 days, betting against big favourites lost about 41 cents per dollar."),
      card('pt-draw', 'Draw spots', even.slice(0, 3).map(draw), 'Draws in the most even games (they draw most). Over the 90 days, draws landed less often than priced; this is a long shot.'),
    ];
    // the mix: two favourites to win, two with the cushion, one draw spot, from different games
    used.clear();
    const mix = card('pt-mix', 'The mix', [...take(backed, 2, win), ...take(big, 2, safe), ...take(even, 1, draw)], 'Two favourites to win, two to avoid losing, one draw spot, all different games.');
    return { key, cards: [...cards, mix].filter(Boolean) };
  }

  // ---------- page ----------
  const pv = p => (p < .001 ? '<0.001' : p.toFixed(p < .01 ? 3 : 2));
  function render(main) {
    if (!LOADED) { main.innerHTML = '<h2>📅 Weekend Patterns</h2><div class="pc"><div class="why">Loading the research…</div></div>'; return; }
    if (!PT) { main.innerHTML = '<h2>📅 Weekend Patterns</h2><div class="pc"><div class="why">The 90-day research file (pattern.json) is not available right now.</div></div>'; return; }
    const T = PT.tests, B = PT.bets || {}, L = liveRound(), N = parlays();
    const maxFav = Math.max(1, ...PT.weeks.map(w => Math.max(w.favs, w.favBand[1]))), maxDr = Math.max(1, ...PT.weeks.map(w => Math.max(w.games, 1)));
    const bar = (v, max, cls) => `<span class="ptbar ${cls}" style="width:${Math.max(2, v / max * 100).toFixed(1)}%"></span>`;
    const row = w => `<div class="ptrow"><div class="ptlbl"><b>${w.kind === 'weekend' ? 'Weekend' : 'Midweek'} ${esc(new Date(w.date + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }))}</b><small>${w.games} games</small></div>
      <div class="ptcol"><small class="ptk">Big favourites dropping points</small><div class="ptline">${bar(w.favFails, maxFav, 'act')}<span class="mono">${w.favFails}/${w.favs}</span></div><div class="ptline">${bar(w.favFailsExp, maxFav, 'exp')}<span class="mono">${w.favFailsExp.toFixed(1)} priced · chance ${w.favBand[0]}–${w.favBand[1]}</span></div></div>
      <div class="ptcol"><small class="ptk">Draws</small><div class="ptline">${bar(w.draws, maxDr, 'act')}<span class="mono">${w.draws} (${P(w.draws / Math.max(1, w.games))})</span></div><div class="ptline">${bar(w.drawsExp, maxDr, 'exp')}<span class="mono">${w.drawsExp.toFixed(1)} priced · ${w.drawBand[0]}–${w.drawBand[1]}</span></div></div></div>`;
    const claim = (q, a, ok) => `<div class="mrow"><div class="lbl">${q}<small>${a}</small></div><span class="hit ${ok ? 'h-hi' : 'h-lo'}">${ok ? 'Yes' : 'No'}</span></div>`;
    main.innerHTML = `<h2>📅 Weekend Patterns <small>${PT.games.toLocaleString()} games · ${esc(PT.window[0])} to ${esc(PT.window[1])}</small></h2>
      <div class="pc"><div class="pchead"><span class="pctitle">"Weekends when all big teams lose… weekends that are 80% draws"</span></div>
        <div class="why" style="margin-top:6px">${esc(PT.verdict)}</div></div>
      <div class="panel" style="padding:2px 14px">
        ${claim('A weekend where every big favourite lost', `${T.allBigLose.value} rounds (chance alone gives ${T.allBigLose.chance.toFixed(2)}). Worst round: ${P(T.worstFavWeekend.value)} of big favourites dropped points.`, T.allBigLose.value > 0)}
        ${claim('A weekend with 80% draws', `${T.draw80Weekends.value} rounds. Most draws in a round: ${P(T.mostDrawsWeekend.value)}.`, T.draw80Weekends.value > 0)}
        ${claim('Rounds swing more than chance', `Favourites ${T.favDispersion.value.toFixed(2)}× the chance swing (p ${pv(T.favDispersion.p)}), draws ${T.drawDispersion.value.toFixed(2)}× (p ${pv(T.drawDispersion.p)}).`, T.favDispersion.p < .05 || T.drawDispersion.p < .05)}
        ${claim('Early slips mean later slips', `Correlation ${T.contagion.value.toFixed(2)} (p ${pv(T.contagion.p)}): ${T.contagion.p < .05 ? 'real at these prices' : T.contagion.p < .15 ? 'a hint, not enough rounds to rely on' : 'no sign of it'}.`, T.contagion.p < .05)}
        ${claim('An upset weekend predicts the next one', `Correlation ${T.favCarryOver.value.toFixed(2)} (p ${pv(T.favCarryOver.p)}).`, T.favCarryOver.p < .05)}
      </div>
      <h2>What betting each side returned <small>$1 a bet at closing odds</small></h2>
      <div class="kpis">${[['Big favourites to win', B.favourites], ['Every draw', B.draws], ['Against big favourites', B.underdogsVsFav]].filter(x => x[1]).map(([n, b]) => `<div class="kpi"><b class="mono" style="color:${b.roi > 0 ? 'var(--yes)' : 'var(--no)'}">${sgn(b.roi)}</b><span>${esc(n)} · ${b.won}/${b.bets} won</span></div>`).join('')}</div>
      <div class="note">${PT.totals.favs} big favourites (priced ${Math.round(PT.favThreshold * 100)}%+ to win): ${PT.totals.favFails} failed to win where the prices expected ${PT.totals.favFailsExp}. ${PT.totals.draws} draws where the prices expected ${PT.totals.drawsExp}. Past returns over 90 days are a small sample, not a promise.</div>
      <h2>This round, live <small>${esc(L.key ? (L.key[0] === 'W' ? 'weekend of ' : 'midweek of ') + L.key.slice(2) : '')}</small></h2>
      <div class="pc"><div class="kpis"><div class="kpi"><b class="mono">${L.fails}/${L.favs}</b><span>big favourites dropped points (${L.expF.toFixed(1)} priced)</span></div><div class="kpi"><b class="mono">${L.draws}/${L.done}</b><span>draws so far (${L.expD.toFixed(1)} priced)</span></div><div class="kpi"><b class="mono">${L.left}</b><span>games still to play</span></div></div>
        <div class="why">${L.done ? 'Early results in a round barely move the later games (see above), so the games still to play are priced on their own.' : 'No results in this round yet.'}</div></div>
      <h2>Parlays for the next round <small>${esc(N.key ? (N.key[0] === 'W' ? 'weekend of ' : 'midweek of ') + N.key.slice(2) : 'no games priced yet')}</small></h2>
      <div class="note">Every leg can be swapped (⇄) and every card simulated 500,000 times. The chances are the model's from today's prices.</div>
      ${N.cards.length ? `<div class="grid">${N.cards.map(c => SB.ticketCard(c.id, esc(c.title), { legs: c.legs, p: SB.parlayProb(c.legs).p, n: c.legs.length }, esc(c.sub))).join('')}</div>` : '<div class="pc"><div class="why">No soccer games are priced for the next round yet.</div></div>'}
      <h2>Round by round <small>big favourites dropping points · draws</small></h2>
      <div class="note">Top bar = what happened, lower bar = what the prices expected; "chance" is the range 90% of simulated rounds land in.</div>
      <div class="panel ptchart" style="padding:6px 14px">${PT.weeks.map(row).join('')}</div>
      <h2>League by league</h2>
      <div class="panel" style="padding:2px 14px">${PT.calibration.map(c => `<div class="mrow"><div class="lbl">${esc(c.comp)}<small>${c.games} games · big favourites won ${c.favWins}/${c.favs} (priced ${c.favWinsExp}) · draws ${c.draws} (priced ${c.drawsExp})</small></div><span class="mono" style="font-weight:800;color:${(c.favRoi || 0) > 0 ? 'var(--yes)' : 'var(--no)'}">${c.favRoi == null ? '—' : sgn(c.favRoi)}</span><span></span></div>`).join('')}</div>
      <div class="note">Right column: return on backing that league's big favourites. Sources: ${esc(PT.sources.csv)}${PT.sources.feedAfter ? `, plus the app's results feed after ${esc(PT.sources.feedAfter)}` : ''}. Re-run every morning.</div>`;
  }
  const css = document.createElement('style');
  css.textContent = '.ptrow{display:grid;grid-template-columns:96px 1fr 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.ptrow:first-child{border-top:0}' +
    '.ptlbl b{display:block;font-size:13px}.ptlbl small{color:var(--mute);font-size:11px}.ptcol{min-width:0}.ptk{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-bottom:2px}.ptline{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mute);min-width:0}' +
    '.ptline .mono{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ptbar{display:block;height:8px;border-radius:4px;flex:none;max-width:45%}.ptbar.act{background:var(--yes)}.ptbar.exp{background:var(--line)}' +
    '@media (max-width:480px){.ptrow{grid-template-columns:1fr}}';
  document.head.appendChild(css);
  SB.registerTab({ key: 'pattern', label: '📅 Weekend Patterns', after: 'upsets', render });
  SB.on && SB.on('data', () => { load(); });
  window.__pattern = { roundOf, liveRound, parlays, get PT() { return PT; } };
})();
