import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { createAgentDoor, defineTool, operatorAuthPeople, operatorPolicyRefs } from '../index.ts'
import { agentErasureStatements } from '../erasure.ts'
import { personAgentArtifacts } from '../../../default-seed/src/agent-door/erasure.ts'
import { autonomousPolicy } from '../conformance/crypto.mjs'

// Hold a prepared write before D1 executes it, after any application-side reads.
function holdWrite(db: D1Database, site: RegExp, ref: string, between: () => Promise<void>) {
  let fired = false
  const statements = new WeakMap<object, { statement: D1PreparedStatement; sql: string; values: unknown[] }>()
  const pause = async (sql: string, values: unknown[]) => {
    if (!fired && site.test(sql) && values.some(value => typeof value === 'string' && value.includes(ref))) {
      fired = true
      await between()
    }
  }
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql, args)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? async (...args: unknown[]) => { await pause(sql, values); return value.apply(target, args) } : value
    } })
    statements.set(proxy, { statement, sql, values })
    return proxy
  }
  return new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
    if (property === 'batch') return async (items: D1PreparedStatement[]) => {
      for (const item of items) { const held = statements.get(item); if (held) await pause(held.sql, held.values) }
      return target.batch(items.map(item => statements.get(item)?.statement ?? item))
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

test('peer writes held across operator erasure cannot restore retired references', async t => {
  const sites = [
    ['audit insert', /^INSERT INTO agent_door_audit(?!.*ON CONFLICT)/, false],
    ['audit upsert', /^INSERT INTO agent_door_audit.*ON CONFLICT/s, false],
    ['open review', /^INSERT INTO agent_door_reviews/, false],
    ['open approval', /^INSERT INTO agent_door_approvals/, true],
    ['call outcome', /^UPDATE agent_door_calls/, false],
    ['event', /^INSERT INTO agent_door_events/, false],
  ] as const
  for (const paired of [true, false]) for (const [label, site, held] of sites) {
    const r = await runtime({ paired, erasure: true })
    try {
      const businessId = 'race-retired-member', email = 'race-retired@example.test'
      assert.equal((await r.settings({ team: [{ id: businessId, email, name: 'Retired Operator', role: 'admin', invite: 0 }] })).status, 200)
      await r.signIn(email)
      const operator = await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(businessId).first<string>('operator_id')
      const owner = await r.db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first<string>('id')
      const ref = 'person:' + (paired ? businessId : operator)
      const policy = { ...autonomousPolicy(), rules: [{ id: 'review', class: 'standard', do: 'review' }, { id: 'hold', class: '*', do: 'approval', approver: [ref], wait: 'PT1H' }], reviewers: [ref, 'role:owner'] }
      if (paired) assert.equal((await r.adopt(policy)).status, 200)
      else assert.equal((await r.fetch('/agents/api/policy', { method: 'PUT', headers: { cookie: r.c.person.cookie, origin: r.c.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: policy }) })).status, 200)
      const envelope = await r.db.prepare('SELECT envelope FROM agent_door_state').first('envelope')
      const map = { artifacts: personAgentArtifacts.artifacts.map(item => item.table === 'agent_door_state'
        ? { table: item.table, columns: item.columns, retire: { refs: 'refs' } }
        : item.match ? { table: item.table, columns: item.columns, match: { sql: '0', params: [] } } : item) }
      let erased = false
      const db = holdWrite(r.db, site, ref, async () => {
        const statements = await agentErasureStatements({ db: r.db, map, subject: { refs: JSON.stringify(await operatorPolicyRefs(r.db, operator!)) }, secret: r.secret,
          tombstone: { erasure_id: crypto.randomUUID(), at: new Date(r.c.now).toISOString() }, checkpoint: async () => [] })
        await r.db.batch([...statements,
          r.db.prepare('DELETE FROM oa_sessions WHERE operator_id=?').bind(operator),
          r.db.prepare('DELETE FROM oa_tokens WHERE operator_id=? OR issuer_id=?').bind(operator, operator),
          r.db.prepare('DELETE FROM bs_team WHERE operator_id=?').bind(operator),
          r.db.prepare('DELETE FROM oa_operators WHERE id=?').bind(operator),
        ])
        erased = true
      })
      const door = createAgentDoor({ seed: 'synthetic', name: 'Race', specialist: 'operations', origin: r.c.origin, db,
        ...(paired ? { trust: { issuer: r.c.signer.issuer, installationId: r.c.signer.installationId, appOrigin: r.c.origin, publicKeys: { [r.c.signer.kid]: await crypto.subtle.exportKey('jwk', r.c.ring.publicKey) } } } : {}),
        people: operatorAuthPeople({ db: r.db, session: async () => null }), tools: [defineTool({
          name: 'synthetic.race.write', title: 'Write', description: 'Write a peer record.', scope: 'records:write', readOnly: false,
          inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
          classes: [held ? 'destructive' : 'standard'], clauses: ['BASE-AGENT-002'],
          classify: () => [{ class: held ? 'destructive' : 'standard', facts: { measure: 1 } }], summary: () => ({ target: { id: 'peer-record' } }),
          async run(_args, ctx) { ctx.emit('peer.updated', 'synthetic://peer-record', { ref }); return { result: { ref }, undo: { ref } } }, async undo() {},
        })] })
      const result = await door.invoke('synthetic.race.write', { idempotency_key: crypto.randomUUID() }, {
        person: { id: owner!, email: r.c.person.email, name: 'Synthetic Person', role: 'owner', active: true }, agent: { id: 'race-agent', name: 'Race Agent' }, scopes: ['records:write'],
      })
      assert.equal(result.outcome, held ? 'pending' : 'done', label)
      assert.ok(erased, label + ': erasure committed while the write was held')
      assert.equal(await r.db.prepare('SELECT envelope FROM agent_door_state').first('envelope'), envelope)
      for (const artifact of personAgentArtifacts.artifacts) for (const column of artifact.columns) {
        if (artifact.table === 'agent_door_state' && column === 'envelope') continue
        const rows = (await r.db.prepare(`SELECT "${column}" FROM "${artifact.table}"`).all()).results
        assert.ok(!JSON.stringify(rows).includes(ref), `${label}: ${artifact.table}.${column}`)
        assert.ok(!JSON.stringify(rows).includes(operator!), `${label}: native id in ${artifact.table}.${column}`)
      }
      t.diagnostic(`${paired ? 'paired' : 'local'} ${label}: held write released after erasure, no retired reference, envelope unchanged`)
    } finally { await r.close() }
  }
})
