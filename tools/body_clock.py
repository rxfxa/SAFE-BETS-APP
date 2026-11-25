#!/usr/bin/env python3
"""Body Clock tab (bodyclock.js): rebuilds bodyclock.json every morning, live, for whatever games are coming up.

    python3 -I tools/body_clock.py [--out bodyclock.json] [--cache .work/espn]

The tab tests an Instagram reel's claim: back the West Coast team in night games against an East Coast team. The rule as
applied here: a Pacific-time team (NFL LAR LAC SF SEA LV; NBA LAL LAC GS SAC POR) against an Eastern-time team, kicking off
at 8 PM ET or later. Arizona is not Pacific. Keys (bodyclock.js reads them; same shapes as the first, hand-built file):
  research    tools/bodyclock_research.json copied verbatim (the static study block).
  upcoming    {from, to, notes, games}: NFL night games (8 PM ET or later) in the next 8 days, plus Pacific vs Eastern night
              games for the rest of the regular season; NBA games in the next 8 days whose home zones are 2+ hours apart,
              plus the next 4 Pacific vs Eastern games within 30 days; soccer (usa.1, mex.1, uefa.champions, uefa.europa,
              uefa.europa.conf, afc.champions, aus.1) in the next 8 days with clubs' home zones 2+ hours apart. Odds: ESPN
              summary pickcenter (DraftKings) for NFL / NBA games in the next 8 days; soccer from the scoreboard's 3-way
              price, margin removed.
  season2026  Pacific vs Eastern NFL night games already played this season: the West team's closing line, ATS result.
  mnf         the next NFL game on a Monday (US Eastern date) at 7 PM ET or later, or null: market (open and now, margin
              removed), ESPN predictor, Polymarket (polymarket.json, strict match), weather, last meeting, head-to-head
              (3 seasons), both teams' splits vs closing lines, injuries (game summary + team roster), this season's Monday
              nights, and facts / watch / stakes sentences written from those numbers only.
  lastMnf     the most recent finished Monday night game: final, last score, quarters, line and result, players vs their
              season average (season.json logs before the game), a season-wide lesson from season.json, the app's legs on
              the game (recs.json; null when none) and the ESPN recap link.
  updated     ISO UTC.
Sources: site.api.espn.com only (scoreboards by month, game summaries, team schedules, team rosters, soccer team records);
repo files season.json (NFL game logs), data.json (app feed: second source for the last final), polymarket.json, recs.json.
Finished games' summaries are cached in .work/espn/<id>.json (only games that are not final are fetched again); past
seasons' schedules and soccer clubs' leagues are cached there too. Requests are sequential, with timeouts and up to 3 tries.
A section that fails keeps its value from the existing bodyclock.json (with a warning); an upcoming sport that fails keeps
its old games that have not started. The file is written to a temp file and renamed. Exit 1 only if nothing could be built.

Morning run (7:32 AM PT): after tools/leg_pairs.py and tools/season_tables.py (fresh season.json); polymarket.json comes from
the 3:47 AM run. Then publish bodyclock.json with the app.
"""
import json, math, os, re, statistics, sys, time, urllib.error, urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else d
rp = lambda p: p if os.path.isabs(p) else os.path.join(REPO, p)
OUT, CACHE = rp(opt('--out', 'bodyclock.json')), rp(opt('--cache', '.work/espn'))
RESEARCH, SEASON, FEED, POLY, RECS = (rp(p) for p in ('tools/bodyclock_research.json', 'season.json', 'data.json', 'polymarket.json', 'recs.json'))
NOW = datetime.now(timezone.utc)
UTC, ET = timezone.utc, ZoneInfo('America/New_York')
API = 'https://site.api.espn.com/apis/site/v2/sports/'
NFLP, NBAP = 'football/nfl', 'basketball/nba'
STATS, WARN = Counter(), []


def warn(msg):
    WARN.append(msg)
    print('WARNING:', msg, file=sys.stderr)


# ---------------------------------------------------------------- network + cache
_last = [0.0]
_down = [0]  # consecutive failed URLs; after 5 the network is taken as down and the rest fail fast


def get(url, timeout=30):
    if _down[0] >= 5:
        STATS['failed'] += 1
        return None
    for i in range(4):  # the first try and up to 3 retries
        wait = 0.25 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=timeout) as r:
                d = json.loads(r.read().decode())
                STATS['fetched'] += 1
                _down[0] = 0
                return d
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):  # a definite answer: no retry
                STATS['failed'] += 1
                return None
        except Exception:  # noqa: BLE001 (timeouts, resets, bad JSON: retry)
            pass
        if i < 3:
            time.sleep(1.5 * (i + 1))
    STATS['failed'] += 1
    _down[0] += 1
    if _down[0] == 5:
        warn('5 requests in a row failed: treating the network as down for the rest of this run')
    return None


def jload(fn):
    try:
        with open(fn) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def jsave(fn, d):
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    tmp = fn + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(tmp, fn)


KEEP = ('header', 'pickcenter', 'boxscore', 'gameInfo', 'scoringPlays', 'drives', 'article', 'injuries', 'predictor', 'standings')
_mem = {}


def summary(path, eid):
    """ESPN game summary; a finished game's (slimmed) summary is cached in .work/espn/<id>.json and never fetched again."""
    if eid in _mem:
        return _mem[eid]
    fn = os.path.join(CACHE, f'{eid}.json')
    d = jload(fn)
    if d:
        STATS['cached'] += 1
    else:
        d = get(f'{API}{path}/summary?event={eid}')
        if d:
            d = {k: d[k] for k in KEEP if k in d}
            if 'drives' in d:  # only what the last-score line needs
                d['drives'] = {'previous': [{'description': dr.get('description'), 'isScore': dr.get('isScore'), 'displayResult': dr.get('displayResult'),
                                             'end': {'period': nested(dr, 'end', 'period')}, 'team': {'abbreviation': nested(dr, 'team', 'abbreviation')}}
                                            for dr in (d['drives'].get('previous') or [])]}
            if 'boxscore' in d:  # team totals only (player lines come from season.json)
                d['boxscore'] = {'teams': [{'team': {'abbreviation': nested(t, 'team', 'abbreviation')}, 'statistics': t.get('statistics') or []}
                                           for t in d['boxscore'].get('teams') or []]}
            if 'article' in d:
                d['article'] = {k: d['article'].get(k) for k in ('headline', 'published', 'links')}
            st = (((d.get('header') or {}).get('competitions') or [{}])[0].get('status') or {}).get('type') or {}
            if st.get('completed'):
                jsave(fn, d)
    _mem[eid] = d
    return d


def cached_get(url, name):
    """For data that never changes (past seasons' schedules, a club's home league): fetched once, kept in .work/espn."""
    fn = os.path.join(CACHE, name)
    d = jload(fn)
    if d is None:
        d = get(url)
        if d is not None:
            jsave(fn, d)
    else:
        STATS['cached'] += 1
    return d


# ---------------------------------------------------------------- small helpers
def P(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(UTC)


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%MZ')


def etd(t):
    return t.astimezone(ET).date()


def off(tz, t):
    return t.astimezone(ZoneInfo(tz)).utcoffset().total_seconds() / 3600


def clock(t, tz):
    return t.astimezone(ZoneInfo(tz)).strftime('%-I:%M %p')


def num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip().lower().lstrip('ou')
    if s in ('even', 'ev'):
        return 100.0
    if s in ('pk', 'pick', "pick'em"):
        return 0.0
    try:
        return float(s.replace('+', ''))
    except ValueError:
        return None


def mli(x):
    v = num(x)
    return None if v is None else int(round(v))


def imp(ml):
    ml = float(ml)
    return 100 / (ml + 100) if ml > 0 else -ml / (-ml + 100)


def novig(*mls):
    if any(m is None for m in mls):
        return None
    ps = [imp(m) for m in mls]
    s = sum(ps)
    return [round(p / s, 3) for p in ps]


fl = lambda x: f'{x:g}'
sgn = lambda x: 'PK' if x == 0 else f'{x:+g}'
mls = lambda x: f'{x:+d}' if x is not None else '?'
mday = lambda d: f"{d:%b} {d.day}"
hrs = lambda g: f'{g:g}'


def rec(w, l, t=0):
    return f'{w}-{l}' + (f'-{t}' if t else '')


def nested(d, *ks):
    for k in ks:
        d = (d or {}).get(k) if isinstance(d, dict) else None
    return d


def join(xs):
    xs = list(xs)
    return xs[0] if len(xs) == 1 else ', '.join(xs[:-1]) + ' and ' + xs[-1] if xs else ''


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


# ---------------------------------------------------------------- zones
ZTZ = {'Pacific': 'America/Los_Angeles', 'Mountain': 'America/Denver', 'Central': 'America/Chicago', 'Eastern': 'America/New_York'}
NFL_ZONE = {**{k: 'Pacific' for k in ('LAR', 'LAC', 'SF', 'SEA', 'LV')}, 'DEN': 'Mountain', 'ARI': 'Mountain',
            **{k: 'Central' for k in ('KC', 'DAL', 'HOU', 'CHI', 'GB', 'MIN', 'NO', 'TEN')},
            **{k: 'Eastern' for k in ('BUF', 'MIA', 'NE', 'NYJ', 'BAL', 'CIN', 'CLE', 'PIT', 'IND', 'JAX', 'NYG', 'PHI', 'WSH', 'DET', 'ATL', 'CAR', 'TB')}}
NBA_ZONE = {**{k: 'Pacific' for k in ('LAL', 'LAC', 'GS', 'SAC', 'POR')}, 'DEN': 'Mountain', 'UTAH': 'Mountain', 'PHX': 'Mountain',
            **{k: 'Central' for k in ('CHI', 'DAL', 'HOU', 'MEM', 'MIL', 'MIN', 'NO', 'OKC', 'SA')},
            **{k: 'Eastern' for k in ('ATL', 'BOS', 'BKN', 'CHA', 'CLE', 'DET', 'IND', 'MIA', 'NY', 'ORL', 'PHI', 'TOR', 'WSH')}}
ARIZONA = {('nfl', 'ARI'), ('nba', 'PHX')}  # Mountain Standard all year (no DST); never Pacific


def ztz(sport, ab, zone):
    return 'America/Phoenix' if (sport, ab) in ARIZONA else ZTZ[zone]


def team(ab, zone, tz, name=None, record=None):
    return {'abbr': ab, 'name': name or ab, 'zone': zone, 'tz': tz, **({'record': record} if record else {})}


# ESPN abbreviations vs the app feed / recs.json / polymarket.json (Sportradar style)
ALIAS = {'WAS': 'WSH', 'LA': 'LAR', 'JAC': 'JAX'}
al = lambda ab: ALIAS.get(ab, ab)


# ---------------------------------------------------------------- ESPN rows
def score(x):
    s = x.get('score')
    if isinstance(s, dict):
        s = s.get('value', s.get('displayValue'))
    return num(s)


def ev_row(e):
    c = (e.get('competitions') or [{}])[0]
    T = {x.get('homeAway'): x for x in c.get('competitors') or []}
    if 'home' not in T or 'away' not in T:
        return None
    st = (c.get('status') or e.get('status') or {}).get('type') or {}
    v = c.get('venue') or {}
    a = v.get('address') or {}
    tm = lambda s: T[s].get('team') or {}
    rc = lambda s: next((r.get('summary') for r in T[s].get('records') or [] if r.get('type') == 'total' or r.get('name') == 'overall'), None)
    return {'id': e['id'], 't': P(e['date']), 'week': (e.get('week') or {}).get('number'), 'short': e.get('shortName'),
            'home': tm('home').get('abbreviation'), 'away': tm('away').get('abbreviation'), 'hid': str(tm('home').get('id')), 'aid': str(tm('away').get('id')),
            'hname': tm('home').get('displayName'), 'aname': tm('away').get('displayName'),
            'hloc': tm('home').get('location') or tm('home').get('displayName'), 'aloc': tm('away').get('location') or tm('away').get('displayName'),
            'hnick': tm('home').get('name'), 'anick': tm('away').get('name'),
            'hs': score(T['home']), 'as': score(T['away']), 'state': st.get('state'), 'completed': bool(st.get('completed')),
            'timeValid': c.get('timeValid', True) is not False, 'neutral': bool(c.get('neutralSite')),
            'venue': v.get('fullName'), 'city': a.get('city'), 'region': a.get('state'), 'country': a.get('country'), 'indoor': v.get('indoor'),
            'tv': [n for b in c.get('broadcasts') or [] for n in b.get('names') or []], 'hrec': rc('home'), 'arec': rc('away'),
            'notes': [n.get('headline') for n in c.get('notes') or [] if n.get('headline')], 'odds': c.get('odds'), 'c': c}


def loc(r, side):
    """Short place name for sentences; the team nickname where a city has two teams."""
    l = r[side[0] + 'loc']
    return r[side[0] + 'nick'] if l in ('Los Angeles', 'New York', 'LA') else l


def lines(summ):
    """The book's line from a game summary (pickcenter[0]); for a finished game ESPN's last price, treated as the close."""
    pc = ((summ or {}).get('pickcenter') or [None])[0]
    if not pc:
        return None
    hs = num(pc.get('spread'))
    if hs is None:
        hs = num(nested(pc, 'pointSpread', 'home', 'close', 'line'))
    tot = num(pc.get('overUnder'))
    if tot is None:
        tot = num(nested(pc, 'total', 'over', 'close', 'line'))
    hml = mli(nested(pc, 'homeTeamOdds', 'moneyLine'))
    hml = hml if hml is not None else mli(nested(pc, 'moneyline', 'home', 'close', 'odds'))
    aml = mli(nested(pc, 'awayTeamOdds', 'moneyLine'))
    aml = aml if aml is not None else mli(nested(pc, 'moneyline', 'away', 'close', 'odds'))
    if hs is None and tot is None and hml is None:
        return None
    return {'book': nested(pc, 'provider', 'name') or 'DraftKings', 'details': pc.get('details'), 'hs': hs, 'tot': tot, 'hml': hml, 'aml': aml,
            'hs_open': num(nested(pc, 'pointSpread', 'home', 'open', 'line')), 'tot_open': num(nested(pc, 'total', 'over', 'open', 'line')),
            'hml_open': mli(nested(pc, 'moneyline', 'home', 'open', 'odds')), 'aml_open': mli(nested(pc, 'moneyline', 'away', 'open', 'odds')),
            'hso': mli(nested(pc, 'homeTeamOdds', 'spreadOdds')), 'aso': mli(nested(pc, 'awayTeamOdds', 'spreadOdds'))}


def odds_obj(L, home):
    if not L:
        return None
    nv = novig(L['hml'], L['aml']) or [None, None]
    det = L['details'] or (f"{home} {sgn(L['hs'])}" if L['hs'] is not None else 'no spread')
    return {'text': f"{det} · total {fl(L['tot']) if L['tot'] is not None else 'n/a'}", 'book': L['book'], 'homeSpread': L['hs'], 'total': L['tot'],
            'homeML': L['hml'], 'awayML': L['aml'], 'noVig': {'home': nv[0], 'away': nv[1]}}


def window():
    f = NOW.astimezone(ET).date()
    return f, f + timedelta(days=7)


# ================================================================ NFL
def nfl_rows():
    d = get(API + NFLP + '/scoreboard')
    Y = nested(d, 'season', 'year') or (NOW.year if NOW.month >= 3 else NOW.year - 1)
    rows = {}
    for ym in (f'{Y}09', f'{Y}10', f'{Y}11', f'{Y}12', f'{Y + 1}01'):
        sb = get(f'{API}{NFLP}/scoreboard?dates={ym}&limit=1000')
        if sb is None:
            raise RuntimeError(f'NFL scoreboard {ym} could not be fetched')
        for e in sb.get('events') or []:
            s = e.get('season') or {}
            if s.get('type') == 2 and s.get('year') == Y:
                r = ev_row(e)
                if r and r['home'] in NFL_ZONE and r['away'] in NFL_ZONE:
                    rows[r['id']] = r
    if not rows:
        raise RuntimeError('no NFL games found')
    return Y, sorted(rows.values(), key=lambda r: r['t'])


def slot(t):
    d = etd(t)
    if d.month == 11 and d.weekday() == 3 and 22 <= d.day <= 28:
        return 'Thanksgiving night'
    return {(12, 24): 'Christmas Eve night', (12, 25): 'Christmas night', (12, 31): "New Year's Eve night"}.get((d.month, d.day), f'{d:%A} night')


def is_pe(za, zh):
    return {za, zh} == {'Pacific', 'Eastern'}


def nfl_upcoming(rows):
    f, to = window()
    games, tbd = [], []
    for r in rows:
        if r['state'] == 'post' or etd(r['t']) < f:
            continue
        za, zh = NFL_ZONE[r['away']], NFL_ZONE[r['home']]
        pe = is_pe(za, zh)
        if not r['timeValid']:
            tbd.append((r, pe))
            continue
        k = r['t'].astimezone(ET)
        if k.hour < 20:
            continue
        near = etd(r['t']) <= to
        if not near and not pe:
            continue
        L = lines(summary(NFLP, r['id'])) if near else None
        g = {'sport': 'nfl', 'espnId': r['id'], 'label': r['short'], 'slot': slot(r['t']), 'kickoffUTC': iso(r['t']),
             'away': team(r['away'], za, ztz('nfl', r['away'], za), record=r['arec']), 'home': team(r['home'], zh, ztz('nfl', r['home'], zh), record=r['hrec']),
             'venue': ', '.join(x for x in (r['city'], r['region']) if x), 'applies': pe,
             'why': (f"{za} ({r['away']}) vs {zh} ({r['home']}): the rule covers only a Pacific-zone team against an Eastern-zone team" if not pe else ''),
             'odds': odds_obj(L, r['home'])}
        if pe:
            west = r['home'] if zh == 'Pacific' else r['away']
            east = r['away'] if west == r['home'] else r['home']
            g['why'] = f"{west} (Pacific) vs {east} (Eastern), night kickoff: the reel's rule backs {west}."
            g['west'] = west
            g['westLine'] = None if not L or L['hs'] is None else (L['hs'] if west == r['home'] else -L['hs'])
        games.append(g)
    return games, tbd


def ats_word(x):
    return 'covered' if x > 0 else 'did not cover' if x < 0 else 'push'


def nfl_season_so_far(rows):
    out = []
    for r in rows:
        if not r['completed'] or not r['timeValid'] or r['t'].astimezone(ET).hour < 20:
            continue
        za, zh = NFL_ZONE[r['away']], NFL_ZONE[r['home']]
        if not is_pe(za, zh):
            continue
        L = lines(summary(NFLP, r['id']))
        west = r['home'] if zh == 'Pacific' else r['away']
        mw = (r['hs'] - r['as']) if west == r['home'] else (r['as'] - r['hs'])
        sw = None if not L or L['hs'] is None else (L['hs'] if west == r['home'] else -L['hs'])
        out.append({'label': r['short'], 'date': r['t'].astimezone(ET).strftime('%a %b %-d, %-I:%M %p ET'), 'west': west,
                    'final': f"{r['away']} {int(r['as'])} - {r['home']} {int(r['hs'])}", 'line': sw,
                    'ats': None if sw is None else ats_word(mw + sw)})
    return out


# ---------------------------------------------------------------- Monday night helpers
def monday_night(r):
    k = r['t'].astimezone(ET)
    return r['timeValid'] and k.weekday() == 0 and k.hour >= 19


def team_games(rows, ab):
    out = []
    for r in rows:
        if not r['completed'] or ab not in (r['home'], r['away']) or r['hs'] is None:
            continue
        home = r['home'] == ab
        pf, pa = (r['hs'], r['as']) if home else (r['as'], r['hs'])
        L = lines(summary(NFLP, r['id']))
        sp = None if not L or L['hs'] is None else (L['hs'] if home else -L['hs'])
        tot = L['tot'] if L else None
        out.append({'date': r['t'].strftime('%Y-%m-%d'), 'opp': r['away'] if home else r['home'], 'home': home, 'pf': int(pf), 'pa': int(pa),
                    'res': 'W' if pf > pa else 'L' if pf < pa else 'T', 'spread': sp, 'total': tot,
                    'ats': None if sp is None else ('W' if pf - pa + sp > 0 else 'L' if pf - pa + sp < 0 else 'P'),
                    'ou': None if tot is None else ('O' if pf + pa > tot else 'U' if pf + pa < tot else 'P'), '_t': r['t']})
    return out


def split(gs):
    c = Counter(g['res'] for g in gs)
    a = Counter(g['ats'] for g in gs if g['ats'])
    o = Counter(g['ou'] for g in gs if g['ou'])
    k = len(gs)
    mean = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    return {'n': k, 'su': rec(c['W'], c['L'], c['T']), 'ats': rec(a['W'], a['L'], a['P']), 'ou': rec(o['O'], o['U'], o['P']),
            'pf': mean([g['pf'] for g in gs]), 'pa': mean([g['pa'] for g in gs]), 'tot': mean([g['pf'] + g['pa'] for g in gs]),
            'line': mean([g['total'] for g in gs if g['total'] is not None])}


def bye_week(rows, ab):
    weeks = {r['week'] for r in rows if ab in (r['home'], r['away']) and r['week']}
    if not weeks:
        return None
    missing = [w for w in range(1, max(weeks) + 1) if w not in weeks]
    return missing[0] if len(missing) == 1 else None


def h2h_games(rows, Y, r):
    """Meetings of the two teams in the last 3 regular seasons (ESPN team schedules; past seasons cached)."""
    A, H, aid, hid = r['away'], r['home'], r['aid'], r['hid']
    games = []
    for y in (Y - 2, Y - 1):
        sd = cached_get(f'{API}{NFLP}/teams/{hid}/schedule?season={y}', f'sched_nfl_{hid}_{y}.json') or {}
        for e in sd.get('events') or []:
            x = ev_row(e)
            if x and x['completed'] and {x['hid'], x['aid']} == {hid, aid}:
                games.append(x)
    games += [x for x in rows if x['completed'] and {x['hid'], x['aid']} == {hid, aid}]
    games.sort(key=lambda x: x['t'])
    out = []
    for x in games:
        L = lines(summary(NFLP, x['id']))
        hsp, tot = (L['hs'], L['tot']) if L else (None, None)
        cov = None if hsp is None else (x['home'] if x['hs'] - x['as'] + hsp > 0 else x['away'] if x['hs'] - x['as'] + hsp < 0 else 'push')
        T = x['hs'] + x['as']
        out.append({'date': x['t'].strftime('%Y-%m-%d'), 'away': x['away'], 'home': x['home'], 'score': f"{x['away']} {int(x['as'])} - {x['home']} {int(x['hs'])}",
                    'line': (L['details'] if L and hsp is not None else None), 'cover': cov,
                    'ou': None if tot is None else ('O' if T > tot else 'U' if T < tot else 'P'), '_x': x, '_L': L})
    return out


def result_text(L, x, lc):
    """'Tampa Bay won outright as a 3-point underdog; 56 points went 11.5 over the 44.5 total.' from a finished game."""
    hs, as_ = x['hs'], x['as']
    win = 'home' if hs > as_ else 'away' if as_ > hs else None
    m = int(abs(hs - as_))
    hsp = L['hs'] if L else None
    if win is None:
        s = f"It ended in a {int(hs)}-{int(as_)} tie"
    elif hsp is None:
        s = f"{lc[win]} won by {m}"
    elif hsp == 0:
        s = f"{lc[win]} won by {m} in a pick'em"
    else:
        fav = 'home' if hsp < 0 else 'away'
        n = abs(hsp)
        cov = (hs - as_ + hsp) * (1 if fav == 'home' else -1)
        if win != fav:
            s = f"{lc[win]} won outright as a {fl(n)}-point underdog"
        elif cov > 0:
            s = f"{lc[fav]} won by {m} and covered the {fl(n)}-point spread"
        elif cov == 0:
            s = f"{lc[fav]} won by {m}, exactly the {fl(n)}-point spread (a push)"
        else:
            s = f"{lc[fav]} won by {m} but did not cover the {fl(n)}-point spread"
    T, tl = int(hs + as_), (L['tot'] if L else None)
    if tl is None:
        return s + '.'
    d = T - tl
    return s + (f"; {T} points went {fl(abs(d))} {'over' if d > 0 else 'under'} the {fl(tl)} total." if d else f"; {T} points landed on the total (a push).")


def last_meeting(m, r):
    x, L = m['_x'], m['_L']
    s = summary(NFLP, x['id']) or {}
    lc = {'home': loc(x, 'home'), 'away': loc(x, 'away')}
    q = {}
    for c in nested(s, 'header', 'competitions')[0]['competitors'] if nested(s, 'header', 'competitions') else []:
        q[c['team']['abbreviation']] = [int(num(l.get('displayValue')) or 0) for l in c.get('linescores') or []]
    ts = {t['team']['abbreviation']: {st['name']: st.get('displayValue') for st in t.get('statistics') or []} for t in nested(s, 'boxscore', 'teams') or []}
    A, H = r['away'], r['home']
    rows_ = [('rushingYards', 'Rushing yards'), ('rushingAttempts', 'Carries'), ('netPassingYards', 'Passing yards'), ('turnovers', 'Turnovers'),
             ('sacksYardsLost', 'Sacked (yards lost)'), ('possessionTime', 'Time of possession'), ('thirdDownEff', 'Third downs')]
    stats = [[lbl, (ts.get(A) or {}).get(k), (ts.get(H) or {}).get(k)] for k, lbl in rows_] if ts.get(A) and ts.get(H) else []
    win = x['home'] if x['hs'] > x['as'] else x['away']
    lose = x['away'] if win == x['home'] else x['home']
    wl = {x['home']: lc['home'], x['away']: lc['away']}
    notes = []
    if ts.get(win):
        w = ts[win]
        ca = re.split(r'[-/]', w.get('completionAttempts') or '')
        notes.append(f"{wl[win]} ran {w.get('rushingAttempts')} times for {w.get('rushingYards')} yards and threw {ca[1] if len(ca) > 1 else '?'} passes"
                     f" ({w.get('netPassingYards')} net passing yards).")
    worst = max((t for t in (win, lose) if ts.get(t)), key=lambda t: num(ts[t].get('turnovers')) or 0, default=None)
    if worst and (num(ts[worst].get('turnovers')) or 0) > 0:
        t = ts[worst]
        sk = (t.get('sacksYardsLost') or '').split('-')[0]
        notes.append(f"{wl[worst]} lost {fl(num(t.get('turnovers')))} turnovers ({t.get('fumblesLost', '?')} fumbles, {t.get('interceptions', '?')} interceptions)"
                     + (f" and was sacked {sk} times." if sk and sk != '0' else '.'))
    sc_ = {x['home']: int(x['hs']), x['away']: int(x['as'])}
    return {'date': str(etd(x['t'])), 'where': x['city'] or '', 'final': f"{win} {sc_[win]}, {lose} {sc_[lose]}", 'quarters': q,
            'line': (f"{L['details']} · total {fl(L['tot'])}" if L and L['details'] and L['tot'] is not None else None),
            'result': result_text(L, x, lc), 'stats': stats, 'notes': notes}


def injuries(summ, r):
    """ESPN game summary's injuries (its 'most relevant' per team), then the team roster's other injured players."""
    out = {'away': [], 'home': []}
    side = {r['away']: 'away', r['home']: 'home'}
    for t in (summ or {}).get('injuries') or []:
        s = side.get(nested(t, 'team', 'abbreviation'))
        if not s:
            continue
        for i in t.get('injuries') or []:
            a = i.get('athlete') or {}
            out[s].append({'name': a.get('displayName'), 'pos': nested(a, 'position', 'abbreviation'), 'status': i.get('status'),
                           'injury': nested(i, 'details', 'type') or ''})
    from_summary = {s: len(v) for s, v in out.items()}
    sev = {'Out': 0, 'Doubtful': 1, 'Questionable': 2, 'Injured Reserve': 3}
    added = 0
    for s, tid in (('away', r['aid']), ('home', r['hid'])):
        ro = get(f'{API}{NFLP}/teams/{tid}/roster')
        if not ro:
            continue
        have = {p['name'] for p in out[s]}
        extra = []
        for grp in ro.get('athletes') or []:
            for a in grp.get('items') or []:
                inj = a.get('injuries') or []
                if inj and a.get('displayName') not in have:
                    extra.append({'name': a.get('displayName'), 'pos': nested(a, 'position', 'abbreviation'), 'status': inj[0].get('status'), 'injury': ''})
        extra.sort(key=lambda p: sev.get(p['status'], 4))
        room = max(0, 12 - len(out[s]))
        out[s] += extra[:room]
        added += len(extra[:room])
    note = f"ESPN's game page lists the {max(from_summary.values()) if from_summary else 0} most relevant per team"
    note += f"; {added} more from the team rosters (status only)." if added else '.'
    out['asOf'] = str(NOW.astimezone(ET).date())
    out['note'] = note + ' Final statuses come out before kickoff.'
    return out


WX = {1: 'sunny', 2: 'mostly sunny', 3: 'partly sunny', 4: 'intermittent clouds', 5: 'hazy sunshine', 6: 'mostly cloudy', 7: 'cloudy', 8: 'dreary',
      11: 'fog', 12: 'showers', 13: 'mostly cloudy with showers', 14: 'partly sunny with showers', 15: 'thunderstorms', 16: 'mostly cloudy with thunderstorms',
      17: 'partly sunny with thunderstorms', 18: 'rain', 19: 'flurries', 20: 'mostly cloudy with flurries', 21: 'partly sunny with flurries', 22: 'snow',
      23: 'mostly cloudy with snow', 24: 'ice', 25: 'sleet', 26: 'freezing rain', 29: 'rain and snow', 30: 'hot', 31: 'cold', 32: 'windy', 33: 'clear',
      34: 'mostly clear', 35: 'partly cloudy', 36: 'intermittent clouds', 37: 'hazy moonlight', 38: 'mostly cloudy', 39: 'partly cloudy with showers',
      40: 'mostly cloudy with showers', 41: 'partly cloudy with thunderstorms', 42: 'mostly cloudy with thunderstorms', 43: 'mostly cloudy with flurries',
      44: 'mostly cloudy with snow'}
WORDS = {0: 'on game day', 1: 'one day out', 2: 'two days out', 3: 'three days out', 4: 'four days out', 5: 'five days out', 6: 'six days out', 7: 'seven days out'}


def weather(summ, r):
    w = nested(summ, 'gameInfo', 'weather')
    roof = 'Indoor stadium (ESPN venue flag): weather does not apply.' if r['indoor'] else 'Open-air stadium (ESPN venue flag).'
    if r['indoor']:
        return roof, None
    if not w:
        return 'No forecast on ESPN yet. ' + roof, None
    m = re.search(r'[?&]day=(\d+)', nested(w, 'link', 'href') or '')
    days = int(m.group(1)) if m else (etd(r['t']) - NOW.astimezone(ET).date()).days
    cond = WX.get(int(num(w.get('conditionId')) or -1))
    parts = [cond] if cond else []
    if w.get('temperature') is not None:
        parts.append(f"{fl(num(w['temperature']))}°F")
    if w.get('gust') is not None:
        parts.append(f"gusts {fl(num(w['gust']))} mph")
    if w.get('precipitation') is not None:
        parts.append(f"precipitation {fl(num(w['precipitation']))} (probably a % chance)")
    txt = f"AccuWeather forecast {WORDS.get(days, f'{days} days out')}: {', '.join(parts)}. {roof} Re-check on game day."
    return txt, {'cond': cond or '', 'precip': num(w.get('precipitation')), 'gust': num(w.get('gust')), 'temp': num(w.get('temperature'))}


def polymarket(r):
    pm = jload(POLY) or {}
    hits = []
    for g in pm.get('games') or []:
        if g.get('sport') != 'nfl' or not g.get('start'):
            continue
        if abs((P(g['start']) - r['t']).total_seconds()) > 900:
            continue
        if al(nested(g, 'home', 'abbr') or '') == r['home'] and al(nested(g, 'away', 'abbr') or '') == r['away']:
            hits.append(g)
    if len(hits) != 1 or not nested(hits[0], 'ml', 'home', 'm'):
        return None
    g = hits[0]
    v = int(round(num(nested(g, 'ml', 'v')) or 0))
    note = ('thin: ' if v < 5000 else '') + f"about ${v:,} traded on the winner market (polymarket.json, {(pm.get('updated') or '')[:16]}Z)"
    if g.get('stale'):
        note += '; marked stale'
    return {'home': nested(g, 'ml', 'home', 'm'), 'away': nested(g, 'ml', 'away', 'm'), 'volume': v, 'url': g.get('url'), 'note': note}


def standings(summ, rows):
    """[(division name, [(abbr, w, l, t), ...])] from the summary's standings block (ESPN orders the teams)."""
    ab = {}
    for r in rows:
        ab[r['hid']], ab[r['aid']] = r['home'], r['away']
    out = []
    for g in nested(summ, 'standings', 'groups') or []:
        name = re.sub(r'^\d{4}\s+|\s+Standings$', '', g.get('header') or '').strip()
        teams = []
        for e in nested(g, 'standings', 'entries') or []:
            s = {x.get('name'): x.get('value') for x in e.get('stats') or []}
            teams.append((ab.get(str(e.get('id')), e.get('team')), int(s.get('wins') or 0), int(s.get('losses') or 0), int(s.get('ties') or 0)))
        if teams:
            out.append((name, teams))
    return out


pct = lambda w, l, t: (w + t / 2) / max(1, w + l + t)


def division_line(name, teams):
    lead = [t for t in teams if pct(*t[1:]) == pct(*teams[0][1:])]
    rest = [t for t in teams if t not in lead]
    s = f"{name}: {join(t[0] for t in lead)} {'lead at' if len(lead) > 1 else 'leads at'} {rec(*lead[0][1:])}"
    groups = []
    for t in rest:
        if groups and groups[-1][1] == t[1:]:
            groups[-1][0].append(t[0])
        else:
            groups.append(([t[0]], t[1:]))
    if groups:
        s += '; ' + '; '.join(f"{join(g)} {'are' if len(g) > 1 else 'is'} {rec(*r_)}" for g, r_ in groups)
    return s + '.'


def stakes_text(st, r, games_left, swept_by):
    A, H = r['away'], r['home']
    div = next(((n, t) for n, t in st if {A, H} <= {x[0] for x in t}), None)
    if div:
        name, teams = div
        rc = {t[0]: t[1:] for t in teams}
        (hw, hl, ht), (aw, alo, at) = rc[H], rc[A]
        s = division_line(name, teams) + ' '
        s += f"A {H} win would make it {H} {rec(hw + 1, hl, ht)} vs {A} {rec(aw, alo + 1, at)}" + (f" and a season sweep of {A}" if swept_by == H else '') + '. '
        s += f"A {A} win would make it {A} {rec(aw + 1, alo, at)} vs {H} {rec(hw, hl + 1, ht)}" + (f" and a season sweep of {H}" if swept_by == A else '')
        return s + (f", with {games_left} games left after this one." if games_left is not None else '.')
    parts = []
    for ab in (A, H):
        d = next(((n, t) for n, t in st if ab in {x[0] for x in t}), None)
        if not d:
            continue
        n, t = d
        i = [x[0] for x in t].index(ab)
        me, top = t[i], t[0]
        gb = ((top[1] - me[1]) + (me[2] - top[2])) / 2
        parts.append(f"{ab} is {ordinal(i + 1)} in the {n} at {rec(*me[1:])}" + (f", {fl(gb)} {'game' if gb == 1 else 'games'} behind {top[0]}" if gb > 0 else ''))
    return ('; '.join(parts) + '.') if parts else f"{A} is {r['arec']}; {H} is {r['hrec']}."


def team_fact(name, gs, home_side):
    if not gs:
        return None
    n = len(gs)
    c = Counter(g['res'] for g in gs)
    PF, PA = sum(g['pf'] for g in gs), sum(g['pa'] for g in gs)
    d = PF - PA
    py = n * PF ** 2.37 / (PF ** 2.37 + PA ** 2.37) if PF + PA else n / 2
    did = f"has outscored opponents by {d}" if d > 0 else f"has been outscored by {-d}" if d < 0 else 'has scored as many points as it allowed'
    s = f"{name} is {rec(c['W'], c['L'], c['T'])} {'but' if abs(c['W'] + c['T'] / 2 - py) >= 0.75 else 'and'} {did}; its points say about {py:.1f} wins."
    one = [g for g in gs if abs(g['pf'] - g['pa']) <= 8]
    vs = [g for g in gs if g['home'] == home_side]
    where, per = ('at home', 'home') if home_side else ('on the road', 'road')
    bits = []
    if one:
        oc = Counter(g['res'] for g in one)
        bits.append(f"{rec(oc['W'], oc['L'], oc['T'])} in one-score games")
    if vs:
        vc = Counter(g['res'] for g in vs)
        bits.append(f"{rec(vc['W'], vc['L'], vc['T'])} {where} ({sum(g['pf'] for g in vs) / len(vs):.1f} points a {per} game)")
    if bits:
        s += ' It is ' + ' and '.join(bits) + '.'
    ou = [g for g in vs if g['ou'] in ('O', 'U')]
    if len(ou) >= 4:
        o = sum(g['ou'] == 'O' for g in ou)
        avg = sum(g['pf'] + g['pa'] for g in ou) / len(ou)
        if o in (0, len(ou)):
            s += f" Its {len(ou)} {per} games with a line all went {'over' if o else 'under'} ({avg:.1f} points a game)."
        elif o / len(ou) >= 0.8 or o / len(ou) <= 0.2:
            s += f" {o} of its {len(ou)} {per} games with a line went over ({avg:.1f} points a game)."
    small = [f"{len(x)} {lab}" for x, lab in ((one, 'one-score games'), (vs, f'{per} games')) if 0 < len(x) < 10]
    if small:
        s += f" Small samples: {join(small)}."
    return s


def build_mnf(Y, rows):
    cand = [r for r in rows if monday_night(r) and r['state'] != 'post' and etd(r['t']) >= NOW.astimezone(ET).date() - timedelta(days=1)]
    if not cand:
        return None, None
    r = cand[0]
    A, H = r['away'], r['home']
    za, zh = NFL_ZONE[A], NFL_ZONE[H]
    summ = summary(NFLP, r['id'])
    if not summ:
        raise RuntimeError(f"summary for {r['short']} could not be fetched")
    L = lines(summ)
    lc = {'away': loc(r, 'away'), 'home': loc(r, 'home')}
    # ---- market
    market = None
    if L and (L['hs'] is not None or L['hml'] is not None):
        hs = L['hs']
        fav = None if hs is None or hs == 0 else (H if hs < 0 else A)
        fs = lambda x: None if x is None else (x if fav == H or fav is None else -x)
        nv, nvo = novig(L['hml'], L['aml']), novig(L['hml_open'], L['aml_open'])
        moves = []
        if L['hs_open'] is not None and hs is not None and L['hs_open'] != hs:
            moves.append(f"{H} {sgn(L['hs_open'])} to {sgn(hs)}")
        if L['tot_open'] is not None and L['tot'] is not None and L['tot_open'] != L['tot']:
            moves.append(f"total {fl(L['tot_open'])} to {fl(L['tot'])}")
        if L['hml_open'] is not None and L['hml'] is not None and L['hml_open'] != L['hml']:
            moves.append(f"{H} {mls(L['hml_open'])} to {mls(L['hml'])}")
        if nv and nvo and abs(nv[0] - nvo[0]) >= 0.005:
            toward = lc['away'] if nv[0] < nvo[0] else lc['home']
            move = f"Since it opened, the price has moved toward {toward}: " + ', '.join(moves) + '.'
        elif moves:
            move = 'Since it opened: ' + ', '.join(moves) + '.'
        else:
            move = 'The price has not moved since it opened.' if L['hml_open'] is not None else 'No opening price on ESPN.'
        market = {'book': f"{L['book']} (via ESPN)", 'fetched': iso(NOW), 'fav': fav, 'spread': fs(hs) if fav else hs,
                  'spreadOdds': {'home': L['hso'], 'away': L['aso']}, 'openSpread': fs(L['hs_open']) if fav else L['hs_open'],
                  'total': L['tot'], 'openTotal': L['tot_open'], 'ml': {'home': L['hml'], 'away': L['aml']},
                  'openMl': {'home': L['hml_open'], 'away': L['aml_open']},
                  'noVig': {'home': nv[0], 'away': nv[1]} if nv else None, 'openNoVig': {'home': nvo[0], 'away': nvo[1]} if nvo else None,
                  'implied': ({'home': (L['tot'] - hs) / 2, 'away': (L['tot'] + hs) / 2} if L['tot'] is not None and hs is not None else None), 'move': move}
    pr = summ.get('predictor') or {}
    ph, pa_ = num(nested(pr, 'homeTeam', 'gameProjection')), num(nested(pr, 'awayTeam', 'gameProjection'))
    predictor = {'home': round(ph / 100, 3), 'away': round(pa_ / 100, 3), 'source': "ESPN Matchup Predictor (ESPN's FPI model, not a price)"} if ph is not None and pa_ is not None else None
    wtxt, wx = weather(summ, r)
    # ---- teams
    tg = {s: team_games(rows, ab) for s, ab in (('away', A), ('home', H))}
    tb = {}
    lastg = {}
    for s, ab in (('away', A), ('home', H)):
        gs = tg[s]
        lastg[s] = max((g['_t'] for g in gs), default=None)
        tb[s] = {'record': r[s[0] + 'rec'], 'season': split(gs), 'home': split([g for g in gs if g['home']]), 'away': split([g for g in gs if not g['home']]),
                 'fav': split([g for g in gs if g['spread'] is not None and g['spread'] < 0]), 'dog': split([g for g in gs if g['spread'] is not None and g['spread'] > 0]),
                 'rest': (etd(r['t']) - etd(lastg[s])).days if lastg[s] else None, 'bye': bye_week(rows, ab),
                 'games': [{k: v for k, v in g.items() if not k.startswith('_')} for g in gs]}
    # ---- head to head
    h2 = h2h_games(rows, Y, r)
    lm = last_meeting(h2[-1], r) if h2 else None
    if h2:
        win = Counter((x['_x']['home'] if x['_x']['hs'] > x['_x']['as'] else x['_x']['away'] if x['_x']['as'] > x['_x']['hs'] else 'tie') for x in h2)
        y0, y1, n = h2[0]['date'][:4], h2[-1]['date'][:4], len(h2)
        span = y0 if y0 == y1 else f'{y0}-{y1}'
        if win[H] != win[A]:
            ld = H if win[H] > win[A] else A
            txt = f"{lc['home'] if ld == H else lc['away']} has won {win[ld]} of the last {n} ({span})"
        else:
            txt = f"They have split the last {n} ({span})"
        athome = [x for x in h2 if x['home'] == H]
        if athome:
            hw = sum(1 for x in athome if x['_x']['hs'] > x['_x']['as'])
            hl = sum(1 for x in athome if x['_x']['hs'] < x['_x']['as'])
            txt += (f", {rec(hw, hl)} at home" if win[H] > win[A] else f"; {lc['home']} is {rec(hw, hl)} at home in these games")
        wl_ = sum(1 for x in h2 if x['line'])
        txt += '.' + ('' if wl_ == n else ' ESPN has no lines for these games.' if not wl_ else f" ESPN has lines for only {wl_} of the {n}.") + ' A small sample; rosters change.'
        this_season = [x for x in h2 if x['_x']['t'].year >= Y and x['_x']['t'] > datetime(Y, 8, 1, tzinfo=UTC)]
        swept_by = None
        if this_season:
            w0 = this_season[0]['_x']
            swept_by = w0['home'] if w0['hs'] > w0['as'] else w0['away'] if w0['as'] > w0['hs'] else None
            if len(this_season) > 1:
                swept_by = None
    else:
        txt, swept_by = f"No meetings in the {Y - 2}-{Y} regular seasons.", None
    h2h = {'games': [{k: v for k, v in x.items() if not k.startswith('_')} for x in h2], 'text': txt}
    # ---- Monday nights this season
    mg = []
    for x in rows:
        if not (monday_night(x) and x['completed']):
            continue
        Lx = lines(summary(NFLP, x['id']))
        hsp, tot = (Lx['hs'], Lx['tot']) if Lx else (None, None)
        T = x['hs'] + x['as']
        cov = None if hsp is None else (x['home'] if x['hs'] - x['as'] + hsp > 0 else x['away'] if x['hs'] - x['as'] + hsp < 0 else 'push')
        mg.append({'week': x['week'], 'date': str(etd(x['t'])), 'away': x['away'], 'home': x['home'], 'score': f"{x['away']} {int(x['as'])} - {x['home']} {int(x['hs'])}",
                   'line': Lx['details'] if Lx and hsp is not None else None, 'total': tot, 'ou': None if tot is None else ('O' if T > tot else 'U' if T < tot else 'P'),
                   'cover': cov, '_fav': None if not hsp else (x['home'] if hsp < 0 else x['away']), '_T': T,
                   '_win': x['home'] if x['hs'] > x['as'] else x['away'] if x['as'] > x['hs'] else None})
    fav_g = [g for g in mg if g['_fav'] and g['cover']]
    dw, dl = sum(g['cover'] not in (g['_fav'], 'push') for g in fav_g), sum(g['cover'] == g['_fav'] for g in fav_g)
    dp = sum(g['cover'] == 'push' for g in fav_g)
    mnf_season = {'n': len(mg), 'over': sum(g['ou'] == 'O' for g in mg), 'under': sum(g['ou'] == 'U' for g in mg), 'dogsAts': rec(dw, dl, dp),
                  'favSu': rec(sum(g['_win'] == g['_fav'] for g in mg if g['_fav']), sum(g['_win'] not in (g['_fav'], None) for g in mg if g['_fav'])),
                  'homeSu': rec(sum(g['_win'] == g['home'] for g in mg), sum(g['_win'] == g['away'] for g in mg)),
                  'avgTotal': round(sum(g['_T'] for g in mg) / len(mg), 1) if mg else None,
                  'avgLine': round(statistics.mean([g['total'] for g in mg if g['total'] is not None]), 1) if any(g['total'] is not None for g in mg) else None,
                  'games': [{k: v for k, v in g.items() if not k.startswith('_')} for g in mg]}
    # ---- stakes, facts, watch
    st = standings(summ, rows)
    played = len(tg['home'])
    stakes = stakes_text(st, r, max(0, 17 - played - 1) if played else None, swept_by)
    facts = [f for f in (team_fact(lc['home'], tg['home'], True), team_fact(lc['away'], tg['away'], False)) if f]
    if lastg['away'] and lastg['home']:
        da, dh = etd(lastg['away']), etd(lastg['home'])
        ra, rh = tb['away']['rest'], tb['home']['rest']
        if da == dh:
            facts.append(f"Both teams last played {da:%A} {mday(da)}, so both get {ra} days of rest.")
        else:
            facts.append(f"{lc['away']} last played {da:%A} {mday(da)} ({ra} days of rest); {lc['home']} last played {dh:%A} {mday(dh)} ({rh} days).")
        for s in ('away', 'home'):
            if tb[s]['rest'] and tb[s]['rest'] >= 13:
                facts[-1] += f" {lc[s]} comes off its bye."
    if mg:
        facts.append(f"Monday nights this season ({len(mg)} games): underdogs {mnf_season['dogsAts']} against the spread, "
                     f"{mnf_season['over']} overs and {mnf_season['under']} unders. A small sample.")
    if st:
        div = next(((n, t) for n, t in st if {A, H} <= {x[0] for x in t}), None)
        if div:
            facts.append(division_line(*div))
    if predictor and market and market['noVig']:
        facts.append(f"ESPN's predictor gives {lc['home']} {predictor['home']:.0%}; the {L['book']} moneyline, margin removed, gives {market['noVig']['home']:.0%}.")
    inj = injuries(summ, r)
    watch = []
    bits = []
    for s in ('home', 'away'):
        by = {}
        for p in inj[s]:
            if p['status'] in ('Out', 'Doubtful', 'Questionable'):
                by.setdefault(p['status'].lower(), []).append(p['name'])
        if by:
            bits.append(f"{lc[s]}: " + '; '.join(f"{join(v)} {k}" for k, v in by.items()))
    watch.append('The injury report before kickoff: ' + ('. '.join(bits) + '.' if bits else 'neither team lists anyone as questionable, doubtful or out yet.'))
    if wx and (re.search(r'storm|rain|snow|shower|sleet|ice|flurr', wx['cond']) or (wx['precip'] or 0) >= 40 or (wx['gust'] or 0) >= 20 or (wx['temp'] is not None and wx['temp'] <= 32)):
        why_ = [x for x in (wx['cond'], f"precipitation {fl(wx['precip'])}" if (wx['precip'] or 0) >= 40 else '',
                            f"gusts {fl(wx['gust'])} mph" if (wx['gust'] or 0) >= 20 else '', f"{fl(wx['temp'])}°F" if wx['temp'] is not None and wx['temp'] <= 32 else '') if x]
        watch.append(f"The weather in {r['city']}: {', '.join(why_)} in the forecast (open-air stadium).")
    if market:
        if L['hs_open'] is not None and L['hs'] is not None and L['hs_open'] != L['hs']:
            d = abs(L['hs'] - L['hs_open'])
            toward = lc['away'] if L['hs'] > L['hs_open'] else lc['home']
            watch.append(f"Line moves: it has moved {fl(d)} {'point' if d == 1 else 'points'} toward {toward} since opening.")
        else:
            watch.append(f"Line moves: the spread has not moved since opening ({market['fav'] or H} {sgn(market['spread'] or 0)}).")
    za_k, zh_k = clock(r['t'], ztz('nfl', A, za)), clock(r['t'], ztz('nfl', H, zh))
    k_et = r['t'].astimezone(ET).strftime('%-I:%M %p')
    if is_pe(za, zh):
        west = H if zh == 'Pacific' else A
        ok = r['t'].astimezone(ET).hour >= 20
        rule = {'applies': ok, 'text': (f"{west} (Pacific) vs {A if west == H else H} (Eastern) at {k_et} ET, {clock(r['t'], ZTZ['Pacific'])} on {west}'s body clock: "
                                        f"the reel's rule would back {west}. Our tests found no edge once the prices are counted." if ok else
                                        'Pacific vs Eastern, but kickoff is before 8 PM ET, so the rule does not apply.')}
    elif za == zh:
        rule = {'applies': False, 'text': f"Both teams are on {za} time, so kickoff is {za_k} on both body clocks. The reel's rule says nothing about this game."}
    else:
        rule = {'applies': False, 'text': f"{A} ({za}) vs {H} ({zh}): kickoff is {za_k} on {A}'s body clock and {zh_k} on {H}'s. The rule covers only Pacific vs Eastern."}
    nv_ = ['Past lines come from one book (DraftKings, through ESPN); no second odds source is reachable here.',
           "ESPN's predictor doesn't publish its inputs."]
    if wx:
        nv_.append("The weather forecast's units (precipitation read as a % chance) come from the feed's AccuWeather fields, not confirmed.")
    nv_.append("Roof status is ESPN's venue 'indoor' flag.")
    mnf = {'espnId': r['id'], 'week': r['week'], 'kickoffUTC': iso(r['t']),
           'away': team(A, za, ztz('nfl', A, za), r['aname'], r['arec']), 'home': team(H, zh, ztz('nfl', H, zh), r['hname'], r['hrec']),
           'venue': ', '.join(x for x in (r['venue'], r['city'], r['region']) if x), 'tv': '/'.join(r['tv']) or None,
           'rule': rule, 'stakes': stakes, 'market': market, 'predictor': predictor, 'polymarket': polymarket(r), 'weather': wtxt,
           'lastMeeting': lm, 'h2h': h2h, 'teams': {'away': tb['away'], 'home': tb['home']}, 'injuries': inj, 'mnfSeason': mnf_season,
           'facts': facts, 'watch': watch, 'notVerified': nv_}
    return mnf, r


# ---------------------------------------------------------------- last Monday night
def season_nfl():
    s = jload(SEASON)
    nfl = nested(s, 'sports', 'nfl')
    if not nfl:
        raise RuntimeError('season.json has no NFL block')
    return nfl


def players_vs_avg(nfl, teams, gdate):
    F = ['date', 'opp', 'home'] + nfl['fields']
    main = {'QB': ('pyd', 'passing yards'), 'RB': ('ryd', 'rushing yards'), 'WR': ('recyd', 'receiving yards'), 'TE': ('recyd', 'receiving yards')}
    beat, short = [], []
    for p in nfl['players']:
        if p['t'] not in teams or p.get('pos') not in main:
            continue
        logs = [dict(zip(F, g)) for g in p['log']]
        on = next((g for g in logs if g['date'] == gdate), None)
        pre = [g for g in logs if g['date'] < gdate]
        if not on or len(pre) < 4:
            continue
        k, lab = main[p['pos']]
        avg = sum(g[k] for g in pre) / len(pre)
        if avg < 15:
            continue
        d = on[k] - avg
        pc = round(100 * d / avg)
        item = f"{p['n']} ({p['t']}) {on[k]:g} {lab} vs {round(avg, 1):g} avg ({round(d, 1):+g}, {pc:+d}%, {len(pre)} games)"
        (beat if d > 0 else short).append((abs(pc), item))
    return [x[1] for x in sorted(beat, reverse=True)[:4]], [x[1] for x in sorted(short, reverse=True)[:4]]


def lesson(nfl):
    F = ['date', 'opp', 'home'] + nfl['fields']

    def loo(stat, pos, min_avg):
        below = above = 0
        for p in nfl['players']:
            if p.get('pos') not in pos:
                continue
            v = [dict(zip(F, g))[stat] for g in p['log']]
            if len(v) < 6 or sum(v) / len(v) < min_avg:
                continue
            for i, x in enumerate(v):
                a = (sum(v) - x) / (len(v) - 1)
                below += x < a
                above += x > a
        return below / (below + above) if below + above else None, below + above
    res = [('rushing yards', *loo('ryd', {'RB'}, 30)), ('receiving yards', *loo('recyd', {'WR', 'TE'}, 30)), ('catches', *loo('rec', {'WR', 'TE', 'RB'}, 3))]
    res = [x for x in res if x[1] is not None]
    if not res:
        return None
    sh = [round(100 * x[1]) for x in res]
    rng = f'{min(sh)}%' if min(sh) == max(sh) else f'{min(sh)}-{max(sh)}%'
    names = join(x[0] for x in res)
    names = names[0].upper() + names[1:]
    n = sum(x[2] for x in res)
    if min(sh) > 50:
        return (f"{names} finished under the player's own season average in {rng} of games this season ({n:,} player-games), "
                f"because a few big games pull the average up. A line set at the average is not a coin flip.")
    if max(sh) < 50:
        return f"{names} finished under the player's own season average in {rng} of games this season ({n:,} player-games): no sign that the average sits too high."
    return f"{names} finished under the player's own season average in {rng} of games this season ({n:,} player-games): mixed, so treat each stat on its own."


def app_legs(r, nfl):
    recs = jload(RECS)
    if not recs:
        return None
    feed = jload(FEED) or {}
    gids = {g['id'] for g in feed.get('games') or [] if g.get('sport') == 'nfl' and g.get('start') and abs((P(g['start']) - r['t']).total_seconds()) <= 1200
            and al(nested(g, 'home', 'abbr') or '') == r['home'] and al(nested(g, 'away', 'abbr') or '') == r['away']}
    F = ['date', 'opp', 'home'] + nfl['fields']
    gdate = r['t'].strftime('%Y-%m-%d')
    stat = {'rec': 'rec', 'recyd': 'recyd', 'recYds': 'recyd', 'ryd': 'ryd', 'rushYds': 'ryd', 'pyd': 'pyd', 'passYds': 'pyd', 'ra': 'ra', 'tgt': 'tgt', 'ptd': 'ptd'}
    legs = {}
    for d in recs.get('days') or []:
        for par in d.get('parlays') or []:
            for l in par.get('legs') or []:
                same = l.get('gid') in gids or (l.get('sport') == 'nfl' and l.get('start') and abs((P(l['start']) - r['t']).total_seconds()) <= 1200
                                                and al(l.get('home') or '') == r['home'] and al(l.get('away') or '') == r['away'])
                if same:
                    legs.setdefault((l.get('gid'), l.get('key')), l)
    if not legs:
        return None
    graded = []
    for l in legs.values():
        res = l.get('res')
        pl = l.get('player')
        if res is None and pl:
            tm = al(pl.get('team') or '')
            cand = [p for p in nfl['players'] if p['n'] == pl.get('name')]
            p = next((x for x in cand if x['t'] == tm), cand[0] if len(cand) == 1 else None)
            g = next((dict(zip(F, x)) for x in (p or {}).get('log', []) if x[0] == gdate), None)
            k = stat.get(pl.get('stat'))
            val = None
            if g and k:
                val = g[k]
            elif g and pl.get('stat') in ('td', 'atd', 'anytd'):
                val = g['rtd'] + g['ctd']
            if val is not None and pl.get('thr') is not None:
                res = (val < pl['thr']) if pl.get('under') else (val >= pl['thr'])
        if res is not None and res != 'push':
            graded.append((bool(res), float(l.get('p') or 0), l.get('label')))
    n, g_ = len(legs), len(graded)
    if not g_:
        return f"The app recommended {n} {'leg' if n == 1 else 'legs'} on this game; none could be graded from the box score."
    hit = sum(x[0] for x in graded)
    exp = sum(x[1] for x in graded)
    s = (f"All {g_} legs the app recommended on this game landed" if hit == g_ and g_ > 1 else
         f"{hit} of {g_} graded legs the app recommended on this game landed")
    low = min((x for x in graded if x[0] and x[1] < 0.5), key=lambda x: x[1], default=None)
    s += (f", including {low[2]} at {low[1]:.1%}" if low else '') + f" (about {exp:.1f} expected)"
    if n > g_:
        s += f"; {n - g_} could not be graded"
    word = NUMW.get(g_, str(g_))
    return s + f". {word[0].upper() + word[1:]} {'leg is' if g_ == 1 else 'legs is'} far too few to judge the pricing."


NUMW = {1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten'}


def build_last_mnf(rows, nfl):
    done = [r for r in rows if monday_night(r) and r['completed']]
    if not done:
        return None
    r = done[-1]
    s = summary(NFLP, r['id'])
    if not s:
        raise RuntimeError(f"summary for {r['short']} could not be fetched")
    A, H = r['away'], r['home']
    hs, as_ = int(r['hs']), int(r['as'])
    lc = {'away': loc(r, 'away'), 'home': loc(r, 'home')}
    first = ('home', 'away') if hs >= as_ else ('away', 'home')
    final = ', '.join(f"{r[x[0] + 'name']} {hs if x == 'home' else as_}" for x in first)
    # second source for the final: the app feed (data.json)
    for g in (jload(FEED) or {}).get('games') or []:
        if g.get('sport') == 'nfl' and g.get('score') and g.get('start') and abs((P(g['start']) - r['t']).total_seconds()) <= 1200 \
                and al(nested(g, 'home', 'abbr') or '') == H and al(nested(g, 'away', 'abbr') or '') == A:
            if g['score'] != {'home': hs, 'away': as_}:
                warn(f"last Monday final differs: ESPN {A} {as_}-{H} {hs}, app feed {g['score']}")
            else:
                STATS['final_checked'] = 1
    # how it ended: the last scoring play
    how = None
    sp = s.get('scoringPlays') or []
    if sp:
        z = sp[-1]
        tab = nested(z, 'team', 'abbreviation')
        side = 'home' if tab == H else 'away'
        q, ck = nested(z, 'period', 'number'), nested(z, 'clock', 'displayValue') or ''
        qn = {1: 'first quarter', 2: 'second quarter', 3: 'third quarter', 4: 'fourth quarter'}.get(q, 'overtime')
        when = 'as time expired' if ck in ('0:00', '0') and q and q >= 4 else (f"with {ck} left in the {qn}" if q and q <= 4 else 'in overtime')
        dr = next((d for d in reversed(nested(s, 'drives', 'previous') or []) if d.get('isScore')), None)
        if not dr or nested(dr, 'team', 'abbreviation') != tab or nested(dr, 'end', 'period', 'number') not in (None, q):
            dr = None  # e.g. a defensive score: the last scoring drive is not this play's
        how = f"The last score: {(z.get('text') or '').strip()} {when}"
        dm = re.match(r'(\d+) plays?, (-?\d+) yards?, (\d+:\d+)', (dr or {}).get('description') or '')
        if dm:
            how += f", ending a {dm.group(1)}-play, {dm.group(2)}-yard {lc[side]} drive that took {dm.group(3)}"
        elif dr and dr.get('description'):
            how += f" ({lc[side]} drive: {dr['description']})"
        how += '.'
        pa_, ph_ = (sp[-2].get('awayScore'), sp[-2].get('homeScore')) if len(sp) > 1 else (0, 0)
        aa, hh = z.get('awayScore'), z.get('homeScore')
        if None not in (pa_, ph_, aa, hh):
            before = (ph_ > pa_) - (ph_ < pa_)
            after = (hh > aa) - (hh < aa)
            lead = f"{max(aa, hh)}-{min(aa, hh)}"
            if after != before and after != 0:
                how += f" It put {lc[side]} ahead {lead}."
            elif after == 0:
                how += f" It tied the game {aa}-{hh}."
    comp = nested(s, 'header', 'competitions')[0]
    qs = {c['homeAway']: [int(num(l.get('displayValue')) or 0) for l in c.get('linescores') or []] for c in comp['competitors']}
    L = lines(s)
    line = None
    if L and L['hs'] is not None and L['tot'] is not None:
        if L['hs'] == 0:
            line = f"Closed pick'em, total {fl(L['tot'])}"
        else:
            fav, dog = (H, A) if L['hs'] < 0 else (A, H)
            f_sp = L['hs'] if fav == H else -L['hs']
            f_op = None if L['hs_open'] is None else (L['hs_open'] if fav == H else -L['hs_open'])
            dml = L['aml'] if dog == A else L['hml']
            line = f"Closed {fav} {sgn(f_sp)}" + (f" (opened {sgn(f_op)})" if f_op is not None else '') + f", total {fl(L['tot'])}" + (f", {dog} {mls(dml)}" if dml is not None else '')
    gdate = r['t'].strftime('%Y-%m-%d')
    beat, short = players_vs_avg(nfl, {A, H}, gdate)
    art = s.get('article') or {}
    return {'label': r['short'], 'date': str(etd(r['t'])), 'final': final, 'how': how,
            'quarters': {'away': qs.get('away', []), 'home': qs.get('home', []), 'awayAbbr': A, 'homeAbbr': H},
            'line': line, 'result': result_text(L, r, lc), 'beat': beat, 'short': short, 'appLegs': app_legs(r, nfl), 'lesson': lesson(nfl),
            'story': f"https://www.espn.com/nfl/recap?gameId={r['id']}", 'storyTitle': art.get('headline') or 'ESPN recap'}


# ================================================================ NBA
def months(*ds):
    return sorted({(d.year, d.month) for d in ds})


def nba_upcoming():
    f, to = window()
    rows = {}
    for y, m in months(f - timedelta(days=1), to, f + timedelta(days=30)):
        sb = get(f'{API}{NBAP}/scoreboard?dates={y}{m:02d}&limit=1000')
        if sb is None:
            raise RuntimeError(f'NBA scoreboard {y}{m:02d} could not be fetched')
        for e in sb.get('events') or []:
            r = ev_row(e)
            if r and r['home'] in NBA_ZONE and r['away'] in NBA_ZONE:
                rows[r['id']] = r
    rows = sorted(rows.values(), key=lambda r: r['t'])
    played = {(ab, etd(r['t'])) for r in rows for ab in (r['home'], r['away'])}
    near, later = [], []
    for r in rows:
        d = etd(r['t'])
        if r['state'] == 'post' or d < f or d > f + timedelta(days=30):
            continue
        za, zh = NBA_ZONE[r['away']], NBA_ZONE[r['home']]
        ta, th = ztz('nba', r['away'], za), ztz('nba', r['home'], zh)
        gap = abs(off(ta, r['t']) - off(th, r['t']))
        pe = is_pe(za, zh)
        late = r['t'].astimezone(ET).hour >= 20
        west = (r['home'] if zh == 'Pacific' else r['away']) if pe else None
        g = {'sport': 'nba', 'espnId': r['id'], 'label': r['short'], 'slot': '', 'kickoffUTC': iso(r['t']),
             'away': team(r['away'], za, ta, record=r['arec']), 'home': team(r['home'], zh, th, record=r['hrec']),
             'venue': ', '.join(x for x in (r['city'], r['region']) if x), 'applies': bool(pe and late)}
        why = (f"Pacific vs Eastern at 8 PM ET or later: the reel's rule would back {west}." if pe and late else
               'Pacific vs Eastern, but before 8 PM ET.' if pe else
               f"{za} vs {zh} ({hrs(gap)}-hour gap): not the Pacific vs Eastern match-up the rule is about.")
        if d <= to:
            if not (pe or gap >= 2):
                continue
            L = lines(summary(NBAP, r['id']))
            g.update({'gap': gap, 'why': why, 'b2b': [ab for ab in (r['away'], r['home']) if (ab, d - timedelta(days=1)) in played], 'odds': odds_obj(L, r['home'])})
            if pe:
                g['west'] = west
                if g['applies']:
                    g['westLine'] = None if not L or L['hs'] is None else (L['hs'] if west == r['home'] else -L['hs'])
            near.append(g)
        elif pe and len(later) < 4:
            g.update({'west': west, 'why': why, 'odds': None})
            if g['applies']:
                g['westLine'] = None
            later.append(g)
    return near, later


# ================================================================ soccer
LEAGUES = {'usa.1': 'MLS', 'mex.1': 'Liga MX', 'uefa.champions': 'UEFA Champions League', 'uefa.europa': 'UEFA Europa League',
           'uefa.europa.conf': 'UEFA Conference League', 'afc.champions': 'AFC Champions League Elite', 'aus.1': 'A-League Men'}
COUNTRY = {'Türkiye': 'Europe/Istanbul', 'Turkey': 'Europe/Istanbul', 'Azerbaijan': 'Asia/Baku', 'Georgia': 'Asia/Tbilisi', 'Kazakhstan': 'Asia/Almaty',
           'Norway': 'Europe/Oslo', 'England': 'Europe/London', 'Scotland': 'Europe/London', 'Wales': 'Europe/London', 'Northern Ireland': 'Europe/London',
           'Republic of Ireland': 'Europe/Dublin', 'Ireland': 'Europe/Dublin', 'Italy': 'Europe/Rome', 'Netherlands': 'Europe/Amsterdam', 'Germany': 'Europe/Berlin',
           'Spain': 'Europe/Madrid', 'Slovakia': 'Europe/Bratislava', 'Czechia': 'Europe/Prague', 'Czech Republic': 'Europe/Prague', 'Belgium': 'Europe/Brussels',
           'France': 'Europe/Paris', 'Portugal': 'Europe/Lisbon', 'Croatia': 'Europe/Zagreb', 'Greece': 'Europe/Athens', 'Austria': 'Europe/Vienna',
           'Hungary': 'Europe/Budapest', 'Albania': 'Europe/Tirane', 'Lithuania': 'Europe/Vilnius', 'Latvia': 'Europe/Riga', 'Estonia': 'Europe/Tallinn',
           'Cyprus': 'Asia/Nicosia', 'Bosnia and Herzegovina': 'Europe/Sarajevo', 'Bulgaria': 'Europe/Sofia', 'Denmark': 'Europe/Copenhagen',
           'Sweden': 'Europe/Stockholm', 'Finland': 'Europe/Helsinki', 'Switzerland': 'Europe/Zurich', 'Poland': 'Europe/Warsaw', 'Romania': 'Europe/Bucharest',
           'Serbia': 'Europe/Belgrade', 'Slovenia': 'Europe/Ljubljana', 'Ukraine': 'Europe/Kyiv', 'Israel': 'Asia/Jerusalem', 'Armenia': 'Asia/Yerevan',
           'Moldova': 'Europe/Chisinau', 'Belarus': 'Europe/Minsk', 'Kosovo': 'Europe/Belgrade', 'North Macedonia': 'Europe/Skopje', 'Montenegro': 'Europe/Podgorica',
           'Iceland': 'Atlantic/Reykjavik', 'Faroe Islands': 'Atlantic/Faroe', 'Luxembourg': 'Europe/Luxembourg', 'Malta': 'Europe/Malta', 'Andorra': 'Europe/Andorra',
           'Gibraltar': 'Europe/Gibraltar', 'San Marino': 'Europe/San_Marino', 'Liechtenstein': 'Europe/Vaduz',
           'South Korea': 'Asia/Seoul', 'Korea Republic': 'Asia/Seoul', 'Japan': 'Asia/Tokyo', 'Vietnam': 'Asia/Ho_Chi_Minh', 'Thailand': 'Asia/Bangkok',
           'China PR': 'Asia/Shanghai', 'China': 'Asia/Shanghai', 'United Arab Emirates': 'Asia/Dubai', 'Saudi Arabia': 'Asia/Riyadh', 'Qatar': 'Asia/Qatar',
           'Iran': 'Asia/Tehran', 'Uzbekistan': 'Asia/Tashkent', 'Malaysia': 'Asia/Kuala_Lumpur', 'Singapore': 'Asia/Singapore', 'Hong Kong': 'Asia/Hong_Kong',
           'Indonesia': 'Asia/Jakarta', 'Philippines': 'Asia/Manila', 'India': 'Asia/Kolkata', 'Iraq': 'Asia/Baghdad', 'Jordan': 'Asia/Amman', 'Kuwait': 'Asia/Kuwait',
           'Bahrain': 'Asia/Bahrain', 'Oman': 'Asia/Muscat', 'Tajikistan': 'Asia/Dushanbe', 'Turkmenistan': 'Asia/Ashgabat', 'New Zealand': 'Pacific/Auckland'}
SLUG = {'eng': 'Europe/London', 'sco': 'Europe/London', 'wal': 'Europe/London', 'nir': 'Europe/London', 'irl': 'Europe/Dublin', 'esp': 'Europe/Madrid',
        'fra': 'Europe/Paris', 'ita': 'Europe/Rome', 'ger': 'Europe/Berlin', 'ned': 'Europe/Amsterdam', 'bel': 'Europe/Brussels', 'por': 'Europe/Lisbon',
        'gre': 'Europe/Athens', 'tur': 'Europe/Istanbul', 'den': 'Europe/Copenhagen', 'nor': 'Europe/Oslo', 'swe': 'Europe/Stockholm', 'fin': 'Europe/Helsinki',
        'aut': 'Europe/Vienna', 'sui': 'Europe/Zurich', 'cyp': 'Asia/Nicosia', 'isr': 'Asia/Jerusalem', 'rou': 'Europe/Bucharest', 'pol': 'Europe/Warsaw',
        'cze': 'Europe/Prague', 'svk': 'Europe/Bratislava', 'hun': 'Europe/Budapest', 'cro': 'Europe/Zagreb', 'srb': 'Europe/Belgrade', 'svn': 'Europe/Ljubljana',
        'bul': 'Europe/Sofia', 'ukr': 'Europe/Kyiv', 'kaz': 'Asia/Almaty', 'aze': 'Asia/Baku', 'geo': 'Asia/Tbilisi', 'arm': 'Asia/Yerevan',
        'jpn': 'Asia/Tokyo', 'kor': 'Asia/Seoul', 'chn': 'Asia/Shanghai', 'tha': 'Asia/Bangkok', 'vie': 'Asia/Ho_Chi_Minh', 'mys': 'Asia/Kuala_Lumpur',
        'ksa': 'Asia/Riyadh', 'uae': 'Asia/Dubai', 'qat': 'Asia/Qatar', 'irn': 'Asia/Tehran', 'uzb': 'Asia/Tashkent', 'sgp': 'Asia/Singapore',
        'hkg': 'Asia/Hong_Kong', 'idn': 'Asia/Jakarta', 'ind': 'Asia/Kolkata'}
US_STATE = {'California': 'America/Los_Angeles', 'Oregon': 'America/Los_Angeles', 'Washington': 'America/Los_Angeles', 'British Columbia': 'America/Vancouver',
            'Utah': 'America/Denver', 'Colorado': 'America/Denver', 'Texas': 'America/Chicago', 'Illinois': 'America/Chicago', 'Missouri': 'America/Chicago',
            'Tennessee': 'America/Chicago', 'Minnesota': 'America/Chicago', 'Kansas': 'America/Chicago'}
MX_CITY = {'Tijuana': 'America/Tijuana', 'Ciudad Juárez': 'America/Ciudad_Juarez', 'Ciudad Juarez': 'America/Ciudad_Juarez', 'Mazatlán': 'America/Mazatlan',
           'Mazatlan': 'America/Mazatlan', 'Monterrey': 'America/Monterrey', 'San Nicolás de los Garza': 'America/Monterrey', 'Guadalupe': 'America/Monterrey',
           'Torreón': 'America/Monterrey', 'Torreon': 'America/Monterrey'}
AU_CITY = {'Sydney': 'Australia/Sydney', 'New South Wales': 'Australia/Sydney', 'Gosford': 'Australia/Sydney', 'Newcastle': 'Australia/Sydney',
           'Melbourne': 'Australia/Melbourne', 'Victoria': 'Australia/Melbourne', 'Brisbane': 'Australia/Brisbane', 'Queensland': 'Australia/Brisbane',
           'Perth': 'Australia/Perth', 'Western Australia': 'Australia/Perth', 'Adelaide': 'Australia/Adelaide', 'South Australia': 'Australia/Adelaide',
           'Auckland': 'Pacific/Auckland', 'Wellington': 'Pacific/Auckland'}
# Club home zones by name for clubs whose ESPN venue is often not at home (general knowledge, not from ESPN)
HAND = {'Shakhtar Donetsk': 'Europe/Kyiv', 'Dynamo Kyiv': 'Europe/Kyiv', 'Dynamo Kiev': 'Europe/Kyiv', 'Zorya Luhansk': 'Europe/Kyiv', 'Oleksandriya': 'Europe/Kyiv',
        'Polissya Zhytomyr': 'Europe/Kyiv', 'Maccabi Tel Aviv': 'Asia/Jerusalem', 'Maccabi Haifa': 'Asia/Jerusalem', "Hapoel Be'er Sheva": 'Asia/Jerusalem',
        "Hapoel Be'er": 'Asia/Jerusalem', 'Hapoel Tel Aviv': 'Asia/Jerusalem', 'Besiktas': 'Europe/Istanbul', 'KuPS Kuopio': 'Europe/Helsinki',
        'Ararat-Armenia': 'Asia/Yerevan', 'Al Sadd': 'Asia/Qatar', 'Melbourne City FC': 'Australia/Melbourne', 'Auckland FC': 'Pacific/Auckland',
        'FC Dallas': 'America/Chicago', 'Cong An Ha Noi': 'Asia/Ho_Chi_Minh', 'Sabah FK': 'Asia/Baku', 'Kairat Almaty': 'Asia/Almaty', 'Iberia 1999': 'Asia/Tbilisi'}


def keyword_tz(lg, name):
    n = name.lower()
    if lg == 'usa.1':
        for k, tz in (('vancouver', 'America/Vancouver'), ('seattle', 'America/Los_Angeles'), ('portland', 'America/Los_Angeles'), ('san jose', 'America/Los_Angeles'),
                      ('la galaxy', 'America/Los_Angeles'), ('lafc', 'America/Los_Angeles'), ('los angeles', 'America/Los_Angeles'), ('san diego', 'America/Los_Angeles'),
                      ('colorado', 'America/Denver'), ('salt lake', 'America/Denver'), ('dallas', 'America/Chicago'), ('houston', 'America/Chicago'),
                      ('austin', 'America/Chicago'), ('kansas', 'America/Chicago'), ('chicago', 'America/Chicago'), ('minnesota', 'America/Chicago'),
                      ('nashville', 'America/Chicago'), ('st. louis', 'America/Chicago'), ('st louis', 'America/Chicago'), ('toronto', 'America/Toronto'),
                      ('montr', 'America/Toronto')):
            if k in n:
                return tz
        return 'America/New_York'
    if lg == 'mex.1':
        for k, tz in (('tijuana', 'America/Tijuana'), ('juárez', 'America/Ciudad_Juarez'), ('juarez', 'America/Ciudad_Juarez'), ('mazatl', 'America/Mazatlan'),
                      ('monterrey', 'America/Monterrey'), ('tigres', 'America/Monterrey'), ('santos', 'America/Monterrey')):
            if k in n:
                return tz
        return 'America/Mexico_City'
    if lg == 'aus.1':
        for k, tz in (('perth', 'Australia/Perth'), ('adelaide', 'Australia/Adelaide'), ('brisbane', 'Australia/Brisbane'), ('wellington', 'Pacific/Auckland'),
                      ('auckland', 'Pacific/Auckland'), ('melbourne', 'Australia/Melbourne'), ('western united', 'Australia/Melbourne')):
            if k in n:
                return tz
        return 'Australia/Sydney'
    return None


def venue_tz(r):
    co, city, reg = r['country'], r['city'] or '', r['region']
    if co in ('USA', 'United States', 'Canada'):
        if 'Vancouver' in city or reg == 'British Columbia':
            return 'America/Vancouver'
        if 'Toronto' in city or 'Montr' in city:
            return 'America/Toronto'
        for s, tz in US_STATE.items():
            if reg == s or city.endswith(s):
                return tz
        return 'America/New_York' if reg or city else None
    if co == 'Mexico':
        return next((tz for c, tz in MX_CITY.items() if c in city), 'America/Mexico_City')
    if co in ('Australia', 'New Zealand'):
        return next((tz for c, tz in AU_CITY.items() if c in city or c == reg), None)
    return COUNTRY.get(co)


def soccer_upcoming():
    f, to = window()
    pm = (f.replace(day=1) - timedelta(days=1))
    evs, failed = [], []
    for lg in LEAGUES:
        got = 0
        for y, m in months(pm, f, to):
            sb = get(f'{API}soccer/{lg}/scoreboard?dates={y}{m:02d}&limit=1000')
            if sb is None:
                failed.append(f'{lg} {y}{m:02d}')
                continue
            for e in sb.get('events') or []:
                r = ev_row(e)
                if r and r['hname'] and r['aname']:
                    r['lg'] = lg
                    r['hteam'], r['ateam'] = str(r['hid']), str(r['aid'])
                    evs.append(r)
                    got += 1
    if failed:
        warn('soccer scoreboards not fetched: ' + ', '.join(failed))
    if not evs:
        raise RuntimeError('no soccer scoreboards could be fetched')
    # club home zones: hand list, league keywords (MLS, Liga MX, A-League), the venue of a home match, then ESPN's team record
    home_venue = {}
    for r in sorted(evs, key=lambda r: r['t']):
        if not r['neutral'] and r['hname'] not in HAND:
            tz = venue_tz(r)
            if tz:
                home_venue.setdefault(r['hname'], tz)
    zone_of, unknown = {}, set()

    def club(lg, name, tid):
        if name in zone_of:
            return zone_of[name]
        tz = HAND.get(name) or keyword_tz(lg, name) or home_venue.get(name)
        if not tz:
            d = cached_get(f'{API}soccer/{lg}/teams/{tid}', f'team_soccer_{lg}_{tid}.json')
            slug = nested(d, 'team', 'defaultLeague', 'slug') or ''
            tz = SLUG.get(slug.split('.')[0])
        zone_of[name] = tz
        if not tz:
            unknown.add(name)
        return tz
    games, seen = [], set()
    for r in sorted(evs, key=lambda r: r['t']):
        d = etd(r['t'])
        if r['id'] in seen or r['state'] == 'post' or not (f <= d <= to):
            continue
        seen.add(r['id'])
        lg = r['lg']
        if any(re.search(r'\b(TBD|TBA|Winner|Loser)\b', n) for n in (r['hname'], r['aname'])):
            continue  # knockout placeholders
        th, ta = club(lg, r['hname'], r['hteam']), club(lg, r['aname'], r['ateam'])
        if not th or not ta:
            continue
        gap = abs(off(th, r['t']) - off(ta, r['t']))
        if gap < 2:
            continue
        us = {'America/Los_Angeles': 'Pacific', 'America/Vancouver': 'Pacific', 'America/Denver': 'Mountain', 'America/Chicago': 'Central',
              'America/New_York': 'Eastern', 'America/Toronto': 'Eastern'}
        zh_, za_ = us.get(th), us.get(ta)
        pe = lg == 'usa.1' and is_pe(za_, zh_)
        late = r['t'].astimezone(ET).hour >= 20
        c = lambda n, tz: {'abbr': n, 'name': n, 'zone': tz.split('/')[-1].replace('_', ' '), 'tz': tz}
        if lg == 'usa.1' and pe:
            west = r['hname'] if zh_ == 'Pacific' else r['aname']
            why = (f"MLS Pacific vs Eastern at 8 PM ET or later: the reel's rule would back {west}. Our MLS test found no edge against the odds." if late else
                   'MLS Pacific vs Eastern, but before 8 PM ET.')
        elif lg == 'usa.1' and za_ and zh_:
            a_, b_ = sorted((za_, zh_), key=['Pacific', 'Mountain', 'Central', 'Eastern'].index)
            why = f"MLS {a_} vs {b_}: a {hrs(gap)}-hour gap, not the Pacific vs Eastern match-up the rule is about."
        else:
            why = f"Home zones {hrs(gap)} hours apart. The reel's idea has not been shown to matter in soccer."
        o = (r['odds'] or [None])[0]
        nv = None
        if o:
            g3 = lambda s: mli(nested(o, 'moneyline', s, 'close', 'odds'))
            nv = novig(g3('home'), g3('draw'), g3('away'))
        g = {'sport': 'soccer', 'league': LEAGUES[lg], 'espnId': r['id'], 'label': f"{r['hname']} v {r['aname']}", 'slot': '', 'kickoffUTC': iso(r['t']),
             'away': c(r['aname'], ta), 'home': c(r['hname'], th), 'venue': ', '.join(x for x in (r['city'], r['region'], r['country']) if x),
             'applies': bool(pe and late), 'gap': gap, 'why': why,
             'odds': {'text': '3-way, margin removed', 'book': nested(o, 'provider', 'name') or 'DraftKings', 'noVig': {'home': nv[0], 'draw': nv[1], 'away': nv[2]}} if nv else None}
        if pe:
            g['west'] = west
            if g['applies']:
                g['westLine'] = None
        games.append(g)
    if unknown:
        warn(f"{len(unknown)} soccer clubs with no known home zone (their games skipped): " + ', '.join(sorted(unknown)[:8]))
    return games


# ================================================================ assemble
BANNED = re.compile(r'\b(lock|locks|guarantee|guaranteed|due)\b', re.I)


def check_words(obj, path=''):
    if isinstance(obj, str):
        if BANNED.search(obj):
            warn(f'banned word in {path}: {obj[:80]}')
    elif isinstance(obj, dict):
        for k, v in obj.items():
            check_words(v, f'{path}.{k}')
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            check_words(v, f'{path}[{i}]')


def main():
    old = jload(OUT) or {}
    out = {'updated': iso(NOW).replace('Z', ':00Z'), 'research': None, 'season2026': None, 'upcoming': None, 'mnf': None, 'lastMnf': None}
    built = []

    def section(key, fn):
        try:
            out[key] = fn()
            built.append(key)
        except Exception as e:  # noqa: BLE001
            warn(f"{key}: {type(e).__name__}: {e} (kept the previous {key})")
            out[key] = old.get(key)
    section('research', lambda: jload(RESEARCH) or (_ for _ in ()).throw(RuntimeError('tools/bodyclock_research.json missing')))
    nfl = {}
    try:
        nfl['Y'], nfl['rows'] = nfl_rows()
    except Exception as e:  # noqa: BLE001
        warn(f'NFL: {e}')
    need = lambda: nfl.get('rows') or (_ for _ in ()).throw(RuntimeError('no NFL schedule'))
    # upcoming: per sport, falling back to the old file's games of that sport that have not started
    f, to = window()
    parts, sport_ok, notes, sport_bad = {}, {}, [], []
    oldg = [g for g in (old.get('upcoming') or {}).get('games') or [] if g.get('kickoffUTC') and P(g['kickoffUTC']) > NOW]
    for sp, fn in (('nfl', lambda: nfl_upcoming(need())), ('nba', nba_upcoming), ('soccer', soccer_upcoming)):
        try:
            parts[sp] = fn()
            sport_ok[sp] = True
        except Exception as e:  # noqa: BLE001
            warn(f'upcoming {sp}: {type(e).__name__}: {e} (kept the previous {sp} games that have not started)')
            sport_ok[sp] = False
            sport_bad.append(sp)
    if any(sport_ok.values()):
        games = []
        if sport_ok.get('nfl'):
            ng, tbd = parts['nfl']
            games += ng
            near = [g for g in ng if etd(P(g['kickoffUTC'])) <= to]
            app = [g['label'] for g in near if g['applies']]
            notes.append(f"NFL: {len(near)} night {'game' if len(near) == 1 else 'games'} (8 PM ET or later) through {mday(to)}; the rule applies to "
                         + (join(app) if app else 'none of them') + '.')
            lat = [g for g in ng if etd(P(g['kickoffUTC'])) > to]
            if lat:
                notes.append(f"Later this season: {len(lat)} more Pacific vs Eastern night {'game' if len(lat) == 1 else 'games'} ("
                             + join(f"{g['label']} {mday(etd(P(g['kickoffUTC'])))}" for g in lat) + ').')
            pe_tbd = [r for r, pe in tbd if pe]
            if tbd:
                notes.append(f"{len(tbd)} later NFL {'game has' if len(tbd) == 1 else 'games have'} no kickoff time yet (ESPN TBD)"
                             + (f"; {join(r['short'] for r in pe_tbd)} would count if set at 8 PM ET or later." if pe_tbd else '; none is Pacific vs Eastern.'))
        else:
            games += [g for g in oldg if g['sport'] == 'nfl']
        if sport_ok.get('nba'):
            near, later = parts['nba']
            games += near + later
            pe_near = [g for g in near if 'west' in g]
            if not pe_near:
                notes.append('No Pacific vs Eastern NBA game in the next 8 days' + (f"; the next is {later[0]['label']} on {etd(P(later[0]['kickoffUTC'])):%a} {mday(etd(P(later[0]['kickoffUTC'])))}."
                                                                                     if later else ' or the 30 days after.'))
            else:
                notes.append(f"NBA: {len(pe_near)} Pacific vs Eastern {'game' if len(pe_near) == 1 else 'games'} in the next 8 days; "
                             f"{sum(g['applies'] for g in pe_near)} tip at 8 PM ET or later.")
        else:
            games += [g for g in oldg if g['sport'] == 'nba']
        if sport_ok.get('soccer'):
            sg = parts['soccer']
            games += sg
            mls_ = [g for g in sg if g['league'] == 'MLS']
            if mls_ and not any('west' in g for g in mls_):
                pairs = sorted({re.match(r'MLS (\w+ vs \w+)', g['why']).group(1) for g in mls_ if re.match(r'MLS (\w+ vs \w+)', g['why'])})
                notes.append(f"MLS games with clubs 2+ hours apart this week are {join(pairs)}, not Pacific vs Eastern." if pairs else
                             'No MLS game this week is Pacific vs Eastern.')
            elif not mls_:
                notes.append('No MLS game in this window has clubs 2+ hours apart.')
        else:
            games += [g for g in oldg if g['sport'] == 'soccer']
        notes.append("These games prove nothing either way: they show where the reel's rule would point, priced by the market.")
        out['upcoming'] = {'from': str(f), 'to': str(to), 'notes': notes, 'games': games}
        built.append('upcoming')
    else:
        out['upcoming'] = old.get('upcoming')
    section('season2026', lambda: nfl_season_so_far(need()))
    mnf_row = [None]

    def mk_mnf():
        m, r = build_mnf(nfl.get('Y'), need())
        mnf_row[0] = r
        return m
    section('mnf', mk_mnf)
    section('lastMnf', lambda: build_last_mnf(need(), season_nfl()))
    if not set(built) - {'research'}:
        print('Nothing could be built; bodyclock.json left as it was.', file=sys.stderr)
        return 1
    check_words({k: out[k] for k in ('upcoming', 'mnf', 'lastMnf')})
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
    os.replace(tmp, OUT)
    # ---- one-screen summary
    up = (out['upcoming'] or {}).get('games') or []
    print(f"bodyclock.json: {os.path.getsize(OUT):,} bytes, updated {out['updated']}; window {(out['upcoming'] or {}).get('from')} to {(out['upcoming'] or {}).get('to')}")
    print(f"requests: {STATS['fetched']} fetched, {STATS['cached']} from cache, {STATS['failed']} failed; sections built: {', '.join(built)}")
    for sp in ('nfl', 'nba', 'soccer'):
        g = [x for x in up if x['sport'] == sp]
        print(f"  {sp:6} {len(g):3} games ({sum(1 for x in g if x.get('odds'))} with odds){'  [kept from the old file]' if sp in sport_bad else ''}")
    ap = [x for x in up if x['applies']]
    print('  rule applies: ' + (', '.join(f"{x['sport'].upper()} {x['label']} ({x['kickoffUTC'][:10]}, west {x.get('west')} {x.get('westLine') if x.get('westLine') is not None else 'no line'})" for x in ap) or 'none'))
    m = out['mnf']
    if m:
        mk = m.get('market') or {}
        print(f"  Monday night: {m['away']['abbr']} @ {m['home']['abbr']} {m['kickoffUTC']} week {m['week']}; "
              f"odds {'found: ' + str(mk.get('fav')) + ' ' + str(mk.get('spread')) + ', total ' + str(mk.get('total')) if mk else 'not found'}; "
              f"predictor {'yes' if m.get('predictor') else 'no'}; Polymarket {'matched' if m.get('polymarket') else 'no match'}; "
              f"h2h {len(m['h2h']['games'])}; injuries {len(m['injuries']['away'])}+{len(m['injuries']['home'])}; facts {len(m['facts'])}")
    else:
        print('  Monday night: none ahead')
    lm = out['lastMnf']
    if lm:
        print(f"  last Monday: {lm['label']} {lm['date']}: {lm['final']}; {lm['line']}; beat {len(lm['beat'])}, short {len(lm['short'])}; "
              f"app legs {'yes' if lm.get('appLegs') else 'none'}; final cross-checked with the app feed: {'yes' if STATS['final_checked'] else 'no'}")
    print(f"  season so far: {len(out['season2026'] or [])} Pacific vs Eastern night games played")
    for w in WARN:
        print('  warning:', w)
    return 0


if __name__ == '__main__':
    sys.exit(main())
