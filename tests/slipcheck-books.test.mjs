// Slip Check: any prop leg can be priced from the odds typed on the slip, and a parlay is priced from those legs.
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
    const g = SB.DATA.games.find(x => x.sport === 'nfl' && !SB.started(x));  // a game still to come: started or finished games are never priced
    const base = { event: `${g.away.name} @ ${g.home.name}`, sport: 'nfl', sel: '' };
    const withOdds = __slipcheck.matchLeg({ ...base, pick: g.home.name.split(' ').pop(), market: 'passing_yards', side: 'over', line: '250.5', odds: '-115' });
    const noOdds = __slipcheck.matchLeg({ ...base, pick: g.home.name.split(' ').pop(), market: 'passing_yards', side: 'over', line: '250.5', odds: '' });
    const td = __slipcheck.matchLeg({ ...base, pick: g.away.name.split(' ').pop(), market: 'anytime_td', side: '', line: '', odds: '+150' });
    const A = __slipcheck.analyze({ legs: [{ ...base, pick: g.home.name.split(' ').pop(), market: 'passing_yards', side: 'over', line: '250.5', odds: '-115' }, { ...base, pick: g.away.name.split(' ').pop(), market: 'anytime_td', side: '', line: '', odds: '+150' }], totalOdds: '+400' });
    return { game: g.id, withOdds: { status: withOdds.status, p: withOdds.p, label: withOdds.label, book: withOdds.bookOnly }, noOdds: { status: noOdds.status, why: noOdds.why }, td: { status: td.status, p: td.p }, parlay: { p: A.p, matched: A.M.length, decCmp: A.decCmp } };
  });
  check('a passing-yards leg with the odds typed is priced from them (-115 is about 53.5%)', r.withOdds.status === 'matched' && Math.abs(r.withOdds.p - 115 / 215) < 0.01 && r.withOdds.book === true, JSON.stringify(r.withOdds));
  check('the label names the prop', /passing yards/i.test(r.withOdds.label || ''), r.withOdds.label);
  check('no odds typed: the leg says what to type instead of failing', r.noOdds.status === 'game' && /Type the book/.test(r.noOdds.why || ''), JSON.stringify(r.noOdds));
  check('an anytime touchdown at +150 is priced (40%)', r.td.status === 'matched' && Math.abs(r.td.p - 0.4) < 0.01, JSON.stringify(r.td));
  check('a two-leg parlay of book-priced legs is priced together', r.parlay.matched === 2 && r.parlay.p > 0 && r.parlay.p < 0.6, JSON.stringify(r.parlay));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
