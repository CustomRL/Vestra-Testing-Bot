import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Checks the client's cache survives a resume with its contents intact.
 *
 * @remarks
 * `resume-check.ts` establishes that the shard layer resumes. This is the layer above: after a
 * resume Discord replays what was missed, every handler runs again over dispatches the cache
 * has already seen, and the cache must end up where it started rather than doubled or emptied.
 * `packages/core/test/replay.test.ts` proves the handlers are idempotent in isolation; this
 * proves it over a real session.
 *
 * **The pass condition requires the resume to have happened.** An earlier version of this
 * script reported PASS with `disconnects: 0` — the cache was unchanged because nothing had
 * occurred. A probe that cannot tell "survived the reconnect" from "no reconnect" is worse than
 * no probe.
 *
 * **What this cannot establish**, and the unit test has to: that processing the *same*
 * dispatch twice is harmless. Discord replays what the client missed while disconnected, and
 * those are dispatches it has never seen — genuinely new, not duplicates. A true duplicate
 * needs the client to have processed a dispatch whose acknowledgement never reached Discord,
 * which is not something a probe can arrange. So `replayed` here counts deliveries, not
 * repeats, and it is normal for it to be zero.
 */

const log = scoped('reconnect')
const client = new Client({
  token: loadConfig().token,
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
})

function census(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const store of client.cache.stores) counts[store.scope] = store.size
  return counts
}

await client.login()
await new Promise((resolve) => setTimeout(resolve, 6_000))

const shard = [...client.shards.shards.values()][0]
if (shard === undefined) throw new Error('no shard')

let resumed = false
let identified = false
let replayed = 0
shard.on('resumed', () => {
  resumed = true
})
shard.on('ready', () => {
  identified = true
})
shard.on('dispatch', (_payload, wasReplayed) => {
  if (wasReplayed) replayed += 1
})

const before = census()
log.info(`before: ${JSON.stringify(before)}`)

log.info('closing with a resumable code, then reconnecting')
await shard.destroy('resume')
await new Promise((resolve) => setTimeout(resolve, 2_000))
await shard.connect()
await new Promise((resolve) => setTimeout(resolve, 8_000))

const after = census()
log.info(`after:  ${JSON.stringify(after)}`)
log.info(`resumed=${String(resumed)} identified=${String(identified)} replayed=${String(replayed)}`)

const unchanged = JSON.stringify(before) === JSON.stringify(after)
const reconnected = resumed || identified

if (!reconnected) {
  log.error('FAIL: no reconnect happened, so this proves nothing')
} else if (!unchanged) {
  log.error('FAIL: the cache changed across the reconnect')
} else {
  log.info(`PASS: cache intact across a ${resumed ? 'resume' : 'fresh identify'}`)
}

await client.destroy()
process.exit(reconnected && unchanged ? 0 : 1)
