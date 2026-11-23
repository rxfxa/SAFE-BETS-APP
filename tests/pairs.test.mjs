// Legs that help each other: the research (pairs.json, tools/leg_pairs.py) measured on this season's box scores, the NFL /
// college yards legs (nflplayers.json), joint pricing of linked legs (exact for two, simulated for more, and the 500,000-run
// sim agreeing), the builders pairing legs that help each other and keeping apart legs that work against each other, the
// research-based swap reasons and slip tips, and the "Legs that help each other" section. Fixtures, fixed clock.
// Run: node tests/pairs.test.mjs
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
const FX = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
const PJ = JSON.parse(FX('pairs-2026-11-23.json'));
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-23T12:00:00Z'));
const pin = { 'data.json': 'data-2026-11-23.json', 'pairs.json': 'pairs-2026-11-23.json', 'nflplayers.json': 'nflplayers-2026-11-23.json', 'firsttd.json': 'firsttd-2026-11-23.json',
  'injuries.json': 'injuries-2026-11-23.json', 'playerform.json': 'playerform-2026-11-23b.json', 'nbalast4.json': 'nbalast4-2026-11-23b.json' };
await page.route(/\/(data|pairs|nflplayers|firsttd|injuries|playerform|nbalast4)\.json(\?.*)?$/, r => { const f = new URL(r.request().url()).pathname.split('/').pop(); r.fulfill({ status: 200, contentType: 'application/json', body: FX(pin[f]) }); });
await page.route('**/mypicks.json', r => r.fulfill({ status: 404, body: 'nf' }));
await page.route('**/recs.json', r => r.fulfill({ status: 404, body: 'nf' }));
try {
  // ---------- the research file ----------
  const all = Object.entries(PJ.sports).flatMap(([sp, S]) => Object.entries(S.pairs).map(([k, r]) => ({ sp, k, ...r })));
  check('research: every pair has n, a correlation with its range, lift, and "reliable" only when the range excludes 0 with 150+ games', all.length >= 30 && all.every(r => r.n >= 60 && r.lo <= r.rho + 1e-9 && r.rho <= r.hi + 1e-9 && r.reliable === ((r.lo > 0 || r.hi < 0) && r.n >= 150)), `${all.length} pairs`);
  const td = PJ.sports.nfl.pairs['RB|td|ryd'];
  check('research: an NFL back\'s touchdown and rushing yards go together (reliable, positive)', td && td.reliable && td.rho > .2 && td.pBgivenA > td.pB, JSON.stringify(td && { rho: td.rho, pBA: td.pBgivenA, pB: td.pB, n: td.n }));
  check('research: covers NFL, college, NBA, NHL and soccer, with the yards spread model', ['nfl', 'ncaaf', 'nba', 'nhl', 'soccer'].every(s => PJ.sports[s] && Object.keys(PJ.sports[s].pairs).length) && PJ.sports.nfl.sd && PJ.sports.nfl.sd.ryd && PJ.sports.nfl.sd.ryd.b > 0);

  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2 && window.__firsttd && __firsttd.FT, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  // ---------- yards legs ----------
  const Y = await page.evaluate(() => { const D = __fm2.DATA, ys = D.players.filter(p => ['ryd', 'recyd', 'pyd'].includes(p.stat));
    const by = s => ys.filter(p => p.stat === s);
    return { n: ys.length, ryd: by('ryd').length, recyd: by('recyd').length, pyd: by('pyd').length, posOk: by('pyd').every(p => p.pos === 'QB') && by('ryd').every(p => p.pos === 'RB' || p.pos === 'QB'),
      sane: ys.every(p => p.avg >= 20 && p.sd >= 6 && p.sd < p.avg * 1.5 + 30), mono: ys.slice(0, 40).every(p => { const L = __fm2.subCands ? [20, 40, 60].map(t => SB.p1(null, `P:${p.id}:${t}`)) : []; return L[0] >= L[1] && L[1] >= L[2]; }) }; });
  check('NFL / college yards legs: rushing (backs, running QBs), receiving, passing (QBs only), with sensible spreads; higher lines less likely', Y.ryd > 20 && Y.recyd > 50 && Y.pyd > 10 && Y.posOk && Y.sane && Y.mono, JSON.stringify(Y));
  // ---------- the link engine ----------
  const E = await page.evaluate(() => { const F = __fm2, D = F.DATA;
    const g = D.games.find(x => x.sport === 'nfl' && x.status !== 'closed' && D.players.some(p => p.gid === x.id && p.stat === 'ryd' && p.pos === 'RB'));
    const rb = D.players.filter(p => p.gid === g.id && p.stat === 'ryd' && p.pos === 'RB').sort((a, b) => b.avg - a.avg)[0];
    const tdKey = `TD:A:${rb.team}:${rb.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '-')}`;
    const A = { gid: g.id, key: tdKey }, B = { gid: g.id, key: `P:${rb.id}:40` };
    const pa = SB.p1(g, A.key), pb = SB.p1(g, B.key), r = F.legRho(F.legMeta(A), F.legMeta(B), g.id), joint = F.parlayProb([A, B]).p;
    const exact = F.bvnP(invz(pa), invz(pb), r ? r.r : 0);
    function invz(p) { let lo = -9, hi = 9; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (.5 * (1 + erf(m / Math.SQRT2)) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
    function erf(x) { const t = 1 / (1 + .3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
    // the other team's win flips a player's link with the win; an under flips it too
    const opp = rb.team === g.home.abbr ? 'A' : 'H', own = opp === 'H' ? 'A' : 'H';
    const rw = F.legRho(F.legMeta(B), F.legMeta({ gid: g.id, key: own }), g.id), ro = F.legRho(F.legMeta(B), F.legMeta({ gid: g.id, key: opp }), g.id);
    const U = { gid: g.id, key: `U:${rb.id}:39.5` }, ru = F.legRho(F.legMeta(A), F.legMeta(U), g.id);
    // two NBA teammates' points: the research found no reliable link, so they multiply
    const nb = D.games.find(x => x.sport === 'nba' && D.players.filter(p => p.gid === x.id && p.stat === 'pts').length >= 4);
    let nbaInd = null; if (nb) { const pts = D.players.filter(p => p.gid === nb.id && p.stat === 'pts' && p.team === nb.home.abbr).sort((a, b) => b.avg - a.avg).slice(0, 2);
      const L = pts.map(p => ({ gid: nb.id, key: `P:${p.id}:10` })), pp = F.parlayProb(L); nbaInd = { p: pp.p, indep: pp.indep, rho: F.legRho(F.legMeta(L[0]), F.legMeta(L[1]), nb.id) }; }
    // three linked legs: a seeded simulation; with no links it is the exact product
    const three = F.jointP([.6, .7, .5], [[1, .4, .3], [.4, 1, .2], [.3, .2, 1]]), indep3 = F.jointP([.6, .7, .5], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const S = F.simJoint([A, B], 200000);
    return { name: rb.name, pa, pb, r: r && r.r, joint, exact, prod: pa * pb, rw: rw && rw.r, ro: ro && ro.r, ru: ru && ru.r, nbaInd, three, indep3, sim: { rate: S.rate, lo: S.lo, hi: S.hi } };
  });
  check('a back\'s anytime TD + his rushing yards: linked by the research figure, priced together above the plain product', E.r > .2 && E.pa > .05 && E.pb > .05 && E.joint > E.prod * 1.02 && Math.abs(E.joint - E.exact) < 2e-4, JSON.stringify({ name: E.name, pa: E.pa, pb: E.pb, r: E.r, joint: E.joint, prod: E.prod }));
  check('the 500,000-run sim draws the same link (200,000 here): it agrees with the joint price', E.joint >= E.sim.lo - .004 && E.joint <= E.sim.hi + .004, JSON.stringify({ joint: E.joint, sim: E.sim }));
  check('the opponent\'s win and an under flip the link\'s sign', E.rw > 0 && E.ro < 0 && Math.abs(E.rw + E.ro) < 1e-9 && E.ru < 0, JSON.stringify({ own: E.rw, opp: E.ro, under: E.ru }));
  check('unmeasured / unreliable links (two NBA teammates\' points) stay independent', !E.nbaInd || (!E.nbaInd.rho && Math.abs(E.nbaInd.p - E.nbaInd.indep) < 1e-12), JSON.stringify(E.nbaInd));
  check('three linked legs: a seeded simulation above the product; no links = the exact product', E.three > .6 * .7 * .5 && Math.abs(E.indep3 - .21) < 1e-12, JSON.stringify({ three: E.three, indep3: E.indep3 }));

  // ---------- builders ----------
  const SG = await page.evaluate(() => { const F = __fm2, D = F.DATA, out = [];
    for (const g of D.games.filter(x => (x.sport === 'nfl' || x.sport === 'nba') && x.status !== 'closed' && Date.parse(x.start) > Date.now()).slice(0, 8)) {
      const T = F.sgpTicketFor ? F.sgpTicketFor(g) : null; if (!T) continue;
      let pos = 0, neg = 0; for (let i = 0; i < T.legs.length; i++) for (let j = i + 1; j < T.legs.length; j++) { const r = F.legRho(F.legMeta(T.legs[i]), F.legMeta(T.legs[j]), g.id); if (r && r.r >= .15) pos++; if (r && r.r <= -.15) neg++; }
      out.push({ g: g.id, n: T.legs.length, pos, neg });
    }
    return out; });
  check('same game parlays pair legs that help each other, and never two that work against each other', SG.length > 0 && SG.some(x => x.pos > 0) && SG.every(x => x.neg === 0), JSON.stringify(SG));
  // swaps: a linked option says so
  const SW = await page.evaluate(() => { const F = __fm2, D = F.DATA;
    const g = D.games.find(x => x.sport === 'nfl' && x.status !== 'closed' && Date.parse(x.start) > Date.now() && D.players.some(p => p.gid === x.id && p.stat === 'recyd'));
    const wr = D.players.filter(p => p.gid === g.id && p.stat === 'rec').sort((a, b) => b.avg - a.avg)[0];
    const other = D.players.filter(p => p.gid === g.id && p.stat === 'pts' || (p.gid === g.id && p.stat === 'ryd'))[0];
    const legs = [{ gid: g.id, key: `P:${wr.id}:3`, label: `${wr.name} 3+ receptions`, p: SB.p1(g, `P:${wr.id}:3`) }, { gid: g.id, key: `P:${other.id}:20`, label: other.name, p: SB.p1(g, `P:${other.id}:20`) }];
    const C = F.subCands(legs, 1, 'test-pairs');
    return { name: wr.name, whys: C.map(c => (c.why || []).join(' · ')) }; });
  check('swap reasons say when an option helps (or works against) a leg already on the card, from the research', SW.whys.some(w => /helps .+: .+link \+0\.\d\d over [\d,]+ games this season/.test(w)), JSON.stringify(SW.whys.slice(0, 4)));

  // ---------- the section ----------
  await page.evaluate(() => SB.goTab('fantasy'));
  await page.waitForFunction(() => /Legs that help each other/.test(document.querySelector('#main').textContent), null, { timeout: 30000 });
  const txt = await page.textContent('#main');
  const G = await page.evaluate(() => __fm2.helpGroups(__fm2.helpPairs()).map(x => ({ k: x.k, n: x.xs.length, lift: x.xs.map(y => y.pj / y.pi) })));
  check('the Fantasy tab shows "Legs that help each other": kinds of pairs, touchdown pairs first, each priced together vs unrelated', G.length >= 3 && /touchdown/i.test(G[0].k) && G.every(x => x.lift.every(l => l > 1)) && /together \d+% \(\d+% if unrelated\)/.test(txt), JSON.stringify(G.slice(0, 4)));
  check('it shows what the research measured (when the first landed, the second did X% vs Y%)', /when the first landed, the second did \d+% of the time vs \d+% overall/.test(txt));
  const before = await page.evaluate(() => __fm2.slip.length);
  const btn = page.locator('[data-addpair]').first(), ab = await btn.getAttribute('data-addpair');
  await btn.click();
  const after = await page.evaluate(k => { const [gid, a, b] = k.split('|'); return { n: __fm2.slip.length, both: [a, b].every(x => __fm2.slip.some(L => L.gid === gid && L.key === x)) }; }, ab);
  check('"Add both" puts both legs of a pair in the slip', after.both && after.n === before + 2, JSON.stringify(after));
  const tips = await page.evaluate(() => { SB.openSlip && SB.openSlip(); return document.body.textContent; });
  check('the slip names the legs that help each other', /Legs that help each other:/.test(tips));
  const P4 = await page.evaluate(() => __fm2.autoCache.pairs ? __fm2.autoCache.pairs.legs.length : 0);
  check('a paired parlay card (pairs from different games) with the 500,000-run button', P4 >= 4 && (await page.locator('[data-sim5="pairs"]').count()) === 1, String(P4));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll', over <= 0, `${over}px`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
