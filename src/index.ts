import { SessionLimitError } from 'vestra'
import { ConfigError, loadConfig, privilegedIntentsInUse } from './config.ts'
import { createFleet } from './gateway.ts'
import { createRest } from './rest.ts'
import { BotState } from './state.ts'
import { scoped } from './logger.ts'

/**
 * Entry point. Loads configuration, connects the fleet and waits.
 */

const log = scoped('bot')

async function main(): Promise<void> {
  const config = loadConfig()

  log.info(`intents: ${config.intentNames.join(', ')} (${String(config.intents)})`)
  log.info(`transport compression: ${config.compression}`)

  const privileged = privilegedIntentsInUse(config.intents)
  if (privileged.length > 0) {
    log.warn(
      `privileged intents in use: ${privileged.join(', ')}. These must be enabled on the ` +
        'Bot page of the developer portal, or the gateway closes with 4014.',
    )
  }

  const state = new BotState()
  const rest = createRest(config.token)
  const { manager } = createFleet(config, rest, state)

  // Shut down cleanly so sessions can be resumed on the next start rather than burning a
  // fresh identify from the daily budget.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true

    log.info(`${signal} received; disconnecting`)
    manager
      .destroy(true)
      .then(() => {
        log.info('disconnected')
        process.exit(0)
      })
      .catch((error: unknown) => {
        log.error('failed to disconnect cleanly', error)
        process.exit(1)
      })
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })

  // A rejected promise that nothing awaited should be loud here. Silently swallowing one
  // is how a test bot ends up "working" while a library bug goes unnoticed.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason)
  })

  log.info('connecting')
  await manager.connect()
  log.info(`connected — ${String(manager.shardCount)} shard(s)`)
}

try {
  await main()
} catch (error) {
  if (error instanceof ConfigError) {
    log.error(error.message)
    process.exit(1)
  }

  if (error instanceof SessionLimitError) {
    log.error(error.message)
    log.error(
      `Wait ${String(Math.ceil(error.resetAfter / 1000))}s for the allowance to reset. ` +
        'Retrying now would make it worse.',
    )
    process.exit(1)
  }

  log.error('failed to start', error)
  process.exit(1)
}
