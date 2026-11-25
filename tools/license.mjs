#!/usr/bin/env node
// Safe Bets unlock codes from the command line: the same codes as Plans → Owner tools in the app (tiers.js).
// Run these on your own computer. The signing key file is private: never commit it, never paste it in a chat.
//
//   node tools/license.mjs keygen [--key ~/.safebets/signing-key.json]
//        makes a P-256 signing key (file mode 600) and prints the public key to put in plans.json "publicKey"
//   node tools/license.mjs issue --tier low|mid|high [--days 34] [--key …]
//        prints an unlock code (--days 0 = never expires; 34 = a month plus 3 days' grace, 369 = a year plus 3)
//   node tools/license.mjs check <code> [--plans plans.json]
//        checks a code against plans.json (signature, expiry, revoked)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const keyPath = opt('key', path.join(os.homedir(), '.safebets', 'signing-key.json'));
const b64u = b => Buffer.from(b).toString('base64url');

if (cmd === 'keygen') {
  if (fs.existsSync(keyPath)) { console.error(`${keyPath} already exists; move it away first (codes made with it stop working if you replace it).`); process.exit(1); }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = privateKey.export({ format: 'jwk' });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d }), { mode: 0o600 });
  console.log(`Signing key saved to ${keyPath} (keep it private and backed up).`);
  console.log('Public key for plans.json "publicKey":');
  console.log(JSON.stringify({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y }));
} else if (cmd === 'issue') {
  const tier = opt('tier', ''), days = Number(opt('days', '34'));
  if (!['low', 'mid', 'high'].includes(tier) || !Number.isFinite(days) || days < 0) { console.error('usage: issue --tier low|mid|high [--days 34]'); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const key = crypto.createPrivateKey({ key: j, format: 'jwk' });
  const id = b64u(crypto.randomBytes(6)), e = days > 0 ? Math.floor(Date.now() / 1000 + days * 86400) : 0;
  const pay = b64u(JSON.stringify({ v: 1, t: tier, e, i: id }));
  const sig = crypto.sign('sha256', Buffer.from(pay), { key, dsaEncoding: 'ieee-p1363' });
  console.log(`SB1-${pay}.${b64u(sig)}`);
  console.error(`id ${id} · ${tier} · ${e ? 'until ' + new Date(e * 1000).toISOString().slice(0, 10) : 'never expires'}`);
} else if (cmd === 'check') {
  const code = argv[1] || '', P = JSON.parse(fs.readFileSync(opt('plans', 'plans.json'), 'utf8'));
  const m = /^SB1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m || !P.publicKey) { console.log('invalid (format, or plans.json has no publicKey)'); process.exit(1); }
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: P.publicKey.x, y: P.publicKey.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(m[1]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[2], 'base64url'));
  const p = JSON.parse(Buffer.from(m[1], 'base64url').toString());
  const why = !ok ? 'bad signature' : (P.revoked || []).includes(p.i) ? 'revoked' : p.e && p.e * 1000 < Date.now() ? 'expired' : 'valid';
  console.log(`${why} · ${p.t} · id ${p.i} · ${p.e ? 'until ' + new Date(p.e * 1000).toISOString().slice(0, 10) : 'never expires'}`);
  process.exit(why === 'valid' ? 0 : 1);
} else {
  console.log('usage: node tools/license.mjs keygen | issue --tier low|mid|high [--days 34] | check <code>');
}
