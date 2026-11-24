// news.js: Highlights ('news'), docs/pro-interface.md screen 12. The reference shows player and league highlight reels next to
// the props it tracks. We do not host video: news.json (tools/news_fetch.py, ESPN's public news API, refreshed by the daily run)
// holds ESPN headlines and video links, and every card opens the story or clip on espn.com in a new tab.
// The screen: sport pills, a Videos / All switch, the newest video as a featured reel, a strip "On today's slate" with the
// players in these headlines who have a prop in the app today (by name: categories ESPN tagged, or the full name in the
// headline / summary; each opens Prop Analyzer), and a grid of cards (image or a sport tile when the image is blocked, Video /
// Story badge, headline, time, two-line summary, Watch / Read on ESPN, chips for the players and teams it names).
// Loading, missing-file, stale (older than a day) and part-failed-run states say what happened.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui || !SB.engine) { console.warn('news.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'news', PAGE = 24, DAY = 864e5;
  const SPN = { nfl: 'NFL', ncaaf: 'College FB', nba: 'NBA', nhl: 'NHL', soccer: 'Soccer' };
  const SPORDER = ['nfl', 'ncaaf', 'nba', 'nhl', 'soccer'];
  const TILE = { nfl: 214, ncaaf: 32, nba: 14, nhl: 192, soccer: 150 };  // hue of the sport tile shown when an image cannot load
  const MORDER = ['pts', 'reb', 'ast', 'rec', 'recyd', 'ryd', 'pyd', 'hpts', 'sog', 'sot', 'td'];  // Prop Analyzer's market order (points first)
  const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) { /* private mode */ } } };
  const num = x => typeof x === 'number' && isFinite(x);

  // ---------- safe links: https only, espn.com pages; images https on ESPN's CDN ----------
  const host = u => { try { const x = new URL(String(u)); return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') ? x.hostname.toLowerCase() : null; } catch (e) { return null; } };
  const isEspn = h => !!h && (h === 'espn.com' || h.endsWith('.espn.com'));
  const safeLink = u => (isEspn(host(u)) ? String(u) : null);
  const safeImg = u => { const h = host(u); return h && (isEspn(h) || h === 'espncdn.com' || h.endsWith('.espncdn.com') || h === 'espnmedia-cdn.akamaized.net') ? String(u) : null; };

  // ---------- data: news.json ----------
  let NEWS = null, LOAD = 'idle', FETCHED = 0, IDX = null, MATCH = new WeakMap();
  function norm(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return null;
    const seen = new Set(), items = [];
    for (const x of d.items) {
      if (!x || typeof x !== 'object' || typeof x.headline !== 'string' || !x.headline.trim() || !SPN[x.sport]) continue;
      const link = safeLink(x.link), t = Date.parse(x.published);
      if (!link || !num(t)) continue;
      const id = String(x.id != null ? x.id : link);
      if (seen.has(id)) continue; seen.add(id);
      items.push({
        id, sport: x.sport, league: typeof x.league === 'string' ? x.league : SPN[x.sport], headline: x.headline.trim(),
        desc: typeof x.description === 'string' ? x.description.trim() : '', t, video: x.type === 'video', premium: x.premium === true,
        link, image: safeImg(x.image),
        athletes: (Array.isArray(x.athletes) ? x.athletes : []).filter(a => typeof a === 'string' && a.trim()).slice(0, 8),
        teams: (Array.isArray(x.teams) ? x.teams : []).filter(tm => tm && typeof tm.name === 'string' && tm.name.trim()).slice(0, 4)
          .map(tm => ({ name: tm.name, abbr: typeof tm.abbr === 'string' ? tm.abbr : '' })),
      });
    }
    items.sort((a, b) => b.t - a.t);
    const up = Date.parse(d.updated);
    return { items, updated: num(up) ? up : null, missing: (Array.isArray(d.missing) ? d.missing : []).filter(s => typeof s === 'string') };
  }
  function load() {
    if (LOAD === 'loading' || (LOAD === 'done' && Date.now() - FETCHED < 3600e3)) return;
    LOAD = 'loading';
    fetch('news.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
      const n = norm(d);
      if (n || !NEWS) NEWS = n;  // a failed re-fetch keeps the headlines already on screen
      LOAD = 'done'; FETCHED = Date.now(); MATCH = new WeakMap();
      if (drawn()) SB.render();
    });
  }

  // ---------- the slate: players with a prop in the app on today's games (Los Angeles day) ----------
  function slate() {
    const D = SB.DATA || {}, T = E.nflByTd;
    if (IDX && IDX.D === D && IDX.T === T) return IDX;
    const ok = Array.isArray(D.games);
    let day = E.dayOf(Date.now()), games = ok ? E.dayGames(day) : [], ahead = 0;
    while (ok && !games.length && ahead < 3) { day = E.nextDay(day); games = E.dayGames(day); ahead++; }
    const G = new Map(games.map(g => [g.id, g])), people = new Map(), byName = new Map(), teams = new Map();
    const add = (g, team, name, stat, extra) => {
      const nk = E.nameKey(name), pk = g.id + '|' + team + '|' + nk;
      let p = people.get(pk);
      if (!p) {
        const home = g.home.abbr === team;
        p = { pk, nk, name, team, opp: (home ? g.away : g.home).abbr, home, g, sport: g.sport, stats: new Set(), td: null };
        people.set(pk, p);
        if (!byName.has(nk)) byName.set(nk, []);
        byName.get(nk).push(p);
      }
      if (stat === 'td') p.td = extra; else p.stats.add(stat);
    };
    for (const pl of D.players || []) {
      if (!pl || !E.LADDER[pl.stat] || pl.status === 'out') continue;
      const g = G.get(pl.gid);
      if (g && (g.home.abbr === pl.team || g.away.abbr === pl.team)) add(g, pl.team, pl.name, pl.stat);
    }
    if (T && typeof T.entries === 'function') {
      for (const g of games) {
        if (g.sport !== 'nfl') continue;
        for (const me of [g.home, g.away]) for (const [k, v] of T) {
          if (!k.startsWith(me.abbr + '|')) continue;
          const slug = k.slice(me.abbr.length + 1);
          add(g, me.abbr, (v && v.name) || slug, 'td', { key: `TD:A:${me.abbr}:${slug}`, ok: null });
        }
      }
    }
    for (const g of games) for (const s of [g.home, g.away]) {
      teams.set(g.sport + '|n|' + E.nameKey(s.name), g);
      if (!teams.has(g.sport + '|a|' + s.abbr)) teams.set(g.sport + '|a|' + s.abbr, g);
    }
    // full names (two words or more) for finding a slate player named in a headline or summary
    const full = {};
    for (const nk of byName.keys()) if (nk.includes('-')) for (const p of byName.get(nk)) { (full[p.sport] = full[p.sport] || new Set()).add(nk); }
    return (IDX = { D, T, day, ahead, games, people, byName, teams, full: Object.fromEntries(Object.entries(full).map(([k, s]) => [k, [...s]])) });
  }
  const tdOk = p => {  // an anytime-TD player counts only when the model prices him (as Prop Analyzer does)
    if (!p.td) return false;
    if (p.td.ok == null) { let x = 0; try { x = SB.p1(p.g, p.td.key); } catch (e) { x = 0; } p.td.ok = x > 0 && x < 0.995; }
    return p.td.ok;
  };
  const markets = p => MORDER.filter(s => (s === 'td' ? tdOk(p) : p.stats.has(s)));
  const statName = s => (s === 'td' ? 'anytime TD' : (E.STATN && E.STATN[s]) || s);
  // the slate players and teams one item names (cached per item and slate)
  function matchOf(it) {
    const X = slate();
    let m = MATCH.get(it);
    if (m && m.X === X) return m;
    const pl = [], seen = new Set();
    const take = (nk, label) => {
      const c = (X.byName.get(nk) || []).filter(p => p.sport === it.sport && markets(p).length);
      if (seen.has(nk)) return; seen.add(nk);
      pl.push({ name: c[0] ? c[0].name : label, nk, p: c[0] || null });
    };
    for (const a of it.athletes) take(E.nameKey(a), a);
    const txt = '-' + E.nameKey(it.headline + ' ' + it.desc) + '-';
    for (const nk of X.full[it.sport] || []) if (!seen.has(nk) && txt.includes('-' + nk + '-')) take(nk, nk);
    const tm = it.teams.map(t => {
      const tk = E.nameKey(t.name), g = X.teams.get(it.sport + '|n|' + tk) || (t.abbr ? X.teams.get(it.sport + '|a|' + t.abbr) : null) || null;
      const side = g && ([g.home, g.away].find(s => E.nameKey(s.name) === tk) || [g.home, g.away].find(s => s.abbr === t.abbr));
      return { name: t.name, abbr: side ? side.abbr : t.abbr, g };  // the feed's abbreviation once matched (ESPN WSH = feed WAS)
    });
    m = { X, players: pl.filter(x => x.p || it.athletes.some(a => E.nameKey(a) === x.nk)), teams: tm };
    MATCH.set(it, m);
    return m;
  }

  // ---------- view state ----------
  const st = { sport: store.get('news.sport', 'all'), type: store.get('news.type', 'all'), shown: PAGE };
  if (st.sport !== 'all' && !SPN[st.sport]) st.sport = 'all';
  if (st.type !== 'video') st.type = 'all';
  let seenP = null;
  function applyParams(prm) {
    if (!prm || typeof prm !== 'object' || !Object.keys(prm).length || seenP === prm) return;
    seenP = prm;
    if (typeof prm.sport === 'string' && (SPN[prm.sport.toLowerCase()] || prm.sport === 'all')) { st.sport = prm.sport.toLowerCase(); st.shown = PAGE; }
    if (prm.type === 'video' || prm.type === 'all') { st.type = prm.type; st.shown = PAGE; }
  }

  // ---------- pieces ----------
  const MIN = 6e4, HR = 36e5;
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  function ago(t) {
    const d = Date.now() - t;
    if (d < -10 * MIN) return dateFmt.format(new Date(t));     // stamped ahead of this device's clock
    if (d < MIN) return 'just now';
    if (d < HR) return Math.floor(d / MIN) + 'm ago';
    if (d < DAY) return Math.floor(d / HR) + 'h ago';
    if (d < 2 * DAY) return 'yesterday';
    if (d < 7 * DAY) return Math.floor(d / DAY) + 'd ago';
    return dateFmt.format(new Date(t));
  }
  const ageText = d => (d < 2 * DAY ? Math.round(d / HR) + ' hours' : Math.floor(d / DAY) + ' days');
  const lbl = s => SPN[s] || s;
  const playIc = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  const playSm = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  const ext = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

  function media(it, big) {
    return `<div class="nw-media${it.image ? '' : ' nw-noimg'}" style="--h:${TILE[it.sport] || 210}">
      <div class="nw-tile" aria-hidden="true"><span class="nw-tsp">${esc(lbl(it.sport))}</span>${it.league && it.league !== lbl(it.sport) ? `<span class="nw-tlg">${esc(it.league)}</span>` : ''}</div>
      ${it.image ? `<img class="nw-img" src="${esc(it.image)}" alt="" loading="${big ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="nw-badge${it.video ? ' nw-v' : ''}">${it.video ? playSm + 'Video' : 'Story'}</span>
      ${it.premium ? '<span class="nw-plus">ESPN+</span>' : ''}
      ${it.video ? `<span class="nw-play" aria-hidden="true">${playIc}</span>` : ''}
    </div>`;
  }
  function chips(it) {
    const m = matchOf(it), out = [];
    for (const x of m.players.slice(0, 5)) {
      if (x.p) {
        const mk = markets(x.p)[0];
        out.push(`<button type="button" class="nw-chip nw-on" data-nw-prop="${esc(x.p.pk)}" data-nw-stat="${esc(mk)}" aria-label="${esc(x.p.name)}: ${esc(statName(mk))} prop in Prop Analyzer"><span class="nw-dot" aria-hidden="true"></span>${esc(x.p.name)}<span class="nw-tg">Props</span></button>`);
      } else {
        out.push(`<button type="button" class="nw-chip" data-nw-player="${esc(x.name)}" data-nw-sport="${esc(it.sport)}" aria-label="${esc(x.name)}: player page">${esc(x.name)}</button>`);
      }
    }
    for (const t of m.teams.slice(0, 3)) {
      if (t.g) out.push(`<button type="button" class="nw-chip nw-tm" data-nw-game="${esc(t.g.id)}" aria-label="${esc(t.name)}: open their game on the slate">${esc(t.abbr || t.name)}<span class="nw-tg">Game</span></button>`);
      else out.push(`<span class="nw-chip nw-tm nw-off" title="${esc(t.name)}">${esc(t.abbr || t.name)}</span>`);
    }
    return out.length ? `<div class="nw-chips">${out.join('')}</div>` : '';
  }
  function cta(it, big) {
    const v = it.video, txt = v ? 'Watch on ESPN' : 'Read on ESPN';
    return `<a class="${big || v ? 'ui-cta' : 'ui-ghost'} sm nw-go" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(txt + ': ' + it.headline + ' (opens espn.com in a new tab)')}">${esc(txt)} ${ext}</a>`;
  }
  function card(it) {
    const hid = 'nw-h-' + it.id.replace(/[^a-zA-Z0-9_-]/g, '');
    return `<article class="nw-card" data-nw-id="${esc(it.id)}" aria-labelledby="${esc(hid)}">
      ${media(it, false)}
      <div class="nw-body">
        <div class="nw-meta"><span>${esc(it.league)}</span><span aria-hidden="true">·</span><time datetime="${esc(new Date(it.t).toISOString())}">${esc(ago(it.t))}</time></div>
        <h3 class="nw-hl" id="${esc(hid)}">${esc(it.headline)}</h3>
        ${it.desc ? `<p class="nw-desc">${esc(it.desc)}</p>` : ''}
        ${chips(it)}
        <div class="nw-ft">${cta(it, false)}</div>
      </div>
    </article>`;
  }
  function featured(it) {
    return `<article class="nw-feat" data-nw-id="${esc(it.id)}" aria-labelledby="nw-feat-h">
      ${media(it, true)}
      <div class="nw-fbody">
        <div class="ui-lbl">${it.video ? 'Latest reel' : 'Latest story'} · ${esc(it.league)} · <time datetime="${esc(new Date(it.t).toISOString())}">${esc(ago(it.t))}</time></div>
        <h2 class="nw-fhl" id="nw-feat-h">${esc(it.headline)}</h2>
        ${it.desc ? `<p class="nw-desc">${esc(it.desc)}</p>` : ''}
        ${chips(it)}
        <div class="nw-ft">${cta(it, true)}</div>
      </div>
    </article>`;
  }
  function strip(list) {
    const X = slate(), agg = new Map();
    for (const it of list) for (const x of matchOf(it).players) if (x.p) { const a = agg.get(x.p.pk) || { p: x.p, n: 0 }; a.n++; agg.set(x.p.pk, a); }
    const all = [...agg.values()].sort((a, b) => b.n - a.n || SB.startMs(a.p.g) - SB.startMs(b.p.g) || (a.p.name < b.p.name ? -1 : 1)), rows = all.slice(0, 16);
    const dayName = X.ahead ? `the ${dateFmt.format(new Date(Date.parse(X.day + 'T12:00:00Z')))} slate` : "today's slate";
    const head = `<div class="nw-shead"><h2 class="nw-h2">On ${esc(dayName)}</h2><span class="ui-muted">${all.length ? `${all.length} player${all.length === 1 ? '' : 's'} in these headlines with a prop in the app${all.length > rows.length ? `, the ${rows.length} most mentioned shown` : ''}` : ''}</span></div>`;
    if (!X.games.length) return `<section class="nw-slate" aria-label="On the slate">${head}<p class="ui-note">No open games in the feed for the next few days, so no player here links to props.</p></section>`;
    if (!rows.length) return `<section class="nw-slate" aria-label="On the slate">${head}<p class="ui-note">None of the players in these ${st.sport === 'all' ? '' : esc(lbl(st.sport)) + ' '}headlines has a prop on ${esc(dayName)}.</p></section>`;
    const cards = rows.map(({ p, n }) => {
      const M = markets(p);
      return `<button type="button" class="nw-sp" data-nw-prop="${esc(p.pk)}" data-nw-stat="${esc(M[0])}" aria-label="${esc(`${p.name}, ${p.team} ${p.home ? 'vs' : 'at'} ${p.opp}, in ${n} ${n === 1 ? 'story' : 'stories'}: open his ${statName(M[0])} prop in Prop Analyzer`)}">
        ${U.team(p.team)}<span class="nw-tx"><b>${esc(p.name)}</b><span class="nw-mu">${esc(p.team)} ${p.home ? 'vs' : '@'} ${esc(p.opp)} · ${esc(SB.when(p.g))}</span>
        <span class="nw-mk">${esc(M.slice(0, 3).map(statName).join(' · '))}</span></span><span class="nw-n">${n} ${n === 1 ? 'story' : 'stories'}<i aria-hidden="true">›</i></span></button>`;
    }).join('');
    return `<section class="nw-slate" aria-label="Players on the slate">${head}<div class="nw-srow">${cards}</div></section>`;
  }

  // ---------- render ----------
  function view() {
    const head = U.page({ kicker: 'Highlights', title: 'Reels &', accent: 'headlines', sub: 'ESPN\'s latest clips and stories for the leagues we price. When a player in the news plays today, his chip opens his props.' });
    const honest = `<p class="ui-note nw-honest">Highlights open on espn.com; we don't host video. Headlines, clips and pictures are ESPN's.</p>`;
    if (!NEWS && LOAD !== 'done') {
      return head + honest + `<div class="nw-loading" role="status" aria-live="polite"><span class="sk"></span><span class="sk"></span><span class="sk"></span><b>Loading highlights…</b></div>`;
    }
    if (!NEWS) {
      return head + honest + U.empty('No highlights yet: news.json is missing or could not be read. The daily data run writes it from ESPN (tools/news_fetch.py); until then there is nothing to show, and we don\'t make headlines up.');
    }
    const now = Date.now(), all = NEWS.items;
    const counts = {}; for (const it of all) counts[it.sport] = (counts[it.sport] || 0) + 1;
    const pills = [{ k: 'all', label: 'All', n: all.length }, ...SPORDER.filter(s => counts[s]).map(s => ({ k: s, label: SPN[s], n: counts[s] }))];
    const sport = st.sport === 'all' || counts[st.sport] ? st.sport : 'all';
    const bySport = all.filter(it => sport === 'all' || it.sport === sport);
    const list = bySport.filter(it => st.type === 'all' || it.video);
    const nv = bySport.filter(it => it.video).length;
    const age = NEWS.updated ? now - NEWS.updated : null;
    const fresh = age == null ? '' : age < -10 * MIN ? `updated ${dateFmt.format(new Date(NEWS.updated))}` : `updated ${ago(NEWS.updated)}`;
    let notes = `<div class="nw-src ui-note"><span>Source: ESPN</span>${fresh ? `<span>${esc(fresh)}</span>` : ''}<span>${all.length} items, ${all.filter(it => it.video).length} videos</span></div>`;
    if (age != null && age > DAY) notes += `<div class="nw-stale" role="note"><b>These headlines are ${esc(ageText(age))} old.</b> The daily run has not refreshed news.json since ${esc(dateFmt.format(new Date(NEWS.updated)))}, so newer stories and injuries are missing.</div>`;
    else if (age == null) notes += `<div class="nw-stale" role="note"><b>We can't tell how old these headlines are</b> (news.json has no update time).</div>`;
    if (NEWS.missing.length) notes += `<p class="ui-note">ESPN's ${esc(NEWS.missing.join(', '))} feed${NEWS.missing.length > 1 ? 's' : ''} did not load on the last run, so ${NEWS.missing.length > 1 ? 'those leagues are' : 'that league is'} missing here.</p>`;
    const ctrls = `<div class="nw-ctrl">${U.pills(pills, sport, 'news-sport')}${U.seg([{ k: 'video', label: `Videos ${nv}` }, { k: 'all', label: 'All' }], st.type, 'news-type')}</div>`;
    if (!all.length) return head + honest + notes + U.empty('news.json has no headlines in it. The last ESPN run came back empty.');
    let body;
    if (!list.length) body = U.empty(st.type === 'video' ? `No ${sport === 'all' ? '' : SPN[sport] + ' '}videos in this file. Switch to All for the headlines.` : 'Nothing here for this filter.');
    else {
      const feat = list.find(it => it.video) || list[0], rest = list.filter(it => it !== feat), shown = rest.slice(0, st.shown);
      body = featured(feat) + strip(bySport) +
        `<div class="nw-shead"><h2 class="nw-h2">${st.type === 'video' ? 'Videos' : 'Latest'}</h2><span class="ui-muted">${rest.length + 1} ${st.type === 'video' ? 'clips' : 'items'}, newest first</span></div>` +
        `<div class="nw-grid">${shown.map(card).join('')}</div>` +
        (rest.length > shown.length ? `<div class="nw-more"><button type="button" class="ui-ghost" data-nw-more="1">Show ${Math.min(PAGE, rest.length - shown.length)} more <span class="ui-muted">(${rest.length - shown.length} left)</span></button></div>` : '');
    }
    return head + honest + notes + ctrls + body;
  }
  function wireImages(root) {
    for (const img of root.querySelectorAll('img.nw-img')) {
      if (img.dataset.w) continue;
      img.dataset.w = '1';
      const fail = () => { const m = img.closest('.nw-media'); if (m) m.classList.add('nw-noimg'); img.remove(); };
      img.addEventListener('error', fail, { once: true });
      img.addEventListener('load', () => { if (!img.naturalWidth) fail(); else { const m = img.closest('.nw-media'); if (m) m.classList.add('nw-ok'); } }, { once: true });
      if (img.complete && !img.naturalWidth) fail();
    }
  }
  let MAIN = null;
  const drawn = () => SB.tab === KEY && !!MAIN && MAIN.isConnected && !!MAIN.querySelector('.nw-root');
  function render(main, params) {
    css(); applyParams(params); load();
    MAIN = main;
    const t0 = performance.now();
    main.innerHTML = `<div class="ui-page nw-root">${view()}</div>`;
    wireImages(main);
    window.__news.lastMs = performance.now() - t0;
  }
  const redraw = focusSel => {
    if (SB.tab !== KEY || !MAIN || !MAIN.isConnected) { SB.render(); return; }
    render(MAIN, {});
    if (focusSel) { const el = MAIN.querySelector(focusSel); if (el) el.focus({ preventScroll: true }); }
  };

  // ---------- actions (one listener for the page) ----------
  document.addEventListener('click', e => {
    const root = e.target.closest && e.target.closest('.nw-root'); if (!root) return;
    const pill = e.target.closest('[data-ui-pill^="news-sport|"]');
    if (pill) { const k = pill.dataset.uiPill.split('|')[1]; st.sport = SPN[k] ? k : 'all'; st.shown = PAGE; store.set('news.sport', st.sport); redraw(`[data-ui-pill="news-sport|${st.sport}"]`); return; }
    const sg = e.target.closest('[data-ui-seg^="news-type|"]');
    if (sg) { const k = sg.dataset.uiSeg.split('|')[1]; st.type = k === 'video' ? 'video' : 'all'; st.shown = PAGE; store.set('news.type', st.type); redraw(`[data-ui-seg="news-type|${st.type}"]`); return; }
    const more = e.target.closest('[data-nw-more]');
    if (more) {
      const before = root.querySelectorAll('.nw-grid .nw-card').length; st.shown += PAGE; redraw(null);
      const nx = MAIN && MAIN.querySelectorAll('.nw-grid .nw-card')[before]; const a = nx && nx.querySelector('.nw-go'); if (a) a.focus();
      return;
    }
    const pr = e.target.closest('[data-nw-prop]');
    if (pr) {
      const p = slate().people.get(pr.dataset.nwProp);
      if (p) SB.goTab('propan', { name: p.name, stat: pr.dataset.nwStat || markets(p)[0], gid: p.g.id, team: p.team });
      return;
    }
    const py = e.target.closest('[data-nw-player]');
    if (py) { SB.goTab('players', { name: py.dataset.nwPlayer, sport: py.dataset.nwSport }); return; }
    const gm = e.target.closest('[data-nw-game]');
    if (gm) { SB.goTab('slate', { gid: gm.dataset.nwGame }); return; }
  });

  // ---------- styles ----------
  function css() {
    if (document.getElementById('news-css')) return;
    const s = document.createElement('style'); s.id = 'news-css';
    s.textContent = `
.nw-root{gap:16px}
.nw-root h2{display:block;margin:0;text-wrap:balance}.nw-root h2::before{content:none;display:none}
.nw-honest{margin-top:-6px}
.nw-src{display:flex;flex-wrap:wrap;gap:4px 14px;font-family:var(--fmono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#ffffff80}
.nw-stale{padding:12px 14px;border-radius:14px;border:1px solid rgba(255,184,0,.45);background:linear-gradient(180deg,rgba(255,184,0,.1),rgba(255,184,0,.02));font:400 13.5px/1.45 var(--fui);color:#ffffffd9}
.nw-stale b{color:var(--mid)}
.nw-ctrl{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.nw-ctrl .ui-pills{flex:0 1 auto}
.nw-root .ui-seg button{min-height:40px}
.nw-loading{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:14px}
.nw-loading .sk{height:220px;border-radius:20px;background:linear-gradient(100deg,rgba(255,255,255,.03) 30%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.03) 70%) 0 0/200% 100%;animation:nwsk 1.4s linear infinite}
.nw-loading b{grid-column:1/-1;font:500 14px var(--fui);color:#ffffffa6}
@keyframes nwsk{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.nw-loading .sk{animation:none}}
.nw-media{position:relative;aspect-ratio:16/9;overflow:hidden;background:#070c16}
.nw-tile{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;padding:14px 16px;
 background:radial-gradient(120% 90% at 85% 10%,hsl(var(--h) 80% 45% / .55),transparent 60%),linear-gradient(135deg,hsl(var(--h) 65% 24%),#060a14 78%)}
.nw-tile .nw-tsp{font:900 italic clamp(26px,5vw,40px)/1 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:-.01em;color:#fff}
.nw-tile .nw-tlg{font:600 11px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffffb3}
.nw-media.nw-ok .nw-tile{visibility:hidden}
.nw-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.nw-media::after{content:"";position:absolute;inset:auto 0 0 0;height:45%;background:linear-gradient(0deg,rgba(3,7,18,.7),transparent);pointer-events:none}
.nw-badge{position:absolute;z-index:2;top:10px;left:10px;display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:999px;font:700 10.5px var(--fmono);letter-spacing:.12em;text-transform:uppercase;
 background:rgba(3,7,18,.78);color:#fff;border:1px solid var(--hair2);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.nw-badge.nw-v{color:var(--acc-ink);background:var(--acc2);border-color:transparent}
.nw-plus{position:absolute;z-index:2;top:10px;right:10px;padding:4px 8px;border-radius:999px;font:800 10.5px var(--fui);background:rgba(255,184,0,.9);color:#1d1400}
.nw-play{position:absolute;z-index:2;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;display:grid;place-items:center;border-radius:50%;background:rgba(3,7,18,.6);border:1.5px solid rgba(255,255,255,.7);color:#fff;
 box-shadow:0 0 30px -6px rgba(var(--acc-rgb),.8)}
.nw-feat{display:grid;grid-template-columns:1fr;border-radius:24px;overflow:hidden;border:1px solid rgba(var(--acc-rgb),.35);background:#080d19;
 box-shadow:0 30px 80px -40px rgba(0,0,0,.9),0 0 70px -30px rgba(var(--acc-rgb),.75)}
.nw-feat .nw-play{width:70px;height:70px;margin:-35px 0 0 -35px}
.nw-fbody{display:flex;flex-direction:column;gap:10px;padding:18px;min-width:0}
.nw-fhl{font:800 22px/1.15 'Rubik',sans-serif!important;letter-spacing:-.01em;overflow-wrap:anywhere;margin:0}
@media(min-width:1000px){.nw-feat{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}.nw-feat .nw-media{aspect-ratio:auto;min-height:300px}.nw-fbody{padding:26px;justify-content:center}.nw-fhl{font-size:27px!important}}
.nw-shead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;margin-top:6px}
.nw-h2{font:800 italic 22px/1.1 'Rubik',sans-serif!important;text-transform:uppercase;letter-spacing:-.01em;margin:0}
.nw-slate{display:flex;flex-direction:column;gap:10px;min-width:0}
.nw-srow{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px;scroll-snap-type:x proximity;scrollbar-width:thin;max-width:100%}
.nw-sp{flex:none;scroll-snap-align:start;display:flex;align-items:center;gap:10px;width:min(290px,80vw);min-height:64px;padding:10px 12px;border-radius:16px;border:1px solid var(--hair2);
 background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));color:#fff;text-align:left;cursor:pointer;font:inherit}
.nw-sp:hover{border-color:rgba(var(--acc-rgb),.5)}
.nw-sp .nw-tx{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.nw-sp b{font:700 15px 'Rubik',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-sp .nw-mu{font:500 12px var(--fui);color:#ffffffa6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-sp .nw-mk{font:700 10.5px var(--fmono);letter-spacing:.1em;text-transform:uppercase;color:var(--acc2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-sp .nw-n{flex:none;display:flex;align-items:center;gap:6px;font:600 12px var(--fui);color:#ffffffb3}.nw-sp .nw-n i{font:400 20px var(--fui);color:var(--acc2);font-style:normal}
.nw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}
.nw-card{display:flex;flex-direction:column;min-width:0;border-radius:20px;overflow:hidden;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.012))}
.nw-body{display:flex;flex-direction:column;gap:8px;padding:14px 16px 16px;flex:1;min-width:0}
.nw-meta{display:flex;flex-wrap:wrap;gap:6px;font:600 11px var(--fmono);letter-spacing:.12em;text-transform:uppercase;color:#ffffff8c}
.nw-hl{font:700 17px/1.25 'Rubik',sans-serif!important;letter-spacing:-.005em;margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nw-desc{font:400 14px/1.45 var(--fui);color:#ffffffb3;margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nw-chips{display:flex;flex-wrap:wrap;gap:6px}
.nw-chip{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 12px;border-radius:999px;border:1px solid var(--hair2);background:rgba(255,255,255,.04);color:#ffffffd9;font:600 13px var(--fui);cursor:pointer;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-chip:hover{border-color:rgba(255,255,255,.35)}
.nw-chip.nw-on{border-color:rgba(var(--acc-rgb),.55);background:rgba(var(--acc-rgb),.1);color:#fff}
.nw-chip .nw-dot{width:7px;height:7px;border-radius:50%;background:var(--acc);flex:none}
.nw-chip .nw-tg{font:700 10px var(--fmono);letter-spacing:.1em;text-transform:uppercase;color:var(--acc2)}
.nw-chip.nw-tm{font-family:var(--fmono);font-size:12px;letter-spacing:.06em}
.nw-chip.nw-off{cursor:default;color:#ffffff99;border-style:dashed}
.nw-ft{margin-top:auto;padding-top:4px;display:flex;gap:8px;flex-wrap:wrap}
.nw-go svg{flex:none}
.nw-more{display:flex;justify-content:center;padding:6px 0 10px}
`;
    document.head.appendChild(s);
  }

  window.__news = { lastMs: null, get state() { return { LOAD, n: NEWS ? NEWS.items.length : null, st: { ...st } }; }, slate, matchOf: it => matchOf(it), reload() { LOAD = 'idle'; load(); } };
  SB.on('data', () => { IDX = null; MATCH = new WeakMap(); if (LOAD === 'done' && Date.now() - FETCHED > 3600e3) LOAD = 'idle'; if (drawn()) SB.render(); });
  SB.registerTab({ key: KEY, label: 'Highlights', render });
})();
