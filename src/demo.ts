import type { CrankEnv } from './crank/model'
import { canonical, digest, type Actor } from './crank/model'
import { mintToken } from './crank/tokens'

/** Real workspace records. Fixed IDs preserve visitor edits if startup repeats. */
export async function seedDemo(env: CrankEnv, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
  const owner = await env.DB.prepare('SELECT id,version FROM oa_operators WHERE email=? AND role=\'owner\'').bind(ownerEmail).first<{ id: string; version: number }>()
  if (!owner) throw new Error('Demo owner is not ready')
  const at = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString()
  const origin = env.CRANK_TARGET_ORIGIN
  if (!origin) throw new Error('Demo destination is not configured')
  const statements = [env.DB.prepare("UPDATE oa_operators SET display_name='Maya Chen' WHERE id=?").bind(owner.id), env.DB.prepare('INSERT INTO oa_first_run(singleton,completed_by,completed_at) VALUES(1,?,?) ON CONFLICT DO NOTHING').bind(owner.id, now.getTime())]
  const people = [ ['maya', 'Maya Chen', 'admin'], ['oliver', 'Oliver Hughes', 'member'], ['amelia', 'Amelia Grant', 'admin'] ]
  for (const [key, name, role] of people) statements.push(env.DB.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,version,created_at) VALUES(?,?,?,?,'active',1,?) ON CONFLICT DO NOTHING").bind(`demo-${key}`, `${key}@harbour.example`, name, role, now.getTime() - 7 * 86400000))
  const flows = [
    ['support', 'Customer follow-up', 'Support desk', 'Operations inbox', 'active'],
    ['orders', 'Order handover', 'Online store', 'Fulfilment desk', 'active'],
    ['suppliers', 'Supplier onboarding', 'Purchasing desk', 'Supplier register', 'active'],
    ['expenses', 'Expense review', 'Team expenses', 'Finance inbox', 'active'],
    ['returns', 'Returns authorisation', 'Customer care', 'Warehouse inbox', 'draft'],
    ['projects', 'Project kickoff', 'Sales pipeline', 'Project desk', 'draft'],
  ]
  const customers = ['Harbour Workshop', 'Banksia Studio', 'Northline Supply', 'Cedar House', 'Riverbend Books', 'Coastal Design']
  const tasks = ['Arrange an installation callback', 'Confirm packing and dispatch', 'Review insurance and payment details', 'Reimburse the site visit', 'Book a return collection', 'Schedule the project handover']
  for (const [index, [key, name, source, destination, status]] of flows.entries()) {
    const flowId = `demo-flow-${key}`, target = `${origin}/${key}/events`
    statements.push(env.DB.prepare('INSERT INTO crank_flows(id,name,source_app,destination_app,target_url,revision,created_by,created_at,status) VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT DO NOTHING').bind(flowId, name, source, destination, target, owner.id, at(168 + index), status))
    // Completed/rejected history remains useful when a flow is paused for revision.
    for (let n = 0; n < 4; n++) {
      const runId = `demo-run-${key}-${n + 1}`, eventId = `${key}-${1042 + n}`
      const input = { customer: customers[(index + n) % customers.length], contact: ['Sophie Martin', 'Liam Wilson', 'Grace Taylor', 'Noah Campbell'][n], task: tasks[index], reference: `HW-${2300 + index * 10 + n}`, ...(key === 'expenses' ? { amount: 86 + n * 47, currency: 'AUD' } : {}) }
      const inputJson = canonical(input), inputDigest = await digest(inputJson)
      const actionJson = canonical({ method: 'POST', target_url: target, flow_revision: 1, source_app: source, destination_app: destination, event_id: eventId, input })
      const actionDigest = await digest(actionJson), state = n === 0 && status === 'active' ? 'pending' : n === 3 ? 'rejected' : 'succeeded'
      const created = at(2 + n * 12 + index), finished = at(1.5 + n * 12 + index)
      const outcome = state === 'succeeded' ? JSON.stringify({ status: 'succeeded', code: 'destination_confirmed', uncertain: false, http_status: 200, destination_id: `demo-delivery-${runId}` }) : null
      statements.push(env.DB.prepare('INSERT INTO crank_runs(id,flow_id,event_id,input_json,input_digest,target_url,flow_revision,source_app,destination_app,action_json,action_digest,state,created_by,created_at,updated_at,outcome_json) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(runId, flowId, eventId, inputJson, inputDigest, target, source, destination, actionJson, actionDigest, state, owner.id, created, finished, outcome))
      if (state !== 'pending') statements.push(env.DB.prepare('INSERT INTO crank_approvals(id,run_id,actor_id,session_id,decision,input_digest,action_digest,action_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(`demo-approval-${key}-${n}`, runId, owner.id, 'demo-history', state === 'rejected' ? 'reject' : 'approve', inputDigest, actionDigest, actionJson, finished))
      if (state === 'succeeded') statements.push(env.DB.prepare('INSERT INTO crank_attempts(id,run_id,number,started_at,finished_at,outcome_json) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING').bind(`demo-attempt-${key}-${n}`, runId, finished, finished, outcome))
    }
  }
  await env.DB.batch(statements)
  // Use the same credential issuance rules as the Access page. Raw secrets are
  // discarded; a visitor creates a new credential to connect their own agent.
  const session = await env.DB.prepare("SELECT id,kind FROM oa_sessions WHERE operator_id=? AND kind IN ('native','dev') AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(owner.id, now.getTime()).first<{ id: string; kind: 'native' | 'dev' }>()
  if (!session) throw new Error('Demo owner session is not ready')
  const actor: Actor = { id: owner.id, name: 'Maya Chen', role: 'owner', kind: session.kind, version: owner.version, sessionId: session.id, local: env.AUTH_LOCAL === 'true' }
  for (const credential of [
    { label: 'Operations assistant', scope: 'agent' },
    { label: 'Support desk events', scope: 'trigger', flow_id: 'demo-flow-support' },
  ]) {
    if (!await env.DB.prepare('SELECT 1 FROM crank_tokens WHERE label=? AND created_by=?').bind(credential.label, owner.id).first()) await mintToken(env, actor, credential)
  }
}
