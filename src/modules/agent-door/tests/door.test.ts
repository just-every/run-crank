import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runtime } from './runtime.mjs'
import { createAgentDoor } from '../index.ts'
import { autonomousPolicy, heldPolicy, policyEnvelope } from '../conformance/crypto.mjs'
import { runAgentDoorConformance } from '../conformance/index.mjs'
import { decide } from '../policy/decide.ts'

const decision = (answer: any) => answer.result?._meta?.['com.runeditrun/decision']
const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const pending = (answer: any) => answer.result?._meta?.['com.runeditrun/approval']
const args = (value = 'synthetic-base-1', key = crypto.randomUUID()) => ({ id: 'synthetic-base-1', value, idempotency_key: key })
const rows = async (r: any) => (await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results

// Each case exercises a public HTTP flow with real D1 and native owner sessions.
test('policy adoption closes the door until answered and preserves the last valid envelope', async () => {
 const r = await runtime()
 try {
  const listed = await r.mcp('tools/list'); assert.deepEqual(listed.result.tools, [])
  const refused = await r.tool('records.write', args()); assert.equal(code(refused), 'policy_unset'); assert.equal(decision(refused).disposition, 'unset'); assert.deepEqual(await rows(r), [])
  const setup = refused.result._meta['com.runeditrun/error'].setup_url; assert.equal(new URL(setup).origin, r.c.origin)
  const correlation = async (expected: string, tool = 'records.write') => {
   const key = crypto.randomUUID(), trace = '00-11111111111111111111111111111111-1111111111111111-01'
   const reply = await r.mcp('tools/call', { name: `synthetic.${tool}`, arguments: { ...args(), idempotency_key: key, confirmExternal: true }, _meta: { traceparent: trace } })
   assert.equal(code(reply), expected)
   const records = (await r.person('/agents/api/audit')).body.rows.filter((row: any) => row.idempotency_key === key)
   assert.equal(records.length, 1); assert.equal(records[0].trace, trace); assert.deepEqual(records[0].ignored_arguments, tool === 'records.write' ? ['confirmExternal'] : ['confirmExternal','value'])
  }
  await correlation('policy_unset')
  const adopted = await r.adopt(); assert.equal(adopted.status, 200)
  assert.deepEqual(Object.keys(adopted.body).sort(), ['adopted','door'])
  assert.deepEqual(adopted.body.adopted, { seq: r.c.seq, revision: r.c.revision })
  const expected = ['access','destructive','external','sensitive','standard']; assert.deepEqual(adopted.body.door.classes.map((item: any) => item.class).sort(), expected)
  const before = (await r.person('/agents/api/state')).body
  for (const overrides of [{ seq: 0 }, { aud: 'https://synthetic-base-3.invalid' }, { sub: 'synthetic-base-3' }, { iss: 'https://synthetic-base-3.invalid' }, { exp: Math.floor(r.c.now/1000)-1 }, { revision_signature: 'synthetic-base-invalid' }]) {
   assert.notEqual((await r.adopt(autonomousPolicy(), overrides)).status, 200)
   assert.deepEqual((await r.person('/agents/api/state')).body, before)
  }
  const invalid = await policyEnvelope(r.c, autonomousPolicy()); invalid.policy = invalid.policy.slice(0,-8)+'AAAAAAAA'
  assert.notEqual((await r.post('/api/rer/agent-policy', { policy: invalid.policy })).status, 200)
  const refreshed = await r.adopt(autonomousPolicy(), { seq: r.c.seq, revision: r.c.revision, iat: Math.floor(r.c.now/1000)+1 }); assert.equal(refreshed.status, 200)
  const partial = autonomousPolicy(); partial.rules = [{ id:'standard',class:'standard',do:'autonomous' }]
  await r.adopt(partial); await correlation('policy_unset', 'records.erase'); const names = (await r.mcp('tools/list')).result.tools.map((t: any) => t.name)
  assert.ok(names.includes('synthetic.records.write')); assert.ok(!names.includes('synthetic.records.erase'))
  assert.equal(code(await r.tool('records.erase', { id:'synthetic-base-1',idempotency_key:crypto.randomUUID() })), 'policy_unset')
  await r.adopt(null); assert.equal(code(await r.tool('records.list', {})), 'policy_unset'); assert.deepEqual(await rows(r), [])
  await r.adopt(autonomousPolicy(), { paused: true }); await correlation('agents_paused')
  await r.adopt(); await r.setNow(r.c.now+301000); await correlation('policy_unavailable'); assert.equal(code(await r.tool('records.list', {})), 'policy_unavailable')
  await r.adopt(); assert.equal((await r.tool('records.list', {})).result.isError, false)
  await r.setNow(r.c.now + 86400000)
  await r.adopt({ ...autonomousPolicy(), rules: [{ id:'base',class:'standard',do:'blocked' }, { id:'daily',class:'standard',do:'autonomous',seed:'synthetic',max_per_day:2 }] })
  assert.equal((await r.tool('records.write',args('synthetic-base-day-1'))).result.isError,false)
  assert.equal((await r.tool('records.write',args('synthetic-base-day-2'))).result.isError,false)
  assert.equal(code(await r.tool('records.write',args('synthetic-base-day-3'))),'policy_blocked')
  assert.equal((await r.person('/agents/api/audit')).body.differs_from_policy,0)
  const { db, ...options } = { db:r.db, seed:'synthetic',name:'Synthetic',specialist:'operations',origin:r.c.origin,trust:null,people:{sponsor:async()=>null,person:async()=>null,session:async()=>null}, tools:[] }; void db
  const sample = { name:'synthetic.records.list', title:'Read',description:'Read',scope:'records:read',readOnly:true,inputSchema:{type:'object'},outputSchema:{type:'object'},classes:['standard'],clauses:[],classify:()=>[],run:async()=>({result:{}}) }
  for (const tools of [[{...sample,classes:['uncatalogued']}],[{...sample,name:'foreign.records.list'}],[sample,sample],[{...sample,outputSchema:undefined}]]) assert.throws(()=>createAgentDoor({...options,db:r.db,tools} as any))
 } finally { await r.close() }
})

test('autonomous and review actions retain one outcome, native refusals, undo, audit and event identities', async () => {
 const r = await runtime()
 try {
  await r.adopt()
  const input = args(), first = await r.tool('records.write', { ...input, confirmExternal:true, internal:true, classes:['external'] })
  assert.equal(first.result.isError,false); assert.deepEqual(decision(first).classes.map((c:any)=>c.class), ['standard'])
  const snapshot = await rows(r), replay = await r.tool('records.write', input)
  assert.deepEqual(replay.result.structuredContent,first.result.structuredContent); assert.deepEqual(await rows(r),snapshot)
  assert.equal(code(await r.tool('records.write',{...input,value:'synthetic-base-2'})),'idempotency_conflict')
  assert.equal(code(await r.tool('records.write',{id:'synthetic-base-1',value:'synthetic-base-2'})),'idempotency_key_required')
  assert.equal(code(await r.tool('records.write',{...args(),expected_revision:0})),'revision_conflict')
  assert.equal(code(await r.tool('records.write',args('synthetic-base-refused'))),'native_refused')
  assert.equal(code(await r.tool('records.write',{...args(),value:1})),'invalid_arguments')
  const bad = args('synthetic-base-invalid'); assert.equal(code(await r.tool('records.write',bad)),'output_invalid'); assert.equal(code(await r.tool('records.write',bad)),'output_invalid')
  await r.adopt(heldPolicy())
  const reviewed = await r.tool('records.write',args('synthetic-base-review')); const id = reviewed.result._meta['com.runeditrun/review'].id
  assert.equal(decision(reviewed).disposition,'review'); assert.equal((await r.person(`/agents/api/reviews/${id}/flag`,{note:'Synthetic observation'})).status,200)
  assert.equal((await r.person(`/agents/api/reviews/${id}/reviewed`,{})).body.review.state,'reviewed')
  assert.equal((await r.person(`/agents/api/reviews/${id}/undo`,{})).body.review.state,'undone')
  await r.adopt()
  const read = await r.mcp('resources/read',{uri:'synthetic://record/synthetic-base-1'}); assert.equal(read.result.contents[0]._meta['com.runeditrun/untrusted'],true)
  await r.db.prepare("INSERT INTO test_records VALUES('synthetic-base-hidden','synthetic-base-hidden',1,'hidden')").run()
  const hidden = await r.mcp('resources/read',{uri:'synthetic://record/synthetic-base-hidden'}), missing = await r.mcp('resources/read',{uri:'synthetic://record/synthetic-base-missing'}); assert.deepEqual(hidden.error,missing.error)
  const audit = (await r.person('/agents/api/audit')).body
  assert.equal(audit.differs_from_policy,0); assert.equal(audit.rows.length,13)
  assert.deepEqual(audit.rows[0].ignored_arguments,['classes','confirmExternal','internal']); assert.equal(audit.rows[1].outcome,'replayed'); assert.equal(audit.rows[1].replay_of,audit.rows[0].id)
  assert.ok(audit.rows.every((row:any)=>row.label==='Agent door conformance for Synthetic Person'))
  await r.adopt(); const events = (await r.tool('events.list',{limit:200})).result.structuredContent.events
  const callbacks = (await r.db.prepare('SELECT event FROM test_callbacks ORDER BY rowid').all()).results.map((row:any)=>JSON.parse(row.event))
  assert.deepEqual(events,callbacks); assert.ok(events.some((e:any)=>e.type==='review.flagged'&&e.actor.kind==='person'))
  const cursor = events[0].id; assert.deepEqual((await r.tool('events.list',{after:cursor,limit:200})).result.structuredContent.events,events.slice(1))
 } finally { await r.close() }
})

test('approval waits, names its person, executes once, rejects, expires and detects changed evidence', async () => {
 const r = await runtime()
 try {
  await r.adopt(); await r.tool('records.write',args())
  await r.adopt(heldPolicy())
  const input = {id:'synthetic-base-1',idempotency_key:crypto.randomUUID()}, before=await rows(r)
  const call = await r.tool('records.erase',input), id=pending(call).id
  assert.equal(call.result.resultType,'input_required'); assert.ok(call.result.inputRequests.approval); assert.deepEqual(await rows(r),before)
  assert.equal((await r.tool('records.erase',input)).result.requestState,call.result.requestState)
  assert.equal(code(await r.tool('records.erase',input,{version:'2025-11-25'})),'approval_required')
  assert.equal((await r.person(`/agents/api/approvals/${id}/approve`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${id}`)).body.approval.summary_sha256}, {authorization:`Bearer ${await r.token()}`})).status,403)
  assert.equal((await r.person(`/agents/api/approvals/${id}/approve`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${id}`)).body.approval.summary_sha256})).status,200); assert.deepEqual(await rows(r),[])
  const completed=await r.tool('records.erase',input), receipt=completed.result._meta['com.runeditrun/receipt']; assert.equal(receipt.approval_id,id); assert.ok(receipt.approved_by.length)
  await r.person(`/agents/api/approvals/${id}/approve`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${id}`)).body.approval.summary_sha256}); assert.deepEqual((await r.tool('records.erase',input)).result.structuredContent,completed.result.structuredContent)
  const rejectedArgs={id:'synthetic-base-2',idempotency_key:crypto.randomUUID()}, rejected=await r.tool('records.erase',rejectedArgs)
  await r.person(`/agents/api/approvals/${pending(rejected).id}/reject`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${pending(rejected).id}`)).body.approval.summary_sha256}); assert.equal(code(await r.tool('records.erase',rejectedArgs)),'approval_rejected')
  const expArgs={id:'synthetic-base-3',idempotency_key:crypto.randomUUID()}, exp=await r.tool('records.erase',expArgs)
  await r.setNow(r.c.now+3601000); await r.adopt(heldPolicy(),{revision:r.c.revision})
  assert.equal((await r.person(`/agents/api/approvals/${pending(exp).id}/approve`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${pending(exp).id}`)).body.approval.summary_sha256})).body.code,'approval_expired'); assert.equal(code(await r.tool('records.erase',expArgs)),'approval_expired')
  const changedArgs={id:'synthetic-base-4',idempotency_key:crypto.randomUUID()}, changed=await r.tool('records.erase',changedArgs)
  await r.db.prepare("INSERT INTO test_records VALUES('synthetic-base-4','synthetic-base-4',1,'internal')").run()
  await r.person(`/agents/api/approvals/${pending(changed).id}/approve`,{revision:r.c.revision,summary_sha256:(await r.person(`/agents/api/approvals/${pending(changed).id}`)).body.approval.summary_sha256}); assert.equal(code(await r.tool('records.erase',changedArgs)),'approval_evidence_changed')
  const changedExecution=(await r.person('/agents/api/audit')).body.rows.find((row:any)=>row.decision_id===decision(changed).id)
  assert.equal(changedExecution.classes[0].facts.measure,1)
  await r.adopt({...autonomousPolicy(),rules:[{id:'block',class:'*',do:'blocked'}]})
  assert.equal(code(await r.tool('records.erase',{id:'synthetic-base-4',idempotency_key:crypto.randomUUID()})),'policy_blocked'); assert.equal((await rows(r)).length,1)
  const person=(await r.db.prepare('SELECT id FROM oa_operators').first()).id
  await r.adopt(); assert.equal(code(await r.tool('access.change',{id:person,idempotency_key:crypto.randomUUID()})),'self_escalation')
  assert.equal((await r.person('/agents/api/audit')).body.differs_from_policy,0)
 } finally { await r.close() }
})

test('credentials, pause, embedded calls, subscriptions and the generic conformance journey share the live door', async () => {
 const r = await runtime()
 try {
  await r.adopt()
  for (const method of ['GET','DELETE']) assert.equal((await r.fetch('/mcp',{method})).status,405)
  assert.equal((await r.mcp('synthetic/unknown')).status,404)
  const legacy=await r.post('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{}}}); assert.equal((await legacy.json()).result.protocolVersion,'2025-11-25')
  const valid=await r.token(), payload=JSON.parse(Buffer.from(valid.split('.')[1],'base64url').toString())
  for (const bad of [await r.sign('at+jwt',payload,'synthetic-base-unknown'),await r.sign('other+jwt',payload),valid.slice(0,-8)+'AAAAAAAA']) assert.equal((await r.mcp('tools/list',{}, {token:bad})).status,401)
  for (const token of [null,await r.token({aud:'https://synthetic-base-3.invalid/mcp'}),await r.token({exp:Math.floor(r.c.now/1000)-1}),await r.token({exp:Math.floor(r.c.now/1000)+901}),await r.token({business:'synthetic-base-3'}),await r.sign('other+jwt',{}),await r.sign('at+jwt',{},'synthetic-base-unknown')]) assert.equal((await r.mcp('tools/list',{}, {token})).status,401)
  assert.equal((await r.tool('records.write',args(),{token:await r.token({scope:'events:read'})})).status,403)
  await r.adopt(autonomousPolicy(),{paused:true}); assert.equal(code(await r.tool('records.list',{})),'agents_paused'); assert.equal((await r.person('/agents/api/state')).status,200)
  await r.adopt(); await r.person('/agents/api/pause',{paused:true}); assert.equal(code(await r.tool('records.list',{})),'agents_paused'); await r.person('/agents/api/pause',{paused:false})
  const embedded=await r.person('/__embedded',{}); assert.equal(embedded.body.outcome,'done')
  await r.tool('records.write',args())
  const listenBody={jsonrpc:'2.0',id:'synthetic-base-subscription',method:'subscriptions/listen',params:{notifications:{resourceSubscriptions:['synthetic://record/synthetic-base-1'],toolsListChanged:true},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}}
  const stream=await r.post('/mcp',listenBody,{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'subscriptions/listen',Authorization:`Bearer ${await r.token()}`})
  const reader=stream.body.getReader(), decoder=new TextDecoder(); assert.match(decoder.decode((await reader.read()).value),/notifications\/subscriptions\/acknowledged/)
  await r.person('/__emit',{}); const notification=decoder.decode((await reader.read()).value); assert.match(notification,/notifications\/resources\/updated/); await reader.cancel()
  const otherToken = await r.token({act:{sub:'synthetic-base-other',name:'Synthetic Other Agent',specialist:'operations'}})
  assert.equal((await r.mcp('tools/list',{}, {token:otherToken})).status,200)
  assert.equal((await r.person('/agents/api/agents/synthetic-base-1/revoke',{})).status,200)
  assert.equal((await r.mcp('tools/list')).status,401)
  assert.equal((await r.mcp('tools/list',{}, {token:otherToken})).status,200)
  await r.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('synthetic-base-2','synthetic-base-2@example.com','Synthetic Other','owner','active',0)").run()
  await r.db.prepare("UPDATE oa_operators SET status='inactive' WHERE email='synthetic-base-1@example.com'").run(); assert.equal((await r.mcp('tools/list')).status,401); await r.db.prepare("UPDATE oa_operators SET status='active' WHERE email='synthetic-base-1@example.com'").run()
  const vectors=JSON.parse(await readFile(new URL('../policy/vectors.json',import.meta.url),'utf8'))
  for(const vector of vectors) assert.deepEqual(decide({...vector,usageToday:(rule:any,cls:any)=>vector.usageToday[`${rule.id}:${cls}`]??0}),vector.expected,vector.name)
 } finally { await r.close() }
 const admission = await runtime()
 try {
  await admission.adopt()
  assert.equal((await admission.settings({team:[{id:'synthetic-base-member',email:'synthetic-base-admin@example.com',name:'Synthetic Admin',role:'admin',invite:0}]})).status,200)
  await admission.db.prepare("UPDATE oa_operators SET status='active' WHERE id=(SELECT operator_id FROM bs_team WHERE business_id='synthetic-base-member')").run()
  const token = await admission.token({ sub:'synthetic-base-member',email: 'synthetic-base-admin@example.com' })
  const call = (name: string, arguments_: any) => admission.tool(name, arguments_, { token })
  assert.equal((await call('records.write',args())).result.isError, false)
  assert.equal((await call('records.list',{})).result.isError, false)
  assert.ok((await admission.mcp('resources/read',{uri:'synthetic://record/synthetic-base-1'},{token})).result.contents)
  await admission.post('/__allowlist',{ emails: [admission.c.person.email] })
  assert.equal((await call('records.list',{})).status,401)
  assert.equal((await call('records.write',args('synthetic-base-excluded'))).status,401)
  assert.equal((await admission.mcp('resources/read',{uri:'synthetic://record/synthetic-base-1'},{token})).status,401)
  await admission.post('/__allowlist',{ emails: [admission.c.person.email,'synthetic-base-admin@example.com'] })
  assert.equal((await call('records.list',{})).result.isError,false)
  assert.equal((await call('records.write',args())).result.isError,false)
  assert.ok((await admission.mcp('resources/read',{uri:'synthetic://record/synthetic-base-1'},{token})).result.contents)
 } finally { await admission.close() }
 const rate=await runtime({limits:{requestsPerMinute:3}})
 try {
  const capacity=(await rate.mcp('server/discover')).result._meta['com.runeditrun/limits'].requestsPerMinute
  for(let i=0;i<capacity;i++)assert.equal((await rate.mcp('tools/list')).status,200)
  const refused=await rate.mcp('tools/list');assert.equal(refused.status,429);assert.ok(Number(refused.headers.get('retry-after'))>0)
 } finally {await rate.close()}
 const local=await runtime({paired:false})
 try {
  assert.equal((await local.adopt()).status,404)
  assert.equal((await local.person('/agents/api/pause',{paused:true})).body.paused.local,true)
  assert.equal(code(await local.tool('records.list',{}, {token:'synthetic-base-local'})),'agents_paused')
  await local.person('/agents/api/pause',{paused:false})
  assert.equal((await local.mcp('tools/list')).status,401)
  assert.equal((await local.person('/agents/api/policy',{document:autonomousPolicy()})).status,405)
  const incomplete=await local.fetch('/agents/api/policy',{method:'PUT',headers:{origin:local.c.origin,cookie:local.c.person.cookie,'content-type':'application/json'},body:JSON.stringify({document:{...autonomousPolicy(),rules:[],spend:undefined}})}); assert.equal(incomplete.status,409); assert.ok((await incomplete.json()).problems.some(p=>p.kind==='spend'))
  const saved=await local.fetch('/agents/api/policy',{method:'PUT',headers:{origin:local.c.origin,cookie:local.c.person.cookie,'content-type':'application/json'},body:JSON.stringify({document:autonomousPolicy()})}); assert.equal(saved.status,200)
  assert.equal((await local.mcp('tools/list',{}, {token:'synthetic-base-local'})).status,200)
 } finally { await local.close() }
 const fresh=await runtime({resourceScope:'resources:read'})
 try {
  const surface={escalations:[{id:'self',tool:'synthetic.access.change',args:{id:{$sponsor:'id'}}}],schema:'rer-agent-surface/1',seed:'synthetic',specialist:'operations',tools:[
   {name:'synthetic.records.list',scope:'records:read',readOnly:true,classes:['standard'],clauses:['BASE-AGENT-002']},
   {name:'synthetic.records.write',scope:'records:write',readOnly:false,classes:['standard'],clauses:['BASE-AGENT-002']},
   {name:'synthetic.records.erase',scope:'records:write',readOnly:false,classes:['destructive'],clauses:['BASE-AGENT-006']},
   {name:'synthetic.records.send',scope:'records:write',readOnly:false,classes:['external','sensitive'],clauses:['BASE-AGENT-006']},
   {name:'synthetic.access.change',scope:'records:write',readOnly:false,classes:['access'],clauses:['BASE-AGENT-006']},
   {name:'synthetic.events.list',scope:'events:read',readOnly:true,classes:['standard'],clauses:['BASE-AGENT-010']}],notTools:[],resources:['synthetic://record/{id}'],witness:{tool:'synthetic.records.list',args:{}},journey:[
    {id:'list',tool:'synthetic.records.list',args:{},expect:[{class:'standard'}]},
    {id:'write',tool:'synthetic.records.write',args:{id:'synthetic-base-1',value:'synthetic-base-1'},expect:[{class:'standard'}],inject:{confirmExternal:true}},
    {id:'send',tool:'synthetic.records.send',args:{id:'synthetic-base-1'},expect:[{class:'external'},{class:'sensitive'}]},
    {id:'access',tool:'synthetic.access.change',args:{id:'synthetic-base-other'},expect:[{class:'access'}]},
    {id:'erase',tool:'synthetic.records.erase',args:{id:'synthetic-base-1'},expect:[{class:'destructive'}]},
    {id:'events',tool:'synthetic.events.list',args:{},expect:[{class:'standard'}]}]}
  const result=await runAgentDoorConformance({fetch:fresh.fetch,origin:fresh.c.origin,surface,signer:fresh.c.signer,person:fresh.c.person,now:()=>fresh.c.now})
  assert.deepEqual(result.points.filter((p:any)=>!p.ok),[])
 } finally { await fresh.close() }
})
