#!/usr/bin/env python3
"""Safe Bets -> Polymarket bet script. It runs on YOUR computer, and your key never leaves it.

In the Safe Bets app (Weekly Plan), tap "Send to my bet script" on a slip. That copies a short code. Then:

    python3 place_slip.py --setup     once: save your Polymarket wallet and a key on this computer
    python3 place_slip.py --check     check the copied slip: live prices, nothing placed, no key needed
    python3 place_slip.py             check it, then place it as ONE Polymarket combo after you type yes
    python3 place_slip.py --singles   buy each leg as its own bet instead of one combo

Other options:
    --ticket SBT1.xxxx   use this code instead of reading the clipboard
    --stake 2.50         stake in pUSD (default: the app's stake for that slip; never above your MAX_STAKE)
    --min-payout 8.5     only accept a combo quote that pays at least this many times the stake
    --slippage 2         cents a leg may rise above the app's price before the script refuses it (default 2)

Needs Python 3.10+. Placing bets also needs Polymarket's official SDK:  pip install polymarket-client==0.20.0
(--check needs nothing extra).

How it places a combo: Polymarket prices combos through quotes from market makers (their "RFQ" system). The script asks
for a quote for exactly these legs, and accepts it automatically only if it is within your stake and pays at least
--min-payout (by default 85% of the payout the legs' live prices imply). Quotes expire in about 5 seconds, so the
decision rule is agreed before you type yes. Nothing is bought if any check fails.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal
from pathlib import Path

SDK_VERSION = '0.20.0'
GAMMA = 'https://gamma-api.polymarket.com'
GEOBLOCK = 'https://polymarket.com/api/geoblock'
RFQ_BASE = 'https://combos-rfq-gateway-requester-api.polymarket.com'
RFQ_PATH = '/v1/requester/rfq/requests'
HOME = Path(os.environ.get('SAFEBETS_HOME') or (Path.home() / '.safebets'))
CONFIG = HOME / 'polymarket.env'
LOG = HOME / 'placed.jsonl'
DEFAULT_MAX_STAKE = Decimal('25')
TICKET_RE = re.compile(r'SBT1\.[A-Za-z0-9_-]{20,}')
SIG_TYPE = {'EOA': 0, 'POLY_PROXY': 1, 'GNOSIS_SAFE': 2, 'DEPOSIT_WALLET': 3}
DONE_OK = {'FILLED', 'CONFIRMED'}
DONE_BAD = {'FAILED', 'EXPIRED', 'CANCELED'}
UA = {'User-Agent': 'safe-bets-place-slip/1', 'Accept': 'application/json'}


class Stop(Exception):
    """A check failed: print the message and place nothing (more)."""


def say(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- http
def http_json(url, *, method='GET', body=None, headers=None, timeout=30):
    """Returns (status, parsed json or None, raw text). Never raises for HTTP error codes."""
    data = body.encode('utf-8') if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers={**UA, **(headers or {})})
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        status = e.code
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    return status, parsed, raw


# ---------------------------------------------------------------- ticket
def read_clipboard():
    cmds = []
    system = platform.system()
    if system == 'Darwin':
        cmds = [['pbpaste']]
    elif system == 'Windows':
        cmds = [['powershell', '-NoProfile', '-Command', 'Get-Clipboard']]
    else:
        cmds = [['wl-paste', '--no-newline'], ['xclip', '-o', '-selection', 'clipboard'], ['xsel', '--clipboard', '--output']]
    for c in cmds:
        if shutil.which(c[0]):
            try:
                return subprocess.run(c, capture_output=True, text=True, timeout=5).stdout or ''
            except (OSError, subprocess.SubprocessError):
                continue
    return ''


def find_ticket(text):
    m = TICKET_RE.search(text or '')
    return m.group(0) if m else None


def decode_ticket(code):
    try:
        b = code.split('.', 1)[1]
        obj = json.loads(base64.urlsafe_b64decode(b + '=' * (-len(b) % 4)).decode('utf-8'))
    except Exception as e:  # noqa: BLE001
        raise Stop(f'That code is damaged ({e}). Copy it again from the app.')
    if not isinstance(obj, dict) or obj.get('v') != 1 or not isinstance(obj.get('L'), list):
        raise Stop('That code is from a different version of the app. Copy it again from the app.')
    legs = []
    for i, L in enumerate(obj['L'], 1):
        if not (isinstance(L, list) and len(L) == 3 and isinstance(L[0], int) and L[1] in (0, 1) and isinstance(L[2], int) and 0 < L[2] < 1000):
            raise Stop(f'Leg {i} in that code is damaged. Copy it again from the app.')
        legs.append({'n': i, 'id': L[0], 'o': L[1], 'app_ask': Decimal(L[2]) / 1000})
    if not 2 <= len(legs) <= 50:
        raise Stop('A combo needs 2 to 50 legs.')
    if len({(L['id'], L['o']) for L in legs}) != len(legs):
        raise Stop('The same leg is in that slip twice.')
    try:
        stake = Decimal(str(obj.get('s') or 1))
    except Exception:  # noqa: BLE001
        stake = Decimal(1)
    return {'tier': str(obj.get('t') or ''), 'name': str(obj.get('n') or 'Slip'), 'made': str(obj.get('d') or ''), 'stake': stake,
            'app_x': obj.get('x'), 'app_mkt': obj.get('m'), 'app_p': obj.get('p'), 'legs': legs}


# ---------------------------------------------------------------- markets
def jl(x):
    if isinstance(x, list):
        return x
    try:
        return json.loads(x or '[]')
    except ValueError:
        return []


def dec(x):
    try:
        return Decimal(str(x)) if x is not None and x != '' else None
    except Exception:  # noqa: BLE001
        return None


def parse_time(s):
    if not s:
        return None
    s = str(s).strip().replace(' ', 'T')
    if s.endswith('+00'):
        s += ':00'
    s = s.replace('Z', '+00:00')
    try:
        t = datetime.fromisoformat(s)
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def load_leg(leg, gamma=None):
    status, m, _ = http_json(f'{gamma or GAMMA}/markets/{leg["id"]}')
    if status != 200 or not isinstance(m, dict):
        raise Stop(f'Leg {leg["n"]}: Polymarket market {leg["id"]} could not be loaded (HTTP {status}).')
    outs = [str(o) for o in jl(m.get('outcomes'))]
    pos, toks = [str(p) for p in jl(m.get('positionIds'))], [str(t) for t in jl(m.get('clobTokenIds'))]
    o = leg['o']
    if len(outs) != 2:
        raise Stop(f'Leg {leg["n"]}: market {leg["id"]} is not a two-sided market.')
    bid0, ask0 = dec(m.get('bestBid')), dec(m.get('bestAsk'))
    ask = ask0 if o == 0 else (None if bid0 is None else Decimal(1) - bid0)
    bid = bid0 if o == 0 else (None if ask0 is None else Decimal(1) - ask0)
    start = parse_time(m.get('gameStartTime')) or parse_time(((m.get('events') or [{}])[0] or {}).get('startTime'))
    leg.update({
        'question': (m.get('question') or '').strip(), 'pick': outs[o], 'other': outs[1 - o], 'line': m.get('line'), 'type': m.get('sportsMarketType') or '',
        'ask': ask, 'bid': bid, 'start': start, 'version': m.get('version') or 'v1', 'combo': (m.get('comboStatus') or '') == 'enabled',
        'combo_pos': pos[o] if len(pos) == 2 else None, 'token': toks[o] if len(toks) == 2 else None,
        # the order-book asset: the CTF token for v1 markets, the position id for Polymarket Protocol V2 markets
        'asset': (pos[o] if len(pos) == 2 else None) if (m.get('version') or 'v1') == 'v2' else (toks[o] if len(toks) == 2 else None),
        'open': bool(m.get('active')) and not m.get('closed') and m.get('acceptingOrders') is not False,
        'min_size': dec(m.get('orderMinSize')) or Decimal(0), 'condition': m.get('conditionId'),
    })
    return leg


def leg_problems(leg, slip_cents, now, mode):
    out = []
    if not leg['open']:
        out.append('market closed')
    if leg['start'] and leg['start'] <= now:
        out.append('game started')
    if leg['ask'] is None:
        out.append('no live price')
    elif leg['ask'] > min(Decimal('0.99'), leg['app_ask'] + Decimal(slip_cents) / 100):
        out.append(f'price up to {cents(leg["ask"])} (app {cents(leg["app_ask"])})')
    if mode == 'combo' and (not leg['combo'] or not leg['combo_pos']):
        out.append('not allowed in combos')
    if mode == 'singles' and not leg['asset']:
        out.append('no order book')
    return out


def cents(x):
    if x is None:
        return '—'
    s = f'{(Decimal(x) * 100).quantize(Decimal("0.1")):f}'
    return (s[:-2] if s.endswith('.0') else s) + '¢'


def show_legs(legs, probs):
    say('')
    say(f' {"#":>2}  {"Polymarket market":<44} {"Buying":<18} {"App":>6} {"Now":>6}  Check')
    for L in legs:
        q = (L['question'] or '')[:44]
        pick = (L['pick'] or '')[:18]
        say(f' {L["n"]:>2}  {q:<44} {pick:<18} {cents(L["app_ask"]):>6} {cents(L["ask"]):>6}  {"OK" if not probs.get(L["n"]) else "✗ " + "; ".join(probs[L["n"]])}')
    say('')


# ---------------------------------------------------------------- config
def read_config(path=CONFIG):
    if not path.exists():
        raise Stop(f'No setup yet. Run:  python3 {Path(sys.argv[0]).name} --setup')
    if os.name == 'posix' and path.stat().st_mode & 0o077:
        raise Stop(f'{path} can be read by other users on this computer. Fix it with:  chmod 600 "{path}"')
    cfg = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            cfg[k.strip()] = v.strip()
    for k in ('POLYMARKET_WALLET_ADDRESS', 'POLYMARKET_KEY'):
        if not cfg.get(k):
            raise Stop(f'{path} is missing {k}. Run --setup again.')
    try:
        cfg['MAX_STAKE'] = Decimal(cfg.get('MAX_STAKE') or DEFAULT_MAX_STAKE)
    except Exception:  # noqa: BLE001
        cfg['MAX_STAKE'] = DEFAULT_MAX_STAKE
    return cfg


def write_config(values, path=CONFIG):
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == 'posix':
        os.chmod(path.parent, 0o700)
    lines = ['# Safe Bets bet script. Private: do not share or upload this file.', *[f'{k}={v}' for k, v in values.items()]]
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    if os.name == 'posix':
        os.chmod(path, 0o600)


# ---------------------------------------------------------------- polymarket sdk
def sdk():
    try:
        import polymarket  # noqa: F401
        from polymarket import RelayerApiKey, SecureClient, SessionKeyKnownScope
        from polymarket._internal.actions.orders.typed_data import build_order_signature, build_order_typed_data
        from polymarket._internal.actions.orders.types import BYTES32_ZERO, UnsignedOrder
        from polymarket._internal.wallet import wrap_deposit_wallet_signature
        from polymarket.models.types import TokenId
        from polymarket.types import EvmAddress, HexString
    except ImportError as e:
        raise Stop(f'Polymarket\'s SDK isn\'t installed ({e}). Run:  pip install polymarket-client=={SDK_VERSION}')
    from importlib.metadata import version
    v = version('polymarket-client')
    if v != SDK_VERSION:
        raise Stop(f'This script was built and tested with polymarket-client {SDK_VERSION}; you have {v}. Run:  pip install polymarket-client=={SDK_VERSION}')
    return {'SecureClient': SecureClient, 'RelayerApiKey': RelayerApiKey, 'Scope': SessionKeyKnownScope, 'UnsignedOrder': UnsignedOrder, 'ZERO': BYTES32_ZERO,
            'typed': build_order_typed_data, 'finish': build_order_signature, 'wrap': wrap_deposit_wallet_signature, 'TokenId': TokenId, 'Addr': EvmAddress, 'Hex': HexString}


def connect(cfg, S):
    try:
        client = S['SecureClient'].create(private_key=cfg['POLYMARKET_KEY'], wallet=cfg['POLYMARKET_WALLET_ADDRESS'])
    except Exception as e:  # noqa: BLE001
        raise Stop(f'Couldn\'t sign in to Polymarket: {e}')
    return client


def wallet_type(client):
    return str(client.wallet_type)


def signer_type(client):
    return str(getattr(client._ctx, 'signer_type', 'OWNER'))  # noqa: SLF001 (pinned SDK version)


# ---------------------------------------------------------------- combo (RFQ requester gateway)
def l2_headers(client, method, path, body):
    creds = client.credentials
    ts = int(time.time())
    msg = f'{ts}{method}{path}{body or ""}'
    secret = base64.urlsafe_b64decode(creds.secret + '=' * (-len(creds.secret) % 4))
    sig = base64.urlsafe_b64encode(hmac.new(secret, msg.encode('utf-8'), hashlib.sha256).digest()).decode('ascii')
    return {'POLY_ADDRESS': str(client.signer), 'POLY_API_KEY': creds.key, 'POLY_PASSPHRASE': creds.passphrase, 'POLY_TIMESTAMP': str(ts), 'POLY_SIGNATURE': sig}


def rfq_call(client, method, path, payload=None, base=None, timeout=35):
    body = None if payload is None else json.dumps(payload, separators=(',', ':'))
    return http_json((base or RFQ_BASE) + path, method=method, body=body, headers=l2_headers(client, method, path, body), timeout=timeout)


def order_identity(client):
    wt = wallet_type(client)
    if wt not in SIG_TYPE or wt == 'EOA':
        raise Stop('Combos need a Polymarket account wallet (Deposit, Proxy or Safe wallet). Use the wallet address from your Polymarket profile.')
    st = SIG_TYPE[wt]
    signer = str(client.wallet) if st == 3 else str(client.signer)
    return st, signer, str(client.wallet)


def build_rfq_body(client, legs, stake):
    st, signer, maker = order_identity(client)
    return {'signer_address': signer, 'maker_address': maker, 'signature_type': st, 'leg_position_ids': [L['combo_pos'] for L in legs],
            'direction': 'BUY', 'side': 'YES', 'requested_size': {'unit': 'notional', 'value_e6': str(int((stake * 1_000_000).to_integral_value(ROUND_DOWN)))}}


def sign_combo_order(client, S, *, position_id, maker_amount_e6, taker_amount_e6):
    """Exchange v3 BUY order for the combo's YES position, signed the same way the SDK signs CLOB orders (Deposit Wallet
    ERC-7739 wrapper, plus the session-signer wrapper when the key is a session key). Builder must be zero here."""
    ctx = client._ctx  # noqa: SLF001 (pinned SDK version)
    st, signer, maker = order_identity(client)
    unsigned = S['UnsignedOrder'](builder=S['ZERO'], chain_id=ctx.environment_config.chain_id, exchange_address=S['Addr'](ctx.environment_config.exchange_v3),
                                  expiration=0, maker=S['Addr'](maker), maker_amount=int(maker_amount_e6), metadata=S['ZERO'], order_type='GTC',
                                  salt=secrets.randbits(64), side='BUY', signature_type=st, signer=S['Addr'](signer), taker_amount=int(taker_amount_e6),
                                  timestamp=int(time.time()), token_id=S['TokenId'](str(position_id)))
    typed = S['typed'](unsigned, protocol_version='3')
    raw = ctx.signer.sign_typed_data(full_message=typed).signature.hex()
    sig = S['finish'](unsigned, S['Hex'](raw if raw.startswith('0x') else '0x' + raw), protocol_version='3')
    if st == 3:
        sig = S['wrap'](signer=ctx.signer.address, signer_type=signer_type(client), signature=sig)
    return {'salt': str(unsigned.salt), 'maker': unsigned.maker, 'signer': unsigned.signer, 'tokenId': str(unsigned.token_id), 'makerAmount': str(unsigned.maker_amount),
            'takerAmount': str(unsigned.taker_amount), 'side': 0, 'signatureType': unsigned.signature_type, 'timestamp': str(unsigned.timestamp),
            'metadata': unsigned.metadata, 'builder': unsigned.builder, 'signature': str(sig)}


def explain_error(code, payload, legs):
    code = code or ''
    if code == 'CONTRADICTORY_LEGS':
        c = (payload or {}).get('conflict') or {}
        ids = {L['combo_pos']: L['n'] for L in legs}
        a = [ids.get(str(x), '?') for x in c.get('legs') or []]
        b = [ids.get(str(x), '?') for x in c.get('conflicts_with') or []]
        return f'Polymarket says legs {a} and {b} can\'t be in the same combo. Swap one of them out in the app (✖) and send the slip again.'
    return {
        'NO_QUOTES': 'No market maker quoted this combo right now. Try again in a minute, or with fewer legs.',
        'UNSUPPORTED_REQUESTER_SIGNATURE_TYPE': 'Polymarket doesn\'t allow combos from this kind of wallet.',
        'RATE_LIMITED': 'Too many combo requests in the last minute. Wait a minute and try again.',
        'UNAUTHENTICATED': 'Polymarket didn\'t accept the sign-in. Run --setup again.',
        'ADDRESS_MISMATCH': 'The key and wallet in your setup don\'t belong together. Run --setup again.',
        'PRE_EXECUTION_BALANCE_RESERVATION_FAILED': 'Not enough pUSD in your Polymarket wallet for this stake.',
        'INVALID_SIGNATURE': 'Polymarket rejected the order signature. Try --singles, or run --setup with your account key.',
        'EXPIRED_RFQ': 'The quote expired before it was accepted. Run the script again.',
    }.get(code, f'Polymarket said: {code or "error"} {json.dumps(payload)[:300] if payload else ""}')


def place_combo(client, S, slip, legs, stake, floor_x, log):
    body = build_rfq_body(client, legs, stake)
    say(f'Asking Polymarket market makers for a quote on this {len(legs)}-leg combo…')
    status, data, raw = rfq_call(client, 'POST', RFQ_PATH, body)
    if status != 200 or not isinstance(data, dict):
        code = (data or {}).get('code') if isinstance(data, dict) else None
        raise Stop(explain_error(code, data, legs) + f' (HTTP {status})')
    rfq_id = data.get('rfq_id')
    if data.get('status') != 'AWAITING_REQUESTER_ACCEPTANCE' or not isinstance(data.get('quote'), dict):
        err = data.get('error') or {}
        raise Stop(explain_error(err.get('code'), err, legs))
    req, q = data.get('request') or {}, data['quote']
    if [str(x) for x in req.get('leg_position_ids') or []] != body['leg_position_ids'] or req.get('direction') != 'BUY' or req.get('side') != 'YES' \
            or (req.get('requested_size') or {}).get('value_e6') != body['requested_size']['value_e6']:
        raise Stop('The quote didn\'t match the legs and stake that were asked for, so it was not accepted.')
    need = Decimal(str(q['total_required_e6'])) / 1_000_000
    shares = Decimal(str(q.get('net_receive_e6') or q['taker_amount_e6'])) / 1_000_000
    x = shares / need if need > 0 else Decimal(0)
    say(f'Quote: costs {need:.2f} pUSD, pays {shares:.2f} pUSD if every leg hits  (×{x:.2f}; your floor ×{floor_x:.2f})')
    if need > stake + Decimal('0.000001'):
        raise Stop('The quote costs more than your stake, so it was not accepted.')
    if x < floor_x:
        log({'event': 'quote_declined', 'rfq_id': rfq_id, 'x': float(x), 'floor': float(floor_x)})
        raise Stop(f'The best quote pays ×{x:.2f}, below your floor of ×{floor_x:.2f}, so nothing was bought. '
                   'Market makers price long combos below the legs\' prices; try --min-payout lower, fewer legs, or --singles.')
    if int(data.get('expires_at') or 0) - int(time.time() * 1000) < 300:
        raise Stop('The quote expired before it could be accepted. Run the script again.')
    signed = sign_combo_order(client, S, position_id=req['yes_position_id'], maker_amount_e6=q['maker_amount_e6'], taker_amount_e6=q['taker_amount_e6'])
    path = f'{RFQ_PATH}/{urllib.parse.quote(str(rfq_id), safe="")}/accept'
    payload = {'quote_id': q['quote_id'], 'signed_order': signed}
    try:
        status, acc, _ = rfq_call(client, 'POST', path, payload)
    except (urllib.error.URLError, TimeoutError, OSError):
        status, acc, _ = rfq_call(client, 'POST', path, payload)  # acceptance is idempotent on Polymarket's side
    log({'event': 'accept', 'rfq_id': rfq_id, 'http': status, 'status': (acc or {}).get('status') if isinstance(acc, dict) else None, 'cost': float(need), 'x': float(x)})
    if status != 200 or not isinstance(acc, dict):
        code = (acc or {}).get('code') if isinstance(acc, dict) else None
        raise Stop(explain_error(code, acc, legs) + f' (HTTP {status})')
    st = acc.get('status')
    deadline = time.time() + 120
    while st not in DONE_OK | DONE_BAD and time.time() < deadline:
        time.sleep(1.0)
        s2, cur, _ = rfq_call(client, 'GET', f'{RFQ_PATH}/{urllib.parse.quote(str(rfq_id), safe="")}')
        if s2 == 200 and isinstance(cur, dict):
            st, acc = cur.get('status'), cur
    log({'event': 'result', 'rfq_id': rfq_id, 'status': st, 'tx': acc.get('tx_hash')})
    if st in DONE_OK:
        say(f'✅ Placed: {len(legs)}-leg combo, {need:.2f} pUSD to win {shares:.2f} pUSD. Transaction {acc.get("tx_hash") or "(pending)"}')
        return True
    if st in DONE_BAD:
        err = acc.get('error') or {}
        raise Stop('Not placed: ' + explain_error(err.get('code'), err, legs))
    raise Stop(f'Still processing after 2 minutes (RFQ {rfq_id}). Check your Polymarket portfolio before trying again, so you don\'t bet twice.')


# ---------------------------------------------------------------- singles (CLOB)
def place_singles(client, legs, stake, slip_cents, log):
    each = (stake / len(legs)).quantize(Decimal('0.01'), ROUND_DOWN)
    placed = 0
    for L in legs:
        cap = min(Decimal('0.99'), L['app_ask'] + Decimal(slip_cents) / 100)
        if L['min_size'] and L['ask'] and each < L['min_size'] * L['ask']:
            say(f' {L["n"]:>2}  skipped: Polymarket\'s minimum for this market is {L["min_size"]} shares (about ${L["min_size"] * L["ask"]:.2f}); your ${each} per leg is less.')
            continue
        try:
            r = client.place_market_order(asset_id=L['asset'], side='BUY', amount=str(each), max_price=str(cap), order_type='FAK')
            ok = getattr(r, 'ok', True)
            oid = getattr(r, 'order_id', None)
            say(f' {L["n"]:>2}  {"bought" if ok else "not filled"}: {L["pick"]} ({L["question"][:40]}) up to {cents(cap)}, ${each}' + (f'  order {oid}' if oid else ''))
            log({'event': 'single', 'leg': L['n'], 'market': L['id'], 'o': L['o'], 'amount': float(each), 'cap': float(cap), 'ok': bool(ok), 'order': oid})
            placed += 1 if ok else 0
        except Exception as e:  # noqa: BLE001
            say(f' {L["n"]:>2}  not placed: {e}')
            log({'event': 'single_error', 'leg': L['n'], 'market': L['id'], 'error': str(e)[:300]})
    say(f'Done: {placed} of {len(legs)} legs bought.')
    return placed


# ---------------------------------------------------------------- setup
def setup():
    S = sdk()
    say('Safe Bets bet script setup. Your key is typed here, stays on this computer, and is never shown or sent anywhere except to Polymarket\'s own sign-in.')
    wallet = input('Your Polymarket wallet address (Polymarket profile menu, starts with 0x): ').strip()
    if not re.fullmatch(r'0x[0-9a-fA-F]{40}', wallet):
        raise Stop('That isn\'t a wallet address.')
    key = getpass.getpass('Your account\'s private key (hidden as you type): ').strip()
    if not re.fullmatch(r'(0x)?[0-9a-fA-F]{64}', key):
        raise Stop('That doesn\'t look like a private key (64 letters and numbers).')
    client = connect({'POLYMARKET_KEY': key, 'POLYMARKET_WALLET_ADDRESS': wallet}, S)
    wt, st = wallet_type(client), signer_type(client)
    if st != 'OWNER':
        raise Stop('That key doesn\'t control that wallet. Check you copied the wallet address from the same Polymarket account.')
    say(f'Signed in. Wallet type: {wt}.')
    cap = input(f'Most you ever want this script to bet in one go, in pUSD [{DEFAULT_MAX_STAKE}]: ').strip() or str(DEFAULT_MAX_STAKE)
    try:
        cap_d = Decimal(cap)
        assert cap_d > 0
    except Exception:  # noqa: BLE001
        raise Stop('That isn\'t an amount.')
    saved_key, kind = key, 'owner'
    if wt == 'DEPOSIT_WALLET':
        say('\nYour account can use a trading-only "session key": it can place bets but can\'t withdraw money, and it expires in 180 days.')
        say('Making one needs a Relayer API key: polymarket.com → Settings → API Keys → Relayer API Keys → create, then copy the API Key and Signer Address.')
        if input('Make a trading-only key now? (recommended) [y/N]: ').strip().lower() in ('y', 'yes'):
            rk = getpass.getpass('Relayer API Key (hidden): ').strip()
            ra = input('Relayer Signer Address (0x…): ').strip()
            from eth_account import Account
            acct = Account.create()
            owner = S['SecureClient'].create(private_key=key, wallet=wallet, api_key=S['RelayerApiKey'](key=rk, address=ra))
            owner.authorize_session_key(address=acct.address, scopes=(S['Scope'].CLOB, S['Scope'].COMBOSRFQ))
            saved_key, kind = '0x' + acct.key.hex().removeprefix('0x'), 'session'
            say(f'Trading-only key {acct.address} is authorized. Your account key will NOT be saved.')
    write_config({'POLYMARKET_WALLET_ADDRESS': wallet, 'POLYMARKET_KEY': saved_key, 'KEY_KIND': kind, 'MAX_STAKE': str(cap_d)})
    say(f'\nSaved to {CONFIG} (only your user can read it).')
    if kind == 'owner':
        say('This is your account key: it can move your money. Keep this computer locked, and delete that file when you stop using the script.')
    say('Next: tap "Send to my bet script" on a slip in the app, then run:  python3 place_slip.py --check')


# ---------------------------------------------------------------- main
def make_logger(slip):
    def log(rec):
        try:
            HOME.mkdir(parents=True, exist_ok=True)
            with open(LOG, 'a') as f:
                f.write(json.dumps({'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'slip': slip['name'], 'tier': slip['tier'], **rec}) + '\n')
        except OSError:
            pass
    return log


def main(argv=None):
    ap = argparse.ArgumentParser(description='Place a Safe Bets slip on Polymarket from your own computer.')
    ap.add_argument('--setup', action='store_true', help='save your wallet and key on this computer')
    ap.add_argument('--check', action='store_true', help='check the slip only; place nothing; no key needed')
    ap.add_argument('--singles', action='store_true', help='buy each leg as its own bet instead of one combo')
    ap.add_argument('--ticket', help='the code from the app (default: read the clipboard)')
    ap.add_argument('--stake', type=Decimal, help='stake in pUSD')
    ap.add_argument('--min-payout', type=Decimal, help='accept a combo only if it pays at least this multiple')
    ap.add_argument('--slippage', type=int, default=2, help='cents a leg may rise above the app price (default 2)')
    a = ap.parse_args(argv)
    if a.setup:
        return setup()

    code = find_ticket(a.ticket) if a.ticket else find_ticket(read_clipboard())
    if not code:
        say('No slip code in your clipboard. In the app tap "🖥 Send to my bet script", or paste the code here.')
        code = find_ticket(input('Code: '))
    if not code:
        raise Stop('No slip code found.')
    slip = decode_ticket(code)
    mode = 'singles' if a.singles else 'combo'
    say(f'{slip["name"]} slip · {len(slip["legs"])} legs · made {slip["made"].replace("T", " ")} · app stake ${slip["stake"]}'
        + (f' · app payout ×{slip["app_x"]}' if slip['app_x'] else ''))
    say('Checking every leg on Polymarket…')
    legs = [load_leg(L) for L in slip['legs']]
    now = datetime.now(timezone.utc)
    probs = {L['n']: leg_problems(L, a.slippage, now, mode) for L in legs}
    show_legs(legs, probs)
    bad = [n for n, p in probs.items() if p]
    asks = [L['ask'] for L in legs if L['ask']]
    live_x = Decimal(1)
    for x in asks:
        live_x /= x
    say(f'At live prices the legs pay ×{live_x:.2f} together' + (f' (the app saw ×{slip["app_x"]})' if slip['app_x'] else '') + '.')
    if bad:
        raise Stop(f'Leg{"s" if len(bad) > 1 else ""} {", ".join(map(str, bad))} failed the check (✗ above), so nothing will be placed. '
                   'Build a fresh slip in the app (✖ swaps a leg) and send it again.')
    if a.check:
        say('Check passed. Nothing was placed (this was --check).')
        return 0

    cfg = read_config()
    stake = a.stake if a.stake is not None else slip['stake']
    stake = stake.quantize(Decimal('0.01'), ROUND_DOWN)
    if stake <= 0:
        raise Stop('The stake has to be more than $0.')
    if stake > cfg['MAX_STAKE']:
        raise Stop(f'${stake} is more than your cap of ${cfg["MAX_STAKE"]} (MAX_STAKE in {CONFIG}).')
    floor_x = a.min_payout if a.min_payout is not None else (live_x * Decimal('0.85')).quantize(Decimal('0.01'))

    st, geo, _ = http_json(GEOBLOCK, timeout=15)  # Polymarket's own location check; the script never works around it
    if st != 200 or not isinstance(geo, dict):
        raise Stop('Couldn\'t confirm with Polymarket that betting is allowed where you are, so nothing was placed. Try again later.')
    if geo.get('blocked'):
        raise Stop(f'Polymarket doesn\'t allow placing bets from your location ({geo.get("country")}-{geo.get("region")}). This script won\'t work around that.')

    if mode == 'combo':
        say(f'About to place ONE combo of {len(legs)} legs for up to {stake} pUSD.')
        say(f'It is accepted automatically only if the best quote costs no more than {stake} pUSD and pays at least ×{floor_x:.2f} (to win at least {stake * floor_x:.2f} pUSD).')
    else:
        each = (stake / len(legs)).quantize(Decimal('0.01'), ROUND_DOWN)
        say(f'About to buy {len(legs)} separate bets of ${each} each (${each * len(legs)} total), each only up to its app price + {a.slippage}¢.')
        say('Separate bets are NOT a parlay: each leg wins or loses on its own.')
    if input('Type yes to place it: ').strip().lower() != 'yes':
        say('Cancelled. Nothing was placed.')
        return 0

    S = sdk()
    client = connect(cfg, S)
    log = make_logger(slip)
    log({'event': 'start', 'mode': mode, 'legs': [[L['id'], L['o']] for L in legs], 'stake': float(stake), 'floor': float(floor_x)})
    if mode == 'combo':
        place_combo(client, S, slip, legs, stake, floor_x, log)
    else:
        place_singles(client, legs, stake, a.slippage, log)
    say('In the app, tap "✅ I placed it" on that slip so it is tracked and graded.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except Stop as e:
        say(f'\n✗ {e}')
        sys.exit(1)
    except KeyboardInterrupt:
        say('\nStopped. If a combo was being accepted, check your Polymarket portfolio.')
        sys.exit(130)
