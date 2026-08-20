import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  CompressionMode,
  GatewayOpcodes,
  MemberChunker,
  ShardManager,
  SystemTimers,
  type GatewayDispatchPayload,
} from 'vestra'
import { loadConfig } from '../src/config.ts'
import { createRest } from '../src/rest.ts'
import { scoped } from '../src/logger.ts'

/**
 * A transport-compression conformance probe.
 *
 * @remarks
 * ADR 7 keeps `zstd-stream` off the default path because the round-trip evidence to date
 * used Node's compressor on both ends, which proves Node is self-consistent rather than
 * interoperable with Discord's encoder. It names the missing evidence explicitly: a
 * conformance check against live gateway traffic.
 *
 * This is that check. It connects with one mode, decodes real traffic, and deliberately
 * provokes large frames — a corrupt decode surfaces as a `JSON.parse` failure downstream,
 * so a clean run across many messages including large ones is the signal.
 *
 * Run with `node scripts/compression-check.ts <mode>`.
 */

const log = scoped('compression')

interface Totals {
  dispatches: number
  bytes: number
  largest: { event: string; bytes: number }
  errors: Error[]
  events: Set<string>
  /** Digest of each decoded GUILD_CREATE, keyed by guild id. */
  digests: Map<string, string>
}

/**
 * Serialises a value with object keys in sorted order, recursively.
 *
 * @param value - The decoded payload.
 * @returns A stable string for hashing.
 *
 * @remarks
 * Plain `JSON.stringify` preserves key insertion order, and Discord's key ordering varies
 * between connections — so hashing it compares serialisation order, not content, and two
 * correct decodes disagree. Sorting first makes the digest a conformance signal instead.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

function parseMode(raw: string | undefined): CompressionMode {
  const valid = Object.values(CompressionMode)
  if (raw === undefined || !(valid as string[]).includes(raw)) {
    throw new Error(`Pass one of: ${valid.join(', ')}`)
  }
  return raw as CompressionMode
}

async function run(): Promise<Totals> {
  const mode = parseMode(process.argv[2])
  const config = loadConfig()
  const rest = createRest(config.token)

  const totals: Totals = {
    dispatches: 0,
    bytes: 0,
    largest: { event: 'none', bytes: 0 },
    errors: [],
    events: new Set(),
    digests: new Map(),
  }

  log.info(`connecting with ${mode}`)

  const manager = new ShardManager({
    token: config.token,
    intents: config.intents,
    compression: mode,
    shardCount: 1,
    fetchGatewayBot: async () => await rest.gateway.getBot(),
  })

  let chunker: MemberChunker | undefined

  // Hand-rolled rather than `Promise.withResolvers`, which is ES2024. The library targets
  // ES2023, and this probe should not need a newer lib than the code it is testing.
  type Identity = { guilds: string[]; session: string }
  let resolveReady: (identity: Identity) => void = () => undefined
  const ready = new Promise<Identity>((resolve) => {
    resolveReady = resolve
  })

  manager.on('shardSpawn', (shardId) => {
    const shard = manager.shards.get(shardId)
    if (shard === undefined) return

    chunker = new MemberChunker(async (data) => {
      await shard.send({ op: GatewayOpcodes.RequestGuildMembers, d: data })
    }, SystemTimers)

    shard.on('error', (error) => {
      totals.errors.push(error)
      log.error('shard error', error.message)
    })

    shard.on('closed', (code, reason, wasClean) => {
      if (!wasClean) {
        totals.errors.push(new Error(`unclean close ${String(code)}: ${reason}`))
      }
    })

    shard.on('ready', (data) => {
      resolveReady({
        guilds: data.guilds.map((guild) => guild.id),
        session: data.session_id,
      })
    })

    shard.on('dispatch', (payload: GatewayDispatchPayload) => {
      // Reaching this listener at all means the frame decompressed and parsed as JSON.
      // Re-serialising gives a size for the decoded payload, which is what we want to
      // report — the compressed wire size is not observable from here.
      const size = Buffer.byteLength(JSON.stringify(payload.d ?? null))
      totals.dispatches += 1
      totals.bytes += size
      totals.events.add(payload.t)
      if (size > totals.largest.bytes) totals.largest = { event: payload.t, bytes: size }

      // A digest of the decoded payload is the actual conformance signal: two codecs that
      // agree byte-for-byte on the same guild have both decoded Discord's encoder
      // correctly. Sizes matching could still hide a transposition; a hash cannot.
      if (payload.t === 'GUILD_CREATE') {
        const guild = payload.d as { id?: string }
        const body = stableStringify(payload.d)
        const digest = createHash('sha256').update(body).digest('hex')
        totals.digests.set(guild.id ?? 'unknown', digest.slice(0, 16))

        // Dumping the decoded payload lets two runs be diffed directly, which is the only
        // way to tell a codec disagreement from ordinary payload volatility.
        const dumpDir = process.env['DUMP_DIR']
        if (dumpDir !== undefined) {
          writeFileSync(`${dumpDir}/${mode}-${guild.id ?? 'unknown'}.json`, body)
        }
      }

      if (payload.t === 'GUILD_MEMBERS_CHUNK' && chunker !== undefined) {
        chunker.handleChunk(payload.d as Parameters<MemberChunker['handleChunk']>[0])
      }
    })
  })

  await manager.connect()
  const identity = await ready
  log.info(`ready — session ${identity.session}, ${String(identity.guilds.length)} guild(s)`)

  // Large frames are where a window-size mismatch would show up, so provoke some rather
  // than reporting on heartbeat-sized traffic. Requesting every member is the biggest
  // payload a bot can ask for on demand.
  for (const guildId of identity.guilds) {
    try {
      const members = await chunker?.request({ guildId, limit: 0, timeoutMs: 20_000 })
      log.info(`guild ${guildId}: ${String(members?.length ?? 0)} member(s) over the gateway`)
    } catch (error) {
      // A missing GuildMembers intent fails here. That is a configuration limit, not a
      // decode failure, so it is reported without being counted as an error.
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`guild ${guildId}: member request failed — ${message}`)
    }
  }

  await manager.destroy(false)
  return totals
}

const totals = await run()

log.info('--- results ---')
log.info(`dispatches decoded: ${String(totals.dispatches)}`)
log.info(`decoded bytes: ${String(totals.bytes)}`)
log.info(`largest payload: ${totals.largest.event} at ${String(totals.largest.bytes)} bytes`)
log.info(`distinct events: ${[...totals.events].sort().join(', ')}`)
for (const [guildId, digest] of [...totals.digests].sort()) {
  log.info(`GUILD_CREATE digest ${guildId}: ${digest}`)
}
log.info(`errors: ${String(totals.errors.length)}`)

for (const error of totals.errors) log.error(`  ${error.message}`)

process.exit(totals.errors.length === 0 ? 0 : 1)
