// ffb.js: the fantasy football screens (fantasy mode, docs/pro-interface.md screen 7) on the window.SB v2 API.
//   ff-startsit  Start / Sit: 2-4 players side by side (projection, floor / ceiling, matchup, last 3) and a verdict
//   ff-trade     Trade Analyzer: You give up / You receive, rest-of-season values, side totals, net value, trade edge %, verdict
//   ff-rate      Rate My Team: a hand-entered roster (kept on this device), the best lineup with grades, bench, players to look at
//   ff-rank      Rankings: QB / RB / WR / TE / FLEX, this week or rest of season, tiers by gaps
// Data: this season's NFL box scores (season.json via SB.season()) and the NFL games in the feed (SB.DATA) through
// SB.engine.teamCtx. Fantasy points per game: 0.04·pass yd + 4·pass TD + 0.1·rush yd + 6·rush TD + 0.1·rec yd + 6·rec TD
// + catches × 1 (PPR) / .5 (Half) / 0 (Std). Our box scores have no interceptions, fumbles or two-point conversions (footnote).
// Projection = (70% season PPG + 30% last-3 PPG) × matchup factor (teamCtx tf, .85-1.15; 1 when unpriced); 0 with no game this
// week. Rest of season = (70/30 per-game projection, no matchup) × games left. Every number is a model estimate.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function' || !SB.ui) { console.warn('ffb.js: window.SB v2 API or SB.ui not found'); return; }
  const U = SB.ui, esc = U.esc;
  const store = SB.store || { get: (k, d) => d, set() {} };
  const num = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r1 = x => Math.round(x * 10) / 10;
  const f1 = x => (num(x) ? r1(x).toFixed(1) : '—');
  const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '±');
  const cssq = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const nameKey = s => {
    try { if (SB.engine && typeof SB.engine.nameKey === 'function') return SB.engine.nameKey(s); } catch (e) { /* fall through */ }
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  const KEYS = ['ff-startsit', 'ff-trade', 'ff-rate', 'ff-rank'];
  const LABEL = { 'ff-startsit': 'Start / Sit', 'ff-trade': 'Trade Analyzer', 'ff-rate': 'Rate My Team', 'ff-rank': 'Rankings' };
  const SCORE = { ppr: 1, half: 0.5, std: 0 }, SCLAB = { ppr: 'PPR', half: 'Half PPR', std: 'Standard' };
  const POS = ['QB', 'RB', 'WR', 'TE'], FLEXPOS = ['RB', 'WR', 'TE'];
  const STARTERS = { QB: 12, RB: 24, WR: 24, TE: 12 };          // a 12-team league: 1 QB, 2 RB, 2 WR, 1 TE and a FLEX each
  const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
  // NFL weeks here run Wednesday to Tuesday on UTC dates (box-score dates are UTC, so a Monday night game stays in its week);
  // week 1 holds the 2026-09-10 opener. The regular season is 18 weeks with 17 games a team.
  const SEASON0 = Date.UTC(2026, 8, 9), WEEKS = 18, GAMES = 17;
  const W_SEAS = 0.7, W_L3 = 0.3, MING = 3, SMALL = 4, ROSTER_MAX = 18, SIDE_MAX = 5, CMP_MAX = 4, RANK_ROWS = 40;
  const weekOf = ms => Math.floor((ms - SEASON0) / (7 * 864e5)) + 1;
  const dayMs = d => Date.parse(d + 'T12:00:00Z');

  // ---------- state (per-viewer settings and lists live on this device) ----------
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  const idList = (v, max) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.length < 120))].slice(0, max) : []);
  const tradeSaved = (() => { const t = store.get('ff.trade', null); return t && typeof t === 'object' ? t : {}; })();
  const st = {
    scoring: pick(store.get('ff.scoring', 'ppr'), Object.keys(SCORE), 'ppr'),
    ss: idList(store.get('ff.startsit', []), CMP_MAX),
    give: idList(tradeSaved.give, SIDE_MAX),
    get: idList(tradeSaved.get, SIDE_MAX),
    roster: idList(store.get('ff.roster', []), ROSTER_MAX),
    rpos: pick(store.get('ff.rankpos', 'RB'), [...POS, 'FLEX'], 'RB'),
    rwin: pick(store.get('ff.rankwin', 'week'), ['week', 'ros'], 'week'),
    rall: false, q: {}, miss: [], pending: null,
  };
  const MAX = { ss: CMP_MAX, give: SIDE_MAX, get: SIDE_MAX, roster: ROSTER_MAX };
  function save(list) {
    if (list === 'ss') store.set('ff.startsit', st.ss);
    else if (list === 'give' || list === 'get') store.set('ff.trade', { give: st.give, get: st.get });
    else if (list === 'roster') store.set('ff.roster', st.roster);
  }
  const showing = () => KEYS.includes(SB.tab);

  // ---------- season.json and the model ----------
  let SEAS = null, SEAS_ST = 'idle', DV = 0, M = null;
  function needSeason() {
    if (SEAS_ST !== 'idle') return;
    SEAS_ST = 'loading';
    Promise.resolve(typeof SB.season === 'function' ? SB.season() : null)
      .then(d => { SEAS = d && d.sports && typeof d.sports === 'object' ? d : null; })
      .catch(() => { SEAS = null; })
      .then(() => { SEAS_ST = SEAS ? 'ok' : 'none'; M = null; if (showing()) rerender(); });
  }
  const nflData = () => { const S = SEAS && SEAS.sports && SEAS.sports.nfl; return S && Array.isArray(S.players) && Array.isArray(S.fields) ? S : null; };
  function ptsFn(S, sc) {
    const I = f => S.fields.indexOf(f) + 3, per = SCORE[sc] == null ? 1 : SCORE[sc];
    const ix = { pyd: I('pyd'), ptd: I('ptd'), ryd: I('ryd'), rtd: I('rtd'), recyd: I('recyd'), ctd: I('ctd'), rec: I('rec') };
    return r => { const v = i => (i >= 3 ? +r[i] || 0 : 0); return 0.04 * v(ix.pyd) + 4 * v(ix.ptd) + 0.1 * v(ix.ryd) + 6 * v(ix.rtd) + 0.1 * v(ix.recyd) + 6 * v(ix.ctd) + per * v(ix.rec); };
  }
  const pctl = (s, p) => { if (!s.length) return null; const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const byProj = (a, b) => b.proj - a.proj || b.floor - a.floor || b.ppg - a.ppg;
  const byRos = (a, b) => b.ros - a.ros || b.ppg - a.ppg;
  function build() {
    const S = nflData(); if (!S) return null;
    const key = st.scoring + '|' + DV;
    if (M && M.key === key && M.S === S) return M;
    // season.json logs are dated by the game's UTC start date (a Sunday or Monday night game carries the next UTC day), so every
    // date check here is on UTC dates: a logged game counts if it is not after today (UTC) and before his team's next game
    const pts = ptsFn(S, st.scoring), now = Date.now(), W = weekOf(now), todayU = new Date(now).toISOString().slice(0, 10);
    const teams = S.teams && typeof S.teams === 'object' && !Array.isArray(S.teams) ? S.teams : {};
    // each team's games as the box scores saw them: how many, the last one, and whether it played this week
    const tDates = new Map();
    for (const P of S.players) {
      if (!P || !Array.isArray(P.log)) continue;
      let s = tDates.get(P.t); if (!s) tDates.set(P.t, (s = new Set()));
      for (const r of P.log) if (Array.isArray(r) && typeof r[0] === 'string' && r[0] <= todayU) s.add(r[0]);
    }
    const tInfo = {};
    for (const [t, s] of tDates) { const d = [...s].sort(); tInfo[t] = { played: d.length, last: d[d.length - 1] || '', thisWeek: d.some(x => weekOf(dayMs(x)) === W) }; }
    const gamesLeft = t => {
      if (W > WEEKS) return 0;
      const I = tInfo[t], wl = WEEKS - Math.max(W, 1) + 1 - (I && I.thisWeek ? 1 : 0);
      return Math.max(0, Math.min(wl, GAMES - (I ? I.played : 0)));
    };
    // this week: each team's next game in the feed that has not started, within 7 days (feed abbr first, then the name)
    const byName = new Map(Object.entries(teams).map(([a, n]) => [nameKey(n), a]));
    const espn = side => (!side ? null : teams[side.abbr] ? side.abbr : byName.get(nameKey(side.name)) || null);
    const G = ((SB.DATA && SB.DATA.games) || []).filter(g => g && g.sport === 'nfl' && SB.openG(g) && SB.startMs(g) - now <= 7 * 864e5)
      .sort((a, b) => SB.startMs(a) - SB.startMs(b));
    const games = {};
    for (const g of G) for (const [s, o] of [['home', 'away'], ['away', 'home']]) {
      const a = espn(g[s]); if (!a || games[a]) continue;
      let c = null; try { c = SB.engine && SB.engine.teamCtx ? SB.engine.teamCtx(g, g[s].abbr) : null; } catch (e) { c = null; }
      const tf = c && num(c.tf) ? clamp(c.tf, 0.85, 1.15) : null;
      const score = tf == null ? null : clamp(Math.round(50 + 250 * (tf - 1) - 60 * Math.max(0, (num(c.pb) ? c.pb : 0) - 0.15)), 0, 100);
      let when = ''; try { when = SB.when(g); } catch (e) { when = ''; }
      games[a] = { g, home: s === 'home', opp: espn(g[o]) || g[o].abbr, oppName: g[o].name, tf, factor: tf == null ? 1 : tf, score, when };
    }
    const players = [], byId = new Map();
    for (const P of S.players) {
      if (!P || !P.n || !POS.includes(P.pos) || !Array.isArray(P.log)) continue;
      const gm = games[P.t] || null, gd = gm ? String(gm.g.start).slice(0, 10) : null;
      const L = P.log.filter(r => Array.isArray(r) && typeof r[0] === 'string' && r[0] <= todayU && (!gd || r[0] < gd)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (!L.length) continue;
      const gp = L.map(pts), n = gp.length, l3a = gp.slice(-3);
      const ppg = gp.reduce((a, b) => a + b, 0) / n, l3 = l3a.reduce((a, b) => a + b, 0) / l3a.length;
      const base = W_SEAS * ppg + W_L3 * l3, srt = gp.slice().sort((a, b) => a - b), ti = tInfo[P.t];
      const p = {
        id: P.t + '|' + nameKey(P.n), n: String(P.n), t: String(P.t || ''), team: String(teams[P.t] || P.t || ''), pos: P.pos, gp: n, ppg, l3, l3n: l3a.length, base,
        floor: pctl(srt, 0.2), ceil: pctl(srt, 0.8), log: L, pts: gp, gm, proj: gm ? base * gm.factor : 0, left: gamesLeft(P.t),
        missed: !!(ti && ti.last && L[L.length - 1][0] < ti.last),
      };
      p.ros = base * p.left; p.value = Math.round(p.ros);
      p.trend = n >= 4 && Math.abs(l3 - ppg) >= 1 && l3 >= ppg * 1.15 ? 1 : n >= 4 && Math.abs(l3 - ppg) >= 1 && l3 <= ppg * 0.85 ? -1 : 0;
      const prev = byId.get(p.id); if (prev && prev.gp >= p.gp) continue;
      if (prev) players.splice(players.indexOf(prev), 1);
      players.push(p); byId.set(p.id, p);
    }
    // ranks at each position: among players with 3+ games (this week: with a game in the feed)
    const pool = {}, rpool = {};
    for (const pos of POS) {
      pool[pos] = players.filter(p => p.pos === pos && p.proj > 0 && p.gp >= MING).sort(byProj);
      rpool[pos] = players.filter(p => p.pos === pos && p.ros > 0 && p.gp >= MING).sort(byRos);
    }
    for (const p of players) {
      p.rank = p.proj > 0 ? 1 + pool[p.pos].filter(q => q !== p && q.proj > p.proj).length : null;
      p.rosRank = p.ros > 0 ? 1 + rpool[p.pos].filter(q => q !== p && q.ros > p.ros).length : null;
    }
    const weeks = [...new Set(G.map(g => weekOf(SB.startMs(g))))].sort((a, b) => a - b);
    return (M = { key, S, W, weeks, players, byId, games, nGames: G.length, tInfo, pool, rpool, teams });
  }
  function resolve(m, id) {
    if (!m || typeof id !== 'string') return null;
    const p = m.byId.get(id); if (p) return p;
    const k = id.slice(id.indexOf('|') + 1); return k ? m.players.find(x => nameKey(x.n) === k) || null : null;  // a player who changed teams
  }
  function findName(m, name) {
    const k = nameKey(name); if (!k) return null;
    const exact = m.players.filter(p => nameKey(p.n) === k);
    const list = exact.length ? exact : m.players.filter(p => nameKey(p.n).includes(k));
    return list.sort((a, b) => b.ppg - a.ppg)[0] || null;
  }
  function search(m, q, excl) {
    const k = nameKey(q); if (!k) return [];
    const up = String(q).trim().toUpperCase(), out = [];
    for (const p of m.players) {
      if (excl.has(p.id)) continue;
      const nk = nameKey(p.n);
      const s = nk.startsWith(k) ? 3 : nk.includes('-' + k) ? 2 : nk.includes(k) ? 1 : p.t === up || p.pos === up ? 0.5 : -1;
      if (s >= 0) out.push([s, p]);
    }
    return out.sort((a, b) => b[0] - a[0] || b[1].ppg - a[1].ppg).slice(0, 8).map(x => x[1]);
  }

  // ---------- shared pieces ----------
  const posTeam = p => `${p.pos} · ${p.t}`;
  const small = p => (p.gp < SMALL ? ` (${p.gp} game${p.gp === 1 ? '' : 's'}: small sample)` : '');
  const muText = p => (p.gm ? `${p.gm.home ? 'vs' : '@'} ${p.gm.opp}${p.gm.when ? ' · ' + p.gm.when : ''}` : 'No game this week (bye or not in the feed)');
  const muLabel = sc => (sc == null ? 'Not priced yet' : sc >= 60 ? 'Soft matchup' : sc < 40 ? 'Tough matchup' : 'Neutral matchup');
  function trendHTML(p) {
    const t = p.trend, lab = t > 0 ? 'Trending up: last 3 games well above his season average' : t < 0 ? 'Trending down: last 3 games well below his season average' : 'Steady: last 3 games near his season average';
    return `<span class="ffb-tr ${t > 0 ? 'up' : t < 0 ? 'dn' : 'fl'}" role="img" aria-label="${esc(lab)}" title="${esc(lab)}">${t > 0 ? '↑' : t < 0 ? '↓' : '→'}</span>`;
  }
  function weekLine(m) {
    const nt = Object.keys(m.games).length, tot = Object.keys(m.teams).length || 32;
    // the badge names the NFL week(s) of the games in the window (a Monday can hold this week's last game and next week's first)
    const wl = (m.weeks.length ? m.weeks : [m.W]).filter(w => w >= 1 && w <= WEEKS);
    const wk = wl.length ? (wl.length === 1 ? `Week ${wl[0]}` : `Weeks ${wl[0]}-${wl[wl.length - 1]}`) : m.W > WEEKS ? 'Regular season over' : 'Before week 1';
    return `<p class="ffb-wk"><span class="ui-badge">${esc(wk)}</span> ${esc(`${m.nGames} NFL game${m.nGames === 1 ? '' : 's'} in our feed in the next 7 days: ${nt} of ${tot} teams have a game "this week". The rest show 0 (bye, or their game isn't in the feed yet).`)}</p>`;
  }
  const scoringSel = () => U.select({ label: 'Scoring', value: st.scoring, options: Object.keys(SCORE).map(k => [k, SCLAB[k]]), name: 'ff-scoring' });
  const FOOT = () => `<p class="ui-note ffb-foot">${esc(`Fantasy points come from this season's ESPN box scores: 0.04 a passing yard, 4 a passing TD, 0.1 a rushing or receiving yard, 6 a rushing or receiving TD, plus ${SCORE[st.scoring]} a catch (${SCLAB[st.scoring]}). Our data has no interceptions, fumbles, two-point conversions, return TDs, kickers or defenses, so players who throw picks or fumble score a little high here. This week's projection = 70% of his season points per game + 30% of his last 3 games, times a matchup factor from his team's game in our feed (the team's expected points from the game's price vs the league average, 0.85 to 1.15; 1 when the game isn't priced). Floor and ceiling are his 20th and 80th percentile games this season. These are model estimates, not promises, and we don't read NFL injury reports: check who is active before kickoff.`)}</p>`;
  function searchBox(m, list, label, ph) {
    const full = st[list].length >= MAX[list];
    return `<div class="ffb-search"><label class="ffb-ql" for="ffb-q-${list}">${esc(label)}</label>
      <input id="ffb-q-${list}" type="search" class="ffb-q" data-ffb-q="${list}" placeholder="${esc(full ? `Full (${MAX[list]} players): remove one to add another` : ph)}" autocomplete="off" spellcheck="false" enterkeyhint="done" aria-describedby="ffb-qs-${list}" value="${esc(st.q[list] || '')}"${full ? ' disabled' : ''}>
      <div class="ffb-res" data-ffb-res="${list}" role="group" aria-label="Matching players">${resultsHTML(m, list)}</div><span class="ffb-sr" id="ffb-qs-${list}" aria-live="polite">${esc(resultsText(m, list))}</span></div>`;
  }
  function excludeFor(list) { return new Set(list === 'give' || list === 'get' ? [...st.give, ...st.get] : st[list]); }
  const resultsFor = (m, list) => (st.q[list] ? search(m, st.q[list], excludeFor(list)) : []);
  function resultsHTML(m, list) {
    return resultsFor(m, list).map(p => `<button type="button" class="ffb-hit" data-ffb-add="${esc(list + '|' + p.id)}"><b>${esc(p.n)}</b><span>${esc(`${posTeam(p)} · ${f1(p.ppg)} PPG · ${p.gp} g`)}</span></button>`).join('');
  }
  function resultsText(m, list) {
    if (!st.q[list]) return '';
    const n = resultsFor(m, list).length;
    return n ? `${n} matching player${n === 1 ? '' : 's'}` : 'No NFL player matches. Try a last name, a team (DET) or a position (TE).';
  }
  function chips(list, ps) {
    if (!ps.length) return '';
    return `<div class="ffb-chips">${ps.map(p => `<span class="ffb-chip"><span class="nm">${esc(p.n)}</span><small>${esc(posTeam(p))}</small><button type="button" class="ffb-x" data-ffb-rm="${esc(list + '|' + p.id)}" aria-label="${esc('Remove ' + p.n)}">×</button></span>`).join('')}</div>`;
  }
  const listOf = (m, list) => st[list].map(id => resolve(m, id)).filter(Boolean);

  // ---------- Start / Sit ----------
  function ssVerdict(P) {
    const s = P.slice().sort(byProj), A = s[0];
    if (!(A.proj > 0)) return { tone: 'pass', title: 'None of them has a game this week in our feed', pick: null, close: [] };
    const close = s.filter(p => A.proj - p.proj <= 1);
    if (close.length > 1) {
      const X = close.slice().sort((a, b) => b.floor - a.floor || b.proj - a.proj)[0];
      return { tone: 'coin', title: `Coin flip: lean ${X.n}, the higher floor`, pick: X, close, A, B: s[1] };
    }
    return { tone: 'take', title: `Start ${A.n}`, pick: A, close: [A], A, B: s[1] };
  }
  function ssCard(p, v) {
    const role = v.pick === p ? (v.tone === 'coin' ? ['Lean', 'mid', 'pick'] : ['Start', 'good', 'pick']) : v.close.includes(p) ? ['Close call', 'mid', ''] : ['Sit', 'bad', ''];
    const sc = p.gm ? p.gm.score : null, last = p.pts.slice(-5), lab = p.log.slice(-5).map(r => String(r[1] || ''));
    const line = p.proj > 0 ? r1(p.proj) : null, hits = line == null ? null : last.filter(x => x >= line).length;
    return `<article class="ui-card ffb-pc ${role[2]}" data-ffb-card="${esc(p.id)}">
      <div class="ffb-pch">${U.team(p.t)}<div class="ffb-pcn"><b>${esc(p.n)}</b><span class="ffb-mono">${esc(posTeam(p))}${p.rank ? esc(` · ${p.pos} #${p.rank} this week`) : ''}</span></div><span class="ui-badge ${role[1]}">${esc(role[0])}</span></div>
      <div class="ffb-mu">${esc(muText(p))}</div>
      <div class="ffb-projrow"><div><div class="ui-lbl">Projection</div><div class="ui-big ffb-projn">${f1(p.proj)}<small>pts</small></div></div>
        <div class="ffb-msc"><div class="ui-lbl">Matchup</div><b>${sc == null ? '—' : sc}</b>${U.meter(sc)}<span class="tone-${U.tone(sc)}">${esc(muLabel(sc))}</span></div></div>
      ${U.tiles([['Floor', f1(p.floor)], ['Ceiling', f1(p.ceil)], ['Season PPG', f1(p.ppg)], [`Last ${p.l3n}`, f1(p.l3)]])}
      ${U.gameLog({ title: `Last ${last.length} games (pts)`, summary: hits == null ? '' : `${hits} of ${last.length} at or above ${f1(line)}`, vals: last.map(r1), labels: lab, line })}
      <p class="ui-note">${esc(`Floor / ceiling from ${p.gp} game${p.gp === 1 ? '' : 's'} this season${p.gp < SMALL ? ' (small sample)' : ''}.`)}${p.missed ? ` <span class="ffb-warn">${esc('⚠ No stats in his team\'s last game (out, inactive or no touches): check his status.')}</span>` : ''}</p>
      <div><button type="button" class="ui-ghost sm" data-ffb-rm="${esc('ss|' + p.id)}" aria-label="${esc('Remove ' + p.n + ' from the comparison')}">Remove</button></div>
    </article>`;
  }
  function viewStartSit(m) {
    const P = listOf(m, 'ss');
    let h = `<div class="ui-row ffb-ctl">${scoringSel()}</div>${weekLine(m)}
      <section class="ui-card ffb-pickcard">${searchBox(m, 'ss', `Add a player to compare (${P.length} of ${CMP_MAX})`, 'Search NFL players: name, team or position')}${chips('ss', P)}</section>`;
    if (P.length < 2) {
      h += `<div class="ui-empty">${esc(P.length ? 'Add one more player to get a verdict.' : 'Pick two to four players you are choosing between for one lineup spot.')}<div style="margin-top:12px"><button type="button" class="ui-ghost sm" data-ffb-act="example-ss">Try an example</button></div></div>`;
      return h + FOOT();
    }
    const v = ssVerdict(P);
    const kick = `Start / sit verdict · ${SCLAB[st.scoring]}`;
    const why = v.A && v.B ? `${v.A.n} ${f1(v.A.proj)} vs ${v.B.n} ${f1(v.B.proj)} projected points (${sgn(v.A.proj - v.B.proj)}${f1(Math.abs(v.A.proj - v.B.proj))})` +
      (v.tone === 'coin' ? `. Within a point, so the tie-break is the higher floor: ${v.pick.n}'s 20th percentile game is ${f1(v.pick.floor)}.` : '.') : 'Nobody here plays in the next 7 days in our feed.';
    h += `<section class="ffb-vd" aria-label="Verdict">${U.verdict({ tone: v.tone, kicker: kick, title: v.title, tag: 'model estimate' })}<p class="ui-muted ffb-why">${esc(why)}</p></section>`;
    h += `<div class="ffb-cards">${P.slice().sort(byProj).map(p => ssCard(p, v)).join('')}</div>`;
    return h + FOOT();
  }

  // ---------- Trade Analyzer ----------
  function band(e) {
    if (e >= 15) return { k: 'strong-accept', label: 'Strong accept', tone: 'good' };
    if (e >= 5) return { k: 'accept', label: 'Accept', tone: 'good' };
    if (e > -5) return { k: 'fair', label: 'Fair', tone: 'mid' };
    if (e > -15) return { k: 'decline', label: 'Decline', tone: 'bad' };
    return { k: 'strong-decline', label: 'Strong decline', tone: 'bad' };
  }
  function tradeMath(G, R) {
    const give = G.reduce((a, p) => a + p.value, 0), get = R.reduce((a, p) => a + p.value, 0), net = get - give;
    const edge = give > 0 ? Math.round(net * 1000 / give) / 10 : null;
    return { give, get, net, edge, band: edge == null ? null : band(edge) };
  }
  function tradeSide(m, list, title, P, total) {
    const rows = P.map(p => `<div class="ffb-prow"><div class="who"><b>${esc(p.n)}</b><span class="ffb-mono">${esc(posTeam(p))}</span><small>${esc(p.left ? `${f1(p.base)} pts a game × ${p.left} game${p.left === 1 ? '' : 's'} left${small(p)}` : 'No games left this season')}${p.missed ? ' · ⚠ no stats in his team\'s last game' : ''}</small></div><span class="v"><span class="ffb-sr">value </span>${esc(p.value)}</span><button type="button" class="ffb-x" data-ffb-rm="${esc(list + '|' + p.id)}" aria-label="${esc('Remove ' + p.n)}">×</button></div>`).join('');
    return `<section class="ffb-side ${list}" aria-label="${esc(title)}"><div class="ui-lbl ffb-sideh">${esc(title)}</div>
      <div class="ffb-plist">${rows || `<div class="ffb-slot">${esc(list === 'give' ? 'No players yet: add who you would send.' : 'No players yet: add who you would get back.')}</div>`}</div>
      ${searchBox(m, list, list === 'give' ? 'Add a player you give up' : 'Add a player you receive', 'Search NFL players')}
      <div class="ffb-tot"><span class="ui-lbl">Trade value</span><span class="ffb-num" data-ffb-total="${list}">${esc(total)}</span></div></section>`;
  }
  function tradeVerdict(T) {
    const b = T.band, pos = 50 + clamp(T.edge, -50, 50), side = T.edge > 0 ? 'favors you' : T.edge < 0 ? 'favors them' : 'even';
    return `<section class="ffb-tv ${b.tone}" data-ffb-band="${b.k}" aria-label="Trade verdict"><div class="ui-lbl">Trade verdict · model estimate</div>
      <div class="ffb-tvrow"><div class="ffb-tvt">${esc(b.label)}</div><div class="ffb-edge"><span class="ffb-edn">${esc(sgn(T.edge) + Math.abs(T.edge).toFixed(1))}<small>%</small></span><span class="ffb-edl">Trade<br>edge</span></div></div>
      <div class="ffb-track" role="img" aria-label="${esc(`Trade edge ${sgn(T.edge)}${Math.abs(T.edge).toFixed(1)}%: ${side}`)}"><i style="left:${pos.toFixed(1)}%"></i></div>
      <div class="ffb-trl"><span>Favors them</span><span class="net">${esc(`${sgn(T.net)}${Math.abs(T.net)} net value`)}</span><span>Favors you</span></div></section>`;
  }
  function viewTrade(m) {
    const G = listOf(m, 'give'), R = listOf(m, 'get'), T = tradeMath(G, R);
    let h = `<div class="ui-row ffb-ctl">${scoringSel()}${G.length || R.length ? '<button type="button" class="ui-ghost sm" data-ffb-act="swap">⇄ Swap sides</button><button type="button" class="ui-ghost sm" data-ffb-act="clear|trade">Clear</button>' : '<button type="button" class="ui-ghost sm" data-ffb-act="example-trade">Try an example</button>'}</div>`;
    if (st.miss.length) h += `<p class="ui-note ffb-warn">${esc(`Couldn't find ${st.miss.join(', ')} among this season's NFL players.`)}</p>`;
    h += `<div class="ffb-trade">${tradeSide(m, 'give', 'You give up', G, T.give)}<div class="ffb-orb" aria-hidden="true"><span></span><em>Trade finder</em></div>${tradeSide(m, 'get', 'You receive', R, T.get)}</div>`;
    if (!G.length || !R.length) h += U.empty('Add at least one player to each side to grade the trade.');
    else if (T.edge == null) h += U.empty("Can't grade it: the players you give up have no value left this season in our data.");
    else h += tradeVerdict(T);
    h += `<p class="ui-note">${esc(`Value = rest-of-season fantasy points (${SCLAB[st.scoring]}): his per-game projection (70% season, 30% last 3, no matchup) times his team's games left. Games left come from the 18-week regular season (17 games a team, from Sep 10). We can't see bye weeks, so we count them from games played: 17 minus the games his team has played in our box scores, capped by the weeks left (a missing box score would make it one too high). Trade edge = (receive − give) ÷ give. It doesn't know your league's roster needs, keeper or dynasty value, or draft picks: a model estimate, not advice to accept.`)}</p>`;
    return h + FOOT();
  }

  // ---------- Rate My Team ----------
  const GP = { 'A+': 4.3, A: 4, B: 3, C: 2, D: 1, F: 0 };
  function gradeOf(p) {
    if (!p || !(p.proj > 0) || !p.rank) return 'F';
    const r = p.rank / STARTERS[p.pos];
    return r <= 0.125 ? 'A+' : r <= 0.25 ? 'A' : r <= 0.5 ? 'B' : r <= 0.75 ? 'C' : r <= 1 ? 'D' : 'F';
  }
  const overallOf = g => (g >= 4.15 ? 'A+' : g >= 3.5 ? 'A' : g >= 2.5 ? 'B' : g >= 1.5 ? 'C' : g >= 0.5 ? 'D' : 'F');
  const gcls = g => (g[0] === 'A' ? 'good' : g === 'B' ? 'acc' : g === 'C' ? 'mid' : 'bad');
  function lineup(P) {
    const left = P.slice().sort(byProj), take = pos => { const i = left.findIndex(p => pos.includes(p.pos)); return i < 0 ? null : left.splice(i, 1)[0]; };
    const slots = [];
    for (const s of SLOTS) if (s !== 'FLEX') slots.push({ slot: s, p: take([s]) });
    slots.push({ slot: 'FLEX', p: take(FLEXPOS) });
    for (const x of slots) x.grade = gradeOf(x.p);
    const gpa = slots.reduce((a, x) => a + GP[x.grade], 0) / slots.length;
    return { slots, bench: left, gpa, grade: overallOf(gpa), total: slots.reduce((a, x) => a + (x.p ? x.p.proj : 0), 0) };
  }
  function viewRate(m) {
    const P = listOf(m, 'roster');
    let h = `<div class="ui-row ffb-ctl">${scoringSel()}${P.length ? '<button type="button" class="ui-ghost sm" data-ffb-act="clear|roster">Clear roster</button>' : '<button type="button" class="ui-ghost sm" data-ffb-act="example-roster">Load an example roster</button>'}</div>${weekLine(m)}
      <section class="ui-card ffb-pickcard"><div class="ffb-rhead"><b>Your roster</b><span class="ui-badge">${P.length} / ${ROSTER_MAX}</span></div>${searchBox(m, 'roster', 'Add a player to your roster', 'Search NFL players: name, team or position')}${chips('roster', P)}
      <p class="ui-note">${esc('Saved on this device only. League sync (ESPN, Sleeper, Yahoo) is not available: it needs your league logins and sites this app does not reach, so enter your players by hand.')}</p></section>`;
    if (!P.length) return h + U.empty('Add your players (up to 18) to see your best lineup, a grade for each spot and who to look at.') + FOOT();
    const L = lineup(P), starters = L.slots.filter(x => x.p);
    const worst = L.slots.slice().sort((a, b) => GP[a.grade] - GP[b.grade])[0], best = L.slots.slice().sort((a, b) => GP[b.grade] - GP[a.grade])[0];
    h += `<section class="ui-card ffb-overall"><div class="ffb-gbig ${gcls(L.grade)}"><span class="ffb-sr">Overall grade </span>${esc(L.grade)}</div><div><div class="ui-lbl">Overall grade · ${esc(SCLAB[st.scoring])}</div>
      <div class="ffb-ovt">${esc(`${f1(L.total)} projected points this week`)}</div>
      <p class="ui-muted">${esc(`Strongest spot: ${best.slot} (${best.grade}). Weakest: ${worst.slot} (${worst.grade}${worst.p ? '' : ', empty'}). Each starter is graded on his rank at his position this week, as a 12-team league with 1 QB, 2 RB, 2 WR, 1 TE and a FLEX would see it.`)}</p></div></section>`;
    const row = x => {
      const p = x.p;
      return `<div class="ffb-lu"><span class="ffb-slotb">${esc(x.slot)}</span><div class="who">${p ? `<b>${esc(p.n)}</b><span>${esc(`${posTeam(p)} · ${muText(p)}${p.rank ? ` · ${p.pos} #${p.rank}` : ''}`)}</span>${p.missed ? `<span class="ffb-warn">${esc('⚠ No stats in his team\'s last game')}</span>` : ''}` : `<b class="ffb-dim">Empty</b><span>${esc(`No ${x.slot === 'FLEX' ? 'RB, WR or TE' : x.slot} left on your roster`)}</span>`}</div>
        <span class="ffb-lup">${p ? f1(p.proj) : '—'}</span><span class="ffb-g ${gcls(x.grade)}"><span class="ffb-sr">grade </span>${esc(x.grade)}</span></div>`;
    };
    h += `<div class="ffb-two"><section class="ui-card"><div class="ffb-rhead"><b>Best lineup this week</b><span class="ui-lbl">Proj · grade</span></div><div class="ffb-lus">${L.slots.map(row).join('')}</div></section>`;
    h += `<section class="ui-card"><div class="ffb-rhead"><b>Bench</b><span class="ui-lbl">Proj</span></div><div class="ffb-lus">${L.bench.length ? L.bench.map(p => `<div class="ffb-lu"><span class="ffb-slotb dim">BN</span><div class="who"><b>${esc(p.n)}</b><span>${esc(`${posTeam(p)} · ${muText(p)}`)}</span></div><span class="ffb-lup">${f1(p.proj)}</span></div>`).join('') : `<p class="ui-muted">${esc('Nobody on the bench.')}</p>`}</div></section></div>`;
    // players to look at: the highest projections this week not on your roster, against the starter they would replace
    const mine = new Set(P.map(p => p.id)), starterAt = pos => {
      const c = L.slots.filter(x => x.slot === pos || (x.slot === 'FLEX' && FLEXPOS.includes(pos)));
      return c.sort((a, b) => (a.p ? a.p.proj : -1) - (b.p ? b.p.proj : -1))[0];
    };
    const look = m.players.filter(p => !mine.has(p.id) && p.proj > 0 && p.gp >= MING).sort(byProj).slice(0, 8);
    h += `<section class="ui-card"><div class="ffb-rhead"><b id="ffb-look" tabindex="-1">Players to look at</b><span class="ui-lbl">Proj</span></div><div class="ffb-lus">${look.map(p => {
      const s = starterAt(p.pos), d = s ? p.proj - (s.p ? s.p.proj : 0) : 0;
      const up = s && d > 0.05 ? `${sgn(d)}${f1(Math.abs(d))} over your ${s.slot}${s.p ? ` (${s.p.n})` : ' (empty)'}` : 'Would sit behind your starters';
      return `<div class="ffb-lu"><span class="ffb-slotb dim">${esc(p.pos)}</span><div class="who"><b>${esc(p.n)}</b><span>${esc(`${p.t} · ${muText(p)} · ${up}`)}</span></div><span class="ffb-lup">${f1(p.proj)}</span>
        <span class="ffb-acts">${P.length < ROSTER_MAX ? `<button type="button" class="ui-ghost sm" data-ffb-add="${esc('roster|' + p.id)}" aria-label="${esc('Add ' + p.n + ' to your roster')}">Add</button>` : ''}${s && s.p && d > 0.05 ? `<button type="button" class="ui-ghost sm" data-ffb-act="${esc('cmp|' + p.id + '|' + s.p.id)}" aria-label="${esc(`Compare ${p.n} with ${s.p.n} in Start / Sit`)}">Compare</button>` : ''}</span></div>`;
    }).join('')}</div>
      <p class="ui-note">${esc("We can't see your league's free agents, so most of these are probably on other rosters: check your waiver wire. Ranked by this week's projection among players with 3+ games.")}</p></section>`;
    return h + FOOT();
  }

  // ---------- Rankings ----------
  function tiers(vals) {
    const out = new Array(vals.length).fill(1); if (vals.length < 3) return out;
    const gaps = vals.slice(1).map((v, i) => vals[i] - v), mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const T = Math.max(mean * 2, Math.abs(vals[0]) * 0.03, 0.3);
    let t = 1; for (let i = 1; i < vals.length; i++) { if (gaps[i - 1] >= T && t < 9) t++; out[i] = t; }
    return out;
  }
  function viewRank(m) {
    const ros = st.rwin === 'ros', posL = st.rpos === 'FLEX' ? FLEXPOS : [st.rpos];
    const all = m.players.filter(p => posL.includes(p.pos));
    const ok = all.filter(p => p.gp >= MING && (ros ? p.ros > 0 : p.proj > 0)).sort(ros ? byRos : byProj);
    const noGame = all.filter(p => p.gp >= MING && !(ros ? p.ros > 0 : p.proj > 0)).length, few = all.filter(p => p.gp < MING).length;
    const rows = st.rall ? ok : ok.slice(0, RANK_ROWS), tv = tiers(rows.map(p => (ros ? p.ros : p.proj)));
    const cols = ['#', 'Player', 'Team', ros ? 'ROS pts' : 'Proj', ...(ros ? ['Games left'] : []), 'PPG', 'Last 3', 'Matchup', 'Trend'];
    let body = '', lastT = 0;
    rows.forEach((p, i) => {
      if (tv[i] !== lastT) { lastT = tv[i]; body += `<tr class="ffb-tier"><td colspan="${cols.length}">Tier ${lastT}</td></tr>`; }
      const sc = p.gm ? p.gm.score : null;
      body += `<tr><td class="ffb-rk">${i + 1}</td><td class="ffb-pl"><span class="pn">${esc(p.n)}</span><span class="pt">${esc(p.pos)}${p.gp < SMALL ? ` · ${p.gp} g` : ''}${p.missed ? ' · ⚠ no stats last game' : ''}</span></td><td>${esc(p.t)}</td>
        <td class="ffb-pj">${ros ? esc(p.value) : f1(p.proj)}</td>${ros ? `<td>${esc(p.left)}</td>` : ''}<td>${f1(p.ppg)}</td><td>${f1(p.l3)}</td>
        <td class="ffb-mcell">${p.gm ? `${esc(`${p.gm.home ? 'vs' : '@'} ${p.gm.opp}`)} <b class="tone-${U.tone(sc)}">${sc == null ? '—' : esc(sc)}</b>` : '<span class="ffb-dim">no game</span>'}</td><td>${trendHTML(p)}</td></tr>`;
    });
    const pills = U.pills([...POS, 'FLEX'].map(k => ({ k, label: k })), st.rpos, 'ff-rpos');
    const seg = U.seg([{ k: 'week', label: 'This week' }, { k: 'ros', label: 'Rest of season' }], st.rwin, 'ff-rwin');
    let h = `${pills}<div class="ui-row ffb-ctl">${scoringSel()}${seg}</div>${weekLine(m)}`;
    if (!rows.length) h += U.empty(ros ? 'No player at this position has games left with 3+ games played.' : 'No player at this position has a game in our feed in the next 7 days.');
    else {
      h += `<div class="ui-tablewrap"><table class="ui-table ffb-rt"><caption class="ffb-sr">${esc(`${st.rpos} rankings, ${ros ? 'rest of season' : 'this week'}, ${SCLAB[st.scoring]}`)}</caption><thead><tr>${cols.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
      if (ok.length > RANK_ROWS) h += `<div><button type="button" class="ui-ghost sm" data-ffb-act="rall" aria-expanded="${st.rall}">${esc(st.rall ? `Show the top ${RANK_ROWS}` : `Show all ${ok.length}`)}</button></div>`;
    }
    h += `<p class="ui-note">${esc(`${ros ? 'Rest of season = per-game projection (70% season, 30% last 3, no matchup) times his team\'s games left (17 a team; byes counted from games played, which we can\'t see directly). ' : 'This week = his team\'s next game in our feed within 7 days; matchup is a 0-100 estimate from the game\'s price ("—" when the game isn\'t priced). '}Tiers break where the gap to the next player is unusually big. Left out: ${noGame} with ${ros ? 'no games left' : 'no game this week'} and ${few} with fewer than ${MING} games (too small a sample). Trend compares his last 3 games with his season average.`)}</p>`;
    return h + FOOT();
  }

  // ---------- params, examples, render ----------
  const seen = new WeakSet();
  function takeParams(key, params) {
    if (!params || typeof params !== 'object' || seen.has(params)) return;
    seen.add(params);
    if (key === 'ff-trade' && (params.give != null || params.get != null)) {
      const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => String(x)).filter(Boolean).slice(0, SIDE_MAX);
      st.pending = { give: arr(params.give), get: arr(params.get) };
    }
  }
  function applyPending(m) {
    if (!st.pending || !m) return;
    const miss = [], res = names => { const out = []; for (const n of names) { const p = findName(m, n); if (p && !out.includes(p.id)) out.push(p.id); else if (!p) miss.push(n); } return out; };
    st.give = res(st.pending.give); st.get = res(st.pending.get).filter(id => !st.give.includes(id));
    st.miss = miss; st.pending = null; save('give');
  }
  function example(m, kind) {
    const pool = pos => m.players.filter(p => p.pos === pos && p.gp >= MING && p.proj > 0).sort(byProj);
    const rpool = pos => m.players.filter(p => p.pos === pos && p.gp >= MING && p.ros > 0).sort(byRos);
    const at = (arr, idx) => idx.map(i => arr[Math.min(i, arr.length - 1)]).filter(Boolean).map(p => p.id);
    if (kind === 'ss') { let ids = at(pool('WR'), [2, 3]); if (new Set(ids).size < 2) ids = m.players.filter(p => p.gp >= MING).sort((a, b) => b.proj - a.proj || b.ppg - a.ppg).slice(0, 2).map(p => p.id); st.ss = [...new Set(ids)]; save('ss'); }
    if (kind === 'trade') {  // a 1-for-1: a WR for the RB worth about 10% more
      const w = rpool('WR'), g = w[Math.min(8, w.length - 1)]; if (!g) return;
      const r = rpool('RB').filter(p => p.id !== g.id).sort((a, b) => Math.abs(a.value - g.value * 1.1) - Math.abs(b.value - g.value * 1.1))[0];
      st.give = [g.id]; st.get = r ? [r.id] : []; st.miss = []; save('give');
    }
    if (kind === 'roster') {
      const src = pos => m.players.filter(p => p.pos === pos && p.gp >= MING).sort((a, b) => b.ppg - a.ppg);
      st.roster = [...new Set([...at(src('QB'), [6, 15]), ...at(src('RB'), [5, 14, 22, 30]), ...at(src('WR'), [4, 12, 20, 28, 36]), ...at(src('TE'), [7, 16])])].slice(0, ROSTER_MAX); save('roster');
    }
  }
  const VIEW = { 'ff-startsit': viewStartSit, 'ff-trade': viewTrade, 'ff-rate': viewRate, 'ff-rank': viewRank };
  const HEAD = {
    'ff-startsit': { kicker: 'Fantasy football · Start / sit', title: 'Start or', accent: 'sit?', sub: 'Put the players you are torn between side by side: this week\'s projection, floor and ceiling, the matchup and recent form, and a call.' },
    'ff-trade': { kicker: 'Fantasy football · Trade analyzer', title: 'Grade the', accent: 'trade', sub: 'Add what you give up and what you get back. Each player is worth his projected fantasy points for the rest of the season.' },
    'ff-rate': { kicker: 'Fantasy football · Team analyzer', title: 'Rate my', accent: 'team', sub: 'Enter your roster to get your best lineup this week, a grade for every spot, your bench and players worth a look.' },
    'ff-rank': { kicker: 'Fantasy football · Rankings', title: 'Fantasy', accent: 'rankings', sub: 'Every NFL player ranked by this week\'s projection or rest-of-season points, in tiers, with form and matchup.' },
  };
  function draw(key, main, params) {
    ensureCss();
    if (SB.mode !== 'fantasy' && typeof SB.setMode === 'function' && SB.tab === key) { try { SB.setMode('fantasy'); } catch (e) { /* the shell keeps its mode */ } }
    takeParams(key, params);
    needSeason();
    let body;
    if (SEAS_ST === 'idle' || SEAS_ST === 'loading') body = `<div class="ui-empty" aria-busy="true">${esc("Loading this season's NFL box scores…")}</div>`;
    else {
      const m = build();
      if (!m) body = U.empty("This season's NFL box scores (season.json) didn't load, so there is nothing to project. Try again in a minute.");
      else { applyPending(m); body = VIEW[key](m); }
    }
    main.innerHTML = `<div class="ui-page ffb-root" data-ffb="${esc(key)}">${U.page(HEAD[key])}${body}</div>`;
  }
  function rerender(focusSel) {
    const main = document.getElementById('main');
    if (!main || !showing()) return;
    const y = window.scrollY;
    draw(SB.tab, main, null);
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
    if (focusSel) { try { const el = main.querySelector(focusSel); if (el && !el.disabled) el.focus({ preventScroll: el.id !== 'ffb-look' }); else { const q = main.querySelector('.ffb-q:not([disabled])'); if (q) q.focus({ preventScroll: true }); } } catch (e) { /* no focus target */ } }
  }

  // ---------- events (delegated, only inside .ffb-root) ----------
  function addTo(list, id) {
    if (!MAX[list] || st[list].includes(id)) return false;
    if (st[list].length >= MAX[list]) { if (SB.toast) SB.toast(`That list is full (${MAX[list]}): remove a player first.`); return false; }
    if (list === 'give') st.get = st.get.filter(x => x !== id);
    if (list === 'get') st.give = st.give.filter(x => x !== id);
    st[list].push(id); st.q[list] = ''; save(list); return true;
  }
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('.ffb-root button') : null; if (!b) return;
    const pill = b.getAttribute('data-ui-pill'), seg = b.getAttribute('data-ui-seg');
    if (pill && pill.startsWith('ff-rpos|')) { st.rpos = pick(pill.split('|')[1], [...POS, 'FLEX'], 'RB'); st.rall = false; store.set('ff.rankpos', st.rpos); rerender(`[data-ui-pill="${cssq(pill)}"]`); return; }
    if (seg && seg.startsWith('ff-rwin|')) { st.rwin = pick(seg.split('|')[1], ['week', 'ros'], 'week'); store.set('ff.rankwin', st.rwin); rerender(`[data-ui-seg="${cssq(seg)}"]`); return; }
    const add = b.getAttribute('data-ffb-add');
    if (add) { const i = add.indexOf('|'), list = add.slice(0, i); addTo(list, add.slice(i + 1)); rerender(b.closest('.ffb-search') ? `[data-ffb-q="${cssq(list)}"]` : '#ffb-look'); return; }
    const rm = b.getAttribute('data-ffb-rm');
    if (rm) {
      const i = rm.indexOf('|'), list = rm.slice(0, i), id = rm.slice(i + 1);
      if (!MAX[list]) return;
      const at = st[list].indexOf(id); st[list] = st[list].filter(x => x !== id); save(list);
      const next = st[list][Math.min(at, st[list].length - 1)];
      rerender(next ? `[data-ffb-rm="${cssq(list + '|' + next)}"]` : `[data-ffb-q="${cssq(list)}"]`);
      return;
    }
    const act = b.getAttribute('data-ffb-act'); if (!act) return;
    const m = build();
    if (act.startsWith('example-') && m) { example(m, act.slice(8)); rerender('[data-ffb-rm]'); return; }
    if (act === 'swap') { const g = st.give; st.give = st.get; st.get = g; save('give'); rerender('[data-ffb-act="swap"]'); return; }
    if (act === 'clear|trade') { st.give = []; st.get = []; st.miss = []; save('give'); rerender('[data-ffb-q="give"]'); return; }
    if (act === 'clear|roster') { st.roster = []; save('roster'); rerender('[data-ffb-q="roster"]'); return; }
    if (act === 'rall') { st.rall = !st.rall; rerender('[data-ffb-act="rall"]'); return; }
    if (act.startsWith('cmp|')) {  // cmp|TEAM|name|TEAM|name: a player to look at vs the starter he would replace
      const x = act.split('|'); if (x.length !== 5) return;
      st.ss = [x[1] + '|' + x[2], x[3] + '|' + x[4]]; save('ss'); SB.goTab('ff-startsit', {});
    }
  });
  document.addEventListener('change', e => {
    const s = e.target; if (!s || !s.matches || !s.matches('.ffb-root select[data-ui-select="ff-scoring"]')) return;
    st.scoring = pick(s.value, Object.keys(SCORE), 'ppr'); store.set('ff.scoring', st.scoring); M = null;
    rerender('select[data-ui-select="ff-scoring"]');
  });
  document.addEventListener('input', e => {
    const t = e.target; if (!t || !t.matches || !t.matches('.ffb-root input[data-ffb-q]')) return;
    const list = t.getAttribute('data-ffb-q'), m = build(); if (!m || !MAX[list]) return;
    st.q[list] = t.value.slice(0, 60);
    const box = t.closest('.ffb-search'), r = box && box.querySelector('[data-ffb-res]'), s = box && box.querySelector('.ffb-sr');
    if (r) r.innerHTML = resultsHTML(m, list);
    if (s) s.textContent = resultsText(m, list);
  });
  document.addEventListener('keydown', e => {
    const t = e.target; if (!t || !t.matches || !t.matches('.ffb-root input[data-ffb-q]')) return;
    const box = t.closest('.ffb-search'), first = box && box.querySelector('.ffb-hit');
    if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
    else if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
    else if (e.key === 'Escape' && t.value) { e.preventDefault(); e.stopPropagation(); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); }
  });

  // ---------- styles (once) ----------
  function ensureCss() {
    if (document.getElementById('ffb-css')) return;
    const s = document.createElement('style'); s.id = 'ffb-css';
    s.textContent = `
.ffb-root{--tvc:0,212,146}
.ffb-root .ffb-ctl{gap:10px}
.ffb-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ffb-wk{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:400 13px/1.45 var(--fui);color:#ffffff99}
.ffb-mono{font:700 11px var(--fmono);letter-spacing:.1em;text-transform:uppercase;color:#ffffff80}
.ffb-dim{color:#ffffff73}
.ffb-warn{color:var(--mid)}
.ffb-pickcard{display:flex;flex-direction:column;gap:12px}
.ffb-search{display:flex;flex-direction:column;gap:8px;min-width:0}
.ffb-ql{font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;color:#ffffff80}
.ffb-q{width:100%;min-height:46px;padding:0 14px;border-radius:12px;border:1px solid var(--hair2);background:rgba(255,255,255,.03);color:#fff;font:500 16px var(--fui);outline:none}
.ffb-q:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--acc-rgb),.18)}
.ffb-q:disabled{opacity:.55}
.ffb-res{display:flex;flex-direction:column;gap:4px}.ffb-res:empty{display:none}
.ffb-hit{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:44px;padding:6px 12px;border-radius:10px;border:1px solid var(--hair);background:rgba(255,255,255,.03);color:#fff;text-align:left;cursor:pointer;font:600 14px var(--fui);min-width:0}
.ffb-hit b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ffb-hit span{flex:none;font:500 12px var(--fui);color:#ffffffa6;white-space:nowrap}
.ffb-hit:hover,.ffb-hit:focus-visible{border-color:rgba(var(--acc-rgb),.6);background:rgba(var(--acc-rgb),.08)}
.ffb-chips{display:flex;flex-wrap:wrap;gap:6px}
.ffb-chip{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 2px 0 12px;border-radius:999px;border:1px solid rgba(var(--acc-rgb),.4);background:rgba(var(--acc-rgb),.1);font:600 13.5px var(--fui);max-width:100%;min-width:0}
.ffb-chip .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ffb-chip small{flex:none;color:#ffffffa6;font:500 11.5px var(--fui)}
.ffb-x{flex:none;width:40px;height:40px;border-radius:50%;border:0;background:none;color:#ffffffb3;font:600 19px var(--fui);cursor:pointer}
.ffb-x:hover{background:rgba(255,255,255,.08);color:#fff}
.ffb-why{margin-top:8px}
.ffb-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:14px}
.ffb-pc{display:flex;flex-direction:column;gap:12px}
.ffb-pc.pick{border-color:rgba(var(--acc-rgb),.6);box-shadow:0 0 50px -26px rgba(var(--acc-rgb),.9)}
.ffb-pch{display:flex;align-items:flex-start;gap:12px}
.ffb-pcn{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ffb-pcn b{font:800 19px/1.1 'Rubik',sans-serif;overflow-wrap:anywhere}
.ffb-mu{font:600 13px var(--fui);color:#ffffffcc}
.ffb-projrow{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:end}
.ffb-projn{font-size:40px}
.ffb-msc{display:flex;flex-direction:column;gap:5px;min-width:0}
.ffb-msc b{font:800 20px 'Rubik',sans-serif}.ffb-msc span{font:600 12.5px var(--fui)}
.ffb-pc .ui-card{padding:12px}
.ffb-trade{display:grid;grid-template-columns:1fr;gap:18px;align-items:start}
.ffb-orb{display:none}
@media(min-width:1100px){.ffb-trade{grid-template-columns:1fr 150px 1fr}
 .ffb-orb{display:flex;flex-direction:column;align-items:center;gap:12px;padding-top:70px}
 .ffb-orb span{width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(var(--acc-rgb),.55),transparent 60%),repeating-radial-gradient(circle at 50% 50%,rgba(var(--acc-rgb),.5) 0 1.5px,transparent 1.5px 6px);box-shadow:0 0 60px -10px rgba(var(--acc-rgb),.6)}
 .ffb-orb em{font:600 10.5px var(--fmono);letter-spacing:.2em;text-transform:uppercase;font-style:normal;color:var(--acc)}}
.ffb-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.ffb-sideh{padding:0 4px}
.ffb-plist{display:flex;flex-direction:column;gap:10px}
.ffb-slot{padding:18px 16px;border-radius:14px;border:1px dashed var(--hair2);color:#ffffff8c;font:400 13.5px var(--fui)}
.ffb-prow{display:flex;align-items:center;gap:8px;min-height:64px;padding:10px 4px 10px 16px;border-radius:14px;border:1px solid var(--hair2);background:#0a1120}
.ffb-side.get .ffb-prow{border-color:rgba(var(--acc-rgb),.55);background:linear-gradient(180deg,rgba(var(--acc-rgb),.08),rgba(var(--acc-rgb),.02)),#0a1120}
.ffb-prow .who{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ffb-prow .who b{font:700 16px 'Rubik',sans-serif;overflow-wrap:anywhere}
.ffb-prow .who small{font:400 12px var(--fui);color:#ffffff8c}
.ffb-prow .v{flex:none;font:800 21px 'Rubik',sans-serif;font-variant-numeric:tabular-nums;padding-left:6px}
.ffb-side.get .ffb-prow .v{color:var(--acc)}
.ffb-tot{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 6px 0}
.ffb-num{font:900 italic 54px/1 'Rubik',sans-serif;letter-spacing:-.02em;font-variant-numeric:tabular-nums;padding-right:.06em}
.ffb-side.get .ffb-num{background:var(--acc-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.ffb-tv{--tvc:0,212,146;display:flex;flex-direction:column;gap:14px;padding:20px 22px;border-radius:24px;border:1px solid rgba(var(--tvc),.5);background:linear-gradient(180deg,rgba(var(--tvc),.1),rgba(var(--tvc),.02)),#050b12;box-shadow:0 0 70px -34px rgba(var(--tvc),.9)}
.ffb-tv.mid{--tvc:255,184,0}.ffb-tv.bad{--tvc:241,30,132}
.ffb-tvrow{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 18px}
.ffb-tvt{font:900 italic clamp(40px,9vw,66px)/.92 'Rubik',sans-serif;text-transform:uppercase;letter-spacing:-.01em;color:rgb(var(--tvc));max-width:9ch;padding-right:.08em}
.ffb-edge{display:flex;align-items:flex-end;gap:8px}
.ffb-edn{font:900 italic clamp(40px,9vw,64px)/1 'Rubik',sans-serif;color:rgb(var(--tvc));font-variant-numeric:tabular-nums;padding-right:.05em}
.ffb-edn small{font-size:.42em}
.ffb-edl{font:600 italic 11px/1.1 var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffffb3;padding-bottom:6px}
.ffb-track{position:relative;height:6px;margin:6px 9px 0;border-radius:999px;background:linear-gradient(90deg,#f11e84,#ff6a2b 38%,#ffb800 55%,#7ed321 75%,#00d492)}
.ffb-track i{position:absolute;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#eafff6;border:4px solid rgb(var(--tvc));box-shadow:0 0 14px rgba(var(--tvc),.9)}
.ffb-trl{display:flex;justify-content:space-between;gap:8px;font:600 10.5px var(--fmono);letter-spacing:.14em;text-transform:uppercase;color:#ffffff80}
.ffb-trl .net{color:rgb(var(--tvc));text-align:center}
.ffb-rhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}
.ffb-rhead b{font:700 16px 'Rubik',sans-serif}
.ffb-overall{display:flex;align-items:center;gap:18px}
.ffb-gbig{flex:none;display:grid;place-items:center;width:92px;height:92px;border-radius:22px;font:900 italic 50px/1 'Rubik',sans-serif;border:1px solid currentColor;background:rgba(255,255,255,.03)}
.ffb-ovt{font:700 18px 'Rubik',sans-serif;margin:4px 0 6px}
.ffb-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px}
.ffb-lus{display:flex;flex-direction:column}
.ffb-lu{display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 0;border-bottom:1px solid var(--hair)}
.ffb-lu:last-child{border-bottom:0}
.ffb-lu .who{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ffb-lu .who b{font:700 15px var(--fui);overflow-wrap:anywhere}.ffb-lu .who span{font:500 12px var(--fui);color:#ffffff99}
.ffb-slotb{flex:none;width:46px;text-align:center;padding:4px 0;border-radius:8px;background:rgba(var(--acc-rgb),.14);color:var(--acc2);font:700 11px var(--fmono);letter-spacing:.08em}
.ffb-slotb.dim{background:rgba(255,255,255,.06);color:#ffffffa6}
.ffb-lup{flex:none;font:800 16px 'Rubik',sans-serif;font-variant-numeric:tabular-nums}
.ffb-g{flex:none;display:grid;place-items:center;width:40px;height:32px;border-radius:9px;font:900 italic 16px 'Rubik',sans-serif;border:1px solid currentColor}
.ffb-g.good,.ffb-gbig.good{color:var(--good)}.ffb-g.acc,.ffb-gbig.acc{color:var(--acc2)}.ffb-g.mid,.ffb-gbig.mid{color:var(--mid)}.ffb-g.bad,.ffb-gbig.bad{color:#ff5aa8}
.ffb-acts{flex:none;display:flex;gap:6px}
.ffb-rt .ffb-tier td{padding:7px 12px;background:rgba(var(--acc-rgb),.07);color:var(--acc);font:700 10.5px var(--fmono);letter-spacing:.16em;text-transform:uppercase;text-align:left}
.ffb-rt .ffb-rk{color:#ffffff80;font:700 12px var(--fmono)}
.ffb-rt td.ffb-pl{position:static}
.ffb-rt td:nth-child(2){position:sticky;left:0;z-index:1;background:#070c16;text-align:left}
.ffb-rt th:nth-child(2){position:sticky;left:0;z-index:3;text-align:left}
.ffb-rt td:first-child,.ffb-rt th:first-child{position:static}
.ffb-rt tr.ffb-tier td:first-child{position:sticky;left:0}
.ffb-rt .ffb-pj{font-weight:800;color:var(--acc2)}
.ffb-tr{font:800 15px var(--fui)}.ffb-tr.up{color:var(--good)}.ffb-tr.dn{color:#ff5aa8}.ffb-tr.fl{color:#ffffff80}
@media(max-width:560px){.ffb-lu .ffb-acts{flex-direction:column}.ffb-overall{align-items:flex-start}.ffb-gbig{width:72px;height:72px;font-size:40px}.ffb-num{font-size:46px}}`;
    document.head.appendChild(s);
  }

  // ---------- register ----------
  for (const k of KEYS) SB.registerTab({ key: k, label: LABEL[k], render: (main, params) => draw(k, main, params) });
  if (SB.on) SB.on('data', () => { DV++; M = null; if (showing() && document.querySelector('#main .ffb-root')) rerender(); });
  // read-only hooks for tests
  window.__ffb = {
    get seasonState() { return SEAS_ST; }, get state() { return st; }, model: () => build(), reset: () => { M = null; DV++; },
    band, tradeMath, gradeOf, lineup, ssVerdict, weekOf, pctl,
    player: name => { const m = build(); return m ? findName(m, name) : null; },
  };
})();
