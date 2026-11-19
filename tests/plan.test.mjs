// Weekly Plan tests (plan.js). Run: node tests/plan.test.mjs
// Uses the Polymarket fixture of 2026-11-18 (full NBA prop ladders) and the feed of that morning (tests/fixtures/data-2026-11-18.json)
// with the page clock fixed to that afternoon, so the slate is the same on every run.
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
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
async function openPage({ fixture = true, w = 390, h = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date('2026-11-18T21:50:00Z'));
  await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
  await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: fixture ? FX : JSON.stringify({ updated: '2026-11-18T21:00:00Z', games: [] }) }));
  await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('plan')));
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__plan && window.__polymarket && window.__polymarket.LOAD === 'done' && window.__lottos && window.__lottos.LOAD === 'done', null, { timeout: 30000 });
  await page.evaluate(() => SB.render()); await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const rulesOf = () => { const P = window.__plan, st = P.state;
  return Object.entries(st.built).map(([k, S]) => { const byG = {}; for (const c of S.legs) (byG[c.pg.slug] = byG[c.pg.slug] || []).push(c);
    const T = P.TIERS.concat(P.BIG).find(t => t.id === k);
    return { k, n: S.legs.length, want: S.target, div3: S.legs.length % 3 === 0, quick: S.quick, range: T.range,
      perGame: Object.values(byG).every(a => a.length >= 2 && a.length <= 3), bothTeams: Object.values(byG).every(a => { const pr = a.filter(c => c.kind === 'prop'); return !pr.length || (pr.some(c => c.side === 'home') && pr.some(c => c.side === 'away')); }),
      oneMkt: Object.values(byG).every(a => new Set(a.map(P.mktOf)).size === a.length), sports: [...new Set(S.legs.map(c => c.pg.sport))] }; }); };
try {
  const { ctx, page, errors } = await openPage();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(x => x.dataset.t));
  check('tab: Weekly Plan sits after Polymarket', tabs.indexOf('plan') === tabs.indexOf('polymarket') + 1, tabs.join(','));
  const C = await page.evaluate(() => { const { C, games } = window.__plan.candidates({ winH: 30, sport: 'all', type: 'mix', lean: 'both' });
    return { n: C.length, sports: [...new Set(C.map(c => c.pg.sport))], kinds: [...new Set(C.map(c => c.kind))], games: games.length,
      price: C.every(c => c.ask <= 0.97 + 1e-9 && c.bid > 0.01 && c.ask - c.bid <= 0.15 + 1e-9 && (c.mo || Math.abs(c.p - c.mid) <= 0.15 + 1e-9)),
      under: C.filter(c => c.kind === 'prop' && !c.over).every(c => Math.abs(c.mid - (1 - c.pr.over.m)) < 1e-9 && Math.abs(c.ask - (1 - c.pr.over.b)) < 1e-9),
      injured: C.filter(c => c.kind === 'prop').every(c => c.pl.w === 0) }; });
  check('every sport: legs from several sports, props and game lines', C.sports.length >= 4 && C.kinds.length === 2, JSON.stringify({ sports: C.sports, games: C.games, n: C.n }));
  check('legs: two-sided quote, ask ≤ 97¢, model within 15 points of the market', C.price);
  check('props: the No side is priced as 1 − Yes; injured players never used', C.under && C.injured);
  const R = await page.evaluate(rulesOf);
  for (const r of R) check(`${r.k}: ${r.want} legs, divisible by 3, 2-3 per game, a player from each team, one per market`, r.n === r.want && r.div3 && r.perGame && r.bothTeams && r.oneMkt, JSON.stringify(r));
  const hits = Object.fromEntries(R.map(r => [r.k, r.quick]));
  check('SAFE lands in 60-89%', hits.safe >= 0.6 && hits.safe <= 0.89, String(hits.safe));
  check('LOTTO lands in 1-40%; 21 legs near 20%; 24 legs in 2-5%', hits.lotto >= 0.01 && hits.lotto <= 0.4 && hits.b21 >= 0.15 && hits.b21 <= 0.26 && hits.b24 >= 0.015 && hits.b24 <= 0.06, JSON.stringify(hits));
  check('tiers rise in risk: SAFE > COIN FLIP > LOTTO', hits.safe > hits.coin && hits.coin > hits.lotto, JSON.stringify(hits));
  const off = await page.evaluate(() => [...document.querySelectorAll('.pl-card')].filter(c => /closest we can get/.test(c.textContent)).map(c => /legs would need about \d+%/.test(c.textContent)));
  check('off-target slips explain why (legs needed vs legs available)', off.every(Boolean), JSON.stringify(off));
  const dis = await page.evaluate(() => { const st = window.__plan.state, ids = ['safe', 'coin', 'lotto'].flatMap(k => st.built[k].legs.map(window.__plan.legId)); return new Set(ids).size === ids.length; });
  check('SAFE, COIN FLIP and LOTTO share no legs', dis);
  // decision buttons
  await page.click('[data-pl-sport="nhl"]'); await page.waitForTimeout(300);
  const nhl = await page.evaluate(() => Object.values(window.__plan.state.built).flatMap(S => S.legs).every(c => c.pg.sport === 'nhl'));
  check('sport button: NHL only', nhl);
  await page.click('[data-pl-sport="all"]'); await page.click('[data-pl-lean="under"]'); await page.waitForTimeout(300);
  const und = await page.evaluate(() => Object.values(window.__plan.state.built).flatMap(S => S.legs).every(c => (c.kind === 'prop' ? !c.over : !/^Over /.test(c.label))));
  check('lean button: unders only', und);
  await page.click('[data-pl-lean="both"]'); await page.click('[data-pl-type="props"]'); await page.waitForTimeout(300);
  check('legs-from button: player props only', await page.evaluate(() => Object.values(window.__plan.state.built).flatMap(S => S.legs).every(c => c.kind === 'prop')));
  await page.click('[data-pl-type="mix"]'); await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__plan.state.built.safe.legs.map(window.__plan.legId));
  await page.click('.pl-card[data-tier="safe"] .pl-x'); await page.waitForTimeout(300);
  const afterDrop = await page.evaluate(() => window.__plan.state.built.safe.legs.map(window.__plan.legId));
  check('✖ drops that leg and the slip still has its legs', !afterDrop.includes(before[0]) && afterDrop.length === before.length, `${before.length} → ${afterDrop.length}`);
  await page.click('[data-pl-act="reroll|safe"]'); await page.waitForTimeout(300);
  const afterRe = await page.evaluate(() => window.__plan.state.built.safe.legs.map(window.__plan.legId));
  check('🔁 New mix builds a different slip', afterRe.filter(x => afterDrop.includes(x)).length === 0 || afterRe.length < afterDrop.length, `${afterRe.length} legs`);
  await page.click('[data-pl-act="reset|safe"]'); await page.waitForTimeout(300);
  check('↺ Start over brings back the first slip', JSON.stringify(await page.evaluate(() => window.__plan.state.built.safe.legs.map(window.__plan.legId))) === JSON.stringify(before));
  // model consistency + blowouts
  const cons = await page.evaluate(() => { const P = window.__plan, S = P.state.built.coin; const sim = P.simulate(S.legs, 200000, 7); return S.legs.map((c, i) => Math.abs((1 - sim.miss[i]) - c.p)); });
  check('simulated leg chances match the leg prices (within 1.5 points)', cons.every(x => x < 0.015), JSON.stringify(cons.map(x => +x.toFixed(4))));
  const blow = await page.evaluate(() => { const P = window.__plan; return { close: P.pOver(20, 8.6, 19.5, true, 0, 1), blowout: P.pOver(20, 8.6, 19.5, true, 22, 1), bench: P.pOver(8, 5.24, 7.5, false, 22, 1), benchClose: P.pOver(8, 5.24, 7.5, false, 0, 1) }; });
  check('blowouts: a starter\'s over drops, a bench player\'s rises', blow.blowout < blow.close - 0.03 && blow.bench > blow.benchClose, JSON.stringify(blow));
  // 500k + week
  await page.click('[data-pl-sim="b21"]'); await page.waitForFunction(() => document.querySelector('.pl-card[data-tier="b21"] .pl-sim'), null, { timeout: 60000 });
  const sim = await page.evaluate(() => { const s = window.__plan.state.sims.b21; return { S: s.S, hit: s.hit, sum: s.dist.reduce((a, b) => a + b, 0), last: s.dist[s.dist.length - 1] }; });
  check('simulator: 500,000 runs, distribution sums to 1, all-legs share = hit rate', sim.S >= 500000 && Math.abs(sim.sum - 1) < 1e-9 && Math.abs(sim.last - sim.hit) < 1e-9, JSON.stringify(sim));
  await page.click('[data-pl-week]'); await page.waitForFunction(() => window.__plan.state.week, null, { timeout: 30000 });
  check('week simulator: 3 tiers, win counts sum to 1', await page.evaluate(() => { const W = window.__plan.state.week; return W.tiers.length === 3 && W.tiers.every(T => Math.abs(T.wins.reduce((a, b) => a + b, 0) - 1) < 1e-9); }));
  // tracking + report
  for (const t of ['safe', 'coin', 'b15']) { await page.click(`[data-pl-track="${t}"]`); await page.waitForTimeout(120); }
  const slips = await page.evaluate(() => window.__plan.slips.map(s => ({ id: s.id, tier: s.tier, n: s.legs.length, stake: s.stake, dec: s.dec, lab: s.legs.every(l => l.label) })));
  check('track: slips saved with labelled legs, stake and payout', slips.length === 3 && slips.every(s => s.n % 3 === 0 && s.stake > 0 && s.dec > 1 && s.lab), JSON.stringify(slips));
  const safe = slips.find(s => s.tier === 'safe'), coin = slips.find(s => s.tier === 'coin');
  await page.click(`[data-pl-res="${safe.id}|won"]`); await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelectorAll('.pl-tr details').forEach(d => { d.open = true; }));
  await page.click(`[data-pl-leg="${coin.id}|0|0"]`); await page.waitForTimeout(150);
  const rep = await page.evaluate(() => [...document.querySelectorAll('.pl-report .pl-rep')].slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  check('report: "SAFE 100% win rate 1/1 won", "COIN FLIP 0% win rate 0/1 won"', /SAFE\s*100% win rate\s*1\/1 won/.test(rep[0]) && /COIN FLIP\s*0% win rate\s*0\/1 won/.test(rep[1]), JSON.stringify(rep));
  // Polymarket connection
  await page.fill('#plPmAddr', 'not-an-address'); await page.click('[data-pl-pmsave]'); await page.waitForTimeout(150);
  check('connect: rejects something that isn\'t a wallet address', !(await page.evaluate(() => localStorage.getItem('fm2.plan.pmAddr'))));
  await page.fill('#plPmAddr', '0x983eedfbd75803602e4a6e6ea9aab6dc6b9c6748'); await page.click('[data-pl-pmsave]'); await page.waitForTimeout(200);
  check('connect: saves a valid wallet address and says what happens next', /0x983e…6748/.test(await page.evaluate(() => document.querySelector('.pl-pm').textContent)));
  const txt = await page.evaluate(() => document.querySelector('#main').textContent);
  check('copy: no "guaranteed" or "lock"; estimates labelled', !/\bguaranteed?\b|\block\b/i.test(txt.replace(/never guarantees/g, '')) && /never guarantees/.test(txt));
  await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(200);
  check('360px: no horizontal scroll', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  const e = await openPage({ fixture: false });
  check('no Polymarket legs: honest message; budget, report and Polymarket card still there', await e.page.evaluate(() => /No Polymarket legs/.test(document.querySelector('#main').textContent) && !!document.getElementById('plBudget') && !!document.querySelector('.pl-report') && !!document.querySelector('.pl-pm')));
  await e.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
