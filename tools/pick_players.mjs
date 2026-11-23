// List the NBA players in today's parlays for the morning player-form research (tools/player-form-research.wf.js).
//   node tools/pick_players.mjs [--out .work/players] [--tabs fantasy,props] [--max 120]
// Opens the app headless on this folder's files with the real clock, like make_picks.mjs, and collects every NBA player leg
// (P: / U: keys, and any leg nested inside one, e.g. substitutes) from: mypicks.json; the page's own My Parlay Picks (myPicks():
// the file when it is for today or tomorrow, else what the page builds); props.json's built parlays; and every ticket the
// --tabs show (each card's "+ My Parlays" button saves its legs with their keys; '' skips the tabs). Keys resolve through
// __fm2.DATA.players by id (name, team, stat, gid); a player who has left the board since falls back to the key's id
// (name-stat~gid), the leg label and nbaroles.json, so a picked leg is never dropped.
// Writes <out>/players.json (unique name+team+stat, with the next game and opponent), <out>/players_<key>.json (groups of at most
// 12, a team's players kept together so one researcher reads each box score once) and <out>/groups.json. Players from the picks
// are always kept; tab players fill up to --max (the ones left out are counted). No NBA legs -> empty lists, exit 0.
// Exits 1 if the page fails to load or throws while reading the picks.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', '.work/players')), TABS = arg('--tabs', 'fantasy,props').split(',').filter(Boolean), MAX = +arg('--max', 120);
const STATS = ['pts', 'reb', 'ast'], GROUP = 12;
const nameKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); // the page's own
const readJSON = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return null; } };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
let code = 0;
try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2 && __fm2.myPicks, null, { timeout: 120000 });
  // in the page: every {key, gid} leg with a player key (nested ones too), tagged with where it came from
  await page.evaluate(() => {
    const seen = new Set();
    window.__pp = [];
    window.__ppWalk = (x, src) => { if (!x || typeof x !== 'object' || seen.has(x)) return; seen.add(x);
      if (typeof x.key === 'string' && /^[PU]:/.test(x.key)) __pp.push({ key: x.key, gid: x.gid || null, label: x.label || '', src });
      for (const v of Array.isArray(x) ? x : Object.values(x)) __ppWalk(v, src); };
  });
  await page.evaluate(file => {
    for (const P of (file && file.parlays) || []) __ppWalk(P.legs, 'mypicks:' + P.id);
    for (const P of __fm2.myPicks().parlays || []) __ppWalk(P.legs, 'page:' + P.id);
    // props.json's built parlays: only legs whose game is still open on the board (the page hides the rest)
    const byId = new Map((__fm2.DATA.players || []).map(p => [p.id, p]));
    for (const P of __fm2.DATA.picks || []) for (const k of P.legs || []) {
      const pl = typeof k === 'string' && /^[PU]:/.test(k) && byId.get(k.split(':')[1]), g = pl && SB.gameById(pl.gid);
      if (g && SB.openG(g)) __pp.push({ key: k, gid: pl.gid, label: '', src: 'built:' + P.id });
    }
  }, readJSON('mypicks.json'));
  if (errors.length) throw new Error('page errors: ' + errors.slice(0, 3).join(' | '));
  // the tabs' tickets: "+ My Parlays" saves each card's legs (keys included) to SB.savedParlays in this throwaway browser
  for (const tab of TABS) {
    const n = errors.length;
    try {
      await page.evaluate(async t => {
        SB.goTab(t, {}); await new Promise(r => setTimeout(r, 300));
        const before = SB.savedParlays.length;
        for (const b of document.querySelectorAll('#main [data-savep]')) b.click();
        for (const rec of SB.savedParlays.slice(before)) __ppWalk(rec.legs, t + ':' + rec.src);
      }, tab);
    } catch (e) { errors.push(e.message); }
    if (errors.length > n) console.warn(`  ${tab} tab skipped: ${errors.slice(n, n + 2).join(' | ')}`);
  }
  // resolve each key to its player and game in the page
  const raw = await page.evaluate(() => {
    const D = __fm2.DATA, byId = new Map((D.players || []).map(p => [p.id, p]));
    const game = gid => { const g = gid && SB.gameById(gid); return g ? { sport: g.sport, start: g.start, final: !!SB.isFinal(g), home: g.home.abbr, away: g.away.abbr, homeName: g.home.name, awayName: g.away.name } : null; };
    return __pp.map(x => { const id = x.key.split(':')[1], pl = byId.get(id) || (D.estById && D.estById.get(id)) || null, gid = (pl && pl.gid) || x.gid;
      return { ...x, id, gid, pl: pl && { name: pl.name, team: pl.team, stat: pl.stat }, g: game(gid) }; });
  });
  // fall back to the key itself when the player is no longer on the board: id = name-stat~gid (props.json ids: name-stat)
  const roles = (readJSON('nbaroles.json') || {}).teams || {};
  const teamOf = (name, g) => [g.home, g.away].find(t => (roles[t] || []).some(r => nameKey(r.name) === nameKey(name))) || null;
  const players = new Map(), unresolved = [];
  for (const x of raw) {
    const m = x.id.match(/-(pts|reb|ast)(?:~(.+))?$/), gid = x.gid || (m && m[2]) || null;
    const gm = gid && gid.match(/^nba-([A-Z]+)-([A-Z]+)-(\d{4}-\d{2}-\d{2})$/);
    const g = x.g || (gm && { sport: 'nba', start: gm[3], final: false, home: gm[1], away: gm[2] });
    if (!g || g.sport !== 'nba') continue;
    const name = x.pl ? x.pl.name : x.label.replace(/\s+(?:under\s+)?\d+(?:\.\d+)?\+?\s+[a-z ]+$/i, '').trim();
    const stat = x.pl ? x.pl.stat : m && m[1], team = (x.pl && x.pl.team) || teamOf(name, g);
    if (!STATS.includes(stat)) continue;
    if (!name || !team) { unresolved.push(x.key); continue; }
    const home = team === g.home, k = team + '|' + nameKey(name) + '|' + stat, old = players.get(k);
    const e = { name, team, teamName: (home ? g.homeName : g.awayName) || '', stat, gid, start: g.start, home, opp: home ? g.away : g.home, oppName: (home ? g.awayName : g.homeName) || '', final: g.final, in: [] };
    // the next game to play: an open game before a finished one, then the earliest
    const best = !old ? e : (old.final - e.final || String(old.start).localeCompare(String(e.start))) > 0 ? { ...e, in: old.in } : old;
    if (!best.in.includes(x.src)) best.in.push(x.src);
    players.set(k, best);
  }
  const isPick = p => p.in.some(s => /^(mypicks|page):/.test(s));
  let list = [...players.values()].sort((a, b) => isPick(b) - isPick(a));
  const keep = Math.max(MAX, list.filter(isPick).length), dropped = Math.max(0, list.length - keep);
  list = list.slice(0, keep).map(({ final, ...p }) => p).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name) || a.stat.localeCompare(b.stat));
  // groups of at most 12, a team never split unless it alone has more than 12
  const byTeam = new Map();
  for (const p of list) { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); }
  const groups = [];
  let cur = [];
  for (const ps of byTeam.values()) {
    if (cur.length && cur.length + ps.length > GROUP) { groups.push(cur); cur = []; }
    for (const p of ps) { if (cur.length >= GROUP) { groups.push(cur); cur = []; } cur.push(p); }
  }
  if (cur.length) groups.push(cur);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/^players_.+\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f)); // yesterday's groups
  const G = groups.map((ps, i) => ({ key: 'nba' + (i + 1), teams: [...new Set(ps.map(p => p.team))], players: ps }));
  for (const g of G) fs.writeFileSync(path.join(OUT, `players_${g.key}.json`), JSON.stringify(g.players, null, 1));
  fs.writeFileSync(path.join(OUT, 'players.json'), JSON.stringify(list, null, 1));
  fs.writeFileSync(path.join(OUT, 'groups.json'), JSON.stringify(G, null, 1));
  console.log(`${list.length} NBA players (${list.filter(isPick).length} in My Parlay Picks) in ${G.length} groups -> ${path.relative(ROOT, OUT)}/groups.json`);
  if (dropped) console.log(`  ${dropped} more players from the ${TABS.join(' / ')} tabs left out by --max ${MAX}`);
  if (unresolved.length) console.warn(`  ${unresolved.length} legs not resolved to a player and team: ${[...new Set(unresolved)].slice(0, 5).join(', ')}`);
  for (const g of G) console.log(`  ${g.key.padEnd(6)} ${String(g.players.length).padStart(2)}  ${g.teams.join(' ')}`);
} catch (e) { console.error('pick_players failed:', e.message); code = 1; }
await browser.close(); server.close();
process.exit(code);
