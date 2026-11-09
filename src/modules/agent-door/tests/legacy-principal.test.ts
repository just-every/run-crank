import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

// A seed upgraded from before rer 0.2.96 holds approvals whose principal has no `source`. They are built here by
// the frozen rer-v0.2.95 credentials module (git blob 06da58d13fbba51acd11080062352534e33aeb89), never by editing
// a saved row, then the Worker is swapped for the current door over the same database.
const frozen = await readFile(new URL('./fixtures/credentials-0.2.95.ts', import.meta.url), 'utf8')
assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(frozen)}\0`).update(frozen).digest('hex'), '06da58d13fbba51acd11080062352534e33aeb89')

const held = { ...autonomousPolicy(), rules: [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] }
const write = (id: string) => ({ id, value: 'private native value', idempotency_key: crypto.randomUUID() })
const detach = (r: any) => r.settings({ detached: true, values: {}, logo: null, team: null })
async function fixture(t: any, options: Record<string, unknown> = {}) {
 const r = await runtime(options)
 t.after(() => r.close())
 assert.equal((await r.adopt(held)).status, 200)
 return r
}
async function hold(r: any, options?: Record<string, unknown>) {
 const id = crypto.randomUUID()
 const answer = await r.tool('records.write', write(id), options)
 return { id, approval: answer.result._meta['com.runeditrun/approval'].id as string }
}
async function principal(r: any, approval: string) {
 const row = await r.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(approval).first()
 return JSON.parse(row.saved).principal
}
async function approve(r: any, id: string) {
 const view = await r.person(`/agents/api/approvals/${id}`)
 assert.equal(view.status, 200)
 return r.person(`/agents/api/approvals/${id}/approve`, { revision: view.body.approval.revision, summary_sha256: view.body.approval.summary_sha256 })
}
const value = async (r: any, id: string) => (await r.db.prepare('SELECT value FROM test_records WHERE id=?').bind(id).first())?.value ?? null

test('a Business approval saved before rer 0.2.96 is refused after its Business stops', async t => {
 const r = await fixture(t, { legacyCredentials: true })
 const { id, approval } = await hold(r)
 const saved = await principal(r, approval)
 assert.equal(saved.source, undefined, 'the frozen door saves no source')
 assert.equal(typeof saved.consent, 'string')
 await r.upgrade()
 assert.equal((await detach(r)).status, 200)
 const decided = await approve(r, approval)
 assert.equal(decided.status, 200)
 assert.equal(decided.body.approval.state, 'refused')
 assert.equal(decided.body.approval.code, 'sponsor_unavailable')
 assert.equal(await value(r, id), null)
})

for (const mode of ['true', 'throwing', 'rejecting', 'nonboolean']) test(`a legacy Business approval is refused when the stop state reads ${mode}`, async t => {
 const r = await fixture(t, { legacyCredentials: true })
 const { id, approval } = await hold(r)
 await r.upgrade()
 await r.setBusinessStopped(mode)
 const decided = await approve(r, approval)
 assert.equal(decided.body.approval.state, 'refused')
 assert.equal(decided.body.approval.code, 'sponsor_unavailable')
 assert.equal(await value(r, id), null)
})

test('a legacy Business approval still executes while its Business runs', async t => {
 const r = await fixture(t, { legacyCredentials: true })
 const { id, approval } = await hold(r)
 await r.upgrade()
 const decided = await approve(r, approval)
 assert.equal(decided.body.approval.state, 'executed')
 assert.equal(await value(r, id), 'private native value')
})

test('a legacy local approval executes after the Business stops', async t => {
 const r = await fixture(t, { legacyCredentials: true })
 const { id, approval } = await hold(r, { token: r.localToken })
 const saved = await principal(r, approval)
 assert.equal(saved.source, undefined)
 assert.equal(saved.consent, undefined)
 await r.upgrade()
 assert.equal((await detach(r)).status, 200)
 const decided = await approve(r, approval)
 assert.equal(decided.body.approval.state, 'executed')
 assert.equal(await value(r, id), 'private native value')
})

test('tagged approvals behave as before: Business refused after a stop, local and embedded kept', async t => {
 const r = await fixture(t)
 const business = await hold(r), local = await hold(r, { token: r.localToken })
 const embedded = crypto.randomUUID()
 const answer = await r.person('/__embedded', { args: write(embedded), consent: crypto.randomUUID(), scopes: ['records:write'] })
 const embeddedApproval = answer.body.approval.id
 assert.equal((await principal(r, business.approval)).source, 'business')
 assert.equal((await principal(r, local.approval)).source, 'local')
 assert.equal((await principal(r, embeddedApproval)).source, undefined)
 assert.equal((await detach(r)).status, 200)
 assert.equal((await approve(r, business.approval)).body.approval.state, 'refused')
 assert.equal((await approve(r, local.approval)).body.approval.state, 'executed')
 assert.equal((await approve(r, embeddedApproval)).body.approval.state, 'executed')
 assert.equal(await value(r, business.id), null)
 assert.equal(await value(r, local.id), 'private native value')
 assert.equal(await value(r, embedded), 'private native value')
})
