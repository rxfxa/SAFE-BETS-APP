// Slip Check player model: a player leg with no odds is priced from his average and the opponent's defence, and the simulation
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
    // a stats file for this game's two teams: the home player averages 245 passing yards against an away defence allowing 173
    __slipcheck.setPlayerStats({ league: { passYds: 235, rushYds: 115, recYds: 235 },
      defense: { [g.away.abbr]: { passYdsAllowed: 173.2, rushYdsAllowed: 86.6 }, [g.home.abbr]: { passYdsAllowed: 211, rushYdsAllowed: 80.9 } },
      players: { 'Test Passer': { team: g.home.abbr, stat: 'passing_yards', mean: 245, sd: 65 }, 'Test Scorer': { team: g.home.abbr, stat: 'anytime_td', mean: 0.85, sd: 0 } } });
    const base = { event: `${g.away.name} @ ${g.home.name}`, sport: 'nfl', sel: '' };
    const A = __slipcheck.analyze({ legs: [
      { ...base, pick: 'Test Passer', market: 'passing_yards', side: 'over', line: '209.5', odds: '' },
      { ...base, pick: 'Test Scorer', market: 'anytime_td', side: '', line: '', odds: '' },
    ], totalOdds: '' });
    const S = __slipcheck.simulateSlip(A);
    const Ao = __slipcheck.analyze({ legs: [{ ...base, pick: 'Test Passer', market: 'player_other', side: 'over', line: '209.5', odds: '' }], totalOdds: '' });
    return { otherP: Ao.M[0] && Ao.M[0].p, passP: A.M[0] && A.M[0].p, tdP: A.M[1] && A.M[1].p, n: A.M.length, S: S && { rate: S.rate, legs: S.legs.map(l => [l.rate, l.how]), N: S.N }, away: g.away.abbr };
  });
  if (!r) { check('an NFL game is on the saved board', false); }
  else {
    const z = (209.5 - 245 * (173.2 / 235)) / 65; const expect = 1 - (0.5 * (1 + ((x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; })(z / Math.SQRT2)));
    check('both player legs are priced with no odds typed', r.n === 2, `${r.n} priced`);
    check('the yards leg is priced from its average and the opponent (about ' + (expect * 100).toFixed(1) + '%)', Math.abs(r.passP - expect) < 0.01, `${(r.passP * 100).toFixed(2)}%`);
    check('"Other player prop" with the same line is priced the same way', r.otherP != null && Math.abs(r.otherP - r.passP) < 1e-9, `${r.otherP}`);
    check('the simulation adds game-total swings: within 5 points of the standalone chance (it is wider because high and low scoring games move the yards)', Math.abs(r.S.legs[0][0] - r.passP) < 0.05 && r.S.legs[0][0] > 0, `${(r.S.legs[0][0] * 100).toFixed(2)}% sim vs ${(r.passP * 100).toFixed(2)}% standalone`);
    check('the touchdown leg is simulated per run and matches its Poisson chance (within 1.5 points)', Math.abs(r.S.legs[1][0] - r.tdP) < 0.015, `${(r.S.legs[1][0] * 100).toFixed(2)}% vs ${(r.tdP * 100).toFixed(2)}%`);
    check('the leg says whose average and which defence it used', /average/.test(r.S.legs[0][1]) && /vs /.test(r.S.legs[0][1]), r.S.legs[0][1]);
    check('the slip rate is below either leg', r.S.rate <= Math.min(r.S.legs[0][0], r.S.legs[1][0]) + 1e-9, `${(r.S.rate * 100).toFixed(2)}%`);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
