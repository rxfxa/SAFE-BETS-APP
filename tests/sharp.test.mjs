// Sharp Board (sharp.js): Polymarket's price vs the sportsbook consensus in the feed for every matched game. Gaps recomputed
// from the raw fixture quotes, strongest signals first, the honest note, filters, sorting, the {gid} param, the buttons, and the
// empty states. Fixtures pinned, clock 2026-11-23T12:00Z. The 23 Nov Polymarket snapshot has no gap of 3+ points on a market with
// $10k+ traded, so the test writes a copy with two (Arsenal +6, Como +4) and also checks the untouched snapshot.
// Run: node tests/sharp.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, check, done, FX, ROOT } from './lib/harness.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-'));
const rel = f => path.relative(path.join(ROOT, 'tests/fixtures'), f);   // pins are read from tests/fixtures/<name>
const put = (name, obj) => { const f = path.join(TMP, name); fs.writeFileSync(f, JSON.stringify(obj)); return rel(f); };

const D = JSON.parse(FX('data-2026-11-23.json'));
const PM = JSON.parse(FX('polymarket-2026-11-23b.json'));
function bump(gid, homeAbbr, awayAbbr, dH, dA, dD) {
  const g = D.games.find(x => x.id === gid), pg = PM.games.find(x => x.sport === g.sport && x.home.abbr === homeAbbr && x.away.abbr === awayAbbr && !x.stale);
  const b = g.prob, s = b.home + b.away + (b.draw || 0), q = (m, v) => ({ ...m, m: +v.toFixed(4), b: +(v - 0.005).toFixed(4), a: +(v + 0.005).toFixed(4) });
  pg.ml.home = q(pg.ml.home, b.home / s + dH); pg.ml.away = q(pg.ml.away, b.away / s + dA); if (pg.ml.draw) pg.ml.draw = q(pg.ml.draw, b.draw / s + dD);
  return { g, pg };
}
const ARS = bump('soccer-ARS-BVB-2026-11-24', 'ARS', 'BVB', 0.06, -0.04, -0.02);
const COM = bump('soccer-COM-AEK-2026-11-24', 'COM', 'AEK1', 0.04, -0.02, -0.02);   // Polymarket names AEK "AEK1": matched by name
const pmPin = put('polymarket.json', PM);
const byGid = new Map(D.games.map(g => [g.id, g])), bySlug = new Map(PM.games.map(x => [x.slug, x]));
const ready = () => window.__sharp && __sharp.state === 'done' && document.querySelector('.sh-root') && !/Loading Polymarket/.test(document.querySelector('.sh-root').innerText);

const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'sharp', pins: { 'polymarket.json': pmPin } });
await page.waitForFunction(ready, null, { timeout: 20000 });
await page.waitForTimeout(250);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('the board renders fast once Polymarket has loaded', rr < 800, `${Math.round(rr)} ms`);
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms', fr != null && fr < 1500, `${Math.round(fr)} ms`);
check('registered as "Sharp Board" in the sidebar', /^\s*Sharp Board\s*$/.test(await page.locator('#tabs [data-t="sharp"]').textContent()));

// ---------- the honest note ----------
const note = await page.locator('.sh-note').innerText();
check('a clear note at the top: not a betting split, no ticket / money data, a gap is not a guaranteed edge, different times',
  /Not a betting split/.test(note) && /no ticket or money percentages/.test(note) && /not a guaranteed edge/.test(note) && /different times/.test(note) && /Polymarket .*PT; the feed .*PT/.test(note), note.slice(0, 120));
const all = await page.locator('.sh-root').innerText();
check('no certainty words', !/\block\b|sure thing|can't lose|\bdue\b/i.test(all.replace(/not a sure thing/gi, '')) && !/guaranteed(?! edge)/i.test(all));

// ---------- matches and gaps (recomputed from the raw fixture quotes) ----------
const cards = await page.evaluate(() => [...document.querySelectorAll('.sh-card')].map(c => ({ gid: c.dataset.shGid, slug: c.dataset.shSlug, gap: +c.dataset.shGap, strong: c.dataset.shStrong === 'true', text: c.innerText.replace(/\s+/g, ' ') })));
check('Polymarket games matched to feed games (fixture slate)', cards.length >= 20, `${cards.length} cards`);
let verified = 0; const bad = [];
for (const c of cards) {
  const g = byGid.get(c.gid), pg = bySlug.get(c.slug); if (!g || !pg) { bad.push(c.gid + ' missing'); continue; }
  const same = pg.home.abbr === g.home.abbr && pg.away.abbr === g.away.abbr, swap = pg.home.abbr === g.away.abbr && pg.away.abbr === g.home.abbr;
  if (!same && !swap) continue;
  const H = swap ? pg.ml.away : pg.ml.home, A = swap ? pg.ml.home : pg.ml.away, Dr = g.sport === 'soccer' ? pg.ml.draw : null;
  const s = H.m + A.m + (Dr ? Dr.m : 0), b = g.prob, bs = b.home + b.away + (Dr ? b.draw : 0);
  const gap = Math.max(Math.abs(H.m / s - b.home / bs), Math.abs(A.m / s - b.away / bs), Dr ? Math.abs(Dr.m / s - b.draw / bs) : 0) * 100;
  if (Math.abs(gap - c.gap) > 0.051) bad.push(`${c.gid} ${c.gap} vs ${gap.toFixed(2)}`); else verified++;
}
check('gap = largest difference between Polymarket (mid, scaled to 100%) and the books, per side, in points', verified >= 10 && !bad.length, `${verified} verified; ${bad.slice(0, 4).join('; ')}`);
const order = cards.map(c => [c.strong ? 1 : 0, c.gap]);
check('strongest signals first, then by gap', order.every((x, i) => !i || order[i - 1][0] > x[0] || (order[i - 1][0] === x[0] && order[i - 1][1] >= x[1])) && cards[0].gid === ARS.g.id && cards[1].gid === COM.g.id && cards.filter(c => c.strong).length === 2,
  JSON.stringify(order.slice(0, 6)));
check('a strong signal needs a 3+ pt gap and $10k+ traded: the bigger but thin college gaps are not strong', cards.some(c => !c.strong && c.gap >= 3) && cards.filter(c => c.strong).every(c => c.gap >= 3));
check('the strong card is highlighted in our words with volume and liquidity', /Strong signal/i.test(cards[0].text) && /Polymarket 6\.0 pts higher on Arsenal FC/.test(cards[0].text) && /\$22\.4k traded on the moneyline/.test(cards[0].text) && /liquidity/.test(cards[0].text)
  && await page.locator('.sh-card.sh-strong').count() === 2, cards[0].text.slice(0, 260));
const hero = await page.evaluate(() => { const h = document.querySelector('[data-sh-hero]'); return h ? { gid: h.dataset.shHero, t: h.innerText.replace(/\s+/g, ' ') } : null; });
check('the top block shows the strongest signal as two split bars (Polymarket, Books) and its team', hero && hero.gid === ARS.g.id && /POLYMARKET/i.test(hero.t) && /BOOKS/i.test(hero.t) && /ARSENAL FC/i.test(hero.t) && /not a sure thing/.test(hero.t), hero && hero.t.slice(0, 200));
const split = await page.evaluate(id => [...document.querySelectorAll(`#sh-${CSS.escape(id)} .ui-split .pct`)].map(x => x.innerText.replace(/\s/g, '')), ARS.g.id);
const sp = (() => { const g = ARS.g, ml = ARS.pg.ml, s = ml.home.m + ml.away.m + ml.draw.m, b = g.prob, bs = b.home + b.away + b.draw, P = x => Math.round(x * 100) + '%'; return [P(ml.away.m / s), P(ml.home.m / s), P(b.away / bs), P(b.home / bs)]; })();
check('split rows: Polymarket away / home, then Books away / home', JSON.stringify(split) === JSON.stringify(sp), JSON.stringify(split) + ' vs ' + JSON.stringify(sp));
const ext = await page.evaluate(() => [...document.querySelectorAll('.sh-root a[href]')].map(a => [a.getAttribute('href'), a.rel, a.target]));
check('outside links are https Polymarket links that open safely', ext.length > 0 && ext.every(([h, r, t]) => /^https:\/\/polymarket\.com\//.test(h) && /noopener/.test(r) && t === '_blank'));
check('no horizontal page scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
const tap = await page.evaluate(() => [...document.querySelectorAll('.sh-root button, .sh-root a')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 40).map(b => b.innerText));
check('tap targets are 40px or taller', !tap.length, tap.slice(0, 5).join(','));

// ---------- filters and sorting ----------
const pillN = await page.evaluate(() => { const b = document.querySelector('[data-ui-pill="sh-sport|ncaaf"]'); return b ? +b.querySelector('.n').innerText : 0; });
await page.click('[data-ui-pill="sh-sport|ncaaf"]');
const nc = await page.evaluate(() => [...document.querySelectorAll('.sh-card')].map(c => c.dataset.shGid));
check('sport filter: College FB shows only its games, as many as the pill says', nc.length === pillN && nc.length > 0 && nc.every(g => g.startsWith('ncaaf-')) && !(await page.locator('[data-sh-hero]').count()) && /No strong signal right now/i.test(await page.locator('.sh-root').innerText()), `${nc.length} vs ${pillN}`);
await page.click('[data-ui-pill="sh-sport|all"]');
await page.click('[data-ui-seg="sh-show|signals"]');
const sig = await page.evaluate(() => [...document.querySelectorAll('.sh-card')].map(c => c.dataset.shStrong));
check('Signals shows only the strong signals', sig.length === 2 && sig.every(x => x === 'true'));
await page.click('[data-ui-seg="sh-show|all"]');
await page.click('[data-ui-seg="sh-sort|time"]');
const times = await page.evaluate(() => [...document.querySelectorAll('.sh-card')].map(c => SB.startMs(SB.gameById(c.dataset.shGid))));
check('sort by start time', times.every((t, i) => !i || times[i - 1] <= t));
await page.click('[data-ui-seg="sh-sort|vol"]');
const vols = await page.evaluate(() => { const R = new Map(__sharp.rows().map(c => [c.g.id, c.vol])); return [...document.querySelectorAll('.sh-card')].map(c => R.get(c.dataset.shGid)); });
check('sort by Polymarket volume', vols.every((v, i) => !i || vols[i - 1] >= v), vols.slice(0, 5).join(','));
await page.click('[data-ui-seg="sh-sort|gap"]');

// ---------- params and buttons ----------
await page.evaluate(id => SB.goTab('sharp', { gid: id }), COM.g.id);
await page.waitForTimeout(300);
const foc = await page.evaluate(id => { const c = document.getElementById('sh-' + id); return c && c.classList.contains('sh-focus') ? Math.round(c.getBoundingClientRect().top) : null; }, COM.g.id);
check('{gid} highlights that game and scrolls to it', foc != null && foc >= -2 && foc < 200, String(foc));
await page.click(`#sh-${COM.g.id} [data-sh-slate]`);
await page.waitForTimeout(300);
check('"Game card" opens the Games tab on that game', await page.evaluate(id => SB.tab === 'slate' && !!document.querySelector(`#sl-${CSS.escape(id)}.sl-focus`), COM.g.id));
await page.evaluate(() => SB.goTab('sharp', {}));
await page.waitForTimeout(200);
await page.click(`#sh-${ARS.g.id} [data-sh-ask]`);
await page.waitForTimeout(250);
const ask = await page.evaluate(() => ({ tab: SB.tab, v: (document.querySelector('#main textarea, #main input[type="text"]') || {}).value || '' }));
check('Ask opens Chat with the question about the gap', ask.tab === 'ask' && /Polymarket and the sportsbooks disagree/.test(ask.v), JSON.stringify(ask));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();

// ---------- the untouched snapshot: no strong signal, said plainly ----------
{
  const o = await open({ width: 1440, height: 900, tab: 'sharp' });
  await o.page.waitForFunction(ready, null, { timeout: 20000 });
  const t = await o.page.locator('.sh-root').innerText();
  check('real snapshot: "No strong signal right now" with the biggest gap named, cards still listed', /No strong signal right now/i.test(t) && /The biggest gap is \d+\.\d points/.test(t) && await o.page.locator('.sh-card').count() >= 20 && !(await o.page.locator('.sh-card.sh-strong').count()));
  check('1440px: no horizontal scroll, two or more cards per row', await o.page.evaluate(() => { const c = [...document.querySelectorAll('.sh-card')].slice(0, 2).map(x => x.getBoundingClientRect().top); return document.documentElement.scrollWidth <= 1440 && c.length === 2 && Math.abs(c[0] - c[1]) < 2; }));
  check('no page errors (1440px)', !o.errors.length, o.errors.join(' | '));
  await o.browser.close();
}
// ---------- no polymarket.json: an honest empty state ----------
{
  const o = await open({ width: 390, height: 844, tab: 'sharp', pins: { 'polymarket.json': null } });
  await o.page.waitForFunction(() => window.__sharp && __sharp.state === 'done' && /not available/.test((document.querySelector('.sh-root') || {}).innerText || ''), null, { timeout: 20000 });
  const t = await o.page.locator('.sh-root').innerText();
  check('polymarket.json missing: says the prices are not available, nothing to compare, no cards; the note stays', /Polymarket prices are not available right now/.test(t) && /nothing to compare/.test(t) && !(await o.page.locator('.sh-card').count()) && /Not a betting split/.test(t));
  await o.page.click('[data-sh-games]');
  check('the empty state offers the Games tab', await o.page.evaluate(() => SB.tab) === 'slate');
  check('no page errors without polymarket.json', !o.errors.length, o.errors.join(' | '));
  await o.browser.close();
}
fs.rmSync(TMP, { recursive: true, force: true });
await done(null);
