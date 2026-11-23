// Trending → My Parlay Picks: 3 exact-score parlays, a 5-leg same game parlay, a 10-leg all-sports mix, a 15-leg NBA props
// parlay (2 per game, every game), 3- and 5-leg underdog moneylines; all legs on one day; chosen once a day. Run: node tests/mypicks.test.mjs
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
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T10:00:00Z'));  // 2 AM in Los Angeles, Sunday Nov 22
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.route('**/recs.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"days":[]}' }));  // the track record has its own test
let SERVER = null;  // the daily job's file; null = not published yet
await page.route('**/mypicks.json', r => SERVER ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SERVER) }) : r.fulfill({ status: 404, body: 'nf' }));
const legsOf = () => page.evaluate(() => {
  const M = __fm2.myPicks(), F = __fm2, out = { day: M.day, src: M.src, by: {} };
  for (const P of M.parlays) out.by[P.id] = { p: P.p, need: P.need, games: P.games, legs: P.legs.map(L => ({ ...L, d: F.dayOf(Date.parse(L.start)) })) };
  out.nbaGames = F.dayGames(M.day).filter(g => g.sport === 'nba' && F.DATA.players.some(p => p.gid === g.id && p.status === 'active')).map(g => g.id);
  out.dayGameCount = F.dayGames(M.day).length;
  out.dogSides = M.parlays.filter(P => P.id.startsWith('dog')).flatMap(P => P.legs.map(L => { const g = F.DATA.games.find(x => x.id === L.gid); return { key: L.key, mine: F.p1(g, L.key), other: F.p1(g, L.key === 'H' ? 'A' : 'H') }; }));
  return out;
});
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 60000 });
  await page.evaluate(() => SB.goTab('trending'));
  check('Trending has the "My Parlay Picks" switch', await page.locator('#trSeg [data-v="picks"]').count() === 1);
  await page.click('#trSeg [data-v="picks"]');
  await page.waitForSelector('#mpNbaSeg');
  check('the picks page is headed "My Parlay Picks"', /My Parlay Picks/.test(await page.locator('#main h2').first().textContent()));
  const A = await legsOf();
  const all = Object.values(A.by).flatMap(x => x.legs);
  check('picks are for Nov 22 (today in Los Angeles)', A.day === '2026-11-22', A.day);
  check('every leg of every parlay is on that day', all.length > 0 && all.every(L => L.d === A.day), [...new Set(all.map(L => L.d))].join(','));
  for (const k of ['exact1', 'exact2', 'exact3']) {
    const P = A.by[k];
    check(`${k}: 3 exact-score legs from 3 different soccer games`, P && P.legs.length === 3 && P.legs.every(L => /^CS\d-\d$/.test(L.key) && L.sport === 'soccer') && new Set(P.legs.map(L => L.gid)).size === 3, JSON.stringify(P && P.legs.map(L => L.label)));
  }
  const ex = ['exact1', 'exact2', 'exact3'].map(k => A.by[k].legs.map(L => L.gid + L.key).sort().join());
  check('the three exact-score parlays are different', new Set(ex).size === 3);
  const sg = A.by.sgp5;
  check('same game parlay: 5 legs from one game', sg.legs.length === 5 && new Set(sg.legs.map(L => L.gid)).size === 1, JSON.stringify(sg.legs.map(L => L.label)));
  const mx = A.by.mixed10, per = {};
  mx.legs.forEach(L => per[L.gid] = (per[L.gid] || 0) + 1);
  check('10-leg mix: 10 legs, 3+ sports, 4+ leagues, one per game', mx.legs.length === 10 && new Set(mx.legs.map(L => L.sport)).size >= 3 && new Set(mx.legs.map(L => L.comp)).size >= 4 && Math.max(...Object.values(per)) === 1,
    JSON.stringify({ n: mx.legs.length, sports: [...new Set(mx.legs.map(L => L.sport))], comps: [...new Set(mx.legs.map(L => L.comp))].length }));
  for (const k of ['nba15', 'nba15up']) {
    const nb = A.by[k], pg = {};
    nb.legs.forEach(L => pg[L.gid] = (pg[L.gid] || 0) + 1);
    check(`${k}: player props only, 2 per game at most, every NBA game, ${Math.min(15, 2 * A.nbaGames.length)} legs`, nb.legs.length === Math.min(15, 2 * A.nbaGames.length) && nb.legs.every(L => L.key.startsWith('P:') && L.sport === 'nba') && Math.max(...Object.values(pg)) <= 2 && A.nbaGames.every(id => pg[id] >= 1),
      JSON.stringify({ n: nb.legs.length, games: A.nbaGames.length, pg }));
    check(`${k}: one leg per player`, new Set(nb.legs.map(L => L.label.replace(/ \d+\+.*/, ''))).size === nb.legs.length);
  }
  const avgOf = await page.evaluate(keys => keys.map(k => { const id = k.split(':')[1], thr = +k.split(':')[2], pl = __fm2.DATA.players.find(p => p.id === id); return { thr, avg: pl.avg, stat: pl.stat }; }), [...A.by.nba15.legs, ...A.by.nba15up.legs].map(L => L.key));
  const half = A.by.nba15.legs.length;
  check('lines are a point or two from the average (points 2, rebounds / assists 1): under it, then over it', avgOf.every((x, i) => { const d = x.stat === 'pts' ? 2 : 1, b = Math.round(x.avg); return i < half ? x.thr === Math.max(1, b - d) : x.thr === b + d; }), JSON.stringify(avgOf.slice(0, 3)));
  check('underdogs: 3 and 5 moneylines', A.by.dog3.legs.length === 3 && A.by.dog5.legs.length === 5 && [...A.by.dog3.legs, ...A.by.dog5.legs].every(L => L.key === 'H' || L.key === 'A'));
  check('every underdog is the less likely side and 25-46%', A.dogSides.every(x => x.mine < x.other && x.mine >= .25 && x.mine <= .46), JSON.stringify(A.dogSides.map(x => +x.mine.toFixed(3))));
  check('one leg per game in each underdog parlay', ['dog3', 'dog5'].every(k => new Set(A.by[k].legs.map(L => L.gid)).size === A.by[k].legs.length));
  const cards = await page.locator('#main .pc').count();
  check('8 cards on the page (3 exact, SGP, mix, NBA, 2 underdog)', cards === 8, `cards=${cards}`);
  await page.click('#mpNbaSeg [data-v="above"]');
  check('NBA switch shows the over-average parlay', /above average/.test(await page.locator('#main').textContent()));
  // QA fixes: long shots keep their real price; card saves keep what grading needs, once
  const up = await page.evaluate(() => [...document.querySelectorAll('#main .pc')].find(c => /above average/.test(c.textContent)).querySelector('.odds').textContent);
  check('a 0.003% ticket is not priced at the old +999900 cap', !/\+999900\b/.test(up) && /\+\d{6,}/.test(up.replace(/,/g, '')), up);
  await page.locator('[data-savep="mp-dog3"]').click();
  await page.locator('[data-savep="mp-dog3"]').click();
  const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('fm2.saved') || '[]'));
  check('＋ My Parlays saves once (second tap is a no-op)', sv.length === 1, `saved=${sv.length}`);
  check('a card-saved leg keeps start, teams and its chance (so it can be graded after the game leaves the feed)', sv[0] && sv[0].legs.every(L => L.start && L.home && L.away && L.p1 > 0) && sv[0].dec == null, JSON.stringify(sv[0] && sv[0].legs[0]));
  // a postponed leg is void: the rest winning makes the card Won
  const vw = await page.evaluate(() => {
    const M = __fm2.myPicks(), P = M.parlays.find(x => x.id === 'dog3'), D = __fm2.DATA;
    const gs = P.legs.map(L => D.games.find(g => g.id === L.gid)), keep = gs.map(g => ({ status: g.status, score: g.score, start: g.start }));
    gs[0].status = 'postponed';
    for (let i = 1; i < gs.length; i++) { const L = P.legs[i]; gs[i].status = 'closed'; gs[i].score = L.key === 'H' ? { home: 3, away: 1 } : { home: 1, away: 3 }; gs[i].start = '2026-11-21T20:00:00Z'; }
    SB.render(); const c = [...document.querySelectorAll('#main .pc')].find(x => /Underdog moneylines · 3 legs/.test(x.textContent));
    const t = c.querySelector('.hit').textContent;
    gs.forEach((g, i) => Object.assign(g, keep[i])); if (!keep[0].score) delete gs[0].score; SB.render();
    return t;
  });
  check('a postponed leg is void and the other legs winning grades the card Won', /Won/.test(vw), vw);
  // chosen once a day: a reload hours later with moved prices keeps the same legs
  await page.clock.setFixedTime(new Date('2026-11-22T15:00:00Z'));
  await page.route('**/data.json', r => { const d = JSON.parse(DATA); for (const g of d.games) if (g.prob && g.sport !== 'soccer') { g.prob.home = Math.min(.95, g.prob.home + .04); g.prob.away = 1 - g.prob.home; } r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) }); });
  await page.reload();
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 60000 });
  const B = await legsOf();
  const sig = X => Object.entries(X.by).map(([k, v]) => k + ':' + v.legs.map(L => L.gid + L.key).join(',')).join('|');
  check('picks are locked for the day: same legs after a reload with new prices', sig(A) === sig(B) && B.src === 'device', B.src);
  // the daily job's file wins over this device's lock
  SERVER = { v: 1, day: '2026-11-22', made: '2026-11-22T11:47:00Z', parlays: [{ id: 'dog3', title: 'Underdog moneylines · 3 legs', sub: '', legs: A.by.dog5.legs.slice(2, 5).map(({ d, ...L }) => L), p: .05, need: 3 }] };
  await page.reload();
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 60000 });
  await page.waitForSelector('#mpNbaSeg');
  const C = await legsOf();
  check('the daily run\'s mypicks.json is used when it is for today', C.src === 'daily' && C.by.dog3.legs.map(L => L.gid).join() === A.by.dog5.legs.slice(2, 5).map(L => L.gid).join(), C.src);
  check('the page says the picks came from the daily run', /by the daily run/.test(await page.locator('#main').textContent()));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
