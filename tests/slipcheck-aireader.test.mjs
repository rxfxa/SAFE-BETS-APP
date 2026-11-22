// Slip Check, AI-reader legs: a DraftKings same-game parlay read from a screenshot (49ers vs Vikings) comes out with every leg
// priced, even when the reader writes the pick as "25+ | Kaelon Black Rushing Yards", and the 500,000-run simulation runs every leg.
// Run: node tests/slipcheck-aireader.test.mjs. Uses tests/fixtures/data-2026-11-22.json, tests/fixtures/polymarket-2026-11-22.json
// (the game is unpriced in the feed but priced on Polymarket) and the repo's playerstats.json.
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
const PM = fs.readFileSync(path.join(ROOT, 'tests/fixtures/polymarket-2026-11-22.json'), 'utf8');
const STATS = fs.readFileSync(path.join(ROOT, 'playerstats.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
const json = body => r => r.fulfill({ status: 200, contentType: 'application/json', body });
await page.route('**/data.json', json(DATA));
await page.route('**/polymarket.json', json(PM));
await page.route('**/playerstats.json', json(STATS));
// the legs exactly as the AI reader wrote them from the user's screenshot
const EV = { event: 'MIN Vikings @ SF 49ers', sport: 'nfl', odds: '', sel: '' };
const LEGS = [
  { ...EV, market: 'moneyline', pick: 'SF 49ers', side: '', line: '' },
  { ...EV, market: 'rushing_yards', pick: '25+ | Kaelon Black Rushing Yards', side: 'over', line: '25' },
  { ...EV, market: 'receiving_yards', pick: '40+ | George Kittle Receiving Yards', side: 'over', line: '40' },
  { ...EV, market: 'receiving_yards', pick: '70+ | Justin Jefferson Receiving Yards', side: 'over', line: '70' },
  { ...EV, market: 'passing_yards', pick: '210+ | Brock Purdy Passing Yards', side: 'over', line: '210' },
  { ...EV, market: 'anytime_td', pick: 'Christian McCaffrey | Anytime TD Scorer', side: '', line: '' },
];
const NAMES = [null, 'Kaelon Black', 'George Kittle', 'Justin Jefferson', 'Brock Purdy', 'Christian McCaffrey'];
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__slipcheck, null, { timeout: 60000 });
  // wait for playerstats.json and polymarket.json: a clean leg gets a model number, and Polymarket has games
  await page.waitForFunction(() => {
    const g = SB.gameById && SB.gameById('nfl-SF-MIN-2026-11-23'); if (!g) return false;
    const v = __slipcheck.playerProb({ event: 'MIN Vikings @ SF 49ers', sport: 'nfl', pick: 'Brock Purdy', market: 'passing_yards', side: 'over', line: '209.5', odds: '' }, g, 'O', 209.5);
    return typeof v === 'number' && window.__polymarket && window.__polymarket.PM && (window.__polymarket.PM.games || []).length > 0;
  }, null, { timeout: 15000 }).catch(() => {});
  const r = await page.evaluate(({ LEGS, EV }) => {
    const A = __slipcheck.analyze({ legs: LEGS, totalOdds: '+700', stake: 3 });
    const clean = __slipcheck.analyze({ legs: [{ ...EV, market: 'rushing_yards', pick: 'Kaelon Black', side: 'over', line: '24.5' }], totalOdds: '' });
    const S = A.M.length ? __slipcheck.simulateSlip(A) : null;
    return {
      gameOnBoard: !!(SB.gameById && SB.gameById('nfl-SF-MIN-2026-11-23')),
      rows: A.rows.map(x => ({ i: x.i, status: x.status, p: x.p, label: x.label, why: x.why, key: x.key })),
      cleanP: clean.rows[0] && clean.rows[0].status === 'matched' ? clean.rows[0].p : null,
      cleanRow: clean.rows[0] && { status: clean.rows[0].status, why: clean.rows[0].why, label: clean.rows[0].label },
      S: S && { N: S.N, rate: S.rate, hits: S.hits, misses: S.misses != null ? S.misses : S.N - S.hits, legs: S.legs.map(l => ({ label: l.label, rate: l.rate, how: l.how })) },
    };
  }, { LEGS, EV });
  check('the 49ers-Vikings game is on the saved board', r.gameOnBoard);
  const rowInfo = x => `#${x.i + 1} ${x.status} p=${x.p} label="${x.label}" why="${x.why}"`;
  check('all 6 legs come back', r.rows.length === 6, String(r.rows.length));
  for (const x of r.rows) check(`leg ${x.i + 1} is matched with a chance between 0 and 1`, x.status === 'matched' && x.p > 0 && x.p < 1, rowInfo(x));
  const bad = r.rows.filter(x => x.status === 'matched' && /not priced|No model|Type the book/i.test(x.why || '') && !/hasn't priced this game/.test(x.why || ''));
  check('no matched leg says it is not priced / has no model / needs the book\'s odds', bad.length === 0, bad.map(rowInfo).join(' | '));
  for (let i = 1; i < 6; i++) {
    const x = r.rows[i]; if (!x) continue;
    check(`leg ${i + 1} label names ${NAMES[i]} without the raw "${LEGS[i].pick.split('|')[0].trim()} |" text`, x.label.includes(NAMES[i]) && !/\|/.test(x.label) && !/^\d+\+/.test(x.label), `label="${x.label}"`);
  }
  const kb = r.rows[1];
  check('"25+" is read as at least 25: same chance as Kaelon Black over 24.5', kb && kb.status === 'matched' && r.cleanP != null && Math.abs(kb.p - r.cleanP) < 1e-6,
    `25+ leg p=${kb && kb.p} vs clean 24.5 p=${r.cleanP} (clean row: ${JSON.stringify(r.cleanRow)})`);
  if (!r.S) check('the simulation runs', false, 'no matched legs');
  else {
    check('the simulation is 500,000 runs', r.S.N === 500000, String(r.S.N));
    check('the simulation runs every leg (6)', r.S.legs.length === 6, `${r.S.legs.length} legs: ${r.S.legs.map(l => l.label).join(' / ')}`);
    const badL = r.S.legs.filter(l => !(l.rate > 0 && l.rate < 1));
    check('every simulated leg has a rate between 0 and 1', badL.length === 0, badL.map(l => `${l.label}=${l.rate}`).join(' | '));
    check('hits + misses equals N (whole runs)', Number.isInteger(r.S.hits) && Number.isInteger(r.S.misses) && r.S.hits >= 0 && r.S.misses >= 0 && r.S.hits + r.S.misses === r.S.N, `hits=${r.S.hits} misses=${r.S.misses}`);
    const ml = r.S.legs[0], mlP = r.rows[0] && r.rows[0].p;
    check('the moneyline leg\'s simulated rate is within 1 point of its chance', ml && mlP > 0 && Math.abs(ml.rate - mlP) < 0.01, ml ? `${(ml.rate * 100).toFixed(2)}% sim vs ${(mlP * 100).toFixed(2)}% (${ml.how})` : '');
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
