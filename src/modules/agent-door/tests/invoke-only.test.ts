import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'
import { createProtocol } from '../conformance/protocol.mjs'

const prepared = 'synthetic.queue.prepare', continued = 'synthetic.queue.execute'
const errorCode = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
const job = () => ({ id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })

async function policyMapping(r: any, exposure: string | undefined) {
 const tools = (await r.mcp('tools/list')).result.tools.map((tool: any) => ({ name: tool.name, classes: tool._meta['com.runeditrun/classes'], scope: tool._meta['com.runeditrun/scope'] }))
 const c: any = createProtocol({ ...r.c, surface: { seed: 'synthetic', specialist: 'operations', tools }, fetch: r.fetch, points: [] })
 for (const options of [{}, { paused: true }, { revoked: { agents: [], consents: [c.consent] } }]) {
  await c.adopt(autonomousPolicy(), options)
  assert.equal(c.points.at(-1).ok, true, c.points.at(-1).detail)
 }
 assert.deepEqual(c.invokeTools.map((tool: any) => tool.name).sort(), exposure === 'invoke' ? [continued, prepared] : [])
 await c.adopt(null)
 assert.equal(c.points.at(-1).ok, true, 'the declared mapping survives unanswered policy')
 const fetch = c.fetch
 for (const corruption of ['visible mapping', ...(exposure === 'invoke' ? ['hidden mapping', 'discovery', 'call'] : [])]) {
  c.fetch = async (url: string, init: any) => {
   const response = await fetch(url, init), body = await response.json(), request = init?.body && JSON.parse(init.body)
   if (new URL(url).pathname === '/api/rer/agent-policy') {
    const name = corruption === 'visible mapping' ? tools[0].name : corruption === 'hidden mapping' ? prepared : null
    if (name) for (const row of body.door.classes) row.tools = row.tools.filter((tool: string) => tool !== name)
   }
   if (corruption === 'discovery' && request?.method === 'tools/list') body.result.tools.push({ name: prepared })
   if (corruption === 'call' && request?.method === 'tools/call' && request.params.name === prepared) return Response.json({ result: { structuredContent: {} } })
   return Response.json(body, { status: response.status, headers: response.headers })
  }
  await c.adopt(autonomousPolicy())
  assert.equal(c.points.at(-1).ok, false, `${corruption} must remain a conformance failure`)
 }
 r.c.seq = c.seq; r.c.revision = c.revision
}

test('invoke-only native work keeps full admission while MCP treats its names as unknown', async t => {
 for (const exposure of [undefined, 'invoke']) {
  const r = await runtime({ queueContext: { exposure, scope: 'worker:prepare' } })
  try {
   const adopted = await r.adopt()
   assert.ok(adopted.body.door.classes.some((row: any) => row.tools.includes(prepared) && row.tools.includes(continued)), 'policy questions still include worker tools')
   const names = (await r.mcp('tools/list')).result.tools.map((tool: any) => tool.name)
   assert.ok(names.includes('synthetic.records.write'))
   t.diagnostic(`${exposure ?? 'default'} tools/list: ${names.join(', ')}`)

   // An ordinary tool retains discovery, MCP execution and embedded execution.
   const ordinary = { id: crypto.randomUUID(), value: 'ordinary', idempotency_key: crypto.randomUUID() }
   assert.equal(errorCode(await r.tool('records.write', ordinary)), undefined)
   const embedded = async (name: string, args: object, scopes = ['records:read', 'records:write', 'worker:prepare']) => (await r.post('/__embedded', {
    name, args, scopes, consent: r.c.consent, agent: { id: r.c.agentId, name: 'Native worker', specialist: 'operations' },
   }, { cookie: r.c.person.cookie })).json()
   assert.equal((await embedded('synthetic.records.write', { ...ordinary, id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })).outcome, 'done')

   const metadata = await (await r.fetch('/.well-known/oauth-protected-resource')).json()
   assert.ok(metadata.scopes_supported.includes('records:write'), 'a scope shared with an exposed tool remains advertised')
   const input = job()
   if (exposure === undefined) {
    assert.ok(names.includes(prepared)); assert.ok(names.includes(continued))
    assert.ok(metadata.scopes_supported.includes('worker:prepare'))
    const token = await r.token({ scope: 'records:read records:write worker:prepare events:read' })
    const called = await r.tool('queue.prepare', input, { token })
    assert.equal(errorCode(called), undefined); assert.ok(called.result.structuredContent.operationId)
    assert.equal(errorCode(await r.tool('queue.execute', input)), 'operation_mismatch', 'MCP resolves the continuation and applies its native binding')
    t.diagnostic('default MCP: queue.prepare executed; queue.execute resolved and required its retained operation; ordinary tool unchanged')
    await policyMapping(r, exposure)
    continue
   }
   assert.ok(!names.includes(prepared)); assert.ok(!names.includes(continued))
   assert.ok(!metadata.scopes_supported.includes('worker:prepare'))
   const headers = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', Authorization: `Bearer ${await r.token()}` }
   const call = async (name: string) => {
    const response = await r.post('/mcp', { jsonrpc: '2.0', id: 'same-request', method: 'tools/call', params: { name, arguments: input, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { ...headers, 'Mcp-Name': name })
    return { status: response.status, body: await response.text() }
   }
   const unknown = await call('synthetic.unknown')
   assert.equal(unknown.status, 400); assert.equal(JSON.parse(unknown.body).error.data.code, 'tool_not_found')
   for (const name of [prepared, continued]) assert.deepEqual(await call(name), unknown, 'MCP status and response bytes equal an unknown name')
   assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_jobs').first()).n, 0, 'MCP ran no worker callback')
   const refused = (await r.person('/agents/api/audit')).body.rows.filter((row: any) => [prepared, continued, 'synthetic.unknown'].includes(row.tool))
   const treatment = ({ id, operation_id, sequence, at, tool, ...row }: any) => row
   assert.equal(refused.length, 3)
   for (const row of refused) assert.deepEqual(treatment(row), treatment(refused[0]), 'hidden and unknown calls have the same audit treatment')
   t.diagnostic(`invoke-only MCP and unknown bytes: status=${unknown.status} body=${unknown.body}; callbacks=0; audit treatment equal`)

   const usageBefore = (await r.db.prepare('SELECT COUNT(*) AS n FROM agent_door_usage WHERE agent=?').bind(r.c.agentId).first()).n
   assert.equal((await embedded(prepared, input, ['records:read', 'records:write'])).code, 'insufficient_scope')
   await r.adopt(autonomousPolicy(), { paused: true })
   assert.equal((await embedded(prepared, input)).code, 'agents_paused')
   await r.adopt(null)
   assert.equal((await embedded(prepared, input)).code, 'policy_unset')
   await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'deny', class: '*', do: 'blocked' }] })
   assert.equal((await embedded(prepared, input)).outcome, 'refused')
   assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_jobs').first()).n, 0)

   await r.adopt()
   const admitted = await embedded(prepared, input)
   assert.equal(admitted.outcome, 'done'); assert.ok(admitted.result.operationId)
   assert.deepEqual((await embedded(prepared, input)).result, admitted.result)
   const drain = async (override?: object, args?: object) => (await r.post('/__queue', { id: input.id, override, args }, { cookie: r.c.person.cookie })).json()
   assert.equal((await drain({ operationId: crypto.randomUUID() })).code, 'operation_mismatch')
   await r.db.prepare('INSERT INTO test_grants(agent,scopes) VALUES(?,?)').bind(r.c.agentId, JSON.stringify(['records:read'])).run()
   assert.equal((await drain()).code, 'insufficient_scope')
   await r.db.prepare('DELETE FROM test_grants').run()
   assert.equal((await drain()).outcome, 'done'); assert.equal((await drain()).outcome, 'done')
   assert.equal((await drain(undefined, { value: 'changed' })).code, 'idempotency_conflict')
   assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects').first()).n, 1)
   const saved = JSON.parse((await r.db.prepare('SELECT saved FROM test_jobs WHERE id=?').bind(input.id).first()).saved)
   const effect = JSON.parse((await r.db.prepare('SELECT saved FROM test_effects WHERE id=?').bind(input.id).first()).saved)
   assert.deepEqual(effect, saved)
   const rows = (await r.person('/agents/api/audit')).body.rows.filter((row: any) => row.tool === continued && ['done', 'replayed'].includes(row.outcome))
   assert.equal(rows.length, 2)
   for (const row of rows) {
    assert.equal(row.door, 'embedded'); assert.equal(row.operation_id, admitted.result.operationId)
    assert.equal(row.continuation_item_id, input.id); assert.equal(row.consent, r.c.consent); assert.equal(row.idempotency_key, input.idempotency_key)
   }
   assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM agent_door_usage WHERE agent=?').bind(r.c.agentId).first()).n - usageBefore, 2, 'both hidden effects count toward usage')
   await r.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [r.c.consent] } })
   assert.equal((await drain()).code, 'consent_revoked')
   await r.adopt(autonomousPolicy(), { revoked: { agents: [r.c.agentId], consents: [] } })
   assert.equal((await drain()).code, 'unauthenticated')

   await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'held', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })
   const held = await embedded(prepared, job())
   assert.equal(held.outcome, 'pending')
   const path = `/agents/api/approvals/${held.approval.id}`, view = (await r.person(path)).body.approval
   assert.equal((await r.person(`${path}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval.state, 'executed')
   await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'review', class: '*', do: 'review' }], reviewers: ['sponsor'] })
   const reviewed = await embedded(prepared, job())
   assert.equal(reviewed.outcome, 'done'); assert.ok(reviewed.review.id)
   assert.equal((await r.person(`/agents/api/reviews/${reviewed.review.id}/reviewed`, {})).body.review.state, 'reviewed')
   t.diagnostic('invoke-only embedded: scope, Pause, policy, native binding, one effect/replay, usage, consent/agent revocation, approval and review PASS')
   await policyMapping(r, exposure)
  } finally { await r.close() }
 }
})
