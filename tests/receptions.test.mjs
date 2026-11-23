// NFL / college reception legs (nflrec.json from ESPN box scores) and "Read more" on long text. Run: node tests/receptions.test.mjs
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
const F = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-23T08:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: F('data-2026-11-23.json') }));
await page.route('**/nflrec.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: F('nflrec-2026-11-23.json') }));
await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('fantasy')));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && /Reception legs/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  const R = await page.evaluate(() => {
    const P = SB.DATA.players.filter(p => p.stat === 'rec'), T = __fm2.autoCache.rec4;
    return { n: P.length, sports: [...new Set(P.map(p => SB.gameById(p.gid).sport))], legs: T ? T.legs.map(L => L.key) : [], teams: T ? T.legs.map(L => SB.DATA.players.find(p => p.id === L.key.split(':')[1]).team) : [], games: T ? T.legs.map(L => L.gid) : [] };
  });
  check('receivers from NFL and college games become reception legs', R.n > 50 && R.sports.includes('nfl') && R.sports.includes('ncaaf'), JSON.stringify({ n: R.n, s: R.sports }));
  check('a reception parlay: one catcher per team, different games', R.legs.length >= 2 && new Set(R.teams).size === R.teams.length && new Set(R.games).size === R.games.length, JSON.stringify(R));
  const txt = await page.textContent('#main');
  check('each catcher shows his last games, lines cleared and his levels (ladder of lines with chances)', /last \d: [\d, ]+ · cleared \d\/\d/.test(txt) && /levels: \d\+ \d+% · \d\+ \d+%/.test(txt));
  // read more (added on the next frame after a render)
  await page.waitForSelector('.rmore', { timeout: 10000 });
  const rm = await page.evaluate(() => { const b = document.querySelector('.rmore'); if (!b) return null; const el = b.previousElementSibling, h0 = el.clientHeight; b.click(); const h1 = el.clientHeight; return { h0, h1, t: b.textContent }; });
  check('long text is clamped with "Read more", which opens it and turns into "Show less"', rm && rm.h1 > rm.h0 && rm.t === 'Show less', JSON.stringify(rm));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
