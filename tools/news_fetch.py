#!/usr/bin/env python3
"""ESPN headlines and highlight videos for the Highlights screen (news.js), written to news.json.

    python3 -I tools/news_fetch.py [--out news.json] [--limit 50] [--max 180] [--days 10]

Reads ESPN's public news JSON (https://site.api.espn.com/apis/site/v2/sports/<path>/news?limit=50) for the NFL, college
football, the NBA, the NHL, the Premier League and the Champions League. Per item it keeps: id, sport, league, headline,
description, published (ISO, UTC), type ("video" when ESPN marks it as Media or its web link is a video clip, else "story"),
espnType (ESPN's own type: Media, Story, Recap, HeadlineNews...), premium (ESPN+), link (https only, an espn.com page), image
(https only, ESPN's CDN), athletes (names) and teams ({name, abbr}) named in its categories.

news.json: {updated, source, feeds: [{sport, league, n, ok}], missing: [league...], items: [...]} newest first, de-duplicated
(ESPN id, then the same headline), at most --max items with a fair share for every feed, nothing older than --days.
Stdlib only. If every feed fails the old news.json is kept and the exit code is 1.
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else d
OUT, LIMIT, MAXN, DAYS = opt('--out', 'news.json'), int(opt('--limit', 50)), int(opt('--max', 180)), float(opt('--days', 10))
API = 'https://site.api.espn.com/apis/site/v2/sports/'
FEEDS = [  # (ESPN path, our sport key, league label)
    ('football/nfl', 'nfl', 'NFL'),
    ('football/college-football', 'ncaaf', 'College Football'),
    ('basketball/nba', 'nba', 'NBA'),
    ('hockey/nhl', 'nhl', 'NHL'),
    ('soccer/eng.1', 'soccer', 'Premier League'),
    ('soccer/uefa.champions', 'soccer', 'Champions League'),
]
LINK_HOST = re.compile(r'^(?:[a-z0-9-]+\.)*espn\.com$')
IMG_HOST = re.compile(r'^(?:(?:[a-z0-9-]+\.)*espncdn\.com|(?:[a-z0-9-]+\.)*espn\.com|espnmedia-cdn\.akamaized\.net)$')


def get(url):
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'safe-bets-app', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception:  # noqa: BLE001  (network, HTTP or JSON error: retry, then give up on this feed)
            time.sleep(1.2 * (i + 1))
    return None


def https_url(u, host_re):
    """An https URL on an allowed host (http:// on that host is upgraded), else None."""
    if not isinstance(u, str) or not u.strip():
        return None
    try:
        p = urllib.parse.urlsplit(u.strip())
        port = p.port
    except ValueError:
        return None
    host = (p.hostname or '').lower()
    if p.scheme not in ('http', 'https') or not host_re.match(host) or p.username or p.password or port not in (None, 443, 80):
        return None
    return urllib.parse.urlunsplit(('https', host, p.path or '/', p.query, ''))


def clean(s, n):
    s = html.unescape(re.sub(r'<[^>]*>', ' ', str(s or '')))
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^[—–-]+\s*', '', s)  # ESPN wire recaps start with "— "
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'


def iso(s):
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00')).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def web_link(a):
    L = a.get('links') or {}
    w = L.get('web') or {}
    for u in (w.get('href'), (w.get('self') or {}).get('href')):
        v = https_url(u, LINK_HOST)
        if v:
            return v
    return None


def pick_image(a):
    imgs = [i for i in (a.get('images') or []) if isinstance(i, dict)]
    def score(i):
        w = i.get('width') or 0
        photo = i.get('type') != 'stitcher'  # stitcher = ESPN's generated team-logo card
        return (photo, i.get('ratio', '16x9') == '16x9' or photo, min(w, 700))
    for i in sorted(imgs, key=score, reverse=True):
        u = https_url(i.get('url'), IMG_HOST)
        if u:
            return u
    return None


def is_video(a, link):
    if a.get('type') == 'Media' or (a.get('video') and isinstance(a.get('video'), list)):
        return True
    return bool(link and '/video/' in link)


def item(a, sport, league):
    link = web_link(a)
    head = clean(a.get('headline') or a.get('title'), 200)
    t = iso(a.get('published') or a.get('lastModified'))
    if not link or not head or not t or a.get('id') is None:
        return None
    ath, teams, seen_a, seen_t = [], [], set(), set()
    for c in a.get('categories') or []:
        if not isinstance(c, dict):
            continue
        if c.get('type') == 'athlete':
            n = clean((c.get('athlete') or {}).get('description') or c.get('description'), 60)
            if n and n.lower() not in seen_a:
                seen_a.add(n.lower()); ath.append(n)
        elif c.get('type') == 'team':
            tm = c.get('team') or {}
            n = clean(tm.get('description') or c.get('description'), 60)
            if n and n.lower() not in seen_t:
                seen_t.add(n.lower()); teams.append({'name': n, 'abbr': clean(tm.get('abbreviation'), 8) or None})
    desc = clean(a.get('description'), 320)
    return {
        'id': str(a.get('id')), 'sport': sport, 'league': league, 'headline': head,
        'description': '' if desc == head else desc,
        'published': t.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'type': 'video' if is_video(a, link) else 'story', 'espnType': clean(a.get('type'), 20) or None,
        'premium': bool(a.get('premium')), 'link': link, 'image': pick_image(a),
        'athletes': ath[:8], 'teams': teams[:4],
    }


def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=DAYS)
    per, feeds, missing = [], [], []
    for path, sport, league in FEEDS:
        d = get(f'{API}{path}/news?limit={LIMIT}')
        arts = d.get('articles') if isinstance(d, dict) else None
        if not isinstance(arts, list):
            feeds.append({'sport': sport, 'league': league, 'n': 0, 'ok': False}); missing.append(league); per.append([])
            continue
        got = [x for x in (item(a, sport, league) for a in arts if isinstance(a, dict)) if x and iso(x['published']) >= cutoff]
        got.sort(key=lambda x: x['published'], reverse=True)
        feeds.append({'sport': sport, 'league': league, 'n': len(got), 'ok': True}); per.append(got)
    if all(not f['ok'] for f in feeds):
        print(f'news_fetch: every ESPN feed failed; {OUT} left as it was', file=sys.stderr)
        return 1
    # de-duplicate across feeds (a Champions League story can sit in the Premier League feed too): ESPN id, then headline
    seen_id, seen_h, lists = set(), set(), []
    for got in per:
        keep = []
        for x in got:
            hk = (x['type'], re.sub(r'[^a-z0-9]+', ' ', x['headline'].lower()).strip())
            if x['id'] in seen_id or hk in seen_h:
                continue
            seen_id.add(x['id']); seen_h.add(hk); keep.append(x)
        lists.append(keep)
    # a fair share for every feed first (so one busy league cannot push another out), then the newest of the rest
    share = MAXN // max(1, len(FEEDS))
    chosen = [x for L in lists for x in L[:share]]
    rest = sorted((x for L in lists for x in L[share:]), key=lambda x: x['published'], reverse=True)
    chosen += rest[:max(0, MAXN - len(chosen))]
    chosen.sort(key=lambda x: (x['published'], x['id']), reverse=True)
    out = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'ESPN news API (site.api.espn.com), headlines and video links; videos play on espn.com',
           'feeds': feeds, 'missing': missing, 'items': chosen}
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, OUT)
    nv = sum(1 for x in chosen if x['type'] == 'video')
    by = ', '.join(f"{f['league']} {f['n'] if f['ok'] else 'FAILED'}" for f in feeds)
    print(f'news_fetch: {len(chosen)} items ({nv} videos) -> {OUT} [{by}]' + (f'; missing: {", ".join(missing)}' if missing else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
