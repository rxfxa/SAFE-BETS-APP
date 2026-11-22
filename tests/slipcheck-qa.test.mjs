// Slip Check QA regressions: stale props lines, finished games, legs missing a line, unmatched legs, model-priced notes,
// the simulation's labels and links, recommended-change chances, refresh/delete keeping the analysis honest, builder prices.
// Run: node tests/slipcheck-qa.test.mjs. Uses tests/fixtures/data-2026-11-22.json, tests/fixtures/polymarket-2026-11-22.json
// (49ers-Vikings is unpriced in the feed, priced on Polymarket) and the repo's playerstats.json.
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
const DATA = fs.readFileSync(path.join(ROOT, 'tests/fixtures/data-2026-11-22.json'), 'utf8');
const PM = fs.readFileSync(path.join(ROOT, 'tests/fixtures/polymarket-2026-11-22.json'), 'utf8');
const STATS = fs.readFileSync(path.join(ROOT, 'playerstats.json'), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
const json = body => r => r.fulfill({ status: 200, contentType: 'application/json', body });
await page.route('**/data.json', json(DATA));
await page.route('**/polymarket.json', json(PM));
await page.route('**/playerstats.json', json(STATS));
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.SB && SB.firstRender && window.__slipcheck, null, { timeout: 60000 });
  await page.waitForFunction(() => {  // playerstats.json and polymarket.json loaded
    const g = SB.gameById('nfl-SF-MIN-2026-11-23'); if (!g) return false;
    const v = __slipcheck.playerProb({ event: 'Vikings @ 49ers', market: 'passing_yards', pick: 'Brock Purdy', side: 'over', line: '230.5', odds: '' }, g, 'O', 230.5);
    return typeof v === 'number' && window.__polymarket && window.__polymarket.PM && (window.__polymarket.PM.games || []).length > 0;
  }, null, { timeout: 15000 }).catch(() => {});

  // 1 · a props.json line for a game that left the feed: no crash, the leg isn't priced from that old line
  const stale = await page.evaluate(() => {
    const L = (event, market, pick, side = '', line = '', odds = '') => ({ event, market, pick, side, line, odds, sport: '', sel: '' });
    SB.DATA.players.push({ id: 'qa-stale-reb', name: 'Qatest Staleman', team: 'BOS', stat: 'reb', gid: 'nba-BOS-XXX-2026-11-01', status: 'active', mean: 8, line: 7.5 },
      { id: 'qa-stale-pts', name: 'Qatest Staleman', team: 'BOS', stat: 'pts', gid: 'nba-BOS-XXX-2026-11-01', status: 'active', mean: 20, line: 19.5 });
    const out = [];
    for (const l of [L('', 'player_rebounds', 'Qatest Staleman', 'Over', '7.5', '-110'), L('', 'player_points', 'Qatest Staleman', 'Over', '19.5', '')]) {
      try { const r = __slipcheck.matchLeg(l); out.push({ st: r.status, key: r.key, why: r.why }); } catch (e) { out.push({ err: e.message }); }
    }
    let full = null; try { const A = __slipcheck.analyze({ legs: [L('', 'player_rebounds', 'Qatest Staleman', 'Over', '7.5', ''), L('Boston Celtics @ Los Angeles Lakers', 'moneyline', 'Lakers', '', '', '-150')], totalOdds: '' }); full = A.rows.map(r => r.status); } catch (e) { full = 'ERR ' + e.message; }
    SB.DATA.players = SB.DATA.players.filter(p => !/^qa-stale/.test(p.id));
    return { out, full };
  }).catch(e => ({ err: e.message }));
  check('a stale props line never throws', stale.out && stale.out.every(x => !x.err), JSON.stringify(stale));
  check('a stale props line is not priced from the old game', stale.out && stale.out.every(x => x.st !== 'matched' || !/qa-stale/.test(x.key || '')), JSON.stringify(stale.out));
  check('a slip with a stale props leg still analyzes', Array.isArray(stale.full), JSON.stringify(stale.full));

  const r = await page.evaluate(() => {
    const L = (event, market, pick, side = '', line = '', odds = '') => ({ event, market, pick, side, line, odds, sport: '', sel: '' });
    const S = __slipcheck;
    // 2 · finished games: one on the board (last night) and one off it (two days ago); a total with no line; an unknown game
    const fin = S.analyze({ legs: [
      L('Sacramento Kings @ Boston Celtics', 'moneyline', 'Celtics', '', '', '-150'),
      L('Indianapolis Colts @ Houston Texans', 'moneyline', 'Texans', '', '', '-150'),
      L('Carolina Hurricanes @ New York Rangers', 'total', 'Over', 'Over', '', '100'),
      L('Foo @ Bar', 'moneyline', 'Bar', '', '', '+110'),
      L('Carolina Hurricanes @ New York Rangers', 'moneyline', 'Rangers', '', '', '-130'),
    ], totalOdds: '+2000' });
    const row = i => { const x = fin.rows[i]; return { st: x.status, p: x.p, why: x.why, g: x.g && x.g.id, start: x.g && x.g.start, fb: !!x.fallback, own: !!x.ownOdds }; };
    const worry = S.injuryWorry(fin);
    // 3 · Purdy (player model) + the game total priced from its own odds, same game; plus a moneyline elsewhere
    const pur = S.analyze({ legs: [
      L('Vikings @ 49ers', 'passing_yards', 'Brock Purdy', 'Over', '230.5', '-115'),
      L('Vikings @ 49ers', 'total', 'Over', 'Over', '44.5', '-110'),
      L('Carolina Hurricanes @ New York Rangers', 'moneyline', 'Rangers', '', '', '-130'),
    ], totalOdds: '+1200' });
    const ps = S.simulateSlip(pur, 200000);
    const rec = S.recommendations(pur);
    const st = S.state; st.A = pur; st.simRes = ps; const html = S.results(); st.simRes = null;
    // 4 · NHL legs: model-priced, read off one score grid per run; same-game legs keep their link
    const nhl = S.analyze({ legs: [
      L('Carolina Hurricanes @ New York Rangers', 'moneyline', 'Rangers', '', '', '-130'),
      L('Carolina Hurricanes @ New York Rangers', 'total', 'Over', 'Over', '5.5', '-110'),
      L('Buffalo Sabres @ Tampa Bay Lightning', 'total', 'Over', 'Over', '6.5', '-110'),
    ], totalOdds: '+600' });
    const ns = S.simulateSlip(nhl, 200000);
    st.A = null;
    return {
      fin: [0, 1, 2, 3, 4].map(row), finFull: fin.full, worryStub: /—/.test(worry), worryGames: (worry.match(/worry<\/span>/g) || []).length,
      pur: { rows: pur.rows.map(x => ({ label: x.label, p: x.p, model: !!x.model, book: !!x.bookOnly, own: !!x.ownOdds })), p: pur.p, corr: pur.corr },
      ps: ps && { rate: ps.rate, ci: ps.ci, legs: ps.legs.map(l => [l.label, l.rate, l.how]) },
      rec: rec.items.map(it => ({ label: it.label, p: it.p, opts: it.opts.map(o => [o.kind, o.p, o.slip]) })), recBase: rec.base, html,
      nhl: { p: nhl.p, rows: nhl.rows.map(x => [x.label, x.p, x.status]) }, ns: ns && { rate: ns.rate, ci: ns.ci, games: ns.gamesSimmed, legs: ns.legs.map(l => [l.label, l.rate, l.how]) },
    };
  });
  const [bos, hou, tot, foo, nyr] = r.fin;
  check('a leg on a game that finished last night is flagged, not priced', bos.st === 'game' && /already finished/.test(bos.why) && /this leg (won|lost)/.test(bos.why) && !bos.own && !bos.fb, JSON.stringify(bos));
  check('a leg on a game that finished two days ago (off the board) is flagged too, not priced from its odds', hou.st === 'game' && /already finished/.test(hou.why) && hou.g === 'nfl-HOU-IND-2026-11-20' && !hou.own, JSON.stringify(hou));
  check('a total with no line asks for the line and is not priced from its odds or the fallback', tot.st === 'game' && /Add the line/.test(tot.why) && !tot.own && !tot.fb, JSON.stringify(tot));
  check('an unknown game borrows no other leg\'s start time', foo.st === 'matched' && foo.own && !foo.start && /^fallback-/.test(foo.g), JSON.stringify(foo));
  check('the slip is graded only on the legs we could price', nyr.st === 'matched' && r.finFull === false, JSON.stringify(nyr));
  check('Injury Worry has no card for a leg with no game', !r.worryStub && r.worryGames === 1, `stub=${r.worryStub} cards=${r.worryGames}`);

  const [pd, ov] = r.pur.rows;
  check('the Purdy leg is priced by the player model, not marked "book only"', pd && pd.model && !pd.book, JSON.stringify(pd));
  check('the leg note says the player model priced it; nothing calls a game total a prop',
    /Priced from our player model/.test(r.html) && !/Purdy[^<]*<\/b>[\s\S]{0,200}no model for this prop/.test(r.html) && !/Over 44\.5 total<\/b>[\s\S]{0,200}no model for this prop/.test(r.html));
  check('the total priced from its own odds is drawn at that chance in the simulation (not re-simulated from a game model)',
    r.ps && /own chance/.test(r.ps.legs[1][2]) && Math.abs(r.ps.legs[1][1] - ov.p) < 0.006, r.ps && JSON.stringify(r.ps.legs[1]));
  check('the same-game note says the legs are only counted as unrelated, not measured', r.pur.corr.length === 1 && r.pur.corr[0].free === 2 && /counted as unrelated/.test(r.html) && !/close to unrelated/.test(r.html), JSON.stringify(r.pur.corr));
  const gapped = r.ps && Math.abs(r.ps.rate - r.pur.p) > 2 * r.ps.ci + 0.002;
  check('when the simulation and the estimate disagree, the page says why and which one the verdict uses', !gapped || (/The simulation lands (above|below) our estimate/.test(r.html) && /verdict uses the estimate/.test(r.html)), `sim ${r.ps && r.ps.rate} vs ${r.pur.p}`);
  // every "slip ≈" is the estimate for the changed slip: removing a leg gives the other legs' joint chance, never more
  const others = lbl => r.pur.rows.filter(x => x.label !== lbl).reduce((s, x) => s * x.p, 1);
  const bad = r.rec.flatMap(it => it.opts.filter(([k, p, s]) => (k === 'remove' ? Math.abs(s - others(it.label)) > 1e-9 : Math.abs(s - others(it.label) * p) > 1e-9)).map(o => `${it.label}: ${o}`));
  check('recommended changes: each slip chance is the other legs times the new leg (nothing impossible)', r.rec.length > 0 && bad.length === 0, bad.join(' | ') || JSON.stringify(r.rec));
  check('recommended changes are based on the estimate, even with a simulation on the page', Math.abs(r.recBase - r.pur.p) < 1e-12);

  check('NHL legs are priced by the model', r.nhl.rows.every(x => x[2] === 'matched' && x[1] > 0), JSON.stringify(r.nhl.rows));
  check('NHL legs are game-simulated, not "(no model)"', r.ns && r.ns.legs.every(l => /game simulation/.test(l[2]) && !/no model/.test(l[2])), r.ns && JSON.stringify(r.ns.legs));
  check('the footer counts the NHL games simulated (never "0 games")', r.ns && r.ns.games === 2, r.ns && String(r.ns.games));
  check('each NHL leg lands at its model chance (within 0.6 points)', r.ns && r.ns.legs.every((l, i) => Math.abs(l[1] - r.nhl.rows[i][1]) < 0.006), r.ns && JSON.stringify(r.ns.legs.map((l, i) => [l[1], r.nhl.rows[i][1]])));
  check('the NHL slip rate matches the estimate with its same-game link (within the run\'s range + 0.4 points)', r.ns && Math.abs(r.ns.rate - r.nhl.p) < 2 * r.ns.ci + 0.004, r.ns && `${r.ns.rate} vs ${r.nhl.p}`);

  // 5 · the UI: refresh keeps the submitted slip; deleting a leg clears the old total odds; the builder gets the slip's prices
  await page.evaluate(() => SB.goTab('slipcheck'));
  await page.click('[data-sc-manual]');
  const typed = [['Carolina Hurricanes @ New York Rangers', 'moneyline', 'Rangers', '', '', '-130'], ['Buffalo Sabres @ Tampa Bay Lightning', 'total', 'Over', 'Over', '6.5', '-110'],
    ['Chicago Blackhawks @ Vancouver Canucks', 'spread', 'Canucks', '', '-1.5', '+150']];
  for (let i = 0; i < typed.length; i++) {
    if (i) await page.click('[data-sc-add]');
    const [ev, mk, pk, sd, ln, od] = typed[i];
    await page.fill(`#sc-ev-${i}`, ev); await page.selectOption(`#sc-mk-${i}`, mk); await page.fill(`#sc-pk-${i}`, pk); if (sd) await page.selectOption(`#sc-sd-${i}`, sd);
    await page.fill(`#sc-ln-${i}`, ln); await page.fill(`#sc-od-${i}`, od);
  }
  await page.fill('#sc-stake', '10'); await page.fill('#sc-tot', '+600');
  await page.click('[data-sc-go]');
  await page.click('[data-sc-simrun]');
  await page.waitForFunction(() => __slipcheck.state.simRes && !__slipcheck.state.simBusy, null, { timeout: 60000 });
  const before = await page.evaluate(() => ({ odds: __slipcheck.state.A.rows[0].src.odds, ev: __slipcheck.state.A.ev }));
  await page.fill('#sc-od-0', '+150');  // typed, not submitted
  const refreshed = await page.evaluate(async () => {
    let n = 0; SB.on('data', () => { n++; });
    await window.__fm2.refreshTick(); await new Promise(r => setTimeout(r, 500));
    const st = __slipcheck.state, A = st.A;
    return { n, odds: A.rows[0].src.odds, ev: A.ev, simShown: !!document.querySelector('#main .sc-sim .kpis'), simValid: !!st.simRes && st.simRes.sig === __slipcheck.sigOf(A) };
  });
  check('a background refresh re-prices the submitted slip, not edits typed since', refreshed.odds === before.odds && Math.abs(refreshed.ev - before.ev) < 1e-9, JSON.stringify({ before, refreshed }));
  check('the simulation result still matches the analysis after the refresh', refreshed.simShown === refreshed.simValid, JSON.stringify(refreshed));
  check('the refresh did fire a data event', refreshed.n >= 1, String(refreshed.n));
  await page.fill('#sc-od-0', '-130');
  await page.click('[data-sc-build]');
  const built = await page.evaluate(() => ({ book: (document.getElementById('bookOdds') || {}).value, stake: (document.getElementById('stakeTop') || {}).value,
    legs: [...document.querySelectorAll('[data-lpx]')].map(x => x.value) }));
  check('Open in builder carries the slip\'s total odds, leg prices and stake', built.book === '+600' && built.stake === '10' && built.legs.join(',') === '-130,-110,+150', JSON.stringify(built));
  await page.evaluate(() => SB.goTab('slipcheck'));
  await page.click('[data-sc-del="0"]');
  const del = await page.evaluate(() => { const A = __slipcheck.state.A; return { tot: __slipcheck.state.slip.totalOdds, legs: A.rows.length, decCmp: A.decCmp, ev: A.ev, toast: document.getElementById('toast').textContent,
    simMsg: /slip changed since the last run/.test(document.querySelector('#main .sc-sim').textContent) }; });
  check('removing a leg clears the total odds typed for the bigger slip and says so', del.tot === '' && del.legs === 2 && /cleared/.test(del.toast), JSON.stringify(del));
  check('the slip is re-priced from the remaining legs\' own odds, not the old total', Math.abs(del.decCmp - (1 + 100 / 110) * 2.5) < 1e-6, String(del.decCmp));
  check('the old simulation result is replaced by a note that the slip changed', del.simMsg);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) { check('suite ran to completion', false, e.stack || e.message); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
