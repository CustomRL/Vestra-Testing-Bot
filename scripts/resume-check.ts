import { ShardManager, type Shard } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { createRest } from '../src/rest.ts'
import { scoped } from '../src/logger.ts'

/**
 * A resume-path probe.
 *
 * @remarks
 * Issue #7 lists the session and close semantics that could not be established from
 * Discord's documentation. Two of them are observable from a client:
 *
 * - whether a resumable close followed by a reconnect actually resumes, and
 * - how long a session survives before Discord discards it, documented only as
 *   "a few minutes".
 *
 * This connects, drops the socket with a resumable close, waits, and reconnects. Whether
 * `RESUMED` or `READY` arrives is the answer. Running it at increasing delays brackets the
 * timeout from observation rather than from the documentation.
 *
 * Run with `node scripts/resume-check.ts [delaySeconds]`.
 *
 * A run that falls back to a fresh identify spends one of the daily session starts, so
 * this is not something to loop on tightly.
 */

const log = scoped('resume')

type Outcome = 'identified' | 'resumed' | 'timed out'

function nextOutcome(shard: Shard, timeoutMs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const done = (outcome: Outcome): void => {
      shard.off('resumed', onResumed)
      shard.off('ready', onReady)
      clearTimeout(timer)
      resolve(outcome)
    }
    const onResumed = (): void => {
      done('resumed')
    }
    const onReady = (): void => {
      done('identified')
    }

    const timer = setTimeout(() => {
      done('timed out')
    }, timeoutMs)

    shard.on('resumed', onResumed)
    shard.on('ready', onReady)
  })
}

async function run(): Promise<number> {
  const delaySeconds = Number(process.argv[2] ?? '5')
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new Error('Pass the delay in seconds, e.g. `node scripts/resume-check.ts 30`.')
  }

  const config = loadConfig()
  const rest = createRest(config.token)

  const manager = new ShardManager({
    token: config.token,
    intents: config.intents,
    compression: config.compression,
    shardCount: 1,
    fetchGatewayBot: async () => await rest.gateway.getBot(),
  })

  let shard: Shard | undefined
  let replayed = 0

  manager.on('shardSpawn', (shardId) => {
    shard = manager.shards.get(shardId)
    shard?.on('dispatch', (_payload, wasReplayed) => {
      if (wasReplayed) replayed += 1
    })
    shard?.on('closed', (code, reason, wasClean, action) => {
      log.info(`closed ${String(code)} clean=${String(wasClean)} action=${action} ${reason}`)
    })
  })

  const first = new Promise<{ session: string; sequence: number | null }>((resolve) => {
    manager.on('shardSpawn', (shardId) => {
      manager.shards.get(shardId)?.once('ready', (data) => {
        resolve({ session: data.session_id, sequence: null })
      })
    })
  })

  await manager.connect()
  const identity = await first
  if (shard === undefined) throw new Error('The shard was never created.')

  log.info(`connected — session ${identity.session}, sequence ${String(shard.sequence)}`)
  const sequenceBefore = shard.sequence

  // 'resume' persists session state and closes with a resumable code. Closing with 1000
  // would invalidate the session and make the reconnect a guaranteed fresh identify,
  // which would tell us nothing.
  log.info('dropping the socket with a resumable close')
  await shard.destroy('resume')

  if (delaySeconds > 0) {
    log.info(`waiting ${String(delaySeconds)}s before reconnecting`)
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
  }

  const outcome = nextOutcome(shard, 45_000)
  const started = performance.now()
  await shard.connect()
  const result = await outcome
  const elapsed = Math.round(performance.now() - started)

  log.info('--- results ---')
  log.info(`delay before reconnect: ${String(delaySeconds)}s`)
  log.info(`outcome: ${result} after ${String(elapsed)}ms`)
  log.info(`sequence before: ${String(sequenceBefore)}, after: ${String(shard.sequence)}`)
  log.info(`replayed dispatches: ${String(replayed)}`)

  if (result === 'resumed') {
    log.info('The session survived. No session start was consumed.')
  } else if (result === 'identified') {
    log.warn('Discord refused the resume and issued a new session; one session start spent.')
  }

  await manager.destroy(false)
  return result === 'timed out' ? 1 : 0
}

const code = await run()
process.exit(code)
