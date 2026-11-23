// Track record of every parlay the app recommends.
//   node tools/recs.mjs snapshot   save today's parlays (My Parlay Picks, Fantasy, NBA Props tickets, stacks, upsets, patterns)
//   node tools/recs.mjs grade      grade every saved day not fully graded yet: game legs from final scores (the app's own
//                                  settle rules on data.json), NBA player legs from ESPN box scores (site.api.espn.com)
// Writes recs.json: {updated, days:[{day, made, parlays:[{id, tab, title, p, result, legs:[{gid,key,label,p,sport,home,away,
// start, player?, res, actual}]}]}]} (last 30 days kept). Run snapshot after make_picks in the 3:47 AM run, grade before it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] || 'snapshot', OUT = path.join(ROOT, 'recs.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
let recs = { updated: null, days: [] };
try { recs = JSON.parse(fs.readFileSync(OUT, 'utf8')); if (!Array.isArray(recs.days)) recs.days = []; } catch (e) {}
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const ready = () => page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2, null, { timeout: 120000 });
let code = 0;
try {
  await page.goto(BASE); await ready();
  if (MODE === 'snapshot') {
    // render each tab once so its cards land in the page's card cache, then read every card's legs
    const cards = await page.evaluate(async () => {
      const F = __fm2, wait = ms => new Promise(r => setTimeout(r, ms)), out = new Map();
      const grab = tab => { for (const [id, T] of Object.entries(F.autoCache)) if (T && T.legs && T.legs.length >= 2 && id !== 'slip' && !out.has(id)) out.set(id, { id, tab, title: (T.title || id), legs: T.legs, p: T.p }); };
      SB.goTab('trending'); await wait(300);
      const seg = document.querySelector('#trSeg [data-v="picks"]'); if (seg) { seg.click(); await wait(500); }
      grab('picks');
      for (const t of ['fantasy', 'props', 'pattern', 'upsets']) { SB.goTab(t); await wait(t === 'upsets' || t === 'pattern' ? 1500 : 600); SB.render(); await wait(300); grab(t); }
      // upset cards are Polymarket legs: map each to the feed's game and key where it matches
      const U = window.__upsets && __upsets.CARDS || {};
      for (const [id, legs] of Object.entries(U)) {
        const pm = (window.__polymarket && __polymarket.PM && __polymarket.PM.games) || [], L2 = [];
        for (const l of legs) { const pg = pm.find(x => x.slug === l.game), m = pg && __polymarket.matchOf(pg); if (!m || !m.g) continue;
          const side = l.kind === 'draw' ? 'D' : (l.team === pg.home.name ? 'H' : 'A'), key = side === 'D' ? 'D' : (side === 'H') !== !!m.swap ? 'H' : 'A';
          L2.push({ gid: m.g.id, key, label: l.label, p: l.mid }); }
        if (L2.length >= 2 && !out.has(id)) out.set(id, { id, tab: 'upsets', title: { upMain: 'Upset parlay', upForm: 'Form-backed upsets', upEdge: 'Close-game edges' }[id] || id, legs: L2, p: L2.reduce((a, l) => a * l.p, 1) });
      }
      // titles from the page where the cache has none, and the facts each leg needs for grading later
      return [...out.values()].map(c => ({ ...c, title: c.title === c.id ? (document.querySelector(`[data-sim5="${c.id}"]`) && document.querySelector(`[data-sim5="${c.id}"]`).closest('.pc').querySelector('.pctitle') || {}).textContent || c.id : c.title,
        legs: c.legs.map(L => { const g = SB.gameById(L.gid) || {}; const o = { gid: L.gid, key: L.key, label: L.label, p: +(+L.p || 0).toFixed(4), sport: g.sport, comp: g.comp, home: g.home && g.home.abbr, away: g.away && g.away.abbr, start: g.start };
          if (/^[PU]:/.test(L.key)) { const id = L.key.split(':')[1], pl = (F.DATA.players || []).find(p => p.id === id) || (F.DATA.estById && F.DATA.estById.get(id)); if (pl) o.player = { name: pl.name, team: pl.team, stat: pl.stat, thr: +L.key.split(':')[2], under: L.key[0] === 'U' }; }
          return o; }) }));
    });
    // the day the picks are for (today, or tomorrow late at night); a day already graded keeps its graded parlays
    const day = await page.evaluate(() => __fm2.myPicks().day);
    const keep = cards.filter(c => c.legs.length >= 2).map(c => ({ ...c, result: 'pending' }));
    const old = recs.days.find(d => d.day === day);
    if (old) { const have = new Set(old.parlays.map(P => P.id)); old.parlays = old.parlays.filter(P => P.result !== 'pending').concat(keep.filter(c => !old.parlays.some(P => P.id === c.id && P.result !== 'pending'))); }
    else recs.days.push({ day, made: new Date().toISOString(), parlays: keep });
    recs.days = recs.days.sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30);
    console.log(`snapshot ${day}: ${keep.length} parlays (${[...new Set(keep.map(c => c.tab))].join(', ')})`);
  } else {
    // grade: game legs with the page's own settle rules; player legs from ESPN box scores
    const todo = recs.days.filter(d => d.parlays.some(P => P.result === 'pending'));
    const games = await page.evaluate(legs => legs.map(L => { const g = SB.gameById(L.gid); if (!g || !SB.isFinal(g) || /^[PU]:/.test(L.key)) return null; const r = SB.evalMarket(g, L.key, g.score.home, g.score.away); return r == null ? null : { res: r, actual: `${g.home.abbr} ${g.score.home}-${g.score.away} ${g.away.abbr}` }; }),
      todo.flatMap(d => d.parlays.flatMap(P => P.legs)));
    let k = 0; for (const d of todo) for (const P of d.parlays) for (const L of P.legs) { const r = games[k++]; if (r && L.res == null) { L.res = r.res; L.actual = r.actual; } }
    // NBA box scores: one scoreboard per US date, one summary per game
    const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba', FIX = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' }, ours = a => FIX[a] || a;
    const nk = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    // curl, not fetch: Node's fetch ignores the HTTPS proxy this environment's network goes through
    const { execFileSync } = await import('node:child_process');
    const getJ = async u => { for (let i = 0; i < 3; i++) { try { return JSON.parse(execFileSync('curl', ['-s', '-m', '30', u], { maxBuffer: 64 << 20 }).toString()); } catch (e) {} await new Promise(r => setTimeout(r, 1500)); } return null; };
    const boards = new Map(), boxes = new Map();
    for (const d of todo) for (const P of d.parlays) for (const L of P.legs) {
      if (!L.player || L.res != null || L.sport !== 'nba' || !L.start || Date.parse(L.start) > Date.now() - 4 * 3600e3) continue;
      const usDate = new Date(Date.parse(L.start) - 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
      if (!boards.has(usDate)) boards.set(usDate, await getJ(`${ESPN}/scoreboard?dates=${usDate}`));
      const ev = ((boards.get(usDate) || {}).events || []).find(e => { const ab = e.competitions[0].competitors.map(c => ours(c.team.abbreviation)); return ab.includes(L.home) && ab.includes(L.away); });
      if (!ev || !ev.competitions[0].status.type.completed) continue;
      if (!boxes.has(ev.id)) boxes.set(ev.id, await getJ(`${ESPN}/summary?event=${ev.id}`));
      const box = boxes.get(ev.id); if (!box) continue;
      let line = null, dnp = false;
      for (const side of box.boxscore.players || []) { const st = side.statistics[0], lab = st.labels || st.names || [];
        for (const a of st.athletes) if (nk(a.athlete.displayName) === nk(L.player.name)) { if (a.didNotPlay || !a.stats || !a.stats.length) dnp = true; else line = { pts: +a.stats[lab.indexOf('PTS')], reb: +a.stats[lab.indexOf('REB')], ast: +a.stats[lab.indexOf('AST')] }; } }
      if (dnp) { L.res = 'void'; L.actual = 'did not play'; continue; }
      if (!line) continue;
      const v = line[L.player.stat]; if (!Number.isFinite(v)) continue;
      L.res = L.player.under ? v < L.player.thr : v >= L.player.thr; L.actual = `${v} ${L.player.stat}`;
    }
    let graded = 0;
    for (const d of todo) for (const P of d.parlays) {
      const live = P.legs.filter(L => L.res !== 'void');
      P.result = live.some(L => L.res === false) ? 'lost' : live.length && live.every(L => L.res === true) ? 'won' : P.legs.every(L => L.res === 'void') ? 'void' : 'pending';
      if (P.result !== 'pending') graded++;
    }
    console.log(`graded ${graded} parlays across ${todo.length} day(s); ${todo.flatMap(d => d.parlays).filter(P => P.result === 'won').length} won`);
  }
  if (errors.length) console.error('page errors (ignored):', errors.slice(0, 2).join(' | '));
  recs.updated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(recs));
} catch (e) { console.error('recs failed:', e.message); code = 1; }
await browser.close(); server.close();
process.exit(code);
