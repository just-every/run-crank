import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { createAgentDoor, operatorAuthPeople } from '../index.ts'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'

const code = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
const member = (id: string, email: string) => ({ id, email, name: id, role: 'admin', invite: 0 })

test('Business subjects, sponsor approvals and Business refs retain their people across address and native role changes', async () => {
 const r = await runtime()
 try {
  const email = 'synthetic-base-a@example.com', otherEmail = 'synthetic-base-b@example.com'
  assert.equal((await r.settings({team:[member('synthetic-base-a',email),member('synthetic-base-b',otherEmail)]})).status,200)
  let cookieX = await r.signIn(email), cookieB = await r.signIn(otherEmail)
  const x = (await r.db.prepare("SELECT operator_id FROM bs_team WHERE business_id='synthetic-base-a'").first()).operator_id
  const b = (await r.db.prepare("SELECT operator_id FROM bs_team WHERE business_id='synthetic-base-b'").first()).operator_id
  await r.adopt()
  const token = await r.token({sub:'synthetic-base-a',email,act:{sub:'synthetic-base-agent-a',name:'Synthetic Agent A'}})
  const tool = (name: string, args: any) => r.tool(name,args,{token})
  const write = (value: string) => ({id:'synthetic-base-record',value,idempotency_key:crypto.randomUUID()})
  assert.equal((await tool('records.write',write('synthetic-base-1'))).result.isError,false)
  assert.equal((await r.mcp('tools/list',{}, {token:await r.token({sub:'synthetic-base-unmapped',email})})).status,401)
  await r.adopt(heldPolicy())
  const input = {id:'synthetic-base-record',idempotency_key:crypto.randomUUID()}
  const held = await tool('records.erase',input), approval = held.result._meta['com.runeditrun/approval']
  await r.db.prepare('UPDATE oa_operators SET email=? WHERE id=?').bind('synthetic-base-x-new@example.com',x).run()
  await r.db.prepare('UPDATE oa_operators SET email=? WHERE id=?').bind(email,b).run()
  const person = async (cookie: string, path: string, body?: any) => {
   const response = body === undefined ? await r.fetch(path,{headers:{cookie}}) : await r.post(path,body,{cookie})
   return {status:response.status,body:await response.json()}
  }
  const view = (await person(cookieX,`/agents/api/approvals/${approval.id}`)).body.approval
  const choice = {revision:view.revision,summary_sha256:view.summary_sha256}
  assert.equal((await person(cookieB,`/agents/api/approvals/${approval.id}/approve`,choice)).status,403)
  assert.equal((await person(cookieX,`/agents/api/approvals/${approval.id}/approve`,choice)).body.approval.state,'executed')
  const execution = (await r.person('/agents/api/audit')).body.rows.find((row: any) => row.decision_id === held.result._meta['com.runeditrun/decision'].id)
  assert.equal(execution.sponsor.id,x); assert.notEqual(execution.sponsor.id,b); assert.deepEqual(execution.approval.by,[x])
  await r.adopt()
  assert.equal((await tool('records.write',write('synthetic-base-2'))).result.isError,false)
  const embedded = createAgentDoor({seed:'synthetic',name:'Synthetic',specialist:'operations',db:r.db,origin:r.c.origin,trust:{issuer:r.c.signer.issuer,installationId:r.c.signer.installationId,appOrigin:r.c.origin,publicKeys:{[r.c.signer.kid]:await crypto.subtle.exportKey('jwk',r.c.ring.publicKey)}},people:operatorAuthPeople({db:r.db,session:async()=>null}),tools:[{
   name:'synthetic.person.read',title:'Read sponsor',description:'Read the current native sponsor.',scope:'records:read',readOnly:true,inputSchema:{type:'object',additionalProperties:false},outputSchema:{type:'object'},classes:['standard'],clauses:['BASE-AGENT-005'],classify:()=>[{class:'standard',facts:{measure:1}}],run:async(_args,ctx)=>({result:{id:ctx.person.id,email:ctx.person.email}}),
  }]})
  const invoked=await embedded.invoke('synthetic.person.read',{}, {person:{id:x,email,name:'Synthetic A',role:'admin',active:true},agent:{id:'synthetic-base-embedded-identity',name:'Synthetic Embedded'},scopes:['records:read']})
  assert.deepEqual(invoked.result,{id:x,email:'synthetic-base-x-new@example.com'})
  const embeddedRow=(await r.person('/agents/api/audit')).body.rows.find((row:any)=>row.agent.id==='synthetic-base-embedded-identity')
  assert.equal(embeddedRow.door,'embedded');assert.equal(embeddedRow.sponsor.id,x)
  const contexts = (await r.db.prepare("SELECT person FROM test_contexts WHERE kind='run'").all()).results
  assert.ok(contexts.every((row: any)=>row.person===x))
  assert.ok((await r.person('/agents/api/audit')).body.rows.filter((row: any)=>row.agent.id==='synthetic-base-agent-a').every((row: any)=>row.sponsor.id===x))
  await r.db.prepare("UPDATE oa_operators SET status='inactive' WHERE id=?").bind(x).run()
  assert.equal((await tool('records.list',{})).status,401)
  await r.db.prepare("UPDATE oa_operators SET status='active' WHERE id=?").bind(x).run()
  cookieX = await r.signIn('synthetic-base-x-new@example.com')
  // Business editor authority is independent of the role an agent can change locally.
  await r.db.prepare("UPDATE bs_team SET business_role='member' WHERE operator_id=?").bind(b).run()
  await r.db.prepare("UPDATE oa_operators SET role='member' WHERE id=?").bind(b).run()
  assert.equal((await tool('access.change',{id:b,role:'admin',idempotency_key:crypto.randomUUID()})).result.isError,false)
  assert.equal((await r.db.prepare('SELECT role FROM oa_operators WHERE id=?').bind(b).first()).role,'admin')
  cookieB = await r.signIn(email)
  const policy = {...autonomousPolicy(),rules:[{id:'hold',class:'*',do:'approval',approver:['role:editor'],wait:'PT1H'}]}
  assert.equal((await r.adopt(policy)).status,200)
  const waiting = await tool('records.write',write('synthetic-base-editor'))
  const id = waiting.result._meta['com.runeditrun/approval'].id
  const body = (await person(cookieX,`/agents/api/approvals/${id}`)).body.approval
  const exact = {revision:body.revision,summary_sha256:body.summary_sha256}
  assert.equal((await person(cookieB,`/agents/api/approvals/${id}/approve`,exact)).status,403)
  await r.db.prepare("DELETE FROM bs_team WHERE operator_id=?").bind(b).run()
  assert.equal((await person(cookieB,`/agents/api/approvals/${id}/approve`,exact)).status,403)
  assert.equal((await person(cookieX,`/agents/api/approvals/${id}/approve`,exact)).body.approval.state,'executed')
  const native = await r.db.prepare("SELECT person,agent,approvers FROM test_contexts WHERE kind='run' ORDER BY rowid DESC LIMIT 1").first()
  assert.equal(native.person,x); assert.equal(native.agent,'synthetic-base-agent-a'); assert.deepEqual(JSON.parse(native.approvers).map((p: any)=>p.id),[x])
  await r.adopt()
  for(const subject of [x,'SYNTHETIC-BASE-X-NEW@EXAMPLE.COM','synthetic-base-agent-a']) assert.equal(code(await tool('access.change',{id:subject,idempotency_key:crypto.randomUUID()})),'self_escalation')
  assert.equal((await tool('access.change',{id:x,role:'member',idempotency_key:crypto.randomUUID()})).result.isError,false)
  assert.equal((await r.db.prepare('SELECT role FROM oa_operators WHERE id=?').bind(x).first()).role,'member')
  const unresolved = await r.adopt({...policy,rules:[{...policy.rules[0],approver:['person:synthetic-base-unmapped']}]})
  assert.equal(unresolved.status,400); assert.equal(unresolved.body.code,'policy_refs_unresolved')
  const state = (await r.person('/agents/api/state')).body
  assert.equal(state.policy.revision,r.c.revision)
 } finally {await r.close()}
})
