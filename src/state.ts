import type { GatewayReadyDispatchData } from 'vestra'

/**
 * The small amount of state the bot keeps.
 *
 * @remarks
 * A stand-in for the cache that arrives with the client in Phase 4. Kept deliberately
 * thin: this exists so the commands have something to report, not to prototype a cache.
 */

/** What the bot remembers about the current session. */
export class BotState {
  /** When the process started. */
  readonly startedAt = Date.now()
  /** The bot's own user id, once READY has arrived. */
  botId: string | null = null
  /** The bot's tag, for logging. */
  botTag: string | null = null
  /** Guild ids the bot is in, across every shard. */
  readonly guilds = new Set<string>()
  /** How many dispatches have been seen, by event name. */
  readonly dispatchCounts = new Map<string, number>()
  /**
   * How many dispatches arrived as replay after a resume.
   *
   * @remarks
   * Tracked separately because a replayed dispatch is one the bot has already seen. Folding
   * them into the totals would make a resume look like a burst of fresh traffic, which is
   * exactly the distinction this bot exists to observe.
   */
  replayed = 0
  /** How many times a session has been resumed. */
  resumes = 0

  /**
   * Records the identity from a READY payload.
   *
   * @param data - The READY dispatch data.
   */
  applyReady(data: GatewayReadyDispatchData): void {
    this.botId = data.user.id
    this.botTag = data.user.discriminator === '0'
      ? data.user.username
      : `${data.user.username}#${data.user.discriminator}`

    // READY carries unavailable stubs; GUILD_CREATE fills them in moments later.
    for (const guild of data.guilds) this.guilds.add(guild.id)
  }

  /**
   * Counts a dispatch.
   *
   * @param event - The event name.
   */
  countDispatch(event: string, wasReplayed: boolean): void {
    this.dispatchCounts.set(event, (this.dispatchCounts.get(event) ?? 0) + 1)
    if (wasReplayed) this.replayed += 1
  }

  /** How long the process has been running, formatted. */
  get uptime(): string {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${String(hours)}h ${String(minutes)}m ${String(seconds % 60)}s`
  }

  /** The busiest events seen so far, most frequent first. */
  topDispatches(count: number): { event: string; seen: number }[] {
    return [...this.dispatchCounts.entries()]
      .map(([event, seen]) => ({ event, seen }))
      .sort((a, b) => b.seen - a.seen)
      .slice(0, count)
  }
}
