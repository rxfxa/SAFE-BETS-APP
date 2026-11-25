// Shared test harness for the research screens: serves the repo, pins the side files to saved fixtures, fixes the clock.
//   import { open, check, done } from './lib/harness.mjs';
//   const { page, errors, browser } = await open({ width: 390, tab: 'insights' });
//   check('name', ok, info); ...; await done(browser);   // exits 1 on any failure
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
export const FX = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
// the 2026-11-23 slate (NBA, NFL, college, NHL, soccer games on 23-24 Nov) and the side files saved with it
export const PINS = { 'data.json': 'data-2026-11-23.json', 'pairs.json': 'pairs-2026-11-23.json', 'nflplayers.json': 'nflplayers-2026-11-23.json', 'firsttd.json': 'firsttd-2026-11-23.json',
  'injuries.json': 'injuries-2026-11-23.json', 'playerform.json': 'playerform-2026-11-23b.json', 'nbalast4.json': 'nbalast4-2026-11-23b.json', 'season.json': 'season-2026-11-23.json',
  'polymarket.json': 'polymarket-2026-11-23b.json', 'nbaroles.json': 'nbaroles-2026-11-23.json', 'nflrec.json': 'nflrec-2026-11-23.json' };
export const CLOCK = '2026-11-23T12:00:00Z';
let fails = 0, server = null;
export const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
export async function open({ width = 390, height = 844, tab = null, pins = {}, clock = CLOCK, notFound = ['mypicks.json', 'recs.json'], init = null, before = null } = {}) {
  if (!server) {
    server = http.createServer((req, res) => {
      const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const f = path.join(ROOT, u === '/' ? 'index.html' : u);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (clock) await page.clock.setFixedTime(new Date(clock));
  const P = { ...PINS, ...pins };
  await page.route(/\/([a-z0-9_-]+)\.json(\?.*)?$/i, r => {
    const f = new URL(r.request().url()).pathname.split('/').pop();
    if (notFound.includes(f)) return r.fulfill({ status: 404, body: 'nf' });
    if (P[f] === null) return r.fulfill({ status: 404, body: 'nf' });
    if (P[f]) return r.fulfill({ status: 200, contentType: 'application/json', body: FX(P[f]) });
    return r.fallback();
  });
  if (before) await before(page, ctx);  // extra routes / init scripts registered before the app loads
  if (tab || init) await page.addInitScript(([t, extra]) => { if (t) localStorage.setItem('fm2.tab', JSON.stringify(t)); if (extra) for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, JSON.stringify(v)); }, [tab, init]);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.SB && SB.firstRender, null, { timeout: 30000 });
  return { browser, ctx, page, errors };
}
export async function done(browser) {
  if (browser) await browser.close();
  if (server) server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
}
