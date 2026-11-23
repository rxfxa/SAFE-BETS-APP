#!/usr/bin/env python3
"""Test the claim "there are weekends when all the big teams lose, and weekends that are 80% draws - follow the pattern"
on the last 90 days of real results, and write pattern.json for the Weekend Patterns tab.

    python3 tools/weekend_pattern.py <dir with football-data.co.uk CSVs> [--days 90] [--end 2026-11-23] [--feed data.json]
                                     [--sims 20000] [--out pattern.json]

Data: football-data.co.uk season files (results + closing odds; https://www.football-data.co.uk/mmz4281/2627/<LEAGUE>.csv),
plus finished games in data.json (the app's feed, with its pre-match win chances) for days the CSVs don't cover yet.
"Expected" always comes from the market: closing average odds with the bookmaker margin removed (proportional), so a team
priced at 75% to win is expected to drop points 25% of the time.

Per weekend (Friday to Monday; Tuesday-Thursday games form a midweek round) it counts big favourites (priced 60%+ to win)
that failed to win, and draws, against what the prices expected. Then it asks whether the weekends cluster more than chance:
  1. dispersion: do weekend totals swing further from expectation than independent games would? (chi-square-type statistic)
  2. extreme weekends: how often does chance alone produce a weekend where every big favourite (3+) fails, or 80% draws?
  3. contagion: when Saturday's favourites slip, do Sunday's slip more than priced? (early vs late residual correlation)
  4. carry-over: does an upset-heavy weekend predict the next one? (lag-1 correlation of weekend residuals)
  5. calibration: over the whole window, did favourites / draws land more or less often than priced, per league?
Each p-value comes from simulating every game again from its own prices (--sims seasons). Small p (< 0.05) would mean the
real data does something chance at those prices rarely does.
"""
import csv, glob, json, os, sys
from datetime import datetime, timedelta, timezone
import numpy as np

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
src = args[0] if args and not args[0].startswith('--') else '.'
DAYS, END = int(opt('--days', 90)), opt('--end', None)
SIMS, OUT, FEED = int(opt('--sims', 20000)), opt('--out', 'pattern.json'), opt('--feed', 'data.json')
NAMES = {'E0': 'Premier League', 'E1': 'Championship', 'SP1': 'La Liga', 'I1': 'Serie A', 'D1': 'Bundesliga', 'F1': 'Ligue 1',
         'N1': 'Eredivisie', 'P1': 'Primeira Liga', 'SC0': 'Scottish Premiership', 'B1': 'Belgian Pro League', 'T1': 'Super Lig', 'G1': 'Greek Super League'}
FAV = 0.60
end = datetime.strptime(END, '%Y-%m-%d').date() if END else datetime.now(timezone.utc).date()
start = end - timedelta(days=DAYS)


def fnum(x):
    try:
        v = float(x)
        return v if v > 1.0 else None
    except (TypeError, ValueError):
        return None


games = []
for f in sorted(glob.glob(os.path.join(src, '*.csv'))):
    lg = os.path.basename(f)[:-4]
    for r in csv.DictReader(open(f, encoding='utf-8-sig')):
        try:
            d = datetime.strptime(r['Date'], '%d/%m/%Y').date()
            hg, ag = int(r['FTHG']), int(r['FTAG'])
        except (KeyError, ValueError):
            continue
        if not (start <= d <= end):
            continue
        o = None
        for pre in ('AvgC', 'PSC', 'B365C', 'Avg', 'B365'):
            h, dr, a = fnum(r.get(pre + 'H')), fnum(r.get(pre + 'D')), fnum(r.get(pre + 'A'))
            if h and dr and a:
                o = (h, dr, a)
                break
        if not o:
            continue
        inv = [1 / x for x in o]
        s = sum(inv)
        games.append({'date': d.isoformat(), 'time': r.get('Time') or '', 'lg': lg, 'comp': NAMES.get(lg, lg), 'home': r['HomeTeam'], 'away': r['AwayTeam'],
                      'hg': hg, 'ag': ag, 'p': [x / s for x in inv], 'margin': s - 1, 'src': 'closing odds'})
have = {(g['date'], g['home'][:5].lower()) for g in games}
csv_end = max((g['date'] for g in games), default=start.isoformat())
# the app's feed for finished games after the CSVs end (its pre-match chances stand in for closing odds)
try:
    feed = json.load(open(FEED))
    COMP = {v: k for k, v in NAMES.items()}
    for g in feed.get('games', []):
        if g.get('sport') != 'soccer' or g.get('status') != 'closed' or not g.get('score') or not g.get('prob') or g.get('comp') not in COMP:
            continue
        d = g['start'][:10]
        if not (csv_end < d <= end.isoformat()):
            continue
        P = g['prob']
        ph, pd, pa = float(P.get('home', 0)), float(P.get('draw', 0)), float(P.get('away', 0))
        s = ph + pd + pa
        if s <= 0 or pd <= 0:
            continue
        games.append({'date': d, 'time': g['start'][11:16], 'lg': COMP[g['comp']], 'comp': g['comp'], 'home': g['home']['name'], 'away': g['away']['name'],
                      'hg': int(g['score']['home']), 'ag': int(g['score']['away']), 'p': [ph / s, pd / s, pa / s], 'src': 'feed chance'})
except (OSError, ValueError):
    pass
games.sort(key=lambda g: (g['date'], g['time']))
N = len(games)
if N < 50:
    sys.exit(f'only {N} games in the window: not enough to test anything')


def bucket(ds):  # Friday-Monday -> that weekend's Saturday; Tuesday-Thursday -> midweek (its Wednesday)
    d = datetime.strptime(ds, '%Y-%m-%d').date()
    wd = d.weekday()
    if wd in (4, 5, 6):
        return 'W ' + (d + timedelta(days=5 - wd)).isoformat()
    if wd == 0:
        return 'W ' + (d - timedelta(days=2)).isoformat()
    return 'M ' + (d + timedelta(days=2 - wd)).isoformat()


P = np.array([g['p'] for g in games])  # (N,3) home, draw, away
res = np.array([0 if g['hg'] > g['ag'] else 1 if g['hg'] == g['ag'] else 2 for g in games])
favside = np.argmax(P[:, [0, 2]], axis=1) * 2  # 0 home / 2 away
favp = P[np.arange(N), favside]
isfav = favp >= FAV
buckets = [bucket(g['date']) for g in games]
keys = sorted(set(buckets), key=lambda k: k[2:])
bidx = np.array([keys.index(b) for b in buckets])
# early / late: each round's big-favourite games split in half by kick-off (games are sorted by date and time), so
# "Saturday's favourites slipped, will Sunday's?" is asked of every round with 2+ favourites
is_early = np.zeros(N, dtype=bool)
for b in set(bidx.tolist()):
    fi = [i for i in range(N) if bidx[i] == b and isfav[i]]
    for i in fi[:len(fi) // 2]:
        is_early[i] = True
B = len(keys)


def stats(outcome):
    """weekend-level stats for one realisation of every game's outcome (array of 0/1/2)."""
    fail = (outcome != favside) & isfav
    draw = outcome == 1
    exp_fail = np.where(isfav, 1 - favp, 0.0)
    var_fail = np.where(isfav, favp * (1 - favp), 0.0)
    out = {}
    for name, obs, ex, var in (('fail', fail, exp_fail, var_fail), ('draw', draw, P[:, 1], P[:, 1] * (1 - P[:, 1]))):
        o = np.bincount(bidx, weights=obs.astype(float), minlength=B)
        e = np.bincount(bidx, weights=ex, minlength=B)
        v = np.bincount(bidx, weights=var, minlength=B)
        ok = v > 0
        z = np.where(ok, (o - e) / np.sqrt(np.where(ok, v, 1)), 0.0)
        out[name] = {'o': o, 'e': e, 'z': z, 'disp': float(np.sum(z[ok] ** 2) / max(1, ok.sum())), 'lag1': float(np.corrcoef(z[ok][:-1], z[ok][1:])[0, 1]) if ok.sum() > 3 else 0.0}
    nf = np.bincount(bidx, weights=isfav.astype(float), minlength=B)
    ng = np.bincount(bidx, minlength=B)
    out['allfail'] = int(np.sum((nf >= 3) & (out['fail']['o'] == nf)))
    out['maxfailrate'] = float(np.max(np.where(nf >= 3, out['fail']['o'] / np.maximum(nf, 1), 0)))
    out['draw80'] = int(np.sum((ng >= 5) & (out['draw']['o'] >= 0.8 * ng)))
    out['maxdrawrate'] = float(np.max(np.where(ng >= 5, out['draw']['o'] / np.maximum(ng, 1), 0)))
    # contagion: early-slot vs late-slot residuals of favourites failing, across buckets that have both
    ve = np.bincount(bidx, weights=np.where(isfav & is_early, favp * (1 - favp), 0), minlength=B)
    vl = np.bincount(bidx, weights=np.where(isfav & ~is_early, favp * (1 - favp), 0), minlength=B)
    fe = np.bincount(bidx, weights=(fail & is_early).astype(float) - np.where(isfav & is_early, 1 - favp, 0), minlength=B) / np.sqrt(np.maximum(ve, 1e-9))
    fl = np.bincount(bidx, weights=(fail & ~is_early).astype(float) - np.where(isfav & ~is_early, 1 - favp, 0), minlength=B) / np.sqrt(np.maximum(vl, 1e-9))
    both = (np.bincount(bidx, weights=(isfav & is_early).astype(float), minlength=B) > 0) & (np.bincount(bidx, weights=(isfav & ~is_early).astype(float), minlength=B) > 0)
    out['contagion'] = float(np.corrcoef(fe[both], fl[both])[0, 1]) if both.sum() > 3 else 0.0
    out['contagionRounds'] = int(both.sum())
    out['totfail'] = float(fail.sum())
    out['totdraw'] = float(draw.sum())
    return out, nf, ng


real, nf, ng = stats(res)
rng = np.random.default_rng(20261123)
cum = np.cumsum(P, axis=1)
keysS = ['fail_disp', 'draw_disp', 'allfail', 'maxfailrate', 'draw80', 'maxdrawrate', 'contagion', 'fail_lag1', 'draw_lag1', 'totfail', 'totdraw']
sim = {k: np.empty(SIMS) for k in keysS}
for s in range(SIMS):
    u = rng.random(N)
    o = np.where(u < cum[:, 0], 0, np.where(u < cum[:, 1], 1, 2))
    st, _, _ = stats(o)
    sim['fail_disp'][s], sim['draw_disp'][s] = st['fail']['disp'], st['draw']['disp']
    sim['fail_lag1'][s], sim['draw_lag1'][s] = st['fail']['lag1'], st['draw']['lag1']
    for k in ('allfail', 'maxfailrate', 'draw80', 'maxdrawrate', 'contagion', 'totfail', 'totdraw'):
        sim[k][s] = st[k]
pv = lambda k, x: float(np.mean(sim[k] >= x))  # one-sided: as extreme or more, in the direction the claim needs
two = lambda k, x: float(np.mean(np.abs(sim[k] - np.mean(sim[k])) >= abs(x - np.mean(sim[k]))))
tests = {
    'favDispersion': {'value': real['fail']['disp'], 'chance': float(np.mean(sim['fail_disp'])), 'p': pv('fail_disp', real['fail']['disp'])},
    'drawDispersion': {'value': real['draw']['disp'], 'chance': float(np.mean(sim['draw_disp'])), 'p': pv('draw_disp', real['draw']['disp'])},
    'allBigLose': {'value': real['allfail'], 'chance': float(np.mean(sim['allfail'])), 'p': pv('allfail', real['allfail'])},
    'worstFavWeekend': {'value': real['maxfailrate'], 'chance': float(np.mean(sim['maxfailrate'])), 'p': pv('maxfailrate', real['maxfailrate'])},
    'draw80Weekends': {'value': real['draw80'], 'chance': float(np.mean(sim['draw80'])), 'p': pv('draw80', real['draw80'])},
    'mostDrawsWeekend': {'value': real['maxdrawrate'], 'chance': float(np.mean(sim['maxdrawrate'])), 'p': pv('maxdrawrate', real['maxdrawrate'])},
    'contagion': {'value': real['contagion'], 'chance': float(np.mean(sim['contagion'])), 'p': pv('contagion', real['contagion'])},
    'favCarryOver': {'value': real['fail']['lag1'], 'chance': float(np.mean(sim['fail_lag1'])), 'p': pv('fail_lag1', real['fail']['lag1'])},
    'drawCarryOver': {'value': real['draw']['lag1'], 'chance': float(np.mean(sim['draw_lag1'])), 'p': pv('draw_lag1', real['draw']['lag1'])},
    'favsFailOverall': {'value': real['totfail'], 'chance': float(np.mean(sim['totfail'])), 'p': two('totfail', real['totfail'])},
    'drawsOverall': {'value': real['totdraw'], 'chance': float(np.mean(sim['totdraw'])), 'p': two('totdraw', real['totdraw'])},
}
# per-weekend series with a 90% chance band for favourites failing and draws (from the simulated seasons, per bucket)
band = {'fail': ([], []), 'draw': ([], [])}
rng2 = np.random.default_rng(7)
samp = []
for s in range(4000):
    u = rng2.random(N)
    o = np.where(u < cum[:, 0], 0, np.where(u < cum[:, 1], 1, 2))
    samp.append((np.bincount(bidx, weights=((o != favside) & isfav).astype(float), minlength=B), np.bincount(bidx, weights=(o == 1).astype(float), minlength=B)))
F = np.array([x[0] for x in samp])
D = np.array([x[1] for x in samp])
weeks = []
for i, k in enumerate(keys):
    gi = np.where(bidx == i)[0]
    weeks.append({'key': k, 'kind': 'weekend' if k[0] == 'W' else 'midweek', 'date': k[2:], 'games': int(ng[i]), 'favs': int(nf[i]),
                  'favFails': int(real['fail']['o'][i]), 'favFailsExp': round(float(real['fail']['e'][i]), 2),
                  'favBand': [int(np.percentile(F[:, i], 5)), int(np.percentile(F[:, i], 95))],
                  'draws': int(real['draw']['o'][i]), 'drawsExp': round(float(real['draw']['e'][i]), 2), 'drawBand': [int(np.percentile(D[:, i], 5)), int(np.percentile(D[:, i], 95))],
                  'upsets': [f"{games[j]['home']} {games[j]['hg']}-{games[j]['ag']} {games[j]['away']} ({games[j]['comp']}, fav {round(favp[j] * 100)}%)" for j in gi if isfav[j] and res[j] != favside[j]][:12]})
# calibration by league: favourites (60%+) and draws, observed vs priced
cal = []
for lg in sorted(set(g['lg'] for g in games)):
    m = np.array([g['lg'] == lg for g in games])
    fm = m & isfav
    cal.append({'lg': lg, 'comp': NAMES.get(lg, lg), 'games': int(m.sum()), 'favs': int(fm.sum()), 'favWins': int(np.sum(res[fm] == favside[fm])), 'favWinsExp': round(float(favp[fm].sum()), 1),
                'draws': int(np.sum(res[m] == 1)), 'drawsExp': round(float(P[m, 1].sum()), 1)})
# draw rate by how even the game was priced (the honest "draw weekend" lever: even games draw more)
bins = [(0, .2), (.2, .3), (.3, .45), (.45, 1.01)]
gap = np.abs(P[:, 0] - P[:, 2])
drawByGap = [{'gap': f'{int(a * 100)}-{int(min(b, 1) * 100)} pts', 'games': int(((gap >= a) & (gap < b)).sum()), 'drawRate': round(float(np.mean(res[(gap >= a) & (gap < b)] == 1)), 3) if ((gap >= a) & (gap < b)).any() else None,
              'priced': round(float(np.mean(P[(gap >= a) & (gap < b), 1])), 3) if ((gap >= a) & (gap < b)).any() else None} for a, b in bins]
def roi(mask, side_of):  # flat $1 at the closing price (margin left in): what a bettor got
    gi = np.where(mask)[0]
    if not len(gi):
        return None
    pr = []
    for i in gi:
        sd = side_of(i)
        dec = 1 / (P[i, sd] * (1 + margin[i]))
        pr.append(dec - 1 if res[i] == sd else -1)
    return {'bets': int(len(gi)), 'won': int(sum(1 for x in pr if x > 0)), 'profit': round(float(sum(pr)), 2), 'roi': round(float(np.mean(pr)), 4)}
margin = np.array([g.get('margin', 0.05) for g in games])
dog = lambda i: 2 if favside[i] == 0 else 0
bets = {'favourites': roi(isfav, lambda i: favside[i]), 'draws': roi(np.ones(N, bool), lambda i: 1), 'drawsVsFav': roi(isfav, lambda i: 1),
        'underdogsVsFav': roi(isfav, dog)}
for c in cal:
    m = np.array([g['lg'] == c['lg'] for g in games])
    c['favRoi'] = (roi(m & isfav, lambda i: favside[i]) or {}).get('roi')
    c['drawRoi'] = (roi(m, lambda i: 1) or {}).get('roi')
data_end = max(g['date'] for g in games)
feed_n = sum(1 for g in games if g['src'] == 'feed chance')
sig = [k for k in ('favDispersion', 'drawDispersion', 'allBigLose', 'draw80Weekends', 'contagion', 'favCarryOver', 'drawCarryOver') if tests[k]['p'] < 0.05]
T = tests
parts = []
if not any(k in sig for k in ('favDispersion', 'drawDispersion', 'allBigLose', 'draw80Weekends')):
    parts.append(f"The tweet's pattern isn't in the last {DAYS} days (results to {data_end}). No round had every big favourite lose (worst: {round(T['worstFavWeekend']['value'] * 100)}% of them dropped points) and none came close to 80% draws (most: {round(T['mostDrawsWeekend']['value'] * 100)}%). Rounds swung about as much as independent games at their prices would (p {T['favDispersion']['p']:.2f} for favourites, {T['drawDispersion']['p']:.2f} for draws).")
else:
    parts.append('Rounds clustered more than chance at these prices would explain: ' + ', '.join(sig) + '.')
c = T['contagion']
if c['p'] < 0.05:
    parts.append(f"When a round's early favourites slipped, its later favourites slipped more than priced too (r {c['value']:.2f}, p {c['p']:.3f}).")
elif c['p'] < 0.15:
    parts.append(f"One hint, not proof: in rounds where the early favourites slipped, the later ones slipped a little more too (r {c['value']:.2f}, p {c['p']:.2f} over {real['contagionRounds']} rounds), too few rounds to rely on.")
else:
    parts.append(f"Early slips didn't lead to later slips in the same round (r {c['value']:.2f} over {real['contagionRounds']} rounds).")
f = T['favsFailOverall']
if f['p'] < 0.05:
    parts.append(f"What the data does show is the opposite of the tweet: big favourites failed {int(f['value'])} times where their prices expected {f['chance']:.0f} (p {f['p']:.3f}), so backing them returned more than betting against them.")
verdict = ' '.join(parts)
if not feed_n:
    print(f'note: the feed added no games (finished games carry no pre-match chance); data ends {data_end}', file=sys.stderr)
data = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'window': [start.isoformat(), data_end], 'asked': [start.isoformat(), end.isoformat()], 'feedGames': feed_n, 'games': N,
        'sources': {'csv': 'football-data.co.uk 2026-27 results with closing odds', 'feedAfter': csv_end, 'leagues': sorted(set(g['comp'] for g in games))},
        'favThreshold': FAV, 'bets': bets, 'sims': SIMS, 'tests': tests, 'significant': sig, 'verdict': verdict, 'weeks': weeks, 'calibration': cal, 'drawByGap': drawByGap,
        'totals': {'favs': int(isfav.sum()), 'favFails': int(real['totfail']), 'favFailsExp': round(float(np.sum(np.where(isfav, 1 - favp, 0))), 1), 'draws': int(real['totdraw']), 'drawsExp': round(float(P[:, 1].sum()), 1)}}
json.dump(data, open(OUT, 'w'), separators=(',', ':'))
print(f'{N} games, {B} rounds ({start}..{end}); favourites 60%+: {int(isfav.sum())}, failed {int(real["totfail"])} vs {data["totals"]["favFailsExp"]} priced; draws {int(real["totdraw"])} vs {data["totals"]["drawsExp"]} priced')
for k, t in tests.items():
    print(f'  {k:18} real {t["value"]:.3f}  chance avg {t["chance"]:.3f}  p={t["p"]:.3f}')
print('bets at closing odds:', json.dumps(bets))
for c in cal:
    print(f"  {c['comp']:22} favs {c['favWins']}/{c['favs']} won (priced {c['favWinsExp']})  draws {c['draws']} (priced {c['drawsExp']})  favROI {c['favRoi']}  drawROI {c['drawRoi']}")
print('draw rate by price gap:', json.dumps(drawByGap))
print('verdict:', verdict)
