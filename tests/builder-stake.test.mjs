// Parlay builder: the stake box next to the leg count and the payout it shows (index.html).
// Run: node tests/builder-stake.test.mjs. Uses the app's own data; if no game has two priced legs right now, the
// slip checks are reported as SKIP (not PASS) so a quiet slate can't hide a broken builder.
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
let fails = 0, skips = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
// a saved slate, so the check always has real games to build legs from (the live slate can be quiet)
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FEED }));
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && window.__fm2 && SB.firstRender, null, { timeout: 60000 });
  const built = await page.evaluate(() => {
    for (const g of SB.DATA.games.filter(g => SB.priced(g))) {
      const mk = __fm2.marketsFor(g);
      for (const a of mk) for (const b of mk) {
        if (a.group === b.group) continue;  // two outcomes of one market can't both win (Home + Away give 0%)
        SB.setSlip([]);
        if (SB.toggleLeg(g.id, a.key) !== true || SB.toggleLeg(g.id, b.key) !== true) continue;
        if (__fm2.parlayProb(SB.slip).p > 0) { SB.openSlip(); return { legs: SB.slip.length }; }
      }
    }
    SB.setSlip([]);
    return null;
  });
  if (!built) {
    skips++;
    console.log('SKIP stake box and payout :: no game with two priced legs right now');
  } else {
    await page.waitForSelector('#stakeTop', { timeout: 10000 });
    const p = await page.evaluate(() => __fm2.parlayProb(SB.slip).p);
    check('stake box shows $10 by default and the lower stake box matches it',
      (await page.inputValue('#stakeTop')) === '10' && (await page.inputValue('#stake')) === '10');
    const fair10 = `$${(10 / p).toFixed(2)}`;
    check('payout at fair odds for $10 is shown', (await page.textContent('#payTop')).includes(fair10), `${await page.textContent('#payTop')} (want ${fair10})`);
    await page.fill('#stakeTop', '25');
    const fair25 = `$${(25 / p).toFixed(2)}`;
    check('typing $25 updates the payout and the lower stake box',
      (await page.textContent('#payTop')).includes(fair25) && (await page.inputValue('#stake')) === '25', `${await page.textContent('#payTop')} (want ${fair25})`);
    const profit = `$${(25 / p - 25).toFixed(2)}`;
    check('profit is shown next to the payout', (await page.textContent('#payTop')).includes(`(profit ${profit})`));
    await page.fill('#bookOdds', '+200');
    await page.waitForTimeout(100);
    check("a book price adds the payout at that price ($25 at +200 = $75.00)", (await page.textContent('#payTop')).includes('$75.00'), await page.textContent('#payTop'));
    await page.fill('#stakeTop', '');
    check('empty stake: asks for a stake instead of showing $0', (await page.textContent('#payTop')).includes('Enter a stake'));
    await page.fill('#stake', '12');
    check('typing in the lower box also moves the top payout',
      (await page.inputValue('#stakeTop')) === '12' && (await page.textContent('#payTop')).includes(`$${(12 / p).toFixed(2)}`));
    await page.fill('#stakeTop', '25');
    await page.click('#saveP');
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fm2.saved') || '[]').at(-1));
    check('save to My Parlays records the $25 stake', !!saved && saved.stake === 25, JSON.stringify(saved && { stake: saved.stake, legs: saved.legs.length }));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('390px: no horizontal scroll with the stake row', over <= 0, `${over}px over`);
  }
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASS'}${skips ? `, ${skips} skipped (no live legs)` : ''}`);
process.exit(fails ? 1 : 0);
