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

// A Business stop is a signed detach or the owner's stop. Both end every authority the door derived from Business.
for (const mode of ['detach', 'owner'] as const) test(`A Business stop (${mode}) ends Business tokens, held calls and Business refs; policy, seed and native access continue`, async () => {
 const r = await runtime()
 try {
  assert.equal((await r.settings({team:[member('synthetic-base-a','synthetic-base-a@example.com'),member('synthetic-base-b','synthetic-base-b@example.com')]})).status,200)
  const cookieA = await r.signIn('synthetic-base-a@example.com'), cookieB = await r.signIn('synthetic-base-b@example.com')
  await r.adopt()
  const agent = (sub: string, email: string) => r.token({sub,email,act:{sub:`${sub}-agent`,name:sub}})
  const tokenA = await agent('synthetic-base-a','synthetic-base-a@example.com'), tokenB = await agent('synthetic-base-b','synthetic-base-b@example.com')
  const write = (id: string, value = 'v') => ({id,value,idempotency_key:crypto.randomUUID()})
  const record = async (id: string) => (await r.db.prepare('SELECT value FROM test_records WHERE id=?').bind(id).first() as any)?.value ?? null
  const approve = async (cookie: string, id: string) => {
   const view = await r.fetch(`/agents/api/approvals/${id}`,{headers:{cookie}})
   if (view.status !== 200) return {status:view.status}
   const { approval } = await view.json() as any, done = await r.post(`/agents/api/approvals/${id}/approve`,{revision:approval.revision,summary_sha256:approval.summary_sha256},{cookie})
   const body = await done.json() as any
   return {status:done.status,state:body.approval?.state,code:body.approval?.code}
  }
  const listen = (token: string) => r.post('/mcp',{jsonrpc:'2.0',id:'sub',method:'subscriptions/listen',params:{notifications:{toolsListChanged:true},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}},{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'subscriptions/listen',Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream'})
  // Before the stop: a call held for approval, a call waiting for admission, and an open subscription.
  assert.equal((await r.tool('records.write',write('held'),{token:tokenA})).result.isError,false)
  await r.adopt(heldPolicy())
  const held = (await r.tool('records.erase',{id:'held',idempotency_key:crypto.randomUUID()},{token:tokenA})).result._meta['com.runeditrun/approval'].id
  const subscription = (await listen(tokenA)).body!.getReader()
  await r.db.prepare("UPDATE agent_door_state SET decision_lock='held-by-test',decision_until=? WHERE id=1").bind(r.c.now + 600000).run()
  const waiting = r.tool('records.write',write('waiting','late'),{token:tokenA})
  await new Promise(resolve => setTimeout(resolve,300))
  if (mode === 'detach') assert.equal((await r.settings({detached:true})).status,200)
  else await r.db.prepare('UPDATE bs_settings SET stopped=1 WHERE singleton=1').run()
  await r.db.prepare("UPDATE agent_door_state SET decision_lock=NULL,decision_until=NULL WHERE id=1").run()
  // 1. No Business token is admitted on any method, for the owner, a roster member or anyone else; subscriptions close.
  for (const token of [await r.token(),tokenA,tokenB,await agent('synthetic-base-unmapped','synthetic-base-a@example.com')]) {
   for (const method of ['server/discover','tools/list','tools/call','resources/read','subscriptions/listen']) {
    const reply = await r.mcp(method,method === 'tools/call' ? {name:'synthetic.records.list',arguments:{}} : method === 'resources/read' ? {uri:'synthetic://record/x'} : {},{token})
    assert.equal(reply.status,401,method); assert.match(reply.headers.get('www-authenticate') ?? '',/resource_metadata=/)
   }
  }
  const ended = await Promise.race([(async () => { for (;;) if ((await subscription.read()).done) return true })(),new Promise(resolve => setTimeout(() => resolve(false),5000))])
  assert.equal(ended,true); await subscription.cancel().catch(() => {})
  // 2. The call that was waiting and the call held for approval do not execute: no native effect.
  const late = await waiting
  assert.equal(code(late),'sponsor_unavailable'); assert.equal(await record('waiting'),null)
  assert.deepEqual(await approve(cookieA,held),{status:200,state:'refused',code:'sponsor_unavailable'}); assert.equal(await record('held'),'v')
  // 5. Seed credentials and native sessions are unchanged.
  assert.equal((await r.tool('records.write',write('seed','ok'),{token:r.localToken})).result.isError,false)
  for (const id of ['editor','person','owner','sponsor']) await r.tool('records.write',write(id),{token:r.localToken})
  assert.equal((await r.person('/agents/api/state')).status,200)
  // 4. Policy naming Business people is still adopted after the stop, and Pause applies.
  const named = (...approver: string[]) => ({...autonomousPolicy(),rules:[{id:'hold',class:'*',do:'approval',approver,wait:'PT1H'}]})
  assert.equal((await r.adopt(named(`person:${r.c.person.sub}`))).status,200)
  // 3. Business approver refs match nobody; a sponsor ref still matches its native person.
  for (const [ref,id] of [['role:editor','editor'],['person:synthetic-base-b','person'],['role:owner','owner']] as const) {
   assert.equal((await r.adopt(named(ref))).status,200)
   const pending = (await r.tool('records.erase',{id,idempotency_key:crypto.randomUUID()},{token:r.localToken})).result._meta['com.runeditrun/approval'].id
   assert.equal((await approve(ref === 'role:owner' ? r.c.person.cookie : cookieB,pending)).status,403)
   assert.equal(await record(id),'v')
  }
  assert.equal((await r.adopt(named('sponsor'))).status,200)
  const own = (await r.tool('records.erase',{id:'sponsor',idempotency_key:crypto.randomUUID()},{token:r.localToken})).result._meta['com.runeditrun/approval'].id
  assert.deepEqual(await approve(r.c.person.cookie,own),{status:200,state:'executed',code:null})
  assert.equal((await r.adopt(autonomousPolicy(),{paused:true})).status,200)
  assert.equal(code(await r.tool('records.list',{},{token:r.localToken})),'agents_paused')
  assert.equal((await r.post('/api/rer/business-settings',{})).status,404)
  assert.equal(((await r.db.prepare('SELECT count(*) AS n FROM bs_team').first()) as any).n,2)
 } finally {await r.close()}
})
