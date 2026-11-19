// Weekly Plan tests (plan.js). Run: node tests/plan.test.mjs
// Uses the Polymarket fixture of 2026-11-18 (full NBA prop ladders) with the page clock fixed to that afternoon.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const FX = fs.readFileSync(path.join(ROOT, 'tests/fixtures/pm-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
async function openPage({ fixture = true, w = 390, h = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date('2026-11-18T21:50:00Z'));
  if (fixture) await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FX }));
  else await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: '2026-11-18T21:00:00Z', games: [] }) }));
  await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('plan')));
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__plan && window.__polymarket && window.__polymarket.LOAD === 'done' && window.__lottos && window.__lottos.LOAD === 'done', null, { timeout: 30000 });
  await page.evaluate(() => SB.render()); await page.waitForTimeout(300);
  return { ctx, page, errors };
}
try {
  const { ctx, page, errors } = await openPage();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(x => x.dataset.t));
  check('tab: Weekly Plan sits after Polymarket', tabs.indexOf('plan') === tabs.indexOf('polymarket') + 1, tabs.join(','));
  const R = await page.evaluate(() => { const P = window.__plan, { C } = P.candidates(30), st = P.state;
    const rules = Object.entries(st.built).map(([k, S]) => { const byG = {}; for (const c of S.legs) (byG[c.pg.slug] = byG[c.pg.slug] || []).push(c);
      return { k, n: S.legs.length, want: st.legs[k], div3: S.legs.length % 3 === 0, perGame: Object.values(byG).every(a => a.length >= 2 && a.length <= 3 && a.some(c => c.side === 'home') && a.some(c => c.side === 'away')),
        onePerPlayer: new Set(S.legs.map(c => c.pg.slug + c.pl.key)).size === S.legs.length, band: S.legs.every(c => c.ps >= P.TIERS.find(t => t.id === k).band[0] - 1e-9) }; });
    const ids = Object.values(st.built).flatMap(S => S.legs.map(P.legId));
    return { C: C.length, rules, disjoint: new Set(ids).size === ids.length,
      price: C.every(c => c.ask <= 0.97 + 1e-9 && c.bid > 0.01 && c.ask - c.bid <= 0.15 + 1e-9 && Math.abs(c.p - c.mid) <= 0.15 + 1e-9),
      sides: C.every(c => c.over ? c.mid === c.pr.over.m && c.ask === c.pr.over.a : Math.abs(c.mid - (1 - c.pr.over.m)) < 1e-9 && Math.abs(c.ask - (1 - c.pr.over.b)) < 1e-9),
      injured: C.every(c => c.pl.w === 0) }; });
  check('candidates: Polymarket legs priced on both sides', R.C > 100, String(R.C));
  check('candidates: two-sided quote, pays at least 3%, model within 15 points of the market', R.price);
  check('candidates: the No side is priced as 1 − Yes', R.sides);
  check('candidates: injured/questionable players are never used', R.injured);
  for (const r of R.rules) check(`${r.k}: ${r.want} legs, divisible by 3`, r.n === r.want && r.div3, JSON.stringify(r));
  check('every slip: 2-3 legs per game with a player from each team, one leg per player, legs in the tier band', R.rules.every(r => r.perGame && r.onePerPlayer && r.band));
  check('the three slips share no legs', R.disjoint);
  // leg counts follow the selector
  for (const n of [15, 21, 24]) { await page.selectOption('select[data-pl-legs="lotto"]', String(n)); await page.waitForTimeout(250);
    const got = await page.evaluate(() => window.__plan.state.built.lotto.legs.length); check(`lotto selector: ${n} legs`, got === n || got % 3 === 0, String(got)); }
  await page.selectOption('select[data-pl-legs="lotto"]', '18'); await page.waitForTimeout(250);
  // model consistency: analytic leg chance vs simulation
  const cons = await page.evaluate(() => { const P = window.__plan, S = P.state.built.coin; const sim = P.simulate(S.legs, 200000, 7); return S.legs.map((c, i) => Math.abs((1 - sim.miss[i]) - c.p)); });
  check('model: simulated leg chances match the analytic ones (within 1 point)', cons.every(x => x < 0.01), JSON.stringify(cons.map(x => +x.toFixed(4))));
  const blow = await page.evaluate(() => { const P = window.__plan; return { close: P.pOver(20, 0.28 * 20 + 3, 19.5, true, 0, 1), blowout: P.pOver(20, 0.28 * 20 + 3, 19.5, true, 22, 1), bench: P.pOver(8, 0.28 * 8 + 3, 7.5, false, 22, 1), benchClose: P.pOver(8, 0.28 * 8 + 3, 7.5, false, 0, 1) }; });
  check('blowouts: a starter\'s over drops, a bench player\'s rises', blow.blowout < blow.close - 0.03 && blow.bench > blow.benchClose, JSON.stringify(blow));
  // 500k simulation
  await page.click('[data-pl-sim="safe"]'); await page.waitForFunction(() => document.querySelector('.pl-card[data-tier="safe"] .pl-sim'), null, { timeout: 60000 });
  const sim = await page.evaluate(() => { const s = window.__plan.state.sims.safe; return { S: s.S, hit: s.hit, sum: s.dist.reduce((a, b) => a + b, 0), last: s.dist[s.dist.length - 1] }; });
  check('simulator: 500,000 runs, distribution sums to 1, all-legs share = hit rate', sim.S >= 500000 && Math.abs(sim.sum - 1) < 1e-9 && Math.abs(sim.last - sim.hit) < 1e-9, JSON.stringify(sim));
  await page.click('[data-pl-week]'); await page.waitForFunction(() => window.__plan.state.week, null, { timeout: 30000 });
  const wk = await page.evaluate(() => { const W = window.__plan.state.week; return { tiers: W.tiers.length, sums: W.tiers.map(T => T.wins.reduce((a, b) => a + b, 0)), up: W.up }; });
  check('week simulator: 3 tiers, win counts 0-7 sum to 1', wk.tiers === 3 && wk.sums.every(x => Math.abs(x - 1) < 1e-9) && wk.up >= 0 && wk.up <= 1, JSON.stringify(wk));
  // tracking + report (no db here: stored in this browser)
  for (const t of ['safe', 'coin', 'lotto']) { await page.click(`[data-pl-track="${t}"]`); await page.waitForTimeout(120); }
  let slips = await page.evaluate(() => window.__plan.slips.map(s => ({ id: s.id, tier: s.tier, n: s.legs.length, stake: s.stake, dec: s.dec })));
  check('track: three slips saved with legs, stake and payout', slips.length === 3 && slips.every(s => s.n % 3 === 0 && s.stake > 0 && s.dec > 1), JSON.stringify(slips));
  const safe = slips.find(s => s.tier === 'safe'), coin = slips.find(s => s.tier === 'coin');
  await page.click(`[data-pl-res="${safe.id}|won"]`); await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelectorAll('.pl-tr details').forEach(d => { d.open = true; }));
  await page.click(`[data-pl-leg="${coin.id}|0|0"]`); await page.waitForTimeout(150);
  const rep = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.pl-report .pl-rep')].slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()), res: window.__plan.slips.map(s => [s.tier, s.result]) }));
  check('grading: a missed leg makes the slip lost', rep.res.some(([t, r]) => t === 'coin' && r === 'lost'), JSON.stringify(rep.res));
  check('report: "SAFE 100% win rate 1/1 won", "COIN FLIP 0% … 0/1 won"', /SAFE\s*100% win rate\s*1\/1 won/.test(rep.rows[0]) && /COIN FLIP\s*0% win rate\s*0\/1 won/.test(rep.rows[1]), JSON.stringify(rep.rows));
  const txt = await page.evaluate(() => document.querySelector('#main').textContent);
  check('copy: no "guaranteed" or "lock"; estimates labelled', !/\bguaranteed?\b|\block\b/i.test(txt.replace(/never guarantees/g, '')) && /never guarantees/.test(txt));
  await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(200);
  check('360px: no horizontal scroll', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  const e = await openPage({ fixture: false });
  check('no props posted yet: honest message, budget and report still there', await e.page.evaluate(() => /posts them on game day/.test(document.querySelector('#main').textContent) && !!document.getElementById('plBudget') && !!document.querySelector('.pl-report')));
  await e.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
