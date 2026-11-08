import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentDoor, operatorAuthPeople } from '../index.ts'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'

const decision = (answer: any) => answer.result?._meta?.['com.runeditrun/decision']

test('principal journey: one sponsor retains distinct client fences through resources, events, streams and delayed approvals', async t => {
  const r = await runtime()
  let points = 0
  const check = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); points++ }
  try {
    await r.adopt(autonomousPolicy())
    for (const service of ['a', 'b']) await r.db.prepare('INSERT INTO test_records VALUES(?,?,1,?)').bind(service, service, `service:${service}`).run()
    const tokens = await Promise.all(['a', 'b'].map(service => r.token({ client_id: `service:${service}`, act: { sub: `agent-${service}`, name: service }, scope: `records:read events:read service:${service}` })))
    const read = (id: string, token: string, requestState?: string) => r.mcp('resources/read', { uri: `synthetic://record/${id}`, ...(requestState ? { requestState } : {}) }, { token })
    for (const [i, service] of ['a', 'b'].entries()) {
      check(JSON.parse((await read(service, tokens[i])).result.contents[0].text).id, service)
      check((await read(service === 'a' ? 'b' : 'a', tokens[i])).error.message, 'Resource unavailable')
    }
    const sponsor = (await r.person('/agents/api/agents')).body.agents[0].sponsor.id
    for (const service of ['a', 'b']) await r.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(service, `synthetic://record/${service}`, JSON.stringify({ id: service, uri: `synthetic://record/${service}`, type: 'changed', at: new Date().toISOString(), actor: { kind: 'person', person: { id: sponsor, name: 'Owner' } } })).run()
    for (const [i, service] of ['a', 'b'].entries()) {
      const listed = await r.tool('events.list', {}, { token: tokens[i] })
      check(listed.result.structuredContent.events.filter((event: any) => event.type === 'changed').map((event: any) => event.uri).every((uri: string) => uri === `synthetic://record/${service}`), true)
      const response = await r.post('/mcp', { jsonrpc: '2.0', id: i, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['synthetic://record/a', 'synthetic://record/b'] }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen', Authorization: `Bearer ${tokens[i]}` })
      const reader = response.body!.getReader()
      try {
        const acknowledged = new TextDecoder().decode((await reader.read()).value)
        check(JSON.parse(acknowledged.slice(6)).params.notifications.resourceSubscriptions, [`synthetic://record/${service}`])
        for (const target of ['a', 'b']) await r.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(crypto.randomUUID(), `synthetic://record/${target}`, JSON.stringify({ id: crypto.randomUUID(), uri: `synthetic://record/${target}`, type: 'changed', actor: { kind: 'person', person: { id: sponsor, name: 'Owner' } } })).run()
        const delivered = new TextDecoder().decode((await reader.read()).value)
        check(JSON.parse(delivered.slice(6)).params.uri, `synthetic://record/${service}`)
      } finally { await reader.cancel() }
    }
    await r.adopt(heldPolicy())
    const approve = async (pending: any) => {
      const id = pending.error.data.approval.id
      const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
      return (await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval
    }
    const otherClient = await r.token({ client_id: 'service:b', act: { sub: 'agent-a', name: 'a' }, scope: 'records:read events:read service:b' })
    const pending = await read('a', tokens[0])
    check(pending.error.data.code, 'approval_required')
    check((await approve(pending)).state, 'executed')
    check((await read('a', otherClient, pending.error.data.requestState)).error.data.code, 'invalid_arguments')
    check(JSON.parse((await read('a', tokens[0], pending.error.data.requestState)).result.contents[0].text).id, 'a')
    await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind('agent-a', JSON.stringify(['records:read', 'events:read'])).run()
    check((await read('a', tokens[0], pending.error.data.requestState)).error.message, 'Resource unavailable')
    const narrowed = await read('b', tokens[1])
    await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind('agent-b', JSON.stringify(['events:read'])).run()
    check((await approve(narrowed)).code, 'insufficient_scope')
    const rows = (await r.person('/agents/api/audit')).body.rows
    const refused = rows.findLast((row: any) => row.agent.id === 'agent-b' && row.decision_id)
    check({ outcome: refused.outcome, code: refused.code, resource: refused.resource, sponsor: refused.sponsor.id, tool: refused.tool }, { outcome: 'refused', code: 'insufficient_scope', resource: 'synthetic://record/b', sponsor, tool: 'resources/read' })
    check((await r.person('/agents/api/audit')).body.differs_from_policy, 0)
    await r.adopt(autonomousPolicy())
    check((await r.person('/__embedded', { scopes: [], name: 'synthetic.records.list' })).body.code, 'insufficient_scope')
    check((await r.person('/__embedded', { scopes: ['records:read'] })).body.outcome, 'done')
    await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind(r.c.agentId, JSON.stringify(['records:read', 'events:read'])).run()
    check((await r.tool('records.list', {}, { token: await r.token({ scope: 'events:read' }) })).status, 403)
    check((await r.person('/agents/api/audit')).body.rows.findLast((row: any) => row.door === 'embedded' && row.code === 'insufficient_scope').tool, 'synthetic.records.list')
    assert.ok(decision(await r.tool('events.list', {})))
    let ran = false
    const nativePeople = operatorAuthPeople({ db: r.db, session: async () => null })
    const embedded = createAgentDoor({ seed: 'synthetic', name: 'Native grant failure', specialist: 'operations', db: r.db, origin: r.c.origin, trust: null, people: nativePeople,
      currentScopes: async () => undefined as unknown as string[],
      tools: [{ name: 'synthetic.grants.read', title: 'Read', description: 'Read only with a valid current grant.', scope: 'records:read', readOnly: true, inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, classes: ['standard'], clauses: ['BASE-AGENT-005'], classify: () => [{ class: 'standard', facts: { measure: 1 } }], async run() { ran = true; return { result: {} } } }],
    })
    const failure = await embedded.invoke('synthetic.grants.read', {}, { person: (await nativePeople.person(sponsor))!, agent: { id: 'grant-failure', name: 'Grant failure' }, scopes: ['records:read'] })
    check(failure.code, 'execution_failed')
    check(ran, false)
    t.diagnostic(`Gap P public-door journey: ${points}/${points} points passed.`)
  } finally { await r.close() }
})
