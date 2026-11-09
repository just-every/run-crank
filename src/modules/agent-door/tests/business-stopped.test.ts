import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

const modes = ['missing', 'true', 'false', 'nonfunction', 'undefined', 'nonboolean', 'throwing', 'rejecting']
const heldPolicy = (ref: string) => ({ ...autonomousPolicy(), rules: [{ id: 'hold', class: '*', do: 'approval', approver: [ref], wait: 'PT1H' }] })
const write = (id: string) => ({ id, value: 'private native value', idempotency_key: crypto.randomUUID() })
async function fixture(t: any) {
 const r = await runtime()
 t.after(() => r.close())
 assert.equal((await r.adopt()).status, 200)
 return r
}
async function stop(r: any, mode: string) {
 // Capture an otherwise valid subject mapping, as a custom adapter can retain it after detachment.
 await r.setBusinessStopped('false')
 if (mode !== 'false') assert.equal((await r.settings({ detached: true, values: {}, logo: null, team: null })).status, 200)
 await r.setBusinessStopped(mode)
}
async function approve(r: any, id: string) {
 const view = await r.person(`/agents/api/approvals/${id}`)
 assert.equal(view.status, 200)
 return r.person(`/agents/api/approvals/${id}/approve`, { revision: view.body.approval.revision, summary_sha256: view.body.approval.summary_sha256 })
}
async function value(r: any, id: string) {
 return (await r.db.prepare('SELECT value FROM test_records WHERE id=?').bind(id).first())?.value ?? null
}

for (const mode of modes) test(`Business token admission: ${mode} stop reader`, async t => {
 const r = await fixture(t)
 assert.equal((await r.tool('records.write', write('before'))).result.isError, false)
 assert.equal(await value(r, 'before'), 'private native value')
 await stop(r, mode)
 const answer = await r.tool('records.write', write('after'))
 assert.equal(answer.status, mode === 'false' ? 200 : 401)
 if (mode === 'false') assert.equal(answer.result.isError, false)
 else assert.match(answer.headers.get('www-authenticate'), /resource_metadata=/)
 assert.equal(await value(r, 'after'), mode === 'false' ? 'private native value' : null)
})

for (const mode of modes) test(`Business person and role refs: ${mode} stop reader`, async t => {
 const r = await fixture(t)
 await stop(r, mode)
 // Native credentials still act: authorization of these refs must fail independently of token admission.
 for (const ref of [`person:${r.c.person.sub}`, 'role:owner']) {
  assert.equal((await r.adopt(heldPolicy(ref))).status, 200)
  const answer = await r.tool('records.write', write(ref), { token: r.localToken })
  const id = answer.result._meta['com.runeditrun/approval'].id
  const decided = await approve(r, id)
  assert.equal(decided.status, mode === 'false' ? 200 : 403, ref)
  if (mode === 'false') assert.equal(decided.body.approval.state, 'executed')
  assert.equal(await value(r, ref), mode === 'false' ? 'private native value' : null, ref)
 }
})

for (const mode of modes) test(`Held Business execution: ${mode} stop reader`, async t => {
 const r = await fixture(t)
 assert.equal((await r.adopt(heldPolicy('sponsor'))).status, 200)
 const answer = await r.tool('records.write', write('held'))
 const id = answer.result._meta['com.runeditrun/approval'].id
 await stop(r, mode)
 const decided = await approve(r, id)
 assert.equal(decided.status, 200)
 assert.equal(decided.body.approval.state, mode === 'false' ? 'executed' : 'refused')
 assert.equal(decided.body.approval.code, mode === 'false' ? null : 'sponsor_unavailable')
 assert.equal(await value(r, 'held'), mode === 'false' ? 'private native value' : null)
})
