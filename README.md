# Vestra testing bot

A live Discord bot that exercises [Vestra](../Vestra) against the real gateway and REST
API. It exists to find things unit tests cannot: real close codes, real rate limits, real
resumes, real chunked member replies.

It is **not** a demonstration of the library's intended ergonomics. `@vestra/core` is
still a skeleton — the `Client`, structures, cache and typed event handlers arrive in
Phase 4 — so this bot wires `ShardManager`, `MemberChunker` and `REST` together by hand.
Much of `src/gateway.ts` is work the client will eventually do for you.

## Setup

The bot depends on the library through a local link, so build the monorepo first:

```bash
cd ../Vestra && pnpm build
cd ../Vestra-Testing-Bot && pnpm install
```

Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`.

`MessageContent` is a privileged intent and is on by default here, because every command
is a prefix command. Enable it on the **Bot** page of your application in the
[developer portal](https://discord.com/developers/applications), or the gateway will
close the connection with `4014 Disallowed intent`. Add `GuildMembers` too if you want
`!members` to fetch more than a username-prefix match.

## Running

```bash
pnpm start          # node runs the TypeScript directly, no build step
DEBUG=1 pnpm start  # adds state transitions and every dispatch
```

Node 22.18+ is required — the sources run through native type stripping rather than a
compiler, which is why there is no build script and no `tsx` dependency. `pnpm typecheck`
runs `tsc` separately, with the same strictness the library uses.

## Commands

| Command | What it exercises |
| --- | --- |
| `!help` | Nothing; lists the rest. |
| `!ping` | Heartbeat latency from `Shard.latency`, plus a REST round-trip. |
| `!info` | Identity from `READY`, uptime, guild count, memory. |
| `!shards` | `ShardState`, latency and sequence number per shard. |
| `!stats` | Dispatch counts, which is a cheap way to spot events arriving that the typings do not cover. |
| `!echo <text>` | The `MessageContent` intent, and `allowed_mentions` on the way back out. |
| `!members [query]` | `MemberChunker` — an op-8 request and the reassembly of the chunked reply. |
| `!react` | A REST route with a percent-encoded path segment. |
| `!reconnect` | Drops the socket resumably and reconnects, reporting whether Discord resumed the session or forced a fresh identify. |

## Probes

Two scripts answer questions the unit tests cannot, because they need a real counterparty.
Both take a real session and are not free to run — a failed resume spends one of the daily
session starts.

```bash
pnpm check:compression zstd-stream   # or zlib-stream, none
pnpm check:resume 60                 # seconds to wait before reconnecting
```

`compression-check` connects with one transport codec, decodes live dispatches and prints
a key-sorted digest of each `GUILD_CREATE`. Running it for two codecs and comparing digests
is the conformance check [ADR 7](../Vestra/docs/adr/0007-zlib-stream-default.md) asks for.
The digest must sort keys: Discord's JSON key ordering varies between connections, so
hashing raw `JSON.stringify` output compares serialisation order rather than content.

`resume-check` connects, drops the socket with a resumable close, waits, and reconnects.
Whether `RESUMED` or `READY` arrives says whether the session survived. Running it at
increasing delays brackets the session timeout, which Discord documents only as "a few
minutes".

## Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point, startup errors, graceful shutdown. |
| `src/config.ts` | Environment parsing and intent resolution. |
| `src/gateway.ts` | Shard fleet, member chunkers, dispatch routing. |
| `src/commands.ts` | The command table and the message handler. |
| `src/rest.ts` | REST client with rate-limit logging. |
| `src/state.ts` | The small amount of state the commands report on. |
| `src/logger.ts` | Timestamped console output. |
| `scripts/compression-check.ts` | Transport compression conformance probe. |
| `scripts/resume-check.ts` | Resume and session-timeout probe. |

## What the probes found

Measured against the live gateway on 2026-08-20. Reported upstream on
[CustomRL/Vestra#7](https://github.com/CustomRL/Vestra/issues/7) and
[#8](https://github.com/CustomRL/Vestra/issues/8).

**Transport compression.** `zlib-stream`, `zstd-stream` and `none` all decoded live traffic
to byte-identical payloads (key-sorted digests match; structural diff empty), largest frame
18,106 bytes, zero errors. `zstd-stream` is not gated behind any special access. This does
*not* touch the window-size question in ADR 7 — an 18 KB frame cannot approach Node's
default 128 MiB `ZSTD_d_windowLogMax` — and Node 22's zstd is still Stability 1, so the
default should stay where it is.

**Session lifetime.** After a client-initiated 4000 close, the session survived a 90s gap
and was gone by 120s:

| Delay | Outcome |
| --- | --- |
| 5s, 60s, 90s | resumed, 150–300ms, 2 dispatches replayed |
| 120s, 180s | fresh identify, 1.4–1.5s, nothing replayed |

Discord documents this only as "a few minutes"; the observed window is nearer 90–120
seconds. One sample per point, so treat it as a bound rather than a constant.

**Resume works.** Sequence advanced 1 → 4 across a resume with the replayed dispatches
flagged correctly, so that plumbing is right end to end.

## Notes from wiring this up

Things worth knowing if you are reading the library rather than using it:

- **`MemberChunker` is not connected to `Shard`.** The consumer owns both halves: passing
  a `send` that emits the op-8 payload, and routing `GUILD_MEMBERS_CHUNK` dispatches back
  into `handleChunk`. Reasonable while the client does not exist, but it means the chunker
  is unreachable from a bare `Shard`.
- **`ShardManagerEvents.allReady` now fires after consumer `ready` handlers**, as of
  [CustomRL/Vestra#11](https://github.com/CustomRL/Vestra/issues/11). It used to run first,
  because the manager registers its own `once('ready')` inside `connect()` before it emits
  `shardSpawn` — so a consumer attaching on `shardSpawn` was always second in line and
  state read in an `allReady` handler was a tick stale. This bot found it: it logged
  `0 guild(s) known` a fraction before its own handler stored two.
- **`GatewayDispatchPayload` narrows on `t` as of
  [CustomRL/Vestra#10](https://github.com/CustomRL/Vestra/issues/10).** It used to be one
  interface parameterised by the event name, so `t` narrowed and `d` came out as `unknown`
  — events missing from `GatewayDispatchEventMap` take the `unknown` branch of
  `GatewayDispatchData`, and `unknown` absorbs every other member of a union. This bot
  carried an `isDispatch` type predicate to work around it. It is a union now, a plain
  `payload.t === 'MESSAGE_CREATE'` check narrows both, and the predicate is gone.
