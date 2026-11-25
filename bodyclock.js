// 🌙 Body Clock tab (bodyclock.json, tools/body_clock.py): the reel's claim that West Coast teams beat the spread in night games
// against East Coast teams because of their body clock (Smith et al. 1997 / 2013), re-tested on real closing lines in three sports,
// with a Monday Night Football breakdown. Three views:
//  - Monday night: the next Monday game broken down: the rule check, the market (DraftKings via ESPN, no-vig), ESPN's predictor,
//    Polymarket, the last meeting, team form against the closing lines, key players from this season's box scores (season.json),
//    injuries, Monday nights this season, what to check before betting, and last Monday's recap. Once the game is priced in the
//    app's feed, the engine's numbers and two same game parlays (SB.ticketCard: ⇄ swaps, 500,000 runs) appear here.
//  - The study: the claim, the papers, and our re-tests (NFL, NBA, soccer) with ranges and p-values. If the edge had held in
//    more than one sport the tab would be labelled "Multi game" (research.verdict.multi); it did not.
//  - Night games: this week's games with each team's body-clock time, where the rule would point, the market and the model.
// Past patterns are not guarantees; every sample under ~30 games is labelled small.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('bodyclock.js: window.SB v2 API not found'); return; }
  const KEY = 'bodyclock';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => typeof x === 'number' && isFinite(x);
  const P = x => (num(x) ? Math.round(x * 100) + '%' : '—');
  const P1 = x => (num(x) ? (x * 100).toFixed(1) + '%' : '—');
  const am = x => (num(x) ? (x > 0 ? '+' : '') + Math.round(x) : '—');
  const sp = x => (num(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x) : 'PK');
  const pv = p => (!num(p) ? '—' : p < 0.001 ? '< 0.001' : p < 0.01 ? p.toFixed(3) : p.toFixed(2));
  const team = (a, big) => (SB.ui && SB.ui.team ? SB.ui.team(a, big) : '');
  let BC = null, LOADED = false, SEASON = null, SEASON_ASKED = false;
  let view = 'mnf', wk = 'all';
  try { const v = JSON.parse(localStorage.getItem('fm2.bcView')); if (['mnf', 'study', 'week'].includes(v)) view = v; } catch (e) { /* private mode */ }
  const isOn = () => SB.tab === KEY;
  const load = () => fetch('bodyclock.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { BC = d && d.research && Array.isArray(d.research.tests) ? d : null; LOADED = true; label(); if (isOn()) SB.render(); });
  load();
  // the tab's name follows the research: "Multi game" only if the edge held in more than one sport
  const multi = () => !!(BC && BC.research && BC.research.verdict && BC.research.verdict.multi);
  let lastLabel = null;
  function label() { const l = '🌙 Body Clock' + (multi() ? ' · Multi game' : ''); if (l !== lastLabel) { lastLabel = l; SB.registerTab({ key: KEY, label: l, render }); } }

  // ---------- time ----------
  const fmt = (iso, tz, o) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(iso)); } catch (e) { return ''; } };
  const clock = (iso, tz) => fmt(iso, tz, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const dayLbl = (iso, tz) => fmt(iso, tz || 'America/New_York', { weekday: 'short', month: 'short', day: 'numeric' });
  const hourAt = (iso, tz) => { const s = fmt(iso, tz, { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }); const m = /(\d+):(\d+)/.exec(s); return m ? (+m[1] % 24) + m[2] / 60 : null; };
  const inWin = h => num(h) && h >= 16 && h < 20;
  const dateOnly = s => new Date(String(s).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // ---------- the app's feed: find a game, read the engine ----------
  const ALIAS = { LAR: 'LA', WSH: 'WAS', JAX: 'JAC', GS: 'GSW', NY: 'NYK', SA: 'SAS', NO: 'NOP', UTAH: 'UTA' };
  const canon = (sport, a) => { a = String(a || '').toUpperCase(); if (sport === 'nfl' && a === 'NO') return 'NO'; return ALIAS[a] || a; };
  const STOPW = new Set('fc cf sc ac afc club city united real sporting athletic the and de'.split(' '));
  const words = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOPW.has(w));
  const nameHit = (a, b) => { const A = words(a), B = words(b); return A.some(w => B.includes(w)); };
  function feedGame(x) {
    const G = (SB.DATA && SB.DATA.games) || [], t = Date.parse(x.kickoffUTC);
    if (!num(t)) return null;
    for (const g of G) {
      if (g.sport !== x.sport || Math.abs(Date.parse(g.start) - t) > (x.sport === 'soccer' ? 3 : 6) * 3600e3) continue;
      if (x.sport === 'soccer') {
        if (nameHit(g.home.name, x.home.name) && nameHit(g.away.name, x.away.name)) return { g, flip: false };
        if (nameHit(g.home.name, x.away.name) && nameHit(g.away.name, x.home.name)) return { g, flip: true };
        continue;
      }
      const H = canon(x.sport, x.home.abbr), A = canon(x.sport, x.away.abbr), gh = canon(g.sport, g.home.abbr), ga = canon(g.sport, g.away.abbr);
      if (gh === H && ga === A) return { g, flip: false };
      if (gh === A && ga === H) return { g, flip: true };
    }
    return null;
  }
  // the engine's view of a game (from the feed's prices): win chances, and for NFL / NBA the spread on its 100,000 simulations
  function model(x, spreadHome) {
    const f = feedGame(x); if (!f) return { inFeed: false };
    const g = f.g; if (!SB.priced(g)) return { inFeed: true, g, priced: false };
    const pH = SB.p1(g, f.flip ? 'A' : 'H'), pA = SB.p1(g, f.flip ? 'H' : 'A'), pD = x.sport === 'soccer' ? SB.p1(g, 'D') : null;
    const out = { inFeed: true, priced: true, g, flip: f.flip, home: pH, away: pA, draw: pD };
    if (x.sport !== 'soccer' && num(spreadHome)) {
      const s = SB.simGame(g);
      if (s && s.mg) { let w = 0, push = 0; const N = s.N, sg = f.flip ? -1 : 1; for (let i = 0; i < N; i++) { const v = sg * s.mg[i] + spreadHome; if (v > 1e-9) w++; else if (Math.abs(v) <= 1e-9) push++; } out.cover = { home: w / N, push: push / N, away: (N - w - push) / N, line: spreadHome }; out.margin = sg * s.mu; out.total = s.T; out.genTotal = !(g.total > 0); }
    }
    return out;
  }

  // ---------- small parts ----------
  const tag = (txt, cls) => `<span class="bc-tag ${cls || ''}">${esc(txt)}</span>`;
  const small = n => (num(n) && n < 100 ? ' <span class="bc-sm">small sample</span>' : '');
  const clockRow = (iso, a, h) => {
    const ha = hourAt(iso, a.tz), hh = hourAt(iso, h.tz);
    const one = (t, hr) => `<div class="bc-clk${inWin(hr) ? ' win' : ''}">${team(t.abbr)}<div><b>${esc(clock(iso, t.tz))}</b><small>${esc(t.abbr)} body clock${t.zone ? ` · ${esc(t.zone)}` : ''}${inWin(hr) ? ' · in the 4-8 PM window' : ''}</small></div></div>`;
    return `<div class="bc-clocks">${one(a, ha)}${one(h, hh)}</div>`;
  };
  const list = (items, cls) => (items && items.length ? `<ul class="bc-list ${cls || ''}">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  const section = (title, sub, body) => `<h2>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</h2>${body}`;

  // ---------- view: Monday night ----------
  function mnfView() {
    const M = BC.mnf;
    if (!M) return '<div class="pc"><div class="why">No Monday night game is scheduled in the next week (the regular season may be over). The study and the night games are in the other two views.</div></div>';
    const a = M.away, h = M.home, mk = M.market || {}, hA = h.abbr, aA = a.abbr;
    const x = { sport: 'nfl', kickoffUTC: M.kickoffUTC, away: a, home: h };
    const mdl = model(x, num(mk.spread) ? (mk.fav === hA ? mk.spread : -mk.spread) : null);
    const kickET = `${dayLbl(M.kickoffUTC)} · ${clock(M.kickoffUTC, 'America/New_York')} (${clock(M.kickoffUTC, 'America/Los_Angeles')})`;
    const started = Date.now() >= Date.parse(M.kickoffUTC);
    let html = `<div class="pc bc-hero"><div class="bc-kick">Monday Night Football · week ${esc(M.week)}${M.tv ? ` · ${esc(M.tv)}` : ''}</div>
      <div class="bc-match">${team(aA, true)}<div><b>${esc(a.name)}</b><small>${esc(a.record || '')} · away</small></div><span class="bc-at">@</span>${team(hA, true)}<div><b>${esc(h.name)}</b><small>${esc(h.record || '')} · home</small></div></div>
      <div class="bc-when">${esc(kickET)}${M.venue ? ` · ${esc(M.venue)}` : ''}${started ? ' · <b>started</b>' : ''}</div>
      ${clockRow(M.kickoffUTC, a, h)}
      <div class="bc-rule">${tag(M.rule && M.rule.applies ? 'The reel\'s rule applies' : 'The reel\'s rule doesn\'t apply', M.rule && M.rule.applies ? 'y' : 'n')}<span>${esc(M.rule ? M.rule.text : '')}${M.rule && M.rule.applies ? ' Our re-tests found no edge in this spot (see The study).' : ''}</span></div>
      ${M.stakes ? `<div class="why">${esc(M.stakes)}</div>` : ''}</div>`;
    // the market
    const tiles = [];
    if (num(mk.spread)) tiles.push(['Spread', `${mk.fav} ${sp(mk.spread)}${mk.spreadOdds ? ` (${am(mk.fav === hA ? mk.spreadOdds.home : mk.spreadOdds.away)})` : ''}`]);
    if (num(mk.total)) tiles.push(['Total', String(mk.total)]);
    if (mk.ml) tiles.push(['Moneyline', `${hA} ${am(mk.ml.home)} · ${aA} ${am(mk.ml.away)}`]);
    if (mk.noVig) tiles.push(['Market chance (margin removed)', `${hA} ${P(mk.noVig.home)} · ${aA} ${P(mk.noVig.away)}`, true]);
    if (M.predictor) tiles.push(["ESPN's model", `${hA} ${P(M.predictor.home)} · ${aA} ${P(M.predictor.away)}`]);
    if (M.polymarket) tiles.push(['Polymarket', `${hA} ${P(M.polymarket.home)} · ${aA} ${P(M.polymarket.away)}`]);
    if (mk.implied) tiles.push(['Implied score', `${hA} ${mk.implied.home} · ${aA} ${mk.implied.away}`]);
    html += section('The market', `${mk.book || ''}${mk.fetched ? ` · checked ${dateOnly(mk.fetched)}` : ''}`,
      `<div class="pc">${SB.ui && SB.ui.tiles ? SB.ui.tiles(tiles) : tiles.map(t => `<div>${esc(t[0])}: ${esc(t[1])}</div>`).join('')}
       ${mk.move ? `<div class="why">${esc(mk.move)}</div>` : ''}
       <div class="note">"Market chance" is the moneyline with the bookmaker's margin taken out.${M.predictor ? ` ${esc(M.predictor.source || '')}.` : ''}${M.polymarket && M.polymarket.note ? ` Polymarket: ${esc(M.polymarket.note)}.` : ''} Prices move: check yours before betting.</div></div>`);
    // the model + parlays
    html += section("The app's model", 'the engine, from the feed\'s prices', modelBlock(M, mdl, hA, aA, mk));
    // last meeting
    const L = M.lastMeeting;
    if (L) {
      const q = L.quarters || {}, qa = q[aA] || q.away || [], qh = q[hA] || q.home || [];
      const qt = qa.length ? `<div class="bc-tw"><table class="bc-t"><thead><tr><th></th>${qa.map((_, i) => `<th>Q${i + 1}</th>`).join('')}<th>Final</th></tr></thead><tbody>
        <tr><td>${esc(aA)}</td>${qa.map(v => `<td>${esc(v)}</td>`).join('')}<td><b>${qa.reduce((s, v) => s + (+v || 0), 0)}</b></td></tr>
        <tr><td>${esc(hA)}</td>${qh.map(v => `<td>${esc(v)}</td>`).join('')}<td><b>${qh.reduce((s, v) => s + (+v || 0), 0)}</b></td></tr></tbody></table></div>` : '';
      const st = (L.stats || []).length ? `<div class="bc-tw"><table class="bc-t bc-stt"><thead><tr><th></th><th>${esc(aA)}</th><th>${esc(hA)}</th></tr></thead><tbody>${L.stats.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>` : '';
      html += section('Last time they met', `${dateOnly(L.date)}${L.where ? ' · ' + L.where : ''}`,
        `<div class="pc"><div class="pchead"><span class="pctitle">${esc(L.final)}</span></div>${L.line ? `<div class="why">Line: ${esc(L.line)}. ${esc(L.result || '')}</div>` : ''}${qt}${st}${list(L.notes)}</div>`);
    }
    if (M.h2h && M.h2h.games && M.h2h.games.length) {
      html += section('Head to head', `last ${M.h2h.games.length}`, `<div class="pc">${M.h2h.games.map(g => `<div class="mrow"><div class="lbl">${esc(g.away)} @ ${esc(g.home)} · ${esc(g.score)}<small>${esc(dateOnly(g.date))}${g.line ? ` · line ${esc(g.line)}` : ' · no line on ESPN'}${g.cover ? ` · ${esc(g.cover)} covered` : ''}${g.ou ? ` · ${g.ou === 'O' ? 'over' : g.ou === 'U' ? 'under' : 'push'}` : ''}</small></div></div>`).join('')}<div class="note">${esc(M.h2h.text || '')}</div></div>`);
    }
    // team form vs the closing lines
    if (M.teams) html += section('Form against the closing lines', 'this season', `<div class="bc-two">${[['away', a], ['home', h]].map(([k, t]) => teamForm(M.teams[k], t)).join('')}</div>
      <div class="note">ATS = against the spread (W-L-push); O/U = over / under the closing total. Lines: DraftKings via ESPN. Splits of under 10 games are small samples and could easily be chance.</div>`);
    // players (season.json, loaded on demand)
    html += section('Key players', "this season's box scores", `<div id="bcPlayers">${playersHTML(M)}</div>`);
    // injuries
    if (M.injuries) {
      const inj = k => (M.injuries[k] || []).map(i => `<div class="mrow"><div class="lbl">${esc(i.name)} <span class="bc-pos">${esc(i.pos || '')}</span><small>${esc(i.injury || '')}</small></div><span class="bc-st ${/out|reserve/i.test(i.status) ? 'out' : 'q'}">${esc(i.status)}</span></div>`).join('') || '<div class="why">None listed.</div>';
      html += section('Injuries', M.injuries.asOf ? `as of ${dateOnly(M.injuries.asOf)}` : '', `<div class="bc-two"><div class="pc"><div class="pchead"><span class="pctitle">${esc(a.abbr)}</span></div>${inj('away')}</div><div class="pc"><div class="pchead"><span class="pctitle">${esc(h.abbr)}</span></div>${inj('home')}</div></div>${M.injuries.note ? `<div class="note">${esc(M.injuries.note)}</div>` : ''}`);
    }
    // Monday nights this season
    const S = M.mnfSeason;
    if (S && S.n) {
      html += section('Monday nights this season', `${S.n} games${S.n < 30 ? ' · small sample' : ''}`,
        `<div class="pc"><div class="kpis bc-k">${[[`${S.over}-${S.under}`, 'overs - unders'], [S.dogsAts, 'underdogs against the spread'], [S.favSu, 'favourites straight up'], [S.homeSu, 'home teams straight up']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
         <details class="bc-more"><summary>Every Monday game</summary>${(S.games || []).map(g => `<div class="mrow"><div class="lbl">Week ${esc(g.week)}: ${esc(g.score)}<small>${esc(dateOnly(g.date))} · line ${esc(g.line || '—')} · total ${esc(g.total ?? '—')} · ${g.ou === 'O' ? 'over' : g.ou === 'U' ? 'under' : 'push'}${g.cover ? ` · ${esc(g.cover)} covered` : ''}</small></div></div>`).join('')}</details>
         <div class="note">${S.n} games can't show a lasting edge either way.</div></div>`);
    }
    if ((M.facts || []).length) html += section('What the numbers say', '', `<div class="pc">${list(M.facts)}</div>`);
    if ((M.watch || []).length) html += section('Check before you bet', '', `<div class="pc">${list(M.watch)}</div>`);
    html += lastMnfHTML();
    if ((M.notVerified || []).length) html += `<details class="bc-more pc"><summary>What we couldn't verify</summary>${list(M.notVerified)}</details>`;
    return html;
  }
  function modelBlock(M, mdl, hA, aA, mk) {
    if (!mdl.inFeed) return `<div class="pc"><div class="why">This game isn't in the app's feed yet. The feed adds games a few days ahead, usually once the week's Thursday game is played. Then the model's chances and two same game parlays (with ⇄ swaps and 500,000 runs) appear here. Until then, the numbers above are the market's.</div></div>`;
    if (!mdl.priced) return `<div class="pc"><div class="why">This game is in the feed, but it ${SB.started(mdl.g) || SB.isFinal(mdl.g) ? 'has started, so pre-game parlays are closed' : "has no prices yet, so the model can't price it. Check back later"}.</div></div>`;
    const c = mdl.cover;
    const nv = mk.noVig || {};
    const diff = num(nv.home) ? mdl.home - nv.home : null;
    let out = `<div class="pc"><div class="kpis bc-k">
      <div class="kpi"><b class="mono">${P(mdl.home)}</b><span>${esc(hA)} to win (market ${P(nv.home)})</span></div>
      <div class="kpi"><b class="mono">${P(mdl.away)}</b><span>${esc(aA)} to win (market ${P(nv.away)})</span></div>
      ${c ? `<div class="kpi"><b class="mono">${P(c.home)}</b><span>${esc(hA)} ${sp(c.line)} covers${c.push > 0.001 ? ` · push ${P(c.push)}` : ''}</span></div>` : ''}
      ${num(mdl.margin) ? `<div class="kpi"><b class="mono">${mdl.margin > 0 ? esc(hA) + ' by ' + mdl.margin.toFixed(1) : esc(aA) + ' by ' + (-mdl.margin).toFixed(1)}</b><span>average margin in the simulations</span></div>` : ''}</div>
      <div class="why">${num(diff) && Math.abs(diff) >= 0.03 ? `The feed's price and the sportsbook's differ by ${Math.round(Math.abs(diff) * 100)} points on ${esc(hA)}. Prices come from different books at different times, so a gap like this is a reason to shop around, not a sure edge.` : "The model's win chances sit close to the sportsbook's, as expected: both come from market prices."}${mdl.genTotal ? ' The feed has no game total, so total-points legs use a league-average total and are kept out of the parlays.' : ''}</div></div>`;
    // the parlays: a steadier 4 and a bigger "to remember" 7, all legs from this game, priced jointly
    const g = mdl.g, E = SB.engine;
    if (E && E.buildTicket) {
      const build = (n, minP) => { let T = null; for (const m of [minP, minP - 0.05, minP - 0.1]) { T = E.buildTicket({ n, sports: ['nfl'], gids: [g.id], minP: m, propsOnly: false, perPlayer: 1, perGame: n, seed: 0 }); T.minP = m; if (T.legs.length >= n) break; } return T; };
      const A = build(4, 0.75), B = build(7, 0.65);
      const card = (id, title, T, sub) => (T.legs.length >= T.n ? SB.ticketCard(id, esc(title), T, esc(sub)) : `<div class="pc"><div class="pchead"><span class="pctitle">${esc(title)}</span></div><div class="why">This game has only ${T.legs.length} legs that fit together right now (player lines arrive with the morning box-score run).</div></div>`);
      out += `<div class="grid">${card('bc-mnf4', `Monday night · 4 legs · ${aA} @ ${hA}`, A, 'Steadier legs from this one game, priced together: the game lines from the simulation, player legs linked to the game script the way this season\'s box scores show.')}${card('bc-mnf7', `A Monday night to remember · 7 legs`, B, 'More legs, bigger payout, a long shot by design. Swap any leg with ⇄ and run the card 500,000 times.')}</div>
        <div class="note">Every leg is the model's estimate, not a sure thing. The body-clock rule plays no part in these legs: it didn't hold up in our tests.</div>`;
    }
    return out;
  }
  function teamForm(T, t) {
    if (!T) return '';
    const row = (lbl, s) => (s && s.n ? `<div class="mrow"><div class="lbl">${esc(lbl)} <span class="bc-sm2">${s.n} g</span><small>${esc(s.su)} · ATS ${esc(s.ats)} · O/U ${esc(s.ou)}${num(s.pf) ? ` · ${s.pf}-${s.pa} a game` : ''}${s.n < 10 ? ' · small sample' : ''}</small></div></div>` : '');
    const games = (T.games || []).map(g => `<span class="bc-g ${g.res === 'W' ? 'w' : g.res === 'L' ? 'l' : ''}" title="${esc(`${dateOnly(g.date)} ${g.home ? 'vs' : '@'} ${g.opp} ${g.pf}-${g.pa}, line ${sp(g.spread)}, ATS ${g.ats}, ${g.ou === 'O' ? 'over' : g.ou === 'U' ? 'under' : 'push'}`)}">${g.home ? '' : '@'}${esc(g.opp)}<i>${esc(g.pf)}-${esc(g.pa)}</i><em>${esc(g.ats || '')}${g.ou ? '·' + esc(g.ou) : ''}</em></span>`).join('');
    return `<div class="pc"><div class="pchead"><span class="pctitle">${team(t.abbr)} ${esc(t.abbr)} · ${esc(T.record || '')}</span>${num(T.rest) ? `<span class="bc-tag">${T.rest} days rest</span>` : ''}</div>
      ${row('Season', T.season)}${row('At home', T.home)}${row('On the road', T.away)}${row('As favourite', T.fav)}${row('As underdog', T.dog)}
      <div class="bc-gs" aria-label="Every game: opponent, score, against the spread, over / under">${games}</div></div>`;
  }
  // key players from season.json: QB, the top two rushers, the top three receivers (by yards), with the median next to the
  // average (a few big games pull the average up, so lines at the average land under 50%)
  const F = { pa: 3, pyd: 4, ptd: 5, ra: 6, ryd: 7, rtd: 8, tgt: 9, rec: 10, recyd: 11, ctd: 12 };
  const med = v => { const s = [...v].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  function playersHTML(M) {
    if (!SEASON) {
      if (!SEASON_ASKED && SB.season) { SEASON_ASKED = true; SB.season().then(d => { SEASON = d || false; const el = document.getElementById('bcPlayers'); if (el && isOn() && BC && BC.mnf) el.innerHTML = playersHTML(BC.mnf); }); }
      return SEASON === false ? '<div class="pc"><div class="why">The season tables (season.json) are not available right now.</div></div>' : '<div class="pc"><div class="why">Loading this season\'s box scores…</div></div>';
    }
    const N = SEASON.sports && SEASON.sports.nfl; if (!N) return '<div class="pc"><div class="why">No NFL box scores in the season tables.</div></div>';
    const cut = String(M.kickoffUTC).slice(0, 10);
    const sides = [M.away, M.home];
    return `<div class="bc-two">${sides.map(t => {
      const opp = sides.find(s => s !== t);
      const res = ((N.results || {})[t.abbr] || []).filter(r => r[0] < cut), lastTeam = res.length ? res[res.length - 1][0] : null;
      const P0 = (N.players || []).filter(p => p.t === t.abbr).map(p => ({ ...p, log: (p.log || []).filter(r => r[0] < cut) })).filter(p => p.log.length);
      const by = (k, f) => P0.map(p => ({ p, v: p.log.reduce((s, r) => s + (+r[F[k]] || 0), 0) })).filter(x => f(x.p) && x.v > 0).sort((x, y) => y.v - x.v);
      const qb = by('pa', p => p.pos === 'QB')[0], rb = by('ryd', p => p.pos !== 'QB').slice(0, 2), wr = by('recyd', () => true).slice(0, 3);
      const rows = [];
      const add = (x, k, nm) => { if (!x) return; const p = x.p, lg = k === 'pyd' ? p.log.filter(r => (+r[F.pa] || 0) >= 10) : p.log, v = lg.map(r => +r[F[k]] || 0); if (v.length < 2) return; const avg = v.reduce((a, b) => a + b, 0) / v.length, m = med(v);
        const vs = lg.filter(r => r[1] === opp.abbr).map(r => +r[F[k]] || 0), last = lg.slice(-5).map(r => +r[F[k]] || 0), missed = lastTeam && p.log[p.log.length - 1][0] < lastTeam;
        const tds = p.log.reduce((s, r) => s + (+r[F.rtd] || 0) + (+r[F.ctd] || 0), 0), tdg = p.log.filter(r => (+r[F.rtd] || 0) + (+r[F.ctd] || 0) > 0).length;
        rows.push(`<tr><td><b>${esc(p.n)}</b><small>${esc(p.pos || '')} · ${nm} · ${v.length} games${missed ? ' · <span class="bc-miss">missed the last game</span>' : ''}</small></td><td class="mono">${avg.toFixed(0)}</td><td class="mono">${m == null ? '—' : m.toFixed(0)}</td><td class="mono bc-l5">${last.join(' · ')}</td><td class="mono">${vs.length ? vs.join(', ') : '—'}</td><td class="mono">${k === 'pyd' ? `${p.log.reduce((s, r) => s + (+r[F.ptd] || 0), 0)} pass` : `${tdg}/${v.length}`}</td></tr>`); };
      add(qb, 'pyd', 'passing yds'); rb.forEach(x => add(x, 'ryd', 'rushing yds')); wr.forEach(x => add(x, 'recyd', 'receiving yds'));
      return `<div class="pc"><div class="pchead"><span class="pctitle">${team(t.abbr)} ${esc(t.abbr)}</span></div>${rows.length ? `<div class="bc-tw"><table class="bc-t bc-pl"><thead><tr><th>Player</th><th>Avg</th><th>Median</th><th>Last 5</th><th>vs ${esc(opp.abbr)}</th><th>TD games</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="why">No box scores for this team yet.</div>'}</div>`;
    }).join('')}</div><div class="note">From this season's ESPN box scores, games before this one. "TD games" = games with a rushing or receiving touchdown (QB: passing touchdowns this season). When the median sits under the average, a few big games pulled the average up, and a line set at the average lands less than half the time.</div>`;
  }
  function lastMnfHTML() {
    const R = BC.lastMnf; if (!R) return '';
    const q = R.quarters;
    const qt = q && q.away ? `<div class="bc-tw"><table class="bc-t"><thead><tr><th></th>${q.away.map((_, i) => `<th>Q${i + 1}</th>`).join('')}<th>Final</th></tr></thead><tbody>${[[q.awayAbbr, q.away], [q.homeAbbr, q.home]].map(([t, v]) => `<tr><td>${esc(t)}</td>${v.map(x => `<td>${esc(x)}</td>`).join('')}<td><b>${v.reduce((s, x) => s + (+x || 0), 0)}</b></td></tr>`).join('')}</tbody></table></div>` : '';
    return section('Last Monday', `${R.label} · ${dateOnly(R.date)}`, `<div class="pc"><div class="pchead"><span class="pctitle">${esc(R.final)}</span></div>
      <div class="why">${esc(R.how || '')}</div>${qt}
      ${R.line ? `<div class="why"><b>Line:</b> ${esc(R.line)}. ${esc(R.result || '')}</div>` : ''}
      ${(R.beat || []).length ? `<div class="bc-sub">Beat their average</div>${list(R.beat, 'good')}` : ''}
      ${(R.short || []).length ? `<div class="bc-sub">Fell short</div>${list(R.short, 'bad')}` : ''}
      ${R.appLegs ? `<div class="why"><b>The app's legs on this game:</b> ${esc(R.appLegs)}</div>` : ''}
      ${R.lesson ? `<div class="why"><b>Lesson for Monday:</b> ${esc(R.lesson)}</div>` : ''}
      ${R.story ? `<div class="note"><a href="${esc(R.story)}" target="_blank" rel="noopener">${esc(R.storyTitle || 'ESPN recap')}</a></div>` : ''}</div>`);
  }

  // ---------- view: the study ----------
  function studyView() {
    const R = BC.research, C = R.claim || {}, V = R.verdict || {};
    let html = `<div class="pc"><div class="bc-kick">The claim · ${esc(C.who || '')}</div><div class="bc-quote">“${esc(C.says || '')}”</div><div class="why"><b>What we found:</b> ${esc(C.found || '')}</div></div>`;
    html += SB.ui && SB.ui.verdict ? SB.ui.verdict({ tone: V.multi ? 'lean' : 'pass', kicker: 'Our verdict, 3 sports', title: V.title || '', tag: V.multi ? 'Multi game' : 'Not multi game' }) : '';
    html += `<div class="why">${esc(V.text || '')}</div>`;
    for (const T of R.tests) {
      const ppg = T.unit === 'ppg';
      const rows = (T.rows || []).map(r => {
        if (ppg) {
          const lo = r.ci ? r.ci[0] : null, hi = r.ci ? r.ci[1] : null, X = v => Math.max(0, Math.min(100, 50 + v / 0.4 * 50));
          return `<div class="bc-row"><div class="lbl">${esc(r.label)}<small>${r.n} games · p ${pv(r.p)}${r.note ? ' · ' + esc(r.note) : ''}${small(r.n)}</small></div>
            <div class="bc-ci" role="img" aria-label="${esc(`${(r.diff > 0 ? '+' : '') + r.diff.toFixed(2)} points a game against the odds${r.ci ? `, range ${lo.toFixed(2)} to ${hi.toFixed(2)}` : ''}`)}"><i class="z" style="left:50%"></i>${r.ci ? `<span style="left:${X(lo)}%;width:${X(hi) - X(lo)}%"></span>` : ''}<b style="left:${X(r.diff)}%"></b></div><span class="mono bc-v">${(r.diff > 0 ? '+' : '') + r.diff.toFixed(2)}</span></div>`;
        }
        const X = v => Math.max(0, Math.min(100, (v - 0.3) / 0.45 * 100));
        return `<div class="bc-row"><div class="lbl">${esc(r.label)}<small>${esc(r.rec)} · ${r.n} decisions · p ${pv(r.p)}${small(r.n)}</small></div>
          <div class="bc-ci" role="img" aria-label="${esc(`${P1(r.pct)} covered${r.ci ? `, 95% range ${P1(r.ci[0])} to ${P1(r.ci[1])}` : ''}`)}"><i class="z" style="left:${X(0.5)}%"></i><i class="be" style="left:${X(0.5238)}%"></i><i class="cl" style="left:${X(0.68)}%"></i>${r.ci ? `<span style="left:${X(r.ci[0])}%;width:${X(r.ci[1]) - X(r.ci[0])}%"></span>` : ''}<b style="left:${X(r.pct)}%"></b></div><span class="mono bc-v">${P1(r.pct)}</span></div>`;
      }).join('');
      html += section(`${T.title}: ${T.found ? 'edge found' : 'no edge'}`, T.headline, `<div class="pc"><div class="why" style="margin-top:0">${esc(T.what || '')}</div>${rows}
        <div class="note">${ppg ? 'Points a game against what the closing odds expected (0 = exactly as priced). The bar is the 95% range.' : 'Cover rate of the West team. The bar is the 95% range; the lines mark 50% (a coin flip), 52.4% (break-even at -110) and 68% (the reel).'}</div>
        ${list(T.points)}<div class="bc-verd ${T.found ? 'y' : 'n'}">${esc(T.verdict || '')}</div></div>`);
    }
    const bySport = s => (R.studies || []).filter(x => x.sport === s);
    html += section('The papers', 'what each one found', ['nfl', 'nba', 'soccer'].map(s => {
      const L = bySport(s); if (!L.length) return '';
      return `<div class="pc"><div class="pchead"><span class="pctitle">${s === 'nfl' ? 'NFL and college football' : s === 'nba' ? 'NBA' : 'Soccer'}</span></div>${L.map(x => `<div class="bc-paper"><b>${esc(x.who)}${x.year ? ` (${x.year})` : ''}</b>${x.where ? ` <small>${esc(x.where)}</small>` : ''}<p>${esc(x.found)}</p>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">Source</a>` : ''}</div>`).join('')}</div>`;
    }).join('') + '<div class="note">We read abstracts, press releases and later write-ups; the full texts were not reachable from here.</div>');
    html += `<details class="bc-more pc"><summary>What we couldn't verify</summary>${list(R.notVerified)}</details>`;
    if (R.sources) html += `<div class="note">${esc(R.sources)}</div>`;
    return html;
  }

  // ---------- view: night games ----------
  function weekView() {
    const U = BC.upcoming || { games: [] }, now = Date.now();
    const G = (U.games || []).filter(g => Date.parse(g.kickoffUTC) > now - 4 * 3600e3);
    const sports = [['all', 'All'], ['nfl', 'NFL'], ['nba', 'NBA'], ['soccer', 'Soccer']].filter(([k]) => k === 'all' || G.some(g => g.sport === k));
    if (!sports.some(s => s[0] === wk)) wk = 'all';
    const show = G.filter(g => wk === 'all' || g.sport === wk).sort((a, b) => (b.applies - a.applies) || Date.parse(a.kickoffUTC) - Date.parse(b.kickoffUTC));
    const ap = G.filter(g => g.applies);
    let html = `<div class="pc"><div class="why" style="margin-top:0"><b>The rule:</b> ${esc(BC.research.rule ? BC.research.rule.nfl : '')} ${ap.length ? `It points at ${ap.length} game${ap.length === 1 ? '' : 's'} below.` : 'It points at no game in this window.'} Our tests found the market already prices these spots, so treat them as curiosities, not picks.</div>
      <div class="bc-pills" role="group" aria-label="Filter by sport">${sports.map(([k, l]) => `<button type="button" class="chip ${wk === k ? 'on' : ''}" data-bcw="${k}" aria-pressed="${wk === k}">${esc(l)}</button>`).join('')}</div></div>`;
    html += show.length ? show.map(gameCard).join('') : '<div class="pc"><div class="why">No night games with a time-zone gap in this window.</div></div>';
    html += list(U.notes, 'bc-notes');
    const S = BC.season2026 || [];
    if (S.length) {
      const cov = S.filter(g => g.ats === 'covered').length, lost = S.filter(g => g.ats === 'did not cover').length, push = S.filter(g => g.ats === 'push').length;
      html += section('The rule this NFL season', `${cov}-${lost}${push ? '-' + push : ''} against the spread · ${S.length} games · small sample`, `<div class="pc">${S.map(g => `<div class="mrow"><div class="lbl">${esc(g.label)} · ${esc(g.final)}<small>${esc(g.date)} · ${esc(g.west)} ${sp(g.line)}</small></div><span class="bc-st ${g.ats === 'covered' ? 'w' : g.ats === 'push' ? 'q' : 'out'}">${esc(g.ats)}</span></div>`).join('')}<div class="note">${S.length} games say nothing either way; the 15-season test is in The study.</div></div>`);
    }
    return html;
  }
  function gameCard(x) {
    const o = x.odds, spreadHome = o && num(o.homeSpread) ? o.homeSpread : null;
    const m = model(x, spreadHome);
    const lg = x.sport === 'soccer' ? (x.league || 'Soccer') : x.sport.toUpperCase();
    const mk = o && o.noVig ? (x.sport === 'soccer' ? `${x.home.abbr} ${P(o.noVig.home)} · draw ${P(o.noVig.draw)} · ${x.away.abbr} ${P(o.noVig.away)}` : `${x.home.abbr} ${P(o.noVig.home)} · ${x.away.abbr} ${P(o.noVig.away)}`) : null;
    let mm = '';
    if (m.priced) {
      mm = x.sport === 'soccer' ? `${P(m.home)} · draw ${P(m.draw)} · ${P(m.away)}` : `${x.home.abbr} ${P(m.home)} · ${x.away.abbr} ${P(m.away)}`;
      if (m.cover && x.west) { const wHome = canon(x.sport, x.west) === canon(x.sport, x.home.abbr), c = wHome ? m.cover.home : m.cover.away, ln = wHome ? m.cover.line : -m.cover.line; mm += ` · ${x.west} ${sp(ln)} covers ${P(c)}`; }
    }
    const isAbbr = x.sport !== 'soccer';
    return `<div class="pc bc-game${x.applies ? ' ap' : ''}"><div class="pchead"><span class="pctitle">${isAbbr ? `${esc(x.away.abbr)} @ ${esc(x.home.abbr)}` : esc(x.label)}</span>${x.applies ? tag('Rule points at ' + x.west, 'y') : x.gap ? tag(`${x.gap}-hour gap`) : tag('Rule n/a', 'n')}</div>
      <div class="bc-when">${esc(lg)}${x.slot ? ` · ${esc(x.slot)}` : ''} · ${esc(dayLbl(x.kickoffUTC, x.home.tz))}${x.venue ? ` · ${esc(x.venue)}` : ''}${(x.b2b || []).length ? ` · back-to-back: ${esc(x.b2b.join(', '))}` : ''}</div>
      ${clockRow(x.kickoffUTC, x.away, x.home)}
      <div class="why">${esc(x.why || '')}</div>
      ${o || m.priced ? `<div class="bc-mk">${o ? `<div><small>Market${o.book ? ' · ' + esc(o.book) : ''}</small><b>${esc(o.text || '')}</b>${mk ? `<span>${esc(mk)}</span>` : ''}</div>` : ''}${m.priced ? `<div><small>The app's model</small><b>${esc(mm)}</b></div>` : ''}</div>` : '<div class="note">No price posted yet.</div>'}</div>`;
  }

  // ---------- page ----------
  function render(main) {
    const head = (sub) => (SB.ui && SB.ui.page ? SB.ui.page({ kicker: 'Research · night games', title: 'Body', accent: 'Clock', sub }) : '<h2>🌙 Body Clock</h2>');
    if (!LOADED) { main.innerHTML = head('Loading the research…'); return; }
    if (!BC) { main.innerHTML = head('') + '<div class="pc"><div class="why">The body-clock research file (bodyclock.json) is not available right now.</div></div>'; return; }
    const seg = `<div class="seg" id="bcSeg" style="margin-bottom:10px">${[['mnf', '🏈 Monday night'], ['study', '🔬 The study'], ['week', '🌙 Night games']].map(([v, t]) => `<button type="button" data-v="${v}" class="${view === v ? 'on' : ''}" aria-pressed="${view === v}">${t}</button>`).join('')}</div>`;
    const V = BC.research.verdict || {};
    const chips = `<div class="bc-chips">${BC.research.tests.map(t => tag(`${t.sport === 'soccer' ? 'Soccer' : t.sport.toUpperCase()}: ${t.found ? 'edge' : 'no edge'}`, t.found ? 'y' : 'n')).join('')}${tag(V.multi ? 'Multi game' : 'Not multi game', V.multi ? 'y' : '')}</div>`;
    main.innerHTML = `<div id="bcWrap">${head("The reel says West Coast teams beat the spread at night because of their body clock. We tested it on real lines in the NFL, NBA and soccer, then broke down Monday night.")}${chips}${seg}
      ${view === 'study' ? studyView() : view === 'week' ? weekView() : mnfView()}
      <div class="note">Updated ${esc(BC.updated ? new Date(BC.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')}. Research, not advice: past patterns are not guarantees.</div></div>`;
    const w = main.querySelector('#bcWrap');
    w.addEventListener('click', e => {
      const b = e.target.closest('#bcSeg button');
      if (b) { view = b.dataset.v; try { localStorage.setItem('fm2.bcView', JSON.stringify(view)); } catch (err) { /* private mode */ } SB.render(); const nb = document.querySelector(`#bcSeg [data-v="${view}"]`); if (nb) nb.focus(); return; }
      const c = e.target.closest('[data-bcw]');
      if (c) { wk = c.dataset.bcw; SB.render(); const nb = document.querySelector(`[data-bcw="${wk}"]`); if (nb) nb.focus(); }
    });
  }
  const css = document.createElement('style');
  css.textContent = '#bcSeg button{flex:1;min-width:0}.bc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}' +
    '.bc-tag{display:inline-block;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--mute);white-space:nowrap}.bc-tag.y{background:color-mix(in srgb,var(--yes) 18%,transparent);color:var(--yes)}.bc-tag.n{background:color-mix(in srgb,var(--no) 14%,transparent);color:var(--no)}' +
    '.bc-kick{font-size:11.5px;font-weight:700;color:var(--mute);letter-spacing:.02em;margin-bottom:6px}.bc-match{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto minmax(0,1fr);gap:8px;align-items:center}.bc-match b{display:block;font-size:15px;line-height:1.2}.bc-match small{color:var(--mute);font-size:12px}.bc-at{color:var(--mute);font-weight:700}' +
    '.bc-when{font-size:12.5px;color:var(--mute);margin:8px 0}.bc-clocks{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0}.bc-clk{display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;min-width:0}.bc-clk.win{border-color:color-mix(in srgb,var(--yes) 55%,transparent)}.bc-clk b{display:block;font-size:14px}.bc-clk small{display:block;color:var(--mute);font-size:11px;line-height:1.3}.bc-clk>div{min-width:0}' +
    '.bc-rule{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin:8px 0 2px;font-size:13px}.bc-rule span:last-child{flex:1 1 220px}' +
    '.bc-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:10px}.bc-two>.pc{margin:0}.bc-tw{overflow-x:auto;margin:6px 0}.bc-t{border-collapse:collapse;font-size:12.5px;width:100%}.bc-t th,.bc-t td{padding:5px 6px;border-top:1px solid var(--line);text-align:center;white-space:nowrap}.bc-t th{color:var(--mute);font-weight:700;font-size:11px;border-top:0}.bc-t td:first-child,.bc-t th:first-child{text-align:left}' +
    '.bc-pl td:first-child{white-space:normal;min-width:120px}.bc-pl td small{display:block;color:var(--mute);font-size:10.5px}.bc-l5{font-size:11.5px}.bc-miss{color:var(--no)}.bc-stt td:first-child{white-space:normal}' +
    '.bc-st{font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;background:var(--soft);color:var(--mute)}.bc-st.out{background:color-mix(in srgb,var(--no) 16%,transparent);color:var(--no)}.bc-st.q{background:color-mix(in srgb,#d9a400 18%,transparent);color:#d9a400}.bc-st.w{background:color-mix(in srgb,var(--yes) 18%,transparent);color:var(--yes)}' +
    '.bc-pos{font-size:11px;color:var(--mute);font-weight:700}.bc-sm,.bc-sm2{font-size:10.5px;color:#d9a400;font-weight:700}.bc-sm2{color:var(--mute)}.bc-gs{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}.bc-g{display:inline-flex;flex-direction:column;align-items:center;font-size:10.5px;font-weight:700;padding:3px 5px;border-radius:6px;background:var(--soft);min-width:44px}.bc-g i{font-style:normal;font-weight:600}.bc-g em{font-style:normal;color:var(--mute);font-weight:600}.bc-g.w{box-shadow:inset 0 -2px 0 var(--yes)}.bc-g.l{box-shadow:inset 0 -2px 0 var(--no)}' +
    '.bc-list{margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.45}.bc-list li{margin:3px 0}.bc-list.good li::marker{color:var(--yes)}.bc-list.bad li::marker{color:var(--no)}.bc-notes{color:var(--mute);font-size:12px}.bc-sub{font-size:12px;font-weight:700;margin-top:8px;color:var(--dim)}' +
    '.bc-more summary{cursor:pointer;font-weight:700;font-size:13px;padding:2px 0}.bc-k{grid-template-columns:repeat(2,minmax(0,1fr))!important}' +
    '.bc-quote{font-size:15px;line-height:1.45;font-weight:600;margin:2px 0 6px}.bc-row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(90px,1fr) 52px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}.bc-row .lbl{font-size:13px;min-width:0}.bc-row .lbl small{display:block;color:var(--mute);font-size:11px}.bc-v{text-align:right;font-weight:800;font-size:13px}' +
    '.bc-ci{position:relative;height:16px;background:var(--soft);border-radius:8px}.bc-ci span{position:absolute;top:4px;height:8px;border-radius:4px;background:color-mix(in srgb,var(--text) 30%,transparent)}.bc-ci b{position:absolute;top:1px;width:4px;height:14px;margin-left:-2px;border-radius:2px;background:var(--text)}.bc-ci i{position:absolute;top:0;width:1px;height:16px;background:var(--mute);opacity:.6}.bc-ci i.be{background:#d9a400}.bc-ci i.cl{background:var(--no);width:2px}' +
    '.bc-verd{margin-top:8px;font-weight:700;font-size:13.5px}.bc-verd.n{color:var(--no)}.bc-verd.y{color:var(--yes)}.bc-paper{padding:8px 0;border-top:1px solid var(--line);font-size:13px}.bc-paper:first-of-type{border-top:0}.bc-paper small{color:var(--mute)}.bc-paper p{margin:3px 0}.bc-paper a{font-size:12px}' +
    '.bc-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.bc-game.ap{border-color:color-mix(in srgb,var(--yes) 45%,transparent)}.bc-mk{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:8px}.bc-mk>div{padding:8px;border-radius:10px;background:var(--soft);min-width:0}.bc-mk small{display:block;color:var(--mute);font-size:11px}.bc-mk b{display:block;font-size:13px}.bc-mk span{display:block;font-size:12px;color:var(--dim)}' +
    '@media (max-width:480px){.bc-match{grid-template-columns:auto minmax(0,1fr);row-gap:6px}.bc-at{display:none}.bc-row{grid-template-columns:minmax(0,1fr) 46px}.bc-row .bc-ci{grid-column:1 / -1;order:3}}';
  document.head.appendChild(css);
  label();
  SB.on && SB.on('data', () => { if (isOn()) SB.render(); });
  window.__bodyclock = { feedGame, model, canon, hourAt, clock, get BC() { return BC; }, get view() { return view; }, multi };
})();
