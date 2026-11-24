#!/usr/bin/env python3
"""Which legs help each other: measured from this season's real box scores (ESPN), per sport.

    python3 tools/leg_pairs.py [--out pairs.json] [--players nflplayers.json] [--feed data.json] [--cache .work/box]
                               [--sports nfl,ncaaf,nba,nhl,soccer] [--boot 300]

For every pair of legs that can share a parlay (the same player's two stats, two teammates, a player and his team's
result, a player and the game total) it measures how often both land, against each player's own usual level: a leg
"lands" when the player beats his own median in that game (for a touchdown / goal: scores at least once). The joint rate
is measured WITHIN players (each player's own covariance, pooled), so players who simply score more often, or play for
teams that win more, don't create a link. The correlation of a normal copula giving that joint rate (tetrachoric), a
bootstrap over players (seeded per pair) for its range and p-value, and Holm's correction across every pair tested:
a link is "reliable" only if it survives Holm, has 150+ player-games and is at least 0.05 in size.
Yards legs are calibrated: walking forward through the season, each player's chance at each line is priced the way the
app prices it (from his earlier games only) and compared with what happened; the isotonic map from priced to actual is
written next to the spread model as an isotonic map (shrunk toward no correction when under 80 players back it), with a
by-player split check.

Pairs (positions from ESPN rosters for the NFL; college positions read from each player's stats):
  NFL / college: RB touchdown + rushing yards / receiving yards / receptions; WR, TE touchdown + receiving yards,
    receptions + receiving yards; QB passing yards + 2+ passing TDs; QB passing yards + his top receiver's yards; RB
    rushing yards + QB passing yards; each with the team's win and the game total.
  NBA: the same player's points + rebounds / assists, rebounds + assists; top scorer + playmaker; two top scorers;
    each with the team's win and the game total.
  NHL: the same player's goal + shots on goal, point + shots; two top scorers; each with the team's win.
  Soccer: the same player's goal + shot on target; goal + team win.
Also writes the yards spread model (sd = a + b x mean), nflplayers.json (every NFL / college player on teams in the
feed's upcoming games, with his season game logs: rushing, receiving, passing yards and touchdowns, and position) and
refreshes firsttd.json's season touchdowns for every NFL team in the feed (its game-day "status" notes are kept).
"""
import hashlib, json, math, os, re, sys, time, unicodedata, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import numpy as np

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
OUT, PLAYERS, FEED, CACHE = opt('--out', 'pairs.json'), opt('--players', 'nflplayers.json'), opt('--feed', 'data.json'), opt('--cache', '.work/box')
SPORTS = opt('--sports', 'nfl,ncaaf,nba,nhl,soccer').split(',')
BOOT = int(opt('--boot', 1000))
NOW = datetime.now(timezone.utc)
API = 'https://site.api.espn.com/apis/site/v2/sports/'
PATH = {'nfl': 'football/nfl', 'ncaaf': 'football/college-football', 'nba': 'basketball/nba', 'nhl': 'hockey/nhl'}
SOCCER = {'eng.1': 'Premier League', 'esp.1': 'La Liga', 'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1'}
START = {'nba': date(2026, 10, 20), 'nhl': date(2026, 10, 6), 'soccer': date(2026, 8, 14)}
rng = np.random.default_rng(7)


def get(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception:  # noqa: BLE001
            time.sleep(1 + i)
    return None


nk = lambda s: re.sub(r'[^a-z0-9]+', '', unicodedata.normalize('NFD', str(s or '').lower()).encode('ascii', 'ignore').decode())
num = lambda x: float(x) if re.fullmatch(r'-?\d+(\.\d+)?', str(x or '').strip()) else 0.0


# ---------- events this season ----------
def events(sport):
    out = {}
    if sport in ('nfl', 'ncaaf'):
        q = '&groups=80&limit=400' if sport == 'ncaaf' else ''
        for w in range(1, 19):
            d = get(f"{API}{PATH[sport]}/scoreboard?seasontype=2&week={w}&dates=2026{q}") or {}
            for e in d.get('events', []):
                if e['competitions'][0]['status']['type'].get('completed'):
                    out[e['id']] = (sport, PATH[sport], e['date'][:10])
            if d and not d.get('events'):
                break
    else:
        lgs = [(sl, f'soccer/{sl}') for sl in SOCCER] if sport == 'soccer' else [(sport, PATH[sport])]
        days = [START[sport] + timedelta(days=i) for i in range((NOW.date() - START[sport]).days)]
        jobs = [(lg, p, d) for lg, p in lgs for d in days]

        def one(j):
            lg, p, d = j
            r = get(f"{API}{p}/scoreboard?dates={d.strftime('%Y%m%d')}") or {}
            return [(e['id'], (sport, p, e['date'][:10])) for e in r.get('events', []) if e['competitions'][0]['status']['type'].get('completed')]
        with ThreadPoolExecutor(12) as ex:
            for res in ex.map(one, jobs):
                out.update(dict(res))
    return out


def extract(sport, path, eid, d):
    """one game, compact: teams (points, win) and player lines"""
    s = get(f"{API}{path}/summary?event={eid}")
    if not s:
        return None
    comp = s.get('header', {}).get('competitions', [{}])[0]
    teams = {}
    for c in comp.get('competitors', []):
        t = c.get('team', {})
        teams[t.get('abbreviation') or t.get('id')] = {'id': t.get('id'), 'pts': num(c.get('score')), 'win': bool(c.get('winner')), 'home': c.get('homeAway') == 'home'}
    P = defaultdict(dict)
    if sport == 'soccer':
        for side in s.get('rosters', []):
            ab = side.get('team', {}).get('abbreviation')
            for p in side.get('roster', []):
                st = {x.get('name'): x.get('value') for x in p.get('stats', [])}
                if not st.get('appearances'):
                    continue
                P[(ab, p['athlete']['displayName'])] = {'pos': (p.get('position') or {}).get('abbreviation'), 'g': st.get('totalGoals') or 0, 'sot': st.get('shotsOnTarget') or 0, 'sh': st.get('totalShots') or 0}
    else:
        for side in s.get('boxscore', {}).get('players', []):
            ab = side['team'].get('abbreviation')
            for cat in side.get('statistics', []):
                lab, name = cat.get('labels') or [], cat.get('name')
                for a in cat.get('athletes', []):
                    v = dict(zip(lab, a.get('stats') or []))
                    if not v:
                        continue
                    k = (ab, a['athlete']['displayName'])
                    pos = (a['athlete'].get('position') or {}).get('abbreviation')
                    if pos:
                        P[k]['pos'] = pos
                    if sport in ('nfl', 'ncaaf'):
                        if name == 'passing':
                            att = str(v.get('C/ATT', '0/0')).split('/')
                            P[k].update({'pa': num(att[-1]), 'pyd': num(v.get('YDS')), 'ptd': num(v.get('TD'))})
                        elif name == 'rushing':
                            P[k].update({'ra': num(v.get('CAR')), 'ryd': num(v.get('YDS')), 'rtd': num(v.get('TD'))})
                        elif name == 'receiving':
                            P[k].update({'rec': num(v.get('REC')), 'recyd': num(v.get('YDS')), 'ctd': num(v.get('TD')), 'tgt': num(v.get('TGTS'))})
                    elif sport == 'nba':
                        if str(v.get('MIN', '')).strip() in ('', '0', '--') or a.get('didNotPlay'):
                            continue
                        P[k].update({'min': num(v.get('MIN')), 'pts': num(v.get('PTS')), 'reb': num(v.get('REB')), 'ast': num(v.get('AST'))})
                    elif sport == 'nhl' and 'S' in v and 'G' in v:  # ESPN: S = shots on goal (shotsTotal); its 'SOG' column is shootout goals
                        P[k].update({'g': num(v.get('G')), 'a': num(v.get('A')), 'sog': num(v.get('S'))})
    return {'id': eid, 'sport': sport, 'date': d, 'teams': teams, 'players': [{'team': k[0], 'name': k[1], **v} for k, v in P.items() if v]}


def load_games(sport):
    cdir = os.path.join(CACHE, sport)
    os.makedirs(cdir, exist_ok=True)
    ev = events(sport)
    have = {f[:-5] for f in os.listdir(cdir)}
    need = [(eid, v) for eid, v in ev.items() if eid not in have]

    def one(item):
        eid, (sp, p, d) = item
        g = extract(sp, p, eid, d)
        if g:
            json.dump(g, open(os.path.join(cdir, eid + '.json'), 'w'), separators=(',', ':'))
        return g is not None
    with ThreadPoolExecutor(12) as ex:
        got = sum(ex.map(one, need))
    games = [json.load(open(os.path.join(cdir, f))) for f in os.listdir(cdir) if f.endswith('.json')]
    print(f'{sport}: {len(ev)} finished games this season, {got} new box scores fetched ({len(need) - got} failed), {len(games)} in cache')
    return games


# ---------- positions (NFL rosters; college from stats) ----------
def nfl_positions(games):
    """(team id, name) -> roster position; a name alone only when it is unique across rosters"""
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
    """college: QB if he passes, RB if he mostly runs, else a receiver (WR / TE together)"""
    pa = sum(l.get('pa', 0) for l in lines) / len(lines)
    ra = sum(l.get('ra', 0) for l in lines) / len(lines)
    rc = sum(l.get('rec', 0) for l in lines) / len(lines)
    return 'QB' if pa >= 8 else 'RB' if ra >= 5 and ra >= rc else 'WR' if rc >= 1 else None


# ---------- statistics ----------
def Phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def invPhi(p):
    p = min(max(p, 1e-9), 1 - 1e-9)
    lo, hi = -10.0, 10.0
    for _ in range(80):
        m = (lo + hi) / 2
        if Phi(m) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


_x, _w = np.polynomial.legendre.leggauss(40)


def bvn(a, b, r):
    """P(X < a, Y < b) for standard normals with correlation r (Gauss-Legendre over the correlation, Plackett's identity)"""
    if abs(r) < 1e-12:
        return Phi(a) * Phi(b)
    t = (r / 2) * (_x + 1)  # nodes on [0, r]
    f = np.exp(-(a * a - 2 * t * a * b + b * b) / (2 * (1 - t * t))) / (2 * np.pi * np.sqrt(1 - t * t))
    return float(Phi(a) * Phi(b) + (r / 2) * np.sum(_w * f))


def tetra(pA, pB, pAB):
    """copula correlation that reproduces the joint rate"""
    if min(pA, pB, 1 - pA, 1 - pB) < 0.02:
        return None
    a, b = invPhi(pA), invPhi(pB)
    lo, hi = -0.95, 0.95
    if pAB <= bvn(a, b, lo):
        return lo
    if pAB >= bvn(a, b, hi):
        return hi
    for _ in range(50):
        m = (lo + hi) / 2
        if bvn(a, b, m) < pAB:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def measure(rows, desc, why, key=''):
    """rows: [(player_key, A, B)] booleans. The joint rate is measured within players: pA * pB plus the players' own
    (unbiased) covariance of A and B, pooled - so a player who scores a lot and also clears his yards a lot doesn't count
    as a link unless his good-yards games are his scoring games."""
    rows = [r for r in rows if r[1] is not None and r[2] is not None]
    n = len(rows)
    if n < 60:
        return None
    by = defaultdict(lambda: [0, 0.0, 0.0, 0.0])
    for k, a, b in rows:
        x = by[k]
        x[0] += 1
        x[1] += float(a)
        x[2] += float(b)
        x[3] += float(a) * float(b)
    M = np.array(list(by.values()), float)

    def est(M):
        N = M[:, 0].sum()
        pA, pB = M[:, 1].sum() / N, M[:, 2].sum() / N
        m = M[M[:, 0] >= 2]
        ni = m[:, 0]
        cov = (m[:, 3] / ni - (m[:, 1] / ni) * (m[:, 2] / ni)) * ni / (ni - 1)
        pAB = pA * pB + float((ni * cov).sum()) / N
        return pA, pB, min(max(pAB, max(0.0, pA + pB - 1) + 1e-9), min(pA, pB) - 1e-9)
    pA, pB, pAB = est(M)
    rho = tetra(pA, pB, pAB)
    if rho is None:
        return None
    r_ = np.random.default_rng(int(hashlib.md5(key.encode()).hexdigest()[:8], 16))
    bs = []
    for _ in range(BOOT):
        r = tetra(*est(M[r_.integers(0, len(M), len(M))]))
        if r is not None:
            bs.append(r)
    se = float(np.std(bs, ddof=1)) if len(bs) > 20 else None
    lo, hi = (float(np.quantile(bs, .025)), float(np.quantile(bs, .975))) if len(bs) > 20 else (None, None)
    pv = math.erfc(abs(rho) / se / math.sqrt(2)) if se else 1.0
    ab = key.split('|')[-2:] if key else [None, None]
    return {'desc': desc, 'why': why, 'ab': ab, 'n': n, 'players': len(M), 'pA': round(pA, 4), 'pB': round(pB, 4), 'pAB': round(pAB, 4),
            'pBgivenA': round(pAB / pA, 4), 'pAgivenB': round(pAB / pB, 4), 'lift': round(pAB / pA / pB, 3), 'rho': round(rho, 3),
            'lo': round(lo, 3) if lo is not None else None, 'hi': round(hi, 3) if hi is not None else None, 'se': round(se, 4) if se else None, 'p': pv, 'reliable': False}


def logs(games, keyf=lambda p: (p['team'], p['name'])):
    L = defaultdict(list)
    for g in games:
        for p in g['players']:
            L[keyf(p)].append((g, p))
    return L


def med(v):
    return float(np.median(v)) if v else None


def football(games, sport, pos_of):
    L = logs(games)
    # each player's own medians (games where he touched the ball in that role)
    lines = {}
    for k, gl in L.items():
        ps = [p for _, p in gl]
        pos = pos_of(k, ps)
        if not pos or len(gl) < 4:
            continue
        lines[k] = {'pos': pos, 'ryd': med([p.get('ryd', 0) for p in ps if p.get('ra', 0) > 0]), 'recyd': med([p.get('recyd', 0) for p in ps if p.get('tgt', 0) > 0 or p.get('rec', 0) > 0]),
                    'rec': med([p.get('rec', 0) for p in ps if p.get('tgt', 0) > 0 or p.get('rec', 0) > 0]), 'pyd': med([p.get('pyd', 0) for p in ps if p.get('pa', 0) >= 10]),
                    'yds': sum(p.get('recyd', 0) + p.get('ryd', 0) for p in ps)}
    totals = sorted(sum(t['pts'] for t in g['teams'].values()) for g in games)
    tmed = totals[len(totals) // 2] if totals else 45
    R = defaultdict(list)
    top = {}  # each team's top receiver and lead rusher by yards, and its QB by attempts
    for k, s in lines.items():
        t = k[0]
        if s['pos'] in ('WR', 'TE') and s['yds'] > top.get((t, 'WR'), (None, -1))[1]:
            top[(t, 'WR')] = (k, s['yds'])
        if s['pos'] == 'RB' and s['yds'] > top.get((t, 'RB'), (None, -1))[1]:
            top[(t, 'RB')] = (k, s['yds'])
    for k, gl in L.items():
        s = lines.get(k)
        if not s:
            continue
        for g, p in gl:
            tm = g['teams'].get(k[0])
            if not tm:
                continue
            win, over = tm['win'], sum(t['pts'] for t in g['teams'].values()) > tmed
            td = (p.get('rtd', 0) + p.get('ctd', 0)) >= 1
            if s['pos'] == 'RB' and p.get('ra', 0) > 0 and s['ryd'] is not None:
                ry = p.get('ryd', 0) > s['ryd']
                R['RB|td|ryd'].append((k, td, ry))
                R['RB|ryd|win'].append((k, ry, win))
                R['RB|ryd|over'].append((k, ry, over))
                R['RB|td|win'].append((k, td, win))
                if s['recyd'] is not None:
                    R['RB|td|recyd'].append((k, td, p.get('recyd', 0) > s['recyd']))
                    R['RB|recyd|ryd'].append((k, p.get('recyd', 0) > s['recyd'], ry))
                if s['rec'] is not None:
                    R['RB|rec|td'].append((k, p.get('rec', 0) > s['rec'], td))
            if s['pos'] in ('WR', 'TE') and (p.get('tgt', 0) > 0 or p.get('rec', 0) > 0) and s['recyd'] is not None:
                cy = p.get('recyd', 0) > s['recyd']
                R[f"{s['pos']}|td|recyd"].append((k, td, cy))
                R[f"{s['pos']}|recyd|win"].append((k, cy, win))
                R[f"{s['pos']}|recyd|over"].append((k, cy, over))
                R[f"{s['pos']}|td|win"].append((k, td, win))
                if s['rec'] is not None:
                    R[f"{s['pos']}|rec|recyd"].append((k, p.get('rec', 0) > s['rec'], cy))
                    R[f"{s['pos']}|rec|td"].append((k, p.get('rec', 0) > s['rec'], td))
            if s['pos'] == 'QB' and p.get('pa', 0) >= 10 and s['pyd'] is not None:
                py = p.get('pyd', 0) > s['pyd']
                R['QB|ptd|pyd'].append((k, p.get('ptd', 0) >= 2, py))
                R['QB|pyd|win'].append((k, py, win))
                R['QB|pyd|over'].append((k, py, over))
                # teammates: his top receiver's yards and his lead rusher's yards in the same game
                for role, key in (('WR', 'tm|pyd|recyd'), ('RB', 'tm|pyd|ryd')):
                    t2 = top.get((k[0], role))
                    if not t2:
                        continue
                    q = next((pp for pp in g['players'] if (pp['team'], pp['name']) == t2[0]), None)
                    s2 = lines.get(t2[0])
                    if q and s2:
                        v = q.get('recyd' if role == 'WR' else 'ryd', 0) > (s2['recyd'] if role == 'WR' else s2['ryd'] or 0)
                        R[key].append((k, py, v))
    # lead rusher vs top receiver, same team, same game
    for g in games:
        for ab in g['teams']:
            a, b = top.get((ab, 'RB')), top.get((ab, 'WR'))
            if not a or not b:
                continue
            pa = next((p for p in g['players'] if (p['team'], p['name']) == a[0]), None)
            pb = next((p for p in g['players'] if (p['team'], p['name']) == b[0]), None)
            if pa and pb and lines[a[0]]['ryd'] is not None and lines[b[0]]['recyd'] is not None:
                R['tm|recyd|ryd'].append((a[0], pb.get('recyd', 0) > lines[b[0]]['recyd'], pa.get('ryd', 0) > lines[a[0]]['ryd']))
    W = {'RB|td|ryd': ('RB touchdown + rushing yards', 'when he scores he has usually been running well'),
         'RB|td|recyd': ('RB touchdown + receiving yards', 'catches out of the backfield'), 'RB|recyd|ryd': ('RB receiving + rushing yards', 'a busy day either way'),
         'RB|rec|td': ('RB receptions + touchdown', 'a bigger share of the offence'), 'RB|ryd|win': ('RB rushing yards + team win', 'teams ahead run the ball'),
         'RB|ryd|over': ('RB rushing yards + game over', 'more points, more drives'), 'RB|td|win': ('RB touchdown + team win', 'winners score'),
         'WR|td|recyd': ('WR touchdown + receiving yards', 'a catch for a score adds yards'), 'TE|td|recyd': ('TE touchdown + receiving yards', 'a catch for a score adds yards'),
         'WR|rec|recyd': ('WR receptions + receiving yards', 'more catches, more yards'), 'TE|rec|recyd': ('TE receptions + receiving yards', 'more catches, more yards'),
         'WR|rec|td': ('WR receptions + touchdown', 'more targets'), 'TE|rec|td': ('TE receptions + touchdown', 'more targets'),
         'WR|recyd|win': ('WR receiving yards + team win', 'game script'), 'TE|recyd|win': ('TE receiving yards + team win', 'game script'),
         'WR|recyd|over': ('WR receiving yards + game over', 'shoot-outs'), 'TE|recyd|over': ('TE receiving yards + game over', 'shoot-outs'),
         'WR|td|win': ('WR touchdown + team win', 'winners score'), 'TE|td|win': ('TE touchdown + team win', 'winners score'),
         'QB|ptd|pyd': ('QB 2+ passing TDs + passing yards', 'a big passing day'), 'QB|pyd|win': ('QB passing yards + team win', 'trailing teams throw more'),
         'QB|pyd|over': ('QB passing yards + game over', 'shoot-outs'), 'tm|pyd|recyd': ("QB passing yards + his top receiver's yards", 'the yards go to someone'),
         'tm|pyd|ryd': ("QB passing yards + his lead rusher's yards", 'pass-heavy days leave fewer carries'), 'tm|recyd|ryd': ("Top receiver's yards + lead rusher's yards", 'one ball to share')}
    pairs = {k: m for k, v in R.items() if (m := measure(v, *W.get(k, (k, '')), key=f'{sport}|{k}'))}
    return pairs, lines, tmed


def basketball(games):
    L = logs(games)
    lines = {k: {s: med([p.get(s, 0) for _, p in gl]) for s in ('pts', 'reb', 'ast')} for k, gl in L.items() if len(gl) >= 5}
    totals = sorted(sum(t['pts'] for t in g['teams'].values()) for g in games)
    tmed = totals[len(totals) // 2] if totals else 225
    R = defaultdict(list)
    seasons = defaultdict(lambda: defaultdict(float))
    for k, gl in L.items():
        for _, p in gl:
            for s in ('pts', 'ast', 'reb', 'min'):
                seasons[k][s] += p.get(s, 0)
    top = {}
    for k, s in seasons.items():
        if k not in lines:
            continue
        for role, st in (('scorer', 'pts'), ('playmaker', 'ast'), ('big', 'reb')):
            if s[st] > top.get((k[0], role), (None, -1))[1]:
                top[(k[0], role)] = (k, s[st])
    second = {}
    for k, s in seasons.items():
        t = top.get((k[0], 'scorer'))
        if k in lines and t and k != t[0] and s['pts'] > second.get(k[0], (None, -1))[1]:
            second[k[0]] = (k, s['pts'])
    for k, gl in L.items():
        m = lines.get(k)
        if not m or m['pts'] < 8:
            continue
        for g, p in gl:
            tm = g['teams'].get(k[0])
            if not tm:
                continue
            hit = {s: p.get(s, 0) > m[s] for s in ('pts', 'reb', 'ast')}
            over = sum(t['pts'] for t in g['teams'].values()) > tmed
            R['pts|reb'].append((k, hit['pts'], hit['reb']))
            R['ast|pts'].append((k, hit['ast'], hit['pts']))
            R['ast|reb'].append((k, hit['ast'], hit['reb']))
            for s in ('pts', 'reb', 'ast'):
                R[f'{s}|win'].append((k, hit[s], tm['win']))
            R['pts|over'].append((k, hit['pts'], over))
    for g in games:
        for ab in g['teams']:
            row = {(p['team'], p['name']): p for p in g['players'] if p['team'] == ab}
            sc, pm, bg, s2 = top.get((ab, 'scorer')), top.get((ab, 'playmaker')), top.get((ab, 'big')), second.get(ab)
            if sc and sc[0] in row:
                ps = row[sc[0]].get('pts', 0) > lines[sc[0]]['pts']
                if pm and pm[0] != sc[0] and pm[0] in row:
                    R['tm|ast|pts'].append((pm[0], row[pm[0]].get('ast', 0) > lines[pm[0]]['ast'], ps))
                if bg and bg[0] != sc[0] and bg[0] in row:
                    R['tm|pts|reb'].append((bg[0], ps, row[bg[0]].get('reb', 0) > lines[bg[0]]['reb']))
                if s2 and s2[0] in row:
                    R['tm|pts|pts'].append((s2[0], ps, row[s2[0]].get('pts', 0) > lines[s2[0]]['pts']))
    W = {'pts|reb': ('Points + rebounds, same player', 'minutes drive both'), 'ast|pts': ('Assists + points, same player', 'minutes and the ball'),
         'ast|reb': ('Assists + rebounds, same player', 'minutes'), 'pts|win': ('Points + team win', 'stars carry wins'), 'reb|win': ('Rebounds + team win', ''),
         'ast|win': ('Assists + team win', 'made shots need passers'), 'pts|over': ('Points + game over', 'pace'),
         'tm|ast|pts': ("Playmaker's assists + top scorer's points", 'his assists feed the scorer'), 'tm|pts|reb': ("Top scorer's points + big's rebounds", 'misses become rebounds'),
         'tm|pts|pts': ('Two top scorers, same team', 'they share the shots')}
    return {k: m for k, v in R.items() if (m := measure(v, *W.get(k, (k, '')), key=f'nba|{k}'))}


def hockey(games):
    L = logs(games)
    lines = {k: {'sog': med([p.get('sog', 0) for _, p in gl])} for k, gl in L.items() if len(gl) >= 6}
    R = defaultdict(list)
    seasons = defaultdict(float)
    for k, gl in L.items():
        seasons[k] = sum(p.get('g', 0) + p.get('a', 0) for _, p in gl)
    top = defaultdict(list)
    for k, v in sorted(seasons.items(), key=lambda x: -x[1]):
        if k in lines and len(top[k[0]]) < 2:
            top[k[0]].append(k)
    for k, gl in L.items():
        m = lines.get(k)
        if not m or seasons[k] < 3:
            continue
        for g, p in gl:
            tm = g['teams'].get(k[0])
            if not tm:
                continue
            goal, point, sog = p.get('g', 0) >= 1, p.get('g', 0) + p.get('a', 0) >= 1, p.get('sog', 0) > m['sog']
            R['goal|sog'].append((k, goal, sog))
            R['point|sog'].append((k, point, sog))
            R['goal|win'].append((k, goal, tm['win']))
            R['point|win'].append((k, point, tm['win']))
            R['sog|win'].append((k, sog, tm['win']))
    for g in games:
        for ab in g['teams']:
            t = top.get(ab, [])
            if len(t) == 2:
                ps = {(p['team'], p['name']): p for p in g['players'] if p['team'] == ab}
                if t[0] in ps and t[1] in ps:
                    R['tm|point|point'].append((t[1], ps[t[0]].get('g', 0) + ps[t[0]].get('a', 0) >= 1, ps[t[1]].get('g', 0) + ps[t[1]].get('a', 0) >= 1))
    W = {'goal|sog': ('Goal + shots on goal, same player', 'goals come from shots'), 'point|sog': ('Point + shots on goal, same player', 'an active night'),
         'goal|win': ('Goal + team win', 'winners score'), 'point|win': ('Point + team win', 'winners score'), 'sog|win': ('Shots on goal + team win', ''),
         'tm|point|point': ('Two top scorers, same team', 'linemates set each other up')}
    return {k: m for k, v in R.items() if (m := measure(v, *W.get(k, (k, '')), key=f'nhl|{k}'))}


def soccer(games):
    L = logs(games)
    R = defaultdict(list)
    for k, gl in L.items():
        if len(gl) < 5 or sum(p.get('sh', 0) for _, p in gl) / len(gl) < 0.8:
            continue
        for g, p in gl:
            tm = g['teams'].get(k[0])
            if not tm:
                continue
            R['goal|sot'].append((k, p.get('g', 0) >= 1, p.get('sot', 0) >= 1))
            R['goal|win'].append((k, p.get('g', 0) >= 1, tm['win']))
            R['sot|win'].append((k, p.get('sot', 0) >= 1, tm['win']))
    W = {'goal|sot': ('Goal + shot on target, same player', 'nearly every goal is a shot on target'), 'goal|win': ('Goal + team win', 'his goal often wins it'),
         'sot|win': ('Shot on target + team win', '')}
    return {k: m for k, v in R.items() if (m := measure(v, *W.get(k, (k, '')), key=f'soccer|{k}'))}


YACT = {'ryd': lambda p: True, 'recyd': lambda p: True, 'pyd': lambda p: p.get('pa', 0) >= 10}
YPOS = {'ryd': ('RB', 'QB'), 'recyd': ('WR', 'TE', 'RB'), 'pyd': ('QB',)}
YLAD = {'ryd': [20, 30, 40, 50, 60, 70, 80, 90, 100, 120], 'recyd': [20, 30, 40, 50, 60, 70, 80, 90, 100], 'pyd': [150, 175, 200, 225, 250, 275, 300, 325]}


def pav(x, y):
    """isotonic (non-decreasing) fit of y on x, x sorted: pool adjacent violators"""
    blocks = [[yi, 1.0] for yi in y]
    out = []
    for b in blocks:
        out.append(b)
        while len(out) > 1 and out[-2][0] / out[-2][1] > out[-1][0] / out[-1][1]:
            a = out.pop()
            out[-1][0] += a[0]
            out[-1][1] += a[1]
    fit = []
    for v, w in out:
        fit += [v / w] * int(w)
    return np.array(fit)


def yards_calib(G, lines, sd, sport):
    """walk forward through the season: price each player's lines the way the app does (earlier games only: average of every
    game played, 30% weight on the last 4, spread = max(6, half the model + half his own)), see what happened, and fit an
    isotonic map priced -> actual. Checked by splitting players in two (fit on one half, test on the other)."""
    L = logs(G)
    out, check = {}, {}
    for st in ('ryd', 'recyd', 'pyd'):
        S = sd.get(st)
        if not S:
            continue
        X, Y, who = [], [], []
        for k, gl in L.items():
            s0 = lines.get(k)
            if not s0 or s0['pos'] not in YPOS[st]:
                continue
            gl = sorted(gl, key=lambda x: x[0]['date'])
            vals = [(p.get(st, 0), YACT[st](p)) for _, p in gl]
            for i in range(3, len(vals)):
                prev = [v for v, ok in vals[:i] if ok]
                if len(prev) < 3 or not vals[i][1]:
                    continue
                avg = float(np.mean(prev))
                if avg < (120 if st == 'pyd' else 20):
                    continue
                a = .7 * avg + .3 * float(np.mean(prev[-4:]))
                m = S['a'] + S['b'] * avg
                own = float(np.std(prev, ddof=1)) if len(prev) >= 5 else m
                sdv = max(6.0, .5 * m + .5 * own)
                for t in YLAD[st]:
                    q = 1 - Phi((t - .5 - a) / sdv)
                    if .03 <= q <= .985:
                        X.append(q)
                        Y.append(1.0 if vals[i][0] >= t else 0.0)
                        who.append(k)
        if len(X) < 400:
            continue
        X, Y = np.array(X), np.array(Y)
        # an isotonic map priced -> actual, binned (20 bins; 6 when few players back it), and shrunk toward "no correction"
        # when fewer than 80 players back it (NFL quarterbacks): a small sample can't move every price on its own
        def iso(x, y, nb):
            o = np.argsort(x)
            xs, fit = x[o], pav(x[o], y[o])
            qs = np.quantile(xs, np.linspace(0, 1, nb + 1))
            kn = []
            for lo_, hi_ in zip(qs[:-1], qs[1:]):
                sel = (xs >= lo_) & (xs <= hi_)
                if sel.sum():
                    kn.append([float(xs[sel].mean()), float(fit[sel].mean())])
            for j in range(1, len(kn)):
                kn[j][1] = max(kn[j][1], kn[j - 1][1])
            return kn
        npl = len(set(who))
        nb, w = (20 if npl >= 100 else 6), min(1.0, npl / 80)
        shrink = lambda kn: [[round(x_, 4), round(w * y_ + (1 - w) * x_, 4)] for x_, y_ in kn]
        out[st] = {'knots': shrink(iso(X, Y, nb)), 'players': npl, 'n': int(len(X)), 'weight': round(w, 2)}
        # check: fit on half the players, test on the other half
        ks = sorted({w_ for w_ in who})
        half = {w_ for w_ in ks if int(hashlib.md5(repr(w_).encode()).hexdigest(), 16) % 2 == 0}
        A_ = np.array([w_ in half for w_ in who])
        ka = shrink(iso(X[A_], Y[A_], nb))
        mp = lambda q: float(np.interp(q, [0] + [k_[0] for k_ in ka] + [1], [0] + [k_[1] for k_ in ka] + [1]))
        rows = []
        for lo_, hi_ in ((.5, .6), (.6, .7), (.7, .8), (.8, .9), (.9, .985)):
            sel = (~A_) & (X >= lo_) & (X < hi_)
            if sel.sum() >= 30:
                rows.append({'lo': lo_, 'hi': hi_, 'n': int(sel.sum()), 'priced': round(float(X[sel].mean()), 3), 'actual': round(float(Y[sel].mean()), 3),
                             'calibrated': round(float(np.mean([mp(q) for q in X[sel]])), 3)})
        check[st] = rows
    return out, check


def sd_model(lines_games, stat, active):
    """sd of a player's game yards against his mean (players with 5+ games): sd = a + b x mean"""
    X, Y = [], []
    for gl in lines_games:
        v = [p.get(stat, 0) for _, p in gl if active(p)]
        if len(v) >= 5:
            X.append(np.mean(v))
            Y.append(np.std(v, ddof=1))
    if len(X) < 20:
        return None
    b, a = np.polyfit(X, Y, 1)
    return {'a': round(float(a), 2), 'b': round(float(b), 3), 'n': len(X)}


out = {'updated': NOW.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'ESPN box scores (site.api.espn.com), this season', 'method':
       'each leg lands when the player beats his own median that game (touchdown / goal: scores); correlation of a normal copula matching the joint rate; 95% range from a bootstrap over players; reliable when the range excludes 0 and n >= 150',
       'sports': {}}
try:
    old = json.load(open(OUT))
except (OSError, ValueError):
    old = {}
feed_games = []
try:
    feed_games = json.load(open(FEED)).get('games', [])
except (OSError, ValueError):
    pass
players_out = []
for sp in SPORTS:
    try:
        G = load_games(sp)
    except Exception as e:  # noqa: BLE001
        print(f'{sp}: failed ({e}); keeping the previous figures')
        if sp in old.get('sports', {}):
            out['sports'][sp] = old['sports'][sp]
        continue
    if not G:
        continue
    if sp in ('nfl', 'ncaaf'):
        if sp == 'nfl':
            posf = nfl_positions(G)
            nfl_games, nfl_pos = G, posf
            pos_of = lambda k, ps: (lambda q: q if q in ('QB', 'RB', 'WR', 'TE') else ('RB' if q == 'FB' else None))(posf(k[0], k[1]))
        else:
            pos_of = lambda k, ps: guess_pos(ps)
        pairs, lines, tmed = football(G, sp, pos_of)
        L = logs(G)
        sd = {st: sd_model([gl for k, gl in L.items() if (lines.get(k) or {}).get('pos') in YPOS[st]], st, YACT[st]) for st in ('ryd', 'recyd', 'pyd')}
        sd = {k: v for k, v in sd.items() if v}
        calib, ccheck = yards_calib(G, lines, sd, sp)
        out['sports'][sp] = {'games': len(G), 'playerGames': sum(len(g['players']) for g in G), 'totalMedian': tmed, 'pairs': pairs, 'sd': sd, 'calib': calib, 'calibCheck': ccheck}
        # players on teams in the feed's upcoming games
        up = [g for g in feed_games if g.get('sport') == sp and g.get('status') != 'closed' and datetime.fromisoformat(g['start'].replace('Z', '+00:00')) <= NOW + timedelta(days=8)]
        # the feed's teams -> ESPN's abbreviations, by abbreviation or by name (the feed's 'LA' is ESPN's 'LAR', and so on)
        T = get(f"{API}{PATH[sp]}/teams?limit=1000") or {}
        et = [t['team'] for lg in T.get('sports', [{}])[0].get('leagues', []) for t in lg.get('teams', [])]
        seen_ab = {ab for g in G for ab in g['teams']}

        def espn_ab(name, ab):
            if ab in seen_ab:
                return ab
            n = nk(name)
            for t in et:
                if t.get('abbreviation') in seen_ab and n in (nk(t.get('displayName')), nk(f"{t.get('location')} {t.get('name')}")):
                    return t['abbreviation']
            for t in et:  # 'Ohio State Buckeyes' vs location 'Ohio State'
                if t.get('abbreviation') in seen_ab and nk(t.get('location')) and n.startswith(nk(t.get('location'))) and len(nk(t.get('location'))) >= 5:
                    return t['abbreviation']
            return None
        for g in up:
            for side in ('home', 'away'):
                ab = espn_ab(g[side]['name'], g[side]['abbr'])
                if not ab:
                    continue
                pl = []
                for k, gl in L.items():
                    if k[0] != ab or k not in lines:  # ab is ESPN's; the file keeps the feed's abbreviation
                        continue
                    gl = sorted(gl, key=lambda x: x[0]['date'])
                    ps = [p for _, p in gl]
                    pl.append({'name': k[1], 'pos': lines[k]['pos'], 'gp': len(ps), 'dates': [x[0]['date'] for x in gl],
                               'ryd': [p.get('ryd', 0) for p in ps], 'ra': [p.get('ra', 0) for p in ps], 'rtd': [p.get('rtd', 0) for p in ps],
                               'rec': [p.get('rec', 0) for p in ps], 'recyd': [p.get('recyd', 0) for p in ps], 'ctd': [p.get('ctd', 0) for p in ps], 'tgt': [p.get('tgt', 0) for p in ps],
                               'pyd': [p.get('pyd', 0) for p in ps], 'pa': [p.get('pa', 0) for p in ps], 'ptd': [p.get('ptd', 0) for p in ps]})
                fab = g[side]['abbr']
                if pl and not any(t['sport'] == sp and t['feedAbbr'] == fab for t in players_out):
                    players_out.append({'sport': sp, 'feedAbbr': fab, 'espnAbbr': ab, 'name': g[side]['name'], 'players': pl})
    elif sp == 'nba':
        out['sports'][sp] = {'games': len(G), 'pairs': basketball(G)}
    elif sp == 'nhl':
        out['sports'][sp] = {'games': len(G), 'pairs': hockey(G)}
    elif sp == 'soccer':
        out['sports'][sp] = {'games': len(G), 'pairs': soccer(G)}
for sp, v in old.get('sports', {}).items():
    out['sports'].setdefault(sp, v)
# Holm's correction across every pair measured in this run: a link is "reliable" only if it survives it, has 150+
# player-games and is at least 0.05 in size
allp = sorted([(m['p'], sp, k) for sp in SPORTS if sp in out['sports'] for k, m in out['sports'][sp]['pairs'].items() if 'p' in m])
run, alive = 0.0, True
for i, (pv, sp, k) in enumerate(allp):
    run = max(run, min(1.0, pv * (len(allp) - i)))
    m = out['sports'][sp]['pairs'][k]
    m['pHolm'] = round(run, 5)
    alive = alive and run < 0.05
    m['reliable'] = bool(alive and m['n'] >= 150 and abs(m['rho']) >= 0.05)
    m['p'] = round(m['p'], 6)
out['method'] = ('each leg lands when the player beats his own median that game (touchdown / goal: scores); joint rate within players; '
                 'normal-copula correlation; bootstrap over players; reliable when it survives Holm across all pairs, n >= 150 and |link| >= 0.05')
# firsttd.json: this season's rushing / receiving touchdowns per team and player, for every NFL team in the feed
if 'nfl' in SPORTS and 'nfl_games' in globals():
    try:
        ft = json.load(open('firsttd.json'))
    except (OSError, ValueError):
        ft = {'status': {}, 'teams': {}}
    T = get(f"{API}football/nfl/teams?limit=100") or {}
    et = [t['team'] for lg in T.get('sports', [{}])[0].get('leagues', []) for t in lg.get('teams', [])]
    by_name = {nk(t.get('displayName')): t.get('abbreviation') for t in et}
    feed_ab = {}
    for g in feed_games:
        if g.get('sport') != 'nfl':
            continue
        for side in ('home', 'away'):
            ea = g[side]['abbr'] if any(g[side]['abbr'] in x['teams'] for x in nfl_games[:40]) else by_name.get(nk(g[side]['name']))
            if ea:
                feed_ab[ea] = g[side]['abbr']
    teams = {}
    for ea, fa in feed_ab.items():
        gl = [g for g in nfl_games if ea in g['teams']]
        if not gl:
            continue
        P = defaultdict(lambda: {'gp': 0, 'rush': 0, 'rec': 0, 'touch': 0})
        for g in gl:
            for p in g['players']:
                if p['team'] != ea:
                    continue
                x = P[p['name']]
                x['gp'] += 1
                x['rush'] += int(p.get('rtd', 0))
                x['rec'] += int(p.get('ctd', 0))
                x['touch'] += p.get('ra', 0) + p.get('tgt', 0)
        pl = [{'name': n, 'pos': nfl_pos(ea, n), 'gp': x['gp'], 'rush': x['rush'], 'rec': x['rec']} for n, x in P.items() if x['rush'] + x['rec'] > 0 or x['touch'] >= 15]
        pl.sort(key=lambda q: -(q['rush'] + q['rec']))
        teams[fa] = {'gp': len(gl), 'rush': sum(q['rush'] for q in pl), 'rec': sum(q['rec'] for q in pl), 'players': pl}
    if teams:
        ft['teams'] = {**ft.get('teams', {}), **teams}
        ft.update({'updated': out['updated'], 'season': 2026, 'source': 'ESPN box scores (site.api.espn.com), this season: rushing + receiving touchdowns by player',
                   'sourceUrl': 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'})
        json.dump(ft, open('firsttd.json', 'w'), ensure_ascii=False, separators=(',', ':'))
        print(f'firsttd.json: {len(teams)} NFL teams refreshed from box scores ({len(ft["teams"])} in the file)')
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
if players_out:
    try:  # keep the teams of sports this run did not cover
        players_out += [t for t in json.load(open(PLAYERS)).get('teams', []) if t.get('sport') not in SPORTS]
    except (OSError, ValueError):
        pass
    json.dump({'updated': out['updated'], 'source': 'ESPN box scores, this season', 'teams': players_out}, open(PLAYERS, 'w'), ensure_ascii=False, separators=(',', ':'))
for sp, v in out['sports'].items():
    print(f"== {sp}: {v['games']} games")
    for k, m in sorted(v['pairs'].items(), key=lambda x: -abs(x[1]['rho'])):
        print(f"   {k:16} n {m['n']:5} rho {m['rho']:+.2f} [{m['lo']}, {m['hi']}] lift {m['lift']}  P(B|A) {m['pBgivenA']} vs {m['pB']}  holm {m.get('pHolm')}  {'RELIABLE' if m['reliable'] else ''}")
    if v.get('sd'):
        print('   sd model:', v['sd'])
    for st, rows in (v.get('calibCheck') or {}).items():
        print(f'   yards calibration {st} (held-out players):', ', '.join(f"{r['priced']:.2f}->{r['actual']:.2f} now {r['calibrated']:.2f} (n {r['n']})" for r in rows))
print(f'wrote {OUT}' + (f' and {PLAYERS} ({sum(len(t["players"]) for t in players_out)} players on {len(players_out)} teams)' if players_out else ''))
