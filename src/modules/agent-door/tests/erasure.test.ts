import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'
import { REPLAY_WINDOW_MS, agentErasureStatements, checkAgentArtifacts } from '../erasure.ts'
import { personAgentArtifacts } from '../../../default-seed/src/agent-door/erasure.ts'
import { createErasure, defineErasure } from '../../erasure/index.mjs'
import { createPortability } from '../../portability/index.mjs'

// Reserved domains keep the subject a strict prefix of the peer at a dot boundary.
const suffixSource = 'ed@suffix.test'
const suffixPeer = suffixSource + '.invalid'

const code = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
async function fixture(t: any) {
  const r = await runtime({ erasure: true }); t.after(() => r.close())
  const portability = await createPortability({ db: r.db, policy: { product: 'agent-erasure-test', buckets: {}, excludeTables: ['test_contexts', 'test_callbacks'] } })
  const declaration = defineErasure({ entity: 'record', root: { table: 'test_records' },
    async beforeStatements({ subject, operation }: any) {
      return agentErasureStatements({ db: r.db, secret: r.secret, map: personAgentArtifacts,
        subject: { values: JSON.stringify([subject.id]) }, tombstone: { erasure_id: operation.id, at: operation.at },
        checkpoint: async () => await portability.redactionStatements() })
    },
  })
  return { ...r, portability, erasure: createErasure({ db: r.db, portability, declarations: [declaration] }) }
}
async function archive(portability: any) {
  const id = await portability.exports.create()
  let state
  do { state = await portability.exports.advance(id) } while (state.phase !== 'complete')
  return new Response(await portability.exports.download(id)).text()
}
test('native erasure keeps sequence and value-free tombstones; old keys refuse in-window and become new requests after expiry; archives exclude replay custody', async t => {
  const r = await fixture(t), subject = 'personal-subject-' + crypto.randomUUID(), peer = 'other-subject-' + crypto.randomUUID()
  const key = subject + '@example.test', args = { id: subject, value: subject, idempotency_key: key }
  const policy = autonomousPolicy(); policy.rules = [{ id: 'review', class: '*', do: 'review' }]
  await r.adopt(policy)
  await r.tool('records.write', { id: peer, value: 'unrelated value', idempotency_key: crypto.randomUUID() })
  const written = await r.tool('records.write', args)
  assert.equal(written.result.structuredContent.version, 1)
  await r.db.prepare("UPDATE agent_door_usage SET classes=json_set(classes,'$[0].facts.kind',?) WHERE decision_id=?").bind(subject, written.result._meta['com.runeditrun/decision'].id).run()
  const accounting = async () => (await r.db.prepare("SELECT decision_id,at,seed,specialist,agent,json_extract(classes,'$[0].class') AS class,json_extract(classes,'$[0].facts.measure') AS measure FROM agent_door_usage ORDER BY decision_id").all()).results
  const usageBefore = await accounting()
  const tableRows = async (where: string) => Promise.all(personAgentArtifacts.artifacts.filter(item => item.match).map(async item => ({
    table: item.table, rows: (await r.db.prepare('SELECT * FROM "' + item.table + '" WHERE ' + where + ' ORDER BY rowid').all()).results,
  })))
  const peerRows = (await r.db.prepare('SELECT * FROM agent_door_calls WHERE instr(outcome,?)>0').bind(peer).all()).results
  const auditBefore = (await r.db.prepare('SELECT sequence,id FROM agent_door_audit ORDER BY sequence').all()).results
  const before = await archive(r.portability)
  const opened = await r.erasure.start('record', { id: subject })
  const blocked = await r.tool('records.write', { ...args, idempotency_key: crypto.randomUUID() })
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'subject_erasure_in_progress')
  assert.equal((await r.erasure.run(opened.id)).phase, 'complete')
  assert.deepEqual((await r.db.prepare('SELECT sequence,id FROM agent_door_audit ORDER BY sequence').all()).results, auditBefore)
  const dump = JSON.stringify(await tableRows('1'))
  assert.ok(!dump.includes(subject), 'every declared artifact column has lost the personal values and legacy key')
  assert.deepEqual(await accounting(), usageBefore, 'redaction clears personal facts without resetting usage measures or scope dimensions')
  assert.deepEqual((await r.db.prepare('SELECT * FROM agent_door_calls WHERE instr(outcome,?)>0').bind(peer).all()).results, peerRows)
  const completedAt = r.c.now
  const expiresAt = await r.db.prepare('SELECT expires_at FROM agent_door_calls WHERE key=?').bind('erased:' + (await r.db.prepare('SELECT call_id FROM agent_door_replay_aliases').first('call_id'))).first<number>('expires_at')
  assert.equal(expiresAt, completedAt + REPLAY_WINDOW_MS, 'erasure preserves the completion horizon')
  for (const age of [0, 86400001, REPLAY_WINDOW_MS - 1]) {
    await r.setNow(completedAt + age)
    await r.adopt(autonomousPolicy())
    const replay = await r.tool('records.write', args)
    assert.equal(code(replay), 'subject_erased')
    assert.equal(replay.result.structuredContent, undefined)
    assert.ok(!JSON.stringify(replay).includes(subject))
    assert.equal(await r.db.prepare("SELECT count(*) n FROM test_contexts WHERE kind='run' AND instr(audit,?)>0").bind(key).first('n'), 1, 'the original effect count remains one')
  }
  const aliases = (await r.db.prepare('SELECT alias FROM agent_door_replay_aliases').all()).results
  assert.equal(aliases.length, 1)
  const after = await archive(r.portability)
  assert.ok(!JSON.parse(after.split('\n')[0]).tables.some((table: any) => table.name === 'agent_door_replay_aliases'))
  assert.ok(!after.includes(key) && !after.includes(String(aliases[0].alias)))

  await r.setNow(expiresAt! + 1)
  const currentPolicy = autonomousPolicy(); currentPolicy.rules = [{ id: 'current', class: '*', do: 'blocked' }]
  await r.adopt(currentPolicy)
  const fresh = await r.tool('records.write', args)
  assert.equal(code(fresh), 'policy_blocked', 'expired key enters current authorization as a new request')
  assert.equal(await r.db.prepare('SELECT count(*) n FROM agent_door_replay_aliases').first('n'), 0, 'expiry deletes the alias')
  assert.equal(await r.db.prepare("SELECT count(*) n FROM agent_door_calls WHERE key LIKE 'erased:%'").first('n'), 0, 'expiry deletes its call in the same transaction')
  assert.equal(await r.db.prepare('SELECT count(*) n FROM test_records WHERE id=?').bind(subject).first('n'), 0, 'new request cannot recover the erased value')
  assert.equal(await r.db.prepare("SELECT count(*) n FROM test_contexts WHERE kind='run' AND instr(audit,?)>0").bind(key).first('n'), 1)

  const lines = before.trim().split('\n').map(line => JSON.parse(line))
  await assert.rejects(async () => {
    const stale = await r.portability.imports.create(lines[0])
    for (const part of lines.filter(line => line.kind === 'part')) await r.portability.imports.uploadPart(stale, part.index, part)
    await r.portability.imports.finalize(stale, { archiveHash: lines.at(-1).archiveHash })
  }, /erasure_epoch/)
  t.diagnostic('all mapped columns clear; audit sequence intact; in-window replay effect=1 at now, 24h+1ms, horizon-1ms; horizon+1ms=new request/current policy_blocked, call+alias deleted, no recovered value; concurrent capture=409; peer unchanged; alias/key absent from export; older archive refused')
})

test('pending approval loses its inputs and marks, cannot execute after native erasure', async t => {
  const r = await fixture(t), id = 'approval-subject-' + crypto.randomUUID()
  await r.db.prepare("INSERT INTO test_records VALUES(?,?,1,'internal')").bind(id, 'private').run()
  const policy = autonomousPolicy(); policy.rules = [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
  await r.adopt(policy)
  const pending = await r.tool('records.write', { id, value: id, idempotency_key: id })
  const approval = pending.result._meta['com.runeditrun/approval']
  const oldView = (await r.person('/agents/api/approvals/' + approval.id)).body.approval
  const opened = await r.erasure.start('record', { id }); await r.erasure.run(opened.id)
  const decided = await r.person('/agents/api/approvals/' + approval.id + '/approve', { revision: oldView.revision, summary_sha256: oldView.summary_sha256 })
  assert.equal(decided.status, 409); assert.equal(decided.body.code, 'subject_erased')
  const page = await r.fetch('/agents/approvals/' + approval.id, { headers: { Cookie: r.c.person.cookie } })
  assert.equal(page.status, 200)
  assert.ok(!(await page.text()).includes('data-approval-action="approve"'))
  assert.equal(await r.db.prepare("SELECT count(*) n FROM test_contexts WHERE kind='run'").first('n'), 0)
  assert.ok(!JSON.stringify((await r.db.prepare('SELECT * FROM agent_door_approvals').all()).results).includes(id))
})

test('People erase preserves Fred when Ed is a substring of his email, including claims, audit, replay and pending approval', async t => {
  const { personErasureRuntime } = await import('./person-erasure-runtime.mjs')
  const r = await personErasureRuntime(t)
  const ed = await r.person('/api/people', { name: 'Edward Customer', email: 'ed@acme.test', details: { sourceUserId: suffixSource } })
  const fred = await r.person('/api/people', { name: 'Frederick Customer', email: 'fred@acme.test', details: {} })
  const gail = await r.person('/api/people', { name: 'Gail Customer', email: 'gail@acme.test', details: {} })
  assert.equal(ed.status, 201); assert.equal(fred.status, 201); assert.equal(gail.status, 201)
  // Keep the same policy revision for completed replays and pending work.
  const held = autonomousPolicy(); held.rules = [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
  await r.c.adopt(held)
  const args = { id: fred.body.id, body: 'Contact fred@acme.test about the renewal', idempotency_key: crypto.randomUUID() }
  const completed = await r.c.tool('base.people.note', args)
  const peerId = completed.result._meta['com.runeditrun/approval'].id
  const peerView = await r.person('/agents/api/approvals/' + peerId)
  const peerApproved = await r.person('/agents/api/approvals/' + peerId + '/approve', { revision: peerView.body.approval.revision, summary_sha256: peerView.body.approval.summary_sha256 })
  assert.equal(peerApproved.status, 200); assert.equal(peerApproved.body.approval.state, 'executed')
  const completedReplay = await r.replay('base.people.note', args)
  assert.equal(code(completedReplay), undefined)
  const ownArgs = { id: ed.body.id, body: 'Contact ed@acme.test about the renewal', idempotency_key: crypto.randomUUID() }
  const own = await r.c.tool('base.people.note', ownArgs)
  const ownId = own.result._meta['com.runeditrun/approval'].id
  const ownView = await r.person('/agents/api/approvals/' + ownId)
  const ownApproved = await r.person('/agents/api/approvals/' + ownId + '/approve', { revision: ownView.body.approval.revision, summary_sha256: ownView.body.approval.summary_sha256 })
  assert.equal(ownApproved.status, 200); assert.equal(ownApproved.body.approval.state, 'executed')
  const pendingArgs = { id: fred.body.id, body: 'Send the proposal to fred@acme.test', idempotency_key: crypto.randomUUID() }
  const pending = await r.c.tool('base.people.note', pendingArgs)
  const pendingId = pending.result._meta['com.runeditrun/approval'].id
  const approvalBefore = await r.person('/agents/api/approvals/' + pendingId)
  const suffixArgs = { id: fred.body.id, body: 'Contact ' + suffixPeer + ' about the renewal', idempotency_key: crypto.randomUUID() }
  const suffix = await r.c.tool('base.people.note', suffixArgs)
  const suffixId = suffix.result._meta['com.runeditrun/approval'].id
  const suffixBefore = await r.person('/agents/api/approvals/' + suffixId)
  // These proposals belong to a third person; only the free text mentions Ed.
  const mentions = []
  for (const body of ['Introduce Gail to ed@acme.test.', 'Merge the duplicate record ' + ed.body.id + '.',
    'Done. ed@acme.test. Next step', 'Done. ' + ed.body.id + '.)']) {
    const args = { id: gail.body.id, body, idempotency_key: crypto.randomUUID() }
    const proposal = await r.c.tool('base.people.note', args)
    const id = proposal.result._meta['com.runeditrun/approval'].id
    const view = await r.person('/agents/api/approvals/' + id)
    assert.equal(view.body.approval.state, 'pending')
    assert.ok(JSON.stringify(view.body.approval.summary).includes(body))
    mentions.push({ args, proposal, id, view })
  }
  const peerDecisions = [completed.decision.id, pending.decision.id, suffix.decision.id]
  const peerRows = async (table: string) => (await r.db.prepare(`SELECT * FROM ${table} WHERE ${table === 'agent_door_audit' ? 'id' : 'decision_id'} IN (?,?,?) ORDER BY rowid`).bind(...peerDecisions).all()).results
  const before = Object.fromEntries(await Promise.all(['agent_door_calls', 'agent_door_audit', 'agent_door_usage'].map(async table => [table, await peerRows(table)])))
  const peerApprovalsBefore = (await r.db.prepare('SELECT * FROM agent_door_approvals WHERE id IN (?,?,?) ORDER BY rowid').bind(peerId, pendingId, suffixId).all()).results
  const erased = await r.person('/api/people/' + ed.body.id + '/erasure', { confirmation: 'erase ' + ed.body.id })
  assert.equal(erased.status, 200); assert.equal(erased.body.receipt.phase, 'complete')

  // Keep these independent so the unfixed run exposes every lost peer surface.
  await t.test('peer claims retain their keys and outcomes', async () => {
    assert.deepEqual(await peerRows('agent_door_calls'), before.agent_door_calls)
    assert.deepEqual((await r.db.prepare('SELECT * FROM agent_door_approvals WHERE id IN (?,?,?) ORDER BY rowid').bind(peerId, pendingId, suffixId).all()).results, peerApprovalsBefore)
  })
  await t.test('peer audit retains its contents and sponsor', async () => {
    assert.deepEqual(await peerRows('agent_door_audit'), before.agent_door_audit)
    assert.deepEqual(await peerRows('agent_door_usage'), before.agent_door_usage)
  })
  await t.test('peer replay returns the recorded result without another note', async () => {
    const notesBefore = await r.db.prepare('SELECT * FROM person_notes WHERE person_id=? ORDER BY id').bind(fred.body.id).all()
    const replay = await r.replay('base.people.note', args)
    assert.equal(code(replay), undefined)
    assert.deepEqual(replay.result.structuredContent, completedReplay.result.structuredContent)
    assert.deepEqual((await r.db.prepare('SELECT * FROM person_notes WHERE person_id=? ORDER BY id').bind(fred.body.id).all()).results, notesBefore.results)
  })
  await t.test('peer pending approval keeps its exact summary and applies', async () => {
    const after = await r.person('/agents/api/approvals/' + pendingId)
    const { revision, summary_sha256 } = approvalBefore.body.approval
    const decided = await r.person('/agents/api/approvals/' + pendingId + '/approve', { revision, summary_sha256 })
    t.diagnostic('Fred approval after Ed erasure: code=' + (after.body.approval.code ?? 'none') + '; approve status=' + decided.status)
    assert.deepEqual(after, approvalBefore)
    assert.equal(decided.status, 200); assert.equal(decided.body.approval.state, 'executed')
    assert.equal(await r.db.prepare('SELECT count(*) n FROM person_notes WHERE person_id=? AND body=?').bind(fred.body.id, pendingArgs.body).first('n'), 1)
  })
  await t.test('suffix peer keeps its exact proposal, claims, audit and usage', async () => {
    assert.deepEqual(await r.person('/agents/api/approvals/' + suffixId), suffixBefore)
    // Fred's pending proposal was approved above; the suffix proposal stays pending.
    const row = await r.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(suffixId).first()
    assert.deepEqual(row, peerApprovalsBefore.find(row => row.id === suffixId))
  })
  for (const mention of mentions) await t.test('sentence-period mention erases: ' + mention.args.body, async () => {
    const view = await r.person('/agents/api/approvals/' + mention.id)
    assert.equal(view.body.approval.code, 'subject_erased')
    assert.equal(view.body.approval.state, 'held')
    assert.deepEqual(view.body.approval.summary, {})
    assert.equal((await r.person('/agents/api/approvals/' + mention.id + '/approve', {
      revision: mention.view.body.approval.revision, summary_sha256: mention.view.body.approval.summary_sha256,
    })).status, 409)
    const call = await r.db.prepare('SELECT * FROM agent_door_calls WHERE decision_id=?').bind(mention.proposal.decision.id).first<any>()
    assert.equal(call.key, 'erased:' + mention.proposal.decision.id)
    const audit = await r.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(mention.proposal.decision.id).first<any>()
    assert.ok(JSON.parse(audit.row).tombstone)
    assert.equal(await r.db.prepare('SELECT count(*) n FROM agent_door_replay_aliases WHERE call_id=?').bind(mention.proposal.decision.id).first('n'), 1)
    assert.equal(code(await r.replay('base.people.note', mention.args)), 'subject_erased')
    const saved = await r.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(mention.id).first<string>('saved')
    assert.ok(!saved!.includes('ed@acme.test') && !saved!.includes(ed.body.id))
  })
  await t.test('sentence-period personal values are absent from the post-erasure archive', async () => {
    const portability = await createPortability({ db: r.db, policy: { product: 'person-erasure-test', buckets: {}, excludeTables: [] } })
    const after = await archive(portability)
    assert.ok(!after.includes(ed.body.id))
    // Fred legitimately contains Ed's email as a substring; check decoded string values.
    for (const line of after.trim().split('\n').map(line => JSON.parse(line))) {
      assert.ok(!JSON.stringify(line).includes('Introduce Gail to ed@acme.test.'))
      assert.ok(!JSON.stringify(line).includes('Done. ed@acme.test. Next step'))
    }
    t.diagnostic('sentence-period proposals: pending 4 -> held/tombstoned 4; live saved/archive personal mentions 4 -> 0; Fred and suffix peer rows byte-identical')
  })
  await t.test('Ed still loses his native records and gets a value-free replay tombstone', async () => {
    assert.equal((await r.person('/api/people/' + ed.body.id + '/export')).status, 404)
    const call = await r.db.prepare('SELECT * FROM agent_door_calls WHERE decision_id=?').bind(own.decision.id).first<any>()
    assert.equal(call.key, 'erased:' + own.decision.id)
    assert.ok(!JSON.stringify(call).includes('ed@acme.test'))
    assert.equal(code(await r.replay('base.people.note', ownArgs)), 'subject_erased')
  })
})

test('seed and Penny maps agree on sentence periods and preserve identifier continuations', async t => {
  const { pennyAgentArtifacts } = await import('../adoption/penny/penny-map.ts')
  const r = await fixture(t)
  await r.db.prepare('CREATE TABLE audit_entries(door_operation_id TEXT,entity_id TEXT,details_json TEXT)').run()
  const cases: [string, string, boolean][] = [
    [suffixSource, 'Introduce Gail to ' + suffixSource + '.', true],
    [suffixSource, 'Done. ' + suffixSource + '. Next step', true],
    [suffixSource, '(' + suffixSource + '.)', true],
    [suffixSource, '.' + suffixSource, true],
    [suffixSource, suffixPeer, false],
    ['ed@acme.test', 'fred@acme.test', false],
    ['01M6SC233WVN2KMBAYM88GCBK2', 'Merge the duplicate record 01M6SC233WVN2KMBAYM88GCBK2.', true],
    ['01M6SC233WVN2KMBAYM88GCBK2', 'base://people/01M6SC233WVN2KMBAYM88GCBK2', true],
    ['01M6SC233WVN2KMBAYM88GCBK2', 'x01M6SC233WVN2KMBAYM88GCBK2', false],
    ['01M6SC233WVN2KMBAYM88GCBK2', '01M6SC233WVN2KMBAYM88GCBK2x', false],
    ['source-12', 'source-1234', false],
    ['source-12', 'source-12.', true],
    ['source[*]?', 'source[*]?extra', false],
    ['source[*]?', '(source[*]?)', true],
    ['1', 'version 1.0', false],
    ['1', 'source/1/path', false],
    ['1', 'Done. 1.', true],
  ]
  for (const map of [personAgentArtifacts, pennyAgentArtifacts]) {
    const selection = map.artifacts.find(item => item.table === 'agent_door_approvals')!.match!.sql
    for (const [source, text, expected] of cases) {
      await r.db.prepare('DELETE FROM agent_door_approvals').run()
      await r.db.prepare("INSERT INTO agent_door_approvals(id,state,saved) VALUES('case','pending',?)").bind(JSON.stringify({ text })).run()
      const selected = await r.db.prepare('SELECT count(*) n FROM agent_door_approvals WHERE ' + selection).bind(JSON.stringify([source])).first('n')
      assert.equal(selected, Number(expected), (map === pennyAgentArtifacts ? 'Penny' : 'seed') + ' ' + JSON.stringify(source) + ' in ' + JSON.stringify(text))
    }
  }
})

test('adoption refuses undeclared tables and columns', async t => {
  const r = await fixture(t)
  await checkAgentArtifacts(r.db, personAgentArtifacts)
  await r.db.prepare('CREATE TABLE agent_door_unmapped(value TEXT)').run()
  await assert.rejects(checkAgentArtifacts(r.db, personAgentArtifacts), /undeclared_table/)
  await r.db.prepare('DROP TABLE agent_door_unmapped').run()
  await r.db.prepare('ALTER TABLE agent_door_events ADD COLUMN private_copy TEXT').run()
  await assert.rejects(checkAgentArtifacts(r.db, personAgentArtifacts), /undeclared_column/)
})

test('an admitted completion cannot overwrite a tombstone or append late personal events; stale selections roll back', async t => {
  const r = await fixture(t), id = 'racing-subject-' + crypto.randomUUID()
  await r.adopt(autonomousPolicy())
  await r.tool('records.write', { id, value: id, idempotency_key: id })
  const nativeHorizon = r.c.now + 60_000
  await r.db.prepare('UPDATE agent_door_calls SET expires_at=? WHERE key=?').bind(nativeHorizon, id).run()
  const original = await r.db.prepare('SELECT row,evidence FROM agent_door_audit ORDER BY sequence DESC LIMIT 1').first<any>()
  const originalRow = JSON.parse(original.row)
  const statements = await agentErasureStatements({ db: r.db, map: personAgentArtifacts, subject: { values: JSON.stringify([id]) }, secret: r.secret,
    tombstone: { erasure_id: crypto.randomUUID(), at: new Date().toISOString() }, checkpoint: () => r.portability.redactionStatements() })
  await r.db.prepare('UPDATE agent_door_calls SET outcome=?').bind(JSON.stringify({ changed: id })).run()
  await assert.rejects(r.db.batch(statements))
  assert.equal(await r.db.prepare('SELECT count(*) n FROM agent_door_replay_aliases').first('n'), 0, 'no partial alias publication')
  const opened = await r.erasure.start('record', { id }); await r.erasure.run(opened.id)
  assert.equal(await r.db.prepare('SELECT expires_at FROM agent_door_calls WHERE decision_id=?').bind(originalRow.id).first('expires_at'), nativeHorizon, 'an existing shorter replay horizon survives erasure')
  const { audit } = await import('../audit.ts'), { appendEvents } = await import('../events.ts')
  const rt = { options: { db: r.db }, now: Date.now } as any
  await audit(rt, originalRow, JSON.parse(original.evidence))
  await audit(rt, { ...originalRow, id: crypto.randomUUID(), decision_id: originalRow.id }, JSON.parse(original.evidence))
  await appendEvents(rt, [{ type: 'record.saved', uri: 'synthetic://record/' + id, actor: { kind: 'business' }, data: { personal: id } }], originalRow.id)
  assert.ok(!JSON.stringify((await r.db.prepare('SELECT * FROM agent_door_audit').all()).results).includes(id))
  assert.ok(!JSON.stringify((await r.db.prepare('SELECT * FROM agent_door_events').all()).results).includes(id))
})

test('operator retirement keeps paired and local peer approvals pending, accepts refreshes, and survives archives', async t => {
  const { operatorPolicyRefs, createAgentDoor, operatorAuthPeople } = await import('../index.ts')
  const { pennyAgentArtifacts } = await import('../adoption/penny/penny-map.ts')
  for (const paired of [true, false]) {
    const r = await runtime({ paired, erasure: true }); t.after(() => r.close())
    const email = 'synthetic-retired@example.test', businessId = 'synthetic-retired-member'
    assert.equal((await r.settings({ team: [{ id: businessId, email, name: 'Synthetic Retired', role: 'admin', invite: 0 }] })).status, 200)
    await r.signIn(email)
    const operator = await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(businessId).first<string>('operator_id')
    const owner = await r.db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first<string>('id')
    const refs = await operatorPolicyRefs(r.db, operator!)
    assert.deepEqual(refs.sort(), ['person:' + operator, 'person:' + businessId].sort())
    assert.deepEqual(await operatorPolicyRefs(r.db, owner!), ['person:' + owner])
    const ref = 'person:' + (paired ? businessId : operator)
    const policy = { ...autonomousPolicy(), rules: [{ id: 'review', class: 'standard', do: 'review' }, { id: 'hold', class: '*', do: 'approval', approver: [ref], wait: 'PT1H' }], reviewers: [ref, 'role:owner'] }
    const deliver = async (document: any, options: any = {}) => {
      if (paired) return r.adopt(document, options)
      const response = await r.fetch('/agents/api/policy', { method: 'PUT', headers: { cookie: r.c.person.cookie, origin: r.c.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) })
      return { status: response.status, body: await response.json() }
    }
    const reviewedPolicy = policy
    assert.equal((await deliver(reviewedPolicy)).status, 200)
    const completedArgs = { id: 'synthetic-reviewed-peer', value: 'peer value', idempotency_key: 'synthetic-reviewed-peer' }
    const completed = await r.tool('records.write', completedArgs, paired ? {} : { token: r.localToken })
    assert.equal(completed.result.isError, false)
    const reviewId = completed.result._meta['com.runeditrun/review'].id
    let begin!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { begin = resolve }), gate = new Promise<void>(resolve => { finish = resolve })
    t.after(() => finish())
    const embeddedDoor = createAgentDoor({ seed: 'synthetic', name: 'Synthetic', specialist: 'operations', origin: r.c.origin, db: r.db,
      ...(paired ? { trust: { issuer: r.c.signer.issuer, installationId: r.c.signer.installationId, appOrigin: r.c.origin, publicKeys: { [r.c.signer.kid]: await crypto.subtle.exportKey('jwk', r.c.ring.publicKey) } } } : {}),
      people: operatorAuthPeople({ db: r.db, session: async () => null }), tools: [{
        name: 'synthetic.retirement.finish', title: 'Finish admitted work', description: 'Synthetic in-flight completion.', scope: 'records:write', readOnly: false,
        inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, classes: ['standard'], clauses: ['BASE-AGENT-005'],
        classify: () => [{ class: 'standard', facts: { measure: 1 } }], summary: () => ({ target: { id: 'synthetic-inflight' } }),
        async run(_args, ctx) { begin(); await gate; ctx.emit('synthetic.finished', 'synthetic://safe', { ref }); return { result: { ref }, undo: { ref } } },
      }] })
    const inFlight = embeddedDoor.invoke('synthetic.retirement.finish', { idempotency_key: 'synthetic-inflight' }, {
      person: { id: owner!, email: r.c.person.email, name: 'Synthetic Person', role: 'owner', active: true }, agent: { id: 'synthetic-inflight-agent', name: 'Synthetic Inflight' }, scopes: ['records:write'],
    })
    await Promise.race([started, inFlight.then(result => { throw new Error('in-flight admission refused: ' + JSON.stringify(result)) })])
    assert.equal((await deliver(policy)).status, 200)
    await r.db.prepare("INSERT INTO test_records VALUES('synthetic-peer-record','safe peer value',1,'internal')").run()
    const call = (key: string) => r.tool('records.erase', { id: 'synthetic-peer-record', idempotency_key: key }, paired ? {} : { token: r.localToken })
    const waiting = await call('synthetic-peer-held')
    const approvalId = waiting.result._meta['com.runeditrun/approval'].id
    const auditBefore = (await r.person('/agents/api/audit')).body
    const envelopeBefore = await r.db.prepare('SELECT envelope FROM agent_door_state').first('envelope')
    const localRevision = await r.db.prepare('SELECT local_revision FROM agent_door_state').first('local_revision')
    const portability = await createPortability({ db: r.db, policy: { product: 'operator-retirement-test', buckets: {}, excludeTables: ['test_contexts', 'test_callbacks'] } })
    const before = await archive(portability)
    // This operator has no own decisions. Only policy mentions in peer decisions
    // exist: selecting them as subject rows would incorrectly tombstone the peer.
    const map = { artifacts: personAgentArtifacts.artifacts.map(item => item.table === 'agent_door_state'
      ? { table: item.table, columns: item.columns, retire: { refs: 'refs' } }
      : item.match ? { table: item.table, columns: item.columns, match: { sql: '0', params: [] } } : item) }
    await checkAgentArtifacts(r.db, pennyAgentArtifacts)
    const tombstone = { erasure_id: crypto.randomUUID(), at: new Date(r.c.now).toISOString() }
    const compile = (subject: any, artifactMap: any = map) => agentErasureStatements({ db: r.db, map: artifactMap, subject, secret: r.secret, tombstone, checkpoint: () => portability.redactionStatements() })
    for (const malformed of ['{}', '["role:owner"]', '["person:a:b"]', '["person:has space"]', '[1]', JSON.stringify(Array(201).fill('person:a'))]) {
      await assert.rejects(compile({ refs: malformed }), /agent_erasure_policy_ref/)
    }
    await assert.rejects(compile({}), /agent_erasure_subject_value:refs/)
    const invalidMap = { artifacts: map.artifacts.map(item => item.table === 'agent_door_state' ? { ...item, unrelated: 'invalid second declaration' } : item) }
    await assert.rejects(compile({ refs: '[]' }, invalidMap), /agent_erasure_undeclared_table:agent_door_state/)
    const wrongTable = { artifacts: map.artifacts.map(item => item.table === 'agent_door_agents' ? { table: item.table, columns: item.columns, retire: { refs: 'refs' } } : item) }
    await assert.rejects(compile({ refs: '[]' }, wrongTable), /agent_erasure_undeclared_table:agent_door_agents/)
    await r.db.batch(await compile({ refs: '[]' }))
    assert.equal(await r.db.prepare('SELECT count(*) n FROM agent_door_retired_refs').first('n'), 0)
    const statements = await compile({ refs: JSON.stringify(refs) })
    await r.db.batch([...statements,
      r.db.prepare('DELETE FROM oa_sessions WHERE operator_id=?').bind(operator),
      r.db.prepare('DELETE FROM oa_tokens WHERE operator_id=? OR issuer_id=?').bind(operator, operator),
      r.db.prepare('DELETE FROM bs_team WHERE operator_id=?').bind(operator),
      r.db.prepare('DELETE FROM oa_operators WHERE id=?').bind(operator),
    ])
    const marker = 'person:erased:' + tombstone.erasure_id
    assert.equal(await r.db.prepare('SELECT envelope FROM agent_door_state').first('envelope'), envelopeBefore)
    assert.equal(await r.db.prepare('SELECT local_revision FROM agent_door_state').first('local_revision'), localRevision)
    const view = (await r.person('/agents/api/approvals/' + approvalId)).body.approval
    assert.equal(view.state, 'pending'); assert.equal(view.code, null); assert.deepEqual(view.approvers, [marker])
    assert.deepEqual((await r.person('/agents/api/audit')).body, auditBefore)
    finish()
    assert.equal((await inFlight).outcome, 'done')
    const replayed = await r.tool('records.write', completedArgs, paired ? {} : { token: r.localToken })
    assert.deepEqual(replayed.result.structuredContent, completed.result.structuredContent, 'completed peer payload replays unchanged')
    assert.equal((await r.person('/agents/api/reviews/' + reviewId + '/undo', {})).body.review.state, 'undone', 'remaining owner reviewer can Undo')
    assert.equal((await r.person('/agents/api/state')).body.policy.pending_retirement, 1)
    const page = await r.fetch('/agents', { headers: { cookie: r.c.person.cookie } })
    assert.match(await page.text(), /data-policy-retirement/)
    const dump = JSON.stringify(await Promise.all(personAgentArtifacts.artifacts.filter(item => item.table !== 'agent_door_state').map(async item => (await r.db.prepare('SELECT * FROM "' + item.table + '"').all()).results)))
    for (const raw of refs.concat([operator!, email])) assert.ok(!dump.includes(raw), raw)
    if (paired) {
      const seq = r.c.seq, revision = r.c.revision
      await r.setNow(r.c.now + 1000)
      assert.equal((await deliver(policy, { seq, revision })).status, 200, 'same-sequence refresh retains immutable authority')
      await r.setNow(r.c.now + 301_000)
      assert.equal((await deliver(policy)).status, 200, 'new delivery naming a retired person remains live')
      const unresolved = await deliver({ ...policy, reviewers: ['person:synthetic-unmapped'] })
      assert.equal(unresolved.status, 400); assert.equal(unresolved.body.code, 'policy_refs_unresolved')
    } else {
      const local = (await r.person('/agents/api/policy')).body
      assert.equal(local.complete, false); assert.deepEqual(local.document.rules[1].approver, [marker]); assert.deepEqual(local.document.reviewers, [marker, 'role:owner'])
    }
    const late = await call('synthetic-peer-late')
    const lateId = late.result._meta['com.runeditrun/approval'].id
    const lateView = (await r.person('/agents/api/approvals/' + lateId)).body.approval
    assert.deepEqual(lateView.approvers, [marker]); assert.equal(lateView.state, 'pending')
    assert.equal((await r.person('/agents/api/approvals/' + lateId + '/approve', { revision: lateView.revision, summary_sha256: lateView.summary_sha256 })).status, 403)
    const embedded = await r.person('/__embedded', { name: 'synthetic.records.erase', args: { id: 'synthetic-peer-record', idempotency_key: 'synthetic-embedded' }, scopes: ['records:write'] })
    assert.equal(embedded.body.outcome, 'pending')
    const after = await archive(portability)
    assert.ok(JSON.parse(after.split('\n')[0]).tables.some((table: any) => table.name === 'agent_door_retired_refs'))
    const archivedAgentRows = after.trim().split('\n').map(line => JSON.parse(line)).filter(line => line.kind === 'part').flatMap(part => part.items).filter(item => item.table?.startsWith('agent_door_'))
    assert.ok(!JSON.stringify(archivedAgentRows).includes(email), 'agent archive rows contain no retired contact')
    if (paired) {
      const destination = await runtime({ erasure: true, ring: r.c.ring }); t.after(() => destination.close())
      const lines = after.trim().split('\n').map(line => JSON.parse(line))
      const lastOwner = await destination.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='oa_preserve_last_owner_delete'").first<string>('sql')
      await destination.db.batch([
        destination.db.prepare('PRAGMA defer_foreign_keys=ON'), destination.db.prepare('DROP TRIGGER oa_preserve_last_owner_delete'),
        ...lines[0].tables.map((table: any) => destination.db.prepare('DELETE FROM "' + table.name + '"')),
        destination.db.prepare(lastOwner!),
      ])
      const restored = await createPortability({ db: destination.db, policy: { product: 'operator-retirement-test', buckets: {}, excludeTables: ['test_contexts', 'test_callbacks'] } })
      const id = await restored.imports.create(lines[0])
      for (const part of lines.filter(line => line.kind === 'part')) await restored.imports.uploadPart(id, part.index, part)
      assert.equal((await restored.imports.finalize(id, { archiveHash: lines.at(-1).archiveHash })).phase, 'complete')
      assert.equal((await destination.adopt(policy, { seq: r.c.seq + 1, revision: r.c.revision + 1 })).status, 200, 'restored suppression permits signed delivery still naming the erased person')
    }
    const old = before.trim().split('\n').map(line => JSON.parse(line))
    await assert.rejects(async () => {
      const id = await portability.imports.create(old[0])
      for (const part of old.filter(line => line.kind === 'part')) await portability.imports.uploadPart(id, part.index, part)
      await portability.imports.finalize(id, { archiveHash: old.at(-1).archiveHash })
    }, /erasure_epoch/)
    assert.equal((await deliver(autonomousPolicy())).status, 200)
    assert.equal((await r.person('/agents/api/state')).body.policy.pending_retirement, 0)
    assert.ok(!JSON.stringify((await r.db.prepare('SELECT * FROM agent_door_state').all()).results).includes(ref))
    t.diagnostic(`${paired ? 'paired' : 'local'}: declaration/subject refusals; native batch; envelope/revision unchanged; peer audit unchanged/differs=0; pending marker; refresh/liveness; in-flight audit/review/call/event retired; completed peer replay and owner Undo; late MCP and embedded copies retired; checkpoint and archive restore custody; release=0`)
  }
})
