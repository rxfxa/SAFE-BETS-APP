// Swap legs (3+ equal-value substitutes that never clash with the card), the player model that reads the game (blowout
// benching, team scoring), and the 500,000-run game-by-game parlay sim. Run: node tests/subs-sim.test.mjs
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
await page.clock.setFixedTime(new Date('2026-11-22T10:00:00Z'));
await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
await page.route('**/mypicks.json', r => r.fulfill({ status: 404, body: 'nf' }));
// the morning's data files are pinned too (live ones change every day): injuries, player form, last-4 box scores
for (const [f, fx] of [['injuries.json', 'injuries-2026-11-23.json'], ['playerform.json', 'playerform-2026-11-23b.json'], ['nbalast4.json', 'nbalast4-2026-11-23b.json']])
  await page.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(path.join(ROOT, 'tests/fixtures', fx), 'utf8') }));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 60000 });
  await page.evaluate(() => SB.goTab('trending'));
  await page.click('#trSeg [data-v="picks"]');
  await page.waitForSelector('#mpNbaSeg');
  // the player model reads the game
  const pm = await page.evaluate(() => {
    const F = __fm2, M = F.myPicks(), L = M.parlays.find(P => P.id === 'nba15').legs[0], id = L.key.split(':')[1], pl = F.DATA.players.find(p => p.id === id);
    const star = F.DATA.players.find(p => p.stat === 'pts' && p.avg >= 20 && F.teamCtx(F.DATA.games.find(g => g.id === p.gid), p.team));
    const P = F.playerParts(star, Math.round(star.avg)), c = F.teamCtx(F.DATA.games.find(g => g.id === star.gid), star.team);
    return { pn: P.pn, pbw: P.pbw, pb: P.pb, tf: c.tf, name: star.name };
  });
  check('a starter scores less in a simulated blowout (benched late), with a real blowout chance', pm.pbw < pm.pn && pm.pb > 0.03 && pm.pb < 0.7, JSON.stringify(pm));
  check('team scoring from the game total and spread is in the model (within 0.85-1.15)', pm.tf >= .85 && pm.tf <= 1.15, String(pm.tf));
  const notes = await page.$$eval('#main .ctxn', xs => xs.map(x => x.textContent));
  check('player legs say what the model read (blowout risk / team scoring)', notes.length > 0 && notes.some(t => /blowout risk|team expected/.test(t)), notes.slice(0, 3).join(' | '));
  // substitutes for every open leg of every pick card
  const S = await page.evaluate(() => {
    const F = __fm2, M = F.myPicks(), out = {};
    for (const P of M.parlays) {
      const legs = P.legs, info = k => { const id = k.split(':')[1]; return F.DATA.players.find(p => p.id === id); };
      out[P.id] = legs.map((L, i) => {
        const C = F.subCands(legs, i, 'mp-' + P.id), others = legs.filter((_, j) => j !== i);
        const bad = C.filter(x => {
          if (others.some(o => o.gid === x.gid && o.key === x.key)) return true;
          // no player twice - unless the research links his two different stats (a TD and his yards, catches and yards...)
          if (x.key.startsWith('P:')) { const a = info(x.key); return !a || others.some(o => { if (!o.key.startsWith('P:')) return false; const b = info(o.key); if (!b) return false;
            if (b.name === a.name) { const r = F.legRho(F.legMeta(x), F.legMeta(o), x.gid); return b.stat === a.stat || !r || r.r < .15; } return b.gid === a.gid && b.team === a.team && b.stat === a.stat; }); }
          return false;
        });
        return { n: C.length, bad: bad.length, kinds: [...new Set(C.map(x => x.key.startsWith('P:') ? 'P' : /^CS/.test(x.key) ? 'CS' : x.key === 'H' || x.key === 'A' ? 'ML' : 'G'))], oneGame: P.id === 'sgp5' ? C.every(x => x.gid === L.gid) : true,
          newGame: ['exact1', 'exact2', 'exact3', 'dog3', 'dog5', 'mixed10'].includes(P.id) ? C.every(x => x.gid === L.gid || !others.some(o => o.gid === x.gid)) : true };
      });
    }
    return out;
  });
  const all = Object.entries(S).flatMap(([k, v]) => v.map(x => ({ k, ...x })));
  check('every leg of every pick card has 3+ substitutes', all.every(x => x.n >= 3), JSON.stringify(all.filter(x => x.n < 3)));
  check('no substitute clashes: same leg, same player, or two players on one team for the same stat', all.every(x => x.bad === 0), JSON.stringify(all.filter(x => x.bad)));
  check('substitutes keep the card\'s kind (NBA: props only; exact: exact scores; underdogs: moneylines)', S.nba15.every(x => x.kinds.join() === 'P') && S.exact1.every(x => x.kinds.join() === 'CS') && S.dog3.every(x => x.kinds.join() === 'ML'), JSON.stringify({ n: S.nba15[0].kinds, e: S.exact1[0].kinds, d: S.dog3[0].kinds }));
  check('same game parlay substitutes stay in that game; one-per-game cards never reuse a game', all.every(x => x.oneGame && x.newGame));
  // swap a leg in the UI, then undo
  const card = () => page.evaluate(() => { const c = [...document.querySelectorAll('#main .pc')].find(x => /Underdog moneylines · 3 legs/.test(x.textContent)); return { labels: [...c.querySelectorAll('.leg b')].map(b => b.textContent), hit: c.querySelector('.hit').textContent, swapped: c.querySelectorAll('.leg .link').length }; });
  const before = await card();
  await page.locator('[data-sub="mp-dog3|0"]').click();
  await page.waitForSelector('[data-subuse]');
  const uses = await page.locator('[data-subuse]').count();
  check('the swap sheet offers 3+ legs', uses >= 3, String(uses));
  // run the sim first so we can see it re-run after the swap
  await page.keyboard.press('Escape');
  await page.locator('[data-sim5="mp-dog3"]').click();
  await page.waitForFunction(() => __fm2.SIM5['mp-dog3'], null, { timeout: 30000 });
  const sim0 = await page.evaluate(() => __fm2.SIM5['mp-dog3']);
  await page.locator('[data-sub="mp-dog3|0"]').click();
  await page.locator('[data-subuse]').first().click();
  await page.waitForTimeout(300);
  const after = await card();
  check('choosing a substitute replaces the leg, marks it SWAPPED and re-prices the card', after.labels[0] !== before.labels[0] && /SWAPPED/.test(after.labels[0]) && after.hit !== before.hit, JSON.stringify({ before: before.labels[0], after: after.labels[0], b: before.hit, a: after.hit }));
  const sim1 = await page.evaluate(() => ({ S: __fm2.SIM5['mp-dog3'], legs: [...document.querySelectorAll('#main .pc')].find(x => /Underdog moneylines · 3 legs/.test(x.textContent)).textContent }));
  check('the 500,000-run result re-ran on its own for the new legs', sim1.S.sig !== sim0.sig && /500,000 runs/.test(sim1.legs), sim1.S.sig);
  await page.reload();
  await page.waitForFunction(() => window.SB && SB.firstRender && document.getElementById('mpNbaSeg'), null, { timeout: 60000 });
  const kept = await card();
  check('the swap is kept after a reload', kept.labels[0] === after.labels[0], kept.labels[0]);
  await page.locator('[data-unsub="mp-dog3|0"]').click();
  await page.waitForTimeout(200);
  check('undo puts the original leg back', (await card()).labels[0] === before.labels[0]);
  // 500,000 runs: independent games match the model; a same-game parlay is simulated game by game
  const R = await page.evaluate(() => {
    const F = __fm2, M = F.myPicks(), dog = M.parlays.find(P => P.id === 'dog3').legs, sg = M.parlays.find(P => P.id === 'sgp5').legs;
    const a = F.simJoint(dog), b = F.simJoint(sg), pd = SB.parlayProb(dog).p, ps = SB.parlayProb(sg).p;
    return { a: { N: a.N, hits: a.hits, rate: a.rate, model: pd }, b: { rate: b.rate, model: ps, legs: b.legs, lp: sg.map(L => SB.p1(F.DATA.games.find(g => g.id === L.gid), L.key)) } };
  });
  const se = Math.sqrt(R.a.model * (1 - R.a.model) / R.a.N);
  check('500,000 runs on separate games land on the model chance (within 4 standard errors)', R.a.N === 500000 && Math.abs(R.a.rate - R.a.model) <= 4 * se, JSON.stringify(R.a));
  check('same game parlay: each leg lands near its own chance in the runs', R.b.legs.every((x, i) => Math.abs(x - R.b.lp[i]) < .03), JSON.stringify({ sim: R.b.legs.map(x => +x.toFixed(3)), model: R.b.lp.map(x => +x.toFixed(3)) }));
  check('same game parlay: the runs play the game (blowouts move legs together), so they may differ from the plain product but stay sane', R.b.rate > 0 && Math.abs(R.b.rate - R.b.model) < .15, JSON.stringify(R.b));
  // Fantasy cards get the same tools
  await page.evaluate(() => SB.goTab('fantasy'));
  await page.waitForSelector('[data-sim5="fantasy"]');
  check('Fantasy cards have swap buttons and the 500,000-run button', (await page.locator('[data-sub^="fantasy|"]').count()) > 0 && (await page.locator('[data-sim5="fantasy"]').count()) === 1);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll with the swap buttons', over <= 0, `${over}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
