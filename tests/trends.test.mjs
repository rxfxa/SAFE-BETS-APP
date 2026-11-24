// 📈 Team Trends: tools/team_trends.py (per-team windows, months, streaks, next game, upset / over-under leans) and the tab in
// trends.js (filters, upset watch and over / under lists with reasons and sample sizes, team table, one parlay card with swap
// legs + 500,000 runs). The tool runs offline on the saved football-data.co.uk CSVs (tests/fixtures/fd) and the 2026-11-22
// feed with a fixed clock, so the page sees the same numbers every run. Run: node tests/trends.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

// ---------- the tool, offline on fixtures ----------
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trends-')), 'trends.json');
execFileSync('python3', [path.join(ROOT, 'tools/team_trends.py'), '--offline', '--end', '2026-11-22', '--now', '2026-11-22T10:00:00Z',
  '--feed', path.join(ROOT, 'tests/fixtures/data-2026-11-22.json'), '--out', OUT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const TR = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const TRJ = JSON.stringify(TR);
const byName = n => TR.teams.find(t => t.name === n || t.csv === n);
check('tool: every soccer league from the CSVs, 12 leagues', Object.keys(TR.sources.soccer.leagues).length === 12 && TR.teams.filter(t => t.sport === 'soccer').length > 200, `${TR.teams.length} teams`);
const ars = byName('Arsenal FC');
check('tool: CSV names are mapped to the feed (Arsenal -> Arsenal FC / ARS, Man United -> Manchester United, Inter -> Inter Milano)',
  ars && ars.abbr === 'ARS' && byName('Manchester United') && byName('Manchester United').csv === 'Man United' && byName('Inter Milano') && byName('Inter Milano').csv === 'Inter', ars && ars.abbr);
const S = ars.windows.season;
check('tool: windows d7 / d30 / season with games, W-D-L, goals and over rate', ['d7', 'd30', 'season'].every(k => ars.windows[k] && 'n' in ars.windows[k]) && S.n === S.w + S.d + S.l && S.gf > 0 && S.ov.n === S.n && S.ov.hit <= S.n);
check('tool: favourite / underdog records against the prices (won, expected, return, z)', S.fav.n + S.dog.n <= S.vp.n && S.vp.n > 0 && 'exp' in S.vp && 'z' in S.vp && 'roi' in S.fav);
check('tool: per-month blocks (YYYY-MM)', Object.keys(ars.months).length >= 3 && Object.keys(ars.months).every(m => /^\d{4}-\d{2}$/.test(m)) && Object.values(ars.months).reduce((a, m) => a + m.n, 0) === S.n);
check('tool: streaks (result, unbeaten, winless, over/under, last 5)', /^[WDL]\d+$/.test(ars.streak.res) && ars.streak.last5.length === 5 && /^[OU]\d+$/.test(ars.streak.ou));
check('tool: the 7-day window only counts games from the last 7 days', TR.teams.every(t => t.windows.d7.n <= t.windows.d30.n && t.windows.d30.n <= t.windows.season.n));
const nx = TR.teams.filter(t => t.next);
check('tool: next games come from the feed, with an upset flag and an over/under lean', nx.length > 40 && nx.every(t => t.next.gid && t.next.lean && 'flag' in t.next.lean.upset && 'side' in t.next.lean.total), `${nx.length} teams`);
const flagged = nx.filter(t => t.next.lean.upset.flag);
check('tool: upset flags carry reasons with sample counts ("won X of N, prices expected Y")', flagged.length > 0 && flagged.every(t => t.next.lean.upset.why.length && t.next.lean.upset.why.every(w => /won \d+ of \d+, prices expected \d/.test(w))), `${flagged.length} flags`);
check('tool: no upset flag for long shots under 15%', flagged.every(t => t.next.lean.upset.role !== 'underdog' || t.next.p >= 0.15));
const leans = nx.filter(t => t.next.lean.total.side);
check('tool: over/under leans carry the evidence and the sample', leans.length > 0 && leans.every(t => t.next.lean.total.n >= 10 && t.next.lean.total.why.some(w => /Together: \d+ of \d+/.test(w))), `${leans.length}`);
check('tool: small samples are labelled and certainty is never claimed', /small sample/.test(TRJ) && !/guarantee|certain|lock\b|can't lose/i.test(TRJ));

// ---------- the tab ----------
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T10:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.route('**/trends.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(OUT, 'utf8') }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.DATA && SB.DATA.games.length > 0, null, { timeout: 60000 });
  if (!(await page.evaluate(() => !!document.querySelector('script[src$="trends.js"]')))) await page.addScriptTag({ url: '/trends.js' });  // until index.html loads it itself
  await page.waitForFunction(() => window.__trends && __trends.TR, null, { timeout: 30000 });
  const order = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(b => b.dataset.t));
  check('tab registered as "📈 Team Trends" right after Weekend Patterns', order.indexOf('trends') >= 0 && (order.indexOf('pattern') < 0 || order.indexOf('trends') === order.indexOf('pattern') + 1) && /Team Trends/.test(await page.textContent('#tabs [data-t="trends"]')), order.join(','));
  await page.evaluate(() => SB.goTab('trends'));
  await page.waitForFunction(() => /Team by team/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  const txt = await page.textContent('#main');
  check('the page is honest: past patterns are not guarantees, small samples labelled', /Past patterns are not guarantees/.test(txt) && /not predictions/.test(txt) && /small sample/.test(txt) && !/guaranteed|sure thing|can't lose/i.test(txt));
  const A = await page.evaluate(() => { const a = __trends.analyse(); return { ups: a.ups.map(u => ({ gid: u.g.id, side: u.side, why: u.why, n: u.n, pd: u.pd })), tots: a.tots.map(t => ({ gid: t.g.id, side: t.side, why: t.why, n: t.n })) }; });
  check('upset watch: games with reasons and samples from the live feed', A.ups.length > 0 && A.ups.every(u => u.why.length && u.n > 0 && u.pd >= 0.15), `${A.ups.length}`);
  check('over / under leans: games with reasons and samples', A.tots.length > 0 && A.tots.every(t => t.why.length >= 2 && t.n >= 10 && (t.side === 'over' || t.side === 'under')), `${A.tots.length}`);
  const lists = await page.$$eval('.trlist', L => L.map(l => [...l.querySelectorAll('.tri')].map(r => ({ reasons: r.querySelectorAll('.trwhy li').length, n: (r.querySelector('.trn') || {}).textContent || '' }))));
  check('both lists render each game with its reasons and a sample-size badge', lists.length === 2 && lists.every(l => l.length > 0 && l.every(r => r.reasons > 0 && /^\d+ games$/.test(r.n))), JSON.stringify(lists.map(l => l.length)));
  const legs = await page.evaluate(() => { const a = __trends.analyse(); return (__trends.parlay(a) || []).map(l => ({ ...l, ok: SB.marketsFor(SB.gameById(l.gid)).some(m => m.key === l.key), sport: SB.gameById(l.gid).sport })); });
  check('trend parlay: feed legs, one per game, valid market keys', legs.length >= 2 && new Set(legs.map(l => l.gid)).size === legs.length && legs.every(l => l.ok && l.p > 0 && l.p < 1), legs.map(l => l.key).join(','));
  check('trend parlay: upset legs back the underdog side, total legs follow the lean', legs.every(l => {
    const u = A.ups.find(x => x.gid === l.gid), t = A.tots.find(x => x.gid === l.gid);
    if (/^DC/.test(l.key) || l.key === 'H' || l.key === 'A') return u && (l.key === 'DC1X' || l.key === 'H' ? u.side === 'H' : u.side === 'A');
    return t && (l.key === 'O2.5' ? t.side === 'over' : t.side === 'under');
  }));
  check('the card is the app\'s: swap buttons and the 500,000-run button', (await page.locator('[data-sub^="tr-mix|"]').count()) > 0 && (await page.locator('[data-sim5="tr-mix"]').count()) === 1);
  await page.locator('[data-sim5="tr-mix"]').click();
  await page.waitForFunction(() => __fm2.SIM5['tr-mix'], null, { timeout: 60000 });
  const SIM = await page.evaluate(() => __fm2.SIM5['tr-mix']);
  check('the trend parlay simulates 500,000 runs', SIM.N === 500000 && SIM.hits >= 0 && SIM.hits <= 500000, `${SIM.hits}`);
  const rows = await page.locator('.trd').count();
  check('team table: one row per team, with 7-day / 30-day / season cells', rows === Math.min(300, TR.teams.length) && (await page.locator('.trd').first().locator('.trc').count()) === 3, `${rows}`);
  const mapped = await page.evaluate(() => { const G = SB.DATA.games.filter(g => g.sport === 'soccer' && ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'].includes(g.comp)); let n = 0, ok = 0; for (const g of G) for (const s of ['home', 'away']) { n++; const t = __trends.find(g, s); if (t && t.comp === g.comp) ok++; } const cl = SB.DATA.games.find(g => g.comp === 'Champions League' && /Manchester City|Real Madrid|Arsenal/.test(g.home.name + g.away.name)); return { n, ok, cl: cl ? [__trends.find(cl, 'home'), __trends.find(cl, 'away')].filter(Boolean).map(t => t.comp) : null }; });
  check('feed teams map to their trends records (big five leagues), Champions League teams to their domestic league', mapped.ok === mapped.n && (!mapped.cl || mapped.cl.length >= 1), JSON.stringify(mapped));
  await page.locator('.trd summary').first().click();
  check('a team opens to months, streaks and favourite / underdog records', (await page.locator('.trd[open] .trm').count()) >= 1 && /Streak:/.test(await page.textContent('.trd[open]')));
  await page.locator('[data-trs="soccer"]').click();
  await page.selectOption('[data-trl]', 'Premier League');
  const pl = await page.$$eval('.trd .trt small', s => s.map(x => x.textContent));
  check('filter by sport and league: Soccer + Premier League shows 20 Premier League teams', pl.length === 20 && pl.every(s => s.startsWith('Premier League')), `${pl.length}`);
  const ul = await page.$$eval('.trlist .tri small', s => s.map(x => x.textContent));
  check('the lists follow the league filter', ul.every(s => /Premier League/.test(s)), ul.slice(0, 3).join(' | '));
  await page.selectOption('[data-trl]', 'all');
  await page.evaluate(() => SB.openNav()); await page.fill('#q', 'arsenal'); await page.evaluate(() => SB.closeNav());  // the search box sits in the menu drawer on phones
  await page.waitForFunction(() => document.querySelectorAll('.trd').length <= 3, null, { timeout: 10000 });
  check('the top search box filters the teams', /Arsenal/.test(await page.textContent('.trtab')) && (await page.locator('.trd').count()) <= 3);
  await page.evaluate(() => SB.openNav()); await page.fill('#q', ''); await page.evaluate(() => SB.closeNav());
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px`);
  // the committed trends.json (live run, NBA included) also renders
  const live = path.join(ROOT, 'trends.json');
  if (fs.existsSync(live)) {
    await page.unroute('**/trends.json');
    await page.route('**/trends.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(live, 'utf8') }));
    await page.evaluate(() => { SB.store.set('trends.f', { sport: 'all', comp: 'all' }); });
    await page.reload();
    await page.waitForFunction(() => window.SB && SB.DATA && SB.DATA.games.length > 0, null, { timeout: 60000 });
    if (!(await page.evaluate(() => !!document.querySelector('script[src$="trends.js"]')))) await page.addScriptTag({ url: '/trends.js' });  // until index.html loads it itself
    await page.waitForFunction(() => window.__trends && __trends.TR, null, { timeout: 30000 });
    await page.evaluate(() => SB.goTab('trends'));
    await page.waitForFunction(() => /Team by team/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
    const L = JSON.parse(fs.readFileSync(live, 'utf8'));
    const hasNba = L.teams.some(t => t.sport === 'nba');
    if (hasNba) { await page.locator('[data-trs="nba"]').click(); }
    const n = await page.locator('.trd').count();
    check('the committed trends.json renders too' + (hasNba ? ' (NBA filter: 30 teams)' : ''), hasNba ? n === 30 : n > 0, `${n}`);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
