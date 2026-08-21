import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Drives the reaction handlers against live Discord.
 *
 * @remarks
 * Reactions are the one part of the event surface that can be exercised end to end without
 * anybody else being present: the bot posts a message, reacts to it, and reads its own
 * dispatch back. That covers the `identifier` form the REST route wants, which is where the
 * classic reaction bug lives — encode it twice, or send message markup, and Discord answers
 * with a 400 that blames the emoji.
 */

const log = scoped('reactions')
const config = loadConfig()

const client = new Client({
  token: config.token,
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
})

const seen: string[] = []
client.on('messageReactionAdd', (emoji, messageId, channelId, userId) => {
  seen.push(`add ${emoji.identifier} by ${userId} on ${messageId} in ${channelId}`)
})
client.on('messageReactionRemove', (emoji, messageId) => {
  seen.push(`remove ${emoji.identifier} on ${messageId}`)
})
client.on('messageReactionRemoveAll', (messageId) => {
  seen.push(`remove-all on ${messageId}`)
})

await client.login()
await new Promise((resolve) => setTimeout(resolve, 5_000))

const guild = [...client.cache.guilds.values()][0]
if (guild === undefined) throw new Error('no guild cached')
const channel = guild.channels().find((entry) => entry.isTextBased() && !entry.isVoiceBased())
if (channel === undefined) throw new Error('no text channel cached')

const posted = await client.rest.channels.createMessage(channel.id, {
  content: 'reaction check — this message will be deleted',
})
log.info(`posted ${posted.id}`)

// The unencoded form is what the route wants; it encodes on the way out.
await client.rest.channels.addReaction(channel.id, posted.id, '👍')
await new Promise((resolve) => setTimeout(resolve, 2_000))

await client.rest.channels.deleteMessage(channel.id, posted.id)
log.info('cleaned up the test message')

await new Promise((resolve) => setTimeout(resolve, 1_500))
for (const entry of seen) log.info(entry)
log.info(seen.some((e) => e.startsWith('add 👍')) ? 'PASS: the reaction round trip works' : 'FAIL')

await client.destroy()
process.exit(seen.some((e) => e.startsWith('add 👍')) ? 0 : 1)
