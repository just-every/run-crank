import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const meta = (answer: any) => answer.result._meta['com.runeditrun/decision']
const args = (id: string) => ({ id, value: 'Native work', idempotency_key: crypto.randomUUID() })
const allow = { decision: 'allow', rule: 'native-rule', revision: '1' }
const hold = { decision: 'hold', rule: 'native-rule', revision: '1', approvers: ['sponsor'], wait: 'PT2H' }
const deny = { decision: 'deny', rule: 'native-rule', revision: '1' }
async function answer(r: any, tool: string, value: unknown) {
 await r.db.prepare('INSERT INTO test_company_policy VALUES(?,?) ON CONFLICT(tool) DO UPDATE SET answer=excluded.answer')
  .bind(tool, value === 'throw' ? value : JSON.stringify(value)).run()
}
async function native(r: any) {
 return (await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results
}
async function approve(r: any, pending: any) {
 const id = pending.result._meta['com.runeditrun/approval'].id
 const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
 return { view, response: await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 }) }
}

test('declared native policy allows, holds and denies through the public door with the existing approval and audit', async t => {
 const r = await runtime({ companyPolicy: true, nativeTargets: true })
 try {
  await r.adopt()
  await answer(r, 'synthetic.records.write', allow)
  const first = await r.tool('records.write', args('native-allow'))
  assert.equal(first.result.isError, false)
  assert.deepEqual(meta(first).company_policy, allow)
  assert.equal(meta(first).disposition, 'autonomous')

  await answer(r, 'synthetic.records.write', hold)
  const input = args('native-hold'), before = await native(r)
  const pending = await r.tool('records.write', { ...input, confirmExternal: true, companyPolicy: 'allow' })
  assert.equal(pending.result.resultType, 'input_required')
  assert.equal(meta(pending).disposition, 'approval')
  assert.deepEqual(await native(r), before)
  assert.deepEqual(meta(pending).company_policy, hold)
  const { view, response } = await approve(r, pending)
  assert.deepEqual(view.summary.company_policy, hold)
  assert.deepEqual(view.summary.nativeTarget, { kind: 'record', id: 'redacted:native-hold' })
  assert.equal(response.body.approval.state, 'executed')
  const replay = await r.tool('records.write', input)
  assert.equal(replay.result.structuredContent.id, 'native-hold')
  assert.ok(replay.result._meta['com.runeditrun/receipt'])
  assert.equal((await native(r)).find((row: any) => row.id === 'native-hold').version, 1)

  await answer(r, 'synthetic.records.send', deny)
  assert.equal(code(await r.tool('records.send', { id: 'native-allow', idempotency_key: crypto.randomUUID() })), 'company_policy_denied')
  const embedded = await r.person('/__embedded', { name: 'synthetic.records.send', scopes: ['records:write'], args: { id: 'native-allow', idempotency_key: crypto.randomUUID() } })
  assert.equal(embedded.body.code, 'company_policy_denied')
  assert.deepEqual(embedded.body.decision.company_policy, deny)
  assert.equal((await r.db.prepare('SELECT count(*) AS n FROM test_sent').first()).n, 0)
  await answer(r, 'resources/read', deny)
  assert.equal(code(await r.mcp('resources/read', { uri: 'synthetic://record/native-allow' })), 'company_policy_denied')

  const audit = (await r.person('/agents/api/audit')).body
  assert.equal(audit.differs_from_policy, 0)
  for (const decision of ['allow', 'hold', 'deny']) assert.ok(audit.rows.some((row: any) => row.company_policy?.decision === decision))
  const held = audit.rows.find((row: any) => row.id === meta(pending).id)
  const execution = audit.rows.find((row: any) => row.decision_id === held.id)
  assert.equal(held.outcome, 'pending')
  assert.equal(execution.outcome, 'done')
  assert.deepEqual(execution.company_policy, hold)
  assert.ok(audit.rows.filter((row: any) => row.code === 'company_policy_denied').every((row: any) => row.outcome === 'refused' && row.decision === 'blocked' && row.classes.length))
  t.diagnostic('Public MCP allow/done, hold/pending then exact person approval/done, deny/refused; embedded and resource denials; audit differs_from_policy=0.')
 } finally { await r.close() }
})

test('native policy cannot widen class policy or replay authority and changed or invalid answers leave no effect', async t => {
 const r = await runtime({ companyPolicy: true })
 try {
  await answer(r, 'synthetic.records.write', 'throw')
  assert.equal(code(await r.tool('records.write', args('unset'))), 'policy_unset')
  await r.adopt(autonomousPolicy(), { paused: true })
  assert.equal(code(await r.tool('records.write', args('paused'))), 'agents_paused')
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'blocked', class: '*', do: 'blocked' }] })
  assert.equal(code(await r.tool('records.write', args('blocked'))), 'policy_blocked')
  await r.adopt()
  assert.equal(code(await r.tool('records.write', args('scope'), { token: await r.token({ scope: 'records:read' }) })), 'insufficient_scope')
  assert.equal(code(await r.tool('access.change', { id: r.c.person.email, idempotency_key: crypto.randomUUID() })), 'self_escalation')
  assert.deepEqual(await native(r), [])

  for (const value of [null, {}, { ...allow, decision: 'unknown' }, { ...allow, revision: '' }, { ...allow, extra: true }, { ...hold, approvers: [] }, { ...hold, approvers: ['agent:anyone'] }, { ...hold, wait: 'PT1S' }]) {
   await answer(r, 'synthetic.records.write', value)
   assert.equal(code(await r.tool('records.write', args('invalid'))), 'company_policy_invalid')
  }
  await answer(r, 'synthetic.records.write', 'throw')
  const unavailable = await r.tool('records.write', args('unavailable'))
  assert.equal(code(unavailable), 'company_policy_unavailable')
  assert.doesNotMatch(JSON.stringify(unavailable), /private native diagnostic/)
  assert.deepEqual(await native(r), [])

  await answer(r, 'synthetic.records.write', allow)
  const original = args('replay')
  assert.equal((await r.tool('records.write', original)).result.isError, false)
  await answer(r, 'synthetic.records.write', hold)
  assert.equal(code(await r.tool('records.write', original)), 'approval_required')
  await answer(r, 'synthetic.records.write', deny)
  assert.equal(code(await r.tool('records.write', original)), 'company_policy_denied')
  assert.equal((await native(r))[0].version, 1)

  await answer(r, 'synthetic.records.write', hold)
  const changed = await r.tool('records.write', args('changed'))
  await answer(r, 'synthetic.records.write', { ...hold, revision: '2' })
  assert.equal((await approve(r, changed)).response.body.approval.code, 'approval_evidence_changed')
  const denied = await r.tool('records.write', args('denied'))
  await answer(r, 'synthetic.records.write', deny)
  assert.equal((await approve(r, denied)).response.body.approval.code, 'approval_evidence_changed')
  await answer(r, 'synthetic.records.write', hold)
  const unavailableApproval = await r.tool('records.write', args('unavailable-approval'))
  await answer(r, 'synthetic.records.write', 'throw')
  assert.equal((await approve(r, unavailableApproval)).response.body.approval.code, 'company_policy_unavailable')
  await answer(r, 'synthetic.records.write', hold)
  const invalidApproval = await r.tool('records.write', args('invalid-approval'))
  await answer(r, 'synthetic.records.write', {})
  assert.equal((await approve(r, invalidApproval)).response.body.approval.code, 'company_policy_invalid')
  await answer(r, 'synthetic.records.write', deny)
  const failed = await r.tool('records.write', args('denied-again'))
  assert.equal(code(failed), 'company_policy_denied')
  assert.equal((await native(r)).length, 1)

  await answer(r, 'synthetic.records.write', allow)
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'review', class: '*', do: 'review' }] })
  const reviewed = await r.tool('records.write', args('review'))
  assert.ok(reviewed.result._meta['com.runeditrun/review'])
  await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'approval', class: '*', do: 'approval', approver: ['role:owner'], wait: 'PT1H' }] })
  const classHeld = await r.tool('records.write', args('class-held'))
  assert.equal(classHeld.result.resultType, 'input_required')
  await answer(r, 'synthetic.records.write', hold)
  const both = await r.tool('records.write', args('both'))
  const { view, response } = await approve(r, both)
  assert.deepEqual(view.approvers, ['role:owner', 'sponsor'])
  assert.equal(Date.parse(view.expires_at) - r.c.now, 3600000)
  assert.equal(response.body.approval.state, 'executed')
  const audit = (await r.person('/agents/api/audit')).body
  assert.equal(audit.differs_from_policy, 0)
  assert.ok(audit.rows.some((row: any) => row.code === 'company_policy_invalid'))
  assert.ok(audit.rows.some((row: any) => row.code === 'company_policy_unavailable'))
  t.diagnostic('Unset/Pause/scope/self-escalation/blocked remain closed; malformed and thrown hooks refuse; retries and changed approvals cannot execute; existing review and approval stay required.')
 } finally { await r.close() }
})
