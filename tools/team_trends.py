#!/usr/bin/env python3
"""Per-team patterns by day, week and month, and what they say about each team's next game. Writes trends.json for the
📈 Team Trends tab (trends.js).

    python3 tools/team_trends.py [--end YYYY-MM-DD] [--feed data.json] [--out trends.json] [--fd DIR] [--offline] [--no-nba]

Soccer: football-data.co.uk 2026-27 season files (results + closing average odds), fetched live from
  https://www.football-data.co.uk/mmz4281/2627/<L>.csv. A league that can't be fetched (or --offline / --fd DIR) is read from
  tests/fixtures/fd/<L>.csv instead. Finished games in data.json after a league's CSV ends are added without prices.
NBA: ESPN's public team schedules (final scores) and each finished game's summary (the moneylines and total ESPN shows from
  its betting partner, "pickcenter"). Lines of finished games never change, so they are cached in ~/.cache/safe-bets/.

Per team, for the last 7 days, the last 30 days, the season and each calendar month:
  n, w-d-l, goals/points for and against per game, average game total,
  ov  = over rate (soccer: over 2.5 goals; NBA: game total over the team's own season-average game total),
  ovx = soccer over 2.5 in priced games vs what the closing over/under prices expected,
  ln  = NBA game total over the posted total, vs the over/under prices,
  fav / dog = games priced as favourite / underdog: won vs expected (sum of no-vig chances), flat-stake return at the posted
        price, and z (how many standard deviations the wins are from the prices; |z| < 2 is easily chance),
  vp  = every priced game: won vs expected.
Plus current streaks, and the next game from the app's feed (data.json) with an "upset watch" flag (an underdog beating its
prices, or a favourite that keeps failing them) and an over/under lean, each with its evidence and sample sizes. These are
past patterns, not predictions: the same lean logic runs live in trends.js on the hourly feed.
"""
import csv, io, json, math, os, re, sys, time, unicodedata, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    LA = ZoneInfo('America/Los_Angeles')
except Exception:  # noqa: BLE001
    LA = timezone(timedelta(hours=-8))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
OFFLINE, NO_NBA = '--offline' in args, '--no-nba' in args
FD = opt('--fd', None)
FEED, OUT = opt('--feed', os.path.join(ROOT, 'data.json')), opt('--out', os.path.join(ROOT, 'trends.json'))
END = datetime.strptime(opt('--end', ''), '%Y-%m-%d').date() if '--end' in args else datetime.now(LA).date()
CACHE = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'safe-bets', 'nba_lines.json')
LEAGUES = ['E0', 'E1', 'SP1', 'I1', 'D1', 'F1', 'N1', 'P1', 'SC0', 'B1', 'T1', 'G1']
NAMES = {'E0': 'Premier League', 'E1': 'Championship', 'SP1': 'La Liga', 'I1': 'Serie A', 'D1': 'Bundesliga', 'F1': 'Ligue 1',
         'N1': 'Eredivisie', 'P1': 'Primeira Liga', 'SC0': 'Scottish Premiership', 'B1': 'Belgian Pro League', 'T1': 'Super Lig', 'G1': 'Greek Super League'}
ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app'}), timeout=30) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                log('fetch failed', url, e)
                return None
            time.sleep(1.5 * (i + 1))


def getj(url):
    b = fetch(url)
    try:
        return json.loads(b.decode()) if b else None
    except ValueError:
        return None


# ---------- team-name matching (football-data.co.uk names <-> the feed's names); trends.js uses the same tokens ----------
STOP = set('fc cf ac afc sc as ssc us bc cfc ud cd rc rcd calcio club de sco osc ogc aj estac fsv sv tsg vfb vfl sk the and'.split())
GENERIC = set('real united city racing sporting athletic olympique stade borussia inter saint st club town'.split())
ALIAS = {'Man United': 'Manchester United', 'Man City': 'Manchester City', "Nott'm Forest": 'Nottingham Forest', 'Ath Bilbao': 'Athletic Bilbao',
         'Ath Madrid': 'Atletico Madrid', 'Espanol': 'Espanyol', 'Sociedad': 'Real Sociedad', 'Vallecano': 'Rayo Vallecano', 'Betis': 'Real Betis',
         'Celta': 'Celta Vigo', 'La Coruna': 'Deportivo Coruna', 'Santander': 'Racing Santander', 'Ein Frankfurt': 'Eintracht Frankfurt',
         "M'gladbach": 'Monchengladbach', 'FC Koln': 'Cologne', 'Paris SG': 'Paris Saint Germain', 'Inter': 'Inter Milano', 'Rennes': 'Rennais',
         'Hamburg': 'Hamburger', 'Sp Lisbon': 'Sporting Lisbon', 'Sp Braga': 'Braga', 'For Sittard': 'Fortuna Sittard', 'Nijmegen': 'NEC Nijmegen',
         'Den Haag': 'ADO Den Haag', 'Olympiakos': 'Olympiacos', 'St. Gilloise': 'Union Saint Gilloise', 'Guimaraes': 'Vitoria Guimaraes',
         'Buyuksehyr': 'Basaksehir', 'Goztep': 'Goztepe'}


def toks(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return [t for t in re.split(r'[^a-z0-9]+', s) if t and t not in STOP and not t.isdigit()]


def tmatch(a, b):  # a = team tokens, b = feed-name tokens -> (share of a matched, jaccard, a distinctive token matched)
    if not a or not b:
        return 0, 0, False
    m, strong = 0, False
    for t in a:
        if any(t == f or (len(t) >= 5 and len(f) >= 5 and (f.startswith(t) or t.startswith(f))) for f in b):
            m += 1
            strong = strong or (len(t) >= 3 and t not in GENERIC)
    return m / len(a), m / (len(a) + len(b) - m), strong


def assign(team_toks, feed):  # one-to-one, best pairs first. team_toks {key: tokens}; feed {name: tokens} -> {key: name}
    pairs = []
    for k, a in team_toks.items():
        for nm, b in feed.items():
            s, j, strong = tmatch(a, b)
            if s >= .5 and strong:
                pairs.append((s, j, k, nm))
    out, used = {}, set()
    for s, j, k, nm in sorted(pairs, reverse=True):
        if k not in out and nm not in used:
            out[k] = nm
            used.add(nm)
    return out


# ---------- numbers ----------
def fnum(x):
    try:
        v = float(x)
        return v if v > 1.0 else None
    except (TypeError, ValueError):
        return None


def am2dec(a):
    try:
        a = float(a)
    except (TypeError, ValueError):
        return None
    return 1 + a / 100 if a > 0 else 1 + 100 / -a if a < 0 else None


def novig(*decs):
    inv = [1 / d for d in decs]
    s = sum(inv)
    return [x / s for x in inv]


r1 = lambda x: None if x is None else round(x, 1)
r2 = lambda x: None if x is None else round(x, 2)


# ---------- soccer ----------
def load_soccer():
    games, src, csv_end = [], {}, {}
    for L in LEAGUES:
        text, where = None, None
        if not OFFLINE and not FD:
            b = fetch(f'https://www.football-data.co.uk/mmz4281/2627/{L}.csv')
            if b and b[:3] in (b'\xef\xbb\xbfD', b'Div') or (b and b.lstrip(b'\xef\xbb\xbf').startswith(b'Div')):
                text, where = b.decode('utf-8-sig', 'replace'), 'live'
        if text is None:
            p = os.path.join(FD or os.path.join(ROOT, 'tests', 'fixtures', 'fd'), L + '.csv')
            if os.path.exists(p):
                text, where = open(p, encoding='utf-8-sig').read(), 'saved copy'
        if text is None:
            log('no data for', L)
            continue
        n0 = len(games)
        for r in csv.DictReader(io.StringIO(text)):
            try:
                ds = r['Date']
                d = datetime.strptime(ds, '%d/%m/%Y' if len(ds) > 8 else '%d/%m/%y').date()
                hg, ag = int(r['FTHG']), int(r['FTAG'])
            except (KeyError, ValueError, TypeError):
                continue
            if d > END:
                continue
            o = None
            for pre in ('AvgC', 'PSC', 'B365C', 'Avg', 'B365'):
                h, dr, a = fnum(r.get(pre + 'H')), fnum(r.get(pre + 'D')), fnum(r.get(pre + 'A'))
                if h and dr and a:
                    o = (h, dr, a)
                    break
            ou = None
            for pre in ('AvgC', 'PC', 'B365C', 'Avg', 'B365'):
                ov, un = fnum(r.get(pre + '>2.5')), fnum(r.get(pre + '<2.5'))
                if ov and un:
                    ou = novig(ov, un)[0]
                    break
            games.append({'date': d.isoformat(), 'lg': L, 'comp': NAMES[L], 'home': r['HomeTeam'].strip(), 'away': r['AwayTeam'].strip(), 'hg': hg, 'ag': ag,
                          'p': novig(*o) if o else None, 'dec': list(o) if o else None, 'pov': ou})
        lg_games = games[n0:]
        src[L] = {'from': where, 'games': len(lg_games), 'last': max((g['date'] for g in lg_games), default=None)}
        csv_end[NAMES[L]] = src[L]['last'] or '0000'
    return games, src, csv_end


def feed_soccer(feed, games, csv_end):
    """finished feed games after each league's CSV ends (no prices: they count for results, goals and over rate only)"""
    names = {}
    for g in games:
        names.setdefault(g['comp'], set()).update((g['home'], g['away']))
    maps, added = {}, 0
    for comp, teams in names.items():
        fn = {}
        for g in feed:
            if g.get('sport') == 'soccer' and g.get('comp') == comp:
                for s in ('home', 'away'):
                    fn[g[s]['name']] = toks(g[s]['name'])
        maps[comp] = {v: k for k, v in assign({t: toks(ALIAS.get(t, t)) for t in teams}, fn).items()}  # feed name -> csv name
    have = {(g['date'], g['home']) for g in games}
    for g in feed:
        if g.get('sport') != 'soccer' or g.get('status') != 'closed' or not g.get('score') or g.get('comp') not in maps:
            continue
        d = start_la(g['start']).isoformat()
        if not (csv_end.get(g['comp'], '0000') < d <= END.isoformat()):
            continue
        h, a = maps[g['comp']].get(g['home']['name']), maps[g['comp']].get(g['away']['name'])
        if not h or not a or (d, h) in have:
            continue
        lg = next(k for k, v in NAMES.items() if v == g['comp'])
        games.append({'date': d, 'lg': lg, 'comp': g['comp'], 'home': h, 'away': a, 'hg': int(g['score']['home']), 'ag': int(g['score']['away']),
                      'p': None, 'dec': None, 'pov': None, 'feed': True})
        have.add((d, h))
        added += 1
    return added


def start_la(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(LA).date()


# ---------- NBA ----------
def load_nba():
    d = getj(f'{ESPN}/teams')
    if not d:
        return None, None
    teams = {t['team']['id']: t['team'] for t in d['sports'][0]['leagues'][0]['teams']}
    with ThreadPoolExecutor(8) as ex:
        sch = dict(zip(teams, ex.map(lambda i: getj(f'{ESPN}/teams/{i}/schedule'), teams)))
    events = {}
    for tid, s in sch.items():
        for e in (s or {}).get('events', []):
            c = e['competitions'][0]
            if not c['status']['type'].get('completed') or (e.get('seasonType') or {}).get('type', 2) != 2:
                continue
            side = {x['homeAway']: x for x in c['competitors']}
            try:
                hs, as_ = int(float(side['home']['score']['value'])), int(float(side['away']['score']['value']))
            except (KeyError, TypeError, ValueError):
                continue
            events[e['id']] = {'id': e['id'], 'date': start_la(e['date']).isoformat(), 'start': e['date'], 'h': side['home']['team']['id'], 'a': side['away']['team']['id'], 'hs': hs, 'as': as_}
    try:
        cache = json.load(open(CACHE))
    except (OSError, ValueError):
        cache = {}
    need = [i for i, e in events.items() if i not in cache and e['date'] <= END.isoformat()]

    def line(eid):
        s = getj(f'{ESPN}/summary?event={eid}')
        if s is None:
            return eid, None
        pc = sorted(s.get('pickcenter') or [], key=lambda x: (x.get('provider') or {}).get('priority', 99))
        if not pc:
            return eid, {}
        x = pc[0]
        return eid, {'ou': x.get('overUnder'), 'spread': x.get('spread'), 'details': x.get('details'), 'oo': x.get('overOdds'), 'uo': x.get('underOdds'),
                     'hml': (x.get('homeTeamOdds') or {}).get('moneyLine'), 'aml': (x.get('awayTeamOdds') or {}).get('moneyLine'),
                     'hfav': (x.get('homeTeamOdds') or {}).get('favorite'), 'book': (x.get('provider') or {}).get('name')}
    if need:
        with ThreadPoolExecutor(12) as ex:
            for eid, v in ex.map(line, need):
                if v is not None:
                    cache[eid] = v
        try:
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            json.dump(cache, open(CACHE, 'w'))
        except OSError:
            pass
    games = []
    for e in sorted(events.values(), key=lambda e: e['start']):
        if e['date'] > END.isoformat():
            continue
        L = cache.get(e['id']) or {}
        hd, ad = am2dec(L.get('hml')), am2dec(L.get('aml'))
        p = dec = None
        if hd and ad:
            ph, pa = novig(hd, ad)
            p, dec = [ph, 0, pa], [hd, None, ad]
        elif L.get('spread') is not None and L.get('hfav') is not None:  # spread only: a normal margin model (sd 12.5)
            s = abs(float(L['spread'])) * (1 if L['hfav'] else -1)
            ph = 0.5 * (1 + math.erf(s / 12.5 / math.sqrt(2)))
            p = [ph, 0, 1 - ph]
        ou = float(L['ou']) if L.get('ou') else None
        oo, uo = am2dec(L.get('oo')), am2dec(L.get('uo'))
        games.append({'date': e['date'], 'comp': 'NBA', 'home': e['h'], 'away': e['a'], 'hg': e['hs'], 'ag': e['as'], 'p': p, 'dec': dec,
                      'line': ou, 'pov': novig(oo, uo)[0] if oo and uo else (0.5 if ou else None), 'eid': e['id']})
    return teams, games


# ---------- per-team summaries ----------
def entries(games, sport):
    T = {}
    for g in games:
        for me in ('home', 'away'):
            h = me == 'home'
            gf, ga = (g['hg'], g['ag']) if h else (g['ag'], g['hg'])
            p = g['p']
            pw, pl = (p[0], p[2]) if p and h else (p[2], p[0]) if p else (None, None)
            dec = g['dec'][0 if h else 2] if g.get('dec') else None
            tot = gf + ga
            e = {'date': g['date'], 'home': h, 'opp': g['away' if h else 'home'], 'gf': gf, 'ga': ga, 'res': 'W' if gf > ga else 'L' if gf < ga else 'D',
                 'pw': pw, 'pl': pl, 'dec': dec, 'tot': tot}
            if sport == 'soccer':
                e['ov'] = tot > 2.5
                e['pov'] = g['pov']
            else:
                e['line'] = g.get('line')
                e['pov'] = g.get('pov')
            T.setdefault((g['comp'] if sport == 'soccer' else 'NBA', g[me]), []).append(e)
    for k in T:
        T[k].sort(key=lambda e: e['date'])
    return T


def rec(xs):  # won-vs-priced block over entries xs (each with pw, res, dec)
    if not xs:
        return {'n': 0}
    won = sum(1 for e in xs if e['res'] == 'W')
    exp = sum(e['pw'] for e in xs)
    var = sum(e['pw'] * (1 - e['pw']) for e in xs)
    out = {'n': len(xs), 'won': won, 'exp': r2(exp), 'z': r2((won - exp) / math.sqrt(var)) if var > 0 else None}
    pr = [(e['dec'] - 1 if e['res'] == 'W' else -1) for e in xs if e.get('dec')]
    if pr:
        out['roi'] = round(sum(pr) / len(pr), 3)
    return out


def summ(es, sport, avg_tot=None):
    n = len(es)
    if not n:
        return {'n': 0}
    s = {'n': n, 'w': sum(e['res'] == 'W' for e in es), 'd': sum(e['res'] == 'D' for e in es), 'l': sum(e['res'] == 'L' for e in es),
         'gf': r2(sum(e['gf'] for e in es) / n), 'ga': r2(sum(e['ga'] for e in es) / n), 'avgT': r1(sum(e['tot'] for e in es) / n)}
    if sport == 'soccer':
        s['ov'] = {'n': n, 'hit': sum(e['ov'] for e in es)}
        px = [e for e in es if e['pov'] is not None]
        s['ovx'] = {'n': len(px), 'hit': sum(e['ov'] for e in px), 'exp': r2(sum(e['pov'] for e in px))}
    else:
        if avg_tot:
            s['ov'] = {'n': n, 'hit': sum(e['tot'] > avg_tot for e in es)}
        lx = [e for e in es if e.get('line') and e['tot'] != e['line']]
        s['ln'] = {'n': len(lx), 'hit': sum(e['tot'] > e['line'] for e in lx), 'exp': r2(sum(e['pov'] or .5 for e in lx)),
                   'avgLine': r1(sum(e['line'] for e in lx) / len(lx)) if lx else None}
    pe = [e for e in es if e['pw'] is not None]
    s['vp'] = rec(pe)
    s['fav'] = rec([e for e in pe if e['pw'] > e['pl']])
    s['dog'] = rec([e for e in pe if e['pw'] < e['pl']])
    return s


def streaks(es, sport):
    out = {}
    if not es:
        return out
    last = es[-1]['res']
    k = 0
    for e in reversed(es):
        if e['res'] != last:
            break
        k += 1
    out['res'] = f'{last}{k}'
    ub = 0
    for e in reversed(es):
        if e['res'] == 'L':
            break
        ub += 1
    wl = 0
    for e in reversed(es):
        if e['res'] == 'W':
            break
        wl += 1
    if sport == 'soccer':
        out['unbeaten'], out['winless'] = ub, wl
        key = lambda e: 'O' if e['ov'] else 'U'
        seq = es
    else:
        key = lambda e: 'O' if e['tot'] > e['line'] else 'U'
        seq = [e for e in es if e.get('line') and e['tot'] != e['line']]
    if seq:
        f = key(seq[-1])
        k = 0
        for e in reversed(seq):
            if key(e) != f:
                break
            k += 1
        out['ou'] = f'{f}{k}'
    out['last5'] = ''.join(e['res'] for e in es[-5:])
    return out


def windows(es, sport):
    avg = sum(e['tot'] for e in es) / len(es) if es else None
    d7, d30 = (END - timedelta(days=6)).isoformat(), (END - timedelta(days=29)).isoformat()
    w = {'d7': summ([e for e in es if e['date'] >= d7], sport, avg), 'd30': summ([e for e in es if e['date'] >= d30], sport, avg), 'season': summ(es, sport, avg)}
    months = {}
    for m in sorted({e['date'][:7] for e in es}):  # slimmer: results, goals, over rate and wins vs prices
        x = summ([e for e in es if e['date'][:7] == m], sport, avg)
        months[m] = {k: v for k, v in x.items() if k not in ('fav', 'dog', 'ovx', 'ln')}
        if 'roi' in x['vp']:
            del months[m]['vp']['roi']
    return w, months


# ---------- leans (trends.js runs the same rules on the live feed) ----------
MINN = {'soccer': 4, 'nba': 5}
MIN_DOG = {'soccer': .15, 'nba': .2}  # an underdog below this is a long shot whatever the pattern says: no upset flag


def tag(b):
    t = []
    if b['n'] < 10:
        t.append('small sample')
    if b.get('z') is not None and abs(b['z']) < 2:
        t.append('could be chance')
    return f" ({', '.join(t)})" if t else ''


def pct(x):
    return f'{round(x * 100)}%'


def upset_reasons(dog, fav, sport):
    """dog = the underdog's team record (or None), fav = the favourite's. -> (reasons, strength)"""
    R, s, mn = [], 0.0, MINN[sport]
    if dog:
        b = dog['windows']['season'].get('dog') or {'n': 0}
        if b['n'] >= mn and b['won'] - b['exp'] >= 1:
            R.append(f"{dog['name']} as an underdog this season: won {b['won']} of {b['n']}, prices expected {b['exp']:.1f}{tag(b)}")
            s += b['won'] - b['exp']
        b = dog['windows']['d30'].get('vp') or {'n': 0}
        if b['n'] >= mn and b['won'] - b['exp'] >= 1:
            R.append(f"{dog['name']} in the last 30 days: won {b['won']} of {b['n']}, prices expected {b['exp']:.1f}{tag(b)}")
            s += (b['won'] - b['exp']) / 2
    if fav:
        b = fav['windows']['season'].get('fav') or {'n': 0}
        if b['n'] >= mn and b['won'] - b['exp'] <= -1:
            R.append(f"{fav['name']} as a favourite this season: won {b['won']} of {b['n']}, prices expected {b['exp']:.1f}{tag(b)}")
            s += b['exp'] - b['won']
    return R, round(s, 2)


def total_lean(teams, sport, line=None):
    """teams = the trends records of the two sides that we have. -> {side, why[], n, strength}"""
    teams = [t for t in teams if t]
    why, side, strength = [], None, 0.0
    if not teams:
        return {'side': None, 'why': [], 'n': 0}
    if sport == 'soccer':
        N = H = Np = Hp = 0
        Ep = 0.0
        for t in teams:
            s = t['windows']['season']
            o, x = s.get('ov') or {'n': 0, 'hit': 0}, s.get('ovx') or {'n': 0, 'hit': 0, 'exp': 0}
            N += o['n']; H += o['hit']; Np += x['n']; Hp += x['hit']; Ep += x['exp'] or 0
            why.append(f"{t['name']} games: {o['hit']} of {o['n']} over 2.5" + (f" (prices expected {x['exp']:.1f} of {x['n']})" if x['n'] else ''))
        rate = H / N if N else 0
        ex = Hp - Ep
        if N >= 10:
            if rate >= .6 and (Np < 6 or ex >= 1.5):
                side = 'over'
            elif rate <= .4 and (Np < 6 or ex <= -1.5):
                side = 'under'
        strength = abs(rate - .5) * 2 + (abs(ex) / max(Np, 1) if Np else 0)
        why.append(f"Together: {H} of {N} ({pct(rate) if N else '—'}) over 2.5" + (f", {ex:+.1f} against the prices" if Np else '') + (' (small sample)' if N < 20 else ''))
        n = N
    else:
        N = H = 0
        for t in teams:
            b = t['windows']['season'].get('ln') or {'n': 0, 'hit': 0}
            N += b['n']; H += b['hit']
            why.append(f"{t['name']} games: {b['hit']} of {b['n']} went over the posted total")
        rate = H / N if N else 0
        if N >= 12:
            side = 'over' if rate >= .6 else 'under' if rate <= .4 else None
        if N:
            why.append(f"Together: {H} of {N} ({pct(rate)}) over the line" + (' (small sample)' if N < 20 else ''))
        else:  # no posted lines: game totals against each team's own season average, last 30 days
            N = sum((t['windows']['d30'].get('ov') or {'n': 0})['n'] for t in teams)
            H = sum((t['windows']['d30'].get('ov') or {'hit': 0})['hit'] for t in teams)
            rate = H / N if N else 0
            if N >= 10:
                side = 'over' if rate >= .65 else 'under' if rate <= .35 else None
            why.append(f"Last 30 days: {H} of {N} games went over the teams' own season-average total")
        av = [t['windows']['d30'].get('avgT') for t in teams if t['windows']['d30'].get('n')]
        if line and av:
            m = sum(av) / len(av)
            why.append(f"Their last-30-day games averaged {m:.1f} points; this game's posted total is {line}")
            if side == 'over' and m < line - 3 or side == 'under' and m > line + 3:
                side = None
                why.append('The average disagrees with the trend, so no lean')
        strength = abs(rate - .5) * 2
        n = N
    return {'side': side, 'why': why, 'n': n, 'strength': round(strength, 3)}


# ---------- main ----------
def main():
    try:
        feed = json.load(open(FEED)).get('games', [])
    except (OSError, ValueError):
        feed = []
        log('no feed at', FEED)
    sources = {}
    sg, ssrc, csv_end = load_soccer()
    added = feed_soccer(feed, sg, csv_end)
    sources['soccer'] = {'csv': 'football-data.co.uk 2026-27 results with closing average odds', 'leagues': ssrc, 'feedResultsAdded': added}
    out_teams = []
    S = entries(sg, 'soccer')
    # map each CSV team to the feed's name / abbreviation (same competition)
    feedteams = {}
    for g in feed:
        if g.get('sport') == 'soccer':
            for s in ('home', 'away'):
                feedteams.setdefault(g['comp'], {})[g[s]['name']] = g[s]['abbr']
    for comp in sorted({k[0] for k in S}):
        names = [k[1] for k in S if k[0] == comp]
        fn = feedteams.get(comp, {})
        mp = assign({t: toks(ALIAS.get(t, t)) for t in names}, {n: toks(n) for n in fn})
        for t in names:
            es = S[(comp, t)]
            w, months = windows(es, 'soccer')
            fname = mp.get(t)
            out_teams.append({'sport': 'soccer', 'comp': comp, 'name': fname or t, 'csv': t, 'abbr': fn.get(fname) if fname else None,
                              'tokens': toks(ALIAS.get(t, t)), 'windows': w, 'months': months, 'streak': streaks(es, 'soccer')})
    if not OFFLINE and not NO_NBA:
        nt, ng = load_nba()
        if nt:
            fe = {}
            for g in feed:
                if g.get('sport') == 'nba':
                    for s in ('home', 'away'):
                        fe[g[s]['name']] = g[s]['abbr']
            mp = assign({i: toks(t['name']) for i, t in nt.items()}, {n: toks(n) for n in fe})
            N = entries(ng, 'nba')
            for tid, t in nt.items():
                es = N.get(('NBA', tid), [])
                for e in es:
                    e['opp'] = nt[e['opp']]['abbreviation'] if e['opp'] in nt else e['opp']
                w, months = windows(es, 'nba')
                out_teams.append({'sport': 'nba', 'comp': 'NBA', 'name': mp.get(tid) or t['displayName'], 'abbr': fe.get(mp.get(tid)) or t['abbreviation'], 'espn': t['abbreviation'], 'espnId': tid,
                                  'tokens': toks(t['name']), 'windows': w, 'months': months, 'streak': streaks(es, 'nba')})
            lined = sum(1 for g in ng if g.get('line'))
            sources['nba'] = {'scores': 'ESPN team schedules (regular season)', 'lines': 'ESPN game summaries (pickcenter: moneyline and total from its betting partner)',
                              'games': len(ng), 'withLines': lined, 'withPrices': sum(1 for g in ng if g.get('p'))}
            # posted lines for upcoming NBA games (ESPN scoreboard), for the total lean
            nba_lines = {}
            days = sorted({(datetime.fromisoformat(g['start'].replace('Z', '+00:00')) - timedelta(hours=5)).strftime('%Y%m%d') for g in feed
                           if g.get('sport') == 'nba' and g.get('status') != 'closed'})[:3]
            for d in days:
                for e in (getj(f'{ESPN}/scoreboard?dates={d}') or {}).get('events', []):
                    c = e['competitions'][0]
                    o = (c.get('odds') or [{}])[0] or {}
                    if o.get('overUnder'):
                        side = {x['homeAway']: x['team']['id'] for x in c['competitors']}
                        nba_lines[(side.get('home'), side.get('away'))] = {'total': o['overUnder'], 'details': o.get('details')}
        else:
            log('NBA: ESPN not reachable, skipped')
            nba_lines = {}
    else:
        nba_lines = {}
    # ---------- next game per team from the feed ----------
    now = datetime.now(timezone.utc)
    idx = {}
    for t in out_teams:
        if t.get('abbr'):
            idx[(t['sport'], t['comp'], t['abbr'])] = t
    soccer_by_comp = {}
    for t in out_teams:
        if t['sport'] == 'soccer':
            soccer_by_comp.setdefault(t['comp'], []).append(t)
    all_soccer = [t for t in out_teams if t['sport'] == 'soccer']

    def find(g, s):
        sp = g.get('sport')
        if sp not in ('soccer', 'nba'):
            return None
        comp = g['comp'] if sp == 'soccer' else 'NBA'
        t = idx.get((sp, comp, g[s]['abbr']))
        if t and (sp == 'nba' or tmatch(t['tokens'], toks(g[s]['name']))[0] >= .5):
            return t
        pool = soccer_by_comp.get(comp) if sp == 'soccer' else [x for x in out_teams if x['sport'] == 'nba']
        cross = sp == 'soccer' and not pool
        best, bk = None, (0, 0)
        for x in (pool or all_soccer):
            sc, j, strong = tmatch(x['tokens'], toks(g[s]['name']))
            if strong and (sc, j) > bk and (sc == 1 if cross else sc >= .5) and (not cross or j >= .5):
                best, bk = x, (sc, j)
        return best

    upcoming = sorted([g for g in feed if g.get('sport') in ('soccer', 'nba') and g.get('status') not in ('closed', 'postponed', 'cancelled')
                       and datetime.fromisoformat(g['start'].replace('Z', '+00:00')) > now], key=lambda g: g['start'])
    for g in upcoming:
        th, ta = find(g, 'home'), find(g, 'away')
        p = g.get('prob') or {}
        ph, pa, pd = p.get('home'), p.get('away'), p.get('draw')
        line = None
        if g['sport'] == 'nba' and th and ta:
            line = (nba_lines.get((th.get('espnId'), ta.get('espnId'))) or {}).get('total')
        for me, t, o, pm, po in (('home', th, ta, ph, pa), ('away', ta, th, pa, ph)):
            if not t or t.get('next'):
                continue
            nx = {'gid': g['id'], 'comp': g['comp'], 'opp': g['away' if me == 'home' else 'home']['name'], 'oppAbbr': g['away' if me == 'home' else 'home']['abbr'],
                  'start': g['start'], 'home': me == 'home', 'p': pm, 'pOpp': po, 'pDraw': pd}
            up = {'flag': False, 'role': None, 'why': []}
            if pm is not None and po is not None:
                if MIN_DOG[g['sport']] <= pm < po:
                    R, s = upset_reasons(t, o, g['sport'])
                    up = {'flag': bool(R), 'role': 'underdog', 'why': R, 'strength': s}
                elif pm > po >= MIN_DOG[g['sport']]:
                    R, s = upset_reasons(None, t, g['sport'])
                    up = {'flag': bool(R), 'role': 'favourite', 'why': R, 'strength': s}
            nx['lean'] = {'upset': up, 'total': total_lean([t, o], g['sport'], line)}
            t['next'] = nx
    for t in out_teams:
        t.setdefault('next', None)
    data = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'asOf': END.isoformat(), 'sources': sources,
            'windows': {'d7': (END - timedelta(days=6)).isoformat(), 'd30': (END - timedelta(days=29)).isoformat()},
            'note': 'Past patterns, not predictions. Samples are small; a z under 2 is easily chance.', 'teams': out_teams}
    json.dump(data, open(OUT, 'w'), separators=(',', ':'))
    # ---------- headline ----------
    soc = [t for t in out_teams if t['sport'] == 'soccer']
    nba = [t for t in out_teams if t['sport'] == 'nba']
    print(f"{len(soc)} soccer teams from {len(sg)} games ({added} from the feed after the CSVs), {len(nba)} NBA teams" + (f" from {sources['nba']['games']} games ({sources['nba']['withLines']} with posted lines)" if nba else ''))
    for L, v in ssrc.items():
        print(f"  {NAMES[L]:22} {v['games']:4} games, to {v['last']} ({v['from']})")
    nx = [t for t in out_teams if t['next']]
    up = [t for t in nx if t['next']['lean']['upset']['flag']]
    tl = {}
    for t in nx:
        s = t['next']['lean']['total']['side']
        if s:
            tl.setdefault(t['next']['gid'], (s, t['next']))
    print(f"next games found for {len(nx)} teams; upset watch flags: {len(up)}; over/under leans: {sum(1 for v in tl.values() if v[0] == 'over')} over, {sum(1 for v in tl.values() if v[0] == 'under')} under")
    for t in sorted(up, key=lambda t: -t['next']['lean']['upset'].get('strength', 0))[:8]:
        print(f"  upset watch: {t['name']} ({t['next']['lean']['upset']['role']}, {pct(t['next']['p'])}) vs {t['next']['opp']}: {t['next']['lean']['upset']['why'][0]}")
    for gid, (s, n) in list(tl.items())[:8]:
        print(f"  {s}: {gid}: {n['lean']['total']['why'][-1]}")
    for sp, L in (('soccer', soc), ('nba', nba)):
        b = [t for t in L if (t['windows']['season'].get('vp') or {}).get('n', 0) >= 8]
        if b:
            hi = max(b, key=lambda t: t['windows']['season']['vp']['won'] - t['windows']['season']['vp']['exp'])
            lo = min(b, key=lambda t: t['windows']['season']['vp']['won'] - t['windows']['season']['vp']['exp'])
            for lab, t in (('most above', hi), ('most below', lo)):
                v = t['windows']['season']['vp']
                print(f"  {sp} {lab} its prices: {t['name']} ({t['comp']}) won {v['won']} of {v['n']}, expected {v['exp']}, z {v['z']}")


if __name__ == '__main__':
    main()
