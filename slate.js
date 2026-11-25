// slate.js: Games ('slate'), docs/pro-interface.md screen 6. One matchup card per game on the chosen Los Angeles day:
//  - both teams, the time and league, and the model's win chance for each side (soccer adds the draw);
//  - tiles: Spread (the model's fair line: its mean home margin rounded to the half point, with the favourite's cover chance),
//    Money (fair American odds for the favourite) and Total (the model total rounded to the half point, with the over chance).
//    NHL shows the puck line (win by 2+, from the score grid); soccer shows home / draw / away and over / under 2.5 goals;
//  - a "lean" band ONLY when there is evidence beyond the model: a Team Trends flag for this game (trends.json: upset watch or
//    over / under lean, with its reasons and sample) or a Polymarket price 3+ points away from the feed (sharp.js compares them).
//    The model itself is built from the sportsbook prices in the feed, so on its own it never disagrees with them;
//  - game-script bars, the three likeliest player legs of the game with + Slip, and Deep dive / Simulate / Ask.
// Params: {gid} opens that game's day, scrolls to its card and highlights it. Every number is a model estimate.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('slate.js: window.SB v2 API (with SB.ui) not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'slate';
  const num = x => typeof x === 'number' && isFinite(x);
  const pct = p => (num(p) ? Math.round(p * 100) + '%' : '—');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) { /* private mode */ } } };
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'College FB', nhl: 'NHL', soccer: 'Soccer' };
  const SPORDER = ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'];
  const TZ = 'America/Los_Angeles';
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const wFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  const dFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const dayLabel = day => { const t = Date.parse(day + 'T12:00:00Z'); return isFinite(t) ? dFmt.format(new Date(t)) : day; };
  const MINUS = '−', sgn = x => (x > 0 ? '+' : x < 0 ? MINUS : '') + Math.abs(x);
  const lineTxt = x => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const fair = p => U.fair(p).replace('-', MINUS);
  const money = v => (!num(v) ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k' : '$' + Math.round(v));

  // ---------- the model, read from SB.fit (margin sports analytically: no extra simulation runs) ----------
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  // home margin d: P(d > x), P(d < x), P(d = x). NFL / college: the integer key-number pmf; NBA: the normal.
  const gt = (m, x) => { if (m.disc) { let s = 0; for (let i = 0; i < m.pm.length; i++) if (i - m.kmax > x) s += m.pm[i]; return s; } return 1 - Phi((x - m.mu) / m.sd); };
  const lt = (m, x) => { if (m.disc) { let s = 0; for (let i = 0; i < m.pm.length; i++) if (i - m.kmax < x) s += m.pm[i]; return s; } return Phi((x - m.mu) / m.sd); };
  const eq = (m, x) => (m.disc && Number.isInteger(x) && Math.abs(x) <= m.kmax ? m.pm[x + m.kmax] : 0);
  const half = x => Math.round(x * 2) / 2;

  let MODEL = new Map();
  function modelOf(g) {
    if (MODEL.has(g.id)) return MODEL.get(g.id);
    let M = null;
    try { M = SB.priced(g) ? build(g) : null; } catch (e) { console.warn('slate.js', g.id, e); M = null; }
    MODEL.set(g.id, M); return M;
  }
  function build(g) {
    const m = SB.fit(g); if (!m) return null;
    const H = g.home.abbr, A = g.away.abbr;
    if (m.kind === 'margin') {
      const pH = gt(m, 0) + eq(m, 0) / 2, pA = 1 - pH, favH = m.mu >= 0, fav = favH ? H : A, dog = favH ? A : H;
      const L = half(Math.abs(m.mu)), cover = L === 0 ? (favH ? pH : pA) : favH ? gt(m, L) : lt(m, -L), push = L === 0 ? 0 : favH ? eq(m, L) : eq(m, -L);
      const LT = half(m.T), over = 1 - Phi((LT - m.T) / m.tsd), B = E.BLOW[g.sport] || 15;
      const blow = m.disc ? gt(m, B - 0.5) + lt(m, -(B - 0.5)) : gt(m, B) + lt(m, -B);
      return {
        kind: 'margin', pH, pA, pD: 0, fav, dog, favH, pFav: favH ? pH : pA,
        spread: { label: 'Spread', line: L, val: L === 0 ? 'Pick’em' : `${fav} ${MINUS}${lineTxt(L)}`, p: cover, push, sub: L === 0 ? `${fav} wins ${pct(cover)}` : `covers ${pct(cover)}${push >= 0.005 ? ` · push ${pct(push)}` : ''}` },
        total: { line: LT, val: `O/U ${lineTxt(LT)}`, p: over, gen: !!m.genTotal },
        ctx: [['Close game · within 8', 1 - gt(m, 8) - lt(m, -8)], [`Blowout · ${B}+`, blow]],
        mu: m.mu,
      };
    }
    const O = SB.outcomes(g); if (!O) return null;
    const pH = SB.p1(g, 'H'), pA = SB.p1(g, 'A'), favH = pH >= pA, fav = favH ? H : A, dog = favH ? A : H;
    if (g.sport === 'nhl') {
      let et = 0, sh = 0; for (let i = 0; i < O.n; i++) { et += (O.h[i] + O.a[i]) * O.p[i]; if (O.h[i] === 0 || O.a[i] === 0) sh += O.p[i]; }
      const LT = half(et); let over = 0, push = 0; for (let i = 0; i < O.n; i++) { const t = O.h[i] + O.a[i]; if (t > LT) over += O.p[i]; else if (t === LT) push += O.p[i]; }
      const S = SB.scoreMatrix(g); let ot = 0; if (S) for (let h = 0; h < S.n; h++) ot += S.P[h * S.n + h];
      const pl = SB.p1(g, favH ? 'H2' : 'A2');
      return {
        kind: 'nhl', pH, pA, pD: 0, fav, dog, favH, pFav: favH ? pH : pA,
        spread: { label: 'Puck line', line: 1.5, val: `${fav} ${MINUS}1.5`, p: pl, push: 0, sub: `covers ${pct(pl)}`, key: favH ? 'H2' : 'A2' },
        total: { line: LT, val: `O/U ${lineTxt(LT)}`, p: over, push, gen: !(g.total > 0) },
        ctx: [['Goes to overtime', ot], ['A shutout (either side)', sh]],
      };
    }
    const pD = SB.p1(g, 'D'), o25 = SB.p1(g, 'O2.5');
    return {
      kind: 'soccer', pH, pA, pD, fav, dog, favH, pFav: favH ? pH : pA,
      draw: { val: fair(pD), p: pD },
      total: { line: 2.5, val: 'O/U 2.5', p: o25, gen: false },
      ctx: [['Both teams score', SB.p1(g, 'BTTS')], [`${fav} win by 2+`, SB.p1(g, favH ? 'H2' : 'A2')]],
    };
  }

  // ---------- evidence: Team Trends (trends.json) ----------
  let TR = null, TR_ST = 'idle', TRIDX = null;
  function needTrends() {
    if (TR_ST !== 'idle') return;
    TR_ST = 'loading';
    fetch('trends.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(d => { if (d && Array.isArray(d.teams)) TR = d; TRIDX = null; TR_ST = 'done'; if (SB.tab === KEY) SB.render(); });  // a failed re-read keeps the last good copy
  }
  function trendIdx() {
    if (TRIDX) return TRIDX;
    TRIDX = new Map();
    for (const t of (TR && TR.teams) || []) { const n = t && t.next; if (!n || !n.gid || !n.lean) continue; if (!TRIDX.has(n.gid)) TRIDX.set(n.gid, []); TRIDX.get(n.gid).push(t); }
    return TRIDX;
  }
  const ofN = s => { const m = /won \d+ of (\d+)/.exec(s) || /: (\d+) of (\d+)/.exec(s); return m ? +(m[2] || m[1]) : 0; };
  // games behind the reasons: per team the largest count (its season and last-30-day lines share games), summed over the teams
  const sampleN = why => { const by = new Map(); for (const w of why) { const k = (/^(.*?) (?:as an? |in the last )/.exec(w) || [, w])[1]; by.set(k, Math.max(by.get(k) || 0, ofN(w))); } let n = 0; for (const v of by.values()) n += v; return n; };
  const NK = s => String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // a trends.json team really is the side its "home" flag says (abbreviation, or the opponent when the abbreviation is missing);
  // anything else (a stale or mismatched entry, swapped sides) is dropped rather than shown as a lean
  function sideOk(t, g) {
    const n = t.next, me = g[n.home ? 'home' : 'away'], op = g[n.home ? 'away' : 'home'];
    if (t.abbr) return String(t.abbr).toUpperCase() === String(me.abbr).toUpperCase();
    return (n.oppAbbr && String(n.oppAbbr).toUpperCase() === String(op.abbr).toUpperCase()) || (!!n.opp && NK(n.opp) === NK(op.name)) || (!!t.name && NK(t.name) === NK(me.name));
  }
  function trendLeans(g, M) {
    const T = (trendIdx().get(g.id) || []).filter(t => sideOk(t, g)); if (!T.length) return [];
    const out = [];
    const up = T.filter(t => t.next.lean.upset && t.next.lean.upset.flag);
    if (up.length) {
      const dogT = up.find(t => t.next.lean.upset.role === 'underdog'), favT = up.find(t => t.next.lean.upset.role === 'favourite');
      const dogHome = dogT ? !!dogT.next.home : favT ? !favT.next.home : null;
      // the flag was made with the morning's prices: if the "underdog" is now the model's favourite (or level), there is no upset to watch
      const stillDog = dogHome != null && (!M || (dogHome ? M.pH < M.pA : M.pA < M.pH));
      if (stillDog) {
        const side = dogHome ? 'H' : 'A', team = g[dogHome ? 'home' : 'away'];
        const why = [...new Set(up.flatMap(t => t.next.lean.upset.why || []).map(String))];
        const n = sampleN(why), small = why.some(w => /small sample/.test(w)), chance = why.some(w => /could be chance/.test(w));
        const st = +((dogT || favT).next.lean.upset.strength || 0);
        if (M) why.push(`The model gives ${team.name} ${pct(dogHome ? M.pH : M.pA)} to win${M.pD ? ` (draw ${pct(M.pD)})` : ''}: the prices already lean the other way, and most underdogs on this list still lose.`);
        out.push({ src: 'trends', tile: 'money', kicker: ['Team Trends', 'Upset watch', 'Moneyline'], title: `${team.abbr} to win`, sub: `${team.name}, the underdog${M ? ` (model ${pct(dogHome ? M.pH : M.pA)})` : ''}, has beaten its prices`, big: (st >= 0 ? '+' : MINUS) + Math.abs(st).toFixed(1), bigSub: 'wins vs prices', why, tag: `${n} games${small ? ' · small sample' : ''}${chance ? ' · could be chance' : ''}`, side });
      }
    }
    const tl = T.map(t => t.next.lean.total).find(x => x && (x.side === 'over' || x.side === 'under'));
    if (tl) {
      const tog = (tl.why || []).map(String).find(w => /^Together:/.test(w)) || '', m = /\((\d+)%\)/.exec(tog);
      const rate = m ? (tl.side === 'over' ? +m[1] : 100 - +m[1]) : null;
      const line = g.sport === 'soccer' ? '2.5 goals' : (T.map(t => t.next.line).find(x => num(+x) && +x > 0) || null);
      const why = (tl.why || []).map(String);
      if (M && g.sport === 'soccer') why.push(`The model prices ${tl.side} 2.5 goals at ${pct(tl.side === 'over' ? M.total.p : 1 - M.total.p)}.`);
      out.push({ src: 'trends', tile: 'total', kicker: ['Team Trends', `${tl.side === 'over' ? 'Over' : 'Under'} lean`, 'Total'], title: `${tl.side === 'over' ? 'Over' : 'Under'} ${line != null ? line : 'the total'}`, sub: `${g.home.name} and ${g.away.name} games${M && g.sport === 'soccer' ? ` · model ${tl.side} ${pct(tl.side === 'over' ? M.total.p : 1 - M.total.p)}` : ''}`,
        big: rate != null ? rate + '%' : '—', bigSub: `${tl.side} in ${tl.n} games`, why, tag: `${tl.n} games${tl.n < 20 ? ' · small sample' : ''}${why.some(w => /could be chance/.test(w)) ? ' · could be chance' : ''}` });
    }
    return out;
  }
  // ---------- evidence: Polymarket vs the feed (window.__sharp, sharp.js) ----------
  // A lean needs the Sharp Board's strong signal: the side itself priced 3+ points higher on Polymarket than at the books, a
  // two-sided quote no wider than 12¢, $10k+ traded on that moneyline, and not a likely data problem (15+ points apart).
  // A thin or wide market is mentioned under "No lean" instead, never shown as one.
  const SH = () => window.__sharp || null;
  const pmOf = g => { const S = SH(); try { return S && S.forGame ? S.forGame(g.id) : null; } catch (e) { return null; } };
  const tStamp = s => { const t = Date.parse(s || ''); return isFinite(t) ? `${wFmt.format(new Date(t))} ${tFmt.format(new Date(t))} PT` : 'an unknown time'; };
  function pmLean(g) {
    const S = SH(), c = pmOf(g), GAP = (S && S.GAP) || 0.03;
    if (!c || !c.strong || c.odd || !c.lead || !(c.lead.gap >= GAP - 1e-12)) return null;
    const L = c.lead, why = c.sides.map(s => `${s.name}: Polymarket ${pct(s.pm)} · books ${pct(s.book)}`);
    why.push(`${money(c.vol)} traded on Polymarket's moneyline. Polymarket's price is from ${tStamp(S.PM && S.PM.updated)}, the books' from ${tStamp(SB.DATA && SB.DATA.updated)}: some of a gap can be news in between.`);
    why.push('Two markets disagreeing is not a guaranteed edge: either can be wrong.');
    const gp = (Math.round(L.gap * 1000) / 10).toFixed(1);
    return { src: 'pm', tile: L.side === 'D' ? 'draw' : 'money', kicker: ['Polymarket', 'Moneyline', 'Strong signal'], title: L.side === 'D' ? 'Draw' : `${L.abbr} to win`,
      sub: `Polymarket ${gp} pts higher on ${L.side === 'D' ? 'the draw' : L.name}: ${pct(L.pm)} vs ${pct(L.book)} at the books`,
      big: '+' + gp, bigSub: 'pts vs books', why, tag: `${money(c.vol)} traded`, side: L.side, gid: g.id };
  }
  // what Polymarket says when it is not a lean (shown in the "No lean" band)
  function pmQuiet(g) {
    const c = pmOf(g); if (!c) return '';
    const p = (Math.round(c.gap * 1000) / 10).toFixed(1);
    if (c.odd) return `Polymarket is ${p} pts away from the books here, which looks like a data problem (an old price or a mismatched game), so it is not used.`;
    if (c.gap < 0.03) return `Polymarket agrees: within ${p} pts of the books.`;
    return `Polymarket is ${p} pts away from the books, but ${!c.live ? 'its quote is too wide to read' : `on a thin market (${money(c.vol)} traded)`}, so that is not enough for a lean.`;
  }

  // ---------- key props: the likeliest player legs of the game ----------
  let PBY = null, PBYD = null;
  function playersOf(gid) {
    if (PBYD !== SB.DATA) { PBYD = SB.DATA; PBY = new Map(); for (const p of (SB.DATA && SB.DATA.players) || []) { if (!p || !p.gid) continue; if (!PBY.has(p.gid)) PBY.set(p.gid, []); PBY.get(p.gid).push(p); } }
    return PBY.get(gid) || [];
  }
  function keyProps(g) {
    const best = [];
    for (const pl of playersOf(g.id)) {
      if (!pl || /^(out|doubtful|inactive)$/i.test(pl.status || '') || !E.LADDER[pl.stat]) continue;
      let legs; try { legs = E.playerLegs(pl); } catch (e) { legs = []; }
      let b = null; for (const L of legs) if (!b || L.p > b.p) b = L;
      if (b) best.push({ pl, key: b.key, thr: b.thr, p: b.p, score: b.p + ((E.STAT_PREF || {})[pl.stat] || 0) });
    }
    best.sort((a, b) => b.score - a.score || b.p - a.p);
    const seen = new Set(), out = [];
    for (const x of best) { const k = E.nameKey(x.pl.name); if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length === 3) break; }
    return out.sort((a, b) => b.p - a.p);
  }

  // ---------- page ----------
  const st = { day: null, sport: store.get('slate.sport', 'all'), focus: null, jump: null, miss: '' };
  if (!['all', ...SPORDER].includes(st.sport)) st.sport = 'all';
  let lastParams = null;
  function days() {
    const today = E.dayOf(Date.now()), tom = E.nextDay(today), by = new Map();
    for (const g of (SB.DATA && SB.DATA.games) || []) { if (!SB.openG(g)) continue; const d = E.dayOf(SB.startMs(g)); if (d < today) continue; by.set(d, (by.get(d) || 0) + 1); }
    const list = [{ k: today, label: 'Today', n: by.get(today) || 0 }, { k: tom, label: 'Tomorrow', n: by.get(tom) || 0 }];
    for (const d of [...by.keys()].sort()) if (d !== today && d !== tom && list.length < 9) list.push({ k: d, label: dayLabel(d).replace(/,.*/, '') + ' ' + d.slice(8).replace(/^0/, ''), n: by.get(d) });
    return list;
  }
  const team = (t, big) => U.team(t.abbr, big);
  function tilesHTML(g, M, hl) {
    const tile = (lbl, val, sub, on) => `<div class="sl-tile${on ? ' sl-hl' : ''}"><span class="ui-lbl">${esc(lbl)}</span><b>${esc(val)}</b><small>${esc(sub)}</small></div>`;
    const dogP = M.favH ? M.pA : M.pH;
    const moneyT = tile('Money', `${M.fav} ${fair(M.pFav)}`, `${M.dog} ${fair(dogP)} · fair`, hl.money);
    const tot = M.total, totSub = `over ${pct(tot.p)}${tot.push >= 0.005 ? ` · push ${pct(tot.push)}` : ''}${tot.gen ? ' · league avg' : ''}`;
    const totalT = tile('Total', lineTxt(tot.line), totSub, hl.total);
    if (M.kind === 'soccer') return `<div class="sl-tiles">${moneyT}${tile('Draw', M.draw.val, `${pct(M.pD)} · fair`, hl.draw)}${totalT}</div>`;
    return `<div class="sl-tiles">${tile(M.spread.label, M.spread.val, M.spread.sub, hl.spread)}${moneyT}${totalT}</div>`;
  }
  // free plan: odds only, so no leans (they are picks)
  const picksLocked = () => !!(SB.paywall && !SB.paywall.can('picks'));
  function leanHTML(L) {
    return `<div class="sl-lean" data-sl-lean="${esc(L.src)}"><div class="sl-lk">${esc(L.kicker.join(' · '))}</div><div class="sl-lt">${esc(L.title)}${L.sub ? `<span class="sl-ls">${esc(L.sub)}</span>` : ''}</div>
      <div class="sl-big">${esc(L.big)}<small>${esc(L.bigSub)}</small></div>
      <details class="sl-why"><summary>Why <span class="sl-tg">${esc(L.tag)}</span></summary><ul>${L.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>${L.src === 'pm' ? `<button type="button" class="ui-link" data-sl-sharp="${esc(L.gid)}">Open on the Sharp Board ›</button>` : ''}</details></div>`;
  }
  function card(g, ev) {
    const M = modelOf(g), H = g.home, A = g.away, ms = SB.startMs(g), soc = g.sport === 'soccer';
    const leans = ev.get(g.id) || [];
    const hl = { money: leans.some(l => l.tile === 'money'), draw: leans.some(l => l.tile === 'draw'), total: leans.some(l => l.tile === 'total'), spread: false };
    const side = (t, p, home) => `<div class="sl-side">${team(t, true)}<div class="sl-nm">${esc(t.name)}</div><div class="sl-ab">${home ? 'home' : 'away'}</div>${M ? `<div class="sl-wp">${esc(pct(p).replace('%', ''))}<small>%</small></div><div class="sl-ab">win chance</div>` : ''}</div>`;
    const tp = tFmt.formatToParts(new Date(ms)), tm = [tp.filter(x => x.type !== 'dayPeriod').map(x => x.value).join('').trim(), (tp.find(x => x.type === 'dayPeriod') || {}).value || ''];
    let body;
    if (!SB.openG(g)) body = `<div class="sl-lean sl-none"><div class="sl-lk">${SB.isFinal(g) ? 'Final' : 'Started'}</div><div class="sl-lt">${SB.isFinal(g) && g.score ? esc(`${A.abbr} ${g.score.away} – ${g.score.home} ${H.abbr}`) : 'This game has started, so there are no pre-game lines here.'}</div></div>`;
    else if (!M) body = `<div class="sl-lean sl-none"><div class="sl-lk">No prices yet</div><div class="sl-lt">No sportsbook prices in the feed for this game yet, so there are no model lines.</div></div>`;
    else {
      const wb = `<div class="sl-wbar" role="img" aria-label="${esc(`Model win chances: ${A.name} ${pct(M.pA)}${M.pD ? `, draw ${pct(M.pD)}` : ''}, ${H.name} ${pct(M.pH)}`)}"><i style="width:${(M.pA * 100).toFixed(1)}%;--h:${U.hue(A.abbr)}"></i>${M.pD ? `<i class="sl-wd" style="width:${(M.pD * 100).toFixed(1)}%"></i>` : ''}<i style="width:${(M.pH * 100).toFixed(1)}%;--h:${U.hue(H.abbr)}"></i></div>`;
      const pq = leans.some(l => l.src === 'pm') ? '' : pmQuiet(g);   // Polymarket's word when it is not a lean
      const lean = picksLocked() ? `<div class="sl-lean sl-none" data-sl-lean="locked"><div class="sl-lk">Leans 🔒</div><div class="sl-lt">Leans are part of the paid plans</div><p>Free shows the odds and win chances. The model's leans, picks and generated parlays come with Betting + Fantasy.</p><button type="button" class="ui-link" data-gotab="plans">See plans ›</button></div>`
        : leans.length ? leans.map(leanHTML).join('') + (pq ? `<p class="sl-pmx" data-sl-pmq>${esc(pq)}</p>` : '') : `<div class="sl-lean sl-none" data-sl-lean="none"><div class="sl-lk">No lean</div><div class="sl-lt">No lean: the model is priced from the market</div><p>Our chances come from the sportsbook prices in the feed, so on its own the model never disagrees with them. A lean shows only when Team Trends or Polymarket give a reason.</p>${pq ? `<p class="sl-pmq" data-sl-pmq>${esc(pq)}</p>` : ''}</div>`;
      const ctx = `<div class="sl-ctx">${M.ctx.map(([l, p]) => `<div class="sl-r"><span>${esc(l)}</span><span class="sl-bar"><i style="width:${clamp(p * 100, 0, 100).toFixed(1)}%"></i></span><b>${esc(pct(p))}</b></div>`).join('')}</div>`;
      body = wb + lean + tilesHTML(g, M, hl) + ctx;
    }
    const kp = SB.openG(g) ? keyProps(g) : [];   // no + Slip on a game that has started
    const props = `<div class="sl-props"><div class="ui-lbl">Key props · likeliest legs</div>${kp.length ? kp.map(x => {
      const inS = SB.inSlip(g.id, x.key);
      return `<div class="sl-prop">${U.team(x.pl.team)}<div class="sl-pn"><b>${esc(x.pl.name)}</b><span>${esc(x.thr)}+ ${esc(E.STATN[x.pl.stat] || x.pl.stat)}${x.pl.est ? ' · season avg' : ''}</span></div><div class="sl-pc"><b>${esc(pct(x.p))}</b><span>${esc(fair(x.p))}</span></div><button type="button" class="ui-ghost sm sl-add${inS ? ' sl-on' : ''}" data-sl-add="${esc(g.id + '|' + x.key)}" aria-pressed="${inS}" aria-label="${esc(`${inS ? 'Remove from' : 'Add to'} slip: ${x.pl.name} ${x.thr}+ ${E.STATN[x.pl.stat] || x.pl.stat}`)}">${inS ? '✓ Slip' : '+ Slip'}</button></div>`;
    }).join('') : `<p class="ui-note">${SB.openG(g) ? 'No player lines for this game yet.' : 'No player legs once a game has started.'}</p>`}</div>`;
    const q = `Break down ${A.name} at ${H.name}`;
    const acts = `<div class="sl-acts"><button type="button" class="ui-cta sm" data-sl-deep="${esc(g.id)}">Deep dive</button><button type="button" class="ui-ghost sm" data-sl-sim="${esc(g.id)}">Simulate</button><button type="button" class="ui-ghost sm" data-sl-ask="${esc(q)}">Ask</button></div>`;
    return `<article class="sl-card${st.focus === g.id ? ' sl-focus' : ''}"${st.focus === g.id ? ' tabindex="-1"' : ''} id="sl-${esc(g.id)}" data-sl-gid="${esc(g.id)}" data-sport="${esc(g.sport)}" style="--ha:${U.hue(A.abbr)};--hh:${U.hue(H.abbr)}">
      <div class="sl-top">${side(A, M && M.pA, false)}<div class="sl-mid"><div class="sl-k">${esc(g.comp || SPN[g.sport])}</div><div class="sl-t">${esc(tm[0])}<small>${esc(tm[1] || '')}</small></div><div class="sl-k">${esc(wFmt.format(new Date(ms)))} · PT</div>${M && soc ? `<div class="sl-dr">Draw <b>${esc(pct(M.pD))}</b></div>` : ''}</div>${side(H, M && M.pH, true)}</div>
      ${body}${props}${acts}</article>`;
  }

  function render(main, params) {
    params = params || {};
    needTrends();
    const S = SH(); if (S && S.state === 'idle' && S.load) S.load().then(() => { if (SB.tab === KEY) SB.render(); });
    if (params !== lastParams) {
      lastParams = params; st.miss = '';
      const g = params.gid && SB.gameById(params.gid);
      // {gid}: that game's day, its card highlighted; the scroll is repeated until Team Trends and Polymarket have loaded
      // (their lean bands change the height of the cards above it)
      if (g) { st.day = E.dayOf(SB.startMs(g)); if (st.sport !== 'all' && st.sport !== g.sport) st.sport = 'all'; st.focus = g.id; st.jump = g.id; }
      else if (params.gid) { st.focus = st.jump = null; st.miss = 'That game is not in the feed any more, so here is the slate.'; }
    }
    const D = days();
    if (!st.day || !D.some(d => d.k === st.day)) st.day = (D.find(d => d.n > 0) || D[0]).k;
    const all = E.dayGames(st.day);
    if (st.focus && !all.some(g => g.id === st.focus)) { const g = SB.gameById(st.focus); if (g) all.push(g); }  // a game that has started still shows when asked for
    const sports = SPORDER.filter(s => all.some(g => g.sport === s));
    if (st.sport !== 'all' && !sports.includes(st.sport)) st.sport = 'all';
    const list = all.filter(g => st.sport === 'all' || g.sport === st.sport);
    // evidence per game (only when its source has loaded)
    const ev = new Map();
    if (!picksLocked()) for (const g of list) { const M = modelOf(g); if (!M) continue; const L = [...(TR ? trendLeans(g, M) : [])]; const p = pmLean(g); if (p) L.unshift(p); if (L.length) ev.set(g.id, L); }
    const priced = list.filter(g => modelOf(g)).length, loadingEv = (TR_ST !== 'done' && !TR) || !S || (S.state !== 'done' && !S.PM);
    const jump = st.jump; if (!loadingEv) st.jump = null;
    const dayName = D.find(d => d.k === st.day) || { label: dayLabel(st.day) };
    main.innerHTML = `<div class="ui-page sl-root">
      ${U.page({ kicker: 'Games · the slate', title: 'Every matchup,', accent: 'by the numbers', sub: 'Win chances, fair lines and the likeliest player legs for each game on the board. Every number is a model estimate built from the sportsbook prices in our feed.' })}
      <div class="sl-bar"><div class="sl-scroll">${U.pills(D.map(d => ({ k: d.k, label: d.label, n: d.n })), st.day, 'sl-day')}</div>
        <div class="sl-scroll">${U.pills([{ k: 'all', label: 'All', n: all.length }, ...sports.map(s => ({ k: s, label: SPN[s], n: all.filter(g => g.sport === s).length }))], st.sport, 'sl-sport')}</div></div>
      ${st.miss ? `<p class="ui-note" role="status">${esc(st.miss)}</p>` : ''}
      <p class="ui-muted sl-sum">${esc(`${list.length} game${list.length === 1 ? '' : 's'} on ${dayLabel(st.day)} · ${priced} with sportsbook prices ${picksLocked() ? '' : ` · ${ev.size} with a lean backed by evidence${loadingEv ? ' (still checking Team Trends and Polymarket)' : ''}`}`)}</p>
      ${list.length ? `<div class="sl-grid">${list.map(g => card(g, ev)).join('')}</div>` : U.empty(`No games left on ${dayName.label === 'Today' ? 'today’s' : dayLabel(st.day) + '’s'} board${st.sport !== 'all' ? ' for ' + SPN[st.sport] : ''}. Pick another day above.`)}
      <p class="ui-note">How these are made: each game's model is fitted to the sportsbook win chances in our feed, so the model's favourite is the market's favourite. Spread is the model's fair line (its average margin rounded to the half point), not a book's posted line. When the feed has no game total, NBA, football and NHL totals sit on a league average and the tile says so. Fair odds are what a chance is worth, not a price you can bet: bet only at that price or better. A lean needs outside evidence: a Team Trends flag (past results, with its sample) or a Polymarket price 3+ points higher than the books on a market with $10k+ traded and a two-sided quote. Past patterns and market gaps are not guarantees.</p>
    </div>`;
    const root = main.querySelector('.sl-root');
    root.addEventListener('click', onClick);
    if (jump) requestAnimationFrame(() => { const el = document.getElementById('sl-' + jump); if (el) { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); } });
  }
  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const pill = t.dataset.uiPill;
    if (pill) {
      const [n, k] = pill.split('|');
      if (n === 'sl-day') { st.day = k; st.focus = st.jump = null; st.miss = ''; }
      else if (n === 'sl-sport') { st.sport = k; store.set('slate.sport', k); }
      else return;
      SB.render();
      const nb = document.querySelector(`[data-ui-pill="${CSS.escape(pill)}"]`); if (nb) nb.focus();
      return;
    }
    if (t.dataset.slAdd) {
      const [gid, ...rest] = t.dataset.slAdd.split('|'); SB.toggleLeg(gid, rest.join('|')); syncSlip(); return;
    }
    if (t.dataset.slDeep) { SB.openGame(t.dataset.slDeep); return; }
    if (t.dataset.slSim) { SB.goTab('sim', { gid: t.dataset.slSim }); return; }
    if (t.dataset.slAsk) { SB.goTab('ask', { q: t.dataset.slAsk }); return; }
    if (t.dataset.slSharp) { SB.goTab('sharp', { gid: t.dataset.slSharp }); }
  }
  function syncSlip() {
    if (SB.tab !== KEY) return;
    for (const b of document.querySelectorAll('#main [data-sl-add]')) {
      const [gid, ...rest] = b.dataset.slAdd.split('|'), on = SB.inSlip(gid, rest.join('|'));
      b.classList.toggle('sl-on', on); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '✓ Slip' : '+ Slip';
      b.setAttribute('aria-label', b.getAttribute('aria-label').replace(/^(Add to|Remove from)/, on ? 'Remove from' : 'Add to'));
    }
  }

  const css = document.createElement('style');
  css.id = 'slate-css';
  css.textContent = `
.sl-root .sl-bar{display:flex;flex-direction:column;gap:8px;min-width:0}
.sl-root .sl-scroll{max-width:100%;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.sl-root .sl-scroll::-webkit-scrollbar{display:none}
.sl-root .sl-scroll .ui-pills{flex-wrap:nowrap;width:max-content;max-width:none}
.sl-root .sl-sum{margin:0}
.sl-root .sl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:16px;align-items:start}
.sl-card{position:relative;min-width:0;border:1px solid var(--hair2);border-radius:22px;overflow:hidden;scroll-margin-top:72px;
  background:radial-gradient(70% 55% at 0% 0%,hsl(var(--ha) 70% 45% / .2),transparent 70%),radial-gradient(70% 55% at 100% 0%,hsl(var(--hh) 70% 45% / .2),transparent 70%),#080d19}
.sl-card.sl-focus{border-color:rgba(var(--acc-rgb),.75);box-shadow:0 0 0 1px rgba(var(--acc-rgb),.5),0 0 60px -24px rgba(var(--acc-rgb),.8)}
.sl-top{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:start;padding:18px 14px 12px}
.sl-side{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;min-width:0}
.sl-side .ui-team{margin-bottom:4px}
.sl-side .sl-nm{font:700 15px/1.2 'Rubik',sans-serif;overflow-wrap:anywhere}
.sl-side .sl-ab{font:500 10.5px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80}
.sl-side .sl-wp{margin-top:6px;font:900 italic 28px/1 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.sl-side .sl-wp small{font-size:.5em;margin-left:1px}
.sl-mid{display:flex;flex-direction:column;align-items:center;gap:5px;padding-top:8px;text-align:center}
.sl-mid .sl-k{font:500 10px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff99;max-width:110px;overflow-wrap:anywhere}
.sl-mid .sl-t{font:900 italic 30px/1 'Rubik',sans-serif;white-space:nowrap;letter-spacing:-.01em}
.sl-mid .sl-t small{font-size:.45em;margin-left:3px;font-style:normal;font-weight:700}
.sl-mid .sl-dr{margin-top:6px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.07);font:600 12px var(--fui);color:#ffffffbf}
.sl-wbar{display:flex;gap:2px;height:7px;margin:0 16px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.06)}
.sl-wbar i{display:block;height:100%;background:hsl(var(--h) 75% 58%)}.sl-wbar i.sl-wd{background:rgba(255,255,255,.28)}
.sl-lean{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;margin:14px 14px 0;padding:14px 16px;border-radius:18px;border:1px solid rgba(255,184,0,.55);
  background:radial-gradient(120% 160% at 100% 50%,rgba(255,184,0,.18),rgba(255,184,0,.03) 62%),rgba(8,13,25,.55)}
.sl-lean+.sl-lean{margin-top:8px}
.sl-lean .sl-lk{grid-column:1/-1;display:flex;align-items:center;gap:7px;font:600 10.5px var(--fmono);letter-spacing:.15em;text-transform:uppercase;color:var(--mid)}
.sl-lean .sl-lk::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.sl-lean .sl-lt{font:700 24px/1.1 'Rubik',sans-serif;min-width:0;overflow-wrap:anywhere}
.sl-lean .sl-ls{display:block;margin-top:5px;font:500 12.5px/1.4 var(--fui);color:#ffffffb3}
.sl-card:focus{outline:none}
.sl-lean .sl-big{font:900 italic 34px/1 'Rubik',sans-serif;color:var(--mid);white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.sl-lean .sl-big small{display:block;margin-top:3px;font:600 9.5px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff99;font-style:normal}
.sl-lean .sl-why{grid-column:1/-1;margin-top:4px}
.sl-lean .sl-why summary{display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer;font:600 13px var(--fui);color:#ffffffcc;list-style:none}
.sl-lean .sl-why summary::-webkit-details-marker{display:none}
.sl-lean .sl-why summary::after{content:"›";font:600 18px var(--fui);color:#ffffff80;transition:transform .15s}
.sl-lean .sl-why[open] summary::after{transform:rotate(90deg)}
.sl-lean .sl-tg{padding:2px 8px;border-radius:999px;background:rgba(255,184,0,.14);color:var(--mid);font:700 11px var(--fui)}
.sl-lean ul{margin:0 0 6px;padding-left:18px;font:400 12.5px/1.45 var(--fui);color:#ffffffbf}.sl-lean li{margin:3px 0}
.sl-lean.sl-none{display:block;border:1px dashed var(--hair2);background:rgba(255,255,255,.02)}
.sl-lean.sl-none .sl-lk{color:#ffffff80}.sl-lean.sl-none .sl-lt{font:600 15px/1.3 var(--fui);margin-top:6px}
.sl-lean.sl-none p{margin:6px 0 0;font:400 12.5px/1.45 var(--fui);color:#ffffff99}
.sl-lean.sl-none p.sl-pmq{color:#ffffffbf}
.sl-pmx{margin:8px 16px 0;font:400 12.5px/1.45 var(--fui);color:#ffffffa6}
.sl-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 14px 0}
.sl-tile{min-width:0;padding:10px 11px;border-radius:14px;border:1px solid var(--hair2);background:rgba(255,255,255,.03)}
.sl-tile .ui-lbl{display:block;margin-bottom:6px;font-size:9.5px}
.sl-tile b{display:block;font:700 17px/1.15 'Rubik',sans-serif;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sl-tile small{display:block;margin-top:4px;font:500 11.5px/1.3 var(--fui);color:#ffffffa6}
.sl-tile.sl-hl{border-color:rgba(255,184,0,.55);background:linear-gradient(180deg,rgba(255,184,0,.12),rgba(255,184,0,.02))}.sl-tile.sl-hl b{color:var(--mid)}
.sl-ctx{display:flex;flex-direction:column;gap:8px;margin:14px 16px 0}
.sl-ctx .sl-r{display:grid;grid-template-columns:minmax(0,1fr) minmax(60px,34%) 40px;gap:10px;align-items:center;font:500 13px var(--fui);color:#ffffffbf}
.sl-ctx .sl-bar{position:relative;height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
.sl-ctx .sl-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--acc2);box-shadow:0 0 10px rgba(var(--acc-rgb),.6)}
.sl-ctx b{text-align:right;font:700 13.5px var(--fui);font-variant-numeric:tabular-nums}
.sl-props{margin:14px 14px 0;padding-top:12px;border-top:1px solid var(--hair)}
.sl-props>.ui-lbl{margin-bottom:4px}
.sl-prop{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--hair)}
.sl-prop:last-child{border-bottom:0}
.sl-prop .ui-team{width:32px;height:32px;font-size:9.5px}
.sl-prop .sl-pn{min-width:0}.sl-prop .sl-pn b{display:block;font:600 14px var(--fui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl-prop .sl-pn span{display:block;font:500 12px var(--fui);color:#ffffffa6}
.sl-prop .sl-pc{text-align:right}.sl-prop .sl-pc b{display:block;font:900 italic 20px/1 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.sl-prop .sl-pc span{display:block;margin-top:2px;font:600 11px var(--fui);color:var(--acc2)}
.sl-prop .sl-add{min-width:76px;padding:0 12px}.sl-prop .sl-add.sl-on{border-color:rgba(var(--acc-rgb),.6);color:var(--acc2);background:rgba(var(--acc-rgb),.12)}
.sl-acts{display:flex;flex-wrap:wrap;gap:8px;padding:14px 14px 16px}
.sl-acts button{flex:1 1 auto}
@media(min-width:900px){.sl-top{padding:22px 18px 14px}.sl-mid .sl-t{font-size:34px}}
@media(max-width:420px){.sl-tiles{gap:6px}.sl-tile{padding:10px 9px}.sl-tile b{font-size:15.5px}.sl-lean .sl-big{font-size:30px}}
`;
  document.head.appendChild(css);

  SB.registerTab({ key: KEY, label: 'Games', render });
  SB.on && SB.on('data', () => { MODEL = new Map(); PBYD = null; TRIDX = null; if (TR_ST === 'done') TR_ST = 'idle'; });  // trends.json is re-read lazily after each feed refresh (the last copy stays meanwhile)
  SB.on && SB.on('slip', syncSlip);
  window.__slate = { modelOf, trendLeans, pmLean, keyProps, days, get trendsState() { return TR_ST; }, get state() { return st; } };
})();
