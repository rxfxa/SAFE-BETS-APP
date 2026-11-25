// Plans and access tiers (tiers.js): Free / Low (Fantasy) / Mid (Betting + Fantasy) / High (Everything), unlock codes
// signed with ECDSA P-256 and checked in the browser, the blurred gate on locked screens, lock badges, the simulation
// buttons (High), the Plans page, and the owner tools (key, codes, settings). A throwaway key is made for the test.
// Run: node tests/plans.test.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { open, check, done, ROOT } from './lib/harness.mjs';

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const J = privateKey.export({ format: 'jwk' }), PUB = { kty: 'EC', crv: 'P-256', x: J.x, y: J.y };
const { privateKey: other } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64u = b => Buffer.from(b).toString('base64url');
const code = (t, days = 30, id = b64u(crypto.randomBytes(6)), key = privateKey) => {
  const e = days > 0 ? Math.floor(Date.UTC(2026, 10, 23, 12) / 1000 + days * 86400) : days < 0 ? Math.floor(Date.UTC(2026, 10, 23, 12) / 1000 + days * 86400) : 0;
  const pay = b64u(JSON.stringify({ v: 1, t, e, i: id }));
  return `SB1-${pay}.${b64u(crypto.sign('sha256', Buffer.from(pay), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'plans.json'), 'utf8'));
const cfg = (over = {}) => JSON.stringify({ ...base, publicKey: PUB, enforceLocal: true, revoked: ['REVOKED1'], links: { low: { month: 'https://buy.stripe.com/test_low', year: '' }, mid: { month: 'https://buy.stripe.com/test_mid', year: 'https://buy.stripe.com/test_midy' }, high: { month: 'javascript:alert(1)', year: '' } }, ...over });
const withPlans = body => async page => { await page.route(/\/plans\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/json', body })); };
const openAs = async (c, opts = {}) => open({ width: opts.width || 390, tab: opts.tab || 'trending', init: c ? { 'fm2.pw.code': c } : null, before: withPlans(opts.body || cfg()) });
const ready = page => page.waitForFunction(() => window.__tiers && __tiers.state.cfg !== 'loading' && __tiers.state.checked, null, { timeout: 15000 });
const view = async (page, k) => { await page.evaluate(k => SB.goTab(k, {}), k); await page.waitForTimeout(150);
  return page.evaluate(() => ({ locked: document.getElementById('main').classList.contains('pw-lock'), inert: document.getElementById('main').inert, gate: !document.getElementById('pwGate').hidden, text: document.getElementById('pwGate').innerText })); };

// ---------- the repo's plans.json (no key yet): plans are off, nothing is locked ----------
{
  const { page, errors, browser } = await open({ width: 390, tab: 'insights' });
  await page.waitForFunction(() => window.__tiers && __tiers.state.cfg !== 'loading', null, { timeout: 15000 });
  const s = await page.evaluate(() => ({ enf: __tiers.enforced(), can: ['insights', 'statx', 'sim'].every(k => __tiers.can(k)), locked: document.getElementById('main').classList.contains('pw-lock') }));
  check('setup (no publicKey in plans.json): plans are off and every screen is open', !s.enf && s.can && !s.locked, JSON.stringify(s));
  await page.evaluate(() => SB.goTab('plans', {}));
  check('setup: the Plans page says plans are not switched on yet', /not switched on yet/.test(await page.textContent('#main')));
  check('setup: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---------- free visitor ----------
{
  const { page, errors, browser } = await openAs(null);
  await ready(page);
  const free = { trending: await view(page, 'trending'), slate: await view(page, 'slate') };
  check('free: My Parlay Picks and Games stay open', !free.trending.locked && !free.slate.locked && !free.trending.gate, JSON.stringify(free));
  const ins = await view(page, 'insights');
  check('free: a betting screen shows a blurred, inert preview with the Mid plan and its price', ins.locked && ins.inert && ins.gate && /Betting \+ Fantasy/.test(ins.text) && /\$24\.99/.test(ins.text), ins.text.slice(0, 160));
  const ff = await view(page, 'ff-trade');
  check('free: a fantasy screen asks for the Fantasy plan ($9.99)', ff.locked && /Fantasy/.test(ff.text) && /\$9\.99/.test(ff.text), ff.text.slice(0, 120));
  const sx = await view(page, 'statx');
  check('free: Stat Explorer (research) asks for Everything ($39.99)', sx.locked && /Everything/.test(sx.text) && /\$39\.99/.test(sx.text), sx.text.slice(0, 120));
  const badges = await page.evaluate(() => { SB.setMode('betting'); SB.openNav(); const o = {}; for (const b of document.querySelectorAll('#tabs .tab[data-t]')) o[b.dataset.t] = (b.querySelector('.pw-lk') || {}).textContent || ''; SB.closeNav(); return o; });
  check('free: sidebar lock badges show which plan opens each screen', /MID/.test(badges.insights) && /HIGH/.test(badges.sim) && !badges.trending && !badges.slate, JSON.stringify({ insights: badges.insights, sim: badges.sim, trending: badges.trending }));
  check('free: the phone top bar offers Upgrade instead of Ask', (await page.textContent('.askpill')).trim() === 'Upgrade');
  check('free: the sidebar footer says Free', /Free/.test(await page.textContent('#pwStat')));
  // the gate's button opens Plans
  await view(page, 'insights'); await page.click('#pwGate [data-gotab="plans"]'); await page.waitForTimeout(150);
  check('the gate\'s "See plans" opens the Plans page', await page.evaluate(() => SB.tab === 'plans' && /Pick your plan/i.test(document.getElementById('main').innerText)));
  // a 500,000-run button on a free screen (My Parlay Picks) asks for High instead of running
  await page.evaluate(() => SB.goTab('trending', {})); await page.waitForTimeout(400);
  // any card's 500,000-run / Watch live button (one is added to the open screen so the check does not depend on the slate)
  for (const a of ['sim5', 'simp']) {
    await page.evaluate(a => { const b = document.createElement('button'); b.dataset[a] = 'pairs'; b.id = 'pwT'; document.getElementById('main').appendChild(b); b.click(); b.remove(); }, a); await page.waitForTimeout(200);
    check(`free: a ${a === 'sim5' ? '500,000-run' : 'Watch live'} button opens the upgrade sheet, not a simulation`, await page.evaluate(() => /Simulations are part of Everything/.test((document.getElementById('sheet') || {}).innerText || '')));
    await page.evaluate(() => SB.closeSheet()); await page.waitForTimeout(100); }
  await page.evaluate(() => SB.closeSheet());
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390px: no horizontal scroll with the gate', ov <= 0, String(ov));
  check('free: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---------- each tier ----------
for (const [t, open1, closed] of [['low', ['ff-trade', 'fantasy', 'players'], ['insights', 'ask', 'statx']], ['mid', ['insights', 'ask', 'sharp', 'ff-trade', 'polymarket'], ['statx', 'sim', 'slipcheck', 'pattern', 'trends', 'upsets']], ['high', ['statx', 'sim', 'slipcheck', 'pattern', 'insights', 'ff-rank'], []]]) {
  const { page, errors, browser } = await openAs(code(t));
  await ready(page);
  const st = await page.evaluate(() => __tiers.state);
  const o = []; for (const k of open1) o.push([k, (await view(page, k)).locked]);
  const c = []; for (const k of closed) c.push([k, (await view(page, k)).locked]);
  check(`${t} code: its screens open, the ones above it stay locked`, st.tier === t && o.every(x => !x[1]) && c.every(x => x[1]), JSON.stringify({ tier: st.tier, open: o, closed: c }));
  check(`${t} code: no page errors`, !errors.length, errors.join(' | '));
  await browser.close();
}

// ---------- bad codes ----------
for (const [name, c, re] of [['expired', code('high', -2), /expired/], ['revoked', code('high', 30, 'REVOKED1'), /cancelled/], ['signed by another key', code('high', 30, undefined, other), /isn't valid/],
  ['tampered (plan changed to high)', (() => { const g = code('low'); const [p, s] = g.slice(4).split('.'); const pl = JSON.parse(Buffer.from(p, 'base64url')); pl.t = 'high'; return `SB1-${b64u(JSON.stringify(pl))}.${s}`; })(), /isn't valid/], ['garbage', 'hello', /doesn't look like/]]) {
  const { page, browser } = await openAs(c);
  await ready(page);
  const r = await page.evaluate(() => ({ tier: __tiers.state.tier, why: __tiers.state.why, locked: (SB.goTab('insights', {}), document.getElementById('main').classList.contains('pw-lock')) }));
  check(`${name} code: treated as free, with the reason`, r.tier === 'free' && r.locked && re.test(r.why), JSON.stringify(r));
  await browser.close();
}

// ---------- the Plans page and unlocking with a code ----------
{
  const { page, errors, browser } = await openAs(null, { tab: 'plans', width: 1440 });
  await ready(page);
  const txt = await page.textContent('#main');
  check('Plans: three plans with the owner\'s prices (monthly)', /\$9\.99/.test(txt) && /\$24\.99/.test(txt) && /\$39\.99/.test(txt) && /Pick your plan/i.test(txt));
  const links = await page.$$eval('[data-pw-buy]', a => a.map(x => ({ id: x.dataset.pwBuy, href: x.href, target: x.target, rel: x.rel })));
  check('Plans: Stripe links open in a new tab; a non-https link is never used', links.length === 2 && links.every(l => l.href.startsWith('https://buy.stripe.com/') && l.target === '_blank' && /noopener/.test(l.rel)) && !links.some(l => l.id === 'high'), JSON.stringify(links));
  await page.click('[data-ui-seg="pwper|year"]'); await page.waitForTimeout(100);
  const y = await page.textContent('#main');
  check('Plans: Yearly shows the yearly prices and the per-month figure', /\$249\.99/.test(y) && /\$20\.83\/mo/.test(y));
  check('Plans: comparison table and the honest notes (Stripe handles cards; casual lock; your own sportsbook)', /What each plan opens/.test(y) && /Stripe/.test(y) && /casual visitors/.test(y) && /own sportsbook/.test(y));
  await page.fill('#pwCode', 'nope'); await page.click('[data-pw-unlock]'); await page.waitForTimeout(150);
  check('Plans: a bad code says why', /doesn't look like/.test(await page.textContent('#pwMsg')));
  await page.fill('#pwCode', code('mid')); await page.click('[data-pw-unlock]'); await page.waitForTimeout(300);
  const u = await page.evaluate(() => ({ msg: document.getElementById('pwMsg').innerText, tier: __tiers.state.tier, stored: !!localStorage.getItem('fm2.pw.code') }));
  check('Plans: a valid Mid code unlocks Betting + Fantasy and is remembered on this browser', u.tier === 'mid' && /Unlocked: Betting \+ Fantasy/.test(u.msg) && u.stored, JSON.stringify(u));
  await page.reload(); await ready(page);
  check('the code survives a reload', await page.evaluate(() => __tiers.state.tier === 'mid'));
  await page.evaluate(() => SB.goTab('plans', {})); await page.click('[data-pw-forget]'); await page.waitForTimeout(200);
  check('Remove my code: back to free', await page.evaluate(() => __tiers.state.tier === 'free' && !localStorage.getItem('fm2.pw.code')));
  check('Plans: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---------- owner tools: make a key in the browser, publish its public half, make codes ----------
{
  const { page, errors, browser } = await open({ width: 1440, tab: 'plans', before: withPlans(JSON.stringify({ ...base, publicKey: null })) });
  await page.waitForFunction(() => window.__tiers && __tiers.state.cfg !== 'loading', null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('[data-pw-own]').open = true);
  await page.click('[data-pw-own="gen"]'); await page.waitForTimeout(300);
  const k = await page.evaluate(() => ({ pub: JSON.parse(document.getElementById('pwPub').value), bk: !!document.getElementById('pwBk'), stored: JSON.parse(localStorage.getItem('fm2.pw.owner')) }));
  check('owner: a signing key is made in the browser; the public half is shown, the backup is offered', k.pub.kty === 'EC' && k.pub.x === k.stored.x && !!k.stored.d && !('d' in k.pub) && k.bk);
  await page.selectOption('[data-ui-select="pwt"]', 'high'); await page.waitForTimeout(100);
  await page.fill('#pwLabel', 'Test customer'); await page.click('[data-pw-own="issue"]'); await page.waitForTimeout(300);
  const made = await page.evaluate(() => ({ code: document.getElementById('pwOut').value, msg: document.getElementById('pwOutMsg').value, list: JSON.parse(localStorage.getItem('fm2.pw.issued')) }));
  check('owner: a code is made, with a message to send, and kept in the local list', /^SB1-/.test(made.code) && /Plans/.test(made.msg) && made.list.length === 1 && made.list[0].label === 'Test customer' && made.list[0].t === 'high');
  await page.click('[data-pw-own="cfg"]'); await page.waitForTimeout(150);
  const cf = await page.evaluate(() => JSON.parse(document.getElementById('pwCfg').value));
  check('owner: "Make plans.json settings" gives the public key (never the private part)', cf.publicKey && cf.publicKey.x === k.pub.x && !('d' in cf.publicKey) && !/"d"/.test(JSON.stringify(cf)));
  check('owner tools: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
  // the app with that public key: the browser-made code works in another browser; the owner's browser has full access
  const pubBody = JSON.stringify({ ...base, publicKey: cf.publicKey, enforceLocal: true });
  const c2 = await open({ width: 390, tab: 'statx', init: { 'fm2.pw.code': made.code }, before: withPlans(pubBody) });
  await ready(c2.page);
  check('a code made in the owner\'s browser unlocks Everything in another browser', await c2.page.evaluate(() => __tiers.state.tier === 'high' && !document.getElementById('main').classList.contains('pw-lock')));
  await c2.browser.close();
  const c3 = await open({ width: 390, tab: 'statx', init: { 'fm2.pw.owner': k.stored }, before: withPlans(pubBody) });
  await ready(c3.page);
  check('the owner\'s browser (holding the key the app checks with) has full access', await c3.page.evaluate(() => __tiers.state.owner === true && __tiers.rank() === 3));
  await c3.browser.close();
  // a fake "owner" with the public numbers but no real private key gets nothing
  const c4 = await open({ width: 390, tab: 'statx', init: { 'fm2.pw.owner': { ...k.stored, d: b64u(crypto.randomBytes(32)) } }, before: withPlans(pubBody) });
  await ready(c4.page);
  check('a made-up owner key with the right public numbers does not unlock anything', await c4.page.evaluate(() => __tiers.state.owner === false && __tiers.rank() === 0));
  await c4.browser.close();
}

// ---------- the command-line tool makes the same codes ----------
{
  const dir = fs.mkdtempSync(path.join(ROOT, '.work', 'lic-')), key = path.join(dir, 'k.json');
  const out = execFileSync('node', [path.join(ROOT, 'tools/license.mjs'), 'keygen', '--key', key], { encoding: 'utf8' });
  const pub = JSON.parse(out.trim().split('\n').pop());
  const c = execFileSync('node', [path.join(ROOT, 'tools/license.mjs'), 'issue', '--tier', 'low', '--days', '34', '--key', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const mode = (fs.statSync(key).mode & 0o777).toString(8);
  const { page, browser } = await open({ width: 390, tab: 'ff-trade', init: { 'fm2.pw.code': c }, before: withPlans(JSON.stringify({ ...base, publicKey: pub, enforceLocal: true })) });
  await ready(page);
  check('tools/license.mjs: keygen (key file mode 600) + issue make a code the app accepts', mode === '600' && await page.evaluate(() => __tiers.state.tier === 'low' && !document.getElementById('main').classList.contains('pw-lock')), mode);
  await browser.close(); fs.rmSync(dir, { recursive: true, force: true });
}
await done(null);
