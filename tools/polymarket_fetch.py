#!/usr/bin/env python3
"""Fetch Polymarket sports game markets (public Gamma API, no key) into polymarket.json for the Safe Bets app.

    python3 tools/polymarket_fetch.py [out=polymarket.json] [days=8]

For every league below it reads GET https://gamma-api.polymarket.com/events?series_id=<id>&closed=false&end_date_min=<now>
&end_date_max=<now+days>, merges each game's side events (player props, exact score, ...) into one game, and keeps:
  ml      moneyline: home / away (/ draw for soccer) prices
  spreads up to 8 lines (home-perspective line), totals up to 8 lines, by volume
  props   player over/under lines with a live two-sided quote (NBA: every line of points/rebounds/assists/threes;
          NFL yards/receptions: top 40)
  tsf     NBA "team to score first"
Each price is {b: best bid, a: best ask, m: mid, id: Gamma market id, o: outcome index} in dollars per $1 share (= implied
probability); id + o identify the exact outcome to buy.
"""
import json, sys, time, re, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

API = 'https://gamma-api.polymarket.com/events'
LEAGUES = [  # (series id, app sport, Polymarket league code, competition label)
    (10345, 'nba', 'nba', 'NBA'), (12185, 'nfl', 'nfl', 'NFL'), (10346, 'nhl', 'nhl', 'NHL'), (12756, 'ncaaf', 'cfb', 'College Football'),
    (10204, 'soccer', 'ucl', 'Champions League'), (10188, 'soccer', 'epl', 'Premier League'), (10193, 'soccer', 'lal', 'La Liga'),
    (10203, 'soccer', 'sea', 'Serie A'), (10194, 'soccer', 'bun', 'Bundesliga'), (10195, 'soccer', 'fl1', 'Ligue 1'),
    (10209, 'soccer', 'uel', 'Europa League'), (10286, 'soccer', 'ere', 'Eredivisie'), (10330, 'soccer', 'por', 'Primeira Liga'),
    (10189, 'soccer', 'mls', 'MLS'), (10290, 'soccer', 'mex', 'Liga MX'),
]
SIDE_SUFFIX = re.compile(r'-(exact-margin|halftime-result|exact-score|first-to-score|player-props|first-td-scorer|more-markets|total-goals|both-teams-to-score|btts|corners|cards)$')
PROP_TYPES = {'points': 'pts', 'rebounds': 'reb', 'assists': 'ast', 'threes': '3pm', 'passing_yards': 'passYds', 'rushing_yards': 'rushYds',
              'receiving_yards': 'recYds', 'receptions': 'rec', 'passing_touchdowns': 'passTd'}


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print('fetch failed', url, e, file=sys.stderr)
                return []
            time.sleep(1.5 * (i + 1))


def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def jl(x):
    if isinstance(x, list):
        return x
    try:
        return json.loads(x or '[]')
    except ValueError:
        return []


def quote(m, idx):
    """Price of outcome idx (0 = first outcome) as {b, a, m, id, o}: id is the Gamma market id and o the outcome index, so a
    leg can be placed later (tools/place_slip.py looks the market up by id and buys outcome o)."""
    prices = [num(p) for p in jl(m.get('outcomePrices'))]
    mid = prices[idx] if idx < len(prices) else None
    b, a = num(m.get('bestBid')), num(m.get('bestAsk'))
    if idx == 1:
        b, a = (None if a is None else round(1 - a, 4)), (None if b is None else round(1 - b, 4))
    if mid is None and b is not None and a is not None:
        mid = (a + b) / 2
    mid_ = int(m['id']) if str(m.get('id') or '').isdigit() else None
    return {'b': b, 'a': a, 'm': None if mid is None else round(mid, 4), 'id': mid_, 'o': idx}


def live_quote(q):
    return q['b'] is not None and q['a'] is not None and 0 < q['b'] < q['a'] < 1 and q['a'] - q['b'] <= 0.12


def vol(m):
    return num(m.get('volumeNum')) or num(m.get('volume')) or 0.0


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'polymarket.json'
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    now = datetime.now(timezone.utc)
    games = {}
    for sid, sport, code, comp in LEAGUES:
        events = []
        for page in range(8):  # the API returns at most 50 events per request (more is refused with 406)
            q = urllib.parse.urlencode({'series_id': sid, 'closed': 'false', 'limit': 50, 'offset': page * 50, 'order': 'endDate', 'ascending': 'true',
                                        'end_date_min': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'end_date_max': (now + timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')})
            batch = get(f'{API}?{q}') or []
            events += batch
            if len(batch) < 50:
                break
        for e in events:
            slug = e.get('slug') or ''
            base = SIDE_SUFFIX.sub('', slug)
            teams = e.get('teams') or []
            g = games.get(base)
            if g is None:
                if SIDE_SUFFIX.search(slug) and base not in games:
                    g = None
                home = next((t for t in teams if t.get('ordering') == 'home'), None)
                away = next((t for t in teams if t.get('ordering') == 'away'), None)
                if not home or not away:
                    if len(teams) == 2:
                        away, home = teams[0], teams[1]
                    else:
                        continue
                g = games[base] = {'slug': base, 'sport': sport, 'league': code, 'comp': comp, 'title': re.sub(r'\s+-\s+.*$', '', e.get('title') or ''),
                                   'start': (e.get('startTime') or e.get('endDate') or '').replace('+00:00', 'Z'),
                                   'home': {'name': home.get('name'), 'abbr': (home.get('abbreviation') or '').upper(), 'alias': home.get('alias')},
                                   'away': {'name': away.get('name'), 'abbr': (away.get('abbreviation') or '').upper(), 'alias': away.get('alias')},
                                   'url': f'https://polymarket.com/event/{base}', 'volume': 0.0, 'liquidity': 0.0,
                                   'ml': {}, 'spreads': [], 'totals': [], 'props': [], 'tsf': None}
            if e.get('ended') or e.get('live'):
                g['live'] = bool(e.get('live'))
            g['volume'] += num(e.get('volume')) or 0
            g['liquidity'] += num(e.get('liquidity')) or 0
            hn, an = (g['home']['name'] or '').lower(), (g['away']['name'] or '').lower()
            for m in e.get('markets') or []:
                if m.get('closed') or not m.get('active', True):
                    continue
                t = m.get('sportsMarketType') or ''
                outs = [str(o) for o in jl(m.get('outcomes'))]
                if t == 'moneyline':
                    if outs[:2] == ['Yes', 'No']:  # soccer: one Yes/No market per result
                        title = (m.get('groupItemTitle') or m.get('question') or '').lower()
                        key = 'draw' if title.startswith('draw') or 'draw' in (m.get('question') or '').lower() else 'home' if hn and hn in title else 'away' if an and an in title else None
                        if key:
                            g['ml'][key] = quote(m, 0)
                    elif len(outs) == 2:
                        for i, o in enumerate(outs):
                            side = 'home' if o.lower() == hn or o.lower() == (g['home']['alias'] or '').lower() else 'away' if o.lower() == an or o.lower() == (g['away']['alias'] or '').lower() else None
                            if side:
                                g['ml'][side] = quote(m, i)
                    g['ml']['v'] = round(g['ml'].get('v', 0) + vol(m))
                elif t == 'spreads' and len(outs) == 2 and num(m.get('line')) is not None:
                    first_home = outs[0].lower() in (hn, (g['home']['alias'] or '').lower())
                    line = num(m.get('line'))
                    q0, q1 = quote(m, 0), quote(m, 1)
                    g['spreads'].append({'hl': line if first_home else -line, 'home': q0 if first_home else q1, 'away': q1 if first_home else q0, 'v': round(vol(m))})
                elif t == 'totals' and num(m.get('line')) is not None:
                    g['totals'].append({'line': num(m.get('line')), 'over': quote(m, 0), 'under': quote(m, 1), 'v': round(vol(m))})
                elif t == 'basketball_team_to_score_first' and len(outs) == 2:
                    first_home = outs[0].lower() in (hn, (g['home']['alias'] or '').lower())
                    g['tsf'] = {'home': quote(m, 0 if first_home else 1), 'away': quote(m, 1 if first_home else 0)}
                elif t in PROP_TYPES and num(m.get('line')) is not None:
                    mm = re.match(r'^(.*?):', m.get('question') or '')
                    q0 = quote(m, 0)
                    if mm and live_quote(q0):
                        g['props'].append({'player': mm.group(1).strip(), 'stat': PROP_TYPES[t], 'line': num(m.get('line')), 'over': q0, 'under': quote(m, 1), 'v': round(vol(m))})
    keep = []
    for g in games.values():
        if not g['ml'] or len([k for k in g['ml'] if k in ('home', 'away', 'draw')]) < 2:
            continue
        g['spreads'] = sorted([s for s in g['spreads'] if live_quote(s['home']) or s['v'] > 0], key=lambda s: (-s['v'], abs((s['home']['m'] or .5) - .5)))[:8]
        g['totals'] = sorted([s for s in g['totals'] if live_quote(s['over']) or s['v'] > 0], key=lambda s: (-s['v'], abs((s['over']['m'] or .5) - .5)))[:8]
        # NBA: every live prop line (the Weekly Plan needs whole ladders, including the high lines whose No side is the safe leg)
        g['props'] = sorted(g['props'], key=lambda p: (-p['v'], p['over']['a'] - p['over']['b']))[:(400 if g['sport'] == 'nba' else 40)]
        g['volume'], g['liquidity'] = round(g['volume']), round(g['liquidity'])
        keep.append(g)
    keep.sort(key=lambda g: g['start'])
    data = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'Polymarket Gamma API (gamma-api.polymarket.com)', 'games': keep}
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    by = {}
    for g in keep:
        by[g['comp']] = by.get(g['comp'], 0) + 1
    print(f'wrote {out}: {len(keep)} games', by)


if __name__ == '__main__':
    main()
