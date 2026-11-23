// Track record and replacements: every parlay the app made is graded the next morning (recs.json); a missed My Parlay Picks
// card gets a replacement of the same kind; legs can be swapped inside the parlay builder. Run: node tests/recs.test.mjs
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
const F = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T21:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: F('data-2026-11-22.json') }));
await page.route('**/recs.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: F('recs-2026-11-22.json') }));
await page.route('**/mypicks.json', r => r.fulfill({ status: 404, body: 'nf' }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 60000 });
  await page.evaluate(() => SB.goTab('trending'));
  await page.click('#trSeg [data-v="picks"]');
  await page.waitForSelector('#mpNbaSeg');
  const txt = await page.textContent('#main');
  check('the picks page shows how yesterday\'s parlays did, graded leg by leg', /How our parlays did/.test(txt) && /Missed/.test(txt) && /✗ Cade Cunningham 15\+ points \(5 pts\)/.test(txt), '');
  check('a tally per parlay type with what the model expected', /Exact score/.test(txt) && /won 0 of 3 · the model expected/.test(txt));
  check('lessons: which kinds of legs lose vs what the model expected, and what to do next time', /Lessons so far/.test(txt) && /hit \d+ of \d+ \(\d+%\) vs \d+% the model expected/.test(txt));
  // the recommended swap next to each leg, with reasons
  await page.locator('[data-subrec="mp-nba15|0"]').click();
  await page.waitForSelector('[data-subuse]');
  const sheet = await page.evaluate(() => ({ rec: document.querySelectorAll('.subrec').length, first: (document.querySelector('.subrec .subwhy') || {}).textContent || '', all: [...document.querySelectorAll('.subwhy')].map(x => x.textContent) }));
  check('★ Rec next to a leg opens the swaps with one marked RECOMMENDED, on top', sheet.rec === 1 && /RECOMMENDED/.test(await page.locator('#sheet .mrow').first().textContent()), JSON.stringify(sheet.first));
  check('every swap says why (value, fit with the card, game / opponent, recent form)', sheet.all.length >= 3 && sheet.all.every(w => /same chance|likelier|longer/.test(w)) && sheet.all.some(w => /cleared \d\/\d recent games|close game|blowout risk|feed|compete/.test(w)), JSON.stringify(sheet.all.slice(0, 3)));
  await page.keyboard.press('Escape');
  // a missed pick gets a replacement of the same kind from games still to play
  const rep = await page.evaluate(() => {
    const M = __fm2.myPicks(), P = M.parlays.find(x => x.id === 'dog3'), D = __fm2.DATA, g = D.games.find(x => x.id === P.legs[0].gid);
    const keep = { status: g.status, score: g.score, start: g.start };
    g.status = 'closed'; g.start = '2026-11-22T18:00:00Z'; g.score = P.legs[0].key === 'H' ? { home: 0, away: 3 } : { home: 3, away: 0 };  // the underdog lost
    SB.render();
    const cards = [...document.querySelectorAll('#main .pc')].map(c => c.querySelector('.pctitle') && c.querySelector('.pctitle').textContent);
    const T = __fm2.autoCache['mprep-dog3'];
    const out = { cards: cards.filter(t => /Replacement/.test(t || '')), n: T ? T.legs.length : 0, open: T ? T.legs.every(L => { const x = D.games.find(y => y.id === L.gid); return x && Date.parse(x.start) > Date.now(); }) : false, ml: T ? T.legs.every(L => L.key === 'H' || L.key === 'A') : false };
    Object.assign(g, keep); if (!keep.score) delete g.score; SB.render();
    return out;
  });
  check('a missed pick gets a "Replacement" card of the same kind (3 underdog moneylines)', rep.cards.some(t => /Replacement · Underdog moneylines · 3 legs/.test(t)) && rep.n === 3 && rep.ml, JSON.stringify(rep));
  check('the replacement only uses games still to play', rep.open);
  // swap a leg inside the parlay builder
  await page.locator('[data-addp="mp-dog3"]').click();
  await page.waitForSelector('[data-sub="slip|0"]');
  const before = await page.evaluate(() => __fm2.slip.map(L => L.gid + '|' + L.key));
  await page.locator('[data-sub="slip|0"]').click();
  await page.waitForSelector('[data-subuse]');
  const n = await page.locator('[data-subuse]').count();
  await page.locator('[data-subuse]').first().click();
  await page.waitForSelector('[data-sub="slip|0"]');
  const after = await page.evaluate(() => __fm2.slip.map(L => L.gid + '|' + L.key));
  check('the builder offers 3+ swaps for a leg', n >= 3, String(n));
  check('picking one replaces that leg in the slip and the builder reopens', after.length === before.length && after[0] !== before[0] && after.slice(1).join() === before.slice(1).join(), JSON.stringify({ before: before[0], after: after[0] }));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
