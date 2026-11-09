import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { runtime } from './runtime.mjs'
import { runAgentDoorConformance } from '../conformance/index.mjs'
import { autonomousPolicy, heldPolicy, policyEnvelope } from '../conformance/crypto.mjs'

const surface = {
 schema: 'rer-agent-surface/1', seed: 'synthetic', specialist: 'operations',
 escalations: [{ id: 'self', tool: 'synthetic.access.change', args: { id: { $sponsor: 'id' } } }],
 tools: [
  { name: 'synthetic.records.list', scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-002'] },
  { name: 'synthetic.records.write', scope: 'records:write', readOnly: false, classes: ['standard'], clauses: ['BASE-AGENT-002'] },
  { name: 'synthetic.records.erase', scope: 'records:write', readOnly: false, classes: ['destructive'], clauses: ['BASE-AGENT-006'] },
  { name: 'synthetic.records.send', scope: 'records:write', readOnly: false, classes: ['external', 'sensitive'], clauses: ['BASE-AGENT-006'] },
  { name: 'synthetic.access.change', scope: 'records:write', readOnly: false, classes: ['access'], clauses: ['BASE-AGENT-006'] },
  { name: 'synthetic.events.list', scope: 'events:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-010'] },
 ], notTools: [], resources: ['synthetic://record/{id}'], witness: { tool: 'synthetic.records.list', args: {} },
 journey: [
  ...Array.from({ length: 5 }, (_, i) => ({ id: `list-${i}`, tool: 'synthetic.records.list', args: {}, expect: [{ class: 'standard' }] })),
  { id: 'write', tool: 'synthetic.records.write', args: { id: 'synthetic-base-1', value: 'synthetic-base-1' }, expect: [{ class: 'standard' }], inject: { confirmExternal: true }, resource: { uriTemplate: 'synthetic://record/{id}', state: { id: 'synthetic-base-1', value: 'synthetic-base-1' } } },
  { id: 'send', tool: 'synthetic.records.send', args: { id: 'synthetic-base-1' }, expect: [{ class: 'external' }, { class: 'sensitive' }] },
  { id: 'access', tool: 'synthetic.access.change', args: { id: 'synthetic-base-other' }, expect: [{ class: 'access' }] },
  { id: 'erase', tool: 'synthetic.records.erase', args: { id: 'synthetic-base-1' }, expect: [{ class: 'destructive' }] },
  { id: 'events', tool: 'synthetic.events.list', args: {}, expect: [{ class: 'standard' }] },
 ],
}

test('a long held conformance phase renews policy without changing approval evidence', async () => {
 const r = await runtime({ resourceScope: 'resources:read' })
 const log: any[] = [], completed: string[] = []
 let held = false, interval = 0, heldStart = 0
 try {
  const result = await runAgentDoorConformance({
   fetch: async (url: string, init: any = {}) => {
    const path = new URL(url).pathname
    if (path === '/api/rer/agent-policy') {
     const payload = JSON.parse(Buffer.from(JSON.parse(init.body).policy.split('.')[1], 'base64url').toString())
     log.push({ path, payload })
     interval = (payload.exp - payload.iat) * 1000 / 6
    } else log.push({ path, held, at: r.c.now })
    const response = await r.fetch(url, init)
    if (path === '/api/rer/agent-policy') log.at(-1).accepted = response.ok
    if (held && path === '/mcp') {
     const body = await response.clone().json()
     log.at(-1).pending = body.result?._meta?.['com.runeditrun/approval']?.id
    }
    if (held && path === '/mcp' && (await response.clone().json()).result?.resultType === 'input_required') await r.setNow(r.c.now + interval)
    return response
   }, origin: r.c.origin, surface, signer: r.c.signer, person: r.c.person, now: () => r.c.now,
   nativeStep: async ({ stage, phase, step }: any) => {
    if (phase === 'held' && !heldStart) heldStart = r.c.now
    held = phase === 'held'
    if (held && stage === 'beforeStep') await r.setNow(r.c.now + interval)
    if (held && stage === 'afterStep') completed.push(step.id)
   },
  })
  const failures = result.points.filter((point: any) => !point.ok)
  for (const failure of failures) console.log(`FAIL ${failure.id}: ${failure.detail}`)
  assert.deepEqual(failures, [])
  assert.deepEqual(completed, surface.journey.map(step => step.id))
  const adoptions = log.filter(entry => entry.payload && entry.accepted)
  const renewals = adoptions.filter((entry, i) => i && entry.payload.seq === adoptions[i - 1].payload.seq)
  assert.ok(renewals.length > 0)
  assert.ok(r.c.now - heldStart > interval * 6, 'The held phase must exceed an original envelope lifetime')
  for (const renewal of renewals) {
   const previous = adoptions[adoptions.indexOf(renewal) - 1].payload
   const { iat, exp, ...authority } = renewal.payload
   const { iat: oldIat, exp: oldExp, ...original } = previous
   assert.deepEqual(authority, original)
   assert.ok(iat > oldIat && iat < oldExp)
   assert.equal(exp - iat, oldExp - oldIat)
   console.log(`RENEW seq=${authority.seq} revision=${authority.revision} iat=${oldIat}->${iat} before-exp=${oldExp} next=${log[log.indexOf(renewal) + 1]?.path}`)
  }
  assert.equal(result.points.filter((point: any) => point.id.startsWith('BASE-AGENT-007.7.adopt.')).length, new Set(adoptions.map(entry => entry.payload.seq)).size)
  const pendingAcrossRenewal = log.find(entry => entry.held && entry.pending && renewals.some(renewal =>
   log.indexOf(renewal) > log.indexOf(entry) && log.some(decision =>
    decision.path === `/agents/api/approvals/${entry.pending}/approve` && log.indexOf(decision) > log.indexOf(renewal))))
  assert.ok(pendingAcrossRenewal, 'A held approval must execute after its pending evidence crosses a renewal')
  console.log(`HELD-RENEWAL approval=${pendingAcrossRenewal.pending} outcome=executed elapsed-ms=${r.c.now - heldStart}`)
  for (const id of ['send', 'access', 'erase']) assert.ok(result.points.some((point: any) => point.id === `BASE-AGENT-007.5.receipt.${id}` && point.ok))
  const conformance = (await r.person('/agents/api/agents')).body.agents.filter((agent: any) => agent.id.startsWith('rer-conformance-'))
  const identities = conformance.filter((agent: any) => !agent.revoked)
  assert.equal(identities.length, 1)
  assert.ok(conformance.some((agent: any) => agent.revoked), 'The revocation phase leaves its revoked throwaway agent listed')
  assert.ok((await r.person('/agents/api/audit')).body.rows.some((row: any) => row.consent && row.agent.id === identities[0].id))
 } finally { await r.close() }
})

test('equal-sequence adoption only renews immutable authority and preserves pending approvals', async () => {
 const r = await runtime()
 const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
 try {
  await r.adopt()
  await r.tool('records.write', { id: 'synthetic-base-1', value: 'original', idempotency_key: randomUUID() })
  const adopted = await r.adopt(heldPolicy(), { revoked: { agents: [], consents: [] } })
  const args = { id: 'synthetic-base-1', idempotency_key: randomUUID() }, pending = await r.tool('records.send', args)
  const handle = pending.result._meta['com.runeditrun/approval']
  const approval = (await r.person(`/agents/api/approvals/${handle.id}`)).body.approval
  await r.setNow(r.c.now + 1000)
  const iat = Math.floor(r.c.now / 1000), life = adopted.payload.exp - adopted.payload.iat
  const renewal = { ...adopted.payload, iat, exp: iat + life }
  const post = async (payload: any) => r.post('/api/rer/agent-policy', { policy: await r.sign('rer-agent-policy+jwt', payload) })
  // JSON object member order does not change authority.
  assert.equal((await post(Object.fromEntries(Object.entries(renewal).reverse()))).status, 200)
  const state = (await r.person('/agents/api/state')).body
  const approvals = (await r.person('/agents/api/approvals')).body
  const stored = await r.db.prepare('SELECT envelope FROM agent_door_state WHERE id=1').first()
  const records = (await r.tool('records.list', {})).result.structuredContent
  const changed = { ...autonomousPolicy(), rules: [{ id: 'all', class: '*', do: 'blocked' }] }
  const document = await policyEnvelope(r.c, changed, { seq: renewal.seq, revision: renewal.revision })
  const cases: [string, any, string, number][] = [
   ['expired', { ...renewal, exp: iat - 1 }, 'policy_invalid', 400],
   ['mismatched revision', { ...renewal, document: changed }, 'policy_revision_invalid', 400],
   ['equal issue time', renewal, 'policy_stale', 409],
   ['earlier issue time', { ...renewal, iat: iat - 1 }, 'policy_stale', 409],
   ['paused authority', { ...renewal, iat: iat + 1, paused: true }, 'policy_stale', 409],
   ['revoked authority', { ...renewal, iat: iat + 1, revoked: { agents: [r.c.agentId], consents: [] } }, 'policy_stale', 409],
   ['changed document', { ...document.payload, iat: iat + 1 }, 'policy_stale', 409],
   ['removed document', { ...renewal, iat: iat + 1, revision: null, document: null, revision_signature: null }, 'policy_stale', 409],
  ]
  for (const [name, payload, expected, status] of cases) {
   const response = await post(payload)
   assert.equal(response.status, status, name)
   assert.equal((await response.json()).code, expected, name)
   assert.deepEqual((await r.person('/agents/api/state')).body, state, name)
   assert.deepEqual((await r.person('/agents/api/approvals')).body, approvals, name)
   assert.deepEqual(await r.db.prepare('SELECT envelope FROM agent_door_state WHERE id=1').first(), stored, name)
   assert.deepEqual((await r.tool('records.list', {})).result.structuredContent, records, name)
  }
  const decision = await r.person(`/agents/api/approvals/${handle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 })
  assert.equal(decision.status, 200)
  assert.equal(decision.body.approval.state, 'executed')
  const receipt = await r.tool('records.send', args)
  assert.equal(code(receipt), undefined)
  assert.equal(receipt.result._meta['com.runeditrun/decision'].revision, adopted.payload.revision)
  assert.equal(receipt.result._meta['com.runeditrun/receipt'].decision_id, pending.result._meta['com.runeditrun/decision'].id)
  const replacement = await r.adopt(changed)
  assert.equal(replacement.status, 200)
  assert.equal(code(await r.tool('records.list', {})), 'policy_blocked')
 } finally { await r.close() }
})

test('an adopted policy that lapses without renewal refuses and audits a native write', async () => {
 const r = await runtime()
 try {
  const adopted = await r.adopt()
  const before = (await r.db.prepare('SELECT * FROM test_records').all()).results
  await r.setNow((adopted.payload.exp + 1) * 1000)
  const key = randomUUID()
  const refused = await r.tool('records.write', { id: 'synthetic-base-lapsed', value: 'unchanged', idempotency_key: key })
  assert.equal(refused.result._meta['com.runeditrun/error'].code, 'policy_unavailable')
  assert.deepEqual((await r.db.prepare('SELECT * FROM test_records').all()).results, before)
  const rows = (await r.person('/agents/api/audit')).body.rows.filter((row: any) => row.idempotency_key === key)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'refused')
  assert.equal(rows[0].code, 'policy_unavailable')
 } finally { await r.close() }
})
