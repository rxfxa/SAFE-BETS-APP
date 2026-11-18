// Slip Check tests (slipcheck.js). Run: node tests/slipcheck.test.mjs
// Starts its own static server on a free port, stubs window.claude.use('sample') with a canned slip reading,
// drives the page with Playwright, prints PASS/FAIL lines, exits non-zero on any failure.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---------- a canned reading built from the live board ----------
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const PROPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'props.json'), 'utf8'));
const soon = g => g.status === 'scheduled' && g.prob && Date.parse(g.start) > Date.now() + 3600e3;
const nba = DATA.games.filter(g => g.sport === 'nba' && soon(g)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
const soc = DATA.games.find(g => g.sport === 'soccer' && soon(g) && g.prob.draw != null);
const pl = PROPS.players.find(p => p.stat === 'pts' && p.status === 'active' && nba.some(g => g.id === p.gid) && !nba.slice(0, 2).some(g => g.id === p.gid))
  || PROPS.players.find(p => p.stat === 'pts' && p.status === 'active' && nba.some(g => g.id === p.gid));
const [G1, G2] = nba;
const ready = G1 && G2 && soc && pl;
const CANNED = ready ? {
  book: 'DraftKings', betType: 'parlay', stake: 10, totalOdds: '+1450', payout: 155,
  legs: [
    { sport: 'nba', event: `${G1.away.name} @ ${G1.home.name}`, market: 'moneyline', selection: `${G1.home.name} Moneyline`, team: G1.home.name, player: null, side: null, line: null, odds: '-150', confidence: 0.95 },
    { sport: 'nba', event: `${G1.away.name} @ ${G1.home.name}`, market: 'total', selection: 'Over 220.5', team: null, player: null, side: 'over', line: 220.5, odds: '-110', confidence: 0.9 },
    { sport: 'nba', event: `${G2.away.name} @ ${G2.home.name}`, market: 'spread', selection: `${G2.away.name} +5.5`, team: G2.away.name, player: null, side: null, line: 5.5, odds: '-110', confidence: 0.9 },
    { sport: 'nba', event: '', market: 'player_points', selection: `${pl.name} Over ${Math.floor(pl.avg) - 0.5} Points`, team: null, player: pl.name, side: 'over', line: Math.floor(pl.avg) - 0.5, odds: '-120', confidence: 0.6 },
    { sport: 'soccer', event: `${soc.home.name} vs ${soc.away.name}`, market: 'btts', selection: 'Both Teams To Score - Yes', team: null, player: null, side: null, line: null, odds: '-125', confidence: 0.9 },
    { sport: 'mlb', event: 'Dodgers vs Padres', market: 'player_other', selection: 'Shohei Ohtani to hit a home run', team: null, player: 'Shohei Ohtani', side: null, line: null, odds: '+300', confidence: 0.8 },
  ], notes: '' } : null;

const browser = await chromium.launch();
async function openPage({ stub = null, w = 390, h = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(([stub]) => {
    localStorage.setItem('fm2.tab', JSON.stringify('slipcheck'));
    if (!stub) return;
    window.__calls = [];
    const fn = async (input, opts = {}) => { window.__calls.push({ kind: 'text', input, tier: opts.modelTier }); const t = 'Pass at this price. The parlay hits less often than the payout needs.'; opts.onText && opts.onText({ text: t, delta: t }); return { text: t, truncated: false, modelTierApplied: 'quick' }; };
    fn.json = async (input, opts = {}) => { window.__calls.push({ kind: 'json', input, images: opts.images ? opts.images.length : 0 });
      if (stub.reject) throw { code: stub.reject, message: 'stub' }; return JSON.parse(JSON.stringify(stub.canned)); };
    fn.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20e6, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] } });
    window.claude = { use: async n => (n === 'sample' ? fn : null) };
  }, [stub]);
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__slipcheck && window.__lottos && window.__lottos.LOAD === 'done', null, { timeout: 30000 });
  await page.waitForFunction(() => window.__slipcheck.ai !== 'checking', null, { timeout: 15000 });
  await page.waitForTimeout(200);
  return { ctx, page, errors };
}

try {
  check('fixture: board has 2 NBA games, a soccer game and a props player', !!ready);
  // ---------- AI path ----------
  const { ctx, page, errors } = await openPage({ stub: { canned: CANNED } });
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabs [data-t]')].map(x => x.dataset.t));
  check('tab: Slip Check sits right after My Parlays', tabs.indexOf('slipcheck') === tabs.indexOf('mine') + 1, tabs.join(','));
  check('AI available: "Read slip with AI" shows, disabled until an image is added', await page.$eval('[data-sc-read]', b => b.disabled));
  await page.setInputFiles('#scFile', { name: 'slip.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.sc-drop img');
  check('upload: preview shows and Read is enabled', !(await page.$eval('[data-sc-read]', b => b.disabled)));
  await page.click('[data-sc-read]');
  await page.waitForSelector('.sc-verdict', { timeout: 20000 });
  const call = await page.evaluate(() => window.__calls.find(c => c.kind === 'json'));
  check('reading: one sample.json call with the image and the slip prompt', call && call.images === 1 && /bet slip/.test(call.input) && /"legs"/.test(call.input));
  const A = await page.evaluate(() => { const A = window.__slipcheck.state.A; return { rows: A.rows.map(r => ({ st: r.status, key: r.key, p: r.p })), p: A.p, indep: A.indep, ev: A.ev, dec: A.decCmp, verdict: A.verdict, full: A.full, corr: A.corr.length }; });
  const keys = A.rows.map(r => r.key);
  check('matching: 5 legs priced, the MLB prop kept as not priced', A.rows.filter(r => r.st === 'matched').length === 5 && A.rows[5].st !== 'matched', JSON.stringify(A.rows.map(r => r.st)));
  check('matching: keys for winner, total, spread, player points and BTTS', keys[0] === 'SC:ml:H' && keys[1] === 'SC:tot:O:220.5' && keys[2] === 'SC:sp:A:5.5' && /^P:[^:]+:\d+$/.test(keys[3]) && keys[4] === 'SC:btts:Y', keys.join(' | '));
  const xs = await page.evaluate(([g1, sc]) => { const G = SB.gameById(g1), S = SB.gameById(sc);
    return { ml: [SB.p1(G, 'SC:ml:H'), SB.p1(G, 'H')], btts: [SB.p1(S, 'SC:btts:Y'), SB.p1(S, 'BTTS')], sp: [SB.p1(G, 'SC:sp:H:-5.5'), SB.p1(G, 'H5.5')] }; }, [G1.id, soc.id]);
  check('pricing: any-line winner matches the engine moneyline (100k sims)', Math.abs(xs.ml[0] - xs.ml[1]) < 0.01, JSON.stringify(xs.ml));
  check('pricing: soccer BTTS from the score grid matches the engine exactly', Math.abs(xs.btts[0] - xs.btts[1]) < 1e-9, JSON.stringify(xs.btts));
  check('pricing: home -5.5 matches the engine "win by 6+" market', Math.abs(xs.sp[0] - xs.sp[1]) < 0.01, JSON.stringify(xs.sp));
  check('analysis: same-game legs priced together (one correlated group)', A.corr === 1 && A.p > 0 && Math.abs(A.p - A.indep) > 1e-6, JSON.stringify({ p: A.p, indep: A.indep }));
  check('analysis: partial slip compares only the priced legs against their book prices', A.full === false && Math.abs(A.dec - [1.6667, 1.9091, 1.9091, 1.8333, 1.8].reduce((s, x) => s * x, 1)) < 0.05, String(A.dec));
  check('verdict: a direct verdict with model and book numbers', ['Value bet', 'Fair price', 'Overpriced', 'Long shot'].includes(A.verdict) && /model/.test(await page.textContent('.sc-op')), A.verdict);
  const ui = await page.evaluate(() => ({ rows: document.querySelectorAll('.sc-tbl .sc-tr').length, can: document.querySelectorAll('.sc-why .pc:first-child li').length, not: document.querySelectorAll('.sc-why .pc:last-child li').length,
    weak: !!document.querySelector('.b-live'), text: document.querySelector('#main').textContent }));
  check('compare table: header + 6 legs + parlay row', ui.rows === 8, String(ui.rows));
  check('reasons: both "why it can hit" and "why it might not" are filled', ui.can > 0 && ui.not > 0, `${ui.can}/${ui.not}`);
  check('reasons: unpriced leg is called out', /Not priced: .*Ohtani/.test(ui.text));
  check('copy: honest (no lock / guaranteed / sure win)', !/\block\b|\bguaranteed\b|sure win/i.test(ui.text));
  // Claude's take
  await page.click('[data-sc-take]');
  await page.waitForFunction(() => (document.getElementById('scTake') || {}).textContent.length > 10);
  const take = await page.evaluate(() => { const c = window.__calls.find(c => c.kind === 'text'); return { prompt: c && c.input, tier: c && c.tier, text: document.getElementById('scTake').textContent }; });
  check("Claude's take: grounded prompt with the model numbers only", /ONLY the numbers/.test(take.prompt) && /parlayModelHitChance/.test(take.prompt) && take.tier === 'quick' && take.text.startsWith('Pass'));
  // builder + track
  await page.click('[data-sc-build]'); await page.waitForTimeout(300);
  const slip = await page.evaluate(() => SB.slip.map(l => l.key));
  check('builder: opens with the 5 priced legs', slip.length === 5 && slip.every(k => !k.startsWith('X:')), slip.join(' | '));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  const before = await page.evaluate(() => (JSON.parse(localStorage.getItem('fm2.saved') || '[]')).length);
  await page.click('[data-sc-track]'); await page.waitForTimeout(200);
  const rec = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('fm2.saved') || '[]'); return { n: s.length, last: s[s.length - 1] }; });
  check('track: saved to My Parlays with book, stake, odds and all 6 legs', rec.n === before + 1 && rec.last.book === 'DraftKings' && rec.last.stake === 10 && rec.last.legs.length === 6 && rec.last.dec > 1, JSON.stringify({ n: rec.n, book: rec.last && rec.last.book, legs: rec.last && rec.last.legs.length }));
  check('track: the unpriced leg is kept as a hand-graded custom leg', rec.last.legs[5].custom === true && /^X:/.test(rec.last.legs[5].key) && /Ohtani/.test(rec.last.legs[5].label));
  await page.evaluate(() => SB.goTab('mine')); await page.waitForTimeout(250);
  const mine = await page.evaluate(() => ({ title: [...document.querySelectorAll('#main .pctitle')].map(x => x.textContent), grade: document.querySelectorAll('#main [data-grade]').length }));
  check('My Parlays: shows the book and offers ✓/✗ for the custom leg', mine.title.some(t => /6-leg parlay · DraftKings/.test(t)) && mine.grade >= 2, JSON.stringify(mine));
  await page.evaluate(() => SB.goTab('slipcheck')); await page.waitForTimeout(200);
  await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(200);
  check('360px: no horizontal scroll with the full analysis on screen', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('no console errors (AI path)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ---------- AI declined: friendly message, hand entry still works ----------
  const d = await openPage({ stub: { canned: CANNED, reject: 'not_granted' } });
  await d.page.setInputFiles('#scFile', { name: 'slip.png', mimeType: 'image/png', buffer: PNG });
  await d.page.click('[data-sc-read]'); await d.page.waitForSelector('.sc-err');
  const dd = await d.page.evaluate(() => ({ err: document.querySelector('.sc-err').textContent, btn: !!document.querySelector('[data-sc-read]') }));
  check('declined: says so, hides the AI button, keeps hand entry', /enter the legs by hand/.test(dd.err) && !dd.btn, JSON.stringify(dd));
  await d.ctx.close();

  // ---------- no AI at all (outside a Claude viewer): manual entry ----------
  const m = await openPage();
  const noAi = await m.page.evaluate(() => ({ btn: !!document.querySelector('[data-sc-read]'), note: document.querySelector('.sc-up .note').textContent }));
  check('no AI in this view: no read button, hand entry offered', !noAi.btn && /Enter the legs by hand/.test(noAi.note));
  await m.page.click('[data-sc-manual]');
  await m.page.fill('#sc-ev-0', `${G2.away.name} @ ${G2.home.name}`);
  await m.page.selectOption('#sc-mk-0', 'moneyline');
  await m.page.fill('#sc-pk-0', G2.home.name.split(' ').slice(-1)[0]);
  await m.page.fill('#sc-od-0', '-140');
  await m.page.click('[data-sc-go]'); await m.page.waitForSelector('.sc-verdict');
  const mr = await m.page.evaluate(() => { const A = window.__slipcheck.state.A; return { st: A.rows[0].status, key: A.rows[0].key, ev: A.ev, v: A.verdict }; });
  check('hand entry: a typed moneyline by nickname is matched and graded', mr.st === 'matched' && mr.key === 'SC:ml:H' && mr.ev != null, JSON.stringify(mr));
  await m.page.reload(); await m.page.waitForFunction(() => window.__slipcheck && window.SB && SB.firstRender);
  check('draft survives a reload', await m.page.evaluate(() => document.getElementById('sc-ev-0') && document.getElementById('sc-ev-0').value.length > 3));
  check('no console errors (hand entry)', m.errors.length === 0, m.errors.slice(0, 3).join(' | '));
  await m.ctx.close();
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
