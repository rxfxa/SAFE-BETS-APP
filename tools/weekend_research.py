#!/usr/bin/env python3
"""Real research for the Weekend Patterns tab: what makes a "crazy weekend" (big favourites dropping points), tested
on several seasons of results with closing odds, and a forecast for the next round.

    python3 tools/weekend_research.py <dir of season CSVs named SSSS_LEAGUE.csv> [--feed data.json] [--pattern pattern.json]
                                      [--euro tools/euro_games.json] [--sims 20000] [--now 2026-11-23T12:00:00Z]

CSVs: football-data.co.uk (https://www.football-data.co.uk/mmz4281/<SSSS>/<LEAGUE>.csv), e.g. 2122_E0.csv. Closing odds
(Pinnacle, else market average) with the margin removed are the "priced" chance of every result. European club games
(tools/euro_games.py, ESPN) give the midweek Champions / Europa / Conference League games.

Each candidate cause is tested two ways among big favourites (priced 60%+ to win):
  1. Observed vs priced: did they fail to win more often than their prices said in that situation?
  2. A logistic regression of "failed to win" on the price and all the causes together, so each cause is measured against
     similar-priced favourites with the other causes held fixed (odds ratio, p-value).
Holm's correction for testing many causes at once: a cause "holds" only if its regression p-value survives that.
Causes: first game after an international break, short rest, a European game 2-4 days before / within 4 days after
(the favourite's, and the underdog's), the Christmas period, start / end of season, long unbeaten and winning runs,
losing runs, an underdog on a good run, favourite away, very big favourites.
Also: calibration (how often favourites at each price failed), months, unbeaten runs ending (how often a run of N ends
vs priced), the craziest rounds and what they had in common, whether crazy rounds come more often than chance at those
prices, unbeaten runs at stake in the next round, and a forecast for the next round in data.json (chance of a crazy
round vs a typical round, the likeliest upsets with reasons). Writes pattern.json "research"; the 90-day block stays.
"""
import csv, glob, json, math, os, re, sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from teamnames import fd_match  # noqa: E402

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
SRC = args[0] if args and not args[0].startswith('--') else '.work/fdhist'
FEED, PAT, EURO, SIMS = opt('--feed', 'data.json'), opt('--pattern', 'pattern.json'), opt('--euro', 'tools/euro_games.json'), int(opt('--sims', 20000))
MIN_GAMES = int(opt('--min', 1000))
NOW = datetime.fromisoformat(opt('--now', datetime.now(timezone.utc).isoformat()).replace('Z', '+00:00'))
NAMES = {'E0': 'Premier League', 'SP1': 'La Liga', 'I1': 'Serie A', 'D1': 'Bundesliga', 'F1': 'Ligue 1', 'N1': 'Eredivisie', 'P1': 'Primeira Liga'}
LG = {v: k for k, v in NAMES.items()}
FAV, CRAZY = 0.60, 0.40
rng = np.random.default_rng(11)


def fnum(x):
    try:
        v = float(x)
        return v if v > 1.0 else None
    except (TypeError, ValueError):
        return None


def pdate(s):
    for f in ('%d/%m/%Y', '%d/%m/%y'):
        try:
            return datetime.strptime(s, f).date()
        except (ValueError, TypeError):
            pass
    return None


# ---------- results with closing prices ----------
games = []
for f in sorted(glob.glob(os.path.join(SRC, '*_*.csv'))):
    season, lg = os.path.basename(f)[:-4].split('_', 1)
    if lg not in NAMES:
        continue
    for r in csv.DictReader(open(f, encoding='utf-8-sig', errors='replace')):
        d = pdate(r.get('Date'))
        try:
            hg, ag = int(r['FTHG']), int(r['FTAG'])
        except (KeyError, ValueError, TypeError):
            continue
        o = None
        for pre in ('PSC', 'AvgC', 'PS', 'Avg', 'B365'):
            h, dr, a = fnum(r.get(pre + 'H')), fnum(r.get(pre + 'D')), fnum(r.get(pre + 'A'))
            if h and dr and a:
                o = (h, dr, a)
                break
        if not d or not o:
            continue
        inv = [1 / x for x in o]
        s = sum(inv)
        games.append({'season': season, 'lg': lg, 'date': d, 'home': r['HomeTeam'], 'away': r['AwayTeam'], 'hg': hg, 'ag': ag, 'p': [x / s for x in inv], 'dec': o})
games.sort(key=lambda g: (g['date'], g['lg']))
if len(games) < MIN_GAMES:
    sys.exit(f'only {len(games)} games: download more seasons first')
CUR = max(g['season'] for g in games)
teams_by_lg = defaultdict(set)
for g in games:
    teams_by_lg[(g['season'], g['lg'])].update((g['home'], g['away']))
all_fd = {t for v in teams_by_lg.values() for t in v}

# ---------- European games (ESPN names -> football-data names) ----------
euro = defaultdict(list)
try:
    EG = json.load(open(EURO))['games']
except (OSError, ValueError, KeyError):
    EG = []
cache = {}
for dt, comp, h, a in EG:
    for n in (h, a):
        if n not in cache:
            cache[n] = fd_match(n, all_fd)
        if cache[n]:
            euro[cache[n]].append(datetime.fromisoformat(dt).date())
for k in euro:
    euro[k] = sorted(set(euro[k]))
EURO_TEAMS = len(euro)


def euro_gap(team, d):
    """days since the team's last European game before d, and days to its next one after d (None if none within 30)"""
    L = euro.get(team)
    if not L:
        return None, None
    i = bisect_left(L, d)
    before = (d - L[i - 1]).days if i > 0 and (d - L[i - 1]).days <= 30 else None
    j = i + 1 if i < len(L) and L[i] == d else i
    after = (L[j] - d).days if j < len(L) and (L[j] - d).days <= 30 else None
    return before, after


# ---------- per team, in order: rest, runs, game number in the season ----------
state, count = {}, defaultdict(int)
sched = lambda season, lg: 2 * (len(teams_by_lg[(season, lg)]) - 1)  # games in a full season: home and away against every other team
EMPTY = {'last': None, 'unb': 0, 'win': 0, 'loss': 0, 'form': '', 'gp': 0}


def play(k, res, d):
    st = state.get(k, EMPTY)
    state[k] = {'last': d, 'unb': st['unb'] + 1 if res != 'L' else 0, 'win': st['win'] + 1 if res == 'W' else 0,
                'loss': st['loss'] + 1 if res == 'L' else 0, 'form': (st['form'] + res)[-10:], 'gp': st['gp'] + 1}


for g in games:
    for side in ('home', 'away'):
        k = (g['season'], g['lg'], g[side])
        st = state.get(k, EMPTY)
        count[k] += 1
        g[side + '_rest'] = (g['date'] - st['last']).days if st['last'] else None
        g[side + '_unb'], g[side + '_win'], g[side + '_loss'] = st['unb'], st['win'], st['loss']
        g[side + '_n'], g[side + '_left'] = count[k], sched(g['season'], g['lg']) - count[k]
        g[side + '_eb'], g[side + '_ea'] = euro_gap(g[side], g['date'])
    for side in ('home', 'away'):
        mine, theirs = (g['hg'], g['ag']) if side == 'home' else (g['ag'], g['hg'])
        play((g['season'], g['lg'], g[side]), 'W' if mine > theirs else 'D' if mine == theirs else 'L', g['date'])

for g in games:
    ph, pd, pa = g['p']
    g['fav'] = 'home' if ph >= pa else 'away'
    g['dog'] = 'away' if g['fav'] == 'home' else 'home'
    g['pf'] = max(ph, pa)
    g['res'] = 'home' if g['hg'] > g['ag'] else 'away' if g['ag'] > g['hg'] else 'draw'
    g['fail'] = g['res'] != g['fav']
big = [g for g in games if g['pf'] >= FAV]

xmas = lambda d: (d.month == 12 and d.day >= 20) or (d.month == 1 and d.day <= 5)
F = lambda g, k: g[g['fav'] + '_' + k]
D = lambda g, k: g[g['dog'] + '_' + k]
inr = lambda v, lo, hi: v is not None and lo <= v <= hi
TESTS = [
    ('postBreak', 'First game after an international break (12+ days without a league game)', lambda g: (F(g, 'rest') or 0) >= 12 and not inr(F(g, 'eb'), 1, 11)),
    ('shortRest', 'Favourite on 3 days rest or less (league games)', lambda g: inr(F(g, 'rest'), 1, 3)),
    ('euroBefore', 'Favourite played a European game 2-4 days before', lambda g: inr(F(g, 'eb'), 1, 4)),
    ('euroAfter', 'Favourite has a European game within 4 days after', lambda g: inr(F(g, 'ea'), 1, 4)),
    ('dogEuroBefore', 'Underdog played a European game 2-4 days before', lambda g: inr(D(g, 'eb'), 1, 4)),
    ('christmas', 'Christmas period (Dec 20 - Jan 5)', lambda g: xmas(g['date'])),
    ('early', "Favourite's first 3 league games of the season", lambda g: F(g, 'n') <= 3),
    ('late', "Favourite's last 4 league games of the season", lambda g: F(g, 'left') <= 3),
    ('favUnbeaten10', 'Favourite unbeaten in 10+ league games', lambda g: F(g, 'unb') >= 10),
    ('favWin5', 'Favourite on a 5+ game winning streak', lambda g: F(g, 'win') >= 5),
    ('favLost2', 'Favourite lost its last 2+ league games', lambda g: F(g, 'loss') >= 2),
    ('dogUnbeaten5', 'Underdog unbeaten in 5+ league games', lambda g: D(g, 'unb') >= 5),
    ('dogLost4', 'Underdog lost its last 4+ league games', lambda g: D(g, 'loss') >= 4),
    ('favAway', 'Favourite playing away', lambda g: g['fav'] == 'away'),
    ('huge', 'Huge favourite (75%+)', lambda g: g['pf'] >= 0.75),
]
DESC = {k: d for k, d, _ in TESTS}
for g in big:
    g['x'] = [1.0 if f(g) else 0.0 for _, _, f in TESTS]


def fstat(rows, name, desc):
    n = len(rows)
    if n < 30:
        return None
    obs = sum(1 for g in rows if g['fail'])
    exp = sum(1 - g['pf'] for g in rows)
    var = sum(g['pf'] * (1 - g['pf']) for g in rows)
    z = (obs - exp) / math.sqrt(var) if var > 0 else 0
    # flat 1 unit on the favourite at closing odds (margin in): what backing them returned
    roi = sum((g['dec'][0 if g['fav'] == 'home' else 2] - 1) if not g['fail'] else -1 for g in rows) / n
    return {'key': name, 'desc': desc, 'n': n, 'fails': obs, 'expected': round(exp, 1), 'ratio': round(obs / exp, 3) if exp else None,
            'z': round(z, 2), 'p': round(math.erfc(abs(z) / math.sqrt(2)), 5), 'favRoi': round(roi, 4)}


logit = lambda q: math.log(q / (1 - q))
sig = lambda v: 1 / (1 + np.exp(-v))


def logreg(X, y):
    """logistic regression by Newton steps; coefficients and standard errors"""
    b = np.zeros(X.shape[1])
    for _ in range(50):
        p = sig(X @ b)
        W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (y - p))
        b += step
        if np.max(np.abs(step)) < 1e-9:
            break
    p = sig(X @ b)
    H = X.T @ (X * (p * (1 - p))[:, None])
    return b, np.sqrt(np.diag(np.linalg.inv(H)))


y = np.array([1.0 if g['fail'] else 0.0 for g in big])
lq = np.array([logit(1 - g['pf']) for g in big])
XC = np.array([g['x'] for g in big])
# causes seen in fewer than 30 big-favourite games (or in nearly all of them) can't be estimated: left out of the regression
est = [j for j in range(len(TESTS)) if 30 <= XC[:, j].sum() <= len(big) - 30]
X = np.column_stack([np.ones(len(big)), lq] + [XC[:, j] for j in est])
beta, se = logreg(X, y)
col = {j: 2 + i for i, j in enumerate(est)}
strata = []
for j, (k, d, f) in enumerate(TESTS):
    s = fstat([g for g in big if g['x'][j]], k, d)
    if not s:
        continue
    if j not in col:
        continue
    c, e = beta[col[j]], se[col[j]]
    s.update({'or': round(math.exp(c), 3), 'orLo': round(math.exp(c - 1.96 * e), 3), 'orHi': round(math.exp(c + 1.96 * e), 3), 'pReg': round(math.erfc(abs(c / e) / math.sqrt(2)), 5)})
    strata.append(s)
# Holm (step-down, monotone): a cause holds only if it survives correction for testing them all
order = sorted(range(len(strata)), key=lambda i: strata[i]['pReg'])
m, run, alive = len(strata), 0.0, True
for rank, i in enumerate(order):
    run = max(run, min(1.0, strata[i]['pReg'] * (m - rank)))
    strata[i]['pHolm'] = round(run, 4)
    alive = alive and run < 0.05
    strata[i]['holds'] = alive
    strata[i]['hint'] = not alive and strata[i]['pReg'] < 0.05  # nominally significant, but not after the correction
overall = fstat(big, 'all', 'All big favourites')
# calibration: the price alone (a + b * logit(priced fail chance)) - how the market's big favourites actually did
cb, _ = logreg(np.column_stack([np.ones(len(big)), lq]), y)
buckets = []
for lo, hi in ((.60, .65), (.65, .70), (.70, .75), (.75, .80), (.80, 1.0)):
    rows = [g for g in big if lo <= g['pf'] < hi]
    if rows:
        buckets.append({'lo': lo, 'hi': hi, 'n': len(rows), 'fails': sum(g['fail'] for g in rows), 'priced': round(sum(1 - g['pf'] for g in rows), 1),
                        'rate': round(sum(g['fail'] for g in rows) / len(rows), 3), 'pricedRate': round(sum(1 - g['pf'] for g in rows) / len(rows), 3)})
# the forecast model: price + only the causes that held
held_idx = [j for j, (k, _, _) in enumerate(TESTS) if any(s['key'] == k and s['holds'] for s in strata)]
fb, _ = logreg(np.column_stack([np.ones(len(big)), lq] + [XC[:, j] for j in held_idx]), y)


def model_q(pf, flags):
    v = fb[0] + fb[1] * logit(1 - pf) + sum(fb[2 + i] for i, j in enumerate(held_idx) if TESTS[j][0] in flags)
    return float(1 / (1 + math.exp(-v)))


# months
MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
months = []
for mo in (8, 9, 10, 11, 12, 1, 2, 3, 4, 5):
    s = fstat([g for g in big if g['date'].month == mo], MN[mo - 1], MN[mo - 1])
    if s:
        months.append({k: s[k] for k in ('key', 'n', 'fails', 'expected', 'ratio', 'z')})

# unbeaten runs ending: every team, how often a run of N ends (a loss) next game vs what the prices said
runs = []
for lo, hi in ((0, 2), (3, 5), (6, 9), (10, 14), (15, 99)):
    rows = []
    for g in games:
        for side in ('home', 'away'):
            if lo <= g[side + '_unb'] <= hi:
                rows.append((g['p'][2] if side == 'home' else g['p'][0], g['res'] == ('away' if side == 'home' else 'home')))
    if len(rows) < 30:
        continue
    n, obs, exp = len(rows), sum(1 for _, x in rows if x), sum(p for p, _ in rows)
    var = sum(p * (1 - p) for p, _ in rows)
    runs.append({'run': f'{lo}-{hi}' if hi < 99 else f'{lo}+', 'lo': lo, 'hi': hi, 'n': n, 'ended': obs, 'expected': round(exp, 1), 'rate': round(obs / n, 3),
                 'priced': round(exp / n, 3), 'ratio': round(obs / exp, 3), 'z': round((obs - exp) / math.sqrt(var), 2) if var else 0})


# ---------- rounds: Friday-Monday weekends ----------
def wkey(d):
    wd = d.weekday()
    return (d + timedelta(days=5 - wd)) if wd in (4, 5, 6) else (d - timedelta(days=2)) if wd == 0 else None


def round_stats(lgs, minsize=6):
    rounds = defaultdict(list)
    for g in big:
        k = wkey(g['date'])
        if k and g['lg'] in lgs:
            rounds[k].append(g)
    return [(k, v) for k, v in sorted(rounds.items()) if len(v) >= minsize]


def sim_rounds(R, qf):
    """how many crazy rounds, and how spread out the fails are, if every favourite failed with chance qf(g) independently"""
    cz, disp = np.zeros(SIMS), np.zeros(SIMS)
    for _, v in R:
        q = np.array([qf(g) for g in v])
        f = rng.random((SIMS, len(q))) < q
        cz += f.mean(axis=1) >= CRAZY
        disp += (f.sum(axis=1) - q.sum()) ** 2 / (q * (1 - q)).sum()
    return cz, disp / len(R)


R = [(k, v) for k, v in round_stats(set(NAMES)) if len(v) >= 10]
share = np.array([sum(g['fail'] for g in v) / len(v) for _, v in R])
cal_q = lambda g: float(1 / (1 + math.exp(-(cb[0] + cb[1] * logit(1 - g['pf'])))))
zR = np.array([(sum(g['fail'] for g in v) - sum(cal_q(g) for g in v)) / math.sqrt(sum(cal_q(g) * (1 - cal_q(g)) for g in v)) for _, v in R])
real_crazy = int(np.sum(share >= CRAZY))
cz_p, _ = sim_rounds(R, lambda g: 1 - g['pf'])
cz_c, dp_c = sim_rounds(R, cal_q)
real_disp = float(np.mean(zR ** 2))
roundsInfo = {'rounds': len(R), 'crazyRounds': real_crazy, 'baseRate': round(real_crazy / len(R), 3), 'threshold': CRAZY,
              'crazyChancePriced': round(float(np.mean(cz_p)), 1), 'crazyChanceCal': round(float(np.mean(cz_c)), 1), 'pCrazyMoreCal': round(float(np.mean(cz_c >= real_crazy)), 4),
              'dispersion': round(real_disp, 3), 'dispersionChance': round(float(np.mean(dp_c)), 3), 'pDispersion': round(float(np.mean(dp_c >= real_disp)), 4)}
FLAGS = ['postBreak', 'euroBefore', 'euroAfter', 'christmas', 'late', 'favAway']
fl = lambda g, k: g['x'][[t[0] for t in TESTS].index(k)]
crazy = sorted(({'date': k.isoformat(), 'favs': len(v), 'failed': int(sum(g['fail'] for g in v)), 'expected': round(sum(1 - g['pf'] for g in v), 1),
                 'share': round(sum(g['fail'] for g in v) / len(v), 3), 'z': round(float(z), 2),
                 'examples': [f"{g['home']} {g['hg']}-{g['ag']} {g['away']} ({NAMES[g['lg']]}, {g[g['fav']]} {round(g['pf'] * 100)}%)" for g in sorted(v, key=lambda g: -g['pf']) if g['fail']][:6]}
                for (k, v), z in zip(R, zR)), key=lambda x: -x['z'])[:10]
# what the craziest tenth of rounds had in common, vs the rest
cut = np.quantile(zR, .9)
traits = []
for k in FLAGS:
    a = [np.mean([fl(g, k) for g in v]) for (_, v), z in zip(R, zR) if z >= cut]
    b = [np.mean([fl(g, k) for g in v]) for (_, v), z in zip(R, zR) if z < cut]
    traits.append({'key': k, 'desc': DESC[k], 'crazy': round(float(np.mean(a)), 3), 'other': round(float(np.mean(b)), 3)})

# ---------- now: current runs (results files, then the feed's finished games) ----------
try:
    pat = json.load(open(PAT))
except (OSError, ValueError):
    pat = {}
prevR = pat.get('research') or {}
prevF = prevR.get('forecast') or {}
try:
    feed = json.load(open(FEED))
except (OSError, ValueError):
    feed = {'games': []}
cur_teams = {lg: teams_by_lg[(CUR, lg)] for lg in NAMES}
fmatch = {}


def ft(comp, name):
    k = (comp, name)
    if k not in fmatch:
        fmatch[k] = fd_match(name, cur_teams.get(LG.get(comp), set()))
    return fmatch[k]


last_csv = defaultdict(lambda: None)
for g in games:
    if g['season'] == CUR:
        last_csv[g['lg']] = max(last_csv[g['lg']] or g['date'], g['date'])
fd_games = [g for g in feed.get('games', []) if g.get('sport') == 'soccer' and g.get('comp') in LG]
sdate = lambda g: datetime.fromisoformat(g['start'].replace('Z', '+00:00'))
unmatched = sorted({f"{g['comp']}: {g[s]['name']}" for g in fd_games for s in ('home', 'away') if not ft(g['comp'], g[s]['name'])})
VOID = re.compile(r'^(postponed|cancel+ed|suspended|abandoned|void)$', re.I)  # the app's void statuses (index.html VOID_RE)
isvoid = lambda g: bool(VOID.match(str(g.get('status') or '')))
# finished league games: this feed's, plus those kept from earlier runs (the feed drops a finished game after ~72h and the
# results files can lag a week); kept until the results files cover their date
fres = {r['gid']: r for r in (prevR.get('feedResults') or []) if r.get('comp') in LG}
for g in fd_games:
    sc = g.get('score') or {}
    if g.get('status') == 'closed' and sc.get('home') is not None and sc.get('away') is not None:
        fres[g['id']] = {'gid': g['id'], 'comp': g['comp'], 'home': g['home']['name'], 'away': g['away']['name'], 'date': sdate(g).date().isoformat(), 'hg': int(sc['home']), 'ag': int(sc['away'])}
listed = {g['id']: g for g in fd_games}
fres = {k: r for k, r in fres.items() if not (last_csv[LG[r['comp']]] and date.fromisoformat(r['date']) <= last_csv[LG[r['comp']]])
        and not (k in listed and listed[k].get('status') != 'closed')}  # a game the feed has since called off (or reopened) no longer counts
added = 0
for r in sorted(fres.values(), key=lambda r: (r['date'], r['gid'])):
    lg, d = LG[r['comp']], date.fromisoformat(r['date'])
    h, a = ft(r['comp'], r['home']), ft(r['comp'], r['away'])
    hg, ag = r['hg'], r['ag']
    if h:
        play((CUR, lg, h), 'W' if hg > ag else 'D' if hg == ag else 'L', d)
    if a:
        play((CUR, lg, a), 'W' if ag > hg else 'D' if hg == ag else 'L', d)
    added += 1
# every league fixture in the feed (any status), so rest counts a game still to be played before the forecast game
fixt = defaultdict(list)
for g in fd_games:
    if isvoid(g):
        continue
    for s in ('home', 'away'):
        t = ft(g['comp'], g[s]['name'])
        if t:
            fixt[(LG[g['comp']], t)].append(sdate(g).date())
for r in fres.values():
    for nm in (r['home'], r['away']):
        t = ft(r['comp'], nm)
        if t:
            fixt[(LG[r['comp']], t)].append(date.fromisoformat(r['date']))


def last_before(lg, team, st, played):
    c = [d for d in fixt.get((lg, team), []) if d < st] + ([played] if played else [])
    return max(c) if c else None


def dist_of(qs):
    """exact chance of each number of fails (independent games)"""
    d = np.array([1.0])
    for q in qs:
        d = np.concatenate([d * (1 - q), [0.0]]) + np.concatenate([[0.0], d * q])
    return d
seasonOf = lambda d: (lambda y: f'{y % 100:02d}{(y + 1) % 100:02d}')(d.year if d.month >= 7 else d.year - 1)
cur = lambda lg, team, d=None: state.get((CUR, lg, team)) if d is None or seasonOf(d) == CUR else None  # league games THIS season

# ---------- forecast: the next full round in the feed ----------
# The round is every Friday-Monday feed game of these leagues (finished ones too), chosen while any of its games is still to
# finish. Games that have kicked off keep the legs (pre-match prices, reasons) of the last run before they started, and
# count as they ended; only games still to start are re-priced. A started game with no earlier leg can't be priced.
# Postponed / cancelled games are left out (as the page does).
by_round = defaultdict(list)
for g in fd_games:
    k = wkey(sdate(g).date())
    if k and not isvoid(g):
        by_round[k].append(g)
voidIds = {g['id'] for g in fd_games if isvoid(g)}
alive = lambda g: g.get('status') != 'closed' and sdate(g) > NOW - timedelta(hours=6)
ahead = lambda k: sum(1 for g in by_round[k] if g.get('status') != 'closed' and sdate(g) > NOW)
# stay on a round once it has been forecast (until it is over, however many of its games the feed still lists);
# otherwise the next round with 8+ games still to start
rk = next((k for k in sorted(by_round) if any(alive(g) for g in by_round[k]) and (prevF.get('round') == k.isoformat() or ahead(k) >= 8)), None)
same = bool(rk and prevF.get('round') == rk.isoformat())
carry = {l['gid']: l for l in (prevF.get('legs') or [])} if same else {}
carryRuns = [r for r in (prevR.get('runsNow') or [])] if same else []
pricedIds = set(prevF.get('pricedGids') or []) if same else set()
fc, runsNow, missing = None, [], 0
WHY = {'postBreak': 'first game after the international break', 'shortRest': 'short rest', 'euroBefore': 'played in Europe {eb} days before',
       'euroAfter': 'European game {ea} days after', 'dogEuroBefore': 'underdog played in Europe {deb} days before', 'christmas': 'Christmas fixtures',
       'early': 'start of season', 'late': 'end of season', 'favUnbeaten10': 'unbeaten in {funb}', 'favWin5': 'won {fwin} in a row',
       'favLost2': 'lost the last {floss}', 'dogUnbeaten5': 'underdog unbeaten in {dunb}', 'dogLost4': 'underdog lost {dloss} in a row',
       'favAway': 'away from home', 'huge': 'huge favourite'}
if rk:
    legs, seen = [], set()
    # the round's leagues: every league with a game in it, whatever its status (kept for the whole round)
    lgs = {LG[g['comp']] for g in by_round[rk]} | ({LG[c] for c in prevF.get('leagues', []) if c in LG} if same else set())
    for g in by_round[rk]:
        seen.add(g['id'])
        if g.get('status') == 'closed' or sdate(g) <= NOW:  # kicked off: the pre-match leg from the last run, and its result
            runsNow.extend(r for r in carryRuns if r['gid'] == g['id'])
            L = carry.get(g['id'])
            if not L:
                missing += g['id'] not in pricedIds  # never priced before it started (a priced non-favourite is no leg)
                continue
            L, sc = dict(L), g.get('score') or {}
            L['frozen'] = True
            if g.get('status') == 'closed' and sc.get('home') is not None and sc.get('away') is not None:
                r = 'home' if sc['home'] > sc['away'] else 'away' if sc['away'] > sc['home'] else 'draw'
                L['result'] = 'won' if r == L['favSide'] else 'failed'
            legs.append(L)
            continue
        P0 = g.get('prob')
        if not P0:
            continue
        tot = (P0.get('home') or 0) + (P0.get('draw') or 0) + (P0.get('away') or 0)
        if tot <= 0:
            continue
        pricedIds.add(g['id'])
        ph, pa = P0['home'] / tot, P0['away'] / tot
        st = datetime.fromisoformat(g['start'].replace('Z', '+00:00')).date()
        # runs at stake this round: every team on 6+ unbeaten, with its chance of losing
        for side, other, pl in (('home', 'away', pa), ('away', 'home', ph)):
            t = ft(g['comp'], g[side]['name'])
            s = cur(LG[g['comp']], t, st) if t else None
            if s and s['unb'] >= 6:
                rr = next((r for r in runs if r['lo'] <= s['unb'] <= r['hi']), None)
                runsNow.append({'gid': g['id'], 'team': g[side]['name'], 'abbr': g[side]['abbr'], 'side': side, 'comp': g['comp'], 'start': g['start'], 'opp': g[other]['name'],
                                'unbeaten': s['unb'], 'form': s['form'], 'pLose': round(pl, 4), 'histRatio': rr['ratio'] if rr else None,
                                'pLoseHist': round(min(.95, pl * rr['ratio']), 4) if rr else None})
        pf = max(ph, pa)
        if pf < FAV:
            continue
        fs = 'home' if ph >= pa else 'away'
        ds = 'away' if fs == 'home' else 'home'
        favT, dogT = g[fs], g[ds]
        fk, dk = ft(g['comp'], favT['name']), ft(g['comp'], dogT['name'])
        fst, dst = (cur(LG[g['comp']], fk, st) if fk else None), (cur(LG[g['comp']], dk, st) if dk else None)
        lastG = last_before(LG[g['comp']], fk, st, fst['last'] if fst else None) if fk else None
        rest = (st - lastG).days if lastG else None
        eb, ea = euro_gap(fk, st) if fk else (None, None)
        deb, _ = euro_gap(dk, st) if dk else (None, None)
        # the favourite's league game number this season: games played, plus league fixtures still to come before this one
        sstart = date(st.year if st.month >= 7 else st.year - 1, 7, 1)
        gnum = ((fst['gp'] if fst else 0) + 1 + sum(1 for d in fixt.get((LG[g['comp']], fk), []) if d >= sstart and (not fst or not fst['last'] or d > fst['last']) and d < st)) if fk else None
        x = {'postBreak': (rest or 0) >= 12 and not inr(eb, 1, 11), 'shortRest': inr(rest, 1, 3), 'euroBefore': inr(eb, 1, 4), 'euroAfter': inr(ea, 1, 4),
             'dogEuroBefore': inr(deb, 1, 4), 'christmas': xmas(st), 'early': bool(gnum and gnum <= 3), 'late': bool(gnum and seasonOf(st) == CUR and 0 <= sched(CUR, LG[g['comp']]) - gnum <= 3),
             'favUnbeaten10': bool(fst and fst['unb'] >= 10), 'favWin5': bool(fst and fst['win'] >= 5), 'favLost2': bool(fst and fst['loss'] >= 2),
             'dogUnbeaten5': bool(dst and dst['unb'] >= 5), 'dogLost4': bool(dst and dst['loss'] >= 4), 'favAway': fs == 'away', 'huge': pf >= .75}
        flags = [k for k, v in x.items() if v]
        vals = {'eb': eb, 'ea': ea, 'deb': deb, 'funb': fst and fst['unb'], 'fwin': fst and fst['win'], 'floss': fst and fst['loss'], 'dunb': dst and dst['unb'], 'dloss': dst and dst['loss']}
        reasons = []
        for k in flags:
            s = next((s for s in strata if s['key'] == k), None)
            reasons.append({'key': k, 'text': WHY[k].format(**vals), 'or': s['or'] if s else None, 'holds': bool(s and s['holds'])})
        legs.append({'gid': g['id'], 'comp': g['comp'], 'start': g['start'], 'fav': favT['name'], 'favAbbr': favT['abbr'], 'dog': dogT['name'], 'dogAbbr': dogT['abbr'], 'favSide': fs,
                     'priced': round(1 - pf, 4), 'model': round(model_q(pf, flags), 4), 'flags': flags, 'reasons': reasons,
                     'form': fst['form'] if fst else None, 'dogForm': dst['form'] if dst else None, 'matched': bool(fk and dk)})
    # legs (and runs) of games that have left the feed since: kept when the game had finished, with its result
    for gid, L in carry.items():
        if gid not in seen and gid not in voidIds and 'result' in L:
            legs.append(dict(L, frozen=True))
    runsNow.extend(r for r in carryRuns if r['gid'] not in seen and r['gid'] not in voidIds)
    if legs:
        res = lambda l: None if 'result' not in l else (1.0 if l['result'] == 'failed' else 0.0)
        Q = np.array([res(l) if res(l) is not None else l['model'] for l in legs])
        Q0 = np.array([res(l) if res(l) is not None else l['priced'] for l in legs])
        n, need = len(legs), math.ceil(CRAZY * len(legs) - 1e-9)
        d, d0 = dist_of(Q), dist_of(Q0)
        # a typical round with the same number of big favourites: n favourites drawn from these leagues' past big
        # favourites (research estimate, and prices alone), and how often real rounds of about that size went crazy
        pool = [g for g in big if g['lg'] in lgs]
        qa, pa_ = np.array([cal_q(g) for g in pool]), np.array([1 - g['pf'] for g in pool])
        idx = rng.integers(0, len(pool), size=(20000, n))
        u = rng.random((20000, n))
        typ, typP = float(np.mean((u < qa[idx]).sum(axis=1) >= need)), float(np.mean((u < pa_[idx]).sum(axis=1) >= need))
        # real rounds: exactly this many big favourites (else within 1, then 2), judged by the same bar (need of n)
        Rl = round_stats(lgs, minsize=1)
        for w in (0, 1, 2):
            near = [v for _, v in Rl if abs(len(v) - n) <= w]
            if len(near) >= 30:
                break
        else:
            near = []
        realN = [sum(g['fail'] for g in v) / len(v) >= need / n - 1e-9 for v in near]
        fc = {'round': rk.isoformat(), 'leagues': sorted(NAMES[l] for l in lgs), 'games': len(by_round[rk]), 'favs': n, 'need': need, 'expFails': round(float(Q.sum()), 2),
              'expFailsPriced': round(float(Q0.sum()), 2), 'pCrazy': round(float(d[need:].sum()), 4), 'pCrazyPriced': round(float(d0[need:].sum()), 4),
              'typical': round(typ, 4), 'typicalPriced': round(typP, 4), 'typicalReal': round(float(np.mean(realN)), 4) if realN else None, 'typicalRounds': len(realN), 'typicalWindow': w if realN else None,
              'dist': [round(float(x), 4) for x in d], 'pAllWin': round(float(d[0]), 4),
              'done': sum(1 for l in legs if 'result' in l), 'failed': sum(1 for l in legs if l.get('result') == 'failed'), 'carried': sum(1 for l in legs if l.get('frozen')),
              'startedUnpriced': missing, 'pricedGids': sorted(pricedIds), 'legs': sorted(legs, key=lambda l: -l['model']), 'heldCauses': [TESTS[j][0] for j in held_idx]}
runsNow.sort(key=lambda r: -r['unbeaten'])

out = {'updated': NOW.strftime('%Y-%m-%dT%H:%M:%SZ'), 'seasons': sorted({g['season'] for g in games}), 'leagues': sorted({NAMES[g['lg']] for g in games}),
       'games': len(games), 'bigFavs': len(big), 'favThreshold': FAV, 'euroGames': len(EG), 'euroTeams': EURO_TEAMS, 'feedResultsAdded': added, 'feedResults': sorted(fres.values(), key=lambda r: (r['date'], r['gid'])), 'unmatchedFeedNames': unmatched,
       'resultsThrough': max(g['date'] for g in games).isoformat(), 'overall': overall,
       'calib': {'a': round(float(cb[0]), 4), 'b': round(float(cb[1]), 4), 'buckets': buckets},
       'model': {'a': round(float(fb[0]), 4), 'b': round(float(fb[1]), 4), 'causes': {TESTS[j][0]: round(float(fb[2 + i]), 4) for i, j in enumerate(held_idx)}}, 'causes': strata, 'months': months,
       'unbeatenRuns': runs, 'rounds': roundsInfo, 'craziest': crazy, 'crazyTraits': traits, 'runsNow': runsNow[:12], 'forecast': fc,
       'source': 'football-data.co.uk results with closing odds (Pinnacle, else market average), margin removed; European games from ESPN scoreboards'}
pat['research'] = out
json.dump(pat, open(PAT, 'w'), separators=(',', ':'))
print(f"{len(games)} games, {len(big)} big favourites, seasons {out['seasons'][0]}..{out['seasons'][-1]}, results to {out['resultsThrough']} (+{added} from the feed); {len(EG)} European games, {EURO_TEAMS} of our teams")
if unmatched:
    print('WARNING feed names with no football-data match (their results are not counted):', '; '.join(unmatched))
print(f"overall fails {overall['fails']} vs {overall['expected']} priced (z {overall['z']}); calibration a {cb[0]:.3f} b {cb[1]:.3f}")
for s in sorted(strata, key=lambda s: s['pReg']):
    print(f"  {s['key']:14} n {s['n']:5} fails {s['fails']:4} vs {s['expected']:7} ratio {s['ratio']:.2f} | OR {s['or']:.2f} [{s['orLo']:.2f}-{s['orHi']:.2f}] p {s['pReg']:.4f} holm {s['pHolm']:.3f} {'HOLDS' if s['holds'] else ''}")
print('months:', [(x['key'], x['ratio']) for x in months])
print('runs ending:', [(r['run'], r['ended'], r['expected']) for r in runs])
print('rounds:', json.dumps(roundsInfo))
print('traits:', [(t['key'], t['crazy'], t['other']) for t in traits])
print('craziest:', [(c['date'], c['failed'], c['favs'], c['z']) for c in crazy[:5]])
print('runs now:', [(r['team'], r['unbeaten'], r['pLose']) for r in runsNow[:8]])
if fc:
    print(f"forecast {fc['round']} ({', '.join(fc['leagues'])}): {fc['favs']} big favourites ({fc['done']} finished, {fc['failed']} failed, {fc['carried']} carried, {fc['startedUnpriced']} started unpriced), exp fails {fc['expFails']} (priced {fc['expFailsPriced']}); P(crazy {fc['need']}+) {fc['pCrazy']} (priced {fc['pCrazyPriced']}), typical {fc['typical']} (priced {fc['typicalPriced']}, real {fc['typicalReal']} of {fc['typicalRounds']} rounds)")
    for l in fc['legs'][:6]:
        print('   ', l['fav'], 'vs', l['dog'], l['priced'], '->', l['model'], [r['text'] for r in l['reasons']])
