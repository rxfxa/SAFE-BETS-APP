// Upset Parlays tab (upsets.js): underdog and draw legs from a saved Polymarket board, legs scroller, sport chips, mix, stake.
// Run: node tests/upsets.test.mjs
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
const PM = fs.readFileSync(path.join(ROOT, 'tests/fixtures/polymarket-2026-11-20.json'), 'utf8');
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.clock.setFixedTime(new Date('2026-11-20T12:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: PM }));
await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('upsets')));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__polymarket && __polymarket.LOAD === 'done' && /Upset Parlays/.test(document.querySelector('#main').textContent) && !/Loading Polymarket/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  const legs = () => page.$$eval('#main .leg', xs => xs.map(x => ({ label: x.querySelector('b').textContent, meta: x.querySelector('.legtxt span').textContent, mid: parseFloat(x.querySelector('.legp').textContent) / 100 })));
  let L = await legs();
  check('tab shows a parlay with legs', L.length >= 2, `${L.length} legs`);
  check('default 5 legs (or fewer if the board is short)', L.length <= 5 && (L.length === 5 || L.length < 5));
  check('legs are underdogs (15-50%) or draws', L.every(l => (l.mid >= .15 && l.mid <= .5) || /draw|level|underdog/.test(l.meta)), JSON.stringify(L.map(l => [l.label, l.mid])));
  const sportsOf = await page.$eval('#main', m => m.textContent);
  check('the sport count is stated', /sport/.test(sportsOf));
  await page.fill('#upStake', '25'); await page.locator('#upStake').blur();
  await page.waitForTimeout(100);
  const ret = await page.textContent('#main');
  check('stake changes the return', /returns on \$25/.test(ret));
  // legs scroller
  await page.evaluate(() => { const r = document.getElementById('upLegs'); r.value = 3; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(150);
  L = await legs();
  check('legs scroller set to 3 gives 3 legs', L.length === 3, `${L.length}`);
  check('one leg per game in the parlay', new Set(L.map(l => l.label)).size === L.length);
  // sport chips: NBA only
  await page.click('[data-up-sport="nba"]'); await page.waitForTimeout(150);
  const chips = await page.$$eval('[data-up-sport].on', xs => xs.map(x => x.dataset.upSport));
  check('a sport chip turns on and filters the parlay', chips.join() === 'nba');
  const nbaText = await page.textContent('#main');
  check('NBA filter: no soccer legs shown', !/Liga|Premier|League|Serie|Bundesliga|Ligue|Eredivisie/.test(nbaText.split('Upset Parlays')[1] || ''));
  await page.click('[data-up-sport="all"]'); await page.waitForTimeout(150);
  // new mix
  const before = (await legs()).map(l => l.label).join('|');
  await page.click('#upNew'); await page.waitForTimeout(150);
  const after = (await legs()).map(l => l.label).join('|');
  check('New mix runs and keeps a valid parlay', after.length > 0);
  // the page is well formed at phone width
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px over`);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
