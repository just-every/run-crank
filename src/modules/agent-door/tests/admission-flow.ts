import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { autonomousPolicy } from '../conformance/crypto.mjs'
import { admissionRuntime, errorCode, input } from './admission.fixture.ts'

// Admission waits at most five seconds, then refuses decision_busy without an
// effect. A starved runner can exhaust that wait, so the call is sent again with
// renewed evidence (a refused approval is spent). A refusal before the full wait
// still fails, and the caller's counts still prove one effect and reservation.
async function untilAdmitted(first: any, send: (evidence: any) => Promise<any>, busy: (reply: any) => boolean, renew: () => Promise<any> | any) {
 for (let evidence = first, tries = 0; ; tries++) {
  const started = Date.now(), reply = await send(evidence)
  if (!busy(reply)) return reply
  assert.ok(Date.now() - started >= 5000, 'decision_busy must wait out the bounded admission first')
  assert.ok(tries < 20, 'admission must clear once contention ends')
  evidence = await renew()
 }
}

const held = () => ({ ...autonomousPolicy(), rules: [{ id: 'held', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })

export async function admissionFlow(t: TestContext) {
 const f = await admissionRuntime(), { r } = f
 try {
  await r.adopt()
  const initial = await f.create(), uri = `base://person/${initial.result.structuredContent.id}`
  const read = () => f.mcp('resources/read', { uri })
  const pendingApproval = async () => {
   const reply = await f.create(), id = (reply.result?._meta?.['com.runeditrun/approval'] ?? reply.error?.data?.approval).id
   return (await r.person(`/agents/api/approvals/${id}`)).body.approval
  }
  const approve = (view: any) => f.person(`/agents/api/approvals/${view.id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  const resourceApproval = async () => {
   const reply = await read()
   return (await r.person(`/agents/api/approvals/${(reply.result?._meta?.['com.runeditrun/approval'] ?? reply.error?.data?.approval).id}`)).body.approval
  }
  // Each door's evidence, and how its execution is sent in parallel.
  const doors: Record<string, [() => Promise<any> | any, (evidence: any) => Promise<any>]> = {
   create: [input, evidence => f.create(evidence)], resource: [() => undefined, read],
   approval: [pendingApproval, approve], 'resource-approval': [resourceApproval, approve],
  }
  for (const width of [4, 8]) for (const door of Object.keys(doors)) {
   await r.adopt(door.includes('approval') ? held() : autonomousPolicy())
   const before = await f.counts()
   const [prepare, send] = doors[door]
   const busy = (reply: any) => (door.includes('approval') ? reply.approval?.code : errorCode(reply)) === 'decision_busy'
   const calls = []
   // Prepare evidence serially; the execution door itself is parallel.
   for (let i = 0; i < width; i++) { const evidence = await prepare(); calls.push(() => untilAdmitted(evidence, send, busy, prepare)) }
   const replies = await Promise.all(calls.map(call => call()))
   for (const reply of replies) {
    if (door.includes('approval')) assert.equal(reply.approval.state, 'executed', JSON.stringify(reply))
    else { assert.equal(errorCode(reply), undefined); assert.ok(reply.result) }
   }
   const after = await f.counts(), effects = door === 'create' || door === 'approval' ? width : 0
   assert.equal(after.people - before.people, effects); assert.equal(after.effects - before.effects, effects)
   assert.equal(after.usage - before.usage, width)
   t.diagnostic(`A ordinary ${door} width=${width}: ${width}/${width}, effects=${effects}, reservations=${width}`)
  }
  await r.adopt()
  const key = input(), beforeReplay = await f.counts()
  const replays = await Promise.all(Array.from({ length: 8 }, () => untilAdmitted(key, f.create, reply => errorCode(reply) === 'decision_busy', () => key)))
  for (const reply of replays) assert.ok(!errorCode(reply) || errorCode(reply) === 'call_in_progress', JSON.stringify(reply))
  assert.equal(errorCode(await f.create(key)), undefined)
  const afterReplay = await f.counts()
  assert.equal(afterReplay.people - beforeReplay.people, 1); assert.equal(afterReplay.effects - beforeReplay.effects, 1); assert.equal(afterReplay.usage - beforeReplay.usage, 1)

  await f.waiting(() => f.create(), () => r.person('/agents/api/pause', { paused: true }), 'agents_paused')
  await r.person('/agents/api/pause', { paused: false })
  await f.waiting(read, () => r.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [r.c.consent] } }), 'unauthenticated')
  await r.adopt()
  await f.waiting(() => f.create(), () => r.person(`/agents/api/agents/${r.c.agentId}/revoke`, {}), 'unauthenticated')
  // The native owner revocation is durable; use a fresh runtime for subsequent work.
  t.diagnostic('B waiting direct Pause, consent revocation and native agent revocation: zero effects/reservations')
  t.diagnostic('A/B eight duplicate keys: one native person, one audit effect, one usage reservation')
 } finally { await r.close() }
 await guardFlow(t)
}

async function guardFlow(t: TestContext) {
 const f = await admissionRuntime(), { r } = f
 try {
  await r.adopt()
  const grant = () => r.db.prepare('INSERT OR REPLACE INTO test_grants(agent,scopes) VALUES(?,?)').bind(r.c.agentId, JSON.stringify(['people:read'])).run()
  await f.waiting(() => f.create(), grant, 'insufficient_scope')
  await r.db.prepare('DELETE FROM test_grants').run()
  const cap = { ...autonomousPolicy(), rules: [{ id: 'daily', seed: 'base', class: 'standard', do: 'autonomous', max_per_day: 1 }, { id: 'over', class: '*', do: 'blocked' }] }
  // Four current admissions compete for one unit, reserving it exactly once.
  await r.adopt(cap)
  const capped = await Promise.all(Array.from({ length: 4 }, () => f.create()))
  assert.equal(capped.filter(reply => !errorCode(reply)).length, 1)
  assert.equal(capped.filter(reply => errorCode(reply) === 'policy_blocked').length, 3)
  assert.deepEqual(await f.counts(), { people: 1, effects: 1, usage: 1 })
  await r.adopt()
  // One retained reservation consumes the changed cap when this waiter enters.
  await f.waiting(() => f.create(), () => r.adopt(cap), 'policy_blocked')
  await r.adopt()
  // A native role change keeps the token valid but removes action authority.
  const email = 'admission-admin@example.com', subject = 'admission-admin'
  assert.equal((await r.settings({ team: [{ id: subject, email, name: 'Admission admin', role: 'admin', invite: 0 }] })).status, 200)
  await r.signIn(email)
  const admin = (await r.person('/auth/operators')).body.find((person: any) => person.email === email)
  const adminToken = await r.token({ sub: subject, email, act: { sub: 'admission-admin-agent', name: 'Admission admin agent' }, scope: 'people:read people:write' })
  await f.waiting(() => f.create(input(), adminToken), () => r.person('/auth/operator/role', { operatorId: admin.id, role: 'member' }), 'operator_role_required')
  const approve = async (change: () => Promise<unknown>, expected: string) => {
   await r.adopt(held())
   const pending = await f.create(), id = pending.result._meta['com.runeditrun/approval'].id
   const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
   await f.waiting(() => f.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 }), change, expected, true)
  }
  await approve(() => r.person('/agents/api/pause', { paused: true }), 'agents_paused')
  await r.person('/agents/api/pause', { paused: false })
  await approve(() => r.adopt(held(), { revoked: { agents: [], consents: [r.c.consent] } }), 'consent_revoked')
  await approve(() => r.adopt(held()), 'approval_evidence_changed')
  await approve(grant, 'insufficient_scope')
  await r.db.prepare('DELETE FROM test_grants').run()
  // The approval's native record changes while its read is waiting.
  await r.adopt(held())
  const person = (await r.db.prepare('SELECT id FROM people LIMIT 1').first()).id
  const resource = await f.mcp('resources/read', { uri: `base://person/${person}` })
  const resourceId = resource.error.data.approval.id
  const resourceView = (await r.person(`/agents/api/approvals/${resourceId}`)).body.approval
  await f.waiting(() => f.person(`/agents/api/approvals/${resourceId}/approve`, { revision: resourceView.revision, summary_sha256: resourceView.summary_sha256 }),
   () => r.db.prepare("UPDATE people SET details=? WHERE id=?").bind(JSON.stringify({ private: 'changed' }), person).run(), 'approval_evidence_changed', true)
  const now = r.c.now
  // Keep the policy valid while the saved approval expires during admission.
  await approve(async () => {
   const next = now + 3600001
   await f.clock(next)
   await r.adopt(held(), { revision: r.c.revision })
  }, 'approval_expired')
  await f.clock(now); await r.adopt()
  const beforeBusy = await f.counts(), started = Date.now(), attempts = f.attempts()
  await f.hold()
  try { assert.equal(errorCode(await f.create()), 'decision_busy') } finally { await f.release() }
  assert.deepEqual(await f.counts(), beforeBusy)
  assert.ok(Date.now() - started < 10000, 'exhausted admission must finish within its bounded wait')
  assert.ok(f.attempts() - attempts > 1, 'busy holder was actually contended')
  // Expiry after acquisition must refuse, never renew/reacquire the old lease.
  let acquired = 0
  f.observe(async owned => { if (owned) { acquired++; await r.db.prepare('UPDATE agent_door_state SET decision_until=? WHERE id=1').bind(r.c.now - 1).run() } })
  assert.equal(errorCode(await f.create()), 'decision_busy')
  f.observe(undefined)
  assert.equal(acquired, 1); assert.deepEqual(await f.counts(), beforeBusy)
  // A newer holder cannot be released by the stale admission's cleanup.
  f.observe(async owned => { if (owned) await r.db.prepare("UPDATE agent_door_state SET decision_lock='new-holder',decision_until=? WHERE id=1").bind(r.c.now + 30000).run() })
  assert.equal(errorCode(await f.create()), 'decision_busy'); f.observe(undefined)
  assert.equal((await r.db.prepare('SELECT decision_lock FROM agent_door_state').first()).decision_lock, 'new-holder')
  assert.deepEqual(await f.counts(), beforeBusy)
  await r.db.prepare('UPDATE agent_door_state SET decision_lock=NULL,decision_until=NULL').run()
  // Exercise the same exhausted and expired-holder fences at approval execution.
  await r.adopt(held())
  const heldCreate = async () => {
   const reply = await f.create(), id = reply.result._meta['com.runeditrun/approval'].id
   return (await r.person(`/agents/api/approvals/${id}`)).body.approval
  }
  const execute = (view: any) => f.person(`/agents/api/approvals/${view.id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  const exhausted = await heldCreate()
  await f.hold()
  try { assert.equal((await execute(exhausted)).approval.code, 'decision_busy') } finally { await f.release() }
  const expired = await heldCreate()
  acquired = 0
  f.observe(async owned => { if (owned) { acquired++; await r.db.prepare('UPDATE agent_door_state SET decision_until=? WHERE id=1').bind(r.c.now - 1).run() } })
  assert.equal((await execute(expired)).approval.code, 'decision_busy'); f.observe(undefined)
  assert.equal(acquired, 1); assert.deepEqual(await f.counts(), beforeBusy)
  t.diagnostic(`B waiting scope, native role, changed cap and approval policy/consent/scope/expiry: zero effects/reservations; exhausted holder attempts=${f.attempts() - attempts}; expired/stolen leases execute zero times`)
 } finally { await r.close() }
}
