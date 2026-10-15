import {queuedEntrypoint} from '@runeditrun/rer/queued-entry';
const queued=await queuedEntrypoint(import.meta.url,'verify:email-link');if(queued!==null)process.exit(queued);
// The foundation's one end-to-end email-link test: the emitted Worker claims
// the owner, mails a sign-in link to the key-gated development outbox, and the
// link signs in through confirmation. Dev identity never replaces this path.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`, directory = await mkdtemp(join(tmpdir(), 'foundation-email-link-'))
const secret = () => randomBytes(32).toString('base64url'), owner = 'owner@example.test'
const vars = { AUTH_LOCAL: 'true', AUTH_ORIGIN: origin, OWNER_EMAIL: owner, SESSION_SECRET: secret(), SETUP_TOKEN: secret(), MAIL_PROVIDER: 'development', MAIL_FROM: 'auth@localhost.test', RER_DEV_KEY: secret() }
await writeFile(join(directory, 'local.env'), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
const wrangler = ['node_modules/wrangler/bin/wrangler.js', '--config', 'dist/server/wrangler.json']
execFileSync(process.execPath, [wrangler[0], 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', directory, ...wrangler.slice(1)], { stdio: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } })
const worker = spawn(process.execPath, [wrangler[0], 'dev', ...wrangler.slice(1), '--inspector-port', '0', '--local', '--persist-to', directory, '--ip', '127.0.0.1', '--port', String(port), '--env-file', join(directory, 'local.env')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true' } })
let output = ''
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { output += chunk })
const post = (path, body, cookie) => fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const key = { 'x-rer-dev-key': vars.RER_DEV_KEY }
try {
  let ready = false
  for (let attempt = 0; attempt < 240 && !ready; attempt++) {
    if (worker.exitCode !== null) throw new Error('emitted Worker exited')
    try { ready = (await fetch(`${origin}/health`)).ok } catch { await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  assert.ok(ready, 'emitted Worker became healthy')
  assert.equal((await post('/auth/bootstrap', { token: vars.SETUP_TOKEN, displayName: 'Owner' })).status, 303, 'owner claimed')
  assert.equal((await post('/auth/magic-link', { email: owner })).status, 202, 'sign-in link mailed')
  assert.equal((await fetch(`${origin}/__dev/outbox`)).status, 404, 'the outbox needs the key gate')
  const listing = await (await fetch(`${origin}/__dev/outbox`, { headers: key })).text()
  const message = listing.match(/href="(\/__dev\/outbox\?message=[^"]+)"/)?.[1]
  assert.ok(message, 'the outbox lists the sign-in message')
  const detail = await (await fetch(origin + message.replaceAll('&amp;', '&'), { headers: key })).text()
  const link = new URL(detail.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), origin)
  assert.equal(link.origin, origin)
  assert.equal((await fetch(link)).status, 200, 'confirmation page')
  const confirmed = await post('/auth/confirm', { token: link.searchParams.get('token') })
  assert.equal(confirmed.status, 303)
  const cookie = confirmed.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  const session = await fetch(`${origin}/auth/session`, { headers: { cookie } })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).operator.email, owner)
  console.log('Email-link sign-in passed against the emitted Worker: claim, key-gated outbox, confirmation, session')
} catch (error) {
  // HTTP failure can arrive before Wrangler forwards its worker diagnostics.
  // Give stdout/stderr a short bounded drain before reporting the failure.
  await new Promise(resolve => setTimeout(resolve, 250))
  for (const value of Object.values(vars)) output = output.replaceAll(value, '[redacted]')
  const diagnostics = output.length > 4000 ? output.slice(0, 2000) + '\n[... diagnostics truncated ...]\n' + output.slice(-2000) : output
  console.error('Emitted Worker diagnostics (stdout/stderr):\n' + diagnostics)
  throw error
} finally {
  worker.kill('SIGTERM')
  await new Promise(resolve => worker.exitCode !== null ? resolve() : worker.once('exit', resolve))
  await rm(directory, { recursive: true, force: true })
}
