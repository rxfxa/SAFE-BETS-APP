#!/usr/bin/env python3
"""Merge the morning researchers' team-form results into form.json for the Upset Parlays tab.

    python3 tools/form_merge.py <results.json> [<results.json> ...] [--groups .work/form/groups.json] [--out form.json]

Each results file is a JSON list of {group, teams:[...]} (a workflow's return value) or a single {teams:[...]}. Team entries
follow the research schema (name, comp, league, position, of, record, unbeaten, winStreak, lossStreak, winless, last5, lastGame,
games, absences, asOf, sources, confidence, note). The sport comes from groups.json (by team name). Teams already in the old
form.json that were not researched again are kept only if their asOf is within 7 days.

From `games` (the last 5 games, oldest first, each with the opponent's table position) it works out who a run came against:
  vsBottom  wins in the current winning run against bottom-half opponents
  soft      a run of 3+ wins where at least two thirds came against bottom-half opponents
which the page uses to flag streaks that may be priced higher than the opponents they beat justify.
"""
import json, sys, os
from datetime import datetime, timezone, timedelta

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
groups_path, out = opt('--groups', '.work/form/groups.json'), opt('--out', 'form.json')
files = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or not args[i - 1].startswith('--'))]
sport_of = {}
try:
    for g in json.load(open(groups_path)):
        for t in g['teams']:
            sport_of[t['name']] = t['sport']
except (OSError, ValueError):
    pass
INT = ('position', 'of', 'unbeaten', 'winStreak', 'lossStreak', 'winless')


def clean(t, sport):
    e = {k: t.get(k) for k in ('name', 'comp', 'league', 'position', 'of', 'record', 'unbeaten', 'winStreak', 'lossStreak', 'winless',
                               'last5', 'lastGame', 'games', 'absences', 'asOf', 'sources', 'confidence', 'note') if t.get(k) not in (None, '', [])}
    e['sport'] = sport
    for k in INT:
        if k in e:
            try:
                e[k] = int(e[k])
            except (TypeError, ValueError):
                del e[k]
    for k in ('unbeaten', 'winStreak', 'lossStreak', 'winless'):
        e.setdefault(k, 0)
    G = [g for g in (e.get('games') or []) if isinstance(g, dict)]
    if G:
        run = []
        for g in reversed(G):  # newest first: the current winning run
            if str(g.get('result', '')).upper() != 'W':
                break
            run.append(g)
        def bottom(g):
            try:
                return int(g['oppPos']) > int(g['oppOf']) / 2
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                return None
        known = [bottom(g) for g in run if bottom(g) is not None]
        e['vsBottom'] = sum(1 for b in known if b)
        e['runKnown'] = len(known)
        e['soft'] = len(run) >= 3 and len(known) >= 3 and e['vsBottom'] >= 2 * len(known) / 3
    return e


teams = {}
for f in files:
    d = json.load(open(f))
    d = d.get('result', d) if isinstance(d, dict) and 'result' in d else d
    blocks = d if isinstance(d, list) else [d]
    for b in blocks:
        for t in (b or {}).get('teams', []) or []:
            name = t.get('name')
            sport = sport_of.get(name) or t.get('sport')
            if not name or not sport:
                continue
            teams[(sport, name)] = clean(t, sport)

now = datetime.now(timezone.utc)
try:
    old = json.load(open(out))
except (OSError, ValueError):
    old = {'teams': []}
for t in old.get('teams', []):
    k = (t.get('sport'), t.get('name'))
    if k in teams:
        continue
    try:
        if now - datetime.fromisoformat(str(t.get('asOf')) + 'T00:00:00+00:00') <= timedelta(days=7):
            teams[k] = t
    except ValueError:
        pass

data = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'Researched game by game from published results (sources per team)',
        'teams': sorted(teams.values(), key=lambda t: (t['sport'], t.get('comp') or '', t['name']))}
json.dump(data, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
v = sum(1 for t in data['teams'] if t.get('confidence') == 'verified')
print(f"wrote {out}: {len(data['teams'])} teams ({v} verified by a second source), {sum(1 for t in data['teams'] if t.get('soft'))} soft streaks")
