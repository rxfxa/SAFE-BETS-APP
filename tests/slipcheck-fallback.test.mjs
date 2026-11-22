// Slip Check fallback: a leg with no stats and no odds gets the chance left over from the slip's own parlay price, so no leg is blank.
// Run: node tests/slipcheck-books.test.mjs. Uses the saved slate (tests/fixtures/data-2026-11-18.json) and a clock inside its window.
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
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__slipcheck, null, { timeout: 60000 });
  const r = await page.evaluate(() => {
    const g = SB.DATA.games.find(x => x.sport === 'nfl');
    const base = { event: `${g.away.name} @ ${g.home.name}`, sport: 'nfl', sel: '' };
    // two legs with odds, one leg with neither stats nor odds; the slip pays +700
    const A = __slipcheck.analyze({ legs: [
      { ...base, pick: g.home.name.split(' ').pop(), market: 'passing_yards', side: 'over', line: '250.5', odds: '-115' },
      { ...base, pick: g.away.name.split(' ').pop(), market: 'anytime_td', side: '', line: '', odds: '+150' },
      { ...base, pick: 'Somebody Unknown | Receiving Yards', market: 'receiving_yards', side: 'over', line: '40', odds: '' },
    ], totalOdds: '+700' });
    const f = A.rows[2], known = A.rows[0].p * A.rows[1].p;
    return { st: A.rows.map(r => r.status), fb: !!f.fallback, p: f.p, expect: Math.min(0.95, Math.max(0.02, (1 / 8) / known)), why: f.why, full: A.full };
  });
  check('a leg with no stats and no odds is never left blank: it gets the fallback', r.st.every(x => x === 'matched') && r.fb, JSON.stringify(r.st));
  check('the fallback is the slip price left after the priced legs: (1/8) / (their chances)', Math.abs(r.p - r.expect) < 1e-9, `${r.p} vs ${r.expect}`);
  check('the fallback leg says it is a fallback from the slip price', /Fallback: worked out from the slip's \+700/.test(r.why || ''), r.why);
  check('with every leg priced the slip is compared in full', r.full === true);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
