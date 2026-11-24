# Safe Bets Pro interface (2026-11-24)

The owner asked for "an exact 1:1 kind of interface" of rotobot.ai, "to do what this app/website can do".
This file is the spec: what the reference does, what we build, how it maps onto our engine, and where we honestly
cannot match it.

**Ground rules**
- Same layout, flow and kinds of screens. Our own name, logo, words and data.
- Never use RotoBot's name, logo, mascot, images or copy.
- Honest numbers (CLAUDE.md):
  - every chance is a model estimate;
  - no "guaranteed", no "lock", no "due";
  - label small samples;
  - no invented stats;
  - when we lack a data source, say so on the screen and show the closest real thing we have.

## 1. The reference (captured 2026-11-24)

Captures from a headless browser are in the session scratchpad, `/tmp/claude-0/-home-user-SAFE-BETS-APP/7151ce4f-818b-5d0a-818f-44cf3898379e/scratchpad/`:
- `rb_dump/*.json`: page text and structure.
- `rb_crops/*.d.N.png` (desktop) and `*.m.N.png` (phone): full pages cut into screens.
- `rb_scroll/root.NN.png` and `sheet_root_0..3.png`: the home page frame by frame (it animates on scroll).

The in-app screens sit behind a sign-in, so the reference for each one is:
- the app shell itself, from `rb_crops/_app_upgrade.d.0.png` and `_stats_qb_passing-yards.d.0.png`;
- the mockups on the marketing and feature pages.

**App shell.**
- A left sidebar 260px wide:
  - logo row and a collapse button;
  - a `BETTING` / fantasy switch;
  - nav items with line icons: Chat, Insights, Prop Analyzer, Prop Explorer, Games, Sharp Board, Highlights, Parlay, Players, Stat Explorer;
  - the account row at the bottom.
- On phones:
  - a top bar with a round menu button, the logo and a cyan pill;
  - the sidebar becomes a drawer.
- Look:
  - near-black navy background `#030712` / `#000513`;
  - cards `#080d19` with hairline borders `rgba(255,255,255,.1)` and radius 20-24px;
  - cyan accent `#00d3f2` / `#3ec4ff`;
  - green `#00d492` (also the fantasy accent), pink `#f11e84` (misses), amber `#ffb800`.
- Type:
  - Rubik for the UI, with heavy italic uppercase display titles that have a cyan gradient accent;
  - Inter for body text;
  - JetBrains Mono for uppercase kicker labels with a glowing dot.

**Screens shown in the reference:**

1. **Chat (Ask).**
   - Suggestion chips and an "Ask … anything" box.
   - The answer is a structured card:
     - player, position badge, market and odds, matchup and time;
     - a verdict band ("Take this bet" plus a strength tag);
     - a bar chart of recent games against the line ("4 of 4 with a TD");
     - four factor tiles (Matchup, Trends, Game script, Usage), each with a coloured status.
   - Also "scan a bet slip".
2. **Game sims.**
   - A game simulated 10,000 times, with one typical game shown play by play.
   - Win probability and play-by-play.
3. **Parlay builder.**
   - Swipe prop cards: Add to slip or Pass.
   - Each card shows hit rate (L10 dots), a matchup score (0-100 with a bar) and "Flip for the full matchup".
   - The slip lists legs and odds, the combined price ("+581, $100 pays $681") and "Send to your book".
   - A generator: sport, legs, risk.
4. **Props board.**
   - Every prop on the slate ranked by hit rate.
   - Rows show photo, line, L10 dots, hit %, and matchup score with a bar.
   - Toggle between HIT % and MATCHUP.
5. **Smart Money (Sharp Board).**
   - Money % vs bets % per side, as two bar pairs.
   - Opening vs current line.
   - A highlighted signal ("Seahawks −7: bigger bets, fewer bettors").
6. **Games.**
   - Each matchup with team logos and time.
   - "Model edge · Lean · Spread", with the edge %.
   - Tiles for Spread, Money and Total.
   - Unit ranks (pass offense #9 vs pass defense #4).
7. **Fantasy.**
   - Trade finder: You give up / You receive, player values, totals, a "Trade verdict: STRONG ACCEPT" band and a trade edge % on a meter.
   - Start/sit, waivers, rate my team, draft rankings and helper.
   - League sync with ESPN, Sleeper and Yahoo.
8. **Stat Explorer.**
   - Sport pills (NFL/NBA/MLB/NHL).
   - Selects: Season, Rows, Weeks, Per game, scoring.
   - Position chips: QB, RB, WR, TE, Receiving, Rushing, Team offense, Team defense.
   - Situation filters.
   - A table with heat-shaded cells; the first column holds the player name with his team in cyan.
9. **Insights.** A daily board of prop cards (the flip cards), sorted by edge, hit rate, probability or time.
10. **Prop Analyzer.** Any player and market: game logs, splits, matchup, projection, and edge vs the line.
11. **Players.** Search, sport chips with counts, top projected players, and player pages.
12. **Highlights.** Player and league video reels next to the props.

## 2. What we build (keys, files, data)

The shell is in `index.html`:
- the sidebar, plus the drawer on phones;
- the `BETTING` / `FANTASY` switch (`body.mode-fantasy` turns the accent green);
- `SB.setMode`, `SB.openNav`, `SB.closeNav`;
- default screen: Chat.

The new screens are modules (`window.SB` v2, `registerTab`). Each has its own file and `tests/<name>.test.mjs`.

| Key | Label | File | Mode | Data |
|---|---|---|---|---|
| `ask` | Chat | ask.js | both | everything below, through page tools |
| `insights` | Insights | insights.js | betting | DATA.players + engine, playerform, nbalast4, season.json |
| `explorer` | Prop Explorer | insights.js | betting | same |
| `propan` | Prop Analyzer | propan.js | betting | same + season.json logs |
| `slate` | Games | slate.js | betting | DATA.games + engine, trends.json, polymarket.json |
| `sharp` | Sharp Board | sharp.js | betting | polymarket.json vs the feed |
| `news` | Highlights | news.js | betting | news.json (tools/news_fetch.py, ESPN) |
| `builder` | Parlay | builder.js | betting | engine (buildTicket, parlayProb), SB.slip |
| `players` | Players | players.js | both | season.json + DATA.players |
| `statx` | Stat Explorer | statx.js | both | season.json |
| `ff-startsit` / `ff-trade` / `ff-rate` / `ff-rank` | Start / Sit, Trade Analyzer, Rate My Team, Rankings | ffb.js | fantasy | season.json (NFL) + games |

**Where the reference is out of reach, and what we show instead (say it on the screen):**
- **No sportsbook prop prices:** the feed has game win chances only. So there is no "edge vs the book" on props.
  - We show the model chance and its **fair odds** ("bet only at +X or better").
  - The viewer can type their book's price (Chat, Prop Analyzer) to get the edge against it.
- **No money / ticket splits.** The Sharp Board compares two real-money markets instead: Polymarket's price vs the
  sportsbook consensus in our feed. It also shows Polymarket volume. It says it is not a betting-split feed.
- **No highlight videos.** Highlights are ESPN headlines and video links from news.json, each opening on espn.com (https).
  Headlines that name a player on the slate link to his props.
- **No league sync** (it needs your logins and hosts we do not reach). Rosters are entered by hand and kept on the device.
- **No MLB / UFC props / F1.** Coverage is NFL, college football, NBA, NHL and soccer (UFC fights are in their own tab).
- **No sign-in or pricing:** nothing is locked. "Send to your book" becomes "Copy slip" (bets are placed only by the owner).

## 3. Shared pieces modules use

`SB.ui` (ui.js) returns HTML strings with every value escaped. The functions are listed at the top of ui.js:
- `page`, `pills`, `seg`, `select`;
- `dots`, `meter`, `tone`, `verdict`, `factors`, `gameLog`;
- `propCard` (the flip card), `team`, `split`, `table`, `tiles`, `empty`;
- `fair`, `pays`, `esc`.

Classes are `.ui-*` (index.html, "Pro interface" block). Accent variables are `--acc`, `--acc2` and `--acc-rgb`; use them so fantasy mode turns green.

`SB.engine` (index.html) gives read-only access to the model:
- **Constants:** `LADDER` (lines per stat), `STATN` (stat names), `YARDS`, `STAT_PREF`, `BLOW`, `SPORTNAME`.
- **Players:**
  - `isP(key)`;
  - `pLegInfo(key)` → {pl, thr, under, p};
  - `playerById(id)`;
  - `playerLegs(pl)` → ladder [{key, thr, p, label}] (p .5-.97);
  - `playerP(pl, thr)`;
  - `playerParts(pl, thr, under)`;
  - `playerMeans(pl)` → {an (normal game), ab (blowout), pb (blowout chance), rf (recent form), c (team context)}.
- **Recent form and team context:**
  - `recentOf(pl)` (playerform last 5);
  - `last4Of(team, name)` (NBA box scores);
  - `teamCtx(g, team)` → {tf (team points vs league average), pb, mu};
  - `closeOf(g)` → {p: chance within 8}.
- **Links between legs:** `legMeta`, `legRho`, `pairRow`, `helpWhy(r, legA, legB)`.
- **Builders and helpers:**
  - `buildTicket({n, sports, minP, target, perGame, perPlayer, propsOnly, gids, seed, pair})` → {legs, p};
  - `subCands(legs, i, cardId)`;
  - `simJoint(legs, N)`;
  - `lessons()`, `legKind(leg)`, `myPicks()`;
  - `dayOf(ms)` (Los Angeles day), `nextDay`, `dayGames(day)`;
  - `injuries` (injuries.json), `nflByTd` (anytime TD players);
  - `jointP`, `p2am`, `fmtAm`, `nameKey`, `tdSlug`.

Also on `SB`:
- `p1(g, key)` (any leg's chance), `parlayProb(legs)` → {p, indep};
- `marketsFor(g)`, `gameById`, `openG`, `priced`, `fit(g)` (margin model: mu, sd, T, tsd);
- `toggleLeg(gid, key)`, `inSlip`, `setSlip`, `openSlip`, `slip`;
- `ticketCard(id, title, T, sub)` (a full parlay card: swap legs, 500,000 runs);
- `saveParlay`, `openGame(gid)`, `goTab(key, params)`, `on('data', fn)`, `openSheet`;
- `season()` → Promise of season.json (loaded once).

Player leg keys are:
- `P:<playerId>:<line>`, meaning line+ (over);
- `U:<playerId>:<line>` (under);
- anytime TD: `TD:A:<TEAM>:<slug>`.

Game keys: `H`, `A`, `D`, `O2.5`, `U44.5`, `H3.5` (home by 4+), `BTTS`, `CS2-1`.

**season.json** (tools/season_tables.py, from the ESPN box-score cache):
- Layout: `sports[sp] = {games, teams: {ESPN abbr: name}, fields, players: [{n, t, pos, gp, tot, log: [[date, opp, home, ...fields]]}]}`.
- Fields:
  - NFL / college: pa, pyd, ptd, ra, ryd, rtd, tgt, rec, recyd, ctd;
  - NBA: min, pts, reb, ast;
  - NHL: g, a, sog;
  - soccer: g, sot, sh.
- Team abbreviations are ESPN's. Match feed teams by abbreviation first, then by name with `nameKey`.

**Fair odds and payouts.** Fair odds come from a chance `p` (`SB.ui.fair(p)`) and so does the fair payout (`SB.ui.pays(p)`). Never call them book prices.

**Matchup score** (0-100, an estimate): 50 + 250·(tf − 1) − 60·max(0, pb − 0.15), clamped.
- tf: the team's expected points vs the league average, from the game's price.
- pb: the blowout chance.
- Labels: ≥ 60 "Soft matchup", < 40 "Tough", else "Neutral".
- Where tf is unknown (no price), show "—".

**Verdict** (from the model chance, and from the edge when the viewer gave a price):
- With a price, compare the model chance with the implied chance:
  - "Take this bet" when the edge is 3 points or more and the chance is 50% or more;
  - "Lean" when the edge is 0-3 points;
  - "Pass" when the edge is below 0.
- Without a price:
  - ≥ 70% "Strong lean";
  - 58-70% "Lean";
  - 45-58% "Coin flip";
  - < 45% "Long shot".
- The tag says "model estimate".

## 4. Conventions for every module

- One IIFE.
  - Check for `window.SB` v2 and `SB.ui`.
  - `SB.registerTab({key, label, render(main, params)})`, labels plain text (the sidebar adds the icon).
  - Never edit index.html or another module's file. Ask the orchestrator if a shell change is needed.
- **Rendering:**
  - Render into `main` and start with `SB.ui.page(...)`.
  - Use `.ui-*` classes. Add module CSS in one `<style id="<key>-css">` injected once, prefixed with the module's class.
  - Escape every value. Links only `https://`.
- **Behaviour:**
  - No network except our own JSON files.
  - Per-viewer settings go in `localStorage` (try/catch).
  - Re-render on `SB.on('data')` only when the tab is showing (`SB.tab === key`).
- **Layout and speed:**
  - Phone first: 390px wide with no horizontal page scroll (tables scroll inside `.ui-tablewrap`).
  - Tap targets 40px+.
  - First render under 1,500 ms on the fixture slate.
- **Tests:** a `tests/<key>.test.mjs` using `tests/lib/harness.mjs`.
  - Fixtures are pinned and the clock is 2026-11-23T12:00Z.
  - Cover: the tab renders, the core interactions, the honest labels, no page errors, and no horizontal scroll at 390px.
  - Run the full suite before handing back: `for t in tests/*.test.mjs; do node $t; done`.

## 5. Moving between screens (`SB.goTab(key, params)`)

Screens hand work to each other with these params. Each screen must accept them and work without them.

**Analyze and ask:**
- `propan`: `{id}`, a DATA.players id. Optional `line` (number) and `under` (bool). Or `{name, stat}`.
  Opens that player and market.
- `ask`: `{q}` puts the question in the box. With `send: true` it is asked straight away (only on a viewer's click).

**Browse:**
- `players`: `{name, sport}` opens that player's page.
- `slate`: `{gid}` scrolls to and opens that game.
- `statx`: `{sport, pos}`.
- `insights`: `{sport}`.

**Build:**
- `builder`: `{sport}` sets the generator's sport. The slip itself is the app's global slip (`SB.slip`, `SB.toggleLeg`).
- `ff-trade`: `{give: [names], get: [names]}`.
