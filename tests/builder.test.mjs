// Parlay screen (builder.js, key 'builder'): the swipe deck, the generator and the slip panel. Fixtures pinned, clock 2026-11-23T12:00Z.
// Run: node tests/builder.test.mjs
import { open, check, done } from './lib/harness.mjs';

const INIT = { 'fm2.slip': [], 'fm2.saved': [], 'fm2.bld.mode': 'swipe', 'fm2.bld.n': 4, 'fm2.bld.risk': 'balanced', 'fm2.bld.props': false };
const { page, errors, browser } = await open({ width: 390, height: 844, tab: 'builder', init: INIT });
const cons = [];
page.on('console', m => { if (m.type() === 'error') cons.push(m.text()); });
await page.emulateMedia({ reducedMotion: 'reduce' });   // deck actions finish at once (the fly-out is checked separately below)
await page.waitForSelector('.bld-root .bld-top', { timeout: 20000 });
await page.waitForTimeout(200);

const S = () => page.evaluate(() => {
  const q = window.__builder.deck(), top = document.querySelector('.bld-root .bld-top');
  return { slip: SB.slip.map(l => l.gid + '|' + l.key), q, top: top && top.getAttribute('data-bld-id'), pos: (document.querySelector('.bld-root .bld-pos') || {}).textContent || '', n: window.__builder.list().length };
});
const blur = () => page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

// ---------- first render, header and the honest labels ----------
const fr = await page.evaluate(() => SB.firstRender && SB.firstRender.ms);
check('first render under 1,500 ms on the fixture slate', fr != null && fr < 1500, `${fr != null ? Math.round(fr) : '?'} ms`);
const rr = await page.evaluate(() => { const t = performance.now(); SB.render(); return performance.now() - t; });
check('a re-render stays fast', rr < 400, `${Math.round(rr)} ms`);
const txt = await page.locator('.bld-root').innerText();
check('header: kicker, display title with an accent, Swipe / Generate', /PARLAY BUILDER/i.test(txt) && await page.locator('.bld-root .ui-title .ac').count() === 1 &&
  await page.locator('[data-ui-seg="bld-mode|swipe"].on').count() === 1 && await page.locator('[data-ui-seg="bld-mode|gen"]').count() === 1);
check('honest lines: model estimates, fair odds not book prices, no prop prices, placed at your own book, no book connection',
  /model estimate/i.test(txt) && /not a book price/.test(txt) && /no sportsbook prop prices/i.test(txt) && /placed at your own book/i.test(txt) && /no book connection/i.test(txt), '');
check('no certainty words', !/guarantee|\block\b|sure thing|can't lose|\bdue\b/i.test(txt));

// ---------- the deck: the Insights board, sorted by model chance ----------
const D0 = await page.evaluate(() => {
  const day = SB.engine.dayOf(Date.now()), items = window.__insights.board(day).items, L = window.__builder.list();
  const ps = L.map(id => window.__builder.item(id).p);
  return { nItems: items.length, nList: L.length, sorted: ps.every((p, i) => !i || ps[i - 1] >= p), maxP: Math.max(...items.map(x => x.p)), firstP: ps[0], td: L.filter(id => id.includes('|TD:A:')).length, sports: [...new Set(L.map(id => window.__builder.item(id).sp))] };
});
check('deck = the Insights board for today (one line per player near 65%), highest model chance first',
  D0.nList === D0.nItems && D0.nList > 40 && D0.sorted && D0.firstP === D0.maxP, `${D0.nList} props, sports ${D0.sports}`);
check('deck includes NFL anytime touchdowns', D0.td > 0, `${D0.td} TD cards`);
let s = await S();
const topInfo = await page.evaluate(id => { const it = window.__builder.item(id); return { name: it.name, p: it.p, mkt: it.marketEm + ' ' + it.market, matchup: it.matchup, fair: SB.ui.fair(it.p), pays: SB.ui.pays(it.p) }; }, s.top);
const F = await page.evaluate(() => { const f = document.querySelector('.bld-root .bld-top .front'), q = x => (f.querySelector(x) || {}).textContent || ''; return { fn: q('.fn'), ln: q('.ln'), mu: q('.mu'), mkt: q('.mkt .t'), odds: q('.odds'), pay: q('.pay'), lbls: [...f.querySelectorAll('.st2 .ui-lbl')].map(x => x.textContent), strip: f.querySelectorAll('.bld-l5 .g > span').length, flip: q('[data-ui-flip]') }; });
check('top card: name, matchup, market, fair odds from the model chance, "$100 pays", hit rate and matchup',
  `${F.fn} ${F.ln}`.trim() === topInfo.name && F.mu.includes(topInfo.matchup) && F.mkt.trim() === topInfo.mkt && F.odds.trim() === topInfo.fair && F.pay.includes(`${topInfo.pays} at fair odds`) &&
  F.lbls.join(',') === 'Hit rate,Matchup' && /Flip for the full matchup/.test(F.flip), `${F.fn} ${F.ln} | ${F.mkt} | ${F.odds} | ${F.pay}`);
check('progress reads "1 of N"', s.pos.trim() === `1 of ${s.n}`, s.pos);
check('two cards wait behind the top one (inert, hidden from screen readers)', await page.evaluate(() => [...document.querySelectorAll('.bld-root .bld-under')].every(u => u.inert && u.getAttribute('aria-hidden') === 'true') && document.querySelectorAll('.bld-root .bld-under').length === 2));

// ---------- recent games on the cards: box scores counted by the UTC date rule, even before Insights has been opened ----------
// bugs: (1) insights.js indexes season.json only when its own tab renders, so a first visit here showed no hit rate on any TD card;
// (2) box-score logs are dated by the game's UTC start date, so cutting at the Los Angeles day dropped last night's game on a back-to-back.
await page.waitForFunction(() => ['ok', 'none'].includes(window.__builder.seasonState), null, { timeout: 30000 });
const HB = await page.evaluate(async () => {
  const E = SB.engine, d = await SB.season(), B = window.__builder, utc = ms => new Date(ms).toISOString().slice(0, 10), today = utc(Date.now());
  const fiOf = sp => { const fi = {}; d.sports[sp].fields.forEach((f, i) => { fi[f] = 3 + i; }); return fi; };
  const ids = B.list(), out = {};
  for (const id of ids) out[id] = B.hits(id).label;
  const lab = v => `L${v.length} · ${v.filter(x => x.h).length} of ${v.length}` + (v.length < 5 ? ' (few games)' : '');
  // one touchdown card by hand: rushing + receiving TDs in games dated before the game's UTC date (and not after today), last 10
  const X = d.sports.nfl, fi = fiOf('nfl');
  const td = ids.map(B.item).filter(it => it.td).find(it => X.players.filter(p => E.nameKey(p.n) === E.nameKey(it.name)).length === 1);
  let tdWant = null;
  if (td) { const P = X.players.find(p => E.nameKey(p.n) === E.nameKey(td.name)), cut = utc(SB.startMs(SB.gameById(td.gid)));
    tdWant = lab(P.log.filter(r => r[0] < cut && r[0] <= today).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(r => ({ h: (+r[fi.rtd] || 0) + (+r[fi.ctd] || 0) >= 1 })).slice(-10)); }
  // one NBA card on a back-to-back: season.json + nbalast4 rows by date, the game dated today (UTC) included
  const N = d.sports.nba, fn = fiOf('nba');
  const b2b = ids.map(B.item).find(it => it.sp === 'nba' && ['pts', 'reb', 'ast'].includes(it.stat) && N.players.filter(p => E.nameKey(p.n) === E.nameKey(it.name)).length === 1 &&
    (E.last4Of(it.team, it.name) || { rows: [] }).rows.some(r => !r.dnp && r.date === today && r[it.stat] != null));
  let nbaWant = null, nbaLast = null;
  if (b2b) { const P = N.players.find(p => E.nameKey(p.n) === E.nameKey(b2b.name)), cut = utc(SB.startMs(SB.gameById(b2b.gid))), by = new Map();
    for (const r of P.log) if (r[0] < cut && r[0] <= today && +r[fn.min] > 0) by.set(r[0], +r[fn[b2b.stat]]);   // 0-minute games are not games
    for (const r of E.last4Of(b2b.team, b2b.name).rows) if (!r.dnp && +r.min > 0 && r[b2b.stat] != null && r.date < cut && r.date <= today && !by.has(r.date)) by.set(r.date, +r[b2b.stat]);
    nbaWant = lab([...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => ({ h: v >= b2b.thr })).slice(-10)); nbaLast = B.log(b2b.id).vals.slice(-1)[0]; }
  // a game he was listed for but played 0 minutes in never counts: feed one into his box scores and look (and a 12-minute one that does)
  let zero = null;
  if (b2b) {
    const orig = E.last4Of, fake = min => (t, n) => { const L = orig(t, n); return L && E.nameKey(n) === E.nameKey(b2b.name) ? Object.assign({}, L, { rows: L.rows.concat([{ date: '2026-10-01', opp: 'TST', min, pts: 0, reb: 0, ast: 0 }]) }) : L; };
    const opps = () => B.log(b2b.id).vals.map(v => v.o);
    E.last4Of = fake(0); B.relog(); const z0 = opps().includes('TST');
    E.last4Of = fake(12); B.relog(); const z12 = opps().includes('TST');
    E.last4Of = orig; B.relog();
    zero = { z0, z12, back: !opps().includes('TST') };
  }
  return { zero, ins: window.__insights.seasonState, out, n: ids.length, tdWith: ids.filter(id => B.item(id).td && /^L\d/.test(out[id])).length, tdAll: ids.filter(id => B.item(id).td).length,
    td: td && { name: td.name, got: out[td.id], want: tdWant }, nba: b2b && { name: b2b.name + ' ' + b2b.thr + '+ ' + b2b.stat, got: out[b2b.id], want: nbaWant, last: nbaLast && nbaLast.d, today } };
});
check('first visit (Insights never opened): touchdown cards show his recent games from season.json', HB.ins === 'idle' && HB.tdAll > 0 && HB.tdWith === HB.tdAll, `${HB.tdWith} of ${HB.tdAll} TD cards`);
check('…a TD card\'s count matches a hand recount of his box scores', HB.td && HB.td.want && HB.td.got === HB.td.want, HB.td && `${HB.td.name}: ${HB.td.got} vs ${HB.td.want}`);
check('back-to-back: last night\'s game (dated today, UTC) counts, and the NBA card matches a hand recount', HB.nba && HB.nba.got === HB.nba.want && HB.nba.last === HB.nba.today, HB.nba && `${HB.nba.name}: ${HB.nba.got} vs ${HB.nba.want}, last game ${HB.nba.last}`);
check('NBA games he played 0 minutes in are not counted (a 12-minute one is)', HB.zero && !HB.zero.z0 && HB.zero.z12 && HB.zero.back, JSON.stringify(HB.zero));
await page.evaluate(() => SB.goTab('insights', {}));
await page.waitForFunction(() => window.__insights.seasonState === 'ok', null, { timeout: 30000 });
await page.evaluate(() => SB.goTab('builder', {}));
await page.waitForSelector('.bld-root .bld-top');
const HB3 = await page.evaluate(out => Object.keys(out).filter(id => { const h = window.__builder.hits(id); return !h || h.label !== out[id]; }).map(id => `${id}: ${out[id]} -> ${(window.__builder.hits(id) || {}).label}`), HB.out);
check('…and the cards\' hit rates stay the same once Insights has indexed the season', !HB3.length && HB.n > 0, HB3.slice(0, 3).join(' | ') || `${HB.n} cards`);

// ---------- add / pass with the buttons ----------
const t0 = s.top;
await page.click('[data-bld-act="add"]');
s = await S();
check('✓ Add to slip puts the top card\'s leg in the slip and moves on', s.slip.length === 1 && s.slip[0] === t0 && s.top !== t0 && s.pos.trim() === `2 of ${s.n}`, `${s.slip} · ${s.pos}`);
check('the slip panel lists the leg', await page.locator('.bld-root .bld-leg').count() === 1 && await page.locator(`.bld-root .bld-leg[data-bld-leg="${t0.replace(/"/g, '\\"')}"]`).count() === 1);
const t1 = s.top;
await page.click('[data-bld-act="pass"]');
s = await S();
check('✕ Pass leaves the slip alone and moves on', s.slip.length === 1 && s.top !== t1 && s.pos.trim() === `3 of ${s.n}`, s.pos);

// ---------- keyboard ----------
await blur();
const t2 = s.top;
await page.keyboard.press('ArrowRight');
s = await S();
check('→ adds the top card', s.slip.length === 2 && s.slip.includes(t2) && s.pos.trim() === `4 of ${s.n}`, s.pos);
const t3 = s.top;
await page.keyboard.press('ArrowLeft');
s = await S();
check('← passes', s.slip.length === 2 && !s.slip.includes(t3) && s.top !== t3 && s.pos.trim() === `5 of ${s.n}`, s.pos);

// ---------- the slip math ----------
const M = await page.evaluate(() => {
  const pr = SB.parlayProb(SB.slip), sum = document.querySelector('.bld-root .bld-sum');
  const legs = [...document.querySelectorAll('.bld-root .bld-leg')].map(r => { const [gid, ...k] = r.getAttribute('data-bld-leg').split('|'), key = k.join('|'), p = SB.p1(SB.gameById(gid), key); return { odds: r.querySelector('.bl-o b').textContent, pc: r.querySelector('.bl-o small').textContent, fair: SB.ui.fair(p), p }; });
  return { p: pr.p, indep: pr.indep, dp: +sum.getAttribute('data-p'), di: +sum.getAttribute('data-indep'), big: sum.querySelector('.bld-big').textContent, price: sum.querySelector('.bld-price span').textContent, n: sum.querySelector('.ui-lbl').textContent, ptxt: sum.querySelector('[data-bld-p]').textContent, itxt: sum.querySelector('[data-bld-indep]').textContent, fair: SB.ui.fair(pr.p), legs };
});
check('joint chance = SB.parlayProb(slip).p and "if unrelated" = its indep', Math.abs(M.dp - M.p) < 1e-12 && Math.abs(M.di - M.indep) < 1e-12 && M.ptxt === Math.round(M.p * 100) + '%' && M.itxt === Math.round(M.indep * 100) + '%', `${M.ptxt} / ${M.itxt}`);
check('fair odds of the joint chance and "$100 pays $X at fair odds"', M.big === M.fair && M.price === `$100 pays $${Math.round(100 / M.p)} at fair odds` && M.n === '2 legs', `${M.big} · ${M.price}`);
check('each leg shows its chance and fair odds', M.legs.length === 2 && M.legs.every(l => l.odds === l.fair && l.pc === Math.round(l.p * 100) + '%'), JSON.stringify(M.legs));

// ---------- undo ----------
await page.click('[data-bld-act="undo"]');
s = await S();
check('Undo last after a pass puts that card back on top, slip unchanged', s.top === t3 && s.slip.length === 2 && s.pos.trim() === `4 of ${s.n}`, s.pos);
await page.click('[data-bld-act="undo"]');
s = await S();
check('Undo again after an add takes the leg out of the slip and puts the card back on top', s.top === t2 && !s.slip.includes(t2) && s.slip.length === 1, `${s.top} · ${s.slip}`);

// ---------- legs already in the slip are skipped ----------
const q = s.q;
await page.evaluate(id => { const i = id.indexOf('|'); SB.toggleLeg(id.slice(0, i), id.slice(i + 1)); }, q[1]);
s = await S();
check('a leg added elsewhere leaves the deck', s.top === q[0] && !s.q.includes(q[1]) && s.slip.includes(q[1]));
await page.click('[data-bld-act="pass"]');
s = await S();
check('…so the next card after a pass skips it', s.top === q[2], s.top);

// ---------- drag / swipe ----------
const dragBy = async (dx, mid) => {
  await page.evaluate(() => document.querySelector('.bld-root .bld-top').scrollIntoView({ block: 'center' }));   // clear of the sticky top bar
  const b = await page.locator('.bld-root .bld-top').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + dx * i / 8, y + 2);
  const m = mid ? await mid() : null;
  await page.mouse.up();
  await page.waitForTimeout(50);
  return m;
};
const t4 = s.top, nSlip = s.slip.length;
const mid = await dragBy(200, () => page.evaluate(() => { const t = document.querySelector('.bld-root .bld-top'); return { dragging: t.classList.contains('dragging'), add: +getComputedStyle(t.querySelector('.bld-stamp.add')).opacity, pass: +getComputedStyle(t.querySelector('.bld-stamp.pass')).opacity, tr: t.style.transform }; }));
s = await S();
check('while dragging right the card follows and the ADD label shows', mid.dragging && mid.add > 0.9 && mid.pass === 0 && /translateX\(\d/.test(mid.tr), JSON.stringify(mid));
check('a drag past the threshold adds the leg', s.slip.length === nSlip + 1 && s.slip.includes(t4) && s.top !== t4);
const t5 = s.top;
const mid2 = await dragBy(-200, () => page.evaluate(() => +getComputedStyle(document.querySelector('.bld-root .bld-top .bld-stamp.pass')).opacity));
s = await S();
check('a drag left shows PASS and passes', mid2 > 0.9 && s.top !== t5 && !s.slip.includes(t5) && s.slip.length === nSlip + 1);
const t6 = s.top;
await dragBy(35);
s = await S();
const snap = await page.evaluate(() => { const t = document.querySelector('.bld-root .bld-top'); return { tr: t.style.transform, flip: t.querySelector('.ui-prop').classList.contains('flip') }; });
check('a short drag snaps back: same card, no flip, slip unchanged', s.top === t6 && s.slip.length === nSlip + 1 && snap.tr === '' && !snap.flip, JSON.stringify(snap));
await page.click('.bld-root .bld-top .front [data-ui-flip]');
await page.waitForTimeout(120);
const fl = await page.evaluate(() => { const c = document.querySelector('.bld-root .bld-top .ui-prop'); return { flip: c.classList.contains('flip'), rows: [...c.querySelectorAll('.back .rows span')].map(x => x.textContent) }; });
check('a plain tap on "Flip for the full matchup" still flips the card (back: team points, blowout risk, injury report)', fl.flip && ['Team points', 'Blowout risk', 'Injury report'].every(k => fl.rows.includes(k)), fl.rows.join(','));
await page.click('.bld-root .bld-top .back [data-ui-flip]');

// ---------- the fly-out (motion allowed) ----------
await page.emulateMedia({ reducedMotion: 'no-preference' });
const t7 = (await S()).top;
await page.click('[data-bld-act="add"]');
const during = await page.evaluate(() => { const t = document.querySelector('.bld-root .bld-top'); return t ? { id: t.getAttribute('data-bld-id'), tr: t.style.transform } : null; });
await page.waitForTimeout(400);
s = await S();
check('with motion on, the card flies out, then the next one is on top', during && during.id === t7 && /translateX\(130%\)/.test(during.tr) && s.top !== t7 && s.slip.includes(t7), JSON.stringify(during));
await blur();
const before = (await S()).slip.length;
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
await page.waitForTimeout(400);
s = await S();
check('two quick key presses are both counted (the first fly-out finishes early)', s.slip.length === before + 1, `${before} -> ${s.slip.length}`);
await page.emulateMedia({ reducedMotion: 'reduce' });

// ---------- remove from the slip panel ----------
const nb = (await S()).slip.length;
await page.click('.bld-root .bld-leg:first-child .bl-x');
check('✕ on a slip leg removes it', (await S()).slip.length === nb - 1);

// ---------- legs that help / work against each other ----------
const H = await page.evaluate(() => {
  const E = SB.engine, A = { gid: 'nba-CHA-MEM-2026-11-24', key: 'P:naz-reid-pts~nba-CHA-MEM-2026-11-24:15' }, B = { gid: 'nba-CHA-MEM-2026-11-24', key: 'P:naz-reid-reb~nba-CHA-MEM-2026-11-24:7' };
  const C = { gid: 'ncaaf-EMU-KENT-2026-11-25', key: 'P:amareon-blue-ryd~ncaaf-EMU-KENT-2026-11-25:40' }, Dd = { gid: 'ncaaf-EMU-KENT-2026-11-25', key: 'A' };
  SB.setSlip([A, B, C, Dd]);
  const r1 = E.legRho(E.legMeta(A), E.legMeta(B), A.gid), r2 = E.legRho(E.legMeta(C), E.legMeta(Dd), C.gid);
  const box = document.querySelector('.bld-root .bld-links'), t = box ? box.innerText : '';
  return { ok: SB.slip.length === 4, r1: r1 && r1.r, r2: r2 && r2.r, w1: r1 && E.helpWhy(r1, A, B), w2: r2 && E.helpWhy(r2, C, Dd), t, good: box ? box.querySelectorAll('li.good').length : 0, bad: box ? box.querySelectorAll('li.bad').length : 0 };
});
check('legs that help each other: listed with the research\'s own words (engine.helpWhy)', H.ok && H.r1 > 0.1 && H.good === 1 && /Legs that help each other/i.test(H.t) && H.t.includes(H.w1), `${H.r1} ${H.w1}`);
check('legs that work against each other: listed too', H.r2 < -0.1 && H.bad === 1 && /Legs that work against each other/i.test(H.t) && H.t.includes(H.w2), `${H.r2} ${H.w2}`);
const pj = await page.evaluate(() => { const pr = SB.parlayProb(SB.slip); return { p: pr.p, d: +document.querySelector('.bld-root .bld-sum').getAttribute('data-p') }; });
check('same-game legs: the joint chance still equals SB.parlayProb', Math.abs(pj.p - pj.d) < 1e-12, `${pj.p}`);

// ---------- copy slip ----------
await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copied = t; return Promise.resolve(); } } }); });
await page.click('[data-bld-copy]');
await page.waitForTimeout(80);
const C1 = await page.evaluate(() => { const pr = SB.parlayProb(SB.slip); return { t: window.__copied, labels: SB.slip.map(l => SB.legLabel(l)), fairs: SB.slip.map(l => SB.ui.fair(SB.p1(SB.gameById(l.gid), l.key))), fair: SB.ui.fair(pr.p), pays: SB.ui.pays(pr.p), toast: document.getElementById('toast').textContent }; });
check('Copy slip: every leg with its fair odds, the joint chance, fair odds and payout',
  C1.t && /^Safe Bets slip \(4 legs\)/.test(C1.t) && C1.labels.every((l, i) => C1.t.includes(l) && C1.t.includes(`fair odds ${C1.fairs[i]}`)) && C1.t.includes(`Together: model`) && C1.t.includes(`fair odds ${C1.fair}`) && C1.t.includes(`${C1.pays} at fair odds`) && /Copied/.test(C1.toast),
  (C1.t || '').split('\n').slice(-2).join(' / '));
check('copied text stays honest (model estimates, your own book)', /Model estimates, not book prices/.test(C1.t) && /your own book/.test(C1.t));
await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }); });
await page.click('[data-bld-copy]');
await page.waitForTimeout(120);
const C2 = await page.evaluate(() => { const ta = document.querySelector('.bld-root [data-bld-copytxt]'); return { ta: ta ? ta.value : null, toast: document.getElementById('toast').textContent, slipTxt: window.__builder.slipText() }; });
check('a blocked clipboard: says so and shows the slip text to copy by hand', C2.ta === C2.slipTxt && /Couldn't copy/.test(C2.toast), C2.toast);

// ---------- save, check ----------
const sv = await page.evaluate(() => { const n0 = SB.savedParlays.length; document.querySelector('[data-bld-save]').click(); const n1 = SB.savedParlays.length, last = SB.savedParlays[n1 - 1], pr = SB.parlayProb(SB.slip);
  document.querySelector('[data-bld-save]').click(); return { n0, n1, n2: SB.savedParlays.length, p: last && last.p, want: pr.p, legs: last && last.legs.map(l => l.gid + '|' + l.key).join(','), slip: SB.slip.map(l => l.gid + '|' + l.key).join(','), toast: document.getElementById('toast').textContent }; });
check('Save to My Parlays saves the slip at its joint chance (once)', sv.n1 === sv.n0 + 1 && Math.abs(sv.p - sv.want) < 1e-12 && sv.legs === sv.slip && sv.n2 === sv.n1 && /Already in My Parlays/.test(sv.toast), JSON.stringify({ n0: sv.n0, n1: sv.n1, n2: sv.n2 }));
await page.click('[data-bld-check]');
check('Check slip opens Slip Check', await page.evaluate(() => SB.tab) === 'slipcheck');
await page.evaluate(() => SB.goTab('builder', {}));
await page.waitForSelector('.bld-root');

// ---------- the generator ----------
await page.click('[data-ui-seg="bld-mode|gen"]');
check('Generate: legs stepper, risk Safer / Balanced / Long shot, Players only, Build',
  await page.locator('[data-bld-nv]').innerText() === '4' && await page.locator('[data-ui-seg^="bld-risk|"]').count() === 3 && await page.locator('[data-bld-props][role="switch"]').count() === 1 && await page.locator('[data-bld-build]').count() === 1);
const gp = await page.evaluate(() => [...document.querySelectorAll('.bld-root [data-ui-pill^="bld-sport|"]')].map(b => b.getAttribute('data-ui-pill').split('|')[1]));
check('sport pills: All + each sport with legs to build from', gp[0] === 'all' && gp.includes('nba') && gp.includes('nfl'), gp.join(','));
await page.click('[data-bld-n="-1"]');
check('stepper: − makes 3', await page.locator('[data-bld-nv]').innerText() === '3');
for (let i = 0; i < 9; i++) await page.click('[data-bld-n="1"]').catch(() => {});
check('stepper stops at 10', await page.locator('[data-bld-nv]').innerText() === '10' && await page.locator('[data-bld-n="1"]').isDisabled());
for (let i = 0; i < 9; i++) await page.click('[data-bld-n="-1"]').catch(() => {});
check('stepper stops at 2', await page.locator('[data-bld-nv]').innerText() === '2' && await page.locator('[data-bld-n="-1"]').isDisabled());
await page.click('[data-bld-n="1"]');
await page.click('[data-ui-seg="bld-risk|safer"]');
await page.click('[data-bld-build]');
const G = () => page.evaluate(() => { const st = window.__builder.state, T = st.T; return { o: st.opts, n: T ? T.legs.length : 0, ps: T ? T.legs.map(l => l.p) : [], keys: T ? T.legs.map(l => l.key) : [], sports: T ? T.legs.map(l => l.sport) : [], cardLegs: document.querySelectorAll('.bld-root .bld-ticket .leg').length, p: T && T.p, pp: T ? SB.parlayProb(T.legs).p : null, card: !!document.querySelector('.bld-root .bld-ticket [data-sim5]') }; });
let g = await G();
const sameOpts = (o, w) => Object.keys(w).every(k => JSON.stringify(o[k]) === JSON.stringify(w[k])) && (w.target === undefined ? !('target' in o) : true);
check('Safer → buildTicket {minP .75} (no target), 3 legs, every leg 75%+',
  sameOpts(g.o, { n: 3, minP: 0.75, propsOnly: false, perPlayer: 1, perGame: 2, sports: ['nba', 'nfl', 'ncaaf', 'nhl', 'soccer'] }) && !('target' in g.o) && g.n === 3 && g.cardLegs === 3 && g.ps.every(p => p >= 0.75), `${JSON.stringify(g.o)} ${g.ps.map(p => p.toFixed(2))}`);
check('the result is the app\'s parlay card (swap legs, 500,000 runs) at the joint chance', g.card && await page.locator('.bld-root .bld-ticket [data-sub]').count() === 3 && Math.abs(g.p - g.pp) < 1e-9);
await page.click('[data-ui-seg="bld-risk|balanced"]');
g = await G();
check('Balanced → {minP .55, target .62}, rebuilt at once', g.o.minP === 0.55 && g.o.target === 0.62 && g.n === 3 && g.ps.every(p => p >= 0.55), g.ps.map(p => p.toFixed(2)).join(','));
await page.click('[data-ui-seg="bld-risk|long"]');
g = await G();
check('Long shot → {minP .30, target .45}', g.o.minP === 0.3 && g.o.target === 0.45 && g.n === 3 && g.ps.every(p => p >= 0.3) && Math.min(...g.ps.map(p => Math.abs(p - 0.45))) < 0.1, g.ps.map(p => p.toFixed(2)).join(','));
await page.click('[data-ui-seg="bld-risk|balanced"]');
await page.click('[data-bld-props]');
g = await G();
check('Players only → propsOnly: every leg a player prop', g.o.propsOnly === true && g.n === 3 && g.keys.every(k => /^P:/.test(k)) && await page.locator('[data-bld-props][aria-checked="true"]').count() === 1, g.keys.join(','));
await page.click('[data-ui-pill="bld-sport|nba"]');
g = await G();
check('a sport pill → that sport only, 3 legs per game allowed', JSON.stringify(g.o.sports) === '["nba"]' && g.o.perGame === 3 && g.n === 3 && g.sports.every(x => x === 'nba'), g.sports.join(','));
const seed0 = await page.evaluate(() => window.__builder.state.seed);
await page.click('[data-bld-again]');
check('Build another changes the seed', await page.evaluate(() => window.__builder.state.seed) === seed0 + 1);
await page.click('[data-ui-pill="bld-sport|all"]'); await page.click('[data-bld-props]');
for (let i = 0; i < 7; i++) await page.click('[data-bld-n="1"]');
g = await G();
check('10 legs across all sports', g.o.n === 10 && g.n === 10 && g.cardLegs === 10, `${g.n}`);
for (let i = 0; i < 6; i++) await page.click('[data-bld-n="-1"]');

// ---------- use this slip (after a swap) ----------
await page.click('.bld-root .bld-ticket [data-sub$="|0"]');
await page.waitForSelector('#sheet.on [data-subuse]');
await page.click('#sheet.on [data-subuse]');
await page.waitForTimeout(150);
const U1 = await page.evaluate(() => { const id = window.__builder.state.cardId, C = window.__fm2.autoCache[id]; return { card: C.legs.map(l => l.gid + '|' + l.key), base: window.__builder.state.T.legs.map(l => l.gid + '|' + l.key), prev: SB.slip.length }; });
await page.click('[data-bld-use]');
await page.waitForTimeout(100);
const U2 = await page.evaluate(() => ({ slip: SB.slip.map(l => l.gid + '|' + l.key), toast: document.getElementById('toast').textContent, panel: document.querySelectorAll('.bld-root .bld-leg').length }));
check('Use this slip replaces the slip with the card\'s legs, swaps included', JSON.stringify(U2.slip) === JSON.stringify(U1.card) && U1.card[0] !== U1.base[0] && U2.panel === U1.card.length, `${U2.slip.length} legs`);
check('…and the app offers Undo for the old slip', U1.prev > 0 && /Undo/.test(U2.toast), U2.toast);

// ---------- params, day, end of the deck ----------
await page.evaluate(() => SB.goTab('builder', { sport: 'nfl', mode: 'swipe' }));
await page.waitForSelector('.bld-root .bld-top');
const P = await page.evaluate(() => ({ sport: window.__builder.state.sport, on: (document.querySelector('.bld-root .ui-pill.on') || {}).getAttribute && document.querySelector('.bld-root .ui-pill.on').getAttribute('data-ui-pill'), list: window.__builder.list().map(id => window.__builder.item(id).sp) }));
check('params {sport: "nfl"} set the sport: NFL pill on, NFL cards only', P.sport === 'nfl' && P.on === 'bld-sport|nfl' && P.list.length > 0 && P.list.every(x => x === 'nfl'), `${P.list.length} cards`);
await page.evaluate(() => SB.setSlip([]));
await blur();
for (let i = 0; i < 80 && await page.locator('.bld-root .bld-top').count(); i++) await page.keyboard.press('ArrowLeft');
const endTxt = await page.locator('.bld-root .bld-main').innerText();
check('end of the deck: says so, with Start over and Generate', /That's the deck: all \d+ props/.test(endTxt) && await page.locator('[data-bld-restart]').count() === 1 && await page.locator('.bld-main [data-ui-seg="bld-mode|gen"]').count() === 1, endTxt.split('\n')[0]);
await page.click('[data-bld-restart]');
s = await S();
check('Start over: back to card 1', s.pos.trim() === `1 of ${s.n}`, s.pos);
await page.selectOption('.bld-root select[data-ui-select="bld-day"]', 'tomorrow');
const tm = await page.evaluate(() => { const B = window.__insights.board(SB.engine.nextDay(SB.engine.dayOf(Date.now()))).items.filter(x => x.sp === 'nfl').map(x => x.id).sort(); const L = window.__builder.list().slice().sort();
  return { day: window.__builder.state.day, same: JSON.stringify(B) === JSON.stringify(L), n: L.length, pos: (document.querySelector('.bld-root .bld-pos') || document.querySelector('.bld-root .ui-empty') || {}).textContent }; });
check('Day: Tomorrow switches the deck to tomorrow\'s board', tm.day === 'tomorrow' && tm.same, `${tm.n} cards · ${tm.pos}`);
await page.selectOption('.bld-root select[data-ui-select="bld-day"]', 'today');
await page.click('[data-ui-pill="bld-sport|all"]');

// ---------- phone layout ----------
for (const mode of ['swipe', 'gen']) {
  await page.click(`[data-ui-seg="bld-mode|${mode}"]`);
  const L = await page.evaluate(() => {
    const sw = document.documentElement.scrollWidth, small = [];
    for (const b of document.querySelectorAll('.bld-root button, .bld-root .ui-sel')) {
      if (b.closest('.bld-ticket') || b.closest('[inert]') || b.closest('.back')) continue;
      const r = b.getBoundingClientRect(); if (!r.width) continue;
      if (r.height < 40 || r.width < 40) small.push((b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 24) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const sl = document.querySelector('.bld-root .bld-slip').getBoundingClientRect(), mn = document.querySelector('.bld-root .bld-main').getBoundingClientRect();
    const bar = document.getElementById('slipbar');
    return { sw, small, below: sl.top >= mn.bottom - 1, bar: !bar.classList.contains('on') || getComputedStyle(bar).display !== 'none' };
  });
  check(`390px ${mode}: no horizontal scroll, tap targets 40px+, slip panel below (the app's slip bar still shows)`, L.sw <= 390 && !L.small.length && L.below && L.bar, `${L.sw}px ${L.small.join('; ')}`);
}

// ---------- the deck without insights.js (its own fallback board) ----------
await page.click('[data-ui-seg="bld-mode|swipe"]');
const FBk = await page.evaluate(() => { window.__insSaved = window.__insights; window.__insights = undefined; SB.render();
  const L = window.__builder.list(), top = document.querySelector('.bld-root .bld-top'); const r = { n: L.length, top: !!top, nba: L.filter(id => window.__builder.item(id).sp === 'nba').length, txt: document.querySelector('.bld-root .bld-main').innerText };
  window.__insights = window.__insSaved; SB.render(); return r; });
check('without insights.js the deck still deals player props (its own board at the line nearest 65%)', FBk.top && FBk.n > 40 && FBk.nba > 0 && !/could not load/i.test(FBk.txt), `${FBk.n} cards`);

// ---------- a game kicks off while the screen is open ----------
const KO = await page.evaluate(() => {
  const L = window.__builder.list().map(id => window.__builder.item(id)), first = L.slice().sort((a, b) => a.start - b.start)[0];
  SB.setSlip([{ gid: first.gid, key: first.key }, ...L.filter(x => x.gid !== first.gid).slice(0, 2).map(x => ({ gid: x.gid, key: x.key }))]);
  return { gid: first.gid, start: first.start, n: L.length, kicked: L.filter(x => x.start <= first.start).length };
});
await page.clock.setFixedTime(new Date(KO.start + 60000));
await page.evaluate(() => SB.render());
const KO2 = await page.evaluate(gid => {
  const L = window.__builder.list().map(id => window.__builder.item(id)), off = document.querySelectorAll('.bld-root .bld-leg.off'), sum = document.querySelector('.bld-root .bld-sum');
  const live = SB.slip.filter(l => l.gid !== gid), pr = SB.parlayProb(live);
  return { n: L.length, any: L.some(x => x.gid === gid), off: off.length, offTxt: off[0] ? off[0].innerText : '', dp: sum ? +sum.getAttribute('data-p') : null, p: pr.p, lbl: sum ? sum.querySelector('.ui-lbl').textContent : '' };
}, KO.gid);
check('a started game leaves the deck', !KO2.any && KO2.n === KO.n - KO.kicked, `${KO.n} -> ${KO2.n}`);
check('…and its slip leg is marked started and left out of the joint chance', KO2.off === 1 && /Started/.test(KO2.offTxt) && Math.abs(KO2.dp - KO2.p) < 1e-12 && KO2.lbl === '2 legs', `${KO2.lbl} ${KO2.dp}`);
await page.clock.setFixedTime(new Date('2026-11-23T12:00:00Z'));
await page.evaluate(() => SB.setSlip([]));

check('no page errors', errors.length === 0, errors.join(' | '));
check('no console errors', cons.length === 0, cons.join(' | '));
check('never fell back to "could not load"', !/could not load/i.test(await page.locator('main').innerText()));
await browser.close();

// ---------- wide screens: the slip sits beside the deck and stays in view ----------
{
  // season.json missing here, and the screen opened cold from another tab: time the first render inside the page
  const { page, errors, browser } = await open({ width: 1440, height: 900, tab: 'slipcheck', init: INIT, pins: { 'season.json': null } });
  await page.waitForTimeout(300);
  const cold = await page.evaluate(() => { const t = performance.now(); SB.goTab('builder', {}); return { ms: performance.now() - t, top: !!document.querySelector('.bld-root .bld-top') }; });
  check('cold first render (SB.goTab from another tab, Insights never shown) under 1,500 ms', cold.top && cold.ms < 1500, `${Math.round(cold.ms)} ms`);
  await page.waitForSelector('.bld-root .bld-top');
  await page.waitForFunction(() => window.__builder.seasonState === 'none', null, { timeout: 20000 });
  const SN = await page.evaluate(() => { const ids = window.__builder.list(), td = ids.filter(id => window.__builder.item(id).td); SB.render();
    return { n: ids.length, td: td.length, lbl: td.map(id => window.__builder.hits(id).label), txt: document.querySelector('.bld-root').innerText }; });
  check('season.json missing: the deck still renders; TD cards say no recent games instead of inventing a hit rate', SN.n > 40 && SN.td > 0 && SN.lbl.every(l => l === 'No recent games logged') && !/could not load/i.test(SN.txt), `${SN.n} cards, ${SN.td} TD`);
  await page.evaluate(() => { const q = window.__builder.deck().slice(0, 3); SB.setSlip(q.map(id => { const i = id.indexOf('|'); return { gid: id.slice(0, i), key: id.slice(i + 1) }; })); });
  const W = await page.evaluate(() => { const sl = document.querySelector('.bld-root .bld-slip'), st = document.querySelector('.bld-root .bld-stack'), a = sl.getBoundingClientRect(), b = st.getBoundingClientRect();
    return { beside: a.left >= b.right && Math.abs(a.top - document.querySelector('.bld-root .bld-main').getBoundingClientRect().top) < 30, pos: getComputedStyle(sl).position, legs: sl.querySelectorAll('.bld-leg').length, sw: document.documentElement.scrollWidth }; });
  check('1440px: the slip panel sits beside the deck, sticky, with the legs', W.beside && W.pos === 'sticky' && W.legs === 3 && W.sw <= 1440, JSON.stringify(W));
  // bug: the app's floating slip bar sat over the bottom of the sticky panel (its book note and buttons)
  const bar = () => page.evaluate(() => { const b = document.getElementById('slipbar'); return { on: b.classList.contains('on'), d: getComputedStyle(b).display }; });
  const b1 = await bar();
  await page.evaluate(() => SB.goTab('insights', {})); await page.waitForTimeout(50);
  const b2 = await bar();
  await page.evaluate(() => SB.goTab('builder', {})); await page.waitForSelector('.bld-root .bld-top');
  check('…the floating slip bar steps aside while the panel is beside the deck, and comes back on other screens', b1.on && b1.d === 'none' && b2.on && b2.d !== 'none' && (await bar()).d === 'none', JSON.stringify([b1, b2]));
  // a 10-leg card makes the left column long: the panel should ride along beside it
  await page.click('[data-ui-seg="bld-mode|gen"]');
  for (let i = 0; i < 6; i++) await page.click('[data-bld-n="1"]');
  await page.click('[data-bld-build]');
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(80);
  const top = await page.evaluate(() => document.querySelector('.bld-root .bld-slip').getBoundingClientRect().top);
  check('…and stays in view when the page scrolls', top >= 0 && top <= 40, `${Math.round(top)}px`);
  check('1440px (season.json missing): no page errors', errors.length === 0, errors.join(' | '));
  await done(browser);
}
