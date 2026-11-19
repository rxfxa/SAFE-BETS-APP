/* plan.js — "📅 Weekly Plan": a $20/week ($80/month) plan of Polymarket slips across every sport, built to hit-rate targets,
   with decision buttons, a 500,000-run simulator, slip tracking, the end-of-week report and the user's Polymarket account.

   TIERS (whole-slip hit rate): SAFE 60-89% · COIN FLIP 45-55% · LOTTO 1-40%. BIG SLIPS (payout at Polymarket prices):
   15+ legs paying ×10+, 21+ legs ×50+, 24+ legs ×100+; each tries its base leg count and up to 9 more (in 3s) and keeps
   the one that reaches the payout with the best simulated chance to hit, favouring legs the model rates above the price.
   LEGS (Polymarket only):
     player props  NBA points / rebounds / assists, both sides (Yes = over, No = under), from polymarket.json
     game lines    moneyline, spread and total for NBA, NFL, NHL, college football and soccer (polymarket.js rows,
                   priced with the app's own SC: leg keys; a game with no model match uses the market price alone)
   A leg needs a two-sided quote (bid > 1¢, ask ≤ 97¢, spread ≤ 15¢) and, when the model prices it, the model within
   15 points of the market mid. Working chance = min(model, mid + 4 points).
   PLAYER MODEL (NBA): season average + injury usage boost (lottos.js) × matchup (implied team total from Polymarket's total
   and spread vs the league average) × minutes (blowouts: starters lose up to 30% of minutes, the bench gains up to 20%),
   with game pace and team shooting shocks; sd: points .28x+3, rebounds .35x+1.2, assists .40x+1.0.
   SLIP RULES: total legs 9-24 in steps of 3; each game gives at most 3 legs; a game with player props always has a
   player from each team; one leg per player and one per market type per game; the three main tiers share no legs.
   BUILDER: start from legs nearest the per-leg target q = target^(1/N), then swap legs one at a time (same game, same
   slot rules) until the product of working chances sits inside the tier's range.
   SIMULATOR: 500,000 joint runs. Margin sports (NBA/NFL/NCAAF) draw the game from the engine's 100,000 simulations, soccer
   and NHL from the exact score grid, so lines and props in the same game move together; market-only legs are drawn alone.
   STORAGE: tracked slips → artifact database "slips" (owner/editors) or this browser. Polymarket account: wallet address
   in "settings/polymarket"; Claude syncs positions and combos into "pm/positions" (tools/polymarket_positions.py).
*/
(function () {
'use strict';
const SB = window.SB;
if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('plan.js: window.SB v2 API not found'); return; }
const { esc } = SB;

// ---------------- settings ----------------
const LEG_OPTIONS = [9, 12, 15, 18, 21, 24];
const TIERS = [
  { id: 'safe', name: 'SAFE', range: [0.60, 0.89], target: 0.70, legs: 9, blurb: 'Hits 60-89% of the time, pays about ×1.2-1.6. The steady one.' },
  { id: 'coin', name: 'COIN FLIP', range: [0.45, 0.55], target: 0.50, legs: 12, blurb: 'Hits about half the time, pays about ×2.' },
  { id: 'lotto', name: 'LOTTO', range: [0.01, 0.40], target: 0.12, legs: 18, blurb: 'Hits 1-40% of the time, pays ×3 to ×100. Most of these lose.' },
];
// big slips are built to a payout: at least ×10 / ×50 / ×100 at Polymarket prices; legs may grow in 3s (up to +9) when
// that reaches the payout with a better chance to hit
const BIG = [
  { id: 'b15', name: 'PAYS 10×+', minPay: 10, legs: 15, blurb: '15 or more legs that pay at least ×10.' },
  { id: 'b21', name: 'PAYS 50×+', minPay: 50, legs: 21, blurb: '21 or more legs that pay at least ×50.' },
  { id: 'b24', name: 'PAYS 100×+', minPay: 100, legs: 24, blurb: '24 or more legs that pay at least ×100.' },
];
const ALL_TIERS = TIERS.concat(BIG);
const SPLITS = [['balanced', 'Balanced 50/30/20', [0.5, 0.3, 0.2]], ['safer', 'Safer 70/20/10', [0.7, 0.2, 0.1]], ['bolder', 'Bolder 34/33/33', [0.34, 0.33, 0.33]]];
const SPORTS = [['all', 'All sports'], ['nba', 'NBA'], ['nfl', 'NFL'], ['nhl', 'NHL'], ['ncaaf', 'College FB'], ['soccer', 'Soccer']];
const TYPES = [['mix', 'Props + lines'], ['props', 'Player props'], ['lines', 'Game lines']];
const LEANS = [['both', 'Overs + unders'], ['under', 'Unders'], ['over', 'Overs']];
const STATS = { pts: { n: 'points', k: 0.9, sd: x => 0.28 * x + 3 }, reb: { n: 'rebounds', k: 0.4, sd: x => 0.35 * x + 1.2 }, ast: { n: 'assists', k: 0.6, sd: x => 0.40 * x + 1.0 } };
const SD_M = { nba: 12.5, nfl: 13.5, ncaaf: 16 }, SHOCK_G = 0.06, SHOCK_T = 0.05, SIMS = 500000, QUICK = 20000, MAX_GAP = 0.15, MAX_ASK = 0.97;

// ---------------- helpers ----------------
const nameKey = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const pctS = (p, d) => SB.pct(p, d == null ? (p < 0.1 ? 1 : 0) : d);
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const cents = x => (x == null ? '—' : Math.round(x * 100) + '¢');
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
const liveQ = (bid, ask) => bid != null && ask != null && bid > 0.01 && ask <= MAX_ASK && ask > bid && ask - bid <= 0.15;

// ---------------- NBA player model ----------------
function mainTotal(pg) { const t = (pg.totals || []).filter(x => x.over && x.over.m != null).sort((a, b) => Math.abs(a.over.m - 0.5) - Math.abs(b.over.m - 0.5))[0]; return t ? t.line : null; }
function mainSpread(pg) { const s = (pg.spreads || []).filter(x => x.home && x.home.m != null).sort((a, b) => Math.abs(a.home.m - 0.5) - Math.abs(b.home.m - 0.5))[0]; return s ? -s.hl : null; }
function leagueTeamTotal(PM) { const T = []; for (const pg of (PM && PM.games) || []) { if (pg.sport !== 'nba') continue; const t = mainTotal(pg); if (t) T.push(t / 2); } return T.length ? T.reduce((s, x) => s + x, 0) / T.length : 115; }
function roster(abbr) {
  const L = window.__lottos; const R = L && L.ROLES && L.ROLES.teams && L.ROLES.teams[abbr]; if (!R) return [];
  const m = L.teamModel(abbr), by = new Map(m.players.map(p => [nameKey(p.name), p]));
  const rows = R.map(r => ({ r, mp: by.get(nameKey(r.name)) })).filter(x => x.mp);
  const starters = new Set(rows.filter(x => x.mp.w === 0).sort((a, b) => b.r.mpg - a.r.mpg).slice(0, 5).map(x => x.r.name));
  return rows.map(({ r, mp }) => { const boost = mp.boost || 0, f = r.ppg > 0 ? boost / r.ppg : 0;
    return { name: r.name, key: nameKey(r.name), team: abbr, mpg: +r.mpg || 0, starter: starters.has(r.name), w: mp.w, inj: mp.inj, boost,
      base: { pts: (+r.ppg || 0) + boost, reb: (+r.rpg || 0) * (1 + 0.6 * f), ast: (+r.apg || 0) * (1 + 0.6 * f) } }; });
}
function pOver(mean, sdBase, line, starter, mu, sign, sdM = SD_M.nba) {
  let tot = 0, wsum = 0;
  for (let i = -30; i <= 30; i++) { const x = i / 30 * 3.5, w = Math.exp(-x * x / 2), m = mu + x * sdM, f = minF(m * sign, starter);
    const me = mean * f, sd = Math.sqrt(sdBase * sdBase * f + me * me * (SHOCK_G * SHOCK_G + SHOCK_T * SHOCK_T)); tot += w * (1 - Phi((line - me) / sd)); wsum += w; }
  return tot / wsum;
}
function tagsFor(pl, over, env, side, LT, mean, line) {
  const t = [], close = Math.abs(env.mu) <= 4, hiT = env.T >= LT * 2 + 4, myTot = env[side];
  if (!over && pl.starter && env.pBlow >= 0.3) t.push(`Blowout risk ${Math.round(env.pBlow * 100)}%: starters may sit late`);
  if (over && close && hiT) t.push('Both teams score and defend: close game, full minutes');
  if (over && pl.boost >= 1) t.push(`Usage up +${pl.boost.toFixed(1)} pts with a teammate out`);
  if (!over && myTot <= LT - 4) t.push(`Tough matchup: team total ${myTot.toFixed(0)}`);
  if (over && myTot >= LT + 4) t.push(`Soft matchup: team total ${myTot.toFixed(0)}`);
  if (!over && mean < line - 4) t.push(`Line ${line} sits above his ${mean.toFixed(1)} projection`);
  if (over && mean > line + 4) t.push(`Projection ${mean.toFixed(1)} clears ${line}`);
  return t.slice(0, 2);
}

// ---------------- candidates (every sport) ----------------
function candidates(opts) {
  const P = window.__polymarket, PM = P && P.PM; if (!PM) return { games: [], C: [], missing: 0 };
  const { winH, sport, type, lean } = opts, now = Date.now(), LT = leagueTeamTotal(PM), C = [], games = []; let missing = 0;
  for (const pg of PM.games) {
    if (sport !== 'all' && pg.sport !== sport) continue;
    const t = Date.parse(pg.start); if (!(t > now && t - now <= winH * 3600e3)) continue;
    const mt = P.matchOf(pg), g = mt ? mt.g : null;
    let mu = mainSpread(pg), T = mainTotal(pg);
    if (g && (mu == null || T == null)) { try { const F = SB.fit(g); if (F && F.kind === 'margin') { if (mu == null) mu = mt.swap ? -F.mu : F.mu; if (T == null && !F.genTotal) T = F.T; } } catch (e) {} }
    const sdM = SD_M[pg.sport] || 13;
    if (mu == null) mu = 0; if (T == null) T = pg.sport === 'nba' ? LT * 2 : 0;
    const env = { mu, T, home: T / 2 + mu / 2, away: T / 2 - mu / 2, pBlow: 0, sdM };
    { let s = 0, w = 0; for (let i = -30; i <= 30; i++) { const x = i / 30 * 3.5, ww = Math.exp(-x * x / 2); s += ww * (Math.abs(mu + x * sdM) >= (pg.sport === 'nba' ? 15 : 17) ? 1 : 0); w += ww; } env.pBlow = s / w; }
    const G = { pg, g, mt, env, home: g ? (mt.swap ? g.away : g.home) : { abbr: pg.home.abbr, name: pg.home.name }, away: g ? (mt.swap ? g.home : g.away) : { abbr: pg.away.abbr, name: pg.away.name }, n: 0 };
    // game lines
    if (type !== 'props') for (const r of P.rowsFor(pg)) {
      if (!['Moneyline', 'Spread', 'Total'].includes(r.type)) continue;
      const q = r.q; if (!liveQ(q.b, q.a) || q.m == null) continue;
      const under = /^Under /.test(r.label), over = /^Over /.test(r.label);
      if (lean === 'under' && over) continue; if (lean === 'over' && under) continue;
      if (r.p != null && Math.abs(r.p - q.m) > MAX_GAP) continue;
      const p = r.p != null ? r.p : q.m, mo = r.p == null || !r.key;
      C.push({ kind: 'line', G, pg, g, mkt: r.type, label: r.label, key: r.key, mo, side: /^SC:(ml|sp):H/.test(r.key || '') ? 'home' : /^SC:(ml|sp):A/.test(r.key || '') ? 'away' : null,
        p, mid: q.m, ask: q.a, bid: q.b, ps: mo ? q.m : Math.min(p, q.m + 0.04), tags: lineTags(r, G, mo), pmId: q.id ?? null, pmO: q.o ?? null });
      G.n++;
    }
    // NBA player props
    if (type !== 'lines' && pg.sport === 'nba' && g && (pg.props || []).length) {
      const R = { home: roster(G.home.abbr), away: roster(G.away.abbr) };
      for (const pr of pg.props) {
        const st = STATS[pr.stat]; if (!st) continue;
        const k = nameKey(pr.player); let side = 'home', pl = R.home.find(x => x.key === k); if (!pl) { side = 'away'; pl = R.away.find(x => x.key === k); }
        if (!pl) { missing++; continue; }
        if (pl.w > 0) continue;
        const envF = Math.pow(env[side] / LT, st.k), mean = pl.base[pr.stat] * envF; if (!(mean > 0)) continue;
        const sdBase = st.sd(mean), sign = side === 'home' ? 1 : -1, po = pOver(mean, sdBase, pr.line, pl.starter, mu, sign, sdM), q = pr.over;
        const sides = [{ over: true, p: po, mid: q.m, ask: q.a, bid: q.b }, { over: false, p: 1 - po, mid: q.m == null ? null : 1 - q.m, ask: q.b == null ? null : 1 - q.b, bid: q.a == null ? null : 1 - q.a }];
        for (const s of sides) {
          if (lean === 'under' && s.over) continue; if (lean === 'over' && !s.over) continue;
          if (s.mid == null || !liveQ(s.bid, s.ask) || Math.abs(s.p - s.mid) > MAX_GAP) continue;
          const team = side === 'home' ? G.home : G.away, opp = side === 'home' ? G.away : G.home;
          C.push({ kind: 'prop', G, pg, g, pr, side, team, opp, pl, stat: pr.stat, line: pr.line, over: s.over, p: s.p, mid: s.mid, ask: s.ask, bid: s.bid, ps: Math.min(s.p, s.mid + 0.04), pmId: q.id ?? null, pmO: q.id == null ? null : s.over ? 0 : 1,
            mean, sdBase, sign, label: `${pl.name} ${s.over ? 'over' : 'under'} ${pr.line} ${st.n}`, tags: tagsFor(pl, s.over, env, side, LT, mean, pr.line) });
          G.n++;
        }
      }
    }
    if (G.n) games.push(G);
  }
  return { games, C, missing };
}
function lineTags(r, G, mo) {
  const t = [];
  if (mo) t.push('Market price only (no model match)');
  else if (r.p != null && r.p - r.q.m >= 0.03) t.push(`Model ${pctS(r.p, 0)} vs market ${pctS(r.q.m, 0)}`);
  if (r.type === 'Moneyline' && r.q.m >= 0.7) t.push('Strong favorite');
  if (r.type === 'Total' && /^Under/.test(r.label) && G.env.pBlow >= 0.3) t.push('Lopsided game: pace drops late');
  return t.slice(0, 2);
}
const legId = c => (c.kind === 'prop' ? `${c.pg.slug}|${c.pl.key}|${c.stat}|${c.line}|${c.over ? 'o' : 'u'}` : `${c.pg.slug}|${c.key || c.label}`);
const mktOf = c => (c.kind === 'prop' ? `p:${c.pl.key}` : `m:${c.mkt}`);

// ---------------- builder: hit-rate targets ----------------
function buildTarget(C, tier, N, exclude) {
  const [lo, hi] = tier.range, tgt = tier.target, q = Math.pow(tgt, 1 / N);
  const pool = C.filter(c => !(exclude && exclude.has(legId(c))) && c.ps > 0.05 && c.ps < 0.985);
  const byG = new Map(); for (const c of pool) { if (!byG.has(c.pg.slug)) byG.set(c.pg.slug, []); byG.get(c.pg.slug).push(c); }
  const near = (a, b) => Math.abs(Math.log(a.ps / q)) - Math.abs(Math.log(b.ps / q));
  // one pack per game: props → a player from each team (+1); lines only → up to 3 distinct markets
  const packs = [];
  for (const [slug, cs] of byG) {
    const props = cs.filter(c => c.kind === 'prop').sort(near), lines = cs.filter(c => c.kind === 'line').sort(near);
    const H = props.find(c => c.side === 'home'), A = props.find(c => c.side === 'away');
    let legs = [];
    if (H && A) { legs = [H, A]; const third = cs.slice().sort(near).find(c => c !== H && c !== A && mktOf(c) !== mktOf(H) && mktOf(c) !== mktOf(A)); if (third) legs.push(third); }
    else { const used = new Set(); for (const c of lines) { if (used.has(mktOf(c))) continue; used.add(mktOf(c)); legs.push(c); if (legs.length === 3) break; } if (legs.length < 2) continue; }
    const fit = legs.reduce((s, c) => s + Math.abs(Math.log(c.ps / q)), 0) / legs.length;
    packs.push({ slug, legs, fit });
  }
  packs.sort((a, b) => a.fit - b.fit);
  const use = []; let rem = N;
  for (const pk of packs) { if (rem <= 0) break; let k = Math.min(pk.legs.length, rem); if (k < 2) break; if (rem - k === 1) { if (k === 3) k = 2; else continue; } use.push({ pk, k }); rem -= k; }
  if (rem === 1) { const u = use.find(x => x.k === 3); if (u) { u.k = 2; rem = 2; for (const pk of packs) { if (use.some(x => x.pk === pk)) continue; use.push({ pk, k: 2 }); rem = 0; break; } } }
  const legs = use.flatMap(x => x.pk.legs.slice(0, x.k));
  // swap legs (same game, same rules) until the product sits in the range, closest to the target
  const prod = () => legs.reduce((s, c) => s * c.ps, 1);
  const okSwap = (old, nw) => {
    if (legs.includes(nw) || nw.pg.slug !== old.pg.slug) return false;
    const same = legs.filter(c => c !== old && c.pg.slug === nw.pg.slug);
    if (same.some(c => mktOf(c) === mktOf(nw))) return false;
    const props = same.filter(c => c.kind === 'prop').concat(nw.kind === 'prop' ? [nw] : []);
    if (props.length && new Set(props.map(c => c.side)).size < 2) return false; // keep a player from each team
    return true;
  };
  for (let it = 0; it < 4 * N && legs.length; it++) {
    const P = prod(); if (P >= lo && P <= hi && Math.abs(Math.log(P / tgt)) < 0.35) break;
    const up = P < tgt; let best = null;
    for (const old of legs) {
      for (const nw of byG.get(old.pg.slug) || []) {
        if (up ? nw.ps <= old.ps : nw.ps >= old.ps) continue;
        if (!okSwap(old, nw)) continue;
        const P2 = P / old.ps * nw.ps, gain = Math.abs(Math.log(P / tgt)) - Math.abs(Math.log(P2 / tgt));
        if (gain > 1e-9 && (!best || gain > best.gain)) best = { old, nw, gain };
      }
    }
    if (!best) break;
    legs[legs.indexOf(best.old)] = best.nw;
  }
  const P = prod();
  return { legs, short: Math.max(0, N - legs.length), games: new Set(legs.map(c => c.pg.slug)).size, est: P, inRange: legs.length === N && P >= lo && P <= hi };
}

// legs in the same game move together, so the slip hits more often than the product says: build, simulate, re-aim once
function buildBest(C, t, N, ex, seed) {
  let S = buildTarget(C, t, N, ex); S.quick = S.legs.length ? simulate(S.legs, QUICK, seed).hit : 0;
  if (S.legs.length === N && S.quick > 0 && (S.quick < t.range[0] || S.quick > t.range[1])) {
    const f = S.est / S.quick, t2 = { ...t, target: t.target * f, range: [t.range[0] * f, t.range[1] * f] };
    const S2 = buildTarget(C, t2, N, ex); S2.quick = S2.legs.length ? simulate(S2.legs, QUICK, seed).hit : 0;
    if (S2.legs.length === N && Math.abs(Math.log(S2.quick / t.target)) < Math.abs(Math.log(S.quick / t.target))) S = S2;
  }
  S.need = Math.pow(t.target, 1 / N); S.strong = C.filter(c => c.ps >= S.need - 0.01).length;
  return S;
}

// payout-targeted builder: product of buy prices ≤ 1/minPay, then trade legs for the highest chance to hit that keeps the pay
function buildPayout(C, tier, N, exclude) {
  const M = tier.minPay, L = Math.log(M), qa = Math.pow(1 / M, 1 / N);
  const pool = C.filter(c => !(exclude && exclude.has(legId(c))) && c.ask >= 0.2 && c.ps >= 0.25);
  const byG = new Map(); for (const c of pool) { if (!byG.has(c.pg.slug)) byG.set(c.pg.slug, []); byG.get(c.pg.slug).push(c); }
  const score = c => Math.abs(Math.log(c.ask / qa)) - 0.8 * Math.log(c.ps / c.ask); // near the target price, value first
  const by = (a, b) => score(a) - score(b), packs = [];
  for (const [slug, cs] of byG) {
    const props = cs.filter(c => c.kind === 'prop').sort(by), lines = cs.filter(c => c.kind === 'line').sort(by);
    const H = props.find(c => c.side === 'home'), A = props.find(c => c.side === 'away'); let legs = [];
    if (H && A) { legs = [H, A]; const third = cs.slice().sort(by).find(c => c !== H && c !== A && mktOf(c) !== mktOf(H) && mktOf(c) !== mktOf(A)); if (third) legs.push(third); }
    else { const used = new Set(); for (const c of lines) { if (used.has(mktOf(c))) continue; used.add(mktOf(c)); legs.push(c); if (legs.length === 3) break; } if (legs.length < 2) continue; }
    packs.push({ slug, legs, fit: legs.reduce((s, c) => s + score(c), 0) / legs.length });
  }
  packs.sort((a, b) => a.fit - b.fit);
  const use = []; let rem = N;
  for (const pk of packs) { if (rem <= 0) break; let k = Math.min(pk.legs.length, rem); if (k < 2) break; if (rem - k === 1) { if (k === 3) k = 2; else continue; } use.push({ pk, k }); rem -= k; }
  if (rem === 1) { const u = use.find(x => x.k === 3); if (u) { u.k = 2; rem = 2; for (const pk of packs) { if (use.some(x => x.pk === pk)) continue; use.push({ pk, k: 2 }); rem = 0; break; } } }
  const legs = use.flatMap(x => x.pk.legs.slice(0, x.k));
  const lpay = () => -legs.reduce((s, c) => s + Math.log(c.ask), 0), lp = () => legs.reduce((s, c) => s + Math.log(c.ps), 0);
  const okSwap = (old, nw) => {
    if (legs.includes(nw) || nw.pg.slug !== old.pg.slug) return false;
    const same = legs.filter(c => c !== old && c.pg.slug === nw.pg.slug);
    if (same.some(c => mktOf(c) === mktOf(nw))) return false;
    const props = same.filter(c => c.kind === 'prop').concat(nw.kind === 'prop' ? [nw] : []);
    return !(props.length && new Set(props.map(c => c.side)).size < 2);
  };
  for (let it = 0; it < 6 * N && legs.length; it++) {
    const cur = lpay(), short = cur < L; let best = null;
    for (const old of legs) for (const nw of byG.get(old.pg.slug) || []) {
      if (!okSwap(old, nw)) continue;
      const dPay = Math.log(old.ask) - Math.log(nw.ask), dP = Math.log(nw.ps) - Math.log(old.ps);
      if (short) { if (dPay <= 1e-9) continue; const r = dP / dPay; if (!best || r > best.r) best = { old, nw, r }; } // cheapest pay gain
      else { if (cur + dPay < L || dP <= 1e-9) continue; if (!best || dP > best.r) best = { old, nw, r: dP }; } // more chance, pay kept
    }
    if (!best) break;
    legs[legs.indexOf(best.old)] = best.nw;
  }
  return { legs, short: Math.max(0, N - legs.length), games: new Set(legs.map(c => c.pg.slug)).size, est: Math.exp(lp()), pay: Math.exp(lpay()), payOk: lpay() >= L - 1e-9 };
}
function buildBig(C, t, exclude, seed) {
  let best = null;
  for (let N = t.legs; N <= t.legs + 9; N += 3) {
    const S = buildPayout(C, t, N, exclude); if (S.legs.length !== N) continue;
    S.quick = simulate(S.legs, QUICK, seed + N).hit; S.target = N;
    const better = !best || (S.payOk && !best.payOk) || (S.payOk === best.payOk && (S.payOk ? S.quick > best.quick : S.pay > best.pay));
    if (better) best = S;
  }
  return best || { legs: [], short: t.legs, games: 0, est: 0, pay: 0, payOk: false, quick: 0, target: t.legs };
}

// ---------------- joint simulation ----------------
function cdfOf(O) { const c = new Float64Array(O.n); let s = 0; for (let i = 0; i < O.n; i++) { s += O.p[i]; c[i] = s; } return c; }
function prepGames(legs) {
  const games = [], gi = new Map(), sc = window.__slipcheck && window.__slipcheck.scCore;
  for (const c of legs) {
    if (!gi.has(c.pg.slug)) {
      const g = c.g, G = { slug: c.pg.slug, env: c.G.env, swap: c.G.mt ? c.G.mt.swap : false, legs: [], kind: 'none' };
      try {
        if (g && SB.priced(g) && (g.sport === 'nba' || g.sport === 'nfl' || g.sport === 'ncaaf')) { const S = SB.simGame(g); if (S && S.N) { G.kind = 'margin'; G.S = S; } }
        else if (g && SB.priced(g) && (g.sport === 'soccer' || g.sport === 'nhl')) { const O = SB.outcomes(g); if (O && O.n) { G.kind = 'goals'; G.O = O; G.cdf = cdfOf(O); } }
      } catch (e) { G.kind = 'none'; }
      gi.set(c.pg.slug, games.length); games.push(G);
    }
    games[gi.get(c.pg.slug)].legs.push({ c, f: c.kind === 'line' && !c.mo && c.key && sc ? sc(c.key) : null });
  }
  return games;
}
function simulate(legs, S, seed) {
  const games = prepGames(legs), r = rng(seed || 0xC0FFEE), n = legs.length, dist = new Float64Array(n + 1), miss = new Float64Array(n), idx = new Map(legs.map((c, i) => [c, i]));
  let hit = 0;
  for (let s = 0; s < S; s++) {
    let k = 0;
    for (const G of games) {
      let m, t = 0, h = 0, a = 0;
      if (G.kind === 'margin') { const j = Math.floor(r.u() * G.S.N); m = G.S.mg[j]; t = G.S.tt[j]; }
      else if (G.kind === 'goals') { const u = r.u(); let lo = 0, hi = G.O.n - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (G.cdf[mid] < u) lo = mid + 1; else hi = mid; } h = G.O.h[lo]; a = G.O.a[lo]; m = h - a; t = h + a; }
      else { const mp = G.env.mu + G.env.sdM * r.n(); m = G.swap ? -mp : mp; t = G.env.T; }
      const mPM = G.swap ? -m : m; // props are on Polymarket's home side
      const z = SHOCK_G * r.n(), zh = SHOCK_T * r.n(), za = SHOCK_T * r.n();
      for (const L of G.legs) {
        const c = L.c; let ok;
        if (c.kind === 'prop') { const f = minF(mPM * c.sign, c.pl.starter), me = c.mean * (1 + z + (c.side === 'home' ? zh : za)) * f, v = me + c.sdBase * Math.sqrt(f) * r.n(); ok = c.over ? v > c.line : v < c.line; }
        else if (L.f && G.kind !== 'none') ok = L.f(m, t, h, a) !== 0;
        else ok = r.u() < c.ps;
        if (ok) k++; else miss[idx.get(c)]++;
      }
    }
    dist[k]++; if (k === n) hit++;
  }
  return { hit: hit / S, dist: Array.from(dist, x => x / S), miss: Array.from(miss, x => x / S), S };
}
async function simulateChunked(legs, S, onProgress) {
  const chunks = 25, per = Math.ceil(S / chunks), parts = [];
  for (let i = 0; i < chunks; i++) { parts.push(simulate(legs, per, 0xA5A5 + i * 7919)); if (onProgress) onProgress((i + 1) / chunks); await new Promise(r => setTimeout(r, 0)); }
  const n = legs.length, out = { hit: 0, dist: new Array(n + 1).fill(0), miss: new Array(n).fill(0), S: per * chunks };
  for (const p of parts) { out.hit += p.hit / chunks; p.dist.forEach((x, i) => { out.dist[i] += x / chunks; }); p.miss.forEach((x, i) => { out.miss[i] += x / chunks; }); }
  return out;
}

// ---------------- state + storage ----------------
const ST = { win: store.get('plan.win', '24h'), budget: +store.get('plan.budget', 20) || 20, split: store.get('plan.split', 'balanced'),
  legs: store.get('plan.legs', { safe: 9, coin: 12, lotto: 18 }), sport: store.get('plan.sport', 'all'), type: store.get('plan.type', 'mix'), lean: store.get('plan.lean', 'both'),
  excl: {}, sims: {}, built: null, week: null, builtKey: '', tickets: {} };
let SLIPS = store.get('plan.slips', []); if (!Array.isArray(SLIPS)) SLIPS = [];
let db = null, dbMode = 'local', dbSlips = null, pmDoc = null, pmAddr = store.get('plan.pmAddr', ''), pmLive = null, pmBusy = false, pmErr = '';
try { const c = store.get('plan.pmLive', null); if (c && c.addr === pmAddr) pmLive = c.doc; } catch (e) {}
(async () => {
  try { if (window.claude && typeof window.claude.use === 'function') db = await window.claude.use('db'); } catch (e) { db = null; }
  if (!db) return;
  try { db.collection('slips').orderBy('createdAt', 'desc').limit(300).onSnapshot(snap => { dbSlips = snap.docs.map(d => ({ id: d.id, ...d.data() })); dbMode = 'db'; rerender(); }, () => { dbMode = 'local'; }); } catch (e) { dbMode = 'local'; }
  try { db.doc('pm/positions').onSnapshot(d => { pmDoc = d.exists ? d.data() : null; rerender(); }, () => {}); } catch (e) {}
  try { const s = await db.doc('settings/polymarket').get(); if (s.exists && s.data().address && s.data().address !== pmAddr) { setPmAddr(s.data().address); rerender(); } } catch (e) {}
})();
const allSlips = () => (dbMode === 'db' && dbSlips ? dbSlips.concat(SLIPS.filter(s => !dbSlips.some(d => d.id === s.id))) : SLIPS);
async function saveSlip(rec) {
  if (db && dbMode === 'db') { try { await db.collection('slips').doc(rec.id).set(rec); return 'db'; } catch (e) {} }
  SLIPS.push(rec); store.set('plan.slips', SLIPS); return 'local';
}
async function updateSlip(id, patch) {
  const loc = SLIPS.find(s => s.id === id);
  if (loc) { Object.assign(loc, patch); store.set('plan.slips', SLIPS); return; }
  if (db) { try { await db.collection('slips').doc(id).update(patch); } catch (e) { SB.toast('Couldn\'t save that grade'); } }
}
function setPmAddr(addr) {
  if (addr !== pmAddr) { pmLive = null; pmErr = ''; }
  pmAddr = addr; store.set('plan.pmAddr', addr);
  setTimeout(syncPm, 0);
}
async function savePmAddr(addr) {
  setPmAddr(addr);
  if (db) { try { await db.doc('settings/polymarket').set({ address: addr, savedAt: Date.now() }); return 'db'; } catch (e) {} }
  return 'local';
}

// ---------------- live positions: read in this browser from Polymarket's public data API (no login, no key) ----------------
const PM_DATA = 'https://data-api.polymarket.com/v2';
const pmNum = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10000) / 10000);
const pmSleep = ms => new Promise(r => setTimeout(r, ms));
const pmShort = a => (a || '').slice(0, 6).toLowerCase() + '…' + (a || '').slice(-4).toLowerCase();  // the form Claude's snapshot is saved under
const pmSnapshot = () => (pmDoc && pmAddr && pmDoc.wallet === pmShort(pmAddr) ? pmDoc : null);  // Claude's last sync: only for the wallet connected now
let pmRun = 0;  // each sync gets a number; only the newest one's result is kept
async function pmGet(path, params) {
  for (let i = 0; ; i++) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 40000);  // a stalled request can't hold the sync forever
    try { const r = await fetch(`${PM_DATA}/${path}?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i >= 2) throw e; await pmSleep(1500 * (i + 1)); }
    finally { clearTimeout(timer); }
  }
}
async function pmWalk(path, params, cap) {
  const out = [], seen = new Set(); let cur = null;
  while (out.length < cap) {
    const q = { ...params, limit: 100 }; if (cur) q.cursor = cur;
    const d = (await pmGet(path, q)) || {}; out.push(...(d.data || []));
    const next = (d.pagination || {}).next_cursor;
    if (!next || seen.has(next)) break;  // last page, or the API repeated a cursor
    seen.add(next); cur = next;
  }
  return out;
}
async function syncPm() {
  const addr = pmAddr;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return;
  const run = ++pmRun;
  pmBusy = true; pmErr = '';
  try {
    const user = addr.toLowerCase(), seen = new Set(), positions = [];
    for (const status of ['OPEN', 'REDEEMABLE', 'REDEEMABLE_LOST', 'CLOSED']) {
      for (const p of await pmWalk('positions', { user, status }, 300)) {
        const k = `${p.slug}|${p.outcome}`; if (seen.has(k)) continue; seen.add(k);  // a position can appear under more than one status
        positions.push({ title: p.title, outcome: p.outcome, slug: p.slug, event: p.event_slug, end: p.end_date, status: p.status,
          avg: pmNum(p.avg_price), now: pmNum(p.current_price), size: pmNum(p.total_size), cost: pmNum(p.total_cost_usdc), value: pmNum(p.current_value),
          pnl: pmNum(p.total_pnl), first: p.first_entry_at, last: p.last_event_at });
      }
    }
    const combos = (await pmWalk('positions/combos', { user }, 200)).slice(0, 100).map(c => ({ title: c.title, status: c.status, total_pnl: c.total_pnl,
      legs: (c.legs && c.legs.length ? c.legs : c.positions || []).slice(0, 30).map(l => ({ title: l.title, outcome: l.outcome, slug: l.slug, status: l.status, current_price: l.current_price })) }));
    if (run !== pmRun) return;  // the wallet or the schedule moved on while this ran
    pmLive = { updated: new Date().toISOString(), positions: positions.slice(0, 400), combos };
    store.set('plan.pmLive', { addr, doc: pmLive });
  } catch (e) {
    if (run === pmRun) pmErr = 'Couldn\'t reach Polymarket from this page. Showing your last sync.';
  } finally {
    if (run === pmRun) pmBusy = false;
    SB.render();
  }
}
setTimeout(() => { if (pmAddr) syncPm(); }, 1200);
setInterval(() => { if (pmAddr && !pmBusy) syncPm(); }, 5 * 60e3);

// ---------------- markup ----------------
const splitOf = () => (SPLITS.find(s => s[0] === ST.split) || SPLITS[0])[2];
const stakes = () => { const sp = splitOf(); return TIERS.map((t, i) => Math.round(ST.budget * sp[i] / 7 * 100) / 100); };
const stakeOf = id => { const i = TIERS.findIndex(t => t.id === id); return i >= 0 ? stakes()[i] : 1; };
// ---------------- bet-script ticket ----------------
// A short code the user's own computer reads (tools/place_slip.py): which Polymarket outcome each leg buys (Gamma market id +
// outcome index) and the price the app saw. The script looks every market up again, checks the live price and asks before it
// bets. No keys or account details are in it.
function ticketOf(t, S) {
  const nums = slipNumbers(S.legs), sim = ST.sims[t.id];
  return { v: 1, t: t.id, n: t.name, d: new Date().toISOString().slice(0, 16) + 'Z', s: stakeOf(t.id), x: nums.dec ? Math.round(nums.dec * 100) / 100 : null,
    m: Math.round(nums.pm * 10000) / 10000, p: Math.round((sim ? sim.hit : S.quick) * 10000) / 10000, L: S.legs.map(c => [c.pmId, c.pmO, Math.round(c.ask * 1000)]) };
}
function encTicket(obj) {
  const b = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  return 'SBT1.' + b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ticketReady = S => S.legs.every(c => Number.isInteger(c.pmId) && (c.pmO === 0 || c.pmO === 1));
function slipNumbers(legs) { const pm = legs.reduce((s, c) => s * c.mid, 1), px = legs.reduce((s, c) => s * c.ask, 1); return { pm, dec: px > 0 ? 1 / px : null }; }
function legRow(c, i, missRate, tierId) {
  const where = c.kind === 'prop' ? `${esc(c.team.abbr)} vs ${esc(c.opp.abbr)} · Polymarket ${c.over ? 'Yes' : 'No'} at ${cents(c.ask)}` : `${esc(c.mkt)} · Polymarket at ${cents(c.ask)}`;
  return `<div class="leg pl-leg"><span class="legdot">${i + 1}</span><div class="legtxt"><b>${esc(c.label)}</b><span>${where} · <a href="${esc(c.pg.url)}" target="_blank" rel="noopener">open</a></span>
    ${c.tags.length ? `<em class="pl-tag">${c.tags.map(esc).join(' · ')}</em>` : ''}${missRate != null ? `<em class="pl-miss">Misses in ${pctS(missRate, 1)} of simulations</em>` : ''}</div>
    <span class="legp mono">${pctS(c.p, 0)}<small>mkt ${pctS(c.mid, 0)}</small></span><button class="pl-x" data-pl-drop="${esc(tierId)}|${esc(legId(c))}" aria-label="Drop this leg and pick another">✖</button></div>`;
}
function slipCard(t, S, stake) {
  if (!S || !S.legs.length) return `<div class="pc pl-card" data-tier="${t.id}"><div class="pchead"><span class="pctitle">${esc(t.name)}</span></div><div class="why">Not enough Polymarket legs for this slip with these filters. Try "All sports", "Next 3 days" or "Props + lines".</div></div>`;
  const nums = slipNumbers(S.legs), sim = ST.sims[t.id], p = sim ? sim.hit : S.quick, isPay = !!t.minPay, inR = isPay ? (nums.dec || 0) >= t.minPay - 1e-9 : p >= t.range[0] && p <= t.range[1];
  const byGame = []; for (const c of S.legs) { let g = byGame.find(x => x.slug === c.pg.slug); if (!g) byGame.push(g = { slug: c.pg.slug, c, legs: [] }); g.legs.push(c); }
  let n = 0;
  return `<div class="pc pl-card" data-tier="${t.id}"><div class="pchead"><span class="pctitle">${esc(t.name)} · ${S.legs.length} legs${S.short ? ` <span class="badge b-est">${S.short} SHORT</span>` : ''}</span><span class="hit ${p >= 0.55 ? 'h-hi' : p >= 0.3 ? 'h-mid' : 'h-lo'}">${pctS(p)} to hit</span></div>
    <div class="gauge" style="--p:${Math.max(0, Math.min(1, p)).toFixed(3)}" aria-hidden="true"><i></i></div>
    ${isPay ? `<div class="why" style="margin-top:6px">${esc(t.blurb)} Pays <b class="mono">×${(nums.dec || 0).toFixed(1)}</b> at Polymarket prices: <b class="${inR ? 'pl-pos' : 'pl-amb'}">${inR ? 'payout target met' : 'closest we can get right now'}</b>${S.legs.length > t.legs ? ` (${S.legs.length - t.legs} legs added for a better chance to hit)` : ''}. To break even at that payout it needs to hit ${pctS(1 / Math.max(1, nums.dec || 1), 1)} of the time; the market's prices say ${pctS(nums.pm, 1)}, our model says ${pctS(p, 1)}.</div>` : `<div class="why" style="margin-top:6px">${esc(t.blurb)} Target ${Math.round(t.range[0] * 100)}-${Math.round(t.range[1] * 100)}%: <b class="${inR ? 'pl-pos' : 'pl-amb'}">${inR ? 'on target' : 'closest we can get right now'}</b>.${!inR && p < t.range[0] ? ` Each of ${S.legs.length} legs would need about ${pctS(S.need, 0)}, and Polymarket has ${S.strong} legs that strong for these filters.` : ''}</div>`}
    <div class="kpis pl-k">${[[pctS(p), sim ? '500k sims' : 'quick estimate'], [pctS(nums.pm), 'market says'], [nums.dec ? '×' + nums.dec.toFixed(2) : '—', 'pays at Polymarket prices'], [money(stake), 'stake'], [nums.dec ? money(stake * nums.dec) : '—', 'returns if it hits']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
    <div class="pl-dec">${[['🔁 New mix', 'reroll'], ['↺ Start over', 'reset'], ['📋 Copy legs', 'copy'], ['🖥 Send to my bet script', 'ticket']].map(([l, a]) => `<button class="pl-chipbtn" data-pl-act="${a}|${t.id}">${l}</button>`).join('')}</div>
    ${ST.tickets[t.id] && ST.tickets[t.id].key === S.legs.map(legId).join(',') ? `<div class="pl-ticket"><div class="note"><b>Copied.</b> On your computer run <code>python3 place_slip.py</code>: it reads this code from your clipboard, checks every leg's live price and asks before it bets. If the copy didn't work, select the code below and copy it.</div><textarea readonly rows="2" aria-label="Bet script code" spellcheck="false">${esc(ST.tickets[t.id].code)}</textarea></div>` : ''}
    ${byGame.map(G => `<div class="pl-game"><div class="mkhead"><span class="lg">${esc(G.c.pg.comp)} · ${esc(G.c.G.away.abbr)} @ ${esc(G.c.G.home.abbr)} · ${G.legs.length} legs</span><span>${esc(new Date(G.c.pg.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</span></div>
      ${G.c.pg.sport === 'nba' && G.c.G.env.T ? `<div class="pl-env">Total ${G.c.G.env.T.toFixed(1)} · ${G.c.G.env.mu >= 0 ? esc(G.c.G.home.abbr) + ' by ' + G.c.G.env.mu.toFixed(1) : esc(G.c.G.away.abbr) + ' by ' + (-G.c.G.env.mu).toFixed(1)} · blowout chance ${pctS(G.c.G.env.pBlow, 0)}</div>` : ''}
      ${G.legs.map(c => legRow(c, n++, sim ? sim.miss[S.legs.indexOf(c)] : null, t.id)).join('')}</div>`).join('')}
    ${sim ? simBlock(sim, S.legs) : ''}
    <div class="pl-btns"><button class="btn" data-pl-sim="${t.id}">${sim ? 'Run 500,000 sims again' : 'Run 500,000 sims'}</button><button class="btn ghost" data-pl-track="${t.id}">✅ I placed it</button></div>
    <div class="pl-prog" id="pl-prog-${t.id}" hidden><i></i></div></div>`;
}
function simBlock(sim, legs) {
  const n = legs.length, D = sim.dist, mx = Math.max(...D), W = 320, H = 70, bw = W / (n + 1);
  const exp = D.reduce((s, x, k) => s + x * k, 0), weak = legs.map((c, i) => ({ c, m: sim.miss[i] })).sort((a, b) => b.m - a.m).slice(0, 3);
  return `<div class="pl-sim"><div class="pl-simh">500,000 simulations: hits ${pctS(sim.hit, 1)} · on average ${exp.toFixed(1)} of ${n} legs land</div>
    <svg class="pl-hist" viewBox="0 0 ${W} ${H + 14}" role="img" aria-label="How many legs land across 500,000 simulations">${D.map((x, k) => { const h = mx ? x / mx * H : 0; return `<rect x="${(k * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${k === n ? 'var(--yes)' : 'var(--glow)'}" opacity="${k === n ? 1 : 0.55}"/>`; }).join('')}
    <text x="0" y="${H + 12}" fill="var(--dim)" font-size="10">0 legs</text><text x="${W}" y="${H + 12}" fill="var(--dim)" font-size="10" text-anchor="end">all ${n}</text></svg>
    <div class="note">Most likely to break it: ${weak.map(w => `${esc(w.c.label)} (${pctS(w.m, 1)})`).join(', ')}.</div></div>`;
}
function weekSim() {
  const st = stakes();
  const tiers = TIERS.map((t, i) => { const S = ST.built && ST.built[t.id]; if (!S || !S.legs.length) return null; const nums = slipNumbers(S.legs); const p = ST.sims[t.id] ? ST.sims[t.id].hit : S.quick; return { t, p, dec: nums.dec || 1, stake: st[i] }; }).filter(Boolean);
  if (!tiers.length) return null;
  const r = rng(0x5EED), W = SIMS, res = new Float64Array(W); let up = 0, sum = 0; const wins = tiers.map(() => new Float64Array(8));
  for (let w = 0; w < W; w++) { let pl = 0; tiers.forEach((T, j) => { let k = 0; for (let d = 0; d < 7; d++) { if (r.u() < T.p) { k++; pl += T.stake * (T.dec - 1); } else pl -= T.stake; } wins[j][k]++; }); res[w] = pl; sum += pl; if (pl > 0) up++; }
  const s = Float64Array.from(res).sort(), q = f => s[Math.min(W - 1, Math.floor(f * W))];
  return { tiers: tiers.map((T, j) => ({ ...T, wins: Array.from(wins[j], x => x / W) })), mean: sum / W, up: up / W, p5: q(0.05), p95: q(0.95), month: 4 * sum / W };
}
function reportBlock() {
  const PMV = pmLive || pmSnapshot();
  const all = allSlips(), today = new Date(), mon = mondayOf(today);
  const line = list => ALL_TIERS.map(t => { const xs = list.filter(s => s.tier === t.id && (s.result === 'won' || s.result === 'lost')); if (!xs.length && !TIERS.includes(t)) return '';
    const w = xs.filter(s => s.result === 'won').length, pl = xs.reduce((a, s) => a + (s.result === 'won' ? s.stake * ((s.dec || 1) - 1) : -s.stake), 0);
    return `<div class="pl-rep"><b>${esc(t.name)}</b><span class="mono">${xs.length ? Math.round(w / xs.length * 100) + '% win rate' : '—'}</span><span>${w}/${xs.length} won</span><span class="mono ${pl >= 0 ? 'pl-pos' : 'pl-neg'}">${xs.length ? (pl >= 0 ? '+' : '') + money(pl) : ''}</span></div>`; }).join('');
  const thisWeek = all.filter(s => s.week === mon), month = all.filter(s => s.date >= localDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const pending = thisWeek.filter(s => !s.result).length;
  let pmLine = '';
  if (PMV && Array.isArray(PMV.positions)) { const [y, mo, dd] = mon.split('-').map(Number), since = new Date(y, mo - 1, dd).getTime() / 1000;
    const wk = PMV.positions.filter(p => p.status !== 'OPEN' && p.last && p.last >= since);
    const won = wk.filter(p => (p.pnl || 0) > 0).length, pl = wk.reduce((a, p) => a + (p.pnl || 0), 0);
    pmLine = `<div class="pl-rep"><b>POLYMARKET</b><span class="mono">${wk.length ? Math.round(won / wk.length * 100) + '% win rate' : '—'}</span><span>${won}/${wk.length} won</span><span class="mono ${pl >= 0 ? 'pl-pos' : 'pl-neg'}">${wk.length ? (pl >= 0 ? '+' : '') + money(pl) : ''}</span></div>`; }
  return `<h2>Week report <small>week of ${esc(fmtDay(mon))}</small></h2><div class="pc pl-report">${line(thisWeek)}${pmLine}
    <div class="note">${pending ? `${pending} slip${pending === 1 ? '' : 's'} still to grade this week. ` : ''}This month: ${month.filter(s => s.result === 'won').length}/${month.filter(s => s.result === 'won' || s.result === 'lost').length} won.${dbMode === 'db' ? ' Saved to your Safe Bets database: Claude grades them Sunday night.' : ' Saved in this browser.'}</div>
    ${month.length ? `<div class="pl-sub">This month</div>${line(month)}` : ''}</div>`;
}
function pmBlock() {
  const PMV = pmLive || pmSnapshot();
  const ok = /^0x[0-9a-fA-F]{40}$/.test(pmAddr || '');
  let h = `<h2>My Polymarket <small>positions and combos, tracked here</small></h2><div class="pc pl-pm">
    <div class="why">Paste your Polymarket wallet address (on your Polymarket profile, starts with 0x). It's public on the blockchain, so no password or API key is needed. The app reads your positions and combos from Polymarket in your browser, refreshes them every 5 minutes, and shows them here and in the week report.</div>
    <div class="pl-row"><input id="plPmAddr" class="pl-addr" value="${esc(pmAddr || '')}" placeholder="0x… wallet address" aria-label="Polymarket wallet address" spellcheck="false" autocomplete="off"><button class="btn" data-pl-pmsave>Connect</button></div>
    ${ok ? `<div class="note">Connected: ${esc(pmAddr.slice(0, 6))}…${esc(pmAddr.slice(-4))}. ${pmBusy ? 'Syncing from Polymarket…' : PMV ? `Synced ${esc(new Date(PMV.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}.` : 'Not synced yet.'}${pmErr ? ` <b class="pl-amb">${esc(pmErr)}</b>` : ''}</div>` : ''}
    <div class="note">Or upload a screenshot of a Polymarket bet in 📸 Slip Check and it's tracked the same way.</div>`;
  if (PMV && Array.isArray(PMV.positions)) {
    const open = PMV.positions.filter(p => p.status === 'OPEN'), done = PMV.positions.filter(p => p.status !== 'OPEN').slice(0, 12);
    const row = p => `<div class="pl-pmr"><span><b>${esc(p.title || '')}</b><small>${esc(p.outcome || '')} · bought at ${cents(p.avg)} · now ${cents(p.now)}</small></span><span class="mono ${(p.pnl || 0) >= 0 ? 'pl-pos' : 'pl-neg'}">${money(p.pnl || 0)}</span></div>`;
    h += `<div class="pl-sub">Open (${open.length})</div>${open.map(row).join('') || '<div class="note">No open positions.</div>'}`;
    if ((PMV.combos || []).length) h += `<div class="pl-sub">Combos (${PMV.combos.length})</div>${PMV.combos.slice(0, 10).map(c => `<div class="pl-pmr"><span><b>${esc(c.title || 'Combo')}</b><small>${(c.legs || []).length} legs · ${esc(c.status || '')}</small></span><span class="mono">${c.total_pnl != null ? money(+c.total_pnl) : ''}</span></div>`).join('')}`;
    h += `<div class="pl-sub">Settled</div>${done.map(row).join('') || '<div class="note">Nothing settled yet.</div>'}`;
  }
  return h + '</div>';
}
function scriptBlock() {
  return `<h2>Bet from your computer <small>your key stays on your computer</small></h2><div class="pc pl-script">
    <div class="why">Tap <b>🖥 Send to my bet script</b> on any slip, then run <code>python3 place_slip.py</code> on your computer. It looks up every leg on Polymarket again, shows the live price next to the app's, and places the whole slip as one Polymarket combo only after you type <b>yes</b>. Your key never comes to this app or to Claude.</div>
    <details><summary>Set it up once (about 5 minutes)</summary><ol class="pl-steps">
      <li>Install Python 3.10 or newer, then run <code>pip install polymarket-client==0.20.0</code>.</li>
      <li>Get <code>place_slip.py</code>: it's in your Safe Bets repo under <code>tools/</code>, or ask Claude to send it.</li>
      <li>Run <code>python3 place_slip.py --setup</code>. It asks for your Polymarket wallet address and key in the terminal, hidden as you type. New Polymarket accounts (Deposit Wallet) get a trading-only key that can bet but can't withdraw, and your main key isn't saved.</li>
      <li>Each time: tap 🖥 on a slip, run <code>python3 place_slip.py</code>, check the legs, type <b>yes</b>.</li></ol>
      <div class="note">Try <code>python3 place_slip.py --check</code> first: it checks the slip with no key and places nothing. The script never bets more than your cap (set during setup, $25 unless you change it), won't buy a leg whose price jumped, and stops if Polymarket doesn't allow betting where you are.</div></details></div>`;
}
function trackedList() {
  const all = allSlips().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 21);
  if (!all.length) return '<div class="pc"><div class="why">No tracked slips yet. Tap "✅ I placed it" on a slip after you place it.</div></div>';
  return `<div class="pl-tracked">${all.map(s => { const T = ALL_TIERS.find(t => t.id === s.tier) || TIERS[0];
    return `<div class="pc pl-tr"><div class="pchead"><span class="pctitle">${esc(T.name)} · ${(s.legs || []).length} legs · ${esc(fmtDay(s.date))}</span><span class="hit ${s.result === 'won' ? 'h-hi' : s.result === 'lost' ? 'h-lo' : 'h-mid'}">${s.result ? s.result.toUpperCase() : 'PENDING'}</span></div>
      <div class="why">${money(s.stake)} at ×${(s.dec || 1).toFixed(2)} · model ${pctS(s.pSim || 0)} · market ${pctS(s.pMkt || 0)}</div>
      <details><summary>Legs</summary>${(s.legs || []).map((L, i) => { const r = s.legRes && s.legRes[i]; return `<div class="pl-trl"><span>${r === true ? '✓' : r === false ? '✗' : '•'}</span><span>${esc(L.label || `${L.player} ${L.over ? 'over' : 'under'} ${L.line} ${(STATS[L.stat] || { n: L.stat }).n}`)} <small>${esc(L.title || ((L.team || '') + (L.opp ? ' vs ' + L.opp : '')))}</small></span>
        <span class="pl-g"><button data-pl-leg="${esc(s.id)}|${i}|1" aria-label="Leg hit">✓</button><button data-pl-leg="${esc(s.id)}|${i}|0" aria-label="Leg missed">✗</button></span></div>`; }).join('')}</details>
      <div class="pl-btns"><button class="btn ghost" data-pl-res="${esc(s.id)}|won">Won</button><button class="btn ghost" data-pl-res="${esc(s.id)}|lost">Lost</button><button class="btn ghost" data-pl-res="${esc(s.id)}|void">Void</button></div></div>`; }).join('')}</div>`;
}
function render(main) {
  const winH = ST.win === '3d' ? 72 : 30, { games, C, missing } = candidates({ winH, sport: ST.sport, type: ST.type, lean: ST.lean }), st = stakes();
  const built = {}, taken = new Set();
  for (const t of TIERS) { const N = ST.legs[t.id] || t.legs; const ex = new Set([...taken, ...(ST.excl[t.id] || [])]); const S = buildBest(C, t, N, ex, 0x1234 + N); S.target = N; S.legs.forEach(c => taken.add(legId(c))); built[t.id] = S; }
  for (const t of BIG) built[t.id] = buildBig(C, t, new Set(ST.excl[t.id] || []), 0x4321);
  const key = JSON.stringify(Object.values(built).map(S => S.legs.map(legId)));
  if (ST.builtKey !== key) { const old = ST.built || {}; for (const id of Object.keys(ST.sims)) { if (!old[id] || JSON.stringify(old[id].legs.map(legId)) !== JSON.stringify((built[id] || { legs: [] }).legs.map(legId))) delete ST.sims[id]; } ST.week = null; }
  ST.builtKey = key; ST.built = built;
  const PM = window.__polymarket && window.__polymarket.PM;
  const chip = (attr, k, l, on) => `<button class="chip ${on ? 'on' : ''}" data-${attr}="${k}" aria-pressed="${on}">${esc(l)}</button>`;
  let h = `<h2>Weekly Plan <small>$${ST.budget}/week · $${ST.budget * 4}/month · Polymarket, every sport</small></h2>
    <div class="note pl-lead">Three slips a day built to hit-rate targets (SAFE 60-89%, COIN FLIP 45-55%, LOTTO 1-40%), plus big slips that pay ×10, ×50 and ×100 or more. Every leg is a Polymarket market: player props priced by a game-script model (injuries, matchup, blowouts), and game lines priced by the app's own engine.</div>
    <div class="pc pl-set">
      <div class="pl-row"><label for="plBudget">Weekly budget</label><span class="pl-money">$<input id="plBudget" type="number" min="3" step="1" inputmode="decimal" value="${ST.budget}"></span><span class="note">= $${(ST.budget * 4).toFixed(0)} a month</span></div>
      <div class="spnav">${SPLITS.map(s => chip('pl-split', s[0], s[1], ST.split === s[0])).join('')}</div>
      <div class="pl-stakes">${TIERS.map((t, i) => `<div><b>${t.name}</b><span class="mono">${money(st[i])}</span><small>a day · ${money(st[i] * 7)} a week</small></div>`).join('')}</div>
      <div class="pl-dlabel">Sport</div><div class="spnav">${SPORTS.map(s => chip('pl-sport', s[0], s[1], ST.sport === s[0])).join('')}</div>
      <div class="pl-dlabel">Legs from</div><div class="spnav">${TYPES.map(s => chip('pl-type', s[0], s[1], ST.type === s[0])).join('')}</div>
      <div class="pl-dlabel">Lean</div><div class="spnav">${LEANS.map(s => chip('pl-lean', s[0], s[1], ST.lean === s[0])).join('')}</div>
      <div class="pl-dlabel">When</div><div class="spnav">${chip('pl-win', '24h', 'Today\'s games', ST.win !== '3d')}${chip('pl-win', '3d', 'Next 3 days', ST.win === '3d')}</div>
      <div class="pl-row">${TIERS.map(t => `<label class="pl-sel">${t.name} legs<select data-pl-legs="${t.id}" aria-label="${t.name} legs">${LEG_OPTIONS.map(n => `<option ${n === (ST.legs[t.id] || t.legs) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="note">Rules: legs in 3s (9 to 24), at most 3 legs per game, a player from each team in any game with props, one leg per player. ✖ on a leg swaps it out; 🔁 builds a new mix.</div></div>`;
  if (!PM) h += '<div class="pc"><div class="why">Loading Polymarket prices…</div></div>';
  else if (!C.length) h += `<div class="pc"><div class="why">No Polymarket legs for these filters in the latest snapshot (${esc(new Date(PM.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}). NBA player props post on game day; try "All sports" or "Next 3 days".</div></div>`;
  else {
    const bySport = {}; for (const G of games) bySport[G.pg.sport] = (bySport[G.pg.sport] || 0) + 1;
    h += `<div class="note">${games.length} games (${Object.entries(bySport).map(([k, v]) => `${v} ${({ nba: 'NBA', nfl: 'NFL', nhl: 'NHL', ncaaf: 'college FB', soccer: 'soccer' })[k] || k}`).join(', ')}) · ${C.length} Polymarket legs priced${missing ? ` · ${missing} prop lines skipped (player not in our data)` : ''} · snapshot ${esc(new Date(PM.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}. Prices move: check each one before you buy.</div>`;
    h += `<div class="grid pl-grid">${TIERS.map((t, i) => slipCard(t, built[t.id], st[i])).join('')}</div>`;
    h += `<h2>Big slips <small>pays ×10+ · ×50+ · ×100+ at Polymarket prices</small></h2><div class="grid pl-grid">${BIG.map(t => slipCard(t, built[t.id], 1)).join('')}</div>`;
    const W = ST.week;
    h += `<h2>Week simulator <small>7 days of SAFE, COIN FLIP and LOTTO · 500,000 weeks</small></h2><div class="pc">
      <div class="pl-btns"><button class="btn" data-pl-week>Run 500,000 weeks</button></div>
      ${W ? `<div class="kpis">${[[money(W.mean), 'average week'], [pctS(W.up, 0), 'weeks in profit'], [money(W.p5), 'bad week (5%)'], [money(W.p95), 'good week (95%)'], [money(W.month), 'average month']].map(([v, l]) => `<div class="kpi"><b class="mono">${esc(v)}</b><span>${l}</span></div>`).join('')}</div>
        ${W.tiers.map(T => `<div class="pl-rep"><b>${T.t.name}</b><span>${pctS(T.p)} a day</span><span>most likely ${T.wins.indexOf(Math.max(...T.wins))}/7 won</span><span class="mono">×${T.dec.toFixed(2)}</span></div>`).join('')}
        <div class="note">Uses today's slips as a typical day and Polymarket's prices for the payout.</div>` : '<div class="why">Plays a full week (7 SAFE, 7 COIN FLIP, 7 LOTTO slips at your stakes) 500,000 times.</div>'}</div>`;
  }
  h += reportBlock() + pmBlock() + scriptBlock();
  h += `<h2>Tracked slips <small>grade them, or let Claude grade them Sunday night</small></h2>` + trackedList();
  h += `<div class="note pl-foot">Place a slip as a Polymarket combo or buy the legs one by one. Live sportsbook odds aren't in the app yet, so every leg is compared with Polymarket's price and our model. Hit chances are model estimates, never guarantees. Bet only what you can lose. 21+.</div>`;
  main.innerHTML = h;
}

// ---------------- events ----------------
document.addEventListener('change', e => {
  const t = e.target; if (!t.closest || !t.closest('#main')) return;
  if (t.id === 'plBudget') { const v = Math.max(3, Math.round(+t.value || 20)); ST.budget = v; store.set('plan.budget', v); ST.week = null; SB.render(); return; }
  if (t.dataset && t.dataset.plLegs) { ST.legs = { ...ST.legs, [t.dataset.plLegs]: +t.value }; store.set('plan.legs', ST.legs); SB.render(); }
});
const setOpt = (k, v) => { ST[k] = v; store.set('plan.' + k, v); ST.excl = {}; SB.render(); };
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-pl-split],[data-pl-win],[data-pl-sport],[data-pl-type],[data-pl-lean],[data-pl-sim],[data-pl-track],[data-pl-week],[data-pl-res],[data-pl-leg],[data-pl-drop],[data-pl-act],[data-pl-pmsave]');
  if (!t || !t.closest('#main')) return;
  const d = t.dataset;
  if (d.plSplit) { ST.split = d.plSplit; store.set('plan.split', d.plSplit); ST.week = null; SB.render(); return; }
  if (d.plWin) return setOpt('win', d.plWin);
  if (d.plSport) return setOpt('sport', d.plSport);
  if (d.plType) return setOpt('type', d.plType);
  if (d.plLean) return setOpt('lean', d.plLean);
  if (d.plDrop) { const i = d.plDrop.indexOf('|'), tier = d.plDrop.slice(0, i), id = d.plDrop.slice(i + 1); ST.excl[tier] = (ST.excl[tier] || []).concat(id); SB.render(); return; }
  if (d.plAct) { const [a, tier] = d.plAct.split('|'), S = ST.built && ST.built[tier];
    if (a === 'reroll' && S) { ST.excl[tier] = (ST.excl[tier] || []).concat(S.legs.map(legId)); SB.render(); }
    else if (a === 'reset') { ST.excl[tier] = []; SB.render(); }
    else if (a === 'ticket' && S && S.legs.length) {
      if (!ticketReady(S)) { SB.toast('Some legs are from an older price snapshot. Refresh the app and try again.'); return; }
      const code = encTicket(ticketOf(ALL_TIERS.find(x => x.id === tier) || TIERS[0], S)); ST.tickets[tier] = { key: S.legs.map(legId).join(','), code };
      let ok = false; try { await navigator.clipboard.writeText(code); ok = true; } catch (err) { ok = false; }
      SB.toast(ok ? 'Copied for your bet script: run python3 place_slip.py' : 'Select the code under the slip and copy it'); SB.render(); }
    else if (a === 'copy' && S) { const txt = S.legs.map((c, i) => `${i + 1}. ${c.label} (${c.pg.away.name} @ ${c.pg.home.name}) at ${cents(c.ask)}`).join('\n');
      try { await navigator.clipboard.writeText(txt); SB.toast('Legs copied'); } catch (err) { SB.toast('Copy didn\'t work here: select the legs and copy them by hand'); } }
    return; }
  if (d.plPmsave != null) { const v = ((document.getElementById('plPmAddr') || {}).value || '').trim(); if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { SB.toast('That isn\'t a wallet address: it starts with 0x and has 40 letters and numbers after it'); return; }
    const where = await savePmAddr(v); SB.toast('Connected. Syncing your positions from Polymarket…'); SB.render(); return; }
  if (d.plWeek != null) { t.disabled = true; t.textContent = 'Running…'; setTimeout(() => { ST.week = weekSim(); SB.render(); }, 30); return; }
  if (d.plSim) {
    const S = ST.built && ST.built[d.plSim]; if (!S || !S.legs.length) return;
    t.disabled = true; t.textContent = 'Simulating…'; const bar = document.getElementById('pl-prog-' + d.plSim); if (bar) bar.hidden = false;
    ST.sims[d.plSim] = await simulateChunked(S.legs, SIMS, f => { const b = document.getElementById('pl-prog-' + d.plSim); if (b) b.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; });
    ST.week = null; SB.render(); return;
  }
  if (d.plTrack) {
    const tier = d.plTrack, S = ST.built && ST.built[tier]; if (!S || !S.legs.length) return;
    const nums = slipNumbers(S.legs), now = new Date(), T = ALL_TIERS.find(x => x.id === tier);
    const rec = { id: `${localDate(now)}-${tier}-${Math.random().toString(36).slice(2, 7)}`, date: localDate(now), week: mondayOf(now), tier, stake: stakeOf(tier), dec: nums.dec ? Math.round(nums.dec * 100) / 100 : 1,
      pSim: ST.sims[tier] ? ST.sims[tier].hit : S.quick, pMkt: nums.pm, createdAt: Date.now(), result: null, legRes: {},
      legs: S.legs.map(c => ({ kind: c.kind, label: c.label, player: c.kind === 'prop' ? c.pl.name : null, team: c.kind === 'prop' ? c.team.abbr : null, opp: c.kind === 'prop' ? c.opp.abbr : null, stat: c.stat || null, line: c.line ?? null, over: c.kind === 'prop' ? c.over : null,
        mkt: c.mkt || null, sport: c.pg.sport, ask: c.ask, mid: c.mid, p: Math.round(c.p * 1000) / 1000, game: c.pg.slug, title: `${c.pg.away.name} @ ${c.pg.home.name}`, start: c.pg.start, url: c.pg.url })) };
    const where = await saveSlip(rec); SB.toast(`Tracking your ${T.name} slip${where === 'db' ? '' : ' in this browser'}`); SB.render(); return;
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
.pl-set{display:grid;gap:10px}
.pl-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pl-row label,.pl-dlabel{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.pl-dlabel{margin-bottom:-4px}
.pl-money{display:inline-flex;align-items:center;gap:4px;font-weight:700}.pl-money input{width:90px;max-width:110px;flex:none;min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:600 17px var(--f);padding:6px 10px;margin-left:2px}
.pl-stakes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pl-stakes div{background:var(--card-hi);border:1px solid var(--line);border-radius:6px;padding:10px;display:grid;gap:2px}
.pl-stakes b{font-size:12px;letter-spacing:.06em}.pl-stakes .mono{font-size:20px}.pl-stakes small{font-size:11.5px;color:var(--dim)}
.pl-sel{display:grid;gap:4px;flex:1 1 90px}
.pl-sel select{min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:600 15px var(--f);padding:6px 8px}
.pl-grid{align-items:start}
.pl-k{margin:12px 0 4px;grid-template-columns:repeat(2,1fr)}
.pl-dec{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 2px}
.pl-chipbtn{min-height:40px;padding:6px 12px;border-radius:6px;border:1px solid var(--edge);background:var(--card-hi);color:var(--text);font:600 13px var(--f);cursor:pointer}
.pl-chipbtn:hover{border-color:var(--glow)}
.pl-ticket{margin:8px 0 2px;display:grid;gap:6px}.pl-ticket textarea{width:100%;box-sizing:border-box;background:var(--soft);color:var(--text);border:1px solid var(--edge);border-radius:6px;padding:8px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;resize:vertical;word-break:break-all}
.pl-script code,.pl-ticket code{font:12.5px ui-monospace,Menlo,Consolas,monospace;background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--ice)}
.pl-script details{margin-top:8px}.pl-script summary{cursor:pointer;font-weight:700;min-height:32px;display:flex;align-items:center}.pl-steps{margin:6px 0 6px 18px;padding:0;display:grid;gap:6px;font-size:14px;line-height:1.45}
.pl-game{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
.pl-env{font-size:12.5px;color:var(--dim);margin:2px 0 4px}
.pl-leg{align-items:flex-start}
.pl-leg .legtxt a{color:var(--blue)}
.pl-x{flex:none;width:36px;height:36px;margin-left:6px;border:1px solid var(--line);background:var(--card);color:var(--mute);border-radius:5px;cursor:pointer}
.pl-x:hover{color:var(--no);border-color:var(--no)}
.pl-tag{display:block;font-style:normal;font-size:12px;color:var(--cyan);margin-top:2px}
.pl-miss{display:block;font-style:normal;font-size:12px;color:var(--amber);margin-top:2px}
.pl-card .legp{display:grid;justify-items:end;align-content:start;text-align:right;flex:none}.pl-card .legp small{display:block}
.pl-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pl-btns .btn{flex:1 1 130px;min-height:44px;padding:11px 10px;font-size:13.5px}
.pl-prog{height:6px;background:var(--soft);border-radius:3px;margin-top:10px;overflow:hidden}.pl-prog i{display:block;height:100%;width:0;background:var(--glow);transition:width .2s}
.pl-sim{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.pl-simh{font-weight:700;font-size:14px}
.pl-hist{width:100%;height:auto;display:block;margin-top:8px}
.pl-report{display:grid;gap:6px}
.pl-rep{display:grid;grid-template-columns:minmax(80px,1fr) auto auto auto;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line);font-size:15px}
.pl-rep b{font-size:15px;letter-spacing:.04em}
.pl-pos{color:var(--yes)}.pl-neg{color:var(--no)}.pl-amb{color:var(--amber)}
.pl-sub{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-top:10px}
.pl-pm{display:grid;gap:8px}
.pl-addr{flex:1 1 220px;min-width:0;min-height:44px;background:var(--soft);border:1px solid var(--line);border-radius:5px;color:var(--text);font:500 14px var(--f);padding:8px 10px}
.pl-pm .btn{min-height:44px;padding:10px 16px}
.pl-pmr{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}.pl-pmr small{display:block;color:var(--dim);font-size:12px}
.pl-tracked{display:grid;gap:10px}
.pl-tr details{margin-top:8px}.pl-tr summary{cursor:pointer;color:var(--blue);min-height:32px}
.pl-trl{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line);font-size:13.5px}
.pl-trl small{color:var(--dim)}
.pl-g button{min-width:40px;min-height:40px;margin-left:4px;background:var(--card-hi);border:1px solid var(--line);border-radius:5px;color:var(--text);cursor:pointer}
.pl-foot{margin-top:16px}
@media(max-width:420px){.pl-stakes .mono{font-size:17px}.pl-rep{grid-template-columns:1fr auto auto}.pl-rep>:last-child{grid-column:1/-1}}
`;
document.head.appendChild(css);

const TAB = { key: 'plan', label: '📅 Weekly Plan', after: 'polymarket', render };
SB.registerTab(TAB);
SB.on('data', () => setTimeout(() => { if (!document.querySelector('#tabs [data-t="plan"]')) SB.registerTab(TAB); }, 0));
window.__plan = { candidates, buildTarget, buildPayout, buildBig, simulate, pOver, roster, weekSim, TIERS, BIG, LEG_OPTIONS, legId, mktOf, get state() { return ST; }, get slips() { return allSlips(); }, get dbMode() { return dbMode; } };
})();
