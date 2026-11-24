// Fantasy football screens (ffb.js): Start / Sit, Trade Analyzer, Rate My Team, Rankings. Checks the fantasy-points formula
// against the fixture logs for PPR / Half / Std, the projection pieces (season PPG, last 3, floor / ceiling, games left, the
// matchup factor from a priced game), the start / sit verdict and its 1-point coin flip, trade math and verdict thresholds,
// params {give, get}, the roster kept across a reload, the best lineup and FLEX, rankings order and tiers, fantasy mode,
// season.json missing, escaping, speed, tap targets and the 390 px layout. Fixtures pinned, clock 2026-11-23T12:00Z.
// Run: node tests/ffb.test.mjs   (FFB_SHOTS=<dir> also saves screenshots)
import { open, check, done, FX } from './lib/harness.mjs';

const SEASON = JSON.parse(FX('season-2026-11-23.json'));
const NFL = SEASON.sports.nfl;
const FI = f => NFL.fields.indexOf(f) + 3;
const PER = { ppr: 1, half: 0.5, std: 0 };
const ptsOf = (r, sc) => 0.04 * r[FI('pyd')] + 4 * r[FI('ptd')] + 0.1 * r[FI('ryd')] + 6 * r[FI('rtd')] + 0.1 * r[FI('recyd')] + 6 * r[FI('ctd')] + PER[sc] * r[FI('rec')];
const TODAY = '2026-11-23';
const SEASON0 = Date.UTC(2026, 8, 9), weekOf = ms => Math.floor((ms - SEASON0) / (7 * 864e5)) + 1, W = weekOf(Date.parse('2026-11-23T12:00:00Z'));
const near = (a, b, e = 0.051) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= e;
const pctl = (s, p) => { const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const P = n => NFL.players.find(p => p.n === n);
// expected numbers straight from the fixture (gd = the UTC date of his team's next game, or null)
function expect(name, sc, gd) {
  const p = P(name), L = p.log.filter(r => r[0] <= TODAY && (!gd || r[0] < gd)).sort((a, b) => (a[0] < b[0] ? -1 : 1)), v = L.map(r => ptsOf(r, sc));
  const ppg = v.reduce((a, b) => a + b, 0) / v.length, l3a = v.slice(-3), l3 = l3a.reduce((a, b) => a + b, 0) / l3a.length, s = v.slice().sort((a, b) => a - b);
  const dates = new Set(); for (const q of NFL.players) if (q.t === p.t) for (const r of q.log) if (r[0] <= TODAY) dates.add(r[0]);
  const thisWeek = [...dates].some(d => weekOf(Date.parse(d + 'T12:00:00Z')) === W), wl = 18 - W + 1 - (thisWeek ? 1 : 0), left = Math.max(0, Math.min(wl, 17 - dates.size));
  const base = 0.7 * ppg + 0.3 * l3;
  return { v, ppg, l3, base, floor: pctl(s, 0.2), ceil: pctl(s, 0.8), left, value: Math.round(base * left), n: v.length };
}
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const ready = (page, sel = '.ffb-root') => page.waitForFunction(s => window.__ffb && __ffb.seasonState !== 'loading' && __ffb.seasonState !== 'idle' && document.querySelector(s), sel, { timeout: 20000 });
const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const shots = process.env.FFB_SHOTS || '';
// page errors that come from this module or the shared components (other modules' errors are printed, not failed here)
function ownErrors(page) {
  const own = [], other = [];
  page.on('pageerror', e => { const s = String(e.stack || '') + ' ' + e.message; (/ffb\.js|ui\.js/.test(s) ? own : other).push(e.message); });
  return { own, other };
}
async function search(page, list, q) {
  await page.fill(`.ffb-root [data-ffb-q="${list}"]`, q);
  await page.waitForFunction(l => document.querySelector(`.ffb-root [data-ffb-res="${l}"] .ffb-hit`), list, { timeout: 5000 });
  await page.click(`.ffb-root [data-ffb-res="${list}"] .ffb-hit`);
  await page.waitForTimeout(40);
}

// ================= phone: betting mode first, then the fantasy screens =================
let { page, browser } = await open({ width: 390, height: 844, tab: 'ask' });
let E = ownErrors(page);
check('starts in betting mode (no body.mode-fantasy)', !(await page.evaluate(() => document.body.classList.contains('mode-fantasy'))));
check('the four tabs are registered', await page.evaluate(() => ['ff-startsit', 'ff-trade', 'ff-rate', 'ff-rank'].every(k => document.querySelector(`#tabs [data-t="${k}"]`) || SB.tab)));
const t0 = await page.evaluate(() => { const t = performance.now(); SB.goTab('ff-rank', {}); return performance.now() - t; });
check('switching to a ff-* tab switches the app to fantasy mode', await page.evaluate(() => document.body.classList.contains('mode-fantasy') && SB.mode === 'fantasy'));
await ready(page, '.ffb-root .ffb-rt');
check('season.json loaded', await page.evaluate(() => __ffb.seasonState) === 'ok');
// first render of each screen, measured inside the page around SB.goTab (model rebuilt each time)
const times = {};
for (const k of ['ff-startsit', 'ff-trade', 'ff-rate', 'ff-rank']) times[k] = await page.evaluate(k => { __ffb.reset(); const t = performance.now(); SB.goTab(k, {}); return performance.now() - t; }, k);
check('first render of every screen under 1,500 ms (model built inside)', Object.values(times).every(t => t < 1500), JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)]))) + ` · first goTab while season loads ${Math.round(t0)} ms`);

// ---- the model: week, games this week, formula, projection pieces ----
const M = await page.evaluate(() => { const m = __ffb.model(); return { W: m.W, teams: Object.keys(m.games).sort(), n: m.players.length }; });
check('week 11 on 2026-11-23 (weeks run Wed-Tue on UTC dates)', M.W === 11 && W === 11, `W=${M.W}`);
check('this week = the feed games not started within 7 days (MNF + Thanksgiving: 8 teams, ESPN abbrs matched by name: WAS->WSH, LA->LAR)', JSON.stringify(M.teams) === JSON.stringify(['CHI', 'CIN', 'DAL', 'DET', 'GB', 'LAR', 'PHI', 'WSH']), M.teams.join(','));
for (const sc of ['ppr', 'half', 'std']) {
  await page.selectOption('.ffb-root select[data-ui-select="ff-scoring"]', sc);
  await page.waitForTimeout(40);
  for (const [name, gd] of [['Jordan Love', '2026-11-26'], ['Trey McBride', null], ['Jahmyr Gibbs', '2026-11-26']]) {
    const x = expect(name, sc, gd);
    const got = await page.evaluate(n => { const p = __ffb.player(n); return p && { pts: p.pts, ppg: p.ppg, l3: p.l3, base: p.base, floor: p.floor, ceil: p.ceil, proj: p.proj, left: p.left, value: p.value, gm: !!p.gm }; }, name);
    check(`${sc}: ${name} points per game match the formula on every logged game (${x.n})`, got && got.pts.length === x.v.length && got.pts.every((v, i) => near(v, x.v[i], 1e-9)), got ? `${got.pts.slice(-3).map(v => v.toFixed(2))} vs ${x.v.slice(-3).map(v => v.toFixed(2))}` : 'missing');
    if (sc === 'ppr' || name === 'Jahmyr Gibbs') check(`${sc}: ${name} PPG, last 3, floor / ceiling (20th / 80th pct), base 70/30, games left, value`,
      near(got.ppg, x.ppg, 1e-9) && near(got.l3, x.l3, 1e-9) && near(got.floor, x.floor, 1e-9) && near(got.ceil, x.ceil, 1e-9) && near(got.base, x.base, 1e-9) && got.left === x.left && got.value === x.value,
      `ppg ${got.ppg.toFixed(2)} l3 ${got.l3.toFixed(2)} floor ${got.floor.toFixed(2)} ceil ${got.ceil.toFixed(2)} left ${got.left}/${x.left} value ${got.value}/${x.value}`);
    check(`${sc}: ${name} projection = base × 1 (unpriced) with a game, 0 without`, gd ? got.gm && near(got.proj, x.base, 1e-9) : !got.gm && got.proj === 0, `proj ${got.proj}`);
  }
}
const sums = { std: expect('Trey McBride', 'std').ppg, half: expect('Trey McBride', 'half').ppg, ppr: expect('Trey McBride', 'ppr').ppg };
check('scorings differ by half a point a catch (McBride: Half − Std = (PPR − Std) / 2)', near(sums.half - sums.std, (sums.ppr - sums.std) / 2, 1e-9) && sums.ppr > sums.half);
await page.selectOption('.ffb-root select[data-ui-select="ff-scoring"]', 'ppr');
check('scoring choice is stored on the device', await page.evaluate(() => localStorage.getItem('fm2.ff.scoring')) === '"ppr"');

// ---- Rankings ----
await page.evaluate(() => SB.goTab('ff-rank', {}));
const rk = async () => page.evaluate(() => [...document.querySelectorAll('.ffb-rt tbody tr:not(.ffb-tier)')].map(tr => ({ n: tr.querySelector('.pn').textContent, pos: tr.querySelector('.pt').textContent.slice(0, 2), v: +tr.querySelector('.ffb-pj').textContent, rank: +tr.querySelector('.ffb-rk').textContent })));
let R = await rk();
check('rankings: RB this week, sorted by projection, ranks 1..n', R.length > 5 && R.every((r, i) => r.rank === i + 1 && (i === 0 || r.v <= R[i - 1].v)) && R.every(r => r.pos === 'RB'), `${R.length} rows, top ${R[0] && R[0].n} ${R[0] && R[0].v}`);
check('rankings: tiers by gaps (Tier 1 first, more than one tier)', await page.evaluate(() => { const t = [...document.querySelectorAll('.ffb-rt .ffb-tier')].map(x => x.textContent); return t[0] === 'Tier 1' && t.length > 1; }));
const gibbs = expect('Jahmyr Gibbs', 'ppr', '2026-11-26');
check('rankings row shows the right projection and PPG (Gibbs)', await page.evaluate(() => { const tr = [...document.querySelectorAll('.ffb-rt tbody tr')].find(t => /Gibbs/.test(t.textContent)); return tr ? [...tr.children].map(td => td.textContent.trim()) : null; }).then(c => c && c[3] === gibbs.base.toFixed(1) && c[4] === gibbs.ppg.toFixed(1) && c[5] === gibbs.l3.toFixed(1)));
check('rankings: unpriced matchup shows "—", trend arrows carry a text name', await page.evaluate(() => /—/.test(document.querySelector('.ffb-rt .ffb-mcell').textContent) && [...document.querySelectorAll('.ffb-tr')].every(t => t.getAttribute('aria-label'))));
await page.click('.ffb-root [data-ui-pill="ff-rpos|FLEX"]'); await page.waitForTimeout(40);
R = await rk();
check('rankings: FLEX mixes RB / WR / TE only, still sorted', R.length > 10 && R.every(r => ['RB', 'WR', 'TE'].includes(r.pos)) && new Set(R.map(r => r.pos)).size >= 2 && R.every((r, i) => i === 0 || r.v <= R[i - 1].v));
await page.click('.ffb-root [data-ui-pill="ff-rpos|WR"]'); await page.waitForTimeout(40);
await page.click('.ffb-root [data-ui-seg="ff-rwin|ros"]'); await page.waitForTimeout(40);
R = await rk();
const rosHead = await page.evaluate(() => [...document.querySelectorAll('.ffb-rt thead th')].map(t => t.textContent));
check('rankings: rest of season sorted by ROS points, with games left, across all teams (not only this week\'s)', R.length >= 40 && R.every((r, i) => i === 0 || r.v <= R[i - 1].v) && rosHead.includes('ROS pts') && rosHead.includes('Games left'), `${R.length} rows`);
const amon = expect('Amon-Ra St. Brown', 'ppr', '2026-11-26');
check('ROS value = round(base × games left) (Amon-Ra St. Brown)', R.find(r => r.n === 'Amon-Ra St. Brown')?.v === amon.value, `${amon.value}`);
const more = await page.$('.ffb-root [data-ffb-act="rall"]');
if (more) { await more.click(); await page.waitForTimeout(40); check('"Show all" lists every ranked player and keeps focus on the button', (await rk()).length > 40 && await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-ffb-act') === 'rall')); }
check('rankings: positions and window are remembered', await page.evaluate(() => localStorage.getItem('fm2.ff.rankpos') === '"WR"' && localStorage.getItem('fm2.ff.rankwin') === '"ros"'));
check('rankings note says who is left out and why', /fewer than 3 games/.test(await text(page, '.ffb-root')));
check('no horizontal scroll at 390 px (rankings)', await noScroll(page));
await page.click('.ffb-root [data-ui-seg="ff-rwin|week"]');

// ---- Start / Sit ----
await page.evaluate(() => SB.goTab('ff-startsit', {}));
check('start / sit: empty state asks for two to four players', /two to four/.test(await text(page, '.ffb-root .ui-empty')));
await search(page, 'ss', 'Gibbs');
check('search adds a player and keeps focus in the search box', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-ffb-q') === 'ss' && document.querySelectorAll('.ffb-chip').length === 1));
await search(page, 'ss', 'swift');
const ss = await page.evaluate(() => ({ v: document.querySelector('.ffb-root .ui-verdict .t').textContent, tag: document.querySelector('.ffb-root .ui-verdict .tag').textContent, cards: [...document.querySelectorAll('.ffb-pc')].map(c => c.querySelector('.ffb-pcn b').textContent + '|' + c.querySelector('.ui-badge').textContent) }));
check('start / sit verdict: "Start Jahmyr Gibbs" (28.5 vs 16.5), tagged model estimate', ss.v === 'Start Jahmyr Gibbs' && /model estimate/.test(ss.tag), JSON.stringify(ss));
check('cards side by side, best first: Start / Sit badges', ss.cards[0] === 'Jahmyr Gibbs|Start' && /Swift\|Sit/.test(ss.cards[1]), ss.cards.join(' / '));
const card = await text(page, '.ffb-pc');
check('card shows projection, floor, ceiling, season PPG, last 3, matchup, sample size', card.includes(gibbs.base.toFixed(1)) && card.includes(gibbs.floor.toFixed(1)) && card.includes(gibbs.ceil.toFixed(1)) && /Floor/.test(card) && /Ceiling/.test(card) && /Last 3/.test(card) && /Matchup/.test(card) && /vs CHI/.test(card) && new RegExp(`from ${gibbs.n} games`).test(card), card.slice(0, 200));
// coin flip on the page: two players within a point
const pair = await page.evaluate(() => { const L = __ffb.model().players.filter(p => p.proj > 0 && p.gp >= 3).sort((a, b) => b.proj - a.proj); for (let i = 0; i < L.length - 1; i++) if (L[i].proj - L[i + 1].proj <= 0.6 && L[i].floor !== L[i + 1].floor) return [L[i], L[i + 1]].map(p => ({ id: p.id, n: p.n, floor: p.floor })); return null; });
if (pair) {
  await page.evaluate(ids => { __ffb.state.ss = ids; SB.render(); }, pair.map(p => p.id));
  const hi = pair[0].floor > pair[1].floor ? pair[0] : pair[1];
  check('within 1 point -> "Coin flip: lean X, the higher floor"', await text(page, '.ffb-root .ui-verdict .t') === `Coin flip: lean ${hi.n}, the higher floor`, await text(page, '.ffb-root .ui-verdict .t'));
}
const V = await page.evaluate(() => {
  const f = (a, b, fa, fb) => __ffb.ssVerdict([{ n: 'A', proj: a, floor: fa }, { n: 'B', proj: b, floor: fb }]);
  return [f(10, 9.2, 5, 7), f(10, 9, 5, 7), f(10, 8.9, 5, 7), f(0, 0, 3, 4), f(10, 9.5, 8, 7)].map(v => v.tone + ':' + v.title);
});
check('verdict rules: within 1 point coin flip (lean the higher floor), beyond it Start, nobody playing -> pass', V[0] === 'coin:Coin flip: lean B, the higher floor' && V[1] === 'coin:Coin flip: lean B, the higher floor' && V[2] === 'take:Start A' && /^pass:/.test(V[3]) && V[4] === 'coin:Coin flip: lean A, the higher floor', V.join(' | '));
await page.evaluate(() => { __ffb.state.ss = []; SB.render(); });
await search(page, 'ss', 'McBride'); await search(page, 'ss', 'Gibbs');
check('a player without a game: 0 and "No game this week (bye or not in the feed)"', /No game this week \(bye or not in the feed\)/.test(await text(page, '.ffb-root .ffb-cards')) && await page.evaluate(() => [...document.querySelectorAll('.ffb-pc')].some(c => /McBride/.test(c.textContent) && /0\.0/.test(c.querySelector('.ffb-projn').textContent))));
await page.click('.ffb-root [data-ffb-rm^="ss|"]'); await page.waitForTimeout(40);
check('remove: the player goes and focus lands on the next control', await page.evaluate(() => document.querySelectorAll('.ffb-chip').length === 1 && !!document.activeElement && document.activeElement.closest('.ffb-root') !== null));
check('no horizontal scroll at 390 px (start / sit)', await noScroll(page));
// escaping: typed markup never becomes an element
await page.fill('.ffb-root [data-ffb-q="ss"]', '<img src=x onerror="window.__xss=1">');
await page.waitForTimeout(60);
check('search text is escaped (no element, no script)', await page.evaluate(() => !document.querySelector('.ffb-root img') && !window.__xss));

// ---- Trade Analyzer: params {give, get} ----
await page.evaluate(() => SB.goTab('ff-trade', { give: ['Amon-Ra St. Brown', 'Kyren Williams'], get: ['Chuba Hubbard', 'Nobody Atall'] }));
const kw = expect('Kyren Williams', 'ppr', '2026-11-26'), ch = expect('Chuba Hubbard', 'ppr', null);
const give = amon.value + kw.value, get = ch.value, net = get - give, edge = Math.round(net * 1000 / give) / 10;
const tr = await page.evaluate(() => ({ give: document.querySelector('[data-ffb-total="give"]').textContent, get: document.querySelector('[data-ffb-total="get"]').textContent, band: document.querySelector('.ffb-tv')?.getAttribute('data-ffb-band'), title: document.querySelector('.ffb-tvt')?.textContent, edge: document.querySelector('.ffb-edn')?.textContent, net: document.querySelector('.ffb-trl .net')?.textContent, dot: document.querySelector('.ffb-track i')?.style.left, rows: [...document.querySelectorAll('.ffb-side.give .ffb-prow .v')].map(v => +v.textContent), miss: document.querySelector('.ffb-root .ffb-warn')?.textContent || '' }));
const bandOf = e => (e >= 15 ? 'strong-accept' : e >= 5 ? 'accept' : e > -5 ? 'fair' : e > -15 ? 'decline' : 'strong-decline');
check('params {give, get} fill both sides; values = ROS points', JSON.stringify(tr.rows) === JSON.stringify([amon.value, kw.value]), JSON.stringify(tr.rows));
check('side totals in the big numbers', tr.give === String(give) && tr.get === String(get), `${tr.give} / ${tr.get} vs ${give} / ${get}`);
check('trade edge % = (receive − give) / give, net value, verdict band', tr.edge === `${edge > 0 ? '+' : edge < 0 ? '−' : '±'}${Math.abs(edge).toFixed(1)}%` && tr.net === `${net > 0 ? '+' : net < 0 ? '−' : '±'}${Math.abs(net)} net value` && tr.band === bandOf(edge), JSON.stringify(tr) + ` expected edge ${edge}`);
check('meter dot sits at 50 + edge (clamped to the track)', tr.dot === `${(50 + Math.max(-50, Math.min(50, edge))).toFixed(1)}%`, tr.dot);
check('a name we cannot find is said on screen', /Nobody Atall/.test(tr.miss), tr.miss);
const B = await page.evaluate(() => [15, 14.9, 5, 4.9, 0, -4.9, -5, -14.9, -15, -40].map(e => __ffb.band(e).label));
check('verdict thresholds: >= +15 Strong accept, +5..15 Accept, -5..+5 Fair, -15..-5 Decline, <= -15 Strong decline',
  JSON.stringify(B) === JSON.stringify(['Strong accept', 'Accept', 'Accept', 'Fair', 'Fair', 'Fair', 'Decline', 'Decline', 'Strong decline', 'Strong decline']), B.join(', '));
const TM = await page.evaluate(() => [[100, 115], [100, 105], [100, 96], [100, 95], [100, 86], [100, 85], [0, 10]].map(([g, r]) => { const t = __ffb.tradeMath([{ value: g }], [{ value: r }]); return t.edge == null ? 'none' : t.edge + ':' + t.band.label; }));
check('trade math on exact boundaries (no float slips)', JSON.stringify(TM) === JSON.stringify(['15:Strong accept', '5:Accept', '-4:Fair', '-5:Decline', '-14:Decline', '-15:Strong decline', 'none']), TM.join(', '));
check('a re-render (data refresh) does not re-apply the params', await page.evaluate(() => { __ffb.state.give = __ffb.state.give.slice(0, 1); SB.render(); return document.querySelectorAll('.ffb-side.give .ffb-prow').length === 1; }));
check('trade note says what the value is and the bye-week gap', /bye weeks/.test(await text(page, '.ffb-root')) && /model estimate/.test(await text(page, '.ffb-root')));
check('no horizontal scroll at 390 px (trade)', await noScroll(page));
const small = await page.evaluate(() => [...document.querySelectorAll('.ffb-root button, .ffb-root input, .ffb-root select')].filter(b => !b.closest('.ui-seg') && b.offsetParent && b.getBoundingClientRect().height < 40 && !b.closest('.ui-sel')).map(b => b.outerHTML.slice(0, 80)));
check('tap targets 40 px+ (trade)', small.length === 0, small.join(' | '));
if (shots) { await page.evaluate(() => scrollTo(0, document.querySelector('.ffb-trade').getBoundingClientRect().top + scrollY - 20)); await page.screenshot({ path: `${shots}/ffb-trade-390.png` }); }

// ---- Rate My Team: roster editor, persistence, best lineup, FLEX ----
await page.evaluate(() => SB.goTab('ff-rate', {}));
check('rate my team: league sync is described honestly (not available, needs logins)', /League sync \(ESPN, Sleeper, Yahoo\) is not available/.test(await text(page, '.ffb-root')));
for (const q of ['Jordan Love', 'Gibbs', 'Swift', 'Kyren Williams', 'Amon-Ra', 'Puka', 'LaPorta', 'Jameson Williams']) await search(page, 'roster', q);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fm2.ff.roster') || '[]'));
check('roster is kept in localStorage fm2.ff.roster', stored.length === 8, JSON.stringify(stored));
const before = await page.evaluate(() => [...document.querySelectorAll('.ffb-lus')[0].querySelectorAll('.ffb-lu')].map(r => r.querySelector('.ffb-slotb').textContent + ':' + (r.querySelector('.who b')?.textContent || '') + ':' + r.querySelector('.ffb-lup').textContent + ':' + r.querySelector('.ffb-g').textContent));
await page.reload();
await page.waitForFunction(() => window.SB && SB.firstRender, null, { timeout: 30000 });
await page.evaluate(() => SB.goTab('ff-rate', {}));  // the harness's init script puts the stored tab back on every load
await ready(page, '.ffb-root .ffb-lus');
const after = await page.evaluate(() => [...document.querySelectorAll('.ffb-lus')[0].querySelectorAll('.ffb-lu')].map(r => r.querySelector('.ffb-slotb').textContent + ':' + (r.querySelector('.who b')?.textContent || '') + ':' + r.querySelector('.ffb-lup').textContent + ':' + r.querySelector('.ffb-g').textContent));
check('roster and lineup persist across a reload', JSON.stringify(before) === JSON.stringify(after) && after.length === 7, after.join(' | '));
// the lineup on screen against the model: best QB, two best RB / WR, best TE, FLEX = best RB / WR / TE left
const lu = await page.evaluate(() => {
  const m = __ffb.model(), ps = JSON.parse(localStorage.getItem('fm2.ff.roster')).map(id => m.byId.get(id)).sort((a, b) => b.proj - a.proj || b.floor - a.floor || b.ppg - a.ppg);
  const left = ps.slice(), take = pos => { const i = left.findIndex(p => pos.includes(p.pos)); return i < 0 ? null : left.splice(i, 1)[0]; };
  const exp = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'].map(s => take([s])); exp.push(take(['RB', 'WR', 'TE']));
  return { exp: exp.map(p => (p ? p.n : '')), bench: left.map(p => p.n) };
});
check('best lineup QB / RB / RB / WR / WR / TE / FLEX by projection', JSON.stringify(after.map(x => x.split(':')[1])) === JSON.stringify(lu.exp), `${after.map(x => x.split(':')[1]).join(', ')} vs ${lu.exp.join(', ')}`);
const F = await page.evaluate(() => {
  const mk = (n, pos, proj, rank) => ({ id: n, n, pos, proj, floor: 0, ppg: proj, rank });
  const base = [mk('Q', 'QB', 20, 2), mk('R1', 'RB', 18, 3), mk('R2', 'RB', 15, 9), mk('R3', 'RB', 14, 12), mk('W1', 'WR', 16, 4), mk('W2', 'WR', 12, 20), mk('W3', 'WR', 13, 15), mk('T1', 'TE', 10, 8), mk('T2', 'TE', 13, 2)];
  const a = __ffb.lineup(base), b = __ffb.lineup(base.map(p => (p.n === 'T1' ? { ...p, proj: 15 } : p.n === 'T2' ? { ...p, proj: 14.5 } : p)));
  const c = __ffb.lineup([mk('Q', 'QB', 20, 2), mk('R1', 'RB', 18, 3), mk('W1', 'WR', 16, 4), mk('W2', 'WR', 12, 20)]);
  return { a: a.slots.map(s => s.slot + '=' + (s.p ? s.p.n : '-')).join(' '), b: b.slots.find(s => s.slot === 'FLEX').p.n, c: c.slots.map(s => s.slot + '=' + (s.p ? s.p.n : '-') + ':' + s.grade).join(' '), grades: a.slots.map(s => s.grade).join(''), gpa: a.grade };
});
check('FLEX takes the best RB / WR / TE left (a 3rd RB here)', F.a === 'QB=Q RB=R1 RB=R2 WR=W1 WR=W3 TE=T2 FLEX=R3', F.a);
check('FLEX can be a second TE when he is the best left (T2 14.5 over RB 14)', F.b === 'T2', F.b);
check('empty slots stay empty and grade F', F.c === 'QB=Q:A RB=R1:A+ RB=-:F WR=W1:A WR=W2:D TE=-:F FLEX=-:F', F.c);
// rank ÷ starters at the position (QB / TE 12, RB / WR 24): <= 1/8 A+, <= 1/4 A, <= 1/2 B, <= 3/4 C, <= 1 D, else F; overall = grade-point average
check('slot grades from position rank in a 12-team league (QB #2 of 12 A, RB #3 of 24 A+, WR #15 C, RB #12 B; GPA 3.47 = B)', F.grades === 'AA+BACAB' && F.gpa === 'B', F.grades + ' ' + F.gpa);
const rate = await text(page, '.ffb-root');
check('overall grade, bench and "players to look at" with the free-agent caveat', /Overall grade/.test(rate) && /Bench/.test(rate) && /Players to look at/.test(rate) && /can't see your league's free agents/.test(rate));
check('no horizontal scroll at 390 px (rate my team)', await noScroll(page));
// compare from "players to look at" opens Start / Sit with both players
const cmp = await page.$('.ffb-root [data-ffb-act^="cmp|"]');
if (cmp) { await cmp.click(); await page.waitForTimeout(60); check('"Compare" opens Start / Sit with the two players', await page.evaluate(() => SB.tab === 'ff-startsit' && document.querySelectorAll('.ffb-pc').length === 2)); }
check('no errors from ffb.js / ui.js (phone)', E.own.length === 0, E.own.join(' | ') + (E.other.length ? ` (other modules: ${[...new Set(E.other)].join(' | ')})` : ''));
await browser.close();

// ================= boot straight into a fantasy tab (stored), and a priced game =================
({ page, browser } = await open({ width: 1440, height: 900, tab: 'ff-trade' }));
E = ownErrors(page);
await ready(page, '.ffb-root .ffb-trade');
check('booting on a stored ff-* tab shows fantasy mode', await page.evaluate(() => document.body.classList.contains('mode-fantasy')));
await page.click('.ffb-root [data-ffb-act="example-trade"]'); await page.waitForTimeout(60);
check('example trade grades a 1-for-1', await page.evaluate(() => document.querySelectorAll('.ffb-prow').length === 2 && !!document.querySelector('.ffb-tv')));
check('desktop: two trade columns side by side', await page.evaluate(() => { const [a, b] = [...document.querySelectorAll('.ffb-side')].map(s => s.getBoundingClientRect()); return Math.abs(a.top - b.top) < 2 && b.left > a.right; }));
check('no horizontal scroll at 1440 px', await noScroll(page));
if (shots) { await page.evaluate(() => scrollTo(0, document.querySelector('.ffb-trade').getBoundingClientRect().top + scrollY - 20)); await page.screenshot({ path: `${shots}/ffb-trade-1440.png` }); }
// a priced game this week: the matchup factor is the engine's tf (clamped .85-1.15), the score 50 + 250(tf-1) - 60 max(0, pb-.15)
const MX = await page.evaluate(() => {
  const g = { id: 'nfl-MIN-ATL-test', sport: 'nfl', comp: 'NFL', start: '2026-11-25T18:00:00Z', status: 'scheduled', home: { abbr: 'MIN', name: 'Minnesota Vikings' }, away: { abbr: 'ATL', name: 'Atlanta Falcons' }, prob: { home: 0.75, away: 0.25 } };
  SB.DATA.games.push(g); __ffb.reset();
  const m = __ffb.model(), c = SB.engine.teamCtx(g, 'MIN'), d = SB.engine.teamCtx(g, 'ATL');
  const p = m.players.find(x => x.t === 'MIN' && x.gp >= 3), q = m.players.find(x => x.t === 'ATL' && x.gp >= 3);
  const out = { tf: c && c.tf, tfA: d && d.tf, pb: c && c.pb, f: m.games.MIN && m.games.MIN.factor, fA: m.games.ATL && m.games.ATL.factor, sc: m.games.MIN && m.games.MIN.score, proj: p.proj, base: p.base, projA: q.proj, baseA: q.base };
  SB.DATA.games.pop(); __ffb.reset(); return out;
});
const cl = x => Math.max(0.85, Math.min(1.15, x));
check('priced game: factor = engine teamCtx tf, clamped .85-1.15; favourite up, underdog down', MX.tf > 1 && MX.tfA < 1 && near(MX.f, cl(MX.tf), 1e-9) && near(MX.fA, cl(MX.tfA), 1e-9) && near(MX.proj, MX.base * MX.f, 1e-9) && near(MX.projA, MX.baseA * MX.fA, 1e-9), JSON.stringify(MX));
check('matchup score = 50 + 250(tf − 1) − 60·max(0, pb − .15), clamped', MX.sc === Math.max(0, Math.min(100, Math.round(50 + 250 * (cl(MX.tf) - 1) - 60 * Math.max(0, MX.pb - 0.15)))), `${MX.sc}`);
await page.evaluate(() => SB.goTab('ff-rate', {}));
await page.click('.ffb-root [data-ffb-act="example-roster"]'); await page.waitForTimeout(60);
check('example roster fills the lineup (desktop)', await page.evaluate(() => document.querySelectorAll('.ffb-lus')[0].querySelectorAll('.ffb-lu').length === 7));
check('no horizontal scroll at 1440 px (rate my team)', await noScroll(page));
check('no errors from ffb.js / ui.js (desktop)', E.own.length === 0, E.own.join(' | '));
await browser.close();

// ================= season.json missing =================
({ page, browser } = await open({ width: 390, height: 844, tab: 'ff-rank', pins: { 'season.json': null } }));
E = ownErrors(page);
await ready(page, '.ffb-root .ui-empty:not([aria-busy])');
check('season.json missing: an honest empty state, no crash', /didn't load/.test(await text(page, '.ffb-root .ui-empty')) && await page.evaluate(() => __ffb.seasonState) === 'none');
for (const k of ['ff-startsit', 'ff-trade', 'ff-rate']) { await page.evaluate(k => SB.goTab(k, { give: ['X'] }), k); }
check('every screen survives without season.json', await page.evaluate(() => /didn't load/.test(document.querySelector('.ffb-root').textContent)) && E.own.length === 0, E.own.join(' | '));
check('no horizontal scroll at 390 px (no data)', await noScroll(page));
await done(browser);
