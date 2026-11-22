// Make the day's "My Parlay Picks" once and write them to mypicks.json, so every viewer sees the same legs all day.
//   node tools/make_picks.mjs [--day YYYY-MM-DD] [--out mypicks.json]
// It opens the app headless on this folder's files (data.json, props.json, nbaroles.json, injuries.json, ...) with the real clock
// and calls the page's own builder, so the picks use exactly the model the app shows. Without --day it picks the day the way the
// page does: today (America/Los_Angeles) while today still has 3+ games to start, otherwise tomorrow.
// Exits 1 (and writes nothing) if the page fails to load, throws, or no parlay has any legs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DAY = arg('--day'), OUT = path.resolve(ROOT, arg('--out') || 'mypicks.json');
if (DAY && !/^\d{4}-\d{2}-\d{2}$/.test(DAY)) { console.error('--day must be YYYY-MM-DD'); process.exit(2); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  // the old picks file is never read: the picks are made fresh from the board
  if (u === '/mypicks.json' || !f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
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
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__fm2 && __fm2.buildMyPicks, null, { timeout: 120000 });
  const picks = await page.evaluate(day => {
    const F = __fm2, today = F.dayOf(Date.now()), tom = F.dayOf(Date.now() + 864e5);
    const d = day || (F.dayGames(today).length >= 3 ? today : tom);
    return F.buildMyPicks(d);
  }, DAY);
  if (errors.length) throw new Error('page errors: ' + errors.slice(0, 3).join(' | '));
  if (!picks || !Array.isArray(picks.parlays) || !picks.parlays.some(P => P.legs.length)) throw new Error('no parlay has any legs for ' + (picks && picks.day));
  picks.by = 'tools/make_picks.mjs';
  fs.writeFileSync(OUT, JSON.stringify(picks));
  console.log(`wrote ${path.relative(ROOT, OUT)} for ${picks.day}`);
  for (const P of picks.parlays) console.log(`  ${P.id.padEnd(8)} ${String(P.legs.length).padStart(2)} legs  ${(P.p * 100).toFixed(P.p < .01 ? 3 : 1)}%  ${P.title}`);
} catch (e) { console.error('make_picks failed:', e.message); code = 1; }
await browser.close(); server.close();
process.exit(code);
