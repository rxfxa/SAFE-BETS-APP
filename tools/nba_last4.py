#!/usr/bin/env python3
"""Each NBA team's last 4 box scores from ESPN (site.api.espn.com) for the teams playing on a day, for the Fantasy tab's duo /
trio stacks, and the same numbers as playerform.json entries (the page blends recent form into player chances).

    python3 tools/nba_last4.py [YYYYMMDD = tomorrow in Los Angeles] [--out nbalast4.json] [--form playerform.json] [--n 4]

nbalast4.json: {updated, day, teams: {ABBR: {next: {opp, home, start}, games: [{date, opp, home, pts, oppPts,
  players: {Name: {min, pts, reb, ast, starter}}}] (newest last), starters: [last game's starters]}}}
Box scores are primary data (the league's own stat lines as ESPN publishes them), so entries are marked verified.
"""
import json, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
FIX = {'NY': 'NYK', 'GS': 'GSW', 'SA': 'SAS', 'NO': 'NOP', 'UTAH': 'UTA', 'WSH': 'WAS'}  # ESPN code -> ours
args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
la = datetime.now(timezone.utc) - timedelta(hours=8)
DAY = args[0] if args and not args[0].startswith('--') else (la + timedelta(days=1)).strftime('%Y%m%d')
OUT, FORM, NG = opt('--out', 'nbalast4.json'), opt('--form', 'playerform.json'), int(opt('--n', 4))


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print('fetch failed', url, e, file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))


ours = lambda a: FIX.get(a, a)
sb = get(f'{API}/scoreboard?dates={DAY}') or {}
teams = {}
for e in sb.get('events', []):
    c = e['competitions'][0]
    side = {x['homeAway']: x for x in c['competitors']}
    for me, op in (('home', 'away'), ('away', 'home')):
        t = side[me]['team']
        teams[ours(t['abbreviation'])] = {'espn': t['abbreviation'].lower(), 'id': t['id'], 'next': {'opp': ours(side[op]['team']['abbreviation']), 'home': me == 'home', 'start': e['date']}}
if not teams:
    sys.exit(f'no NBA games on {DAY}')
num = lambda x: float(x) if str(x).replace('.', '', 1).lstrip('-').isdigit() else None
for ab, T in teams.items():
    sch = get(f"{API}/teams/{T['id']}/schedule") or {}
    done = [e for e in sch.get('events', []) if e['competitions'][0]['status']['type'].get('completed')]
    T['games'] = []
    for e in done[-NG:]:
        s = get(f"{API}/summary?event={e['id']}")
        if not s:
            continue
        comp = s['header']['competitions'][0]
        sc = {ours(x['team']['abbreviation']): (int(x.get('score') or 0), x['homeAway']) for x in comp['competitors']}
        opp = next((k for k in sc if k != ab), None)
        g = {'date': comp['date'][:10], 'opp': opp, 'home': sc.get(ab, (0, ''))[1] == 'home', 'pts': sc.get(ab, (0,))[0], 'oppPts': sc.get(opp, (0,))[0], 'players': {}}
        for side in s['boxscore'].get('players', []):
            if ours(side['team']['abbreviation']) != ab:
                continue
            st = side['statistics'][0]
            lab = st.get('labels') or st.get('names') or []
            ix = {k: lab.index(k) for k in ('MIN', 'PTS', 'REB', 'AST') if k in lab}
            for a in st['athletes']:
                nm = a['athlete']['displayName']
                if a.get('didNotPlay') or not a.get('stats'):
                    g['players'][nm] = {'min': 0, 'dnp': True, 'starter': False}
                    continue
                v = a['stats']
                g['players'][nm] = {'min': num(v[ix['MIN']]) or 0, 'pts': num(v[ix['PTS']]), 'reb': num(v[ix['REB']]), 'ast': num(v[ix['AST']]), 'starter': bool(a.get('starter'))}
        T['games'].append(g)
        time.sleep(.3)
    T['starters'] = [n for n, p in (T['games'][-1]['players'].items() if T['games'] else []) if p.get('starter')]
    print(f"{ab}: {len(T['games'])} games, starters last game: {', '.join(T['starters'])}")
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'updated': now, 'day': DAY, 'source': 'ESPN box scores (site.api.espn.com)', 'teams': teams}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
# playerform.json: each player's last games played (pts / reb / ast), so the page's player chances use recent form
try:
    pf = json.load(open(FORM))
except (OSError, ValueError):
    pf = {'players': []}
keep = {(p.get('team'), p.get('name'), p.get('stat')): p for p in pf.get('players', [])}
for ab, T in teams.items():
    names = {n for g in T['games'] for n in g['players']}
    for nm in names:
        played = [(g, g['players'][nm]) for g in T['games'] if nm in g['players'] and not g['players'][nm].get('dnp') and g['players'][nm].get('min', 0) > 0]
        if len(played) < 2:
            continue
        for st in ('pts', 'reb', 'ast'):
            vals = [p[st] for g, p in played if p.get(st) is not None]
            keep[(ab, nm, st)] = {'name': nm, 'team': ab, 'stat': st, 'last5': vals, 'min5': [p['min'] for g, p in played], 'opp5': [g['opp'] for g, p in played],
                                  'dnp': len(T['games']) - len(played), 'avg5': round(sum(vals) / len(vals), 1) if vals else None, 'asOf': T['games'][-1]['date'],
                                  'note': f'last {len(T["games"])} team games, ESPN box scores', 'sources': ['https://site.api.espn.com'], 'confidence': 'verified'}
pf = {'updated': now, 'note': "Each player's last team games from ESPN box scores (tools/nba_last4.py) and the morning research.", 'players': list(keep.values())}
json.dump(pf, open(FORM, 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'wrote {OUT} ({len(teams)} teams) and {FORM} ({len(pf["players"])} player-stat entries)')
