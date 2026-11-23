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
  - **reception legs (NFL / college)**: receivers' catches from their last 4 ESPN box scores (nflrec.json, tools/rec_last4.py), each with his levels (ladder of lines and chances); a 4-leg reception parlay, one catcher per team;
  - **duo / trio stacks**: same-team starters whose stats feed each other (playmaker assists + scorer points + big rebounds; never two players on one stat), close games first, last-4 box scores, substitutes, legs and games scrollers.
- **Upset Parlays (upsets.js):**
  - underdogs and draws from Polymarket;
  - researched form (form.json) and a form-backed parlay;
  - a streak check (who each run came against);
  - close games with an edge (home side, opponent injuries).
- **📅 Weekend Patterns (pattern.js):**
  - tests the tweet "weekends when all big teams lose / 80% draws" on 90 days of results (pattern.json). Verdict: not true. Big favourites beat their prices instead.
  - shows the current round live, and next round's parlay mix.
- **📈 Team Trends (trends.js, trends.json from tools/team_trends.py):** every team's last 7 / 30 days, months and season: record, over/under rates, as favourite / underdog vs prices, streaks; upset watch and over/under leans for next games with reasons and sample sizes (soccer from football-data.co.uk CSVs, NBA from ESPN scores and posted lines); a trend parlay card.
- **Other tabs:** Soccer Parlays, Point Lottos, Polymarket, Weekly Plan, Best Parlays, NBA Props, First TD, UFC.
- **Your bets:** My Parlays (ledger, grading) and Slip Check (screenshot or typed slips, 500,000-run simulation, recommended changes).

## Every parlay card
- **Swap legs (⇄):** 3+ substitutes of about the same chance that don't clash with the card. No player twice, no two players on one team for one stat, and the card's own rules hold. Kept per card for the day, with undo.
- **🎲 500,000 runs:** game by game. Player legs are benched in simulated blowouts, and teammates share a team factor (correlation 0.2). Re-runs after a swap.
- **▶ Watch live** opens the Simulator.
- **★ Rec next to every leg** (and ⇄): the swap list puts one RECOMMENDED pick on top. Every option says why: value, how it fits the card (assists feed a teammate's points), close game or blowout risk, recent box scores, and lessons (kinds of legs that keep missing are flagged and ranked down).
- **The parlay builder** has ★ Rec and ⇄ on every leg too (same rules); picking a swap replaces that leg in the slip.
- **Track record (recs.json, tools/recs.mjs):**
  - The 3:47 AM run grades every saved day (`node tools/recs.mjs grade`): game legs from final scores, NBA player legs from ESPN box scores.
  - It then saves the new day's parlays (`node tools/recs.mjs snapshot`, after make_picks).
  - "How our parlays did" shows on My Parlay Picks (all types) and Fantasy (its own types).
  - A My Parlay Picks card that misses a leg gets a "Replacement" card of the same kind, from games still to play.
  - "Lessons so far": each kind of leg's hit rate vs what the model expected (memory of what loses), with what to do next time.
- **Player model:** season average, with recent form (playerform.json) counting 30%. The team's expected points come from the total and spread. In blowouts (15+ NBA, 17+ NFL, 21+ college), starters ×0.8 and bench ×1.15.

## Look
- Long descriptions (.why / .note / reasons) clamp to 3 lines with "Read more" / "Show less" (clampLong, runs after every render).
- Clean theme (2026-11-23): slate background, flat rounded cards, Inter font, no italics / caps / glows, pill chips and price buttons (a Polymarket-style override block at the end of index.html's main style). Logo and layout kept.

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
| nflrec.json | tools/rec_last4.py (ESPN box scores, NFL / college receivers on upcoming games) |
| trends.json | tools/team_trends.py (7:32 AM run) |
| recs.json | tools/recs.mjs: each day's recommended parlays, graded the next morning (30 days kept) |
| props.json, scorers.json, firsttd.json, firstbasket.json, playerstats.json | older research files |

## Scheduled tasks
All of these fire into this session (`session_01BXNfXbMbY5NYSUdc1M3X6r`). Times are America/Los_Angeles.
- **3:47 AM daily, "Safe Bets: daily data refresh + My Parlay Picks"** (trig_0154hy44mSKH3UCJM4kjvses): game feed, Polymarket, UFC, NBA injury report, grade yesterday (recs.mjs grade), make_picks, snapshot today (recs.mjs snapshot), publish.
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
- `node tests/<name>.test.mjs` (Playwright + Chromium preinstalled). There are 35 suites, all on saved fixtures with a fixed clock, so they don't depend on the live feed.
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
  - Track record: every recommended parlay is saved and graded.
  - Nov 22's 9 picks all missed (the 10-leg mix on 1 leg, the SGP on 1 leg, NBA 14-leg props 10/14).
  - Replacements for missed picks; ⇄ swap in the builder.
  - ★ Rec swaps with reasons; lessons; clean Polymarket-style theme.
  - 📈 Team Trends tab (248 teams; upset watch, over/under leans).
  - NFL / college reception legs (259 receivers, last 4 box scores, levels); "Read more" on long text.
