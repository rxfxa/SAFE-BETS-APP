// UFC tab (ufc.js): fight cards from ufc.json. Run: node tests/ufc.test.mjs
// Uses a saved card (tests/fixtures/ufc-2026-11-19.json) and an empty one, so the checks don't depend on today's cards.
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
const CARD = fs.readFileSync(path.join(ROOT, 'tests/fixtures/ufc-2026-11-19.json'), 'utf8');
const EMPTY = fs.readFileSync(path.join(ROOT, 'tests/fixtures/ufc-empty.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
async function open(body, w = 390) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route('**/ufc.json', r => r.fulfill({ status: 200, contentType: 'application/json', body }));
  await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('ufc')));
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && window.SB.firstRender && document.querySelector('#main h2') && /UFC/.test(document.querySelector('#main').textContent) && !/Loading fight cards/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  return { ctx, page, errors };
}
try {
  const A = await open(CARD);
  const t = await A.page.textContent('#main');
  check('tab is registered and in the tab bar after Injuries', (await A.page.$$eval('#tabs [data-t]', xs => xs.map(x => x.dataset.t))).indexOf('ufc') === (await A.page.$$eval('#tabs [data-t]', xs => xs.map(x => x.dataset.t))).indexOf('injuries') + 1);
  check('each fight shows both fighters', /Jirí Procházka/.test(t) && /Navajo Stirling/.test(t));
  check('moneyline shows the market chance for each fighter (40% / 61%, rounded)', /Jirí Procházka\s*40%/.test(t.replace(/\s+/g, ' ')) && /Navajo Stirling\s*61%/.test(t.replace(/\s+/g, ' ')));
  check('go the distance, method and rounds sections are shown', /Goes the distance/.test(t) && /Method/.test(t) && /Rounds/.test(t) && /O\/U 2\.5 Rounds/.test(t));
  check('the page says these are market prices, not our estimate', /not our own estimate/.test(t));
  check('each card links to its Polymarket event', (await A.page.$$eval('#main a', xs => xs.filter(a => /polymarket\.com\/event\//.test(a.href)).length)) >= 11);
  const over = await A.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px over`);
  check('no console errors', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
  await A.ctx.close();

  const B = await open(EMPTY);
  check('no fights: says so plainly', /No UFC fights on Polymarket in the next 10 days/.test(await B.page.textContent('#main')));
  check('no fights: no console errors', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
  await B.ctx.close();
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
