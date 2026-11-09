import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { accessToken } from '../conformance/crypto.mjs'
import { createProtocol } from '../conformance/protocol.mjs'
import { signSettings, testDocument, testTrust } from '../../business-settings/testing/index.mjs'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { build } = require('esbuild')
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const { unstable_splitSqlQuery: split } = require('wrangler')

export async function personErasureRuntime(t) {
  const output = await build({ entryPoints: [fileURLToPath(new URL('./person-erasure-worker.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*'] })
  const origin = 'http://127.0.0.1:19876', issuer = 'https://agent-erasure.example.test', kid = 'erasure'
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const ownerId = crypto.randomUUID(), installationId = crypto.randomUUID(), email = 'owner@example.test'
  const token = crypto.randomUUID(), secret = crypto.randomUUID()
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text,
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'person-erasure' }, r2Buckets: { FILES: 'person-erasure' },
    bindings: { AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: email, SETUP_TOKEN: token, SESSION_SECRET: secret,
      INSTALLATION_KEY: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), RER_BUSINESS_TRUST: JSON.stringify(testTrust()),
      RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ [kid]: await crypto.subtle.exportKey('jwk', keys.publicKey) }) },
  }))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB')
  const migrations = new URL('../../../default-seed/migrations/core/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await db.batch(split(await readFile(new URL(file, migrations), 'utf8')).map(sql => db.prepare(sql)))
  }
  const fetch = (url, init = {}) => mf.dispatchFetch('http://localhost', { method: 'POST', body: JSON.stringify({ url: new URL(url, origin).href,
    method: init.method ?? 'GET', headers: { host: new URL(origin).host, 'cf-connecting-ip': '192.0.2.1', ...Object.fromEntries(new Headers(init.headers)) }, ...(init.body ? { body: init.body } : {}) }), redirect: 'manual' })
  const post = (path, input, headers = {}) => fetch(path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) })
  const boot = await post('/auth/bootstrap', { token, displayName: 'Erasure Owner' })
  assert.equal(boot.status, 303, boot.status === 303 ? '' : await boot.text())
  const cookie = boot.headers.get('set-cookie').split(';')[0]
  await boot.body?.cancel()
  const settings = await post('/api/rer/business-settings', { settings: await signSettings(testDocument({ owner_id: ownerId, business: 'agent-erasure-business' })) })
  assert.equal(settings.status, 200, await settings.text())
  const c = createProtocol({ origin, fetch, surface: JSON.parse(await readFile(new URL('../../../default-seed/agent-surface.json', import.meta.url), 'utf8')),
    signer: { issuer, kid, installationId, privateKey: keys.privateKey }, person: { sub: ownerId, email, cookie },
    consent: crypto.randomUUID(), agentId: crypto.randomUUID(), business: 'agent-erasure-business', seq: 0, revision: 0, points: [] })
  const person = async (path, input) => {
    const response = input === undefined ? await fetch(path, { headers: { cookie } }) : await post(path, input, { cookie })
    return { status: response.status, body: await response.json() }
  }
  const replay = async (name, args) => {
    const response = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } } } },
      { authorization: `Bearer ${await accessToken(c)}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name })
    return response.json()
  }
  return { db, c, person, replay, fetch, cookie }
}
