import {queuedEntrypoint} from '@runeditrun/rer/queued-entry';
const queued=await queuedEntrypoint(import.meta.url,'verify:runtime');if(queued!==null)process.exit(queued);
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emittedRecovery } from './emitted-recovery.mjs'

const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
// The installed homepage reads the claim state from D1: run the emitted Worker
// on its own migrated store, never the checkout's local data.
const persist = await mkdtemp(join(tmpdir(), 'foundation-runtime-'))
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'foundation', '--local', '--persist-to', persist, '--config', 'dist/server/wrangler.json'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
const setupToken = crypto.randomUUID() + crypto.randomUUID()
const sessionSecret = crypto.randomUUID() + crypto.randomUUID()
const ownerAddress = ['synthetic-crank-1', 'example.test'].join('@')
const workerArgs = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--inspector-port', '0', '--local', '--persist-to', persist, '--ip', '127.0.0.1', '--config', 'dist/server/wrangler.json', '--port', String(port), '--var', `AUTH_ORIGIN:http://127.0.0.1:${port}`, '--var', 'AUTH_LOCAL:true', '--var', 'MAIL_PROVIDER:development', '--var', `OWNER_EMAIL:${ownerAddress}`, '--var', `SETUP_TOKEN:${setupToken}`, '--var', `SESSION_SECRET:${sessionSecret}`]
let output = '', worker
function startWorker(extra = []) {
  const child = spawn(process.execPath, [...workerArgs, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output += chunk.toString().replaceAll(setupToken, '<private>').replaceAll(sessionSecret, '<private>') })
  child.stderr.on('data', chunk => { output += chunk.toString().replaceAll(setupToken, '<private>').replaceAll(sessionSecret, '<private>') })
  return child
}
async function stopWorker() {
  worker.kill('SIGTERM')
  await new Promise(resolve => worker.exitCode !== null ? resolve() : worker.once('exit', resolve))
}
worker = startWorker()
const origin = `http://127.0.0.1:${port}`
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (worker.exitCode !== null) throw new Error(output)
    try { ready = (await fetch(`${origin}/health`)).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, output)
  const health = await (await fetch(`${origin}/health`)).json()
  assert.equal(health.status, 'ok')
  assert.equal(health.ok, true)
  assert.deepEqual(health.dependencies, { DB: 'available', executor_storage: 'available' })
  assert.deepEqual(Object.keys(health.deployment ?? {}).sort(), ['fingerprint', 'sourceSha', 'versionId'])
  const document = await fetch(origin)
  assert.equal(document.status, 200)
  const branding = JSON.parse(await readFile(new URL('../src/branding.json', import.meta.url)))
  assert.ok((await document.text()).includes(branding.name))
  for (const path of ['/missing', '/health/extra', '/api', '/api/missing']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path)
  }
  // Exercise the same installation-only binding the maintained container
  // launchers supply. This route regression is not container qualification.
  const send = async (path, input, cookie = '') => {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { origin, cookie, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const text = await response.text()
    let value; try { value = JSON.parse(text) } catch { value = text }
    return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const owner = await send('/auth/bootstrap', { token: setupToken, displayName: 'Synthetic Crank owner' })
  assert.equal(owner.status, 303, JSON.stringify(owner.value)); assert.ok(owner.cookie)
  const created = await send('/api/crank/workflows', { name: 'Synthetic receiving workflow', graph: { trigger: { type: 'email' }, steps: [] } }, owner.cookie)
  assert.equal(created.status, 201)
  const path = `/api/crank/workflows/${created.value.id}/email-aliases`
  const alias = await send(path, { domain: 'receiving.example.test' }, owner.cookie)
  assert.equal(alias.status, 201, 'Workers address creation remains supported')
  const before = (await send('/api/crank/settings/email', undefined, owner.cookie)).value
  assert.equal(before.receiving_requirement, null)
  await stopWorker()
  worker = startWorker(['--var', 'RER_IMAGE_DIGEST:synthetic-crank-1'])
  let restarted = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (worker.exitCode !== null) throw new Error(output)
    try { restarted = (await fetch(origin + '/health')).ok } catch {}
    if (restarted) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(restarted, output)
  for (const input of [{ domain: 'receiving.example.test' }, { domain: 'receiving.example.test', rotate: alias.value.id }]) {
    const refused = await send(path, input, owner.cookie)
    assert.equal(refused.status, 409)
    assert.match(JSON.stringify(refused.value), /TRIG-006 requires the Workers platform with Cloudflare Email Routing/)
  }
  const after = (await send('/api/crank/settings/email', undefined, owner.cookie)).value
  assert.deepEqual(after.aliases, before.aliases, 'refused creation and rotation leave existing aliases intact')
  assert.deepEqual(after.receipts, before.receipts)
  // Complete the real first-run form before inspecting the Settings page.
  const setup = await fetch(origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin, cookie: owner.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })
  assert.equal(setup.status, 303)
  const html = await (await fetch(origin + '/app/settings/email', { headers: { cookie: owner.cookie } })).text()
  assert.match(html, /TRIG-006 requires the Workers platform/)
  assert.ok(!html.includes('Create address'), 'container settings do not offer an undeliverable address')
  if (process.env.CRANK_EVIDENCE) {
    const { chromium, expect } = await import('@playwright/test')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(process.env.CRANK_EVIDENCE, { recursive: true })
    const browser = await chromium.launch({ headless: true, ...(process.env.CRANK_CHROMIUM ? { executablePath: process.env.CRANK_CHROMIUM } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
    try {
      const context = await browser.newContext()
      const [name, ...value] = owner.cookie.split('=')
      await context.addCookies([{ name, value: value.join('='), url: origin }])
      const page = await context.newPage()
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.goto(origin + '/app/settings/email')
        if (width === 1440) {
          await expect(page.getByRole('status')).toContainText('TRIG-006 requires the Workers platform')
          await expect(page.getByRole('button', { name: 'Create address' })).toHaveCount(0)
          assert.ok(await page.locator('.panel p, .panel button, .panel strong').evaluateAll(nodes => nodes.every(node => parseFloat(getComputedStyle(node).fontSize) >= 13)))
          for (const label of ['Search runs', 'Your account']) {
            const control = page.locator(`[aria-describedby="${label === 'Search runs' ? 'search-tooltip' : 'account-tooltip'}"]`)
            const tooltip = page.getByRole('tooltip', { name: label, exact: true })
            await page.mouse.move(0, 0); await control.blur(); await control.hover()
            await page.waitForTimeout(150); await expect(tooltip).toBeHidden(); await expect(tooltip).toBeVisible()
            await page.mouse.move(0, 0); await control.focus(); await expect(tooltip).toBeVisible({ timeout: 100 }); await control.blur()
          }
        }
        await page.screenshot({ path: join(process.env.CRANK_EVIDENCE, `${width}-container-email-requirement.png`), fullPage: true })
      }
      await context.close()
    } finally { await browser.close() }
  }
  assert.equal((await send(`/api/crank/settings/email/${alias.value.id}/revoke`, {}, owner.cookie)).status, 200)
  console.log('TRIG-006 runtime platform guard passed: Workers address creation, container creation and rotation refusal without mutation, Settings requirement and revocation')
  console.log('HTTP-001 passed against emitted local Worker: health, the installed homepage, HTTP and document 404s')
} finally {
  await stopWorker()
  await rm(persist, { recursive: true, force: true })
  // wrangler dev keeps its scratch (.wrangler/tmp) beside the config it runs, which here is the emitted Worker; the artifact producer refuses that folder in dist/server, so leave the build output as rer build wrote it.
  await rm('dist/server/.wrangler', { recursive: true, force: true })
}
await emittedRecovery()
