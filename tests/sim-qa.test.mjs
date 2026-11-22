// Simulator QA regressions: saved parlays with Slip Check legs, Slip Check game lines in every sport, handoffs that leave legs
// out, legs that can't all win, the anytime-scorer price label, busted live slips and the Odds Tools → Hedge link.
// Run: node tests/sim-qa.test.mjs. Uses a saved slate (tests/fixtures/data-2026-11-22.json) at a fixed clock before kick-off.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-22.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.clock.setFixedTime(new Date('2026-11-22T06:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FEED }));
const runParlay = async n => { await page.evaluate(() => { window.__prevPar = __sim.PAR; }); await page.click('[data-a="prun"]');
  await page.waitForFunction(k => !__sim.RUN.active && __sim.PAR && __sim.PAR !== window.__prevPar && __sim.PAR.per.length === k, n, { timeout: 120000 }); };
const SOC = 'soccer-BAR-VIL-2026-11-22';
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__sim && window.__slipcheck, null, { timeout: 60000 });
  // games: an NHL game (same-game Slip Check lines), an NBA game (Slip Check total), an NFL game (a player leg kept as text)
  const G = await page.evaluate(() => {
    const ok = g => SB.priced(g) && SB.fit(g) && SB.openG(g);
    const nhl = SB.gameById('nhl-NYR-CAR-2026-11-22'), nba = SB.DATA.games.find(g => g.sport === 'nba' && ok(g)), nfl = SB.DATA.games.find(g => g.sport === 'nfl' && ok(g));
    return nhl && ok(nhl) && nba && nfl ? { nhl: nhl.id, nba: nba.id, nbaT: Math.floor(SB.fit(nba).T) + .5, nfl: nfl.id } : null;
  });
  check('the saved slate has open NHL, NBA and NFL games', !!G, JSON.stringify(G));
  if (G) {
    // 1. a parlay tracked from Slip Check: game lines as SC: keys, a player leg as a hand-graded custom leg with its chance (p1)
    const legs = [{ gid: G.nhl, key: 'SC:ml:H', label: 'Rangers ML', p1: .42 }, { gid: G.nhl, key: 'SC:tot:O:5.5', label: 'Over 5.5', p1: .55 },
      { gid: G.nba, key: `SC:tot:O:${G.nbaT}`, label: 'NBA over' }, { gid: G.nfl, key: 'X:Test%20Back%20over%2020.5%20(rushing)', label: 'Test Back over 20.5 Rushing yards', custom: true, p1: .44 }];
    await page.evaluate(L => { SB.saveParlay({ legs: L, p: .05, src: 'slipcheck' }); SB.setSlip([]); SB.goTab('sim', { mode: 'parlay' }); }, legs);
    await page.click('[data-a="pload"][data-i="0"]');
    const pre = await page.evaluate(() => [...document.querySelectorAll('.sm-pl')].map(x => x.textContent));
    check('a saved custom leg keeps its saved label and chance (not 0.0%)', /Test Back over 20\.5 Rushing yards/.test(pre[3]) && /44\.0%/.test(pre[3]) && /saved/.test(pre[3]) && !/X:/.test(pre.join()), pre[3]);
    await runParlay(4);
    const R = await page.evaluate(L => {
      const P = __sim.PAR, eng = __fm2.parlayProb(L.slice(0, 3)).p * .44;
      return { how: P.per.map(x => x.how), sim: P.per.map(x => x.sim), p: P.per.map(x => x.p), hit: P.hit, eng: P.eng, want: eng, notes: P.notes.join(' | '), agree: document.getElementById('smAgree').textContent };
    }, legs);
    check('Slip Check game lines (NHL, NBA) are settled on the simulated games; the custom leg is drawn at its saved chance', R.how.join() === 'sim,sim,sim,saved', JSON.stringify(R.how));
    check('no game line is "drawn independently"', !/drawn independently\./.test(R.notes) && /drawn independently at the 44\.0% saved with it/.test(R.notes), R.notes);
    check('each simulated leg lands near its engine chance', R.sim.every((s, i) => Math.abs(s - R.p[i]) < .03), JSON.stringify({ sim: R.sim, p: R.p }));
    check('engine reference = engine legs x the saved chance, and the sim hit rate is near it', Math.abs(R.eng - R.want) < 1e-9 && R.eng > 0 && Math.abs(R.hit - R.eng) < Math.max(.01, .12 * R.eng), JSON.stringify({ hit: R.hit, eng: R.eng }));
    // 2. a handoff that left legs out says so, with the sender's own chance
    await page.evaluate(L => SB.goTab('sim', { legs: L.slice(0, 2), title: 'Slip check', from: 'slipcheck', p: .014, dropped: ['Kaelon Black over 20.5', 'George Kittle over 4.5'], price: '+600', stake: 25 }), legs);
    const ho = await page.textContent('#simRoot'), bk = await page.evaluate(() => [document.getElementById('smBp').value, __sim.S.bank.stake]);
    check('handoff: the slip’s own book price and stake prefill the bankroll sim', bk[0] === '+600' && bk[1] === 25, JSON.stringify(bk));
    check('handoff: the sender’s chance and the legs it couldn’t send are named', /Slip Check priced it at 1\.4%/.test(ho) && /2 of its legs aren’t here \(Kaelon Black over 20\.5, George Kittle over 4\.5\)/.test(ho) && /for the 2 legs listed/.test(ho), ho.slice(ho.indexOf('Simulating'), ho.indexOf('Simulating') + 400));
    // 3. a custom leg with no chance at all is left out and said to be, not priced at 0%
    await page.evaluate(L => { SB.saveParlay({ legs: [L[0], { gid: 'x-1-1', key: 'X:Mystery%20leg', label: 'Mystery leg', custom: true }], p: .4, src: 'slipcheck' }); SB.goTab('sim', { mode: 'parlay' }); }, legs);
    await page.click('[data-a="pload"][data-i="1"]');
    const nb = await page.evaluate(() => document.querySelectorAll('.sm-pl')[1].textContent);
    check('an unpriced leg shows "no price", not 0.0%', /no price/.test(nb) && !/0\.0%/.test(nb), nb);
    await runParlay(2);
    const np = await page.evaluate(() => ({ t: document.getElementById('simRoot').textContent, how: __sim.PAR.per.map(x => x.how), save: document.querySelector('[data-a="psave"]').disabled }));
    check('the run leaves it out and says so; it can’t be re-saved with a partial chance', np.how.join() === 'sim,none' && /1 leg has no price and is left out/.test(np.t) && np.save, JSON.stringify(np.how));
  }
  // 4. legs that can't all win together: both models at 0 -> no "differs", no ±0.00, no save
  const ag = await page.evaluate(() => [__sim.parAgree({ hit: 0, eng: 0, N: 1e5 }), __sim.parAgree({ hit: 0, eng: 1e-5, N: 1e5 }).ok, __sim.parAgree({ hit: 0, eng: 1e-3, N: 1e5 }).ok, __sim.parAgree({ hit: .01, eng: 0, N: 1e5 }).ok]);
  check('agreement: 0 vs 0 = can’t win; no hits vs a 0.001% engine chance is within noise; 0 vs 0.1% and hits vs 0 differ', ag[0].ok && ag[0].zero && ag[1] && !ag[2] && !ag[3], JSON.stringify(ag));
  await page.evaluate(id => { SB.setSlip([{ gid: id, key: 'HWN' }, { gid: id, key: 'CS2-1' }]); SB.goTab('sim', { mode: 'parlay' }); }, SOC);
  if (await page.$('[data-a="useslip"]')) await page.click('[data-a="useslip"]'); // back from the saved parlay to the slip
  await runParlay(2);
  const z = await page.evaluate(() => ({ a: document.getElementById('smAgree').textContent, k: document.querySelector('.sm-kpis').textContent, save: document.querySelector('[data-a="psave"]').disabled }));
  check('contradictory legs: the note says they can’t all win, not that the models differ', /can’t all win together/.test(z.a) && !/differ/.test(z.a) && !/—/.test(z.a), z.a);
  check('no hits: the hit rate says 0 of 100,000 instead of ±0.00, and it can’t be saved', /0 of 100,000/.test(z.k) && !/±0\.00/.test(z.k) && z.save, z.k);
  // 5. Live: a leg that can no longer win reads "lost" and the slip is busted
  await page.evaluate(id => { SB.setSlip([{ gid: id, key: 'H' }, { gid: id, key: 'HWN' }]); SB.goTab('sim', { gid: id, mode: 'live' }); }, SOC);
  await page.waitForSelector('#smLiveOut .sm-lrow', { timeout: 60000 });
  await page.evaluate(() => { const r = document.getElementById('smLmin'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('[data-a="lstep"][data-k="a"][data-d="1"]');
  const lv = await page.evaluate(() => ({ t: document.getElementById('smLiveOut').textContent, rows: [...document.querySelectorAll('#smLiveOut .sm-lrow')].map(x => x.textContent) }));
  const wtn = lv.rows.find(x => /win to nil/i.test(x)) || '';
  check('live: a leg that can no longer win reads "already lost" / lost', /already lost/.test(wtn) && /lost$/.test(wtn), wtn);
  check('live: the slip is marked busted, with no hedge link', /Busted/.test(lv.t) && /so the slip has lost/.test(lv.t) && !/Odds Tools → Hedge/.test(lv.t), lv.t.slice(lv.t.indexOf('Your slip'), lv.t.indexOf('Your slip') + 300));
  await page.click('[data-a="lstep"][data-k="h"][data-d="1"]');
  const bt = await page.evaluate(() => [...document.querySelectorAll('#smLiveOut .sm-lrow')].map(x => x.textContent).find(x => /Both teams score/.test(x)) || '');
  check('live: a landed leg reads "already won"', /already won/.test(bt) && /won$/.test(bt), bt);
  // 6. the hedge link lands on the Hedge calculator
  await page.evaluate(id => SB.setSlip([{ gid: id, key: 'H' }]), SOC);
  await page.click('[data-a="lstep"][data-k="a"][data-d="-1"]');
  await page.click('#smLiveOut [data-a="hedge"]');
  await page.waitForTimeout(300);
  const hg = await page.evaluate(() => { const p = document.getElementById('o-hedge').closest('.panel').getBoundingClientRect(); return { top: Math.round(p.top), y: Math.round(scrollY), h: innerHeight }; });
  check('Odds Tools → Hedge scrolls the Hedge calculator into view', hg.y > 0 && hg.top >= 0 && hg.top < hg.h / 2, JSON.stringify(hg));
  // 7. anytime-scorer rows: the fair price is labelled as the anytime price, next to it
  const sg = await page.evaluate(() => SB.DATA.games.filter(g => g.sport === 'soccer' && SB.priced(g) && SB.fit(g) && SB.openG(g)).map(g => ({ id: g.id, n: __sim.S && 0 })).slice(0, 40).map(x => x.id));
  const gid = await page.evaluate(ids => { const c = ids.map(id => SB.gameById(id)); return (c.find(g => g.id === 'soccer-LFC-MUN-2026-11-22') || c[0] || {}).id; }, sg);
  await page.evaluate(id => SB.goTab('sim', { gid: id, mode: 'game' }), gid);
  await page.click('#smRun');
  await page.waitForFunction(() => !__sim.RUN.active, null, { timeout: 120000 });
  const sc = await page.evaluate(() => [...document.querySelectorAll('[data-grp="scorers"] .sm-row .l > span')].map(x => x.textContent));
  if (!sc.length) check('scorer rows (skipped: no scorer data for ' + gid + ')', true);
  else check('scorer rows: "anytime fair" leads, first-scorer chance after it', sc.every(t => /^anytime fair [+−-]?\d/.test(t) && /· first scorer \d/.test(t)), sc[0]);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
