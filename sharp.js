// sharp.js: Sharp Board ('sharp'), docs/pro-interface.md screen 5. The reference compares the share of money with the share of
// bets on each side. We have no betting-split feed, so this board compares two real-money markets instead: Polymarket's price
// (the middle of its bid and ask, scaled so the sides add up to 100%) against the sportsbook consensus in our feed (game.prob),
// for every upcoming feed game matched to a polymarket.json game (window.__polymarket.matchOf, the Polymarket tab's matcher).
// Per game: the two markets as split bars, the gap in points, Polymarket volume and liquidity, the start time; the strongest
// signals first (gap of 3+ points on a market with $10k+ traded, two-sided quote) with a highlighted band. Margin sports also
// compare a Polymarket spread whose line equals the model's fair line. A gap is a disagreement between markets, not an edge.
// window.__sharp = {load, state, PM, rows(), forGame(gid)} also feeds the Games tab's lean band (slate.js).
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui) { console.warn('sharp.js: window.SB v2 API (with SB.ui) not found'); return; }
  const U = SB.ui, esc = U.esc, KEY = 'sharp';
  const GAP = 0.03, VOL = 10000, WIDE = 0.12;
  const num = x => typeof x === 'number' && isFinite(x);
  const pct = p => (num(p) ? Math.round(p * 100) + '%' : '—');
  const pts = x => (Math.round(Math.abs(x) * 1000) / 10).toFixed(1);
  const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) { /* private mode */ } } };
  const money = v => (!num(v) ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k' : '$' + Math.round(v));
  const SPN = { nba: 'NBA', nfl: 'NFL', ncaaf: 'College FB', nhl: 'NHL', soccer: 'Soccer' };
  const SPORDER = ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'];
  const TZ = 'America/Los_Angeles';
  const whenFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const when = ms => (num(ms) ? whenFmt.format(new Date(ms)) + ' PT' : '');
  const MINUS = '−', line = x => (x > 0 ? '+' : x < 0 ? MINUS : '') + Math.abs(x);

  // ---------- data: polymarket.json (the Polymarket tab's copy when it has one, else our own fetch) ----------
  let PM = null, LOAD = 'idle', WAIT = null, ROWS = null, ROWSD = null;
  function load() {
    if (WAIT) return WAIT;
    const P = window.__polymarket;
    if (P && P.LOAD === 'done') { PM = P.PM && Array.isArray(P.PM.games) ? P.PM : null; LOAD = 'done'; ROWS = null; return (WAIT = Promise.resolve()); }
    LOAD = 'loading';
    WAIT = fetch('polymarket.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(d => { PM = d && Array.isArray(d.games) ? d : null; LOAD = 'done'; ROWS = null; if (SB.tab === KEY) SB.render(); });
    return WAIT;
  }
  // fallback matcher (same sport, start within 6 hours, both abbreviations) when the Polymarket tab is not loaded
  function matchOwn(pg) {
    const t = Date.parse(pg.start);
    for (const g of (SB.DATA && SB.DATA.games) || []) {
      if (g.sport !== pg.sport || Math.abs(SB.startMs(g) - t) > 6 * 3600e3) continue;
      const a = (x, y) => String(x || '').toUpperCase() === String(y || '').toUpperCase();
      if (a(pg.home.abbr, g.home.abbr) && a(pg.away.abbr, g.away.abbr)) return { g, swap: false };
      if (a(pg.home.abbr, g.away.abbr) && a(pg.away.abbr, g.home.abbr)) return { g, swap: true };
    }
    return null;
  }
  const quoteOk = q => q && num(q.m) && q.m >= 0 && q.m <= 1;
  const liveQ = q => q && num(q.b) && num(q.a) && q.b > 0 && q.a < 1 && q.a > q.b && q.a - q.b <= WIDE;

  // the model's fair spread (same rule as the Games tab: mean home margin rounded to the half point) and its cover chance
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  const gt = (m, x) => { if (m.disc) { let s = 0; for (let i = 0; i < m.pm.length; i++) if (i - m.kmax > x) s += m.pm[i]; return s; } return 1 - Phi((x - m.mu) / m.sd); };
  function spreadCmp(pg, g, swap) {
    let m = null; try { m = SB.fit(g); } catch (e) { m = null; }
    if (!m || m.kind !== 'margin') return null;
    const L = Math.round(Math.abs(m.mu) * 2) / 2; if (!L) return null;
    const homeLine = m.mu >= 0 ? -L : L;
    for (const s of pg.spreads || []) {
      const ghl = swap ? -s.hl : s.hl; if (!num(ghl) || Math.abs(ghl - homeLine) > 1e-9) continue;
      const qh = swap ? s.away : s.home, qa = swap ? s.home : s.away; if (!quoteOk(qh) || !quoteOk(qa) || qh.m + qa.m <= 0) continue;
      const pmH = qh.m / (qh.m + qa.m), model = gt(m, -ghl);
      return { homeLine: ghl, pm: pmH, model, gap: pmH - model, v: s.v, live: liveQ(qh) && liveQ(qa) };
    }
    return null;
  }
  function compare(pg) {
    if (!pg || pg.stale || !pg.ml || !pg.home || !pg.away) return null;
    const P = window.__polymarket;
    let m = null; try { m = P && P.matchOf ? P.matchOf(pg) : matchOwn(pg); } catch (e) { m = null; }
    const g = m && m.g; if (!g || !SB.priced(g) || !g.prob) return null;
    const ml = pg.ml, qH = m.swap ? ml.away : ml.home, qA = m.swap ? ml.home : ml.away, qD = ml.draw || null;
    const soc = g.sport === 'soccer';
    if (!quoteOk(qH) || !quoteOk(qA) || (soc && !quoteOk(qD))) return null;
    const s = qH.m + qA.m + (soc ? qD.m : 0), b = g.prob, bs = (b.home || 0) + (b.away || 0) + (soc ? b.draw || 0 : 0);
    if (!(s > 0) || !(bs > 0)) return null;
    const sides = [
      { side: 'A', name: g.away.name, abbr: g.away.abbr, pm: qA.m / s, book: (b.away || 0) / bs, q: qA },
      ...(soc ? [{ side: 'D', name: 'Draw', abbr: 'Draw', pm: qD.m / s, book: (b.draw || 0) / bs, q: qD }] : []),
      { side: 'H', name: g.home.name, abbr: g.home.abbr, pm: qH.m / s, book: (b.home || 0) / bs, q: qH },
    ];
    for (const x of sides) x.gap = x.pm - x.book;
    const lead = sides.reduce((a, x) => (x.gap > a.gap ? x : a), sides[0]);
    const gap = Math.max(...sides.map(x => Math.abs(x.gap)));
    const live = sides.every(x => liveQ(x.q)), vol = num(ml.v) ? ml.v : num(pg.volume) ? pg.volume : 0;
    const wide = Math.max(...sides.map(x => (num(x.q.a) && num(x.q.b) ? x.q.a - x.q.b : 1)));
    const url = typeof pg.url === 'string' && /^https:\/\/polymarket\.com\//.test(pg.url) ? pg.url : null;
    return { pg, g, sides, gap, lead: lead.gap > 0 ? lead : null, live, wide, vol, evVol: num(pg.volume) ? pg.volume : null, liq: num(pg.liquidity) ? pg.liquidity : null,
      strong: live && gap >= GAP - 1e-12 && vol >= VOL, start: SB.startMs(g), url, spread: spreadCmp(pg, g, m.swap) };
  }
  function rows() {
    if (ROWS && ROWSD === SB.DATA) return ROWS;
    ROWSD = SB.DATA; const now = Date.now(), seen = new Map();
    for (const pg of (PM && PM.games) || []) {
      const t = Date.parse(pg && pg.start); if (!(t > now) || t - now > 10 * 864e5) continue;
      const c = compare(pg); if (!c) continue;
      const o = seen.get(c.g.id); if (!o || c.vol > o.vol) seen.set(c.g.id, c);  // one Polymarket event per game: the busiest
    }
    return (ROWS = [...seen.values()]);
  }
  const forGame = gid => (PM ? rows().find(c => c.g.id === gid) || null : null);

  // ---------- page ----------
  const st = { sport: 'all', sort: store.get('sharp.sort', 'gap'), show: store.get('sharp.show', 'all') };
  if (!['gap', 'time', 'vol'].includes(st.sort)) st.sort = 'gap';
  if (!['all', 'signals'].includes(st.show)) st.show = 'all';
  let lastParams = null;
  const sorters = {
    gap: (a, b) => (b.strong - a.strong) || (b.gap - a.gap) || (a.start - b.start),
    time: (a, b) => (a.start - b.start) || (b.gap - a.gap),
    vol: (a, b) => (b.vol - a.vol) || (b.gap - a.gap),
  };
  const sayLead = c => (c.lead ? `Polymarket ${pts(c.lead.gap)} pts higher on ${c.lead.side === 'D' ? 'the draw' : c.lead.name}` : 'The two markets agree');
  function splitHTML(c) {
    const A = c.sides.find(x => x.side === 'A'), H = c.sides.find(x => x.side === 'H'), D = c.sides.find(x => x.side === 'D');
    return U.split({ rows: [{ l: A.pm * 100, r: H.pm * 100, label: 'Polymarket' }, { l: A.book * 100, r: H.book * 100, label: 'Books' }] }) +
      (D ? `<div class="sh-draw"><span>Draw</span><span>Polymarket <b>${esc(pct(D.pm))}</b></span><span>Books <b>${esc(pct(D.book))}</b></span></div>` : '');
  }
  function teamsHTML(c, big) {
    const g = c.g;
    return `<div class="sh-teams${big ? ' sh-big' : ''}"><div class="sh-sd">${U.team(g.away.abbr, big)}<div><b>${esc(g.away.name)}</b><span>away</span></div></div>
      <div class="sh-mid"><span class="sh-k">${esc(g.comp || SPN[g.sport])}</span><span class="sh-t">${esc(when(c.start))}</span></div>
      <div class="sh-sd">${U.team(g.home.abbr, big)}<div><b>${esc(g.home.name)}</b><span>home</span></div></div></div>`;
  }
  function metaHTML(c) {
    const bits = [`${money(c.vol)} traded on the moneyline`];
    if (c.evVol != null) bits.push(`${money(c.evVol)} on the whole event`);
    if (c.liq != null) bits.push(`${money(c.liq)} liquidity`);
    bits.push(c.live ? `quote ${Math.round(c.wide * 100)}¢ wide` : 'wide quote: not a signal');
    return `<p class="sh-meta">${esc(bits.join(' · '))}</p>`;
  }
  function spreadHTML(c) {
    const s = c.spread; if (!s) return '';
    return `<div class="sh-spread"><span class="ui-lbl">Spread · ${esc(c.g.home.abbr)} ${esc(line(s.homeLine))}</span><span>Polymarket <b>${esc(pct(s.pm))}</b></span><span>Model <b>${esc(pct(s.model))}</b></span><span class="sh-gp">${esc((s.gap >= 0 ? '+' : MINUS) + pts(s.gap))} pts</span></div>`;
  }
  function cardHTML(c, focus) {
    const g = c.g, q = `Why do Polymarket and the sportsbooks disagree on ${g.away.name} at ${g.home.name}?`;
    return `<article class="sh-card${c.strong ? ' sh-strong' : ''}${focus ? ' sh-focus' : ''}" id="sh-${esc(g.id)}" data-sh-gid="${esc(g.id)}" data-sh-slug="${esc(c.pg.slug)}" data-sh-gap="${esc(pts(c.gap))}" data-sh-strong="${c.strong}">
      <div class="sh-hd"><span class="sh-k">${esc(SPN[g.sport] || g.sport)} · moneyline</span><span class="sh-gap${c.strong ? ' sh-gon' : c.gap >= GAP ? ' sh-gmid' : ''}">${esc(pts(c.gap))} pts gap</span></div>
      ${teamsHTML(c, false)}${splitHTML(c)}
      ${c.strong ? `<div class="sh-band"><span class="sh-k">Strong signal</span><b>${esc(sayLead(c))}</b></div>` : c.lead && c.gap >= GAP ? `<p class="sh-soft">${esc(sayLead(c))}${c.live ? ', on a thin market' : ', but the quote is too wide to read'}.</p>` : ''}
      ${spreadHTML(c)}${metaHTML(c)}
      <div class="sh-acts"><button type="button" class="ui-ghost sm" data-sh-slate="${esc(g.id)}">Game card</button><button type="button" class="ui-ghost sm" data-sh-deep="${esc(g.id)}">Deep dive</button><button type="button" class="ui-ghost sm" data-sh-ask="${esc(q)}">Ask</button>${c.url ? `<a class="ui-link sh-ext" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Polymarket ↗</a>` : ''}</div>
    </article>`;
  }
  function heroHTML(c) {
    const L = c.lead, nm = L.side === 'D' ? 'The draw' : L.name;
    return `<section class="sh-hero" data-sh-hero="${esc(c.g.id)}">${teamsHTML(c, true)}<div class="sh-hsplit">${splitHTML(c)}</div>
      <div class="sh-sig"><div class="ui-kick">Polymarket higher · moneyline · strong signal</div><div class="sh-tt">${esc(nm)}</div>
      <p>${esc(`Polymarket prices ${nm === 'The draw' ? 'the draw' : nm} at ${pct(L.pm)}, the books at ${pct(L.book)}: ${pts(L.gap)} points apart, with ${money(c.vol)} traded on Polymarket. A gap between two markets, not a sure thing.`)}</p></div></section>`;
  }
  function render(main, params) {
    params = params || {};
    let focus = null;
    if (params !== lastParams) { lastParams = params; if (params.gid) focus = String(params.gid); if (params.sport && (params.sport === 'all' || SPN[params.sport])) st.sport = params.sport; }
    if (LOAD === 'idle') load();
    const head = U.page({ kicker: 'Sharp board · market vs market', title: 'Polymarket vs', accent: 'the books', sub: 'Two real-money prices for every game we can match, side by side, with the biggest disagreements first.' });
    const note = `<div class="ui-card sh-note" role="note"><b>Not a betting split.</b> We have no ticket or money percentages, so nothing here shows where the bets or the big money are. Each game compares two real-money prices instead: Polymarket's (the middle of its bid and ask, scaled to add up to 100%) and the sportsbook consensus in our feed. A gap is a disagreement between markets, not a guaranteed edge: either one can be wrong, and the prices were taken at different times${PM && PM.updated ? ` (Polymarket ${esc(when(Date.parse(PM.updated)))}; the feed ${esc(when(Date.parse((SB.DATA && SB.DATA.updated) || '')))})` : ''}.</div>`;
    let body;
    if (!PM && LOAD !== 'done') body = U.empty('Loading Polymarket prices…');
    else if (!PM) body = U.empty('Polymarket prices are not available right now (polymarket.json did not load), so there is nothing to compare. The sportsbook side of every game is still on the Games tab.') + `<div class="ui-row"><button type="button" class="ui-cta sm" data-sh-games>Open Games</button></div>`;
    else {
      const R = rows();
      if (!R.length) body = U.empty('No upcoming game matched between Polymarket and our feed right now. Matching needs the same sport, a start within 6 hours and both teams.');
      else {
        const sports = SPORDER.filter(s => R.some(c => c.g.sport === s));
        if (st.sport !== 'all' && !sports.includes(st.sport)) st.sport = 'all';
        const inSport = R.filter(c => st.sport === 'all' || c.g.sport === st.sport);
        const strong = inSport.filter(c => c.strong).sort(sorters.gap);
        let list = (st.show === 'signals' ? inSport.filter(c => c.strong) : inSport).slice().sort(sorters[st.sort]);
        const top = strong[0] || null, big = inSport.slice().sort((a, b) => b.gap - a.gap)[0];
        const heroBlock = top ? heroHTML(top) : `<div class="ui-card sh-quiet"><div class="ui-kick">No strong signal right now</div><p>${esc(`No matched game has a gap of 3+ points on a Polymarket moneyline with $10k+ traded and a two-sided quote. The biggest gap is ${pts(big.gap)} points (${big.g.away.name} at ${big.g.home.name}, ${money(big.vol)} traded).`)}</p></div>`;
        body = `<div class="sh-ctl"><div class="sh-scroll">${U.pills([{ k: 'all', label: 'All', n: R.length }, ...sports.map(s => ({ k: s, label: SPN[s], n: R.filter(c => c.g.sport === s).length }))], st.sport, 'sh-sport')}</div>
          <div class="ui-row">${U.seg([{ k: 'gap', label: 'Gap' }, { k: 'time', label: 'Time' }, { k: 'vol', label: 'Volume' }], st.sort, 'sh-sort')}${U.seg([{ k: 'all', label: 'All' }, { k: 'signals', label: `Signals ${strong.length}` }], st.show, 'sh-show')}</div></div>
          ${heroBlock}
          <p class="ui-muted sh-sum">${esc(`${inSport.length} matched game${inSport.length === 1 ? '' : 's'} · ${strong.length} strong signal${strong.length === 1 ? '' : 's'} (gap 3+ pts, $10k+ traded) · ${inSport.filter(c => c.gap >= GAP).length} with a gap of 3+ pts`)}</p>
          ${list.length ? `<div class="sh-grid">${list.map(c => cardHTML(c, c.g.id === focus)).join('')}</div>` : U.empty('No strong signals for this filter. Switch to All to see every matched game.')}`;
      }
    }
    main.innerHTML = `<div class="ui-page sh-root">${head}${note}${body}<p class="ui-note">How to read it: the striped bar and the left / right numbers are the away and home team's chances in each market. "Books" is the sportsbook consensus in our feed, the same chances the Games tab's model is built on. A strong signal needs a 3+ point gap, a two-sided Polymarket quote no wider than 12¢ and $10k+ traded on that moneyline. Polymarket fees and the books' margin are not included.</p></div>`;
    const root = main.querySelector('.sh-root');
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-sh-games]')) e.target.click(); });
    if (focus) requestAnimationFrame(() => { const el = document.getElementById('sh-' + focus); if (el) el.scrollIntoView({ block: 'start' }); });
  }
  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const pill = t.dataset.uiPill || t.dataset.uiSeg;
    if (pill) {
      const [n, k] = pill.split('|');
      if (n === 'sh-sport') st.sport = k; else if (n === 'sh-sort') { st.sort = k; store.set('sharp.sort', k); } else if (n === 'sh-show') { st.show = k; store.set('sharp.show', k); } else return;
      SB.render();
      const sel = t.dataset.uiPill ? `[data-ui-pill="${CSS.escape(pill)}"]` : `[data-ui-seg="${CSS.escape(pill)}"]`, nb = document.querySelector(sel); if (nb) nb.focus();
      return;
    }
    if (t.dataset.shSlate) { SB.goTab('slate', { gid: t.dataset.shSlate }); return; }
    if (t.dataset.shDeep) { SB.openGame(t.dataset.shDeep); return; }
    if (t.dataset.shAsk) { SB.goTab('ask', { q: t.dataset.shAsk }); return; }
    if (t.hasAttribute('data-sh-games')) SB.goTab('slate', {});
  }

  const css = document.createElement('style');
  css.id = 'sharp-css';
  css.textContent = `
.sh-root .sh-note{border-color:rgba(255,184,0,.4);background:linear-gradient(90deg,rgba(255,184,0,.1),rgba(255,184,0,.02));font:400 13.5px/1.5 var(--fui);color:#ffffffcc}
.sh-root .sh-note b{color:var(--mid)}
.sh-root .sh-ctl{display:flex;flex-direction:column;gap:8px;min-width:0}
.sh-root .sh-scroll{max-width:100%;overflow-x:auto;scrollbar-width:none}.sh-root .sh-scroll::-webkit-scrollbar{display:none}
.sh-root .sh-scroll .ui-pills{flex-wrap:nowrap;width:max-content;max-width:none}
.sh-root .sh-sum{margin:0}
.sh-root .ui-seg button{min-height:40px}
.sh-root .sh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:16px;align-items:start}
.sh-card{min-width:0;padding:16px;border-radius:22px;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.012)),#080d19;scroll-margin-top:72px}
.sh-card.sh-strong{border-color:rgba(62,196,255,.55);box-shadow:0 0 0 1px rgba(62,196,255,.25),0 24px 60px -30px rgba(62,196,255,.7)}
.sh-card.sh-focus{border-color:rgba(var(--acc-rgb),.8)}
.sh-hd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sh-hd .sh-k{font:500 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff99}
.sh-hd .sh-gap{flex:none;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.07);font:700 12px var(--fui);color:#ffffffcc;font-variant-numeric:tabular-nums}
.sh-hd .sh-gap.sh-gmid{background:rgba(255,184,0,.14);color:var(--mid)}.sh-hd .sh-gap.sh-gon{background:rgba(62,196,255,.18);color:#7fdcff}
.sh-teams{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:start;margin:12px 0 4px}
.sh-teams .sh-sd{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;min-width:0}
.sh-teams .sh-sd>div{min-width:0}.sh-teams b{display:block;font:700 14px/1.2 'Rubik',sans-serif;overflow-wrap:anywhere}
.sh-teams .sh-sd>div span{display:block;font:500 10px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80}
.sh-teams .sh-mid{display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;max-width:110px;padding-top:6px}
.sh-teams .sh-mid .sh-k{font:500 9.5px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80;overflow-wrap:anywhere}
.sh-teams .sh-mid .sh-t{font:600 11.5px/1.25 var(--fui);color:#ffffffcc}
.sh-card .ui-split .pct{font-size:26px}
.sh-draw{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 14px;margin-top:10px;font:500 12.5px var(--fui);color:#ffffffa6}.sh-draw span:first-child{font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.sh-draw b{color:#fff}
.sh-band{margin-top:14px;padding:12px 14px;border-radius:14px;border:1px solid rgba(62,196,255,.45);background:linear-gradient(90deg,rgba(62,196,255,.16),rgba(62,196,255,.03))}
.sh-band .sh-k{display:flex;align-items:center;gap:7px;font:600 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#7fdcff}
.sh-band .sh-k::before{content:"";width:6px;height:6px;border-radius:50%;background:#2b7fff;box-shadow:0 0 8px #2b7fff}
.sh-band b{display:block;margin-top:4px;font:800 18px/1.2 'Rubik',sans-serif}
.sh-soft{margin:12px 0 0;font:500 13px/1.4 var(--fui);color:var(--mid)}
.sh-spread{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:12px;padding-top:10px;border-top:1px solid var(--hair);font:500 12.5px var(--fui);color:#ffffffa6}
.sh-spread b{color:#fff}.sh-spread .sh-gp{margin-left:auto;font-weight:700;color:#ffffffcc}
.sh-meta{margin:10px 0 0;font:500 12px/1.45 var(--fui);color:#ffffff8c}
.sh-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.sh-acts .ui-ghost{flex:1 1 auto}.sh-acts .sh-ext{padding:0 6px}
.sh-hero{position:relative;padding:20px 16px 22px;border-radius:24px;border:1px solid var(--hair2);overflow:hidden;
  background:radial-gradient(60% 70% at 100% 0%,rgba(0,212,146,.16),transparent 70%),radial-gradient(60% 70% at 0% 0%,rgba(62,196,255,.12),transparent 70%),#060b16}
.sh-hero .sh-teams.sh-big b{font-size:clamp(15px,3.6vw,24px)}
.sh-hero .sh-teams.sh-big .sh-mid .sh-t{font:500 11px var(--fmono);letter-spacing:.12em;text-transform:uppercase}
.sh-hero .sh-hsplit{max-width:760px;margin:10px auto 0}
.sh-hero .ui-split .pct{font-size:clamp(30px,7vw,56px)}
.sh-sig{margin-top:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
.sh-sig .ui-kick{justify-content:center;text-align:center}
.sh-sig .ui-kick::before{background:#2b7fff;box-shadow:0 0 8px #2b7fff}
.sh-sig .sh-tt{font:900 italic clamp(30px,7vw,60px)/1 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:-.015em;overflow-wrap:anywhere}
.sh-sig p{max-width:52ch;margin:0;font:400 14.5px/1.5 var(--fui);color:#ffffffbf}
.sh-quiet p{margin:8px 0 0;font:400 14px/1.5 var(--fui);color:#ffffffbf}
`;
  document.head.appendChild(css);

  SB.registerTab({ key: KEY, label: 'Sharp Board', render });
  SB.on && SB.on('data', () => { ROWS = null; if (LOAD === 'done') { LOAD = 'idle'; WAIT = null; } });  // polymarket.json is re-read lazily after each feed refresh
  window.__sharp = { load, rows, forGame, compare, get state() { return LOAD; }, get PM() { return PM; }, GAP, VOL };
})();
