// Chat (ask.js): the empty state, offline answers (prop card with verdict, game log and 4 factors; a 3-leg NBA parlay; a price
// that turns the verdict into an edge read), slip / navigation buttons, history across a reload, params, and Claude through a
// MOCKED `sample` capability (a page tool runs, its card renders, the text streams, model text is never HTML, errors handled).
// Review additions: the name matcher (hyphenated / shared surnames, first names, dotted initials), markets the app has no line
// for, the UTC log-date rule, under bars, the price-only verdict kicker, render time measured in the page, focus and the live
// region, and on the Claude side: a price or line only Claude wrote never reaches a card, the no-tools path sends cache:false,
// every error code, the tools limit, and New chat during a slow call.
// Breakdowns (2026-11-25): any player's season (player_stats), one game (review_player), a parlay leg by leg (review_parlay:
// the app's graded picks from a recs.json fixture with a miss and a near miss, typed legs, My Parlays), a team, leaders and the
// app's track record, offline and through the mocked capability; every number checked against the fixtures computed here;
// the "general knowledge" rule in the instructions turn; hostile names, titles, headlines and links in every new card.
import { open, check, done, FX } from './lib/harness.mjs';

const SEA = JSON.parse(FX('season-2026-11-23.json')), RECS = JSON.parse(FX('recs-askbd-2026-11-23.json')), TODAY = '2026-11-23';
const nameKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const f1 = x => (Math.round(x * 10) / 10).toFixed(1), mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], fmtD = d => `${MONS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
// one player's season the way the box scores give it: every entry of his name (a traded pro), logs up to today (UTC)
function sPl(sp, name) {
  const S = SEA.sports[sp], k = nameKey(name), ents = S.players.filter(p => nameKey(p.n) === k), fi = f => S.fields.indexOf(f);
  let gp = 0; const tot = S.fields.map(() => 0), rows = [];
  for (const e of ents) { gp += e.gp; e.tot.forEach((v, i) => { tot[i] += v; }); for (const r of e.log) if (r[0] <= TODAY) rows.push({ r, t: e.t }); }
  rows.sort((a, b) => a.r[0].localeCompare(b.r[0]));
  return { gp, tot, rows, T: f => tot[fi(f)], v: (row, f) => row.r[3 + fi(f)] };
}
const resOf = (sp, ab, d) => SEA.sports[sp].results[ab].find(r => r[0] === d);
function leadersOf(sp, f, pg, mg) {
  const S = SEA.sports[sp], fi = S.fields.indexOf(f), m = new Map();
  for (const p of S.players) { const k = sp === 'ncaaf' ? nameKey(p.n) + '|' + p.t : nameKey(p.n), e = m.get(k) || { n: p.n, gp: 0, v: 0 }; e.gp += p.gp; e.v += p.tot[fi]; m.set(k, e); }
  return [...m.values()].filter(e => e.gp >= (mg || 1) && e.gp > 0).map(e => ({ ...e, x: pg ? e.v / e.gp : e.v })).sort((a, b) => b.x - a.x || a.gp - b.gp || a.n.localeCompare(b.n));
}
const medGames = sp => { const L = Object.values(SEA.sports[sp].results).map(r => r.length).filter(Boolean).sort((a, b) => a - b); return L[Math.floor(L.length / 2)]; };

const settle = page => page.waitForFunction(() => window.__ask && !__ask.state.busy, null, { timeout: 30000 });
async function askQ(page, q) { await page.fill('.ask-input', q); await page.click('.ask-send'); await page.waitForTimeout(30); await settle(page); }
const lastA = page => page.evaluate(() => {
  const a = [...document.querySelectorAll('.ask-a')].pop(); if (!a) return null;
  const pcs = [...a.querySelectorAll('.ask-pc')].map(c => ({
    name: (c.querySelector('.ask-pc-nm b') || {}).textContent, market: (c.querySelector('.ask-pc-mk span') || {}).textContent,
    vTitle: (c.querySelector('.ui-verdict .t') || {}).textContent, vKick: (c.querySelector('.ui-verdict .k') || {}).textContent, vTag: (c.querySelector('.ui-verdict .tag') || {}).textContent,
    bars: c.querySelectorAll('.ui-log .b').length, logSum: (c.querySelector('.ui-loghead b') || {}).textContent,
    factors: [...c.querySelectorAll('.ui-factor summary b')].map(b => b.textContent), factorWhy: [...c.querySelectorAll('.ui-factor p')].map(p => p.textContent),
    tiles: Object.fromEntries([...c.querySelectorAll('.ui-tile')].map(t => [t.querySelector('.ui-lbl').textContent, t.querySelector('b').textContent])),
    btns: [...c.querySelectorAll('.ask-act button')].map(b => b.textContent) }));
  return { text: a.querySelector('.ask-text').textContent, note: (a.querySelector('.ask-note') || {}).textContent || '', err: (a.querySelector('.ask-err') || {}).textContent || '',
    pcs, legs: a.querySelectorAll('.ask-tc .leg').length, legText: [...a.querySelectorAll('.ask-tc .leg .legtxt b')].map(b => b.textContent), list: a.querySelectorAll('.ask-list .ask-lr').length };
});
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------- 1. offline (no window.claude): the harness page as served
{
  const { page, errors, browser } = await open({ width: 390, tab: 'ask' });
  await page.waitForSelector('.ask .ask-chip');
  const E0 = await page.evaluate(() => ({
    nav: (document.querySelector('#tabs [data-t="ask"]') || {}).textContent, tab: SB.tab, ms: SB.firstRender && SB.firstRender.ms,
    orb: !!document.querySelector('.ask-panel .ask-orb'), h: (document.querySelector('.ask-h') || {}).textContent, title: (document.querySelector('.ask .ui-title') || {}).textContent,
    chips: [...document.querySelectorAll('.ask-chip')].map(b => b.textContent), ph: document.querySelector('.ask-input').placeholder,
    scan: !!document.querySelector('[data-ask-scan]'), send: !!document.querySelector('.ask-send'), foot: document.querySelector('.ask-foot').textContent,
    tap: [...document.querySelectorAll('.ask-chip,.ask-send,.ask-scan')].every(b => b.getBoundingClientRect().height >= 40),
    names: SB.DATA.players.filter(p => p.stat === 'pts').map(p => p.name) }));
  check('the Chat tab is registered with the label Chat and opens', /Chat/.test(E0.nav || '') && E0.tab === 'ask', E0.nav);
  check('first render under 1,500 ms on the fixture slate', E0.ms < 1500, `${Math.round(E0.ms)} ms`);
  const RT0 = await page.evaluate(() => { SB.goTab('players'); const t0 = performance.now(); SB.goTab('ask'); return performance.now() - t0; });
  check('Chat render measured in the page (empty state, suggestions from the slate): under 1,500 ms', RT0 < 1500, `${Math.round(RT0)} ms`);
  check('suggestions are a labelled group of buttons (no list role without list items)', await page.evaluate(() => { const g = document.querySelector('.ask-chips'); return g.getAttribute('role') === 'group' && !!g.getAttribute('aria-label'); }));
  check('empty state: orb, "Ask Safe Bets", a display title', E0.orb && E0.h === 'Ask Safe Bets' && E0.title.length > 10, E0.title);
  check('4-5 suggestion chips built from the slate (a real NBA scorer named)', E0.chips.length >= 4 && E0.chips.length <= 5 && E0.chips.some(c => E0.names.some(n => c.includes(n))) && E0.chips.some(c => /3-leg parlay/.test(c)) && E0.chips.some(c => /Best props/.test(c)), JSON.stringify(E0.chips));
  check('composer: "Ask Safe Bets anything", round send button, Scan a slip', E0.ph === 'Ask Safe Bets anything' && E0.send && E0.scan);
  check('tap targets are 40px+', E0.tap);
  check('offline: says AI answers are not available in this view', /AI answers aren't available in this view/.test(E0.foot), E0.foot);
  check('no horizontal scroll at 390 (empty state)', await noHScroll(page));
  await page.setViewportSize({ width: 360, height: 740 });
  check('no horizontal scroll at 360 either (empty state)', await noHScroll(page));
  await page.setViewportSize({ width: 390, height: 844 });

  // a player question -> the prop card
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  let A = await lastA(page);
  const P = A.pcs[0] || {};
  check('player question -> a prop card (name, market)', A.pcs.length === 1 && P.name === 'Tyrese Maxey' && P.market === 'Over 24.5 points', JSON.stringify([P.name, P.market]));
  check('verdict without a price: model-chance read, tagged as a model estimate', ['Strong lean', 'Lean', 'Coin flip', 'Long shot'].includes(P.vTitle) && P.vTag === 'Model estimate' && !/your price/.test(P.vKick), `${P.vTitle} / ${P.vKick}`);
  check('without a price the verdict says the price it needs ("only at <fair> or better"), text too', P.vKick.includes(`only at ${P.tiles['Fair odds']} or better`) && /worth it only at [+-]\d+ or better/.test(A.text), P.vKick);
  const ch = parseInt(P.tiles['Model chance'], 10) / 100, rule = ch >= .7 ? 'Strong lean' : ch >= .58 ? 'Lean' : ch >= .45 ? 'Coin flip' : 'Long shot';
  check('the verdict follows the spec rule for the shown chance', Math.abs(ch - .7) < .006 || Math.abs(ch - .58) < .006 || Math.abs(ch - .45) < .006 || rule === P.vTitle, `${P.tiles['Model chance']} -> ${P.vTitle}`);
  check('game log of his recent games vs the line ("N of M over 24.5")', P.bars >= 3 && /^\d of \d over 24\.5$/.test(P.logSum || ''), `${P.bars} bars, ${P.logSum}`);
  check('4 factors: Matchup, Trends, Game script, Usage, each with a why', JSON.stringify(P.factors) === '["Matchup","Trends","Game script","Usage"]' && P.factorWhy.every(w => w.length > 20), JSON.stringify(P.factors));
  check('Trends says the sample is small', /small sample/.test(P.factorWhy[1] || ''), P.factorWhy[1]);
  check('fair odds and model chance on the card; buttons + Slip, Analyze, Ask a follow-up', /^[+-]\d+$/.test(P.tiles['Fair odds'] || '') && /%$/.test(P.tiles['Model chance'] || '') && JSON.stringify(P.btns) === '["+ Slip","Analyze","Ask a follow-up"]', JSON.stringify([P.tiles, P.btns]));
  check('offline: a templated sentence with the chance, and a quiet note', /Tyrese Maxey/.test(A.text) && /model chance/.test(A.text) && /AI answers aren't available in this view/.test(A.note), A.text.slice(0, 120));

  // the same bet at the viewer's price -> an edge read
  await askQ(page, 'Is Tyrese Maxey over 24.5 points at -110 a good bet?');
  A = await lastA(page); const Q = A.pcs[0] || {};
  const edge = parseFloat(String(Q.tiles && Q.tiles.Edge).replace('−', '-')), qch = parseInt(Q.tiles && Q.tiles['Model chance'], 10) / 100;
  const rule2 = edge >= 3 && qch >= .5 ? 'Take this bet' : edge >= 0 ? 'Lean' : 'Pass';
  check('a price in the question turns the verdict into an edge read', ['Take this bet', 'Lean', 'Pass'].includes(Q.vTitle) && /vs your price/.test(Q.vKick) && Q.tiles['Your price'] === '-110' && Q.tiles.Implied === '52%' && isFinite(edge), JSON.stringify([Q.vTitle, Q.vKick, Q.tiles]));
  check('the edge verdict follows the rule (3+ pts and 50%+ take, 0-3 lean, below 0 pass)', Q.vTitle === rule2 || Math.abs(edge) < .15 || Math.abs(edge - 3) < .15, `${edge} -> ${Q.vTitle}`);
  check('the text names the price and the edge', /-110/.test(A.text) && /edge/.test(A.text), A.text.slice(0, 160));

  // a 3-leg NBA parlay
  await askQ(page, 'build me a 3-leg NBA parlay');
  A = await lastA(page);
  check('"build me a 3-leg NBA parlay" -> a 3-leg parlay card (swap legs, 500,000 runs)', A.legs === 3 && A.legText.every(t => /points|rebounds|assists/.test(t)) && await page.evaluate(() => { const a = [...document.querySelectorAll('.ask-a')].pop(); return !!a.querySelector('[data-sim5]') && !!a.querySelector('.subbtn,[data-sub]'); }), JSON.stringify(A.legText));
  check('parlay text: joint chance, labelled as priced from the simulations', /joint chance/.test(A.text) && /simulations/.test(A.text), A.text.slice(0, 120));

  // best props, a TD question, a game, an unknown question
  await askQ(page, 'Best props tonight?');
  A = await lastA(page);
  check('"Best props tonight?" -> a ranked list card, no edge claimed', A.list >= 3 && /no book prices/.test(A.text), `${A.list} rows`);
  check('list names (tap for the full card) are 40px+ tap targets', await page.evaluate(() => [...document.querySelectorAll('.ask-a:last-child .ask-lname')].every(b => b.getBoundingClientRect().height >= 40)));
  check('screen readers hear "Answer ready." (live region filled after the redraw)', await page.waitForFunction(() => (document.querySelector('.ask-sr') || {}).textContent === 'Answer ready.', null, { timeout: 3000 }).then(() => true, () => false));
  await askQ(page, 'Should I take Chase Brown to score a TD?');
  A = await lastA(page);
  check('a TD question -> an Anytime TD card with "N of M with a TD"', A.pcs.length === 1 && A.pcs[0].market === 'Anytime TD' && /with a TD/.test(A.pcs[0].logSum || '') && A.pcs[0].factors.length === 4, JSON.stringify([A.pcs[0] && A.pcs[0].market, A.pcs[0] && A.pcs[0].logSum]));
  await askQ(page, 'What is the weather on Mars?');
  A = await lastA(page);
  check('an unknown question gets a plain "couldn\'t match" reply with examples, no card', /couldn't match/.test(A.text) && !A.pcs.length && !A.legs, A.text.slice(0, 80));

  // the name matcher and the markets the app has no line for (parseIntent on the fixture slate)
  const PI = await page.evaluate(() => { const f = q => { const I = __ask.parseIntent(q); return { kind: I.kind, name: I.e && I.e.name, stat: I.stat, line: I.line, missing: I.missing, amb: I.amb || '', td: I.tdNote || '', legs: I.legs && I.legs.map(L => [L.e.name, L.stat, L.line]), gid: I.gid }; };
    return { naw: f('Nickeil Alexander-Walker over 10.5 points'), sga: f('Gilgeous-Alexander over 30.5 points'), lebron: f('Is LeBron a good over?'), mitch: f('Is Mitchell over 22.5 points?'),
      lj: f('price a parlay: Maxey over 20.5 points and L.J. Phillips over 40.5 rushing yards'), td2: f('Will Chase Brown score 2 TDs?'), threes: f('Will Maxey make 4 threes?'), hou: f('How does Houston look tonight?'), smith: f('Is Smith over 50.5 receiving yards?'), off: f('Is Nickeil Alexander-Walker a good bet tonight?'), best: f('Best props tonight?') }; });
  check('a named player with no game is answered as such, not with a list of other props', PI.off.kind === 'seasononly' && PI.best.kind === 'top', JSON.stringify([PI.off.kind, PI.best.kind]));
  check('"Alexander-Walker" (not on the slate) is never read as Shai Gilgeous-Alexander', PI.naw.name !== 'Shai Gilgeous-Alexander' && PI.naw.kind !== 'prop', JSON.stringify(PI.naw));
  check('"Gilgeous-Alexander" alone finds him', PI.sga.name === 'Shai Gilgeous-Alexander' && PI.sga.line === 30.5, JSON.stringify(PI.sga));
  check('a first name only one slate player has ("LeBron") finds him', PI.lebron.kind === 'prop' && PI.lebron.name === 'LeBron James', JSON.stringify(PI.lebron));
  check('a shared surname picks by the stat named and says who it picked', PI.mitch.name === 'Donovan Mitchell' && /Ajay Mitchell/.test(PI.mitch.amb) && PI.smith.name === 'DeVonta Smith' && PI.smith.stat === 'recyd', JSON.stringify([PI.mitch, PI.smith.name]));
  check('dotted initials keep each leg\'s own stat and line (L.J. Phillips rushing 40.5, Maxey points 20.5)', JSON.stringify(PI.lj.legs) === JSON.stringify([['Tyrese Maxey', 'pts', 20.5], ['L.J. Phillips Jr.', 'ryd', 40.5]]), JSON.stringify(PI.lj.legs));
  check('"2 TDs" gets a note that the app prices anytime (1+) only', PI.td2.stat === 'td' && /Two or more/.test(PI.td2.td), JSON.stringify(PI.td2));
  check('"threes" is named as a market the app has no line for', PI.threes.missing === 'three-pointers made' && PI.threes.stat === 'pts', JSON.stringify(PI.threes));
  check('a city name finds the game ("Houston" -> LAC @ HOU)', PI.hou.kind === 'game' && /HOU/.test(PI.hou.gid || ''), JSON.stringify(PI.hou));
  await askQ(page, 'Will Maxey make 4 threes?');
  A = await lastA(page);
  check('the answer says when it priced another market than the one asked', /no three-pointers made line for him, so this is his points market/.test(A.text), A.text.slice(0, 200));
  await askQ(page, 'Is Mitchell over 22.5 points?');
  A = await lastA(page);
  check('the answer says which Mitchell it read', A.pcs[0] && A.pcs[0].name === 'Donovan Mitchell' && /Reading "mitchell" as Donovan Mitchell/.test(A.text), A.text.slice(-200));

  // box-score logs are dated by the game's UTC start date: last night's game (logged 2026-11-23) counts for tonight's game
  const LC = await page.evaluate(() => { const c1 = __ask.logCut({ start: '2026-11-24T00:30:00Z' }), c2 = __ask.logCut({ start: '2026-11-26T00:00:00Z' });
    return [c1('2026-11-23'), c1('2026-11-24'), c2('2026-11-24'), c2('2026-11-22')]; });
  check('log-date rule: before the priced game\'s UTC date and not after today\'s UTC date', JSON.stringify(LC) === '[true,false,false,true]', JSON.stringify(LC));
  await askQ(page, 'Is Pascal Siakam over 20.5 points?');
  A = await lastA(page);
  const sk = await page.evaluate(() => [...document.querySelectorAll('.ask-a:last-child .ui-log .o')].map(o => o.textContent));
  check('a back-to-back keeps last night\'s game in the log (Siakam: ... NY, logged 2026-11-23)', sk.length === 5 && sk[4] === 'NY', JSON.stringify(sk));

  // an under: the bars take their colour from the under (green = under the line)
  await askQ(page, 'Maxey under 30.5 points');
  const UB = await page.evaluate(() => { const a = document.querySelector('.ask-a:last-child'); return { sum: (a.querySelector('.ui-loghead b') || {}).textContent, hit: a.querySelectorAll('.ui-log .b.hit').length, vals: [...a.querySelectorAll('.ui-log .b .v')].map(v => +v.textContent) }; });
  check('under: green bars are the games under the line, matching "N of M under"', +UB.sum.split(' ')[0] === UB.hit && UB.hit === UB.vals.filter(v => v < 30.5).length && /under 30\.5/.test(UB.sum), JSON.stringify(UB));

  // + Slip, Analyze, Ask a follow-up, Scan a slip
  const before = await page.evaluate(() => SB.slip.length);
  await page.locator('.ask-pc [data-ask-slip]').first().click();
  const sl = await page.evaluate(() => ({ n: SB.slip.length, lbl: document.querySelector('.ask-pc [data-ask-slip]').textContent, key: SB.slip.map(L => L.key) }));
  check('+ Slip adds the card\'s leg to the app slip and the button says so', sl.n === before + 1 && sl.lbl === '✓ In slip' && sl.key.some(k => /^P:tyrese-maxey|^TD:A:/.test(k)), JSON.stringify(sl));
  await page.locator('.ask-pc [data-ask-fu]').first().click();
  const fu = await page.evaluate(() => ({ v: document.querySelector('.ask-input').value, f: document.activeElement === document.querySelector('.ask-input') }));
  check('Ask a follow-up fills and focuses the box', /^About Tyrese Maxey Over 24\.5 points: $/.test(fu.v) && fu.f, fu.v);
  await page.locator('.ask-pc [data-ask-an]').first().click();
  const an = await page.evaluate(() => SB.tab);
  check('Analyze opens the Prop Analyzer', an === 'propan', an);
  await page.evaluate(() => SB.goTab('ask'));
  await page.click('[data-ask-scan]');
  check('Scan a slip opens Slip Check', await page.evaluate(() => SB.tab) === 'slipcheck');
  await page.evaluate(() => SB.goTab('ask'));
  check('no horizontal scroll at 390 with cards on screen', await noHScroll(page));
  const ub = await page.evaluate(() => { const u = document.querySelector('.ask-ub'), r = u.getBoundingClientRect(); return { right: r.right, w: innerWidth, b: getComputedStyle(u).borderTopColor }; });
  check('user bubbles sit on the right with an accent border', ub.right > ub.w - 40 && /0, 211, 243|62, 196, 255/.test(ub.b), JSON.stringify(ub));

  // user text with HTML is text
  await askQ(page, '<b id="inj">Maxey</b> points?');
  check('user text with HTML shows as text', await page.evaluate(() => !document.getElementById('inj') && [...document.querySelectorAll('.ask-ub')].some(u => u.textContent.includes('<b id="inj">'))));

  // history survives a reload (text + cards), capped at 20 messages
  const nMsgs = await page.evaluate(() => document.querySelectorAll('.ask-u,.ask-a').length);
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-thread'));
  await page.waitForFunction(() => document.querySelector('.ask-pc'), null, { timeout: 15000 });
  const H = await page.evaluate(() => ({ n: document.querySelectorAll('.ask-u,.ask-a').length, pc: document.querySelectorAll('.ask-pc').length, tc: document.querySelectorAll('.ask-tc .pc').length, first: (document.querySelector('.ask-ub') || {}).textContent, saved: JSON.parse(localStorage.getItem('fm2.chat')).msgs.length }));
  check('history survives a reload (messages and re-priced cards)', H.n === Math.min(20, nMsgs) && H.pc >= 2 && H.tc >= 1 && H.saved <= 20, JSON.stringify(H));
  const RT = await page.evaluate(() => { const t0 = performance.now(); SB.goTab('ask'); const t1 = performance.now(); SB.goTab('insights'); const t2 = performance.now(); SB.goTab('ask'); return { withCards: t1 - t0, again: performance.now() - t2, cards: document.querySelectorAll('.ask-pc,.ask-tc,.ask-list,.ask-gc').length }; });
  check('render measured in the page with a full history of cards: under 1,500 ms', RT.withCards < 1500 && RT.again < 1500 && RT.cards >= 3, `${Math.round(RT.withCards)} ms, again ${Math.round(RT.again)} ms, ${RT.cards} cards`);

  // params: {q} fills the box, {q, send:true} asks it
  await page.evaluate(() => SB.goTab('ask', { q: 'How does Grizzlies @ Hornets look?' }));
  const pv = await page.evaluate(() => document.querySelector('.ask-input').value);
  check('goTab(ask, {q}) puts the question in the box without sending', pv === 'How does Grizzlies @ Hornets look?' && !(await page.evaluate(() => __ask.state.busy)), pv);
  const n0 = await page.evaluate(() => document.querySelectorAll('.ask-a').length);
  await page.evaluate(() => SB.goTab('ask', { q: 'How does Grizzlies @ Hornets look?', send: true }));
  await page.waitForFunction(n => document.querySelectorAll('.ask-a').length > n, n0); await settle(page);
  A = await lastA(page);
  check('goTab(ask, {q, send:true}) asks it: a game card', await page.evaluate(() => !!document.querySelector('.ask-a:last-child .ask-gc')) && /Grizzlies/.test(A.text), A.text.slice(0, 80));

  // New chat
  await page.click('[data-ask-new]');
  const nc = await page.evaluate(() => ({ empty: !!document.querySelector('.ask.is-empty'), saved: JSON.parse(localStorage.getItem('fm2.chat')).msgs.length }));
  check('New chat clears the conversation and the saved history', nc.empty && nc.saved === 0, JSON.stringify(nc));

  // fantasy mode: fantasy suggestions and a start / sit card
  await page.evaluate(() => SB.setMode('fantasy')); await page.evaluate(() => SB.goTab('ask'));
  const fc = await page.evaluate(() => [...document.querySelectorAll('.ask-chip')].map(b => b.textContent));
  check('fantasy mode: fantasy questions (start at flex: A or B)', fc.some(c => /^Who should I start at flex: .+ or .+\?$/.test(c)), JSON.stringify(fc));
  await page.click('.ask-chip');
  await page.waitForTimeout(30); await settle(page);
  check('after a suggestion is asked, focus lands on the Send button (not lost to the page)', await page.evaluate(() => document.activeElement && document.activeElement.matches('.ask-send')));
  const ss = await page.evaluate(() => { const c = document.querySelector('.ask-a:last-child .ask-ss'); return c ? { v: c.querySelector('.ui-verdict .t').textContent, cols: c.querySelectorAll('.ask-ss-c').length, tag: c.querySelector('.ui-verdict .tag').textContent } : null; });
  check('start / sit -> a comparison card with a model-estimate verdict', ss && ss.cols === 2 && /^Start |^Close call$/.test(ss.v) && ss.tag === 'Model estimate', JSON.stringify(ss));
  await page.evaluate(() => SB.setMode('betting'));

  check('no page errors (offline run)', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => { localStorage.removeItem('fm2.chat'); localStorage.removeItem('fm2.slip'); });
  await browser.close();
}

// ---------------------------------------------------------------- 2. Claude through a mocked `sample` capability
{
  const { page, errors, browser } = await open({ width: 390, tab: 'ask' });
  await page.addInitScript(() => {
    localStorage.removeItem('fm2.chat');
    window.__calls = []; window.__mock = 'ok';
    const fakeSample = async (input, options) => {
      window.__calls.push({ input, tools: (options.tools || []).map(t => t.name), signal: options.signal instanceof AbortSignal, cache: options.cache });
      const mode = window.__mock;
      if (mode === 'not_granted') throw { code: 'not_granted', message: 'declined' };
      if (mode === 'rate_limited') throw { code: 'rate_limited', message: 'slow down' };
      if (mode === 'slow') {
        options.onText({ text: 'Looking at Maxey', delta: 'Looking at Maxey' });
        return new Promise((res, rej) => options.signal.addEventListener('abort', () => rej({ code: 'cancelled', message: 'stopped', text: 'Looking at Maxey' })));
      }
      if (mode === 'upstream') { options.onText({ text: 'Half an ans', delta: 'Half an ans' }); throw { code: 'upstream_error', message: 'x', text: 'Half an ans' }; }
      if (mode.startsWith('err:')) { const [, code, part] = mode.split(':'); if (part) options.onText({ text: part, delta: part }); throw part && code !== 'refused' ? { code, message: 'x', text: part } : { code, message: 'x' }; }
      if (mode === 'slowcancel') return new Promise((res, rej) => options.signal.addEventListener('abort', () => setTimeout(() => rej({ code: 'cancelled', message: 'stopped' }), 400)));
      if (mode === 'inject') {  // Claude passes a price and a line the viewer never typed
        const t = options.tools.find(x => x.name === 'prop_report');
        window.__inj = await t.execute({ player: 'Tyrese Maxey', stat: 'points', line: 27.5, side: 'over', price: '+150' }, { signal: options.signal });
        options.onText({ text: 'Done.', delta: 'Done.' }); return { text: 'Done.', truncated: false, modelTierApplied: 'default' };
      }
      if (mode === 'fine' || !options.tools) { await new Promise(r => setTimeout(r, 600)); options.onText({ text: 'Fine.', delta: 'Fine.' }); return { text: 'Fine.', truncated: false, modelTierApplied: 'default' }; }
      const t = options.tools.find(x => x.name === 'prop_report');
      window.__toolResult = await t.execute({ player: 'Tyrese Maxey', stat: 'points', line: 24.5, side: 'over' }, { signal: options.signal });
      let bad = null; try { await t.execute({ player: 'Nobody Atall', stat: 'points' }, { signal: options.signal }); } catch (e) { bad = String(e && e.message); }
      window.__toolError = bad;
      await new Promise(r => setTimeout(r, 40));
      const parts = ['**Lean over** on Maxey. ', `Model chance ${window.__toolResult.model_chance}.\n\n- From the card\n- <img src=x onerror="window.__xss=1">`];
      let text = '';
      for (const d of parts) { text += d; options.onText({ text, delta: d }); window.__streamed = (window.__streamed || 0) + 1; await new Promise(r => setTimeout(r, 250)); }
      return { text, truncated: false, modelTierApplied: 'default' };
    };
    fakeSample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
    window.claude = { use: async name => (name === 'sample' ? fakeSample : null) };
  });
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-chip'));
  await page.waitForFunction(() => __ask.state.ai === 'ready');
  check('with Claude available the footer says so', /Claude answers from the app's numbers/.test(await page.textContent('.ask-foot')));
  await page.fill('.ask-input', 'Is Tyrese Maxey over 24.5 points a good bet?'); await page.click('.ask-send');
  await page.waitForFunction(() => window.__streamed >= 1);
  const mid = await page.evaluate(() => ({ busy: __ask.state.busy, text: document.querySelector('.ask-a:last-child .ask-text').textContent, card: !!document.querySelector('.ask-a:last-child .ask-pc'), stop: !!document.querySelector('[data-ask-stop]') }));
  check('the text streams in while the call runs (Stop shown)', mid.busy && /Lean over/.test(mid.text) && mid.stop, JSON.stringify(mid));
  check('the page tool ran and its card is under the answer before the text finishes', mid.card && /%$/.test((await page.evaluate(() => window.__toolResult || {})).model_chance || ''));
  await settle(page);
  const M = await page.evaluate(() => { const a = document.querySelector('.ask-a:last-child'), c = window.__calls[0]; return {
    text: a.querySelector('.ask-text').textContent, strong: (a.querySelector('.ask-text strong') || {}).textContent, lis: a.querySelectorAll('.ask-text li').length, imgs: a.querySelectorAll('.ask-text img, .ask-a img').length, xss: window.__xss,
    name: (a.querySelector('.ask-pc-nm b') || {}).textContent, market: (a.querySelector('.ask-pc-mk span') || {}).textContent, note: (a.querySelector('.ask-note') || {}).textContent || '',
    first: c.input[0], last: c.input[c.input.length - 1], roles: c.input.map(x => x.role), tools: c.tools, signal: c.signal, cache: c.cache, toolErr: window.__toolError, res: window.__toolResult }; });
  check('the final text renders the safe markdown subset (bold, bullets)', M.strong === 'Lean over' && M.lis === 2 && /Model chance \d+%/.test(M.text), M.text);
  check('model text with <img onerror> shows as text, never as HTML', M.imgs === 0 && M.xss === undefined && M.text.includes('<img src=x onerror="window.__xss=1">'));
  check('the card comes from the engine (Maxey, Over 24.5 points), not from the model\'s words', M.name === 'Tyrese Maxey' && M.market === 'Over 24.5 points');
  check('input: a leading instructions turn, the question last, user turns at both ends', M.first.role === 'user' && /Safe Bets research assistant/.test(M.first.content) && /model estimates/.test(M.first.content) && /never|Never/.test(M.first.content) && M.last.content === 'Is Tyrese Maxey over 24.5 points a good bet?' && M.roles[M.roles.length - 1] === 'user', JSON.stringify(M.roles));
  check('page tools offered: find_players, prop_report, game_report, build_parlay, price_parlay, top_props, start_sit and the breakdown tools; a signal; no cache with tools', ['find_players', 'prop_report', 'game_report', 'build_parlay', 'price_parlay', 'top_props', 'start_sit', 'player_stats', 'review_player', 'review_parlay', 'team_report', 'leaders', 'track_record'].every(t => M.tools.includes(t)) && M.signal && M.cache === undefined, JSON.stringify(M.tools));
  check('a tool with no data throws a plain error for Claude', /No player named "Nobody Atall"/.test(M.toolErr || ''), M.toolErr);
  check('the tool result is small plain data with the numbers', M.res && M.res.player === 'Tyrese Maxey' && /model estimate/.test(M.res.verdict) && Array.isArray(M.res.factors) && M.res.factors.length === 4 && JSON.stringify(M.res).length < 4000, JSON.stringify(M.res).length);
  check('no offline note on a Claude answer', !/AI answers aren't available/.test(M.note), M.note);

  // a follow-up carries the earlier turns (with what the cards showed)
  await page.evaluate(() => { window.__streamed = 0; });
  await page.fill('.ask-input', 'And the under?'); await page.click('.ask-send'); await settle(page);
  const F = await page.evaluate(() => { const c = window.__calls[1]; return { roles: c.input.map(x => x.role), prev: c.input[2] && c.input[2].content }; });
  check('follow-ups send the recent turns (assistant text + the cards it showed)', JSON.stringify(F.roles) === '["user","user","assistant","user"]' && /Cards shown: Tyrese Maxey Over 24.5 points/.test(F.prev || ''), JSON.stringify(F));

  // Stop
  await page.evaluate(() => { window.__mock = 'slow'; });
  await page.fill('.ask-input', 'Maxey rebounds?'); await page.click('.ask-send');
  await page.waitForSelector('[data-ask-stop]'); await page.waitForFunction(() => /Looking at Maxey/.test(document.querySelector('.ask-a:last-child .ask-text').textContent));
  await page.click('[data-ask-stop]'); await settle(page);
  const S = await page.evaluate(() => ({ text: document.querySelector('.ask-a:last-child .ask-text').textContent, note: (document.querySelector('.ask-a:last-child .ask-note') || {}).textContent, send: !!document.querySelector('.ask-send:not(.ask-stop)') }));
  check('Stop cancels: the partial text stays, marked Stopped, the box comes back', S.text === 'Looking at Maxey' && S.note === 'Stopped.' && S.send, JSON.stringify(S));

  // upstream error: keep the partial, offer Try again
  await page.evaluate(() => { window.__mock = 'upstream'; });
  await askQ(page, 'Maxey assists?');
  const UE = await page.evaluate(() => ({ text: document.querySelector('.ask-a:last-child .ask-text').textContent, err: (document.querySelector('.ask-a:last-child .ask-err') || {}).textContent || '', retry: !!document.querySelector('.ask-a:last-child [data-ask-retry]') }));
  check('upstream_error: partial text kept, marked interrupted, Try again offered', UE.text === 'Half an ans' && /interrupted/.test(UE.err) && UE.retry, JSON.stringify(UE));

  // rate limited: say so and keep the question in the box
  await page.evaluate(() => { window.__mock = 'rate_limited'; });
  await askQ(page, 'Best props tonight?');
  const RL = await page.evaluate(() => ({ err: (document.querySelector('.ask-a:last-child .ask-err') || {}).textContent || '', box: document.querySelector('.ask-input').value, ai: __ask.state.ai }));
  check('rate_limited: tells the viewer and keeps the question in the box (no retry loop)', /Too many questions/.test(RL.err) && RL.box === 'Best props tonight?' && RL.ai === 'ready', JSON.stringify(RL));

  // a price and a line that only Claude wrote never reach the card; a price the viewer typed does
  await page.evaluate(() => { window.__mock = 'inject'; });
  await askQ(page, 'Is Tyrese Maxey a good bet tonight?');
  const IJ = await page.evaluate(() => { const c = document.querySelector('.ask-a:last-child .ask-pc'); return { kick: c.querySelector('.ui-verdict .k').textContent, mk: c.querySelector('.ask-pc-mk span').textContent, tiles: [...c.querySelectorAll('.ui-tile .ui-lbl')].map(x => x.textContent), ign: window.__inj.ignored || [] }; });
  check('a price only Claude wrote is ignored: no "your price" tile or edge verdict, and Claude is told', !IJ.tiles.includes('Your price') && !/your price/.test(IJ.kick) && IJ.ign.some(x => /price \+150 ignored/.test(x)), JSON.stringify(IJ));
  check('a line only Claude wrote is ignored: the card uses the app\'s own line', !/27\.5/.test(IJ.mk) && IJ.ign.some(x => /line 27\.5 ignored/.test(x)), JSON.stringify(IJ));
  await askQ(page, 'Is Tyrese Maxey over 27.5 points at +150 a good bet?');
  const IJ2 = await page.evaluate(() => { const c = document.querySelector('.ask-a:last-child .ask-pc'); return { kick: c.querySelector('.ui-verdict .k').textContent, mk: c.querySelector('.ask-pc-mk span').textContent, price: Object.fromEntries([...c.querySelectorAll('.ui-tile')].map(t => [t.querySelector('.ui-lbl').textContent, t.querySelector('b').textContent]))['Your price'], ign: window.__inj.ignored }; });
  check('the same price and line typed by the viewer are used (edge read vs your price)', IJ2.price === '+150' && /vs your price/.test(IJ2.kick) && IJ2.mk === 'Over 27.5 points' && !IJ2.ign, JSON.stringify(IJ2));

  // a view without page tools: the numbers go in the prompt and the chat turn is never cached
  await page.evaluate(() => { window.__mock = 'fine'; __ask.state.toolsOk = false; });
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  const NT = await page.evaluate(() => { const c = window.__calls[window.__calls.length - 1]; return { tools: c.tools.length, cache: c.cache, last: c.input[c.input.length - 1].content, card: !!document.querySelector('.ask-a:last-child .ask-pc') }; });
  check('no tools: cache:false, the app\'s numbers in the last turn, the card still drawn by the engine', NT.tools === 0 && NT.cache === false && /The app's numbers for this question/.test(NT.last) && NT.card, JSON.stringify({ ...NT, last: NT.last.slice(0, 60) }));
  await page.evaluate(() => { __ask.state.toolsOk = true; });
  check('limits(): the tools limit is read (maxCount 16)', await page.evaluate(() => __ask.state.maxTools === 16));
  await page.evaluate(() => { __ask.state.maxTools = 3; window.__mock = 'fine'; });
  await askQ(page, 'Best props tonight?');
  const MT = await page.evaluate(() => window.__calls[window.__calls.length - 1].tools);
  check('a view that allows 3 tools gets the 3 that matter most (prop_report, player_stats, review_parlay)', JSON.stringify(MT) === '["prop_report","player_stats","review_parlay"]', JSON.stringify(MT));
  // review fix: the instructions name only the tools this view sent; fantasy mode keeps start_sit (its suggestion chip's tool)
  const MR = await page.evaluate(() => { const c = window.__calls[window.__calls.length - 1], r = c.input[0].content, pick = (r.split('\n').find(l => /^- Pick the tool:/.test(l)) || ''); return { pick, names: c.tools }; });
  check('with 3 tools, "Pick the tool" names those 3 only and says the view allows only them', /player_stats for/.test(MR.pick) && /review_parlay for/.test(MR.pick) && /prop_report for bets/.test(MR.pick) && !/review_player|team_report|leaders for|track_record|start_sit|build_parlay/.test(MR.pick) && /allows only these 3 tools/.test(MR.pick), MR.pick);
  await page.evaluate(() => SB.setMode('fantasy')); await page.evaluate(() => SB.goTab('ask'));
  await askQ(page, 'Who should I start?');
  const MF = await page.evaluate(() => { const c = window.__calls[window.__calls.length - 1]; return { tools: c.tools, pick: c.input[0].content.split('\n').find(l => /^- Pick the tool:/.test(l)) || '' }; });
  check('fantasy mode with 3 tools keeps start_sit, and the instructions name it', MF.tools.includes('start_sit') && MF.tools.length === 3 && /start_sit/.test(MF.pick), JSON.stringify(MF));
  await page.evaluate(() => SB.setMode('betting')); await page.evaluate(() => SB.goTab('ask'));
  await page.evaluate(() => { __ask.state.maxTools = 16; });
  await askQ(page, 'Best props tonight?');
  const MA = await page.evaluate(() => window.__calls[window.__calls.length - 1].input[0].content.split('\n').find(l => /^- Pick the tool:/.test(l)) || '');
  check('with every tool sent, "Pick the tool" names the breakdown tools and adds no limit note', ['player_stats', 'review_player', 'review_parlay', 'team_report', 'leaders', 'track_record', 'start_sit'].every(t => MA.includes(t)) && !/allows only/.test(MA), MA);

  // every other error code
  const errCase = async (mode, q) => { await page.evaluate(m => { window.__mock = m; }, mode); await askQ(page, q); return page.evaluate(() => { const a = document.querySelector('.ask-a:last-child'); return { text: a.querySelector('.ask-text').textContent, err: (a.querySelector('.ask-err') || {}).textContent || '', note: (a.querySelector('.ask-note') || {}).textContent || '', card: !!a.querySelector('.ask-pc'), retry: !!a.querySelector('[data-ask-retry]'), box: document.querySelector('.ask-input').value, ai: __ask.state.ai, toolsOk: __ask.state.toolsOk }; }); };
  let EC = await errCase('err:session_expired', 'Maxey points?');
  check('session_expired: say so, keep the question in the box', /sign-in expired/.test(EC.err) && EC.box === 'Maxey points?' && EC.ai === 'ready', JSON.stringify(EC));
  EC = await errCase('err:refused:Partial words', 'Maxey points?');
  check('refused: the partial text is withdrawn, the viewer is told', EC.text === '' && /declined/.test(EC.err), JSON.stringify(EC));
  EC = await errCase('err:empty_completion', 'Maxey points?');
  check('empty_completion: no answer, ask for less', /No answer came back/.test(EC.err), JSON.stringify(EC));
  EC = await errCase('err:prompt_too_large', 'Maxey points?');
  check('prompt_too_large: start a new chat', /too long/.test(EC.err), JSON.stringify(EC));
  EC = await errCase('err:invalid_request', 'Is Tyrese Maxey over 24.5 points a good bet?');
  check('invalid_request (a page bug): the app\'s own answer with its card, Claude kept for later', EC.card && /couldn't take this question/.test(EC.note) && EC.ai === 'ready', JSON.stringify(EC));
  EC = await errCase('err:some_new_code:Half a', 'Maxey points?');
  check('an unknown code is treated as upstream_error: partial kept, Try again', EC.text === 'Half a' && /interrupted/.test(EC.err) && EC.retry, JSON.stringify(EC));
  EC = await errCase('err:tools_unavailable', 'Is Tyrese Maxey over 24.5 points a good bet?');
  check('tools_unavailable: the app\'s own answer now, later calls go without tools', EC.card && /can't run the app's tools/.test(EC.note) && EC.toolsOk === false && EC.ai === 'ready', JSON.stringify(EC));
  await page.evaluate(() => { __ask.state.toolsOk = true; });

  // New chat while a call is still being cancelled: the next question keeps its busy state and its own Stop
  await page.evaluate(() => { window.__mock = 'slowcancel'; });
  await page.fill('.ask-input', 'Maxey rebounds?'); await page.click('.ask-send'); await page.waitForSelector('[data-ask-stop]');
  await page.click('[data-ask-new]');
  await page.evaluate(() => { window.__mock = 'fine'; });
  await page.fill('.ask-input', 'Maxey assists?'); await page.click('.ask-send');
  await page.waitForTimeout(450);
  const NC = await page.evaluate(() => ({ busy: __ask.state.busy, ctl: !!__ask.state.ctl, stop: !!document.querySelector('[data-ask-stop]'), n: document.querySelectorAll('.ask-a').length }));
  check('New chat during a slow call: the old call settling later does not end the new one', NC.busy && NC.ctl && NC.stop && NC.n === 1, JSON.stringify(NC));
  await settle(page);

  // not granted: switch to offline answers for the session
  await page.evaluate(() => { window.__mock = 'not_granted'; });
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  const NG = await page.evaluate(() => ({ note: (document.querySelector('.ask-a:last-child .ask-note') || {}).textContent || '', card: !!document.querySelector('.ask-a:last-child .ask-pc'), ai: __ask.state.ai, calls: window.__calls.length, foot: document.querySelector('.ask-foot').textContent }));
  check('not_granted: answers offline with the same card and a note; the session stays offline', NG.card && /wasn't allowed/.test(NG.note) && NG.ai === 'off' && /aren't available/.test(NG.foot), JSON.stringify(NG));
  const c0 = NG.calls; await askQ(page, 'Best props tonight?');
  check('after not_granted, later questions never call Claude again', await page.evaluate(n => window.__calls.length === n, c0));

  check('no horizontal scroll at 390 (Claude run)', await noHScroll(page));
  check('no page errors (Claude run)', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---------------------------------------------------------------- 2b. missing data: no season.json, then an empty slate
{
  const { page, errors, browser } = await open({ width: 390, tab: 'ask', pins: { 'season.json': null } });
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await page.waitForSelector('.ask-chip');
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  let A = await lastA(page);
  check('no season.json: the prop card still draws (form-file log, 4 factors)', A.pcs.length === 1 && A.pcs[0].factors.length === 4 && /model chance/.test(A.text), JSON.stringify(A.pcs[0] && [A.pcs[0].logSum, A.pcs[0].factors]));
  await askQ(page, 'Should I take Chase Brown to score a TD?');
  A = await lastA(page);
  check('no season.json: a TD card says it has no recent box scores instead of inventing them', A.pcs.length === 1 && A.pcs[0].bars === 0 && A.pcs[0].factorWhy.some(w => /No recent box scores/.test(w)), JSON.stringify(A.pcs[0] && A.pcs[0].factorWhy[1]));
  await page.route(/\/data\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: '2026-11-23T11:00:00Z', games: [] }) }));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-chip'));
  await askQ(page, 'build me a 3-leg NBA parlay');
  A = await lastA(page);
  check('an empty slate: a parlay request gets a plain "no legs qualify" answer, no card', !A.legs && /No NBA legs qualify|couldn't match/.test(A.text), A.text.slice(0, 100));
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  A = await lastA(page);
  check('an empty slate: a player question says he has no game on the slate', !A.pcs.length && /no game with a model line|couldn't match/.test(A.text), A.text.slice(0, 120));
  check('no page errors (missing data)', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await browser.close();
}

// ---------------------------------------------------------------- 4. breakdowns, offline: a player's season, one game, a parlay, a team, leaders, the track record
const lastBD = page => page.evaluate(() => {
  const a = [...document.querySelectorAll('.ask-a')].pop(), q = s => a.querySelector(s), txt = e => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const tiles = root => Object.fromEntries([...a.querySelectorAll(root + ' .ui-tile')].map(t => [txt(t.querySelector('.ui-lbl')), txt(t.querySelector('b'))]));
  const rows = root => [...a.querySelectorAll(root + ' .ui-table tbody tr')].map(tr => [...tr.children].map(td => txt(td)));
  return { text: txt(q('.ask-text')), note: txt(q('.ask-note')),
    ps: q('.ask-ps') ? { name: txt(q('.ask-ps .ask-hd .nm b')), tiles: tiles('.ask-ps'), rows: rows('.ask-ps'), bars: a.querySelectorAll('.ask-ps .ui-log .b').length, lineLbl: txt(q('.ask-ps .ui-log .lv')), notes: [...a.querySelectorAll('.ask-ps .ui-note')].map(txt), all: txt(q('.ask-ps')) } : null,
    rv: q('.ask-rv') ? { title: txt(q('.ask-rv .ui-verdict .t')), kick: txt(q('.ask-rv .ui-verdict .k')), tone: q('.ask-rv .ui-verdict').className, close: txt(q('.ask-rv .ask-p')), facts: [...a.querySelectorAll('.ask-rv .ask-why li')].map(li => [txt(li.querySelector('.ask-tag')), txt(li.querySelector('span:last-child'))]),
      sel: [...a.querySelectorAll('.ask-rv .ui-log .b')].findIndex(b => b.classList.contains('sel')), bars: a.querySelectorAll('.ask-rv .ui-log .b').length, all: txt(q('.ask-rv')) } : null,
    pr: q('.ask-pr') ? { title: txt(q('.ask-pr .ui-verdict .t')), kick: txt(q('.ask-pr .ui-verdict .k')), tiles: tiles('.ask-pr'), secs: [...a.querySelectorAll('.ask-pr .ask-sec > .ui-lbl')].map(txt), all: txt(q('.ask-pr')),
      legs: [...a.querySelectorAll('.ask-pr .ask-legs > li')].map(li => ({ cls: li.className, ic: txt(li.querySelector('.ic')), label: txt(li.querySelector('.t b')), badge: txt(li.querySelector('.ask-badge')), sub: txt(li.querySelector('.t > span:not(.ask-badge)')), p: txt(li.querySelector('.pp')) })) } : null,
    tm: q('.ask-tm') ? { name: txt(q('.ask-tm .ask-hd .nm b')), tiles: tiles('.ask-tm'), rows: rows('.ask-tm'), secs: [...a.querySelectorAll('.ask-tm .ask-sec > .ui-lbl')].map(txt), all: txt(q('.ask-tm')) } : null,
    ld: q('.ask-ld') ? { title: txt(q('.ask-ld .ask-lh b')), rule: txt(q('.ask-ld .ask-lh .ui-note')), rows: [...a.querySelectorAll('.ask-ld li')].map(li => [txt(li.querySelector('.ask-lname')), txt(li.querySelector('.p b'))]) } : null,
    tr: q('.ask-tr') ? { tiles: tiles('.ask-tr'), all: txt(q('.ask-tr')) } : null };
});
{
  // small researched-form and trends files for the team card (the live ones change every day)
  const FORM = { teams: [{ name: 'Lakers', comp: 'NBA', league: 'Western Conference', position: 2, of: 15, record: '14-3', winStreak: 1, lossStreak: 0, unbeaten: 0, last5: 'W W W L W', games: [{ date: '2026-11-21', comp: 'NBA', home: true, opp: 'Sacramento Kings', oppPos: 15, oppOf: 15, result: 'W', score: '106-104' }], absences: 'Austin Reaves out (heel)', asOf: '2026-11-22' }] };
  const TRENDS = { teams: [{ sport: 'nba', comp: 'NBA', name: 'Los Angeles Lakers', abbr: 'LAL', espn: 'LAL', windows: { season: { n: 17, fav: { n: 15, won: 12, exp: 10.5 }, dog: { n: 2, won: 2, exp: 0.8 }, ln: { n: 17, hit: 11, exp: 8.5 } } }, streak: { res: 'W1' }, next: null }] };
  const json = b => r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  const before = async pg => { await pg.route(/\/form\.json(\?.*)?$/, json(FORM)); await pg.route(/\/trends\.json(\?.*)?$/, json(TRENDS)); };
  const { page, errors, browser } = await open({ width: 390, tab: 'ask', notFound: ['mypicks.json'], pins: { 'recs.json': 'recs-askbd-2026-11-23.json', 'news.json': 'news-2026-11-24.json' }, before });
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await page.waitForSelector('.ask-chip');

  // a player's season, on the slate
  await askQ(page, 'Tyrese Maxey stats');
  let B = await lastBD(page);
  const MX = sPl('nba', 'Tyrese Maxey'), mxL = MX.rows[MX.rows.length - 1], mxR = resOf('nba', 'PHI', mxL.r[0]), mxPg = f1(MX.T('pts') / MX.gp);
  check('"Tyrese Maxey stats" -> a player card with per-game numbers from the season totals (tot / gp)', B.ps && B.ps.name === 'Tyrese Maxey' && B.ps.tiles['PTS a game'] === mxPg && B.ps.tiles.Games === String(MX.gp) && B.ps.tiles['REB a game'] === f1(MX.T('reb') / MX.gp) && B.text.includes(`${mxPg} points`), JSON.stringify(B.ps && B.ps.tiles));
  check('player card: the latest game first in the table, with his line and the team\'s result from the results', B.ps && JSON.stringify(B.ps.rows[0]) === JSON.stringify([fmtD(mxL.r[0]), `${mxL.r[2] ? 'vs' : '@'} ${mxL.r[1]}`, ...[4, 5, 6, 3].map(i => String(mxL.r[i])), `${mxR[3] > mxR[4] ? 'W' : 'L'} ${mxR[3]}-${mxR[4]}`]), JSON.stringify(B.ps && B.ps.rows[0]));
  check('player card: a chart of his last 5 with his season average as the line', B.ps && B.ps.bars === 5 && B.ps.lineLbl === mxPg, JSON.stringify([B.ps && B.ps.bars, B.ps && B.ps.lineLbl]));
  check('text: the last-5 average from the logged games, called a small sample; the UTC date rule', B.text.includes(`Last 5: ${f1(mean(MX.rows.slice(-5).map(x => x.r[4])))} points a game (a small sample)`) && /UTC start date/.test(B.text), B.text.slice(0, 300));
  check('player card: the app\'s line for his next game is a model estimate with fair odds', /Next game/.test(B.ps.all) && /model estimate/.test(B.ps.all) && /fair [+-]\d+/.test(B.ps.all), B.ps.all.slice(-400));

  // a player with no game on the slate
  await askQ(page, 'Nickeil Alexander-Walker last 5');
  B = await lastBD(page);
  const NW = sPl('nba', 'Nickeil Alexander-Walker');
  check('a player with no game on the slate still gets his season (NAW, last 5)', B.ps && B.ps.name === 'Nickeil Alexander-Walker' && B.ps.rows.length === 5 && B.ps.tiles['PTS a game'] === f1(NW.T('pts') / NW.gp), JSON.stringify(B.ps && [B.ps.rows.length, B.ps.tiles]));
  check('the card says when the file keeps fewer games than the season (last 15 of 17)', NW.rows.length < NW.gp && B.ps.notes.some(n => n.includes(`last ${NW.rows.length} logged games; season numbers cover all ${NW.gp}`)), JSON.stringify(B.ps.notes));

  // one game: a miss, the app's own line and chance, facts vs possibilities
  await askQ(page, 'How did Cade Cunningham do on Nov 22?');
  B = await lastBD(page);
  const CC = sPl('nba', 'Cade Cunningham'), ccRow = CC.rows.find(x => x.r[0] === '2026-11-22'), ccRes = resOf('nba', 'DET', '2026-11-22');
  const ccLeg = RECS.days[0].parlays.flatMap(P => P.legs).find(L => L.player && L.player.name === 'Cade Cunningham'), minO = (CC.T('min') - ccRow.r[3]) / (CC.gp - 1);
  check('"How did Cade Cunningham do on Nov 22?" -> a review card: missed, his points vs the app\'s 15+ line (not the slate\'s Caleb Cunningham)', B.rv && B.rv.title === `Missed: ${ccRow.r[4]} points vs 14.5` && /pass/.test(B.rv.tone) && /the app's line/.test(B.rv.kick) && !/Caleb/.test(B.text), JSON.stringify(B.rv && [B.rv.title, B.rv.kick]));
  check('how close: points short and the number needed', B.rv.close === `How close: ${15 - ccRow.r[4]} points short (needed 15).`, B.rv.close);
  check('facts from the box score: minutes vs his other games, the final score', B.rv.facts.some(([t, x]) => t === 'Fact' && x.startsWith(`Played ${ccRow.r[3]} minutes vs ${f1(minO)} a game in his other ${CC.gp - 1} games`)) && B.rv.facts.some(([t, x]) => t === 'Fact' && x.startsWith(`DET ${ccRes[3] > ccRes[4] ? 'won' : 'lost'} ${ccRes[3]}-${ccRes[4]} at ATL`)), JSON.stringify(B.rv.facts.slice(0, 3)));
  check('what the data can\'t show is tagged Possible, and no Fact says may / might / often', B.rv.facts.some(([t]) => t === 'Possible') && B.rv.facts.filter(([t]) => t === 'Fact').every(([, x]) => !/\b(may|might|often|probably|likely)\b/i.test(x)), JSON.stringify(B.rv.facts));
  check('the app\'s pre-game chance from its saved pick, then variance (an 86% leg misses about 1 time in 7)', B.text.includes(`gave this leg ${Math.round(ccLeg.p * 100)}% before the game (model estimate)`) && /misses about 1 time in 7/.test(B.text), B.text.slice(-400));
  check('the reviewed game is picked out on his chart', B.rv.bars >= 5 && B.rv.sel === B.rv.bars - 1, JSON.stringify([B.rv.bars, B.rv.sel]));
  check('no hindsight words in the answer or the card (obvious, due, guaranteed, lock)', !/\b(obvious|due|guarantee[ds]?|lock)\b/i.test(B.text + ' ' + B.rv.all), '');

  // a near miss, last night
  await askQ(page, 'why did Aaron Nesmith miss last night');
  B = await lastBD(page);
  const AN = sPl('nba', 'Aaron Nesmith'), anL = AN.rows[AN.rows.length - 1], anLeg = RECS.days[0].parlays.flatMap(P => P.legs).find(L => L.player && L.player.name === 'Aaron Nesmith');
  check('"why did Aaron Nesmith miss last night" -> his latest game: 1 point short of the app\'s 10+, a near miss', B.rv && B.rv.title === `Missed: ${anL.r[4]} points vs 9.5` && anL.r[4] === 9 && /1 point short \(needed 10\), a near miss/.test(B.rv.close) && B.text.includes(`${Math.round(anLeg.p * 100)}% before the game`), JSON.stringify(B.rv && [B.rv.title, B.rv.close]));

  // the app's picks: the closest loss of the day, leg by leg
  await askQ(page, "What went wrong with yesterday's picks?");
  B = await lastBD(page);
  const D22 = RECS.days.find(d => d.day === '2026-11-22'), missN = P => P.legs.filter(L => L.res === false).length;
  const pick = D22.parlays.filter(P => P.tab === 'picks' && P.result === 'lost').sort((a, b) => missN(a) - missN(b) || b.p - a.p)[0];
  check("\"What went wrong with yesterday's picks?\" -> the closest loss of Nov 22's picks, leg by leg", B.pr && B.pr.kick.includes(pick.title) && B.pr.kick.includes('Nov 22') && B.pr.legs.length === pick.legs.length && B.pr.title === `Missed: ${missN(pick)} of ${pick.legs.length} legs`, JSON.stringify(B.pr && [B.pr.kick, B.pr.title]));
  const legOk = pick.legs.every((L, i) => { const P = sPl('nba', L.player.name), row = P.rows.find(x => x.r[0] === L.start.slice(0, 10)), v = P.v(row, L.player.stat); return B.pr.legs[i].sub.startsWith(`${v} ${L.player.stat.toUpperCase()}`) && B.pr.legs[i].ic === (v >= L.player.thr ? '✓' : '✗') && (B.pr.legs[i].ic === '✓') === (L.res === true); });
  check('each leg: the box-score number, ✓ / ✗ from it, the same as the app\'s morning grading', legOk, JSON.stringify(B.pr.legs.map(l => [l.ic, l.sub])));
  check('the breaking leg is highlighted with how far it missed and its chance before', B.pr.legs.filter(l => /brk/.test(l.cls)).length === missN(pick) && B.pr.legs.filter(l => /brk/.test(l.cls)).every(l => /short/.test(l.sub) && /%/.test(l.p)), JSON.stringify(B.pr.legs.filter(l => /brk/.test(l.cls))));
  check('the parlay\'s chance before (model estimate) and what it says about variance', B.pr.tiles['Chance before'] === `${Math.round(pick.p * 100)}%` && /misses about 5 times in 10 even when every leg is priced right/.test(B.text), JSON.stringify(B.pr.tiles));
  check('the app\'s track record for those kinds of legs (Lessons)', B.pr.secs.some(x => /track record/i.test(x)) && /player points legs: hit \d+ of \d+ \(\d+%\) vs \d+% the model expected/.test(B.pr.all), JSON.stringify(B.pr.secs));

  // a 14-leg props parlay with a near miss
  await askQ(page, "what went wrong with yesterday's NBA player props parlay");
  B = await lastBD(page);
  const NP = D22.parlays.find(P => P.id === 'mp-nba15'), nes = B.pr && B.pr.legs.find(l => l.label.startsWith('Aaron Nesmith'));
  check('a 14-leg props parlay: the near miss (Nesmith, 1 point short) is flagged as one', B.pr && B.pr.kick.includes(NP.title) && nes && nes.badge === 'Near miss' && /1 point short/.test(nes.sub) && /miss/.test(nes.cls), JSON.stringify(nes));
  check('its misses match the app\'s own grading, leg for leg', B.pr.legs.length === NP.legs.length && NP.legs.every((L, i) => (B.pr.legs[i].ic === '✗') === (L.res === false)), JSON.stringify(B.pr.legs.map(l => l.ic).join('')));

  // legs the viewer types
  await askQ(page, 'what went wrong with my parlay: Maxey over 20.5 points and Siakam over 20.5 points');
  B = await lastBD(page);
  const PS = sPl('nba', 'Pascal Siakam'), psL = PS.rows[PS.rows.length - 1];
  check('typed legs are graded from each player\'s latest box score (Maxey 17 vs 20.5: 4 short)', B.pr && B.pr.legs.length === 2 && B.pr.legs[0].ic === '✗' && B.pr.legs[0].sub.startsWith(`${mxL.r[4]} PTS`) && /4 points short \(needed 21\)/.test(B.pr.legs[0].sub) && B.pr.legs[1].ic === (psL.r[4] > 20.5 ? '✓' : '✗') && B.pr.legs[1].sub.startsWith(`${psL.r[4]} PTS`), JSON.stringify(B.pr && B.pr.legs));
  check('typed legs without a date: the card says each leg used that player\'s latest game', mxL.r[0] === psL.r[0] || /No date was given/.test(B.pr.all), B.pr.all.slice(-300));
  const LAr = SEA.sports.nba.results.LAL.filter(r => r[0] <= TODAY), lal = LAr[LAr.length - 1], INr = SEA.sports.nba.results.IND.filter(r => r[0] <= TODAY), ind = INr[INr.length - 1];
  const TL = await page.evaluate(() => __ask.tools.review_parlay({ source: 'legs', legs: [{ team: 'Pacers', market: 'win' }, { team: 'Lakers', market: 'over', line: 210.5 }, { player: 'Tyrese Maxey', stat: 'points', line: 20.5, date: '2026-11-21' }] }));
  check('typed team legs: a win from the final score, a game total vs its line, a dated player leg', TL.legs && TL.legs[0] === `${ind[3] > ind[4] ? '✓' : '✗'} Indiana Pacers to win: IND ${ind[3]}-${ind[4]} ${ind[1]} (${fmtD(ind[0])}) (${ind[3] > ind[4] ? 'won' : 'lost'} by ${Math.abs(ind[3] - ind[4])})`
    && TL.legs[1].startsWith(`${lal[3] + lal[4] > 210.5 ? '✓' : '✗'} Los Angeles Lakers game over 210.5: LAL ${lal[3]}-${lal[4]}`) && TL.legs[1].includes(`total ${lal[3] + lal[4]} vs 210.5`) && TL.legs[2].startsWith('✗ Tyrese Maxey over 20.5 points: 17 PTS'), JSON.stringify(TL.legs));

  // a yes / no leg (an anytime TD, line 0.5) that missed is never called a near miss
  const nflS = SEA.sports.nfl, td = r => r[3 + nflS.fields.indexOf('rtd')] + r[3 + nflS.fields.indexOf('ctd')];
  const rb = nflS.players.find(p => p.pos === 'RB' && p.gp >= 6 && nflS.players.filter(q => nameKey(q.n) === nameKey(p.n)).length === 1 && p.log.length && td(p.log[p.log.length - 1]) === 0);
  const TD0 = await page.evaluate(n => __ask.tools.review_parlay({ source: 'legs', legs: [{ player: n, stat: 'touchdowns', line: 0.5 }] }), rb.n);
  check('an anytime-TD leg with no TD: "1 touchdown short", not a near miss', TD0.legs && TD0.legs[0].startsWith(`✗ ${rb.n} over 0.5 touchdowns: 0 TD`) && /1 touchdown short \(needed 1\)/.test(TD0.legs[0]) && !/near miss/.test(TD0.legs[0]) && !TD0.near_misses, JSON.stringify(TD0.legs));

  // the track record
  await askQ(page, 'How did your picks do?');
  B = await lastBD(page);
  const G22 = D22.parlays.filter(P => P.result === 'won' || P.result === 'lost'), gl = G22.flatMap(P => P.legs).filter(L => L.res === true || L.res === false), exp = G22.reduce((s, P) => s + P.p, 0);
  check('"How did your picks do?" -> wins vs what the model expected, legs hit, from the graded days', B.tr && B.text.includes(`won ${G22.filter(P => P.result === 'won').length} of ${G22.length}`) && B.text.includes(`the model expected ${f1(exp)}`) && B.text.includes(`${gl.filter(L => L.res).length} of ${gl.length} graded legs hit`) && B.tr.tiles['Parlays won'] === `${G22.filter(P => P.result === 'won').length} of ${G22.length}`, B.text.slice(0, 200));
  check('track record card: by kind, the legs that broke parlays most, the lessons', /By kind/.test(B.tr.all) && /Legs that broke parlays most/.test(B.tr.all) && /Lessons/.test(B.tr.all), B.tr.all.slice(0, 200));

  // leaders
  await askQ(page, 'Who leads the NFL in rushing yards?');
  B = await lastBD(page);
  const LR = leadersOf('nfl', 'ryd');
  check('"Who leads the NFL in rushing yards?" -> season totals from the box scores, ranked', B.ld && JSON.stringify(B.ld.rows.slice(0, 3)) === JSON.stringify(LR.slice(0, 3).map(e => [e.n, e.v.toLocaleString('en-US')])) && B.text.includes(`1. ${LR[0].n}`), JSON.stringify(B.ld && B.ld.rows.slice(0, 3)));
  await askQ(page, 'NBA rebounds leaders per game');
  B = await lastBD(page);
  const mg = Math.max(2, Math.ceil(medGames('nba') / 2)), LB = leadersOf('nba', 'reb', true, mg);
  check('per-game leaders state the minimum-games rule (half the typical team\'s games)', B.ld && B.ld.rows[0][0] === LB[0].n && B.ld.rows[0][1] === f1(LB[0].x) && B.ld.rule.includes(`at least ${mg} games`), JSON.stringify(B.ld && [B.ld.rows[0], B.ld.rule]));

  // a team
  await askQ(page, 'How are the Lakers doing?');
  B = await lastBD(page);
  const lw = LAr.filter(r => r[3] > r[4]).length, ll = LAr.length - lw;
  check('"How are the Lakers doing?" -> record, points for and against a game, from the results', B.tm && B.tm.tiles.Record === `${lw}-${ll}` && B.text.includes(`${lw}-${ll} this season`) && B.tm.tiles['Scored / game'] === f1(mean(LAr.map(r => r[3]))) && B.tm.tiles['Allowed / game'] === f1(mean(LAr.map(r => r[4]))), JSON.stringify(B.tm && B.tm.tiles));
  check('team card: the last 10 newest first, researched form and trends with their caveats', B.tm.rows.length === Math.min(10, LAr.length) && B.tm.rows[0][0] === fmtD(lal[0]) && B.tm.secs.includes('Researched form') && /As favourite: won 12 of 15 \(the prices expected 10\.5\)/.test(B.tm.all) && /Past patterns, not predictions/.test(B.tm.all), JSON.stringify(B.tm.secs));
  await askQ(page, 'Kings record');
  B = await lastBD(page);
  check('a nickname two leagues share: one team, the other named (Kings)', B.tm && B.tm.name === 'Sacramento Kings' && /Also matching: Los Angeles Kings \(NHL\)/.test(B.text), B.text.slice(-160));

  // a football player's season
  await askQ(page, 'Josh Allen stats this season');
  B = await lastBD(page);
  const JA = sPl('nfl', 'Josh Allen');
  check('a QB\'s season: passing yards, passing TDs, attempts and rushing yards a game', B.ps && B.ps.name === 'Josh Allen' && B.ps.tiles['PASS YDS a game'] === f1(JA.T('pyd') / JA.gp) && B.ps.tiles['PASS TD a game'] === f1(JA.T('ptd') / JA.gp) && B.ps.tiles['RUSH YDS a game'] === f1(JA.T('ryd') / JA.gp), JSON.stringify(B.ps && B.ps.tiles));

  // the parser: breakdown questions find their intent, the old ones keep theirs
  const PI2 = await page.evaluate(() => { const f = q => { const I = __ask.parseIntent(q); return [I.kind, I.name || (I.p && I.p.n) || (I.e && I.e.name) || I.src || I.sp || '']; };
    return { cade: f('Is Cade Cunningham over 20.5 points?'), build: f("Build me today's parlay"), maxey: f('Is Tyrese Maxey over 24.5 points a good bet?'), rec: f('Lakers record'), day: f('how did your picks do yesterday'), lead: f('most points in the NBA'),
      mine: f('what went wrong with my last parlay'), hou: f('How does Houston look tonight?'), vs: f('how did Derrick Henry do vs the Bengals'), slip: f('is my parlay good?'), mars: f('What is the weather on Mars?') }; });
  check('parser: breakdown intents', JSON.stringify([PI2.rec, PI2.day, PI2.lead, PI2.mine, PI2.vs]) === JSON.stringify([['team', 'Los Angeles Lakers'], ['rparlay', 'picks'], ['leaders', 'nba'], ['rparlay', 'saved'], ['rplayer', 'Derrick Henry']]), JSON.stringify(PI2));
  check('parser: the old intents keep theirs (a full name off the slate beats a slate surname; build stays build)', PI2.cade[0] === 'seasononly' && PI2.cade[1] === 'Cade Cunningham' && PI2.build[0] === 'parlay' && PI2.maxey[0] === 'prop' && PI2.hou[0] === 'game' && PI2.slip[0] === 'slipq' && PI2.mars[0] === 'help', JSON.stringify(PI2));
  await askQ(page, 'how is my parlay doing');
  B = await lastBD(page);
  check('no saved parlays: a plain answer that says how to type the legs, no card', /no saved parlays in My Parlays/.test(B.text) && !B.pr, B.text);

  check('no horizontal scroll at 390 with every breakdown card on screen', await noHScroll(page));
  check('breakdown card buttons and links are 40px+ tap targets', await page.evaluate(() => [...document.querySelectorAll('.ask-ps button, .ask-rv button, .ask-pr button, .ask-tm button, .ask-ld button, .ask-tr button, .ask-news a')].every(b => b.getBoundingClientRect().height >= 40)));
  check('headline links are https only', await page.evaluate(() => [...document.querySelectorAll('.ask-thread a')].every(x => x.href.startsWith('https://'))));
  // history: the breakdown cards come back after a reload and are redrawn from the data
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-thread'));
  await page.waitForFunction(() => document.querySelector('.ask-ld') && document.querySelector('.ask-tm .ui-tile'), null, { timeout: 15000 });
  const HR = await page.evaluate(() => ({ ps: document.querySelectorAll('.ask-ps').length, pr: document.querySelectorAll('.ask-pr').length, tm: document.querySelectorAll('.ask-tm').length, ld: document.querySelectorAll('.ask-ld').length, tr: document.querySelectorAll('.ask-tr').length, rv: document.querySelectorAll('.ask-rv').length }));
  check('history: player, parlay review, team, leaders and track record cards survive a reload', HR.ps >= 1 && HR.pr >= 2 && HR.tm >= 2 && HR.ld >= 2 && HR.tr >= 1, JSON.stringify(HR));
  const RT = await page.evaluate(() => { const t0 = performance.now(); SB.goTab('insights'); SB.goTab('ask'); return performance.now() - t0; });
  check('render measured in the page with a history of breakdown cards: under 1,500 ms', RT < 1500, `${Math.round(RT)} ms`);
  check('no page errors (breakdowns, offline)', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await browser.close();
}

// ---------------------------------------------------------------- 5. breakdowns through the mocked capability: review_parlay, player_stats, review_player run as page tools
{
  const { page, errors, browser } = await open({ width: 390, tab: 'ask', notFound: ['mypicks.json'], pins: { 'recs.json': 'recs-askbd-2026-11-23.json', 'news.json': 'news-2026-11-24.json' } });
  await page.addInitScript(() => {
    localStorage.removeItem('fm2.chat'); window.__calls = [];
    const fake = async (input, options) => {
      window.__calls.push({ input, tools: (options.tools || []).map(t => t.name) });
      const T = n => options.tools.find(x => x.name === n), o = { signal: options.signal };
      window.__bd = {};
      window.__bd.parlay = await T('review_parlay').execute({ source: 'picks', day: '2026-11-22', title: 'same game' }, o);
      window.__bd.stats = await T('player_stats').execute({ player: 'Cade Cunningham', last: 5 }, o);
      window.__bd.review = await T('review_player').execute({ player: 'Cade Cunningham', date: '2026-11-22', stat: 'points', line: 30.5 }, o);
      try { await T('player_stats').execute({ player: 'Nobody Atall' }, o); } catch (e) { window.__bd.err = String(e && e.message); }
      const text = '**Missed on one leg:** Cade Cunningham scored 5 (see the cards).'; options.onText({ text, delta: text }); return { text, truncated: false };
    };
    fake.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
    window.claude = { use: async n => (n === 'sample' ? fake : null) };
  });
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-chip'));
  await page.waitForFunction(() => __ask.state.ai === 'ready');
  await askQ(page, 'What went wrong with the same game parlay yesterday, and how has Cade Cunningham been playing?');
  const M = await page.evaluate(() => { const c = window.__calls[0], a = document.querySelector('.ask-a:last-child'); return { rules: c.input[0].content, tools: c.tools, bd: window.__bd, sizes: Object.values(window.__bd).map(x => JSON.stringify(x).length),
    pr: !!a.querySelector('.ask-pr'), ps: !!a.querySelector('.ask-ps'), rv: (a.querySelector('.ask-rv .ui-verdict .t') || {}).textContent, prLegs: a.querySelectorAll('.ask-pr .ask-legs > li').length }; });
  check('the breakdown tools are offered to Claude', ['player_stats', 'review_player', 'review_parlay', 'team_report', 'leaders', 'track_record'].every(t => M.tools.includes(t)), JSON.stringify(M.tools));
  check('instructions: general knowledge only as background, labelled "general knowledge (may be out of date)", never mixed into this season', M.rules.includes('general knowledge (may be out of date)') && /never mix it into this season's numbers/.test(M.rules), '');
  check('instructions: breakdowns go facts, likely reasons (possibilities named), how close, what it says; no hindsight, never due', /1\) what happened/.test(M.rules) && /2\) why it likely happened/.test(M.rules) && /3\) how close it was/.test(M.rules) && /4\) what that says/.test(M.rules) && /never say a result was obvious/.test(M.rules) && /due/.test(M.rules), '');
  check('instructions: say when a player or team isn\'t in the app\'s data, and what it covers', /isn't in the app's data, say so plainly and say what the app covers/.test(M.rules) && /5 soccer leagues/.test(M.rules), '');
  const CCs = sPl('nba', 'Cade Cunningham');
  check('review_parlay through options.tools: the same game parlay, missed on 1 of 5, the breaking leg named', M.bd.parlay.result === 'missed: 1 of 5 legs' && M.bd.parlay.broke_it[0] === 'Cade Cunningham 15+ points' && M.bd.parlay.legs.length === 5 && Array.isArray(M.bd.parlay.what_it_says), JSON.stringify(M.bd.parlay).slice(0, 300));
  check('player_stats through options.tools: per-game points from the season totals, his last 5', M.bd.stats.per_game.points === +f1(CCs.T('pts') / CCs.gp) && M.bd.stats.games_this_season === CCs.gp && M.bd.stats.last_5_games.length === 5, JSON.stringify(M.bd.stats).slice(0, 300));
  check('review_player: a line only Claude wrote is ignored (the app\'s own 14.5 line is used, and Claude is told)', /line 30\.5 ignored/.test((M.bd.review.ignored || []).join(' ')) && M.rv === `Missed: ${CCs.rows.find(x => x.r[0] === '2026-11-22').r[4]} points vs 14.5` && Array.isArray(M.bd.review.why_facts) && Array.isArray(M.bd.review.why_possibilities), JSON.stringify(M.bd.review).slice(0, 300));
  check('the tool results are small plain data (under 32 KB each)', M.sizes.every(n => n < 32000), JSON.stringify(M.sizes));
  check('a player the app doesn\'t have: a plain error that says what the app covers', /No player named "Nobody Atall".*NFL, college football, the NBA, the NHL and 5 soccer leagues/.test(M.bd.err || ''), M.bd.err);
  check('the cards come from the engine: parlay review (5 legs), player card and review card under the answer', M.pr && M.prLegs === 5 && M.ps && !!M.rv, JSON.stringify([M.pr, M.prLegs, M.ps, M.rv]));
  check('no page errors (breakdowns through Claude)', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---------------------------------------------------------------- 6. hostile names, team names, titles, labels, headlines and links in every new card
{
  const H = `Zed "<img src=x onerror=window.__xss=1>" O'Neil`, HT = '<svg onload=window.__xss=2>Zed City';
  const SEA2 = JSON.parse(FX('season-2026-11-23.json')), nba = SEA2.sports.nba;
  nba.players.push({ n: H, t: 'ZZX', pos: '<b>G</b>', gp: 3, tot: [90, 180, 15, 9], log: [['2026-11-19', 'BOS', 1, 30, 60, 5, 3], ['2026-11-21', 'NY', 0, 30, 60, 5, 3], ['2026-11-23', 'MIA', 1, 30, 60, 5, 3]] });
  nba.teams.ZZX = HT; nba.results.ZZX = [['2026-11-19', 'BOS', 1, 120, 100], ['2026-11-21', 'NY', 0, 99, 101], ['2026-11-23', 'MIA', 1, 130, 90]];
  const RECS2 = JSON.parse(FX('recs-askbd-2026-11-23.json'));
  RECS2.days.unshift({ day: '2026-11-20', made: '2026-11-20T11:00:00Z', parlays: [{ id: 'mp-sgp5', tab: 'picks', title: '<img src=x onerror=window.__xss=3> SGP', p: 0.3, result: 'lost', legs: [{ gid: 'nba-NYK-ZZX-2026-11-21', key: 'P:zed-pts~nba-NYK-ZZX-2026-11-21:70', label: `${H} 70+ points`, p: 0.3, sport: 'nba', comp: 'NBA', home: 'NYK', away: 'ZZX', start: '2026-11-21T00:30:00Z', player: { name: H, team: 'ZZX', stat: 'pts', thr: 70, under: false }, res: false, actual: '60 pts' }] }] });
  const NEWS2 = JSON.parse(FX('news-2026-11-24.json'));
  NEWS2.items.unshift({ id: 'x1', sport: 'nba', league: 'NBA', headline: '<img src=x onerror=window.__xss=5> headline', published: '2026-11-24T20:00:00Z', type: 'story', link: 'javascript:window.__xss=6', athletes: [H], teams: [{ name: HT, abbr: 'ZZX' }] });
  const SAVED = [{ legs: [{ gid: 'nba-PHI-MIL-2026-11-21', key: 'H', label: '<img src=x onerror=window.__xss=4> PHI win', sport: 'nba', comp: 'NBA', home: 'PHI', away: 'MIL', start: '2026-11-21T00:00:00Z' }], p: 0.55, at: Date.parse('2026-11-20T20:00:00Z') }];
  const json = b => r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  const before = async pg => { await pg.route(/\/season\.json(\?.*)?$/, json(SEA2)); await pg.route(/\/recs\.json(\?.*)?$/, json(RECS2)); await pg.route(/\/news\.json(\?.*)?$/, json(NEWS2)); };
  const { page, errors, browser } = await open({ width: 390, tab: 'ask', notFound: ['mypicks.json'], before, init: { 'fm2.saved': SAVED } });
  await page.addInitScript(([h]) => {
    localStorage.removeItem('fm2.chat'); window.__mode = 'h1';
    const fake = async (input, options) => {
      const T = n => options.tools.find(x => x.name === n), o = { signal: options.signal };
      if (window.__mode === 'h1') { await T('player_stats').execute({ player: h }, o); await T('review_player').execute({ player: h }, o); await T('team_report').execute({ team: 'ZZX', sport: 'nba' }, o); await T('review_parlay').execute({ source: 'picks', day: '2026-11-20' }, o); }
      else { await T('review_parlay').execute({ source: 'saved' }, o); await T('leaders').execute({ sport: 'nba', stat: 'points', per_game: true, min_games: 1, n: 5 }, o); await T('track_record').execute({}, o); }
      options.onText({ text: 'See the cards.', delta: 'See the cards.' }); return { text: 'See the cards.', truncated: false };
    };
    fake.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
    window.claude = { use: async n => (n === 'sample' ? fake : null) };
  }, [H]);
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-chip'));
  await page.waitForFunction(() => __ask.state.ai === 'ready');
  await askQ(page, 'Tell me about this player and his team');
  await page.evaluate(() => { window.__mode = 'h2'; });
  await askQ(page, 'And my saved parlay, the leaders and your record');
  const X = await page.evaluate(([h, ht]) => { const T = document.querySelector('.ask-thread'), t = s => [...T.querySelectorAll(s)].map(e => e.textContent).join(' ');
    return { xss: window.__xss, tags: T.querySelectorAll('img, svg, script, b b').length, js: T.querySelectorAll('a[href^="javascript"]').length,
      ps: t('.ask-ps').includes(h) && t('.ask-ps').includes('<img src=x onerror=window.__xss=5> headline'), rv: t('.ask-rv').includes(h), tm: t('.ask-tm').includes(ht), pr: t('.ask-pr').includes(`${h} 70+ points`) && t('.ask-pr').includes('<img src=x onerror=window.__xss=3> SGP') && t('.ask-pr').includes('<img src=x onerror=window.__xss=4> PHI win'),
      ld: t('.ask-ld').includes(h), tr: !!T.querySelector('.ask-tr'), pos: t('.ask-ps').includes('<b>G</b>') }; }, [H, HT]);
  check('hostile names in every new card show as text: player card (name, position, headline), review, team, parlay reviews (title, labels), leaders', X.xss === undefined && X.tags === 0 && X.ps && X.pos && X.rv && X.tm && X.pr && X.ld && X.tr, JSON.stringify(X));
  check('a javascript: headline link is never drawn as a link', X.js === 0, JSON.stringify(X.js));
  check('no horizontal scroll at 390 with long hostile names in the cards', await noHScroll(page), JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ask-thread *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.ui-tablewrap')).slice(0, 6).map(e => e.tagName + '.' + e.className + ':' + e.textContent.slice(0, 40)))));
  check('no page errors (hostile data)', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---------------------------------------------------------------- 7. review fixes (2026-11-25): QB touchdowns, typed legs off the slate, traded players, two men with one
// name, one date rule, lines next to dates and signs, players who sat, pushes, future questions, the owner's wording, team questions, the
// global .hit class, a typed leg's sport, restored cards when a file fails
{
  const { page, errors, browser } = await open({ width: 390, tab: 'ask', notFound: ['mypicks.json'], pins: { 'recs.json': 'recs-askbd-2026-11-23.json', 'news.json': 'news-2026-11-24.json' } });
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await page.waitForSelector('.ask-chip');
  await page.waitForFunction(() => window.__ask && SB.DATA.recs, null, { timeout: 30000 });
  const lbl = (row) => `${row.r[2] ? 'vs' : '@'} ${row.r[1]}`;

  // a QB's "anytime TD" is a TD he scored, never the one he threw
  const BR = sPl('nfl', 'Jacoby Brissett'), br22 = BR.rows.find(x => x.r[0] === '2026-11-22'), brTd = BR.v(br22, 'rtd') + BR.v(br22, 'ctd');
  const Q1 = await page.evaluate(async () => { const T = __ask.tools; return { pr: await T.review_parlay({ source: 'legs', legs: [{ player: 'Jacoby Brissett', stat: 'anytime TD', line: 0.5, date: '2026-11-22' }] }), rp: await T.review_player({ player: 'Jacoby Brissett', stat: 'anytime touchdown', line: 0.5, date: '2026-11-22' }), ld: await T.leaders({ sport: 'nfl', stat: 'touchdowns', position: 'QB', n: 3 }) }; });
  check('a QB\'s anytime TD is graded on the TDs he scored (rushing + receiving), not the one he threw', brTd === 0 && BR.v(br22, 'ptd') >= 1 && Q1.pr.legs[0].startsWith('✗ Jacoby Brissett over 0.5 touchdowns: 0 TD') && Q1.rp.result === 'miss' && /^0 touchdowns/.test(Q1.rp.what_happened) && /rushing \+ receiving/.test(Q1.rp.note_stat || '') && Q1.pr.notes.some(n => /passing TDs are their own stat/.test(n)), JSON.stringify([Q1.pr.legs, Q1.rp.what_happened]));
  check('QB leaders by "touchdowns" stay passing TDs, and the title says so', /QB leaders · passing TDs/.test(Q1.ld.title), Q1.ld.title);

  // typed legs whose players have left the slate: every box-score full name is a leg, never the slate's first-name match
  await askQ(page, 'what went wrong with my parlay: Derrick Henry over 80.5 rushing yards and Jacoby Brissett anytime TD');
  let B = await lastBD(page);
  const DH = sPl('nfl', 'Derrick Henry'), dhL = DH.rows[DH.rows.length - 1], dhY = DH.v(dhL, 'ryd'), brL = BR.rows[BR.rows.length - 1];
  check('offline typed legs: Derrick Henry and Jacoby Brissett (box scores only) are both graded; no Henry Hasselbeck', B.pr && B.pr.legs.length === 2 && B.pr.legs[0].label === 'Derrick Henry over 80.5 rushing yards' && B.pr.legs[0].ic === (dhY > 80.5 ? '✓' : '✗') && B.pr.legs[0].sub.startsWith(`${dhY} RUSH YDS`)
    && B.pr.legs[1].label === 'Jacoby Brissett over 0.5 touchdowns' && B.pr.legs[1].ic === (BR.v(brL, 'rtd') + BR.v(brL, 'ctd') >= 1 ? '✓' : '✗') && !/Hasselbeck/.test(B.text + B.pr.all), JSON.stringify(B.pr && B.pr.legs.map(l => [l.ic, l.label, l.sub])));

  // a traded player: each game carries the team he played for
  const brOld = BR.rows.find(x => x.r[0] === '2026-11-01'), brOR = resOf('nfl', brOld.t, '2026-11-01');
  const Q3 = await page.evaluate(async () => ({ rv: await __ask.tools.review_player({ player: 'Jacoby Brissett', date: '2026-11-01' }), ps: await __ask.tools.player_stats({ player: 'Jacoby Brissett', last: 5 }) }));
  check('a traded player\'s old-team game is labelled with that team (score, facts, last games); his season is still one player', brOld.t === 'ARI' && Q3.rv.final_score.startsWith(`ARI ${brOR[3] > brOR[4] ? 'won' : 'lost'} ${brOR[3]}-${brOR[4]}`) && /\(ARI\) in this game/.test(Q3.rv.played_for || '')
    && Q3.rv.why_facts.some(x => x.startsWith('ARI ')) && !Q3.rv.why_facts.some(x => x.startsWith('BAL ')) && Q3.ps.last_5_games.some(x => x.startsWith('Nov 1 ') && x.includes('· ARI ')) && Q3.ps.games_this_season === BR.gp, JSON.stringify([Q3.rv.final_score, Q3.rv.played_for, Q3.ps.last_5_games]));
  await askQ(page, 'Jacoby Brissett last 5');
  B = await lastBD(page);
  const brCard = B.ps && B.ps.rows.find(r => r[0] === 'Nov 1');
  check('player card: an old-team game\'s result names that team', brCard && brCard[brCard.length - 1].startsWith(`ARI ${brOR[3] > brOR[4] ? 'W' : 'L'} ${brOR[3]}-${brOR[4]}`), JSON.stringify(B.ps && B.ps.rows));

  // two men with one name (Vitinha at PSG and at Genoa play the same weekends) are kept apart
  const VI = SEA.sports.soccer.players.filter(p => nameKey(p.n) === 'vitinha');
  const Q4 = await page.evaluate(() => __ask.tools.player_stats({ player: 'Vitinha', sport: 'soccer' }));
  const viP = VI.find(p => Q4.team.includes(`(${p.t})`)), viO = VI.find(p => p !== viP);
  check('two players named Vitinha are not merged: one man\'s games and team, the other named', VI.length === 2 && viP && Q4.games_this_season === viP.gp && Q4.last_5_games.every(x => x.includes(`· ${viP.t} `)) && Q4.notes.some(n => n.includes(`Vitinha (${viO.t}, soccer)`)), JSON.stringify([Q4.team, Q4.games_this_season, Q4.last_5_games, Q4.notes]));

  // one date string means one game in both tools (the UTC date player_stats lists); a US date the viewer typed uses the feed's start time
  const JJ = sPl('nba', 'Jalen Johnson'), jj21 = JJ.rows.find(x => x.r[0] === '2026-11-21'), DD = sPl('nba', 'Dyson Daniels'), dd27 = DD.rows.find(x => x.r[0] === '2026-10-27');
  const Q5 = await page.evaluate(async () => { const T = __ask.tools; return { jr: (await T.review_player({ player: 'Jalen Johnson', stat: 'points', date: '2026-11-21' })).game, jp: (await T.review_parlay({ source: 'legs', legs: [{ player: 'Jalen Johnson', stat: 'points', line: 20.5, date: '2026-11-21' }] })).legs[0],
    dr: (await T.review_player({ player: 'Dyson Daniels', stat: 'points', date: '2026-10-27' })).game, dp: (await T.review_parlay({ source: 'legs', legs: [{ player: 'Dyson Daniels', stat: 'points', line: 9.5, date: '2026-10-27' }] })).legs[0],
    us20: await T.review_player({ player: 'Tyrese Maxey', date: '2026-11-20', _us: true }), us21: await T.review_player({ player: 'Tyrese Maxey', date: '2026-11-21', _us: true }) }; });
  check('one date, one game: review_player and review_parlay\'s legs read 2026-11-21 / 2026-10-27 the same way (UTC)', Q5.jr === `Nov 21 ${lbl(jj21)} (UTC date)` && Q5.jp.includes(`(${lbl(jj21)} Nov 21:`) && Q5.dr === `Oct 27 ${lbl(dd27)} (UTC date)` && Q5.dp.includes(`(${lbl(dd27)} Oct 27:`), JSON.stringify([Q5.jr, Q5.jp, Q5.dr, Q5.dp]));
  check('a US date the viewer typed is matched by the feed\'s start time (PHI-MIL 18:00 UTC Nov 21 is Nov 21, not Nov 20)', /^Nov 21 vs MIL/.test(Q5.us21.game || '') && !/MIL/.test(Q5.us20.game || ''), JSON.stringify([Q5.us21.game, Q5.us20.game || Q5.us20.error]));

  // a line only Claude wrote never gets through on a date the viewer typed; a spread keeps its sign
  const Q6 = await page.evaluate(async () => { const T = __ask.tools, ctx = said => ({ card() {}, step() {}, q: said[0], said });
    return { a: await T.review_player({ player: 'Cade Cunningham', stat: 'points', line: 22.5, date: '2026-11-22' }, ctx(['How did Cade Cunningham do on Nov 22?'])),
      b: await T.review_parlay({ source: 'legs', legs: [{ player: 'Cade Cunningham', stat: 'points', line: 22.5, date: '2026-11-22' }] }, ctx(['what went wrong with my parlay on 11/22? Cade points'])),
      c: await T.review_parlay({ source: 'legs', legs: [{ team: 'Pistons', market: 'cover', line: -3.5, sport: 'nba', date: '2026-11-22' }] }, ctx(['did my Pistons +3.5 cover?'])),
      d: await T.review_parlay({ source: 'legs', legs: [{ team: 'Pistons', market: 'cover', line: 3.5, sport: 'nba', date: '2026-11-22' }] }, ctx(['did my Pistons +3.5 cover?'])),
      e: await T.review_player({ player: 'Cade Cunningham', stat: 'points', line: 22.5, date: '2026-11-22' }, ctx(['Did Cade go over 22.5 points on Nov 22?'])) }; });
  check('a date the viewer typed ("Nov 22", "11/22") never lets a line only Claude wrote through', (Q6.a.ignored || []).some(x => /line 22\.5 ignored/.test(x)) && /the app's line of 14\.5/.test(Q6.a.what_happened) && (Q6.b.ignored || []).some(x => /line 22\.5/.test(x)), JSON.stringify([Q6.a.what_happened, Q6.a.ignored, Q6.b.ignored]));
  check('a spread keeps its sign: the viewer\'s +3.5 turns away Claude\'s -3.5 and accepts +3.5', (Q6.c.ignored || []).some(x => /line -3\.5/.test(x)) && !Q6.d.ignored && /Detroit Pistons \+3\.5/.test(Q6.d.legs[0]), JSON.stringify([Q6.c.ignored, Q6.d.legs]));
  check('a line the viewer typed next to a date is used (22.5 on Nov 22)', !Q6.e.ignored && /a line of 22\.5/.test(Q6.e.what_happened), Q6.e.what_happened);

  // a player who sat his team's recent games: said first, in the tools and offline
  const SC = sPl('nba', 'Stephen Curry'), scL = SC.rows[SC.rows.length - 1], gsAfter = SEA.sports.nba.results.GS.filter(r => r[0] > scL.r[0] && r[0] <= TODAY);
  const Q7 = await page.evaluate(async d => ({ rv: await __ask.tools.review_player({ player: 'Stephen Curry' }), ps: await __ask.tools.player_stats({ player: 'Stephen Curry' }), leg: await __ask.tools.review_parlay({ source: 'legs', legs: [{ player: 'Stephen Curry', stat: 'points', line: 20.5, date: d }] }) }), gsAfter[0][0]);
  check('his latest game while GS has played since: "No box-score line for him in GS\'s N games since", first, in review_player and player_stats', gsAfter.length >= 1 && Q7.rv.why_facts[0].startsWith(`No box-score line for him in GS's ${gsAfter.length} game`) && /he did not play/.test(Q7.rv.why_facts[0]) && Q7.rv.games_missed_since === Q7.rv.why_facts[0] && Q7.ps.games_missed_since === Q7.rv.why_facts[0], JSON.stringify([Q7.rv.why_facts[0], Q7.ps.games_missed_since]));
  check('a typed leg on a day his team played without him says so (not just "no game")', /though GS (won|lost)/.test(Q7.leg.legs[0]) && /he did not play/.test(Q7.leg.legs[0]), Q7.leg.legs[0]);
  await askQ(page, 'How did Stephen Curry do last night?');
  B = await lastBD(page);
  check('offline "last night" for a player who sat: says he has no line last night and the games he missed, then his latest game', B.text.startsWith(`No box-score line for Stephen Curry last night (Nov 22). He has no line in GS's ${gsAfter.length} game`) && B.rv && B.rv.kick.includes(fmtD(scL.r[0])), B.text.slice(0, 220));
  await askQ(page, 'How did Tyrese Maxey do last night?');
  B = await lastBD(page);
  const MXr = sPl('nba', 'Tyrese Maxey'), mxLast = MXr.rows[MXr.rows.length - 1];
  check('offline "last night" when his last game was earlier: says so first, then reviews that game', mxLast.r[0] < '2026-11-22' && B.text.startsWith('No box-score line for Tyrese Maxey last night (Nov 22).') && B.rv && B.rv.kick.includes(fmtD(mxLast.r[0])), B.text.slice(0, 220));

  // a pushed leg is a push, not a hit
  const CCl = sPl('nba', 'Cade Cunningham'), ccv = CCl.rows[CCl.rows.length - 1].r[4], mxv = mxLast.r[4];
  await askQ(page, `how did my parlay do: Cade Cunningham over ${ccv} points and Tyrese Maxey over ${mxv - 6.5} points`);
  B = await lastBD(page);
  check('a pushed leg: "won with 1 push" (card: 1 of 2 hit, 1 pushed), never "hit: all 2 legs"', B.pr && B.pr.title === 'Won: 1 of 2 hit, 1 pushed' && B.pr.legs[0].ic === '=' && B.pr.tiles.Pushed === '1' && /won with 1 push/.test(B.text) && !/all 2 legs/.test(B.text), JSON.stringify(B.pr && [B.pr.title, B.pr.legs.map(l => l.ic), B.text.slice(0, 160)]));
  const Q9 = await page.evaluate(() => __ask.tools.review_parlay({ source: 'legs', legs: [{ player: 'Cade Cunningham', stat: 'points', line: 5, date: '2026-11-22' }] }));
  check('every leg pushed: "a push", stake back', /^a push: all 1 legs landed exactly on the line/.test(Q9.result), Q9.result);

  // the parser: games still to come are not breakdowns; the owner's wording is; team questions go to the team
  const PI3 = await page.evaluate(() => { const f = q => { const I = __ask.parseIntent(q); return [I.kind, I.name || (I.e && I.e.name) || I.src || '', I.line == null ? null : I.line, I.sp || '']; };
    return { o: Object.fromEntries([['cash', 'Will my parlay cash: Maxey over 24.5 points and Donovan Mitchell over 26.5 points?'], ['cash2', 'Can my parlay cash tonight? Maxey over 24.5 points and Mitchell over 26.5 points'],
      ['wed', 'Will Maxey score 25 points on Wednesday?'], ['d1124', 'Is Donovan Mitchell over 26.5 points on 11/24 a good bet?'], ['vs', 'Is Tyrese Maxey over 24.5 points vs Portland a good bet?'], ['avg', 'Maxey over 24.5 points, he is averaging 27, good bet?'],
      ['pg', 'Is Maxey over 24.5 points per game worth it?'], ['wrong', 'What went wrong with Maxey?'], ['right', 'What went right for Donovan Mitchell?'], ['over', 'Did Maxey go over 24.5 points?'], ['stats', 'Is Maxey averaging 25 points this season?'],
      ['missed', 'Did my parlay miss?'], ['was', 'How did Washington do last night?'], ['kc', 'What happened in the Chiefs game yesterday?'], ['dal', 'How did Dallas do?'],
      ['canyou', 'Can you review my last parlay?'], ['canlegs', 'Could you break down my parlay: Maxey over 20.5 points and Siakam over 20.5 points']].map(([k, q]) => [k, f(q)])),
      d: [__ask.dateIn('will maxey score 25 on wednesday'), __ask.dateIn('how did he do on wednesday'), __ask.dateIn('on 11/24'), __ask.dateIn('nov 22'), __ask.dateIn('marcus 25 points')] }; });
  const K = PI3.o;
  check('future questions are bets, not breakdowns ("will my parlay cash", "will he score 25 on Wednesday", "on 11/24", a line + "good bet")', ['cash', 'cash2'].every(k => K[k][0] === 'price') && ['wed', 'd1124', 'vs', 'avg', 'pg'].every(k => K[k][0] === 'prop'), JSON.stringify(K));
  check('the owner\'s wording is a breakdown ("what went wrong / right with X", "did X go over 24.5"); "averaging 25 this season" is his season', K.wrong[0] === 'rplayer' && K.wrong[1] === 'Tyrese Maxey' && K.right[0] === 'rplayer' && K.right[1] === 'Donovan Mitchell' && K.over[0] === 'rplayer' && K.over[2] === 24.5 && K.stats[0] === 'pstats' && K.missed[0] === 'rparlay', JSON.stringify(K));
  check('"can you / could you ..." asks the assistant: still a breakdown, not a future question', K.canyou[0] === 'rparlay' && K.canyou[1] === 'saved' && K.canlegs[0] === 'rparlay' && K.canlegs[1] === 'legs', JSON.stringify([K.canyou, K.canlegs]));
  check('team questions go to the team ("How did Washington do last night?", "the Chiefs game yesterday", "Dallas" is not FC Dallas)', K.was[0] === 'team' && /^Washington /.test(K.was[1]) && K.kc[0] === 'team' && K.kc[1] === 'Kansas City Chiefs' && K.dal[0] === 'team' && K.dal[1] !== 'FC Dallas' && K.dal[3] !== 'soccer', JSON.stringify([K.was, K.kc, K.dal]));
  check('dates: "will ... on Wednesday" is the coming one (future), "how did ... on Wednesday" the last one; 11/24 is future, not last year; "Marcus 25" is no date', JSON.stringify(PI3.d) === JSON.stringify([{ d: '2026-11-25', future: true }, { d: '2026-11-18', future: false }, { d: '2026-11-24', future: true }, { d: '2026-11-22', future: false }, {}]), JSON.stringify(PI3.d));
  await askQ(page, 'How did Washington do last night?');
  B = await lastBD(page);
  check('offline: "How did Washington do last night?" leads with that team\'s most recent result', B.tm && /^Washington .+, most recent result: /.test(B.text), B.text.slice(0, 200));

  // parlay-review rows never pick up the page's global .hit class (a pill that doesn't wrap)
  await askQ(page, 'what went wrong with my parlay: Amon-Ra St. Brown over 60.5 receiving yards and Shai Gilgeous-Alexander over 30.5 points and Tyrese Maxey over 10.5 points');
  const CL = await page.evaluate(() => { const L = [...document.querySelectorAll('.ask-a:last-child .ask-legs > li')]; return { n: L.length, cls: L.map(li => li.className), bad: L.some(li => li.classList.contains('hit') || li.classList.contains('miss')), ws: L.map(li => getComputedStyle(li).whiteSpace) }; });
  check('parlay-review rows are lg-hit / lg-miss (no global .hit pill), they wrap, and the page doesn\'t scroll sideways at 390', CL.n === 3 && !CL.bad && CL.cls.some(c => /lg-hit/.test(c)) && CL.ws.every(w => w === 'normal') && await noHScroll(page), JSON.stringify(CL));

  // a typed leg's sport picks the player (Jaden Bradley: the NFL receiver, not the NBA guard)
  const JB = SEA.sports.nfl.players.find(p => nameKey(p.n) === 'jaden-bradley');
  const Q8 = await page.evaluate(() => __ask.tools.review_parlay({ source: 'legs', legs: [{ player: 'Jaden Bradley', stat: 'receptions', line: 2.5, sport: 'nfl' }] }));
  check('a typed leg\'s sport is used (NFL receptions, his WSH game; not the NBA player\'s points)', JB && / over 2\.5 receptions: \d+ REC \(/.test(Q8.legs[0]) && Q8.legs[0].includes(`${JB.log[0][2] ? 'vs' : '@'} ${JB.log[0][1]}`), Q8.legs[0]);

  // history before a failed load: a team, leaders and the track record too
  await askQ(page, 'Who leads the NFL in rushing yards?');
  await askQ(page, 'How did your picks do?');
  check('no page errors (review fixes)', errors.length === 0, errors.join(' | '));
  // season.json and recs.json failing on the next visit: restored cards say the file didn't load
  await page.route(/\/(season|recs)\.json(\?.*)?$/, r => r.fulfill({ status: 404, body: 'nf' }));
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender && document.querySelector('.ask-thread'));
  await page.waitForFunction(() => !document.querySelector('.ask-wait'), null, { timeout: 15000 });
  const FL = await page.evaluate(() => ({ gone: [...document.querySelectorAll('.ask-gone')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), cards: document.querySelectorAll('.ask-ps, .ask-rv, .ask-pr, .ask-tm, .ask-ld, .ask-tr').length }));
  check('season.json / recs.json failing: restored cards say the file didn\'t load (never "no longer in the box scores", "no graded parlays", "no results")', FL.gone.length >= 6 && FL.cards === 0 && FL.gone.some(x => /season\.json\) didn't load/.test(x)) && FL.gone.some(x => /recs\.json\) didn't load/.test(x)) && !FL.gone.some(x => /no longer in the app's season box scores|No graded parlays yet|no results for this team/.test(x)), JSON.stringify(FL));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await browser.close();
}

// ---------------------------------------------------------------- 3. wide screen
{
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'ask' });
  await page.waitForSelector('.ask-chip');
  const W = await page.evaluate(() => { const h = document.querySelector('.ask-hero').getBoundingClientRect(), p = document.querySelector('.ask-panel').getBoundingClientRect(); return { side: h.right <= p.left, top: Math.abs(h.top + h.height / 2 - (p.top + p.height / 2)) < 160 }; });
  check('1440: the header and the chat panel sit side by side', W.side && W.top, JSON.stringify(W));
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  check('1440: no horizontal scroll with a card', await noHScroll(page));
  await askQ(page, 'How did Cade Cunningham do on Nov 22?');
  const WR = await page.evaluate(() => { const c = document.querySelector('.ask-a:last-child .ask-rv'); return c ? { w: c.getBoundingClientRect().width, t: c.querySelector('.ui-verdict .t').textContent } : null; });
  check('1440: a review card without the app\'s picks file compares with his average, at most 620px wide', WR && WR.w <= 621 && /vs his average/.test(WR.t) && await noHScroll(page), JSON.stringify(WR));
  check('no page errors (1440)', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await done(browser);
}
