// Insights (the daily prop-card board) and Prop Explorer (the heat table), insights.js. Fixtures pinned, clock 2026-11-23T12:00Z.
// Run: node tests/insights.test.mjs
import { open, check, done, FX } from './lib/harness.mjs';

const nameKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SEASON = JSON.parse(FX('season-2026-11-23.json'));
const L4 = JSON.parse(FX('nbalast4-2026-11-23b.json'));
const DAY = '2026-11-23';
// his games before the day, oldest first, straight from the fixture logs (NBA: season log joined with the last-4 box scores)
function fixtureVals(sp, name, feedTeam, stat) {
  const S = SEASON.sports[sp], fi = f => 3 + S.fields.indexOf(f);
  let c = S.players.filter(p => nameKey(p.n) === nameKey(name));
  if (c.length > 1) c = c.filter(p => p.t === feedTeam);
  const by = new Map();
  if (c.length === 1) for (const r of c[0].log) if (r[0] < DAY) by.set(r[0], stat === 'td' ? (r[fi('rtd')] || 0) + (r[fi('ctd')] || 0) : r[fi(stat)]);
  if (sp === 'nba' && L4.teams[feedTeam]) for (const g of L4.teams[feedTeam].games) {
    const e = Object.entries(g.players).find(([n]) => nameKey(n) === nameKey(name));
    if (e && !e[1].dnp && g.date < DAY && !by.has(g.date)) by.set(g.date, e[1][stat]);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(x => x[1]);
}

const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'insights' });
await page.waitForFunction(() => window.__insights && __insights.seasonState === 'ok' && document.querySelectorAll('.ins-root .ui-prop').length > 0, null, { timeout: 20000 });
await page.waitForTimeout(300);

// ---------- first render and the honest labels ----------
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${Math.round(fr)} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a re-render (board cached per DATA) stays fast', rr < 400, `${Math.round(rr)} ms`);
const txt = await page.locator('.ins-root').innerText();
check('header: kicker and display title', /MODEL PICKS & PROP BOARD/i.test(txt) && /PROP BOARD/i.test(await page.locator('.ins-root .ui-title').innerText()));
check('honest line: no sportsbook prop prices, model chance + fair odds, bet only at that price or better',
  /No sportsbook prop prices/.test(txt) && /fair odds/.test(txt) && /bet only at that price or better/.test(txt) && /small sample/.test(txt));
check('no certainty words on the board', !/guarantee|\block\b|sure thing|can't lose|\bdue\b/i.test(txt));

// ---------- cards: NBA ----------
const nCards = await page.locator('.ins-root .ui-prop').count();
check('24 cards before "Show more"', nCards === 24 && await page.locator('[data-ins-more]').count() === 1, `${nCards}`);
const nba = page.locator('.ins-root .ui-prop[data-sport="nba"]').first();
const F = await nba.evaluate(c => {
  const f = c.querySelector('.front'), q = s => (f.querySelector(s) || {}).textContent || '';
  return { key: c.getAttribute('data-key'), id: c.getAttribute('data-ui-card'), fn: q('.fn'), ln: q('.ln'), pos: q('.pos'), mu: q('.mu'), mkt: q('.mkt .t'), odds: q('.odds'), pay: q('.pay'),
    hitBig: f.querySelectorAll('.st2 .ui-big')[0].textContent, hitLbl: f.querySelectorAll('.st2 .ui-muted')[0].textContent, dots: f.querySelectorAll('.st2 .ui-dots i').length,
    muBig: f.querySelectorAll('.st2 .ui-big')[1].textContent, muLbl: f.querySelectorAll('.st2 .ui-muted')[1].textContent, strip: f.querySelectorAll('.ins-l5 .g > span').length };
});
const info = await page.evaluate(k => { const i = SB.engine.pLegInfo(k); const g = SB.gameById(i.pl.gid); return { name: i.pl.name, team: i.pl.team, stat: i.pl.stat, thr: i.thr, p: i.p, away: g.away.abbr, home: g.home.abbr, legs: SB.engine.playerLegs(i.pl).map(x => x.p) }; }, F.key);
check('NBA card: first / last name split, position badge, "AWAY @ HOME" and the time',
  `${F.fn} ${F.ln}` === info.name && /^[GFC]/.test(F.pos) && F.mu.includes(`${info.away} @ ${info.home}`) && /\d:\d\d [AP]M PT/.test(F.mu), `${F.fn}|${F.ln}|${F.pos}|${F.mu}`);
check('NBA card: market "N+ Points/Rebounds/Assists" at the ladder line nearest 65%',
  new RegExp(`^${info.thr}\\+ (Points|Rebounds|Assists)$`).test(F.mkt.trim()) && Math.abs(info.p - .65) <= Math.min(...info.legs.map(p => Math.abs(p - .65))) + 1e-9, F.mkt);
const fairTxt = await page.evaluate(p => SB.ui.fair(p), info.p);
check('NBA card: fair odds from the model chance, and "$100 pays $X at fair odds"',
  F.odds.trim() === fairTxt && F.pay.includes(`Model chance ${Math.round(info.p * 100)}%`) && F.pay.includes(`$100 pays $${Math.round(100 / info.p)} at fair odds`), `${F.odds} · ${F.pay}`);
const nbaVals = fixtureVals('nba', info.name, info.team, info.stat).slice(-5);
const nbaHits = nbaVals.filter(v => v >= info.thr).length;
check('NBA hit rate matches the fixture box scores (season log + last 4) against this line',
  F.hitLbl === `L${nbaVals.length} · ${nbaHits} of ${nbaVals.length}` + (nbaVals.length < 5 ? ' (few games)' : '') && F.dots === nbaVals.length && F.strip === nbaVals.length &&
  F.hitBig.startsWith(String(Math.round(nbaHits / nbaVals.length * 100))), `${info.name} ${info.thr}+ ${info.stat}: [${nbaVals}] -> ${F.hitLbl}`);
check('matchup: "—" with "No game price yet" when the game has no price (fixture NBA games are unpriced)',
  (await page.evaluate(gid => SB.priced(SB.gameById(gid)), F.id.split('|')[0])) ? /^\d+$/.test(F.muBig) : F.muBig.trim() === '—' && /No game price/.test(F.muLbl), `${F.muBig} ${F.muLbl}`);

// ---------- flip ----------
await nba.locator('.front [data-ui-flip]').click();
await page.waitForTimeout(150);
const fl = await nba.evaluate(c => ({ flip: c.classList.contains('flip'), fi: c.querySelector('.front').inert, bi: c.querySelector('.back').inert, rows: [...c.querySelectorAll('.back .rows span')].map(s => s.textContent), note: (c.querySelector('.back .note') || {}).textContent || '' }));
check('flip: shows the back, the front goes inert', fl.flip && fl.fi === true && fl.bi === false);
check('back: projection, season avg, last-5 avg, ladder, team points, blowout risk, injury report and a note',
  ['Projection', 'Season avg', 'Last 5 avg', 'Ladder', 'Team points', 'Blowout risk', 'Injury report'].every(k => fl.rows.includes(k)) && fl.note.length > 20, fl.rows.join(','));
const ladder = await nba.evaluate(c => [...c.querySelectorAll('.back .rows div')].find(d => d.querySelector('span').textContent === 'Ladder').querySelector('b').textContent);
check('back: three ladder lines with chances, including this line', (ladder.match(/\d+\+ \d+%/g) || []).length === 3 && ladder.includes(`${info.thr}+ ${Math.round(info.p * 100)}%`), ladder);
await nba.locator('.back [data-ui-flip]').click();
await page.waitForTimeout(150);
check('flip back: the back goes inert again', await nba.evaluate(c => !c.classList.contains('flip') && c.querySelector('.back').inert && !c.querySelector('.front').inert));

// ---------- + Slip and Analyze ----------
await page.evaluate(() => SB.setSlip([]));
await nba.locator('.front [data-ins-slip]').click();
const sl = await page.evaluate(id => ({ slip: SB.slip.map(l => l.gid + '|' + l.key), btn: [...document.querySelectorAll(`[data-ins-slip="${CSS.escape(id)}"]`)].map(b => [b.textContent, b.getAttribute('aria-pressed')]) }), F.id);
check('+ Slip adds this card\'s leg (gid|key) to the slip', sl.slip.length === 1 && sl.slip[0] === F.id, sl.slip.join(','));
check('+ Slip shows the added state on both faces', sl.btn.length === 2 && sl.btn.every(([t, a]) => t === '✓ In slip' && a === 'true'), JSON.stringify(sl.btn));
await nba.locator('.front [data-ins-slip]').click();
check('pressing it again removes the leg', (await page.evaluate(() => SB.slip.length)) === 0);
await page.evaluate(() => { window.__go = []; window.__realGo = SB.goTab; SB.goTab = (k, p) => { __go.push([k, p]); }; });
await nba.locator('.front [data-ins-an]').click();
const go = await page.evaluate(() => __go.slice());
check('Analyze opens the Prop Analyzer with {id, line}', go.length === 1 && go[0][0] === 'propan' && go[0][1].id === F.key.split(':')[1] && go[0][1].line === info.thr, JSON.stringify(go));
await page.evaluate(() => { SB.goTab = __realGo; });

// ---------- sorting ----------
const pays = () => page.$$eval('.ins-root .ui-prop .front .pay', a => a.map(x => +(/Model chance (\d+)%/.exec(x.textContent) || [0, -1])[1]));
const nonInc = a => a.every((v, i) => i === 0 || a[i - 1] >= v), nonDec = a => a.every((v, i) => i === 0 || a[i - 1] <= v);
check('sort "Model chance": chances never go up down the board', nonInc(await pays()));
await page.selectOption('select[data-ui-select="ins-sort"]', 'hit');
const hitPct = await page.$$eval('.ins-root .ui-prop .front .st2 > div:first-child .ui-big', a => a.map(x => parseInt(x.textContent, 10)).filter(Number.isFinite));
check('sort "Hit rate": hit rates never go up', hitPct.length >= 20 && nonInc(hitPct), hitPct.slice(0, 8).join(','));
check('keyboard focus stays on the select after the redraw', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-ui-select') === 'ins-sort'));
await page.selectOption('select[data-ui-select="ins-sort"]', 'time');
const starts = await page.$$eval('.ins-root .ui-prop', a => a.map(c => __insights.board().byId.get(c.getAttribute('data-ui-card')).start));
check('sort "Tip-off": earliest games first', starts.length && nonDec(starts));
await page.selectOption('select[data-ui-select="ins-sort"]', 'p');

// ---------- filters: NFL (yards, receptions, anytime TDs) ----------
const nflN = +(await page.locator('[data-ui-pill="ins-sport|nfl"] .n').innerText());
await page.click('[data-ui-pill="ins-sport|nfl"]');
while (await page.locator('[data-ins-more]').count()) await page.click('[data-ins-more]');
const nflSports = await page.$$eval('.ins-root .ui-prop', a => a.map(c => c.getAttribute('data-sport')));
check('sport pill NFL: only NFL cards, as many as its count', nflSports.length === nflN && nflSports.every(s => s === 'nfl'), `${nflSports.length} of ${nflN}`);
const td = page.locator('.ins-root .ui-prop[data-key^="TD:A:"]').first();
const T = await td.evaluate(c => { const f = c.querySelector('.front'); return { key: c.getAttribute('data-key'), id: c.getAttribute('data-ui-card'), mkt: f.querySelector('.mkt .t').textContent, pay: f.querySelector('.pay').textContent, lbl: f.querySelectorAll('.st2 .ui-muted')[0].textContent, name: f.querySelector('.fn').textContent + ' ' + f.querySelector('.ln').textContent, pos: (f.querySelector('.pos') || {}).textContent }; });
const tdP = await page.evaluate(id => { const i = id.indexOf('|'); return SB.p1(SB.gameById(id.slice(0, i)), id.slice(i + 1)); }, T.id);
check('NFL anytime TD card: "Yes Anytime TD", chance via SB.p1, position badge', T.mkt.trim() === 'Yes Anytime TD' && T.pay.includes(`Model chance ${Math.round(tdP * 100)}%`) && /^(QB|RB|WR|TE)$/.test(T.pos), `${T.name} ${T.mkt} ${T.pay}`);
const tdVals = fixtureVals('nfl', T.name, T.key.split(':')[2], 'td').slice(-5), tdHits = tdVals.filter(v => v >= 1).length;
check('TD hit rate = games with a rushing or receiving TD in his last 5 (fixture logs)', T.lbl === `L${tdVals.length} · ${tdHits} of ${tdVals.length}` + (tdVals.length < 5 ? ' (few games)' : ''), `${T.name}: [${tdVals}] -> ${T.lbl}`);
const yd = page.locator('.ins-root .ui-prop[data-key^="P:"]').first();
const Y = await yd.evaluate(c => ({ key: c.getAttribute('data-key'), lbl: c.querySelectorAll('.front .st2 .ui-muted')[0].textContent }));
const yi = await page.evaluate(k => { const i = SB.engine.pLegInfo(k); return { name: i.pl.name, team: i.pl.team, stat: i.pl.stat, thr: i.thr }; }, Y.key);
const yv = fixtureVals('nfl', yi.name, yi.team, yi.stat).slice(-5), yh = yv.filter(v => v >= yi.thr).length;
check('NFL yards / receptions hit rate matches the fixture season log', yv.length > 0 && Y.lbl === `L${yv.length} · ${yh} of ${yv.length}` + (yv.length < 5 ? ' (few games)' : ''), `${yi.name} ${yi.thr}+ ${yi.stat}: [${yv}] -> ${Y.lbl}`);
await page.click('[data-ui-pill="ins-sport|all"]');

// ---------- params and the next day ----------
await page.evaluate(() => SB.goTab('insights', { sport: 'nfl' }));
await page.waitForTimeout(100);
check('goTab("insights", {sport: "nfl"}) opens on NFL', await page.locator('[data-ui-pill="ins-sport|nfl"].on').count() === 1 && (await page.$$eval('.ins-root .ui-prop', a => a.every(c => c.getAttribute('data-sport') === 'nfl'))));
await page.evaluate(() => SB.goTab('insights', {}));
await page.selectOption('select[data-ui-select="ins-day"]', 'tomorrow');
await page.waitForTimeout(100);
check('Tomorrow on NFL (none in the fixture): an empty state with "Show all sports"', /No NFL player props tomorrow/.test(await page.locator('.ins-root .ui-empty').innerText()) && await page.locator('.ins-root .ui-empty ~ .ins-more [data-ui-pill="ins-sport|all"]').count() === 1);
await page.click('.ins-root .ins-more [data-ui-pill="ins-sport|all"]');
await page.waitForTimeout(100);
const tm = await page.evaluate(() => {
  const B = __insights.board(__insights.dayKey('tomorrow'));
  const it = [...document.querySelectorAll('.ins-root .ui-prop')].map(c => B.byId.get(c.getAttribute('data-ui-card'))).find(x => x && x.mu);
  if (!it) return null;
  const c = SB.engine.teamCtx(it.g, it.team), want = Math.round(Math.max(0, Math.min(100, 50 + 250 * (c.tf - 1) - 60 * Math.max(0, c.pb - 0.15))));
  const card = document.querySelector(`.ui-prop[data-ui-card="${CSS.escape(it.id)}"]`);
  return { want, got: it.mu.s, label: it.mu.label, shown: card ? card.querySelectorAll('.front .st2 .ui-big')[1].textContent : null, sports: [...new Set(B.items.map(x => x.sp))] };
});
check('Tomorrow: priced games get a matchup score from the spec formula, with its label', tm && tm.want === tm.got && tm.shown === String(tm.got) && /Soft matchup|Neutral|Tough/.test(tm.label), JSON.stringify(tm));
await page.selectOption('select[data-ui-select="ins-day"]', 'today');
check('no horizontal page scroll at 390px (Insights)', await page.evaluate(() => document.documentElement.scrollWidth <= 390));
const small = await page.$$eval('.ins-root button, .ins-root .ui-sel', a => a.filter(b => b.offsetParent && !b.closest('th') && !b.closest('[inert]') && b.getBoundingClientRect().height < 40).map(b => b.className + ':' + Math.round(b.getBoundingClientRect().height)));
check('tap targets 40px+ (Insights)', small.length === 0, small.slice(0, 5).join(' '));

// ---------- Prop Explorer ----------
await page.evaluate(() => SB.goTab('explorer', {}));
await page.waitForSelector('.ins-root[data-ins="explorer"] .ui-table');
const ex = await page.evaluate(() => ({ rows: document.querySelectorAll('.ins-root .ui-table tbody tr').length, heads: [...document.querySelectorAll('.ins-root .ui-table th')].map(t => t.textContent.replace(/[↓↑]/g, '').trim()), seg: [...document.querySelectorAll('.ins-root [data-ui-seg]')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')) }));
check('explorer: 25 rows and the columns from the spec', ex.rows === 25 && ['Player', 'Game', 'Market', 'Line', 'Model %', 'Fair odds', 'Hit L5 · L10', 'Avg L5', 'Season avg', 'Matchup'].every(h => ex.heads.includes(h)), ex.heads.join('|'));
check('explorer: HIT % / MATCHUP seg, HIT % on by default', ex.seg.join(',') === 'Hit %*,Matchup', ex.seg.join(','));
const colVals = async label => page.evaluate(l => { const i = [...document.querySelectorAll('.ins-root .ui-table th')].findIndex(t => t.textContent.replace(/[↓↑]/g, '').trim() === l); return [...document.querySelectorAll('.ins-root .ui-table tbody tr')].map(tr => tr.children[i].textContent); }, label);
const hitCol = (await colVals('Hit L5 · L10')).map(s => { const m = /· (\d+)\/(\d+)/.exec(s); return m ? +m[1] / +m[2] : -1; });
check('explorer: ranked by hit rate (last 10) by default', nonInc(hitCol), hitCol.slice(0, 6).map(x => x.toFixed(2)).join(','));
await page.click('.ins-root [data-ui-sort="exp|p"]');
const pc = (await colVals('Model %')).map(s => parseInt(s, 10));
check('explorer: sort by Model % is descending', pc.length === 25 && nonInc(pc) && await page.locator('.ins-root th.on [data-ui-sort="exp|p"]').count() === 1, pc.slice(0, 6).join(','));
await page.click('.ins-root [data-ui-sort="exp|p"]');
check('explorer: a second click sorts ascending', nonDec((await colVals('Model %')).map(s => parseInt(s, 10))));
await page.click('.ins-root [data-ui-seg="exp-rank|mu"]');
check('explorer: the MATCHUP seg ranks by matchup', await page.locator('.ins-root [data-ui-seg="exp-rank|mu"].on').count() === 1 && await page.locator('.ins-root th.on [data-ui-sort="exp|mu"]').count() === 1);
await page.selectOption('select[data-ui-select="exp-rows"]', '50');
check('explorer: rows select 50', (await page.locator('.ins-root .ui-table tbody tr').count()) === 50);
await page.selectOption('select[data-ui-select="exp-stat"]', 'pts');
check('explorer: stat select keeps only Points', (await colVals('Market')).every(m => m === 'Points'));
await page.selectOption('select[data-ui-select="exp-minp"]', '0.7');
const mp = (await colVals('Model %')).map(s => parseInt(s, 10));
check('explorer: min chance 70%+', mp.length > 0 && mp.every(v => v >= 70), `${mp.length} rows`);
await page.selectOption('select[data-ui-select="exp-minp"]', '0');
await page.selectOption('select[data-ui-select="exp-stat"]', 'all');
await page.click('[data-ui-pill="exp-sport|nfl"]');
const teams = await page.$$eval('select[data-ui-select="exp-team"] option', a => a.map(o => o.value).filter(v => v !== 'all'));
check('explorer: sport pill NFL and its teams in the team select', teams.length === 2 && (await page.$$eval('.ins-root .ui-table tbody .pt', a => a.every(x => / · NFL$/.test(x.textContent)))), teams.join(','));
await page.selectOption('select[data-ui-select="exp-team"]', teams[0]);
check('explorer: team select', (await page.$$eval('.ins-root .ui-table tbody .pt', a => a.map(x => x.textContent.split(' · ')[0]))).every(t => t === teams[0]));
await page.selectOption('select[data-ui-select="exp-lines"]', 'all');
const allN = await page.evaluate(() => __insights.rows.length);
check('explorer: "Every line" lists the whole ladder', allN > 0 && (await page.$$eval('.ins-root .ui-table tbody .pn', a => a.length)) === allN);
await page.selectOption('select[data-ui-select="exp-lines"]', 'main');
await page.selectOption('select[data-ui-select="exp-team"]', 'all');
await page.click('[data-ui-pill="exp-sport|all"]');
// row click -> Prop Analyzer
await page.evaluate(() => { window.__go = []; window.__realGo = SB.goTab; SB.goTab = (k, p) => { __go.push([k, p]); }; });
await page.locator('.ins-root .ui-table tbody tr').nth(1).locator('td').nth(3).click();
const r0 = await page.evaluate(() => ({ go: __go.slice(), it: __insights.rows[1].it }));
check('explorer: a row click opens the Prop Analyzer for that prop', r0.go.length === 1 && r0.go[0][0] === 'propan' && (r0.it.td ? r0.go[0][1].stat === 'td' : r0.go[0][1].id === r0.it.pl.id && r0.go[0][1].line === r0.it.thr), JSON.stringify(r0.go));
await page.evaluate(() => { SB.goTab = __realGo; });
// Copy table: success and failure both answer with a toast
await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copied = t; return Promise.resolve(); } } }); });
await page.click('.ins-root [data-ins-copy]');
await page.waitForTimeout(100);
const cp = await page.evaluate(() => ({ t: window.__copied, toast: document.getElementById('toast').textContent, n: __insights.rows.length }));
check('Copy table: a header and one tab-separated line per row', cp.t && cp.t.split('\n').length === cp.n + 1 && cp.t.split('\n')[0].split('\t')[0] === 'Player' && /Copied \d+ row/.test(cp.toast), cp.toast);
await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }); });
await page.click('.ins-root [data-ins-copy]');
await page.waitForTimeout(100);
check('Copy table: a blocked clipboard shows a toast instead of failing', /Couldn't copy/.test(await page.evaluate(() => document.getElementById('toast').textContent)));
const ov = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, wrap: (() => { const w = document.querySelector('.ins-root .ui-tablewrap'); return w.scrollWidth > w.clientWidth; })() }));
check('explorer at 390px: no page scroll, the wide table scrolls inside its wrap', ov.page <= 390 && ov.wrap, JSON.stringify(ov));
const small2 = await page.$$eval('.ins-root button, .ins-root .ui-sel', a => a.filter(b => b.offsetParent && !b.closest('th') && b.getBoundingClientRect().height < 40).map(b => b.className + ':' + Math.round(b.getBoundingClientRect().height)));
check('tap targets 40px+ (Explorer, outside the table header)', small2.length === 0, small2.slice(0, 5).join(' '));
const etxt = await page.locator('.ins-root').innerText();
check('explorer: honest labels (fair odds are not a book price, model estimates)', /No sportsbook prop prices/.test(etxt) && /not a book price/.test(etxt) && !/guarantee|\block\b|sure thing/i.test(etxt));

check('no page errors', errors.length === 0, errors.join(' | '));
await done(browser);
