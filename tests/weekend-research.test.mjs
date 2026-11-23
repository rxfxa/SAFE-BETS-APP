// tools/weekend_research.py across a weekend: a round's legs freeze once its games kick off (pre-match prices kept,
// finished games count as they ended, runs on the line kept), team names match deterministically, 'last 4 games of the
// season' uses the full schedule, the 'typical' round has the same number of big favourites, and weekend_pattern.py
// keeps the research block. Runs on fixtures (tests/fixtures/fd = this season's results, data-2026-11-23.json = the feed).
// Run: node tests/weekend-research.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wkr-'));
const py = (args, env = {}) => execFileSync('python3', ['-I', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
try {
  const csv = path.join(T, 'csv'); fs.mkdirSync(csv);
  for (const L of ['E0', 'SP1', 'I1', 'D1', 'F1', 'N1', 'P1']) fs.copyFileSync(path.join(ROOT, 'tests/fixtures/fd', L + '.csv'), path.join(csv, `2627_${L}.csv`));
  const feed1 = path.join(ROOT, 'tests/fixtures/data-2026-11-23.json'), P = path.join(T, 'pattern.json');
  const run = (feed, now, pat = P) => { py(['tools/weekend_research.py', csv, '--feed', feed, '--pattern', pat, '--now', now, '--min', '300', '--sims', '200']); return JSON.parse(fs.readFileSync(pat, 'utf8')).research; };

  // Monday: the coming weekend's forecast
  const R1 = run(feed1, '2026-11-23T12:00:00Z'), F1 = R1.forecast;
  check('Monday: the forecast is for the coming weekend, with its big favourites', F1 && F1.round === '2026-11-28' && F1.favs >= 3 && F1.done === 0 && F1.carried === 0, JSON.stringify(F1 && { round: F1.round, favs: F1.favs }));
  check('every feed club name in the five leagues matches a football-data team', Array.isArray(R1.unmatchedFeedNames) && R1.unmatchedFeedNames.length === 0, JSON.stringify(R1.unmatchedFeedNames));
  check('"typical" is a round with the same number of big favourites (same threshold), plus prices-alone and real rates', F1.need === Math.ceil(0.4 * F1.favs - 1e-9) && F1.typical > 0 && F1.typicalPriced > F1.typical && (F1.typicalReal == null ? F1.typicalRounds === 0 : F1.typicalRounds >= 30), JSON.stringify({ n: F1.favs, need: F1.need, t: F1.typical, tp: F1.typicalPriced, real: F1.typicalReal, rounds: F1.typicalRounds }));
  const distSum = F1.dist.reduce((a, b) => a + b, 0), tail = F1.dist.slice(F1.need).reduce((a, b) => a + b, 0);
  check('the crazy chance is the exact tail of the fails distribution', Math.abs(distSum - 1) < 1e-3 && Math.abs(tail - F1.pCrazy) < 1e-3, `${distSum} ${tail} ${F1.pCrazy}`);
  check("'last 4 games of the season' is never flagged in a season that is only a third played", !R1.causes.some(c => c.key === 'late'), JSON.stringify(R1.causes.map(c => c.key)));

  // Saturday afternoon: some of the round has kicked off; the finished favourites all lost (prices removed, as the real feed does)
  const cut = Date.parse('2026-11-28T16:00:00Z'), feed = JSON.parse(fs.readFileSync(feed1, 'utf8')), favSide = Object.fromEntries(F1.legs.map(l => [l.gid, l.favSide]));
  const started = new Set();
  for (const g of feed.games) {
    if (g.sport !== 'soccer' || Date.parse(g.start) >= cut) continue;
    const s = favSide[g.id]; if (!s && !(Date.parse(g.start) >= Date.parse('2026-11-27T00:00:00Z'))) continue;
    started.add(g.id); g.status = 'closed'; g.prob = null; g.score = s === 'home' ? { home: 0, away: 1 } : s === 'away' ? { home: 1, away: 0 } : { home: 1, away: 1 };
  }
  const feed2 = path.join(T, 'feed-sat.json'); fs.writeFileSync(feed2, JSON.stringify(feed));
  const startedLegs = F1.legs.filter(l => started.has(l.gid));
  const R2 = run(feed2, '2026-11-28T16:00:00Z'), F2 = R2.forecast;
  check('Saturday: still the same round, with every big favourite (none dropped because its game started)', F2 && F2.round === F1.round && F2.favs === F1.favs && startedLegs.length > 0, JSON.stringify(F2 && { favs: F2.favs, was: F1.favs, started: startedLegs.length }));
  check('games that kicked off keep their pre-match leg (price, research estimate, reasons)', startedLegs.every(l => { const m = F2.legs.find(x => x.gid === l.gid); return m && m.frozen && m.priced === l.priced && m.model === l.model && JSON.stringify(m.reasons) === JSON.stringify(l.reasons); }) && F2.carried === startedLegs.length);
  check('finished games count as they ended (all lost here), so the crazy chance rises', F2.done === startedLegs.length && F2.failed === startedLegs.length && F2.pCrazy > F1.pCrazy && F2.legs.filter(l => l.result === 'failed').length === startedLegs.length, JSON.stringify({ done: F2.done, failed: F2.failed, p1: F1.pCrazy, p2: F2.pCrazy }));
  const runs1 = R1.runsNow.filter(r => started.has(r.gid));
  check('runs on the line in games that kicked off are kept', runs1.every(r => R2.runsNow.some(x => x.gid === r.gid && x.team === r.team && x.unbeaten === r.unbeaten)), `${runs1.length} started-game runs`);
  check('the round keeps its leagues, and every started game had been priced before kick-off', JSON.stringify(F2.leagues) === JSON.stringify(F1.leagues) && F2.startedUnpriced === 0, JSON.stringify({ l1: F1.leagues, l2: F2.leagues, unpriced: F2.startedUnpriced }));
  check('real rounds are quoted only from 30+ rounds of about the same size (window 0-2), else not at all', (F1.typicalReal == null && F1.typicalRounds === 0) || (F1.typicalRounds >= 30 && F1.typicalWindow <= 2), JSON.stringify({ r: F1.typicalRounds, w: F1.typicalWindow }));

  // Monday: Friday's and Saturday's finished games have left the feed (it keeps them ~72h); the round must not shrink
  const P2 = path.join(T, 'p-sat.json'); fs.copyFileSync(P, P2);
  const roundGames = feed.games.filter(g => g.sport === 'soccer' && Date.parse(g.start) >= Date.parse('2026-11-27T00:00:00Z') && Date.parse(g.start) < Date.parse('2026-12-01T12:00:00Z'));
  const lastStart = Math.max(...roundGames.map(g => Date.parse(g.start))), mon = new Date(lastStart - 2 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const feedM = JSON.parse(JSON.stringify(feed));
  for (const g of feedM.games) if (g.sport === 'soccer' && Date.parse(g.start) < lastStart - 2 * 3600e3 && g.status !== 'closed') { const s = favSide[g.id]; g.status = 'closed'; g.prob = null; g.score = s === 'away' ? { home: 1, away: 0 } : { home: 0, away: 1 }; }
  feedM.games = feedM.games.filter(g => !(g.sport === 'soccer' && g.status === 'closed' && Date.parse(g.start) < cut));  // the feed has let go of the games before Saturday afternoon
  const dropped = F1.legs.filter(l => !feedM.games.some(g => g.id === l.gid));
  const feed4 = path.join(T, 'feed-mon.json'); fs.writeFileSync(feed4, JSON.stringify(feedM));
  const R4 = run(feed4, mon, P2), F4 = R4.forecast;
  check('Monday: games gone from the feed keep their legs and results, so the round still has every big favourite', F4 && F4.round === F1.round && F4.favs === F1.favs && dropped.length > 0 && dropped.every(l => F4.legs.some(x => x.gid === l.gid && x.result)) && JSON.stringify(F4.leagues) === JSON.stringify(F1.leagues), JSON.stringify(F4 && { favs: F4.favs, was: F1.favs, dropped: dropped.length, now: mon }));
  check('the earlier weekend results the feed has dropped come from the kept results (runs unchanged)', R4.feedResults.length >= R1.feedResults.length && R1.runsNow.filter(r => !started.has(r.gid)).every(r => [...R4.runsNow].some(x => x.team === r.team)) || R1.runsNow.length === 0, `${R1.feedResults.length} -> ${R4.feedResults.length}`);

  // a postponed favourite is left out (as the page leaves it out), so the counts match the page
  const feedP = JSON.parse(fs.readFileSync(feed1, 'utf8')), pg = F1.legs[0].gid; feedP.games.find(g => g.id === pg).status = 'postponed';
  const feed5 = path.join(T, 'feed-post.json'); fs.writeFileSync(feed5, JSON.stringify(feedP));
  const R5 = run(feed5, '2026-11-23T12:00:00Z', path.join(T, 'post.json')), F5 = R5.forecast;
  check('a postponed favourite is not a leg and not counted', F5.favs === F1.favs - 1 && !F5.legs.some(l => l.gid === pg) && F5.need === Math.ceil(0.4 * F5.favs - 1e-9), JSON.stringify({ favs: F5.favs, was: F1.favs }));

  // last weekend's results have left the feed: the results kept from Monday's run still count
  const feedOld = JSON.parse(fs.readFileSync(feed1, 'utf8')); feedOld.games = feedOld.games.filter(g => !(g.sport === 'soccer' && g.status === 'closed'));
  const feed6 = path.join(T, 'feed-noresults.json'); fs.writeFileSync(feed6, JSON.stringify(feedOld));
  const P6 = path.join(T, 'p6.json'); fs.writeFileSync(P6, JSON.stringify({ research: R1 }));
  const R6 = run(feed6, '2026-11-24T12:00:00Z', P6);
  const sig = R => R.runsNow.map(r => r.team + ':' + r.unbeaten).sort().join(',');
  check('results the feed has dropped still count (kept from the last run)', R1.feedResults.length > 0 && R6.feedResults.length === R1.feedResults.length && sig(R6) === sig(R1), JSON.stringify({ kept: R6.feedResults.length, r1: sig(R1), r6: sig(R6) }));
  // the same Saturday with no earlier forecast: started games can't be priced, and the file says so
  const R3 = run(feed2, '2026-11-28T16:00:00Z', path.join(T, 'fresh.json')), F3 = R3.forecast;
  check('with no earlier forecast, started games are counted as unpriced, never invented', !F3 || F3.round !== F1.round || (F3.startedUnpriced > 0 && F3.carried === 0), JSON.stringify(F3 && { round: F3.round, unpriced: F3.startedUnpriced, favs: F3.favs }));

  // a result the feed later calls off (abandoned) stops counting, even though it was kept from an earlier run
  const ab = R1.feedResults[0], feedA = JSON.parse(fs.readFileSync(feed1, 'utf8')); feedA.games.find(g => g.id === ab.gid).status = 'abandoned';
  const feed7 = path.join(T, 'feed-abandoned.json'); fs.writeFileSync(feed7, JSON.stringify(feedA));
  const P7 = path.join(T, 'p7.json'); fs.writeFileSync(P7, JSON.stringify({ research: R1 }));
  const R7 = run(feed7, '2026-11-24T12:00:00Z', P7);
  check('a kept result whose game the feed has since called off no longer counts', !R7.feedResults.some(r => r.gid === ab.gid) && R7.feedResults.length === R1.feedResults.length - 1, ab.gid);

  // the opening weekend of a new season (its results file has no rows yet): last season's game counts and runs don't carry over
  const shift = Date.parse('2027-08-21T00:00:00Z') - Date.parse('2026-11-28T00:00:00Z'), feedS = JSON.parse(fs.readFileSync(feed1, 'utf8'));
  feedS.games = feedS.games.filter(g => g.sport === 'soccer' && Date.parse(g.start) >= Date.parse('2026-11-27T00:00:00Z') && Date.parse(g.start) < Date.parse('2026-12-01T12:00:00Z'))
    .map(g => ({ ...g, id: g.id + '-aug', start: new Date(Date.parse(g.start) + shift).toISOString().replace(/\.\d+Z$/, 'Z') }));
  const feed8 = path.join(T, 'feed-aug.json'); fs.writeFileSync(feed8, JSON.stringify(feedS));
  const R8 = run(feed8, '2027-08-19T12:00:00Z', path.join(T, 'aug.json')), F8 = R8.forecast;
  check('opening weekend: favourites are "start of season", never "end of season", and no runs carry over from last season', F8 && F8.legs.length > 0 && F8.legs.every(l => l.flags.includes('early') && !l.flags.includes('late')) && R8.runsNow.length === 0, JSON.stringify(F8 && F8.legs.map(l => l.flags)));

  // three opening weekends in a row (Aug 14, 21, 28): the 3rd game is still 'start of season' when the 2nd is finished but
  // still listed and the 1st has left the feed (kept results) - each game counted once
  const base = JSON.parse(fs.readFileSync(feed1, 'utf8')).games.filter(g => g.sport === 'soccer' && Date.parse(g.start) >= Date.parse('2026-11-27T00:00:00Z') && Date.parse(g.start) < Date.parse('2026-12-01T12:00:00Z'));
  const wk = w => base.map(g => ({ ...g, id: g.id + '-w' + w, start: new Date(Date.parse(g.start) + Date.parse('2027-08-14T00:00:00Z') - Date.parse('2026-11-28T00:00:00Z') + w * 7 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z') }));
  const closed = gs => gs.map(g => ({ ...g, status: 'closed', prob: null, score: { home: 1, away: 1 } }));
  const fA = path.join(T, 'feed-aug-a.json'), fB = path.join(T, 'feed-aug-b.json'), pA = path.join(T, 'p-aug.json');
  fs.writeFileSync(fA, JSON.stringify({ games: [...closed(wk(0)), ...wk(1), ...wk(2)] }));
  run(fA, '2027-08-17T12:00:00Z', pA);
  fs.writeFileSync(fB, JSON.stringify({ games: [...closed(wk(1)), ...wk(2)] }));
  const RB = run(fB, '2027-08-24T12:00:00Z', pA), FB = RB.forecast;
  check('3rd game of the season: still "start of season" (each finished game counted once)', FB && FB.legs.length > 0 && FB.legs.every(l => l.flags.includes('early')), JSON.stringify(FB && FB.legs.map(l => l.flags)));

  // the Eredivisie and Primeira Liga start first: their new-season files must not stop the big five from matching their teams
  const csv2 = path.join(T, 'csv2'); fs.mkdirSync(csv2);
  for (const f of fs.readdirSync(csv)) fs.copyFileSync(path.join(csv, f), path.join(csv2, f));
  for (const L of ['N1', 'P1']) { const lines = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fd', L + '.csv'), 'utf8').split(/\r?\n/); fs.writeFileSync(path.join(csv2, `2728_${L}.csv`), [lines[0], ...lines.slice(1, 4).map(x => x.replace(/\d\d\/\d\d\/\d{2,4}/, '07/08/2027'))].join('\n') + '\n'); }
  py(['tools/weekend_research.py', csv2, '--feed', feed8, '--pattern', path.join(T, 'aug2.json'), '--now', '2027-08-19T12:00:00Z', '--min', '300', '--sims', '200']);
  const R9 = JSON.parse(fs.readFileSync(path.join(T, 'aug2.json'), 'utf8')).research, F9 = R9.forecast;
  check('new-season rows for two leagues only: the big five still match their teams and get "start of season"', R9.unmatchedFeedNames.length === 0 && F9 && F9.legs.length > 0 && F9.legs.every(l => l.matched && l.flags.includes('early')), JSON.stringify({ unmatched: R9.unmatchedFeedNames.length, legs: F9 && F9.legs.map(l => [l.matched, l.flags]) }));

  // weekend_pattern.py (run first each morning) keeps the research block
  py(['tools/weekend_pattern.py', path.join(ROOT, 'tests/fixtures/fd'), '--days', '90', '--end', '2026-11-23', '--feed', feed1, '--sims', '200', '--out', P]);
  const after = JSON.parse(fs.readFileSync(P, 'utf8'));
  check('weekend_pattern.py rewrites the 90-day block but keeps the research (and its forecast)', Array.isArray(after.weeks) && after.research && after.research.forecast && after.research.forecast.round === F2.round);

  // names: the feed's spellings, and ties never decided by chance
  const names = py(['-c', `import sys; sys.path.insert(0, 'tools'); from teamnames import fd_match
SP = {'Espanol', 'Barcelona', 'La Coruna', 'Real Madrid', 'Betis'}
print(fd_match('Espanyol Barcelona', SP), fd_match('FC Barcelona', SP), fd_match('RC Deportivo de A Coruna', SP), fd_match('Inter Milano', {'Inter', 'Milan'}), fd_match('1. FC Cologne', {'FC Koln', 'Union Berlin'}), fd_match('Stade Rennais FC', {'Rennes', 'Brest'}), fd_match('Real', {'Real Madrid', 'Real Sociedad'}))`]).trim();
  check('feed names match (Espanyol, Barcelona, Deportivo, Inter, Cologne, Rennes); a tie gives no match', names === 'Espanol Barcelona La Coruna Inter FC Koln Rennes None', names);
  const seeds = [1, 2, 3, 4, 5, 6].map(s => py(['-c', "import sys; sys.path.insert(0, 'tools'); from teamnames import fd_match; print(fd_match('Espanyol Barcelona', {'Espanol', 'Barcelona'}), fd_match('Sevilla FC', {'Sevilla', 'Betis', 'Espanol'}))"], { PYTHONHASHSEED: String(s) }).trim());
  check('the same answer whatever the hash seed', new Set(seeds).size === 1, JSON.stringify([...new Set(seeds)]));
} catch (e) { check('suite ran to completion', false, (e.stderr || '') + (e.stack || e.message)); }
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
