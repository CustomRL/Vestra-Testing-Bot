import { buildGatewayUrl, WebSocketTransport, type TransportListeners } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { createRest } from '../src/rest.ts'
import { scoped } from '../src/logger.ts'

/**
 * Transport conformance against Discord itself.
 *
 * @remarks
 * `packages/gateway/test/transport.test.ts` scripts X1–X9 from the Phase 3 spec against a
 * local RFC 6455 server. On some runtimes — Node 25.8.1 on Windows among them — the global
 * `WebSocket` will not complete a handshake with a locally hosted server at all, so that
 * suite skips and its assertions go unproven.
 *
 * Discord is a real server the same client connects to happily, so the subset of those
 * checks that a real peer can be made to perform is verifiable here. That is X1 (a close
 * code and reason delivered verbatim, cleanly) and X7 (binary arrives as an `ArrayBuffer`).
 * The rest need a peer that misbehaves on command and stay with the local suite.
 *
 * Run with `node scripts/transport-check.ts`.
 *
 * Authentication failures do not consume a session start, so this is cheap to repeat.
 */

const log = scoped('transport')

interface Outcome {
  opened: boolean
  firstMessageIsArrayBuffer: boolean | null
  close: { code: number; reason: string; wasClean: boolean } | null
}

async function run(): Promise<Outcome> {
  const config = loadConfig()
  const rest = createRest(config.token)

  const info = await rest.gateway.getBot()
  // zlib-stream so the first frame is binary, which is what X7 turns on.
  const url = buildGatewayUrl(info.url, '10', 'json', 'zlib-stream')
  log.info(`connecting to ${url}`)

  const outcome: Outcome = { opened: false, firstMessageIsArrayBuffer: null, close: null }

  let settle: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })

  const listeners: TransportListeners = {
    onOpen: () => {
      outcome.opened = true
      log.info('socket opened')
    },
    onMessage: (data) => {
      outcome.firstMessageIsArrayBuffer ??= data instanceof ArrayBuffer
    },
    onClose: (code, reason, wasClean) => {
      outcome.close = { code, reason, wasClean }
      settle()
    },
    onError: (error) => {
      // Expected to be uninformative; the transport documents why.
      log.warn(`error event: ${error.message === '' ? '(no message)' : error.message}`)
    },
  }

  const transport = new WebSocketTransport(listeners, { userAgent: 'Vestra transport check' })
  transport.connect(url)

  // Wait for Hello, then identify with a token Discord will certainly reject. 4004 is the
  // one authoritative close code a client can provoke on demand without side effects.
  setTimeout(() => {
    transport.send(
      JSON.stringify({
        op: 2,
        d: {
          token: 'Bot not.a.real.token',
          intents: 0,
          properties: { os: 'linux', browser: 'vestra', device: 'vestra' },
        },
      }),
    )
  }, 1_000)

  const guard = setTimeout(() => {
    settle()
  }, 20_000)

  await finished
  clearTimeout(guard)
  transport.destroy()
  return outcome
}

const outcome = await run()

log.info('--- results ---')
log.info(`opened: ${String(outcome.opened)}`)
log.info(`X7 first message is an ArrayBuffer: ${String(outcome.firstMessageIsArrayBuffer)}`)

if (outcome.close === null) {
  log.error('X1 inconclusive: no close was observed within 20s')
  process.exit(1)
}

const { code, reason, wasClean } = outcome.close
log.info(`X1 close: code=${String(code)} wasClean=${String(wasClean)} reason="${reason}"`)

const failures: string[] = []
if (code !== 4004) failures.push(`expected close code 4004, got ${String(code)}`)
if (!wasClean) failures.push('expected a clean close from a completed closing handshake')
if (reason === '') failures.push('expected a non-empty reason delivered verbatim')
if (outcome.firstMessageIsArrayBuffer !== true) {
  failures.push('expected the first binary frame to arrive as an ArrayBuffer')
}

for (const failure of failures) log.error(failure)
log.info(failures.length === 0 ? 'X1 and X7 hold against the live gateway.' : 'checks failed')

process.exit(failures.length === 0 ? 0 : 1)
