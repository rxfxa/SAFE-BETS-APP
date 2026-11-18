// Sharp Lab sportsbook picker tests (lab.html). Run: node tests/lab.test.mjs
// Starts its own static server on a free port, drives lab.html with Playwright, prints PASS/FAIL lines.
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
  const f = path.join(ROOT, u === '/' ? 'lab.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const LAB = `http://127.0.0.1:${server.address().port}/lab.html`;
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
try {
  await page.goto(LAB);
  await page.waitForFunction(() => document.querySelectorAll('#bookChips .chip').length > 0 && window.__lab && !window.__lab.warming, null, { timeout: 30000 });
  const ui = await page.evaluate(() => ({ opts: document.querySelectorAll('#bookSel option').length, groups: [...document.querySelectorAll('#bookSel optgroup')].map(g => g.label),
    chips: [...document.querySelectorAll('#bookChips .chip')].map(c => c.textContent), on: document.querySelector('#bookChips .chip.on').textContent, val: document.getElementById('bookSel').value,
    note: document.getElementById('bookNote').textContent }));
  check('dropdown: "All sportsbooks" plus every one of the 100 books, grouped', ui.opts === 101 && ui.groups.length === 5 && ui.val === 'all', `${ui.opts} options · ${ui.groups.join(', ')}`);
  check('chips: All plus the popular books, All selected', ui.chips[0] === 'All' && ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'Fanatics', 'bet365', 'Hard Rock Bet', 'BetRivers', 'theScore Bet', 'Pinnacle'].every(n => ui.chips.includes(n)) && ui.on === 'All', ui.chips.join(','));
  check('All = your books from Settings', /Showing your \d+ book/.test(ui.note), ui.note);
  const sizes = await page.evaluate(() => [...document.querySelectorAll('#bookChips .chip'), document.getElementById('bookSel')].map(e => Math.round(e.getBoundingClientRect().height)));
  check('tap targets: chips and dropdown at least 44px tall', sizes.every(h => h >= 44), sizes.join(','));

  // pick DraftKings with a chip
  await page.click('#bookChips [data-bk]:text-is("DraftKings")');
  await page.waitForTimeout(150);
  const dk = await page.evaluate(() => ({ id: __lab.BOOKS.find(b => b.name === 'DraftKings').id, sel: document.getElementById('bookSel').value, on: document.querySelector('#bookChips .chip.on').textContent,
    stored: JSON.parse(localStorage.getItem('firstmove.st') || '{}').book, note: document.getElementById('bookNote').textContent }));
  check('chip: picking DraftKings selects it in the dropdown and saves it', dk.sel === dk.id && dk.on === 'DraftKings' && dk.stored === dk.id && /DraftKings only/.test(dk.note), JSON.stringify(dk));
  // let the market run so there is something to filter
  await page.waitForTimeout(2500);
  const f = await page.evaluate(id => {
    const L = window.__lab, plays = L.opps.filter(L.passes), arbsAll = L.scanArbs(false), mids = L.scanMiddles(false);
    return { plays: plays.length, playsOk: plays.every(o => (L.myBest(o) || o.bet) && (L.myBest(o) || o.bet).id === id), arbs: arbsAll.length, arbsOk: arbsAll.every(a => a.b0 === id || a.b1 === id),
      mids: mids.length, midsOk: mids.every(x => x.lo.id === id || x.hi.id === id), mine: L.mineBook(id) && !L.mineBook(L.BOOKS.find(b => b.name === 'FanDuel').id) };
  }, dk.id);
  check('plays: every open play is a DraftKings price', f.playsOk, `${f.plays} plays`);
  check('arbitrage: every pair has DraftKings on one side', f.arbsOk, `${f.arbs} arbs`);
  check('middles: every middle has DraftKings on one side', f.midsOk, `${f.mids} middles`);
  check('book filter: only the picked book counts as yours while it is picked', f.mine);
  // scanner header names the book
  await page.click('#nav [data-v="scan"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => { const b = document.querySelector('#scanSeg [data-s="arbs"]'); b && b.click(); });
  await page.waitForTimeout(200);
  const head = await page.evaluate(() => document.getElementById('scanHead').textContent);
  check('scanner: arbs header says "with DraftKings"', /with DraftKings/.test(head), head.trim().slice(0, 60));

  // dropdown: any of the 100 books, shown as an extra chip
  const other = await page.evaluate(() => __lab.BOOKS.find(b => b.name === 'Bovada').id);
  await page.selectOption('#bookSel', other); await page.waitForTimeout(150);
  const ov = await page.evaluate(() => ({ on: document.querySelector('#bookChips .chip.on').textContent, chips: document.querySelectorAll('#bookChips .chip').length }));
  check('dropdown: a book outside the popular list gets its own chip, selected', ov.on === 'Bovada' && ov.chips === 12, JSON.stringify(ov));

  // persistence
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#bookChips .chip').length > 0);
  const per = await page.evaluate(() => ({ v: document.getElementById('bookSel').value, on: document.querySelector('#bookChips .chip.on').textContent }));
  check('remembered after a reload', per.v === other && per.on === 'Bovada', JSON.stringify(per));

  // empty state for a sharp book
  await page.click('#bookChips [data-bk]:text-is("Pinnacle")'); await page.waitForTimeout(150);
  await page.click('#nav [data-v="feed"]'); await page.waitForTimeout(200);
  const pin = await page.evaluate(() => ({ note: document.getElementById('bookNote').textContent, feed: document.getElementById('feed').textContent }));
  check('sharp book: explains that stale prices are rare there', /sharp book/.test(pin.note), pin.note);
  check('empty or filtered feed names the picked book', /Pinnacle/.test(pin.feed) || (await page.evaluate(() => { const L = __lab; return L.opps.filter(L.passes).every(o => L.myBest(o).id === L.BOOKS[0].id); })));

  // back to all
  await page.selectOption('#bookSel', 'all'); await page.waitForTimeout(150);
  const all = await page.evaluate(() => { const L = __lab; return { on: document.querySelector('#bookChips .chip.on').textContent, book: L.st.book, mine: L.RETAIL.filter(b => L.mineBook(b.id)).length === L.RETAIL.filter(b => L.st.books[b.id]).length }; });
  check('All sportsbooks goes back to your Settings books', all.on === 'All' && all.book === 'all' && all.mine, JSON.stringify(all));

  // a stale saved id falls back to All
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('firstmove.st') || '{}'); s.book = 'nope'; localStorage.setItem('firstmove.st', JSON.stringify(s)); });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#bookChips .chip').length > 0);
  check('unknown saved book falls back to All', await page.evaluate(() => document.getElementById('bookSel').value === 'all' && document.querySelector('#bookChips .chip.on').textContent === 'All'));

  await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(150);
  check('360px: no horizontal page scroll (chips scroll inside their row)', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
