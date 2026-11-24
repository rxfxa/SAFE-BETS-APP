// Games (slate.js): day tabs, sport pills, one matchup card per game with the model's fair lines, lean bands only with evidence
// (Team Trends or a Polymarket gap of 3+ points), key props with + Slip, the buttons and the {gid} param.
// Fixtures pinned, clock 2026-11-23T12:00Z. The 23 Nov feed has no NBA / NFL / NHL prices for the games still to play, so the test
// writes a copy with prices on one game of each (and an NBA game total), a small trends.json with one upset flag and one
// over / under lean (plus entries that must NOT make a lean: an "underdog" the prices now favour, a team on the wrong side),
// and a Polymarket copy with a 6-point gap on one game. A lean from Polymarket needs the Sharp Board's strong signal (3+ points
// on the side, two-sided quote, $10k+ traded, under 15 points apart). Run: node tests/slate.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, check, done, FX, ROOT } from './lib/harness.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-'));
const rel = f => path.relative(path.join(ROOT, 'tests/fixtures'), f);   // pins are read from tests/fixtures/<name>
const put = (name, obj) => { const f = path.join(TMP, name); fs.writeFileSync(f, JSON.stringify(obj)); return rel(f); };
const DAY = '2026-11-23', laDay = s => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(s));
const NOW = Date.parse('2026-11-23T12:00:00Z');

// ---------- fixtures ----------
const D = JSON.parse(FX('data-2026-11-23.json'));
const upcoming = D.games.filter(g => Date.parse(g.start) > NOW && g.status !== 'closed').sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
const first = sp => upcoming.find(g => g.sport === sp && laDay(g.start) === DAY);
const NBA = first('nba'), NFL = first('nfl'), NHL = first('nhl');
NBA.prob = { home: 0.64, away: 0.36 }; NBA.total = 231.5;
NFL.prob = { home: 0.3, away: 0.7 };   // an away favourite
NHL.prob = { home: 0.56, away: 0.44 };
const dataPin = put('data.json', D);
const SOC = upcoming.find(g => g.id === 'soccer-BRE-EVE-2026-11-23');
const TR = { asOf: DAY, teams: [
  { name: NBA.away.name, sport: 'nba', comp: 'NBA', abbr: NBA.away.abbr, windows: {}, next: { gid: NBA.id, home: false, opp: NBA.home.name, p: 0.36, line: null,
    lean: { upset: { flag: true, role: 'underdog', why: [`${NBA.away.name} as an underdog this season: won 5 of 9, prices expected 3.1 (small sample, could be chance)`, `${NBA.away.name} in the last 30 days: won 3 of 5, prices expected 1.6 (small sample, could be chance)`], strength: 1.9 }, total: { side: null, why: [], n: 0 } } } },
  { name: NBA.home.name, sport: 'nba', comp: 'NBA', abbr: NBA.home.abbr, windows: {}, next: { gid: NBA.id, home: true, opp: NBA.away.name, p: 0.64, line: null,
    lean: { upset: { flag: false, role: 'favourite', why: [], strength: 0 }, total: { side: null, why: [], n: 0 } } } },
  { name: SOC.home.name, sport: 'soccer', comp: SOC.comp, abbr: SOC.home.abbr, windows: {}, next: { gid: SOC.id, home: true, opp: SOC.away.name, p: 0.4, line: null,
    lean: { upset: { flag: false, role: null, why: [] }, total: { side: 'under', n: 20, why: [`${SOC.home.name} games: 3 of 10 over 2.5 (prices expected 5.2 of 9)`, `${SOC.away.name} games: 5 of 10 over 2.5 (prices expected 5.0 of 9)`, 'Together: 8 of 20 (40%) over 2.5, -2.2 against the prices'] } } } },
  { name: 'Unrelated FC', sport: 'soccer', comp: 'Serie A', abbr: 'UNR', windows: {}, next: { gid: 'soccer-MON-FIO-2026-11-23', home: true, opp: 'x', p: 0.3, line: null,
    lean: { upset: { flag: false, role: 'underdog', why: [] }, total: { side: 'over', why: ['Together: 14 of 20 (70%) over 2.5'], n: 20 } } } },   // not in that game: no lean
  // flagged as the underdog with the morning's prices, but the feed now makes this side the favourite (70%): no upset lean
  { name: NFL.away.name, sport: 'nfl', comp: 'NFL', abbr: NFL.away.abbr, windows: {}, next: { gid: NFL.id, home: false, opp: NFL.home.name, p: 0.45, line: null,
    lean: { upset: { flag: true, role: 'underdog', why: [`${NFL.away.name} as an underdog this season: won 4 of 6, prices expected 2.2 (small sample, could be chance)`], strength: 1.8 }, total: { side: null, why: [], n: 0 } } } },
  // the home team listed as the away side (a swapped entry): dropped
  { name: NHL.home.name, sport: 'nhl', comp: 'NHL', abbr: NHL.home.abbr, windows: {}, next: { gid: NHL.id, home: false, opp: NHL.away.name, p: 0.44, line: null,
    lean: { upset: { flag: true, role: 'underdog', why: [`${NHL.home.name} as an underdog this season: won 6 of 9, prices expected 3.5`], strength: 2.5 }, total: { side: 'over', why: ['Together: 22 of 30 (73%) over the line'], n: 30 } } } },
] };
const trendsPin = put('trends.json', TR);
const PM = JSON.parse(FX('polymarket-2026-11-23b.json'));
const ars = D.games.find(g => g.id === 'soccer-ARS-BVB-2026-11-24'), pa = PM.games.find(x => x.sport === 'soccer' && x.home.abbr === 'ARS' && x.away.abbr === 'BVB' && !x.stale);
{ const b = ars.prob, s = b.home + b.away + b.draw, q = m => ({ ...m, b: +(m.m - 0.005).toFixed(4), a: +(m.m + 0.005).toFixed(4) });
  pa.ml.home = q({ ...pa.ml.home, m: +(b.home / s + 0.06).toFixed(4) }); pa.ml.away = q({ ...pa.ml.away, m: +(b.away / s - 0.04).toFixed(4) }); pa.ml.draw = q({ ...pa.ml.draw, m: +(b.draw / s - 0.02).toFixed(4) }); }
const pmPin = put('polymarket.json', PM);

const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'slate', pins: { 'data.json': dataPin, 'trends.json': trendsPin, 'polymarket.json': pmPin } });
await page.waitForFunction(() => window.__slate && __slate.trendsState === 'done' && window.__sharp && __sharp.state === 'done' && document.querySelectorAll('.sl-card').length > 0, null, { timeout: 20000 });
await page.waitForTimeout(250);

// ---------- first render, header, honesty ----------
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${Math.round(fr)} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a re-render stays fast', rr < 600, `${Math.round(rr)} ms`);
check('registered as "Games" in the sidebar', /^\s*Games\s*$/.test(await page.locator('#tabs [data-t="slate"]').textContent()), await page.locator('#tabs [data-t="slate"]').textContent());
const txt = await page.locator('.sl-root').innerText();
check('header and honest notes: model estimates, fair line not a book line, league-average totals, no guarantees',
  /model estimate/i.test(txt) && /not a book's posted line/.test(txt) && /league average/.test(txt) && /not guarantees/.test(txt));
check('no certainty words', !/guarantee[ds]?\b(?! )|\block\b|sure thing|can't lose|\bdue\b/i.test(txt.replace(/not guarantees|not a guaranteed edge/g, '')));

// ---------- day tabs and sport pills ----------
const days = await page.evaluate(() => [...document.querySelectorAll('[data-ui-pill^="sl-day|"]')].map(b => ({ k: b.dataset.uiPill.split('|')[1], label: b.innerText.replace(/\s+/g, ' ').trim(), on: b.classList.contains('on') })));
const exp = await page.evaluate(() => { const E = SB.engine, t = E.dayOf(Date.now()), o = {}; for (const g of SB.DATA.games) if (SB.openG(g)) { const d = E.dayOf(SB.startMs(g)); o[d] = (o[d] || 0) + 1; } return { t, o }; });
check('day tabs: Today and Tomorrow first, Los Angeles days, counts from the feed', days[0].k === DAY && /^Today \d+$/.test(days[0].label) && days[0].on && days[1].k === '2026-11-24' && /^Tomorrow/.test(days[1].label)
  && days.every(d => +d.label.split(' ').pop() === (exp.o[d.k] || 0)) && days.length >= 5, JSON.stringify(days.map(d => d.label)));
const sp = await page.evaluate(() => [...document.querySelectorAll('[data-ui-pill^="sl-sport|"]')].map(b => b.innerText.replace(/\s+/g, ' ').trim()));
check('sport pills with counts for the day', sp.join(',') === 'All 20,NBA 8,NFL 1,NHL 7,Soccer 4', sp.join(','));
check('one card per game on the day', await page.locator('.sl-card').count() === 20);

// ---------- model numbers on the cards (recomputed from SB.fit / SB.p1 / the game's simulations) ----------
const nums = await page.evaluate(([nba, nfl, nhl]) => {
  const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2)), P = p => Math.round(p * 100) + '%', F = p => SB.ui.fair(p).replace('-', '−');
  const tiles = id => [...document.querySelectorAll(`#sl-${CSS.escape(id)} .sl-tile`)].map(t => [...t.children].map(x => x.textContent.trim()).join(' '));
  const out = {};
  { const g = SB.gameById(nba), m = SB.fit(g), L = Math.round(Math.abs(m.mu) * 2) / 2, fav = m.mu >= 0 ? g.home.abbr : g.away.abbr;
    const cover = 1 - Phi((L - Math.abs(m.mu)) / m.sd), s = SB.simGame(g); let c = 0; for (let i = 0; i < s.N; i++) if ((m.mu >= 0 ? s.mg[i] : -s.mg[i]) > L) c++;
    const ph = g.prob.home / (g.prob.home + g.prob.away);
    out.nba = { tiles: tiles(nba), want: [`Spread ${fav} −${L} covers ${P(cover)}`, `Money ${g.home.abbr} ${F(ph)} ${g.away.abbr} ${F(1 - ph)} · fair`, `Total 231.5 over 50%`], sim: c / s.N, cover, wp: [...document.querySelectorAll(`#sl-${CSS.escape(nba)} .sl-wp`)].map(x => x.innerText.replace(/\s/g, '')), wpw: [P(1 - ph), P(ph)] }; }
  { const g = SB.gameById(nfl), m = SB.fit(g), L = Math.round(Math.abs(m.mu) * 2) / 2; let cover = 0, push = 0;
    for (let i = 0; i < m.pm.length; i++) { const d = i - m.kmax; if (-d > L) cover += m.pm[i]; else if (-d === L) push += m.pm[i]; }
    const s = SB.simGame(g); let c = 0; for (let i = 0; i < s.N; i++) if (-s.mg[i] > L) c++;
    out.nfl = { tiles: tiles(nfl), fav: g.away.abbr, L, cover, push, sim: c / s.N, want: `Spread ${g.away.abbr} −${Number.isInteger(L) ? L : L.toFixed(1)} covers ${P(cover)}${push >= 0.005 ? ` · push ${P(push)}` : ''}` }; }
  { const g = SB.gameById(nhl), fh = SB.p1(g, 'H') >= SB.p1(g, 'A'), fav = fh ? g.home.abbr : g.away.abbr;
    out.nhl = { tiles: tiles(nhl), want: `Puck line ${fav} −1.5 covers ${P(SB.p1(g, fh ? 'H2' : 'A2'))}` }; }
  { const g = SB.gameById('soccer-BRE-EVE-2026-11-23'), card = document.getElementById('sl-' + g.id);
    out.soc = { wp: [...card.querySelectorAll('.sl-wp')].map(x => x.innerText.replace(/\s/g, '')), dr: card.querySelector('.sl-dr').innerText, want: [P(SB.p1(g, 'A')), P(SB.p1(g, 'H'))], wantD: P(SB.p1(g, 'D')),
      tot: card.querySelectorAll('.sl-tile')[2].innerText.replace(/\s+/g, ' '), wantT: `over ${P(SB.p1(g, 'O2.5'))}`, draw: card.querySelectorAll('.sl-tile')[1].innerText.replace(/\s+/g, ' '), wantDr: F(SB.p1(g, 'D')) }; }
  return out;
}, [NBA.id, NFL.id, NHL.id]);
check('NBA card: spread = fair line (mean margin to the half point) with the normal cover chance; money = fair odds; game total used', JSON.stringify(nums.nba.tiles) === JSON.stringify(nums.nba.want), JSON.stringify(nums.nba.tiles) + ' vs ' + JSON.stringify(nums.nba.want));
check('NBA cover chance matches the game\'s 100,000 simulations (within 1 point)', Math.abs(nums.nba.sim - nums.nba.cover) < 0.01, `${nums.nba.cover.toFixed(4)} vs sim ${nums.nba.sim.toFixed(4)}`);
check('NBA win chances shown per side (away left, home right)', JSON.stringify(nums.nba.wp) === JSON.stringify(nums.nba.wpw), JSON.stringify(nums.nba.wp));
check('NFL card: an away favourite\'s line, cover from the key-number margin model', nums.nfl.tiles[0] === nums.nfl.want && /league avg/.test(nums.nfl.tiles[2]), JSON.stringify(nums.nfl.tiles[0]) + ' vs ' + nums.nfl.want);
check('NFL cover chance matches the simulations (within 1 point)', Math.abs(nums.nfl.sim - nums.nfl.cover) < 0.01, `${nums.nfl.cover.toFixed(4)} vs ${nums.nfl.sim.toFixed(4)}`);
check('NHL card: puck line (win by 2+) from the score grid via SB.p1', nums.nhl.tiles[0] === nums.nhl.want, JSON.stringify(nums.nhl.tiles[0]) + ' vs ' + nums.nhl.want);
check('soccer card: home / draw / away chances, draw fair odds and over 2.5 from SB.p1', JSON.stringify(nums.soc.wp) === JSON.stringify(nums.soc.want) && nums.soc.dr.includes(nums.soc.wantD) && nums.soc.tot.includes(nums.soc.wantT) && nums.soc.draw.includes(nums.soc.wantDr),
  JSON.stringify(nums.soc));
const unpriced = await page.evaluate(() => { const g = SB.engine.dayGames(SB.engine.dayOf(Date.now())).find(x => !x.prob); const c = g && document.getElementById('sl-' + g.id); return c ? { t: c.innerText, tiles: c.querySelectorAll('.sl-tile').length } : null; });
check('a game without prices says so and shows no model lines', unpriced && /No sportsbook prices in the feed/.test(unpriced.t) && unpriced.tiles === 0);

// ---------- lean bands: only with evidence ----------
async function allCards() {
  const out = [];
  const keys = await page.evaluate(() => [...document.querySelectorAll('[data-ui-pill^="sl-day|"]')].map(b => b.dataset.uiPill));
  for (const k of keys) {
    await page.click(`[data-ui-pill="${k}"]`);
    out.push(...await page.evaluate(() => [...document.querySelectorAll('.sl-card')].map(c => ({ gid: c.dataset.slGid, leans: [...c.querySelectorAll('[data-sl-lean]')].map(l => l.dataset.slLean), priced: c.querySelectorAll('.sl-tile').length > 0, text: [...c.querySelectorAll('[data-sl-lean], .sl-pmx')].map(l => l.innerText.replace(/\s+/g, ' ')).join(' | '), hscroll: document.documentElement.scrollWidth }))));
  }
  return out;
}
const cards = await allCards();
// every matched game, recomputed from the raw quotes: a lean needs a side 3+ pts higher on Polymarket, every side quoted
// two-sided within 12¢, $10k+ traded on the moneyline and no side 15+ pts apart
const pmAll = await page.evaluate(() => __sharp.rows().map(c => {
  const ml = c.pg.ml, qs = c.swap ? { H: ml.away, A: ml.home, D: ml.draw } : { H: ml.home, A: ml.away, D: ml.draw }, soc = c.g.sport === 'soccer';
  const ks = soc ? ['H', 'A', 'D'] : ['H', 'A'], sum = ks.reduce((a, k) => a + qs[k].m, 0), b = c.g.prob, bs = b.home + b.away + (soc ? b.draw : 0);
  const gaps = ks.map(k => qs[k].m / sum - ({ H: b.home, A: b.away, D: b.draw })[k] / bs), live = ks.every(k => qs[k].b > 0 && qs[k].a < 1 && qs[k].a > qs[k].b && qs[k].a - qs[k].b <= 0.12);
  return { gid: c.g.id, maxGap: Math.max(...gaps.map(Math.abs)), up: Math.max(...gaps), live, vol: ml.v || 0 };
}));
const pmGaps = pmAll.filter(x => x.live && x.vol >= 10000 && x.up >= 0.03 && x.maxGap <= 0.15);
const thin = pmAll.filter(x => x.maxGap >= 0.03 && x.maxGap <= 0.15 && !pmGaps.includes(x)), odd = pmAll.filter(x => x.maxGap > 0.15);
const expPM = new Set(pmGaps.map(x => x.gid)), expTR = new Set([NBA.id, SOC.id]);
const priced = cards.filter(c => c.priced);
const wrongPM = priced.filter(c => c.leans.includes('pm') !== expPM.has(c.gid)), wrongTR = priced.filter(c => c.leans.includes('trends') !== expTR.has(c.gid));
check('Polymarket lean bands exactly on the strong signals (recomputed from the raw quotes: 3+ pts on the side, $10k+, two-sided, under 15 pts)', pmGaps.length >= 1 && !wrongPM.length && expPM.has(ars.id), `${pmGaps.map(x => x.gid + ' ' + (x.up * 100).toFixed(1)).join(', ')} wrong: ${wrongPM.map(c => c.gid).join(',')}`);
const thinC = thin.map(x => cards.find(c => c.gid === x.gid)).filter(Boolean);
check('a 3+ pt gap on a thin market ($0-$10k traded, e.g. the college games) is no lean, and the No lean band says why', thin.length >= 3 && thinC.length === thin.length && thinC.every(c => c.leans.join() === 'none' && /not enough for a lean/.test(c.text)), thin.map(x => x.gid + ' $' + x.vol).join(', '));
const oddC = odd.map(x => cards.find(c => c.gid === x.gid)).filter(Boolean);
check('prices 15+ pts apart (the test\'s NBA game: 24.5) are treated as a data problem, never a lean', odd.some(x => x.gid === NBA.id) && oddC.every(c => !c.leans.includes('pm') && /looks like a data problem/.test(c.text)), odd.map(x => x.gid + ' ' + (x.maxGap * 100).toFixed(1)).join(', '));
check('Team Trends lean bands exactly on the flagged games (not on a game whose trend has no lean, a team not in that game, a swapped side, or an "underdog" the prices now favour)', !wrongTR.length && cards.find(c => c.gid === NFL.id).leans.join() === 'none' && cards.find(c => c.gid === NHL.id).leans.join() === 'none' && cards.find(c => c.gid === 'soccer-MON-FIO-2026-11-23').leans.join() === 'none', wrongTR.map(c => c.gid).join(','));
check('every other priced card says "No lean: the model is priced from the market"', priced.filter(c => !c.leans.includes('pm') && !c.leans.includes('trends')).every(c => c.leans.join() === 'none' && /No lean: the model is priced from the market/.test(c.text)) && priced.length > 40, `${priced.length} priced cards`);
const nbaL = cards.find(c => c.gid === NBA.id), socL = cards.find(c => c.gid === SOC.id), arsL = cards.find(c => c.gid === ars.id);
check('trends upset band: underdog, wins vs prices, its reasons, and the sample counted once per team (9, not 9 + 5) with its caveats', /Upset watch/i.test(nbaL.text) && nbaL.text.includes(`${NBA.away.abbr} to win`) && nbaL.text.includes(`${NBA.away.name}, the underdog`) && /\+1\.9/.test(nbaL.text) && /\b9 games · small sample · could be chance/.test(nbaL.text) && nbaL.leans.join() === 'trends', nbaL.text.slice(0, 260));
check('trends total band: under 2.5 with the rate and the sample', /Under 2\.5 goals/.test(socL.text) && /60%/.test(socL.text) && /20 games/.test(socL.text), socL.text.slice(0, 200));
check('Polymarket band: "Polymarket 6.0 pts higher on Arsenal", strong signal, volume', /ARS to win/.test(arsL.text) && /Polymarket 6\.0 pts higher on Arsenal FC/.test(arsL.text) && /\+6\.0/.test(arsL.text) && /Strong signal/i.test(arsL.text) && /traded/.test(arsL.text), arsL.text.slice(0, 220));
check('no horizontal page scroll at 390px on any day', cards.every(c => c.hscroll <= 390), Math.max(...cards.map(c => c.hscroll)) + 'px');

// ---------- the {gid} param, key props, buttons ----------
await page.evaluate(() => SB.goTab('slate', { gid: 'soccer-PSG-FCL-2026-11-28' }));
await page.waitForTimeout(300);
const jump = await page.evaluate(() => { const c = document.getElementById('sl-soccer-PSG-FCL-2026-11-28'), r = c && c.getBoundingClientRect(); return { on: document.querySelector('[data-ui-pill^="sl-day|"].on').dataset.uiPill, focus: c && c.classList.contains('sl-focus'), top: r && r.top }; });
check('{gid} opens that game\'s day, highlights the card and scrolls to it', jump.on === 'sl-day|2026-11-28' && jump.focus && jump.top >= -2 && jump.top < 200, JSON.stringify(jump));
await page.evaluate(() => SB.render());   // a later re-render (e.g. evidence arriving) keeps the highlight
check('the highlight survives a re-render', await page.evaluate(() => !!document.querySelector('#sl-soccer-PSG-FCL-2026-11-28.sl-focus')));
const tm = await page.evaluate(() => [...document.querySelectorAll('.sl-mid .sl-t')].map(x => [x.firstChild.textContent, (x.querySelector('small') || {}).textContent]));
check('kick-off time split into the time and AM / PM', tm.length > 0 && tm.every(([t, ap]) => /^\d{1,2}:\d{2}$/.test(t) && /^(AM|PM)$/.test(ap)), JSON.stringify(tm.slice(0, 3)));
// a game that has finished: shown when asked for, with the score and no + Slip buttons
const fin = D.games.find(g => g.status === 'closed' && g.score && (D.players || []).some(p => p.gid === g.id)) || D.games.find(g => g.status === 'closed' && g.score);
await page.evaluate(id => SB.goTab('slate', { gid: id }), fin.id);
await page.waitForTimeout(200);
const finC = await page.evaluate(id => { const c = document.getElementById('sl-' + id); return c ? { t: c.innerText, add: c.querySelectorAll('[data-sl-add]').length, focus: c.classList.contains('sl-focus') } : null; }, fin.id);
check('a finished game asked for by {gid}: shown with its score, no pre-game lines and no + Slip', finC && finC.focus && /Final/i.test(finC.t) && finC.t.includes(`${fin.away.abbr} ${fin.score.away} – ${fin.score.home} ${fin.home.abbr}`) && finC.add === 0, JSON.stringify(finC && { add: finC.add, t: finC.t.slice(0, 80) }));
await page.evaluate(() => SB.goTab('slate', { gid: 'nba-XXX-YYY-2026-11-23' }));
await page.waitForTimeout(150);
check('an unknown {gid} says so and shows the slate', /not in the feed any more/.test(await page.locator('.sl-root').innerText()) && await page.locator('.sl-card').count() > 0);
await page.evaluate(() => SB.goTab('slate', { gid: 'nba-PHI-POR-2026-11-24' }));
await page.waitForTimeout(250);
const kp = await page.evaluate(() => [...document.querySelectorAll('#sl-nba-PHI-POR-2026-11-24 .sl-prop')].map(r => ({ name: r.querySelector('.sl-pn b').innerText, p: parseInt(r.querySelector('.sl-pc b').innerText, 10), key: r.querySelector('[data-sl-add]').dataset.slAdd })));
const kpWant = await page.evaluate(() => __slate.keyProps(SB.gameById('nba-PHI-POR-2026-11-24')).map(x => ({ name: x.pl.name, p: Math.round(x.p * 100), key: 'nba-PHI-POR-2026-11-24|' + x.key })));
check('key props: the three likeliest legs, one per player, highest chance first', kp.length === 3 && new Set(kp.map(x => x.name)).size === 3 && kp[0].p >= kp[1].p && kp[1].p >= kp[2].p && JSON.stringify(kp) === JSON.stringify(kpWant), JSON.stringify(kp));
const add = page.locator('#sl-nba-PHI-POR-2026-11-24 [data-sl-add]').first();
await add.click();
const inS = await page.evaluate(k => { const [g, ...r] = k.split('|'); return SB.inSlip(g, r.join('|')); }, kp[0].key);
check('+ Slip adds the leg to the slip and the button shows it', inS && /✓ Slip/.test(await add.innerText()) && await add.getAttribute('aria-pressed') === 'true');
await add.click();
check('pressing it again takes the leg out', !(await page.evaluate(k => { const [g, ...r] = k.split('|'); return SB.inSlip(g, r.join('|')); }, kp[0].key)) && /\+ Slip/.test(await add.innerText()));
const tap = await page.evaluate(() => { const bad = [...document.querySelectorAll('.sl-root button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 40).map(b => b.innerText); return bad; });
check('tap targets are 40px or taller', !tap.length, tap.slice(0, 5).join(','));
await page.click(`#sl-${NBA.id} [data-sl-deep]`).catch(() => {});
await page.evaluate(id => { SB.goTab('slate', { gid: id }); }, NBA.id);
await page.waitForTimeout(200);
await page.click(`#sl-${NBA.id} [data-sl-deep]`);
await page.waitForTimeout(250);
const sheet = await page.evaluate(() => { const s = document.getElementById('sheet'); return !!s && s.getBoundingClientRect().height > 50 && /Hawks|Pistons|win/i.test(s.innerText) ? s.innerText.slice(0, 60) : (s ? 'closed' : 'none'); });
check('Deep dive opens the game sheet', sheet && sheet !== 'closed' && sheet !== 'none', sheet);
await page.evaluate(() => SB.closeSheet());
await page.click(`#sl-${NBA.id} [data-sl-ask]`);
await page.waitForTimeout(250);
const ask = await page.evaluate(() => ({ tab: SB.tab, v: (document.querySelector('#main textarea, #main input[type="text"]') || {}).value || '' }));
check('Ask opens Chat with the matchup question', ask.tab === 'ask' && ask.v.includes(`${NBA.away.name} at ${NBA.home.name}`), JSON.stringify(ask));
await page.evaluate(id => SB.goTab('slate', { gid: id }), NBA.id);
await page.waitForTimeout(200);
await page.click(`#sl-${NBA.id} [data-sl-sim]`);
await page.waitForTimeout(300);
check('Simulate opens the Simulator on that game', await page.evaluate(() => SB.tab) === 'sim');
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();

// ---------- no evidence files: honest bands, still renders ----------
{
  const o = await open({ width: 390, height: 844, tab: 'slate', pins: { 'data.json': dataPin, 'trends.json': null, 'polymarket.json': null } });
  await o.page.waitForFunction(() => window.__slate && __slate.trendsState === 'done' && window.__sharp && __sharp.state === 'done' && document.querySelectorAll('.sl-card').length > 0, null, { timeout: 20000 });
  await o.page.waitForTimeout(200);
  const L = await o.page.evaluate(() => [...document.querySelectorAll('[data-sl-lean]')].map(x => x.dataset.slLean));
  check('without trends.json and polymarket.json: no lean bands, every priced card says no lean', L.length > 0 && L.every(x => x === 'none'), L.join(','));
  check('no page errors without the evidence files', !o.errors.length, o.errors.join(' | '));
  await o.browser.close();
}
fs.rmSync(TMP, { recursive: true, force: true });
await done(null);
