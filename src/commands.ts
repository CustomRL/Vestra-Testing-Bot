import type {
  APIAllowedMentions,
  GatewayMessageCreateDispatchData,
  MemberChunker,
  REST,
  Shard,
  ShardManager,
  Timers,
} from 'vestra'
import type { BotState } from './state.ts'
import { scoped } from './logger.ts'

/**
 * The command handler.
 *
 * @remarks
 * Prefix commands rather than slash commands on purpose: they exercise the
 * `MessageContent` intent and the gateway dispatch path, which is what this bot exists to
 * test. Slash commands would arrive over an interaction webhook and prove far less.
 */

const log = scoped('commands')

/** Never let relayed user input ping anybody. See `APIAllowedMentions` in the library. */
const NoMentions: APIAllowedMentions = { parse: [] }

/** What a command needs to do its work. */
export interface CommandContext {
  /** The REST client. */
  rest: REST
  /** The shard fleet. */
  manager: ShardManager
  /** The shard the triggering message arrived on. */
  shard: Shard
  /** The member chunker bound to that shard. */
  chunker: MemberChunker
  /** Accumulated bot state. */
  state: BotState
  /** Timer sources, so the reconnect test can be driven deterministically. */
  timers: Timers
  /** The triggering message. */
  message: GatewayMessageCreateDispatchData
  /** The arguments after the command name. */
  args: string[]
}

/** A single command. */
interface Command {
  /** One-line description, shown by `help`. */
  description: string
  /** Runs the command. */
  run: (context: CommandContext) => Promise<string>
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function formatLatency(latency: number): string {
  return Number.isFinite(latency) && latency >= 0 ? `${String(Math.round(latency))}ms` : '—'
}

const commands: Record<string, Command> = {
  help: {
    description: 'Lists the available commands.',
    run: async () => {
      const lines = Object.entries(commands)
        .map(([name, command]) => `\`${name}\` — ${command.description}`)
        .sort()
      return await Promise.resolve(`**Vestra test bot**\n${lines.join('\n')}`)
    },
  },

  ping: {
    description: 'Reports gateway heartbeat latency and a REST round-trip.',
    run: async (context) => {
      const started = performance.now()
      await context.rest.channels.triggerTyping(context.message.channel_id)
      const restMs = Math.round(performance.now() - started)

      return (
        'Pong.\n' +
        `- gateway heartbeat: ${formatLatency(context.shard.latency)}\n` +
        `- REST round-trip: ${String(restMs)}ms\n` +
        `- shard: ${String(context.shard.id)} of ${String(context.manager.shardCount)}`
      )
    },
  },

  info: {
    description: 'Reports identity, uptime and memory.',
    run: async (context) => {
      const memory = process.memoryUsage()
      return await Promise.resolve(
        `**${context.state.botTag ?? 'unknown'}** (\`${context.state.botId ?? '?'}\`)\n` +
          `- uptime: ${context.state.uptime}\n` +
          `- guilds: ${String(context.state.guilds.size)}\n` +
          `- shards: ${String(context.manager.shardCount)}\n` +
          `- heap: ${formatBytes(memory.heapUsed)} of ${formatBytes(memory.heapTotal)}\n` +
          `- rss: ${formatBytes(memory.rss)}\n` +
          `- node: ${process.version}`,
      )
    },
  },

  shards: {
    description: 'Reports the state of every shard in this process.',
    run: async (context) => {
      const rows = [...context.manager.shards.values()].map((shard) => {
        const sequence = shard.sequence === null ? '—' : String(shard.sequence)
        return (
          `- shard ${String(shard.id)}: ${shard.state} · ` +
          `${formatLatency(shard.latency)} · seq ${sequence}`
        )
      })
      return await Promise.resolve(`**Shards**\n${rows.join('\n')}`)
    },
  },

  stats: {
    description: 'Reports the most frequent gateway dispatches seen so far.',
    run: async (context) => {
      const top = context.state.topDispatches(10)
      if (top.length === 0) return await Promise.resolve('No dispatches recorded yet.')

      const total = [...context.state.dispatchCounts.values()].reduce((sum, n) => sum + n, 0)
      const rows = top.map((row) => `- \`${row.event}\` x${String(row.seen)}`)
      return await Promise.resolve(
        `**Dispatches** (${String(total)} total, ${String(context.state.replayed)} replayed ` +
          `across ${String(context.state.resumes)} resume(s))\n${rows.join('\n')}`,
      )
    },
  },

  echo: {
    description: 'Repeats its argument. Exercises the MessageContent intent.',
    run: async (context) => {
      const text = context.args.join(' ')
      if (text === '') {
        return await Promise.resolve(
          'Nothing to echo. If you passed text and this still says nothing, the ' +
            '`MessageContent` privileged intent is probably not enabled.',
        )
      }
      return await Promise.resolve(text)
    },
  },

  members: {
    description: 'Fetches members over the gateway. Exercises the member chunker.',
    run: async (context) => {
      const guildId = context.message.guild_id
      if (guildId === undefined) return 'This command only works in a guild.'

      // Discord pairs an empty query with `limit: 0` to mean "every member"; a non-zero
      // limit alongside an empty query is not a combination the API documents. The
      // all-members form is also gated to once per guild per 30 seconds.
      const query = context.args[0] ?? ''
      const started = performance.now()
      const members = await context.chunker.request({
        guildId,
        query,
        limit: query === '' ? 0 : 100,
      })
      const elapsed = Math.round(performance.now() - started)

      const names = members
        .slice(0, 10)
        .map((member) => member.user?.username ?? 'unknown')
        .join(', ')

      return (
        `Fetched ${String(members.length)} member(s) in ${String(elapsed)}ms` +
        (query === '' ? '' : ` matching \`${query}\``) +
        (names === '' ? '.' : `.\nFirst few: ${names}`)
      )
    },
  },

  reconnect: {
    description: 'Drops the socket resumably and reconnects. Exercises the resume path.',
    run: async (context) => {
      const { shard } = context

      // Whether the reconnect resumed or fell back to a fresh identify is the whole
      // result, so listen for both before dropping the socket.
      const outcome = new Promise<string>((resolve) => {
        // Every path clears the timer and both listeners. Leaving the timer armed would
        // hold the event loop open for 30s after an answer had already arrived.
        const settle = (result: string): void => {
          context.timers.clearTimeout(timer)
          shard.off('resumed', onResumed)
          shard.off('ready', onReady)
          resolve(result)
        }
        const onResumed = (): void => {
          settle('resumed')
        }
        const onReady = (): void => {
          settle('identified')
        }
        const timer = context.timers.setTimeout(() => {
          settle('timed out')
        }, 30_000)

        shard.on('resumed', onResumed)
        shard.on('ready', onReady)
      })

      const started = performance.now()
      // 'resume' persists the session and closes with a resumable code. A plain close
      // would invalidate it and turn this into a session start, which is daily-capped.
      await shard.destroy('resume')
      await shard.connect()

      const result = await outcome
      const elapsed = Math.round(performance.now() - started)

      return (
        `Reconnect ${result} in ${String(elapsed)}ms.\n` +
        `- shard: ${String(shard.id)}\n` +
        `- state: ${shard.state}\n` +
        `- sequence: ${shard.sequence === null ? '—' : String(shard.sequence)}\n` +
        (result === 'resumed'
          ? 'The session survived — no session start was consumed.'
          : result === 'identified'
            ? 'Fell back to a fresh identify, which spends one of the daily session starts.'
            : 'Neither RESUMED nor READY arrived within 30s.')
      )
    },
  },

  react: {
    description: 'Reacts to your message. Exercises a REST route with an encoded path.',
    run: async (context) => {
      await context.rest.channels.addReaction(
        context.message.channel_id,
        context.message.id,
        '✅',
      )
      return 'Reacted.'
    },
  },
}

/**
 * Handles a message, running a command if one matches.
 *
 * @param context - Everything the command needs, minus the parsed arguments.
 * @param prefix - The command prefix.
 *
 * @remarks
 * Errors are reported back into the channel rather than thrown. A test bot that dies on a
 * bad command is a test bot that stops testing.
 */
export async function handleMessage(
  context: Omit<CommandContext, 'args'>,
  prefix: string,
): Promise<void> {
  const { message } = context

  // Ignore bots, including ourselves. Two of these bots in one guild would otherwise
  // echo at each other until a rate limit stopped them.
  if (message.author.bot === true) return
  if (!message.content.startsWith(prefix)) return

  const [name, ...args] = message.content.slice(prefix.length).trim().split(/\s+/)
  if (name === undefined || name === '') return

  const command = commands[name.toLowerCase()]
  if (command === undefined) return

  log.info(`${message.author.username} ran "${name}"`)

  try {
    const reply = await command.run({ ...context, args })
    await context.rest.channels.createMessage(message.channel_id, {
      content: reply.slice(0, 2000),
      allowed_mentions: NoMentions,
      message_reference: { message_id: message.id, fail_if_not_exists: false },
    })
  } catch (error) {
    log.error(`"${name}" failed`, error)

    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    await context.rest.channels
      .createMessage(message.channel_id, {
        content: `Command failed.\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``,
        allowed_mentions: NoMentions,
      })
      .catch((sendError: unknown) => {
        log.error('could not report the failure either', sendError)
      })
  }
}
