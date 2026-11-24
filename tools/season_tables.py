#!/usr/bin/env python3
"""Season player tables (season.json) for the Players, Stat Explorer, Prop Analyzer and Fantasy screens.

Reads the ESPN box-score cache that tools/leg_pairs.py keeps in .work/box/<sport>/<event>.json (run leg_pairs.py first;
this script fetches no box scores). Adds ESPN team names (one teams call per sport, so the app can match the feed's teams by
name) and NFL roster positions (one roster call per team). College positions are guessed from usage, as leg_pairs.py does.

Output, compact on purpose (the app loads it only when one of those screens opens):
  {updated, source, sports: {<sport>: {games, teams: {ESPN abbr: name}, fields: [...], players: [
      {n: name, t: ESPN team abbr, pos, gp, tot: [season totals in `fields` order], log: [[date, opp, home 1/0, stats in `fields` order], ...]}
  ]}}}
Logs keep every game for football (17 or fewer) and the last 15 for the NBA, NHL and soccer.
Run: python3 -I tools/season_tables.py
"""
import json
import os
import sys
import unicodedata
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.work', 'box')
API = 'https://site.api.espn.com/apis/site/v2/sports/'
PATH = {'nfl': 'football/nfl', 'ncaaf': 'football/college-football', 'nba': 'basketball/nba', 'nhl': 'hockey/nhl', 'soccer': None}
FIELDS = {
    'nfl': ['pa', 'pyd', 'ptd', 'ra', 'ryd', 'rtd', 'tgt', 'rec', 'recyd', 'ctd'],
    'ncaaf': ['pa', 'pyd', 'ptd', 'ra', 'ryd', 'rtd', 'tgt', 'rec', 'recyd', 'ctd'],
    'nba': ['min', 'pts', 'reb', 'ast'],
    'nhl': ['g', 'a', 'sog'],
    'soccer': ['g', 'sot', 'sh'],
}
KEEP_LOG = {'nfl': 99, 'ncaaf': 99, 'nba': 15, 'nhl': 15, 'soccer': 15}


def nk(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", '', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def get(url):
    for _ in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception:
            continue
    return None


def team_names(sp):
    if not PATH.get(sp):
        return {}
    T = get(f"{API}{PATH[sp]}/teams?limit=1000") or {}
    et = [t['team'] for lg in T.get('sports', [{}])[0].get('leagues', []) for t in lg.get('teams', [])]
    return {t.get('abbreviation'): t.get('displayName') for t in et if t.get('abbreviation')}


def nfl_positions(games):
    ids = sorted({str(t['id']) for g in games for t in g['teams'].values() if t.get('id')})
    pos, byname = {}, defaultdict(set)

    def one(tid):
        r = get(f"{API}football/nfl/teams/{tid}/roster") or {}
        return tid, [(nk(it['displayName']), (it.get('position') or {}).get('abbreviation')) for grp in r.get('athletes', []) for it in grp.get('items', [])]
    with ThreadPoolExecutor(8) as ex:
        for tid, res in ex.map(one, ids):
            for n, q in res:
                pos[(tid, n)] = q
                byname[n].add(q)
    uniq = {n: next(iter(v)) for n, v in byname.items() if len(v) == 1}
    abbr2id = {ab: str(t['id']) for g in games for ab, t in g['teams'].items() if t.get('id')}
    return lambda ab, name: pos.get((abbr2id.get(ab), nk(name))) or uniq.get(nk(name))


def guess_pos(lines):
    pa = sum(l.get('pa', 0) for l in lines) / len(lines)
    ra = sum(l.get('ra', 0) for l in lines) / len(lines)
    rc = sum(l.get('rec', 0) for l in lines) / len(lines)
    return 'QB' if pa >= 8 else 'RB' if ra >= 5 and ra >= rc else 'WR' if rc >= 1 else None


def num(x):
    try:
        v = float(x)
        return int(v) if v == int(v) else round(v, 1)
    except (TypeError, ValueError):
        return 0


def build(sp):
    d = os.path.join(CACHE, sp)
    if not os.path.isdir(d):
        return None
    games = []
    for f in os.listdir(d):
        if f.endswith('.json'):
            try:
                games.append(json.load(open(os.path.join(d, f))))
            except (OSError, ValueError):
                pass
    games.sort(key=lambda g: g.get('date', ''))
    F = FIELDS[sp]
    by = defaultdict(list)  # (team, name) -> [(game, line)]
    for g in games:
        for p in g.get('players', []):
            by[(p['team'], p['name'])].append((g, p))
    posf = nfl_positions(games) if sp == 'nfl' else None
    out = []
    for (team, name), gl in by.items():
        lines = [p for _, p in gl]
        if sp in ('nfl', 'ncaaf'):
            q = posf(team, name) if posf else guess_pos(lines)
            if sp == 'nfl':
                q = q if q in ('QB', 'RB', 'WR', 'TE') else ('RB' if q == 'FB' else None)
            if not q:
                continue
            yards = sum(num(l.get('pyd')) + num(l.get('ryd')) + num(l.get('recyd')) for l in lines)
            if sp == 'ncaaf' and yards < 150:
                continue  # college: only players with a real role
            pos = q
        else:
            pos = (lines[-1].get('pos') or '')
            if sp == 'nba' and sum(num(l.get('min')) for l in lines) < 30:
                continue
            if sp == 'nhl' and len(lines) < 3:
                continue
            if sp == 'soccer' and sum(num(l.get('sh')) for l in lines) < 3 and not any(num(l.get('g')) for l in lines):
                continue
        tot = [round(sum(num(l.get(f)) for l in lines), 1) for f in F]
        tot = [int(x) if x == int(x) else x for x in tot]
        log = []
        for g, l in gl[-KEEP_LOG[sp]:]:
            opp = next((ab for ab in g['teams'] if ab != team), '')
            home = 1 if (g['teams'].get(team) or {}).get('home') else 0
            log.append([g['date'], opp, home] + [num(l.get(f)) for f in F])
        out.append({'n': name, 't': team, 'pos': pos, 'gp': len(lines), 'tot': tot, 'log': log})
    out.sort(key=lambda r: (r['t'], -r['gp'], r['n']))
    return {'games': len(games), 'teams': team_names(sp), 'fields': F, 'players': out}


def main():
    sports = sys.argv[1:] or list(FIELDS)
    try:
        old = json.load(open(os.path.join(ROOT, 'season.json')))
    except (OSError, ValueError):
        old = {'sports': {}}
    res = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'source': 'ESPN box scores (site.api.espn.com), this season; positions from ESPN rosters (NFL) or usage (college)',
           'sports': {}}
    for sp in sports:
        r = build(sp)
        if r:
            res['sports'][sp] = r
            print(f"{sp}: {r['games']} games, {len(r['players'])} players, {len(r['teams'])} team names")
    for sp, v in old.get('sports', {}).items():
        res['sports'].setdefault(sp, v)
    json.dump(res, open(os.path.join(ROOT, 'season.json'), 'w'), separators=(',', ':'))
    print('season.json', os.path.getsize(os.path.join(ROOT, 'season.json')) // 1024, 'KB')


if __name__ == '__main__':
    main()
