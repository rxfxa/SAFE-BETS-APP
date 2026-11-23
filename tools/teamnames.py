"""Match a club name from ESPN (or the feed) to football-data.co.uk's short names ("Manchester City" -> "Man City")."""
import re, unicodedata

ALIAS = {'man city': 'manchester city', 'man united': 'manchester united', "nott m forest": 'nottingham forest', 'ath madrid': 'atletico madrid',
         'ath bilbao': 'athletic club', 'sociedad': 'real sociedad', 'betis': 'real betis', 'celta': 'celta vigo', 'espanol': 'espanyol',
         'paris sg': 'paris saint germain', 'st etienne': 'saint etienne', 'm gladbach': 'borussia monchengladbach', 'ein frankfurt': 'eintracht frankfurt',
         'fc koln': 'koln', 'leverkusen': 'bayer leverkusen', 'dortmund': 'borussia dortmund', 'bayern munich': 'bayern munich',
         'sp lisbon': 'sporting cp', 'sp braga': 'braga', 'guimaraes': 'vitoria guimaraes', 'psv eindhoven': 'psv eindhoven', 'az alkmaar': 'az alkmaar',
         'twente': 'fc twente', 'utrecht': 'fc utrecht', 'inter': 'internazionale', 'milan': 'ac milan', 'roma': 'as roma', 'verona': 'hellas verona',
         'spurs': 'tottenham hotspur', 'tottenham': 'tottenham hotspur', 'wolves': 'wolverhampton wanderers', 'west ham': 'west ham united',
         'newcastle': 'newcastle united', 'brighton': 'brighton hove albion', 'leicester': 'leicester city', 'hertha': 'hertha berlin',
         'union berlin': 'union berlin', 'mainz': 'mainz', 'hoffenheim': 'hoffenheim', 'wolfsburg': 'wolfsburg', 'freiburg': 'freiburg',
         'stuttgart': 'stuttgart', 'rb leipzig': 'rb leipzig', 'nijmegen': 'nec nijmegen', 'go ahead eagles': 'go ahead eagles', 'heerenveen': 'heerenveen',
         'vitesse': 'vitesse', 'feyenoord': 'feyenoord', 'ajax': 'ajax', 'lens': 'lens', 'lille': 'lille', 'nice': 'nice', 'rennes': 'rennes',
         'marseille': 'marseille', 'lyon': 'lyon', 'monaco': 'monaco', 'brest': 'brest', 'reims': 'reims', 'nantes': 'nantes', 'strasbourg': 'strasbourg',
         'villarreal': 'villarreal', 'osasuna': 'osasuna', 'girona': 'girona', 'vallecano': 'rayo vallecano', 'granada': 'granada', 'sevilla': 'sevilla',
         'valencia': 'valencia', 'benfica': 'benfica', 'porto': 'porto', 'gil vicente': 'gil vicente', 'pacos ferreira': 'pacos de ferreira',
         'santa clara': 'santa clara', 'arouca': 'arouca', 'famalicao': 'famalicao', 'fiorentina': 'fiorentina', 'lazio': 'lazio', 'napoli': 'napoli',
         'atalanta': 'atalanta', 'juventus': 'juventus', 'bologna': 'bologna', 'torino': 'torino', 'sheffield united': 'sheffield united',
         'west brom': 'west bromwich albion', 'qpr': 'queens park rangers'}
STOP = {'fc', 'cf', 'ac', 'sc', 'afc', 'ss', 'as', 'us', 'cd', 'ud', 'rc', 'ca', 'sv', 'vfl', 'vfb', 'tsg', 'fsv', '1', 'de', 'club', 'calcio', 'cp',
        'olympique', 'stade', 'rcd', 'bk', 'sk', 'fk', 'osc', 'ogc', 'losc', 'sl', 'clube', 'futebol', 'hotspur', 'albion', 'hove', 'and', '04', '05', '1899',
        '1846', '1848', '1909', 'eindhoven', 'alkmaar', 'enschede', 'arnhem', 'balompie'}
# names ESPN (or the feed) uses that differ from the full names above
ESPN = {'stade rennais': 'rennes', 'paris saint germain': 'paris saint germain', 'olympique lyonnais': 'lyon', 'olympique de marseille': 'marseille',
        'atletico de madrid': 'atletico madrid', 'internazionale milano': 'internazionale', 'inter milan': 'internazionale', 'sporting': 'sporting cp',
        'sc braga': 'braga', 'vitoria de guimaraes': 'vitoria guimaraes', 'vitoria sc': 'vitoria guimaraes', 'tottenham': 'tottenham hotspur',
        'brighton and hove albion': 'brighton hove albion', 'wolves': 'wolverhampton wanderers', 'bournemouth': 'afc bournemouth',
        'deportivo alaves': 'alaves', 'rcd mallorca': 'mallorca', 'rcd espanyol': 'espanyol', 'athletic bilbao': 'athletic club', 'cadiz': 'cadiz',
        'fc st pauli': 'st pauli', 'hamburger sv': 'hamburg', 'koln': 'koln', 'fc cologne': 'koln', '1 fc koln': 'koln', 'nec': 'nec nijmegen',
        'psv': 'psv eindhoven', 'az': 'az alkmaar', 'paris fc': 'paris fc', 'le havre ac': 'le havre', 'ac ajaccio': 'ajaccio',
        # the feed's (data.json) names
        'inter milano': 'internazionale', '1 fc cologne': 'koln', 'stade rennais fc': 'rennes', 'rc deportivo de a coruna': 'la coruna',
        'deportivo la coruna': 'la coruna', 'deportivo de la coruna': 'la coruna', 'espanyol barcelona': 'espanyol', 'rcd espanyol barcelona': 'espanyol'}


def nk(s):
    s = unicodedata.normalize('NFD', str(s or '').lower()).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ]+", ' ', s)).strip()


def toks(s):
    return [t for t in nk(s).split() if t not in STOP]


def fd_match(name, fd_names, min_score=0.75):
    """The football-data name for this club, or None. Every word of the shorter name must match a word of the other
    (exactly, after the aliases above). Deterministic: names are tried in sorted order, and a tie between two clubs
    (e.g. 'Espanyol Barcelona' against both Espanol and Barcelona without its alias) gives None, never a coin flip."""
    a = toks(ESPN.get(nk(name), name))
    best, bs, tie = None, 0.0, False
    for f in sorted(fd_names):
        b = toks(ALIAS.get(nk(f), f))
        if not a or not b:
            continue
        x, y = (a, b) if len(a) <= len(b) else (b, a)
        hit = sum(1 for t in x if t in y)
        sc = hit / len(x) - 0.01 * abs(len(a) - len(b))
        if nk(ESPN.get(nk(name), name)) == nk(ALIAS.get(nk(f), f)):
            sc = 2
        if sc > bs:
            bs, best, tie = sc, f, False
        elif sc == bs and sc > 0:
            tie = True
    return best if bs >= min_score and not tie else None
