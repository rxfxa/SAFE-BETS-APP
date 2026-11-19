// Simulator: who scores. Unit checks on the scorer model (NBA points, NFL touchdowns), then the play-by-play in the Watch view.
// Run: node tests/sim-scorers.test.mjs. Uses a saved slate (tests/fixtures/data-2026-11-18.json) and the app's own roster files.
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
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0, skips = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FEED }));

async function watchGame(gid) {
  await page.evaluate(gid => SB.goTab('sim', { gid, mode: 'watch' }), gid);
  await page.waitForSelector('[data-a="wnew"]', { timeout: 60000 });
  await page.click('[data-a="wnew"]');
  await page.waitForSelector('#smTk > div', { timeout: 240000 });
  await page.click('[data-a="wskip"]');
  await page.waitForTimeout(300);
}

try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && window.SB.firstRender && window.__lottos && window.__lottos.LOAD === 'done' && window.__firsttd && window.__sim, null, { timeout: 60000 });
  // 1. unit: the NBA scorer pools come from the roster model, the list sums to 100% of a team's top scorer
  const nba = await page.evaluate(() => {
    const g = SB.DATA.games.find(x => x.sport === 'nba') || { home: { abbr: 'PHI', name: 'Philadelphia' }, away: { abbr: 'IND', name: 'Indiana' }, sport: 'nba', id: 'x' };
    const pools = __sim.scorerPools(g);
    if (!pools) return null;
    const P = { g: 114, x: 0.02 };  // expected points per team (the simulator's own scale), a small home lean
    const L = __sim.likelyScorers(g, P);
    const sums = [0, 1].map(t => L.rows.filter(r => r.team === t).reduce((s, r) => s + r.pTop, 0));
    const pick = __sim.pickWho(pools[0]);
    return { home: g.home.abbr, n: pools.map(p => p.length), names0: pools[0].slice(0, 3).map(p => p.name), sums, top: L.rows.slice(0, 3).map(r => ({ name: r.name, pTop: +r.pTop.toFixed(3), mu: +r.mu.toFixed(1), p20: +r.p20.toFixed(3) })), pick: pools[0].some(p => p.name === pick) };
  });
  if (!nba) { skips++; console.log('SKIP NBA model :: no NBA roster data loaded'); }
  else {
    check('NBA: both teams have a scoring roster from the roster model', nba.n[0] > 0 && nba.n[1] > 0, JSON.stringify(nba.n));
    check('NBA: top-scorer chances add up to 100% for each team', nba.sums.every(s => Math.abs(s - 1) < 0.02), JSON.stringify(nba.sums));
    check('NBA: the favourite has the best chance to be top scorer, and 20+ chances are between 0 and 1', nba.top[0].pTop >= nba.top[1].pTop && nba.top.every(t => t.p20 >= 0 && t.p20 <= 1), JSON.stringify(nba.top));
    check('NBA: a play-by-play pick is always someone on the roster', nba.pick === true);
  }
  // 2. unit: NFL touchdown chances are per player, anytime chance grows with team expected points
  const nfl = await page.evaluate(() => {
    const g = SB.DATA.games.find(x => x.sport === 'nfl' && SB.priced(x) && SB.fit(x)) || SB.DATA.games.find(x => x.sport === 'nfl');
    if (!g) return null;
    const lo = __sim.likelyScorers(g, { g: 1.6, x: 0 }), hi = __sim.likelyScorers(g, { g: 2.6, x: 0 });
    return { lo: lo && lo.rows[0] && lo.rows[0].pAny, hi: hi && hi.rows[0] && hi.rows[0].pAny, n: lo && lo.rows.length, pools: __sim.scorerPools(g).map(p => p.length) };
  });
  if (!nfl || !nfl.n) { skips++; console.log('SKIP NFL model :: no NFL touchdown data'); }
  else {
    check('NFL: touchdown chances rise with the expected score', nfl.hi > nfl.lo && nfl.hi < 1, `${nfl.lo} → ${nfl.hi}`);
    check('NFL: both teams have touchdown scorers from the touchdown file', nfl.pools.every(n => n > 0), JSON.stringify(nfl.pools));
  }
  // 3. the Watch view: scorers named in the play-by-play and in the most-likely list (games the slate prices)
  const ids = await page.evaluate(() => {
    const ok = x => SB.priced(x) && SB.fit(x);
    const g = SB.DATA.games;
    return { nfl: (g.find(x => x.sport === 'nfl' && ok(x)) || {}).id, nba: (g.find(x => x.sport === 'nba' && ok(x)) || {}).id, nhl: (g.find(x => x.sport === 'nhl' && ok(x)) || {}).id };
  });
  if (ids.nfl) {
    await watchGame(ids.nfl);
    const log = await page.$$eval('#smTk > div', xs => xs.map(x => x.textContent));
    const tds = log.filter(t => /Touchdown/.test(t));
    check('play-by-play names the scorer on each touchdown', tds.length > 0 && tds.every(t => /·/.test(t)), tds.slice(0, 2).join(' | '));
    check('most-likely list is shown with touchdown chances', (await page.$$('.sm-likely .sm-row')).length >= 1);
  } else { skips++; console.log('SKIP Watch NFL :: no priced NFL game in the saved slate'); }
  if (ids.nba) {
    await watchGame(ids.nba);
    const log = await page.$$eval('#smTk > div', xs => xs.map(x => x.textContent));
    const pts = log.filter(t => /pointer|2 points/.test(t));
    check('play-by-play names the player on each basket', pts.length > 0 && pts.every(t => /·/.test(t)), pts.slice(0, 2).join(' | '));
  } else { skips++; console.log('SKIP Watch NBA :: no priced NBA game in the saved slate'); }
  if (ids.nhl) {
    await watchGame(ids.nhl);
    check('NHL says it has no player scoring data yet', /No NHL player scoring data yet/.test(await page.textContent('#simRoot')));
  } else { skips++; console.log('SKIP Watch NHL :: no priced NHL game in the saved slate'); }
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px over`);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASS'}${skips ? `, ${skips} skipped` : ''}`);
process.exit(fails ? 1 : 0);
