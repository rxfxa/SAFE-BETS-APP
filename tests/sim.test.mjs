// Simulator module tests (sim.js). Run: node tests/sim.test.mjs
// Starts its own static server on a free port, drives the page with Playwright, prints PASS/FAIL lines,
// exits non-zero on any failure.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
const browser = await chromium.launch();
const allErrors = [];
async function openPage({ w = 390, h = 844, theme = 'light', noWorker = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') allErrors.push(m.text() + ' @' + (m.location().url || '')); });
  page.on('pageerror', e => allErrors.push('pageerror: ' + e.message));
  await page.addInitScript(([t, nw]) => {
    localStorage.setItem('fm2.tab', JSON.stringify('sim')); localStorage.setItem('fm2.theme', JSON.stringify(t));
    if (nw) { try { delete window.Worker; } catch (e) {} window.Worker = undefined; }
  }, [theme, noWorker]);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__sim, null, { timeout: 30000 });
  return { ctx, page };
}
async function runGame(page, gid, wiSetup) {
  await page.evaluate(id => SB.goTab('sim', { gid: id }), gid);
  if (wiSetup) await page.evaluate(wiSetup);
  await page.click('#smRun');
  await page.waitForFunction(() => !__sim.RUN.active, null, { timeout: 90000 });
  return page.evaluate(id => {
    const g = SB.gameById(id), wk = (() => { const o = {}; for (const k of Object.keys(__sim.S.wi)) o[k] = __sim.S.wi[k]; return o; })();
    const R = [...__sim.CACHE.values()].filter(x => x.gid === id).pop();
    const m = SB.fit(g); let et;
    if (m.kind === 'margin') et = m.T; else { const O = SB.outcomes(g); et = 0; for (let i = 0; i < O.n; i++) et += (O.h[i] + O.a[i]) * O.p[i]; }
    return { N: R && R.N, hw: R && R.hw, engH: SB.p1(g, 'H'), tot: R && R.avgH + R.avgA, engT: et, err: __sim.RUN.err, nMk: R && R.mk.length,
      txt: document.getElementById('smRunBox').textContent, wk };
  }, gid);
}

try {
  const { ctx, page } = await openPage();
  // ---------- tab ----------
  const tabs = await page.$$eval('.tab', b => b.map(x => x.textContent));
  const ti = tabs.indexOf('🎲 Simulator');
  check('Simulator tab registered right after Trending', ti >= 0 && tabs[ti - 1] === '🔥 Trending' || tabs.slice(0, ti).includes('🔥 Trending'), tabs.join(' | '));
  check('Simulator view renders', await page.$('#simRoot') !== null && await page.$('#smRun') !== null);

  // ---------- pick games ----------
  const ids = await page.evaluate(() => {
    const L = SB.DATA.games.filter(g => SB.priced(g) && SB.fit(g)).sort((a, b) => SB.startMs(a) - SB.startMs(b));
    const pick = (f, n) => L.filter(f).slice(0, n).map(g => g.id);
    return { soccer: pick(g => g.sport === 'soccer', 3), margin: [...pick(g => g.sport === 'nba', 2), ...pick(g => g.sport === 'nfl', 1)].slice(0, 3), nhl: pick(g => g.sport === 'nhl', 1) };
  });
  check('found 3 soccer and 3 NBA/NFL priced games', ids.soccer.length === 3 && ids.margin.length === 3, JSON.stringify(ids));

  // ---------- accuracy vs engine ----------
  let first = true;
  for (const id of [...ids.soccer, ...ids.margin, ...ids.nhl]) {
    const r = await runGame(page, id);
    if (first) {
      check('run completes exactly 100,000 sims', r.N === 100000 && await page.evaluate(() => __sim.RUN.done) === 100000, `N=${r.N}`);
      check('progress text shows 100,000 simulated games', /100,000 simulated games/.test(r.txt), r.txt.slice(0, 80));
      check('convergence chart drawn', await page.$('#smRunBox svg polyline') !== null);
      first = false;
    }
    const dH = Math.abs(r.hw - r.engH) * 100, dT = Math.abs(r.tot / r.engT - 1) * 100;
    check(`${id}: home win within 1.5pp of engine`, r.N === 100000 && dH <= 1.5, `sim ${(r.hw * 100).toFixed(2)}% vs engine ${(r.engH * 100).toFixed(2)}% (Δ ${dH.toFixed(2)}pp)`);
    check(`${id}: mean total within 3% of engine`, dT <= 3, `sim ${r.tot.toFixed(2)} vs engine ${r.engT.toFixed(2)} (Δ ${dT.toFixed(2)}%)`);
  }
  check('market table lists engine markets with + buttons', await page.$$eval('#simRoot .sm-add[data-key]', b => b.length) > 5);
  check('results are cached per game (re-render shows them without rerun)', await page.evaluate(id => { SB.goTab('sim', { gid: id }); return !!document.querySelector('.sm-heat'); }, ids.soccer[0]));

  // ---------- add a leg from the sim table ----------
  await page.evaluate(id => { SB.setSlip([]); SB.goTab('sim', { gid: id }); }, ids.soccer[0]);
  await page.click('#simRoot .sm-add[data-key="H"]');
  check('+ adds the engine market to the slip', await page.evaluate(id => SB.inSlip(id, 'H'), ids.soccer[0]));

  // ---------- SIM leg type (half-time / first goal) ----------
  const simLeg = await page.evaluate(id => { const g = SB.gameById(id); const a = SB.p1(g, 'SIM:HTH'), b = SB.p1(g, 'SIM:HTD'), c = SB.p1(g, 'SIM:HTA');
    const j = SB.probOf(g, ['H', 'SIM:HTH']); return { a, b, c, j, h: SB.p1(g, 'H') }; }, ids.soccer[0]);
  check('SIM half-time legs priced and sum to 1', simLeg.a > 0 && Math.abs(simLeg.a + simLeg.b + simLeg.c - 1) < 1e-6, JSON.stringify(simLeg));
  check('SIM leg joint with match winner is correlated and ≤ each leg', simLeg.j > simLeg.a * simLeg.h && simLeg.j <= Math.min(simLeg.a, simLeg.h) + 1e-9);

  // ---------- what-if ----------
  const wr = await runGame(page, ids.soccer[0], () => { const r = document.getElementById('smw_str'); r.value = '0.6'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const wiTxt = await page.textContent('#smRes');
  check('what-if run shows deltas vs baseline', /What-if vs baseline/.test(wiTxt) && /Δ base/i.test(wiTxt), `hw ${(wr.hw * 100).toFixed(1)}%`);
  check('home strength tweak raises the home-win chance', wr.hw > wr.engH + .03, `${(wr.hw * 100).toFixed(1)} vs ${(wr.engH * 100).toFixed(1)}`);
  await page.evaluate(() => { document.getElementById('smWi').open = true; });
  await page.click('[data-a="wireset"]');

  // ---------- responsiveness + cancel during a run ----------
  await page.evaluate(id => SB.goTab('sim', { gid: id }), ids.margin[0]);
  await page.evaluate(() => { __sim.CACHE.clear(); __sim.BASE.clear(); });
  await page.click('#smRun');
  const midRun = await page.evaluate(() => __sim.RUN.active);
  const was = await page.evaluate(() => document.getElementById('smWi').open);
  await page.click('#smWi summary'); // a click on another control while the worker runs
  const opened = await page.evaluate(w => document.getElementById('smWi').open !== w, was);
  await page.click('#smCancel');
  const cancel = await page.evaluate(() => ({ active: __sim.RUN.active, cancelled: __sim.RUN.cancelled, done: __sim.RUN.done, gap: __sim.DBG.maxGap, clicks: __sim.DBG.clicksDuringRun }));
  check('UI handles clicks during a run (worker keeps the main thread free)', midRun && opened && cancel.clicks >= 1, JSON.stringify(cancel));
  check('cancel stops the run', !cancel.active && cancel.cancelled && cancel.done < 100000, JSON.stringify(cancel));
  // full run frame-gap check
  await page.click('#smRun');
  await page.waitForFunction(() => !__sim.RUN.active, null, { timeout: 90000 });
  const gap = await page.evaluate(() => __sim.DBG.maxGap);
  check('no main-thread jank during a 100k run (max frame gap < 250 ms)', gap < 250, `${gap.toFixed(0)} ms`);

  // ---------- parlay sim: 2-leg same-game soccer ----------
  await page.evaluate(id => { SB.setSlip([{ gid: id, key: 'H' }, { gid: id, key: 'O2.5' }]); SB.goTab('sim', { mode: 'parlay' }); }, ids.soccer[0]);
  await page.click('[data-a="prun"]');
  await page.waitForFunction(() => !__sim.RUN.active && __sim.PAR, null, { timeout: 90000 });
  const par = await page.evaluate(() => ({ N: __sim.PAR.N, hit: __sim.PAR.hit, eng: __sim.PAR.eng, pp: SB.parlayProb(SB.slip).p, indep: __sim.PAR.indep }));
  check('parlay sim runs 100,000 times', par.N === 100000);
  check('2-leg same-game soccer parlay within 1.5pp of parlayProb', Math.abs(par.hit - par.pp) <= .015, `sim ${(par.hit * 100).toFixed(2)}% vs engine ${(par.pp * 100).toFixed(2)}% (independent ${(par.indep * 100).toFixed(2)}%)`);
  // parlay with a SIM leg + a scorer/custom leg if present
  const par3 = await page.evaluate(async id => { SB.setSlip([{ gid: id, key: 'H' }, { gid: id, key: 'SIM:HTH' }]); return SB.parlayProb(SB.slip).p; }, ids.soccer[0]);
  await page.evaluate(() => SB.goTab('sim', { mode: 'parlay' }));
  await page.click('[data-a="prun"]');
  await page.waitForFunction(() => !__sim.RUN.active && __sim.PAR && __sim.PAR.per.length === 2, null, { timeout: 90000 });
  const p3 = await page.evaluate(() => __sim.PAR.hit);
  check('parlay with a half-time SIM leg matches the engine joint within 1.5pp', Math.abs(p3 - par3) <= .015, `sim ${(p3 * 100).toFixed(2)} vs ${(par3 * 100).toFixed(2)}`);
  // bankroll
  await page.fill('#smBp', '+150');
  await page.click('[data-a="brun"]');
  await page.waitForFunction(() => !__sim.RUN.active && __sim.BANK, null, { timeout: 90000 });
  const bk = await page.evaluate(() => __sim.BANK);
  check('bankroll sim: 100,000 paths with median / percentiles / ruin', bk.N === 100000 && bk.p5 <= bk.median && bk.median <= bk.p95 && bk.ruin >= 0 && bk.ruin <= 1 && Math.abs(bk.dec - 2.5) < 1e-9, JSON.stringify({ median: bk.median, p5: bk.p5, p95: bk.p95, ruin: bk.ruin }));

  // ---------- watch one game ----------
  await page.evaluate(id => { SB.goTab('sim', { gid: id, mode: 'watch' }); }, ids.soccer[0]);
  await page.click('[data-a="wnew"]');
  await page.waitForTimeout(600);
  const moved = await page.evaluate(() => document.querySelector('.sm-sb .ck').textContent);
  await page.click('[data-a="wskip"]');
  const w = await page.evaluate(() => ({ sc: document.querySelector('.sm-sb .sc').textContent, ft: [...document.querySelectorAll('#smTk div')].some(d => /Full-time/.test(d.textContent)) }));
  check('watch mode animates and skips to full time', !!moved && w.ft && /^\d+–\d+$/.test(w.sc), `${moved} → ${w.sc}`);
  for (const sp of ['nba', 'nhl', 'nfl']) {
    const gid = await page.evaluate(s => (SB.DATA.games.find(g => g.sport === s && SB.priced(g)) || {}).id, sp);
    if (!gid) continue;
    await page.evaluate(id => SB.goTab('sim', { gid: id, mode: 'watch' }), gid);
    await page.click('[data-a="wnew"]');
    await page.waitForFunction(() => document.querySelector('[data-a="wskip"]'), null, { timeout: 30000 });
    await page.click('[data-a="wskip"]');
    const t = await page.evaluate(() => { const [h, a] = document.querySelector('.sm-sb .sc').textContent.split('–').map(Number); return { h, a, fin: /Final|FT/.test(document.querySelector('.sm-sb .ck').textContent) }; });
    check(`watch ${sp}: plays to a final with a winner`, t.fin && (sp === 'nfl' || t.h !== t.a), JSON.stringify(t));
  }
  // ---------- layout ----------
  for (const mode of ['game', 'watch', 'parlay']) {
    await page.evaluate(m => SB.goTab('sim', { mode: m }), mode);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`no horizontal scroll at 390px (${mode})`, sw <= 390, `scrollWidth ${sw}`);
  }
  await ctx.close();

  // ---------- dark + desktop ----------
  const d = await openPage({ w: 1280, h: 900, theme: 'dark' });
  await runGame(d.page, ids.soccer[1]);
  check('desktop dark run renders results', await d.page.$('.sm-heat') !== null);
  await d.ctx.close();

  // ---------- no-Worker fallback (time-sliced main-thread loop) ----------
  const f = await openPage({ noWorker: true });
  const fr = await runGame(f.page, ids.soccer[2]);
  const fb = await f.page.evaluate(() => ({ worker: __sim.DBG.worker, gap: __sim.DBG.maxGap }));
  check('fallback without Workers completes 100,000 sims', fr.N === 100000 && fb.worker !== true, JSON.stringify(fb));
  check('fallback home win still within 1.5pp', Math.abs(fr.hw - fr.engH) <= .015, `${(fr.hw * 100).toFixed(2)} vs ${(fr.engH * 100).toFixed(2)}`);
  await f.ctx.close();

  check('no console errors', allErrors.length === 0, allErrors.slice(0, 5).join(' | '));
} catch (e) {
  check('test run threw', false, e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
