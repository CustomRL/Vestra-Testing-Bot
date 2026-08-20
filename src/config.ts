import { CompressionMode, GatewayIntentBits, PrivilegedGatewayIntents } from 'vestra'

/**
 * Runtime configuration, read from the environment.
 */

/** The bot's resolved settings. */
export interface Config {
  /** The bot token. */
  token: string
  /** The intents bit set to identify with. */
  intents: number
  /** The names of the intents, for logging. */
  intentNames: string[]
  /** An explicit shard count, or `undefined` to use Discord's recommendation. */
  shardCount: number | undefined
  /** The transport compression to negotiate. */
  compression: CompressionMode
  /** The prefix the command handler responds to. */
  prefix: string
}

/** Intents used when `DISCORD_INTENTS` is not set. */
const DefaultIntents = ['Guilds', 'GuildMessages', 'MessageContent'] as const

/** Thrown when the environment is missing or malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function parseIntents(raw: string | undefined): { intents: number; names: string[] } {
  const names = (raw ?? DefaultIntents.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  let intents = 0
  for (const name of names) {
    if (!(name in GatewayIntentBits)) {
      const valid = Object.keys(GatewayIntentBits).join(', ')
      throw new ConfigError(`Unknown intent "${name}". Valid names are: ${valid}`)
    }
    intents |= GatewayIntentBits[name as keyof typeof GatewayIntentBits]
  }

  return { intents, names }
}

function parseCompression(raw: string | undefined): CompressionMode {
  if (raw === undefined || raw.trim() === '') return CompressionMode.ZlibStream

  const mode = raw.trim()
  const valid = Object.values(CompressionMode)
  if (!(valid as string[]).includes(mode)) {
    throw new ConfigError(
      `DISCORD_COMPRESSION must be one of ${valid.join(', ')}, got "${raw}".`,
    )
  }
  return mode as CompressionMode
}

function parseShardCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined

  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1) {
    throw new ConfigError(`DISCORD_SHARD_COUNT must be a positive integer, got "${raw}".`)
  }
  return count
}

/**
 * Which of the configured intents need approval in the developer portal.
 *
 * @param intents - The resolved intents bit set.
 * @returns The names of the privileged intents in use.
 *
 * @remarks
 * Worth surfacing at startup. Identifying with an unapproved privileged intent is closed
 * with `Disallowed intent`, which is fatal and not obviously about the developer portal.
 */
export function privilegedIntentsInUse(intents: number): string[] {
  return Object.entries(GatewayIntentBits)
    .filter(([, bit]) => (intents & bit) !== 0)
    .filter(([, bit]) => PrivilegedGatewayIntents.includes(bit))
    .map(([name]) => name)
}

/**
 * Reads and validates configuration from `.env` and the process environment.
 *
 * @returns The resolved configuration.
 * @throws {@link ConfigError} when the token is missing or a value is malformed.
 */
export function loadConfig(): Config {
  // Node reads the file itself; a dotenv dependency would be the only one in the repo.
  try {
    process.loadEnvFile('.env')
  } catch {
    // No .env is fine so long as the variables are already in the environment.
  }

  const token = process.env['DISCORD_TOKEN']?.trim()
  if (token === undefined || token === '') {
    throw new ConfigError('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.')
  }

  const { intents, names } = parseIntents(process.env['DISCORD_INTENTS'])

  return {
    token,
    intents,
    intentNames: names,
    shardCount: parseShardCount(process.env['DISCORD_SHARD_COUNT']),
    compression: parseCompression(process.env['DISCORD_COMPRESSION']),
    prefix: process.env['COMMAND_PREFIX'] ?? '!',
  }
}
