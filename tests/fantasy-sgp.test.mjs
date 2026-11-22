// Fantasy tab: same game parlay (one game, 2-10 legs) and the 20-leg safest combo (3 legs from each game).
// Run: node tests/fantasy-sgp.test.mjs. Uses the saved slate (tests/fixtures/data-2026-11-18.json).
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
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-15T12:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender, null, { timeout: 60000 });
  await page.evaluate(() => SB.goTab('fantasy'));
  await page.waitForSelector('#sgpR', { timeout: 20000 });
  const chips = await page.locator('[data-sgpg]').count();
  check('same game parlay section has a legs scroller and game chips', chips > 0, `chips=${chips}`);
  const one = async () => page.evaluate(() => {
    const cards = [...document.querySelectorAll('.pc')].filter(c => /same game parlay ·/.test(c.textContent));
    const c = cards[0]; if (!c) return null;
    const legs = [...c.querySelectorAll('.legtxt > span')].map(x => x.textContent.split(' · ')[0]);
    return { n: c.querySelectorAll('.leg').length, games: [...new Set(legs)] };
  });
  let r = await one();
  check('4-leg same game parlay: 4 legs, all from one game', r && r.n === 4 && r.games.length === 1, JSON.stringify(r));
  await page.locator('#sgpR').fill('6'); await page.locator('#sgpR').dispatchEvent('change');
  r = await one();
  const thin = await page.evaluate(() => /has \d+ legs? at this safety level/.test(document.body.textContent));
  check('scroller to 6 rebuilds the same game parlay (or says the game is short of legs)', (r && r.n === 6 && r.games.length === 1) || thin, JSON.stringify(r));
  await page.locator('[data-sgpg]').nth(Math.min(1, chips - 1)).click();
  check('picking another game marks it on', await page.locator('[data-sgpg].on').count() === 1);
  const m = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.pc')].find(x => /20 legs ·/.test(x.textContent)); if (!c) return null;
    const ps = [...c.querySelectorAll('.legp')].map(x => parseFloat(x.textContent));
    const per = {}; c.querySelectorAll('.legtxt > span').forEach(x => { const k = x.textContent.split(' · ')[0]; per[k] = (per[k] || 0) + 1; });
    return { n: ps.length, min: Math.min(...ps), maxPerGame: Math.max(...Object.values(per)), hit: c.querySelector('.hit').textContent };
  });
  check('20-leg combo: 20 legs, at most 3 per game, every leg 85%+', m && m.n === 20 && m.maxPerGame <= 3 && m.min >= 85, JSON.stringify(m));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
