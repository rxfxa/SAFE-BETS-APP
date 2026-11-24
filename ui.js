// Shared components for the research screens (Chat, Insights, Prop Analyzer, Prop Explorer, Games, Sharp Board, Highlights,
// Parlay, Players, Stat Explorer, Fantasy). Every function returns an HTML string with every value escaped; the styles are the
// .ui-* rules in index.html ("Pro interface" block). docs/pro-interface.md lists what each one is for.
//   SB.ui.page({kicker, title, accent, sub})      the screen header: mono kicker, display title (accent part coloured), subtitle
//   SB.ui.pills(items, active, name)               pill row; items [{k, label, n?, dot?}]; buttons carry data-ui-pill="name|k"
//   SB.ui.seg(items, active, name)                 small segmented control; data-ui-seg="name|k"
//   SB.ui.select({label, value, options, name})    labelled dropdown pill (a real <select data-ui-select="name"> inside)
//   SB.ui.dots(arr)                                hit / miss dots: true = hit (green), false = miss (pink), null = no game
//   SB.ui.meter(score, n=8)                        0-100 bar in n segments, toned by score
//   SB.ui.tone(score)                              'good' (>= 60) | 'mid' | 'bad' (< 40)
//   SB.ui.verdict({tone, kicker, title, tag})      the verdict band; tone take | lean | coin | pass
//   SB.ui.factors([{name, tone, status, why}])     2x2 tiles that open to show why (native <details>)
//   SB.ui.gameLog({title, summary, vals, labels, line}) bar chart of recent games with the line drawn
//   SB.ui.propCard(o)                              the flip card (see the function for its fields); data-ui-flip flips it
//   SB.ui.team(abbr, big)                          team badge, colour from the abbreviation
//   SB.ui.split({left, right, rows})               two-sided percentage bars (Sharp Board)
//   SB.ui.table({cols, rows, sort, name})          sortable heat table; header buttons carry data-ui-sort="name|k"
//   SB.ui.tiles([[label, value, hl?]])             small stat tiles
//   SB.ui.empty(text), SB.ui.esc(s), SB.ui.fair(p) (fair American odds text), SB.ui.pays(p, stake=100) (fair payout text)
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2)) { console.warn('ui.js: window.SB v2 API not found'); return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => (typeof x === 'number' && isFinite(x));
  const hue = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const tone = sc => (!num(sc) ? 'mid' : sc >= 60 ? 'good' : sc < 40 ? 'bad' : 'mid');
  const fair = p => (num(p) && p > 0 && p < 1 ? SB.fmtAm(SB.p2am(p)) : '—');
  const pays = (p, stake = 100) => (num(p) && p > 0 && p < 1 ? '$' + stake + ' pays $' + Math.round(stake / p) : '');

  function page(o) {
    o = o || {};
    const t = esc(o.title || ''), a = o.accent ? ` <span class="ac">${esc(o.accent)}</span>` : '';
    return `<div class="ui-head">${o.kicker ? `<div class="ui-kick">${esc(o.kicker)}</div>` : ''}<h1 class="ui-title">${t}${a}</h1>${o.sub ? `<p class="ui-subt">${esc(o.sub)}</p>` : ''}</div>`;
  }
  function pills(items, active, name) {
    return `<div class="ui-pills" role="group">${(items || []).map(it => `<button type="button" class="ui-pill${it.k === active ? ' on' : ''}" data-ui-pill="${esc(name)}|${esc(it.k)}" aria-pressed="${it.k === active}">${it.dot ? `<span class="dot" style="background:${esc(it.dot)}"></span>` : ''}${esc(it.label)}${it.n != null ? `<span class="n">${esc(it.n)}</span>` : ''}</button>`).join('')}</div>`;
  }
  function seg(items, active, name) {
    return `<div class="ui-seg" role="group">${(items || []).map(it => `<button type="button" class="${it.k === active ? 'on' : ''}" data-ui-seg="${esc(name)}|${esc(it.k)}" aria-pressed="${it.k === active}">${esc(it.label)}</button>`).join('')}</div>`;
  }
  function select(o) {
    const opts = (o.options || []).map(x => (Array.isArray(x) ? x : [x, x]));
    const cur = opts.find(x => String(x[0]) === String(o.value)) || opts[0] || ['', ''];
    return `<label class="ui-sel"><span class="l">${esc(o.label)}</span><span class="v">${esc(cur[1])}</span><select data-ui-select="${esc(o.name)}" aria-label="${esc(o.label)}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur[0]) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  function dots(arr) {
    return `<span class="ui-dots" aria-hidden="true">${(arr || []).map(x => `<i class="${x === true ? '' : x === false ? 'x' : 'n'}"></i>`).join('')}</span>`;
  }
  function meter(sc, n = 8) {
    const k = num(sc) ? Math.max(0, Math.min(n, Math.round(sc / 100 * n))) : 0;
    return `<span class="ui-meter ${tone(sc)}" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="${i < k ? 'on' : ''}"></i>`).join('')}</span>`;
  }
  function verdict(o) {
    const t = ['take', 'lean', 'coin', 'pass'].includes(o.tone) ? o.tone : 'lean';
    const ic = { take: '✓', lean: '↗', coin: '≈', pass: '✕' }[t];
    return `<div class="ui-verdict ${t}"><span class="ic" aria-hidden="true">${ic}</span><div>${o.kicker ? `<div class="k">${esc(o.kicker)}</div>` : ''}<div class="t">${esc(o.title)}</div></div>${o.tag ? `<span class="tag">${esc(o.tag)}</span>` : ''}</div>`;
  }
  function factors(list) {
    return `<div class="ui-factors">${(list || []).map(f => `<details class="ui-factor ${['good', 'bad'].includes(f.tone) ? f.tone : ''}"><summary><span><b>${esc(f.name)}</b><span class="st tone-${['good', 'bad'].includes(f.tone) ? f.tone : 'mid'}">${esc(f.status)}</span></span></summary><p>${esc(f.why || '')}</p></details>`).join('')}</div>`;
  }
  function gameLog(o) {
    const vals = (o.vals || []).map(Number), labels = o.labels || [], line = num(o.line) ? o.line : null;
    if (!vals.length) return '';
    const top = Math.max(1, ...vals, line == null ? 0 : line * 1.25) * 1.08;
    const pctOf = v => Math.max(0, Math.min(100, v / top * 100));
    const bars = vals.map((v, i) => {
      const cls = line == null ? '' : v >= line ? 'hit' : 'miss';
      return `<div class="b ${cls}"><span class="v" style="bottom:${pctOf(v)}%">${esc(Number.isInteger(v) ? v : v.toFixed(1))}</span><div class="bar" style="height:${pctOf(v)}%"></div><span class="o">${esc(labels[i] || '')}</span></div>`;
    }).join('');
    const ln = line == null ? '' : `<div class="line" style="bottom:calc(24px + (100% - 50px) * ${pctOf(line) / 100})"></div><span class="lv" style="bottom:calc(24px + (100% - 50px) * ${pctOf(line) / 100})">${esc(line)}</span>`;
    return `<div class="ui-card"><div class="ui-loghead"><span>${esc(o.title || '')}</span>${o.summary ? `<b>${esc(o.summary)}</b>` : ''}</div><div class="ui-log" role="img" aria-label="${esc((o.title || 'Recent games') + ': ' + vals.join(', ') + (line == null ? '' : ', line ' + line))}">${bars}${ln}</div></div>`;
  }
  function team(abbr, big) {
    return `<span class="ui-team${big ? ' lg' : ''}" style="--h:${hue(abbr)}" aria-hidden="true">${esc(String(abbr || '').slice(0, 4))}</span>`;
  }
  // o: {id, first, last, team, pos, matchup, when, market, marketEm, chance, hits:[bool], hitLabel, matchupScore, matchupLabel,
  //     back:{rows:[[k, v]], note}, actions:[{label, attr, value, cta?}] (rendered on both faces), flipLabel}
  function propCard(o) {
    const h = hue(o.team), ch = num(o.chance) ? o.chance : null, ms = num(o.matchupScore) ? Math.round(o.matchupScore) : null;
    const act = (o.actions || []).map(a => `<button type="button" class="${a.cta ? 'ui-cta' : 'ui-ghost'} sm" data-${esc(a.attr)}="${esc(a.value)}">${esc(a.label)}</button>`).join('');
    const id = esc(o.id || '');
    return `<article class="ui-prop" data-ui-card="${id}" style="--h:${h}">
  <div class="f front">
    <div class="hd"><div class="nm"><div class="fn">${esc(o.first || '')}</div><div class="ln">${esc(o.last || '')}</div>
      <div class="mu">${o.pos ? `<span class="pos">${esc(o.pos)}</span>` : ''}<span>${esc(o.matchup || '')}</span>${o.when ? `<span style="color:#ffffff99">· ${esc(o.when)}</span>` : ''}</div></div>${team(o.team)}</div>
    <div class="mk2"><div class="mkt"><span class="t">${o.marketEm ? `<em>${esc(o.marketEm)}</em> ` : ''}${esc(o.market || '')}</span><span class="odds" title="fair odds from the model's chance">${esc(fair(ch))}</span></div>
      <div class="pay">Model chance ${ch == null ? '—' : Math.round(ch * 100) + '%'} · ${esc(pays(ch))} at fair odds</div></div>
    <div class="st2"><div><div class="ui-lbl">Hit rate</div><div class="ui-big">${o.hits && o.hits.length ? Math.round(o.hits.filter(Boolean).length / o.hits.filter(x => x != null).length * 100) || 0 : '—'}<small>%</small></div>${dots(o.hits)}<div class="ui-muted" style="font-size:12px;margin-top:4px">${esc(o.hitLabel || '')}</div></div>
      <div><div class="ui-lbl">Matchup</div><div class="ui-big">${ms == null ? '—' : ms}</div>${meter(ms)}<div class="ui-muted tone-${tone(ms)}" style="font-size:12px;margin-top:4px">${esc(o.matchupLabel || '')}</div></div></div>
    <div class="ft"><button type="button" class="ui-link" data-ui-flip="${id}" aria-label="Show the full matchup for ${esc((o.first || '') + ' ' + (o.last || ''))}">⟳ ${esc(o.flipLabel || 'Flip for the full matchup')}</button>${act}</div>
  </div>
  <div class="f back" aria-hidden="true" inert>
    <div class="hd"><div class="nm"><div class="fn">${esc(o.market || '')}</div><div class="ln">${esc((o.first || '') + ' ' + (o.last || ''))}</div><div class="mu"><span>${esc(o.matchup || '')}</span></div></div>${team(o.team)}</div>
    <div class="rows">${((o.back && o.back.rows) || []).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    ${o.back && o.back.note ? `<div class="note">${esc(o.back.note)}</div>` : ''}
    <div class="ft"><button type="button" class="ui-link" data-ui-flip="${id}">⟲ Back</button>${act}</div>
  </div>
</article>`;
  }
  function split(o) {
    const row = (l, r, label, b) => `<div class="ui-split" style="margin-top:10px"><span class="pct" style="opacity:${l >= r ? 1 : .55}">${Math.round(l)}<small>%</small></span><div><div class="ui-lbl" style="text-align:center;margin-bottom:6px">${esc(label)}</div><div class="track${b ? ' b' : ''}"><i style="width:${Math.max(0, Math.min(100, r))}%"></i></div></div><span class="pct" style="opacity:${r >= l ? 1 : .55}">${Math.round(r)}<small>%</small></span></div>`;
    return `<div>${(o.rows || []).map((x, i) => row(x.l, x.r, x.label, i % 2 === 1)).join('')}</div>`;
  }
  // cols: [{k, label, num?, heat?, fmt?(v,row)}]; rows: objects (row.html for the first column, else row[k]); sort {k, dir}
  function table(o) {
    const cols = o.cols || [], rows = o.rows || [], sk = o.sort && o.sort.k;
    const rng = {};
    for (const c of cols) if (c.heat) { const v = rows.map(r => r[c.k]).filter(num); rng[c.k] = v.length ? [Math.min(...v), Math.max(...v)] : null; }
    const heat = (c, v) => { const R = rng[c.k]; if (!R || !num(v) || R[1] <= R[0]) return ''; const t = (v - R[0]) / (R[1] - R[0]); return ` style="background:rgba(var(--acc-rgb),${(0.05 + 0.5 * t).toFixed(3)})"`; };
    const th = cols.map(c => `<th class="${c.k === sk ? 'on' : ''}" scope="col">${c.sort === false ? esc(c.label) : `<button type="button" data-ui-sort="${esc(o.name)}|${esc(c.k)}">${esc(c.label)}${c.k === sk ? (o.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button>`}</th>`).join('');
    const tr = rows.map(r => `<tr>${cols.map((c, i) => { const v = r[c.k]; const txt = i === 0 && r.html ? r.html : esc(c.fmt ? c.fmt(v, r) : v == null ? '—' : v); return `<td${c.heat ? heat(c, v) : ''}>${txt}</td>`; }).join('')}</tr>`).join('');
    return `<div class="ui-tablewrap"><table class="ui-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  function tiles(list) {
    return `<div class="ui-tiles">${(list || []).map(([l, v, hl]) => `<div class="ui-tile${hl ? ' hl' : ''}"><span class="ui-lbl">${esc(l)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
  }
  const empty = t => `<div class="ui-empty">${esc(t)}</div>`;

  // flip cards (keyboard and pointer); the hidden face is inert so it never takes focus
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ui-flip]'); if (!b) return;
    const card = b.closest('.ui-prop'); if (!card) return;
    const on = !card.classList.contains('flip'); card.classList.toggle('flip', on);
    const F = card.querySelector('.f.front'), B = card.querySelector('.f.back');
    F.inert = on; F.setAttribute('aria-hidden', String(on)); B.inert = !on; B.setAttribute('aria-hidden', String(!on));
    const tgt = (on ? B : F).querySelector('[data-ui-flip]'); if (tgt) setTimeout(() => tgt.focus(), 60);
  });

  SB.ui = { esc, hue, tone, fair, pays, page, pills, seg, select, dots, meter, verdict, factors, gameLog, propCard, team, split, table, tiles, empty };
})();
