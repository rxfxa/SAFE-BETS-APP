// Weekend Patterns tab, three views: Next weekend (crazy-weekend meter, likeliest to slip with reasons, unbeaten runs on the
// line, parlays), 6 seasons (the research: causes tested vs prices, runs ending, months, craziest rounds) and The tweet
// (the 90-day test, live round, parlay mix). App cards: swap legs + 500,000 runs. Fixture: tests/fixtures/pattern-2026-11-23.json
// (90-day block + research run on data-2026-11-23.json). Run: node tests/pattern.test.mjs
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
const FX = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
const PTX = FX('pattern-2026-11-23.json'), PT = JSON.parse(PTX), R = PT.research;
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const errors = [];
async function open(data, clock, view) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(clock));
  await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FX(data) }));
  await page.route('**/pattern.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: PTX }));
  await page.addInitScript(v => { localStorage.setItem('fm2.tab', JSON.stringify('pattern')); if (v) localStorage.setItem('fm2.ptView', JSON.stringify(v)); }, view);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__pattern && __pattern.PT && /Weekend Patterns/.test(document.querySelector('#main').textContent) && !/Loading the research/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  return page;
}
const noScroll = async page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
try {
  // ---------- the research file itself ----------
  check('research: several seasons, 7 leagues, thousands of priced games and big favourites', R.seasons.length >= 5 && R.leagues.length === 7 && R.games > 10000 && R.bigFavs > 3000, `${R.seasons.length} seasons, ${R.games} games`);
  check('research: every cause has observed vs priced, an odds ratio with its range, a p-value and a Holm verdict', R.causes.length >= 12 && R.causes.every(c => c.n >= 30 && c.or > 0 && c.orLo <= c.or && c.or <= c.orHi && c.pReg >= 0 && c.pHolm >= c.pReg - 1e-9 && typeof c.holds === 'boolean'));
  check('research: Holm is step-down (once one fails, none after it holds)', (() => { const s = [...R.causes].sort((a, b) => a.pReg - b.pReg); let ok = true, seenFail = false; for (const c of s) { if (seenFail && c.holds) ok = false; if (!c.holds) seenFail = true; } return ok; })());
  check('research: the European-game causes are tested (from ESPN fixtures)', ['euroBefore', 'euroAfter', 'dogEuroBefore'].every(k => R.causes.some(c => c.key === k)) && R.euroGames > 1000 && R.euroTeams >= 40, `${R.euroGames} games, ${R.euroTeams} teams`);
  check('research: unbeaten runs, months, calibration, craziest rounds, rounds vs chance', R.unbeatenRuns.length >= 4 && R.months.length >= 8 && R.calib.buckets.length >= 4 && R.craziest.length >= 5 && R.rounds.rounds > 100 && R.rounds.crazyChanceCal > 0);
  check('research: forecast for the next round with model and priced chances per favourite', R.forecast && R.forecast.legs.length >= 3 && R.forecast.legs.every(l => l.priced > 0 && l.priced <= .4 && l.model > 0 && Array.isArray(l.reasons)) && R.forecast.typical > 0);

  // ---------- Next weekend (default view) ----------
  let page = await open('data-2026-11-23.json', '2026-11-23T12:00:00Z', null);
  let txt = await page.textContent('#main');
  check('the tab opens on Next weekend with the crazy-weekend meter', /Crazy weekend meter/.test(txt) && (await page.evaluate(() => __pattern.view)) === 'next');
  const X = await page.evaluate(() => { const x = __pattern.forecast(); return { n: x.n, need: x.need, p: x.pCrazy, sum: x.dist.reduce((a, b) => a + b, 0), tail: x.dist.slice(x.need).reduce((a, b) => a + b, 0), legs: x.legs.map(l => ({ gid: l.gid, q: l.q, fav: l.favSide })) }; });
  check('the meter shows the exact chance that 40%+ of the big favourites drop points', Math.abs(X.sum - 1) < 1e-9 && Math.abs(X.tail - X.p) < 1e-12 && X.need === Math.ceil(.4 * X.n - 1e-9) && txt.includes(`${Math.round(X.p * 100)}%`) && txt.includes(`${X.need}+ of the ${X.n} big favourites`), JSON.stringify({ n: X.n, need: X.need, p: X.p }));
  check('it is compared with a typical round of the same leagues and the same number of big favourites', new RegExp(`typical ${Math.round(R.forecast.typical * 100)}%`).test(txt) && /(About a normal|Wilder than a normal|Quieter than a normal) weekend/.test(txt) && new RegExp(`with ${R.forecast.favs} big favourites has a ${Math.round(R.forecast.typical * 100)}% chance by the same research estimate \\(${Math.round(R.forecast.typicalPriced * 100)}% at the prices alone\\)`).test(txt));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#main .panel')][0].querySelectorAll('.mrow').length);
  check('one row per big favourite, likeliest to slip first, each with its reasons and what the research found', rows === X.n && /Likeliest to slip/.test(txt) && /no proven effect|a hint, not proven|held up/.test(txt), `${rows} rows vs ${X.n}`);
  check('unbeaten runs on the line, with the chance each ends', !R.runsNow.length || (/Unbeaten runs on the line/.test(txt) && R.runsNow.every(r => txt.includes(r.team)) && /are not "due" to end/.test(txt)));
  const C = await page.evaluate(() => __pattern.nextCards(__pattern.forecast()).map(c => ({ id: c.id, legs: c.legs.map(l => ({ gid: l.gid, key: l.key, p: l.p })) })));
  const by = Object.fromEntries(C.map(c => [c.id, c])), fav = Object.fromEntries(R.forecast.legs.map(l => [l.gid, l.favSide]));
  check('crazy-weekend lottos: underdog-or-draw against the favourites likeliest to slip', by['pt-crazy3'] && by['pt-crazy3'].legs.length === 3 && by['pt-crazy3'].legs.every(l => l.key === (fav[l.gid] === 'home' ? 'DCX2' : 'DC1X')) && (!by['pt-crazy5'] || by['pt-crazy5'].legs.length === 5), Object.keys(by).join(','));
  const top3 = [...X.legs].sort((a, b) => b.q - a.q).slice(0, 3).map(l => l.gid).sort().join();
  check('the 3-upset lotto takes the three highest research estimates', by['pt-crazy3'].legs.map(l => l.gid).sort().join() === top3);
  check('the steady weekend backs the surest favourites to win; every card uses different games', by['pt-steady'] && by['pt-steady'].legs.every(l => l.key === (fav[l.gid] === 'home' ? 'H' : 'A')) && C.every(c => new Set(c.legs.map(l => l.gid)).size === c.legs.length));
  check('the runs card bets each long run to end (the opponent to win)', !by['pt-runs'] || by['pt-runs'].legs.every(l => { const r = R.runsNow.find(x => x.gid === l.gid); return r && l.key === (r.side === 'home' ? 'A' : 'H'); }));
  check('the cards are the app\'s: swap buttons and the 500,000-run button', (await page.locator('[data-sub^="pt-crazy3|"]').count()) > 0 && (await page.locator('[data-sim5="pt-crazy3"]').count()) === 1);
  await page.locator('[data-sim5="pt-crazy3"]').click();
  await page.waitForFunction(() => __fm2.SIM5['pt-crazy3'], null, { timeout: 30000 });
  const S = await page.evaluate(() => __fm2.SIM5['pt-crazy3']);
  check('a crazy-weekend parlay simulates 500,000 runs', S.N === 500000, `${S.hits}`);
  const b0 = page.locator('#main .panel').first().locator('[data-leg]').first(), lk = await b0.getAttribute('data-leg');
  await b0.click();
  check('"underdog or draw" buttons add the leg to the slip', await page.evaluate(k => __fm2.slip.some(L => L.gid + '|' + L.key === k), lk), lk);
  // a finished game counts as it ended - and, as in the real feed, a finished game has no prices any more
  const fin = await page.evaluate(() => { const x0 = __pattern.forecast(), L = x0.legs[0], g = SB.gameById(L.gid), keep = { status: g.status, score: g.score, prob: g.prob };
    g.status = 'closed'; g.prob = null; g.score = L.favSide === 'home' ? { home: 0, away: 1 } : { home: 1, away: 0 };
    let x1, err = null, txt = '';
    try { x1 = __pattern.forecast(); SB.render(); txt = document.querySelector('#main').textContent; } catch (e) { err = e.message; }
    const l1 = x1 && x1.legs.find(l => l.gid === L.gid);
    const cards = x1 ? __pattern.nextCards(x1).map(c => ({ id: c.id, gids: c.legs.map(l => l.gid) })) : [];
    Object.assign(g, keep); if (!keep.score) delete g.score; SB.render();
    return { err, done: x1 && x1.done, failed: x1 && x1.failed, q: l1 && l1.q, up: x1 && x1.pCrazy > x0.pCrazy, page: /Crazy weekend meter/.test(txt) && /So far 1 of 1 finished have dropped points/.test(txt) && /✗ slipped/.test(txt), inCards: cards.some(c => c.gids.includes(L.gid)) }; });
  check('a finished favourite with no prices left (as the feed sends it) counts as a fail, the meter goes up and the page still renders', !fin.err && fin.done === 1 && fin.failed === 1 && fin.q === 1 && fin.up && fin.page, JSON.stringify(fin));
  check('a finished game is never offered in a parlay card', fin.inCards === false);
  const cr = await page.evaluate(() => { const x = __pattern.forecast(), C = __pattern.nextCards(x), by = Object.fromEntries(C.map(c => [c.id, c.legs.map(l => l.gid)])), open = x.legs.filter(l => !l.done).length;
    return { open, c3: by['pt-crazy3'] || null, c5: by['pt-crazy5'] || null, st: by['pt-steady'] || [] }; });
  check('card rules: 3 upsets only with 3+ open favourites, 5 only with 5+, steady never on the 3-upset games', (cr.open >= 3 ? cr.c3 && cr.c3.length === 3 : !cr.c3) && (cr.open >= 5 ? cr.c5 && cr.c5.length === 5 : !cr.c5) && !(cr.c3 || []).some(g => cr.st.includes(g)), JSON.stringify(cr));
  check('Next weekend at 390px: no horizontal scroll', (await noScroll(page)) <= 0, `${await noScroll(page)}px`);

  // ---------- 6 seasons ----------
  await page.click('#ptSeg [data-v="research"]');
  await page.waitForFunction(() => /What makes a big favourite slip/.test(document.querySelector('#main').textContent));
  txt = await page.textContent('#main');
  check('6 seasons: the honest answer up top', /Can you predict a crazy weekend\?/.test(txt) && (R.causes.some(c => c.holds) ? /held up\./.test(txt) : /Not beyond the odds\./.test(txt) && /None of the \d+ suspected causes/.test(txt)));
  check('6 seasons: favourites vs prices, ROI at real closing odds, crazy rounds vs chance, long runs ending', txt.includes(R.overall.fails.toLocaleString()) && /backing every big favourite at the real closing odds/.test(txt) && txt.includes(`${R.rounds.crazyRounds} / ${R.rounds.rounds}`) && /unbeaten runs of 10\+ that ended next game/.test(txt));
  check('6 seasons: every cause listed with its verdict', R.causes.every(c => txt.includes(c.desc)) && (txt.match(/no proven effect|a hint, not proven|held up/g) || []).length >= R.causes.length);
  check('6 seasons: prices vs results, runs, months, craziest rounds with real scorelines', /Prices vs results/.test(txt) && /Unbeaten runs: how often they end/.test(txt) && /By month/.test(txt) && txt.includes(R.craziest[0].examples[0]));
  check('6 seasons at 390px: no horizontal scroll', (await noScroll(page)) <= 0, `${await noScroll(page)}px`);
  check('the chosen view is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('fm2.ptView'))) === 'research');
  await page.context().close();

  // ---------- The tweet (90 days) ----------
  page = await open('data-2026-11-22.json', '2026-11-22T10:00:00Z', 'tweet');
  await page.waitForFunction(() => /Round by round/.test(document.querySelector('#main').textContent), null, { timeout: 60000 });
  txt = await page.textContent('#main');
  check('the tweet view answers the tweet with the 90-day verdict', txt.includes(PT.verdict.slice(0, 60)));
  check('each claim is checked against chance (all big teams lose, 80% draws, swings, early slips, carry-over)', ['A weekend where every big favourite lost', 'A weekend with 80% draws', 'Rounds swing more than chance', 'Early slips mean later slips', 'An upset weekend predicts the next one'].every(s => txt.includes(s)));
  check('returns at closing odds are shown for favourites, draws and betting against favourites', /Big favourites to win/.test(txt) && /Every draw/.test(txt) && /Against big favourites/.test(txt));
  check('one row per round, one row per league', (await page.locator('.ptrow').count()) === PT.weeks.length && PT.calibration.every(c => txt.includes(c.comp)), `${await page.locator('.ptrow').count()} rows vs ${PT.weeks.length}`);
  check('the live round tracker is on the page', /This round, live/.test(txt) && /games still to play/.test(txt));
  const T = await page.evaluate(() => __pattern.parlays());
  const tb = Object.fromEntries(T.cards.map(c => [c.id, c]));
  check('a mix of parlays for the next round (favourites, cushion, chaos, draws, the mix)', ['pt-fav', 'pt-safe', 'pt-chaos', 'pt-draw', 'pt-mix'].filter(k => tb[k]).length >= 4, Object.keys(tb).join(','));
  const games = await page.evaluate(ids => ids.map(id => { const g = SB.DATA.games.find(x => x.id === id); const p = g.prob, s = p.home + (p.draw || 0) + p.away; return { h: p.home / s, a: p.away / s, d: (p.draw || 0) / s }; }), T.cards.flatMap(c => c.legs.map(l => l.gid)));
  let k = 0; const gi = {}; T.cards.forEach(c => c.legs.forEach(l => { gi[c.id + l.gid + l.key] = games[k++]; }));
  const g = (c, l) => gi[c.id + l.gid + l.key];
  check('favourite legs are big favourites (60%+) to win', tb['pt-fav'].legs.every(l => (l.key === 'H' ? g(tb['pt-fav'], l).h : g(tb['pt-fav'], l).a) >= .6 && (l.key === 'H' || l.key === 'A')));
  check('chaos legs are against the favourite (underdog or draw)', !tb['pt-chaos'] || tb['pt-chaos'].legs.every(l => { const q = g(tb['pt-chaos'], l); return (l.key === 'DCX2' && q.h > q.a) || (l.key === 'DC1X' && q.a > q.h); }));
  check('draw legs are in even games (within 20 points)', !tb['pt-draw'] || tb['pt-draw'].legs.every(l => { const q = g(tb['pt-draw'], l); return l.key === 'D' && Math.abs(q.h - q.a) < .2; }));
  check('the mix uses five different games', !tb['pt-mix'] || new Set(tb['pt-mix'].legs.map(l => l.gid)).size === tb['pt-mix'].legs.length);
  check('the tweet view at 390px: no horizontal scroll', (await noScroll(page)) <= 0, `${await noScroll(page)}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
