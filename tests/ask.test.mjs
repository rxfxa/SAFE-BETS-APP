// Chat (ask.js): the empty state, offline answers (prop card with verdict, game log and 4 factors; a 3-leg NBA parlay; a price
// that turns the verdict into an edge read), slip / navigation buttons, history across a reload, params, and Claude through a
// MOCKED `sample` capability (a page tool runs, its card renders, the text streams, model text is never HTML, errors handled).
// Review additions: the name matcher (hyphenated / shared surnames, first names, dotted initials), markets the app has no line
// for, the UTC log-date rule, under bars, the price-only verdict kicker, render time measured in the page, focus and the live
// region, and on the Claude side: a price or line only Claude wrote never reaches a card, the no-tools path sends cache:false,
// every error code, the tools limit, and New chat during a slow call.
import { open, check, done } from './lib/harness.mjs';

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
    fakeSample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 7 } });
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
  check('page tools offered: find_players, prop_report, game_report, build_parlay, price_parlay, top_props (+ start_sit); a signal; no cache with tools', ['find_players', 'prop_report', 'game_report', 'build_parlay', 'price_parlay', 'top_props'].every(t => M.tools.includes(t)) && M.signal && M.cache === undefined, JSON.stringify(M.tools));
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
  check('limits(): the tools limit is read (maxCount 7)', await page.evaluate(() => __ask.state.maxTools === 7));
  await page.evaluate(() => { __ask.state.maxTools = 3; window.__mock = 'fine'; });
  await askQ(page, 'Best props tonight?');
  const MT = await page.evaluate(() => window.__calls[window.__calls.length - 1].tools);
  check('a view that allows 3 tools gets the 3 that matter most (prop_report first)', JSON.stringify(MT) === '["prop_report","build_parlay","game_report"]', JSON.stringify(MT));
  await page.evaluate(() => { __ask.state.maxTools = 7; });

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

// ---------------------------------------------------------------- 3. wide screen
{
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'ask' });
  await page.waitForSelector('.ask-chip');
  const W = await page.evaluate(() => { const h = document.querySelector('.ask-hero').getBoundingClientRect(), p = document.querySelector('.ask-panel').getBoundingClientRect(); return { side: h.right <= p.left, top: Math.abs(h.top + h.height / 2 - (p.top + p.height / 2)) < 160 }; });
  check('1440: the header and the chat panel sit side by side', W.side && W.top, JSON.stringify(W));
  await askQ(page, 'Is Tyrese Maxey over 24.5 points a good bet?');
  check('1440: no horizontal scroll with a card', await noHScroll(page));
  check('no page errors (1440)', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => localStorage.removeItem('fm2.chat'));
  await done(browser);
}
