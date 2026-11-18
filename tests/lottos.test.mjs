// Point Lottos + Injuries tests (lottos.js, injuries.json, nbaroles.json). Run: node tests/lottos.test.mjs
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
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
const STATUSES = ['out', 'doubtful', 'questionable', 'day-to-day', 'probable'];

// ---------- file-level ----------
const INJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'injuries.json'), 'utf8'));
const ROLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'nbaroles.json'), 'utf8'));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
{
  const bad = INJ.injuries.filter(e => !e.sport || !e.team || !e.player || !STATUSES.includes(e.status) || !e.source);
  const keys = INJ.injuries.map(e => `${e.sport}|${e.team}|${e.player}`);
  check('injuries.json: valid entries {sport, team, player, status, source}', !!INJ.updated && INJ.injuries.length > 50 && !bad.length, `${INJ.injuries.length} entries, ${bad.length} bad`);
  check('injuries.json: no duplicate player entries', new Set(keys).size === keys.length);
  check('injuries.json: unchecked teams listed as sport:TEAM', Array.isArray(INJ.unchecked) && INJ.unchecked.every(x => /^[a-z]+:[A-Z0-9]+$/.test(x)));
  const teams = Object.entries(ROLES.teams || {});
  const badP = teams.flatMap(([, ps]) => ps.filter(p => !p.name || !(p.ppg >= 0) || !(p.mpg > 0) || !(p.gp >= 0)));
  check('nbaroles.json: every team has a rotation with ppg/mpg/gp', teams.length >= 20 && teams.every(([, ps]) => ps.length >= 5) && !badP.length, `${teams.length} teams`);
}

const browser = await chromium.launch();
async function openPage({ tab = 'lottos', w = 390, h = 844, routes = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !(routes && routes.some(x => r.url().includes(x)))) errors.push(`${r.status()} ${r.url()}`); });
  if (routes) for (const f of routes) await page.route('**/' + f, r => r.fulfill({ status: 404, body: 'gone' }));
  await page.addInitScript(t => { localStorage.setItem('fm2.tab', JSON.stringify(t)); }, tab);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__lottos, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__lottos.LOAD === 'done', null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

try {
  // ---------- tabs + model math on the real data ----------
  const { ctx, page, errors } = await openPage();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(x => x.dataset.t));
  check('tabs: Point Lottos sits after Soccer Parlays, Injuries after College FB', tabs.indexOf('lottos') === tabs.indexOf('soccerparlays') + 1 && tabs.indexOf('injuries') === tabs.indexOf('ncaaf') + 1, tabs.join(','));

  const math = await page.evaluate(() => {
    const L = window.__lottos, out = { teams: 0, sumErr: 0, capBad: 0, noAbsentBoost: 0, injuredLeg: 0, starsBad: 0 };
    for (const abbr of Object.keys(L.ROLES.teams)) {
      const m = L.teamModel(abbr); out.teams++;
      const raw = m.elig.reduce((s, p) => s + p.rawBoost, 0);
      if (m.elig.length) out.sumErr = Math.max(out.sumErr, Math.abs(raw - L.R * m.absent));
      for (const p of m.elig) if (p.boost > Math.min(L.CAP_PCT * p.ppg, L.CAP_PTS) + 1e-9 || p.boost > p.rawBoost + 1e-9) out.capBad++;
      if (m.absent === 0 && m.elig.some(p => p.boost > 0)) out.noAbsentBoost++;
      if (m.elig.some(p => p.w > 0)) out.injuredLeg++;
      if (m.players.filter(p => p.star).length > 2) out.starsBad++;
    }
    return out;
  });
  check('boost: redistributed points sum to R x absent points before caps (every team)', math.sumErr < 1e-9, JSON.stringify(math));
  check('boost: caps hold (40% of ppg, 9 pts) and never exceed the raw share', math.capBad === 0);
  check('boost: no boost when nobody is out', math.noAbsentBoost === 0);
  check('boost: injured players are never eligible for legs; at most 2 stars per team', math.injuredLeg === 0 && math.starsBad === 0);

  const P = await page.evaluate(() => {
    const L = window.__lottos; const res = {};
    for (const win of ['24h', '3d']) {
      const { games, C } = L.candidates(win);
      res[win] = { games: games.length, cands: C.length, firstBoosted: C.length ? C[0].p.boost : 0, firstStar: C.length ? C[0].p.star : null,
        tiers: L.TIERS.map(t => L.buildTier(C, t).map(P => ({ n: P.legs.length, want: t.n, p: P.p, prod: P.legs.reduce((s, l) => s * l.line.p, 1),
          games: new Set(P.legs.map(l => l.g.id)).size, teams: new Set(P.legs.map(l => l.p.team)).size, stars: P.legs.filter(l => l.p.star).length,
          band: P.legs.every(l => l.line.p >= L.LEG_MIN - 1e-12 && l.line.p <= L.LEG_MAX + 1e-12),
          ids: P.legs.map(l => l.p.team + ':' + l.p.slug) }))) };
    }
    return res;
  });
  const win = P['24h'].games ? '24h' : '3d';
  const all = P[win].tiers.flat();
  check(`lottos (${win}): NBA games in window and tier parlays built`, P[win].games > 0 ? all.length > 0 : true, `${P[win].games} games, ${all.length} parlays`);
  check('lottos: parlay hit % = product of its legs', all.every(x => Math.abs(x.p - x.prod) < 1e-12));
  check('lottos: right leg count per tier, different games and teams, at most one star', all.every(x => x.n === x.want && x.games === x.n && x.teams === x.n && x.stars <= 1));
  check('lottos: every leg inside the 12-45% band', all.every(x => x.band));
  check('lottos: no player twice within a tier', P[win].tiers.every(T => { const ids = T.flatMap(x => x.ids); return new Set(ids).size === ids.length; }));
  check('lottos: boosted role players rank first ("other players")', !P[win].cands || (P[win].firstBoosted >= 0.5 ? P[win].firstStar === false : true), JSON.stringify({ b: P[win].firstBoosted, s: P[win].firstStar }));

  if (win === '3d') { await page.click('[data-lt-win="3d"]'); await page.waitForTimeout(200); }
  const ui = await page.evaluate(() => ({ h2: [...document.querySelectorAll('#main h2')].map(h => h.textContent), cards: document.querySelectorAll('#main .lt-card').length,
    sw: document.documentElement.scrollWidth, iw: innerWidth, foot: (document.querySelector('#main .lt-foot') || {}).textContent || '' }));
  check('lottos tab: three tiers + boosted board render', ['Small lotto', 'Big lotto', 'Moonshot', 'Boosted players'].every(t => ui.h2.some(h => h.startsWith(t))) && ui.cards > 0, `${ui.cards} cards`);
  check('lottos tab: labelled as model estimates, 21+', /model estimates/.test(ui.foot) && /21\+/.test(ui.foot));
  check('lottos tab: honest copy (no lock / guaranteed / sure win)', !(await page.evaluate(() => /\block\b|\bguaranteed\b|sure win/i.test(document.querySelector('#main').textContent))));

  // build: Open in builder puts L: legs in the slip with matching labels and chances
  if (ui.cards) {
    await page.click('#main [data-lt-build]');
    await page.waitForTimeout(300);
    const slip = await page.evaluate(() => SB.slip.map(l => ({ key: l.key, label: l.label, p: SB.p1(SB.gameById(l.gid), l.key) })));
    const card = await page.evaluate(() => [...document.querySelectorAll('#main .lt-card')][0].querySelectorAll('.leg').length);
    check('builder: Open in builder loads every lotto leg into the slip', slip.length === card && slip.every(l => /^L:[A-Z0-9]+-[a-z0-9-]+:\d+$/.test(l.key)), JSON.stringify(slip));
    check('builder: leg labels read "<Name> <N>+ points" with a live chance', slip.every(l => / \d+\+ points$/.test(l.label) && l.p > 0.1 && l.p < 0.5));
    await page.keyboard.press('Escape');
    await page.evaluate(() => SB.setSlip([]));
    // a boosted-player line chip toggles into the slip
    await page.evaluate(() => SB.goTab('lottos'));
    await page.waitForTimeout(200);
    const chip = await page.$('#main [data-lt-leg]');
    if (chip) { await chip.click(); await page.waitForTimeout(150);
      const n = await page.evaluate(() => SB.slip.filter(l => l.key.startsWith('L:')).length);
      check('boosted board: tapping a line adds it to the slip', n === 1); }
    await page.evaluate(() => SB.setSlip([]));
    // Simulate 100k hands the legs to the simulator tab
    const simBtn = await page.$('#main [data-lt-sim]');
    if (simBtn) { await simBtn.click(); await page.waitForTimeout(500);
      const t = await page.evaluate(() => (document.querySelector('#tabs [aria-current="page"]') || {}).dataset?.t);
      check('Simulate 100k opens the simulator with the lotto', t === 'sim', t); }
  }

  // injuries tab
  await page.evaluate(() => SB.goTab('injuries'));
  await page.waitForTimeout(300);
  const inj = await page.evaluate(() => ({ games: document.querySelectorAll('#main .lt-game').length, st: [...document.querySelectorAll('#main .lt-st')].map(x => x.textContent),
    chips: [...document.querySelectorAll('#main [data-inj-sp]')].map(x => x.dataset.injSp), notChecked: /Report not checked yet/.test(document.querySelector('#main').textContent) }));
  check('injuries tab: games with status badges and sport chips', inj.games > 0 && inj.st.length > 0 && ['all', 'nba', 'nfl', 'nhl', 'ncaaf', 'soccer'].every(s => inj.chips.includes(s)), `${inj.games} games, ${inj.st.length} players`);
  check('injuries tab: only the five statuses are shown', inj.st.every(s => ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'DAY-TO-DAY', 'PROBABLE'].includes(s)));
  await page.click('[data-inj-sp="nba"]'); await page.waitForTimeout(200);
  const nba = await page.evaluate(() => ({ lg: [...document.querySelectorAll('#main .lt-game .lg')].map(x => x.textContent), gains: document.querySelectorAll('#main .lt-gain').length }));
  check('injuries tab: NBA filter shows only NBA games, with "Who gains"', nba.lg.length > 0 && nba.lg.every(t => t.startsWith('NBA')) && nba.gains > 0, `${nba.lg.length} games, ${nba.gains} gainers`);
  await page.evaluate(() => { const b = document.querySelector('[data-inj-sp="all"]'); b && b.click(); });

  // 360 wide: no sideways scroll on either tab
  await page.setViewportSize({ width: 360, height: 740 });
  for (const t of ['lottos', 'injuries']) { await page.evaluate(k => SB.goTab(k), t); await page.waitForTimeout(250);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`360px: no horizontal scroll on ${t}`, sw <= 0, String(sw)); }
  check('no console errors on the lotto and injury tabs', errors.length === 0, errors.slice(0, 4).join(' | '));
  await ctx.close();

  // ---------- synthetic team: exact formula ----------
  const g = DATA.games.find(x => x.sport === 'nba' && x.status === 'scheduled' && Date.parse(x.start) > Date.now());
  if (g) {
    const T = g.home.abbr;
    const roster = [{ name: 'Star Out', gp: 10, mpg: 36, ppg: 30 }, { name: 'Half Season', gp: 5, mpg: 30, ppg: 20 }, { name: 'Role One', gp: 10, mpg: 30, ppg: 12 },
      { name: 'Role Two', gp: 10, mpg: 20, ppg: 8 }, { name: 'Bench Guy', gp: 10, mpg: 10, ppg: 4 }, { name: 'Big Three', gp: 10, mpg: 34, ppg: 22 }];
    const inj = [{ sport: 'nba', team: T, player: 'Star Out', status: 'out', source: 't' }, { sport: 'nba', team: T, player: 'Half Season', status: 'questionable', source: 't' }];
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p2 = await ctx2.newPage();
    await p2.route('**/nbaroles.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 'x', teams: { [T]: roster } }) }));
    await p2.route('**/injuries.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: '2026-11-18T00:00:00Z', injuries: inj }) }));
    await p2.goto(BASE); await p2.waitForFunction(() => window.__lottos && window.SB && SB.firstRender);
    await p2.evaluate(() => window.__lottos.load(true)); await p2.waitForFunction(() => window.__lottos.LOAD === 'done');
    const m = await p2.evaluate(t => { const m = window.__lottos.teamModel(t); return { absent: m.absent, b: Object.fromEntries(m.players.map(p => [p.name, +p.boost.toFixed(6)])), stars: m.players.filter(p => p.star).map(p => p.name) }; }, T);
    // absent = 30*1*(10/10) + 20*.4*(5/10) = 34; eligible: Role One (12x30=360), Role Two (8x20=160), Big Three (22x34=748); Bench (mpg 10) out
    const A = 34, tot = 360 + 160 + 748, exp = { 'Role One': Math.min(.65 * A * 360 / tot, .4 * 12, 9), 'Role Two': Math.min(.65 * A * 160 / tot, .4 * 8, 9), 'Big Three': Math.min(.65 * A * 748 / tot, .4 * 22, 9) };
    check('formula: absent points use status weight and games-played share', Math.abs(m.absent - A) < 1e-9, String(m.absent));
    check('formula: boosts split by ppg x mpg with caps; bench and injured get none', Object.entries(exp).every(([k, v]) => Math.abs(m.b[k] - v) < 1e-5) && m.b['Bench Guy'] === 0 && m.b['Star Out'] === 0, JSON.stringify(m.b));
    check('formula: stars are the two leading scorers still playing', m.stars.length === 2 && m.stars.includes('Big Three') && m.stars.includes('Role One'), m.stars.join(','));
    await ctx2.close();
  }

  // ---------- missing files: honest empty states, no page errors ----------
  const miss = await openPage({ tab: 'injuries', routes: ['injuries.json', 'nbaroles.json'] });
  const t1 = await miss.page.evaluate(() => document.querySelector('#main').textContent);
  await miss.page.evaluate(() => SB.goTab('lottos')); await miss.page.waitForTimeout(250);
  const t2 = await miss.page.evaluate(() => document.querySelector('#main').textContent);
  check('missing injuries.json: Injuries tab says the list is unavailable', /Injury list unavailable/.test(t1));
  check('missing files: Point Lottos still renders honestly (props fallback or empty state)', /did not load|missing|No NBA games|Small lotto/.test(t2));
  check('missing files: no page errors', !miss.errors.some(e => e.startsWith('pageerror')), miss.errors.slice(0, 3).join(' | '));
  await miss.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
