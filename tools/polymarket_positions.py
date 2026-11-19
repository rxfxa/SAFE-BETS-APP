#!/usr/bin/env python3
"""Read a Polymarket account's positions and combos (parlays) from the public Data API v2 (no key needed: positions are
public on-chain) into a JSON file the Safe Bets app shows in the Weekly Plan.

    python3 tools/polymarket_positions.py 0xYourProxyWallet [out=.work/pm-positions.json]

The wallet is the account's Polymarket (proxy) address shown on its profile. Then write the file into the artifact
database as collection "pm", doc "positions" (Claude does this with ArtifactData set, file_path = the output).
"""
import json, sys, re, time, urllib.request, urllib.parse
from datetime import datetime, timezone

API = 'https://data-api.polymarket.com/v2'


def get(path, params, tries=3):
    url = f'{API}/{path}?{urllib.parse.urlencode(params)}'
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                # never write a partial file: the app would show it as the whole account
                raise SystemExit(f'fetch failed, nothing written: {url} ({e})')
            time.sleep(1.5 * (i + 1))


def walk(path, params, cap=600):
    out, cur = [], None
    while len(out) < cap:
        q = dict(params, limit=100)
        if cur:
            q['cursor'] = cur
        d = get(path, q) or {}
        out += d.get('data') or []
        cur = (d.get('pagination') or {}).get('next_cursor')
        if not cur:
            break
    return out


def num(x):
    try:
        return round(float(x), 4)
    except (TypeError, ValueError):
        return None


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r'0x[0-9a-fA-F]{40}', sys.argv[1]):
        sys.exit('usage: polymarket_positions.py 0x<40 hex wallet> [out]')
    user, out = sys.argv[1].lower(), (sys.argv[2] if len(sys.argv) > 2 else '.work/pm-positions.json')
    pos = []
    for st in ('OPEN', 'REDEEMABLE', 'REDEEMABLE_LOST', 'CLOSED'):
        for p in walk('positions', {'user': user, 'status': st}, cap=300):
            pos.append({'title': p.get('title'), 'outcome': p.get('outcome'), 'slug': p.get('slug'), 'event': p.get('event_slug'), 'end': p.get('end_date'),
                        'status': p.get('status'), 'avg': num(p.get('avg_price')), 'now': num(p.get('current_price')), 'size': num(p.get('total_size')),
                        'cost': num(p.get('total_cost_usdc')), 'value': num(p.get('current_value')), 'pnl': num(p.get('total_pnl')),
                        'first': p.get('first_entry_at'), 'last': p.get('last_event_at')})
    combos = []
    for c in walk('positions/combos', {'user': user}, cap=200):
        legs = c.get('legs') or c.get('positions') or []
        combos.append({k: c.get(k) for k in ('title', 'status', 'avg_price', 'current_price', 'total_cost_usdc', 'current_value', 'total_pnl', 'first_entry_at', 'last_event_at') if k in c}
                      | {'legs': [{k: l.get(k) for k in ('title', 'outcome', 'slug', 'status', 'current_price') if k in l} for l in legs][:30]})
    seen, uniq = set(), []
    for p in pos:  # a position can show under more than one status filter
        k = (p['slug'], p['outcome'])
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    data = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'wallet': user[:6] + '…' + user[-4:], 'positions': uniq[:400], 'combos': combos[:100]}
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {out}: {len(uniq)} positions, {len(combos)} combos')


if __name__ == '__main__':
    main()
