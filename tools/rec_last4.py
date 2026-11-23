#!/usr/bin/env python3
"""Receptions for NFL and college football receivers: each team's last 4 ESPN box scores, for the teams in upcoming
feed games (data.json), written to nflrec.json for the page's reception legs.

    python3 tools/rec_last4.py [--days 8] [--n 4] [--out nflrec.json] [--feed data.json]

nflrec.json: {updated, source, teams: [{sport, feedAbbr, name, games: n, players: [{name, rec: [last games, oldest first],
 avg, tgt?}]}]} - players with 2+ catches a game on average in the games they played.
"""
import json, re, sys, time, unicodedata, urllib.request
from datetime import datetime, timedelta, timezone

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
DAYS, NG, OUT, FEED = int(opt('--days', 8)), int(opt('--n', 4)), opt('--out', 'nflrec.json'), opt('--feed', 'data.json')
PATH = {'nfl': 'football/nfl', 'ncaaf': 'football/college-football'}
API = 'https://site.api.espn.com/apis/site/v2/sports/'


def get(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception:  # noqa: BLE001
            time.sleep(1.2 * (i + 1))
    return None


nk = lambda s: re.sub(r'[^a-z0-9 ]+', '', unicodedata.normalize('NFD', str(s or '').lower()).encode('ascii', 'ignore').decode()).strip()
now = datetime.now(timezone.utc)
feed = json.load(open(FEED))
games = [g for g in feed.get('games', []) if g.get('sport') in PATH and g.get('status') != 'closed'
         and now <= datetime.fromisoformat(g['start'].replace('Z', '+00:00')) <= now + timedelta(days=DAYS)]
teams, boards = {}, {}
for g in games:
    sp, d = g['sport'], datetime.fromisoformat(g['start'].replace('Z', '+00:00')) - timedelta(hours=8)
    key = (sp, d.strftime('%Y%m%d'))
    if key not in boards:
        q = '&groups=80&limit=300' if sp == 'ncaaf' else ''
        boards[key] = get(f"{API}{PATH[sp]}/scoreboard?dates={key[1]}{q}") or {}
    for e in boards[key].get('events', []):
        comp = e['competitions'][0]['competitors']
        def side(name, abbr):  # the ESPN competitor that is this feed team
            for c in comp:
                t = c['team']
                if t.get('abbreviation', '').upper() == abbr.upper() or nk(t.get('displayName')) == nk(name) or (nk(t.get('location')) and nk(t.get('location')) in nk(name)):
                    return t
            return None
        h, a = side(g['home']['name'], g['home']['abbr']), side(g['away']['name'], g['away']['abbr'])
        if h and a:
            for t, f in ((h, g['home']), (a, g['away'])):
                teams[(sp, t['id'])] = {'sport': sp, 'feedAbbr': f['abbr'], 'name': f['name'], 'espn': t['id']}
            break
print(f'{len(games)} upcoming NFL / college games, {len(teams)} teams matched on ESPN')
out = []
for (sp, tid), T in teams.items():
    sch = get(f"{API}{PATH[sp]}/teams/{tid}/schedule") or {}
    done = [e for e in sch.get('events', []) if e['competitions'][0]['status']['type'].get('completed')][-NG:]
    rec = {}
    for e in done:
        s = get(f"{API}{PATH[sp]}/summary?event={e['id']}")
        if not s:
            continue
        for side in s.get('boxscore', {}).get('players', []):
            if str(side['team'].get('id')) != str(tid):
                continue
            for st in side.get('statistics', []):
                if st.get('name') != 'receiving':
                    continue
                lab = st.get('labels') or []
                i = lab.index('REC') if 'REC' in lab else None
                if i is None:
                    continue
                for a in st.get('athletes', []):
                    try:
                        rec.setdefault(a['athlete']['displayName'], {})[e['id']] = int(a['stats'][i])
                    except (ValueError, IndexError, KeyError):
                        pass
        time.sleep(.2)
    ids = [e['id'] for e in done]
    players = []
    for name, by in rec.items():
        vals = [by[i] for i in ids if i in by]
        if len(vals) >= 2 and sum(vals) / len(vals) >= 2:
            players.append({'name': name, 'rec': vals, 'avg': round(sum(vals) / len(vals), 1)})
    players.sort(key=lambda p: -p['avg'])
    out.append({**T, 'games': len(ids), 'players': players[:6]})
    print(f"{sp} {T['feedAbbr']}: {len(ids)} games, {len(players)} receivers")
json.dump({'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'ESPN box scores (site.api.espn.com), last 4 games', 'teams': out}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'wrote {OUT}: {sum(len(t["players"]) for t in out)} receivers on {len(out)} teams')
