// Weekend Patterns tab: the 90-day research (pattern.json) shown honestly, the live round tracker, and the parlay mix for the
// next round (app cards: swap legs + 500,000 runs). Run: node tests/pattern.test.mjs
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
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-22.json'), 'utf8');
const PT = JSON.parse(fs.readFileSync(path.join(ROOT, 'pattern.json'), 'utf8'));
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T10:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('pattern')));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__pattern && __pattern.PT && /Round by round/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  const txt = await page.textContent('#main');
  check('the tab answers the tweet with the research verdict', txt.includes(PT.verdict.slice(0, 60)) && /Weekend Patterns/.test(txt));
  check('each claim is checked against chance (all big teams lose, 80% draws, swings, early slips, carry-over)', ['A weekend where every big favourite lost', 'A weekend with 80% draws', 'Rounds swing more than chance', 'Early slips mean later slips', 'An upset weekend predicts the next one'].every(s => txt.includes(s)));
  check('returns at closing odds are shown for favourites, draws and betting against favourites', /Big favourites to win/.test(txt) && /Every draw/.test(txt) && /Against big favourites/.test(txt));
  check('one row per round, one row per league', (await page.locator('.ptrow').count()) === PT.weeks.length && PT.calibration.every(c => txt.includes(c.comp)), `${await page.locator('.ptrow').count()} rows vs ${PT.weeks.length}`);
  check('the live round tracker is on the page', /This round, live/.test(txt) && /games still to play/.test(txt));
  const C = await page.evaluate(() => __pattern.parlays());
  const by = Object.fromEntries(C.cards.map(c => [c.id, c]));
  check('a mix of parlays for the next round (favourites, cushion, chaos, draws, the mix)', ['pt-fav', 'pt-safe', 'pt-chaos', 'pt-draw', 'pt-mix'].filter(k => by[k]).length >= 4, Object.keys(by).join(','));
  const games = await page.evaluate(ids => ids.map(id => { const g = SB.DATA.games.find(x => x.id === id); const p = g.prob, s = p.home + (p.draw || 0) + p.away; return { h: p.home / s, a: p.away / s, d: (p.draw || 0) / s }; }), C.cards.flatMap(c => c.legs.map(l => l.gid)));
  let k = 0; const gi = {}; C.cards.forEach(c => c.legs.forEach(l => { gi[c.id + l.gid + l.key] = games[k++]; }));
  const g = (c, l) => gi[c.id + l.gid + l.key];
  check('favourite legs are big favourites (60%+) to win', by['pt-fav'].legs.every(l => (l.key === 'H' ? g(by['pt-fav'], l).h : g(by['pt-fav'], l).a) >= .6 && (l.key === 'H' || l.key === 'A')));
  check('chaos legs are against the favourite (underdog or draw)', !by['pt-chaos'] || by['pt-chaos'].legs.every(l => { const q = g(by['pt-chaos'], l); return (l.key === 'DCX2' && q.h > q.a) || (l.key === 'DC1X' && q.a > q.h); }));
  check('draw legs are in even games (within 20 points)', !by['pt-draw'] || by['pt-draw'].legs.every(l => { const q = g(by['pt-draw'], l); return l.key === 'D' && Math.abs(q.h - q.a) < .2; }));
  check('the mix uses five different games', !by['pt-mix'] || new Set(by['pt-mix'].legs.map(l => l.gid)).size === by['pt-mix'].legs.length);
  check('the cards are the app\'s: swap buttons and the 500,000-run button', (await page.locator('[data-sub^="pt-fav|"]').count()) > 0 && (await page.locator('[data-sim5="pt-fav"]').count()) === 1);
  await page.locator('[data-sim5="pt-chaos"]').click();
  await page.waitForFunction(() => __fm2.SIM5['pt-chaos'], null, { timeout: 30000 });
  const S = await page.evaluate(() => __fm2.SIM5['pt-chaos']);
  check('a pattern parlay simulates 500,000 runs', S.N === 500000 && S.hits + (S.N - S.hits) === 500000, `${S.hits}`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
