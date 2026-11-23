// Player-form tools for the morning run: playerform_merge.py on a small synthetic results file (shape, avg5, stale entry dropped,
// bad types rejected), the research workflow run with stub agents into the merge, and pick_players.mjs once on the repo's real
// files (real clock): it must list every NBA player in mypicks.json. Run: node tests/playerform-tools.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'playerform-'));
const W = (f, x) => { fs.writeFileSync(path.join(TMP, f), JSON.stringify(x)); return path.join(TMP, f); };
const R = f => JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8'));
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const nameKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const merge = (...a) => spawnSync('python3', ['tools/playerform_merge.py', ...a, '--today', '2026-11-23'], { cwd: ROOT, encoding: 'utf8' });
const KEYS = 'name,team,stat,last5,min5,opp5,dnp,avg5,asOf,note,sources,confidence';
const shapeOk = e => Object.keys(e).sort().join(',') === KEYS.split(',').sort().join(',') && typeof e.name === 'string' && /^[A-Z]{2,4}$/.test(e.team) &&
  ['pts', 'reb', 'ast'].includes(e.stat) && Array.isArray(e.last5) && e.last5.length >= 1 && e.last5.every(Number.isFinite) &&
  e.min5.length === e.last5.length && e.min5.every(Number.isFinite) && e.opp5.length === e.last5.length && e.opp5.every(x => typeof x === 'string') &&
  Number.isInteger(e.dnp) && Number.isFinite(e.avg5) && /^\d{4}-\d{2}-\d{2}$/.test(e.asOf) && typeof e.note === 'string' &&
  Array.isArray(e.sources) && ['verified', 'partial', 'unverified'].includes(e.confidence);
const full = (name, team, stat, asOf, o) => ({ name, team, stat, last5: [5, 6, 7], min5: [30, 31, 32], opp5: ['A', 'B', 'C'], dnp: 0, avg5: 6, asOf, note: '', sources: ['https://a.com/x', 'https://b.com/y'], confidence: 'verified', ...o });
const g = (date, opp, min, value) => ({ date, opp, min, value });
try {
  // ---- playerform_merge.py ----
  const groups = W('groups.json', [{ key: 'nba1', teams: ['NYK', 'LAL'], players: [
    { name: 'Jalen Brunson', team: 'NYK', stat: 'pts' }, { name: 'Luka Dončić', team: 'LAL', stat: 'ast' }, { name: 'Josh Hart', team: 'NYK', stat: 'reb' },
    { name: 'Mikal Bridges', team: 'NYK', stat: 'pts' }] }]);
  const res = W('results.json', { result: [{ group: 'nba1', players: [
    // 6 games, newest first, team written "NY": sorted oldest first, the oldest dropped, team taken from groups.json
    { name: 'Jalen Brunson', team: 'NY', stat: 'pts', dnp: 0, asOf: '2026-11-21', note: 'sat the 4th in a 28-point win on 11-19', confidence: 'verified',
      sources: ['https://www.espn.com/nba/boxscore/1', 'https://www.cbssports.com/nba/2', 'https://espn.com/nba/3'],
      games: [g('2026-11-21', 'BOS', 36.5, 30), g('2026-11-19', 'MIA', 29, 22), g('2026-11-17', 'tor', 35, 28), g('2026-11-15', 'CHI', 33, 25), g('2026-11-13', 'ORL', 30, 20), g('2026-11-11', 'PHI', 34, 31)] },
    // last5 given directly, name without the accent, one site only -> lowered to partial
    { name: 'Luka Doncic', team: 'LAL', stat: 'ast', last5: [8, 9, 7], min5: [36, 37.5, 35], opp5: ['den', 'phx', 'sac'], dnp: 2, asOf: '2026-11-22', note: 'missed 2 (ankle)',
      sources: ['https://www.espn.com/a', 'https://espn.com/b'], confidence: 'verified' },
    // a 0-minute game is a DNP, not a 0
    { name: 'Josh Hart', team: 'NYK', stat: 'reb', dnp: 1, asOf: '2026-11-21', note: '', sources: ['https://x.com/1'], confidence: 'partial',
      games: [g('2026-11-15', 'CHI', 31, 10), g('2026-11-17', 'TOR', 0, 0), g('2026-11-19', 'MIA', 33, 12), g('2026-11-21', 'BOS', 30, 9)] },
    // bad types: each one rejected, never coerced
    { name: 'Mikal Bridges', team: 'NYK', stat: 'pts', last5: [18, 'twenty', 15], min5: [30, 30, 30], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-21', confidence: 'partial' },
    { name: 'OG Anunoby', team: 'NYK', stat: 'blk', last5: [1, 2, 3], min5: [30, 30, 30], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-21' },
    { name: 'Karl-Anthony Towns', team: 'NYK', stat: 'reb', last5: [10, 11, 12], min5: [30, 30, 30], opp5: ['A', 'B', 'C'], dnp: 'one', asOf: '2026-11-21' },
    { name: 'Mitchell Robinson', team: 'NYK', stat: 'reb', last5: [8, 9, 10], min5: [25, 25, 25], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-25' },
    { name: 'Miles McBride', team: 'NYK', stat: 'pts', last5: [8, 9, 10], min5: [25, 25], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-21' },
    { name: 'Jordan Clarkson', team: 'NYK', stat: 'pts', last5: [true, 10, 12], min5: [20, 20, 20], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-21' },
    { name: 'Landry Shamet', team: 'NYK', stat: 'pts', last5: [12.5, 10, 12], min5: [20, 20, 20], opp5: ['A', 'B', 'C'], dnp: 0, asOf: '2026-11-21' },
    'junk',
  ] }] });
  const out = W('playerform.json', { updated: '2026-11-22T08:00:00Z', players: [
    full('Jalen Brunson', 'NYK', 'pts', '2026-11-20', { last5: [1, 1, 1], avg5: 1 }), // re-researched: replaced
    full('Jayson Tatum', 'BOS', 'pts', '2026-11-21'),                                   // 2 days old: kept
    full('Derrick White', 'BOS', 'ast', '2026-11-20'),                                  // exactly 3 days: kept
    full('Jaylen Brown', 'BOS', 'pts', '2026-11-18'),                                   // 5 days old: dropped
  ] });
  const m = merge(res, '--groups', groups, '--out', out);
  check('merge exits 0', m.status === 0, m.stderr.trim().split('\n')[0]);
  const P = R('playerform.json'), by = Object.fromEntries(P.players.map(e => [e.team + '|' + nameKey(e.name) + '|' + e.stat, e]));
  check('top level is {updated: ISO, players: [...]}', Object.keys(P).sort().join() === 'players,updated' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(P.updated) && Array.isArray(P.players));
  check('every player has exactly the page\'s shape and types', P.players.length > 0 && P.players.every(shapeOk), P.players.filter(e => !shapeOk(e)).map(e => e.name).join(', '));
  const B = by['NYK|jalen-brunson|pts'];
  check('games sorted oldest first, the 6th dropped, team from groups.json', B && B.last5.join() === '20,25,28,22,30' && B.opp5.join() === 'ORL,CHI,TOR,MIA,BOS' && B.min5.join() === '30,33,35,29,36.5', B && JSON.stringify(B.last5));
  check('avg5 is the mean of last5 (25.0)', B && B.avg5 === 25);
  check('verified kept with two different sites', B && B.confidence === 'verified' && B.sources.length === 3);
  const L = by['LAL|luka-doncic|ast'];
  check('name taken from groups.json (accent kept), opponents upper-cased', L && L.name === 'Luka Dončić' && L.opp5.join() === 'DEN,PHX,SAC' && L.dnp === 2 && L.avg5 === 8);
  check('"verified" from one site only is lowered to partial', L && L.confidence === 'partial');
  const H = by['NYK|josh-hart|reb'];
  check('a 0-minute game is left out of last5; avg5 rounded to 1 decimal (10.3)', H && H.last5.join() === '10,12,9' && H.avg5 === 10.3, H && JSON.stringify(H));
  const rejected = ['Mikal Bridges', 'OG Anunoby', 'Karl-Anthony Towns', 'Mitchell Robinson', 'Miles McBride', 'Jordan Clarkson', 'Landry Shamet'];
  check('bad types rejected (string, unknown stat, dnp string, future asOf, length mismatch, bool, half a point)', rejected.every(n => !P.players.some(e => e.name === n)), P.players.map(e => e.name).join(', '));
  check('each rejected entry is named on stderr', rejected.every(n => m.stderr.includes('rejected ' + n)) && /junk/.test(m.stderr), m.stderr.trim().split('\n').length + ' lines');
  check('old entries within 3 days kept, re-researched replaced', by['BOS|jayson-tatum|pts'] && by['BOS|derrick-white|ast'] && B.asOf === '2026-11-21');
  check('stale old entry (5 days) dropped', !by['BOS|jaylen-brown|pts']);
  check('a listed player with no usable form is reported', /listed players have no form: Mikal Bridges pts/.test(m.stdout), m.stdout.trim());
  check('5 players written (3 researched, 2 kept)', P.players.length === 5, String(P.players.length));

  // ---- the workflow with stub agents, its output into the merge ----
  const src = fs.readFileSync(path.join(ROOT, 'tools/player-form-research.wf.js'), 'utf8');
  const meta = Function('return ' + src.match(/export const meta = (\{[\s\S]*?\n\})/)[1])();
  check('workflow meta: name, description, phases Research and Verify', meta.name === 'player-form-research' && meta.description && meta.phases.map(p => p.title).join() === 'Research,Verify');
  const calls = [], ok = { name: 'Jalen Brunson', team: 'NYK', stat: 'pts', dnp: 0, asOf: '2026-11-21', note: 'x', sources: ['https://a.com/1', 'https://b.com/2'], confidence: 'verified',
    games: [g('2026-11-13', 'ORL', 30, 20), g('2026-11-15', 'CHI', 33, 25), g('2026-11-17', 'TOR', 35, 28), g('2026-11-19', 'MIA', 29, 22), g('2026-11-21', 'BOS', 36.5, 30)] };
  const agent = async (prompt, o) => { calls.push({ prompt, ...o }); return o.label === 'verify:nba2' ? null : { players: [ok] }; };
  const pipeline = (items, ...stages) => Promise.all(items.map(async (it, i) => { let r = it; for (const s of stages) r = await s(r, it, i); return r; }));
  const run = new (async () => {}).constructor('args', 'agent', 'pipeline', src.replace(/^export const meta =/m, 'const meta ='));
  const ret = await run({ dir: '/w/players', groups: ['nba1', 'nba2'] }, agent, pipeline);
  check('workflow returns [{group, players}] per group (a failed verify gives [])', JSON.stringify(ret.map(r => [r.group, r.players.length])) === '[["nba1",1],["nba2",0]]');
  const rp = calls.find(c => c.label === 'research:nba1'), vp = calls.find(c => c.label === 'verify:nba1');
  check('researcher reads its group file; verifier gets the entries and a different source', rp && rp.prompt.includes('/w/players/players_nba1.json') && rp.phase === 'Research' &&
    vp && vp.phase === 'Verify' && vp.prompt.includes('"Jalen Brunson"') && /DIFFERENT source/.test(vp.prompt));
  check('schema requires games, dnp, asOf, sources, confidence', rp && ['games', 'dnp', 'asOf', 'sources', 'confidence'].every(k => rp.schema.properties.players.items.required.includes(k)));
  W('playerform.json', { players: [] });
  const m2 = merge(W('wf.json', ret), '--groups', groups, '--out', path.join(TMP, 'playerform.json'));
  const P2 = R('playerform.json').players;
  check('the workflow\'s output merges cleanly', m2.status === 0 && P2.length === 1 && shapeOk(P2[0]) && P2[0].avg5 === 25, m2.stderr.trim());

  // ---- pick_players.mjs on the repo's real files ----
  const pp = spawnSync('node', ['tools/pick_players.mjs', '--out', path.join(TMP, 'players')], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  check('pick_players exits 0', pp.status === 0, (pp.stderr || pp.stdout).trim().split('\n')[0]);
  const PL = R('players/players.json'), G = R('players/groups.json');
  const MP = JSON.parse(fs.readFileSync(path.join(ROOT, 'mypicks.json'), 'utf8'));
  const want = new Map();
  for (const Pp of MP.parlays) for (const Lg of Pp.legs) {
    if (!/^[PU]:/.test(Lg.key) || !String(Lg.gid).startsWith('nba-')) continue;
    const st = (Lg.key.split(':')[1].match(/-(pts|reb|ast)(?:~|$)/) || [])[1];
    if (st) want.set(nameKey(Lg.label.replace(/\s+(?:under\s+)?\d+(?:\.\d+)?\+?\s+[a-z ]+$/i, '')) + '|' + st, Lg);
  }
  const have = new Set(PL.map(p => nameKey(p.name) + '|' + p.stat)), miss = [...want.keys()].filter(k => !have.has(k));
  check(`lists every NBA player in mypicks.json (${want.size})`, want.size > 0 && !miss.length, miss.join(', '));
  check('each mypicks player is marked as from the picks', PL.filter(p => want.has(nameKey(p.name) + '|' + p.stat)).every(p => p.in.some(s => s.startsWith('mypicks:'))));
  check('each player has a team, the game and the opponent', PL.every(p => /^[A-Z]{2,4}$/.test(p.team) && /^nba-/.test(p.gid) && p.opp && p.opp !== p.team && p.gid.includes(p.team) && p.gid.includes(p.opp) && p.start));
  check('unique by name + team + stat', new Set(PL.map(p => p.team + '|' + nameKey(p.name) + '|' + p.stat)).size === PL.length);
  const inG = G.flatMap(x => x.players), files = G.map(x => R(`players/players_${x.key}.json`));
  check('groups of at most 12 cover every player once, one file per group', G.every(x => x.players.length <= 12) && inG.length === PL.length &&
    files.every((f, i) => JSON.stringify(f) === JSON.stringify(G[i].players)), G.map(x => x.key + ':' + x.players.length).join(' '));
  const split = [...new Set(PL.map(p => p.team))].filter(t => PL.filter(p => p.team === t).length <= 12 && G.filter(x => x.players.some(p => p.team === t)).length > 1);
  check('a team\'s players stay in one group', !split.length, split.join(','));
} catch (e) { check('no exception', false, e.stack); }
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
