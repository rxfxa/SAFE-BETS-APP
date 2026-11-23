#!/usr/bin/env python3
"""Results with closing odds from football-data.co.uk for the Weekend Patterns research: the last N seasons of 7 European
leagues, saved as <dir>/<SSSS>_<LEAGUE>.csv (e.g. 2627_E0.csv). Past seasons are fetched once; the current one every run.

    python3 tools/fd_history.py [--dir .work/fdhist] [--seasons 7]
"""
import os, sys, time, urllib.request
from datetime import datetime, timezone

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
DIR, NS = opt('--dir', '.work/fdhist'), int(opt('--seasons', 7))
LEAGUES = ['E0', 'SP1', 'I1', 'D1', 'F1', 'N1', 'P1']
now = datetime.now(timezone.utc)
start = now.year if now.month >= 7 else now.year - 1  # a season starts in July / August
seasons = [f'{(y % 100):02d}{((y + 1) % 100):02d}' for y in range(start - NS + 1, start + 1)]
os.makedirs(DIR, exist_ok=True)
got = kept = failed = 0
for s in seasons:
    for lg in LEAGUES:
        f = os.path.join(DIR, f'{s}_{lg}.csv')
        if s != seasons[-1] and os.path.exists(f) and os.path.getsize(f) > 1000:
            kept += 1
            continue
        for i in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(f'https://www.football-data.co.uk/mmz4281/{s}/{lg}.csv', headers={'User-Agent': 'safe-bets-app'}), timeout=60) as r:
                    b = r.read()
                if len(b) < 200 or not b.lstrip().startswith((b'Div', b'\xef\xbb\xbfDiv')):
                    raise ValueError('not a results file')
                open(f, 'wb').write(b)
                got += 1
                break
            except Exception as e:  # noqa: BLE001
                if i == 2:
                    failed += 1
                    print(f'  {s} {lg}: {e}')
                time.sleep(1.5 * (i + 1))
print(f'seasons {seasons[0]}..{seasons[-1]}: {got} downloaded, {kept} kept, {failed} failed -> {DIR}')
