// Players (players.js): search, sport chips with counts, the "Top" rows per sport, the full table, a player page (season
// averages, last-10 log, his props on the slate with + Slip and Analyze, Ask), params {name, sport}, and season.json missing.
// Fixtures pinned, clock 2026-11-23T12:00Z. Run: node tests/players.test.mjs
import { open, check, done, FX } from './lib/harness.mjs';

const SEASON = JSON.parse(FX('season-2026-11-23.json'));
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
const T = (S, P, f) => { const i = S.fields.indexOf(f); return i < 0 ? 0 : +P.tot[i] || 0; };
const TOPF = {
  nfl: (S, P) => (0.04 * T(S, P, 'pyd') + 4 * T(S, P, 'ptd') + 0.1 * T(S, P, 'ryd') + 6 * T(S, P, 'rtd') + T(S, P, 'rec') + 0.1 * T(S, P, 'recyd') + 6 * T(S, P, 'ctd')) / P.gp,
  nba: (S, P) => T(S, P, 'pts') / P.gp, nhl: (S, P) => (T(S, P, 'g') + T(S, P, 'a')) / P.gp,
  ncaaf: (S, P) => (T(S, P, 'pyd') + T(S, P, 'ryd') + T(S, P, 'recyd')) / P.gp, soccer: (S, P) => T(S, P, 'g'),
};
const MIN = { nfl: 4, nba: 5, nhl: 8, ncaaf: 4, soccer: 1 };
const fixtureTop = sp => { const S = SEASON.sports[sp]; return S.players.filter(P => P.gp >= MIN[sp]).map(P => ({ n: P.n, v: TOPF[sp](S, P), gp: P.gp })).sort((a, b) => b.v - a.v || a.gp - b.gp || (a.n < b.n ? -1 : 1)); };
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'players' });
await page.waitForFunction(() => window.__players && __players.seasonState === 'ok' && document.querySelectorAll('.pl-root .pl-card').length > 0, null, { timeout: 20000 });
await page.waitForTimeout(300);

// ---------- first render, header, chips ----------
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${Math.round(fr)} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a re-render stays fast', rr < 400, `${Math.round(rr)} ms`);
const rms = await page.evaluate(() => __players.renderMs);
check('render time measured in the page: every render so far under 1,500 ms (incl. the cold one that indexes 4,500 season players)', rms.n >= 2 && rms.max < 1500, `max ${Math.round(rms.max)} ms over ${rms.n} renders`);
const txt = await page.locator('.pl-root').innerText();
check('header: player count kicker and display title', /PLAYERS · 5 SPORTS/i.test(txt) && /SEASON STATS/i.test(await page.locator('.pl-root .ui-title').innerText()));
check('honest: averages are what happened, not projections', /not projections/.test(txt));
check('no certainty words', !/guarantee|\block\b|sure thing|can't lose|\bdue\b/i.test(txt));
const socNote = await page.evaluate(() => document.querySelector('[data-pl-sec="soccer"] .pl-k2').textContent);
check('soccer note names the leagues our box scores really cover (no Champions League / MLS claim)', /Premier League, La Liga, Serie A, Bundesliga and Ligue 1/.test(socNote) && /no Champions League, MLS/.test(socNote), socNote);
const chips = await page.evaluate(() => [...document.querySelectorAll('.pl-chips .ui-pill')].map(b => [b.getAttribute('data-ui-pill'), b.querySelector('.n') ? b.querySelector('.n').textContent : '']));
const idx = await page.evaluate(() => { const X = __players.index(); return { counts: X.counts, total: X.total, slateOnly: Object.fromEntries(['nfl', 'nba', 'nhl', 'ncaaf', 'soccer'].map(sp => [sp, X.bySp[sp].filter(e => !e.P).length])) }; });
check('chips: All sports, NFL, NBA, NHL, College, Soccer in that order', chips.map(c => c[0].split('|')[1]).join(',') === 'all,nfl,nba,nhl,ncaaf,soccer', chips.map(c => c[0]).join(','));
const cOk = ['nfl', 'nba', 'nhl', 'ncaaf', 'soccer'].every(sp => idx.counts[sp] - idx.slateOnly[sp] === SEASON.sports[sp].players.length && chips.find(c => c[0] === 'pl-sport|' + sp)[1] === idx.counts[sp].toLocaleString('en-US'));
check('chip counts: every season.json player per sport, plus slate players with no season line', cOk, JSON.stringify(idx));

// ---------- the Top rows ----------
const tops = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-pl-sec]')].map(s => [s.getAttribute('data-pl-sec'), [...s.querySelectorAll('.pl-card')].map(c => [c.querySelector('.pl-nm').textContent, c.querySelector('.pl-val b').textContent, c.querySelector('.pl-val small').textContent])])));
for (const sp of ['nfl', 'nba', 'nhl', 'ncaaf', 'soccer']) {
  const want = fixtureTop(sp).slice(0, 6), got = tops[sp] || [];
  const ok = got.length === 6 && want.every((w, i) => got[i][0] === w.n && got[i][1] === (sp === 'soccer' ? String(Math.round(w.v)) : f1(w.v)));
  check(`Top row ${sp}: 6 cards matching the fixture (${got[0] ? got[0][2] : ''})`, ok, got.slice(0, 3).map(g => g.join(' ')).join(' · ') + ' | want ' + want.slice(0, 3).map(w => w.n + ' ' + f1(w.v)).join(' · '));
}
check('cards: photo-less gradient art with the team watermark', await page.evaluate(() => { const a = document.querySelector('.pl-card .pl-art'); return !!a && !document.querySelector('.pl-root img') && getComputedStyle(a).backgroundImage.includes('gradient') && !!a.querySelector('.wm').textContent; }));
check('no horizontal scroll at 390 px (list; card rows scroll inside)', await noScroll(page) && await page.evaluate(() => { const r = document.querySelector('.pl-row'); return r.scrollWidth > r.clientWidth && getComputedStyle(r).overflowX === 'auto'; }));
const tapOk = await page.evaluate(() => [...document.querySelectorAll('.pl-chips .ui-pill, .pl-card, .pl-all')].every(b => b.getBoundingClientRect().height >= 40));
check('tap targets 40px+ (chips, cards, links)', tapOk);

// ---------- search ----------
const sName = 'Victor Wembanyama';
await page.locator('#pl-q').click();
await page.keyboard.type('wemban');
await page.waitForSelector('#pl-sug:not([hidden]) .pl-opt');
const sug = await page.evaluate(() => [...document.querySelectorAll('#pl-sug .pl-opt b')].map(b => b.textContent));
check('search finds a fixture player by part of his name', sug[0] === sName, sug.join(', '));
await page.locator('#pl-sug .pl-opt').first().click();
await page.waitForSelector('.pl-root[data-pl="page"]');
const S = SEASON.sports.nba, W = S.players.find(p => p.n === sName);
const pg = await page.evaluate(() => ({
  title: document.querySelector('.pl-root .ui-title').textContent, kick: document.querySelector('.pl-root .ui-kick').textContent, team: document.querySelector('[data-pl-team]').textContent, meta: document.querySelector('.pl-meta').textContent,
  tiles: Object.fromEntries([...document.querySelectorAll('[data-pl-avgs] .ui-tile')].map(t => [t.querySelector('.ui-lbl').textContent, t.querySelector('b').textContent])),
  log: [...document.querySelectorAll('[data-pl-log] tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())),
  head: [...document.querySelectorAll('[data-pl-log] thead th')].map(th => th.textContent.trim()),
}));
const bar0 = await page.evaluate(() => { const b = document.querySelector('.pl-root .ui-log .bar'); return b ? getComputedStyle(b).marginBottom + ' ' + getComputedStyle(b).display : 'none'; });
check('game-log chart: the app\'s older .bar rule is undone (no 4px lift off the baseline)', bar0 === '0px block', bar0);
check('player page: name as the display title, team full name, position, games', pg.title.replace(/\s+/g, ' ').trim() === sName && pg.team === SEASON.sports.nba.teams[W.t] && pg.meta.includes(`${W.gp} games`) && pg.kick.includes('NBA'), `${pg.title} | ${pg.team} | ${pg.meta}`);
check('season averages: points / rebounds / assists a game = season totals ÷ games', pg.tiles.Points === f1(T(S, W, 'pts') / W.gp) && pg.tiles.Rebounds === f1(T(S, W, 'reb') / W.gp) && pg.tiles.Assists === f1(T(S, W, 'ast') / W.gp) && pg.tiles.Games === String(W.gp), JSON.stringify(pg.tiles));
const fi = f => 3 + S.fields.indexOf(f), want10 = W.log.slice(-10).reverse();
check('last-10 log: newest first, values straight from the fixture box scores', pg.log.length === want10.length && want10.every((r, i) => pg.log[i][1] === `${r[2] === 1 ? 'vs' : '@'} ${r[1]}` && pg.log[i][pg.head.indexOf('Pts')] === String(r[fi('pts')]) && pg.log[i][pg.head.indexOf('Min')] === String(r[fi('min')])), JSON.stringify(pg.log.slice(0, 2)));
check('no horizontal scroll at 390 px (player page)', await noScroll(page));
await page.locator('[data-pl-back]').click();
check('Back returns to the list', await page.evaluate(() => document.querySelector('.pl-root').getAttribute('data-pl') === 'list' && document.querySelectorAll('.pl-card').length > 0));

// ---------- params {name, sport}: a player on the slate, his props ----------
const on = await page.evaluate(() => { const e = __players.index().bySp.nba.find(x => x.P && x.slate.length && x.slate[0].stats.pts); const p = e.slate[0], pl = p.stats.pts; return { name: e.name, id: pl.id, gid: p.gid, lad: SB.engine.LADDER.pts.map(t => [t, SB.engine.playerP(pl, t)]) }; });
await page.evaluate(n => SB.goTab('players', { name: n, sport: 'nba' }), on.name);
await page.waitForSelector('.pl-root[data-pl="page"] [data-pl-props]');
const props = await page.evaluate(() => [...document.querySelectorAll('[data-pl-mkt="pts"] .pl-lad')].map(r => [r.querySelector('.ln b').textContent, r.querySelector('.ln .p').textContent, r.querySelector('.fo').textContent]));
const wantLad = on.lad.filter(([, p]) => p >= 0.05 && p <= 0.97);
check('params {name, sport}: opens his page with his points ladder at the engine\'s chances and fair odds', props.length === wantLad.length && wantLad.every(([t, p], i) => props[i][0] === `${t}+` && props[i][1] === Math.round(p * 100) + '%'), JSON.stringify(props));
const fairOk = await page.evaluate(([rows, lad]) => rows.every((r, i) => r[2] === SB.ui.fair(lad[i][1])), [props, wantLad]);
check('props: fair odds from each chance', fairOk);
await page.evaluate(() => SB.setSlip([]));
await page.locator('[data-pl-mkt="pts"] [data-pl-slip]').first().click();
const slip = await page.evaluate(() => SB.slip.map(l => l.gid + '|' + l.key));
check('+ Slip adds the P:<id>:<line> leg', slip.length === 1 && slip[0] === `${on.gid}|P:${on.id}:${wantLad[0][0]}`, slip.join(','));
check('+ Slip shows "In slip" and keeps the page', /In slip/.test(await page.locator('[data-pl-mkt="pts"] [data-pl-slip]').first().innerText()) && await page.evaluate(() => document.querySelector('.pl-root').getAttribute('data-pl') === 'page'));
await page.evaluate(() => SB.setSlip([]));
await page.locator('[data-pl-mkt="pts"] [data-pl-an]').first().click();
await page.waitForSelector('.pa-root[data-pa="prop"]');
const an = await page.evaluate(() => ({ tab: SB.tab, line: document.getElementById('pa-line').value, name: document.querySelector('.pa-nm').textContent }));
check('Analyze opens the Prop Analyzer on that line', an.tab === 'propan' && an.name === on.name && an.line === String(wantLad[0][0] - 0.5), JSON.stringify(an));

// ---------- NFL: anytime TD block, PPR tile; Ask ----------
const nfl = await page.evaluate(() => { const e = __players.index().bySp.nfl.find(x => x.P && x.slate.some(p => p.td)); return e ? { name: e.name, ppr: e.top } : null; });
if (nfl) {
  await page.evaluate(n => SB.goTab('players', { name: n, sport: 'nfl' }), nfl.name);
  await page.waitForSelector('.pl-root[data-pl="page"]');
  const N = await page.evaluate(() => ({ td: !!document.querySelector('[data-pl-mkt="td"] [data-pl-slip^="nfl-"]'), ppr: [...document.querySelectorAll('[data-pl-avgs] .ui-tile')].map(t => [t.querySelector('.ui-lbl').textContent, t.querySelector('b').textContent]).find(t => t[0] === 'PPR/G') }));
  check('NFL page: anytime TD with + Slip, and a PPR a game tile', N.td && N.ppr && N.ppr[1] === f1(nfl.ppr), JSON.stringify(N));
} else check('an NFL player with an anytime TD is on the fixture slate', false);
await page.locator('[data-pl-ask]').click();
await page.waitForTimeout(200);
const ask = await page.evaluate(() => ({ tab: SB.tab, draft: (document.querySelector('.ask-input') || {}).value || '' }));
check('Ask: opens Chat with a question about him', ask.tab === 'ask' && ask.draft.includes(nfl ? nfl.name : ''), JSON.stringify(ask));

// ---------- a sport: the full table, sort, min games ----------
await page.evaluate(() => SB.goTab('players', { sport: 'nba' }));
await page.waitForSelector('[data-pl-table="nba"]');
const tb = await page.evaluate(() => ({ n: document.querySelectorAll('[data-pl-table] tbody tr').length, first: document.querySelector('[data-pl-table] tbody tr .pn').textContent, secs: [...document.querySelectorAll('[data-pl-sec]')].map(s => s.getAttribute('data-pl-sec')) }));
const nba3 = SEASON.sports.nba.players.filter(P => P.gp >= 3).sort((a, b) => T(S, b, 'pts') / b.gp - T(S, a, 'pts') / a.gp);
check('NBA chip: its Top row plus the full table (50 rows), led by the top scorer', tb.secs.join() === 'nba' && tb.n === 50 && tb.first === nba3[0].n, JSON.stringify(tb));
await page.locator('[data-ui-sort="pl-tab|rebg"]').click();
const rebFirst = await page.evaluate(() => document.querySelector('[data-pl-table] tbody tr .pn').textContent);
const nbaReb = SEASON.sports.nba.players.filter(P => P.gp >= 3).sort((a, b) => T(S, b, 'reb') / b.gp - T(S, a, 'reb') / a.gp || b.gp - a.gp);
check('table sorts by a column (rebounds)', rebFirst === nbaReb[0].n, `${rebFirst} vs ${nbaReb[0].n}`);
await page.locator('[data-pl-more]').click();
check('Show more adds 50 rows', (await page.locator('[data-pl-table] tbody tr').count()) === 100);
check('Show more: focus moves to the first added row (the clicked button is gone)', await page.evaluate(() => document.activeElement === document.querySelectorAll('[data-pl-table] tbody tr')[50].querySelector('button')));
await page.selectOption('select[data-ui-select="pl-min"]', '10');
const min10 = await page.evaluate(() => [...document.querySelectorAll('[data-pl-table] tbody tr')].map(tr => +tr.querySelectorAll('td')[1].textContent));
check('Min games 10+ filters the table', min10.length > 0 && min10.every(g => g >= 10), `${min10.length} rows`);
check('no horizontal scroll at 390 px (table scrolls inside its wrapper)', await noScroll(page));
// NFL table: passing TDs have their own column (the old "TD" column counted rushing + receiving only, so QBs read ~0)
await page.evaluate(() => SB.goTab('players', { sport: 'nfl' }));
await page.waitForSelector('[data-pl-table="nfl"]');
const nflT = await page.evaluate(() => { const head = [...document.querySelectorAll('[data-pl-table] thead th')].map(th => th.textContent.replace(/[↑↓]/g, '').trim()); const rows = [...document.querySelectorAll('[data-pl-table] tbody tr')].map(tr => [tr.querySelector('.pn').textContent, ...[...tr.querySelectorAll('td')].slice(1).map(td => td.textContent)]); return { head, rows }; });
const SN = SEASON.sports.nfl, qb = SN.players.filter(P => P.gp >= 3 && P.pos === 'QB').map(P => ({ n: P.n, ptd: T(SN, P, 'ptd'), rr: T(SN, P, 'rtd') + T(SN, P, 'ctd') })).find(q => nflT.rows.some(r => r[0] === q.n));
const qRow = qb && nflT.rows.find(r => r[0] === qb.n), hi = k => nflT.head.indexOf(k);
check('NFL table: "Pass TD" and "Rush+Rec TD" columns, a QB\'s values equal the fixture totals', !!qRow && qRow[hi('Pass TD')] === String(qb.ptd) && qRow[hi('Rush+Rec TD')] === String(qb.rr), qb ? `${qb.n}: ${qRow && qRow[hi('Pass TD')]} / ${qRow && qRow[hi('Rush+Rec TD')]} vs ${qb.ptd} / ${qb.rr}` : 'no QB row');
await page.evaluate(() => SB.goTab('players', { sport: 'soccer' }));
await page.waitForSelector('[data-pl-table="soccer"]');
const socG = await page.evaluate(() => { const hi = [...document.querySelectorAll('[data-pl-table] thead th')].findIndex(th => /^G\b/.test(th.textContent.trim())); return [...document.querySelectorAll('[data-pl-table] tbody tr')].slice(0, 5).map(tr => tr.querySelectorAll('td')[hi].textContent); });
check('soccer table: goals are whole numbers (were "15.0")', socG.length === 5 && socG.every(v => /^\d+$/.test(v)), socG.join(','));
// the menu item goes back to the list from a player page
await page.evaluate(n => SB.goTab('players', { name: n, sport: 'nba' }), sName);
await page.waitForSelector('.pl-root[data-pl="page"]');
await page.evaluate(() => { const b = document.querySelector('#tabs [data-t="players"]'); if (b) b.click(); else SB.goTab('players', {}); });
await page.waitForTimeout(150);
check('the Players menu item returns to the list', await page.evaluate(() => document.querySelector('.pl-root').getAttribute('data-pl') === 'list'));
await page.evaluate(() => SB.goTab('players', { name: 'Nobody McFakename' }));
check('a name we do not have: a notice, the list stays', /No player named Nobody McFakename/.test(await page.locator('.pl-root').innerText()));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();

// ======================= 1440 px =======================
{
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'players' });
  await page.waitForFunction(() => window.__players && __players.seasonState === 'ok' && document.querySelectorAll('.pl-card').length > 0, null, { timeout: 20000 });
  const fit = await page.evaluate(() => { const r = document.querySelector('.pl-row'); return r.scrollWidth <= r.clientWidth + 1 && r.querySelectorAll('.pl-card').length === 6; });
  check('1440 px: six cards per row fit without scrolling', fit);
  check('1440 px: no horizontal scroll, no errors', await noScroll(page) && errors.length === 0, errors.join(' | '));
  await page.evaluate(() => SB.goTab('players', { name: 'Victor Wembanyama', sport: 'nba' }));
  await page.waitForSelector('.pl-root[data-pl="page"]');
  check('1440 px: player page has no horizontal scroll', await noScroll(page));
  await browser.close();
}

// ======================= season.json missing =======================
{
  const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'players', pins: { 'season.json': null } });
  await page.waitForFunction(() => window.__players && __players.seasonState === 'none', null, { timeout: 20000 });
  await page.waitForTimeout(200);
  const t = await page.locator('.pl-root').innerText();
  check('season.json missing: says so', /did not load/.test(t));
  const cards = await page.locator('.pl-card').count();
  check('season.json missing: slate players still shown (top scorers on the slate from the feed)', cards > 0 && /ON THE SLATE|on the slate/i.test(t), `${cards} cards`);
  const slatePl = await page.evaluate(() => { const e = __players.index().bySp.nba.find(x => x.slate.length && x.slate[0].stats.pts); return e.name; });
  await page.locator('#pl-q').click();
  await page.keyboard.type(slatePl.split(' ').slice(-1)[0]);
  await page.waitForSelector('#pl-sug:not([hidden]) .pl-opt');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pl-root[data-pl="page"]');
  const pt = await page.locator('.pl-root').innerText();
  check('season.json missing: search opens a slate player; his props show and the log says it did not load', /did not load, so there is no game log/.test(pt) && (await page.locator('[data-pl-props] .pl-lad').count()) > 0, pt.slice(0, 120).replace(/\n/g, ' | '));
  check('season.json missing: no page errors, no horizontal scroll', errors.length === 0 && await noScroll(page), errors.join(' | '));
  await browser.close();
}
await done(null);
