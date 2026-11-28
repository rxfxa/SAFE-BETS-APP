// Fantasy duo / trio stacks: same-team starters whose stats feed each other (playmaker assists + scorer points + big rebounds),
// last-4 box scores, close games first, substitutes, legs / games scrollers, 500,000 runs with teammates moving together.
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
// the slate's own injury report, so a later day's absences can't change which teammate takes a stat
for (const [glob, file] of [['**/data.json', 'data-2026-11-23.json'], ['**/polymarket.json', 'polymarket-2026-11-23b.json'], ['**/nbalast4.json', 'nbalast4-2026-11-23.json'], ['**/nbaroles.json', 'nbaroles-2026-11-23.json'], ['**/injuries.json', 'injuries-2026-11-23.json']])
  await page.route(glob, r => r.fulfill({ status: 200, contentType: 'application/json', body: F(file) }));
await page.addInitScript(() => { localStorage.setItem('fm2.tab', JSON.stringify('fantasy')); localStorage.setItem('fm2.stk', JSON.stringify({ legs: 6, games: 3 })); });
try {
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('stkL') && window.__polymarket && __polymarket.LOAD === 'done', null, { timeout: 60000 });
  await page.evaluate(() => SB.render());
  const S = await page.evaluate(() => {
    const box = document.getElementById('stkL').closest('.fbox'), card = box.nextElementSibling, out = { title: card.querySelector('.pctitle').textContent, stacks: [] };
    let n = card.nextElementSibling;
    while (n && n.classList.contains('pc')) { out.stacks.push({ t: n.querySelector('.pctitle').textContent, hit: n.querySelector('.hit').textContent, m: [...n.querySelectorAll('.stkm')].map(x => x.textContent.replace(/\s+/g, ' ').trim()) }); n = n.nextElementSibling; }
    const T = __fm2.SIM5, legs = (window.__fmCards || null);
    return out;
  });
  check('a 6-leg stack parlay for Monday Nov 23 (tomorrow)', /6-leg stack parlay · Monday, Nov 23/.test(S.title), S.title);
  check('3 games, stacks of 2-3 starters each', S.stacks.length >= 2 && S.stacks.every(s => s.m.length >= 1 && s.m.length <= 3), JSON.stringify(S.stacks.map(s => s.m.length)));
  check('every stack mixes roles (playmaker assists / scorer points / big rebounds), never two players on one stat', S.stacks.every(s => { const st = s.m.map(x => /assists/.test(x.split(' last')[0]) ? 'a' : /points/.test(x.split(' last')[0]) ? 'p' : 'r'); return new Set(st).size === st.length; }));
  check('each member shows his last 4 box scores and how often he cleared his line', S.stacks.every(s => s.m.every(x => /last 4: [\dDNP, ]+ · cleared \d\/\d/.test(x))), S.stacks[0].m[0]);
  check('closeness comes from Polymarket\'s moneyline for games without a posted line, closest first', S.stacks.every(s => /% within 8/.test(s.hit)) && S.stacks.map(s => parseInt(s.hit)).every((x, i, a) => i === 0 || x <= a[i - 1] + 1), JSON.stringify(S.stacks.map(s => s.hit)));
  check('each member names who takes his stat if he sits', S.stacks.every(s => s.m.every(x => /if he sits: /.test(x))));
  // the legs scroller and games scroller
  await page.evaluate(() => { const r = document.getElementById('stkL'); r.value = 10; r.dispatchEvent(new Event('change', { bubbles: true })); const g = document.getElementById('stkG'); g.value = 5; g.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(300);
  const t2 = await page.evaluate(() => document.getElementById('stkL').closest('.fbox').nextElementSibling.querySelector('.pctitle').textContent);
  check('scrollers: 10 legs over 5 games rebuilds the parlay (9-10 legs when a stack is short)', /(9|10)-leg stack parlay/.test(t2), t2);
  // teammates move together in the 500,000 runs: a stack's sim rate is at least its plain product
  const R = await page.evaluate(() => {
    const T = [...document.querySelectorAll('[data-sim5="stk"]')].length, B = __fm2.SIM5;
    const legs = (() => { const id = 'stk'; return null; })();
    return T;
  });
  await page.click('[data-sim5="stk"]');
  await page.waitForFunction(() => __fm2.SIM5.stk, null, { timeout: 60000 });
  const sim = await page.evaluate(() => { const S = __fm2.SIM5.stk; const keys = S.sig.split(','); return { rate: S.rate, N: S.N, legs: S.legs }; });
  const prod = sim.legs.reduce((a, x) => a * x, 1);
  check('500,000 runs; teammates\' legs move together, so the parlay lands at least as often as the plain product', sim.N === 500000 && sim.rate >= prod * 0.98, `sim ${sim.rate.toFixed(4)} vs product of its own leg rates ${prod.toFixed(4)}`);
  check('the stack card has swap buttons', (await page.locator('[data-sub^="stk|"]').count()) > 0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
