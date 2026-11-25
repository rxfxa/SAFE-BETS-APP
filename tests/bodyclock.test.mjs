// 🌙 Body Clock tab (bodyclock.js + bodyclock.json): the Monday night breakdown, the study, the night games, the engine wiring
// (a priced Monday game gets the model's numbers and two same game parlays), the "Multi game" label, a missing file.
// Fixtures: bodyclock-2026-11-25.json (the real file as first built: CAR @ TB, not in the feed); bodyclock-mnf-wsh.json (the same
// file with the Monday game switched to CIN @ WSH on Nov 23, which the test feed data-2026-11-23-bc.json prices at the closing
// no-vig moneyline, 28.5% / 71.5%: test prices, not the feed's own).
import { open, check, done, FX } from './lib/harness.mjs';

const T = (page, sel) => page.$eval(sel, e => e.innerText).catch(() => '');
const noScrollX = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------- 1. phone, the real file (CAR @ TB is not in the feed) ----------
let { browser, page, errors } = await open({ width: 390, tab: 'bodyclock', clock: '2026-11-25T18:00:00Z', pins: { 'bodyclock.json': 'bodyclock-2026-11-25.json' }, notFound: ['mypicks.json', 'recs.json', 'plans.json'] });
await page.waitForSelector('#bcWrap', { timeout: 20000 });
const tabLbl = await page.evaluate(() => { const b = document.querySelector('#tabs [data-t="bodyclock"]'); return b ? b.textContent.trim() : ''; });
check('tab is in the sidebar, not marked multi game', /Body Clock/.test(tabLbl) && !/Multi/i.test(tabLbl), tabLbl);
check('tab sits with the research tabs (after Team Trends)', await page.evaluate(() => { const k = [...document.querySelectorAll('#tabs [data-t]')].map(b => b.dataset.t); return k.indexOf('bodyclock') === k.indexOf('trends') + 1; }));
check('paywall: High tier', await page.evaluate(() => !SB.paywall || SB.paywall.needOf('bodyclock') === 3));
let txt = await T(page, '#bcWrap');
check('chips: no edge in NFL, NBA, soccer; the multi game answer in plain words', /NFL: no edge/.test(txt) && /NBA: no edge/.test(txt) && /Soccer: no edge/.test(txt) && /Does it hold in the NBA and soccer too\? No\. So the tab is not marked multi game\./.test(txt));
check('Monday night is the default view', await page.$eval('#bcSeg [data-v="mnf"]', b => b.getAttribute('aria-pressed') === 'true'));
check('hero: CAR @ TB with both body clocks', /Carolina Panthers/.test(txt) && /Tampa Bay Buccaneers/.test(txt) && /8:15 PM EST/.test(txt) && /5:15 PM PST/.test(txt), txt.slice(0, 400));
check("rule doesn't apply (both Eastern)", /rule doesn.t apply/i.test(txt) && /Both teams are on Eastern time/.test(txt));
check('market: spread, total, no-vig, ESPN model, Polymarket', /TB −3 \(-105\)/.test(txt) && /43\.5/.test(txt) && /TB 58% · CAR 42%/.test(txt) && /TB 67%/.test(txt) && /TB 60%/.test(txt), (txt.match(/The market[\s\S]{0,500}/) || [''])[0]);
check("model: says the game isn't in the feed yet (no made-up numbers)", /isn.t in the app.s feed yet/.test(txt) && !(await page.$('[data-sim5^="bc-mnf"]')));
check('last meeting: TB 43, CAR 13 with quarters and stats', /TB 43, CAR 13/.test(txt) && /Rushing yards/.test(txt) && /258/.test(txt));
check('head to head and team form', /Head to head/i.test(txt) && /Form against the closing lines/i.test(txt) && /As underdog/.test(txt));
check('injuries listed for both teams', /Antoine Winfield Jr\./.test(txt) && /Bobby Okereke/.test(txt));
check('head to head shows years', /Dec 1, 2024/.test(txt) && /Oct 25, 2026/.test(txt));
check('team form: every split labelled small, chips explained', /Every split here is a small sample/.test(txt) && /Each game: opponent \(@ = away\)/.test(txt));
await page.waitForFunction(() => /Bryce Young/.test((document.getElementById('bcPlayers') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
const pl = await T(page, '#bcPlayers');
check('key players from the box scores (QB, backs, receivers; vs this opponent)', /Bryce Young/.test(pl) && /Baker Mayfield/.test(pl) && /vs TB/.test(pl) && /vs CAR/.test(pl), pl.slice(0, 300));
check('players: box scores before the game only, with medians', /Median/.test(pl));
check('players: table fits a phone (nothing clipped)', await page.evaluate(() => [...document.querySelectorAll('#bcPlayers .bc-tw')].every(e => e.scrollWidth <= e.clientWidth + 1)));
txt = await T(page, '#bcWrap');
check('last Monday recap', /Washington Commanders 22, Cincinnati Bengals 20/.test(txt) && /Fell short/.test(txt));
check('honest wording (no lock / guaranteed / due)', !/\b(lock|guarantee[ds]?|due)\b/i.test(txt.replace(/not guarantees/g, '').replace(/due to/g, '')));
check('no horizontal scroll at 390 (Monday night)', await noScrollX(page));

// the study
await page.click('#bcSeg [data-v="study"]');
txt = await T(page, '#bcWrap');
check('study: the claim (not in quotation marks) and the verdict', /68%/.test(txt) && /The reel.s claim, in short/.test(txt) && !/“/.test(txt) && /No edge in any of the three sports/.test(txt) && /not marked multi game/i.test(txt));
check('study: how to read p, decisions and the range', /decisions are games that weren.t a push/.test(txt) && /luck alone/.test(txt));
check('study: decisions and games kept apart', /1,344 games \(1,318 decisions\)/.test(txt) && /55 decisions/.test(txt));
check('study: soccer measured in league points', /league points a game \(3 for a win, 1 for a draw\)/i.test(txt));
check('study: NFL re-test 30-25-2, p 0.59', /30-25-2/.test(txt) && /p 0\.59/.test(txt));
check('study: NBA 289-289-14 and 371-369-12', /289-289-14/.test(txt) && /371-369-12/.test(txt));
check('study: soccer -0.18 the wrong way', /−?-0\.18/.test(txt) && /wrong way/.test(txt));
check('study: three "no edge" sections', (txt.match(/: no edge/g) || []).length >= 3);
check('study: papers by sport', /Smith, Guilleminault & Efron/.test(txt) && /Nutting & Price/.test(txt) && /Goumas/.test(txt));
check('study: ranges drawn with labels', (await page.$$('.bc-ci[role="img"]')).length >= 12);
check('no horizontal scroll at 390 (study)', await noScrollX(page));
check('view is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('fm2.bcView')) === 'study'));

// night games
await page.click('#bcSeg [data-v="week"]');
txt = await T(page, '#bcWrap');
check('night games: LV @ CLE flagged, both clocks', /LV @ CLE/.test(txt) && /Rule points at LV/.test(txt) && /5:20 PM PST/.test(txt) && /8:20 PM EST/.test(txt));
check('night games: CAR @ TB not flagged', await page.evaluate(() => { const c = [...document.querySelectorAll('.bc-game')].find(e => /CAR @ TB/.test(e.innerText)); return !!c && !c.classList.contains('ap'); }));
check('night games: flagged games first', await page.evaluate(() => { const c = [...document.querySelectorAll('.bc-game')]; const i = c.findIndex(e => !e.classList.contains('ap')); return i > 0 && c.slice(i).every(e => !e.classList.contains('ap')); }));
check('night games: past games dropped (Gamba Osaka v Port FC, Nov 25 10:00 UTC)', !/Gamba Osaka/.test(txt));
check('night games: an odds object with no numbers shows no market (PHI @ SF)', !/None/.test(txt) && await page.evaluate(() => { const c = [...document.querySelectorAll('.bc-game')].find(e => /PHI @ SF/.test(e.innerText)); return !!c && /No price posted yet/.test(c.innerText) && !c.querySelector('.bc-mk'); }));
check('night games: flagged cards carry the caveat in the rule line', /We found no edge beyond the prices in these spots/.test(txt));
check('night games: 13-season test', /13-season test/.test(txt) && !/15-season/.test(txt));
check('this season under the rule: 2-2-1', /2-2-1 against the spread/.test(txt));
await page.click('[data-bcw="nba"]');
txt = await T(page, '#bcWrap');
const sportsShown = await page.$$eval('.bc-game .bc-when', els => [...new Set(els.map(e => e.innerText.split(' · ')[0]))]);
check('filter: NBA only', sportsShown.length === 1 && sportsShown[0] === 'NBA', JSON.stringify(sportsShown));
check('filter: the NBA rule and its own count', /LAL, LAC, GS, SAC, POR/.test(txt) && /It points at 2 games below/.test(txt), (txt.match(/The rule[\s\S]{0,300}/) || [''])[0]);
check('NBA: GS @ CLE flagged (Dec 12, 8 PM ET)', /GS @ CLE/.test(txt) && /Rule points at GS/.test(txt));
check('NBA: 2-hour gap games labelled', /2-hour gap/.test(txt));
await page.click('[data-bcw="soccer"]');
txt = await T(page, '#bcWrap');
check('soccer: 3-way market with the draw', /draw \d+%/.test(txt) && /Barcelona/.test(txt));
check('soccer: a started game is marked and its price called pre-game', await page.evaluate(() => { const c = [...document.querySelectorAll('.bc-game')].find(e => /Sabah FK v Barcelona/.test(e.innerText)); return !!c && /Started/.test(c.innerText) && /Pre-game market/.test(c.innerText); }));
check('soccer: the rule line says no game here', /It points at no game here/.test(txt));
const SM = await page.evaluate(() => { const S = window.__bodyclock.sideScore; return [S({ abbr: 'LAFC', name: 'Los Angeles FC' }, 'LAFC'), S({ abbr: 'DC', name: 'D.C. United' }, 'D.C. United'), S({ abbr: 'LA', name: 'LA Galaxy' }, 'LAFC'), S({ abbr: 'STL', name: 'Saint Louis City SC' }, 'St. Louis CITY SC'), S({ abbr: 'SBH', name: 'Sabah FK' }, 'Sabah FK')]; });
check('soccer matching: LAFC = Los Angeles FC, D.C. United by its whole name, LA Galaxy is not LAFC', SM[0] > 0 && SM[1] > 0 && SM[2] === 0 && SM[4] > 0, JSON.stringify(SM));
const NY = await page.evaluate(() => { const B = window.__bodyclock, G = SB.DATA.games; const g = { id: 'x-nyc', sport: 'soccer', start: '2026-11-28T00:00:00Z', home: { abbr: 'RBNY', name: 'New York Red Bulls' }, away: { abbr: 'NYC', name: 'New York City FC' }, status: 'scheduled' }; G.push(g); const r = B.feedGame({ sport: 'soccer', kickoffUTC: '2026-11-28T00:00Z', home: { name: 'New York City FC' }, away: { name: 'New York Red Bulls' } }); G.pop(); return r ? r.flip : 'none'; });
check('soccer matching: a New York derby is matched the right way round', NY === true, String(NY));
check('no horizontal scroll at 390 (night games)', await noScrollX(page));
check('no page errors (phone)', errors.length === 0, errors.join(' | '));
await browser.close();

// ---------- 2. desktop, the Monday game priced in the feed: model numbers and two same game parlays ----------
({ browser, page, errors } = await open({ width: 1280, height: 900, tab: 'bodyclock', clock: '2026-11-23T12:00:00Z', pins: { 'bodyclock.json': 'bodyclock-mnf-wsh.json', 'data.json': 'data-2026-11-23-bc.json' }, notFound: ['mypicks.json', 'recs.json', 'plans.json'], init: { 'fm2.bcView': 'mnf' } }));
await page.waitForSelector('#bcWrap', { timeout: 20000 });
await page.waitForFunction(() => document.querySelector('[data-sim5="bc-mnf4"]') || /legs that fit/.test(document.getElementById('bcWrap').innerText), null, { timeout: 20000 }).catch(() => {});
const M = await page.evaluate(() => {
  const B = window.__bodyclock, x = { sport: 'nfl', kickoffUTC: B.BC.mnf.kickoffUTC, away: B.BC.mnf.away, home: B.BC.mnf.home };
  const m = B.model(x, 6), g = SB.gameById('nfl-WAS-CIN-2026-11-24'), s = SB.simGame(g);
  let w = 0, p = 0; for (let i = 0; i < s.N; i++) { const v = s.mg[i] + 6; if (v > 1e-9) w++; else if (Math.abs(v) <= 1e-9) p++; }
  return { inFeed: m.inFeed, priced: m.priced, flip: m.flip, home: m.home, pH: SB.p1(g, 'H'), cover: m.cover && m.cover.home, cover2: w / s.N, push: m.cover && m.cover.push, push2: p / s.N };
});
check('feed match: WSH (ESPN) = WAS (feed), same orientation', M.inFeed && M.priced && M.flip === false, JSON.stringify(M));
check("model win chance = the engine's", Math.abs(M.home - M.pH) < 1e-9);
check('model spread: WSH +6 cover counted on the 100,000 simulations', Math.abs(M.cover - M.cover2) < 1e-9 && Math.abs(M.push - M.push2) < 1e-9, `${M.cover} ${M.cover2}`);
txt = await T(page, '#bcWrap');
check('model block shows the chances next to the market', new RegExp(`${Math.round(M.pH * 100)}%`).test(txt) && /WSH to win \(market 2[89]%\)/.test(txt) && /WSH \+6 covers/.test(txt), (txt.match(/The app.s model[\s\S]{0,400}/) || [''])[0]);
const cards = await page.evaluate(() => ['bc-mnf4', 'bc-mnf7'].map(id => { const T = window.__fm2.autoCache[id]; return T ? { n: T.legs.length, gids: [...new Set(T.legs.map(l => l.gid))], swap: !!document.querySelector(`[data-sub^="${id}|"]`), sim: !!document.querySelector(`[data-sim5="${id}"]`) } : null; }));
check('two same game parlays, every leg from this game', cards.every(c => c && c.n >= 4 && c.gids.length === 1 && c.gids[0] === 'nfl-WAS-CIN-2026-11-24'), JSON.stringify(cards));
check('cards have ⇄ swaps and 500,000 runs', cards.every(c => c && c.swap && c.sim));
await page.waitForFunction(() => /Joe Burrow/.test((document.getElementById('bcPlayers') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
const pl2 = await T(page, '#bcPlayers');
check('players: CIN and WSH from the box scores', /Joe Burrow/.test(pl2) && /Jayden Daniels/.test(pl2), pl2.slice(0, 200));
check('players: only games before the Monday (Burrow: 9 games, none vs WSH yet)', /Joe Burrow[\s\S]{0,40}9 games/.test(pl2) && /vs WSH/.test(pl2));
check('no page errors (desktop, priced)', errors.length === 0, errors.join(' | '));
await browser.close();

// ---------- 3. the label follows the research: multi game when the edge holds in 2+ sports ----------
const multiFile = JSON.parse(FX('bodyclock-2026-11-25.json'));
multiFile.research.verdict.multi = true;
({ browser, page, errors } = await open({ width: 390, tab: 'bodyclock', clock: '2026-11-25T18:00:00Z', notFound: ['mypicks.json', 'recs.json', 'plans.json'],
  before: async p => { await p.route(/\/bodyclock\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(multiFile) })); } }));
await page.waitForSelector('#bcWrap', { timeout: 20000 });
await page.waitForFunction(() => /Multi game/.test((document.querySelector('#tabs [data-t="bodyclock"]') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
check('multi flag: tab labelled "Multi game"', /Multi game/.test(await page.$eval('#tabs [data-t="bodyclock"]', b => b.textContent)));
check('no page errors (multi)', errors.length === 0, errors.join(' | '));
await browser.close();

// ---------- 4. the file is missing ----------
({ browser, page, errors } = await open({ width: 390, tab: 'bodyclock', clock: '2026-11-25T18:00:00Z', pins: { 'bodyclock.json': null }, notFound: ['mypicks.json', 'recs.json', 'plans.json'] }));
await page.waitForFunction(() => /not available right now|Loading/.test(document.querySelector('main') ? document.querySelector('main').innerText : ''), null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => /not available right now/.test(document.querySelector('main').innerText), null, { timeout: 10000 }).catch(() => {});
check('missing file: says so, no crash', /not available right now/.test(await T(page, 'main')) && errors.length === 0, errors.join(' | '));
await done(browser);
