// Slip Check: the injury worry section names who is out or doubtful in each game on the slip, and flags a stale injury file.
// Run: node tests/injury-worry.test.mjs
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
await page.clock.setFixedTime(new Date('2026-11-18T21:50:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__slipcheck && window.__lottos && window.__lottos.LOAD === 'done', null, { timeout: 60000 });
  const out = await page.evaluate(() => {
    const g = SB.DATA.games.find(x => x.sport === 'nba' && SB.priced(x)) || SB.DATA.games.find(x => x.sport === 'nba');
    if (!g) return null;
    const ml = { gid: g.id, key: 'SC:ml:H' };
    const A = { groups: [{ g, rows: [], p: .5, indep: .5 }], M: [{ label: `${g.home.name} to win`, g, key: 'SC:ml:H', p: .5 }] };
    const html = __slipcheck.injuryWorry(A);
    return { home: g.home.abbr, away: g.away.abbr, html, hasLevel: /worry<\/span>/.test(html) };
  });
  if (!out) check('an NBA game is on the board to test with', false);
  else {
    check('the section appears with a worry level for the game', out.hasLevel && out.html.includes(out.home) && out.html.includes(out.away), out.html.slice(0, 160));
    check('the injury file age is stated', /Injury file (updated|last updated)/.test(out.html), '');
    check('the section says opponent form and benching are not in our data yet', /benching/.test(out.html));
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
