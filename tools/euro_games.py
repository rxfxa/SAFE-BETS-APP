#!/usr/bin/env python3
"""European club games (Champions League, Europa League, Conference League) from ESPN scoreboards, for the Weekend
Patterns research ("did a midweek European game make a favourite drop points at the weekend?").

    python3 tools/euro_games.py [--out tools/euro_games.json] [--from 2020-07-01] [--to <today + 14 days>] [--recent 21]

Asks ESPN for every Tuesday, Wednesday and Thursday (when these competitions play) in the range. With --recent N it only
refreshes the last N days and the next 14, keeping the rest of the file (the daily run uses this).
Writes {updated, games: [[date YYYY-MM-DD, comp, home, away], ...]} with ESPN's team names.
"""
import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
OUT = opt('--out', 'tools/euro_games.json')
today = datetime.now(timezone.utc).date()
COMPS = {'uefa.champions': 'Champions League', 'uefa.europa': 'Europa League', 'uefa.europa.conf': 'Conference League'}
try:
    old = json.load(open(OUT))
except (OSError, ValueError):
    old = {'games': []}
if '--recent' in args and old['games']:
    lo = today - timedelta(days=int(opt('--recent', 21)))
else:
    lo = date.fromisoformat(opt('--from', '2020-07-01'))
hi = date.fromisoformat(opt('--to', (today + timedelta(days=14)).isoformat()))
days = [lo + timedelta(days=i) for i in range((hi - lo).days + 1) if (lo + timedelta(days=i)).weekday() in (1, 2, 3)]


def get(slug, d):
    url = f'https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={d.strftime("%Y%m%d")}'
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=30) as r:
                ev = json.loads(r.read().decode()).get('events', [])
                out = []
                for e in ev:
                    c = e['competitions'][0]['competitors']
                    h = next((x for x in c if x.get('homeAway') == 'home'), c[0])
                    a = next((x for x in c if x.get('homeAway') == 'away'), c[1])
                    # ESPN's date is UTC kick-off; European evening games stay on the same calendar day
                    out.append([e['date'][:10], COMPS[slug], h['team']['displayName'], a['team']['displayName']])
                return out
        except Exception:  # noqa: BLE001
            time.sleep(1 + i)
    return None


jobs = [(s, d) for d in days for s in COMPS]
with ThreadPoolExecutor(10) as ex:
    res = list(ex.map(lambda j: get(*j), jobs))
failed = sum(1 for r in res if r is None)
new = {tuple(g) for r in res if r for g in r}
keep = [g for g in old['games'] if not (lo.isoformat() <= g[0] <= hi.isoformat())]
games = sorted({tuple(g) for g in keep} | new)
json.dump({'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'ESPN scoreboards (site.api.espn.com)', 'games': [list(g) for g in games]},
          open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'{len(jobs)} day/competition requests ({failed} failed); {len(new)} games in {lo}..{hi}; {len(games)} in {OUT}')
