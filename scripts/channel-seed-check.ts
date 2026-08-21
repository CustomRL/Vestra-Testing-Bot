import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Checks that every channel Discord sends is a channel the library kept.
 *
 * @remarks
 * `createChannel` returns `undefined` for a type it cannot build, which is correct and also
 * silent. This counts what arrived against what was cached, so a type the library drops shows
 * up as a number rather than as a channel nobody notices is missing.
 */

const log = scoped('channels')
const config = loadConfig()

const client = new Client({
  token: config.token,
  intents: [GatewayIntentBits.Guilds],
  cache: { threads: true },
})

let sentChannels = 0
let sentThreads = 0
const sentTypes = new Map<number, number>()

client.on('raw', (payload) => {
  if (payload.t !== 'GUILD_CREATE') return
  const data = payload.d as Record<string, unknown>
  if (!('roles' in data)) return

  const channels = data.channels as { type: number }[]
  const threads = data.threads as unknown[]
  sentChannels += channels.length
  sentThreads += threads.length
  for (const channel of channels) {
    sentTypes.set(channel.type, (sentTypes.get(channel.type) ?? 0) + 1)
  }
})

await client.login()
await new Promise((resolve) => setTimeout(resolve, 6_000))

log.info(`channels sent: ${String(sentChannels)}, cached: ${String(client.cache.channels.size)}`)
log.info(`threads sent:  ${String(sentThreads)}, cached: ${String(client.cache.threads.size)}`)
log.info(`types seen: ${[...sentTypes].map(([t, n]) => `${String(t)}x${String(n)}`).join(' ')}`)

const dropped = sentChannels - client.cache.channels.size
log.info(dropped === 0 ? 'every channel was built' : `${String(dropped)} channels were dropped`)

await client.destroy()
process.exit(0)
