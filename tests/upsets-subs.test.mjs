// Upset Parlays: ⇄ leg swaps on every card (#upMain, #upForm, #upEdge). Stand-ins of the same kind and about the same chance,
// never from a game or team already on the card; a pick re-prices the card, ↺ undoes it, and a card with a 500,000-run result
// runs again for the new legs. Run: node tests/upsets-subs.test.mjs (saved board, fixed clock).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const PMJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/polymarket-2026-11-20.json'), 'utf8'));
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-18.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const NOW = Date.parse('2026-11-20T12:00:00Z');
// NBA / NHL underdog games in the window (college names are mascots shared by many schools, so they're left out of the form file)
const dogGames = PMJ.games.filter(g => !g.stale && Date.parse(g.start) > NOW && Date.parse(g.start) - NOW <= 48 * 3600e3 && (g.sport === 'nba' || g.sport === 'nhl') && g.ml && g.ml.home && g.ml.away)
  .map(g => { const h = g.ml.home, a = g.ml.away, dog = h.m < a.m ? 'home' : 'away', q = g.ml[dog]; return { g, fav: dog === 'home' ? 'away' : 'home', ok: q.m >= .15 && q.m <= .5 && q.a != null && q.a <= .55 }; })
  .filter(x => x.ok);
const team = (name, sport, o) => ({ name, sport, comp: 'X', record: '9-6', unbeaten: 0, winStreak: 0, lossStreak: 0, winless: 0, last5: 'L L W W L', lastGame: 'x', asOf: '2026-11-19', sources: ['https://example.org'], confidence: 'verified', ...o });
const formFor = xs => { const m = new Map(); for (const x of xs) m.set(x.g.sport + x.g[x.fav].name, team(x.g[x.fav].name, x.g.sport, { lossStreak: 2 })); return { updated: '2026-11-20T08:00:00Z', teams: [...m.values()] }; };
const INJ = { updated: '2026-11-20T06:00:00Z', injuries: [] };  // no injuries: every close game leans to its home side
const browser = await chromium.launch();
async function open(FORM) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: DATA }));
  await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PMJ) }));
  await page.route('**/injuries.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(INJ) }));
  await page.route('**/form.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FORM) }));
  await page.addInitScript(() => localStorage.setItem('fm2.tab', JSON.stringify('upsets')));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__upsets && document.getElementById('upMain') && document.getElementById('upForm') && document.getElementById('upEdge'), null, { timeout: 60000 });
  return { ctx, page, errors };
}
// the open stand-in list of a card, as shown
const subsShown = (page, id) => page.evaluate(id => { const s = document.querySelector(`#${id} .subs`); return s ? { rows: [...s.querySelectorAll('.subrow')].map(r => ({ k: r.dataset.k, text: r.textContent.replace(/\s+/g, ' ').trim() })), note: (s.querySelector('.note') || {}).textContent || '' } : null; }, id);
const legLabels = (page, id) => page.$$eval(`#${id} .leg`, xs => xs.map(x => x.querySelector('b').textContent));
const headPct = async (page, id) => { const t = await page.textContent(`#${id} .pchead .hit`); return /^<0\.01%/.test(t) ? 1e-4 : parseFloat(t) / 100; };
const simMatches = (page, id) => page.waitForFunction(id => { const S = __upsets.SIMS[id], L = __upsets.CARDS[id], b = document.querySelector(`[data-up-sim="${id}"]`);
  return S && L && S.sig === __upsets.sigOf(L) && /500,000 runs/.test(document.querySelector(`[data-up-out="${id}"]`).textContent) && b && !b.disabled; }, id, { timeout: 30000 });

try {
  check('fixture has 10+ NBA/NHL underdog games for the form file', dogGames.length >= 10, String(dogGames.length));
  const { ctx, page, errors } = await open(formFor(dogGames));
  // ---------- every leg of every card: ⇄ with 3+ stand-ins that fit ----------
  for (const id of ['upMain', 'upForm', 'upEdge']) {
    const n = await page.locator(`#${id} .leg`).count();
    check(`${id}: every leg has a ⇄ swap button`, n >= 2 && (await page.locator(`#${id} [data-up-swap]`).count()) === n, `${n} legs`);
    const per = [], bad = [];
    for (let i = 0; i < n; i++) {
      await page.locator(`#${id} [data-up-swap]`).nth(i).click();
      const s = await subsShown(page, id);
      per.push(s ? s.rows.length : 0);
      // the rules, checked against the card and the board here rather than trusting the module
      const r = await page.evaluate(([id, i, keys]) => {
        const G = new Map(__polymarket.PM.games.map(g => [g.slug, g])), L = __upsets.CARDS[id], o = L[i];
        const T = slug => { const g = G.get(slug); return [g.home.abbr, g.away.abbr].map(a => g.sport + ':' + a); };
        const onCard = new Set(L.map(l => l.game)), teams = new Set(L.flatMap(l => T(l.game)));
        const R = __upsets.subsFor(id, o.game), d = c => Math.round(Math.abs(c.mid - o.mid) * 100), edgeKeys = new Set(__upsets.edgeLegs().map(l => l.game + '|' + l.kind + '|' + l.label));
        const games = keys.map(k => k.split('|')[0]), out = [];
        if (games.some(g => onCard.has(g))) out.push('a stand-in is from a game on the card');
        if (games.some(g => T(g).some(t => teams.has(t)))) out.push('a stand-in shares a team with the card');
        if (new Set(games).size !== games.length) out.push('two stand-ins from one game');
        if (R.list.some(c => c.kind !== o.kind)) out.push('a stand-in of another kind');
        if (id === 'upForm' && R.list.some(c => !(c.edge && c.edge.score >= 1))) out.push('a form stand-in with a form edge under 1');
        if (id === 'upEdge' && keys.some(k => !edgeKeys.has(k))) out.push('an edge stand-in that is not a close-game edge pick');
        for (let j = 1; j < R.list.length; j++) if (d(R.list[j]) < d(R.list[j - 1])) out.push('not closest chance first');
        const rest = R.fit.slice(R.list.length); if (rest.length && Math.min(...rest.map(d)) < Math.max(...R.list.map(d))) out.push('a closer stand-in was left out');
        if (keys.join() !== R.list.map(c => c.game + '|' + c.kind + '|' + c.label).join()) out.push('shown list differs from the rules');
        return out;
      }, [id, i, s ? s.rows.map(x => x.k) : []]);
      bad.push(...r.map(x => `leg ${i + 1}: ${x}`));
      if (s) for (const row of s.rows) if (!(/\d+%/.test(row.text) && /¢ to buy/.test(row.text) && /different game/.test(row.text) && /card [\d.<]+%, pays ×\d/.test(row.text))) bad.push(`leg ${i + 1}: row missing chance/price/why: ${row.text}`);
      if (s && id !== 'upMain' && !s.rows.every(row => (id === 'upForm' ? /favourite lost 2 straight/ : /at home/).test(row.text))) bad.push(`leg ${i + 1}: a stand-in without its reasons`);
    }
    check(`${id}: at least 3 stand-ins on every leg`, per.length === n && per.every(x => x >= 3), JSON.stringify(per));
    check(`${id}: stand-ins never from a game or team already on the card, same kind, closest chance first, each with chance, price, competition and why`, bad.length === 0, bad.slice(0, 4).join(' | '));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${id}: 390px with stand-ins open: no horizontal scroll`, over <= 0, `${over}px over`);
    await page.locator(`#${id} [data-up-swap][aria-expanded="true"]`).click();
    check(`${id}: ⇄ again closes the list`, (await page.locator(`#${id} .subs`).count()) === 0);
  }
  await page.locator('#upMain [data-up-swap]').nth(0).click();
  const comps = await page.evaluate(() => { const L = __upsets.CARDS.upMain, R = __upsets.subsFor('upMain', L[0].game); return R.list.map(c => c.sport === 'soccer' ? 'Soccer · ' + c.comp : c.comp); });
  const rowsTxt = (await subsShown(page, 'upMain')).rows.map(r => r.text);
  check('each stand-in shows its sport / competition', comps.every((c, i) => rowsTxt[i].includes(c)), JSON.stringify(comps));
  await page.locator('#upMain [data-up-swap][aria-expanded="true"]').click();

  // ---------- pick a stand-in on the main card: it replaces the leg, re-prices, and the 500,000 runs follow ----------
  await page.click('[data-up-sim="upMain"]'); await simMatches(page, 'upMain');
  // SIMS.at is Date.now(), which the fixed clock freezes: tell runs apart by the result object instead
  const before = await page.evaluate(() => ({ run: (window.__run0 = __upsets.SIMS.upMain, 1), sig: __upsets.SIMS.upMain.sig, head: document.querySelector('#upMain .pchead .hit').textContent, pays: document.querySelector('#upMain .kpi b').textContent }));
  const L0 = await legLabels(page, 'upMain');
  await page.locator('#upMain [data-up-swap]').nth(1).click();
  // pick a stand-in whose chance differs by a point or more, so the re-price is visible
  const pick = await page.evaluate(() => { const L = __upsets.CARDS.upMain, o = L[1], R = __upsets.subsFor('upMain', o.game); const i = Math.max(0, R.list.findIndex(c => Math.abs(c.mid - o.mid) >= .01)); return { i, label: R.list[i].label, team: R.list[i].team || R.list[i].label, orig: o.label }; });
  await page.locator('#upMain .subrow').nth(pick.i).click();
  const L1 = await legLabels(page, 'upMain');
  check('picking a stand-in replaces that leg only', L1[1] === pick.label && L1.filter((x, i) => i !== 1).join() === L0.filter((x, i) => i !== 1).join(), JSON.stringify({ L0, L1 }));
  const tag = await page.textContent('#upMain .leg.swapped .swtag').catch(() => '');
  check('the swapped leg is marked SWAPPED and names the leg it replaced, with an ↺ undo', /SWAPPED/.test(tag) && tag.includes(pick.orig) && (await page.locator('#upMain [data-up-undo]').count()) === 1, tag);
  const price = await page.evaluate(() => { const L = __upsets.CARDS.upMain; return { prod: L.reduce((s, l) => s * l.mid, 1), dec: L.reduce((s, l) => s * (l.ask > 0 ? 1 / l.ask : 1), 1), head: document.querySelector('#upMain .pchead .hit').textContent, pays: document.querySelector('#upMain .kpi b').textContent }; });
  const shown = await headPct(page, 'upMain');
  check('the card re-prices: market chance is the product of the legs shown', price.head !== before.head && shown / price.prod > .9 && shown / price.prod < 1.1, `${before.head} -> ${price.head} (product ${(price.prod * 100).toPrecision(3)}%)`);
  check('the card re-prices: the payout is the product of the buy prices', price.pays === '×' + price.dec.toFixed(1) && price.pays !== before.pays, `${before.pays} -> ${price.pays}`);
  await simMatches(page, 'upMain');
  const S = await page.evaluate(() => { const s = __upsets.SIMS.upMain, L = __upsets.CARDS.upMain; return { fresh: s !== window.__run0, n: __upsets.N_SIM, legs: s.mkt.legHits, mids: L.map(l => l.mid), rate: s.mkt.rate, out: document.querySelector('[data-up-out="upMain"]').textContent }; });
  const prod = S.mids.reduce((a, x) => a * x, 1), se = Math.sqrt(prod * (1 - prod) / S.n);
  check('the 500,000 runs re-ran on their own after the swap (live)', S.fresh && S.n === 500000);
  check('the new runs match the new legs: each leg at its own chance, card within 4 standard errors', S.legs.every((x, i) => Math.abs(x - S.mids[i]) < .005) && Math.abs(S.rate - prod) <= 4 * se + 1e-6 && S.out.includes(pick.team), JSON.stringify(S.legs.map(x => +x.toFixed(3))));
  // a re-render (stake change, data refresh) keeps the swap
  await page.fill('#upStake', '25'); await page.locator('#upStake').blur(); await page.waitForTimeout(150);
  await page.evaluate(() => SB.render()); await page.waitForTimeout(150);
  check('a re-render (stake change, refresh) keeps the swap', (await legLabels(page, 'upMain'))[1] === pick.label && /SWAPPED/.test(await page.textContent('#upMain')) && /returns on \$25/.test(await page.textContent('#upMain')));
  // ↺ puts the original back and the runs follow again
  await page.evaluate(() => { window.__run1 = __upsets.SIMS.upMain; });
  await page.click('#upMain [data-up-undo]');
  const L2 = await legLabels(page, 'upMain');
  check('↺ undo restores the original leg and its price', L2.join() === L0.join() && !/SWAPPED/.test(await page.textContent('#upMain')) && (await page.textContent('#upMain .pchead .hit')) === before.head, JSON.stringify(L2));
  await simMatches(page, 'upMain');
  check('after ↺ the runs re-ran and match the original legs again', await page.evaluate(sig => __upsets.SIMS.upMain.sig === sig && __upsets.SIMS.upMain !== window.__run1, before.sig));

  // ---------- form and edge cards swap the same way ----------
  for (const id of ['upForm', 'upEdge']) {
    const a = await legLabels(page, id);
    await page.locator(`#${id} [data-up-swap]`).nth(0).click();
    const s = await subsShown(page, id), want = await page.evaluate(id => __upsets.subsFor(id, __upsets.CARDS[id][0].game).list[0].label, id);
    await page.locator(`#${id} .subrow`).nth(0).click();
    const b = await legLabels(page, id);
    check(`${id}: picking a stand-in replaces the leg and marks it SWAPPED`, s && b[0] === want && b[0] !== a[0] && /SWAPPED/.test(await page.textContent(`#${id}`)), `${a[0]} -> ${b[0]}`);
  }
  // a stand-in never comes from a game on the card, also once other legs are swapped
  const swappedClash = await page.evaluate(() => { const L = __upsets.CARDS.upForm, R = __upsets.subsFor('upForm', L[1].game), g = new Set(L.map(l => l.game).concat(L.filter(l => l.orig).map(l => l.orig.game))); return R.list.filter(c => g.has(c.game)).map(c => c.label); });
  check('with a leg swapped, other legs\' stand-ins skip both the new leg\'s game and the swapped-out one', swappedClash.length === 0, swappedClash.join());

  // ---------- the original leaves the board: the swap is dropped ----------
  await page.locator('#upMain [data-up-swap]').nth(2).click(); await page.locator('#upMain .subrow').nth(0).click();
  const orig = await page.evaluate(() => __upsets.CARDS.upMain[2].orig.game);
  check('main card swap is in place before the original leaves', await page.evaluate(() => __upsets.SWAPS.upMain.size === 1));
  await page.evaluate(g => { __polymarket.PM.games.find(x => x.slug === g).stale = true; SB.render(); }, orig); await page.waitForTimeout(150);
  check('the original leg leaves the board: its swap is dropped', await page.evaluate(g => __upsets.SWAPS.upMain.size === 0 && !__upsets.CARDS.upMain.some(l => l.game === g || (l.orig && l.orig.game === g)) && !document.querySelector('#upMain .swtag'), orig));
  await page.evaluate(g => { __polymarket.PM.games.find(x => x.slug === g).stale = false; SB.render(); }, orig);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px after swaps: no horizontal scroll', over <= 0, `${over}px over`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ---------- fewer than 3 stand-ins: show what there is and say why ----------
  {
    const few = dogGames.filter(x => x.g.sport === 'nba').slice(0, 3);
    const { ctx, page, errors } = await open(formFor(few));
    const n = await page.locator('#upForm .leg').count(), notes = [];
    for (let i = 0; i < n; i++) { await page.locator('#upForm [data-up-swap]').nth(i).click(); const s = await subsShown(page, 'upForm'); notes.push({ rows: s.rows.length, note: s.note }); }
    check('sparse form file: the form card still has legs', n >= 2, String(n));
    check('fewer than 3 stand-ins: what there is is shown and the note says why', notes.length && notes.every(x => x.rows < 3 ? /^(Only \d+ stand-ins?|No stand-in): the board has \d+ other form-backed upsets? in this window/.test(x.note.trim()) && /form edge of 1 or more/.test(x.note) : !x.note), JSON.stringify(notes));
    check('sparse: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
