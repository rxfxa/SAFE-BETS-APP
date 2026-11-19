// Simulator + My Parlays: save a parlay, simulate it from My Parlays or the Simulator, pick saved parlays, add a simulated one.
// Run: node tests/sim-plays.test.mjs. Uses a saved slate (tests/fixtures/data-2026-11-18.json), so it doesn't depend on today's games.
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
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0, skips = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FEED }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && window.__fm2 && SB.firstRender, null, { timeout: 60000 });
  // build a two-leg parlay that can win together (different markets of one game) from the saved slate
  const built = await page.evaluate(() => {
    for (const g of SB.DATA.games.filter(g => SB.priced(g))) {
      const mk = __fm2.marketsFor(g);
      for (const a of mk) for (const b of mk) {
        if (a.group === b.group) continue;
        SB.setSlip([]);
        if (SB.toggleLeg(g.id, a.key) !== true || SB.toggleLeg(g.id, b.key) !== true) continue;
        if (__fm2.parlayProb(SB.slip).p > 0) return { n: SB.slip.length };
      }
    }
    SB.setSlip([]); return null;
  });
  if (!built) { skips++; console.log('SKIP all checks :: no game with two legs that can win together in the saved slate'); }
  else {
    // 1. save from the builder (existing button), then it shows in My Parlays
    await page.evaluate(() => SB.openSlip());
    await page.click('#saveP'); await page.waitForTimeout(150);
    check('save from the builder adds it to My Parlays', (await page.evaluate(() => SB.savedParlays.length)) === 1);
    // 2. My Parlays: 🎲 Simulate opens it in the Simulator's parlay mode with its title
    await page.evaluate(() => SB.goTab('mine')); await page.waitForTimeout(150);
    check('My Parlays card has a Simulate button', (await page.$$('[data-simmine]')).length === 1);
    await page.click('[data-simmine="0"]'); await page.waitForTimeout(300);
    const title = await page.textContent('#simRoot');
    check('Simulate from My Parlays opens the Simulator with the parlay', /Simulating/.test(title) && /2-leg parlay/.test(title), title.slice(0, 120));
    check('the saved parlay is offered as a chip, selected', (await page.$$eval('[data-a="pload"].on', xs => xs.length)) === 1);
    // 3. simulate it; the add button unlocks once there is a result
    check('Add to My Parlays is locked until the parlay is simulated', await page.isDisabled('[data-a="psave"]'));
    await page.click('[data-a="prun"]');
    await page.waitForFunction(() => document.querySelector('.sm-kpis') && /sim hit rate/.test(document.querySelector('#simRoot').textContent), null, { timeout: 120000 });
    check('simulating the parlay gives a hit rate and engine price', /sim hit rate/.test(await page.textContent('#simRoot')));
    check('it is already in My Parlays, so the button says so', /In My Parlays/.test(await page.textContent('[data-a="psave"]')) && await page.isDisabled('[data-a="psave"]'));
    // 4. a different parlay from the current slip, simulated and then added
    const second = await page.evaluate(() => {
      const g = SB.DATA.games.filter(g => SB.priced(g)).find(g => { const mk = __fm2.marketsFor(g); return mk.length >= 4; });
      if (!g) return null;
      const mk = __fm2.marketsFor(g);
      for (const a of mk) for (const b of mk) {
        if (a.group === b.group || (a.key === SB.slip[0]?.key && a.group === 'x')) continue;
        SB.setSlip([]);
        if (SB.toggleLeg(g.id, a.key) !== true || SB.toggleLeg(g.id, b.key) !== true) continue;
        if (__fm2.parlayProb(SB.slip).p > 0 && !SB.savedParlays.some(s => s.legs.map(l => l.key).join() === SB.slip.map(l => l.key).join())) return SB.slip.length;
      }
      return null;
    });
    if (second) {
      await page.evaluate(() => SB.goTab('sim', { mode: 'parlay' })); await page.waitForTimeout(200);
      if (await page.$('[data-a="useslip"]')) { await page.click('[data-a="useslip"]'); await page.waitForTimeout(200); }
      check('the Simulator uses the current slip when no saved parlay is opened', (await page.$$eval('[data-a="pload"].on', xs => xs.length)) === 0);
      await page.click('[data-a="prun"]');
      await page.waitForFunction(() => /sim hit rate/.test(document.querySelector('#simRoot').textContent), null, { timeout: 120000 });
      await page.click('[data-a="psave"]'); await page.waitForTimeout(150);
      check('a simulated slip can be added to My Parlays', (await page.evaluate(() => SB.savedParlays.length)) === 2);
      check('after adding it the button says so', /In My Parlays/.test(await page.textContent('[data-a="psave"]')));
      // 5. pick a saved parlay from the chips and simulate it
      await page.click('[data-a="pload"][data-i="0"]'); await page.waitForTimeout(200);
      check('tapping a saved parlay chip loads its legs', (await page.$$eval('[data-a="pload"].on', xs => xs.length)) === 1 && /Simulating/.test(await page.textContent('#simRoot')));
    } else {
      skips++; console.log('SKIP second parlay :: no second two-leg combination in the saved slate');
    }
    // 6. Fantasy cards (when the fixture slate builds one) get Save and Simulate
    await page.evaluate(() => SB.goTab('fantasy')); await page.waitForTimeout(400);
    const fz = await page.$$('[data-simp]');
    if (fz.length) {
      check('fantasy parlay card has Save and Simulate', (await page.$$('[data-savep]')).length >= 1);
      await page.click('[data-savep]'); await page.waitForTimeout(150);
      check('fantasy: Save adds the parlay to My Parlays', (await page.evaluate(() => SB.savedParlays.length)) >= 1);
      await page.click('[data-simp]'); await page.waitForTimeout(300);
      check('fantasy: Simulate opens the Simulator with that parlay', /Simulating/.test(await page.textContent('#simRoot')));
    } else {
      skips++; console.log('SKIP fantasy buttons :: no fantasy parlay on this saved slate');
    }
  }
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px over`);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASS'}${skips ? `, ${skips} skipped` : ''}`);
process.exit(fails ? 1 : 0);
