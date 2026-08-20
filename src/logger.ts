/**
 * A timestamped console logger.
 *
 * Deliberately tiny and dependency-free — the point of this repo is to exercise Vestra,
 * not to demonstrate a logging library.
 */

/** How noisy a log line is. */
export type LogLevel = 'debug' | 'error' | 'info' | 'warn'

const Colours: Record<LogLevel, string> = {
  debug: '[90m',
  info: '[36m',
  warn: '[33m',
  error: '[31m',
}

const Reset = '[0m'
const Bold = '[1m'

/** Whether debug lines are printed. Set `DEBUG=1` to see raw dispatch traffic. */
const debugEnabled = process.env['DEBUG'] === '1'

function timestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

/**
 * Prints a log line.
 *
 * @param level - The severity.
 * @param scope - The subsystem the line came from, such as `gateway` or `rest`.
 * @param message - The line itself.
 * @param extra - Any additional values to append.
 */
export function log(level: LogLevel, scope: string, message: string, ...extra: unknown[]): void {
  if (level === 'debug' && !debugEnabled) return

  const prefix = `${Colours[level]}${timestamp()} ${level.toUpperCase().padEnd(5)}${Reset}`
  const target = level === 'error' ? console.error : console.log
  target(`${prefix} ${Bold}${scope}${Reset} ${message}`, ...extra)
}

/** Level-specific logging functions bound to one scope. */
export type ScopedLogger = Record<LogLevel, (message: string, ...extra: unknown[]) => void>

/**
 * Builds a logger bound to one scope.
 *
 * @param scope - The subsystem name to tag every line with.
 * @returns Level-specific logging functions.
 */
export function scoped(scope: string): ScopedLogger {
  return {
    debug: (message, ...extra) => {
      log('debug', scope, message, ...extra)
    },
    info: (message, ...extra) => {
      log('info', scope, message, ...extra)
    },
    warn: (message, ...extra) => {
      log('warn', scope, message, ...extra)
    },
    error: (message, ...extra) => {
      log('error', scope, message, ...extra)
    },
  }
}
