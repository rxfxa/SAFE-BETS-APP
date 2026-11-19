// Live Polymarket positions in the Weekly Plan: the browser reads a wallet's public positions and combos (no login, no key).
// Run: node tests/pm-live.test.mjs   (offline: Polymarket's data API is answered by the test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const FX = fs.readFileSync(path.join(ROOT, 'tests/fixtures/pm-2026-11-18.json'), 'utf8');
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
const WALLET = '0x983eedfbd75803602e4a6e6ea9aab6dc6b9c6748';
const OTHER = '0x1111111111111111111111111111111111111111';
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const pos = (st, i, extra = {}) => ({ title: `Market ${st} ${i}`, outcome: i % 2 ? 'Yes' : 'No', slug: `${st.toLowerCase()}-${i}`, event_slug: 'ev', end_date: '2026-12-01',
  status: st, avg_price: 0.4, current_price: 0.55, total_size: 10, total_cost_usdc: 4, current_value: 5.5, total_pnl: 1.5, first_entry_at: 1795000000, last_event_at: 1795000100, ...extra });
const NET = { mode: 'ok' };
const calls = [];
// what Polymarket's data API would answer for WALLET: OPEN is two pages; one position repeats under REDEEMABLE (must show once)
function answer(url) {
  const u = new URL(url), st = u.searchParams.get('status'), cur = u.searchParams.get('cursor');
  if (u.pathname === '/v2/positions/combos') return { data: [{ title: 'Combo A', status: 'OPEN', total_pnl: -0.5, legs: [{ title: 'Leg one', outcome: 'Yes', slug: 's', status: 'OPEN', current_price: 0.5 }] }], pagination: {} };
  if (u.pathname !== '/v2/positions') return {};
  if (st === 'OPEN') return cur === 'c2' ? { data: [pos('OPEN', 2)], pagination: {} } : { data: [pos('OPEN', 0), pos('OPEN', 1)], pagination: { next_cursor: 'c2' } };
  if (st === 'REDEEMABLE') return { data: [pos('OPEN', 0)], pagination: {} };  // duplicate of an OPEN position
  if (st === 'CLOSED') return { data: [pos('CLOSED', 5, { total_pnl: -4 })], pagination: {} };
  return { data: [], pagination: {} };
}

async function open({ snapshot = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date('2026-11-18T21:50:00Z'));
  await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
  await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: FX }));
  await page.route('https://data-api.polymarket.com/**', r => {
    const url = r.request().url(); calls.push(url);
    if (NET.mode === 'fail') return r.abort('connectionfailed');
    if (NET.mode === 'http500') return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer(url)) });
  });
  await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('plan')));
  if (snapshot) await page.addInitScript(doc => {
    // Claude's database, holding one saved sync (pm/positions) of one wallet
    const db = {
      collection() { const q = { orderBy() { return q; }, limit() { return q; }, onSnapshot(cb) { cb({ docs: [] }); }, doc() { return { set: async () => {} }; } }; return q; },
      doc(p) { return { onSnapshot(cb) { cb({ exists: p === 'pm/positions', data: () => doc }); }, get: async () => ({ exists: false }), set: async () => {} }; },
    };
    window.claude = { use: async () => db };
  }, snapshot);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__plan && window.__polymarket && window.__polymarket.LOAD === 'done' && window.__lottos && window.__lottos.LOAD === 'done', null, { timeout: 30000 });
  await page.evaluate(() => SB.render()); await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const rows = page => page.$$eval('.pl-pm .pl-pmr', xs => xs.length);
const pmText = page => page.$eval('.pl-pm', x => x.textContent.replace(/\s+/g, ' '));

const browser = await chromium.launch();
try {
  // 1. no wallet yet: nothing is fetched
  const A = await open();
  await A.page.waitForTimeout(1500);
  check('no wallet connected: nothing is requested from Polymarket', calls.length === 0, `${calls.length} calls`);
  // 2. a bad address is refused and fetches nothing
  await A.page.fill('#plPmAddr', 'nope'); await A.page.click('[data-pl-pmsave]'); await A.page.waitForTimeout(400);
  check('bad address: refused, nothing requested', calls.length === 0 && !(await A.page.evaluate(() => localStorage.getItem('fm2.plan.pmAddr'))));
  // 3. connect: the browser reads positions and combos, paging with the cursor
  await A.page.fill('#plPmAddr', WALLET); await A.page.click('[data-pl-pmsave]');
  await A.page.waitForFunction(() => /Synced/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  const urls = calls.map(u => new URL(u));
  const statuses = new Set(urls.filter(u => u.pathname === '/v2/positions').map(u => u.searchParams.get('status')));
  check('connect: all four statuses and combos are requested', ['OPEN', 'REDEEMABLE', 'REDEEMABLE_LOST', 'CLOSED'].every(s => statuses.has(s)) && urls.some(u => u.pathname === '/v2/positions/combos'));
  check('connect: the wallet is sent in lowercase and the cursor is followed', urls.every(u => (u.searchParams.get('user') || WALLET) === WALLET) && urls.some(u => u.searchParams.get('cursor') === 'c2'));
  const t1 = await pmText(A.page);
  check('connect: open positions shown (3, both pages), the duplicate once, the combo and the settled row', /Open \(3\)/.test(t1) && /Combo A/.test(t1) && /Settled/.test(t1), t1.slice(0, 300));
  check('connect: 5 rows in total (3 open, 1 combo, 1 settled)', (await rows(A.page)) === 5, `${await rows(A.page)} rows`);
  check('connect: says when it last synced', /Synced /.test(t1) && !/Syncing/.test(t1));
  // 4. reload with the network down: the last sync for this wallet still shows, with a clear note
  NET.mode = 'fail';
  await A.page.reload();
  await A.page.waitForFunction(() => window.__plan && window.__polymarket && window.__polymarket.LOAD === 'done', null, { timeout: 30000 });
  await A.page.evaluate(() => SB.render()); await A.page.waitForTimeout(300);
  check('reload: last sync is shown from this browser before the network answers', (await rows(A.page)) === 5, `${await rows(A.page)} rows`);
  await A.page.waitForFunction(() => /Showing your last sync/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  check('network down: a plain note, no crash', /Couldn't reach Polymarket from this page/.test(await pmText(A.page)));
  // 5. a different wallet while the network is down: nothing from the old wallet is shown as theirs
  await A.page.fill('#plPmAddr', OTHER); await A.page.click('[data-pl-pmsave]');
  await A.page.waitForFunction(() => /Showing your last sync|Not synced yet/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  check('new wallet while offline: no positions from the old wallet', (await rows(A.page)) === 0, `${await rows(A.page)} rows`);
  // 6. back online: the new wallet syncs (no positions for it in this fixture, so it says so)
  NET.mode = 'ok';
  await A.page.reload();
  await A.page.waitForFunction(() => window.__plan && window.__polymarket && window.__polymarket.LOAD === 'done', null, { timeout: 30000 });
  await A.page.waitForFunction(() => /Synced/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  check('online again: the wallet on file syncs by itself on load', /Synced/.test(await pmText(A.page)));
  // 7. Claude's last sync (database) still works when there is no live copy
  await A.page.evaluate(() => { localStorage.removeItem('fm2.plan.pmLive'); });
  // 7b. Claude's saved sync is shown only for the wallet it belongs to
  const SNAP_OTHER = { updated: '2026-11-18T20:00:00Z', wallet: '0xaaaa…aaaa', positions: [{ title: 'OTHER WALLET POS', outcome: 'Yes', slug: 'other', status: 'OPEN', avg: 0.5, now: 0.6, pnl: 1 }], combos: [] };
  const SNAP_MINE = { updated: '2026-11-18T20:00:00Z', wallet: '0x983e…6748', positions: [{ title: 'MINE POS', outcome: 'Yes', slug: 'mine', status: 'OPEN', avg: 0.5, now: 0.6, pnl: 1 }], combos: [] };
  NET.mode = 'fail';
  const S1 = await open({ snapshot: SNAP_OTHER });
  await S1.page.waitForTimeout(800);
  check('a saved sync for another wallet is not shown when no wallet is connected', !/OTHER WALLET POS/.test(await pmText(S1.page)));
  await S1.page.fill('#plPmAddr', WALLET); await S1.page.click('[data-pl-pmsave]');
  await S1.page.waitForFunction(() => /Showing your last sync|Not synced yet/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  check('a saved sync for another wallet is not shown for the connected wallet either', !/OTHER WALLET POS/.test(await pmText(S1.page)));
  await S1.ctx.close();
  const S2 = await open({ snapshot: SNAP_MINE });
  await S2.page.fill('#plPmAddr', WALLET); await S2.page.click('[data-pl-pmsave]');
  await S2.page.waitForFunction(() => /Showing your last sync/.test(document.querySelector('.pl-pm').textContent), null, { timeout: 30000 });
  check("the saved sync for the connected wallet is shown when the live sync is down", /MINE POS/.test(await pmText(S2.page)));
  await S2.ctx.close();
  NET.mode = 'ok';
  // 7c. text typed in the wallet box but not saved survives a sync that finishes meanwhile
  NET.mode = 'ok';
  await A.page.fill('#plPmAddr', '0x2222222222222222222222222222222222222222');
  await A.page.evaluate(() => window.__plan.syncPm());
  await A.page.waitForTimeout(1500);
  check('typed but unsaved wallet address survives a sync that finishes meanwhile', (await A.page.inputValue('#plPmAddr')) === '0x2222222222222222222222222222222222222222');
  // 8. layout and console
  await A.page.setViewportSize({ width: 360, height: 740 }); await A.page.waitForTimeout(200);
  check('360px: no horizontal scroll', (await A.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  // the offline step blocks Polymarket on purpose, so the browser logs those blocked requests; anything else is an error
  const unexpected = A.errors.filter(e => !/ERR_CONNECTION_FAILED/.test(e));
  check('no console errors (except the blocked requests of the offline step)', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  await A.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
