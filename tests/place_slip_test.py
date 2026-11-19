"""Offline tests for tools/place_slip.py: no real keys, no orders, no Polymarket account.

    python3 -m venv .work/venv && .work/venv/bin/pip install polymarket-client==0.20.0
    .work/venv/bin/python tests/place_slip_test.py

Throwaway keys are generated per run. Checks that the script's combo request and signed acceptance order match what the
official SDK builds (byte for byte, with the random salt and clock pinned), that signatures recover to the signer, and runs
the full request -> quote -> accept -> fill flow against a local stand-in for Polymarket's RFQ gateway and Gamma API.
"""
import base64
import importlib.util
import json
import sys
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from polymarket import ApiKeyCreds, SecureClient
from polymarket._internal.actions import combo_rfq
from polymarket._internal.actions.orders.typed_data import build_order_typed_data
from polymarket._internal.environment import get_environment_config
from polymarket._internal.hmac import build_hmac_signature
from polymarket._internal.wallet import derive_beacon_deposit_wallet_address, derive_proxy_wallet_address
from polymarket.environments import PRODUCTION
from polymarket.rfq import ComboQuote, RfqDirection

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('place_slip', ROOT / 'tools' / 'place_slip.py')
ps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps)

FAILS = []


def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def offline_client(wallet_type, signer_type='OWNER', key=None, wallet=None):
    acct = Account.from_key(key) if key else Account.create()
    cfg = get_environment_config(PRODUCTION)
    if wallet is None:
        wallet = derive_beacon_deposit_wallet_address(acct.address, cfg.wallet_derivation) if wallet_type == 'DEPOSIT_WALLET' else derive_proxy_wallet_address(acct.address, cfg.wallet_derivation)
    creds = ApiKeyCreds(apiKey='11111111-2222-3333-4444-555555555555', secret=base64.urlsafe_b64encode(b'test-secret-32-bytes-long-000000').decode(), passphrase='pass')
    c = SecureClient._construct_for_wallet(signer=acct, wallet=wallet, wallet_type=wallet_type, signer_type=signer_type, environment=PRODUCTION, config=cfg,  # noqa: SLF001
                                           credentials=creds, api_key=None, logger=None, on_rate_limit_update=None)
    return c, acct


S = ps.sdk()
LEGS = [{'n': 1, 'combo_pos': '454169401619941368002253409521950085668002924950581530916946488608035962881'},
        {'n': 2, 'combo_pos': '480392008062283820356469112999584629275359471113175105553958724377432293376'}]

# ---- ticket decode (same encoding as plan.js encTicket)
t = {'v': 1, 't': 'safe', 'n': 'SAFE', 'd': '2026-11-19T18:00Z', 's': 2.29, 'x': 3.1, 'm': 0.3, 'p': 0.62, 'L': [[6707159, 1, 760], [6428605, 0, 630]]}
code = 'SBT1.' + base64.urlsafe_b64encode(json.dumps(t).encode()).decode().rstrip('=')
d = ps.decode_ticket(ps.find_ticket('junk ' + code + ' more'))
check('ticket decodes', d['name'] == 'SAFE' and d['stake'] == Decimal('2.29') and d['legs'][0] == {'n': 1, 'id': 6707159, 'o': 1, 'app_ask': Decimal('0.76')})
for bad in ({**t, 'v': 2}, {**t, 'L': [[1, 0, 500]]}, {**t, 'L': [[1, 2, 500], [2, 0, 500]]}, {**t, 'L': [[1, 0, 500], [1, 0, 500]]}):
    c2 = 'SBT1.' + base64.urlsafe_b64encode(json.dumps(bad).encode()).decode().rstrip('=')
    try:
        ps.decode_ticket(c2)
        check('bad ticket rejected', False, json.dumps(bad)[:60])
    except ps.Stop:
        check('bad ticket rejected', True)

# ---- HMAC headers = SDK
c, acct = offline_client('DEPOSIT_WALLET')
h = ps.l2_headers(c, 'POST', '/v1/requester/rfq/requests', '{"a":1}')
check('L2 signature matches SDK', h['POLY_SIGNATURE'] == build_hmac_signature(secret=c.credentials.secret, timestamp=int(h['POLY_TIMESTAMP']), method='POST', path='/v1/requester/rfq/requests', body='{"a":1}'))
check('L2 address is the signer', h['POLY_ADDRESS'] == acct.address)

# ---- request body = SDK
for wt in ('DEPOSIT_WALLET', 'POLY_PROXY'):
    c, acct = offline_client(wt)
    mine = ps.build_rfq_body(c, LEGS, Decimal('2.29'))
    _, theirs = combo_rfq.build_combo_quote_request_body(c._ctx, leg_position_ids=[L['combo_pos'] for L in LEGS], direction='BUY', amount=Decimal('2.29'), size=None, side='YES')  # noqa: SLF001
    check(f'RFQ body matches SDK ({wt})', mine == theirs, f'{mine} vs {theirs}')

# ---- signed acceptance order = SDK (salt and clock pinned), and the signature recovers to the signer
import secrets as _secrets  # noqa: E402
import time as _time  # noqa: E402

for wt in ('DEPOSIT_WALLET', 'POLY_PROXY'):
    c, acct = offline_client(wt)
    orig_bits, orig_time = _secrets.randbits, _time.time
    _secrets.randbits = lambda n: 123456789
    _time.time = lambda: 1795000000.0
    try:
        mine = ps.sign_combo_order(c, S, position_id='999000111', maker_amount_e6='966191', taker_amount_e6='1932381')
        theirs = combo_rfq._sign_acceptance_order(c._ctx, direction=RfqDirection.BUY, position_id='999000111', builder_code=S['ZERO'], maker_amount_e6=966191, taker_amount_e6=1932381)  # noqa: SLF001
    finally:
        _secrets.randbits, _time.time = orig_bits, orig_time
    check(f'signed order matches SDK ({wt})', mine == {**theirs, 'tokenId': str(theirs['tokenId'])}, f'{mine} vs {theirs}')
    order = S['UnsignedOrder'](builder=S['ZERO'], chain_id=137, exchange_address=S['Addr'](c._ctx.environment_config.exchange_v3), expiration=0, maker=S['Addr'](mine['maker']),  # noqa: SLF001
                               maker_amount=966191, metadata=S['ZERO'], order_type='GTC', salt=123456789, side='BUY', signature_type=mine['signatureType'],
                               signer=S['Addr'](mine['signer']), taker_amount=1932381, timestamp=1795000000, token_id=S['TokenId']('999000111'))
    raw = bytes.fromhex(mine['signature'][2:])[:65]
    who = Account.recover_message(encode_typed_data(full_message=build_order_typed_data(order, protocol_version='3')), signature=raw)
    check(f'signature recovers to the signer ({wt})', who == acct.address)
    check(f'exchange is Exchange v3 ({wt})', c._ctx.environment_config.exchange_v3.lower() == '0xe3333700ca9d93003f00f0f71f8515005f6c00aa')  # noqa: SLF001
    if wt == 'DEPOSIT_WALLET':
        check('deposit wallet order: maker = signer = wallet, type 3', mine['maker'] == mine['signer'] == str(c.wallet) and mine['signatureType'] == 3)
    else:
        check('proxy order: maker = proxy wallet, signer = key, type 1', mine['maker'] == str(c.wallet) and mine['signer'] == acct.address and mine['signatureType'] == 1)

# session key on a deposit wallet: same order, with the SDK's session-signer wrapper on top (as for CLOB orders)
owner = Account.create()
wallet = derive_beacon_deposit_wallet_address(owner.address, get_environment_config(PRODUCTION).wallet_derivation)
c, sess = offline_client('DEPOSIT_WALLET', signer_type='SESSION_KEY', wallet=wallet)
o1 = ps.sign_combo_order(c, S, position_id='5', maker_amount_e6='100', taker_amount_e6='300')
check('session key signature carries the session wrapper', sess.address[2:].lower() in o1['signature'].lower() and len(o1['signature']) > 400)

# ---- full flow against local stand-ins for Gamma and the RFQ gateway
STATE = {'mode': 'ok', 'accepted': None, 'polls': 0}
MARKETS = {
    '101': {'id': '101', 'question': 'Warriors vs. Grizzlies', 'outcomes': '["Warriors", "Grizzlies"]', 'bestBid': 0.74, 'bestAsk': 0.76, 'gameStartTime': '2099-01-01 01:00:00+00',
            'comboStatus': 'enabled', 'version': 'v1', 'positionIds': ['1000', '1001'], 'clobTokenIds': '["2000", "2001"]', 'active': True, 'closed': False, 'acceptingOrders': True, 'orderMinSize': 5},
    '102': {'id': '102', 'question': 'LeBron James: Points O/U 24.5', 'outcomes': '["Over", "Under"]', 'bestBid': 0.36, 'bestAsk': 0.38, 'gameStartTime': '2099-01-01 01:00:00+00',
            'comboStatus': 'enabled', 'version': 'v1', 'positionIds': ['1100', '1101'], 'clobTokenIds': '["2100", "2101"]', 'active': True, 'closed': False, 'acceptingOrders': True, 'orderMinSize': 5},
    '103': {'id': '103', 'question': 'Old game', 'outcomes': '["Yes", "No"]', 'bestBid': 0.5, 'bestAsk': 0.52, 'gameStartTime': '2001-01-01 01:00:00+00',
            'comboStatus': 'disabled', 'version': 'v1', 'positionIds': ['1200', '1201'], 'clobTokenIds': '["2200", "2201"]', 'active': True, 'closed': False, 'acceptingOrders': True, 'orderMinSize': 5},
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):  # noqa: N802
        if self.path.startswith('/markets/'):
            m = MARKETS.get(self.path.split('/')[-1])
            return self.send(200, m) if m else self.send(404, {'error': 'not found'})
        if self.path.startswith('/v1/requester/rfq/requests/'):
            STATE['polls'] += 1
            assert 'POLY_SIGNATURE' in self.headers and 'POLY_API_KEY' in self.headers
            return self.send(200, {'rfq_id': 'rfq_1', 'status': 'FILLED' if STATE['polls'] >= 2 else 'EXECUTING', 'tx_hash': '0xabc'})
        self.send(404, {})

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
        sig_ok = self.headers.get('POLY_SIGNATURE') == build_hmac_signature(secret=CLIENT.credentials.secret, timestamp=int(self.headers['POLY_TIMESTAMP']), method='POST',
                                                                              path=self.path, body=json.dumps(body, separators=(',', ':')))
        if not sig_ok:
            return self.send(401, {'error': 'bad sig', 'code': 'UNAUTHENTICATED'})
        if self.path == '/v1/requester/rfq/requests':
            if STATE['mode'] == 'noquote':
                return self.send(200, {'rfq_id': 'rfq_1', 'status': 'FAILED', 'error': {'code': 'NO_QUOTES', 'message': 'no quotes'}})
            if STATE['mode'] == 'conflict':
                return self.send(400, {'error': 'invalid rfq: contradictory legs', 'code': 'CONTRADICTORY_LEGS', 'conflict': {'legs': [body['leg_position_ids'][0]], 'conflicts_with': [body['leg_position_ids'][1]]}})
            stake = int(body['requested_size']['value_e6'])
            price = {'ok': 0.30, 'cheap': 0.60}[STATE['mode']]  # combo price per share
            shares = int(stake / price)
            import time as t2
            return self.send(200, {'rfq_id': 'rfq_1', 'status': 'AWAITING_REQUESTER_ACCEPTANCE', 'expires_at': int(t2.time() * 1000) + 5000,
                                   'request': {**{k: body[k] for k in ('direction', 'side', 'requested_size', 'leg_position_ids', 'maker_address')}, 'rfq_id': 'rfq_1',
                                               'condition_id': '0x' + 'ab' * 32, 'yes_position_id': '777', 'no_position_id': '778', 'created_at': 1},
                                   'quote': {'quote_id': 'q_1', 'blended_price_e6': str(int(price * 1e6)), 'maker_amount_e6': str(stake), 'taker_amount_e6': str(shares),
                                             'total_required_e6': str(stake), 'net_receive_e6': str(shares)}})
        if self.path == '/v1/requester/rfq/requests/rfq_1/accept':
            STATE['accepted'] = body
            return self.send(200, {'rfq_id': 'rfq_1', 'status': 'EXECUTING', 'taker_order_hash': '0xdef'})
        self.send(404, {})


srv = HTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_port}'
ps.GAMMA = BASE
ps.RFQ_BASE = BASE
ps.HOME = Path(__file__).resolve().parent.parent / '.work' / 'place-slip-test'
ps.LOG = ps.HOME / 'placed.jsonl'
CLIENT, ACCT = offline_client('DEPOSIT_WALLET')

from datetime import datetime, timezone  # noqa: E402

legs = [ps.load_leg({'n': 1, 'id': 101, 'o': 1, 'app_ask': Decimal('0.25')}), ps.load_leg({'n': 2, 'id': 102, 'o': 0, 'app_ask': Decimal('0.38')})]
check('leg loads with the right side', legs[0]['pick'] == 'Grizzlies' and legs[0]['combo_pos'] == '1001' and legs[0]['asset'] == '2001' and legs[0]['ask'] == Decimal('0.26'))
now = datetime.now(timezone.utc)
check('price within slippage passes', ps.leg_problems(legs[0], 2, now, 'combo') == [])
check('price jump is refused', any('price up' in p for p in ps.leg_problems(legs[0], 0, now, 'combo')))
old = ps.load_leg({'n': 3, 'id': 103, 'o': 0, 'app_ask': Decimal('0.52')})
pr = ps.leg_problems(old, 2, now, 'combo')
check('started game and non-combo market are refused', 'game started' in pr and 'not allowed in combos' in pr, str(pr))

slip = {'name': 'SAFE', 'tier': 'safe'}
log = ps.make_logger(slip)
ok = ps.place_combo(CLIENT, S, slip, legs, Decimal('2.29'), Decimal('3.0'), log)
acc = STATE['accepted']
check('combo placed and filled', ok is True and STATE['polls'] >= 2)
check('accepted the quote id with a signed order for the combo YES position', acc and acc['quote_id'] == 'q_1' and acc['signed_order']['tokenId'] == '777'
      and acc['signed_order']['makerAmount'] == '2290000' and acc['signed_order']['builder'] == S['ZERO'])
for mode, want in (('cheap', 'below your floor'), ('noquote', 'No market maker'), ('conflict', 'legs [1] and [2]')):
    STATE.update(mode=mode, accepted=None, polls=0)
    try:
        ps.place_combo(CLIENT, S, slip, legs, Decimal('2.29'), Decimal('3.0'), log)
        check(f'{mode}: refused', False)
    except ps.Stop as e:
        check(f'{mode}: refused with a clear reason', want in str(e) and STATE['accepted'] is None, str(e))

# main(): --check passes with no key, and a price jump stops everything before any key is read
t2 = {**t, 'L': [[101, 1, 250], [102, 0, 380]]}
code2 = 'SBT1.' + base64.urlsafe_b64encode(json.dumps(t2).encode()).decode().rstrip('=')
check('--check passes', ps.main(['--check', '--ticket', code2]) == 0)
t3 = {**t, 'L': [[101, 1, 200], [102, 0, 380]]}
code3 = 'SBT1.' + base64.urlsafe_b64encode(json.dumps(t3).encode()).decode().rstrip('=')
try:
    ps.main(['--check', '--ticket', code3])
    check('--check stops on a price jump', False)
except ps.Stop as e:
    check('--check stops on a price jump', 'Leg 1 failed' in str(e), str(e))

srv.shutdown()
print(f'\n{"ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: " + ", ".join(FAILS)}')
sys.exit(1 if FAILS else 0)
