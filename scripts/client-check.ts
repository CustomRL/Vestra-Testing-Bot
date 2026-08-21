import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Drives the Phase 4 `Client` against the live gateway.
 *
 * @remarks
 * The first end-to-end exercise of the whole stack: options resolution, the shard bridge,
 * the event router, the handlers and the cache, over a real socket. Unit tests cover each
 * piece; this is the only thing that proves they are wired to each other.
 */

const log = scoped('client')
const config = loadConfig()

const client = new Client({
  token: config.token,
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
  cache: { messages: { max: 50 }, members: true, users: true, threads: true, voiceStates: true, presences: true },
})

client.on('ready', (user) => {
  log.info(`ready as ${user.tag} (${user.id})`)
})

client.on('guildCreate', (guild) => {
  log.info(`guild ${guild.name} (${guild.id}) members=${String(guild.memberCount ?? -1)}`)
})

client.on('messageCreate', (message) => {
  log.info(`message from ${message.author?.username ?? 'unknown'}: ${message.content ?? ''}`)
})

client.on('error', (error, context) => {
  log.error(`error on ${context.event} shard ${String(context.shardId)}`, error.message)
})

let rawCount = 0
client.on('raw', (payload) => {
  rawCount += 1
  log.debug(`raw ${payload.t}`)
})

const user = await client.login()
log.info(`login resolved with ${user.tag}`)

await new Promise((resolve) => setTimeout(resolve, 8_000))

log.info('--- results ---')
log.info(`dispatches seen: ${String(rawCount)}`)
log.info(`guilds cached: ${String(client.cache.guilds.size)}`)
log.info(`channels cached: ${String(client.cache.channels.size)}`)
log.info(`threads cached: ${String(client.cache.threads.size)}`)
log.info(`roles cached: ${String(client.cache.roles.size)}`)
for (const guild of client.cache.guilds.values()) {
  log.info(
    `  ${guild.name}: ${String(client.cache.roles.group(guild.id).length)} roles, ` +
      `${String(client.cache.channels.group(guild.id).length)} channels grouped`,
  )
}
log.info(`members cached: ${String(client.cache.members.size)}`)
log.info(`users cached: ${String(client.cache.users.size)}`)
log.info(`messages cached: ${String(client.cache.messages.size)}`)
log.info(`voice states cached: ${String(client.cache.voiceStates.size)}`)
log.info(`presences cached: ${String(client.cache.presences.size)}`)
for (const presence of client.cache.presences.values()) {
  const what = presence.activities.map((a) => `${a.name}`).join(', ')
  log.info(`  ${presence.userId}: ${presence.status}${what === '' ? '' : ` — ${what}`}`)
}
log.info(`client.user: ${client.user?.tag ?? 'none'}`)

await client.destroy()
log.info('destroyed cleanly')
process.exit(0)
