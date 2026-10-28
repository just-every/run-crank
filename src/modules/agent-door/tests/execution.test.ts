import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy, policyEnvelope } from '../conformance/crypto.mjs'
import { createAgentDoor } from '../index.ts'

const code = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
const args = (value: string) => ({id:'synthetic-base-record',value,idempotency_key:crypto.randomUUID()})
const approvalOf = (reply: any) => reply.result._meta['com.runeditrun/approval']

test('execution audit survives a final-write fault, resource reads obey policy, and revoked approvals cannot execute', async () => {
 const r = await runtime()
 try {
  await r.adopt()
  const input = args('synthetic-base-once')
  await r.db.prepare("CREATE TRIGGER synthetic_base_audit_fault BEFORE UPDATE ON agent_door_audit WHEN json_extract(NEW.row,'$.outcome')='done' BEGIN SELECT RAISE(FAIL,'synthetic-base-final-write'); END").run()
  await assert.rejects(()=>r.tool('records.write',input))
  const record = await r.db.prepare('SELECT row FROM agent_door_audit WHERE json_extract(row,\'$.idempotency_key\')=?').bind(input.idempotency_key).first()
  assert.equal(JSON.parse(record.row).outcome,'running')
  const saved = await r.db.prepare('SELECT outcome FROM agent_door_calls WHERE key=?').bind(input.idempotency_key).first()
  assert.equal(JSON.parse(saved.outcome).outcome,'done')
  const once = await r.db.prepare('SELECT version FROM test_records WHERE id=?').bind(input.id).first()
  assert.equal(once.version,1)
  await r.db.prepare('DROP TRIGGER synthetic_base_audit_fault').run()
  assert.equal((await r.tool('records.write',input)).result.isError,false)
  const recovered = (await r.person('/agents/api/audit')).body.rows
  assert.equal(recovered.find((row: any)=>row.id===JSON.parse(record.row).id).outcome,'done')
  assert.equal((await r.db.prepare('SELECT version FROM test_records WHERE id=?').bind(input.id).first()).version,1)
  const observed = await r.db.prepare("SELECT audit FROM test_contexts WHERE kind='run'").first()
  assert.equal(JSON.parse(JSON.parse(observed.audit).row).outcome,'running')
  const uri = `synthetic://record/${input.id}`
  const read = () => r.mcp('resources/read',{uri})
  const policies = [
   {mode:'blocked',reply:'policy_blocked'}, {mode:'review',reply:null}, {mode:'autonomous',reply:null}, {mode:'approval',reply:'approval_required'},
  ]
  for (const {mode,reply} of policies) {
   const document = {...autonomousPolicy(),rules:[{id:'standard',class:'standard',do:'autonomous'},{id:'sensitive',class:'sensitive',do:mode,...(mode==='approval'?{approver:['sponsor'],wait:'PT1H'}:{})}],reviewers:['sponsor']}
   assert.equal((await r.adopt(document)).status,200)
   const before = (await r.person('/agents/api/audit')).body.rows.length
   const result = await read()
   assert.equal(code(result) ?? null,reply)
   if (reply) assert.equal(result.result,undefined)
   else assert.equal(JSON.parse(result.result.contents[0].text).value,input.value)
   const rows = (await r.person('/agents/api/audit')).body.rows
   assert.equal(rows.length,before+1)
   const row = rows.at(-1); assert.equal(row.tool,'resources/read'); assert.equal(row.resource,uri); assert.equal(row.decision,mode)
   assert.deepEqual(row.classes,[{class:'sensitive',facts:{measure:1,kind:'tax'}}])
   if (mode==='review') assert.equal((await r.person('/agents/api/reviews')).body.reviews.filter((item: any)=>item.decision_id===row.id).length,1)
   if (mode==='approval') {
    const id = result.error.data.approval.id
    const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
    assert.deepEqual(view.summary,{uri})
    assert.equal((await r.person(`/agents/api/approvals/${id}/approve`,{revision:view.revision,summary_sha256:view.summary_sha256})).body.approval.state,'executed')
   }
  }
  await r.adopt(heldPolicy())
  const reviewed = await r.tool('records.write',args('synthetic-base-review'))
  const review = reviewed.result._meta['com.runeditrun/review'].id
  await r.person(`/agents/api/reviews/${review}/undo`,{})
  const undo = await r.db.prepare("SELECT person,agent,actor FROM test_contexts WHERE kind='undo' ORDER BY rowid DESC LIMIT 1").first()
  const owner = (await r.db.prepare('SELECT claim_id FROM oa_bootstrap').first()).claim_id
  assert.equal(undo.person,owner); assert.equal(undo.agent,null); assert.deepEqual(JSON.parse(undo.actor),{kind:'person',person:{id:owner,name:'Synthetic Person'},label:'Synthetic Person'})
  const held = await r.tool('records.erase',{id:input.id,idempotency_key:crypto.randomUUID()})
  const id = approvalOf(held).id, view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
  assert.equal((await r.person(`/agents/api/approvals/${id}/approve`,{revision:view.revision})).body.code,'approval_summary_mismatch')
  assert.equal((await r.person(`/agents/api/approvals/${id}/approve`,{revision:view.revision,summary_sha256:'synthetic-base-stale'})).status,409)
  await r.person('/agents/api/pause',{paused:true})
  const paused = await r.person(`/agents/api/approvals/${id}/approve`,{revision:view.revision,summary_sha256:view.summary_sha256})
  assert.equal(paused.body.approval.state,'refused'); assert.equal(paused.body.approval.code,'agents_paused')
  const execution = (await r.person('/agents/api/audit')).body.rows.find((row: any)=>row.decision_id===view.decision_id)
  assert.equal(execution.outcome,'refused'); assert.equal(execution.code,'agents_paused'); assert.deepEqual(execution.approval.by,[owner])
  await r.person('/agents/api/pause',{paused:false})
  const revokeInput={id:input.id,idempotency_key:crypto.randomUUID()}, pending=await r.tool('records.erase',revokeInput), revokeId=approvalOf(pending).id
  const revokeView=(await r.person(`/agents/api/approvals/${revokeId}`)).body.approval
  const token=await r.token(), other=await r.token({act:{sub:'synthetic-base-other-agent',name:'Synthetic Other Agent'},consent:'synthetic-base-other-consent'})
  assert.equal((await r.adopt(heldPolicy(),{revoked:{agents:[r.c.agentId],consents:[]}})).status,200)
  assert.equal((await r.mcp('tools/list',{}, {token})).status,401)
  assert.equal((await r.mcp('tools/list',{}, {token:other})).status,200)
  assert.equal((await r.person(`/agents/api/approvals/${revokeId}`)).body.approval.state,'expired')
  assert.equal((await r.person(`/agents/api/approvals/${revokeId}/approve`,{revision:revokeView.revision,summary_sha256:revokeView.summary_sha256})).body.code,'approval_expired')
  await r.adopt(autonomousPolicy(),{revoked:{agents:[],consents:[r.c.consent]}})
  assert.equal((await r.mcp('tools/list',{}, {token})).status,401)
  assert.equal((await r.mcp('tools/list',{}, {token:other})).status,200)
  assert.equal((await r.mcp('tools/list',{}, {token:await r.token({consent:undefined})})).status,401)
  assert.equal((await r.person('/agents/api/audit')).body.differs_from_policy,0)
  const caps = {...autonomousPolicy(),spend:{caps:[{seed:'synthetic',specialist:'operations',microusd_per_day:500}]}}
  assert.equal((await r.adopt(caps)).status,200)
  assert.equal((await r.person('/agents/api/state')).body.policy.spend_caps,'not_enforced')
  const page = await r.fetch('/agents',{headers:{cookie:r.c.person.cookie}})
  assert.match(await page.text(),/data-spend-caps="not-enforced"/)
  const options:any={db:r.db,seed:'synthetic',name:'Synthetic',specialist:'operations',origin:r.c.origin,trust:null,people:{sponsor:async()=>null,person:async()=>null,session:async()=>null},tools:[]}
  const sample:any={name:'synthetic.records.list',title:'Read',description:'Read',scope:'records:read',readOnly:true,inputSchema:{type:'object'},outputSchema:{type:'object'},classes:['standard'],clauses:[],classify:()=>[],run:async()=>({result:{}})}
  for (const tools of [[{...sample,cost:0}],[{...sample,readOnly:false}],[{...sample,classes:['access']}],[{...sample,classes:['security']}]]) assert.throws(()=>createAgentDoor({...options,tools}))
  assert.throws(()=>createAgentDoor({...options,resources:[{uriTemplate:'synthetic://record/{id}',name:'Record',read:async()=>({json:{}})}]}))
  const second=await runtime({ring:r.c.ring})
  try {
   const daily={...autonomousPolicy(),rules:[{id:'daily',class:'money',do:'autonomous',max_per_day:{amount:500,currency:'USD'}},{id:'money',class:'money',do:'approval',approver:['sponsor'],wait:'PT1H'}]}
   const signed=await policyEnvelope(r.c,daily)
   for (const instance of [r,second]) {
    const prior=(await instance.person('/agents/api/state')).body.policy.revision
    const response=await instance.post('/api/rer/agent-policy',{policy:signed.policy})
    assert.equal(response.status,400); assert.deepEqual(await response.json(),{code:'policy_document_invalid',path:'$.rules[0].seed'})
    assert.equal((await instance.person('/agents/api/state')).body.policy.revision,prior)
   }
   assert.equal((await r.adopt({...daily,rules:daily.rules.map(rule=>({...rule,seed:'synthetic'}))})).status,200)
   assert.equal((await r.adopt({...daily,rules:daily.rules.map(rule=>({...rule,seed:'synthetic-base-other'}))})).status,200)
  } finally {await second.close()}
 } finally {await r.close()}
 const local=await runtime({paired:false})
 try {
  const document={...autonomousPolicy(),spend:{caps:[{seed:'synthetic',specialist:'operations',microusd_per_day:500}]}}
  const response=await local.fetch('/agents/api/policy',{method:'PUT',headers:{origin:local.c.origin,cookie:local.c.person.cookie,'content-type':'application/json'},body:JSON.stringify({document})})
  assert.equal(response.status,409); assert.equal((await response.json()).code,'spend_caps_not_enforced')
  assert.equal((await local.person('/agents/api/state')).body.policy.revision,null)
 } finally {await local.close()}
})
