// Highlights ('news', news.js) on the saved ESPN file (tests/fixtures/news-2026-11-24.json, written by tools/news_fetch.py) and the
// 2026-11-23 slate: missing file -> honest empty state; cards, https espn.com links in a new tab, Videos / sport filters, the
// "On today's slate" strip and its jump to Prop Analyzer, off-slate player chips to Players, image fallback tiles, stale file,
// escaping and link rules on a hand-made file, first-render time, no horizontal scroll at 390px and 3 columns at 1440px.
// Run: node tests/news.test.mjs
import { open, check, done, FX } from './lib/harness.mjs';

const NEWS = JSON.parse(FX('news-2026-11-24.json'));
const byId = new Map(NEWS.items.map(x => [String(x.id), x]));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// 1. the file is missing: an honest empty state, nothing invented
const { page, errors, browser } = await open({ width: 390, tab: 'news', pins: { 'news.json': null } });
await page.waitForFunction(() => document.querySelector('.nw-root .ui-empty'), null, { timeout: 15000 });
let t = await page.evaluate(() => ({ txt: document.querySelector('.nw-root').innerText, cards: document.querySelectorAll('.nw-card').length }));
check('missing news.json: honest empty state, no cards', /news\.json is missing/.test(t.txt) && /don't make headlines up/.test(t.txt) && t.cards === 0, t.txt.slice(0, 160));
check('missing news.json: says we do not host video', /we don't host video/i.test(t.txt));

// 2. the saved ESPN file; Premier League-CDN (akamaized) images are blocked, ESPN CDN images load
await page.route(/\/news\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NEWS) }));
await page.route(/espnmedia-cdn\.akamaized\.net/, r => r.abort());
await page.route(/espncdn\.com/, r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
await page.evaluate(() => window.__news.reload());
await page.waitForSelector('.nw-card', { timeout: 15000 });
t = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('.nw-grid .nw-card')].map(c => c.dataset.nwId);
  return { ids, feat: document.querySelector('.nw-feat') && document.querySelector('.nw-feat').dataset.nwId, title: document.querySelector('.ui-title').textContent,
    label: document.querySelector('#tabs [data-t="news"]') && document.querySelector('#tabs [data-t="news"]').textContent.trim() };
});
check('cards render: a featured reel and a page of 24 cards', t.ids.length === 24 && !!t.feat, `${t.ids.length} cards, featured ${t.feat}`);
check('featured is the newest video in the file', t.feat === String(NEWS.items.filter(x => x.type === 'video').sort((a, b) => b.published.localeCompare(a.published))[0].id));
check('cards are newest first', t.ids.every((id, i) => i === 0 || byId.get(t.ids[i - 1]).published >= byId.get(id).published));
check('sidebar label is Highlights', /Highlights/.test(t.label || ''), t.label);
const L = await page.evaluate(() => [...document.querySelectorAll('.nw-root a')].map(a => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, txt: a.textContent.trim(), aria: a.getAttribute('aria-label') })));
check('every link is https espn.com, opens a new tab with rel noopener', L.length >= 25 && L.every(a => { try { const u = new URL(a.href); return u.protocol === 'https:' && (u.hostname === 'espn.com' || u.hostname.endsWith('.espn.com')) && a.target === '_blank' && /noopener/.test(a.rel); } catch (e) { return false; } }), `${L.length} links`);
check('videos say "Watch on ESPN", stories "Read on ESPN", names say a new tab opens', L.some(a => /^Watch on ESPN/.test(a.txt)) && L.some(a => /^Read on ESPN/.test(a.txt)) && L.every(a => /new tab/.test(a.aria || '')));
const vb = await page.evaluate(() => [...document.querySelectorAll('.nw-card')].map(c => [c.dataset.nwId, c.querySelector('.nw-badge').textContent.trim(), (c.querySelector('.nw-go') || {}).textContent || '']));
check('Video / Story badge and button match the item type', vb.every(([id, b, go]) => (byId.get(id).type === 'video') === (b === 'Video') && (b === 'Video') === /Watch/.test(go)));

// image fallback: blocked images become the sport tile, loaded ones hide it
await page.waitForFunction(() => document.querySelector('.nw-media.nw-noimg') && document.querySelector('.nw-media.nw-ok'), null, { timeout: 10000 }).catch(() => {});
t = await page.evaluate(() => {
  const bad = [...document.querySelectorAll('.nw-media.nw-noimg')], ok = [...document.querySelectorAll('.nw-media.nw-ok')];
  return { bad: bad.length, badImg: bad.some(m => m.querySelector('img')), tile: bad[0] && getComputedStyle(bad[0].querySelector('.nw-tile')).visibility, tileTxt: bad[0] && bad[0].querySelector('.nw-tile').textContent.trim(), ok: ok.length,
    inline: document.querySelector('.nw-root').innerHTML.match(/\son[a-z]+=/i) };
});
check('a blocked image falls back to the sport tile', t.bad > 0 && !t.badImg && t.tile === 'visible' && /NFL|NBA|NHL|Soccer|College/.test(t.tileTxt || ''), JSON.stringify(t));
check('a loaded image hides the tile', t.ok > 0);
check('no inline event handlers in the markup', !t.inline, String(t.inline));

// first render in the page (data already loaded): under 1,500 ms
const ms = await page.evaluate(() => { const t0 = performance.now(); SB.goTab('news'); return { all: performance.now() - t0, view: window.__news.lastMs }; });
check('first render under 1,500 ms', ms.all < 1500, `${ms.all.toFixed(0)} ms (view ${ms.view.toFixed(0)} ms)`);

// Videos filter
await page.click('[data-ui-seg="news-type|video"]');
t = await page.evaluate(() => ({ ids: [...document.querySelectorAll('.nw-root [data-nw-id]')].map(c => c.dataset.nwId), on: document.querySelector('[data-ui-seg="news-type|video"]').getAttribute('aria-pressed'), focus: document.activeElement && document.activeElement.dataset.uiSeg, stored: localStorage.getItem('fm2.news.type') }));
const nVid = NEWS.items.filter(x => x.type === 'video').length;
check('Videos filter: only videos', t.ids.length > 0 && t.ids.every(id => byId.get(id).type === 'video'), `${t.ids.length} shown of ${nVid}`);
check('Videos filter: pressed state, focus kept, choice remembered', t.on === 'true' && t.focus === 'news-type|video' && t.stored === '"video"');

// sport filter (NBA) on top of Videos, then back to All
await page.click('[data-ui-pill="news-sport|nba"]');
t = await page.evaluate(() => [...document.querySelectorAll('.nw-root [data-nw-id]')].map(c => c.dataset.nwId));
check('sport filter: NBA videos only', t.length > 0 && t.every(id => byId.get(id).sport === 'nba' && byId.get(id).type === 'video'), `${t.length}`);
await page.click('[data-ui-seg="news-type|all"]');
t = await page.evaluate(() => [...document.querySelectorAll('.nw-root [data-nw-id]')].map(c => c.dataset.nwId));
check('sport filter: all NBA items', t.length === Math.min(25, NEWS.items.filter(x => x.sport === 'nba').length) && t.every(id => byId.get(id).sport === 'nba'), `${t.length}`);

// "On today's slate": NBA players in the news who have a prop today; a click opens Prop Analyzer on him
t = await page.evaluate(() => ({ names: [...document.querySelectorAll('.nw-sp b')].map(b => b.textContent), head: (document.querySelector('.nw-slate h2') || {}).textContent }));
check('slate strip: NBA players from the file with a prop today', t.names.length > 0 && /today's slate/.test(t.head || ''), t.names.slice(0, 6).join(', '));
const slateOk = await page.evaluate(() => {
  const X = window.__news.slate();
  return [...document.querySelectorAll('.nw-sp')].every(b => { const p = X.people.get(b.dataset.nwProp); return p && p.sport === 'nba' && SB.DATA.players.some(pl => pl.gid === p.g.id && SB.engine.nameKey(pl.name) === p.nk) && SB.openG(p.g); });
});
check('slate strip: every player has a prop on an open game in DATA.players', slateOk);
const first = t.names[0];
await page.click('.nw-sp');
await page.waitForFunction(() => SB.tab === 'propan', null, { timeout: 5000 });
t = await page.evaluate(() => ({ tab: SB.tab, txt: document.getElementById('main').innerText }));
check('slate player opens Prop Analyzer on him', t.tab === 'propan' && t.txt.includes(first.split(' ').slice(-1)[0]), first);

// off-slate athlete chip -> Players page
await page.evaluate(() => SB.goTab('news'));
await page.click('[data-ui-pill="news-sport|all"]');
const off = await page.evaluate(() => { const b = document.querySelector('.nw-chip[data-nw-player]'); return b ? b.dataset.nwPlayer : null; });
if (off) {
  await page.click(`.nw-chip[data-nw-player="${off.replace(/"/g, '\\"')}"]`);
  await page.waitForFunction(() => SB.tab === 'players', null, { timeout: 5000 }).catch(() => {});
  check('a player chip without a prop today opens Players', await page.evaluate(() => SB.tab) === 'players', off);
  await page.evaluate(() => SB.goTab('news'));
} else check('a player chip without a prop today opens Players', false, 'no off-slate chip');

// a team chip for a team playing on the slate opens Games on that game, with the feed's abbreviation (ESPN WSH = feed WAS)
const tc = await page.evaluate(() => { const b = document.querySelector('.nw-chip[data-nw-game]'); return b ? { gid: b.dataset.nwGame, txt: b.textContent } : null; });
const wsh = await page.evaluate(() => [...document.querySelectorAll('.nw-chip.nw-tm')].map(b => b.textContent));
check('team chips use the feed abbreviation once matched', !wsh.some(x => /^WSH/.test(x)) && wsh.some(x => /^WAS/.test(x)), wsh.slice(0, 8).join(','));
if (tc) {
  await page.click(`.nw-chip[data-nw-game="${tc.gid}"]`);
  await page.waitForFunction(() => SB.tab === 'slate', null, { timeout: 5000 }).catch(() => {});
  check('a team chip opens Games on its game', await page.evaluate(() => SB.tab) === 'slate', tc.txt);
  await page.evaluate(() => SB.goTab('news'));
} else check('a team chip opens Games on its game', false, 'no team chip with a game');

// Show more: 24 more cards, focus on the first new one
t = await page.evaluate(() => { document.querySelector('[data-nw-more]').click(); const c = document.querySelectorAll('.nw-grid .nw-card'); return { n: c.length, focus: document.activeElement === c[24].querySelector('.nw-go') }; });
check('Show more adds 24 cards and moves focus to the first new one', t.n === 48 && t.focus, JSON.stringify(t));

// 390px: no horizontal page scroll, tap targets 40px+
t = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  small: [...document.querySelectorAll('.nw-root button, .nw-root a')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 40).map(b => b.className + ':' + b.textContent.trim().slice(0, 20)).slice(0, 5) }));
check('390px: no horizontal scroll', t.sw <= t.cw, `${t.sw} vs ${t.cw}`);
check('390px: tap targets 40px+', t.small.length === 0, t.small.join(' | '));

// 3. a hand-made file: a slate player named only in the headline text, unsafe values, an old file
const pl = await page.evaluate(() => { const X = window.__news.slate(); const p = [...X.people.values()].find(p => p.sport === 'nba' && p.stats.has('pts') && p.nk.includes('-')); return p && { name: p.name, team: p.team }; });
const old = { updated: '2026-11-20T09:00:00Z', source: 'test', missing: ['NHL'], items: [
  { id: 'x1', sport: 'nba', league: 'NBA', headline: `${pl.name} drops 30 in a win`, description: 'A <b>big</b> night', published: '2026-11-20T08:00:00Z', type: 'story', link: 'https://www.espn.com/nba/story/_/id/1/x', image: 'http://a.espncdn.com/x.jpg', athletes: [], teams: [{ name: 'Nowhere Team', abbr: 'NWT' }] },
  { id: 'x2', sport: 'nba', league: 'NBA', headline: '<img src=x onerror="window.__pwn=1">Hack', description: '"><script>window.__pwn=2</script>', published: '2026-11-20T07:00:00Z', type: 'video', link: 'https://www.espn.com/video/clip/_/id/2', image: 'https://evil.example.com/x.png', athletes: ['<b>Bold</b> Name'], teams: [] },
  { id: 'x3', sport: 'nba', league: 'NBA', headline: 'javascript link', published: '2026-11-20T06:00:00Z', type: 'story', link: 'javascript:alert(1)', athletes: [], teams: [] },
  { id: 'x4', sport: 'nba', league: 'NBA', headline: 'not espn', published: '2026-11-20T05:00:00Z', type: 'story', link: 'https://evil.example.com/espn.com', athletes: [], teams: [] },
  { id: 'x5', sport: 'nba', league: 'NBA', headline: 'plain http espn', published: '2026-11-20T04:00:00Z', type: 'story', link: 'http://www.espn.com/nba/story', athletes: [], teams: [] },
] };
await page.unroute(/\/news\.json(\?.*)?$/);
await page.route(/\/news\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(old) }));
await page.evaluate(() => { localStorage.removeItem('fm2.news.type'); window.__news.reload(); });
await page.waitForFunction(() => window.__news.state.n === 2, null, { timeout: 10000 });
t = await page.evaluate(() => ({ ids: [...document.querySelectorAll('.nw-root [data-nw-id]')].map(c => c.dataset.nwId), txt: document.querySelector('.nw-root').innerText, pwn: window.__pwn || null,
  imgs: [...document.querySelectorAll('.nw-root img')].map(i => i.getAttribute('src')), strip: [...document.querySelectorAll('.nw-sp b')].map(b => b.textContent),
  chipOn: [...document.querySelectorAll('.nw-chip.nw-on')].map(b => b.textContent), off: [...document.querySelectorAll('.nw-chip.nw-off')].map(b => b.textContent) }));
check('unsafe links are dropped (javascript:, other hosts, plain http)', t.ids.length === 2 && !t.ids.includes('x3') && !t.ids.includes('x4') && !t.ids.includes('x5'), t.ids.join(','));
check('feed text is escaped, nothing runs, non-https / non-ESPN images are not loaded', !t.pwn && t.txt.includes('<img src=x onerror') && t.txt.includes('<b>Bold</b> Name') && t.imgs.length === 0, JSON.stringify(t.imgs));
check('a slate player named only in the headline gets a Props chip and a strip entry', t.strip.includes(pl.name) && t.chipOn.some(c => c.includes(pl.name)), `${pl.name}: ${t.strip.join(',')}`);
check('a team without a game on the slate is a plain chip', t.off.includes('NWT'));
check('stale file: says how old and that it was not refreshed', /These headlines are 3 days old/.test(t.txt) && /has not refreshed news\.json/.test(t.txt), t.txt.match(/These headlines[^\n]*/) && t.txt.match(/These headlines[^\n]*/)[0]);
check('a feed that failed on the last run is named', /ESPN's NHL feed did not load/.test(t.txt));
await page.click('[data-ui-pill="news-sport|nba"]').catch(() => {});
await page.click('[data-ui-seg="news-type|video"]');
await page.click('[data-ui-pill="news-sport|all"]');
t = await page.evaluate(() => document.querySelectorAll('.nw-root [data-nw-id]').length);
check('Videos with one video in the file shows just it', t === 1);

// 4. 1440px: three columns, no horizontal scroll
await page.unroute(/\/news\.json(\?.*)?$/);
await page.route(/\/news\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NEWS) }));
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => { localStorage.setItem('fm2.news.type', '"all"'); window.__news.reload(); });
await page.waitForFunction(() => window.__news.state.n === 180, null, { timeout: 10000 });
await page.click('[data-ui-seg="news-type|all"]');
t = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector('.nw-grid')).gridTemplateColumns.split(' ').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
check('1440px: 3+ columns, no horizontal scroll', t.cols >= 3 && t.sw <= t.cw, JSON.stringify(t));

check('no page errors', errors.length === 0, errors.join(' | '));
await done(browser);
