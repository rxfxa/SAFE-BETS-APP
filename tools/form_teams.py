#!/usr/bin/env python3
"""List the teams whose form the morning research run must look up, split into groups for parallel researchers.

    python3 tools/form_teams.py [outdir=.work/form] [hours=48]

Teams = both sides of every game on Polymarket's board (polymarket.json) starting in the next `hours`, plus every team in a
leg of today's My Parlay Picks (mypicks.json, matched to data.json for full names). Writes <outdir>/groups.json
([{key, comp, teams:[{name, abbr, sport, comp, opp, start, inPicks}]}]) and one <outdir>/form_<key>.json per group (at most 12
teams each), so each researcher reads one file.
"""
import json, os, sys
from datetime import datetime, timezone, timedelta

out = sys.argv[1] if len(sys.argv) > 1 else '.work/form'
hours = int(sys.argv[2]) if len(sys.argv) > 2 else 48
os.makedirs(out, exist_ok=True)
now = datetime.now(timezone.utc)
iso = lambda s: datetime.fromisoformat(str(s).replace('Z', '+00:00'))
teams = {}  # (sport, name) -> team


def add(sport, comp, me, opp, start, pick=False):
    k = (sport, me['name'])
    t = teams.get(k) or {'name': me['name'], 'abbr': (me.get('abbr') or '').upper(), 'sport': sport, 'comp': comp, 'opp': opp['name'], 'start': start, 'inPicks': False}
    if pick:
        t['inPicks'] = True
    if iso(start) < iso(t['start']):
        t.update(opp=opp['name'], start=start, comp=comp)
    teams[k] = t


try:
    pm = json.load(open('polymarket.json'))
except (OSError, ValueError):
    pm = {'games': []}
for g in pm.get('games', []):
    if g.get('stale') or g.get('sport') not in ('nba', 'nfl', 'nhl', 'ncaaf', 'soccer'):
        continue
    try:
        t = iso(g['start'])
    except (KeyError, ValueError):
        continue
    if not (now < t <= now + timedelta(hours=hours)) or not (g.get('ml') or {}).get('home'):
        continue
    add(g['sport'], g['comp'], g['home'], g['away'], g['start'])
    add(g['sport'], g['comp'], g['away'], g['home'], g['start'])

# every team in today's picks, even outside the window (their legs must be researched without fail)
try:
    picks = json.load(open('mypicks.json'))
    feed = {g['id']: g for g in json.load(open('data.json')).get('games', [])}
except (OSError, ValueError):
    picks, feed = {'parlays': []}, {}
for P in picks.get('parlays', []):
    for L in P.get('legs', []):
        g = feed.get(L.get('gid'))
        if not g:
            continue
        add(g['sport'], g.get('comp') or L.get('comp') or '', g['home'], g['away'], g['start'], True)
        add(g['sport'], g.get('comp') or L.get('comp') or '', g['away'], g['home'], g['start'], True)

by = {}
for t in sorted(teams.values(), key=lambda t: (t['comp'], t['name'])):
    by.setdefault(t['comp'] or t['sport'], []).append(t)
groups = []
for comp, ts in by.items():
    for i in range(0, len(ts), 12):
        key = ''.join(c for c in comp.lower() if c.isalnum())[:10] + str(i // 12 + 1)
        groups.append({'key': key, 'comp': comp, 'teams': ts[i:i + 12]})
        json.dump(ts[i:i + 12], open(os.path.join(out, f'form_{key}.json'), 'w'), indent=0, ensure_ascii=False)
json.dump(groups, open(os.path.join(out, 'groups.json'), 'w'), indent=0, ensure_ascii=False)
print(f'{len(teams)} teams in {len(groups)} groups -> {out}/groups.json')
for g in groups:
    print(f"  {g['key']:14} {len(g['teams']):3}  {g['comp']}")
