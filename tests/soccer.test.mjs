// Soccer Parlays tests (soccer.js + scorers.json). Run: node tests/soccer.test.mjs
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
// another engineer's module may not exist yet: only its 404 is tolerated. NO_SIM=1 blocks sim.js to test this module alone.
const NO_SIM = !!process.env.NO_SIM;
const OPTIONAL = NO_SIM || !fs.existsSync(path.join(ROOT, 'sim.js')) ? /\/sim\.js$/ : null;
const SWITCH_BUDGET_MS = 300;
const LEAGUE_ORDER = [['ucl', 'Champions League'], ['epl', 'Premier League'], ['laliga', 'La Liga'], ['seriea', 'Serie A'], ['bundesliga', 'Bundesliga'],
  ['ligue1', 'Ligue 1'], ['uel', 'Europa League'], ['eredivisie', 'Eredivisie'], ['primeira', 'Primeira Liga'], ['mls', 'MLS']];
const SECTIONS = ['overs', 'unders', 'exact', 'scorers', 'btts', 'results', 'mega'];

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

// scorers.json shape (file-level, no browser)
try {
  const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'scorers.json'), 'utf8'));
  const ids = new Set(); let dup = 0, bad = 0;
  for (const t of sc.teams) { if (!t.team || !t.abbr || !Array.isArray(t.comp) || !Array.isArray(t.players)) bad++;
    for (const p of t.players) { if (ids.has(p.id)) dup++; ids.add(p.id); if (!['active', 'doubtful', 'out'].includes(p.status)) bad++; } }
  const names = sc.teams.map(t => t.team.toLowerCase());
  check('scorers.json: valid shape {updated, season, teams, sources}', !!sc.updated && sc.season === '2026-27' && sc.teams.length > 100 && Array.isArray(sc.sources) && !bad, `${sc.teams.length} teams, ${ids.size} players`);
  check('scorers.json: unique player ids and team names', dup === 0 && new Set(names).size === names.length);
} catch (e) { check('scorers.json parses', false, e.message); }

const browser = await chromium.launch();
async function openPage({ tab = 'soccerparlays', socp = null, w = 390, h = 844, theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !(OPTIONAL && OPTIONAL.test(m.location().url || ''))) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  if (NO_SIM) await page.route('**/sim.js', r => r.fulfill({ status: 404, body: '' }));
  await page.addInitScript(([t, s, th]) => { localStorage.setItem('fm2.tab', JSON.stringify(t)); localStorage.setItem('fm2.theme', JSON.stringify(th)); if (s) localStorage.setItem('fm2.socp', JSON.stringify(s)); }, [tab, socp, theme]);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__soccer, null, { timeout: 30000 });
  await page.waitForTimeout(50);
  return { ctx, page, errors };
}

try {
  const { ctx, page, errors } = await openPage({ socp: { lg: 'all', sec: 'best' } });

  // ---------- tab ----------
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map(b => [b.dataset.t, b.textContent.trim()]));
  const ti = tabs.findIndex(t => t[0] === 'soccerparlays');
  check('tab "⚽ Soccer Parlays" exists right after Trending', ti === 1 && tabs[0][0] === 'trending' && tabs[ti][1] === '⚽ Soccer Parlays', tabs.map(t => t[0]).join(','));
  check('tab is active and rendered', await page.evaluate(() => !!document.querySelector('#tabs .tab.on[data-t="soccerparlays"]') && !!document.querySelector('#main .spnav')));

  // ---------- league chips ----------
  const chips = await page.evaluate(() => [...document.querySelectorAll('#main .spnav:not(.spsecs) [data-sp-lg]')].map(b => ({ id: b.dataset.spLg, text: b.firstChild.textContent.trim(), n: +b.querySelector('.n').textContent })));
  check('"All leagues" chip first', chips[0] && chips[0].id === 'all');
  const top = chips.slice(1, 11);
  check('all 10 top league chips render in order', top.length === 10 && LEAGUE_ORDER.every(([id, name], i) => top[i].id === id && top[i].text === name), top.map(c => c.text).join(' | '));
  const counts = await page.evaluate(() => { const c = {}; for (const g of SB.DATA.games) if (g.sport === 'soccer' && SB.openG(g)) { const id = __soccer.leagueOf(g.comp).id; c[id] = (c[id] || 0) + 1; } return c; });
  check('chip fixture counts match the feed', chips.slice(1).every(c => c.n === (counts[c.id] || 0)), JSON.stringify(counts));
  const more = chips.slice(11);
  check('other comps in the feed appear under "More"', Object.keys(counts).filter(k => k.startsWith('x-')).every(k => more.some(c => c.id === k)) && await page.evaluate(() => !!document.querySelector('#main .spnav .more')), more.map(c => c.text).join(','));
  check('comp alias map', await page.evaluate(() => ['UEFA Champions League', 'LaLiga', "Ligue 1 McDonald's", 'Liga Portugal Betclic', 'UEFA Europa League', 'Major League Soccer', 'Serie A Enilive'].map(c => __soccer.leagueOf(c).id).join(',')) === 'ucl,laliga,ligue1,primeira,uel,mls,seriea');

  // ---------- all leagues view ----------
  const best = await page.evaluate(() => ({ cards: document.querySelectorAll('#main .spcard').length, empty: document.querySelectorAll('#main .sp-empty').length }));
  check('All leagues view: best parlay of each of the 7 types', best.cards + best.empty === 7 && best.cards >= 5, JSON.stringify(best));

  // ---------- every league x section ----------
  const allCards = [];
  let worstSwitch = 0, missing = [], wide = [];
  for (const c of chips.slice(1)) {
    const t = await page.evaluate(id => { const t0 = performance.now(); document.querySelector(`[data-sp-lg="${id}"]`).click(); return performance.now() - t0; }, c.id);
    worstSwitch = Math.max(worstSwitch, t);
    if (!c.n) {
      const txt = await page.evaluate(() => (document.querySelector('#main .sp-empty') || {}).textContent || '');
      check(`${c.text}: honest empty state`, /No fixtures in the feed yet; they appear automatically when the hourly refresh adds them/.test(txt));
      continue;
    }
    for (const s of SECTIONS) {
      const r = await page.evaluate(s => {
        document.querySelector(`[data-sp-sec="${s}"]`).click();
        const cards = [...document.querySelectorAll('#main .spcard')].map(el => ({ id: el.dataset.spCard, p: +el.dataset.spP, legs: JSON.parse(el.dataset.spLegs), title: el.querySelector('.pctitle').textContent, hit: el.querySelector('.hit').textContent, lottery: !!el.querySelector('.pctitle .badge') }));
        return { cards, empty: document.querySelectorAll('#main .sp-empty').length, boards: document.querySelectorAll('#main .spboard').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      }, s);
      if (!(r.cards.length || r.empty)) missing.push(`${c.id}/${s}`);
      if (r.boards !== c.n) missing.push(`${c.id}/${s} boards ${r.boards}/${c.n}`);
      if (r.sw > r.cw) wide.push(`${c.id}/${s}`);
      for (const x of r.cards) allCards.push({ ...x, lg: c.id, sec: s });
    }
  }
  check('every league with fixtures: every section shows a parlay card or an honest empty state, plus one board per fixture', !missing.length, missing.join(', '));
  check('no horizontal page scroll at 390px in any league/section', !wide.length, wide.join(', '));
  check(`league switch under ${SWITCH_BUDGET_MS} ms`, worstSwitch < SWITCH_BUDGET_MS, worstSwitch.toFixed(1) + ' ms worst');
  check('parlay cards were built', allCards.length >= 60, allCards.length + ' cards');

  // exactness + rules on every card
  const v = await page.evaluate(cards => {
    const bad = [], WIN = 7 * 864e5;
    for (const c of cards) {
      const pr = SB.parlayProb(c.legs).p;
      if (Math.abs(pr - c.p) > 1e-12) bad.push(`${c.id} p ${c.p} vs ${pr}`);
      const shown = parseFloat(c.hit), want = +(pr * 100).toFixed(pr < .1 ? 1 : 0);
      if (Math.abs(shown - want) > 1e-9) bad.push(`${c.id} shows ${c.hit} want ${want}`);
      const gids = c.legs.map(L => L.gid), sgp = /same game/i.test(c.title);
      if (!sgp && new Set(gids).size !== gids.length) bad.push(`${c.id} two legs from one match`);
      if (sgp && new Set(gids).size !== 1) bad.push(`${c.id} same-game combo spans matches`);
      if (c.legs.length < 2) bad.push(`${c.id} has ${c.legs.length} leg`);
      for (const L of c.legs) { const g = SB.gameById(L.gid); if (!g || g.sport !== 'soccer' || !SB.priced(g) || SB.startMs(g) - Date.now() > WIN) bad.push(`${c.id} leg ${L.gid} not an upcoming fixture within 7 days`);
        if (c.lg !== 'all' && __soccer.leagueOf(g.comp).id !== c.lg) bad.push(`${c.id} leg from another league`); }
      if (c.sec === 'exact' && (!c.lottery || !c.legs.every(L => /^CS\d-\d$/.test(L.key)))) bad.push(`${c.id} exact-score card not labelled lottery-style / wrong keys`);
      if (c.sec === 'scorers' && !c.legs.some(L => L.key.startsWith('G:'))) bad.push(`${c.id} scorer card without a scorer leg`);
    }
    return bad;
  }, allCards);
  check('card hit chances equal SB.parlayProb of their legs (and the shown %)', !v.some(x => / p | shows /.test(x)), v.filter(x => / p | shows /.test(x)).slice(0, 5).join('; '));
  check('selection rules: one leg per match (except same-game combos), upcoming within 7 days, right league/section', !v.some(x => !/ p | shows /.test(x)), v.filter(x => !/ p | shows /.test(x)).slice(0, 5).join('; '));
  // deterministic
  const again = await page.evaluate(() => __soccer.sectionParlays('epl', 'mega').map(P => P.legs.map(L => L.key + '@' + L.gid).join(',')).join(' / '));
  const again2 = await page.evaluate(() => { __soccer.render(); return __soccer.sectionParlays('epl', 'mega').map(P => P.legs.map(L => L.key + '@' + L.gid).join(',')).join(' / '); });
  check('parlay selection is deterministic', again === again2 && again.length > 0);

  // ---------- goalscorer model ----------
  const gs = await page.evaluate(() => {
    const out = { n: 0, bad: [], pairs: 0, condBad: [], uncondBad: [], win: [], unmatched: [], firstBad: [], doubtfulInCard: false };
    const ie = __soccer.ieTable;
    for (const g of SB.DATA.games.filter(g => g.sport === 'soccer' && SB.priced(g))) {
      const R = __soccer.model(g.id);
      for (const s of ['home', 'away']) if (!R[s].team) out.unmatched.push(g[s].name);
      let fsum = 0;
      for (const s of ['home', 'away']) for (const x of R[s].players) {
        const p = SB.p1(g, 'G:' + x.id), f = SB.p1(g, 'G:1st:' + x.id); out.n++;
        if (!(p > 0 && p < 1)) out.bad.push(`${x.id} ${p}`);
        if (!(f > 0 && f < p)) out.firstBad.push(`${x.id} first ${f} anytime ${p}`);
        if (Math.abs(SB.probOf(g, ['G:' + x.id]) - p) > 1e-12) out.bad.push(`${x.id} prob != grid sum`);
        fsum += f;
      }
      if (fsum > 1 - SB.p1(g, 'CS0-0') + 1e-12) out.firstBad.push(`${g.id} first-scorer chances add to ${fsum}`);
      for (const s of ['home', 'away']) {
        const ps = R[s].players.filter(x => !x.priorOnly); if (ps.length < 2) continue;
        const [a, b] = ps, ka = 'G:' + a.id, kb = 'G:' + b.id; out.pairs++;
        // given the team scores k goals, teammates compete for the same goals: P(both|k) < P(a|k)·P(b|k)
        const both = ie([a.e, b.e], 10);
        for (let k = 1; k <= 10; k++) { const pa = 1 - Math.pow(1 - a.e, k), pb = 1 - Math.pow(1 - b.e, k); if (!(both[k] < pa * pb)) out.condBad.push(`${a.id}+${b.id} k=${k}`); }
        // unconditionally the grid's team goals are Poisson, so (thinning) the joint is the product of singles, never above it
        const j = SB.probOf(g, [ka, kb]), pr = SB.p1(g, ka) * SB.p1(g, kb);
        if (!(j <= pr * (1 + 1e-9) && j >= pr * (1 - 2e-3))) out.uncondBad.push(`${a.id}+${b.id} joint ${j} product ${pr}`);
        // scorer + his team winning: strongly positive
        const kw = s === 'home' ? 'H' : 'A', jw = SB.probOf(g, [ka, kw]);
        if (!(jw > SB.p1(g, ka) * SB.p1(g, kw))) out.win.push(`${a.id} + ${kw}`);
        if (!(Math.abs(SB.parlayProb([{ gid: g.id, key: ka }, { gid: g.id, key: kw }]).p - jw) < 1e-12)) out.win.push(`${a.id} parlayProb != probOf`);
      }
    }
    // same player anytime + first: first implies anytime
    const g0 = SB.DATA.games.find(g => g.sport === 'soccer' && SB.priced(g) && __soccer.model(g.id).home.players.length);
    const x0 = __soccer.model(g0.id).home.players[0];
    out.firstImplies = Math.abs(SB.probOf(g0, ['G:' + x0.id, 'G:1st:' + x0.id]) - SB.p1(g0, 'G:1st:' + x0.id)) < 1e-12;
    out.twoFirsts = SB.probOf(g0, ['G:1st:' + x0.id, 'G:1st:' + (__soccer.model(g0.id).away.players[0] || x0).id]);
    out.unknown = SB.p1(g0, 'G:no-such-player');
    // team unders equal the complements of engine markets
    out.sx = Math.max(Math.abs(SB.p1(g0, 'SX:HU0.5') - SB.p1(g0, 'ACS')), Math.abs(SB.p1(g0, 'SX:AU0.5') - SB.p1(g0, 'HCS')), Math.abs(SB.p1(g0, 'SX:HU1.5') - (1 - SB.p1(g0, 'HO1.5'))), Math.abs(SB.p1(g0, 'SX:AU2.5') - (1 - SB.p1(g0, 'AO2.5'))));
    return out;
  });
  check('anytime-scorer chances are in (0,1) and equal the exact grid sum', gs.n > 150 && !gs.bad.length, `${gs.n} player-games; ${gs.bad.slice(0, 3).join('; ')}`);
  check('first-scorer chances are below anytime and add up to at most P(any goal)', !gs.firstBad.length, gs.firstBad.slice(0, 3).join('; '));
  check('same team, given k team goals: P(both score) < product (they compete for the goals)', gs.pairs > 20 && !gs.condBad.length, `${gs.pairs} pairs; ${gs.condBad.slice(0, 3).join('; ')}`);
  check('same team, unconditional joint ≤ product of singles (= product up to grid truncation: Poisson thinning)', !gs.uncondBad.length, gs.uncondBad.slice(0, 3).join('; '));
  check('scorer + his team winning: joint above product; parlayProb uses the exact joint', !gs.win.length, gs.win.slice(0, 3).join('; '));
  check('first scorer implies anytime; two different first scorers = 0; unknown player = 0', gs.firstImplies && gs.twoFirsts === 0 && gs.unknown === 0);
  check('team-under legs (SX) match the engine\'s complementary markets', gs.sx < 1e-12, String(gs.sx));
  check('every scorers.json team in a feed fixture is matched by name', gs.unmatched.every(n => ['AEK Athens', 'SK Slovan Bratislava', 'Valencia CF', 'Puebla', 'Atletico de San Luis', 'Atlante', 'Schalke 04'].includes(n)), gs.unmatched.join(', '));
  check('doubtful players are never auto-picked', !allCards.some(c => c.legs.some(L => L.key === 'G:osimhen-gal')));

  // goalscorer board: flags, freshness, lineup note
  await page.evaluate(() => { document.querySelector('[data-sp-lg="ucl"]').click(); document.querySelector('[data-sp-sec="scorers"]').click(); });
  const sb = await page.evaluate(() => ({ fresh: /Lineups are not confirmed/.test(document.querySelector('#main .lineup')?.textContent || '') && /compiled/.test(document.querySelector('#main .lineup').textContent),
    doubt: [...document.querySelectorAll('#main .sprow')].some(r => /Osimhen/.test(r.textContent) && /DOUBTFUL/.test(r.textContent)), nodata: /No scorer data for/.test(document.querySelector('#main').textContent) }));
  check('goalscorers: data freshness + confirm-lineups note, doubtful flag, honest "no scorer data" rows', sb.fresh && sb.doubt && sb.nodata, JSON.stringify(sb));

  // "out" players are excluded (swap in a modified copy of the scorer data, price a copy of the game, restore)
  const outEx = await page.evaluate(() => {
    const sc = JSON.parse(JSON.stringify(SB.DATA.scorers)); const t = sc.teams.find(t => t.team === 'Manchester City'); const pid = t.players[0].id; t.players[0].status = 'out';
    const g = SB.DATA.games.find(g => g.sport === 'soccer' && g.home.name === 'Manchester City' && SB.priced(g));
    const old = SB.DATA.scorers; SB.DATA.scorers = sc;
    let R; try { R = __soccer.modelOf({ ...g }); } finally { SB.DATA.scorers = old; }
    return !R.byId.has(pid) && R.home.out.some(p => p.id === pid) && R.home.players.length === t.players.length - 1;
  });
  check('players marked "out" are excluded from the model and listed as left out', outEx);

  // ---------- interactions ----------
  await page.evaluate(() => { SB.setSlip([]); document.querySelector('[data-sp-lg="epl"]').click(); document.querySelector('[data-sp-sec="overs"]').click(); });
  const tap = await page.evaluate(() => {
    const b = document.querySelector('#main .spboard .spc[data-leg]'); const s = b.dataset.leg; const [gid, key] = [s.slice(0, s.indexOf('|')), s.slice(s.indexOf('|') + 1)];
    b.click(); const added = SB.inSlip(gid, key) && b.classList.contains('in');
    b.click(); const removed = !SB.inSlip(gid, key) && !b.classList.contains('in'); return added && removed;
  });
  check('tapping a board price adds/removes the leg and reflects in-slip state', tap);
  const scTap = await page.evaluate(() => { document.querySelector('[data-sp-sec="scorers"]').click(); const b = document.querySelector('#main .sprow [data-leg]'); b.click();
    const s = b.dataset.leg, i = s.indexOf('|'); const ok = SB.inSlip(s.slice(0, i), s.slice(i + 1)) && SB.slip.some(L => L.key.startsWith('G:') && /to score/.test(L.label)); SB.setSlip([]); return ok; });
  check('a goalscorer leg can be added to the slip with a readable label', scTap);
  const build = await page.evaluate(() => {
    document.querySelector('[data-sp-sec="mega"]').click();
    const card = document.querySelector('#main .spcard'); const legs = JSON.parse(card.dataset.spLegs);
    card.querySelector('[data-sp-build]').click();
    const slip = SB.slip.map(L => L.gid + '|' + L.key).sort().join(','), want = legs.map(L => L.gid + '|' + L.key).sort().join(',');
    return { same: slip === want, sheet: document.getElementById('sheet').classList.contains('on') };
  });
  check('"Open in builder" puts the card\'s legs in SB.slip and opens the builder', build.same && build.sheet, JSON.stringify(build));
  await page.evaluate(() => { SB.closeSheet(); SB.setSlip([]); });
  const simBtn = await page.evaluate(() => ({ sim: !!document.querySelector('#tabs [data-t="sim"]'), btn: !!document.querySelector('#main [data-sp-sim]') }));
  check('"Simulate 100k" shows exactly when the sim tab is registered', simBtn.sim === simBtn.btn, JSON.stringify(simBtn));
  if (simBtn.sim) {
    const s = await page.evaluate(() => { document.querySelector('#main [data-sp-sim]').click(); return document.querySelector('#tabs .tab.on').dataset.t; });
    check('"Simulate 100k" opens the sim tab', s === 'sim', s);
    await page.evaluate(() => SB.goTab('soccerparlays', {}));
  }
  // odds format re-render
  const fmt = await page.evaluate(() => { SB.setOddsFormat('decimal'); const t = document.querySelector('#main .spcard .odds').firstChild.textContent.trim(); SB.setOddsFormat('american'); return t; });
  check('prices follow the odds format', /^\d+\.\d{2}$|^\d+(\.\d)?$/.test(fmt), fmt);
  // goTab params
  const gp = await page.evaluate(() => { SB.goTab('soccerparlays', { league: 'La Liga', section: 'btts' }); return __soccer.state; });
  check('goTab params select league + section', gp.lg === 'laliga' && gp.sec === 'btts', JSON.stringify(gp));
  check('no console errors on the Soccer Parlays tab', !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ---------- persistence + other tabs ----------
  {
    const { ctx, page, errors } = await openPage({ socp: { lg: 'seriea', sec: 'results' }, theme: 'dark' });
    const s = await page.evaluate(() => ({ st: __soccer.state, chip: document.querySelector('#main [data-sp-lg].on')?.dataset.spLg, sec: document.querySelector('#main [data-sp-sec].on')?.dataset.spSec }));
    check('selected league + section are remembered (SB.store)', s.chip === 'seriea' && s.sec === 'results', JSON.stringify(s));
    const tabsAll = await page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map(b => b.dataset.t));
    for (const t of tabsAll) { await page.evaluate(t => document.querySelector(`#tabs [data-t="${t}"]`).click(), t); await page.waitForTimeout(t === 'lab' ? 300 : 40); }
    await page.evaluate(() => document.querySelector('#tabs [data-t="soccer"]').click());
    const gs = await page.evaluate(() => { const el = document.querySelector('#main [data-open]'); if (!el) return false; el.click(); return document.getElementById('sheet').classList.contains('on'); });
    check('other tabs and the game sheet still work with soccer.js loaded', gs);
    check('no console errors on any tab', !errors.length, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await openPage({ socp: { lg: 'all', sec: 'scorers' }, w: 1280, h: 900, theme: 'dark' });
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, boards: document.querySelectorAll('#main .spboard').length, ms: __soccer.lastMs }));
    check('1280px all-leagues scorer board renders without overflow', r.sw <= r.cw && r.boards > 50, JSON.stringify(r));
    check('no console errors at 1280px', !errors.length, errors.join(' | '));
    await ctx.close();
  }
  // missing scorers.json must not break the tab
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (NO_SIM) await page.route('**/sim.js', r => r.fulfill({ status: 404, body: '' }));
    await page.route('**/scorers.json', r => r.fulfill({ status: 404, body: 'nope' }));
    await page.addInitScript(() => { localStorage.setItem('fm2.tab', JSON.stringify('soccerparlays')); localStorage.setItem('fm2.socp', JSON.stringify({ lg: 'epl', sec: 'scorers' })); });
    await page.goto(BASE); await page.waitForFunction(() => window.SB && SB.firstRender && window.__soccer);
    const t = await page.evaluate(() => document.querySelector('#main').textContent);
    check('without scorers.json the Goalscorers section shows an honest message and no page errors', /Scorer data isn't loaded/.test(t) && !errors.length, errors.join(' | '));
    await ctx.close();
  }
} catch (e) {
  check('test run', false, e.stack || String(e));
}
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
