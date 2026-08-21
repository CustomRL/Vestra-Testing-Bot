import {
  GatewayOpcodes,
  MemberChunker,
  ShardManager,
  SystemTimers,
  type GatewayDispatchPayload,
  type REST,
  type Shard,
} from 'vestra'
import type { Config } from './config.ts'
import type { BotState } from './state.ts'
import { handleMessage } from './commands.ts'
import { scoped } from './logger.ts'

/**
 * Gateway wiring: the shard fleet, per-shard member chunkers and dispatch routing.
 */

const log = scoped('gateway')

/** The running fleet, and the chunkers bound to it. */
export interface Fleet {
  /** The shard manager. */
  manager: ShardManager
  /** Member chunkers, keyed by shard id. */
  chunkers: Map<number, MemberChunker>
}

/**
 * Builds the shard fleet and attaches every listener.
 *
 * @param config - Resolved configuration.
 * @param rest - The REST client, used to bootstrap and to reply.
 * @param state - Where observed state accumulates.
 * @returns The fleet, not yet connected.
 */
export function createFleet(config: Config, rest: REST, state: BotState): Fleet {
  const chunkers = new Map<number, MemberChunker>()

  const manager = new ShardManager({
    token: config.token,
    intents: config.intents,
    compression: config.compression,
    // The gateway package takes a fetcher rather than a REST client so that it never
    // depends on `@vestra/rest`. This is where the two halves meet.
    fetchGatewayBot: async () => await rest.gateway.getBot(),
    ...(config.shardCount === undefined ? {} : { shardCount: config.shardCount }),
  })

  manager.on('shardSpawn', (shardId) => {
    const shard = manager.shards.get(shardId)
    if (shard === undefined) return

    attachShard(shard, { manager, chunkers }, rest, state, config)
    log.info(`shard ${String(shardId)} spawned`)
  })

  manager.on('allReady', () => {
    // No guild count here on purpose. `ShardManager` registers its own `once('ready')`
    // before it emits `shardSpawn`, so this fires ahead of the consumer's READY handler
    // and any state read here is a tick stale.
    log.info(`all ${String(manager.shardCount)} shard(s) reported ready`)
  })

  manager.on('sessionStartWarning', (remaining, total) => {
    log.warn(`session starts running low: ${String(remaining)} of ${String(total)} left today`)
  })

  manager.on('error', (error, shardId) => {
    log.error(`shard ${String(shardId)} error`, error)
  })

  return { manager, chunkers }
}

function attachShard(
  shard: Shard,
  fleet: Fleet,
  rest: REST,
  state: BotState,
  config: Config,
): void {
  // The chunker is not wired into `Shard` itself, so the consumer owns both halves:
  // sending the op-8 payload, and feeding the resulting chunks back in.
  // Passing the intents lets the chunker reject a request Discord would silently drop,
  // instead of the caller waiting out a timeout that can only guess at the cause.
  const chunker = new MemberChunker(
    async (data) => {
      await shard.send({ op: GatewayOpcodes.RequestGuildMembers, d: data })
    },
    SystemTimers,
    config.intents,
  )
  fleet.chunkers.set(shard.id, chunker)

  const tag = `shard ${String(shard.id)}`

  shard.on('ready', (data) => {
    state.applyReady(data)
    // Chunks belong to a session. Anything outstanding across a fresh identify is dead.
    chunker.reset(new Error('The session was replaced by a fresh identify.'))
    log.info(
      `${tag} ready as ${state.botTag ?? 'unknown'} — ` +
        `${String(data.guilds.length)} guild(s), session ${data.session_id}`,
    )
  })

  shard.on('resumed', () => {
    state.resumes += 1
    log.info(`${tag} resumed`)
  })

  shard.on('hello', (intervalMs) => {
    log.debug(`${tag} hello — heartbeat every ${String(intervalMs)}ms`)
  })

  shard.on('stateChange', (from, to) => {
    log.debug(`${tag} ${from} -> ${to}`)
  })

  shard.on('closed', (code, reason, wasClean, action) => {
    const level = wasClean ? 'info' : 'warn'
    log[level](
      `${tag} closed ${String(code)} (${reason === '' ? 'no reason' : reason}) — ${action}`,
    )
  })

  shard.on('zombie', () => {
    log.warn(`${tag} stopped acknowledging heartbeats; reconnecting`)
  })

  shard.on('backpressure', (inflight, bytes) => {
    log.warn(`${tag} back-pressure: ${String(inflight)} inflight, ${String(bytes)} bytes`)
  })

  shard.on('heartbeatDrift', (driftMs) => {
    log.warn(`${tag} heartbeat late by ${String(Math.round(driftMs))}ms — event loop blocked?`)
  })

  shard.on('error', (error) => {
    log.error(`${tag} error`, error)
  })

  shard.on('dispatch', (payload, replayed) => {
    routeDispatch(payload, replayed, shard, chunker, fleet, rest, state, config)
  })
}

function routeDispatch(
  payload: GatewayDispatchPayload,
  replayed: boolean,
  shard: Shard,
  chunker: MemberChunker,
  fleet: Fleet,
  rest: REST,
  state: BotState,
  config: Config,
): void {
  state.countDispatch(payload.t, replayed)
  log.debug(`shard ${String(shard.id)} <- ${payload.t}${replayed ? ' (replayed)' : ''}`)

  if (payload.t === 'GUILD_MEMBERS_CHUNK') {
    chunker.handleChunk(payload.d)
    return
  }

  if (payload.t === 'GUILD_CREATE') {
    state.guilds.add(payload.d.id)
    return
  }

  if (payload.t === 'GUILD_DELETE') {
    // An outage marks the guild unavailable; only a real removal drops it from the set.
    if (payload.d.unavailable === true) return
    state.guilds.delete(payload.d.id)
    return
  }

  if (payload.t === 'MESSAGE_CREATE') {
    // Replayed messages were already handled before the disconnect; running them again
    // would double every command issued in the seconds before a resume.
    if (replayed) return

    void handleMessage(
      {
        rest,
        manager: fleet.manager,
        shard,
        chunker,
        state,
        timers: SystemTimers,
        message: payload.d,
      },
      config.prefix,
    )
  }
}
