// 📅 Weekend Patterns tab, three views:
//  - Next weekend: the crazy-weekend meter for the next round (chance that 40%+ of the big favourites drop points vs a
//    typical round), the favourites likeliest to slip with their reasons, unbeaten runs on the line, and parlays built
//    from it (crazy-weekend lottos, runs ending, the steady side).
//  - 6 seasons: real research (pattern.json "research", tools/weekend_research.py): ~15,000 games of 7 European leagues
//    with closing odds and European fixtures, every suspected cause of upsets tested against the prices (logistic
//    regression + Holm correction), unbeaten runs ending, months, the craziest rounds.
//  - The tweet: the original 90-day test of "weekends when all big teams lose / 80% draws" (tools/weekend_pattern.py),
//    the live round tracker and its parlay mix.
// Parlay cards are the app's own (SB.ticketCard): every leg can be swapped and every card simulated 500,000 times.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('pattern.js: window.SB v2 API not found'); return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(1) + '%';
  const N0 = x => Number(x).toLocaleString();
  let PT = null, LOADED = false;
  const load = () => fetch('pattern.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { PT = d && (Array.isArray(d.weeks) || d.research) ? d : null; LOADED = true; if (document.querySelector('#tabs [data-t="pattern"].on')) SB.render(); });
  load();
  let view = 'next';
  try { const v = JSON.parse(localStorage.getItem('fm2.ptView')); if (['next', 'research', 'tweet'].includes(v)) view = v; } catch (e) { /* private mode */ }

  // rounds: Friday-Monday is a weekend (keyed by its Saturday), Tuesday-Thursday a midweek round (keyed by its Wednesday)
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  function roundOf(ms) {
    const d = new Date(ms), wd = d.getUTCDay(), off = wd === 5 ? 1 : wd === 6 ? 0 : wd === 0 ? -1 : wd === 1 ? -2 : 3 - wd;
    return (wd >= 2 && wd <= 4 ? 'M ' : 'W ') + day(ms + off * 864e5);
  }
  const soccer = () => ((SB.DATA && SB.DATA.games) || []).filter(g => g.sport === 'soccer' && g.prob);
  const probs = g => { const p = g.prob, s = (p.home || 0) + (p.draw || 0) + (p.away || 0); return s > 0 ? { h: p.home / s, d: (p.draw || 0) / s, a: p.away / s } : null; };
  const favOf = g => { const q = probs(g); if (!q) return null; return q.h >= q.a ? { side: 'H', p: q.h, team: g.home, opp: g.away, q } : { side: 'A', p: q.a, team: g.away, opp: g.home, q }; };
  const leg = (g, key, label) => ({ gid: g.id, key, label, p: SB.p1(g, key), sport: 'soccer' });
  const dateLbl = s => new Date(s + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  // ---------- next weekend: the crazy-weekend forecast ----------
  // research estimate of a favourite failing to win: today's price, corrected the way 6 seasons of big favourites
  // actually did at their prices (plus any cause that held up after the correction for testing many)
  const lg = q => Math.log(q / (1 - q));
  function modelQ(R, pf, flags) {
    const M = R.model || R.calib; let v = M.a + M.b * lg(Math.min(.99, Math.max(.01, 1 - pf)));
    for (const k of flags || []) if (M.causes && M.causes[k] != null) v += M.causes[k];
    return 1 / (1 + Math.exp(-v));
  }
  // exact chance of each number of fails (independent games), finished games counted as they ended
  function failDist(qs) { let d = [1]; for (const q of qs) { const n = new Array(d.length + 1).fill(0); d.forEach((x, i) => { n[i] += x * (1 - q); n[i + 1] += x * q; }); d = n; } return d; }
  function forecast() {
    const R = PT && PT.research, F = R && R.forecast; if (!F) return null;
    const legs = [];
    for (const L of F.legs) {
      const g = SB.gameById(L.gid);
      if (g && SB.isVoid && SB.isVoid(g)) continue;
      if (!g && !L.result) continue;  // gone from the feed with no result
      let priced = L.priced, model = L.model, res = L.result ? L.result === 'failed' : null;
      // finished games count as they ended (the feed's finished games carry no prices, so read the score first)
      if (g && SB.isFinal(g) && g.score) { const h = g.score.home, a = g.score.away, r = h > a ? 'home' : h < a ? 'away' : 'draw'; res = r !== L.favSide; }
      // games still to start follow today's prices; games under way keep their pre-match chance
      else if (res == null && g && g.prob && !SB.started(g)) { const q = probs(g); if (q) { const pf = L.favSide === 'home' ? q.h : q.a; priced = 1 - pf; model = modelQ(R, pf, L.flags); } }
      const done = res != null;
      legs.push({ ...L, g, done, res, priced, model, q: res == null ? model : res ? 1 : 0, q0: res == null ? priced : res ? 1 : 0 });
    }
    if (!legs.length) return null;
    const n = legs.length, need = Math.ceil(R.rounds.threshold * n - 1e-9), dist = failDist(legs.map(l => l.q)), dist0 = failDist(legs.map(l => l.q0));
    const tail = d => d.slice(need).reduce((a, b) => a + b, 0);
    return { R, F, legs, n, need, dist, pCrazy: tail(dist), pPriced: tail(dist0), exp: legs.reduce((a, l) => a + l.q, 0), exp0: legs.reduce((a, l) => a + l.q0, 0),
      done: legs.filter(l => l.done).length, failed: legs.filter(l => l.res === true).length };
  }
  const causeOf = k => ((PT && PT.research && PT.research.causes) || []).find(c => c.key === k);
  const verdictOf = c => (!c ? ['ptv-none', 'no data'] : c.holds ? ['ptv-held', 'held up'] : c.hint ? ['ptv-hint', 'a hint, not proven'] : ['ptv-none', 'no proven effect']);
  const swapSide = s => (s === 'home' ? 'away' : 'home');
  function nextCards(X) {
    if (!X) return [];
    const open = X.legs.filter(l => l.g && !l.done && SB.priced(l.g) && SB.p1(l.g, l.favSide === 'home' ? 'DCX2' : 'DC1X') > 0);
    const card = (id, title, legs, sub) => { legs = legs.filter(l => l.p > 0); return legs.length >= 2 ? { id, title, sub, legs } : null; };
    const against = l => leg(l.g, l.favSide === 'home' ? 'DCX2' : 'DC1X', `${l.dog} or draw (vs ${l.fav})`);
    const slip = [...open].sort((a, b) => b.model - a.model), up3 = slip.length >= 3 ? slip.slice(0, 3) : [];
    const med = [...open].map(l => l.model).sort((a, b) => a - b)[Math.floor((open.length - 1) / 2)];
    const steady = open.filter(l => !up3.includes(l) && l.model <= med).sort((a, b) => a.model - b.model).slice(0, 4);  // the surer half, never the 3-upset games
    const R = PT.research, runs = (R.runsNow || []).filter(r => { const g = SB.gameById(r.gid); return g && SB.openG(g); });
    const seen = new Set(), runLegs = [];
    for (const r of runs) { if (runLegs.length >= 3 || seen.has(r.gid)) continue; seen.add(r.gid); const g = SB.gameById(r.gid); runLegs.push(leg(g, r.side === 'home' ? 'A' : 'H', `${g[swapSide(r.side)].name} beat ${r.team} (unbeaten in ${r.unbeaten})`)); }
    const roi = R.overall ? sgn(R.overall.favRoi) : '', F = R.forecast || {};
    const wild = F.typicalReal > 0 && F.typicalRounds ? `In ${F.typicalRounds} past rounds of these leagues with ${F.typicalWindow ? `about ${F.favs}` : F.favs} big favourites, ${P(F.typicalReal)} were this wild (about 1 in ${Math.round(1 / F.typicalReal)}).` : 'Rounds this wild are rare.';
    return [
      up3.length ? card('pt-crazy3', 'Crazy weekend lotto · 3 upsets', up3.map(against), 'The three big favourites the research rates likeliest to drop points: each underdog only has to avoid losing. A long shot: big favourites usually come through.') : null,
      slip.length >= 5 ? card('pt-crazy5', 'Full chaos · 5 favourites slip', slip.slice(0, 5).map(against), `What a crazy weekend looks like on a slip. ${wild}`) : null,
      card('pt-runs', 'Unbeaten runs end', runLegs, 'The longest unbeaten runs on the line this round, each one ending in a loss. History says long runs end a little less often than their prices suggest, so this is a lotto.'),
      steady.length >= 2 ? card('pt-steady', 'The steady weekend', steady.map(l => leg(l.g, l.favSide === 'home' ? 'H' : 'A', `${l.fav} to win`)), `The ${steady.length} big favourites the research is surest about. Backing every big favourite at closing odds over 6 seasons returned ${roi}: no edge to speak of, but it is the side history supports.`) : null,
    ].filter(Boolean);
  }
  const formHTML = f => (f ? `<span class="ptform">${[...f.slice(-5)].map(c => `<i class="f${c}">${c}</i>`).join('')}</span>` : '');
  function renderNext() {
    const R = PT && PT.research;
    if (!R) return '<div class="pc"><div class="why">The research file is not available right now.</div></div>';
    const X = forecast();
    if (!X) return `<div class="pc"><div class="why">No big favourites (priced ${Math.round(R.favThreshold * 100)}%+) are listed for the next round yet. The research runs every morning.</div></div>`;
    const F = X.F, ratio = X.pCrazy / Math.max(.01, F.typical), same = X.n === F.favs;
    const word = !same ? `${F.favs - X.n} of this morning's ${F.favs} big favourites ${F.favs - X.n === 1 ? 'is' : 'are'} off (postponed or called off)` : ratio >= 1.25 ? 'Wilder than a normal weekend' : ratio <= .8 ? 'Quieter than a normal weekend' : 'About a normal weekend';
    const mx = Math.max(...X.dist), wkd = dateLbl(F.round).replace(/, \d{4}$/, '');
    const cards = nextCards(X);
    const runs = (R.runsNow || []).map(r => ({ ...r, g: SB.gameById(r.gid) })).filter(r => r.g && !(SB.isVoid && SB.isVoid(r.g)));
    const runEnd = r => { if (!SB.isFinal(r.g) || !r.g.score) return null; const h = r.g.score.home, a = r.g.score.away; return (r.side === 'home' ? h < a : a < h) ? '✗ run ended' : '✓ run goes on'; };
    return `<div class="pc ptmeter"><div class="pchead"><span class="pctitle">Crazy weekend meter · weekend of ${esc(wkd)}</span></div>
        <div class="ptbig"><b class="mono">${P(X.pCrazy)}</b><span>chance that ${X.need}+ of the ${X.n} big favourites drop points (a "crazy" round: ${Math.round(R.rounds.threshold * 100)}%+ of them)</span></div>
        <div class="ptgauge" role="img" aria-label="${P(X.pCrazy)} this round vs ${P(F.typical)} in a typical round"><span class="fill" style="width:${Math.min(100, X.pCrazy * 100 * 2).toFixed(1)}%"></span>${same ? `<span class="mark" style="left:${Math.min(100, F.typical * 100 * 2).toFixed(1)}%"></span>` : ''}</div>
        <div class="ptscale"><span>0%</span><span>${same ? `typical ${P(F.typical)}` : ''}</span><span>50%+</span></div>
        <div class="ptlead">${word}.</div>
        <div class="why">The research expects ${X.exp.toFixed(1)} of the ${X.n} big favourites (${esc(F.leagues.join(', '))}) to drop points; the prices alone say ${X.exp0.toFixed(1)}. A typical round of these leagues with ${F.favs} big favourites has a ${P(F.typical)} chance by the same research estimate${F.typicalPriced != null ? ` (${P(F.typicalPriced)} at the prices alone)` : ''}${F.typicalReal != null ? `, and ${P(F.typicalReal)} of ${N0(F.typicalRounds)} past rounds ${F.typicalWindow ? `with ${F.favs - F.typicalWindow} to ${F.favs + F.typicalWindow}` : `with ${F.favs}`} actually went crazy` : ''}. Every big favourite winning: ${P(X.dist[0])}.${X.done ? ` So far ${X.failed} of ${X.done} finished have dropped points.` : ''}</div>
        <div class="pthist" aria-label="Chance of each number of big favourites dropping points">${X.dist.map((p, i) => `<div class="${i >= X.need ? 'hot' : ''}"><span style="height:${Math.max(2, p / mx * 100).toFixed(0)}%"></span><small>${i}</small></div>`).join('')}</div>
        <div class="note" style="margin:4px 0 0">How many of the ${X.n} drop points (red = crazy). Each game counted on its own: 6 seasons found no sign that upsets come in clusters.</div></div>
      <h2>Likeliest to slip <small>big favourites, research estimate of dropping points</small></h2>
      <div class="panel" style="padding:2px 14px">${X.legs.slice().sort((a, b) => b.q - a.q).map(l => {
        const key = l.favSide === 'home' ? 'DCX2' : 'DC1X', p = !l.done && l.g && SB.openG(l.g) ? SB.p1(l.g, key) : null;
        const chips = l.reasons.map(r => { const c = causeOf(r.key), [cls, v] = verdictOf(c); return `<span class="ptchip ${cls}" title="${c ? `odds ratio ${c.or} vs similar-priced favourites, p ${pv(c.pReg)}` : ''}">${esc(r.text)} · ${esc(v)}</span>`; }).join('');
        return `<div class="mrow"><div class="lbl">${esc(l.fav)} vs ${esc(l.dog)}<small>${esc(l.comp)}${l.g ? ' · ' + esc(SB.when(l.g)) : ''} · ${l.favSide === 'home' ? 'at home' : 'away'} · priced ${P(1 - l.priced)} to win ${formHTML(l.form)}</small>${chips ? `<span class="ptchips">${chips}</span>` : ''}</div>
          <span class="mono" style="font-weight:800" title="research estimate (prices alone: ${P(l.priced)})">${l.done ? (l.res ? '✗ slipped' : '✓ won') : P(l.q)}</span><span></span>${p ? `<button class="yes ${SB.inSlip(l.gid, key) ? 'in' : ''}" data-leg="${esc(l.gid)}|${key}" aria-label="${esc(l.dog)} or draw at ${esc(SB.fmtOdds(p))}">${esc(SB.fmtOdds(p))}</button>` : '<span></span>'}</div>`;
      }).join('')}</div>
      <div class="note">Percent = the research estimate that the favourite fails to win (draw or loss): today's price, corrected by how 6 seasons of big favourites did at their prices. The chips are this game's situations, with what the research found about each (see 6 seasons). The button adds "underdog or draw".</div>
      ${runs.length ? `<h2>Unbeaten runs on the line <small>league games, this round</small></h2>
      <div class="panel" style="padding:2px 14px">${runs.map(r => { const k = r.side === 'home' ? 'A' : 'H', p = SB.openG(r.g) ? SB.p1(r.g, k) : null; return `<div class="mrow"><div class="lbl">${esc(r.team)} · unbeaten in ${r.unbeaten}<small>${r.side === 'home' ? 'home to' : 'away at'} ${esc(r.opp)} · ${esc(r.comp)} · ${esc(SB.when(r.g))} ${formHTML(r.form)}</small><small>Run ends (a loss): ${P(r.pLose)} priced${r.pLoseHist != null ? ` · ${P(r.pLoseHist)} adjusted for how runs this long have ended` : ''}</small></div>
        <span class="mono" style="font-weight:800">${runEnd(r) || (SB.started(r.g) ? 'under way' : P(r.pLoseHist != null ? r.pLoseHist : r.pLose))}</span><span></span>${p ? `<button class="yes ${SB.inSlip(r.gid, k) ? 'in' : ''}" data-leg="${esc(r.gid)}|${k}" aria-label="${esc(r.opp)} to win at ${esc(SB.fmtOdds(p))}">${esc(SB.fmtOdds(p))}</button>` : '<span></span>'}</div>`; }).join('')}</div>
      <div class="note">${(() => { const L = (R.unbeatenRuns || []).filter(x => x.lo >= 10), e = L.reduce((a, x) => a + x.ended, 0), x = L.reduce((a, y) => a + y.expected, 0); return L.length ? `Over 6 seasons, runs of 10+ games ended ${N0(e)} times where the prices expected ${Math.round(x)}: long runs are not "due" to end.` : ''; })()} The button adds the opponent to win.</div>` : ''}
      <h2>Parlays for this weekend <small>every leg can be swapped (⇄) · 500,000-run sims</small></h2>
      ${cards.length ? `<div class="grid">${cards.map(c => SB.ticketCard(c.id, esc(c.title), { legs: c.legs, p: SB.parlayProb(c.legs).p, n: c.legs.length }, esc(c.sub))).join('')}</div>` : '<div class="pc"><div class="why">The games of this round have started.</div></div>'}
      <div class="note">Estimates, not promises. Research from ${N0(R.games)} games, updated ${esc(String(R.updated).slice(0, 10))}; results through ${esc(R.resultsThrough)}${R.feedResultsAdded ? ' plus the app\'s results feed' : ''}.</div>`;
  }

  // ---------- 6 seasons of research ----------
  const pv = p => (p < .001 ? '<0.001' : p.toFixed(p < .01 ? 3 : 2));
  function renderResearch() {
    const R = PT && PT.research;
    if (!R) return '<div class="pc"><div class="why">The research file is not available right now.</div></div>';
    const O = R.overall, RR = R.rounds, held = R.causes.filter(c => c.holds), hints = R.causes.filter(c => c.hint);
    const L10 = (R.unbeatenRuns || []).filter(x => x.lo >= 10), e10 = L10.reduce((a, x) => a + x.ended, 0), x10 = L10.reduce((a, y) => a + y.expected, 0);
    const seasons = `${R.seasons[0].slice(0, 2)}/${R.seasons[0].slice(2)} to ${R.seasons[R.seasons.length - 1].slice(0, 2)}/${R.seasons[R.seasons.length - 1].slice(2)}`;
    const kpi = (v, t, col) => `<div class="kpi"><b class="mono"${col ? ` style="color:${col}"` : ''}>${v}</b><span>${t}</span></div>`;
    const mx = Math.max(1.2, ...R.months.map(m => m.ratio));
    return `<div class="pc"><div class="pchead"><span class="pctitle">Can you predict a crazy weekend?</span></div>
        <div class="ptlead">${held.length ? `Partly: ${esc(held.map(c => c.desc.toLowerCase()).join('; '))} held up.` : 'Not beyond the odds.'}</div>
        <div class="why">${held.length ? '' : `None of the ${R.causes.length} suspected causes of upsets held up once each was measured against similar-priced favourites and corrected for testing ${R.causes.length} at once. `}Crazy weekends happen about as often as chance at those prices allows${RR.crazyRounds < RR.crazyChanceCal ? ' (a little less, in fact)' : ''}, and upsets don't cluster. What the history does give: how big favourites really do at their prices, how runs end, and the real chance of a crazy round, shown on the next-weekend view.</div>
        <div style="color:var(--mute);font-size:12px;margin-top:4px">${N0(R.games)} games (${esc(R.leagues.join(', '))}, seasons 20${esc(seasons)}) with closing odds, plus ${N0(R.euroGames)} Champions, Europa and Conference League games.</div></div>
      <div class="kpis ptkpis">${kpi(`${N0(O.fails)} / ${N0(Math.round(O.expected))}`, `big favourites (${Math.round(R.favThreshold * 100)}%+) failed to win vs margin-free prices (${N0(O.n)} games)`)}
        ${kpi(sgn(O.favRoi), 'backing every big favourite at the real closing odds: break-even, so that gap is mostly the bookmaker\'s margin', O.favRoi > 0 ? 'var(--yes)' : 'var(--no)')}
        ${kpi(`${RR.crazyRounds} / ${RR.rounds}`, `crazy rounds (${Math.round(RR.threshold * 100)}%+ of big favourites slipped); chance alone gives about ${Math.round(RR.crazyChanceCal)}`)}
        ${L10.length ? kpi(`${N0(e10)} / ${Math.round(x10)}`, 'unbeaten runs of 10+ that ended next game, vs the prices') : ''}</div>
      <h2>What makes a big favourite slip? <small>${R.causes.length} causes tested</small></h2>
      <div class="panel" style="padding:2px 14px">${[...R.causes].sort((a, b) => a.pReg - b.pReg).map(c => { const [cls, v] = verdictOf(c); return `<div class="mrow"><div class="lbl">${esc(c.desc)}<small>${N0(c.n)} games · failed to win ${c.fails} vs ${c.expected} priced · vs similar-priced favourites: odds ratio ${c.or} (${c.orLo}–${c.orHi}), p ${pv(c.pReg)}</small></div><span class="${cls}">${esc(v)}</span><span></span></div>`; }).join('')}</div>
      <div class="note">Odds ratio above 1 = favourites in that spot fail more often than others at the same price; below 1 = less. Each cause is measured with the price and every other cause held fixed (logistic regression), and only counts if it survives Holm's correction for testing ${R.causes.length} at once. ${hints.length ? `"A hint": nominally significant (p < 0.05) but not after the correction, so it could be chance. ` : ''}The plain "failed vs priced" counts run low almost everywhere because big favourites as a group beat margin-free prices.</div>
      <h2>Prices vs results <small>big favourites by price</small></h2>
      <div class="panel" style="padding:2px 14px">${R.calib.buckets.map(b => `<div class="mrow"><div class="lbl">Priced ${Math.round(b.lo * 100)}–${Math.round(Math.min(1, b.hi) * 100)}% to win<small>${N0(b.n)} favourites · failed ${P(b.rate)} of the time vs ${P(b.pricedRate)} priced</small></div><span class="mono" style="font-weight:800">${P(1 - b.rate)} won</span><span></span></div>`).join('')}</div>
      <h2>Unbeaten runs: how often they end <small>all teams, next game</small></h2>
      <div class="panel" style="padding:2px 14px">${R.unbeatenRuns.map(r => `<div class="mrow"><div class="lbl">Unbeaten in ${esc(r.run.replace('-', '–'))}<small>${N0(r.n)} games · lost ${N0(r.ended)} (${P(r.rate)}) vs ${P(r.priced)} priced</small></div><span class="hit ${r.ratio < .95 ? 'h-hi' : r.ratio > 1.05 ? 'h-lo' : 'h-mid'}">${r.ratio.toFixed(2)}×</span><span></span></div>`).join('')}</div>
      <div class="note">Ratio below 1: runs that long ended less often than their prices said. A run is not "due" to end, and a long one is no sign of a coming upset.</div>
      <h2>By month <small>big favourites failing vs priced</small></h2>
      <div class="panel ptmonths" style="padding:8px 14px">${R.months.map(m => `<div class="ptmrow"><b>${esc(m.key)}</b><span class="ptmbar"><span style="width:${(m.ratio / mx * 100).toFixed(1)}%" class="${m.ratio > 1 ? 'up' : ''}"></span><i style="left:${(1 / mx * 100).toFixed(1)}%"></i></span><span class="mono">${m.ratio.toFixed(2)}×</span><small>${N0(m.n)}</small></div>`).join('')}</div>
      <div class="note">The line marks "as priced". ${(() => { const up = R.months.filter(m => m.ratio > 1); return up.length ? `Only ${esc(up.map(m => m.key).join(', '))} ran above it, and not by enough to rule out chance.` : 'Every month ran at or below its prices.'; })()}</div>
      <h2>The craziest rounds <small>most big favourites dropping points vs priced</small></h2>
      <div class="panel" style="padding:2px 14px">${R.craziest.map(c => `<div class="mrow"><div class="lbl">Weekend of ${esc(dateLbl(c.date))}<small>${c.failed} of ${c.favs} big favourites dropped points (${c.expected} priced)</small><div class="why">${esc(c.examples.join(' · '))}</div></div><span class="mono" style="font-weight:800">${P(c.share)}</span><span></span></div>`).join('')}</div>
      ${R.crazyTraits && R.crazyTraits.length ? `<h2>What the craziest rounds had in common <small>share of their big favourites</small></h2>
      <div class="panel" style="padding:2px 14px">${R.crazyTraits.map(t => `<div class="mrow"><div class="lbl">${esc(t.desc)}<small>craziest tenth of rounds ${P(t.crazy)} · other rounds ${P(t.other)}</small></div><span class="mono">${t.crazy > t.other + .03 ? 'more' : t.crazy < t.other - .03 ? 'less' : 'same'}</span><span></span></div>`).join('')}</div>
      <div class="note">A difference here is not a cause: game by game, these situations were tested above against similar-priced favourites. Crazy rounds fall in the busy part of the season, when more teams are also in Europe.</div>` : ''}
      <div class="note">Rounds tested for clustering: fails spread ${RR.dispersion.toFixed(2)}× what independent games would give (1.00 = chance; p ${pv(RR.pDispersion)}). Sources: ${esc(R.source)}. Re-run every morning.</div>`;
  }

  // ---------- the tweet: 90 days ----------
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
  function nextGames() {
    const now = Date.now(), open = soccer().filter(g => SB.priced(g) && SB.startMs(g) > now).sort((a, b) => SB.startMs(a) - SB.startMs(b));
    if (!open.length) return { key: null, games: [] };
    const key = roundOf(SB.startMs(open[0]));
    return { key, games: open.filter(g => roundOf(SB.startMs(g)) === key) };
  }
  const calOf = comp => (PT && PT.calibration || []).find(c => c.comp === comp) || null;
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
  function renderTweet() {
    if (!PT || !Array.isArray(PT.weeks)) return '<div class="pc"><div class="why">The 90-day research file is not available right now.</div></div>';
    const T = PT.tests, B = PT.bets || {}, L = liveRound(), N = parlays();
    const maxFav = Math.max(1, ...PT.weeks.map(w => Math.max(w.favs, w.favBand[1]))), maxDr = Math.max(1, ...PT.weeks.map(w => Math.max(w.games, 1)));
    const bar = (v, max, cls) => `<span class="ptbar ${cls}" style="width:${Math.max(2, v / max * 100).toFixed(1)}%"></span>`;
    const row = w => `<div class="ptrow"><div class="ptlbl"><b>${w.kind === 'weekend' ? 'Weekend' : 'Midweek'} ${esc(new Date(w.date + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }))}</b><small>${w.games} games</small></div>
      <div class="ptcol"><small class="ptk">Big favourites dropping points</small><div class="ptline">${bar(w.favFails, maxFav, 'act')}<span class="mono">${w.favFails}/${w.favs}</span></div><div class="ptline">${bar(w.favFailsExp, maxFav, 'exp')}<span class="mono">${w.favFailsExp.toFixed(1)} priced · chance ${w.favBand[0]}–${w.favBand[1]}</span></div></div>
      <div class="ptcol"><small class="ptk">Draws</small><div class="ptline">${bar(w.draws, maxDr, 'act')}<span class="mono">${w.draws} (${P(w.draws / Math.max(1, w.games))})</span></div><div class="ptline">${bar(w.drawsExp, maxDr, 'exp')}<span class="mono">${w.drawsExp.toFixed(1)} priced · ${w.drawBand[0]}–${w.drawBand[1]}</span></div></div></div>`;
    const claim = (q, a, ok) => `<div class="mrow"><div class="lbl">${q}<small>${a}</small></div><span class="hit ${ok ? 'h-hi' : 'h-lo'}">${ok ? 'Yes' : 'No'}</span></div>`;
    return `<div class="pc"><div class="pchead"><span class="pctitle">"Weekends when all big teams lose… weekends that are 80% draws"</span></div>
        <div class="why" style="margin-top:6px">${esc(PT.verdict)}</div><small style="color:var(--mute)">${N0(PT.games)} games · ${esc(PT.window[0])} to ${esc(PT.window[1])}</small></div>
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

  // ---------- page ----------
  function render(main) {
    if (!LOADED) { main.innerHTML = '<h2>📅 Weekend Patterns</h2><div class="pc"><div class="why">Loading the research…</div></div>'; return; }
    if (!PT) { main.innerHTML = '<h2>📅 Weekend Patterns</h2><div class="pc"><div class="why">The research file (pattern.json) is not available right now.</div></div>'; return; }
    const R = PT.research;
    const seg = `<div class="seg" id="ptSeg" style="margin-bottom:10px">${[['next', '🔮 Next weekend'], ['research', '🔬 6 seasons'], ['tweet', '🐦 The tweet']].map(([v, t]) => `<button data-v="${v}" class="${view === v ? 'on' : ''}" aria-pressed="${view === v}">${t}</button>`).join('')}</div>`;
    main.innerHTML = `<h2>📅 Weekend Patterns <small>${R ? `${N0(R.games)} games · ${R.leagues.length} leagues · ${R.seasons.length} seasons` : `${N0(PT.games)} games · 90 days`}</small></h2>${seg}
      ${view === 'research' ? renderResearch() : view === 'tweet' ? renderTweet() : renderNext()}`;
    const sg = main.querySelector('#ptSeg');
    if (sg) sg.onclick = e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; try { localStorage.setItem('fm2.ptView', JSON.stringify(view)); } catch (err) { /* private mode */ } SB.render(); };
  }
  const css = document.createElement('style');
  css.textContent = '.ptrow{display:grid;grid-template-columns:96px 1fr 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.ptrow:first-child{border-top:0}' +
    '.ptlbl b{display:block;font-size:13px}.ptlbl small{color:var(--mute);font-size:11px}.ptcol{min-width:0}.ptk{display:block;font-size:10.5px;font-weight:700;letter-spacing:.02em;color:var(--dim);margin-bottom:2px}.ptline{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mute);min-width:0}' +
    '.ptline .mono{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ptbar{display:block;height:8px;border-radius:4px;flex:none;max-width:45%}.ptbar.act{background:var(--yes)}.ptbar.exp{background:var(--line)}' +
    '#ptSeg button{flex:1;min-width:0}' +
    '.ptbig{display:flex;align-items:baseline;gap:10px;margin:8px 0 6px}.ptbig b{font-size:34px;font-weight:800;line-height:1;white-space:nowrap;flex:none}' +
    '.ptlead{font-weight:700;font-size:15px;margin:8px 0 2px}.ptkpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}' +
    '.ptv-held,.ptv-hint,.ptv-none{font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;text-align:center}.ptv-held{background:color-mix(in srgb,var(--yes) 18%,transparent);color:var(--yes)}.ptv-hint{background:color-mix(in srgb,#d9a400 18%,transparent);color:#d9a400}.ptv-none{background:var(--soft);color:var(--mute)}.ptbig span{color:var(--mute);font-size:13px}' +
    '.ptgauge{position:relative;height:10px;border-radius:6px;background:var(--line);overflow:visible}.ptgauge .fill{display:block;height:100%;border-radius:6px;background:var(--no)}.ptgauge .mark{position:absolute;top:-4px;width:2px;height:18px;background:var(--text);border-radius:1px}' +
    '.ptscale{display:flex;justify-content:space-between;font-size:11px;color:var(--mute);margin:3px 0 8px}' +
    '.pthist{display:flex;gap:3px;align-items:flex-end;height:70px;margin-top:10px}.pthist>div{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;min-width:0}.pthist span{display:block;width:100%;background:var(--line);border-radius:3px 3px 0 0}.pthist .hot span{background:var(--no)}.pthist small{font-size:10px;color:var(--mute)}' +
    '.ptchips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.ptchip{font-size:11px;font-weight:600;white-space:normal;text-align:left}' +
    '.ptform{display:inline-flex;gap:2px;margin-left:4px;vertical-align:middle}.ptform i{font-style:normal;font-size:10px;font-weight:700;width:15px;height:15px;line-height:15px;text-align:center;border-radius:3px;background:var(--line)}.ptform .fW{background:color-mix(in srgb,var(--yes) 35%,transparent)}.ptform .fL{background:color-mix(in srgb,var(--no) 35%,transparent)}' +
    '.ptmrow{display:grid;grid-template-columns:36px 1fr 48px 44px;gap:8px;align-items:center;padding:4px 0;font-size:12px}.ptmrow small{color:var(--mute);text-align:right}.ptmbar{position:relative;height:10px;background:var(--soft);border-radius:5px}.ptmbar span{display:block;height:100%;border-radius:5px;background:var(--yes)}.ptmbar span.up{background:var(--no)}.ptmbar i{position:absolute;top:-3px;width:2px;height:16px;background:var(--text);opacity:.6}' +
    '@media (max-width:480px){.ptrow{grid-template-columns:1fr}.ptbig b{font-size:30px}}';
  document.head.appendChild(css);
  SB.registerTab({ key: 'pattern', label: '📅 Weekend Patterns', after: 'upsets', render });
  SB.on && SB.on('data', () => { load(); });
  window.__pattern = { roundOf, liveRound, parlays, forecast, nextCards, modelQ, failDist, get PT() { return PT; }, get view() { return view; } };
})();
