import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runtime } from './runtime.mjs'
import { heldPolicy } from '../conformance/crypto.mjs'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { unstable_splitSqlQuery: split } = require('wrangler')
const decision = (answer: any) => answer.result._meta['com.runeditrun/decision'].id
const approval = (answer: any) => answer.result._meta['com.runeditrun/approval'].id
const policy = { ...heldPolicy(), rules: heldPolicy().rules.slice(0, 1) }
const write = (r: any) => r.tool('records.write', { id: crypto.randomUUID(), value: 'Harbour annual survey', idempotency_key: crypto.randomUUID() })
async function fixture(t: any) { const r = await runtime(); t.after(() => r.close()); return r }
async function pull(r: any, business = r.c.business) {
 const iat = Math.floor(r.c.now / 1000)
 const token = await r.sign('rer-agent-decisions+jwt', { v: 1, iss: r.c.signer.issuer, aud: r.c.origin, sub: r.c.signer.installationId, business, after: 0, limit: 200, iat, exp: iat + 60, jti: crypto.randomUUID() })
 const response = await r.post('/api/rer/agent-decisions', { pull: token }), raw = await response.text()
 return { status: response.status, raw, body: raw ? JSON.parse(raw) : null }
}
async function approve(r: any, held: any) {
 const path = `/agents/api/approvals/${approval(held)}`
 const view = (await r.person(path)).body.approval
 return r.person(`${path}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
}
async function apply(r: any, file: string) {
 for (const statement of split(await readFile(new URL(file, import.meta.url), 'utf8'))) await r.db.prepare(statement).run()
}
async function memberships(r: any) {
 return (await r.db.prepare('SELECT decision_id,business FROM agent_door_relay ORDER BY decision_id').all()).results
}

test('old Business approval cannot enter the new Business feed; current Business execution does', async t => {
 const r = await fixture(t); await r.adopt(policy)
 const oldBusiness = r.c.business, oldConsent = r.c.consent, heldA = await write(r), original = decision(heldA)
 const auditA = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.id === original)
 r.c.business = 'synthetic-business-b'; r.c.consent = crypto.randomUUID(); await r.adopt(policy)
 const before = await pull(r), oldBefore = await pull(r, oldBusiness)
 const refused = await approve(r, heldA)
 assert.equal(refused.status, 200); assert.equal(refused.body.approval.code, 'approval_evidence_changed')
 const after = await pull(r)
 t.diagnostic(`A approval=${refused.body.approval.code}; B rows before=${before.body.decisions.length} after=${after.body.decisions.length}; oldConsentExposed=${after.body.decisions.some((row: any) => row.consent === oldConsent)}; executionFromA=${after.body.decisions.some((row: any) => row.execution_of === original)}`)
 assert.deepEqual(after, before, 'B must receive no new row, consent or execution link from A')
 assert.deepEqual(await pull(r, oldBusiness), oldBefore, 'A remains inaccessible while B is paired')
 assert.equal(oldBefore.status, 404)
 const retained = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.id === original)
 assert.equal(retained.consent, auditA.consent); assert.equal(retained.decision_id, null); assert.equal(retained.outcome, auditA.outcome)
 assert.equal((await memberships(r)).find((row: any) => row.decision_id === original).business, oldBusiness)
 const heldB = await write(r), executed = await approve(r, heldB)
 assert.equal(executed.body.approval.state, 'executed')
 const rows = (await pull(r)).body.decisions
 assert.equal(rows.length, 2)
 assert.ok(rows.some((row: any) => row.id === decision(heldB)))
 assert.ok(rows.some((row: any) => row.execution_of === decision(heldB) && row.consent === r.c.consent))
 assert.ok(rows.every((row: any) => row.consent !== oldConsent && row.execution_of !== original))
})

test('execution of a decision without relay membership stays out on insert and update', async t => {
 const r = await fixture(t); await r.adopt(policy)
 const held = await write(r), id = decision(held)
 // A real saved approval may predate relay adoption; retain the audit and approval.
 await r.db.prepare('DELETE FROM agent_door_relay WHERE decision_id=?').bind(id).run()
 assert.equal((await approve(r, held)).body.approval.state, 'executed')
 const execution = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.decision_id === id)
 assert.ok(execution)
 assert.deepEqual((await pull(r)).body.decisions, [], 'unattributed execution must not adopt the current Business')
 await r.db.prepare('UPDATE agent_door_audit SET row=row WHERE id=?').bind(execution.id).run()
 assert.deepEqual((await pull(r)).body.decisions, [], 'updating must not assign an unattributed execution')
})

test('forward relay migration removes only cross-Business memberships created by old triggers and converges', async t => {
 const r = await fixture(t)
 for (const name of ['insert', 'update']) await r.db.prepare(`DROP TRIGGER agent_door_relay_audit_${name}`).run()
 await apply(r, '../../../default-seed/migrations/core/0040_agent_door_relay.sql')
 await r.adopt(policy)
 const heldA = await write(r), oldBusiness = r.c.business
 r.c.business = 'synthetic-business-b'; r.c.consent = crypto.randomUUID(); await r.adopt(policy)
 await approve(r, heldA)
 const heldB = await write(r); await approve(r, heldB)
 const leaked = (await pull(r)).body.decisions.find((row: any) => row.execution_of === decision(heldA))
 assert.ok(leaked, 'old triggers reproduce the deployed cross-Business execution membership')
 const beforeAudit = (await r.db.prepare('SELECT * FROM agent_door_audit ORDER BY sequence').all()).results
 const beforeMembership = await memberships(r)
 const count = await r.db.prepare(`SELECT COUNT(*) AS n FROM agent_door_relay r JOIN agent_door_audit a ON a.id=r.decision_id
   JOIN agent_door_relay parent ON parent.decision_id=json_extract(a.row,'$.decision_id') WHERE parent.business<>r.business`).first('n')
 assert.equal(count, 1)
 await apply(r, '../../../default-seed/migrations/core/0043_agent_door_relay_privacy.sql')
 const after = await memberships(r)
 assert.deepEqual(after, beforeMembership.filter((row: any) => row.decision_id !== leaked.id))
 assert.equal(after.find((row: any) => row.decision_id === decision(heldA)).business, oldBusiness)
 assert.deepEqual((await r.db.prepare('SELECT * FROM agent_door_audit ORDER BY sequence').all()).results, beforeAudit)
 const page = await pull(r)
 assert.equal(page.body.decisions.length, 2)
 await apply(r, '../../../default-seed/migrations/core/0043_agent_door_relay_privacy.sql')
 assert.deepEqual(await memberships(r), after); assert.deepEqual(await pull(r), page)
 // Exercise both recreated triggers through the next approval execution and its audit upsert.
 const next = await write(r); await approve(r, next)
 assert.ok((await pull(r)).body.decisions.some((row: any) => row.execution_of === decision(next)))
 const audit = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.decision_id === decision(heldA))
 await r.db.prepare('UPDATE agent_door_audit SET row=row WHERE id=?').bind(audit.id).run()
 assert.ok(!(await pull(r)).body.decisions.some((row: any) => row.id === leaked.id))
 assert.equal((await memberships(r)).find((row: any) => row.decision_id === leaked.id).business, oldBusiness)
 t.diagnostic('Old triggers: 1 cross-Business membership; migration twice: only that membership removed, all audits intact; recreated insert/update retain original Business')
})
