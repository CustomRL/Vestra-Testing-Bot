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
  ],
  cache: { messages: { max: 50 }, members: true },
})

client.on('ready', (user) => {
  log.info(`ready as ${user.tag} (${user.id})`)
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
log.info(`roles cached: ${String(client.cache.roles.size)}`)
log.info(`members cached: ${String(client.cache.members.size)}`)
log.info(`messages cached: ${String(client.cache.messages.size)}`)
log.info(`client.user: ${client.user?.tag ?? 'none'}`)

await client.destroy()
log.info('destroyed cleanly')
process.exit(0)
