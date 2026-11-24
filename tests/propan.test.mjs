// Prop Analyzer (propan.js): search, market, line stepper, Over / Under, your price -> edge, projection, chance, game log, splits,
// factors, ladder, + Slip, Ask, Player page, params, and the empty state. Fixtures pinned, clock 2026-11-23T12:00Z.
// Line rule under test: lines are half points; over L = ceil(L)+ (P:<id>:<ceil(L)>), under L = floor(L) or fewer (U:<id>:<L>),
// so over + under = 1; a whole number N is read as "N or more" (N - 0.5).
// Run: node tests/propan.test.mjs
import { open, check, done, FX } from './lib/harness.mjs';

const nameKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SEASON = JSON.parse(FX('season-2026-11-23.json'));
const L4 = JSON.parse(FX('nbalast4-2026-11-23b.json'));
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
// his games before `day`, oldest first, straight from the fixtures (NBA: season log with minutes > 0, joined with the last 4).
// Logs are dated by the game's UTC start date, so `day` is the priced game's UTC date, and nothing after today's UTC date counts.
const TODAY_UTC = '2026-11-23';
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
function fixtureVals(sp, name, team, stat, day) {
  const S = SEASON.sports[sp], fi = f => 3 + S.fields.indexOf(f);
  let c = S.players.filter(p => nameKey(p.n) === nameKey(name));
  if (c.length > 1) c = c.filter(p => p.t === team);
  const by = new Map();
  if (c.length === 1) for (const r of c[0].log) {
    if (!(r[0] < day && r[0] <= TODAY_UTC)) continue;
    if (sp === 'nba' && !(r[fi('min')] > 0)) continue;
    by.set(r[0], stat === 'td' ? (r[fi('rtd')] || 0) + (r[fi('ctd')] || 0) : r[fi(stat)]);
  }
  if (sp === 'nba' && L4.teams[team]) for (const g of L4.teams[team].games) {
    const e = Object.entries(g.players).find(([n]) => nameKey(n) === nameKey(name));
    if (e && !e[1].dnp && g.date < day && g.date <= TODAY_UTC && !by.has(g.date)) by.set(g.date, e[1][stat]);
  }
  return { vals: [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(x => x[1]), P: c.length === 1 ? c[0] : null };
}
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

// ======================= 390 px, the full fixture set =======================
const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'propan' });
await page.waitForFunction(() => window.__propan && __propan.seasonState === 'ok' && document.querySelectorAll('.pa-root .pa-trow').length > 0, null, { timeout: 20000 });
await page.waitForTimeout(300);

// ---------- first render, header, honest labels ----------
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${Math.round(fr)} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a re-render stays fast', rr < 400, `${Math.round(rr)} ms`);
const rms = await page.evaluate(() => __propan.renderMs);
check('render time measured in the page: every render so far under 1,500 ms (incl. the cold one once the box scores load)', rms.n >= 2 && rms.max < 1500, `max ${Math.round(rms.max)} ms over ${rms.n} renders`);
const t0 = await page.locator('.pa-root').innerText();
check('header: kicker "Prop deep-dive" and the display title', /PROP DEEP-DIVE/i.test(t0) && /PROP\s*ANALYZER/i.test(await page.locator('.pa-root .ui-title').innerText()));
check('honest line on the empty state: no sportsbook prop prices, model estimates, type your price', /No sportsbook prop prices/.test(t0) && /model estimates/.test(t0) && /type your book's price/.test(t0));
check('no certainty words', !/guarantee|\block\b|sure thing|can't lose|\bdue\b/i.test(t0));

// ---------- empty state: the top 8 ----------
const nTop = await page.locator('.pa-root .pa-trow').count();
check('empty state lists the top 8 props on the slate', nTop === 8, `${nTop}`);
const top0 = await page.evaluate(() => { const t = __propan.topProps()[0]; return { name: t.p.name, team: t.p.team, sp: t.p.sp, stat: t.stat, line: t.line, h: t.h, n: t.n, day: new Date(t.p.start).toISOString().slice(0, 10), rate: t.rate, ch: t.ch, rates: __propan.topProps().map(x => x.rate == null ? -1 : x.rate + ((SB.engine.STAT_PREF || {})[x.stat] || 0)) }; });
const fx0 = fixtureVals(top0.sp, top0.name, top0.team, top0.stat, top0.day).vals.slice(-10);
const fh0 = fx0.filter(v => (top0.stat === 'td' ? v >= 1 : v > top0.line)).length;
check('top row: hit rate over the last 10 matches the fixture box scores', fh0 === top0.h && fx0.length === top0.n, `${top0.name} ${top0.stat} ${top0.line}: fixture ${fh0}/${fx0.length}, shown ${top0.h}/${top0.n}`);
check('top list is ordered by hit rate (points get the owner\'s small selection bonus)', top0.rates.every((r, i, a) => i === 0 || a[i - 1] >= r - 1e-9), top0.rates.map(r => r.toFixed(2)).join(','));
const row0 = await page.locator('.pa-root .pa-trow').first().innerText();
check('top row labels the sample under the hit rate ("h of n")', row0.includes(`${top0.h} of ${top0.n}`), row0.replace(/\n/g, ' | '));
check('top row shows name, line, fair odds and the hit rate', row0.includes(top0.name) && row0.includes(String(top0.line)) && /fair [+-]\d+/.test(row0) && row0.includes(String(Math.round(top0.h / top0.n * 100))), row0.replace(/\n/g, ' | '));
await page.locator('[data-ui-seg="pa-sort|mu"]').click();
const muOrder = await page.evaluate(() => __propan.topProps().map(x => (x.mu ? x.mu.s : -1)));
check('MATCHUP toggle re-ranks by the matchup score', muOrder.every((v, i, a) => i === 0 || a[i - 1] >= v), muOrder.join(','));
await page.locator('[data-ui-seg="pa-sort|hit"]').click();
check('no horizontal scroll at 390 px (empty state)', await noScroll(page));

// ---------- params {id, line}: an NBA points prop ----------
const subj = await page.evaluate(() => {
  const L = __propan.slate().list.filter(p => p.sp === 'nba' && p.stats.pts && p.stats.pts.avg >= 14);
  const p = L[0], pl = p.stats.pts;
  return { pk: p.pk, id: pl.id, name: p.name, team: p.team, gid: p.gid, day: new Date(p.start).toISOString().slice(0, 10) };
});
await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
await page.waitForSelector('.pa-root[data-pa="prop"]');
const eng = await page.evaluate(id => {
  const E = SB.engine, pl = E.playerById(id), M = E.playerMeans(pl);
  return { p15: E.playerP(pl, 15), p16: E.playerP(pl, 16), p14: E.playerP(pl, 14), p20: E.playerP(pl, 20), p21: E.playerP(pl, 21), proj: (1 - M.pb) * M.an + M.pb * M.ab, ladder: E.LADDER.pts.map(t => E.playerP(pl, t)), lad: E.LADDER.pts };
}, subj.id);
const read = () => page.evaluate(() => ({
  line: document.getElementById('pa-line').value, chance: document.querySelector('[data-pa-chance]').textContent, proj: document.querySelector('[data-pa-proj]').textContent,
  odds: document.querySelector('.pa-mk .odds').textContent, mk: document.querySelector('.pa-mk .t').textContent, meaning: document.querySelector('.pa-meaning').textContent,
  verdict: document.querySelector('.ui-verdict .t').textContent, vk: (document.querySelector('.ui-verdict .k') || {}).textContent || '', tag: (document.querySelector('.ui-verdict .tag') || {}).textContent || '',
  name: document.querySelector('.pa-nm').textContent, mu: document.querySelector('.pa-mu').textContent,
}));
let R = await read();
check('params {id, line: 15}: opens that player, line 14.5 (15 is read as "15 or more")', R.name === subj.name && R.line === '14.5' && /Over 14\.5/.test(R.mk) && /15 or more points/.test(R.meaning), `${R.name} ${R.line} ${R.mk}`);
check('header: team, matchup "AWAY @ HOME" and the time in PT', / @ /.test(R.mu) && /\d:\d\d [AP]M PT/.test(R.mu), R.mu);
check('model chance at the line = engine.playerP(pl, 15)', R.chance.startsWith(String(Math.round(eng.p15 * 100))), `${R.chance} vs ${eng.p15}`);
check('fair odds from the model chance', R.odds.trim() === await page.evaluate(p => SB.ui.fair(p), eng.p15), R.odds);
check('projection = engine.playerMeans blend (normal game / blowout)', R.proj.startsWith(f1(eng.proj)), `${R.proj} vs ${eng.proj}`);
const vNo = eng.p15 >= 0.7 ? 'Strong lean' : eng.p15 >= 0.58 ? 'Lean' : eng.p15 >= 0.45 ? 'Coin flip' : 'Long shot';
check('verdict without a price follows the spec bands, tagged "Model estimate"', R.verdict === vNo && R.tag === 'Model estimate' && !/your price/.test(R.vk), `${R.verdict} (${eng.p15.toFixed(3)})`);

// ---------- Over / Under ----------
await page.locator('[data-ui-seg="pa-ou|under"]').click();
R = await read();
const sumOU = await page.evaluate(pk => [0.5, 3.5, 14.5, 19.5, 27.5, 40.5].map(L => __propan.chance(pk, 'pts', L, false) + __propan.chance(pk, 'pts', L, true)), subj.pk);
check('Under: chance = 1 − over at the same line', R.chance.startsWith(String(Math.round((1 - eng.p15) * 100))) && /Under 14\.5/.test(R.mk) && /14 or fewer/.test(R.meaning), `${R.chance} ${R.mk}`);
check('over + under = 1 at every half-point line', sumOU.every(s => Math.abs(s - 1) < 1e-12), sumOU.join(','));
const ulog = await page.evaluate(() => [...document.querySelectorAll('[data-pa-log] .ui-log .b')].map(b => [+b.querySelector('.v').textContent, b.className]));
check('Under: game-log bars are green when the under won', ulog.length > 0 && ulog.every(([v, c]) => (v < 14.5 ? / hit/.test(c) : / miss/.test(c))), JSON.stringify(ulog));
await page.locator('[data-ui-seg="pa-ou|over"]').click();

// ---------- the line stepper ----------
await page.locator('[data-pa-step="1"]').click();
R = await read();
check('+ raises the line by 1 (15.5) and the over chance = playerP(16)', R.line === '15.5' && R.chance.startsWith(String(Math.round(eng.p16 * 100))) && eng.p16 <= eng.p15, `${R.line} ${R.chance}`);
await page.locator('[data-pa-step="-1"]').click();
await page.locator('[data-pa-step="-1"]').click();
R = await read();
check('− lowers it (13.5) and the over chance = playerP(14)', R.line === '13.5' && R.chance.startsWith(String(Math.round(eng.p14 * 100))), `${R.line} ${R.chance}`);
await page.fill('#pa-line', '20');
await page.press('#pa-line', 'Enter');
R = await read();
check('typing a whole number 20 gives 19.5 (20 or more)', R.line === '19.5' && R.chance.startsWith(String(Math.round(eng.p20 * 100))), `${R.line} ${R.chance}`);
await page.fill('#pa-line', '20.3');
await page.press('#pa-line', 'Enter');
R = await read();
check('a fractional line rounds to its half point (20.3 -> 20.5, 21 or more)', R.line === '20.5' && R.chance.startsWith(String(Math.round(eng.p21 * 100))), `${R.line} ${R.chance}`);

// ---------- ladder ----------
const lad = await page.evaluate(() => [...document.querySelectorAll('[data-pa-ladder] tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
const ladOk = eng.lad.every((t, i) => { const r = lad.find(x => x[0].startsWith(String(t - 0.5))); return r && r[1] === Math.round(eng.ladder[i] * 100) + '%' && r[3] === Math.round((1 - eng.ladder[i]) * 100) + '%'; });
check('ladder: every LADDER line with over chance, fair odds and under chance', ladOk && lad.length === eng.lad.length + 1, JSON.stringify(lad.slice(0, 3)));
check('ladder: the current line (20.5, off the ladder) is marked', await page.evaluate(() => !!document.querySelector('[data-pa-ladder] tr.cur [data-pa-line="20.5"]')));
await page.locator('[data-pa-line="14.5"]').click();
R = await read();
check('tapping a ladder line uses it', R.line === '14.5' && R.chance.startsWith(String(Math.round(eng.p15 * 100))), R.line);
// a typed line fires 'change' on mousedown of the next click: the redraw must not swallow that click or pull focus back
await page.fill('#pa-line', '18');
await page.locator('[data-ui-seg="pa-ou|under"]').click();
await page.waitForTimeout(50);
R = await read();
check('type a line, then click Under: both apply (the click is not lost to the redraw)', R.line === '17.5' && /Under 17\.5/.test(R.mk), `${R.line} ${R.mk}`);
await page.locator('[data-ui-seg="pa-ou|over"]').click();
await page.fill('#pa-line', '22');
await page.keyboard.press('Tab');
await page.waitForTimeout(50);
const fA = await page.evaluate(() => ({ line: document.getElementById('pa-line').value, f: document.activeElement && document.activeElement.getAttribute('data-pa-step') }));
check('type a line, then Tab: the line applies and focus moves on to + (not back into the box)', fA.line === '21.5' && fA.f === '1', JSON.stringify(fA));
await page.locator('[data-pa-line="14.5"]').click();

// ---------- game log, splits, factors (vs the fixture box scores) ----------
const fx = fixtureVals('nba', subj.name, subj.team, 'pts', subj.day);
const last10 = fx.vals.slice(-10);
const bars = await page.evaluate(() => [...document.querySelectorAll('[data-pa-log] .ui-log .b .v')].map(v => +v.textContent));
const sum = await page.evaluate(() => document.querySelector('[data-pa-log] .ui-loghead b').textContent);
check('game log: his last 10 games from the fixture box scores, oldest first', JSON.stringify(bars) === JSON.stringify(last10), `${bars} vs ${last10}`);
check('game log summary: "h of n over 14.5"', sum === `${last10.filter(v => v > 14.5).length} of ${last10.length} over 14.5`, sum);
const gl = await page.evaluate(() => [...document.querySelectorAll('[data-pa-log] .ui-log .b')].map(b => [b.getBoundingClientRect().width, b.querySelector('.bar').getBoundingClientRect().width, getComputedStyle(b.querySelector('.bar')).marginBottom]));
check('game log at 390 px: every game gets the same column and a solid bar (the app\'s older .hit / .bar rules are undone)', gl.length > 0 && Math.max(...gl.map(x => x[0])) - Math.min(...gl.map(x => x[0])) < 1 && gl.every(x => x[1] >= 12 && x[2] === '0px'), JSON.stringify(gl.map(x => [Math.round(x[0]), Math.round(x[1])])));
const splits = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-pa-split]')].map(d => [d.getAttribute('data-pa-split'), d.innerText.replace(/\n/g, ' | ')])));
const l5 = fx.vals.slice(-5), l5avg = l5.reduce((a, b) => a + b, 0) / l5.length;
check('split "Last 5": average and hits from the fixture, with its sample size', splits['Last 5'] && splits['Last 5'].includes(f1(l5avg)) && splits['Last 5'].includes(`${l5.filter(v => v > 14.5).length} of 5 over 14.5`) && /5 games/.test(splits['Last 5']), splits['Last 5']);
const P = fx.P, trunc = P && P.gp > P.log.length;
const seasonAvg = P ? P.tot[SEASON.sports.nba.fields.indexOf('pts')] / P.gp : null;
check('split "Season": season totals ÷ games when the file keeps only his last 15', !P || (trunc ? splits.Season.includes(f1(seasonAvg)) && splits.Season.includes(`${P.gp} games`) && splits[`Last ${fx.vals.length}`] : !!splits.Season), JSON.stringify(splits.Season));
check('splits: home / away with their sample sizes', ['Home', 'Away'].every(k => !splits[k] || / games?/.test(splits[k])) && (!!splits.Home || !!splits.Away));
const fac = await page.evaluate(() => [...document.querySelectorAll('.pa-root .ui-factor')].map(d => [d.querySelector('b').textContent, d.querySelector('.st').textContent, d.querySelector('p').textContent]));
check('factors: Matchup, Trends, Game script, Usage, each with numbers in "why"', fac.map(f => f[0]).join(',') === 'Matchup,Trends,Game script,Usage' && fac.slice(1).every(f => /\d/.test(f[2])), fac.map(f => f[0] + ':' + f[1]).join(' · '));
check('unpriced game: Matchup says Unknown (the feed has no price)', fac[0][1] === 'Unknown' && /no price/i.test(fac[0][2]));
const t1 = await page.locator('.pa-root').innerText();
check('notes: sample size, source, the half-point rule, fair odds not a book price', /Recent games: \d+ from ESPN box scores/.test(t1) && /over 14\.5 means 15 or more/.test(t1) && /not a book's price/.test(t1));
check('no horizontal scroll at 390 px (analysis)', await noScroll(page));

// ---------- back-to-back: last night's game is logged under today's UTC date and must count ----------
{
  const b2b = await page.evaluate(() => { const p = __propan.slate().list.find(x => x.name === 'Pascal Siakam' && x.stats.pts); return p ? { id: p.stats.pts.id, team: p.team, la: SB.engine.dayOf(p.start), utc: new Date(p.start).toISOString().slice(0, 10) } : null; });
  if (b2b) {
    await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), b2b.id);
    await page.waitForSelector('.pa-root[data-pa="prop"]');
    const fxb = fixtureVals('nba', 'Pascal Siakam', b2b.team, 'pts', b2b.utc).vals.slice(-10);
    const P = SEASON.sports.nba.players.find(x => x.n === 'Pascal Siakam'), last = P.log.find(r => r[0] === '2026-11-23');
    const barsB = await page.evaluate(() => [...document.querySelectorAll('[data-pa-log] .ui-log .b .v')].map(v => +v.textContent));
    check('back-to-back (IND, played Nov 22 PT, logged 2026-11-23): that game is in the log (cut at the priced game\'s UTC date, not the LA day)', b2b.la === '2026-11-23' && b2b.utc === '2026-11-24' && !!last && barsB[barsB.length - 1] === last[3 + SEASON.sports.nba.fields.indexOf('pts')] && JSON.stringify(barsB) === JSON.stringify(fxb), `${barsB} vs ${fxb}`);
  } else check('the fixture slate has Pascal Siakam (IND back-to-back)', false);
  await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
  await page.waitForSelector('.pa-root[data-pa="prop"]');
}

// ---------- your price -> edge ----------
await page.fill('#pa-price', '-110');
await page.press('#pa-price', 'Enter');
await page.waitForTimeout(150);
R = await read();
const dec = await page.evaluate(() => SB.parseOdds('-110', 'american'));
const edge = (eng.p15 - 1 / dec) * 100, sg = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1);
const vPrice = edge >= 3 && eng.p15 >= 0.5 ? 'Take this bet' : edge >= 0 ? 'Lean' : 'Pass';
const tiles = await page.evaluate(() => [...document.querySelectorAll('.pa-px .ui-tile')].map(t => t.innerText.replace(/\n/g, ' ')));
check('price -110: edge = model − implied, in points', tiles.some(t => t === `EDGE ${sg(edge)} pts` || t === `Edge ${sg(edge)} pts`) && tiles.some(t => /52\.4%/.test(t)), tiles.join(' · '));
check('price -110: verdict vs your price per the spec', R.verdict === vPrice && /vs your price/.test(R.vk), `${R.verdict} edge ${edge.toFixed(1)}`);
const vtxt = await page.locator('.pa-verd p').innerText();
check('price -110: the verdict line names the implied chance and the edge', vtxt.includes('52.4%') && vtxt.includes(sg(edge)), vtxt);
check('a big edge (10+ pts) carries a caution that the model may be missing news', edge >= 10 ? /rare against a real book/.test(vtxt) : !/rare against a real book/.test(vtxt), `edge ${edge.toFixed(1)}`);
await page.fill('#pa-price', '-125');
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(450);
const fP = await page.evaluate(() => ({ f: document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('data-ui-seg')), tiles: [...document.querySelectorAll('.pa-px .ui-tile')].map(t => t.innerText.replace(/\n/g, ' ')).join(' · ') }));
check('a typed price redraws without pulling focus back into the box once the viewer has moved on', fP.f === 'pa-ou|under' && /-125/.test(fP.tiles), JSON.stringify(fP));
await page.fill('#pa-price', '50');
await page.press('#pa-price', 'Enter');
const b50 = await page.evaluate(() => ({ tiles: [...document.querySelectorAll('.pa-px .ui-tile')].map(t => t.innerText.replace(/\n/g, ' ')).join(' · '), v: document.querySelector('.ui-verdict .t').textContent }));
check('a bare "50" is not read as a price (not valid American odds; was read as decimal 50.0)', /not read/i.test(b50.tiles) && b50.v === vNo, JSON.stringify(b50));
await page.fill('#pa-price', '-2000');
await page.waitForTimeout(600);
R = await read();
check('price -2000 (95% implied): Pass', R.verdict === 'Pass', R.verdict);
check('typing the price keeps focus in the box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'pa-price'));
await page.fill('#pa-price', '');
await page.press('#pa-price', 'Enter');

// ---------- + Slip (over and under keys) ----------
await page.evaluate(() => SB.setSlip([]));
await page.locator('[data-pa-slip]').click();
let slip = await page.evaluate(() => SB.slip.map(l => l.gid + '|' + l.key));
check('+ Slip adds the over key P:<id>:15 for over 14.5', slip.length === 1 && slip[0] === `${subj.gid}|P:${subj.id}:15`, slip.join(','));
check('+ Slip button turns into "In slip"', /In slip/.test(await page.locator('[data-pa-slip]').innerText()));
await page.locator('[data-pa-slip]').click();
await page.locator('[data-ui-seg="pa-ou|under"]').click();
await page.locator('[data-pa-slip]').click();
slip = await page.evaluate(() => SB.slip.map(l => l.key));
const uInfo = await page.evaluate(k => SB.engine.pLegInfo(k).p, `U:${subj.id}:14.5`);
check('under: + Slip adds U:<id>:14.5, priced by the engine as 1 − P(15+)', slip.length === 1 && slip[0] === `U:${subj.id}:14.5` && Math.abs(uInfo - (1 - eng.p15)) < 1e-12, slip.join(','));
await page.evaluate(() => SB.setSlip([]));
await page.locator('[data-ui-seg="pa-ou|over"]').click();

// ---------- market select ----------
const mk = await page.evaluate(() => [...document.querySelectorAll('select[data-ui-select="pa-mkt"] option')].map(o => o.value));
if (mk.includes('reb')) {
  await page.selectOption('select[data-ui-select="pa-mkt"]', 'reb');
  const r2 = await page.evaluate(pk => { const p = __propan.slate().people.get(pk), pl = p.stats.reb, E = SB.engine; const rows = E.LADDER.reb.map(t => ({ t, p: E.playerP(pl, t) })), inR = rows.filter(r => r.p >= .5 && r.p <= .97); const b = (inR.length ? inR : rows).reduce((a, x) => (Math.abs(x.p - .65) < Math.abs(a.p - .65) ? x : a)); return { line: document.getElementById('pa-line').value, want: String(b.t - .5), ch: document.querySelector('[data-pa-chance]').textContent, p: b.p, mk: document.querySelector('.pa-mk .t').textContent }; }, subj.pk);
  check('market select: Rebounds at the ladder line nearest 65%', r2.line === r2.want && r2.ch.startsWith(String(Math.round(r2.p * 100))) && /Rebounds/.test(r2.mk), JSON.stringify(r2));
} else check('market select lists his stats', mk.length >= 1, mk.join(','));

// ---------- search ----------
await page.locator('[data-pa-clear]').click();
check('clear (✕) goes back to the top props', await page.evaluate(() => document.querySelector('.pa-root').getAttribute('data-pa') === 'empty'));
const pick = await page.evaluate(() => { const p = __propan.slate().list.find(x => x.sp === 'ncaaf' && SB.priced(x.g) && Object.keys(x.stats).length); return { name: p.name, pk: p.pk, team: p.team, gid: p.gid }; });
await page.locator('#pa-q').click();
await page.keyboard.type(pick.name.split(' ').slice(-1)[0].slice(0, 6));
await page.waitForSelector('#pa-sug:not([hidden]) .pa-opt');
const sug = await page.evaluate(() => [...document.querySelectorAll('#pa-sug .pa-opt b')].map(b => b.textContent));
check('search suggests players on the slate', sug.includes(pick.name), sug.join(', '));
await page.locator(`#pa-sug .pa-opt[data-pa-pick="${pick.pk}"]`).click();
await page.waitForSelector('.pa-root[data-pa="prop"]');
check('picking a suggestion opens that player', (await page.locator('.pa-nm').innerText()) === pick.name);
const mf = await page.evaluate(() => [...document.querySelectorAll('.pa-root .ui-factor')].map(d => [d.querySelector('.st').textContent, d.querySelector('p').textContent])[0]);
const muWant = await page.evaluate(([gid, team]) => { const c = SB.engine.teamCtx(SB.gameById(gid), team); return Math.round(Math.max(0, Math.min(100, 50 + 250 * (c.tf - 1) - 60 * Math.max(0, c.pb - .15)))); }, [pick.gid, pick.team]);
check('priced game: Matchup factor shows the 0-100 score from the spec formula', /Soft matchup|Tough|Neutral/.test(mf[0]) && mf[1].includes(`Matchup score ${muWant} of 100`), mf.join(' | '));
// keyboard: arrows + Enter in the search box
await page.locator('[data-pa-clear]').click();
await page.locator('#pa-q').click();
await page.keyboard.type(subj.name.slice(0, 5));
await page.keyboard.press('Enter');
await page.waitForSelector('.pa-root[data-pa="prop"]');
check('Enter in the search box opens the first suggestion', (await page.locator('.pa-nm').innerText()).length > 0);

// ---------- params {name, stat: 'td'} (NFL anytime TD) ----------
const td = await page.evaluate(() => { const p = __propan.slate().list.find(x => x.td && SB.p1(x.g, x.td.key) > 0.3); return p ? { name: p.name, team: p.team, gid: p.gid, key: p.td.key, p: SB.p1(p.g, p.td.key) } : null; });
if (td) {
  await page.evaluate(o => SB.goTab('propan', { name: o.name, stat: 'td', team: o.team, gid: o.gid }), td);
  await page.waitForSelector('.pa-root[data-pa="prop"]');
  const T = await page.evaluate(() => ({ mkt: document.querySelector('select[data-ui-select="pa-mkt"]').value, ch: document.querySelector('[data-pa-chance]').textContent, dis: document.getElementById('pa-line').disabled, name: document.querySelector('.pa-nm').textContent, slip: document.querySelector('[data-pa-slip]').getAttribute('data-pa-slip') }));
  check('params {name, stat: "td"}: anytime TD at the First TD model\'s chance, line fixed at 0.5', T.mkt === 'td' && T.name === td.name && T.ch.startsWith(String(Math.round(td.p * 100))) && T.dis, JSON.stringify(T));
  check('anytime TD: + Slip uses the TD:A key', T.slip === `${td.gid}|${td.key}`, T.slip);
} else check('an NFL anytime-TD player is on the fixture slate', false);

// ---------- params that miss ----------
await page.evaluate(() => SB.goTab('propan', { name: 'Nobody McFakename', stat: 'pts' }));
check('a name not on the slate shows a notice and the top props', /has no prop on the slate/.test(await page.locator('.pa-root').innerText()) && (await page.locator('.pa-trow').count()) === 8);

// ---------- Ask about this / Player page ----------
await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
await page.waitForSelector('.pa-root[data-pa="prop"]');
await page.locator('[data-pa-ask]').click();
await page.waitForTimeout(200);
const ask = await page.evaluate(() => ({ tab: SB.tab, draft: (document.querySelector('.ask-input') || {}).value || '' }));
check('Ask about this: opens Chat with the question in the box', ask.tab === 'ask' && ask.draft.includes(subj.name) && /over 14\.5 points/.test(ask.draft), JSON.stringify(ask));
await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
await page.waitForSelector('.pa-root[data-pa="prop"]');
await page.locator('[data-pa-player]').click();
await page.waitForTimeout(400);
const pp = await page.evaluate(() => ({ tab: SB.tab, title: (document.querySelector('.pl-root .ui-title') || {}).textContent || '' }));
check('Player page: opens Players on his page', pp.tab === 'players' && pp.title.replace(/\s+/g, ' ').toLowerCase().includes(subj.name.split(' ').slice(-1)[0].toLowerCase()), JSON.stringify(pp));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();

// ======================= 1440 px: two columns, no horizontal scroll =======================
{
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'propan' });
  await page.waitForFunction(() => window.__propan && __propan.seasonState === 'ok', null, { timeout: 20000 });
  await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
  await page.waitForSelector('.pa-root[data-pa="prop"]');
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.pa-grid')).gridTemplateColumns.split(' ').length);
  check('1440 px: analysis in two columns', cols === 2, String(cols));
  check('1440 px: no horizontal scroll', await noScroll(page));
  check('1440 px: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ======================= season.json and injuries.json missing =======================
{
  const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'propan', pins: { 'season.json': null, 'injuries.json': null } });
  const cerr = []; page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) cerr.push(m.text().slice(0, 160)); });
  await page.waitForFunction(() => window.__propan && __propan.seasonState === 'none', null, { timeout: 20000 });
  await page.waitForTimeout(200);
  check('season.json missing: the empty state still lists props', (await page.locator('.pa-trow').count()) > 0);
  check('season.json missing: says the box scores are unavailable', /box scores unavailable/.test(await page.locator('.pa-root').innerText()));
  await page.evaluate(id => SB.goTab('propan', { id, line: 15 }), subj.id);
  await page.waitForSelector('.pa-root[data-pa="prop"]');
  const ch = await page.evaluate(() => document.querySelector('[data-pa-chance]').textContent);
  check('season.json missing: the analysis still prices the prop', ch.startsWith(String(Math.round(eng.p15 * 100))), ch);
  const lg = await page.evaluate(() => [...document.querySelectorAll('[data-pa-log] .ui-log .b .v')].length);
  check('season.json missing: NBA game log falls back to the last-4 box scores / morning form', lg >= 3 && lg <= 5, String(lg));
  check('season.json missing: no page errors, no horizontal scroll', errors.length === 0 && await noScroll(page), errors.join(' | '));
  check('injuries.json missing: the screen still draws (it crashed with "could not load" before)', !/could not load/.test(await page.locator('#main').innerText()) && cerr.length === 0, cerr.join(' | '));
  await browser.close();
}
await done(null);
