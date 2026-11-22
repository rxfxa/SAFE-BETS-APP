// QA regressions for the market modules (firsttd.js, upsets.js, lottos.js, plan.js, soccer.js, polymarket.js).
// Run: node tests/modules-qa.test.mjs
// Uses saved feeds (tests/fixtures/) with the page clock fixed, so the slate is the same on every run. UFC checks live in
// tests/ufc.test.mjs.
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
const FX = n => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
const D22 = FX('data-2026-11-22.json'), PM22 = FX('polymarket-2026-11-22.json'), D18 = FX('data-2026-11-18.json'), PM18 = FX('pm-2026-11-18.json');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
async function open({ tab, data = D22, pm = PM22, now = '2026-11-22T08:44:00Z', w = 390, ready = '1' }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/data.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: data }));
  await page.route('**/polymarket.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: pm }));
  await page.addInitScript(t => localStorage.setItem('fm2.tab', JSON.stringify(t)), tab);
  await page.goto(BASE);
  await page.waitForFunction(`window.SB && SB.firstRender && window.__polymarket && __polymarket.LOAD === 'done' && (${ready})`, null, { timeout: 60000 });
  await page.evaluate(() => SB.render()); await page.waitForTimeout(300);
  return { ctx, page, errors };
}

try {
  // ---------- First TD: game cards fit a phone ----------
  {
    const { ctx, page, errors } = await open({ tab: 'firsttd', ready: "document.querySelector('#main .ft-card') || /No upcoming NFL/.test(document.querySelector('#main').textContent)" });
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('#main .ft-card')].map(c => Math.round(c.getBoundingClientRect().right)),
      btns: [...document.querySelectorAll('#main .ft-card .yes')].filter(b => b.getBoundingClientRect().right > document.documentElement.clientWidth).length }));
    check('First TD 390px: game cards fit, no sideways scroll, no clipped price buttons', r.cards.length > 1 && r.sw <= 390 && r.cards.every(x => x <= 390) && r.btns === 0, JSON.stringify({ sw: r.sw, maxRight: Math.max(...r.cards), btns: r.btns }));
    check('First TD: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- Upset Parlays: underdogs only, honest small chances ----------
  {
    const { ctx, page, errors } = await open({ tab: 'upsets', ready: "!/Loading Polymarket/.test(document.querySelector('#main').textContent) && document.getElementById('upLegs')" });
    const dogs = () => page.evaluate(() => {
      const G = __polymarket.PM.games, bad = [], n = { up: 0 };
      for (const el of document.querySelectorAll('#upMain .leg, #upForm .leg')) {  // the upset cards (close-game edge legs can be slight favourites)
        const label = el.querySelector('b').textContent, m = /^(.*) to beat (.*)$/.exec(label); if (!m) continue; n.up++;
        const pg = G.find(g => (g.home.name === m[1] && g.away.name === m[2]) || (g.away.name === m[1] && g.home.name === m[2]));
        const me = pg.home.name === m[1] ? pg.ml.home : pg.ml.away, other = pg.home.name === m[1] ? pg.ml.away : pg.ml.home;
        if (!(me.m < other.m)) bad.push(`${label} ${me.m} vs ${other.m}`);
      }
      return { bad, n: n.up };
    });
    const setLegs = n => page.evaluate(n => { const r = document.getElementById('upLegs'); r.value = n; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, n);
    let d = await dogs();
    check('Upsets: every "to beat" leg is priced below its opponent (no 3-way favourites)', d.n > 0 && d.bad.length === 0, JSON.stringify(d));
    await page.click('#upMix'); await page.click('[data-up-sport="soccer"]'); await page.waitForTimeout(200);
    d = await dogs();
    check('Upsets: soccer only, mix off: still no favourites called underdogs', d.bad.length === 0, JSON.stringify(d));
    // the board has far more soccer favourites under 50% than real underdogs: none of them may slip in
    const fav = await page.evaluate(() => __polymarket.PM.games.filter(g => g.sport === 'soccer' && g.ml && g.ml.home && g.ml.away && g.ml.draw && Math.max(g.ml.home.m, g.ml.away.m) <= .5 && Math.abs(g.ml.home.m - g.ml.away.m) > .1).length);
    check('Upsets: the fixture has 3-way favourites under 50% to test against', fav > 0, String(fav));
    await page.click('[data-up-sport="all"]'); await page.click('#upMix'); await setLegs(8); await page.waitForTimeout(200);
    const head = await page.evaluate(() => { const h = document.querySelector('#upMain .pchead .hit'); const mids = [...document.querySelectorAll('#upMain .leg .legp')].map(x => parseFloat(x.textContent) / 100); return { h: h ? h.textContent : '', prod: mids.reduce((s, x) => s * x, 1), n: mids.length }; });
    const shown = /^<0\.01%/.test(head.h) ? 0.0001 : parseFloat(head.h) / 100;
    check('Upsets: an 8-leg slip never says "0% market chance"', !/^0% /.test(head.h) && /market chance/.test(head.h), head.h);
    check('Upsets: the chance shown agrees with the legs (within rounding)', head.n === 8 && shown > 0 && shown / head.prod > 0.5 && shown / head.prod < 2, `${head.h} vs product of shown legs ${(head.prod * 100).toPrecision(2)}%`);
    check('Upsets: each leg says its price is the price to buy', /¢ to buy/.test(await page.textContent('#main')));
    check('Upsets: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- Point Lottos: name suffixes ----------
  {
    const { ctx, page, errors } = await open({ tab: 'lottos', ready: "window.__lottos && __lottos.LOAD === 'done'" });
    const s = await page.evaluate(() => ['Jaren Jackson Jr.', 'Lauri Markkanen', 'Kenneth Walker III', 'Gary Trent Jr', 'Nene'].map(__lottos.surname).join('|'));
    check('Lottos: a missing player is named by surname with his suffix', s === 'Jackson Jr.|Markkanen|Walker III|Trent Jr|Nene', s);
    const t = await page.textContent('#main');
    check('Lottos: no "Jr. (out)" / "III (out)" without a surname', !/(With |, )(Jr|Sr|II|III|IV)\.? \(/.test(t), (t.match(/With [^·]{0,60}/) || [''])[0]);
    check('Lottos: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- Weekly Plan: ✖ swaps one leg; money adds up; honest "strong legs" count ----------
  {
    const { ctx, page, errors } = await open({ tab: 'plan', data: D18, pm: PM18, now: '2026-11-18T21:50:00Z', ready: "window.__plan && window.__lottos && __lottos.LOAD === 'done'" });
    const legs = t => page.evaluate(t => window.__plan.state.built[t].legs.map(window.__plan.legId), t);
    const rules = t => page.evaluate(t => { const P = window.__plan, S = P.state.built[t], byG = {}; for (const c of S.legs) (byG[c.pg.slug] = byG[c.pg.slug] || []).push(c);
      return Object.values(byG).every(a => { const pr = a.filter(c => c.kind === 'prop'); return a.length <= 3 && new Set(a.map(P.mktOf)).size === a.length && (!pr.length || new Set(pr.map(c => c.side)).size === 2); }); }, t);
    const drop = async (t, i) => { await (await page.$$(`.pl-card[data-tier="${t}"] [data-pl-drop]`))[i].click(); await page.waitForTimeout(300); };
    for (const t of ['safe', 'coin', 'lotto', 'b15']) {
      const before = await legs(t);
      // drop the last leg of the first game that has 3 legs (the QA case), else the third leg
      const i = await page.evaluate(t => { const L = window.__plan.state.built[t].legs, n = {}; for (const c of L) n[c.pg.slug] = (n[c.pg.slug] || 0) + 1; const k = L.findIndex(c => n[c.pg.slug] === 3); return k >= 0 ? k + 2 : 2; }, t);
      const gone = before[i];
      await drop(t, i);
      const after = await legs(t);
      check(`Plan ${t}: ✖ swaps out only that leg (the other ${before.length - 1} stay)`, after.length === before.length && !after.includes(gone) && before.filter(x => x !== gone).every(x => after.includes(x)), `${before.length} → ${after.length}, kept ${before.filter(x => x !== gone && after.includes(x)).length}`);
      check(`Plan ${t}: the slip rules still hold after ✖`, await rules(t));
    }
    // a prop leg in a props game: its team still gets a player
    const pi = await page.evaluate(() => window.__plan.state.built.safe.legs.findIndex(c => c.kind === 'prop'));
    if (pi >= 0) { await drop('safe', pi); check('Plan: ✖ on a player prop keeps a player from each team', await rules('safe')); }
    // other main slips don't change when one is edited, and never share legs
    const coinBefore = await legs('coin'); await drop('safe', 0);
    check('Plan: ✖ on SAFE leaves COIN FLIP alone', JSON.stringify(await legs('coin')) === JSON.stringify(coinBefore));
    check('Plan: main slips still share no legs', await page.evaluate(() => { const st = window.__plan.state, ids = ['safe', 'coin', 'lotto'].flatMap(k => st.built[k].legs.map(window.__plan.legId)); return new Set(ids).size === ids.length; }));
    await page.click('[data-pl-act="reset|safe"]'); await page.waitForTimeout(300);
    check('Plan: ↺ Start over after ✖ gives a full rules-following slip', (await legs('safe')).length === 9 && await rules('safe'));
    // weekly amounts are the budget split exactly; a month is 52/12 weeks
    for (const sp of ['balanced', 'safer', 'bolder']) {
      await page.click(`[data-pl-split="${sp}"]`); await page.waitForTimeout(150);
      const wk = await page.evaluate(() => [...document.querySelectorAll('.pl-stakes small')].map(s => parseFloat((/\$([\d.]+) a week/.exec(s.textContent) || [])[1])));
      check(`Plan ${sp}: weekly amounts add up to the $20 budget`, wk.length === 3 && Math.abs(wk.reduce((a, x) => a + x, 0) - 20) < 0.005, wk.join(' + '));
    }
    const head = await page.textContent('#main h2');
    check('Plan: a month is about 4.33 weeks ($20/week = about $87/month)', /about \$87\/month/.test(head) && /= about \$87 a month/.test(await page.textContent('.pl-set')), head);
    // "strong legs" only counts legs the builder can use (none at 98.5% or more, ≤ 3 a game)
    const st = await page.evaluate(() => { const P = window.__plan, { C, games } = P.candidates({ winH: 30, sport: 'all', type: 'mix', lean: 'both' });
      return Object.values(P.state.built).filter(S => S.strong != null).map(S => ({ strong: S.strong, raw: C.filter(c => c.ps >= S.need - 0.01).length, usable: C.filter(c => c.ps >= S.need - 0.01 && c.ps < 0.985).length, cap: 3 * games.length })); });
    check('Plan: the strong-legs count leaves out legs the builder never uses', st.length === 3 && st.every(x => x.strong <= x.usable && x.strong <= x.cap), JSON.stringify(st));
    const off = await page.evaluate(() => [...document.querySelectorAll('.pl-card')].map(c => c.querySelector('.why').textContent).filter(t => /legs would need about/.test(t)));
    check('Plan: off-target text never says the target is reachable without saying the builder missed it', off.every(t => /only \d+ legs that strong fit the slip rules|builder couldn't combine/.test(t)), JSON.stringify(off));
    check('Plan: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- Soccer Parlays: a league the feed doesn't carry ----------
  {
    const { ctx, page, errors } = await open({ tab: 'soccerparlays', ready: 'window.__soccer' });
    await page.click('[data-sp-lg="uel"]'); await page.waitForTimeout(200);
    const t = await page.textContent('#main .sp-empty');
    check('Soccer: an empty league says the feed lacks it and points to Polymarket\'s games', /No Europa League fixtures in the app's game feed right now/.test(t) && /Polymarket lists \d+ Europa League games? in the next 8 days/.test(t) && !/appear automatically/.test(t), t);
    check('Soccer: the link opens the Polymarket tab', await page.evaluate(() => { document.querySelector('#main .sp-empty [data-gotab="polymarket"]').click(); return !!document.querySelector('#tabs [data-t="polymarket"].on'); }));
    await page.evaluate(() => SB.goTab('soccerparlays'));
    const foot = await page.evaluate(() => [...document.querySelectorAll('#main .note')].map(n => n.textContent).find(x => /Leagues in the feed now/.test(x)) || '');
    check('Soccer: the footer lists only leagues with fixtures and names the empty ones', /No fixtures in the feed for Europa League, Eredivisie, Primeira Liga/.test(foot) && !/now:[^.]*Europa League/.test(foot), foot.slice(-220));
    check('Soccer: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- Polymarket parlays: the numbers on the card multiply out ----------
  {
    const { ctx, page, errors } = await open({ tab: 'polymarket', ready: "document.querySelector('#main .pm-card')" });
    const cards = await page.evaluate(() => [...document.querySelectorAll('#main .pm-card')].map(c => {
      const mk = [...c.querySelectorAll('.pm-why')].map(e => parseFloat((/Market ([\d.]+)%/.exec(e.textContent) || [])[1]) / 100);
      const buy = [...c.querySelectorAll('.pm-why')].map(e => parseFloat((/(\d+)¢ to buy/.exec(e.textContent) || [])[1]) / 100);
      const says = parseFloat(c.querySelector('.pm-two b').textContent) / 100, be = parseFloat((/hit ([\d.]+)% of the time to break even/.exec(c.textContent) || [])[1]) / 100;
      return { title: c.querySelector('.pctitle').textContent, mk: mk.reduce((s, x) => s * x, 1), buy: buy.reduce((s, x) => s * x, 1), says, be };
    }));
    check('Polymarket: "Market says" is the product of the leg market % shown (within rounding)', cards.length > 0 && cards.every(c => Math.abs(c.mk - c.says) < (c.says < 0.1 ? 0.0006 : 0.006)), JSON.stringify(cards.map(c => [c.title, +c.mk.toFixed(4), c.says])));
    check('Polymarket: the break-even at buy prices is the product of the leg buy prices', cards.every(c => Math.abs(c.buy - c.be) < 0.0006), JSON.stringify(cards.map(c => [+c.buy.toFixed(4), c.be])));
    check('Polymarket: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} catch (e) {
  check('suite ran to completion', false, e.stack || e.message);
}
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
