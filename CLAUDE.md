# Safe Bets: project memory

Read this first. It is the memory of this project across sessions: what is built, where it lives, what runs on a schedule,
and how the owner wants things done. The nightly run adds a dated line to "Change log" and refreshes "Open items".

## The app
- Live: https://claude.ai/artifact/QbHWjenPNPvnc7D16qa1ZW (artifact slug bf0ba756-3c90-4ae3-9ea1-d8d26fe6d3a5), published from this repo.
- Repo: rxfxa/safe-bets-app, branch `claude/sports-parlay-enhancements-o4td79`. Never push elsewhere without the owner's OK.
- A vanilla JS single page (`index.html`) plus modules that use the `window.SB` v2 API (registerTab, goTab, saveParlay, ticketCard,
  p1, parlayProb, simGame, ...): soccer.js, sim.js, lottos.js, ufc.js, slipcheck.js, polymarket.js, upsets.js, pattern.js, plan.js, firsttd.js, pastslips.js.
- Engine (index.html): soccer and NHL priced from exact score grids; NBA, NFL and college football from 100,000 seeded simulations per game.
  Same-game legs are priced jointly.

## Pro interface (2026-11-24; spec: docs/pro-interface.md)
- The owner asked for "an exact 1:1 kind of interface" of rotobot.ai, to do what it does. We match its layout and function, keep our own name, logo and words, and never copy RotoBot's branding, images or text.
- **Shell (index.html):**
  - left sidebar (260px) with a BETTING / FANTASY switch (`body.mode-fantasy` turns the accent green);
  - on phones, a top bar (menu, logo, Ask) and the sidebar as a drawer (`SB.openNav` / `SB.closeNav`; tests open it before clicking a tab or the search box);
  - navy `#030712` with cyan `#00d3f2` / `#3ec4ff`, Rubik + Inter + JetBrains Mono;
  - default screen: Chat.
- **Sidebar groups:** Research (the new screens), Safe Bets picks, Your bets, Games, Tools. Fantasy mode shows Chat, Start / Sit, Trade Analyzer, Rate My Team, Rankings, Players, Stat Explorer, Fantasy Parlay.
- **New screens (one module each, `SB.ui` components from ui.js, `SB.engine` read-only model access):**
  - ask.js (Chat: the `sample` capability with page tools; a model-only mode when AI isn't available). Breakdowns (2026-11-25, owner: "a breakdown of what went right or wrong with players stats or parlay ... fully verse ... any sport question about any player"):
    - tools player_stats (any player in season.json: totals, per game, last games, splits, next game, injuries, headlines), review_player (one game vs the line or his average: how close, workload, margin, opponent, form; reasons split into facts and possibilities), review_parlay (the app's picks, My Parlays or typed legs: each leg graded, the leg that broke it, near misses, links, track record), team_report, leaders, track_record; each draws a card;
    - rules: tools for every current-season number; general knowledge only for background, labelled "general knowledge (may be out of date)"; breakdowns go what happened → why it likely happened → how close → what it says; no hindsight words, never "due";
    - grading matches the morning run's `res` on every recs.json leg; anytime TD = TDs he scored (passing TDs only when said); a push is its own status; a player with no box-score line since his last game is said to have not played;
    - limits said in the app: soccer club codes differ between the feed and ESPN (unlinked clubs say so), season.json keeps 15 games for NBA / NHL / soccer, no threes / steals / blocks / shooting / saves;
  - insights.js (Insights flip cards + Prop Explorer table);
  - propan.js (Prop Analyzer), players.js, statx.js (Stat Explorer);
  - slate.js (Games), sharp.js (Sharp Board: Polymarket vs the books, since we have no money / ticket splits);
  - news.js (Highlights: ESPN links, tools/news_fetch.py);
  - builder.js (Parlay: swipe + generate + slip);
  - ffb.js (fantasy screens).
- **Honest gaps shown on screen:** no sportsbook prop prices (we show model chance + fair odds), no betting splits, no hosted video, no league sync, no MLB / F1.
- **season.json** (tools/season_tables.py, from leg_pairs.py's ESPN box-score cache): every player's season totals and game logs for NFL, college, NBA, NHL, soccer. It is loaded only by the screens that need it (`SB.season()`).
- **Tests for new screens:** tests/lib/harness.mjs (fixtures pinned, clock 2026-11-23T12:00Z): ask, insights, propan, players, slate, sharp, news, builder, statx, ffb.
- **Box-score dates are UTC** (a 4 PM PT game is dated the next day). A logged game counts when it is before the priced game's UTC date and not after today's UTC date; cutting at the Los Angeles day drops last night's game on back-to-backs.
- **Chat safety:**
  - Card numbers come from the engine only.
  - A price counts only if the viewer typed it.
  - A line counts only if the viewer typed it or it is the app's own.
- **Polymarket matching** (Sharp Board, Games leans, Polymarket tab): a strict matcher, `__sharp.match`. A bare college nickname counts only when the abbreviation runs through the full name, and ties don't match.

## Plans and access tiers (2026-11-25; tiers.js, plans.json, tools/license.mjs)
- The owner asked for "a subscription based payment system ... fantasy only, betting and fantasy ... and everything the app offers (Low-Mid-High Tier). More money more access".
- **Owner's choices:** unlock codes on this link (no server), Stripe payment links, these prices and tiers, and a free preview.
- **Tiers:**
  - **Free (owner, 2026-11-25: "only be able to see odds ... parlay builder is accessible but thats it. No generated parlays or your parlay picks"):**
    - odds only: Games (leans locked), the sport tabs (no "Easiest parlay"), game pages, Odds tools;
    - the parlay builder: Swipe and the slip (Generate locked; the slip's ⇄ recommended swaps and the soccer game page's "Best same-game pairs" are left out; `GEN_SEL` upsell as a backstop);
    - saving (cards' ＋ My Parlays, the slip's Save, the builder's Save) needs Fantasy (`SAVE_SEL`);
    - Games: a game with a paid lean shows "Lean 🔒" (never its side, reasons or a highlighted tile); other games show "No lean";
    - Past Slips (pastslips.js): the day before's settled slips from recs.json, never today's or upcoming ones. A slip shows only once every one of its games is over and it has a result, so a slip with a leg still to play stays hidden. A slip whose games are over with no missed leg but a leg nobody could grade (recs.mjs grades NBA player legs only) shows as "Not fully graded". Betting + Fantasy and up can pick any past day.
    - Every other screen shows a blurred, inert preview whose words and numbers are replaced by dots, with an Upgrade card. A first visit lands on Games.
  - **Low, Fantasy ($9.99/mo, $99.99/yr):** the fantasy screens, Fantasy Parlay, Players, My Parlays.
  - **Mid, Betting + Fantasy ($24.99/mo, $249.99/yr):** every other screen, including Trending with My Parlay Picks, generated parlays and leans (the pseudo-screen `picks`: builder Generate, the sport tabs' parlay, Games leans), AI Chat, Sharp Board, Polymarket.
  - **High, Everything ($39.99/mo, $399.99/yr):** adds Slip Check, the Simulator, every 500,000-run / Watch live button (cards, soccer, Weekly Plan) and the research tabs (Weekend Patterns, Team Trends, Upset Parlays, Stat Explorer).
  - The map is `NEED` in tiers.js; an unlisted screen needs Mid.
- **Codes:**
  - Format `SB1-<base64url JSON {v,t,e,i}>.<ECDSA P-256 signature>`, checked in the browser against plans.json `publicKey`.
  - Expiry is checked against the newer of the device clock and the feed's server time.
  - plans.json `revoked` lists cancelled code ids.
  - A code unlocks one browser (localStorage `fm2.pw.code`).
- **Owner tools** (Plans page, bottom; everything stays in the owner's browser):
  - create or restore the signing key, which unlocks that browser automatically through a possession check;
  - make codes (month +3 days, year +3, 7-day trial, never) with a message to send;
  - cancel codes;
  - make the plans.json settings (public key, Stripe links, contact, revoked).
  - `node tools/license.mjs keygen|issue|check` does the same from a computer (key file mode 600, outside the repo).
- **Switches:**
  - Plans stay off (everything open) while plans.json has no `publicKey`; on localhost too unless `enforceLocal`, so the other suites never see the lock.
  - A key once seen is remembered (`fm2.pw.pk`), so a slow or blocked plans.json does not open the lock.
- **Honest limits, shown on the Plans page:**
  - The app's files are public, so this stops casual visitors, not determined ones.
  - The owner sends each code by hand, and payments are checked by the owner.
  - Automatic code emails would need a server.
- **To switch plans on:** the owner sends the public key, Stripe links and contact from Owner tools → "Make plans.json settings". Put them in plans.json and publish with tiers.js and plans.json.

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
  - **duo / trio stacks**: same-team starters by role (playmaker assists + scorer points + big rebounds; never two players on one stat), close games first, last-4 box scores, substitutes, legs and games scrollers. The box scores show NBA teammates' lines barely move together (link +0.06, not reliable), and the page says so.
  - **legs that help each other** (helpHTML): pairs grouped by kind, touchdown pairs first, each priced together vs unrelated, "Add both", and a paired parlay. Pair kinds include a back's TD + rushing yards, a receiver's catches + yards, QB + top receiver, a player + his team's win, NBA points + rebounds, NHL point + shots.
- **Upset Parlays (upsets.js):**
  - underdogs and draws from Polymarket;
  - researched form (form.json) and a form-backed parlay;
  - a streak check (who each run came against);
  - close games with an edge (home side, opponent injuries).
- **📅 Weekend Patterns (pattern.js), three views:**
  - **🔮 Next weekend:**
    - crazy-weekend meter: the exact chance that 40%+ of the round's big favourites (60%+) drop points, vs a typical round of the same leagues with the same number of big favourites;
    - a round, once forecast, is kept until it ends: games that kick off keep their pre-match leg, finished ones count as they ended (the feed's finished games have no prices);
    - likeliest to slip (research estimate, reasons with what the research found about each);
    - unbeaten runs on the line;
    - parlays: 3-upset lotto, full chaos 5, unbeaten runs end, the steady weekend.
  - **🔬 6 seasons** (pattern.json "research", tools/weekend_research.py):
    - 15,112 games, 7 leagues 2020/21 to now, closing odds; 2,870 European games (tools/euro_games.json, ESPN) matched by tools/teamnames.py;
    - 15 causes tested by logistic regression vs similar-priced favourites with Holm correction. **None held.** Hint only: underdog unbeaten in 5+ (OR 1.40, p 0.03);
    - big favourites failed 1,166 vs 1,287 margin-free priced, but backing all at real closing odds returned +0.4% (break-even: it is the margin);
    - crazy rounds 17 of 213 vs ~25 by chance; no clustering;
    - unbeaten runs of 10+ ended less often than priced (155 vs 179).
  - **🐦 The tweet:** the 90-day test of "weekends when all big teams lose / 80% draws" (not true), the live round and its parlay mix.
- **📈 Team Trends (trends.js, trends.json from tools/team_trends.py):** every team's last 7 / 30 days, months and season: record, over/under rates, as favourite / underdog vs prices, streaks; upset watch and over/under leans for next games with reasons and sample sizes (soccer from football-data.co.uk CSVs, NBA from ESPN scores and posted lines); a trend parlay card.
- **Other tabs:** Soccer Parlays, Point Lottos, Polymarket, Weekly Plan, Best Parlays, NBA Props, First TD, UFC.
- **Your bets:** My Parlays (ledger, grading) and Slip Check (screenshot or typed slips, 500,000-run simulation, recommended changes).

## Every parlay card
- **Swap legs (⇄):** 3+ substitutes of about the same chance that don't clash with the card. No player twice, no two players on one team for one stat, and the card's own rules hold. Kept per card for the day, with undo.
  When a crowded card leaves fewer than 3, the list adds the same player at another line or another exact score in the same game (ranked lower).
- **🎲 500,000 runs:** game by game. Player legs and anytime TDs are correlated normals linked to each other, to their team's simulated margin and to the game total by the measured links (pairs.json); NBA / NHL starters sit late in simulated blowouts. Re-runs after a swap.
- **Legs that help each other (pairs.json, tools/leg_pairs.py):**
  - Measured on this season's ESPN box scores: NFL 162 games, college 822, NBA 248, NHL 334, soccer 545.
  - Each leg "lands" when the player beats his own median (TD / goal: scores). The joint rate is measured within players (pooled per-player covariance), the link is the normal-copula correlation, with a bootstrap over players. It is used only when it survives Holm's correction across all pairs, has 150+ player-games and is at least 0.05.
  - Examples (2026-11-24 run): an NFL back's TD + rushing yards +0.43; WR TD + receiving yards +0.42; TE TD + receiving yards +0.46; QB yards + top receiver +0.57; back's yards + team win +0.44; NBA points + rebounds +0.24; NHL goal + shots +0.43; soccer goal + win +0.34. No longer reliable: an NFL back's TD + receiving yards, TE TD + team win.
  - Yards chances are recalibrated by what happened (pairs.json calib: isotonic knots from walking through the season pricing each player from his earlier games only, shrunk toward no change by sample size). Held out by player, NFL rushing lines priced 65% landed 52% before the fix (calibrated 55%). The yards average counts every game played (a zero is a real result).
  - Same-game legs are priced together on the game's own model: the game's markets settle on each of its 100,000 simulations (or exact scores) and each player leg / anytime TD is a normal linked to that game's margin and total (one linked leg exactly, more by a seeded 20,000-draw simulation); the 500,000-run sim draws the same links, so the card and the sim agree (tested). Spreads, handicaps, double chance and win-to-nil carry the side's win link. Games without a model (started) link a win / total leg to the players directly.
  - Builders add a partner leg that helps (link >= .15) only when the pair costs the card no more than its next best leg from another game, and keep off legs that work against each other (<= -.15). Swaps and the slip say which legs help or hurt each other, with what the research counted ("when he scored a TD, he beat his usual rushing yards 66% of the time vs 46%"). An anytime TD swaps for other anytime TDs (then that game's yards legs).
  - The same player twice is allowed only for two different stats the research links.
- **▶ Watch live** opens the Simulator.
- **★ Rec next to every leg** (and ⇄): the swap list puts one RECOMMENDED pick on top. Every option says why: value, how it fits the card (assists feed a teammate's points), close game or blowout risk, recent box scores, and lessons (kinds of legs that keep missing are flagged and ranked down).
- **The parlay builder** has ★ Rec and ⇄ on every leg too (same rules); picking a swap replaces that leg in the slip.
- **Track record (recs.json, tools/recs.mjs):**
  - The 3:47 AM run grades every saved day (`node tools/recs.mjs grade`): game legs from final scores, NBA player legs from ESPN box scores.
  - It then saves the new day's parlays (`node tools/recs.mjs snapshot`, after make_picks).
  - "How our parlays did" shows on My Parlay Picks (all types) and Fantasy (its own types).
  - A My Parlay Picks card that misses a leg gets a "Replacement" card of the same kind, from games still to play.
  - "Lessons so far": each kind of leg's hit rate vs what the model expected (memory of what loses), with what to do next time.
- **Player model:** season average, with recent form (playerform.json) counting 30%. The team's expected points come from the total and spread. In blowouts (15+ NBA, 17+ NFL, 21+ college), starters ×0.8 and bench ×1.15 (not for yards: the measured game-script link covers it).
- **NFL / college yards legs (nflplayers.json):** rushing (backs, running QBs), receiving (WR / TE / RB), passing (QBs), each a normal with the player's spread shrunk to a measured a + b·mean model. A player who missed his team's last game is left out.

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
| pattern.json | tools/weekend_pattern.py (90-day block; football-data.co.uk CSVs; fixtures in tests/fixtures/fd), then tools/weekend_research.py adds "research" (run it after) |
| tools/euro_games.json | tools/euro_games.py (`--recent 21` daily; the full history once) |
| .work/fdhist/*.csv (not committed) | tools/fd_history.py: 7 seasons × 7 leagues, past seasons kept |
| nflrec.json | tools/rec_last4.py (ESPN box scores, NFL / college receivers on upcoming games) |
| pairs.json, nflplayers.json | tools/leg_pairs.py (7:32 AM run; box-score cache in .work/box, only new games fetched) |
| firsttd.json | tools/leg_pairs.py refreshes every NFL team's season TDs from box scores (game-day "status" notes kept) |
| trends.json | tools/team_trends.py (7:32 AM run) |
| recs.json | tools/recs.mjs: each day's recommended parlays, graded the next morning (30 days kept) |
| season.json | tools/season_tables.py (7:32 AM run, after leg_pairs.py): season tables + game logs, all sports (NBA 0-minute games skipped), and every team's results with scores (`results`) |
| news.json | tools/news_fetch.py (3:47 AM and 7:32 AM runs; ESPN news API): headlines and videos for Highlights |
| props.json, scorers.json, firsttd.json, firstbasket.json, playerstats.json | older research files |

## Scheduled tasks
All of these fire into this session (`session_01BXNfXbMbY5NYSUdc1M3X6r`). Times are America/Los_Angeles.
- **3:47 AM daily, "Safe Bets: daily data refresh + My Parlay Picks"** (trig_0154hy44mSKH3UCJM4kjvses): game feed, Polymarket, UFC, NBA injury report, grade yesterday (recs.mjs grade), make_picks, snapshot today (recs.mjs snapshot), publish.
- **7:32 AM daily, "Safe Bets: morning form research"** (trig_01HGBuKM416rUSPocccDMoui): nba_last4 box scores, team form, player form, weekend pattern + 6-season research and crazy-weekend forecast, injury re-check of every picked leg, publish. Done by 8 AM as the owner asked. **Do not change its schedule.**
- **11:34 PM daily, "Safe Bets: nightly memory + build save"** (trig_01EfBa9zKHBDbwWgywjhNQPV): updates this file, commits and pushes, runs the tests, and makes sure the live app matches the repo.
- **Sunday 8:17 PM, "Safe Bets: weekly slip grading and report"** (trig_01F9w4ED73EpBHW6db2vSDdf): grades Weekly Plan slips and reports SAFE / COIN FLIP / LOTTO / big slips / POLYMARKET.
- **Hourly at :55, "FirstMove hourly games refresh"** (trig_011dcsKBB9zytWc2jL2e3jdQ): owns data.json. Not ours to change without the owner's OK.

## How to publish
- Artifact publish with url = the app, file_path = index.html, files = only the changed modules and data files. (brand/icon-*.png are on the artifact but git-ignored by `*.png`; the local copies match.) Leave data.json out: the hourly task owns it. tiers.js and plans.json must be on the artifact (plans only switch on with both); publish plans.json again whenever its key, links or revoked list change.
- **If refused for a newer version:**
  1. Compare the saved live copy's sha256 with `git show <commit>:index.html` for recent commits.
  2. If it equals one of ours, publish again unchanged and it goes through.
  3. For supporting files that weren't read this session, read them first (action read, paths).

## Tests
- `node tests/<name>.test.mjs` (Playwright + Chromium preinstalled). There are 48 suites, all on saved fixtures with a fixed clock, so they don't depend on the live feed.
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
- **Points over assists / rebounds, for NBA parlays and Fantasy:** prefer points legs (STAT_PREF in index.html: a selection bonus in ticket building, NBA picks, highest-floor legs and swap ranking; PTS_PREF in plan.js for Weekly Plan; duo/trio stacks lead with the scorer; never added to a chance). Keep reporting how each stat actually hits (Lessons).
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
- **Plans:** not switched on yet. The owner still has to create the signing key in Owner tools and send its public key, make the 6 Stripe payment links, and choose a contact. For a Low (fantasy-only) customer, Chat (Mid) and Stat Explorer (High) stay locked in fantasy mode, per the owner's tier choices; confirm whether that is wanted.
- **Free tier question for the owner:** Games cards show free visitors "Key props · likeliest legs" (the model's 3 likeliest player lines per game, with chance and fair odds), treated as odds like the builder deck. Lock them if the owner counts them as picks (slate.js card(), picksLocked()).
- **Grading coverage:** tools/recs.mjs grades game legs and NBA player legs only, so slips with NFL / college / NHL / soccer player legs show "Not fully graded" on Past Slips and in Chat until those are graded too (the box scores are already in leg_pairs.py's cache).
- **Pro interface follow-ups:**
  - Highlights images come from ESPN's image servers; the artifact may block them, in which case sport tiles show.
  - season.json lacks full names for a few college teams (ALB, RGV, WES).
  - A traded player shows one row per team.
  - insights.js could share its season index (`__insights.needSeason`) with builder.js; both work without it.
- **Keyboard access:** on phones the menu is a closed drawer now, so content comes first. On desktop the sidebar's ~30 items still come before the page: a skip link would fix that.
- **tests/sim.test.mjs:** failed once in a full-suite run on 2026-11-23, then passed 5 times in a row on its own. It looks like a timing problem; if it fails again, capture which check fails.

## Change log
- 2026-11-22:
  - My Parlay Picks; QA by 3 agents (64 findings, nearly all fixed).
  - Upset Parlays: form, streak check, close-game edges, swaps.
  - Swap legs and 500,000-run sims on every card; player model that reads the game.
- 2026-11-24 nightly save (Los Angeles date; the 2026-11-25 entries below are the same evening in UTC): 39 commits today: pro interface published (v163), plans and tiers, the owner's new free tier with Past Slips (v181), Chat breakdowns (v182), season.json team results. Live app = repo.
- 2026-11-25 (night):
  - Chat breakdowns: 6 new tools and cards (player stats, a player's game reviewed, a parlay reviewed, team, leaders, track record), offline intents for each; two reviewers found 18 problems (QB anytime TD graded on passing TDs, wrong player in typed parlays, traded players' old games, two players with one name, dates, made-up lines through typed dates, a player who sat, pushes, unplayed parlays called missed, a 430px card at 390, ...), all fixed. tests/ask.test.mjs: 190 checks (fixture recs-askbd-2026-11-23.json). Full suite 48/48; published as version 182 with season.json (team results).
- 2026-11-25 (later):
  - Free tier redefined by the owner: odds, the parlay builder (no Generate) and Past Slips (yesterday's settled slips only); Trending / My Parlay Picks, generated parlays and leans moved to Mid. New pastslips.js; recs fixture tests/fixtures/recs-2026-11-25.json; tests/plans.test.mjs covers the new rules.
  - Reviewed by 3 independent agents with a skeptic per angle: fixed the slip's recommended swaps and soccer same-game pairs reaching free, free saves to a locked My Parlays, a lock on every Games card (now only where a lean exists), Past Slips headings / ungradable legs / a raw "pairs" title / screen-reader results, and the Plans table hiding its plan columns on phones (old bug). Kept: Games' key props (odds per line, like the builder deck). Published as version 181 (without ask.js: the Chat breakdowns are still being built).
- 2026-11-25:
  - Plans and access tiers: Free / Fantasy $9.99 / Betting + Fantasy $24.99 / Everything $39.99.
  - Signed unlock codes, Stripe links, blurred previews, the Plans page, owner tools and tools/license.mjs.
  - 3 independent reviewers found no crypto holes; ~20 findings fixed: Weekly Plan sims, builder and save gates, the load window, clock rollback, readable previews, first-visit landing, focus and announcements, wording.
  - 48 suites. Plans are off until the owner's key is added.
- 2026-11-23 (evening):
  - Legs that help each other, reviewed (14 confirmed findings fixed): within-player links with Holm; yards calibrated (v156 had overpriced rushing lines, about 65% priced vs 52% landed); the card's joint price now conditions on the game's simulations (the old 500,000-run sim had the team-win link's sign reversed); spreads and double chance linked; partner legs gated by cost; TD swaps; help pairs follow the sport filter and are grouped by sport. Engine kept fast (normal scores taken from the sim's own model; the help section fills in after the Fantasy tab paints).
  - Pro interface (owner: "an exact 1:1 kind of interface" of rotobot.ai): captured the site (network access approved for rotobot.ai), built the shell (sidebar, Betting / Fantasy modes, phone drawer, navy / cyan), ui.js components, SB.engine, season.json and the spec (docs/pro-interface.md). The screens were built and adversarially reviewed by agents (8 in parallel after the owner asked to "make it quicker"); 47 suites pass; published as version 163 (2026-11-24 ~09:00 UTC).
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
  - Points legs preferred over assists / rebounds (owner's call; NBA picks went from 3 to 7 points legs of 14).
  - Weekend Patterns rebuilt on real research: 6 seasons, 7 leagues, European fixtures, and a crazy-weekend forecast.
    - Honest result: nothing predicts a crazy weekend beyond the odds.
    - Nov 28 round: 19% chance vs 20% for a typical round of that size; 12 big favourites.
    - An independent review (4 angles, adversarially verified) found 9 real problems, all fixed:
      - the round shrank each weekend morning;
      - the default view would crash once a forecast game finished;
      - four feed club names didn't match, and Espanyol could randomly map to Barcelona (Bayern's run is 10, not 9);
      - "typical" compared rounds of different sizes;
      - smaller ones: the 'late' cause in a part-played season, rest days, price buttons on started games, duplicate cards.
  - Swaps: crowded cards now always offer 3+ (today's exact-score cards and an SGP leg had 2).
  - Legs that help each other (owner's idea: "McCaffrey 1 TD and 30+ rushing yards helped both legs"):
    - measured on this season's box scores for 5 sports;
    - NFL / college yards legs;
    - linked legs priced together in cards and the 500,000-run sim;
    - builders pair helping legs; firsttd.json refreshed from box scores (Seattle was missing).
    - Correction: NBA teammates' lines barely move together, so the old 0.2 team factor and the "assists feed points" claim were removed.
