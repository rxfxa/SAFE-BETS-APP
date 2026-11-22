export const meta = {
  name: 'team-form-research',
  description: 'Morning form research: each team\'s last 5 games (with opponents\' table positions), runs and table position from results, verified by a second source',
  phases: [{ title: 'Research', detail: 'web research per team group' }, { title: 'Verify', detail: 'second source checks every number' }],
}
// args: {dir: absolute path holding form_<key>.json from tools/form_teams.py, groups: [keys]}
const SP = args.dir
const TEAM = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'EXACTLY as given in the input list' },
    comp: { type: 'string' },
    league: { type: 'string', description: 'domestic league / conference the standing refers to' },
    position: { type: ['integer', 'null'], description: 'current league table rank (NBA/NHL/NFL: conference rank)' },
    of: { type: ['integer', 'null'], description: 'teams in that table' },
    record: { type: 'string', description: 'season record, e.g. 9-4-2 (W-D-L soccer), 12-5 (NBA), 13-6-2 (NHL W-L-OTL), 7-4 (NFL)' },
    unbeaten: { type: 'integer', description: 'current run of games without a loss, newest backwards (soccer: all competitions, draws count as unbeaten; NHL: no regulation loss, OT/SO losses do not end it; NBA/NFL: same as win streak)' },
    winStreak: { type: 'integer', description: 'current consecutive wins (0 if last game was not a win)' },
    lossStreak: { type: 'integer', description: 'current consecutive losses (0 if last game was not a loss; NHL counts OT/SO losses)' },
    winless: { type: 'integer', description: 'current run of games without a win (soccer: draws count; others: same as lossStreak)' },
    last5: { type: 'string', description: 'last 5 results oldest to newest as letters W/D/L (NHL: OTL for overtime/shootout losses), space separated' },
    lastGame: { type: 'string', description: 'date, opponent, score and result of the most recent game' },
    games: { type: 'array', description: 'the last 5 games, OLDEST FIRST, each with the opponent and where that opponent sits in its table today', items: { type: 'object', properties: {
      date: { type: 'string' }, opp: { type: 'string' }, home: { type: 'boolean' }, result: { type: 'string', enum: ['W', 'D', 'L', 'OTL'] }, score: { type: 'string' },
      oppPos: { type: ['integer', 'null'], description: "opponent's current league / conference rank" }, oppOf: { type: ['integer', 'null'] }, comp: { type: 'string' } }, required: ['date', 'opp', 'result', 'score'] } },
    absences: { type: 'string', description: 'key players out for the next game, if reported (short)' },
    asOf: { type: 'string', description: 'YYYY-MM-DD of the most recent game counted' },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs used' },
    confidence: { type: 'string', enum: ['verified', 'partial', 'unverified'] },
    note: { type: 'string', description: 'anything uncertain or conflicting between sources' },
  },
  required: ['name', 'comp', 'record', 'unbeaten', 'winStreak', 'lossStreak', 'winless', 'last5', 'lastGame', 'games', 'asOf', 'sources', 'confidence'],
}
const OUT = { type: 'object', properties: { teams: { type: 'array', items: TEAM } }, required: ['teams'] }
const RULES = `Use today's real date and time (run \`date\`). Use WebSearch (load it with ToolSearch "select:WebSearch" if it is not loaded) and fetch real pages: league/official sites, ESPN, BBC Sport, FBref, Soccerway, Flashscore, Transfermarkt, Basketball-Reference, Hockey-Reference, Pro-Football-Reference, team sites, recent match reports. Work from actual RESULTS game by game (newest first) to count the streaks; do not estimate from ratings or odds. Games played earlier today count only if they are finished. For Champions League clubs, count all competitions for the streaks and give the DOMESTIC league position. For each of the last 5 games give the opponent and that opponent's CURRENT table position (so it is clear whether a run came against strong or weak sides). Never invent a number: if you cannot confirm something, say so in note and set confidence to partial or unverified. Do not edit any files.`
const groups = args.groups
const res = await pipeline(groups,
  g => agent(`${RULES}\n\nResearch the current form of every team in ${SP}/form_${g}.json (Read it; each has name, abbr, sport, comp, opp = next opponent, start = next game UTC). Return one entry per team with name copied exactly.`, { label: `research:${g}`, phase: 'Research', schema: OUT }),
  (r, g) => agent(`${RULES}\n\nAnother researcher produced the team-form entries below for ${SP}/form_${g}.json. VERIFY every number (record, position, unbeaten, winStreak, lossStreak, winless, last5, lastGame, games with each opponent's position, asOf) against a DIFFERENT source than the ones listed, game by game from actual results. Correct anything wrong, fill gaps, and set confidence: verified only when a second source agrees. Return the full corrected list (same team names).\n\nENTRIES:\n${JSON.stringify((r && r.teams) || [])}`, { label: `verify:${g}`, phase: 'Verify', schema: OUT }))
return groups.map((g, i) => ({ group: g, teams: (res[i] && res[i].teams) || [] }))
