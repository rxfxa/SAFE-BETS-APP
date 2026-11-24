// Stat Explorer (statx.js): season leaderboards from season.json. Checks the numbers against the fixture (season totals, per
// game, last 3, vs team, home / away, team offense and defense added up from the player logs, fantasy formula), sorting, the
// position chips per sport, params {sport, pos}, search, the honest footnote, season.json missing, and the 390 px / 1440 px
// layouts. Fixtures pinned, clock 2026-11-23T12:00Z. Run: node tests/statx.test.mjs
import { open, check, done, FX } from './lib/harness.mjs';

const SEASON = JSON.parse(FX('season-2026-11-23.json'));
const NFL = SEASON.sports.nfl;
const fI = (S, f) => S.fields.indexOf(f);
const sumL = (S, L, f) => L.reduce((a, r) => a + (+r[3 + fI(S, f)] || 0), 0);
const fInt = x => Math.round(x).toLocaleString('en-US');
const f1 = x => (Math.round(x * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const std = (S, L) => 0.04 * sumL(S, L, 'pyd') + 4 * sumL(S, L, 'ptd') + 0.1 * sumL(S, L, 'ryd') + 6 * sumL(S, L, 'rtd') + 0.1 * sumL(S, L, 'recyd') + 6 * sumL(S, L, 'ctd');
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const ready = page => page.waitForFunction(() => window.__statx && __statx.seasonState !== 'loading' && __statx.seasonState !== 'idle' && document.querySelector('.sx-root .sx-out') && !document.querySelector('.sx-root [aria-busy="true"]'), null, { timeout: 20000 });
// the table as [{name, sub, <header label>: cell text}] (labels without the sort arrow)
const table = page => page.evaluate(() => {
  const heads = [...document.querySelectorAll('.sx-root .ui-table thead th')].map(th => th.textContent.replace(/[↑↓]/g, '').trim());
  return [...document.querySelectorAll('.sx-root .ui-table tbody tr')].map(tr => {
    const pt = tr.querySelector('.pt'), c = pt ? pt.cloneNode(true) : null;
    if (c) c.querySelectorAll('.ta').forEach(x => x.remove());  // the abbreviation phones show instead of the full name
    const o = { name: (tr.querySelector('.pn') || {}).textContent || '', sub: c ? c.textContent : '', shown: pt ? pt.innerText : '' };
    [...tr.children].forEach((td, i) => { if (i > 0) o[heads[i]] = td.textContent.trim(); });
    return o;
  });
});
const heads = page => page.evaluate(() => [...document.querySelectorAll('.sx-root .ui-table thead th')].map(th => th.textContent.replace(/[↑↓]/g, '').trim()));
const sel = async (page, name, v) => { await page.selectOption(`.sx-root select[data-ui-select="${name}"]`, v); await page.waitForTimeout(60); };
const chip = async (page, k) => { await page.click(`.sx-root [data-sx-pos="${k}"]`); await page.waitForTimeout(60); };

// ============ phone, NFL quarterbacks (the default) ============
const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'statx' });
await ready(page);
check('season.json loaded', await page.evaluate(() => __statx.seasonState) === 'ok');
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${Math.round(fr)} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a full re-render with the table stays fast', rr < 400, `${Math.round(rr)} ms`);
const head = await page.evaluate(() => ({ kick: document.querySelector('.sx-root .ui-kick').textContent, title: document.querySelector('.sx-root .ui-title').textContent }));
check('header: kicker and display title', /Stat explorer/i.test(head.kick) && /leaderboards/i.test(head.title), JSON.stringify(head));
const pills = await page.evaluate(() => [...document.querySelectorAll('.sx-root .sx-sports .ui-pill')].map(b => [b.getAttribute('data-ui-pill'), b.textContent.trim(), !!b.querySelector('.dot'), b.classList.contains('on')]));
check('sport pills NFL, NBA, NHL, College with a dot each; NFL on', pills.map(p => p[1]).join(',') === 'NFL,NBA,NHL,College' && pills.every(p => p[2]) && pills[0][3], JSON.stringify(pills));
const chips = await page.evaluate(() => [...document.querySelectorAll('.sx-root .sx-chip')].map(b => b.getAttribute('data-sx-pos') + (b.classList.contains('on') ? '*' : '')));
check('football chips QB, RB, WR, TE, RCV, RUSH, Offense, Defense; QB on', chips.join(',') === 'qb*,rb,wr,te,rcv,rush,off,def', chips.join(','));
const ctrls = await page.evaluate(() => ({ season: !!document.querySelector('select[data-ui-select="sx-season"]'), rows: [...document.querySelectorAll('select[data-ui-select="sx-rows"] option')].map(o => o.textContent).join('/'),
  last: [...document.querySelectorAll('select[data-ui-select="sx-last"] option')].map(o => o.textContent).join('/'), per: !!document.querySelector('[data-sx-per][role="switch"]'),
  seg: [...document.querySelectorAll('[data-ui-seg^="sx-scoring|"]')].map(b => b.textContent).join('/'), q: !!document.querySelector('#sx-q'),
  team: document.querySelectorAll('select[data-ui-select="sx-team"] option').length, vs: document.querySelectorAll('select[data-ui-select="sx-vs"] option').length,
  ha: [...document.querySelectorAll('select[data-ui-select="sx-ha"] option')].map(o => o.textContent).join('/') }));
check('controls: Season, Rows 25/50/100/All, Games All/Last 3/5/10, Per game switch, All/PPR/Half/Std', ctrls.season && ctrls.rows === '25/50/100/All' && ctrls.last === 'All/Last 3/Last 5/Last 10' && ctrls.per && ctrls.seg === 'All/PPR/Half/Std', JSON.stringify(ctrls));
const teamOpts = await page.evaluate(() => [...document.querySelectorAll('select[data-ui-select="sx-team"] option')].slice(1, 4).map(o => o.textContent));
check('filters: player search, team (full names), vs team, home / away', ctrls.q && ctrls.team === 33 && ctrls.vs === 33 && ctrls.ha === 'All/Home/Away' && teamOpts[0] === 'Arizona Cardinals', JSON.stringify(teamOpts));

// QB totals = fixture sums
const QBs = NFL.players.filter(p => p.pos === 'QB' && p.tot[fI(NFL, 'pa')] > 0).sort((a, b) => b.tot[fI(NFL, 'pyd')] - a.tot[fI(NFL, 'pyd')]);
const top = QBs[0];
let T = await table(page);
check('default sort: the most passing yards first', T[0].name === top.n, `${T[0].name} vs ${top.n}`);
check('QB yards and TDs equal the fixture sums of his logs', T[0].Yds === fInt(sumL(NFL, top.log, 'pyd')) && T[0].TD === String(sumL(NFL, top.log, 'ptd')) && T[0].GP === String(top.log.length) && T[0].Att === fInt(sumL(NFL, top.log, 'pa')), JSON.stringify(T[0]));
check('name cell: player, team full name in the accent line, position', T[0].sub === `${NFL.teams[top.t]} · QB` && await page.evaluate(() => getComputedStyle(document.querySelector('.sx-root .ui-table .pn')).textTransform === 'uppercase'), T[0].sub);
check('phones show the team abbreviation under the name', T[0].shown === `${top.t} · QB`, T[0].shown);
check('Rows 50 by default, rank numbers', T.length === Math.min(50, QBs.length) && await page.evaluate(() => document.querySelector('.sx-root .sx-rk').textContent === '1'), String(T.length));
const heat = await page.evaluate(() => { const tds = [...document.querySelectorAll('.sx-root .ui-table tbody tr:first-child td')]; return tds.filter(td => /rgba\(/.test(td.getAttribute('style') || '')).length; });
check('heat shading on the stat cells', heat >= 8, String(heat));

// per game
await page.click('.sx-root [data-sx-per]');
T = await table(page);
const r0 = T.find(r => r.name === top.n);
check('per game = total / GP (one decimal)', r0 && r0.Yds === f1(sumL(NFL, top.log, 'pyd') / top.log.length) && r0.TD === f1(sumL(NFL, top.log, 'ptd') / top.log.length) && r0.GP === String(top.log.length), JSON.stringify(r0));
check('per game: switch on, meta says per game and the minimum games', await page.evaluate(() => document.querySelector('[data-sx-per]').getAttribute('aria-checked') === 'true' && /Per game/.test(document.querySelector('.sx-meta').textContent) && /Min \d+ games/.test(document.querySelector('.sx-meta').textContent)));
await page.click('.sx-root [data-sx-per]');

// last 3
await sel(page, 'sx-last', '3');
T = await table(page);
const L3 = top.log.slice(-3), r3 = T.find(r => r.name === top.n);
check('Last 3 recomputes from the logs', r3 && r3.GP === '3' && r3.Yds === fInt(sumL(NFL, L3, 'pyd')) && r3.TD === String(sumL(NFL, L3, 'ptd')), JSON.stringify(r3));
check('Last 3: meta names the sample and flags small samples', await page.evaluate(() => /Last 3 games/.test(document.querySelector('.sx-meta').textContent) && /Small samples/.test(document.querySelector('.sx-meta').textContent)));
await sel(page, 'sx-last', '0');

// vs team
const opp = top.log[top.log.length - 1][1];
await sel(page, 'sx-vs', opp);
T = await table(page);
const want = QBs.length && NFL.players.filter(p => p.pos === 'QB').map(p => ({ p, L: p.log.filter(r => r[1] === opp) })).filter(x => x.L.length && sumL(NFL, x.L, 'pa') > 0);
const rv = T.find(r => r.name === top.n), Lv = top.log.filter(r => r[1] === opp);
check(`vs Team (${opp}): his games against them only`, rv && rv.GP === String(Lv.length) && rv.Yds === fInt(sumL(NFL, Lv, 'pyd')), JSON.stringify(rv));
check('vs Team: every quarterback who faced them, and no one else', T.length === want.length && T.every(r => { const w = want.find(x => x.p.n === r.name); return w && r.GP === String(w.L.length) && r.Yds === fInt(sumL(NFL, w.L, 'pyd')); }), `${T.length} vs ${want.length}`);
check('vs Team: meta says who', await page.evaluate(o => document.querySelector('.sx-meta').textContent.includes('vs ' + o), NFL.teams[opp]));
await page.click('.sx-root .sx-filt [data-sx-reset]');
await page.waitForTimeout(60);
check('Clear filters resets the situation filters', await page.evaluate(() => { const s = __statx.state; return s.vs === 'all' && s.ha === 'all' && s.last === 0 && s.team === 'all' && s.q === ''; }));

// home / away and team
await sel(page, 'sx-ha', 'home');
T = await table(page);
const Lh = top.log.filter(r => r[2] === 1), rh = T.find(r => r.name === top.n);
check('Home: home games only', rh && rh.GP === String(Lh.length) && rh.Yds === fInt(sumL(NFL, Lh, 'pyd')), JSON.stringify(rh));
await sel(page, 'sx-ha', 'all');
await sel(page, 'sx-team', top.t);
T = await table(page);
check('Team filter: only that team\'s players', T.length >= 1 && T.every(r => r.sub.startsWith(NFL.teams[top.t])), T.map(r => r.name).join(', '));
await sel(page, 'sx-team', 'all');

// sort toggles direction
await page.click('.sx-root [data-ui-sort="sx|pyd"]');
T = await table(page);
const minQ = QBs[QBs.length - 1];
const up = await page.evaluate(() => document.querySelector('.sx-root .ui-table th.on').textContent);
check('sort: a second click on the sorted column flips it (fewest yards first)', /↑/.test(up) && T[0].Yds === fInt(minQ.tot[fI(NFL, 'pyd')]), `${up} ${T[0].name} ${T[0].Yds}`);
check('sort: aria-sort on the sorted header', await page.evaluate(() => document.querySelector('.sx-root .ui-table th.on').getAttribute('aria-sort') === 'ascending'));
check('sort: focus stays on the header button', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-ui-sort') === 'sx|pyd'));
await page.click('.sx-root [data-ui-sort="sx|pyd"]');
T = await table(page);
check('sort: and back to most first', T[0].name === top.n && /↓/.test(await page.evaluate(() => document.querySelector('.sx-root .ui-table th.on').textContent)));
await page.click('.sx-root [data-ui-sort="sx|ptd"]');
T = await table(page);
const byTd = [...QBs].sort((a, b) => b.tot[fI(NFL, 'ptd')] - a.tot[fI(NFL, 'ptd')]);
check('sort: another column sorts high to low first', T[0].TD === String(byTd[0].tot[fI(NFL, 'ptd')]), `${T[0].name} ${T[0].TD}`);

// search
await page.fill('#sx-q', 'mahom');
await page.waitForTimeout(80);
T = await table(page);
check('player search filters the table and keeps focus in the box', T.length === 1 && T[0].name === 'Patrick Mahomes' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'sx-q'), T.map(r => r.name).join(', '));
await page.fill('#sx-q', '');
await page.waitForTimeout(60);

// WR: fantasy columns
await chip(page, 'wr');
const WRs = NFL.players.filter(p => p.pos === 'WR').sort((a, b) => b.tot[fI(NFL, 'recyd')] - a.tot[fI(NFL, 'recyd')]);
const wr = WRs[0];
T = await table(page);
const w0 = T[0], s0 = std(NFL, wr.log), rec = sumL(NFL, wr.log, 'rec');
check('WR table: most receiving yards first, with targets and catch rate', w0.name === wr.n && w0.Yds === fInt(sumL(NFL, wr.log, 'recyd')) && w0.Tgt === fInt(sumL(NFL, wr.log, 'tgt')) && w0['Cth%'] === (Math.round(rec / sumL(NFL, wr.log, 'tgt') * 1000) / 10).toFixed(1) + '%', JSON.stringify(w0));
check('PPR / Half / Std columns follow the formula (rec × 1 / .5 / 0)', w0.PPR === f1(s0 + rec) && w0.Half === f1(s0 + 0.5 * rec) && w0.Std === f1(s0), `${w0.PPR} ${w0.Half} ${w0.Std} want ${f1(s0 + rec)} ${f1(s0 + 0.5 * rec)} ${f1(s0)}`);
await page.click('.sx-root [data-ui-seg="sx-scoring|ppr"]');
await page.waitForTimeout(60);
const hp = await heads(page);
check('scoring PPR: one fantasy column', hp.includes('PPR') && !hp.includes('Half') && !hp.includes('Std'), hp.join(','));
await page.click('.sx-root [data-ui-seg="sx-scoring|all"]');
await page.waitForTimeout(60);

// team offense / defense
await chip(page, 'off');
T = await table(page);
const tm = 'DAL', tmName = NFL.teams[tm];
const offRows = NFL.players.filter(p => p.t === tm).flatMap(p => p.log.map(r => ({ p, r })));
const offDates = new Set(offRows.map(x => x.r[0]));
const tOff = T.find(r => r.name === tmName);
const offYds = offRows.reduce((a, x) => a + x.r[3 + fI(NFL, 'pyd')] + x.r[3 + fI(NFL, 'ryd')], 0);
const qbPpr = NFL.players.filter(p => p.t === tm && p.pos === 'QB').reduce((a, p) => a + std(NFL, p.log) + sumL(NFL, p.log, 'rec'), 0);
check('team offense: total yards = the sum of its players\' passing + rushing log lines', tOff && tOff['Tot yds'] === fInt(offYds) && tOff.GP === String(offDates.size), JSON.stringify(tOff));
check('team offense: pass / rush yards and the QB PPR column', tOff && tOff['Pass yds'] === fInt(offRows.reduce((a, x) => a + x.r[3 + fI(NFL, 'pyd')], 0)) && tOff['Rush yds'] === fInt(offRows.reduce((a, x) => a + x.r[3 + fI(NFL, 'ryd')], 0)) && tOff['QB PPR'] === f1(qbPpr), JSON.stringify(tOff));
check('team offense: 32 teams, "from player box lines" on screen', T.length === 32 && /Added up from player box lines/.test(await page.locator('.sx-meta').innerText()) && /added up from player box lines/i.test(await page.locator('.sx-foot').innerText()));
await chip(page, 'def');
T = await table(page);
const defRows = NFL.players.flatMap(p => p.log.filter(r => r[1] === tm));
const tDef = T.find(r => r.name === tmName);
check('team defense: what opponents gained against them', tDef && tDef['Tot yds vs'] === fInt(defRows.reduce((a, r) => a + r[3 + fI(NFL, 'pyd')] + r[3 + fI(NFL, 'ryd')], 0)) && tDef.GP === String(new Set(defRows.map(r => r[0])).size), JSON.stringify(tDef));
await sel(page, 'sx-ha', 'home');
T = await table(page);
const defHome = defRows.filter(r => r[2] === 0), tDefH = T.find(r => r.name === tmName);
check('team defense at home = opponents\' away lines (home flipped)', tDefH && tDefH['Tot yds vs'] === fInt(defHome.reduce((a, r) => a + r[3 + fI(NFL, 'pyd')] + r[3 + fI(NFL, 'ryd')], 0)) && tDefH.GP === String(new Set(defHome.map(r => r[0])).size), JSON.stringify(tDefH));
await sel(page, 'sx-ha', 'all');

// honest footnote and words
const foot = await page.locator('.sx-root .sx-foot').innerText();
check('footnote: source, what happened (not projections), and what is missing', /ESPN box scores/.test(foot) && /not projections/.test(foot) && /completions, interceptions, sacks, air yards/.test(foot) && /No interceptions, fumbles or two-point conversions/.test(foot), foot.slice(0, 200));
check('no certainty words', !/guarantee|\block\b|sure thing|can't lose|\bdue\b/i.test(await page.locator('.sx-root').innerText()));

// 390 px layout
check('no horizontal page scroll at 390 px; the table scrolls inside its wrapper', await noScroll(page) && await page.evaluate(() => { const w = document.querySelector('.sx-root .ui-tablewrap'); return w.scrollWidth > w.clientWidth && getComputedStyle(w).overflowX === 'auto'; }));
await chip(page, 'qb');
const small = await page.evaluate(() => [...document.querySelectorAll('.sx-root .ui-pill, .sx-root .sx-chip, .sx-root .ui-sel, .sx-root [data-sx-per], .sx-root [data-ui-seg], .sx-root .sx-csv, .sx-root .sx-q, .sx-root .ui-table th button, .sx-root .sx-nm')]
  .map(b => [b.className || b.tagName, Math.round(b.getBoundingClientRect().height)]).filter(x => x[1] < 40));
check('tap targets 40px+ (pills, chips, selects, switch, sort headers, names)', small.length === 0, JSON.stringify(small.slice(0, 5)));

// CSV
const csv = await page.evaluate(() => __statx.csvText());
const csvLines = csv.split('\n');
check('CSV of the table: header and one line per shown row', csvLines[0].startsWith('Rank,Player,Team,Pos,GP,Att,Yds') && csvLines.length === (await table(page)).length + 1, csvLines[0]);
await page.click('.sx-root [data-sx-csv]');
await page.waitForTimeout(250);
check('CSV button copies or shows the text to copy', await page.evaluate(() => !!document.querySelector('.sx-csvbox') || /Copied/.test((document.getElementById('toast') || {}).textContent || '')));
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

// a name opens the player page
await page.click('.sx-root .ui-table tbody tr:first-child button.sx-nm');
await page.waitForTimeout(200);
check('a player name opens his page on Players', await page.evaluate(n => SB.tab === 'players' && document.querySelector('.ui-title') && document.querySelector('.ui-title').textContent.replace(/\s+/g, ' ').trim().toLowerCase().includes(n.split(' ').pop().toLowerCase()), top.n));

// params {sport, pos}
await page.evaluate(() => SB.goTab('statx', { sport: 'nba', pos: 'guards' }));
await ready(page);
const NBA = SEASON.sports.nba;
const G = NBA.players.filter(p => p.pos === 'G' && p.tot[fI(NBA, 'min')] > 0).sort((a, b) => b.tot[fI(NBA, 'pts')] - a.tot[fI(NBA, 'pts')]);
T = await table(page);
const nb = T[0], gp = G[0];
const nbaState = await page.evaluate(() => [document.querySelector('.sx-root').dataset.sxSport, document.querySelector('.sx-root').dataset.sxPos, [...document.querySelectorAll('.sx-root .sx-chip')].map(b => b.getAttribute('data-sx-pos')).join(',')]);
check('params {sport: nba, pos: guards} open NBA Guards; chips All / Guards / Forwards / Centers', nbaState.join('|') === 'nba|g|all,g,f,c', nbaState.join('|'));
const tr = (P, f) => P.tot[fI(NBA, f)];
check('NBA: season totals from season.json, sorted by points; PRA = pts + reb + ast', nb.name === gp.n && nb.Pts === fInt(tr(gp, 'pts')) && nb.GP === String(gp.gp) && nb.PRA === fInt(tr(gp, 'pts') + tr(gp, 'reb') + tr(gp, 'ast')) && T.every(r => / · G$/.test(r.sub)), JSON.stringify(nb));
check('NBA: no fantasy scoring switch', await page.evaluate(() => !document.querySelector('[data-ui-seg^="sx-scoring|"]')));
await sel(page, 'sx-last', '5');
T = await table(page);
const n5 = T.find(r => r.name === gp.n), L5 = gp.log.slice(-5);
check('NBA Last 5 recomputes from the logs and says logs keep 15 games', n5 && n5.GP === '5' && n5.Pts === fInt(sumL(NBA, L5, 'pts')) && /last 15 games/.test(await page.locator('.sx-meta').innerText()), JSON.stringify(n5));
await sel(page, 'sx-last', '0');

await page.evaluate(() => SB.goTab('statx', { sport: 'nhl', pos: 'defense' }));
await ready(page);
const NHL = SEASON.sports.nhl;
T = await table(page);
const D = NHL.players.filter(p => p.pos === 'D').sort((a, b) => (b.tot[0] + b.tot[1]) - (a.tot[0] + a.tot[1]) || b.gp - a.gp);
check('NHL defense: only D, points = goals + assists, sorted by points', T.every(r => / · D$/.test(r.sub)) && T[0].Pts === String(D[0].tot[0] + D[0].tot[1]) && T[0].G === String(D[0].tot[0]) && T[0].A === String(D[0].tot[1]), JSON.stringify(T[0]));
await chip(page, 'f');
T = await table(page);
check('NHL forwards: C / LW / RW, no goalies or defensemen', T.length > 0 && T.every(r => / · (C|LW|RW)$/.test(r.sub)), T.slice(0, 3).map(r => r.sub).join(' | '));

await page.evaluate(() => SB.goTab('statx', { sport: 'college', pos: 'receiving' }));
await ready(page);
const cs = await page.evaluate(() => [document.querySelector('.sx-root').dataset.sxSport, document.querySelector('.sx-root').dataset.sxPos, [...document.querySelectorAll('.sx-root .sx-chip')].map(b => b.getAttribute('data-sx-pos')).join(',')]);
const hc = await heads(page);
check('College receiving: no TE chip (positions guessed from usage), no target columns', cs.join('|') === 'ncaaf|rcv|qb,rb,wr,rcv,rush,off,def' && !hc.includes('Tgt') && hc.includes('Yds'), cs.join('|') + ' ' + hc.join(','));
check('College footnote: 150+ yards and no targets', /150\+ yards/.test(await page.locator('.sx-foot').innerText()) && /no targets/.test(await page.locator('.sx-foot').innerText()));
await sel(page, 'sx-rows', '0');
const tAll = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
const nAll = (await table(page)).length;
check('Rows All shows every row and still renders fast', nAll === await page.evaluate(() => __statx.model().rows.length) && nAll > 100 && tAll < 1000, `${nAll} rows in ${Math.round(tAll)} ms`);
await sel(page, 'sx-rows', '50');
await chip(page, 'off');
check('College team offense renders (Rows 50 of 100+ teams)', (await table(page)).length === 50 && await page.evaluate(() => __statx.model().rows.length) > 100, String(await page.evaluate(() => __statx.model().rows.length)));
check('remembered on this device: sport, position, rows', await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('fm2.sx.prefs')); return p.sport === 'ncaaf' && p.pos.ncaaf === 'off' && p.rows === 50; }));
await page.evaluate(() => SB.goTab('statx', { sport: 'nfl', pos: 'qb' }));
await ready(page);

check('no page errors (phone)', errors.length === 0, errors.join(' | '));
await browser.close();

// ============ desktop 1440 ============
{
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'statx' });
  await ready(page);
  check('1440 px: no horizontal page scroll, table beside the 260 px sidebar', await noScroll(page) && await page.evaluate(() => document.querySelector('.sx-root .ui-tablewrap').getBoundingClientRect().left >= 260));
  const dsub = await page.evaluate(() => document.querySelector('.sx-root .ui-table tbody .pt').innerText);
  check('1440 px: the full team name under the player', /^[A-Z][a-z]+ .+ · QB$/i.test(dsub) && dsub.length > 10, dsub);
  check('1440 px: leaders bold, the low end dim (heat text)', await page.evaluate(() => !!document.querySelector('.sx-root .ui-table td.hi') && !!document.querySelector('.sx-root .ui-table td.lo')));
  check('1440 px: options sit on one row under the sport pills', await page.evaluate(() => { const o = [...document.querySelectorAll('.sx-root .sx-opts > *')].map(e => Math.round(e.getBoundingClientRect().top)); return new Set(o).size === 1; }));
  check('no page errors (desktop)', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ============ season.json missing ============
{
  const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'statx', pins: { 'season.json': null } });
  await ready(page);
  const txt = await page.locator('.sx-root').innerText();
  check('season.json missing: honest empty state, no table', await page.evaluate(() => __statx.seasonState) === 'none' && /did not load/.test(txt) && /season\.json is missing/.test(txt) && !(await page.$('.sx-root .ui-table')), txt.slice(0, 160));
  check('season.json missing: sport pills still there, no page errors', (await page.$$('.sx-root .sx-sports .ui-pill')).length === 4 && errors.length === 0, errors.join(' | '));
  check('season.json missing: no horizontal scroll', await noScroll(page));
  await done(browser);
}
