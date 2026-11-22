// Slip Check: "Simulate the slip" runs 500,000 runs; a game leg's simulated rate matches its model chance.
// Run: node tests/slipcheck-sim.test.mjs. Uses the saved slate (tests/fixtures/data-2026-11-18.json).
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
    const g = SB.DATA.games.find(x => (x.sport === 'nfl' || x.sport === 'nba') && SB.priced(x) && SB.fit(x));
    if (!g) return null;
    const base = { event: `${g.away.name} @ ${g.home.name}`, sport: g.sport, sel: '' };
    const A = __slipcheck.analyze({ legs: [
      { ...base, pick: g.home.name.split(' ').pop(), market: 'moneyline', side: '', line: '', odds: '-150' },
      { ...base, pick: g.away.name.split(' ').pop(), market: 'passing_yards', side: 'over', line: '200.5', odds: '-110' },
    ], totalOdds: '+300' });
    const t0 = performance.now();
    const S = __slipcheck.simulateSlip(A);
    return { ms: performance.now() - t0, S: S && { N: S.N, rate: S.rate, legs: S.legs.map(l => [l.label, l.rate, l.how]), joint: S.joint, book: S.book, gamesSimmed: S.gamesSimmed }, mlP: A.M[0] && A.M[0].p, bookLeg: A.M[1] && A.M[1].p };
  });
  if (!r || !r.S) { check('a priced NFL or NBA game is on the saved board', false); }
  else {
    check('the run is 500,000 trials', r.S.N === 500000, String(r.S.N));
    const ml = r.S.legs[0], pr = r.S.legs[1];
    check('the game leg is simulated from the game model', /game simulation/.test(ml[2]), ml[2]);
    check('the game leg rate matches its model chance (within 0.5 points over 500,000 runs)', Math.abs(ml[1] - r.mlP) < 0.005, `${(ml[1] * 100).toFixed(2)}% vs ${(r.mlP * 100).toFixed(2)}%`);
    check('the prop leg is drawn at its own chance', /own chance/.test(pr[2]) && Math.abs(pr[1] - r.bookLeg) < 0.005, `${(pr[1] * 100).toFixed(2)}% vs ${(r.bookLeg * 100).toFixed(2)}%`);
    check('the slip rate is a probability and not above either leg', r.S.rate >= 0 && r.S.rate <= Math.min(ml[1], pr[1]) + 1e-9, (r.S.rate * 100).toFixed(2) + '%');
    check('the run finishes quickly enough to use (under 20 seconds)', r.ms < 20000, Math.round(r.ms) + ' ms');
  }
  const html = await page.evaluate(() => (document.querySelector('#main') || {}).textContent || '');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
