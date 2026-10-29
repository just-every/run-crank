import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

const errorCode = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
const result = (reply: any) => reply.result?.structuredContent
const job = () => ({ id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })
const drain = async (r: any, id: string, override?: object, args?: object) => (await r.post('/__queue', { id, override, args }, { cookie: r.c.person.cookie })).json()
const saved = async (r: any, table: string, id: string) => {
 const row = await r.db.prepare(`SELECT saved FROM ${table} WHERE id=?`).bind(id).first()
 return row ? JSON.parse(row.saved) : null
}

test('native queue retains admission identity through one effect and replay', async t => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt()
  const input = job(), reply = await r.tool('queue.prepare', input), handle = result(reply)
  assert.equal(errorCode(reply), undefined); assert.ok(handle?.operationId, 'queued handle must carry a door-issued operation id')
  const admission = await saved(r, 'test_jobs', input.id)
  assert.equal(admission.operationId, handle.operationId); assert.equal(admission.idempotencyKey, input.idempotency_key)
  assert.equal(admission.consent, r.c.consent); assert.deepEqual(admission.scopes, ['records:read', 'records:write', 'events:read'])
  assert.equal(admission.agent.id, r.c.agentId); assert.ok(admission.person.id); assert.deepEqual(admission.approvers, [])
  assert.deepEqual(result(await r.tool('queue.prepare', input)), handle)
  assert.equal((await drain(r, input.id, { scopes: [...admission.scopes].reverse() })).outcome, 'done')
  assert.deepEqual(await saved(r, 'test_effects', input.id), admission)
  assert.equal((await drain(r, input.id)).outcome, 'done')
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects').first()).n, 1)
  const rows = (await r.person('/agents/api/audit')).body.rows
  for (const row of rows) { assert.equal(row.operation_id, admission.operationId); assert.equal(row.idempotency_key, input.idempotency_key); assert.equal(row.consent, admission.consent) }
  assert.ok(rows.some((row: any) => row.tool === 'synthetic.queue.execute' && row.outcome === 'replayed'))
  const first = job(), second = crypto.randomUUID()
  assert.ok(result(await r.tool('queue.prepare', { ...first, additional: [second] }))?.operationId)
  const one = await drain(r, first.id), two = await drain(r, second)
  const effects = (await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects WHERE id IN (?,?)').bind(first.id, second).first()).n
  t.diagnostic(`G-op-fanout jobs=2 first=${one.outcome} second=${two.code ?? two.outcome} effects=${effects}; expected=2`)
  assert.equal(one.outcome, 'done'); assert.equal(two.outcome, 'done'); assert.equal(effects, 2)
  assert.equal((await drain(r, first.id)).result.id, first.id)
  assert.equal((await drain(r, second)).result.id, second)
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects WHERE id IN (?,?)').bind(first.id, second).first()).n, 2)
  assert.equal((await drain(r, first.id, undefined, { value: 'changed' })).code, 'idempotency_conflict')
  const fanoutRows = (await r.person('/agents/api/audit')).body.rows.filter((row: any) => row.tool === 'synthetic.queue.execute' && row.operation_id === (one.result as any).operationId)
  assert.deepEqual([...new Set(fanoutRows.map((row: any) => row.continuation_item_id))].sort(), [first.id, second].sort())
  for (const row of fanoutRows) { assert.equal(row.idempotency_key, first.idempotency_key); assert.equal(row.consent, admission.consent) }
  assert.equal(errorCode(await r.tool('queue.execute', { id: second, idempotency_key: first.idempotency_key })), 'operation_mismatch')
  for (const id of [' ', `${crypto.randomUUID()}\0`, crypto.randomUUID().repeat(6)]) {
   assert.ok(result(await r.tool('queue.prepare', { id, idempotency_key: crypto.randomUUID() }))?.operationId)
   assert.equal((await drain(r, id)).code, 'operation_mismatch')
  }
  // A caller cannot select another replay namespace or mutate an item's native origin.
  assert.equal((await drain(r, second, { continuationItemId: crypto.randomUUID() })).result.id, second)
  const secondAdmission = await saved(r, 'test_jobs', second)
  await r.db.prepare('UPDATE test_jobs SET saved=? WHERE id=?').bind(JSON.stringify({ ...secondAdmission, operationId: crypto.randomUUID() }), second).run()
  assert.equal((await drain(r, second)).code, 'operation_mismatch')
  await r.db.prepare('UPDATE test_jobs SET saved=? WHERE id=?').bind(JSON.stringify(secondAdmission), second).run()
  await r.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [r.c.consent] } })
  assert.equal((await drain(r, first.id)).code, 'consent_revoked')
  assert.equal((await drain(r, second)).code, 'consent_revoked')
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects WHERE id IN (?,?)').bind(first.id, second).first()).n, 2)

  t.diagnostic('a/b PASS: saved admission equals native effect identity; prepare replay and worker replay retain one effect.')
 } finally { await r.close() }
})

test('same native queue key replays one retained handle and one effect', async t => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt(); const input = job()
  const first = result(await r.tool('queue.prepare', input))
  const second = result(await r.tool('queue.prepare', input))
  assert.ok(first?.operationId); assert.deepEqual(second, first)
  assert.equal((await drain(r, input.id)).result.operationId, first.operationId)
  assert.equal((await drain(r, input.id)).result.operationId, first.operationId)
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_jobs').first()).n, 1)
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects').first()).n, 1)
  const changed = await r.tool('queue.prepare', { ...input, id: crypto.randomUUID() })
  assert.equal(errorCode(changed), 'idempotency_conflict')
  t.diagnostic('b PASS: one handle, one queue item, one effect; changed arguments with the same key remain idempotency_conflict.')
 } finally { await r.close() }
})

test('revoked native queue consent refuses execution without an effect', async t => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt(); const input = job()
  assert.ok(result(await r.tool('queue.prepare', input))?.operationId)
  await r.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [r.c.consent] } })
  const refused = await drain(r, input.id)
  assert.equal(refused.code, 'consent_revoked'); assert.equal(refused.outcome, 'refused')
  assert.equal(await saved(r, 'test_effects', input.id), null)
  const row = (await r.person('/agents/api/audit')).body.rows.at(-1)
  assert.equal(row.code, 'consent_revoked'); assert.equal(row.operation_id, (await saved(r, 'test_jobs', input.id)).operationId)
  t.diagnostic('c PASS: revoked execution remains consent_revoked; native effect absent.')
 } finally { await r.close() }
})

test('tools cannot mutate admission identity or widen scopes; forged queue identity stays refused', async t => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt()
  const token = await r.token({ scope: 'records:read' }), attacked = await r.tool('context.attack', {}, { token })
  assert.equal(result(attacked)?.blocked, 9); assert.deepEqual(result(attacked)?.scopes, ['records:read'])
  assert.equal(errorCode(await r.tool('queue.prepare', job(), { token })), 'insufficient_scope')
  const input = job(); assert.ok(result(await r.tool('queue.prepare', input))?.operationId)
  const admission = await saved(r, 'test_jobs', input.id)
  for (const override of [{ agent: { ...admission.agent, name: 'Changed' } }, { agent: { ...admission.agent, specialist: 'Changed' } }, { scopes: ['records:read', 'records:write', 'access:write'] }, { consent: crypto.randomUUID() }, { operationId: crypto.randomUUID() }, { person: { id: crypto.randomUUID() } }, { agent: { id: crypto.randomUUID(), name: 'Other' } }, { clientId: crypto.randomUUID() }]) {
   assert.equal((await drain(r, input.id, override)).outcome, 'refused')
  }
  assert.equal(await saved(r, 'test_effects', input.id), null)
  await r.db.prepare('INSERT INTO test_grants(agent,scopes) VALUES(?,?)').bind(r.c.agentId, JSON.stringify(['records:read'])).run()
  assert.equal((await drain(r, input.id)).code, 'insufficient_scope')
  assert.equal(await saved(r, 'test_effects', input.id), null)
  t.diagnostic('d PASS: nine runtime edits blocked; read-only token, forged identities and narrowed live grant produce no effect.')
 } finally { await r.close() }
})


test('approved native preparation preserves operation identity, key and named approver in the worker', async () => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'held', class: 'standard', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })
  const input = job(), sibling = crypto.randomUUID(), held = await r.tool('queue.prepare', { ...input, additional: [sibling] })
  const approval = held.result?._meta?.['com.runeditrun/approval'] ?? held.error?.data?.approval
  const view = (await r.person(`/agents/api/approvals/${approval.id}`)).body.approval
  const executed = await r.person(`/agents/api/approvals/${approval.id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  assert.equal(executed.body.approval.state, 'executed')
  const admission = await saved(r, 'test_jobs', input.id)
  assert.equal(admission.operationId, view.decision_id); assert.equal(admission.idempotencyKey, input.idempotency_key)
  assert.deepEqual(admission.approvers, [{ id: admission.person.id, name: 'Synthetic Person' }])
  await r.adopt()
  assert.equal((await drain(r, input.id)).outcome, 'done')
  assert.deepEqual(await saved(r, 'test_effects', input.id), admission)
  assert.equal((await drain(r, sibling)).outcome, 'done')
  assert.deepEqual(await saved(r, 'test_effects', sibling), admission)
  const delayed = job()
  assert.ok(result(await r.tool('queue.prepare', delayed))?.operationId)
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'held', class: 'standard', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })
  const waiting = await drain(r, delayed.id)
  assert.equal(waiting.outcome, 'pending')
  const path = `/agents/api/approvals/${waiting.approval.id}`
  const pending = (await r.person(path)).body.approval
  const identity = await saved(r, 'test_jobs', delayed.id)
  await r.db.prepare('UPDATE test_jobs SET saved=? WHERE id=?').bind(JSON.stringify({ ...identity, operationId: crypto.randomUUID() }), delayed.id).run()
  const refused = (await r.person(`${path}/approve`, { revision: pending.revision, summary_sha256: pending.summary_sha256 })).body.approval
  assert.equal(refused.state, 'refused'); assert.equal(refused.code, 'operation_mismatch')
  assert.equal(await saved(r, 'test_effects', delayed.id), null)
 } finally { await r.close() }
})
