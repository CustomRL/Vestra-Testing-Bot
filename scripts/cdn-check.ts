import { Client, GatewayIntentBits } from 'vestra'
import { loadConfig } from '../src/config.ts'
import { scoped } from '../src/logger.ts'

/**
 * Checks that the CDN URLs the library builds actually resolve.
 *
 * @remarks
 * Unit tests can only prove the string is the shape the code intends. Whether that shape is
 * the one Discord serves — `discovery-splashes` and not `discovery-splash`, `role-icons` and
 * not `roleicons` — is a claim about a live service, and a HEAD request is the cheap way to
 * check it. A wrong path passes every assertion and 404s in production.
 */

const log = scoped('cdn')
const client = new Client({
  token: loadConfig().token,
  intents: [GatewayIntentBits.Guilds],
})

await client.login()
await new Promise((resolve) => setTimeout(resolve, 5_000))

const checks: [string, string | undefined][] = []

const self = client.user
if (self !== undefined) {
  checks.push(['bot avatar', self.avatarUrl()])
  checks.push(['bot avatar @128', self.avatarUrl({ size: 128 })])
  checks.push(['default avatar', self.avatarUrl({ format: 'png' })])
}

for (const guild of client.cache.guilds.values()) {
  checks.push([`icon of ${guild.name}`, guild.iconUrl()])
  checks.push([`banner of ${guild.name}`, guild.bannerUrl()])
  checks.push([`splash of ${guild.name}`, guild.splashUrl()])
  for (const role of client.cache.roles.group(guild.id)) {
    const icon = role.iconUrl()
    if (icon !== undefined) checks.push([`icon of role ${role.name}`, icon])
  }
}

let failures = 0
for (const [label, url] of checks) {
  if (url === undefined) {
    log.info(`${label}: not set, nothing to check`)
    continue
  }
  const response = await fetch(url, { method: 'HEAD' })
  if (!response.ok) failures += 1
  log.info(`${label}: ${String(response.status)} ${response.ok ? 'OK' : 'FAILED'} ${url}`)
}

log.info(failures === 0 ? 'PASS: every built URL resolved' : `FAIL: ${String(failures)} did not`)
await client.destroy()
process.exit(failures === 0 ? 0 : 1)
