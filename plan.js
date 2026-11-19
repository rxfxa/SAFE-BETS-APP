/* plan.js — "📅 Weekly Plan": a $20/week ($80/month) plan of three daily Polymarket NBA player-prop slips (SAFE, COIN FLIP,
   LOTTO), built from a game-script model, a 500,000-run simulator, slip tracking and the end-of-week report.

   LEGS: Polymarket NBA points / rebounds / assists markets from polymarket.json, both sides: Yes = over the line, No = under.
   A side needs a two-sided quote (bid > 1¢, ask ≤ 97¢ so it pays at least 3%, spread ≤ 15¢). Buy price of No = 1 − Yes bid.
   PLAYER MODEL (per game):
     base   = season average (nbaroles.json); points get the injury usage boost from lottos.js, rebounds/assists 60% of it
     env    = (implied team total / league-average team total)^k, k = .9 points, .6 assists, .4 rebounds. Implied team total
              = game total / 2 ± home margin / 2, from Polymarket's main total and spread (the lines nearest 50/50), so the
              opponent's defense and the pace are in it. Two teams that both score and defend give a close game with a high
              total: full minutes and more stats.
     script = home margin m ~ Normal(mu, 12.5). Blowout share c = clamp((|m| − 12) / 18, 0, 1): the five starters play
              (1 − .30c) of their minutes, the bench (1 + .20c). Stars on either side sit when it gets out of hand.
     noise  = game pace shock N(0, 6%) shared by everyone in the game, team shooting-night shock N(0, 5%) per team, then the
              player's own spread: points sd .28x+3, rebounds .35x+1.2, assists .40x+1.0 (x = expected value), scaled by √minutes.
     Leg chance = that model integrated over the margin (61-point grid). Model and market must agree within 15 points;
     a leg's working chance is min(model, market mid + 4 points) so the model never runs far ahead of the market.
   SLIPS: total legs 9-24 in steps of 3; every game in a slip gives 2 or 3 legs and always one player from each team;
   one leg per player. SAFE takes legs at 86%+, COIN FLIP 76-95%, LOTTO 60-88%. Slip chance: 500,000 joint simulations
   (legs in the same game share the margin and the shocks, so a blowout moves them together).
   STORAGE: tracked slips go to the artifact database (collection "slips", owner/editors only) so Claude can grade them at
   the end of the week; anyone else keeps them in this browser.
*/
(function () {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('plan.js: window.SB v2 API not found'); return; }
const { esc } = SB;

// ---------------- settings ----------------
const LEG_OPTIONS = [9, 12, 15, 18, 21, 24];
const TIERS = [
  { id: 'safe', name: 'SAFE', band: [0.86, 0.995], legs: 9, blurb: 'The highest-probability legs: mostly unders on lines the player rarely reaches, and overs he almost always clears.' },
  { id: 'coin', name: 'COIN FLIP', band: [0.76, 0.95], legs: 12, blurb: 'Medium risk: strong legs with a bit more price, aiming near a coin flip for the whole slip.' },
  { id: 'lotto', name: 'LOTTO', band: [0.60, 0.88], legs: 18, blurb: 'High risk, big payout: more legs and more value. Most of these lose.' },
];
const SPLITS = [['balanced', 'Balanced 50/30/20', [0.5, 0.3, 0.2]], ['safer', 'Safer 70/20/10', [0.7, 0.2, 0.1]], ['bolder', 'Bolder 34/33/33', [0.34, 0.33, 0.33]]];
const STATS = { pts: { n: 'points', k: 0.9, sd: x => 0.28 * x + 3 }, reb: { n: 'rebounds', k: 0.4, sd: x => 0.35 * x + 1.2 }, ast: { n: 'assists', k: 0.6, sd: x => 0.40 * x + 1.0 } };
const SD_M = 12.5, SHOCK_G = 0.06, SHOCK_T = 0.05, SIMS = 500000, QUICK = 20000, MAX_GAP = 0.15, MAX_ASK = 0.97; // a leg must pay at least 3%

// ---------------- helpers ----------------
const nameKey = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const pctS = (p, d) => SB.pct(p, d == null ? (p < 0.1 ? 1 : 0) : d);
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const cents = x => (x == null ? '—' : (x * 100).toFixed(x < 0.995 && x > 0.005 ? 0 : 1) + '¢');
const store = { get: (k, d) => { try { return SB.store.get(k, d); } catch (e) { return d; } }, set: (k, v) => { try { SB.store.set(k, v); } catch (e) {} } };
const activeTab = () => { const el = document.querySelector('#tabs [aria-current="page"]') || document.querySelector('#tabs .tab.on'); return el ? el.dataset.t : null; };
const rerender = () => { if (activeTab() === 'plan') SB.render(); };
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804 * Math.exp(-z * z / 2); const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return z > 0 ? 1 - p : p; }
function rng(seed) { let s = seed >>> 0; let spare = null;
  const u = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { u, n() { if (spare != null) { const v = spare; spare = null; return v; } let a, b, r; do { a = 2 * u() - 1; b = 2 * u() - 1; r = a * a + b * b; } while (r >= 1 || r === 0); const f = Math.sqrt(-2 * Math.log(r) / r); spare = b * f; return a * f; } }; }
const blow = m => Math.max(0, Math.min(1, (Math.abs(m) - 12) / 18));
const minF = (m, starter) => (starter ? 1 - 0.30 * blow(m) : 1 + 0.20 * blow(m));
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return localDate(x); };
const fmtDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };

// ---------------- model ----------------
function leagueTeamTotal(PM) {
  const T = [];
  for (const pg of (PM && PM.games) || []) { if (pg.sport !== 'nba') continue; const t = mainTotal(pg); if (t) T.push(t / 2); }
  return T.length ? T.reduce((s, x) => s + x, 0) / T.length : 115;
}
function mainTotal(pg) { const t = (pg.totals || []).filter(x => x.over && x.over.m != null).sort((a, b) => Math.abs(a.over.m - 0.5) - Math.abs(b.over.m - 0.5))[0]; return t ? t.line : null; }
function mainSpread(pg) { const s = (pg.spreads || []).filter(x => x.home && x.home.m != null).sort((a, b) => Math.abs(a.home.m - 0.5) - Math.abs(b.home.m - 0.5))[0]; return s ? -s.hl : null; }
function roster(abbr) {
  const L = window.__lottos; const R = L && L.ROLES && L.ROLES.teams && L.ROLES.teams[abbr]; if (!R) return [];
  const m = L.teamModel(abbr), by = new Map(m.players.map(p => [nameKey(p.name), p]));
  const rows = R.map(r => ({ r, mp: by.get(nameKey(r.name)) })).filter(x => x.mp);
  const starters = new Set(rows.filter(x => x.mp.w === 0).sort((a, b) => b.r.mpg - a.r.mpg).slice(0, 5).map(x => x.r.name));
  return rows.map(({ r, mp }) => { const boost = mp.boost || 0, f = r.ppg > 0 ? boost / r.ppg : 0;
    return { name: r.name, key: nameKey(r.name), team: abbr, mpg: +r.mpg || 0, starter: starters.has(r.name), w: mp.w, inj: mp.inj, boost,
      base: { pts: (+r.ppg || 0) + boost, reb: (+r.rpg || 0) * (1 + 0.6 * f), ast: (+r.apg || 0) * (1 + 0.6 * f) } }; });
}
function pOver(mean, sdBase, line, starter, mu, sign) { // integrate over the home margin m ~ N(mu, SD_M); sign: +1 home team, -1 away
  let tot = 0, wsum = 0;
  for (let i = -30; i <= 30; i++) {
    const x = i / 30 * 3.5, w = Math.exp(-x * x / 2), m = mu + x * SD_M, f = minF(m * sign, starter);
    const me = mean * f, sd = Math.sqrt(sdBase * sdBase * f + me * me * (SHOCK_G * SHOCK_G + SHOCK_T * SHOCK_T));
    tot += w * (1 - Phi((line - me) / sd)); wsum += w;
  }
  return tot / wsum;
}
function candidates(winH) {
  const P = window.__polymarket, PM = P && P.PM; if (!PM) return { games: [], C: [], LT: 115, missing: 0 };
  const now = Date.now(), LT = leagueTeamTotal(PM), C = [], games = []; let missing = 0;
  for (const pg of PM.games) {
    if (pg.sport !== 'nba' || !(pg.props || []).length) continue;
    const t = Date.parse(pg.start); if (!(t > now && t - now <= winH * 3600e3)) continue;
    const mt = P.matchOf(pg); if (!mt) continue;
    const g = mt.g, ourHome = mt.swap ? g.away : g.home, ourAway = mt.swap ? g.home : g.away;
    let mu = mainSpread(pg), T = mainTotal(pg);
    if (mu == null || T == null) { try { const F = SB.fit(g); if (F && F.kind === 'margin') { if (mu == null) mu = mt.swap ? -F.mu : F.mu; if (T == null && !F.genTotal) T = F.T; } } catch (e) {} }
    if (mu == null) mu = 0; if (T == null) T = LT * 2;
    const env = { mu, T, home: T / 2 + mu / 2, away: T / 2 - mu / 2, pBlow: 0 };
    { let s = 0, w = 0; for (let i = -30; i <= 30; i++) { const x = i / 30 * 3.5, ww = Math.exp(-x * x / 2); s += ww * (Math.abs(mu + x * SD_M) >= 15 ? 1 : 0); w += ww; } env.pBlow = s / w; }
    const R = { home: roster(ourHome.abbr), away: roster(ourAway.abbr) };
    const G = { pg, g, env, home: ourHome, away: ourAway, n: 0 }; games.push(G);
    for (const pr of pg.props) {
      const st = STATS[pr.stat]; if (!st) continue;
      const k = nameKey(pr.player); let side = 'home', pl = R.home.find(x => x.key === k); if (!pl) { side = 'away'; pl = R.away.find(x => x.key === k); }
      if (!pl) { missing++; continue; }
      if (pl.w > 0) continue; // listed out / doubtful / questionable / day-to-day: skip
      const envF = Math.pow(env[side] / LT, st.k), mean = pl.base[pr.stat] * envF; if (!(mean > 0)) continue;
      const sdBase = st.sd(mean), sign = side === 'home' ? 1 : -1, po = pOver(mean, sdBase, pr.line, pl.starter, mu, sign);
      const q = pr.over;
      const sides = [{ over: true, p: po, mid: q.m, ask: q.a, bid: q.b }, { over: false, p: 1 - po, mid: q.m == null ? null : 1 - q.m, ask: q.b == null ? null : 1 - q.b, bid: q.a == null ? null : 1 - q.a }];
      for (const s of sides) {
        if (s.mid == null || s.ask == null || s.bid == null || !(s.bid > 0.01 && s.ask <= MAX_ASK && s.ask - s.bid <= 0.15)) continue;
        if (Math.abs(s.p - s.mid) > MAX_GAP) continue;
        const team = side === 'home' ? ourHome : ourAway, opp = side === 'home' ? ourAway : ourHome;
        C.push({ G, pg, g, pr, side, team, opp, pl, stat: pr.stat, line: pr.line, over: s.over, p: s.p, mid: s.mid, ask: s.ask, bid: s.bid, ps: Math.min(s.p, s.mid + 0.04),
          mean, sdBase, sign, tags: tagsFor(pl, s.over, env, side, LT, mean, pr.line) });
        G.n++;
      }
    }
  }
  return { games, C, LT, missing };
}
function tagsFor(pl, over, env, side, LT, mean, line) {
  const t = [], close = Math.abs(env.mu) <= 4, hiT = env.T >= LT * 2 + 4, myTot = env[side];
  if (!over && pl.starter && env.pBlow >= 0.3) t.push(`Blowout risk ${Math.round(env.pBlow * 100)}%: starters may sit late`);
  if (over && close && hiT) t.push('Both teams score and defend: close game, full minutes');
  if (over && pl.boost >= 1) t.push(`Usage up +${pl.boost.toFixed(1)} pts with a teammate out`);
  if (!over && myTot <= LT - 4) t.push(`Tough matchup: team total ${myTot.toFixed(0)}`);
  if (over && myTot >= LT + 4) t.push(`Soft matchup: team total ${myTot.toFixed(0)}`);
  if (!over && mean < line - 4) t.push(`Line ${line} sits well above his ${mean.toFixed(1)} projection`);
  if (over && mean > line + 4) t.push(`Projection ${mean.toFixed(1)} clears ${line} easily`);
  return t.slice(0, 2);
}
// slips: every game gives 2-3 legs, one from each team at least, one leg per player
function buildSlip(C, band, N, exclude) {
  const ok = c => c.ps >= band[0] && c.ps <= band[1] && !(exclude && exclude.has(legId(c)));
  const byG = new Map(); for (const c of C) if (ok(c)) { if (!byG.has(c.pg.slug)) byG.set(c.pg.slug, []); byG.get(c.pg.slug).push(c); }
  const packs = [];
  for (const [, cs] of byG) {
    cs.sort((a, b) => b.ps - a.ps);
    const H = cs.find(c => c.side === 'home'), A = cs.find(c => c.side === 'away'); if (!H || !A) continue;
    const third = cs.find(c => c !== H && c !== A && c.pl.key !== H.pl.key && c.pl.key !== A.pl.key);
    packs.push({ legs: third ? [H, A, third] : [H, A], score: (H.ps + A.ps) / 2 });
  }
  packs.sort((a, b) => b.score - a.score);
  const use = []; let rem = N;
  for (const pk of packs) {
    if (rem <= 0) break;
    let k = Math.min(pk.legs.length, rem); if (k < 2) break;
    if (rem - k === 1) { if (k === 3) k = 2; else continue; }
    use.push({ pk, k }); rem -= k;
  }
  if (rem === 1) { const u = use.find(x => x.k === 3); if (u) { u.k = 2; rem = 2; for (const pk of packs) { if (use.some(x => x.pk === pk)) continue; use.push({ pk, k: 2 }); rem = 0; break; } } }
  const legs = use.flatMap(x => x.pk.legs.slice(0, x.k));
  return { legs, short: Math.max(0, N - legs.length), games: use.length };
}
const legId = c => `${c.pg.slug}|${c.pl.key}|${c.stat}|${c.line}|${c.over ? 'o' : 'u'}`;
function simulate(legs, S, seed) { // joint simulation; returns {hit, dist[legs hit], miss[i]}
  const games = [], gi = new Map();
  for (const c of legs) { if (!gi.has(c.pg.slug)) { gi.set(c.pg.slug, games.length); games.push({ mu: c.G.env.mu, legs: [] }); } games[gi.get(c.pg.slug)].legs.push(c); }
  const r = rng(seed || 0xC0FFEE), n = legs.length, dist = new Float64Array(n + 1), miss = new Float64Array(n), idx = new Map(legs.map((c, i) => [c, i]));
  let hit = 0;
  for (let s = 0; s < S; s++) {
    let k = 0;
    for (const G of games) {
      const m = G.mu + SD_M * r.n(), z = SHOCK_G * r.n(), zh = SHOCK_T * r.n(), za = SHOCK_T * r.n();
      for (const c of G.legs) {
        const f = minF(m * c.sign, c.pl.starter), me = c.mean * (1 + z + (c.side === 'home' ? zh : za)) * f, v = me + c.sdBase * Math.sqrt(f) * r.n();
        if (c.over ? v > c.line : v < c.line) k++; else miss[idx.get(c)]++;
      }
    }
    dist[k]++; if (k === n) hit++;
  }
  return { hit: hit / S, dist: Array.from(dist, x => x / S), miss: Array.from(miss, x => x / S), S };
}
async function simulateChunked(legs, S, onProgress) { // keeps the page responsive: 25 chunks
  const chunks = 25, per = Math.ceil(S / chunks), parts = [];
  for (let i = 0; i < chunks; i++) { parts.push(simulate(legs, per, 0xA5A5 + i * 7919)); if (onProgress) onProgress((i + 1) / chunks); await new Promise(r => setTimeout(r, 0)); }
  const n = legs.length, out = { hit: 0, dist: new Array(n + 1).fill(0), miss: new Array(n).fill(0), S: per * chunks };
  for (const p of parts) { out.hit += p.hit / chunks; p.dist.forEach((x, i) => { out.dist[i] += x / chunks; }); p.miss.forEach((x, i) => { out.miss[i] += x / chunks; }); }
  return out;
}

// ---------------- state + storage ----------------
const ST = { win: store.get('plan.win', '24h'), budget: +store.get('plan.budget', 20) || 20, split: store.get('plan.split', 'balanced'),
  legs: store.get('plan.legs', { safe: 9, coin: 12, lotto: 18 }), sims: {}, built: null, week: null, weekRun: false };
let SLIPS = store.get('plan.slips', []); if (!Array.isArray(SLIPS)) SLIPS = [];
let db = null, dbMode = 'local', dbSlips = null;
(async () => {
  try { if (window.claude && typeof window.claude.use === 'function') db = await window.claude.use('db'); } catch (e) { db = null; }
  if (!db) return;
  try {
    db.collection('slips').orderBy('createdAt', 'desc').limit(300).onSnapshot(snap => { dbSlips = snap.docs.map(d => ({ id: d.id, ...d.data() })); dbMode = 'db'; rerender(); }, () => { dbMode = 'local'; });
  } catch (e) { dbMode = 'local'; }
})();
const allSlips = () => (dbMode === 'db' && dbSlips ? dbSlips.concat(SLIPS.filter(s => !dbSlips.some(d => d.id === s.id))) : SLIPS);
async function saveSlip(rec) {
  if (db && dbMode === 'db') { try { await db.collection('slips').doc(rec.id).set(rec); return 'db'; } catch (e) { /* not allowed for this viewer: keep it here */ } }
  SLIPS.push(rec); store.set('plan.slips', SLIPS); return 'local';
}
async function updateSlip(id, patch) {
  const loc = SLIPS.find(s => s.id === id);
  if (loc) { Object.assign(loc, patch); store.set('plan.slips', SLIPS); return; }
  if (db) { try { await db.collection('slips').doc(id).update(patch); } catch (e) { SB.toast('Couldn\'t save that grade'); } }
}

// ---------------- markup ----------------
const splitOf = () => (SPLITS.find(s => s[0] === ST.split) || SPLITS[0])[2];
const stakes = () => { const sp = splitOf(); return TIERS.map((t, i) => Math.round(ST.budget * sp[i] / 7 * 100) / 100); };
function slipNumbers(legs) { const pm = legs.reduce((s, c) => s * c.mid, 1), px = legs.reduce((s, c) => s * c.ask, 1), pi = legs.reduce((s, c) => s * c.p, 1); return { pm, dec: px > 0 ? 1 / px : null, pi }; }
function legRow(c, i, missRate) {
  const st = STATS[c.stat];
  return `<div class="leg"><span class="legdot">${i + 1}</span><div class="legtxt"><b>${esc(c.pl.name)} ${c.over ? 'over' : 'under'} ${c.line} ${st.n}</b>
    <span>${esc(c.team.abbr)} vs ${esc(c.opp.abbr)} · Polymarket ${c.over ? 'Yes' : 'No'} at ${cents(c.ask)}</span>
    ${c.tags.length ? `<em class="pl-tag">${c.tags.map(esc).join(' · ')}</em>` : ''}${missRate != null ? `<em class="pl-miss">Misses in ${pctS(missRate, 1)} of simulations</em>` : ''}</div>
    <span class="legp mono">${pctS(c.p, 0)}<small>mkt ${pctS(c.mid, 0)}</small></span></div>`;
}
function slipCard(t, i, built, stake) {
  const S = built[t.id], N = ST.legs[t.id] || t.legs;
  if (!S || !S.legs.length) return `<div class="pc pl-card"><div class="pchead"><span class="pctitle">${t.name} · ${N} legs</span></div><div class="why">Not enough Polymarket legs in the ${Math.round(t.band[0] * 100)}%+ range right now. Polymarket posts NBA props on game day; check back this afternoon.</div></div>`;
  const nums = slipNumbers(S.legs), sim = ST.sims[t.id], p = sim ? sim.hit : S.quick;
  const byGame = []; for (const c of S.legs) { let g = byGame.find(x => x.slug === c.pg.slug); if (!g) byGame.push(g = { slug: c.pg.slug, c, legs: [] }); g.legs.push(c); }
  let n = 0;
  return `<div class="pc pl-card" data-tier="${t.id}"><div class="pchead"><span class="pctitle">${t.name} · ${S.legs.length} legs${S.short ? ` <span class="badge b-est">${S.short} SHORT</span>` : ''}</span><span class="hit ${p >= 0.55 ? 'h-hi' : p >= 0.3 ? 'h-mid' : 'h-lo'}">${pctS(p)} to hit</span></div>
    <div class="gauge" style="--p:${Math.max(0, Math.min(1, p)).toFixed(3)}" aria-hidden="true"><i></i></div>
    <div class="why" style="margin-top:6px">${esc(t.blurb)}</div>
    <div class="kpis pl-k">${[[pctS(p), sim ? '500k sims' : 'quick estimate'], [pctS(nums.pm), 'market says'], [nums.dec ? '×' + nums.dec.toFixed(2) : '—', 'pays at Polymarket prices'], [money(stake), 'today\'s stake'], [nums.dec ? money(stake * nums.dec) : '—', 'returns if it hits']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
    ${byGame.map(G => `<div class="pl-game"><div class="mkhead"><span class="lg">${esc(G.c.G.away.abbr)} @ ${esc(G.c.G.home.abbr)} · ${G.legs.length} legs</span><span>${esc(SB.when(G.c.g))}</span></div>
      <div class="pl-env">Total ${G.c.G.env.T.toFixed(1)} · ${G.c.G.env.mu >= 0 ? esc(G.c.G.home.abbr) + ' by ' + G.c.G.env.mu.toFixed(1) : esc(G.c.G.away.abbr) + ' by ' + (-G.c.G.env.mu).toFixed(1)} · blowout chance ${pctS(G.c.G.env.pBlow, 0)}</div>
      ${G.legs.map(c => legRow(c, n++, sim ? sim.miss[S.legs.indexOf(c)] : null)).join('')}</div>`).join('')}
    ${sim ? simBlock(sim, S.legs) : ''}
    <div class="pl-btns"><button class="btn" data-pl-sim="${t.id}">${sim ? 'Run 500,000 sims again' : 'Run 500,000 sims'}</button><button class="btn ghost" data-pl-track="${t.id}">Track this slip</button></div>
    <div class="pl-prog" id="pl-prog-${t.id}" hidden><i></i></div></div>`;
}
function simBlock(sim, legs) {
  const n = legs.length, D = sim.dist, mx = Math.max(...D), W = 320, H = 70, bw = W / (n + 1);
  const exp = D.reduce((s, x, k) => s + x * k, 0), weak = legs.map((c, i) => ({ c, m: sim.miss[i] })).sort((a, b) => b.m - a.m).slice(0, 3);
  return `<div class="pl-sim"><div class="pl-simh">500,000 simulations: hits ${pctS(sim.hit, 1)} · on average ${exp.toFixed(1)} of ${n} legs land</div>
    <svg class="pl-hist" viewBox="0 0 ${W} ${H + 14}" role="img" aria-label="How many legs land across 500,000 simulations">${D.map((x, k) => { const h = mx ? x / mx * H : 0; return `<rect x="${(k * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${k === n ? 'var(--yes)' : 'var(--glow)'}" opacity="${k === n ? 1 : 0.55}"/>`; }).join('')}
    <text x="0" y="${H + 12}" fill="var(--dim)" font-size="10">0 legs</text><text x="${W}" y="${H + 12}" fill="var(--dim)" font-size="10" text-anchor="end">all ${n}</text></svg>
    <div class="note">Most likely to break it: ${weak.map(w => `${esc(w.c.pl.name)} ${w.c.over ? 'over' : 'under'} ${w.c.line} (${pctS(w.m, 1)})`).join(', ')}.</div></div>`;
}
function bigSection(C) {
  const rows = [15, 18, 21, 24].map(N => { const S = buildSlip(C, [0.86, 0.999], N); return { N, S, p: S.legs.length === N ? simulate(S.legs, QUICK, 0xBEEF + N).hit : null }; });
  return `<h2>Best plays: 15+ legs <small>the highest-probability legs only</small></h2><div class="pc">
    <div class="why">Every leg here is 86%+ in our model and close to the market. A 15-leg slip only hits 75% of the time if each leg is about 98%, so these are long even when every leg is strong.</div>
    <div class="pl-big">${rows.map(r => `<div class="pl-bigrow"><b>${r.N} legs</b>${r.p == null ? `<span class="note">Not enough 86%+ legs right now (${r.S.legs.length} found)</span>` : `<span class="mono">${pctS(r.p, 1)} to hit</span><span class="note">${r.p >= 0.75 ? 'Clears 75%' : 'Below 75%'}</span><button class="btn ghost" data-pl-usebig="${r.N}">Use as SAFE</button>`}</div>`).join('')}</div></div>`;
}
function weekSim() {
  const st = stakes(), out = [];
  const tiers = TIERS.map((t, i) => { const S = ST.built && ST.built[t.id]; if (!S || !S.legs.length) return null; const nums = slipNumbers(S.legs); const p = ST.sims[t.id] ? ST.sims[t.id].hit : S.quick; return { t, p, dec: nums.dec || 1, stake: st[i] }; }).filter(Boolean);
  if (!tiers.length) return null;
  const r = rng(0x5EED), W = SIMS, res = new Float64Array(W); let up = 0, sum = 0; const wins = tiers.map(() => new Float64Array(8));
  for (let w = 0; w < W; w++) { let pl = 0; tiers.forEach((T, j) => { let k = 0; for (let d = 0; d < 7; d++) { if (r.u() < T.p) { k++; pl += T.stake * (T.dec - 1); } else pl -= T.stake; } wins[j][k]++; }); res[w] = pl; sum += pl; if (pl > 0) up++; }
  const s = Float64Array.from(res).sort(), q = f => s[Math.min(W - 1, Math.floor(f * W))];
  return { tiers: tiers.map((T, j) => ({ ...T, wins: Array.from(wins[j], x => x / W) })), mean: sum / W, up: up / W, p5: q(0.05), p95: q(0.95), month: 4 * sum / W };
}
function reportBlock() {
  const all = allSlips(), today = new Date(), mon = mondayOf(today);
  const line = (list, label) => TIERS.map(t => { const xs = list.filter(s => s.tier === t.id && (s.result === 'won' || s.result === 'lost'));
    const w = xs.filter(s => s.result === 'won').length, pl = xs.reduce((a, s) => a + (s.result === 'won' ? s.stake * ((s.dec || 1) - 1) : -s.stake), 0);
    return `<div class="pl-rep"><b>${t.name}</b><span class="mono">${xs.length ? Math.round(w / xs.length * 100) + '% win rate' : '—'}</span><span>${w}/${xs.length} won</span><span class="mono ${pl >= 0 ? 'pl-pos' : 'pl-neg'}">${xs.length ? (pl >= 0 ? '+' : '') + money(pl) : ''}</span></div>`; }).join('');
  const thisWeek = all.filter(s => s.week === mon), month = all.filter(s => s.date >= localDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const pending = thisWeek.filter(s => !s.result).length;
  return `<h2>Week report <small>week of ${esc(fmtDay(mon))}</small></h2><div class="pc pl-report">${line(thisWeek)}
    <div class="note">${pending ? `${pending} slip${pending === 1 ? '' : 's'} still to grade this week. ` : ''}This month: ${month.filter(s => s.result === 'won').length}/${month.filter(s => s.result === 'won' || s.result === 'lost').length} won.${dbMode === 'db' ? ' Saved to your Safe Bets database: Claude grades them at the end of the week.' : ' Saved in this browser.'}</div>
    ${month.length ? `<div class="pl-sub">This month</div>${line(month)}` : ''}</div>`;
}
function trackedList() {
  const all = allSlips().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 21);
  if (!all.length) return '<div class="pc"><div class="why">No tracked slips yet. Tap "Track this slip" on a slip above after you place it.</div></div>';
  return `<div class="pl-tracked">${all.map(s => { const T = TIERS.find(t => t.id === s.tier) || TIERS[0];
    return `<div class="pc pl-tr"><div class="pchead"><span class="pctitle">${T.name} · ${(s.legs || []).length} legs · ${esc(fmtDay(s.date))}</span><span class="hit ${s.result === 'won' ? 'h-hi' : s.result === 'lost' ? 'h-lo' : 'h-mid'}">${s.result ? s.result.toUpperCase() : 'PENDING'}</span></div>
      <div class="why">${money(s.stake)} at ×${(s.dec || 1).toFixed(2)} · model ${pctS(s.pSim || 0)} · market ${pctS(s.pMkt || 0)}</div>
      <details><summary>Legs</summary>${(s.legs || []).map((L, i) => { const r = s.legRes && s.legRes[i]; return `<div class="pl-trl"><span>${r === true ? '✓' : r === false ? '✗' : '•'}</span><span>${esc(L.player)} ${L.over ? 'over' : 'under'} ${L.line} ${esc((STATS[L.stat] || { n: L.stat }).n)} <small>${esc(L.team)} vs ${esc(L.opp)}</small></span>
        <span class="pl-g"><button data-pl-leg="${esc(s.id)}|${i}|1" aria-label="Leg hit">✓</button><button data-pl-leg="${esc(s.id)}|${i}|0" aria-label="Leg missed">✗</button></span></div>`; }).join('')}</details>
      <div class="pl-btns"><button class="btn ghost" data-pl-res="${esc(s.id)}|won">Won</button><button class="btn ghost" data-pl-res="${esc(s.id)}|lost">Lost</button><button class="btn ghost" data-pl-res="${esc(s.id)}|void">Void</button></div></div>`; }).join('')}</div>`;
}
function render(main) {
  const winH = ST.win === '3d' ? 72 : 30, { games, C, missing } = candidates(winH), st = stakes();
  // build the three slips; a leg goes to the safest tier that wants it
  const built = {}, taken = new Set();
  for (const t of TIERS) { const N = ST.legs[t.id] || t.legs; const S = buildSlip(C, t.band, N, taken); S.legs.forEach(c => taken.add(legId(c))); S.quick = S.legs.length ? simulate(S.legs, QUICK, 0x1234 + N).hit : 0; built[t.id] = S; }
  if (ST.builtKey !== JSON.stringify(Object.values(built).map(S => S.legs.map(legId)))) { ST.sims = {}; ST.week = null; }
  ST.builtKey = JSON.stringify(Object.values(built).map(S => S.legs.map(legId))); ST.built = built;
  const PM = window.__polymarket && window.__polymarket.PM;
  const chip = (attr, k, l, on) => `<button class="chip ${on ? 'on' : ''}" data-${attr}="${k}" aria-pressed="${on}">${esc(l)}</button>`;
  let h = `<h2>Weekly Plan <small>$${ST.budget}/week · $${ST.budget * 4}/month · Polymarket NBA player props</small></h2>
    <div class="note pl-lead">Three slips a day: SAFE, COIN FLIP and LOTTO. Every leg is a Polymarket player market, priced by a game-script model: injuries, the matchup (Polymarket's total and spread), and blowouts, when stars sit and unders hit. Close games between two teams that score and defend push stats up.</div>
    <div class="pc pl-set">
      <div class="pl-row"><label for="plBudget">Weekly budget</label><span class="pl-money">$<input id="plBudget" type="number" min="3" step="1" inputmode="decimal" value="${ST.budget}"></span><span class="note">= $${(ST.budget * 4).toFixed(0)} a month</span></div>
      <div class="spnav">${SPLITS.map(s => chip('pl-split', s[0], s[1], ST.split === s[0])).join('')}</div>
      <div class="pl-stakes">${TIERS.map((t, i) => `<div><b>${t.name}</b><span class="mono">${money(st[i])}</span><small>a day · ${money(st[i] * 7)} a week</small></div>`).join('')}</div>
      <div class="pl-row">${TIERS.map(t => `<label class="pl-sel">${t.name} legs<select data-pl-legs="${t.id}" aria-label="${t.name} legs">${LEG_OPTIONS.map(n => `<option ${n === (ST.legs[t.id] || t.legs) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="spnav">${chip('pl-win', '24h', 'Today\'s games', ST.win !== '3d')}${chip('pl-win', '3d', 'Next 3 days', ST.win === '3d')}</div>
      <div class="note">Rules: legs come in 3s (9 to 24), each game gives 2 or 3 legs with a player from each team, one leg per player.</div></div>`;
  if (!PM) h += '<div class="pc"><div class="why">Loading Polymarket prices…</div></div>';
  else if (!C.length) h += `<div class="pc"><div class="why">No Polymarket NBA player props for ${ST.win === '3d' ? 'the next 3 days' : 'today\'s games'} in the latest snapshot (${esc(new Date(PM.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}). Polymarket posts them on game day; the slips fill in once they're up.</div></div>`;
  else {
    h += `<div class="note">${games.length} games · ${C.length} Polymarket legs priced${missing ? ` · ${missing} lines skipped (player not in our data)` : ''} · snapshot ${esc(new Date(PM.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}. Prices move: check each one before you buy.</div>`;
    h += `<div class="grid pl-grid">${TIERS.map((t, i) => slipCard(t, i, built, st[i])).join('')}</div>`;
    h += bigSection(C);
    const W = ST.week;
    h += `<h2>Week simulator <small>7 days of these three slips · 500,000 weeks</small></h2><div class="pc">
      <div class="pl-btns"><button class="btn" data-pl-week>Run 500,000 weeks</button></div>
      ${W ? `<div class="kpis">${[[money(W.mean), 'average week'], [pctS(W.up, 0), 'weeks in profit'], [money(W.p5), 'bad week (5%)'], [money(W.p95), 'good week (95%)'], [money(W.month), 'average month']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${l}</span></div>`).join('')}</div>
        ${W.tiers.map(T => `<div class="pl-rep"><b>${T.t.name}</b><span>${pctS(T.p)} a day</span><span>most likely ${T.wins.indexOf(Math.max(...T.wins))}/7 won</span><span class="mono">×${T.dec.toFixed(2)}</span></div>`).join('')}
        <div class="note">Uses today's slips as a typical day. Payouts assume you get Polymarket's prices on every leg; a sportsbook parlay pays its own odds.</div>` : '<div class="why">Plays a full week (7 SAFE, 7 COIN FLIP, 7 LOTTO slips at your stakes) 500,000 times.</div>'}</div>`;
  }
  h += reportBlock();
  h += `<h2>Tracked slips <small>grade them, or let Claude grade them Sunday night</small></h2>` + trackedList();
  h += `<div class="note pl-foot">Polymarket sells each leg on its own, so a slip is a parlay you place at a sportsbook or a set of Polymarket positions. We compare every leg with Polymarket's price; live sportsbook odds aren't in the app yet. Hit chances are model estimates, never guarantees. Bet only what you can lose. 21+.</div>`;
  main.innerHTML = h;
}

// ---------------- events ----------------
document.addEventListener('change', e => {
  const t = e.target; if (!t.closest || !t.closest('#main')) return;
  if (t.id === 'plBudget') { const v = Math.max(3, Math.round(+t.value || 20)); ST.budget = v; store.set('plan.budget', v); ST.week = null; SB.render(); return; }
  if (t.dataset && t.dataset.plLegs) { ST.legs = { ...ST.legs, [t.dataset.plLegs]: +t.value }; store.set('plan.legs', ST.legs); SB.render(); }
});
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-pl-split],[data-pl-win],[data-pl-sim],[data-pl-track],[data-pl-week],[data-pl-usebig],[data-pl-res],[data-pl-leg]');
  if (!t || !t.closest('#main')) return;
  const d = t.dataset;
  if (d.plSplit) { ST.split = d.plSplit; store.set('plan.split', d.plSplit); ST.week = null; SB.render(); return; }
  if (d.plWin) { ST.win = d.plWin; store.set('plan.win', d.plWin); SB.render(); return; }
  if (d.plUsebig) { ST.legs = { ...ST.legs, safe: +d.plUsebig }; store.set('plan.legs', ST.legs); SB.render(); return; }
  if (d.plWeek != null) { t.disabled = true; t.textContent = 'Running…'; setTimeout(() => { ST.week = weekSim(); SB.render(); }, 30); return; }
  if (d.plSim) {
    const S = ST.built && ST.built[d.plSim]; if (!S || !S.legs.length) return;
    t.disabled = true; t.textContent = 'Simulating…'; const bar = document.getElementById('pl-prog-' + d.plSim); if (bar) bar.hidden = false;
    ST.sims[d.plSim] = await simulateChunked(S.legs, SIMS, f => { const b = document.getElementById('pl-prog-' + d.plSim); if (b) b.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; });
    ST.week = null; SB.render(); return;
  }
  if (d.plTrack) {
    const tier = d.plTrack, S = ST.built && ST.built[tier]; if (!S || !S.legs.length) return;
    const i = TIERS.findIndex(x => x.id === tier), nums = slipNumbers(S.legs), now = new Date();
    const rec = { id: `${localDate(now)}-${tier}-${Math.random().toString(36).slice(2, 7)}`, date: localDate(now), week: mondayOf(now), tier, stake: stakes()[i], dec: nums.dec ? Math.round(nums.dec * 100) / 100 : 1,
      pSim: ST.sims[tier] ? ST.sims[tier].hit : S.quick, pMkt: nums.pm, createdAt: Date.now(), result: null, legRes: {},
      legs: S.legs.map(c => ({ player: c.pl.name, team: c.team.abbr, opp: c.opp.abbr, stat: c.stat, line: c.line, over: c.over, ask: c.ask, mid: c.mid, p: Math.round(c.p * 1000) / 1000, game: c.pg.slug, start: c.pg.start, url: c.pg.url })) };
    const where = await saveSlip(rec); SB.toast(`Tracking your ${TIERS[i].name} slip${where === 'db' ? '' : ' in this browser'}`); SB.render(); return;
  }
  if (d.plRes) { const [id, res] = d.plRes.split('|'); await updateSlip(id, { result: res, gradedBy: 'you' }); SB.render(); return; }
  if (d.plLeg) {
    const [id, i, v] = d.plLeg.split('|'), s = allSlips().find(x => x.id === id); if (!s) return;
    const legRes = { ...(s.legRes || {}), [i]: v === '1' }, n = (s.legs || []).length, vals = Object.values(legRes);
    const result = vals.includes(false) ? 'lost' : vals.length === n && vals.every(Boolean) ? 'won' : s.result || null;
    await updateSlip(id, { legRes, result, gradedBy: 'you' }); SB.render();
  }
});
SB.on('data', () => rerender());

// ---------------- styles (tokens only) ----------------
const css = document.createElement('style');
css.textContent = `
.pl-lead{margin:-4px 2px 12px}
.pl-set{display:grid;gap:12px}
.pl-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pl-row label{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.pl-money{display:inline-flex;align-items:center;gap:4px;font-weight:700}.pl-money input{width:90px;max-width:110px;flex:none;min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:600 17px var(--f);padding:6px 10px;margin-left:2px}
.pl-stakes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pl-stakes div{background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:10px;display:grid;gap:2px}
.pl-stakes b{font-size:12px;letter-spacing:.06em}.pl-stakes .mono{font-size:20px}.pl-stakes small{font-size:11.5px;color:var(--dim)}
.pl-sel{display:grid;gap:4px;flex:1 1 90px}
.pl-sel select{min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:600 15px var(--f);padding:6px 8px}
.pl-grid{align-items:start}
.pl-k{margin:12px 0 4px;grid-template-columns:repeat(2,1fr)}
.pl-game{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
.pl-env{font-size:12.5px;color:var(--dim);margin:2px 0 4px}
.pl-tag{display:block;font-style:normal;font-size:12px;color:var(--cyan);margin-top:2px}
.pl-miss{display:block;font-style:normal;font-size:12px;color:var(--amber);margin-top:2px}
.pl-card .legp{display:grid;justify-items:end;align-content:start;text-align:right;flex:none}.pl-card .legp small{display:block}
.pl-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pl-btns .btn{flex:1 1 130px;min-height:44px;padding:11px 10px;font-size:13.5px}
.pl-prog{height:6px;background:var(--soft);border-radius:3px;margin-top:10px;overflow:hidden}.pl-prog i{display:block;height:100%;width:0;background:var(--glow);transition:width .2s}
.pl-sim{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.pl-simh{font-weight:700;font-size:14px}
.pl-hist{width:100%;height:auto;display:block;margin-top:8px}
.pl-big{display:grid;gap:8px;margin-top:10px}
.pl-bigrow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border-top:1px solid var(--line);padding-top:8px}.pl-bigrow b{min-width:64px}.pl-bigrow .btn{margin-left:auto;min-height:40px;padding:8px 12px;font-size:13px}
.pl-report{display:grid;gap:6px}
.pl-rep{display:grid;grid-template-columns:minmax(80px,1fr) auto auto auto;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line);font-size:15px}
.pl-rep b{font-size:15px;letter-spacing:.04em}
.pl-pos{color:var(--yes)}.pl-neg{color:var(--no)}
.pl-sub{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-top:10px}
.pl-tracked{display:grid;gap:10px}
.pl-tr details{margin-top:8px}.pl-tr summary{cursor:pointer;color:var(--blue);min-height:32px}
.pl-trl{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line);font-size:13.5px}
.pl-trl small{color:var(--dim)}
.pl-g button{min-width:40px;min-height:40px;margin-left:4px;background:var(--card-hi);border:1px solid var(--line);border-radius:5px;color:var(--text);cursor:pointer}
.pl-foot{margin-top:16px}
@media(max-width:420px){.pl-stakes{grid-template-columns:1fr 1fr 1fr}.pl-stakes .mono{font-size:17px}.pl-rep{grid-template-columns:1fr auto auto}.pl-rep>:last-child{grid-column:1/-1}}
`;
document.head.appendChild(css);

const TAB = { key: 'plan', label: '📅 Weekly Plan', after: 'polymarket', render };
SB.registerTab(TAB);
SB.on('data', () => setTimeout(() => { if (!document.querySelector('#tabs [data-t="plan"]')) SB.registerTab(TAB); }, 0));
window.__plan = { candidates, buildSlip, simulate, pOver, roster, weekSim, TIERS, LEG_OPTIONS, legId, get state() { return ST; }, get slips() { return allSlips(); }, get dbMode() { return dbMode; } };
})();
