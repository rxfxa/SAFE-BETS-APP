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
  check('"typical" is a round with the same number of big favourites (same threshold), plus prices-alone and real rates', F1.need === Math.ceil(0.4 * F1.favs - 1e-9) && F1.typical > 0 && F1.typicalPriced > F1.typical && F1.typicalRounds > 0 && F1.typicalReal != null, JSON.stringify({ n: F1.favs, need: F1.need, t: F1.typical, tp: F1.typicalPriced, real: F1.typicalReal, rounds: F1.typicalRounds }));
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
  // the same Saturday with no earlier forecast: started games can't be priced, and the file says so
  const R3 = run(feed2, '2026-11-28T16:00:00Z', path.join(T, 'fresh.json')), F3 = R3.forecast;
  check('with no earlier forecast, started games are counted as unpriced, never invented', !F3 || F3.round !== F1.round || (F3.startedUnpriced > 0 && F3.carried === 0), JSON.stringify(F3 && { round: F3.round, unpriced: F3.startedUnpriced, favs: F3.favs }));

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
