# Safe Bets: project memory

Read this first. It is the memory of this project across sessions: what is built, where it lives, what runs on a schedule,
and how the owner wants things done. The nightly run adds a dated line to "Change log" and refreshes "Open items".

## The app
- Live: https://claude.ai/artifact/QbHWjenPNPvnc7D16qa1ZW (artifact slug bf0ba756-3c90-4ae3-9ea1-d8d26fe6d3a5), published from this repo.
- Repo: rxfxa/safe-bets-app, branch `claude/sports-parlay-enhancements-o4td79`. Never push elsewhere without the owner's OK.
- A vanilla JS single page (`index.html`) plus modules that use the `window.SB` v2 API (registerTab, goTab, saveParlay, ticketCard,
  p1, parlayProb, simGame, ...): soccer.js, sim.js, lottos.js, ufc.js, slipcheck.js, polymarket.js, upsets.js, pattern.js, plan.js, firsttd.js.
- Engine (index.html): soccer and NHL priced from exact score grids; NBA, NFL and college football from 100,000 seeded simulations per game.
  Same-game legs are priced jointly.

## Tabs (Find bets group, roughly in order)
- **Trending → 🧠 My Parlay Picks.** Chosen once a day for one Los Angeles day:
  - three 3-leg exact-score parlays;
  - a 5-leg same game parlay;
  - a 10-leg mix covering every league;
  - a 15-leg NBA props parlay (lines a point or two under the average, with a toggle for over), 2 per game, every game;
  - 3- and 5-leg underdog moneylines (25-46%).
  - Source order: mypicks.json from the daily run, then the device's lock, then build and lock.
- **Fantasy Parlay:**
  - the fantasy ticket and high-yield tickets;
  - a same game parlay (pick a game, 2-10 legs);
  - a 20-leg safest combo on one day;
  - **duo / trio stacks**: same-team starters whose stats feed each other (playmaker assists + scorer points + big rebounds; never two players on one stat), close games first, last-4 box scores, substitutes, legs and games scrollers.
- **Upset Parlays (upsets.js):**
  - underdogs and draws from Polymarket;
  - researched form (form.json) and a form-backed parlay;
  - a streak check (who each run came against);
  - close games with an edge (home side, opponent injuries).
- **📅 Weekend Patterns (pattern.js):**
  - tests the tweet "weekends when all big teams lose / 80% draws" on 90 days of results (pattern.json). Verdict: not true. Big favourites beat their prices instead.
  - shows the current round live, and next round's parlay mix.
- **Other tabs:** Soccer Parlays, Point Lottos, Polymarket, Weekly Plan, Best Parlays, NBA Props, First TD, UFC.
- **Your bets:** My Parlays (ledger, grading) and Slip Check (screenshot or typed slips, 500,000-run simulation, recommended changes).

## Every parlay card
- **Swap legs (⇄):** 3+ substitutes of about the same chance that don't clash with the card. No player twice, no two players on one team for one stat, and the card's own rules hold. Kept per card for the day, with undo.
- **🎲 500,000 runs:** game by game. Player legs are benched in simulated blowouts, and teammates share a team factor (correlation 0.2). Re-runs after a swap.
- **▶ Watch live** opens the Simulator.
- **Player model:** season average, with recent form (playerform.json) counting 30%. The team's expected points come from the total and spread. In blowouts (15+ NBA, 17+ NFL, 21+ college), starters ×0.8 and bench ×1.15.

## Data files (who writes them)
| File | Written by |
|---|---|
| data.json | the hourly task "FirstMove hourly games refresh" (publishes to the artifact only; copy it into the repo before using it) |
| polymarket.json | tools/polymarket_fetch.py |
| ufc.json | tools/ufc_fetch.py |
| mypicks.json | tools/make_picks.mjs (3:47 AM run) |
| injuries.json | research runs (NBA teams playing that day) |
| nbaroles.json | Basketball-Reference season averages for all 30 teams (refreshed 2026-11-23) |
| form.json | tools/form_teams.py → tools/form-research.wf.js → tools/form_merge.py |
| playerform.json | tools/nba_last4.py (ESPN box scores) and tools/player-form-research.wf.js → playerform_merge.py |
| nbalast4.json | tools/nba_last4.py |
| pattern.json | tools/weekend_pattern.py (football-data.co.uk CSVs; fixtures in tests/fixtures/fd) |
| props.json, scorers.json, firsttd.json, firstbasket.json, playerstats.json | older research files |

## Scheduled tasks
All of these fire into this session (`session_01BXNfXbMbY5NYSUdc1M3X6r`). Times are America/Los_Angeles.
- **3:47 AM daily, "Safe Bets: daily data refresh + My Parlay Picks"** (trig_0154hy44mSKH3UCJM4kjvses): game feed, Polymarket, UFC, NBA injury report, make_picks, publish.
- **7:32 AM daily, "Safe Bets: morning form research"** (trig_01HGBuKM416rUSPocccDMoui): nba_last4 box scores, team form, player form, weekend pattern, injury re-check of every picked leg, publish. Done by 8 AM as the owner asked. **Do not change its schedule.**
- **11:34 PM daily, "Safe Bets: nightly memory + build save"** (trig_01EfBa9zKHBDbwWgywjhNQPV): updates this file, commits and pushes, runs the tests, and makes sure the live app matches the repo.
- **Sunday 8:17 PM, "Safe Bets: weekly slip grading and report"** (trig_01F9w4ED73EpBHW6db2vSDdf): grades Weekly Plan slips and reports SAFE / COIN FLIP / LOTTO / big slips / POLYMARKET.
- **Hourly at :55, "FirstMove hourly games refresh"** (trig_011dcsKBB9zytWc2jL2e3jdQ): owns data.json. Not ours to change without the owner's OK.

## How to publish
- Artifact publish with url = the app, file_path = index.html, files = only the changed modules and data files. Leave data.json out: the hourly task owns it.
- **If refused for a newer version:**
  1. Compare the saved live copy's sha256 with `git show <commit>:index.html` for recent commits.
  2. If it equals one of ours, publish again unchanged and it goes through.
  3. For supporting files that weren't read this session, read them first (action read, paths).

## Tests
- `node tests/<name>.test.mjs` (Playwright + Chromium preinstalled). There are 30 suites, all on saved fixtures with a fixed clock, so they don't depend on the live feed.
- New features get a test file. Run the whole suite before publishing:

  `for t in tests/*.test.mjs; do node $t; done`

## Network
- The environment allows Polymarket (gamma, clob, data-api), ESPN (www.espn.com, site.api.espn.com), fbref.com, www.basketball-reference.com, and football-data.co.uk (both hosts).
- Most other stats sites are blocked, so prefer these. site.web.api.espn.com is not allowed.

## The owner's standing preferences
- **Fast:** keep it quick. Use few agents unless asked; delegate only independent work.
- **Honest numbers:** never "guaranteed", never treat 90% as certain, never claim a loss is "due". Show model estimates as estimates, label small samples, and don't invent stats.
- **Research for real:** verify with a second source where possible, and say what couldn't be verified.
- **500,000 runs** for any simulation. Swap legs on parlays.
- **Security:**
  - Never ask for, store or use API keys, wallet keys or seed phrases.
  - A Polymarket API key was once pasted in chat: never use it.
  - Bets are placed only by the owner (tools/place_slip.py runs on their own machine).
- **Commits:**
  - End with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01BXNfXbMbY5NYSUdc1M3X6r`.
  - No model names in code.
  - Commit and push work when done; the stop hook insists.

## Open items
- **Polymarket wallet:** not saved in Settings, so the weekly report can't sync positions. Only the owner can add it.
- **Polymarket parlays:** Weekly Plan's builder can miss the SAFE / COIN targets even when there are enough strong legs (it would need a redesign).
- **Search box:** does nothing on most module tabs.
- **Missing soccer leagues:** Europa League, Eredivisie and Primeira Liga aren't in data.json (the hourly feed), so the Soccer tabs can't price them.
- **pattern.json:** results come only from the CSVs (finished games in data.json carry no pre-match chance), so it lags until football-data.co.uk updates.
- **Keyboard access:** a user needs about 41 Tab presses to reach the first game. A skip link would fix that.

## Change log
- 2026-11-22:
  - My Parlay Picks; QA by 3 agents (64 findings, nearly all fixed).
  - Upset Parlays: form, streak check, close-game edges, swaps.
  - Swap legs and 500,000-run sims on every card; player model that reads the game.
- 2026-11-23:
  - Weekend Patterns tab (tweet tested: not true).
  - Fantasy duo/trio stacks with last-4 ESPN box scores.
  - Network access approved for ESPN, FBref, Basketball-Reference and football-data.co.uk.
  - nbaroles refreshed (Portland added).
  - Live-feed tests moved to fixtures.
  - This memory file and the nightly save.
