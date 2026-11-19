#!/usr/bin/env python3
"""UFC fight cards from Polymarket (public Gamma API, no key) into ufc.json for the Safe Bets app.

    python3 tools/ufc_fetch.py [out=ufc.json] [days=10]

For every open UFC event (series 38) in the window it keeps the fight's markets: the moneyline (who wins), go the
distance, method of victory / finish, round of finish / victory and total rounds. Prices are Polymarket's mid prices:
dollars per $1 share, i.e. the market's implied chance. id + o identify the exact outcome (o = 0 is the first outcome,
Yes or the first fighter), so a bet can be placed the same way as the football legs.
"""
import json, sys, re, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

API = 'https://gamma-api.polymarket.com/events'
SERIES_UFC = 38
KINDS = {'ufc_method_of_victory': 'method', 'ufc_method_of_finish': 'method', 'ufc_go_the_distance': 'distance',
         'ufc_round_of_finish': 'rounds', 'ufc_round_of_victory': 'rounds', 'totals': 'rounds'}


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise SystemExit(f'fetch failed, nothing written: {url} ({e})')  # never write a partial card
            time.sleep(1.5 * (i + 1))


def jl(x):
    if isinstance(x, list):
        return x
    try:
        return json.loads(x or '[]')
    except ValueError:
        return []


def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def first_price(m):
    pr = [num(p) for p in jl(m.get('outcomePrices'))]
    return round(pr[0], 4) if pr and pr[0] is not None else None


def weight_and_card(title):
    m = re.search(r'\(([^)]*)\)\s*$', title or '')
    if not m:
        return None, None
    parts = [p.strip() for p in m.group(1).split(',')]
    card = 'Main Card' if any('Main Card' in p for p in parts) else 'Prelims' if any('Prelim' in p for p in parts) else None
    weight = next((p for p in parts if 'Main Card' not in p and 'Prelim' not in p), None)
    return weight, card


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'ufc.json'
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    now = datetime.now(timezone.utc)
    events = []
    for page in range(4):
        q = urllib.parse.urlencode({'series_id': SERIES_UFC, 'closed': 'false', 'limit': 50, 'offset': page * 50, 'order': 'endDate', 'ascending': 'true',
                                    'end_date_min': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'end_date_max': (now + timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')})
        batch = get(f'{API}?{q}') or []
        events += batch
        if len(batch) < 50:
            break
    fights = []
    for e in events:
        markets = [m for m in (e.get('markets') or []) if m.get('active', True) and not m.get('closed')]
        ml = next((m for m in markets if m.get('sportsMarketType') == 'moneyline'), None)
        if not ml:
            continue
        names = [str(o) for o in jl(ml.get('outcomes'))]
        if len(names) != 2:
            continue
        fight = {'slug': e.get('slug'), 'title': e.get('title') or '', 'start': (e.get('startTime') or e.get('endDate') or '').replace('+00:00', 'Z'),
                 'url': f'https://polymarket.com/event/{e.get("slug")}', 'fighters': names, 'ml': [], 'distance': None, 'method': [], 'rounds': []}
        fight['weight'], fight['card'] = weight_and_card(fight['title'])
        for i, name in enumerate(names):
            p = first_price(ml) if i == 0 else (None if first_price(ml) is None else round(1 - first_price(ml), 4))
            fight['ml'].append({'name': name, 'id': int(ml['id']) if str(ml.get('id') or '').isdigit() else None, 'o': i, 'p': p})
        for m in markets:
            kind = KINDS.get(m.get('sportsMarketType') or '')
            p = first_price(m)
            if not kind or p is None or not (0.01 < p < 0.99) or not str(m.get('id') or '').isdigit():
                continue
            row = {'q': (m.get('question') or '').strip(), 'id': int(m['id']), 'o': 0, 'p': p}
            if kind == 'distance':
                fight['distance'] = row
            elif kind == 'method':
                fight['method'].append(row)
            elif kind == 'rounds':
                fight['rounds'].append(row)
        if not fight['ml'][0]['p'] or fight['ml'][0]['p'] is None:
            continue
        fights.append(fight)
    fights.sort(key=lambda f: f['start'])
    data = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'Polymarket Gamma API (gamma-api.polymarket.com), UFC series', 'fights': fights}
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {out}: {len(fights)} fights')


if __name__ == '__main__':
    main()
