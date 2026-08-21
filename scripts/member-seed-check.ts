import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Measures how much of a guild's member list `GUILD_CREATE` actually delivers.
 *
 * @remarks
 * Answers a question the Discord documentation does not: which intent controls the size of
 * `GUILD_CREATE.members`. The intuitive answer is `GuildMembers`, and it is wrong.
 *
 * Connects twice against the same guilds, once with `GuildMembers` and once with
 * `GuildMembers | GuildPresences`, and reports what arrived each time. The difference is the
 * finding — Discord builds the member list from the presence set, so a guild far below
 * `large_threshold` still sends only the bot when presences are off.
 *
 * Kept as a script rather than written down as a fact because it is a claim about a live
 * service, and the only honest way to keep it true is to be able to re-run it.
 */

const log = scoped('members')
const config = loadConfig()

interface Observation {
  guild: string
  memberCount: number
  large: boolean
  membersSent: number
  presencesSent: number
}

async function observe(
  intents: number[],
  label: string,
): Promise<Observation[]> {
  const seen: Observation[] = []
  const client = new Client({
    token: config.token,
    intents,
    cache: { members: true, users: true },
  })

  client.on('raw', (payload) => {
    if (payload.t !== 'GUILD_CREATE') return
    const data = payload.d as Record<string, unknown>
    // The unavailable stub carries an ID and nothing else, so it has no list to measure.
    if (!('roles' in data)) return

    seen.push({
      guild: String(data.name),
      memberCount: Number(data.member_count),
      large: Boolean(data.large),
      membersSent: (data.members as unknown[]).length,
      presencesSent: (data.presences as unknown[]).length,
    })
  })

  await client.login()
  // The guild stream is not finished when READY resolves, so this waits it out rather than
  // measuring a list that is still arriving.
  await new Promise((resolve) => setTimeout(resolve, 6_000))

  log.info(`--- ${label} ---`)
  for (const entry of seen) {
    log.info(
      `${entry.guild}: ${String(entry.membersSent)}/${String(entry.memberCount)} members, ` +
        `${String(entry.presencesSent)} presences, large=${String(entry.large)}`,
    )
  }
  log.info(
    `cached: ${String(client.cache.members.size)} members, ${String(client.cache.users.size)} users`,
  )

  await client.destroy()
  return seen
}

const withoutPresences = await observe(
  [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  'GuildMembers only',
)

const withPresences = await observe(
  [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  'GuildMembers + GuildPresences',
)

const before = withoutPresences.reduce(
  (total, entry) => total + entry.membersSent,
  0,
)
const after = withPresences.reduce(
  (total, entry) => total + entry.membersSent,
  0,
)

log.info('--- conclusion ---')
log.info(`members delivered without presences: ${String(before)}`)
log.info(`members delivered with presences:    ${String(after)}`)
log.info(
  after > before
    ? 'GUILD_CREATE.members is gated on GuildPresences, not GuildMembers.'
    : 'No difference observed — the guilds may be too large, or the intent is off in the portal.',
)

process.exit(0)
