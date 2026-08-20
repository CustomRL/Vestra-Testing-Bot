import { REST } from 'vestra'
import { scoped } from './logger.ts'

/**
 * The REST client, wired to log rate limits and failures.
 */

const log = scoped('rest')

/**
 * Builds a REST client for the given token.
 *
 * @param token - The bot token.
 * @returns A client with logging attached.
 */
export function createRest(token: string): REST {
  const rest = new REST().setToken(token)

  rest.on('rateLimited', (info) => {
    // Worth shouting about. A bot that trips these in normal operation is doing something
    // wrong, and the global flag in particular means every other request is queued too.
    log.warn(
      `rate limited for ${String(info.timeToReset)}ms`,
      `route=${info.route} global=${String(info.global)} limit=${String(info.limit)}`,
    )
  })

  rest.on('response', (request, status) => {
    log.debug(`${request.method} ${request.path} -> ${String(status)}`)
  })

  return rest
}
