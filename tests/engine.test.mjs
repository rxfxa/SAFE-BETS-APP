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
  check('registerTab after + goTab params (odds now sits with the tools: fixed TAB_ORDER)', m.tabParams && /odds,ztest/.test(m.tabOrder), m.tabOrder);
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

  // ================= regression checks for fix round 1 (engine fixer) =================
  {
    const { ctx, page, errors } = await openPage();
    // ---- calibration: soccer (quant-1 / soccer-1 / sim-10), margin totals (quant-2), NFL key numbers (quant-5), NHL (quant-6)
    const c = await page.evaluate(() => {
      const r = {}, S = SB.DATA.games.filter(g => g.sport === 'soccer' && SB.priced(g));
      let x2 = 0, o25 = 0, rhoMax = -9, tMax = 0, tPriorBad = [];
      for (const g of S) { const m = SB.fit(g), M = SB.scoreMatrix(g), t = g.prob.home + g.prob.away + g.prob.draw; let H = 0, D = 0, A = 0;
        for (let h = 0; h < 11; h++) for (let a = 0; a < 11; a++) { const p = M.P[h * 11 + a]; if (h > a) H += p; else if (h === a) D += p; else A += p; }
        x2 = Math.max(x2, Math.abs(H - g.prob.home / t), Math.abs(D - g.prob.draw / t), Math.abs(A - g.prob.away / t));
        o25 += SB.p1(g, 'O2.5'); if (!/feed total/.test(m.method)) rhoMax = Math.max(rhoMax, m.rho); tMax = Math.max(tMax, m.lh + m.la);
        if (!g.total && m.lh + m.la > SB.leagueT(g.comp) + 1.2 + 1e-9) tPriorBad.push(g.id); }
      Object.assign(r, { n: S.length, x2, meanO25: o25 / S.length, rhoMax, tMax, tPriorBad });
      const find = (h, a) => S.find(g => g.home.abbr === h && g.away.abbr === a);
      const mci = find('MCI', 'FUL'); r.mci = mci ? SB.p1(mci, 'O2.5') : null;
      r.lt = ['UEFA Champions League', 'LaLiga', 'Premier League', 'Bundesliga', 'Somewhere Else'].map(SB.leagueT);
      // a feed total still drives the soccer fit (copy of a game, nothing global touched)
      const g0 = S[0], gt = { ...g0, id: g0.id + '-t', total: 2.4 }; delete gt._m; delete gt._sm; r.feedTotal = [SB.fit(gt).method, SB.fit(gt).lh + SB.fit(gt).la];
      // margin sports: no feed total -> total ladder is labelled, out of auto parlays; a feed total brings it back, centred on the line
      r.totInParlay = ['nba', 'nfl', 'ncaaf', 'nhl'].map(sp => { const P = window.__fm2.buildParlay(g => g.sport === sp, .25, 4, .6, .8); return P ? P.legs.filter(l => /total|goals/i.test(l.label) && !/win/.test(l.label)).length : 0; });
      const nba = SB.DATA.games.find(g => g.sport === 'nba' && SB.priced(g));
      r.gen = SB.marketsFor(nba).filter(m => m.group === 'Total points').every(m => m.gen && m.nopool);
      const nb2 = { ...nba, id: nba.id + '-t', total: 238.5 }; delete nb2._m; delete nb2._mk; delete nb2._s;
      const tk = SB.marketsFor(nb2).filter(m => m.group === 'Total points');
      r.withTotal = { gen: tk.some(m => m.gen || m.nopool), mid: SB.p1(nb2, 'O238.5'), T: SB.fit(nb2).T };
      // NFL integer margins with key numbers
      const nfl = SB.DATA.games.filter(g => g.sport === 'nfl' && SB.priced(g)); let k3 = 0, k7 = 0, frac = 0, N = 0;
      for (const g of nfl) { const s = SB.simGame(g); for (let i = 0; i < s.N; i++) { const d = Math.abs(s.mg[i]); if (d === 3) k3++; if (d === 7) k7++; if (d !== Math.round(d)) frac++; } N += s.N; }
      r.nfl = { n: nfl.length, k3: k3 / N, k7: k7 / N, frac };
      // NHL: final-score mean ~6.2 goals, regulation ties 21-24%, a feed total is honoured
      const nhl = SB.DATA.games.filter(g => g.sport === 'nhl' && SB.priced(g)), ef = g => { const O = SB.outcomes(g); let e = 0; for (let i = 0; i < O.n; i++) e += (O.h[i] + O.a[i]) * O.p[i]; return e; };
      r.nhl = nhl.map(g => { const M = SB.scoreMatrix(g); let t = 0; for (let h = 0; h < 11; h++) t += M.P[h * 11 + h]; return [ef(g), t]; });
      const nh2 = { ...nhl[0], id: nhl[0].id + '-t', total: 6.5 }; delete nh2._m; delete nh2._sm; delete nh2._o; delete nh2._mk;
      r.nhlTotal = [ef(nh2), SB.marketsFor(nh2).some(m => m.gen), SB.marketsFor(nhl[0]).filter(m => m.group === 'Total goals').every(m => m.gen && m.nopool)];
      return r;
    });
    check('soccer fit: provider 1X2 reproduced < 1e-6 on every game', c.x2 < 1e-6, c.x2.toExponential(2));
    check('soccer fit: slate mean Over 2.5 in 0.55-0.62 (was 0.635)', c.meanO25 > .55 && c.meanO25 < .62, c.meanO25.toFixed(3));
    check('soccer fit: rho <= 0.05 and total <= 4.0 (no positive-rho blow-ups)', c.rhoMax <= .05 + 1e-9 && c.tMax <= 4 + 1e-9, `rho ${c.rhoMax.toFixed(3)} T ${c.tMax.toFixed(2)}`);
    check('soccer fit: total never above league prior + 1.2', !c.tPriorBad.length, c.tPriorBad.join(','));
    check('soccer fit: MCI-FUL Over 2.5 ~0.63 (book ~0.636)', c.mci == null || Math.abs(c.mci - .63) < .03, String(c.mci));
    check('league prior lookup normalises comp aliases', JSON.stringify(c.lt) === JSON.stringify([3.1, 2.6, 2.85, 3.1, 2.8]), JSON.stringify(c.lt));
    check('soccer fit: a feed total still drives the fit', c.feedTotal[0] === 'feed total' && Math.abs(c.feedTotal[1] - 2.4) < 1e-9, JSON.stringify(c.feedTotal));
    check('no-line totals (NBA/NFL/NCAAF/NHL) never enter auto parlays', c.totInParlay.every(x => x === 0), JSON.stringify(c.totInParlay));
    check('no-line total ladder is flagged gen + nopool', c.gen);
    check('a feed total brings the ladder back, centred on the line', !c.withTotal.gen && Math.abs(c.withTotal.mid - .5) < .01 && c.withTotal.T === 238.5, JSON.stringify(c.withTotal));
    check('NFL margins are whole points with key numbers (|3| > 8%, |7| > 5%)', c.nfl.n === 0 || (c.nfl.frac === 0 && c.nfl.k3 > .08 && c.nfl.k7 > .05), JSON.stringify(c.nfl));
    check('NHL: final total ~6.2 and regulation ties 21-24%', c.nhl.every(([e, t]) => e > 6.05 && e < 6.35 && t > .21 && t < .24), JSON.stringify(c.nhl.slice(0, 3)));
    check('NHL: feed total honoured (E[final] = 6.5), no-line totals nopool', Math.abs(c.nhlTotal[0] - 6.5) < .01 && !c.nhlTotal[1] && c.nhlTotal[2], JSON.stringify(c.nhlTotal));

    // ---- odds parsing / display (quant-3, quant-7)
    const o2 = await page.evaluate(() => ({
      p: [['1,85', 'american'], ['1,85', 'decimal'], ['2,000', 'american'], ['150', 'decimal'], ['150', 'american'], ['40', 'prob'], ['+150', 'decimal'], ['101', 'decimal'], ['100', 'american']].map(([s, f]) => SB.parseOdds(s, f)),
      frac: [1.909, 2.05, 2, 1.5].map(d => SB.fmtPrice(d, 'fractional')), ev: [SB.fmtOdds(.5, 'american'), SB.fmtPrice(2, 'american')],
      rt: [.005, .01, .3, .62].every(p => Math.abs(1 / SB.parseOdds(SB.fmtOdds(p, 'decimal'), 'decimal') - p) < .006),
      rtFrac: [.05, .3, .5, .62, .9].every(p => Math.abs(1 / SB.parseOdds(SB.fmtOdds(p, 'fractional'), 'fractional') - p) < .02) }));
    check('parseOdds: decimal comma, thousands, bare number follows the odds format', JSON.stringify(o2.p) === JSON.stringify([1.85, 1.85, 21, 150, 2.5, 2.5, 2.5, 101, 2]), JSON.stringify(o2.p));
    check('fractional uses the UK ladder (10/11, 21/20, Evens) and even money is +100 both ways', JSON.stringify(o2.frac) === JSON.stringify(['10/11', '21/20', 'Evens', '1/2']) && o2.ev[0] === '+100' && o2.ev[1] === '+100', JSON.stringify(o2));
    check('decimal round trip down to p=0.005; fractional round trip', o2.rt && o2.rtFrac);

    // ---- slip hygiene: bad keys pruned (qa-3), two correct scores refused (ux-5), replace + undo (ux-9)
    const sl = await page.evaluate(() => {
      const g = SB.DATA.games.find(g => g.sport === 'soccer' && SB.priced(g)), nba = SB.DATA.games.find(g => g.sport === 'nba' && SB.priced(g)), r = {};
      SB.setSlip([{ gid: nba.id, key: 'O215.5' }, { gid: nba.id, key: 'H' }]); r.pruned = SB.slip.map(l => l.key).join(',');
      SB.setSlip([]); r.cs1 = SB.toggleLeg(g.id, 'CS1-0'); r.cs2 = SB.toggleLeg(g.id, 'CS2-0'); r.csN = SB.slip.length;
      SB.setSlip([{ gid: g.id, key: 'H' }, { gid: g.id, key: 'O1.5' }]);
      SB.replaceSlip([{ gid: nba.id, key: 'H' }]); r.replaced = SB.slip.map(l => l.key).join(',');
      r.toast = /Replaced your 2-leg slip/.test(document.getElementById('toast').textContent) && !!document.getElementById('undoSlip');
      document.getElementById('undoSlip').click(); r.undone = SB.slip.map(l => l.key).sort().join(','); SB.setSlip([]); return r;
    });
    check('a slip leg whose market no longer exists is pruned (no 0% parlay)', sl.pruned === 'H', sl.pruned);
    check('two correct scores from one match are refused', sl.cs1 === true && sl.cs2 === false && sl.csN === 1, JSON.stringify(sl));
    check('"Open in builder" replace shows Undo, and Undo restores the hand-built slip', sl.replaced === 'H' && sl.toast && sl.undone === 'H,O1.5', JSON.stringify(sl));

    // ---- your book's prices (gaps-1)
    const bk = await page.evaluate(() => {
      const g = SB.DATA.games.find(g => g.sport === 'soccer' && SB.priced(g) && g.home.abbr === 'BAR' && g.away.abbr === 'VIL') || SB.DATA.games.find(g => g.sport === 'soccer' && SB.priced(g));
      const before = SB.p1(g, 'O2.5'); SB.openGame(g.id); document.getElementById('bookBox').open = true;
      const set = (k, v) => { const i = document.querySelector(`[data-bk="${k}"]`); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      set('o', '-150'); set('u', '+125'); set('h', '-435'); set('d', '+600'); set('a', '+1200');
      document.getElementById('bookUse').click(); const g2 = SB.gameById(g.id), m = SB.fit(g2), O = SB.noVig([SB.parseOdds('-150'), SB.parseOdds('+125')], 'shin')[0];
      const r = { id: g.id, method: m.method, rho: m.rho, dO: Math.abs(SB.p1(g2, 'O2.5') - O), badge: /IN USE/.test(document.getElementById('sheet').textContent) };
      return { r, before };
    });
    check('your-book prices refit every market (method, rho range, Over 2.5 = de-vigged book)', bk.r.method === 'your book' && bk.r.rho >= -.15 - 1e-9 && bk.r.rho <= .1 + 1e-9 && bk.r.dO < .005 && bk.r.badge, JSON.stringify(bk.r));
    await page.evaluate(() => window.__fm2.refreshTick());
    const bk2 = await page.evaluate(id => SB.fit(SB.gameById(id)).method, bk.r.id);
    check('your-book prices survive a data reload', bk2 === 'your book', bk2);
    const bk3 = await page.evaluate(id => { SB.openGame(id); document.getElementById('bookClr').click(); return SB.p1(SB.gameById(id), 'O2.5'); }, bk.r.id);
    check('Clear restores the provider fit exactly', bk3 === bk.before, `${bk3} vs ${bk.before}`);

    // ---- same-game pairs (gaps-2)
    const pr = await page.evaluate(id => { const g = SB.gameById(id), P = window.__fm2.bestPairs(g), all = [...P.together, ...P.apart];
      return { n: all.length, nested: all.filter(x => x.pj >= Math.min(x.pa, x.pb) - 1e-9).length, finite: all.every(x => isFinite(x.lift)), shown: !!document.querySelector('#sheet .pairs .prow') }; }, bk.r.id);
    check('same-game pairs: listed, no nested pair, finite lifts', pr.n > 0 && pr.nested === 0 && pr.finite && pr.shown, JSON.stringify(pr));

    // ---- dialog (ux-3), heatmap price (ux-5), slip bar above the sheet (ux-5), tiny prices (ux-13)
    const dg = await page.evaluate(() => { const S = document.getElementById('sheet'), b = document.getElementById('slipbar');
      const cell = document.querySelector('#sheet .csc:not([disabled])'); cell.click();
      const r = { role: S.getAttribute('role'), modal: S.getAttribute('aria-modal'), inertMain: document.getElementById('main').inert, csPrice: !!cell.querySelector('.csp') && /[+-]\d/.test(cell.textContent),
        toast: /Added/.test(document.getElementById('toast').textContent) };
      const br = b.getBoundingClientRect(), el = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); r.barOnTop = !!el && b.contains(el);
      const tiny = [...document.querySelectorAll('#sheet .mrow')].find(x => /<0\.5%/.test(x.textContent)); r.tinyDisabled = !tiny || tiny.querySelector('button').disabled;
      return r; });
    check('sheet is a modal dialog with the page behind inert', dg.role === 'dialog' && dg.modal === 'true' && dg.inertMain === true, JSON.stringify(dg));
    check('correct-score cells show their price; tapping one toasts; slip bar sits above the sheet', dg.csPrice && dg.toast && dg.barOnTop, JSON.stringify(dg));
    check('sub-0.5% markets show a capped label with a disabled button', dg.tinyDisabled);
    await page.keyboard.press('Escape');
    check('Escape closes the sheet', await page.evaluate(() => !document.getElementById('sheet').classList.contains('on') && document.getElementById('sheet').inert));
    await page.evaluate(() => SB.setSlip([]));

    // ---- keyboard: Tab reaches a game opener, Enter opens the sheet, focus moves in, Escape returns focus (ux-2, ux-3)
    await page.evaluate(() => { SB.goTab('soccer'); document.activeElement.blur(); window.scrollTo(0, 0); });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement.closest('[data-open]')); }
    const opener = await page.evaluate(() => document.activeElement.dataset.open);
    await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    const kb = await page.evaluate(() => ({ open: document.getElementById('sheet').classList.contains('on'), inSheet: document.getElementById('sheet').contains(document.activeElement) }));
    await page.keyboard.press('Escape'); await page.waitForTimeout(50);
    const back = await page.evaluate(() => document.activeElement.dataset && document.activeElement.dataset.open);
    check('keyboard: Tab reaches a game opener, Enter opens the sheet, focus moves into it', reached && kb.open && kb.inSheet, JSON.stringify({ reached, ...kb }));
    check('keyboard: closing returns focus to the opener', back === opener, `${back} vs ${opener}`);

    // ---- nav (ux-1): the active tab is always scrolled into view; no horizontal page scroll
    const nav = await page.evaluate(() => { const bad = []; for (const k of [...document.querySelectorAll('#tabs .tab')].map(b => b.dataset.t)) { if (k === 'lab' || k === 'ztest') continue; SB.goTab(k);
      const T = document.getElementById('tabs').getBoundingClientRect(), r = document.querySelector('#tabs .tab.on').getBoundingClientRect(); if (r.left < T.left - 1 || r.right > T.right + 1) bad.push(k);
      if (document.querySelector('#tabs .tab.on').getAttribute('aria-current') !== 'page') bad.push(k + ':aria'); }
      return { bad, sw: document.documentElement.scrollWidth }; });
    check('390px: every active tab is scrolled into view with aria-current', !nav.bad.length && nav.sw <= 390, JSON.stringify(nav));

    // ---- % format wording (ux-10)
    const pf = await page.evaluate(() => { SB.setOddsFormat('prob'); SB.goTab('parlays'); const t = document.getElementById('main').textContent; SB.setOddsFormat('american'); return { orBetter: /or better/.test(t), lower: /or lower/.test(t) }; });
    check('% format: no ambiguous "or better", says "or lower"', !pf.orBetter && pf.lower, JSON.stringify(pf));

    // ---- theme (ux-16): one committed black theme, no toggle; the 'theme' event name stays subscribable for modules
    const th = await page.evaluate(() => ({ cs: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.body).backgroundColor,
      toggle: !!document.getElementById('themeBtn'), sub: typeof SB.on('theme', () => {}) }));
    check('single black theme: color-scheme dark, black page, no theme toggle, theme event still subscribable', th.cs === 'dark' && th.bg === 'rgb(0, 0, 0)' && !th.toggle && th.sub === 'function', JSON.stringify(th));

    // ---- background refresh never steals focus from a field being typed in (ux-12)
    await page.evaluate(() => SB.goTab('odds'));
    await page.click('[data-ot="conv"]'); await page.keyboard.type('5');
    await page.evaluate(() => window.__fm2.refreshTick());
    const ty = await page.evaluate(() => ({ still: document.activeElement && document.activeElement.dataset.ot === 'conv', v: document.activeElement.value }));
    check('a refresh while typing keeps focus and the value', ty.still && /5$/.test(ty.v), JSON.stringify(ty));

    // ---- sims are reused across a reload (qa-5)
    const sc = await page.evaluate(async () => { const g = SB.DATA.games.find(g => g.sport === 'nba' && SB.priced(g)), s1 = SB.simGame(g), p = SB.p1(g, 'H');
      await window.__fm2.refreshTick(); const g2 = SB.gameById(g.id); return { same: SB.simGame(g2) === s1, p: SB.p1(g2, 'H') === p, fresh: g2 !== g }; });
    check('100k sims are reused after a data reload (same numbers, no recompute)', sc.same && sc.p && sc.fresh, JSON.stringify(sc));

    // ---- lab loads only on request and is not rebuilt by a refresh (qa-7)
    const lb = await page.evaluate(async () => { SB.goTab('lab'); const r = { before: document.querySelectorAll('iframe').length }; document.getElementById('labLoad').click();
      const f = document.querySelector('#labHost iframe'); await window.__fm2.refreshTick(); SB.goTab('trending'); SB.goTab('lab'); r.same = document.querySelector('#labHost iframe') === f; r.n = document.querySelectorAll('iframe').length; SB.goTab('trending'); r.hidden = document.getElementById('labHost').hidden; return r; });
    check('Sharp Lab loads on tap, one iframe, kept across refresh and tab switches', lb.before === 0 && lb.same && lb.n === 1 && lb.hidden, JSON.stringify(lb));
    check('no console errors in the regression run', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---- feed failures (qa-1) and odd feed shapes (qa-6) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(e.message));
    let mode = 'ok';
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    const g0 = real.games.find(g => g.sport === 'soccer' && g.status === 'scheduled');
    const fed = { ...real, updated: '2026-11-18T09:00:00Z', games: [...real.games.map(g => ({ ...g })),
      { ...g0, id: 'soccer-TST-PPD-2099-01-01', status: 'postponed', start: '2099-01-01T12:00:00Z', home: { abbr: 'TST', name: 'Test FC' }, away: { abbr: 'PPD', name: 'Postponed FC' } },
      { ...g0, id: 'soccer-STR-PRB-2099-01-01', start: '2099-01-01T12:00:00Z', comp: undefined, prob: { home: '0.5', draw: '0.3', away: '0.2' }, home: { abbr: 'STR', name: 'String Prob' }, away: { abbr: 'PRB', name: 'Prob Town' } },
      { ...g0, id: 'soccer-BAD-DAT-2099', start: 'TBD' }, { id: 'mlb-X-Y', sport: 'mlb', start: '2099-01-01T00:00:00Z', home: { abbr: 'X', name: 'X' }, away: { abbr: 'Y', name: 'Y' } }] };
    await page.route('**/data.json', r => mode === 'ok' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fed) })
      : mode === '404' ? r.fulfill({ status: 404, body: 'x' }) : mode === '503' ? r.fulfill({ status: 503, body: 'x' })
      : mode === 'trunc' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fed).slice(0, 5000) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 'x', games: 'oops' }) }));
    await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('soccer')));
    await page.goto(BASE); await page.waitForFunction(() => window.SB && SB.firstRender);
    const f0 = await page.evaluate(() => { const g = SB.gameById('soccer-STR-PRB-2099-01-01'), p = SB.gameById('soccer-TST-PPD-2099-01-01');
      SB.setSlip([]); const add = SB.toggleLeg(p.id, 'H');
      return { n: SB.DATA.games.length, upd: SB.DATA.updated, str: g && SB.p1(g, 'H'), comp: g && g.comp, bad: !!SB.gameById('soccer-BAD-DAT-2099') || !!SB.gameById('mlb-X-Y'), ppdPriced: SB.priced(p), add,
        txt: /NaN|undefined|Invalid Date/.test(document.getElementById('main').textContent) }; });
    check('feed: string probabilities coerced, missing comp filled, bad dates / unknown sports dropped', Math.abs(f0.str - .5) < 1e-9 && f0.comp === 'Soccer' && !f0.bad && !f0.txt, JSON.stringify(f0));
    check('feed: a postponed game is not priced and its legs cannot be added', !f0.ppdPriced && f0.add === false, JSON.stringify(f0));
    await page.evaluate(() => SB.setSlip(SB.DATA.games.filter(g => g.sport === 'soccer' && SB.priced(g)).slice(0, 2).map(g => ({ gid: g.id, key: 'H' }))));
    for (const m of ['404', '503', 'trunc', 'shape']) {
      mode = m; await page.evaluate(() => window.__fm2.refreshTick());
      const r = await page.evaluate(() => ({ n: SB.DATA.games.length, upd: SB.DATA.updated, legs: SB.slip.length }));
      check(`failed refresh (${m}) keeps the live feed and the slip`, r.n === f0.n && r.upd === f0.upd && r.legs === 2, JSON.stringify(r));
    }
    // a refresh that drops a slip game while the builder is open: the sheet follows, Save never stores a 0-leg "Won" parlay (qa-2)
    mode = 'ok';
    const gone = await page.evaluate(() => SB.slip[0].gid);
    fed.games = fed.games.filter(g => g.id !== gone);
    const z = await page.evaluate(async () => { SB.setSlip([SB.slip[0]]); SB.openSlip(); await window.__fm2.refreshTick();
      const open = document.getElementById('sheet').classList.contains('on');
      localStorage.setItem('fm2.saved', JSON.stringify([{ legs: [], p: .39, at: 1 }])); return { open, legs: SB.slip.length }; });
    check('refresh that removes the only slip game closes the stale builder', !z.open && z.legs === 0, JSON.stringify(z));
    await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender);
    const zl = await page.evaluate(() => { SB.goTab('mine'); return [...document.querySelectorAll('#main .pc .hit')].map(x => x.textContent).join(','); });
    check('a 0-leg saved parlay shows Void, never Won', zl === 'Void', zl);
    check('no page errors with odd feeds / failed refreshes', !errs.length, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---- My Parlays ledger (gaps-4): grades after the game leaves the feed, manual grading, ROI ----
  {
    const { ctx, page, errors } = await openPage({ tab: 'mine' });
    const lg = await page.evaluate(() => {
      const fin = SB.DATA.games.find(g => SB.isFinal(g) && g.score.home !== g.score.away), sh = fin.score.home, sa = fin.score.away;
      const winKey = sh > sa ? 'H' : sh < sa ? 'A' : 'D', loseKey = winKey === 'H' ? 'A' : 'H';
      const leg = (key, extra) => ({ gid: fin.id, key, label: key, sport: fin.sport, comp: fin.comp, home: fin.home.abbr, away: fin.away.abbr, start: fin.start, ...extra });
      localStorage.setItem('fm2.saved', JSON.stringify([
        { legs: [leg(winKey)], p: .5, dec: 2.5, stake: 10, at: 1 },
        { legs: [leg(loseKey)], p: .3, dec: 3, stake: 10, at: 2 },
        { legs: [leg('G:nobody-x')], p: .2, at: 3 }]));
      return { id: fin.id };
    });
    await page.reload(); await page.waitForFunction(() => window.SB && SB.firstRender);
    const l1 = await page.evaluate(() => ({ tags: [...document.querySelectorAll('#main .pc .hit')].map(x => x.textContent).join(','), txt: document.getElementById('main').textContent, res: JSON.parse(localStorage.getItem('fm2.saved'))[0].res }));
    check('ledger: saves final scores and shows Won / Lost, P/L and ROI', !!l1.res && /Won/.test(l1.tags) && /Lost/.test(l1.tags) && /\$5\.00/.test(l1.txt) && /\+25\.0%/.test(l1.txt), l1.txt.slice(0, 200));
    // the game drops out of the feed: the parlay still grades from the stored result
    await page.route('**/data.json', async r => { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8')); d.games = d.games.filter(g => g.id !== lg.id); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) }); });
    await page.evaluate(() => window.__fm2.refreshTick()); await page.evaluate(() => SB.goTab('mine'));
    const l2 = await page.evaluate(() => [...document.querySelectorAll('#main .pc .hit')].map(x => x.textContent).join(','));
    check('ledger: a parlay still grades after its game leaves the feed', /Won/.test(l2) && /Lost/.test(l2), l2);
    const l3 = await page.evaluate(() => { const b = document.querySelector('[data-grade$="|1"]'); if (!b) return 'no button'; b.click(); return document.getElementById('main').textContent + '||' + [...document.querySelectorAll('#main .pc .hit')].map(x => x.textContent).join(','); });
    check('ledger: a leg the engine cannot settle (scorer) can be graded by hand', /graded by you/.test(l3) && (l3.split('||')[1].match(/Won/g) || []).length === 2, String(l3).slice(-80));
    check('no console errors on the ledger', !errors.length, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---- boot: module tabs present while the feed is still loading, loading text shown (ux-15); 360px header (ux-14/16) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } }), page = await ctx.newPage();
    await page.route('**/*.json', async r => { await new Promise(x => setTimeout(x, 1500)); r.continue(); });
    await page.goto(BASE); await page.waitForFunction(() => window.SB && window.__soccer);
    const b0 = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('#tabs .tab')].map(b => b.dataset.t).join(','), main: document.getElementById('main').textContent }));
    await page.waitForFunction(() => SB.firstRender, null, { timeout: 30000 });
    const b1 = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('#tabs .tab')].map(b => b.dataset.t).join(','), sw: document.documentElement.scrollWidth,
      sizes: ['.search', '#oddsFmt', '.chip'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.height); }) }));
    check('boot: Soccer Parlays + Simulator tabs exist before the feed loads, with a loading message', /soccerparlays/.test(b0.tabs) && /sim/.test(b0.tabs) && /Loading/.test(b0.main) && b0.tabs === b1.tabs, JSON.stringify(b0));
    check('360px: no horizontal scroll, header controls and chips >= 40px', b1.sw <= 360 && b1.sizes.every(h => h >= 40), JSON.stringify(b1));
    await page.evaluate(() => { const g = SB.DATA.games.find(g => g.sport === 'soccer' && SB.priced(g)); SB.setSlip([{ gid: g.id, key: 'H' }, { gid: g.id, key: 'O1.5' }]); SB.openSlip(); });
    const tg = await page.evaluate(() => ['.star', '.x'].map(s => { const r = document.querySelector('#sheet ' + s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    check('slip ★ / ✕ tap targets >= 40px', tg.every(([w, h]) => w >= 40 && h >= 40), JSON.stringify(tg));
    await ctx.close();
  }

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
