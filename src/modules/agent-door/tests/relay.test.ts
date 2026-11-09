import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { relayDecisions } from '../relay.ts'
import { relayFeed, relayReader } from './fixtures/relay-pages.mjs'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy, signJws } from '../conformance/crypto.mjs'
import { createProtocol } from '../conformance/protocol.mjs'
import { relayPhase } from '../conformance/relay.mjs'
import { agentErasureStatements, checkAgentArtifacts } from '../index.ts'
import { personAgentArtifacts } from '../../../default-seed/src/agent-door/erasure.ts'
import { pennyAgentArtifacts } from '../adoption/penny/penny-map.ts'
import { createErasure, defineErasure } from '../../erasure/index.mjs'
import { createPortability } from '../../portability/index.mjs'

const route = '/api/rer/agent-decisions'
const keys = 'agent,approval,at,classes,code,consent,disposition,execution_of,id,outcome,replay_of,resource_count,resources,review,revision,seq,tool'
const decision = (answer: any) => answer.result._meta['com.runeditrun/decision'].id
const write = (r: any, id = crypto.randomUUID(), value = 'private argument') => r.tool('records.write', {id,value,idempotency_key:crypto.randomUUID()})
async function fixture(t: any, options = {}) { const r = await runtime(options); t.after(() => r.close()); return r }
function claims(r: any, overrides = {}) {
 const iat = Math.floor(r.c.now/1000)
 return {v:1,iss:r.c.signer.issuer,aud:r.c.origin,sub:r.c.signer.installationId,business:r.c.business,after:0,limit:200,iat,exp:iat+60,jti:crypto.randomUUID(),...overrides}
}
const signed = (r: any, overrides = {}) => r.sign('rer-agent-decisions+jwt',claims(r,overrides))
async function pull(r: any, overrides = {}) {
 const response = await r.fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pull:await signed(r,overrides)})})
 const raw = await response.text()
 return {status:response.status,raw,body:raw ? JSON.parse(raw) : null}
}
async function decide(r: any, id: string, action = 'approve') {
 const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
 return r.person(`/agents/api/approvals/${id}/${action}`,{revision:view.revision,summary_sha256:view.summary_sha256})
}

test('R1 public Business writes and reads project exactly 17 public fields, including refusals', async t => {
 const r = await fixture(t)
 const beforeEnvelope = await write(r)
 await r.adopt()
 const call = await write(r,'relay-private-id','never-forward-this@example.test'), id = decision(call)
 const page = (await pull(r)).body, row = page.decisions[0]
 assert.equal(page.decisions.length,1); assert.equal(Object.keys(row).sort().join(),keys)
 assert.ok(!page.decisions.some((item: any) => item.id === decision(beforeEnvelope)))
 const audit = (await r.person('/agents/api/audit')).body.rows.find((item: any) => item.id === id)
 assert.deepEqual(row,{id,seq:row.seq,at:audit.at,tool:'synthetic.records.write',disposition:'autonomous',outcome:'done',code:null,revision:r.c.revision,classes:['standard'],agent:r.c.agentId,consent:r.c.consent,execution_of:null,replay_of:null,approval:null,review:null,resources:['synthetic://record/relay-private-id'],resource_count:1})
 assert.deepEqual(audit.resources,row.resources); assert.equal(audit.resource_count,1)
 for (const secret of ['never-forward-this@example.test',r.c.person.email,r.c.person.sub,'Synthetic Person','Agent door conformance','facts','evidence','idempotency_key','sponsor']) assert.ok(!JSON.stringify(page).includes(secret),secret)
 await r.mcp('resources/read',{uri:'synthetic://record/relay-private-id'})
 const read = (await pull(r,{after:page.cursor})).body.decisions[0]
 assert.equal(read.tool,'resources/read'); assert.deepEqual(read.resources,row.resources); assert.equal(read.resource_count,1)
 await r.adopt({...autonomousPolicy(),rules:[{id:'blocked',class:'*',do:'blocked'}]})
 await write(r); const blocked = (await pull(r)).body.decisions.at(-1)
 assert.equal(Object.keys(blocked).sort().join(),keys); assert.equal(blocked.disposition,'blocked'); assert.equal(blocked.outcome,'refused')
 await r.adopt(); await r.tool('records.write',{id:'refused',value:'synthetic-base-refused',idempotency_key:crypto.randomUUID()})
 assert.equal((await pull(r)).body.decisions.at(-1).code,'native_refused')
 t.diagnostic('R1 write/read=one projection each; 17 exact keys; blocked/native refusals closed; private values absent')
})

test('R2 pulls are byte stable, cursor-safe and door replays have their own linked row', async t => {
 const r = await fixture(t); await r.adopt()
 const args = {id:'replay',value:'private',idempotency_key:'synthetic-replay-key'}
 const original = decision(await r.tool('records.write',args)), first = await pull(r)
 assert.equal((await pull(r)).raw,first.raw)
 assert.deepEqual((await pull(r,{after:first.body.cursor})).body,{decisions:[],cursor:first.body.cursor,head:first.body.head,more:false})
 assert.deepEqual((await pull(r,{after:first.body.head+100})).body,{decisions:[],cursor:first.body.head+100,head:first.body.head,more:false})
 const replay = await r.tool('records.write',args), page = (await pull(r,{after:first.body.cursor})).body
 assert.equal(page.decisions.length,1); assert.equal(page.decisions[0].id,decision(replay)); assert.notEqual(page.decisions[0].id,original)
 assert.equal(page.decisions[0].replay_of,original); assert.equal(page.decisions[0].outcome,'replayed')
 t.diagnostic('R2 identical pulls; empty at/above head; replay adds one linked projection without resending original')
})

test('R3 approval execution/rejection/expiry and review marks resequence the held decision', async t => {
 const r = await fixture(t), policy = {...heldPolicy(),rules:heldPolicy().rules.slice(0,1)}; await r.adopt(policy)
 const held = await write(r), id = decision(held), approval = held.result._meta['com.runeditrun/approval'].id
 const initial = (await pull(r)).body
 assert.equal(initial.decisions[0].approval.state,'pending')
 assert.equal((await decide(r,approval)).body.approval.state,'executed')
 const executed = (await pull(r,{after:initial.cursor})).body
 assert.equal(executed.decisions.length,2)
 assert.equal(executed.decisions.find((row: any)=>row.id===id).approval.state,'executed')
 assert.equal(executed.decisions.find((row: any)=>row.id!==id).execution_of,id)
 assert.equal(executed.decisions.find((row: any)=>row.id===id).outcome,'pending')
 const rejected = await write(r), rejectId = decision(rejected), beforeReject = (await pull(r)).body.cursor
 await decide(r,rejected.result._meta['com.runeditrun/approval'].id,'reject')
 const rejection = (await pull(r,{after:beforeReject})).body.decisions
 assert.equal(rejection.length,1); assert.equal(rejection[0].id,rejectId); assert.equal(rejection[0].approval.state,'rejected')
 const expiring = await write(r), beforeExpiry = (await pull(r)).body.cursor
 await r.setNow(r.c.now+3601000); await r.adopt(policy)
 await decide(r,expiring.result._meta['com.runeditrun/approval'].id)
 assert.equal((await pull(r,{after:beforeExpiry})).body.decisions[0].approval.state,'expired')
 await r.adopt(heldPolicy()); const reviewed = await write(r), beforeReview = (await pull(r)).body.cursor
 await r.person(`/agents/api/reviews/${reviewed.result._meta['com.runeditrun/review'].id}/reviewed`,{})
 const marked = (await pull(r,{after:beforeReview})).body.decisions
 assert.equal(marked.length,1); assert.equal(marked[0].id,decision(reviewed)); assert.equal(marked[0].review.state,'reviewed'); assert.ok(marked[0].seq>beforeReview)
 t.diagnostic('R3 held decision resequenced once after execution/rejection/expiry/mark; execution has its own execution_of')
})

test('R4 signed detach, owner stop and unpaired return empty 404', async t => {
 for (const mode of ['detach','owner','unpaired']) {
  const r = await fixture(t,{paired:mode!=='unpaired'}); await r.adopt(); if (mode!=='unpaired') await write(r)
  if (mode==='detach') assert.equal((await r.settings({detached:true,values:{},logo:null,team:null})).status,200)
  if (mode==='owner') assert.equal((await r.person('/__stop',{})).status,200)
  const response = await pull(r); assert.equal(response.status,404,mode); assert.equal(response.raw,'',mode)
 }
 t.diagnostic('R4 detach=404 empty; owner stop=404 empty; unpaired=404 empty')
})

test('R5 method, body and signed claims refuse in W-R3 order without a projection', async t => {
 const r = await fixture(t); await r.adopt(); await write(r)
 assert.equal((await r.fetch(route)).status,405)
 for (const body of ['{','{}','[]','null','{"pull":1}','{"pull":"x","extra":1}',JSON.stringify({pull:'x'.repeat(8192)})]) {
  const res = await r.fetch(route,{method:'POST',body}); assert.equal(res.status,400); assert.deepEqual(await res.json(),{code:'relay_invalid'})
 }
 const now = Math.floor(r.c.now/1000), variants: any[] = [{iss:'https://foreign.invalid'},{aud:'https://foreign.invalid'},{sub:'foreign'},{exp:now},{exp:now+61},{iat:now+31,exp:now+60},{extra:1},{after:-1},{after:1.5},{after:'0'},{limit:0},{limit:201},{limit:1.5},{v:2},{jti:''}]
 for (const key of Object.keys(claims(r))) variants.push({[key]:undefined})
 for (const value of variants) { const res = await pull(r,value); assert.equal(res.status,401,JSON.stringify(value)); assert.deepEqual(res.body,{code:'relay_unauthenticated'}) }
 const foreign = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
 for (const token of [await r.sign('at+jwt',claims(r)),await signJws(foreign.privateKey,r.c.signer.kid,'rer-agent-decisions+jwt',claims(r))]) {
  const res=await r.post(route,{pull:token}); assert.equal(res.status,401); assert.deepEqual(await res.json(),{code:'relay_unauthenticated'})
 }
 const other=await pull(r,{business:'other'}); assert.equal(other.status,404); assert.equal(other.raw,'')
 t.diagnostic(`R5 GET=405; 7 malformed/oversized bodies=400; ${variants.length+2} invalid signatures/claims=401; foreign Business=404; refusals value-free`)
})

test('R6 local credentials and embedded consent do not enter the relay', async t => {
 const r=await fixture(t); await r.adopt()
 await r.tool('records.list',{}, {token:r.localToken})
 assert.equal((await r.person('/__embedded',{consent:r.c.consent})).body.outcome,'done')
 assert.deepEqual((await pull(r)).body,{decisions:[],cursor:0,head:0,more:false})
 t.diagnostic('R6 local and embedded-with-consent audits retained locally; relay count=0')
})

test('R7 paused refusal is paused/refused/agents_paused', async t => {
 const r=await fixture(t); await r.adopt(autonomousPolicy(),{paused:true}); await write(r)
 const row=(await pull(r)).body.decisions[0]
 assert.equal(Object.keys(row).sort().join(),keys); assert.equal(row.disposition,'paused'); assert.equal(row.outcome,'refused'); assert.equal(row.code,'agents_paused')
 t.diagnostic('R7 paused/refused/agents_paused, same 17-key live shape')
})

test('R8 re-pairing preserves the first Business partition', async t => {
 const r=await fixture(t); await r.adopt(); const old=r.c.business, oldId=decision(await write(r))
 r.c.business='synthetic-new-business'; await r.adopt(); const newId=decision(await write(r))
 const page=(await pull(r)).body; assert.deepEqual(page.decisions.map((row:any)=>row.id),[newId]); assert.notEqual(oldId,newId)
 assert.equal((await pull(r,{business:old})).status,404)
 t.diagnostic('R8 new Business sees only new decision; old Business=404')
})

test('R9 native erasure resends only the erased decision in its closed value-free form', async t => {
 const r=await fixture(t,{erasure:true}); await r.adopt()
 await checkAgentArtifacts(r.db,personAgentArtifacts); await checkAgentArtifacts(r.db,pennyAgentArtifacts)
 const portability=await createPortability({db:r.db,policy:{product:'relay-test',buckets:{},excludeTables:['test_contexts','test_callbacks']}})
 const declaration=defineErasure({entity:'record',root:{table:'test_records'},async beforeStatements({subject,operation}:any) {
  return agentErasureStatements({db:r.db,secret:r.secret,map:personAgentArtifacts,subject:{values:JSON.stringify([subject.id])},tombstone:{erasure_id:operation.id,at:operation.at},checkpoint:()=>portability.redactionStatements()})
 }})
 const erasure=createErasure({db:r.db,portability,declarations:[declaration]})
 const subject='synthetic-erased-subject', peer=decision(await write(r,'synthetic-peer')), id=decision(await write(r,subject,subject))
 const before=(await pull(r)).body, original=before.decisions.find((row:any)=>row.id===id)
 const opened=await erasure.start('record',{id:subject}); assert.equal((await erasure.run(opened.id)).phase,'complete')
 const erased=(await pull(r,{after:before.cursor})).body.decisions
 assert.equal(erased.length,1); assert.deepEqual(erased[0],{id,seq:erased[0].seq,at:original.at,erased:true,tool:original.tool,classes:original.classes,disposition:original.disposition,agent:original.agent})
 assert.ok(!JSON.stringify(erased).includes(subject)); assert.ok(erased[0].seq>before.cursor)
 assert.deepEqual((await pull(r)).body.decisions.find((row:any)=>row.id===peer),before.decisions.find((row:any)=>row.id===peer))
 t.diagnostic('R9 native erasure complete with both maps; 8-key erased projection only; peer byte-identical; subject/consent/key absent')
})

test('R10 unreachable Business never delays calls or grows an outbox; changes retain 30 feed entries', async t => {
 let outbound=0, reachable=true
 const r=await fixture(t,{outboundService:async()=>{outbound++; return new Response(null,{status:reachable?200:503})}})
 await r.adopt(heldPolicy()); const reviews=[], baseline=[], durations=[]
 for (let i=0;i<30;i++) { const start=performance.now(); await write(r); baseline.push(performance.now()-start) }
 // Compare the same door and workload with the Business network edge unavailable.
 reachable=false
 for (let i=0;i<30;i++) { const start=performance.now(), result=await write(r); durations.push(performance.now()-start); reviews.push(result.result._meta['com.runeditrun/review'].id) }
 const bound=Math.max(...baseline)+2000
 assert.ok(durations.every(ms=>ms<bound),`unreachable max=${Math.max(...durations)}ms; reachable max=${Math.max(...baseline)}ms + 2000ms`)
 assert.equal(outbound,0,'calls never wait on an outbound Business request')
 const before=(await pull(r)).body
 for (let i=0;i<70;i++) assert.equal((await r.person(`/agents/api/reviews/${reviews[i%30]}/${i%2?'reviewed':'flag'}`,{})).status,200)
 assert.equal(await r.db.prepare('SELECT COUNT(*) AS n FROM agent_door_relay').first('n'),60)
 const after=(await pull(r,{after:before.cursor})).body
 assert.equal(after.decisions.length,30); assert.equal(new Set(after.decisions.map((row:any)=>row.id)).size,30)
 t.diagnostic(`R10 reachable baseline max=${Math.ceil(Math.max(...baseline))}ms; unreachable Business: 30 calls max=${Math.ceil(Math.max(...durations))}ms; 70 marks; feed=60 (30 baseline + 30 unreachable), no outbox growth; resent=30 unique`)
})

test('R11 byte and count bounds hold across chained pages at 200 and 7', async t => {
 const r=await fixture(t); await r.adopt()
 for (let i=0;i<205;i++) await write(r,`${i}-${'x'.repeat(470)}`)
 for (const limit of [200,7]) {
  let after=0; const ids=new Set(), sequences=[]; let pages=0,maxBytes=0
  for (;;) { const page=await pull(r,{after,limit}), bytes=Buffer.byteLength(page.raw); maxBytes=Math.max(maxBytes,bytes); pages++
   assert.equal(page.status,200); assert.ok(bytes<=65536); assert.ok(page.body.decisions.length<=limit); assert.ok(page.body.decisions.length>0)
   for (const row of page.body.decisions) { assert.ok(row.seq>after); assert.ok(!ids.has(row.id)); ids.add(row.id); sequences.push(row.seq); after=row.seq }
   assert.equal(page.body.cursor,after); if (!page.body.more) break
  }
  assert.equal(ids.size,205); assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b)); t.diagnostic(`R11 limit=${limit}: covered=205 unique ordered; pages=${pages}; maxBytes=${maxBytes}`)
 }
})

test('R12 relay conformance passes the public door and rejects unrouting or foreign-signature acceptance', async t => {
 const r=await fixture(t); await r.adopt(); await write(r)
 for (const mode of ['live','unrouted','foreign-accepted']) {
  const valid=(await pull(r)).body
  const fetch=async (url:string,init:RequestInit) => {
   if (new URL(url).pathname===route && mode==='unrouted') return new Response(null,{status:404})
   const response=await r.fetch(url,init)
   if (new URL(url).pathname===route && mode==='foreign-accepted' && response.status===401) return Response.json(valid)
   return response
  }
  const c=createProtocol({...r.c,fetch,points:[],listed:new Map()}); await c.phase('BASE-AGENT-009.relay',()=>relayPhase(c))
  const failed=c.points.filter((point:any)=>!point.ok)
  if (mode==='live') assert.deepEqual(failed,[])
  else assert.ok(failed.some((point:any)=>point.id===`BASE-AGENT-009.relay.${mode==='unrouted'?'route':'foreign'}`),JSON.stringify(failed))
  t.diagnostic(`R12 ${mode}: ${failed.length?'rejected':'passed'}`)
 }
})

test('R11 pages match frozen original bytes at limits 200 and 7 with linear sizing cost', async t => {
 const frozen = JSON.parse(await readFile(new URL('./fixtures/relay-pages.json', import.meta.url), 'utf8'))
 let fullPageSizingBytes = 0, compared = 0
 for (const sample of frozen.cases) {
  const records = relayFeed(sample.kind), read = await relayReader(relayDecisions, records)
  const ids: string[] = []
  let after = 0
  for (let i = 0; i < sample.pages.length; i++) {
   const input = i === sample.pages.length - 1 ? after + 100 : after
   let serializedBytes = 0
   const stringify = JSON.stringify
   const spy = t.mock.method(JSON, 'stringify', (value: any, replacer: any, space: any) => {
    const raw = stringify(value, replacer, space)
    if (raw && value && (Array.isArray(value.decisions) || typeof value.seq === 'number')) serializedBytes += Buffer.byteLength(raw)
    return raw
   })
   let raw: string
   try { raw = await read(input, sample.limit) } finally { spy.mock.restore() }
   // Compare the full response bytes, then both object directions for all wire fields.
   assert.equal(raw, sample.pages[i], sample.kind + '/' + sample.limit + '/' + input)
   const page = JSON.parse(raw!), expected = JSON.parse(sample.pages[i])
   assert.deepEqual(page, expected); assert.deepEqual(expected, page)
   assert.ok(Buffer.byteLength(raw!) <= 65536)
   assert.ok(page.decisions.length <= sample.limit)
   if (i < sample.pages.length - 2) {
    assert.ok(page.decisions.length > 0)
    for (const row of page.decisions) { assert.ok(row.seq > after); after = row.seq; ids.push(row.id) }
    assert.equal(page.cursor, after)
    assert.equal(page.more, after < page.head)
   } else {
    assert.deepEqual(page.decisions, [])
    assert.equal(page.cursor, input); assert.equal(page.more, false)
   }
   if (sample.kind === 'compact' && sample.limit === 200 && i === 0) {
    assert.equal(page.decisions.length, 200); fullPageSizingBytes = serializedBytes
   }
   if (sample.kind === 'large' && sample.limit === 200 && i === 0) assert.equal(Buffer.byteLength(raw!), 65536)
   compared++
  }
  assert.deepEqual(ids, records.map(row => JSON.parse(row.row).id))
  assert.equal(new Set(ids).size, 205)
 }
 assert.ok(fullPageSizingBytes < frozen.fullPageSizingBytes / 20)
 t.diagnostic(`Frozen original pages: ${compared} byte-identical in both directions; full 200-entry sizing: ${frozen.fullPageSizingBytes} -> ${fullPageSizingBytes} serialized bytes`)
})
