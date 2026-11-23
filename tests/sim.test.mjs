// Simulator module tests (sim.js). Run: node tests/sim.test.mjs
// Starts its own static server on a free port, drives the page with Playwright, prints PASS/FAIL lines,
// exits non-zero on any failure. Runs on a saved slate (tests/fixtures/data-2026-11-18.json) and the scorer / roster files of the
// same days, with the clock fixed that evening, so there are always soccer, NBA, NFL, NHL and college games to simulate.
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
  let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // /csp/... serves the same files with a CSP that blocks Web Workers (like a locked-down artifact sandbox)
  const csp = u.startsWith('/csp/'); if (csp) u = u.slice(4);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store', ...(csp ? { 'content-security-policy': "worker-src 'none'" } : {}) });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

const FIX = f => fs.readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8');
const NOW = '2026-11-18T21:50:00Z';  // evening of the saved slate: NBA and NHL games tonight, NFL and soccer later in the week
// every live file the simulator reads -> its saved copy (firsttd.js adds ?t=..., so match on the path only)
const FEEDS = { 'data.json': FIX('data-2026-11-18.json'), 'scorers.json': FIX('scorers-2026-11-18.json'), 'props.json': FIX('props-2026-11-18.json'),
  'nbaroles.json': FIX('nbaroles-2026-11-18.json'), 'injuries.json': FIX('injuries-2026-11-18.json'), 'firstbasket.json': FIX('firstbasket-2026-11-18.json'),
  'firsttd.json': FIX('firsttd-2026-11-19.json') };
async function pinFeeds(page) {
  await page.clock.setFixedTime(new Date(NOW));
  for (const [f, body] of Object.entries(FEEDS)) await page.route(new RegExp('/' + f.replace('.', '\\.') + '(\\?|$)'), r => r.fulfill({ status: 200, contentType: 'application/json', body }));
}
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const allErrors = [];
async function openPage({ w = 390, h = 844, theme = 'light', noWorker = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') allErrors.push(m.text() + ' @' + (m.location().url || '')); });
  page.on('pageerror', e => allErrors.push('pageerror: ' + e.message));
  await pinFeeds(page);
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
  await page.waitForSelector('.sm-sb .ck', { timeout: 30000 }); // calibration (if any) now runs in the worker first
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


  // ================= regression checks: review round 1 =================
  {
    const R1 = await openPage({ w: 390, h: 844 });
    const P = R1.page;
    const sg = await P.evaluate(() => {
      const L = SB.DATA.games.filter(g => SB.priced(g) && SB.fit(g)).sort((a, b) => SB.startMs(a) - SB.startMs(b));
      const by = s => L.filter(g => g.sport === s).map(g => g.id);
      return { soc: by('soccer'), nhl: by('nhl'), nba: by('nba'), nfl: by('nfl') };
    });
    // --- soccer run: honest copy, summary above the fold, goal-timing chart not double counted ---
    await P.evaluate(() => window.scrollTo(0, 0));
    await runGame(P, sg.soc[0]);
    await P.waitForTimeout(900); // smooth scroll to the summary
    const s1 = await P.evaluate(() => {
      const txt = document.getElementById('simRoot').textContent;
      const wdl = document.querySelector('#smSum .sm-wdl:last-of-type').getBoundingClientRect();
      const R = [...__sim.CACHE.values()].pop(), gm = R.gm;
      const svg = [...document.querySelectorAll('.sm-svg')].find(x => /by game time/.test(x.getAttribute('aria-label') || ''));
      const hs = [...svg.querySelectorAll('rect')].map(r => +r.getAttribute('height'));
      const lab = [...svg.querySelectorAll('text')].map(t => t.textContent).join(' ');
      let tot = 0, inb = 0; for (let i = 0; i < 40; i++) { tot += gm[i]; if (i % 20 < 18) inb += gm[i]; }
      return { bad: (txt.match(/confirm|check the prices/i) || [null])[0], wdlBottom: wdl.bottom, ih: innerHeight, conv: !!document.querySelector('#smRunBox details.sm-conv svg polyline'),
        ratioSvg: hs[8] / hs[7], ratioGm: (gm[8] + gm[28]) / (gm[7] + gm[27]), nbars: hs.length, lab, tot, inb };
    });
    check('copy: no "confirms / checks the prices" claim', !s1.bad, String(s1.bad));
    check('390px: win/draw/loss summary is on screen after a run (above the slip bar)', s1.wdlBottom < s1.ih - 70, `bottom ${s1.wdlBottom.toFixed(0)} / ${s1.ih}`);
    check('convergence chart kept, folded into "How the runs converged"', s1.conv);
    check('soccer goal-timing chart: 18 bars, 45+/90+ bars not double counted', s1.nbars === 18 && Math.abs(s1.ratioSvg - s1.ratioGm) < .02 && /45\+/.test(s1.lab) && /90\+/.test(s1.lab) && s1.tot === s1.inb, JSON.stringify(s1));
    // a soccer game with goalscorer data (for the SX / first-scorer parlay check below)
    let cx = null;
    for (const id of sg.soc.slice(0, 8)) {
      if (id !== sg.soc[0]) await runGame(P, id);
      cx = await P.evaluate(id => { const R = [...__sim.CACHE.values()].filter(x => x.gid === id && x.sc && x.sc.length).pop(); if (!R) return null; const g = SB.gameById(id);
        const p = R.sc.find(x => SB.p1(g, 'G:1st:' + x.id) > 0); return p && SB.p1(g, 'SX:HU1.5') > 0 ? { gid: id, id: p.id } : null; }, id);
      if (cx) break;
    }
    await P.evaluate(id => SB.goTab('sim', { gid: id }), sg.soc[0]);
    // --- stale what-if marker ---
    await P.evaluate(() => { const r = document.getElementById('smw_str'); r.value = '0.4'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    const st1 = await P.evaluate(() => ({ b: !!document.getElementById('smStale'), dim: !!document.querySelector('.sm-resw.sm-stale') }));
    await P.evaluate(() => { const r = document.getElementById('smw_str'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    const st2 = await P.evaluate(() => !!document.getElementById('smStale'));
    check('moving a what-if slider marks the shown results as stale (and back clears it)', st1.b && st1.dim && !st2, JSON.stringify({ st1, st2 }));
    // --- NHL: 3 periods, 15 four-minute buckets ---
    if (sg.nhl.length) {
      await runGame(P, sg.nhl[0]);
      const n1 = await P.evaluate(() => { const svg = [...document.querySelectorAll('.sm-svg')].find(x => /by game time/.test(x.getAttribute('aria-label') || ''));
        const gm = [...__sim.CACHE.values()].pop().gm; let out = 0; for (let i = 0; i < 40; i++) if (i % 20 >= 15) out += gm[i];
        return { axis: [...svg.querySelectorAll('text')].map(t => t.textContent).join(''), bars: svg.querySelectorAll('rect').length, out }; });
      check('NHL goal-timing chart: P1 P2 P3 with 15 four-minute bars', n1.axis === 'P1P2P3' && n1.bars === 15 && n1.out === 0, JSON.stringify(n1));
    }
    // --- another game picked mid-run: banner with Cancel / View, no dead end ---
    await P.evaluate(() => { __sim.BASE.clear(); __sim.CACHE.clear(); });
    await P.evaluate(id => SB.goTab('sim', { gid: id }), sg.nba[0]);
    await P.click('#smRun');
    await P.evaluate(id => SB.goTab('sim', { gid: id }), sg.soc[1]);
    const o1 = await P.evaluate(() => ({ active: __sim.RUN.active, banner: !!document.querySelector('#smOther [data-a="cancel"]'), runDis: document.getElementById('smRun').disabled, box: document.getElementById('smRunBox').textContent }));
    await P.click('#smOther [data-a="view"]');
    const o2 = await P.evaluate(id => ({ gid: __sim.S.gid === id, cancelVisible: !document.getElementById('smCancel').hidden }), sg.nba[0]);
    await P.evaluate(id => SB.goTab('sim', { gid: id }), sg.soc[1]);
    await P.click('#smOther [data-a="cancel"]');
    const o3 = await P.evaluate(() => ({ active: __sim.RUN.active, runDis: document.getElementById('smRun').disabled, banner: !!document.getElementById('smOther') }));
    check('run on another game: banner offers View / Cancel, run box says another sim is running', o1.active && o1.banner && o1.runDis && /Another simulation is running/.test(o1.box) && o2.gid && o2.cancelVisible, JSON.stringify({ o1, o2 }));
    check('banner Cancel stops the other run and frees the Run button', !o3.active && !o3.runDis && !o3.banner, JSON.stringify(o3));
    // --- parlay sim: per-leg % by position (same labels on different games), relative agreement, no fair-price prefill ---
    await P.evaluate(([a, b]) => { SB.setSlip([{ gid: a, key: 'O2.5' }, { gid: b, key: 'O2.5' }, { gid: a, key: 'BTTS' }, { gid: b, key: 'BTTS' }]); SB.goTab('sim', { mode: 'parlay' }); }, [sg.soc[0], sg.soc[1]]);
    await P.click('[data-a="prun"]');
    await P.waitForFunction(() => !__sim.RUN.active && __sim.PAR && __sim.PAR.per.length === 4, null, { timeout: 90000 });
    const pl = await P.evaluate(() => { const rows = [...document.querySelectorAll('.sm-pl .p')].map(x => x.firstChild.textContent.trim());
      const want = __sim.PAR.per.map(x => (x.sim * 100).toFixed(1) + '%'); return { rows, want }; });
    check('parlay sim rows show each leg’s own sim % (legs with the same label on different games)', JSON.stringify(pl.rows) === JSON.stringify(pl.want), JSON.stringify(pl));
    const ag = await P.evaluate(() => [__sim.parAgree({ hit: .0517, eng: .0377, N: 1e5 }).ok, __sim.parAgree({ hit: .395, eng: .3935, N: 1e5 }).ok, __sim.parAgree({ hit: .01, eng: 0, N: 1e5 }).ok]);
    check('parlay agreement is relative: 5.17% vs 3.77% differs, 39.5% vs 39.35% consistent, engine 0 never "consistent"', ag[0] === false && ag[1] === true && ag[2] === false, JSON.stringify(ag));
    const bk = await P.evaluate(() => ({ v: document.getElementById('smBp').value, dis: document.querySelector('[data-a="brun"]').disabled, ph: document.getElementById('smBp').placeholder, kv: document.getElementById('smBkv').textContent }));
    check('bankroll sim does not prefill our own fair price; Run waits for a book price', bk.v === '' && bk.dis && /fair/.test(bk.ph) && !/valid price/.test(bk.kv), JSON.stringify(bk));
    await P.fill('#smBp', '+400');
    check('typing a book price enables the bankroll run', await P.evaluate(() => !document.querySelector('[data-a="brun"]').disabled));
    await P.evaluate(id => { SB.setSlip([{ gid: id, key: 'H' }]); SB.goTab('sim', { mode: 'parlay' }); }, sg.soc[0]);
    await P.click('[data-a="prun"]');
    await P.waitForFunction(() => !__sim.RUN.active && __sim.PAR && __sim.PAR.per.length === 1, null, { timeout: 90000 });
    check('single calibrated leg: parlay sim and engine reported as consistent', /consistent/.test(await P.textContent('#smAgree')), await P.textContent('#smAgree'));
    // --- custom legs the sim can settle: SX team unders + first goalscorer ---
    if (cx) {
      await P.evaluate(c => { SB.setSlip([{ gid: c.gid, key: 'SX:HU1.5' }, { gid: c.gid, key: 'G:1st:' + c.id }]); SB.goTab('sim', { mode: 'parlay' }); }, cx);
      await P.click('[data-a="prun"]');
      await P.waitForFunction(() => !__sim.RUN.active && __sim.PAR && __sim.PAR.per.length === 2, null, { timeout: 90000 });
      const sx = await P.evaluate(c => { const g = SB.gameById(c.gid), per = __sim.PAR.per; return { how: per.map(x => x.how), sims: per.map(x => x.sim), eng: [SB.p1(g, 'SX:HU1.5'), SB.p1(g, 'G:1st:' + c.id)], notes: __sim.PAR.notes.join(' ') }; }, cx);
      check('SX and first-goalscorer legs are settled inside the sim (no engine-conditional fallback)', sx.how.join() === 'sim,sim' && !/can’t settle/.test(sx.notes) && Math.abs(sx.sims[0] - sx.eng[0]) < .02 && Math.abs(sx.sims[1] - sx.eng[1]) < .04, JSON.stringify(sx));
    } else check('SX / first-scorer parlay check skipped (no scorer data in the feed)', true);
    // --- Live mode: exact in-play DP ---
    const lv = await P.evaluate(id => { const g = SB.gameById(id), base = __sim.BASE.get(__sim.tsig(g)); __sim.S.wi = {};
      const a = __sim.liveCalc(g, base, { min: 0, h: 0, a: 0 }), z = __sim.liveCalc(g, base, { min: 90, h: 2, a: 1 }), r = __sim.liveCalc(g, base, { min: 45, h: 0, a: 0, ra: true }), n = __sim.liveCalc(g, base, { min: 45, h: 0, a: 0 });
      const GC = __sim.CORE.GC, sum = F => F.reduce((s, v) => s + v, 0); let below = 0; for (let h = 0; h < GC; h++) for (let x = 0; x < GC; x++) if (h < 2 || x < 1) below += z.F[h * GC + x];
      return { d0: Math.max(Math.abs(a.H - base.fitH), Math.abs(a.D - base.fitD)), s0: Math.abs(sum(a.F) - 1), p21: z.F[2 * GC + 1], below, s9: Math.abs(sum(z.F) - 1), red: r.H > n.H }; }, sg.soc[0]);
    check('live DP: minute 0 at 0-0 = pre-match fit; minute 90 at 2-1 keeps 2-1 most likely; reds help the other side', lv.d0 < 1e-4 && lv.s0 < 1e-9 && lv.p21 > .7 && lv.below === 0 && lv.s9 < 1e-9 && lv.red, JSON.stringify(lv));
    await P.evaluate(id => { SB.setSlip([{ gid: id, key: 'H' }, { gid: id, key: 'O2.5' }]); SB.goTab('sim', { gid: id, mode: 'live' }); }, sg.soc[0]);
    await P.waitForSelector('#smLiveOut .sm-lrow', { timeout: 30000 });
    await P.evaluate(() => { const r = document.getElementById('smLmin'); r.value = '70'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await P.click('[data-a="lstep"][data-k="h"][data-d="1"]');
    const lu = await P.evaluate(() => ({ t: document.getElementById('smLiveOut').textContent, sw: document.documentElement.scrollWidth, st: __sim.S.live }));
    check('Live mode prices the match and the slip from minute / score', /live parlay chance/.test(lu.t) && /Most likely final scores/.test(lu.t) && lu.st.min === 70 && lu.st.h === 1 && lu.sw <= 390, JSON.stringify(lu.st));
    // --- Watch one pauses when the user leaves the tab ---
    await P.evaluate(id => SB.goTab('sim', { gid: id, mode: 'watch' }), sg.soc[0]);
    await P.click('[data-a="wnew"]');
    await P.waitForFunction(() => __sim.W.ev && __sim.W.playing, null, { timeout: 30000 });
    await P.evaluate(() => SB.goTab('trending'));
    const p0 = await P.evaluate(() => __sim.W.pos);
    await P.waitForTimeout(2000);
    const p1 = await P.evaluate(() => ({ pos: __sim.W.pos, playing: __sim.W.playing }));
    check('Watch one pauses when you leave the Simulator tab', p1.pos - p0 <= 1 && !p1.playing, JSON.stringify({ p0, p1 }));
    // --- narrow phones: nothing clipped in market rows / KPI tiles ---
    await R1.ctx.close();
    for (const w of [360, 390]) {
      const N1 = await openPage({ w, h: 800 });
      let clip = [];
      for (const id of [sg.nba[0], sg.soc[0], sg.nfl[0]].filter(Boolean)) {
        await runGame(N1.page, id);
        await N1.page.evaluate(() => document.querySelectorAll('#simRoot details').forEach(d => { d.open = true; }));
        clip = clip.concat(await N1.page.evaluate(() => [...document.querySelectorAll('.sm-row .l b, .sm-row .l span, .sm-kpis b')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 30))));
      }
      const sw = await N1.page.evaluate(() => document.documentElement.scrollWidth);
      check(`${w}px: no clipped market labels / KPI values, no horizontal scroll`, !clip.length && sw <= w, clip.slice(0, 4).join(' | ') + ` sw ${sw}`);
      await N1.ctx.close();
    }
    // --- blob Workers blocked by CSP + slow CPU: one main-thread run, progress only rises ---
    const C = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const cp = await C.newPage(); const warns = [];
    cp.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text()); });
    await pinFeeds(cp);
    await cp.addInitScript(() => { localStorage.setItem('fm2.tab', JSON.stringify('sim')); });
    await cp.goto(BASE.replace('/index.html', '/csp/index.html'));
    await cp.waitForFunction(() => window.SB && SB.firstRender && window.__sim, null, { timeout: 30000 });
    const cdp = await C.newCDPSession(cp); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cp.evaluate(id => SB.goTab('sim', { gid: id }), sg.nba[0]);
    await cp.evaluate(() => { window.__tr = []; const f = () => { __tr.push(__sim.RUN.done); if (__sim.RUN.active || __tr.length < 3) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await cp.click('#smRun');
    await cp.waitForFunction(() => !__sim.RUN.active, null, { timeout: 300000 });
    const cs = await cp.evaluate(() => { let back = 0; for (let i = 1; i < __tr.length; i++) if (__tr[i] < __tr[i - 1] && __tr[i] !== 0) back++;
      const R = [...__sim.CACHE.values()].pop(); return { back, N: R && R.N, worker: __sim.DBG.worker, local: __sim.DBG.local }; });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    check('CSP blocks workers + 4x CPU: falls back once, progress never goes backwards, 100,000 sims', cs.back === 0 && cs.N === 100000 && cs.worker === false && cs.local === 1 && !warns.some(t => /worker silent/.test(t)), JSON.stringify(cs) + ' ' + warns.filter(t => /sim\.js/.test(t)).join(' | '));
    await C.close();
    // --- football drive model: key numbers and margin spread vs the engine's key-number model ---
    const G = await openPage({ w: 390, h: 844 });
    const fb = await G.page.evaluate(() => SB.DATA.games.filter(g => SB.priced(g) && SB.fit(g) && (g.sport === 'nfl' || g.sport === 'ncaaf')).map(g => { const m = SB.fit(g);
      let s1 = 0, s2 = 0; for (let i = 0; i < m.pm.length; i++) { const d = i - m.kmax; s1 += d * m.pm[i]; s2 += d * d * m.pm[i]; }
      return { id: g.id, sport: g.sport, tg: { ph: SB.p1(g, 'H'), T: m.T, mu: m.mu, sd: m.sd, tsd: m.tsd }, sd: Math.sqrt(s2 - s1 * s1) }; }));
    await G.ctx.close();
    const src = fs.readFileSync(path.join(ROOT, 'sim.js'), 'utf8');
    const CORE = new Function(src.slice(src.indexOf('function SIMCORE(){'), src.indexOf('/* ============================== end SIMCORE')) + ';return SIMCORE();')();
    const fbRun = (t, N) => { const it = CORE.makeJob({ cmd: 'run', spec: { gid: t.id, sport: t.sport, tg: t.tg, wi: {}, line: Math.floor(t.tg.T) + .5 }, N, seed: CORE.hashStr(t.id + '|run') }, { budget: 1e9 });
      let r; while (!(r = it.next()).done); const v = r.value; let k3 = 0, k7 = 0, hw = 0, tt = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const d = v.H[i] - v.A[i]; if (Math.abs(d) === 3) k3++; if (Math.abs(d) === 7) k7++; if (d > 0) hw++; tt += v.H[i] + v.A[i]; s1 += d; s2 += d * d; }
      return { k3: k3 / N, k7: k7 / N, ph: hw / N, tot: tt / N, sd: Math.sqrt(s2 / N - (s1 / N) ** 2) }; };
    const close = fb.filter(t => t.sport === 'nfl' && Math.abs(t.tg.mu) < 4.5).slice(0, 3), cfb = fb.filter(t => t.sport === 'ncaaf').slice(0, 2);
    for (const t of close) { const r = fbRun(t, 40000);
      check(`${t.id}: NFL margin 3 (${(r.k3 * 100).toFixed(1)}%) beats 7 (${(r.k7 * 100).toFixed(1)}%), both in range; fit still matches`, r.k3 > .12 && r.k3 < .17 && r.k7 > .075 && r.k7 < .115 && r.k3 > r.k7 && Math.abs(r.ph - t.tg.ph) < .012 && Math.abs(r.tot - t.tg.T) < .6 && Math.abs(r.sd - t.sd) < .8, JSON.stringify(r)); }
    for (const t of cfb) { const r = fbRun(t, 40000);
      check(`${t.id}: college margin spread ${r.sd.toFixed(1)} near the engine’s ${t.sd.toFixed(1)}`, Math.abs(r.sd - t.sd) < .8 && Math.abs(r.ph - t.tg.ph) < .012, JSON.stringify(r)); }
    if (!close.length && !cfb.length) check('football calibration checks skipped (no NFL/CFB games in the feed)', true);
  }

  check('no console errors', allErrors.length === 0, allErrors.slice(0, 5).join(' | '));
} catch (e) {
  check('test run threw', false, e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
