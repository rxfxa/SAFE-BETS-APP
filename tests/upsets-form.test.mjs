// Upset Parlays: researched form (form.json) on the legs, the form-backed parlay, the streak check, and the 500,000-run simulation.
// Run: node tests/upsets-form.test.mjs. Saved board (tests/fixtures/polymarket-2026-11-20.json) and a form file built from it.
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
const PMJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/polymarket-2026-11-20.json'), 'utf8'));
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
// a form file for three games with an underdog: favourite on a losing run; favourite on a soft winning run; underdog on a run
const NOW = Date.parse('2026-11-20T12:00:00Z');
const dogGames = PMJ.games.filter(g => !g.stale && Date.parse(g.start) > NOW && Date.parse(g.start) - NOW <= 48 * 3600e3 && g.ml && g.ml.home && g.ml.away && g.sport !== 'soccer')
  .map(g => { const h = g.ml.home, a = g.ml.away, dog = h.m < a.m ? 'home' : 'away', q = g.ml[dog]; return { g, dog, fav: dog === 'home' ? 'away' : 'home', ok: q.m >= .15 && q.m <= .5 && q.a != null && q.a <= .55 }; })
  .filter(x => x.ok).slice(0, 3);
const team = (name, sport, o) => ({ name, sport, comp: 'X', record: '9-6', unbeaten: 0, winStreak: 0, lossStreak: 0, winless: 0, last5: 'W L W L W', lastGame: 'x', asOf: '2026-11-19', sources: ['https://example.org'], confidence: 'verified', ...o });
const g5 = (pos) => pos.map((p, i) => ({ date: `2026-11-${10 + i}`, opp: `Opp ${i}`, home: i % 2 === 0, result: 'W', score: '100-90', oppPos: p, oppOf: 15 }));
const [A, B, Cg] = dogGames;
const FORM = { updated: '2026-11-20T08:00:00Z', teams: [
  team(A.g[A.fav].name, A.g.sport, { lossStreak: 3, winless: 3, last5: 'W W L L L', position: 13, of: 15 }),
  team(A.g[A.dog].name, A.g.sport, { winStreak: 1, unbeaten: 1 }),
  team(B.g[B.fav].name, B.g.sport, { winStreak: 4, unbeaten: 4, last5: 'L W W W W', games: [{ date: '2026-11-09', opp: 'Opp x', result: 'L', score: '90-100', oppPos: 2, oppOf: 15 }, ...g5([14, 12, 15, 3])], soft: true, vsBottom: 3, runKnown: 4 }),
  team(Cg.g[Cg.dog].name, Cg.g.sport, { winStreak: 5, unbeaten: 5, last5: 'W W W W W', confidence: 'partial' }),
] };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.clock.setFixedTime(new Date(NOW));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PMJ) }));
await page.route('**/form.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FORM) }));
await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('upsets')));
try {
  check('fixture has 3 games with an underdog', dogGames.length === 3, dogGames.map(x => x.g.slug).join(','));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__upsets && document.getElementById('upMain') && /Streak check/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  const txt = await page.textContent('#main');
  check('the note says form was researched from results (no "isn\'t in our feeds")', /researched game by game from results/.test(txt) && !/isn't in our feeds/.test(txt));
  check('a favourite on a losing run shows "lost 3 straight"', txt.includes(`${A.g[A.fav].name}`) && /lost 3 straight/.test(txt));
  const fc = await page.evaluate(() => { const c = document.getElementById('upForm'); return c ? { n: c.querySelectorAll('.leg').length, why: [...c.querySelectorAll('.fwhy')].map(x => x.textContent) } : null; });
  check('form-backed parlay: built from upsets the form supports, each with its reason', fc && fc.n >= 2 && fc.why.length === fc.n && fc.why.every(w => /lost|run came|unbeaten|won/.test(w)), JSON.stringify(fc));
  check('the soft-run favourite is in the form parlay with the reason', fc && fc.why.some(w => /run came mostly against bottom-half sides \(3 of 4\)/.test(w)), JSON.stringify(fc && fc.why));
  check('streak check marks the soft run and lists who the wins came against', /Soft run/.test(txt) && /Opp 1 \(12th of 15\)/.test(txt) && /3 of the 4 wins we could place came against bottom-half sides/.test(txt));
  check('a team not confirmed by a second source is marked ?', /title="not confirmed by a second source"/.test(await page.innerHTML('#main')));
  check('the page never says a loss is "due" (only that it is not)', !/loss is due|due for a loss/i.test(txt.replace(/doesn't make a loss due/g, '')));
  // 500,000 runs on the main parlay
  const mids = await page.$$eval('#upMain .leg .legp', xs => xs.map(x => parseFloat(x.textContent) / 100));
  await page.click('[data-up-sim="upMain"]');
  await page.waitForFunction(() => /500,000 runs/.test((document.querySelector('[data-up-out="upMain"]') || {}).textContent || ''), null, { timeout: 30000 });
  const S = await page.evaluate(() => { const s = __upsets.SIMS.upMain, L = __upsets.CARDS.upMain; return { hits: s.mkt.hits, rate: s.mkt.rate, legs: s.mkt.legHits, mids: L.map(l => l.mid), n: __upsets.N_SIM, out: document.querySelector('[data-up-out="upMain"]').textContent }; });
  const prod = S.mids.reduce((a, x) => a * x, 1), se = Math.sqrt(prod * (1 - prod) / S.n);
  check('500,000 runs: hits + misses add up and both are shown', S.n === 500000 && /hits \(market chances\)/.test(S.out) && S.out.includes(S.hits.toLocaleString()) && S.out.includes((S.n - S.hits).toLocaleString()), `${S.hits}`);
  check('the hit rate matches the market chance within 4 standard errors', Math.abs(S.rate - prod) <= 4 * se + 1e-6, `${S.rate} vs ${prod}`);
  check('each leg lands at its own chance (within 0.5 points)', S.legs.every((x, i) => Math.abs(x - S.mids[i]) < .005), JSON.stringify(S.legs.map(x => +x.toFixed(3))));
  check('the result shows the average return at the price to buy', /would average [+−]\$\d/.test(S.out));
  const again = await page.textContent('[data-up-sim="upMain"]');
  check('the button offers to run again', /Run again/.test(again), again);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
