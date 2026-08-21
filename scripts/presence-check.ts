import { ActivityType, Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Sends every shape of presence update and checks Discord accepts them.
 *
 * @remarks
 * **Discord does not send a bot its own `PRESENCE_UPDATE`**, even with the `GuildPresences`
 * intent — that event is about other members. Measured: setting three different presences here
 * produced no dispatch about this bot at all. So this cannot verify what the presence *looks*
 * like; that is a thing to see in the client.
 *
 * What it can verify is that Discord accepted the payloads, and that is not nothing: a
 * malformed opcode 3 closes the socket with 4002, so a run that stays connected through every
 * variant means each was well formed. The zstd and resume checks in this repository verify
 * their claims the same way — by surviving.
 */

const log = scoped('presence')
const client = new Client({
  token: loadConfig().token,
  intents: [GatewayIntentBits.Guilds],
})

let errors = 0
let closed = 0
client.on('error', (error) => {
  errors += 1
  log.error('client error', error.message)
})

await client.login()
client.shards.on('shardDisconnect', () => {
  closed += 1
})
await new Promise((resolve) => setTimeout(resolve, 3_000))

const variants: [string, Parameters<typeof client.setPresence>[0]][] = [
  ['playing', { status: 'online', activities: [{ name: 'Vestra' }] }],
  ['listening', { status: 'online', activities: [{ name: 'the gateway', type: ActivityType.Listening }] }],
  ['watching, idle', { status: 'idle', activities: [{ name: 'the cache', type: ActivityType.Watching }] }],
  [
    'custom status, obvious spelling',
    { status: 'dnd', activities: [{ name: 'shipping a Discord library', type: ActivityType.Custom }] },
  ],
  [
    'streaming with a twitch url',
    {
      status: 'online',
      activities: [
        { name: 'live', type: ActivityType.Streaming, url: 'https://twitch.tv/discord' },
      ],
    },
  ],
  ['cleared', { status: 'online' }],
]

for (const [label, options] of variants) {
  await client.setPresence(options)
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  log.info(`${label}: sent, socket still up`)
}

await new Promise((resolve) => setTimeout(resolve, 2_000))
const ok = errors === 0 && closed === 0
log.info(
  ok
    ? 'PASS: every presence variant was accepted; how they render is a thing to see in Discord'
    : `FAIL: ${String(errors)} errors, ${String(closed)} disconnects`,
)

await client.destroy()
process.exit(ok ? 0 : 1)
