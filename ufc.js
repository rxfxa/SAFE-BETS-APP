// 🥊 UFC tab: fight cards from Polymarket (ufc.json, written by tools/ufc_fetch.py). Shows the market's price for each
// outcome: who wins, go the distance, method, rounds. These are Polymarket prices, not our own estimate: no fight model yet.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || typeof SB.registerTab !== 'function') { console.warn('ufc.js: window.SB v2 API not found'); return; }
  let U = null, LOADED = false;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const when = s => { const t = Date.parse(s); return isNaN(t) ? '' : new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const style = document.createElement('style');
  style.textContent = '.ufc-row{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line);font-size:14px}' +
    '.ufc-ml{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}' +
    '.ufc-side{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:14px}';
  document.head.appendChild(style);
  const load = () => fetch('ufc.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(d => { U = d || { fights: [] }; LOADED = true; SB.render(); });
  load();
  const row = (label, p) => `<div class="ufc-row"><span>${esc(label)}</span><b class="mono">${P(p)}</b></div>`;
  function fightCard(f) {
    return `<div class="pc ufc-card">
      <div class="pchead"><span class="pctitle">${esc(f.fighters[0])} vs ${esc(f.fighters[1])}</span></div>
      <div class="why">${esc([f.weight, f.card].filter(Boolean).join(' · '))}${f.start ? ' · ' + esc(when(f.start)) : ''}</div>
      <div class="ufc-ml">${f.ml.map(x => `<div class="ufc-side"><b>${esc(x.name)}</b><span class="mono">${P(x.p)}</span></div>`).join('')}</div>
      ${f.distance ? row('Goes the distance', f.distance.p) : ''}
      ${f.method.length ? `<div class="pl-sub">Method</div>${f.method.map(m => row(m.q, m.p)).join('')}` : ''}
      ${f.rounds.length ? `<div class="pl-sub">Rounds</div>${f.rounds.map(m => row(m.q, m.p)).join('')}` : ''}
      <div class="note"><a href="${esc(f.url)}" target="_blank" rel="noopener">Open on Polymarket</a></div></div>`;
  }
  function render(main) {
    if (!LOADED) { main.innerHTML = '<h2>UFC</h2><div class="pc"><div class="why">Loading fight cards…</div></div>'; return; }
    const F = U.fights || [];
    main.innerHTML = `<h2>UFC <small>fight cards from Polymarket</small></h2>
      <div class="note">Each price is the chance Polymarket's market gives that outcome, not our own estimate. There is no fight model yet.</div>
      ${F.length ? F.map(fightCard).join('') : '<div class="pc"><div class="why">No UFC fights on Polymarket in the next 10 days.</div></div>'}
      <div class="note">Prices as of ${esc(when(U.updated))}. Prices move: check each one before you bet.</div>`;
  }
  SB.registerTab({ key: 'ufc', label: '🥊 UFC', after: 'injuries', render });
})();
