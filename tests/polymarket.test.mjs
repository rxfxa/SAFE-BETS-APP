// Polymarket tab tests (polymarket.js + polymarket.json). Run: node tests/polymarket.test.mjs
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
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const PMJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'polymarket.json'), 'utf8'));
const okQ = q => q && ['b', 'a', 'm'].every(k => q[k] == null || (q[k] >= 0 && q[k] <= 1));
check('polymarket.json: games with home/away and valid prices', PMJ.games.length > 0 && PMJ.games.every(g => g.home && g.away && g.start && g.ml && okQ(g.ml.home) && okQ(g.ml.away) && g.spreads.every(s => okQ(s.home) && okQ(s.away)) && g.totals.every(t => okQ(t.over) && okQ(t.under))), `${PMJ.games.length} games`);

const browser = await chromium.launch();
async function openPage({ w = 390, h = 844, block = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  if (block) await page.route('**/polymarket.json', r => r.fulfill({ status: 404, body: 'gone' }));
  await page.addInitScript(() => { localStorage.setItem('fm2.tab', JSON.stringify('polymarket')); localStorage.setItem('fm2.pm.win', JSON.stringify('8d')); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__polymarket && window.__polymarket.LOAD === 'done', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
try {
  const { ctx, page, errors } = await openPage();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(x => x.dataset.t));
  check('tab: Polymarket sits after Point Lottos', tabs.indexOf('polymarket') === tabs.indexOf('lottos') + 1, tabs.join(','));
  const r = await page.evaluate(() => { const P = window.__polymarket, G = P.games('all', '8d'), rows = G.flatMap(P.rowsFor);
    const matched = G.filter(g => P.matchOf(g)), V = rows.filter(P.isValue);
    const mlGap = matched.map(pg => { const m = P.matchOf(pg); const R = P.rowsFor(pg).filter(x => x.type === 'Moneyline' && x.p != null && x.q.m != null); return R.map(x => Math.abs(x.p - x.q.m)); }).flat();
    return { games: G.length, matched: matched.length, priced: rows.filter(x => x.p != null).length, value: V.length,
      vOk: V.every(x => x.key && x.ev >= P.MIN_EV && x.ev <= 0.3 + 1e-9 && Math.abs(x.p - x.q.m) <= 0.08 + 1e-9 && x.q.a >= .15 && x.q.a <= .85 && Math.abs(x.ev - (x.p / x.q.a - 1)) < 1e-9),
      mlGap: mlGap.length ? mlGap.reduce((s, x) => s + x, 0) / mlGap.length : null,
      noTot: rows.filter(x => x.type === 'Total' && x.p != null).every(x => { const F = SB.fit(x.g); return !(F.kind === 'margin' && F.genTotal); }) }; });
  check('matching: Polymarket games paired with feed games', r.matched > 0 && r.priced > 0, JSON.stringify(r));
  check('matching: model and market agree on winners on average (within 8 points)', r.mlGap != null && r.mlGap < 0.08, String(r.mlGap));
  check('value picks follow the rules (EV 4-30%, within 8 points of the mid, 15-85¢)', r.vOk);
  check('totals: no model where the feed has no game total', r.noTot);
  const ui = await page.evaluate(() => ({ h2: [...document.querySelectorAll('#main h2')].map(h => h.textContent), games: document.querySelectorAll('#main .pm-game').length, cards: document.querySelectorAll('#main .pm-card').length, text: document.querySelector('#main').textContent }));
  check('tab renders value list, parlays, simulator and games', ['Best value', 'Polymarket parlays', 'Slate simulator', 'Games'].every(t => ui.h2.some(h => h.startsWith(t))) && ui.games > 0, `${ui.games} games, ${ui.cards} parlays`);
  check('copy: snapshot time, fees and legality noted; no "guaranteed"', /Snapshot from Polymarket/.test(ui.text) && /fees/.test(ui.text) && /legal where you live/.test(ui.text) && !/\bguaranteed\b|\block\b/i.test(ui.text));
  // parlays: market chance = product of mids, model chance = product of model legs (different games)
  const par = await page.evaluate(() => [...document.querySelectorAll('#main [data-pm-build]')].map(b => b.dataset.pmBuild));
  if (par.length) {
    await page.click(`#main [data-pm-build="${par[0]}"]`); await page.waitForTimeout(250);
    const sl = await page.evaluate(() => SB.slip.map(l => ({ k: l.key, p: SB.p1(SB.gameById(l.gid), l.key), gid: l.gid })));
    check('parlay: opens in the builder with priced legs from different games', sl.length >= 2 && sl.every(x => x.p > 0) && new Set(sl.map(x => x.gid)).size === sl.length, JSON.stringify(sl.map(x => x.k)));
    await page.keyboard.press('Escape'); await page.evaluate(() => SB.setSlip([]));
  }
  // value row tap adds to slip
  const vr = await page.$('#main .pm-row[data-pm-leg]');
  if (vr) { await vr.click(); await page.waitForTimeout(150); check('value list: tapping a pick adds it to the slip', (await page.evaluate(() => SB.slip.length)) === 1); await page.evaluate(() => SB.setSlip([])); }
  // simulator: mean matches the expected value of the picks
  if (await page.$('[data-pm-run]')) {
    await page.click('[data-pm-run]'); await page.waitForFunction(() => document.querySelector('#main .pm-hist'), null, { timeout: 20000 });
    const sim = await page.evaluate(() => { const P = window.__polymarket, rows = P.games(SB.store.get('pm.sp', 'all'), SB.store.get('pm.win', '8d')).flatMap(P.rowsFor);
      const picks = P.pickByGame(rows, 8, P.isValue, (a, b) => b.ev - a.ev), s = P.simulate(picks, 10), ev = picks.reduce((t, r) => t + 10 * (r.p / r.q.a - 1), 0), sd = Math.sqrt(picks.reduce((t, r) => t + 100 * r.p * (1 - r.p) / (r.q.a * r.q.a), 0));
      return { n: picks.length, mean: s.model.mean, ev, se: sd / Math.sqrt(100000), games: new Set(picks.map(r => r.g.id)).size }; });
    check('simulator: one pick per game; 100,000-night average matches the picks\' EV', sim.n === sim.games && Math.abs(sim.mean - sim.ev) < 5 * sim.se + 1e-6, JSON.stringify(sim));
  }
  await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(200);
  check('360px: no horizontal scroll', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  const m = await openPage({ block: true });
  check('missing polymarket.json: honest message, no page errors', /did not load/.test(await m.page.evaluate(() => document.querySelector('#main').textContent)) && !m.errors.some(e => e.startsWith('pageerror')));
  await m.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
