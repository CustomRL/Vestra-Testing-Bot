import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Runs the README's example verbatim, and drives it end to end.
 *
 * @remarks
 * The example in a README is a promise, and the previous one could not have worked: it named
 * options the client does not take, an intents constant that does not exist, a `connect()`
 * that is called `login()`, and a `message.channel.createMessage(...)` where `channel` is a
 * cache-backed accessor returning `undefined` under the default configuration.
 *
 * Connecting is not enough to prove the replacement — the interesting half is the handler. So
 * this posts the trigger itself and waits for the reply, in the testing guild this repository
 * exists for.
 */

const log = scoped('readme')

// ---- the README example, verbatim from here ----
const client = new Client({
  token: loadConfig().token,
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    await message.reply({ content: 'pong' })
  }
})

await client.login()
// ---- to here ----

client.on('error', (error) => {
  log.error('client error', error.message)
})

const replied = new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => {
    resolve(false)
  }, 20_000)
  client.on('messageCreate', (message) => {
    if (message.content !== 'pong') return
    clearTimeout(timer)
    resolve(true)
  })
})

// Wait for the guild stream, then pick a channel the bot can actually post in.
await new Promise((resolve) => setTimeout(resolve, 5_000))

const guild = [...client.cache.guilds.values()][0]
if (guild === undefined) throw new Error('no guild cached; cannot drive the example')

const channel = guild.channels().find((entry) => entry.isTextBased() && !entry.isVoiceBased())
if (channel === undefined) throw new Error('no text channel cached; cannot drive the example')

log.info(`posting !ping in #${'name' in channel ? String(channel.name) : channel.id}`)
await client.rest.channels.createMessage(channel.id, { content: '!ping' })

const ok = await replied
log.info(ok ? 'PASS: the README example replied with pong' : 'FAIL: no pong within 20s')

await client.destroy()
process.exit(ok ? 0 : 1)
