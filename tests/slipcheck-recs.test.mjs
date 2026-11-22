// Slip Check recommended changes: lower a weak leg, swap in a more likely player, or remove it. Run: node tests/slipcheck-recs.test.mjs
// reads it per run. Run: node tests/slipcheck-players.test.mjs. Uses a saved fixture game and a test stats file.
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
    const g = SB.DATA.games.find(x => x.sport === 'nfl' && SB.priced(x) && SB.fit(x)) || SB.DATA.games.find(x => x.sport === 'nfl');
    if (!g) return null;
    __slipcheck.setPlayerStats({ league: { passYds: 235, rushYds: 115, recYds: 235, tdByQuarter: [0.21, 0.31, 0.21, 0.27] },
      defense: { [g.away.abbr]: { passYdsAllowed: 173.2, rushYdsAllowed: 86.6 }, [g.home.abbr]: { passYdsAllowed: 211, rushYdsAllowed: 80.9 } },
      players: { 'Test Passer': { team: g.home.abbr, stat: 'passing_yards', mean: 245, sd: 65 }, 'Test Receiver': { team: g.home.abbr, stat: 'receiving_yards', mean: 60, sd: 28 },
        'Away Receiver': { team: g.away.abbr, stat: 'receiving_yards', mean: 52, sd: 26 } } });
    const base = { event: `${g.away.name} @ ${g.home.name}`, sport: 'nfl', sel: '' };
    const A = __slipcheck.analyze({ legs: [
      { ...base, pick: '210+ | Test Passer Passing Yards', market: 'passing_yards', side: 'over', line: '210', odds: '' },
      { ...base, pick: '70+ | Away Receiver Receiving Yards', market: 'receiving_yards', side: 'over', line: '70', odds: '' },
    ], totalOdds: '+700' });
    const R = __slipcheck.recommendations(A);
    return { base: R.base, items: R.items.map(it => ({ label: it.label, p: it.p, opts: it.opts.map(o => ({ kind: o.kind, text: o.text, p: o.p, slip: o.slip })) })) };
  });
  if (!r) check('an NFL game is on the saved board', false);
  else {
    const it = r.items, away = it.find(x => /Away Receiver/.test(x.label));
    check('weak legs get recommendations, weakest first', it.length >= 1 && it.every((x, i) => i === 0 || it[i - 1].p <= x.p), JSON.stringify(it.map(x => [x.label, +x.p.toFixed(3)])));
    const low = away && away.opts.find(o => o.kind === 'lower');
    check('a weak yards leg gets a lower line it clears about two times in three', low && low.p >= 0.6 && +/Lower to (\d+)/.exec(low.text)[1] < 70, JSON.stringify(low));
    const rep = it.flatMap(x => x.opts).find(o => o.kind === 'replace');
    check('a replacement is a player not already on the slip, and more likely', rep && /Test Receiver/.test(rep.text) && rep.p > Math.min(...it.map(x => x.p)), JSON.stringify(rep));
    const rem = away && away.opts.find(o => o.kind === 'remove');
    check('removing a leg raises the slip chance', rem && rem.slip > r.base, JSON.stringify({ base: r.base, rem }));
    check('every option says the new slip chance', it.every(x => x.opts.every(o => o.slip > 0 && o.slip <= 1)));
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
