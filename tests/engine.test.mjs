// Engine & odds tests for Safe Bets (index.html). Run: node tests/engine.test.mjs
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
// module files owned by other engineers may not exist yet: their 404s are expected, not app errors
const OPTIONAL = /\/(soccer\.js|sim\.js|scorers\.json)$/;
const RENDER_BUDGET_MS = 1500;

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
async function openPage({ tab = 'trending', fmt = null, w = 390, h = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !OPTIONAL.test(m.location().url || '')) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.addInitScript(([t, f]) => { localStorage.setItem('fm2.tab', JSON.stringify(t)); if (f) localStorage.setItem('fm2.oddsFmt', JSON.stringify(f)); }, [tab, fmt]);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender, null, { timeout: 30000 });
  return { ctx, page, errors };
}

try {
  // ---------- model ----------
  const { ctx, page, errors } = await openPage();
  const m = await page.evaluate(() => {
    const SB = window.SB, out = { version: SB.version, nsim: SB.NSIM };
    const soccer = SB.DATA.games.filter(g => g.sport === 'soccer' && SB.priced(g));
    out.nSoccer = soccer.length;
    let sumErr = 0, x2Err = 0, compErr = 0, worst = '', jointErr = 0, totals = [];
    for (const g of soccer) {
      const M = SB.scoreMatrix(g), n = M.n; let s = 0, H = 0, D = 0, A = 0, ho = 0;
      for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) { const p = M.P[h * n + a]; s += p; if (h > a) H += p; else if (h === a) D += p; else A += p; if (h > a && h + a > 2.5) ho += p; }
      sumErr = Math.max(sumErr, Math.abs(s - 1));
      const t = g.prob.home + g.prob.away + (g.prob.draw || 0);
      const e = Math.max(Math.abs(H - g.prob.home / t), Math.abs(D - g.prob.draw / t), Math.abs(A - g.prob.away / t));
      if (e > x2Err) { x2Err = e; worst = g.id; }
      totals.push(M.eh + M.ea);
      const p = k => SB.p1(g, k);
      let cs = p('CSOH') + p('CSOD') + p('CSOA'); for (let h = 0; h <= 4; h++) for (let a = 0; a <= 4; a++) cs += p(`CS${h}-${a}`);
      compErr = Math.max(compErr, Math.abs(p('O2.5') + p('U2.5') - 1), Math.abs(p('BTTS') + p('BTTSN') - 1), Math.abs(cs - 1),
        Math.abs(p('DC1X') - p('H') - p('D')), Math.abs(p('DCX2') - p('A') - p('D')), Math.abs(p('DC12') - p('H') - p('A')),
        Math.abs(p('O1.5') + p('U1.5') - 1), Math.abs(p('H') + p('D') + p('A') - 1), Math.abs(p('HCS') - (1 - p('AO0.5'))));
      // joint of two same-game legs == exact matrix sum
      jointErr = Math.max(jointErr, Math.abs(SB.probOf(g, ['H', 'O2.5']) - ho), Math.abs(SB.p1(g, 'H&O2.5') - ho));
    }
    Object.assign(out, { sumErr, x2Err, worst, compErr, jointErr, tMin: Math.min(...totals), tMax: Math.max(...totals) });
    // legacy keys used by saved slips
    const g0 = soccer[0];
    out.legacy = ['H', 'D', 'A', 'H2', 'A2', 'O0.5', 'O1.5', 'O2.5', 'U2.5', 'U3.5', 'U4.5'].every(k => SB.marketsFor(g0).some(m => m.key === k));
    out.newKeys = ['O3.5', 'O4.5', 'U1.5', 'BTTS', 'BTTSN', 'DC1X', 'DCX2', 'DC12', 'HO0.5', 'HO1.5', 'HO2.5', 'AO0.5', 'AO1.5', 'AO2.5', 'HCS', 'ACS', 'HWN', 'AWN', 'H+1.5', 'A+1.5', 'CS2-1', 'CS0-0', 'CS4-4', 'CSOH', 'CSOD', 'CSOA', 'H&O2.5', 'A&O2.5', 'BTTS&O2.5']
      .filter(k => !SB.marketsFor(g0).some(m => m.key === k));
    // auto-parlay pool never uses correct scores
    out.csInAuto = (() => { const P = window.__fm2.buildParlay(() => true, .25, 4, .6, .8); return P ? P.legs.some(l => /^CS/.test(l.key)) : false; })();
    // NHL: OT counts, H + A = 1, matches provider
    const nhl = SB.DATA.games.filter(g => g.sport === 'nhl' && SB.priced(g));
    out.nhlErr = Math.max(0, ...nhl.map(g => Math.max(Math.abs(SB.p1(g, 'H') + SB.p1(g, 'A') - 1), Math.abs(SB.p1(g, 'H') - g.prob.home / (g.prob.home + g.prob.away)))));
    out.nhlN = nhl.length;
    // margin sports: 100k seeded sims, joint <= min single
    const mg = SB.DATA.games.find(g => g.sport === 'nba' && SB.priced(g));
    if (mg) { const s = SB.simGame(mg), mk = SB.marketsFor(mg); const ks = [mk[0].key, mk.find(x => x.group === 'Total points').key];
      out.simN = s.N; out.marginJointOk = SB.probOf(mg, ks) <= Math.min(SB.p1(mg, ks[0]), SB.p1(mg, ks[1])) + 1e-12 && SB.probOf(mg, ks) > 0; }
    // custom leg type: exact joint via condMany
    SB.registerLegType('TST', {
      label: (k, g) => 'Test leg ' + k,
      prob: (g, k) => { const M = SB.scoreMatrix(g); let s = 0; for (let h = 0; h < M.n; h++) for (let a = 0; a < M.n; a++) s += M.P[h * M.n + a] * (1 - Math.pow(.7, h)); return s; },
      cond: (g, k) => (h, a) => 1 - Math.pow(.7, h),
    });
    const key = 'TST:x';
    let manual = 0; { const M = SB.scoreMatrix(g0); for (let h = 0; h < M.n; h++) for (let a = 0; a < M.n; a++) if (h + a > 2.5) manual += M.P[h * M.n + a] * (1 - Math.pow(.7, h)); }
    out.customErr = Math.abs(SB.probOf(g0, [key, 'O2.5']) - manual);
    out.customLabel = SB.legLabel({ gid: g0.id, key });
    out.customAdded = SB.toggleLeg(g0.id, key) === true && SB.inSlip(g0.id, key);
    out.parlayCustomErr = Math.abs(SB.parlayProb([{ gid: g0.id, key }, { gid: g0.id, key: 'O2.5' }]).p - manual);
    SB.setSlip([]);
    out.evalMarket = [SB.evalMarket(g0, 'CS2-1', 2, 1), SB.evalMarket(g0, 'BTTS', 1, 0), SB.evalMarket(g0, 'O2.5', 2, 1)];
    // registerTab + goTab params + events
    let got = null, evs = [];
    SB.on('oddsformat', f => evs.push(f));
    SB.registerTab({ key: 'ztest', label: 'Z', after: 'odds', render: (el, params) => { got = params; el.innerHTML = '<div id="ztest">z</div>'; } });
    SB.goTab('ztest', { a: 1 });
    out.tabOrder = [...document.querySelectorAll('.tab')].map(b => b.dataset.t).join(',');
    out.tabParams = got && got.a === 1 && !!document.getElementById('ztest');
    SB.setOddsFormat('decimal'); out.fmtDec = SB.fmtOdds(.4); SB.setOddsFormat('fractional'); out.fmtFrac = SB.fmtOdds(.4);
    SB.setOddsFormat('prob'); out.fmtProb = SB.fmtOdds(.4); SB.setOddsFormat('american'); out.fmtAm = SB.fmtOdds(.4);
    out.events = evs.join(',');
    out.storedFmt = localStorage.getItem('fm2.oddsFmt');
    out.dataScorers = 'scorers' in SB.DATA;
    return out;
  });
  check('SB.version === 2', m.version === 2);
  check('SB.NSIM === 100000', m.nsim === 100000, String(m.nsim));
  check('priced soccer games found', m.nSoccer > 0, String(m.nSoccer));
  check('every soccer score matrix sums to 1 (1e-9)', m.sumErr < 1e-9, m.sumErr.toExponential(2));
  check('matrix reproduces provider 1X2 within 0.5pp', m.x2Err < .005, `${(m.x2Err * 100).toExponential(2)}pp worst ${m.worst}`);
  check('expected goals plausible (1.5-6.5)', m.tMin > 1.5 && m.tMax < 6.5, `${m.tMin.toFixed(2)}-${m.tMax.toFixed(2)}`);
  check('complementary soccer markets sum exactly (O/U, BTTS, CS+other, DC)', m.compErr < 1e-9, m.compErr.toExponential(2));
  check('probOf same-game soccer legs == exact matrix sum', m.jointErr < 1e-12, m.jointErr.toExponential(2));
  check('legacy soccer keys still exist', m.legacy);
  check('all new soccer market keys exist', m.newKeys.length === 0, m.newKeys.join(','));
  check('correct scores never enter auto parlays', !m.csInAuto);
  check('NHL H+A=1 and matches provider (OT counts)', m.nhlN === 0 || m.nhlErr < 1e-6, `${m.nhlN} games, err ${m.nhlErr}`);
  check('margin sports run 100,000 sims', m.simN === undefined || m.simN === 100000, String(m.simN));
  check('margin joint <= single legs', m.marginJointOk !== false);
  check('registerLegType exact joint via cond()', m.customErr < 1e-12, String(m.customErr));
  check('custom leg label / toggle / parlayProb', m.customLabel === 'Test leg TST:x' && m.customAdded && m.parlayCustomErr < 1e-12);
  check('evalMarket settles scores', JSON.stringify(m.evalMarket) === '[true,false,true]', JSON.stringify(m.evalMarket));
  check('registerTab after + goTab params', m.tabParams && /parlays,odds,ztest/.test(m.tabOrder), m.tabOrder);
  check('odds formats', m.fmtDec === '2.50' && m.fmtFrac === '3/2' && m.fmtProb === '40%' && m.fmtAm === '+150', [m.fmtDec, m.fmtFrac, m.fmtProb, m.fmtAm].join(' '));
  check("'oddsformat' events + persisted to store", m.events === 'decimal,fractional,prob,american' && m.storedFmt === '"american"', m.events);
  check('DATA.scorers present (null when file missing)', m.dataScorers);

  // ---------- odds maths ----------
  const o = await page.evaluate(() => {
    const SB = window.SB, r = {};
    r.parse = ['+250', '-120', '2.5', '3/2', '40%', '+100', '-100', 'evens', '150', 'abc', '-50', '0.5', ''].map(SB.parseOdds);
    let worst = 0;
    for (const p of [.02, .1, .2, .3333, .45, .5, .55, .6, .75, .9, .97]) {
      const am = SB.p2am(p), d = SB.am2dec(am); worst = Math.max(worst, Math.abs(1 / d - p)); // american rounding
      worst = Math.max(worst, Math.abs(SB.dec2p(SB.p2dec(p)) - p));
      for (const f of ['american', 'decimal', 'prob']) worst = Math.max(worst, Math.abs(1 / SB.parseOdds(SB.fmtOdds(p, f)) - p) > .006 ? 1 : 0);
    }
    for (const a of [-1000, -250, -110, 100, 120, 250, 900]) worst = Math.max(worst, Math.abs(SB.dec2am(SB.am2dec(a)) - a) > 0 ? 1 : 0);
    r.roundTrip = worst;
    r.frac = SB.parseOdds(SB.fmtPrice(2.5, 'fractional'));
    r.ev = SB.ev(.5, 2.2); r.kelly = SB.kelly(.5, 2.2, .25); r.kellyNeg = SB.kelly(.4, 2, 1);
    const nv = SB.noVig([SB.parseOdds('-110'), SB.parseOdds('-110')], 'shin'); r.nv = nv;
    r.nvSum = ['multiplicative', 'additive', 'power', 'shin'].map(mm => SB.noVig([2.5, 3.4, 3.1], mm).reduce((a, b) => a + b, 0));
    return r;
  });
  const exp = [3.5, 1 + 100 / 120, 2.5, 2.5, 2.5, 2, 2, 2, 2.5, null, null, null, null];
  check('parseOdds +250 -120 2.5 3/2 40% (+ edge cases)', o.parse.every((v, i) => v === exp[i] || (v != null && exp[i] != null && Math.abs(v - exp[i]) < 1e-12)), JSON.stringify(o.parse));
  check('odds conversions round-trip', o.roundTrip < .006, String(o.roundTrip));
  check('fractional round-trip 3/2', Math.abs(o.frac - 2.5) < 1e-12);
  check('ev / kelly', Math.abs(o.ev - .1) < 1e-12 && Math.abs(o.kelly - .25 * (.1 / 1.2)) < 1e-12 && o.kellyNeg === 0);
  check('no-vig methods sum to 1', o.nvSum.every(s => Math.abs(s - 1) < 1e-6) && Math.abs(o.nv[0] - .5) < 1e-9, o.nvSum.join(','));

  // ---------- determinism across reloads ----------
  const snap = () => page.evaluate(() => { const SB = window.SB; const out = [];
    for (const g of SB.DATA.games.filter(g => SB.priced(g))) for (const m of SB.marketsFor(g)) out.push(g.id + '|' + m.key + '=' + SB.p1(g, m.key).toPrecision(15) + '|' + SB.fmtOdds(SB.p1(g, m.key)));
    return out.join('\n'); });
  const s1 = await snap();
  await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender);
  const s2 = await snap();
  check('every price identical across two page loads', s1 === s2 && s1.length > 1000, `${s1.split('\n').length} markets`);

  // ---------- click-through: tabs, game sheet, slip ----------
  await page.evaluate(() => SB.goTab('trending'));
  const tabs = await page.$$eval('.tab', bs => bs.map(b => b.dataset.t).filter(t => t !== 'ztest'));
  for (const t of tabs) { await page.click(`.tab[data-t="${t}"]`); await page.waitForTimeout(120);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > 390) check(`no horizontal scroll on ${t}`, false, `scrollWidth ${sw}`); }
  check('visited every tab', tabs.includes('odds') && tabs.length >= 12, tabs.join(','));
  await page.click('.tab[data-t="soccer"]');
  await page.click('.mk .team');
  await page.waitForSelector('#sheet.on .csc');
  await page.click('#sheet .csc >> nth=11');
  await page.click('#sheet [data-leg$="|O2.5"]');
  const slipKeys = await page.evaluate(() => SB.slip.map(l => l.key).join(','));
  check('correct-score grid + market buttons add legs', slipKeys === 'CS2-1,O2.5', slipKeys);
  await page.click('#closeS');
  await page.click('#slipbar');
  await page.waitForSelector('#sheet.on #bookOdds');
  await page.fill('#bookOdds', '5/1');
  const chk = await page.textContent('#chkOut');
  check('price check accepts fractional input and shows EV / Kelly', /Expected value/.test(chk) && /Kelly/.test(chk), chk.slice(0, 80));
  const minTxt = await page.textContent('#minOut');
  check('min price for +EV and 5% edge shown', /\+EV only at/.test(minTxt) && /5% edge/.test(minTxt));
  await page.selectOption('#oddsFmt', 'decimal');
  const slipO = await page.textContent('#slipO');
  check('slip bar follows odds format', /^\d+\.\d+$/.test(slipO.trim()), slipO);
  await page.selectOption('#oddsFmt', 'american');
  await page.click('#clearSlip');
  // odds tools tab works with live inputs
  await page.click('.tab[data-t="odds"]');
  await page.fill('[data-ot="conv"]', '3/2');
  const conv = await page.textContent('#o-conv');
  check('odds converter live update', /\+150/.test(conv) && /40\.00%/.test(conv), conv.slice(0, 60));
  await page.fill('[data-ot="arb.0"]', '2.1'); await page.fill('[data-ot="arb.1"]', '2.1');
  check('arbitrage checker finds arb', /Arbitrage profit/.test(await page.textContent('#o-arb')));
  check('parlay cards show "Bet only at ... or better"', await page.evaluate(() => { SB.goTab('parlays'); return /Bet only at/.test(document.getElementById('main').textContent); }));
  check('footer disclaimer present', /model estimates, not guarantees/.test(await page.textContent('footer')));
  check('no console errors across tabs, game sheet, slip', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ---------- first render time, every tab, cold load ----------
  for (const t of ['trending', 'props', 'fantasy', 'parlays', 'odds', 'soccer', 'nba', 'nfl', 'nhl', 'ncaaf', 'mine', 'lab']) {
    const P = await openPage({ tab: t });
    const fr = await P.page.evaluate(() => SB.firstRender);
    check(`first render of ${t} < ${RENDER_BUDGET_MS}ms`, fr.ms < RENDER_BUDGET_MS, `${fr.ms.toFixed(0)}ms render, ${fr.at.toFixed(0)}ms since navigation`);
    if (P.errors.length) check(`no console errors on cold ${t}`, false, P.errors[0]);
    await P.ctx.close();
  }
} catch (e) {
  check('test run completed', false, e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
