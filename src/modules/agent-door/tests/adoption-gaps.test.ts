import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { heldPolicy } from '../conformance/crypto.mjs'
import { validateAgentSurface } from '../conformance/surface.mjs'

const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code

test('G1 retained replay and subscriptions recheck native visibility for actor and Business owner', async () => {
 const r = await runtime()
 try {
  await r.adopt()
  const start = (await r.tool('events.list', {})).result.structuredContent.cursor
  await r.tool('records.write', { id: 'synthetic-base-1', value: 'private', idempotency_key: crypto.randomUUID() })
  const visible = (await r.tool('events.list', {})).result.structuredContent
  assert.equal(visible.events.filter((event: any) => event.uri === 'synthetic://record/synthetic-base-1').length, 1)
  const body = { jsonrpc: '2.0', id: 'visibility', method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['synthetic://record/synthetic-base-1'] }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }
  const response = await r.post('/mcp', body, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen', Authorization: `Bearer ${await r.token()}` })
  const reader = response.body.getReader()
  try {
   assert.match(new TextDecoder().decode((await reader.read()).value), /acknowledged/)
   await r.db.prepare("UPDATE test_records SET exposure='hidden'").run()
   await r.person('/__emit', {})
   await r.db.prepare("DELETE FROM test_contexts WHERE kind='read'").run()
   const replay = (await r.tool('events.list', { after: start })).result.structuredContent
   assert.deepEqual(replay, { events: [], cursor: start })
   assert.equal((await r.db.prepare("SELECT COUNT(*) AS n FROM test_contexts WHERE kind='read'").first()).n, 2)
   const pending = reader.read()
   // Wait for actual delivery processing, then close at the native stream's
   // lifetime boundary. A hidden notification would satisfy pending first.
   for (let tries = 0; ; tries++) {
    const n = (await r.db.prepare("SELECT COUNT(*) AS n FROM test_contexts WHERE kind='read'").first()).n
    if (n > 2) break
    assert.ok(tries < 50, 'subscription must invoke the native reader')
    await new Promise(resolve => setTimeout(resolve, 50))
   }
   await r.setNow(r.c.now + 120001)
   const final = new TextDecoder().decode((await pending).value)
   assert.doesNotMatch(final, /notifications\/resources\/updated/)
   assert.match(final, /complete/)
  } finally { await reader.cancel() }
 } finally { await r.close() }
})

test('G2 declaration, registration and public MCP accept contract names and reject malformed names', async () => {
 for (const [seed, suffixes] of [['chest', ['search', 'ask', 'pick', 'share', 'send', 'rewind', 'sign']], ['crank', ['runs.preview_replay', 'tickets.log_work']]] as const) {
  const names = suffixes.map(suffix => `${seed}.${suffix}`)
  const surface = (tools: string[]) => ({ schema: 'rer-agent-surface/1', seed, specialist: 'operations', tools: tools.map(name => ({ name, scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-002'] })), notTools: [], resources: [], witness: { tool: names[0], args: {} }, journey: names.map((tool, i) => ({ id: String(i), tool, args: {}, expect: [{ class: 'standard' }] })) })
  for (const name of names) assert.equal(validateAgentSurface(surface(names)).points.find((point: any) => point.id === `BASE-AGENT-013.surface.${name}.name`).ok, true)
  for (const name of [`${seed}.Upper`, `${seed}..read`, `${seed}.read work`, 'foreign.read', `${seed}.bad-name`, `${seed}.${'a'.repeat(129)}`, names[0]]) {
   const declaration = surface([...names, name])
   assert.ok(validateAgentSurface(declaration).points.some((point: any) => point.id === `BASE-AGENT-013.surface.${name}.name` && !point.ok), name)
  }
  const r = await runtime({ seed, toolNames: names })
  try {
   await r.adopt()
   assert.deepEqual((await r.mcp('tools/list')).result.tools.map((tool: any) => tool.name).sort(), [...names, `${seed}.events.list`].sort())
   for (const name of names) assert.equal((await r.mcp('tools/call', { name, arguments: {} })).result.isError, false, name)
  } finally { await r.close() }
 }
})

test('G4 integer and UUID revision tokens survive approval and execution without coercion', async () => {
 for (const revisionType of [undefined, 'string']) {
  const r = await runtime({ revisionType })
  try {
   await r.adopt()
   const input = (value: string, expected?: string | number) => ({ id: 'record', value, idempotency_key: crypto.randomUUID(), ...(expected === undefined ? {} : { expected_revision: expected }) })
   await r.tool('records.write', input('initial'))
   const current = async () => revisionType ? (await r.db.prepare('SELECT token FROM test_revisions WHERE id=?').bind('record').first()).token : (await r.db.prepare('SELECT version FROM test_records WHERE id=?').bind('record').first()).version
   const token = await current()
   if (revisionType) assert.match(token, /^[a-f0-9-]{36}$/)
   else assert.equal(token, 1)
   const listed = (await r.mcp('tools/list')).result.tools.find((tool: any) => tool.name === 'synthetic.records.write')
   assert.deepEqual(listed.inputSchema.properties.expected_revision, { type: revisionType ?? 'integer' })
   assert.equal(code(await r.tool('records.write', input('wrong-type', revisionType ? 1 : '1'))), 'invalid_arguments')
   assert.equal(code(await r.tool('records.write', input('stale', revisionType ? crypto.randomUUID() : 0))), 'revision_conflict')
   await r.adopt({ ...heldPolicy(), rules: heldPolicy().rules.slice(0, 1) })
   const heldInput = input('approved', token), held = await r.tool('records.write', heldInput)
   const id = held.result._meta['com.runeditrun/approval'].id
   const saved = JSON.parse((await r.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(id).first()).saved)
   assert.equal(saved.expected_revision, token)
   // A person's native change races the saved approval; no approved effect runs.
   if (revisionType) await r.db.prepare('UPDATE test_revisions SET token=?').bind(crypto.randomUUID()).run()
   else await r.db.prepare('UPDATE test_records SET version=version+1').run()
   const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
   const result = await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
   assert.equal(result.body.approval.state, 'refused')
   assert.equal(result.body.approval.code, 'revision_conflict')
   assert.equal((await r.db.prepare('SELECT value FROM test_records').first()).value, 'initial')
   assert.equal(code(await r.tool('records.write', heldInput)), 'revision_conflict')
   const fresh = await r.tool('records.write', input('approved-fresh', await current()))
   const freshId = fresh.result._meta['com.runeditrun/approval'].id
   const freshView = (await r.person(`/agents/api/approvals/${freshId}`)).body.approval
   const executed = await r.person(`/agents/api/approvals/${freshId}/approve`, { revision: freshView.revision, summary_sha256: freshView.summary_sha256 })
   assert.equal(executed.body.approval.state, 'executed')
   assert.equal((await r.db.prepare('SELECT value FROM test_records').first()).value, 'approved-fresh')
  } finally { await r.close() }
 }
})
