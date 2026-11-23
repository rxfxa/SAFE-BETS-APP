#!/usr/bin/env python3
"""Merge the morning researchers' player-form results into playerform.json (recent form on the NBA player legs).

    python3 tools/playerform_merge.py <results.json> [<results.json> ...] [--groups .work/players/groups.json] [--out playerform.json] [--today YYYY-MM-DD]

Each results file is a workflow's return value (a list of {group, players:[...]}, or {"result": that list}) or one {players:[...]}.
Entries follow the research schema in tools/player-form-research.wf.js: name, team, stat, games (his last 5 games PLAYED, each with
date, opp, min, value), dnp, asOf, note, sources, confidence. Entries that already carry last5 / min5 / opp5 are taken as they are.
Each player is written as
  {name, team, stat, last5, min5, opp5, dnp, avg5, asOf, note, sources, confidence}
with last5 / min5 / opp5 OLDEST first (games sorted by date when every game has one) and avg5 the mean of last5 (1 decimal).
An entry is left out, and named on stderr, when: stat is not pts / reb / ast; last5 is not 1-5 whole numbers in range (strings and
booleans are rejected, never coerced); min5 / opp5 do not match it game for game; dnp is not 0-5; asOf is not a real date or is
after today. A bad number is never written. "verified" needs sources on two different sites, else it is lowered to "partial".
Name and team are taken from groups.json when the player is listed there, so they match the page's own keys (team|name|stat).
Players in the old playerform.json that were not researched again are kept only if their asOf is within 3 days of today.
"""
import json, sys, re, unicodedata
from datetime import datetime, date, timezone, timedelta
from urllib.parse import urlparse

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
groups_path, out = opt('--groups', '.work/players/groups.json'), opt('--out', 'playerform.json')
files = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or not args[i - 1].startswith('--'))]
now = datetime.now(timezone.utc)
today = date.fromisoformat(opt('--today', now.date().isoformat()))
STATS, CONF = ('pts', 'reb', 'ast'), ('verified', 'partial', 'unverified')
CAP = {'pts': 100, 'reb': 40, 'ast': 35}  # above any NBA single-game record: a bigger number is a typo or a season total


def name_key(s):  # the page's nameKey
    s = unicodedata.normalize('NFD', str(s or '').lower())
    return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', ''.join(c for c in s if not unicodedata.combining(c))))


listed = {}  # (name key, stat) -> (name, team) as pick_players wrote them
try:
    for g in json.load(open(groups_path)):
        for p in g.get('players', []):
            listed[(name_key(p['name']), p['stat'])] = (p['name'], p['team'])
except (OSError, ValueError, KeyError, TypeError):
    pass


def num(x):  # a real number, not a string or a bool
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float('inf')


def clean(t):
    """-> (entry, None) or (None, why it was rejected)"""
    if not isinstance(t, dict):
        return None, 'not an object'
    name, stat = t.get('name'), t.get('stat')
    if not isinstance(name, str) or not name.strip():
        return None, 'no name'
    if stat not in STATS:
        return None, f'stat {stat!r}'
    name, team = listed.get((name_key(name), stat), (name.strip(), t.get('team')))
    if not isinstance(team, str) or not re.fullmatch(r'[A-Za-z]{2,4}', team.strip()):
        return None, f'team {team!r}'
    G = t.get('games')
    if isinstance(G, list) and G:
        if not all(isinstance(g, dict) for g in G):
            return None, 'games not objects'
        if all(isinstance(g.get('date'), str) for g in G):
            G = sorted(G, key=lambda g: g['date'])  # oldest first, whatever order they came in
        G = [g for g in G if not (num(g.get('min')) and g['min'] <= 0)][-5:]  # 0 minutes = did not play
        l5, m5, o5 = [g.get('value') for g in G], [g.get('min') for g in G], [g.get('opp') for g in G]
    else:
        l5, m5, o5 = t.get('last5'), t.get('min5'), t.get('opp5')
    if not isinstance(l5, list) or not 1 <= len(l5) <= 5 or not all(num(v) and v == int(v) and 0 <= v <= CAP[stat] for v in l5):
        return None, f'last5 {l5!r}'
    if not isinstance(m5, list) or len(m5) != len(l5) or not all(num(v) and 0 < v <= 70 for v in m5):
        return None, f'min5 {m5!r}'
    if not isinstance(o5, list) or len(o5) != len(l5) or not all(isinstance(v, str) and v.strip() for v in o5):
        return None, f'opp5 {o5!r}'
    dnp = t.get('dnp')
    if not (num(dnp) and dnp == int(dnp) and 0 <= dnp <= 5):
        return None, f'dnp {dnp!r}'
    try:
        as_of = date.fromisoformat(str(t.get('asOf')))
    except ValueError:
        return None, f"asOf {t.get('asOf')!r}"
    if as_of > today:
        return None, f'asOf {as_of} is after today'
    src = list(dict.fromkeys(s for s in (t.get('sources') or []) if isinstance(s, str) and s.startswith('http')))
    conf = t.get('confidence') if t.get('confidence') in CONF else 'unverified'
    if conf == 'verified' and len({urlparse(s).netloc.lower().removeprefix('www.') for s in src}) < 2:
        conf = 'partial'  # "verified" means a second, different source agreed
    l5 = [int(v) for v in l5]
    return {'name': name, 'team': team.strip().upper(), 'stat': stat, 'last5': l5, 'min5': [round(float(v), 1) for v in m5],
            'opp5': [v.strip().upper() for v in o5], 'dnp': int(dnp), 'avg5': round(sum(l5) / len(l5), 1), 'asOf': as_of.isoformat(),
            'note': t.get('note') if isinstance(t.get('note'), str) else '', 'sources': src, 'confidence': conf}, None


key = lambda e: (e['team'], name_key(e['name']), e['stat'])
players, bad = {}, []
for f in files:
    d = json.load(open(f))
    d = d['result'] if isinstance(d, dict) and 'result' in d else d
    for b in d if isinstance(d, list) else [d]:
        for t in (b or {}).get('players', []) or []:
            e, why = clean(t)
            if e:
                players[key(e)] = e
            else:
                bad.append(f"{t.get('name')} {t.get('stat')}: {why}" if isinstance(t, dict) else f'{t!r}: {why}')

try:
    old = json.load(open(out))
except (OSError, ValueError):
    old = {'players': []}
kept = 0
for t in old.get('players') or []:
    try:
        if key(t) not in players and today - date.fromisoformat(str(t['asOf'])) <= timedelta(days=3):
            players[key(t)] = t
            kept += 1
    except (KeyError, TypeError, ValueError):
        pass

data = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'players': sorted(players.values(), key=lambda e: (e['team'], e['name'], e['stat']))}
json.dump(data, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
v = sum(1 for e in data['players'] if e.get('confidence') == 'verified')
missing = sorted(f'{n} {s}' for (k, s), (n, t) in listed.items() if (t, k, s) not in players)
print(f"wrote {out}: {len(data['players'])} players ({v} verified by a second source, {kept} kept from the last run)")
if missing:
    print(f'  {len(missing)} listed players have no form: ' + ', '.join(missing[:12]) + (' ...' if len(missing) > 12 else ''))
for b in bad:
    print('  rejected ' + b, file=sys.stderr)
