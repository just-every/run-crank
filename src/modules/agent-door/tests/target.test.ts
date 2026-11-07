import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { targetSurface } from './target.fixture.mjs'
import { runAgentDoorConformance } from '../conformance/index.mjs'
import { checkTarget } from '../conformance/target.mjs'
import { createProtocol } from '../conformance/protocol.mjs'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'
import { revisionProbeCases } from './revision-probes.fixture.mjs'

const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const input = (id: string, value = 'Campaign plan') => ({ id, value, idempotency_key: crypto.randomUUID() })

test('native target conformance binds audit and approval evidence; resource refusals retain machine codes', async t => {
 const r = await runtime({ nativeTargets: true })
 try {
  const surface = targetSurface()
  const result = await runAgentDoorConformance({ fetch: r.fetch, origin: r.c.origin, surface, signer: r.c.signer, person: r.c.person, now: () => r.c.now })
  const failed = result.points.filter((point: any) => !point.ok)
  for (const point of failed) t.diagnostic(`FAIL ${point.id}: ${point.detail}`)
  t.diagnostic(`Native target/resource fixture: ${result.points.length - failed.length}/${result.points.length} conformance points`)
  assert.deepEqual(failed, [])
  const policy = (await r.person('/agents/api/state')).body.policy
  r.c.seq = policy.seq; r.c.revision = policy.revision; r.c.business = policy.business

  // An incorrect native identity must remain a conformance failure.
  const c: any = createProtocol({ ...r.c, surface, fetch: r.fetch, points: [] })
  const answer = await c.tool('synthetic.records.write', input('native-target-negative'))
  await checkTarget(c, { id: 'wrong', tool: 'synthetic.records.write', target: { kind: 'record', id: 'wrong-native-id' } }, new Map(), answer, 'negative')
  assert.ok(c.points.some((point: any) => !point.ok && point.id.includes('.target.')))
  t.diagnostic('Negative native target expectation: FAIL as required; audit identity is seed-resolved and redacted.')

  const uri = 'synthetic://record/native-target-negative'
  await r.db.prepare("UPDATE test_records SET exposure='hidden' WHERE id=?").bind('native-target-negative').run()
  const hidden = await r.mcp('resources/read', { uri })
  const missing = await r.mcp('resources/read', { uri: 'synthetic://record/missing' })
  assert.equal(hidden.error.data.code, 'resource_unavailable')
  assert.deepEqual(hidden.error, missing.error)
  assert.equal((await r.mcp('resources/read', { uri: 'unknown://record' })).error.data.code, 'tool_not_found')
  assert.equal((await r.mcp('resources/read', { uri }, { token: await r.token({ scope: 'events:read' }) })).error.data.code, 'insufficient_scope')
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'block', class: '*', do: 'blocked' }] })
  await r.db.prepare("UPDATE test_records SET exposure='internal' WHERE id=?").bind('native-target-negative').run()
  const blocked = await r.mcp('resources/read', { uri })
  assert.equal(blocked.error.data.code, 'policy_blocked')
  assert.equal(blocked.result, undefined)
  t.diagnostic('Resource negatives: missing/hidden resource_unavailable, unknown tool_not_found, scope insufficient_scope, policy policy_blocked; all withhold content.')
 } finally { await r.close() }

 const invalid = await runtime({ nativeTargets: 'invalid' })
 try {
  await invalid.adopt()
  assert.equal(code(await invalid.tool('records.write', input('invalid-target'))), 'target_invalid')
  assert.deepEqual((await invalid.tool('records.list', {})).result.structuredContent.records, [])
 } finally { await invalid.close() }

 const changed = await runtime({ nativeTargets: 'mutable' })
 try {
  await changed.adopt()
  await changed.tool('records.write', input('alias', 'native-first'))
  await changed.adopt(heldPolicy())
  const pending = await changed.tool('records.erase', { id: 'alias', idempotency_key: crypto.randomUUID() })
  const id = pending.result._meta['com.runeditrun/approval'].id
  const view = (await changed.person(`/agents/api/approvals/${id}`)).body.approval
  assert.deepEqual(view.summary.nativeTarget, { kind: 'record', id: 'native-first' })
  await changed.tool('records.write', input('alias', 'native-second'))
  const approved = await changed.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  assert.equal(approved.body.approval.code, 'approval_evidence_changed')
  assert.equal((await changed.tool('records.list', {})).result.structuredContent.records[0].value, 'native-second')
  t.diagnostic('Target negatives: malformed resolver refused target_invalid; changed native target refused approval_evidence_changed with no erase.')
 } finally { await changed.close() }
})

test('pause and unset conformance retain resolvable native target and computed classes without effects', async t => {
 const r = await runtime({ nativeTargets: true })
 try {
  const points: any[] = []
  for (const mode of ['unset', 'paused']) {
   if (mode === 'paused') await r.adopt(autonomousPolicy(), { paused: true })
   const args = input(`native-${mode}`), answer = await r.tool('records.write', args)
   const row = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.idempotency_key === args.idempotency_key)
   points.push({ id: `BASE-AGENT-009.${mode}.target`, ok: row?.resource?.kind === 'record' && row.resource.id === `redacted:native-${mode}` })
   points.push({ id: `BASE-AGENT-009.${mode}.classification`, ok: row?.classes?.[0]?.class === 'standard' && row.classes[0].facts.measure === 1 && row.rules[0]?.do === mode })
   assert.equal(code(answer), mode === 'unset' ? 'policy_unset' : 'agents_paused')
  }
  for (const point of points) t.diagnostic(`${point.ok ? 'PASS' : 'FAIL'} ${point.id}`)
  assert.ok(points.every(point => point.ok))
  await r.adopt()
  assert.deepEqual((await r.tool('records.list', {})).result.structuredContent.records, [])
  // A native classifier refusal is explicit audit evidence, never invented facts.
  await r.adopt(autonomousPolicy(), { paused: true })
  const refused = await r.tool('access.change', { id: r.c.person.email, idempotency_key: crypto.randomUUID() })
  assert.equal(code(refused), 'agents_paused')
  const last = (await r.person('/agents/api/audit')).body.rows.at(-1)
  assert.equal(last.classification_refusal, 'classifier_refused')
  assert.deepEqual(last.classes, [])
  t.diagnostic('Native classifier denial remains explicit; paused calls still refuse and perform no effect.')
  await revisionProbeCases(r, t)
 } finally { await r.close() }
})
