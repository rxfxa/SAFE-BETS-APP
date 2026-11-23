export const meta = {
  name: 'player-form-research',
  description: "Morning player-form research: each picked NBA player's last 5 games (stat, minutes, opponent, DNPs and the story behind them) from real box scores, verified by a second source",
  phases: [{ title: 'Research', detail: 'box scores per player group' }, { title: 'Verify', detail: 'a different source checks every game' }],
}
// args: {dir: absolute path holding players_<key>.json from tools/pick_players.mjs, groups: [keys]}
// returns [{group, players:[...]}] for tools/playerform_merge.py
const SP = args.dir
const GAME = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD, US date of the game' },
    opp: { type: 'string', description: 'opponent abbreviation, e.g. BOS' },
    home: { type: 'boolean' },
    min: { type: 'number', description: 'minutes played as a decimal (34:30 -> 34.5)' },
    value: { type: 'integer', description: 'the stat asked for (points, rebounds or assists) in that game, from the box score' },
    margin: { type: ['integer', 'null'], description: "his team's final margin (+ won by, - lost by); 15+ either way was a blowout" },
  },
  required: ['date', 'opp', 'min', 'value'],
}
const PLAYER = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'EXACTLY as given in the input list' },
    team: { type: 'string', description: 'team abbreviation EXACTLY as given' },
    stat: { type: 'string', enum: ['pts', 'reb', 'ast'], description: 'EXACTLY as given' },
    games: { type: 'array', items: GAME, description: 'his last 5 games PLAYED, OLDEST FIRST: games he missed are left out (reach further back instead), and a game you could not confirm is left out too' },
    dnp: { type: 'integer', minimum: 0, maximum: 5, description: "games he did not play (injury, rest, DNP-coach's decision, suspension) among his team's last 5 games" },
    asOf: { type: 'string', description: "YYYY-MM-DD of his team's most recent FINISHED game you checked" },
    note: { type: 'string', description: 'one or two short sentences reading between the lines (see rules) plus anything not confirmed; facts only, no prediction' },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs actually used (box scores, game logs, recaps, search results)' },
    confidence: { type: 'string', enum: ['verified', 'partial', 'unverified'] },
  },
  required: ['name', 'team', 'stat', 'games', 'dnp', 'asOf', 'note', 'sources', 'confidence'],
}
const OUT = { type: 'object', properties: { players: { type: 'array', items: PLAYER } }, required: ['players'] }
const RULES = `Use today's real date and time (run \`date\`). Load WebSearch and WebFetch with ToolSearch ("select:WebSearch,WebFetch") if they are not loaded. Many stats sites (Basketball-Reference, NBA.com stats, ESPN, StatMuse) can be blocked from this environment: if a page will not load, use the WebSearch result snippets (box scores, player game logs, game recaps, team sites, CBS, Yahoo, FOX Sports, Covers, RotoWire, Basketball-Reference snippets) and any page that does load, and say in note what you could not open. Work game by game from real box scores, newest backwards, for each player's last 5 games PLAYED this NBA season: date, opponent, minutes and the asked stat (points, rebounds or assists). Games played earlier today count only if they are final. Count dnp from his team's last 5 results: games he sat (injury, rest, coach's decision, suspension). Read between the lines in note, short: a blowout (final margin 15+) where he sat the fourth quarter or played garbage time; a minutes trend (rising or falling, a minutes limit after injury); a move into or out of the starting five; a teammate out or back who changes his shots, boards or assists; a back-to-back or a heavy favourite tonight (blowout risk: starters sit late). Report facts from the games, not predictions. Never invent a number: if you cannot confirm a game, leave it out of games, say so in note and set confidence partial or unverified. Group players of the same team: one box score gives every one of them. Do not edit any files.`
const groups = args.groups
const res = await pipeline(groups,
  g => agent(`${RULES}\n\nResearch the recent form of every player in ${SP}/players_${g}.json (Read it; each has name, team, stat, and the next game: gid, start, opp, home). Return one entry per player with name, team and stat copied exactly.`, { label: `research:${g}`, phase: 'Research', schema: OUT }),
  (r, g) => agent(`${RULES}\n\nAnother researcher produced the player-form entries below for ${SP}/players_${g}.json. VERIFY every game (date, opponent, minutes, the stat), dnp and asOf against a DIFFERENT source than the ones listed, game by game. Correct anything wrong, fill gaps (any player in the file missing below: research him from scratch), keep the sources of both checks, and set confidence: verified only when a second, different source agrees on every game listed; partial when only some games or only one source could be checked; unverified when nothing could be. Return the full corrected list (same names, teams and stats).\n\nENTRIES:\n${JSON.stringify((r && r.players) || [])}`, { label: `verify:${g}`, phase: 'Verify', schema: OUT }))
return groups.map((g, i) => ({ group: g, players: (res[i] && res[i].players) || [] }))
