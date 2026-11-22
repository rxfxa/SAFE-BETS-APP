// 🥊 UFC tab: fight cards from Polymarket (ufc.json, written by tools/ufc_fetch.py). Shows the market's price for each
// outcome: who wins, go the distance, method, rounds. These are Polymarket prices, not our own estimate: no fight model yet.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('ufc.js: window.SB v2 API not found'); return; }
  let U = null, LOADED = false;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const when = s => { const t = Date.parse(s); return isNaN(t) ? '' : new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const stamp = s => { const t = Date.parse(s); return isNaN(t) ? 'unknown' : new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const OVER = 8 * 3600e3;  // a fight's start is the card's start; a whole card is done well inside 8 hours
  const ended = f => Date.parse(f.start) + OVER < Date.now();
  // totals markets price the first outcome, "Over": say so instead of the bare "O/U 2.5 Rounds"
  const label = q => q.replace(/^O\/U ([\d.]+) Rounds?$/i, 'Over $1 rounds');
  const style = document.createElement('style');
  style.textContent = '.ufc-row{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line);font-size:14px}' +
    '.ufc-ml{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}' +
    '.ufc-side{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:14px}' +
    '.ufc-thin{opacity:.6}.ufc-thin b::after{content:" ?";color:var(--amber)}';
  document.head.appendChild(style);
  const load = () => fetch('ufc.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { U = d || { fights: [] }; LOADED = true; SB.render(); });
  load();
  const row = (q, p, thin) => `<div class="ufc-row${thin ? ' ufc-thin' : ''}"><span>${esc(label(q))}</span><b class="mono">${P(p)}</b></div>`;
  // Round and per-fighter KO markets are thin and often sit near a default price, so they can add up to more than the
  // fighter's own win chance. Flag rows that can't all be true rather than present them as clean chances.
  function thinRows(f) {
    const thin = new Set(), why = [], has = (m, s) => m.q.includes(s);
    for (const x of f.ml) {
      const rs = f.rounds.filter(m => has(m, x.name) && /win in Round/i.test(m.q)), sum = rs.reduce((s, m) => s + m.p, 0);
      if (rs.length > 1 && x.p != null && sum > x.p + .05) { rs.forEach(m => thin.add(m)); why.push(`${x.name}'s round prices add up to ${P(sum)}, against ${P(x.p)} to win at all.`); }
    }
    const ko = f.method.find(m => /fight be won by KO/i.test(m.q)), kos = f.method.filter(m => /win by KO/i.test(m.q)), ks = kos.reduce((s, m) => s + m.p, 0);
    if (ko && kos.length === 2 && ks > ko.p + .05) { [ko, ...kos].forEach(m => thin.add(m)); why.push(`Each fighter's KO price adds up to ${P(ks)}, more than the ${P(ko.p)} for any KO.`); }
    const ways = [ko, ...f.method.filter(m => /fight be won by (submission|decision)/i.test(m.q))].filter(Boolean), ws = ways.reduce((s, m) => s + m.p, 0);
    if (ways.length === 3 && ws > 1.05) { ways.forEach(m => thin.add(m)); why.push(`KO, submission and decision add up to ${P(ws)}, though only one of them can happen.`); }
    return { thin, why };
  }
  function fightCard(f) {
    const { thin, why } = thinRows(f), started = Date.parse(f.start) < Date.now();
    return `<div class="pc ufc-card">
      <div class="pchead"><span class="pctitle">${esc(f.fighters[0])} vs ${esc(f.fighters[1])}</span>${started ? '<span class="badge b-est">Card under way</span>' : ''}</div>
      <div class="why">${esc([f.weight, f.card].filter(Boolean).join(' · '))}${f.start ? ' · ' + esc(when(f.start)) : ''}</div>
      <div class="ufc-ml">${f.ml.map(x => `<div class="ufc-side"><b>${esc(x.name)}</b><span class="mono">${P(x.p)}</span></div>`).join('')}</div>
      ${f.distance ? row('Goes the distance', f.distance.p) : ''}
      ${f.method.length ? `<div class="pl-sub">Method</div>${f.method.map(m => row(m.q, m.p, thin.has(m))).join('')}` : ''}
      ${f.rounds.length ? `<div class="pl-sub">Rounds</div>${f.rounds.map(m => row(m.q, m.p, thin.has(m))).join('')}` : ''}
      ${why.length ? `<div class="note">? These prices can't all be true: ${esc(why.join(' '))} Few trades on these markets, so don't read them as chances.</div>` : ''}
      <div class="note"><a href="${esc(f.url)}" target="_blank" rel="noopener">Open on Polymarket</a></div></div>`;
  }
  function render(main) {
    if (!LOADED) { main.innerHTML = '<h2>UFC</h2><div class="pc"><div class="why">Loading fight cards…</div></div>'; return; }
    const all = U.fights || [], F = all.filter(f => !ended(f)), gone = all.length - F.length;
    main.innerHTML = `<h2>UFC <small>fight cards from Polymarket</small></h2>
      <div class="note">Each price is the chance Polymarket's market gave that outcome, not our own estimate. There is no fight model yet. Prices as of <b>${esc(stamp(U.updated))}</b>.</div>
      ${F.length ? F.map(fightCard).join('') : `<div class="pc"><div class="why">${gone ? 'No upcoming UFC fights in the latest Polymarket snapshot.' : 'No UFC fights on Polymarket in the next 10 days.'}</div></div>`}
      ${gone ? `<div class="note">${gone} fight${gone === 1 ? '' : 's'} from a card that has finished ${gone === 1 ? 'is' : 'are'} hidden.</div>` : ''}
      <div class="note">Over/under rounds rows give the chance of the over. Prices move: check each one before you bet.</div>`;
  }
  SB.registerTab({ key: 'ufc', label: '🥊 UFC', after: 'injuries', render });
})();
