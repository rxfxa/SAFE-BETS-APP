// Past Slips: the slips the app made the day before, once they are settled (recs.json, graded each morning by
// tools/recs.mjs). This is the one slip screen on the free plan, so it never shows anything still to play:
//   - only days before today (Los Angeles day);
//   - free: only the day before; paid plans can pick any saved day;
//   - a slip shows only when every one of its games is over (a slip from yesterday can carry a leg on today's game: that
//     slip stays hidden until the game is played, since it would be a live pick).
(function () {
  'use strict';
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || !SB.ui || !SB.engine) { console.warn('pastslips.js: window.SB v2 API not found'); return; }
  const U = SB.ui, E = SB.engine, esc = U.esc, KEY = 'pastslips';
  const OVER_MS = 6 * 3600e3;   // a leg nobody could grade (no box score) counts as over 6 hours after its start
  const KIND = { picks: 'My Parlay Picks', fantasy: 'Fantasy Parlay', props: 'NBA Props', upsets: 'Upset Parlays', pattern: 'Weekend Patterns', parlays: 'Best Parlays', soccer: 'Soccer Parlays' };
  const NAMED = { 'trend-mixed': 'Trend parlay', fantasy: 'Fantasy ticket', sgp: 'Same game parlay', mega20: '20-leg safest combo', stk: 'Duo / trio stack',
    rec4: '4-leg reception parlay', pairs: 'Paired parlay', 'pt-crazy3': '3-upset lotto', 'pt-crazy5': 'Full chaos 5', 'pt-runs': 'Unbeaten runs end', 'pt-steady': 'The steady weekend' };
  const st = { day: null };

  const pct = p => (!(p > 0 && p < 1) ? '' : p >= 0.01 ? Math.round(p * 100) + '%' : p >= 0.001 ? (p * 100).toFixed(1) + '%' : '<0.1%');
  function titleOf(P) {
    if (P.title && P.title !== P.id) return P.title;
    if (NAMED[P.id]) return NAMED[P.id];
    let m;
    if ((m = /^hy(\d+)$/.exec(P.id))) return `High-yield ${m[1]}-leg`;
    if ((m = /^fsday(\d+)$/.exec(P.id))) return `NBA props day slip ${+m[1] + 1}`;
    if ((m = /^fs(\d+)$/.exec(P.id))) return `NBA props slip ${+m[1] + 1}`;
    if ((m = /^ps(\d+)$/.exec(P.id))) return `NBA props, safer ${+m[1] + 1}`;
    if ((m = /^ph(\d+)$/.exec(P.id))) return `NBA props, bigger payout ${+m[1] + 1}`;
    return String(P.id || 'Parlay');
  }
  // a game counts as over by the earlier of this device's clock and the feed's time (a clock set forward opens nothing early;
  // a slip also needs its result, which only the morning grading run writes)
  const nowMs = () => { const t = Date.parse(((SB.DATA || {}).updated) || ''); return Math.min(Date.now(), isFinite(t) ? t + 3600e3 : Date.now()); };
  const today = () => E.dayOf(Date.now());
  const dayBefore = d => new Date(Date.parse(d + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
  const graded = L => L.res === true || L.res === false || L.res === 'void';
  const legOver = (L, now) => graded(L) || (!!L.start && Date.parse(L.start) + OVER_MS < now);
  // won / lost / void; 'nograde': every game is over and no graded leg missed, but a leg has no box score to grade it
  // (only NBA player legs are graded from box scores); 'pending': not over yet
  function resultOf(P, now) {
    const legs = P.legs || [], live = legs.filter(L => L.res !== 'void');
    if (live.some(L => L.res === false)) return 'lost';
    if (live.length && live.every(L => L.res === true)) return 'won';
    if (legs.length && legs.every(L => L.res === 'void')) return 'void';
    if (now != null && legs.length && legs.every(L => legOver(L, now)) && live.some(L => L.res === true)) return 'nograde';
    return 'pending';
  }
  // the settled slips of one day: every game over and a result
  function settled(d, now) {
    return (d.parlays || []).filter(P => Array.isArray(P.legs) && P.legs.length && P.legs.every(L => legOver(L, now)) && resultOf(P, now) !== 'pending');
  }
  function pastDays() {
    const R = SB.DATA && SB.DATA.recs, t = today();
    return ((R && Array.isArray(R.days)) ? R.days : []).filter(d => d && typeof d.day === 'string' && d.day < t).sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  const dayName = d => { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch (e) { return d; } };

  function legRow(L) {
    const r = L.res === true ? ['ps-hit', '✓', 'Hit'] : L.res === false ? ['ps-miss', '✗', 'Missed'] : L.res === 'void' ? ['ps-void', '–', 'Void'] : ['ps-void', '·', 'Not graded'];
    return `<li class="${r[0]}"><span class="ps-ic" aria-hidden="true">${r[1]}</span><span class="ps-lb"><span class="ps-sr">${r[2]}: </span>${esc(L.label || '')}${L.actual != null ? `<small>${esc(String(L.actual))}</small>` : L.res == null ? '<small>no box score to grade it</small>' : ''}</span>${pct(L.p) ? `<span class="ps-p" title="The model's chance before the game"><span class="ps-sr">model chance </span>${pct(L.p)}</span>` : '<span class="ps-p"></span>'}</li>`;
  }
  function slipCard(P, now) {
    const res = resultOf(P, now), legs = P.legs, nHit = legs.filter(L => L.res === true).length, nG = legs.filter(L => L.res === true || L.res === false).length;
    const nNo = legs.filter(L => L.res == null).length;
    const badge = res === 'won' ? '<span class="ui-badge good">Hit</span>' : res === 'lost' ? '<span class="ui-badge bad">Missed</span>' : res === 'nograde' ? `<span class="ui-badge" title="Every graded leg hit; ${nNo} leg${nNo === 1 ? '' : 's'} could not be graded">Not fully graded</span>` : '<span class="ui-badge">Void</span>';
    return `<article class="ui-card ps-card" data-ps-id="${esc(P.id)}" data-ps-res="${res}">
      <div class="ps-top"><div class="ps-t">${esc(titleOf(P))}</div>${badge}</div>
      <div class="ps-sum">${legs.length} legs · ${nHit} of ${nG} graded legs hit${P.p > 0 && P.p < 1 ? ` · the model gave it ${pct(P.p)} (${esc(U.fair(P.p))})` : ''}</div>
      <ul class="ps-legs">${legs.map(legRow).join('')}</ul></article>`;
  }
  const CSS = `.ps-card{display:flex;flex-direction:column;gap:8px}.ps-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.ps-t{font:700 16px/1.3 var(--fui)}.ps-sum{font:500 12.5px/1.4 var(--fui);color:#ffffffa6}
.ps-legs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ps-legs li{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:1px solid var(--hair);font:500 13.5px/1.35 var(--fui)}
.ps-ic{flex:none;width:20px;text-align:center;font-weight:800}.ps-hit .ps-ic{color:var(--good)}.ps-miss .ps-ic{color:#ff7ab8}.ps-void .ps-ic{color:#ffffff66}
.ps-lb{flex:1;min-width:0}.ps-lb small{display:block;font:500 12px var(--fui);color:#ffffff8c}.ps-p{flex:none;font:600 12px var(--fmono);color:#ffffff8c}
.ps-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.ps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:12px}`;
  function css() { if (!document.getElementById('ps-css')) { const s = document.createElement('style'); s.id = 'ps-css'; s.textContent = CSS; document.head.appendChild(s); } }

  function render(main) {
    css();
    const now = nowMs(), t = today(), yest = dayBefore(t), paid = !!(SB.paywall ? SB.paywall.can('picks') : true);
    const R = SB.DATA && SB.DATA.recs;
    // free: the day before only; paid: any saved day before today
    const days = pastDays().filter(d => paid || d.day === yest);
    if (!st.day || !days.some(d => d.day === st.day)) st.day = (days.find(d => d.day === yest) || days[0] || {}).day || null;
    const D = days.find(d => d.day === st.day);
    const isY = !st.day || st.day === yest;
    const head = U.page({ kicker: 'Past slips · settled', title: isY ? "Yesterday's slips," : `${dayName(st.day)}:`, accent: 'graded', sub: `Every parlay the app made ${isY ? 'the day before' : 'that day'}, once its games are over: each leg graded from the final score or the box score, next to the chance the model gave it before the game.` });
    let body;
    if (!R) body = U.empty('The graded slips have not loaded. They come with the next refresh.');
    else if (!D) body = U.empty(`No slips from ${dayName(yest)} yet. Slips are graded each morning by about 4 AM Pacific.`);
    else {
      const S = settled(D, now), all = (D.parlays || []).length, hidden = all - S.length;
      const won = S.filter(P => resultOf(P, now) === 'won').length, lost = S.filter(P => resultOf(P, now) === 'lost').length, nog = S.filter(P => resultOf(P, now) === 'nograde').length;
      const anyGraded = (D.parlays || []).some(P => (P.legs || []).some(graded));
      const gl = S.flatMap(P => P.legs).filter(L => L.res === true || L.res === false), hit = gl.filter(L => L.res === true).length;
      const exp = gl.reduce((a, L) => a + (L.p > 0 && L.p < 1 ? L.p : 0), 0), withP = gl.filter(L => L.p > 0 && L.p < 1).length;
      const groups = new Map(); for (const P of S) { const k = KIND[P.tab] || P.tab || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(P); }
      body = !anyGraded ? `${paid && days.length > 1 ? `<div class="ui-row" style="margin:4px 0 10px">${U.select({ label: 'Day', value: st.day, options: days.map(d => [d.day, dayName(d.day)]), name: 'ps-day' })}</div>` : ''}${U.empty(`The slips from ${dayName(D.day)} are graded each morning by about 4 AM Pacific. Check back then.`)}` : `${paid && days.length > 1 ? `<div class="ui-row" style="margin:4px 0 10px">${U.select({ label: 'Day', value: st.day, options: days.map(d => [d.day, dayName(d.day)]), name: 'ps-day' })}</div>` : ''}
        ${U.tiles([...(paid && days.length > 1 ? [] : [['Day', dayName(D.day)]]), ['Slips settled', String(S.length)], ['Hit', String(won), won > 0], ['Missed', String(lost)], ['Legs hit', gl.length ? `${hit} of ${gl.length}` : '—']])}
        ${withP ? `<p class="ui-muted" style="margin:8px 0">The model expected about ${exp.toFixed(1)} of the ${withP} priced legs to hit. One day is a small sample.</p>` : ''}
        ${nog > 0 ? `<p class="ui-muted" style="margin:8px 0">${nog} slip${nog === 1 ? '' : 's'} hit every graded leg but ${nog === 1 ? 'has' : 'have'} a leg with no box score to grade it (the morning run grades NBA player legs only), so ${nog === 1 ? 'it is' : 'they are'} marked "Not fully graded" and not counted as a hit.</p>` : ''}
        ${hidden > 0 ? `<p class="ui-note" role="note">${hidden} more slip${hidden === 1 ? '' : 's'} from that day ${hidden === 1 ? 'is' : 'are'} not shown: ${hidden === 1 ? 'it has' : 'they have'} a game still to play or a leg still being graded. Past Slips shows a slip only once it is over.</p>` : ''}
        ${S.length ? [...groups.entries()].map(([k, Ps]) => `<h2>${esc(k)} <small>${Ps.length}</small></h2><div class="ps-grid">${Ps.map(P => slipCard(P, now)).join('')}</div>`).join('') : U.empty('None of these slips is settled yet. Check back after the games.')}`;
    }
    const up = SB.paywall && !paid ? `<div class="ui-card" style="margin-top:14px"><div class="ui-lbl">Today's slips</div><p class="ui-muted" style="margin:6px 0 10px">Today's and upcoming slips, My Parlay Picks and the generated parlays come with Betting + Fantasy. This screen shows yesterday's slips once they are settled.</p><button type="button" class="ui-cta sm" data-gotab="plans">See plans</button></div>` : '';
    main.innerHTML = `<div class="ui-page ps-root">${head}${body}${up}
      <p class="ui-note">Chances are the model's estimates made before the games, never guarantees. Legs are graded by the morning run: game lines from final scores, NBA player legs from ESPN box scores; other player legs show "not graded" when there is no box score to check.</p></div>`;
  }
  document.addEventListener('change', e => {
    const s = e.target.closest && e.target.closest('select[data-ui-select="ps-day"]'); if (!s || SB.tab !== KEY) return;
    st.day = s.value; SB.render(); const n = document.querySelector('select[data-ui-select="ps-day"]'); if (n) n.focus();
  });
  SB.registerTab({ key: KEY, label: '🧾 Past Slips', render });
  window.__pastslips = { settled, resultOf, titleOf, pastDays, dayBefore, get state() { return { ...st }; } };
})();
