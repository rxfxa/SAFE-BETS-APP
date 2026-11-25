// Plans and access tiers (owner: "a subscription based payment system… different tiers of access such as: fantasy only,
// betting and fantasy… and everything the app offers. (Low-Mid-High Tier) More money more access").
//
//   Free  My Parlay Picks (Trending) and Games, plus a blurred preview of every other screen.
//   Low   (Fantasy, $9.99/mo)  the fantasy football screens, Fantasy Parlay and Players.
//   Mid   (Betting + Fantasy, $24.99/mo)  Low plus every betting screen, the AI Chat, Sharp Board and Polymarket.
//   High  (Everything, $39.99/mo)  Mid plus Slip Check, the Simulator and the 500,000-run sims, and the research tabs
//         (Weekend Patterns, Team Trends, Upset Parlays, Stat Explorer).
//
// Payment: Stripe payment links (plans.json "links"). Access: an unlock code the owner makes after a payment and sends to
// the customer. A code is "SB1-<payload>.<signature>": payload = base64url JSON {v, t: tier, e: expiry (unix s, 0 = never),
// i: id}; signature = ECDSA P-256 / SHA-256 over the payload text, checked here against plans.json "publicKey". The private
// key never leaves the owner's own browser (Owner tools below) or computer (tools/license.mjs). plans.json "revoked" lists
// code ids that no longer work.
//
// Honest limits (said on the Plans page): the app runs in the browser with public files, so this is a lock for ordinary
// visitors, not a vault; a code unlocks one browser; payments are checked by the owner, not by this page.
// While plans.json has no publicKey (setup) or the page runs on localhost (tests), nothing is locked.
(function () {
  const SB = window.SB;
  if (!SB || !(SB.version >= 2) || !SB.ui) { console.warn('tiers.js: SB v2 + ui.js needed'); return; }
  const U = SB.ui, esc = U.esc, $ = id => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('fm2.pw.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fm2.pw.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem('fm2.pw.' + k); } catch (e) { } },
  };
  const RANK = { free: 0, low: 1, mid: 2, high: 3 }, TIER_OF = ['free', 'low', 'mid', 'high'];
  const DEF_PLANS = [
    { id: 'low', tag: 'Low', name: 'Fantasy', month: 9.99, year: 99.99, blurb: 'Fantasy football: start / sit, trades, your team, rankings, Fantasy Parlay and player pages.' },
    { id: 'mid', tag: 'Mid', name: 'Betting + Fantasy', month: 24.99, year: 249.99, popular: true, blurb: 'Everything in Fantasy plus the betting screens: My Parlay Picks and generated parlays, AI Chat, props, Sharp Board, Polymarket, highlights.' },
    { id: 'high', tag: 'High', name: 'Everything', month: 39.99, year: 399.99, blurb: 'Everything in Betting + Fantasy plus Slip Check, the game Simulator and 500,000-run sims, and the research tabs.' },
  ];
  // what each screen needs (0 free … 3 high); a screen not listed needs Mid (every other betting screen).
  // Free (owner, 2026-11-25): odds only (Games, the sport tabs, game pages, Odds tools), the parlay builder without
  // Generate, and yesterday's settled slips (Past Slips). No generated parlays, picks or leans: `picks` is that pseudo-screen.
  const NEED = { slate: 0, soccer: 0, nba: 0, nfl: 0, nhl: 0, ncaaf: 0, odds: 0, builder: 0, pastslips: 0, plans: 0, trending: 2, picks: 2, 'ff-startsit': 1, 'ff-trade': 1, 'ff-rate': 1, 'ff-rank': 1, fantasy: 1, players: 1, mine: 1,
    slipcheck: 3, sim: 3, pattern: 3, trends: 3, upsets: 3, statx: 3 };
  const needOf = k => (k in NEED ? NEED[k] : 2);
  const FREE_LINE = "Free: odds (Games, the sport tabs, game pages), the parlay builder and yesterday's settled slips.";
  // buttons that run the simulations: 500,000 runs and Watch live on every card, the soccer tab's simulate button
  const SIM_SEL = '[data-sim5],[data-simp],[data-sp-sim],[data-pl-sim],[data-pl-week]';
  // generated parlays and picks outside the locked screens: the builder's Generate
  const GEN_SEL = '[data-ui-seg="bld-mode|gen"],[data-bld-build]', SAVE_SEL = '[data-savep]';
  const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  let CFG = null, CFGST = 'loading', ST = { tier: 'free', exp: 0, id: null, why: '', checked: false }, OWNER = false, KEY = null, KEYJ = '';
  const plans = () => (CFG && Array.isArray(CFG.plans) && CFG.plans.length === 3 ? CFG.plans : DEF_PLANS);
  const planOf = r => plans()[Math.max(0, Math.min(2, r - 1))];
  const pubOk = j => j && j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string';
  // plans are on when plans.json has a key; while it loads (or if it fails) a key seen here before keeps them on
  const PK0 = (() => { const k = LS.get('pk', null); return pubOk(k) ? k : null; })();
  const keyNow = () => (CFGST === 'ok' ? (pubOk(CFG.publicKey) ? CFG.publicKey : null) : PK0);
  const enforced = () => !!keyNow() && !(isLocal() && !(CFG && CFG.enforceLocal));
  const pending = () => enforced() && (CFGST === 'loading' || !ST.checked);
  // expiry against the newer of this device's clock and the feed's server time (setting a phone back doesn't extend a code)
  const nowMs = () => Math.max(Date.now(), Date.parse(((SB.DATA || {}).updated) || '') || 0);
  const firstVisit = (() => { try { return localStorage.getItem('fm2.tab') == null; } catch (e) { return false; } })();
  const rank = () => (!enforced() ? 3 : OWNER ? 3 : RANK[ST.tier] || 0);
  const can = k => rank() >= needOf(k);
  const money = x => '$' + Number(x).toFixed(2);

  // ---------- codes ----------
  const b64e = u8 => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const b64d = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const subtle = () => (window.crypto && crypto.subtle) || null;
  async function verifyKey() {
    const j = keyNow(), k = j.x + '|' + j.y; if (KEY && KEYJ === k) return KEY;
    KEY = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); KEYJ = k; return KEY;
  }
  // -> {ok, tier, exp, id, why}
  async function checkCode(code) {
    const m = /^SB1-([A-Za-z0-9_-]{8,400})\.([A-Za-z0-9_-]{40,120})$/.exec(String(code || '').replace(/\s+/g, ''));
    if (!m) return { ok: false, why: "That doesn't look like a Safe Bets unlock code (they start with SB1-)." };
    if (!subtle()) return { ok: false, why: "This browser can't check codes (no Web Crypto). Try a current Chrome, Safari or Firefox." };
    if (!enforced()) return { ok: false, why: 'Plans are not switched on yet, so there is nothing to unlock: every screen is open.' };
    let p; try { p = JSON.parse(new TextDecoder().decode(b64d(m[1]))); } catch (e) { return { ok: false, why: 'This code is damaged. Copy it again exactly as it was sent.' }; }
    let good = false; try { good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, await verifyKey(), b64d(m[2]), new TextEncoder().encode(m[1])); } catch (e) { good = false; }
    if (!good) return { ok: false, why: "This code isn't valid for this app. Copy it again exactly as it was sent, or ask for a new one." };
    if (!p || p.v !== 1 || !RANK[p.t] || typeof p.i !== 'string') return { ok: false, why: 'This code is from a newer version of the app. Reload the page.' };
    if (((CFG && CFG.revoked) || []).includes(p.i)) return { ok: false, tier: p.t, id: p.i, why: 'This code has been cancelled. Ask the app owner for a new one.' };
    if (p.e && p.e * 1000 < nowMs()) return { ok: false, tier: p.t, id: p.i, exp: p.e, why: `This code expired on ${new Date(p.e * 1000).toLocaleDateString()}. Renew your plan for a new code.` };
    return { ok: true, tier: p.t, exp: p.e || 0, id: p.i };
  }
  async function refreshState() {
    ST = { tier: 'free', exp: 0, id: null, why: '', checked: false }; OWNER = false;
    if (!enforced()) { ST.checked = true; return; }
    const code = LS.get('code', null);
    if (code) { const r = await checkCode(code); if (r.ok) ST = { tier: r.tier, exp: r.exp, id: r.id, why: '', checked: true }; else ST = { tier: 'free', exp: r.exp || 0, id: r.id || null, why: r.why, checked: true }; }
    OWNER = await ownerCheck();
    ST.checked = true;
  }
  // the owner's browser holds the private key; prove it by signing a fresh challenge that the published key accepts
  async function ownerCheck() {
    const j = LS.get('owner', null); if (!j || !enforced() || !subtle()) return false;
    const K = keyNow(); if (!K || j.x !== K.x || j.y !== K.y) return false;
    try {
      const k = await subtle().importKey('jwk', j, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const msg = crypto.getRandomValues(new Uint8Array(32)), sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k, msg);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, await verifyKey(), sig, msg);
    } catch (e) { return false; }
  }
  async function issue(privJwk, tier, days) {
    const k = await subtle().importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const id = b64e(crypto.getRandomValues(new Uint8Array(6)));
    const e = days > 0 ? Math.floor(Date.now() / 1000 + days * 86400) : 0;
    const pay = b64e(new TextEncoder().encode(JSON.stringify({ v: 1, t: tier, e, i: id })));
    const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k, new TextEncoder().encode(pay)));
    return { code: `SB1-${pay}.${b64e(sig)}`, id, t: tier, e };
  }

  // ---------- config ----------
  function loadCfg() {
    return fetch('plans.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(async d => {
      if (d && typeof d === 'object') { CFG = d; CFGST = 'ok'; if (pubOk(d.publicKey)) LS.set('pk', { kty: 'EC', crv: 'P-256', x: d.publicKey.x, y: d.publicKey.y }); else LS.del('pk'); }
      else { CFG = { plans: DEF_PLANS }; CFGST = 'missing'; }
      await refreshState();
      // a first visit opens on a screen the visitor can use (the default screen, Chat, is part of Betting + Fantasy)
      if (enforced() && firstVisit && !OWNER && !can(SB.tab)) SB.goTab('slate', {}); else SB.render();
      paintChrome();
    });
  }

  // ---------- the gate on locked screens: a blurred, inert preview with what it takes to open it ----------
  const STYLE = `
#pwGate{position:sticky;top:calc(env(safe-area-inset-top,0px) + 66px);z-index:30;margin:14px max(16px,env(safe-area-inset-right,0px)) 0 max(16px,env(safe-area-inset-left,0px));display:flex;justify-content:center}
@media(min-width:900px){#pwGate{top:24px;margin-left:calc(var(--side) + 32px);margin-right:32px}}
#pwGate[hidden]{display:none}
.pw-card{width:min(560px,100%);display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:22px;border:1px solid rgba(var(--acc-rgb),.45);background:linear-gradient(180deg,rgba(10,16,28,.97),rgba(5,10,20,.97));box-shadow:0 30px 70px -20px rgba(0,0,0,.9),0 0 60px -24px rgba(var(--acc-rgb),.8)}
.pw-card h2{font:800 22px/1.15 'Rubik',sans-serif!important;margin:0!important}.pw-card h2::before{display:none!important}
.pw-card p{font:400 14.5px/1.5 var(--fui);color:#ffffffbf;margin:0}
.pw-price{font:600 14px var(--fui);color:#ffffffb3}.pw-price b{font:900 italic 30px/1 'Rubik',sans-serif;color:#fff;margin-right:4px}
main.pw-lock,#sub.pw-lock{filter:blur(7px) saturate(.7);opacity:.55;pointer-events:none;user-select:none;max-height:1500px;overflow:hidden}
.pw-card h2:focus{outline:none}
.pw-lk{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.08);font:700 9.5px var(--fmono);letter-spacing:.1em;color:#ffffff99}
.pw-stat{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-height:40px;padding:4px 10px;border:1px solid var(--hair2);border-radius:10px;background:rgba(255,255,255,.04);color:#fff;font:600 12.5px var(--fui);cursor:pointer;text-align:left}
.pw-stat small{font:500 11px var(--fui);color:var(--acc2)}
.pw-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:14px}
.pw-plan{position:relative;display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:20px;border:1px solid var(--hair2);background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.012))}
.pw-plan.pop{border-color:rgba(var(--acc-rgb),.6);box-shadow:0 0 50px -24px rgba(var(--acc-rgb),.9)}
.pw-plan.cur{outline:2px solid var(--good);outline-offset:2px}
.pw-plan .nm{font:800 20px 'Rubik',sans-serif}.pw-plan .bl{font:400 13.5px/1.45 var(--fui);color:#ffffffb3}
.pw-plan .pr b{font:900 italic 34px/1 'Rubik',sans-serif}.pw-plan .pr span{font:600 13px var(--fui);color:#ffffff99;margin-left:4px}
.pw-plan ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font:400 13.5px/1.4 var(--fui);color:#ffffffd9}
.pw-plan li::before{content:"✓";color:var(--good);font-weight:800;margin-right:8px}
.pw-plan .ui-cta,.pw-plan .ui-ghost{margin-top:auto;width:100%}
.pw-tbl td:first-child{white-space:normal}
.pw-in{width:100%;min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--hair2);background:rgba(255,255,255,.04);color:#fff;font:500 14px var(--fmono)}
.pw-in:focus{outline:none;border-color:var(--acc)}
textarea.pw-in{min-height:96px;padding:10px 14px;resize:vertical;font-size:12.5px}
.pw-msg{font:500 13.5px/1.45 var(--fui)}.pw-msg.bad{color:#ff7ab8}.pw-msg.good{color:var(--good)}
.pw-own{border:1px dashed var(--hair2);border-radius:18px;padding:4px 16px}
.pw-own summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font:700 14px var(--fui)}
.pw-own .blk{display:flex;flex-direction:column;gap:10px;padding:12px 0;border-top:1px solid var(--hair)}
.pw-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:8px}
`;
  if (!$('pw-css')) { const st = document.createElement('style'); st.id = 'pw-css'; st.textContent = STYLE; document.head.appendChild(st); }

  function screenName(k) { const b = document.querySelector(`#tabs .tab[data-t="${CSS.escape ? CSS.escape(k) : k}"] .tl`); return b ? b.textContent.trim() : 'This screen'; }
  function gateHTML(view) {
    if (pending()) return `<div class="pw-card" role="status"><div class="ui-kick">Your plan</div><h2 id="pwGateH" tabindex="-1">Checking your plan…</h2></div>`;
    const need = needOf(view), P = planOf(need), name = screenName(view);
    const what = need === 1 ? 'Fantasy football screens start at the Fantasy plan.' : need === 2 ? 'Betting screens start at the Betting + Fantasy plan.' : 'Slip Check, the Simulator, the 500,000-run sims and the research tabs come with Everything.';
    return `<div class="pw-card" role="region" aria-label="Locked: ${esc(name)}">
      <div class="ui-kick">${esc(P.tag)} plan · ${esc(P.name)}</div>
      <h2 id="pwGateH" tabindex="-1">${esc(name)} is part of ${esc(P.name)}</h2>
      <p>${esc(what)} ${ST.why ? esc(ST.why) : ''}</p>
      <div class="pw-price"><b>${money(P.month)}</b>/month · or ${money(P.year)}/year</div>
      <div class="ui-row"><button type="button" class="ui-cta" data-gotab="plans">Upgrade</button><button type="button" class="ui-ghost" data-pw-code>Have a code?</button></div>
      <p style="font-size:12.5px;color:#ffffff80">${esc(FREE_LINE)} Everything else shows a preview.</p></div>`;
  }
  const LOCKED_IDS = ['main', 'sub', 'labHost'];
  const blank = root => { if (!root) return; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (/[A-Za-z0-9]/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/[A-Za-z0-9]/g, '•'); };
  let LOCKED = false, LASTV = null, BLANKQ = false;
  function gate(view) {
    const G = $('pwGate'); if (!G || !$('main')) return;
    const locked = enforced() && (pending() ? needOf(view) > 0 : !can(view));  // nothing is gated before plans are on
    const changed = view !== LASTV; LASTV = view; LOCKED = locked;
    if (!locked) {
      if (!G.hidden) { G.hidden = true; G.innerHTML = ''; }
      for (const id of LOCKED_IDS) { const E = $(id); if (E && E.classList.contains('pw-lock')) { E.classList.remove('pw-lock'); E.inert = false; E.removeAttribute('aria-hidden'); } }
      if ($('labHost') && view === 'lab') $('labHost').hidden = false;
      return;
    }
    for (const id of LOCKED_IDS) { const E = $(id); if (!E) continue; E.classList.add('pw-lock'); E.inert = true; E.setAttribute('aria-hidden', 'true'); blank(E); }
    if ($('labHost')) $('labHost').hidden = true;
    G.hidden = false; G.innerHTML = gateHTML(view);
    // keyboard: a locked screen opened from the sidebar puts focus on the gate, so it is announced and reachable
    const a = document.activeElement;
    if (changed && (!a || a === document.body || (a.closest && a.closest('#tabs')))) requestAnimationFrame(() => { const h = $('pwGateH'); if (h) h.focus({ preventScroll: true }); });
  }
  // keep a locked screen inert (the phone menu frees `main` when it closes) and keep later redraws (async modules) blanked
  const watch = new MutationObserver(recs => {
    if (!LOCKED) return;
    for (const id of LOCKED_IDS) { const E = $(id); if (E && E.classList.contains('pw-lock') && !E.inert) E.inert = true; }
    if (!BLANKQ && recs.some(r => r.type !== 'attributes')) { BLANKQ = true; requestAnimationFrame(() => { BLANKQ = false; if (LOCKED) for (const id of LOCKED_IDS) { const E = $(id); if (E && E.classList.contains('pw-lock')) blank(E); } }); }
  });
  for (const id of LOCKED_IDS) { const E = $(id); if (E) watch.observe(E, { attributes: true, attributeFilter: ['inert'], childList: true, subtree: true, characterData: true }); }

  // sidebar: lock badges on screens above your plan, your plan at the bottom; phones: Upgrade instead of Ask when Chat is locked
  function badges(T) {
    if (!T) return;
    for (const b of T.querySelectorAll('.tab[data-t]')) {
      const old = b.querySelector('.pw-lk'); if (old) old.remove(); b.removeAttribute('aria-label');
      if (!enforced() || pending() || can(b.dataset.t)) continue;
      const P = planOf(needOf(b.dataset.t)); const s = document.createElement('span'); s.className = 'pw-lk'; s.textContent = '🔒 ' + P.tag.toUpperCase(); s.title = 'Part of ' + P.name; s.setAttribute('aria-hidden', 'true'); b.appendChild(s);
      const tl = b.querySelector('.tl'); b.setAttribute('aria-label', ((tl ? tl.textContent : b.textContent) || '').trim() + ' (locked, ' + P.name + ' plan)');
    }
  }
  function paintChrome() {
    const F = document.querySelector('.side-foot'); if (F) {
      let s = $('pwStat');
      if (!enforced()) { if (s) s.remove(); }
      else {
        if (!s) { s = document.createElement('button'); s.type = 'button'; s.id = 'pwStat'; s.className = 'pw-stat'; s.dataset.gotab = 'plans'; F.insertBefore(s, F.firstChild); F.style.flexWrap = 'wrap'; }
        const r = rank(), label = OWNER ? 'Owner' : r === 0 ? 'Free' : planOf(r).name;
        s.innerHTML = `${esc(label)}<small>${r >= 3 ? 'Full access' : 'Upgrade'}</small>`;
        s.setAttribute('aria-label', `Your plan: ${label}. Open Plans`);
      }
    }
    // the phone Ask button and the logos open Chat; while Chat is locked they offer Upgrade / the free screen instead
    const chatLocked = enforced() && !pending() && !can('ask');
    const A = document.querySelector('.askpill'); if (A) { A.textContent = chatLocked ? 'Upgrade' : 'Ask'; A.dataset.gotab = chatLocked ? 'plans' : 'ask'; }
    for (const B of document.querySelectorAll('.brand')) B.dataset.gotab = chatLocked ? 'slate' : 'ask';
    badges($('tabs'));
  }
  SB.on('rendered', v => { gate(v); paintChrome(); });
  SB.on('tabs', T => badges(T));
  // a new feed brings a newer server time: re-check the code's expiry
  SB.on('data', () => { if (enforced() && ST.checked && (ST.exp || ST.why)) refreshState().then(() => { SB.render(); paintChrome(); }); });

  // the simulation buttons on every card (High)
  const upsell = (need, title, what) => { const P = planOf(need);
    SB.openSheet(`<h2>${esc(title)} ${need === 1 ? 'start at' : 'are part of'} ${esc(P.name)}</h2><div class="note">${esc(what)} come with the ${esc(P.name)} plan (${money(P.month)}/month) and above.</div>
      <div class="ui-row" style="margin-top:12px"><button type="button" class="ui-cta" data-gotab="plans">Upgrade</button><button type="button" class="ui-ghost" data-pw-code>Have a code?</button></div>`, { label: 'Upgrade' }); };
  document.addEventListener('click', e => {
    if (!enforced() || pending() || !e.target.closest) return;
    const r = rank(); let hit = null;
    if (r < 3 && e.target.closest(SIM_SEL)) hit = [3, 'Simulations', 'The 500,000-run sims, Watch live and the game Simulator'];
    else if (r < 2 && e.target.closest(GEN_SEL)) hit = [2, 'Generated parlays', 'Parlays the model builds for you, My Parlay Picks and the leans'];
    else if (r < 1 && e.target.closest(SAVE_SEL)) hit = [1, 'Saved parlays', 'Saving parlays to My Parlays'];
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation(); upsell(...hit);
  }, true);
  document.addEventListener('click', e => { if (e.target.closest('[data-pw-code]')) { e.preventDefault(); UI.focused = false; SB.goTab('plans', { code: true }); } });

  // ---------- the Plans screen ----------
  const UI = { period: LS.get('period', 'month'), msg: '', msgOk: false, own: { out: null, msg: '' } };
  const featureRows = [
    ['Odds: Games, the sport tabs, game pages, Odds tools', 0], ['The parlay builder (build your own) and your slip', 0], ["Past Slips: yesterday's settled slips", 0],
    ['Fantasy: Start / Sit, Trade Analyzer, Rate My Team, Rankings', 1], ['Fantasy Parlay, Players, My Parlays (saved parlays)', 1],
    ['Trending with My Parlay Picks, generated parlays, leans and live slips', 2], ['AI Chat, Insights, Prop Explorer, Prop Analyzer', 2], ['Best Parlays, NBA Props, First TD, soccer and point lottos', 2], ['Sharp Board, Polymarket, Weekly Plan, Highlights, UFC, Sharp Lab', 2],
    ['Slip Check, Simulator, 500,000-run sims, Watch live', 3], ['Weekend Patterns, Team Trends, Upset Parlays, Stat Explorer', 3],
  ];
  function linkOf(id, per) { const L = CFG && CFG.links && CFG.links[id] && CFG.links[id][per]; return typeof L === 'string' && /^https:\/\/[^\s"'<>]+$/.test(L) ? L : null; }
  function plansHTML(params) {
    const r = rank(), on = enforced(), per = UI.period === 'year' ? 'year' : 'month';
    const st = !on ? (CFGST === 'loading' ? 'Checking your plan…' : 'Plans are not switched on yet: every screen is open.')
      : OWNER ? 'Owner: full access on this browser.'
      : r === 0 ? FREE_LINE + ' Previews of the rest.'
      : `${planOf(r).name}${ST.exp ? ` · until ${new Date(ST.exp * 1000).toLocaleDateString()}` : ''}`;
    const cards = plans().map((P, i) => {
      const tierR = i + 1, cur = on && !OWNER && r === tierR, L = linkOf(P.id, per), price = per === 'year' ? P.year : P.month;
      const inc = featureRows.filter(([, n]) => n > 0 && n <= tierR && (n === tierR || tierR === 1)).map(([t]) => t);
      const list = tierR === 1 ? inc : [`Everything in ${plans()[i - 1].name}`, ...inc];
      return `<div class="pw-plan${P.popular ? ' pop' : ''}${cur ? ' cur' : ''}">
        <div class="ui-row" style="justify-content:space-between"><span class="ui-kick">${esc(P.tag)}</span>${P.popular ? '<span class="ui-badge">Popular</span>' : ''}${cur ? '<span class="ui-badge good">Your plan</span>' : ''}</div>
        <div class="nm">${esc(P.name)}</div><div class="pr"><b>${money(price)}</b><span>/${per === 'year' ? 'year' : 'month'}</span>${per === 'year' ? `<span>· ${money(price / 12)}/mo</span>` : ''}</div>
        <div class="bl">${esc(P.blurb || '')}</div><ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${L ? `<a class="ui-cta" href="${esc(L)}" target="_blank" rel="noopener noreferrer" data-pw-buy="${esc(P.id)}">${cur ? 'Renew' : 'Choose'} ${esc(P.name)} ↗</a>` : `<button type="button" class="ui-ghost" disabled>Payment link coming soon</button>`}</div>`;
    }).join('');
    const tbl = U.table({ name: 'pwcmp', cols: [{ k: 'f', label: 'What you get', sort: false }, ...['Free', ...plans().map(p => p.tag)].map((l, i) => ({ k: 'c' + i, label: l, sort: false }))],
      rows: featureRows.map(([t, n]) => ({ f: t, html: esc(t), c0: n === 0 ? '✓' : '—', c1: n <= 1 ? '✓' : '—', c2: n <= 2 ? '✓' : '—', c3: '✓' })) });
    const after = (CFG && CFG.afterPay) || 'After you pay, the app owner sends you an unlock code by email or message. Paste it below to open your plan on this browser.';
    const contact = CFG && typeof CFG.contact === 'string' && CFG.contact.trim() ? CFG.contact.trim() : '';
    return `<div class="ui-page pw-page">
      ${U.page({ kicker: 'Pick your plan', title: 'More access,', accent: 'more edge', sub: 'Three plans: fantasy only, betting and fantasy, or everything the app does. Every number in the app is a model estimate, never a guarantee.' })}
      <div class="ui-card"><div class="ui-lbl">Your plan</div><div style="font:700 18px 'Rubik',sans-serif;margin-top:6px" id="pwState">${esc(st)}</div>
        ${ST.why && on && !OWNER && r === 0 ? `<p class="pw-msg bad" style="margin-top:6px">${esc(ST.why)}</p>` : ''}
        ${on && LS.get('code', null) ? `<button type="button" class="ui-link" data-pw-forget>Remove my code from this browser</button>` : ''}</div>
      ${U.seg([{ k: 'month', label: 'Monthly' }, { k: 'year', label: 'Yearly · about 2 months free' }], per, 'pwper')}
      <div class="pw-plans">${cards}</div>
      <p class="ui-note">${esc(after)}${contact ? ' Questions: ' + esc(contact) + '.' : ''} Payments are handled by Stripe; this page never sees your card.</p>
      <div class="ui-card" id="pwCodeBox"><div class="ui-lbl">Have an unlock code?</div>
        <div class="ui-row" style="margin-top:8px;flex-wrap:nowrap"><input class="pw-in" id="pwCode" placeholder="SB1-…" autocomplete="off" spellcheck="false" aria-label="Unlock code"><button type="button" class="ui-cta sm" data-pw-unlock>Unlock</button></div>
        <p class="pw-msg ${UI.msgOk ? 'good' : 'bad'}" id="pwMsg" role="status" aria-live="polite" tabindex="-1">${esc(UI.msg)}</p></div>
      <h2>What each plan opens</h2>${tbl}
      <p class="ui-note">A code opens its plan on the browser you enter it in; renewals come with a new code. This app runs in your browser, so the lock keeps out casual visitors rather than determined ones. Bets are placed at your own sportsbook; 21+.</p>
      ${ownerHTML()}</div>`;
  }

  // ---------- owner tools (all local to this browser) ----------
  function ownerHTML() {
    const j = LS.get('owner', null), pub = j ? JSON.stringify({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y }) : '';
    const live = j && CFG && pubOk(CFG.publicKey) && CFG.publicKey.x === j.x && CFG.publicKey.y === j.y;
    const issued = LS.get('issued', []), rev = issued.filter(x => x.rev).map(x => x.i);
    const links = ['low', 'mid', 'high'].map(id => ['month', 'year'].map(per => `<label class="ui-lbl" style="display:flex;flex-direction:column;gap:4px">${esc(planOf(RANK[id]).name)} · ${per}ly<input class="pw-in" data-pw-link="${id}|${per}" value="${esc((CFG && CFG.links && CFG.links[id] && CFG.links[id][per]) || '')}" placeholder="https://buy.stripe.com/…"></label>`).join('')).join('');
    const out = UI.own.out;
    return `<details class="pw-own" ${UI.own.open ? 'open' : ''} data-pw-own><summary>Owner tools (for the app's owner)</summary>
      <div class="blk"><p class="ui-muted">Everything here stays in this browser. The signing key makes unlock codes: never share it. Only its public half goes into the app.</p>
      ${!j ? `<div class="ui-row"><button type="button" class="ui-cta sm" data-pw-own="gen">Create a signing key</button></div>
        <label class="ui-lbl">Or restore a saved key<textarea class="pw-in" id="pwRestore" placeholder='{"kty":"EC","crv":"P-256",…,"d":"…"}'></textarea></label><div><button type="button" class="ui-ghost sm" data-pw-own="restore">Restore key</button></div>`
      : `<div class="pw-msg ${live ? 'good' : ''}">${live ? '✓ This key is the one the app checks codes with. This browser has full access.' : 'Step 2: add this public key to the app (send it to Claude to put in plans.json, then publish). Until then plans stay switched off.'}</div>
        <label class="ui-lbl">Public key (safe to share)<textarea class="pw-in" readonly id="pwPub">${esc(pub)}</textarea></label>
        <div class="ui-row"><button type="button" class="ui-ghost sm" data-pw-copy="pwPub">Copy public key</button><button type="button" class="ui-ghost sm" data-pw-own="backup">${UI.own.showBk ? 'Hide' : 'Show'} key backup</button></div>
        ${UI.own.showBk ? `<label class="ui-lbl">Signing key backup: keep it private (a password manager is a good place)<textarea class="pw-in" readonly id="pwBk">${esc(JSON.stringify(j))}</textarea></label><div><button type="button" class="ui-ghost sm" data-pw-copy="pwBk">Copy backup</button></div>` : ''}`}
      </div>
      ${j ? `<div class="blk"><div class="ui-lbl">Make an unlock code</div>
        <div class="pw-grid2">${U.select({ label: 'Plan', value: UI.own.t || 'mid', options: [['low', 'Fantasy (Low)'], ['mid', 'Betting + Fantasy (Mid)'], ['high', 'Everything (High)']], name: 'pwt' })}
          ${U.select({ label: 'Lasts', value: String(UI.own.d || 34), options: [['34', '1 month (+3 days grace)'], ['369', '1 year (+3 days grace)'], ['7', '7-day trial'], ['0', 'Never expires']], name: 'pwd' })}</div>
        <input class="pw-in" id="pwLabel" placeholder="Who it's for (kept on this browser only)" autocomplete="off">
        <div><button type="button" class="ui-cta sm" data-pw-own="issue">Make code</button></div>
        ${out ? `<label class="ui-lbl">Code<textarea class="pw-in" readonly id="pwOut">${esc(out.code)}</textarea></label>
          <label class="ui-lbl">Message to send<textarea class="pw-in" readonly id="pwOutMsg">${esc(`Your Safe Bets ${planOf(RANK[out.t]).name} unlock code:\n${out.code}\n\nOpen the app, go to Plans, paste it under "Have an unlock code?" and press Unlock. ${out.e ? 'Good until ' + new Date(out.e * 1000).toLocaleDateString() + '.' : 'It does not expire.'}`)}</textarea></label>
          <div class="ui-row"><button type="button" class="ui-ghost sm" data-pw-copy="pwOut">Copy code</button><button type="button" class="ui-ghost sm" data-pw-copy="pwOutMsg">Copy message</button></div>` : ''}
        <p class="pw-msg" role="status">${esc(UI.own.msg || '')}</p></div>
      <div class="blk"><div class="ui-lbl">Codes made on this browser (${issued.length})</div>
        ${issued.length ? U.table({ name: 'pwiss', cols: [{ k: 'l', label: 'For', sort: false }, { k: 't', label: 'Plan', sort: false }, { k: 'x', label: 'Until', sort: false }, { k: 'r', label: '', sort: false }],
          rows: issued.slice().reverse().slice(0, 50).map(x => ({ l: x.label || '—', html: esc(x.label || '—') + `<span class="pt">${esc(x.i)}</span>`, t: planOf(RANK[x.t]).tag, x: x.e ? new Date(x.e * 1000).toLocaleDateString() : 'never', r: x.rev ? 'cancelled' : '' })) }) : '<p class="ui-muted">None yet.</p>'}
        ${issued.length ? `<div class="ui-row">${U.select({ label: 'Cancel code', value: '', options: [['', 'Pick a code…'], ...issued.filter(x => !x.rev).map(x => [x.i, (x.label || x.i) + ' · ' + planOf(RANK[x.t]).tag])], name: 'pwrev' })}</div>` : ''}
        ${rev.length ? `<p class="ui-muted">Cancelled codes stop working once their ids are in plans.json "revoked": ${esc(rev.join(', '))}</p>` : ''}</div>` : ''}
      <div class="blk"><div class="ui-lbl">Stripe payment links (one per plan and period: Stripe dashboard → Payment Links, recurring)</div>
        <div class="pw-grid2">${links}</div>
        <label class="ui-lbl" style="display:flex;flex-direction:column;gap:4px">Where customers reach you (shown on Plans)<input class="pw-in" id="pwContact" value="${esc((CFG && CFG.contact) || '')}" placeholder="support email or link"></label>
        <div><button type="button" class="ui-ghost sm" data-pw-own="cfg">Make plans.json settings</button></div>
        ${UI.own.cfg ? `<textarea class="pw-in" readonly id="pwCfg">${esc(UI.own.cfg)}</textarea><div><button type="button" class="ui-ghost sm" data-pw-copy="pwCfg">Copy settings</button></div><p class="ui-muted">Send these to Claude (no secrets in them) to publish with the app.</p>` : ''}</div>
    </details>`;
  }
  async function copyEl(id) {
    const el = $(id); if (!el) return;
    try { await navigator.clipboard.writeText(el.value || el.textContent); SB.toast('Copied'); } catch (e) { el.focus(); el.select && el.select(); SB.toast('Select the text and copy it (the browser blocked the clipboard)'); }
  }
  // redraw the Plans page and put focus back on the control the viewer used (by its data attribute or id)
  function rerender(focusSel) {
    if (SB.tab !== 'plans') return;
    const a = document.activeElement, sel = focusSel || (a && a !== document.body ? (['data-ui-seg', 'data-ui-select', 'data-pw-own', 'data-pw-copy', 'data-pw-unlock'].map(k => a.getAttribute && a.getAttribute(k) != null ? `[${k}="${CSS.escape(a.getAttribute(k))}"]` : null).find(Boolean) || (a.id ? '#' + CSS.escape(a.id) : null)) : null);
    SB.render(); if (sel) { const el = document.querySelector('#main ' + sel); if (el) el.focus({ preventScroll: true }); }
  }
  const announce = () => { const m = $('pwMsg'); if (m) { m.focus({ preventScroll: true }); m.scrollIntoView({ block: 'center' }); } };

  SB.registerTab({
    key: 'plans', label: 'Plans', render(main, params) {
      main.innerHTML = plansHTML(params || {});
      if (params && params.code && !UI.focused) { UI.focused = true; setTimeout(() => { const i = $('pwCode'); if (i) { i.focus(); i.scrollIntoView({ block: 'center' }); } }, 30); }
    },
  });
  document.addEventListener('click', async e => {
    const t = e.target;
    const seg = t.closest('[data-ui-seg^="pwper|"]'); if (seg) { UI.period = seg.dataset.uiSeg.split('|')[1]; LS.set('period', UI.period); rerender(`[data-ui-seg="${seg.dataset.uiSeg}"]`); return; }
    if (t.closest('[data-pw-unlock]')) {
      const code = ($('pwCode') || {}).value || ''; const r = await checkCode(code);
      if (!r.ok) { UI.msg = r.why; UI.msgOk = false; const m = $('pwMsg'); if (m) { m.textContent = r.why; m.className = 'pw-msg bad'; } const i = $('pwCode'); if (i) i.focus(); return; }
      LS.set('code', code.replace(/\s+/g, '')); await refreshState(); UI.msg = `Unlocked: ${planOf(RANK[r.tier]).name}${r.exp ? ' until ' + new Date(r.exp * 1000).toLocaleDateString() : ''}.`; UI.msgOk = true;
      SB.render(); paintChrome(); announce(); return;
    }
    if (t.closest('[data-pw-forget]')) { LS.del('code'); await refreshState(); UI.msg = 'Your code was removed from this browser.'; UI.msgOk = true; SB.render(); paintChrome(); announce(); return; }
    const cp = t.closest('[data-pw-copy]'); if (cp) { copyEl(cp.dataset.pwCopy); return; }
    const own = t.closest('[data-pw-own]'); if (!own) return; const act = own.dataset.pwOwn; UI.own.open = true;
    try {
      if (act === 'gen') {
        if (!subtle()) { UI.own.msg = "This browser can't make keys (no Web Crypto)."; return rerender(); }
        const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const j = await subtle().exportKey('jwk', kp.privateKey); if (!LS.set('owner', { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d })) { UI.own.msg = "This browser won't save the key (storage is blocked). Use a normal window."; return rerender(); }
        UI.own.showBk = true; UI.own.msg = 'Key created. Save the backup somewhere private, then send the public key to be added to the app.';
      } else if (act === 'restore') {
        let j = null; try { j = JSON.parse(($('pwRestore') || {}).value || ''); } catch (er) { }
        if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || !j.d) { UI.own.msg = "That isn't a saved signing key."; return rerender(); }
        await subtle().importKey('jwk', j, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        LS.set('owner', { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d }); UI.own.msg = 'Key restored.';
      } else if (act === 'backup') { UI.own.showBk = !UI.own.showBk; }
      else if (act === 'issue') {
        const j = LS.get('owner', null); if (!j) return;
        const tier = ['low', 'mid', 'high'].includes(UI.own.t) ? UI.own.t : 'mid', days = Number.isFinite(+UI.own.d) ? +UI.own.d : 34;
        const out = await issue(j, tier, days), label = (($('pwLabel') || {}).value || '').trim().slice(0, 80);
        const L = LS.get('issued', []); L.push({ i: out.id, t: out.t, e: out.e, label, at: Date.now() }); LS.set('issued', L.slice(-500));
        UI.own.out = out; UI.own.msg = (CFG && pubOk(CFG.publicKey) && CFG.publicKey.x === j.x) ? 'Code made.' : 'Code made, but it only works once this key is in the app (step 2).';
      } else if (act === 'cfg') {
        const links = {}; for (const inp of document.querySelectorAll('[data-pw-link]')) { const [id, per] = inp.dataset.pwLink.split('|'); const v = inp.value.trim(); (links[id] = links[id] || {})[per] = /^https:\/\/\S+$/.test(v) ? v : ''; }
        const j = LS.get('owner', null), rev = LS.get('issued', []).filter(x => x.rev).map(x => x.i);
        UI.own.cfg = JSON.stringify({ publicKey: j ? { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } : (CFG && CFG.publicKey) || null, links, contact: (($('pwContact') || {}).value || '').trim(), revoked: [...new Set([...((CFG && CFG.revoked) || []), ...rev])] }, null, 1);
      }
    } catch (er) { UI.own.msg = 'That did not work: ' + (er && er.message || er); }
    rerender();
  });
  document.addEventListener('change', e => {
    const s = e.target.closest('[data-ui-select]'); if (!s) return; const n = s.dataset.uiSelect;
    if (n === 'pwt') UI.own.t = s.value; else if (n === 'pwd') UI.own.d = +s.value;
    else if (n === 'pwrev' && s.value) { const L = LS.get('issued', []); const x = L.find(y => y.i === s.value); if (x) { x.rev = true; LS.set('issued', L); UI.own.msg = `Marked ${x.label || x.i} as cancelled. Add its id to plans.json "revoked" (Make plans.json settings).`; } }
    else return;
    UI.own.open = true; rerender();
  });
  document.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('[data-pw-own]')) UI.own.open = e.target.open; }, true);

  window.__tiers = { NEED, needOf, can, rank, enforced, pending, checkCode, refreshState, issue, get state() { return { ...ST, owner: OWNER, cfg: CFGST }; }, get CFG() { return CFG; } };
  SB.paywall = { can, rank, needOf, get tier() { return OWNER ? 'high' : enforced() ? ST.tier : 'all'; } };
  loadCfg();
})();
