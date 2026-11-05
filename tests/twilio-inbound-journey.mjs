import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {connection,deliver,estimateHold,fakeEdge,jsonResponse,runs,settled,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z';
const sid=(kind,label)=>kind+createHash('sha256').update('synthetic-crank-'+label).digest('hex').slice(0,32);
export const smsAccount=sid('AC','account'),smsNumber='+15555550101';
const secret='synthetic-crank-1701',from='+15555550102';
export const smsFields=(patch={})=>({AccountSid:smsAccount,MessageSid:sid('SM','message'),From:from,To:smsNumber,Body:'synthetic-crank-1702',NumMedia:'0',SmsStatus:'received',...patch});
const encoded=fields=>new URLSearchParams(fields).toString();
const sign=(url,body,key=secret)=>{
  const form=new URLSearchParams(body);
  return createHmac('sha1',key).update(url+[...new Set(form.keys())].sort().map(key=>key+form.getAll(key).join('')).join('')).digest('base64');
};
export async function sendSms(h,w,fields=smsFields(),options={}) {
  const url=options.url??w.callback,body=options.body??encoded(fields);
  return deliver(h,url,{method:'POST',duplex:'half',headers:{'content-type':['application','x-www-form-urlencoded'].join('/'),'x-twilio-signature':options.signature??sign(options.signedUrl??url,body,options.secret??secret),...options.headers},body});
}
const signing=(h,patch={})=>connection(h,{app:'webhook',label:'Declared Twilio signing token',auth_kind:'signing_secret',secret:{secret},...patch});
export async function smsWorkflow(h,c,{name='Inbound SMS order',steps=[],trigger={},publish=true}={}) {
  const w=await h.post('workflows',{name,graph:{trigger:{type:'manual'},steps:[]}},h.owner,201);
  const callback=h.origin+'/hooks/twilio/'+w.id;
  const graph={trigger:{type:'twilio_sms',account_sid:smsAccount,to:smsNumber,callback_url:callback,signing_connection_id:c.id,...trigger},steps};
  await h.post(`workflows/${w.id}/draft`,{graph});
  const published=publish?await h.post(`workflows/${w.id}/publish`,{},h.owner,201):null;
  return {...w,graph,callback,published};
}
async function restrictedViewer(h,w) {
  const invited=await h.send('/auth/invite',{email:['synthetic-crank-1705','example.test'].join('@'),displayName:'SMS status viewer',role:'member'},h.owner);assert.equal(invited.status,202,invited.text);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),token=new URL(link,h.origin).searchParams.get('token');
  const signed=await h.send('/auth/confirm',{token});assert.equal(signed.status,303);
  const people=await h.send('/auth/operators',undefined,h.owner),person=people.value.find(row=>row.displayName==='SMS status viewer');
  await h.post('team/'+person.id,{role:'viewer',workflow_ids:[w.id],connection_ids:[]});return signed.cookie;
}
const mapped={id:'fields',type:'map',input:{account:'{{trigger.account_sid}}',message:'{{trigger.message_sid}}',from:'{{trigger.from}}',to:'{{trigger.to}}',body:'{{trigger.body}}',media:'{{trigger.num_media}}'}};
const wait={id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}};
const effect={id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/texts',body:{message:'{{trigger.message_sid}}',body:'{{trigger.body}}'}}};

/** Signed transport to immutable native publication, durable admission and one continuation. */
export async function twilioInboundJourney({onScreen=async()=>{},emitted=false}={}) {
  const fake=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock,...(emitted?{emitted:true}:{})});
  fake.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({received:true})});
  try {
    const c=await signing(h),w=await smsWorkflow(h,c,{steps:[mapped,wait,effect]});
    assert.ok(w.published.version.authority.connections.includes(c.id));
    assert.match(w.published.warnings.join(' '),/ownership and provisioning are unverified/);
    assert.equal((await h.get('catalog')).apps.find(app=>app.app==='twilio').triggers[0].trigger,'twilio_sms');
    const stored=await h.db.prepare('SELECT secret_ciphertext FROM crank_connections WHERE id=?').bind(c.id).first();assert.ok(stored.secret_ciphertext&&!stored.secret_ciphertext.includes(secret));
    const agent=await h.post('tokens',{label:'Prepare SMS only',scope:'agent'},h.owner,201);
    await h.post(`workflows/${w.id}/publish`,{},'',403,{authorization:'Bearer '+agent.token});
    const form=smsFields({SmsSid:sid('SM','message'),SmsMessageSid:sid('SM','message')});
    const first=await Promise.all([sendSms(h,w,form),sendSms(h,w,form),sendSms(h,w,form)]);
    for(const response of first){assert.equal(response.status,200,response.text);assert.equal(response.text,'<Response></Response>');assert.match(response.headers.get('content-type'),/xml/);assert.ok(!response.text.includes('Message>'))}
    const waiting=await settled(h,(await runs(h,w))[0].id);assert.equal(waiting.status,'waiting',JSON.stringify(waiting.error));
    assert.equal(waiting.trigger_kind,'twilio_sms');assert.deepEqual(stepOf(waiting,'fields').output,{account:smsAccount,message:form.MessageSid,from,to:smsNumber,body:form.Body,media:0});
    assert.equal((await runs(h,w)).length,1);assert.equal(effects.length,0);
    await h.restart();await sendSms(h,w,form);assert.equal((await runs(h,w)).length,1);
    if(!emitted)await h.restart({clock:new Date(Date.parse(waiting.waits[0].due_at)+1000).toISOString()});
    await h.tick(Date.parse(waiting.waits[0].due_at)+1000);await h.tick(Date.parse(waiting.waits[0].due_at)+2000);
    const run=await settled(h,waiting.id);assert.equal(run.status,'succeeded',JSON.stringify(run.error));
    assert.deepEqual(effects,[{message:form.MessageSid,body:form.Body}]);
    const history=JSON.stringify(run);assert.ok(!history.includes(secret)&&!history.includes('x-twilio-signature')&&!history.includes('SmsStatus'));
    await h.get('workflow-runs/'+run.id,'',401);
    const viewer=await restrictedViewer(h,w),hidden=await h.get('workflow-runs/'+run.id,viewer);assert.equal(hidden.payload,'restricted');assert.equal(hidden.trigger,undefined);assert.ok(!JSON.stringify(hidden).includes(form.Body));
    assert.deepEqual((await h.get('workflow-runs?q='+form.Body,viewer)).runs,[]);
    // A saved draft never changes the published receiving account or number.
    await h.post(`workflows/${w.id}/draft`,{graph:{...w.graph,trigger:{...w.graph.trigger,to:'+15555550103'}}});
    assert.equal((await sendSms(h,w,form)).status,200);
    assert.equal((await sendSms(h,w,smsFields({MessageSid:sid('SM','draft'),To:'+15555550103'}))).status,403);
    const wrongAccount=await smsWorkflow(h,c,{name:'Other declared account',trigger:{account_sid:sid('AC','other-account')},steps:[mapped]});
    assert.equal((await sendSms(h,wrongAccount,form)).status,403);
    assert.equal((await sendSms(h,wrongAccount,smsFields({AccountSid:sid('AC','other-account')}))).status,200);
    const other=await settled(h,(await runs(h,wrongAccount))[0].id);assert.equal(other.trigger.account_sid,sid('AC','other-account'));
    const otherNumber=await smsWorkflow(h,c,{name:'Other declared number',trigger:{to:'+15555550103'},steps:[mapped]});
    assert.equal((await sendSms(h,otherNumber,form)).status,403);assert.equal((await sendSms(h,otherNumber,smsFields({To:'+15555550103'}))).status,200);
    const numberRun=await settled(h,(await runs(h,otherNumber))[0].id);assert.equal(numberRun.trigger.to,'+15555550103');assert.equal(numberRun.trigger.account_sid,smsAccount);
    // Forwarded origin hints cannot choose the signed URL.
    assert.equal((await sendSms(h,w,form,{headers:{'x-forwarded-host':'attacker.example','x-forwarded-proto':'https'}})).status,200);
    const bounded=await smsWorkflow(h,c,{name:'Bounded signed form',steps:[mapped]});
    const maxBody=smsFields({MessageSid:sid('SM','max-body'),Body:'x'.repeat(1600)});assert.equal((await sendSms(h,bounded,maxBody)).status,200);
    assert.equal((await settled(h,(await runs(h,bounded))[0].id)).trigger.body.length,1600);
    const prefix=encoded(smsFields({MessageSid:sid('SM','max-form')}))+'&Padding=',exact=prefix+'x'.repeat(16384-Buffer.byteLength(prefix));assert.equal(Buffer.byteLength(exact),16384);
    assert.equal((await sendSms(h,bounded,{}, {body:exact})).status,200);assert.equal((await sendSms(h,bounded,{}, {body:exact+'x'})).status,400);
    const full=smsFields({MessageSid:sid('SM','max-fields')});for(let i=Object.keys(full).length;i<64;i++)full['Extra'+i]='x';assert.equal((await sendSms(h,bounded,full)).status,200);
    await Promise.all((await runs(h,bounded)).map(run=>settled(h,run.id)));assert.equal((await runs(h,bounded)).length,3);
    assert.equal((await sendSms(h,w,smsFields({Body:'changed authenticated input'}))).status,409);
    assert.equal(effects.length,1);
    await h.post(`workflows/${w.id}/draft`,{graph:w.graph});
    await onScreen({h,w,run,state:'sms-admission'});
    // All rejected inputs use new message identities and must change no admission state.
    const count=(await runs(h,w)).length,eventCount=(await h.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=?').bind(w.id).first()).n;
    let n=0;
    const refused=async(patch,status=400,options={})=>{const result=await sendSms(h,w,smsFields({MessageSid:sid('SM','refusal-'+(++n)),...patch}),options);assert.equal(result.status,status,result.text)};
    for(const patch of [{AccountSid:'synthetic-crank-invalid'},{MessageSid:'synthetic-crank-invalid'},{From:'anonymous'},{To:'15555550101'},{SmsSid:sid('SM','other')},{SmsMessageSid:sid('SM','other')},{NumMedia:'1'},{NumMedia:'00'},{MediaUrl0:'https://media.example/private'},{MediaContentType0:'image'},{Body:'x'.repeat(1601)},{Body:'\0'},{SmsStatus:'delivered'},{MessageStatus:'sent'}])await refused(patch);
    await refused({AccountSid:sid('AC','foreign')},403);await refused({To:'+15555550104'},403);
    await refused({},401,{signature:'synthetic-crank-forged'});
    const genuine=encoded(smsFields({MessageSid:sid('SM','tampered')}));
    await refused({},401,{body:genuine.replace('1702','1703'),signature:sign(w.callback,genuine)});
    await refused({},401,{url:w.callback+'?redirect=1',signedUrl:w.callback});
    await refused({},415,{headers:{'content-type':['application','json'].join('/')}});
    const fresh=encoded(smsFields({MessageSid:sid('SM','ambiguous')}));
    for(const suffix of ['&AccountSid='+smsAccount,'&To='+encodeURIComponent(smsNumber),'&Body=other','&%4dessageSid='+sid('SM','second'),'&accountsid='+smsAccount,'&Other=%ZZ','&Other=%FF','&=empty','&Other=one&Other=two'])await refused({},400,{body:fresh+suffix});
    await refused({},400,{body:fresh+'&Padding='+'x'.repeat(16384)});
    await refused({},400,{body:fresh+Array.from({length:65},(_,i)=>'&Extra'+i+'=x').join('')});
    assert.equal((await deliver(h,w.callback)).status,405);
    assert.equal((await runs(h,w)).length,count);assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=?').bind(w.id).first()).n,eventCount);
    assert.equal(effects.length,1);assert.equal(fake.to('media.example').length,0);
    const unpublished=await smsWorkflow(h,c,{publish:false});assert.equal((await sendSms(h,unpublished)).status,404);
    const malformed=[{account_sid:'synthetic-crank-account'},{to:'anonymous'},{callback_url:'https://other.example/hooks/twilio/id?query=1'},{signing_connection_id:1},{media:true}];
    for(const patch of malformed)await h.post(`workflows/${w.id}/draft`,{graph:{...w.graph,trigger:{...w.graph.trigger,...patch}}},h.owner,422);
    // Valid configuration shape still cannot publish another workflow or origin.
    for(const callback of [h.origin+'/hooks/twilio/another-workflow','https://other.example/hooks/twilio/'+w.id]){
      await h.post(`workflows/${w.id}/draft`,{graph:{...w.graph,trigger:{...w.graph.trigger,callback_url:callback}}});await h.post(`workflows/${w.id}/publish`,{},h.owner,422);
    }
    const otherEnv=await signing(h,{environment:'sandbox'}),bad=await smsWorkflow(h,otherEnv,{publish:false});await h.post(`workflows/${bad.id}/publish`,{},h.owner,422);
    // No provider account authorization, number provisioning or message send is attempted.
    assert.ok(fake.requests.every(request=>request.url.hostname==='receiver.example'));
  } finally {await h.close()}
}

/** Paused holds, revoked and rotated signing revisions, and transaction fences. */
export async function twilioAuthorityJourney() {
  const fake=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  fake.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
  try {
    const c=await signing(h),w=await smsWorkflow(h,c,{steps:[mapped,effect]});
    await h.post(`workflows/${w.id}/pause`);const held=smsFields({MessageSid:sid('SM','held')});
    const responses=await Promise.all([sendSms(h,w,held),sendSms(h,w,held)]);assert.ok(responses.every(r=>r.status===200));
    const [hold]=await h.get(`workflows/${w.id}/holds`);assert.ok(hold);assert.equal((await h.get('holds/'+hold.id)).items.length,1);assert.equal(effects.length,0);assert.equal((await runs(h,w)).length,0);
    await h.restart();await h.post(`workflows/${w.id}/resume`);
    const released=await h.post(`holds/${hold.id}/release`,{all:true,estimate_fingerprint:(await estimateHold(h,hold.id)).estimate_fingerprint});
    assert.equal((await settled(h,released.runs[0].id)).status,'succeeded');assert.equal(effects.length,1);
    await sendSms(h,w,held);assert.equal(effects.length,1);
    const waiting=await smsWorkflow(h,c,{name:'Revoked SMS continuation',steps:[wait,effect]});
    await sendSms(h,waiting,smsFields({MessageSid:sid('SM','waiting')}));const run=await settled(h,(await runs(h,waiting))[0].id);assert.equal(run.status,'waiting');
    await h.post(`connections/${c.id}/revoke`);const revoked=await sendSms(h,w,smsFields({MessageSid:sid('SM','revoked')}));assert.equal(revoked.status,401);assert.ok(!revoked.text.includes(c.label),'unauthenticated receiving errors disclose no connection label');
    await h.restart();await h.tick(Date.parse(run.waits[0].due_at)+1000);assert.equal((await h.get('workflow-runs/'+run.id)).status,'paused');assert.equal(effects.length,1);
    await h.post(`connections/${c.id}/rotate`,{secret:{secret}});
    assert.equal((await sendSms(h,w,smsFields({MessageSid:sid('SM','reconnected')}))).status,409,'reconnection alone grants no receiving authority to an old publication');
    await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
    assert.equal((await sendSms(h,w,smsFields({MessageSid:sid('SM','reconnected')}))).status,200);await Promise.all((await runs(h,w)).map(run=>settled(h,run.id)));assert.equal(effects.length,2);
    // An in-transaction authority change must roll back the claim, run and hold.
    await h.db.exec(`CREATE TRIGGER synthetic_twilio_late BEFORE INSERT ON crank_trigger_events WHEN NEW.workflow_id='${w.id}' BEGIN UPDATE crank_connections SET status='revoked' WHERE id='${c.id}'; END;`);
    const before=(await runs(h,w)).length;
    const late=await sendSms(h,w,smsFields({MessageSid:sid('SM','late-commit')}));assert.equal(late.status,409,late.text);
    assert.equal((await runs(h,w)).length,before);assert.equal((await h.get('connections')).find(row=>row.id===c.id).status,'active','the complete failed admission transaction rolled back');
    await h.db.exec('DROP TRIGGER synthetic_twilio_late');assert.equal(effects.length,2);
    // A held event released after revocation still cannot dispatch a native step.
    const heldFlow=await smsWorkflow(h,c,{steps:[effect]});await h.post(`workflows/${heldFlow.id}/pause`);await sendSms(h,heldFlow,smsFields({MessageSid:sid('SM','revoked-held')}));
    const [revokedHold]=await h.get(`workflows/${heldFlow.id}/holds`);await h.post(`workflows/${heldFlow.id}/resume`);const quote=await estimateHold(h,revokedHold.id);
    await h.post(`connections/${c.id}/revoke`);const fenced=await h.post(`holds/${revokedHold.id}/release`,{all:true,estimate_fingerprint:quote.estimate_fingerprint});
    assert.equal((await settled(h,fenced.runs[0].id)).status,'paused');assert.equal(effects.length,2);
    await h.post(`connections/${c.id}/rotate`,{secret:{secret}});
    const streamed=await smsWorkflow(h,c,{steps:[effect]}),raw=encoded(smsFields({MessageSid:sid('SM','stream')})),bytes=Buffer.from(raw);
    let finish,started;const reading=new Promise(resolve=>started=resolve),stream=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,30));started();finish=()=>{controller.enqueue(bytes.subarray(30));controller.close()}}});
    const inFlight=sendSms(h,streamed,{}, {body:stream,signature:sign(streamed.callback,raw)});await reading;await h.post(`connections/${c.id}/revoke`);finish();
    assert.ok([401,409].includes((await inFlight).status));assert.equal((await runs(h,streamed)).length,0);assert.equal(effects.length,2);
    await h.post(`connections/${c.id}/rotate`,{secret:{secret}});
    // A changed owner version fences both receiving and already admitted waits.
    const active=await smsWorkflow(h,c,{steps:[wait,effect]});await sendSms(h,active,smsFields({MessageSid:sid('SM','owner-wait')}));const ownerRun=await settled(h,(await runs(h,active))[0].id);assert.equal(ownerRun.status,'waiting');
    await h.db.prepare("UPDATE oa_operators SET version=version+1 WHERE role='owner'").run();
    const stale=await sendSms(h,active,smsFields({MessageSid:sid('SM','stale-owner')}));assert.equal(stale.status,409,stale.text);
    await h.tick(Date.parse(ownerRun.waits[0].due_at)+1000);assert.equal((await h.db.prepare('SELECT status FROM crank_wf_runs WHERE id=?').bind(ownerRun.id).first()).status,'paused');assert.equal(effects.length,2);
    assert.ok(fake.requests.every(request=>request.url.hostname==='receiver.example'));
  } finally {await h.close()}
}

/** Entire receiving records round-trip without credentials, execution or receiving grants. */
export async function twilioCustodyJourney() {
  const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});let restored,stale;
  try {
    const c=await signing(h),w=await smsWorkflow(h,c,{steps:[mapped]});
    await h.post(`workflows/${w.id}/pause`);await h.post('./data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['body','from']});await h.post(`workflows/${w.id}/resume`);
    const fields=smsFields();assert.equal((await sendSms(h,w,fields)).status,200);
    const run=await settled(h,(await runs(h,w))[0].id);assert.equal(run.status,'succeeded');
    assert.equal(JSON.parse((await h.db.prepare('SELECT trigger_json FROM crank_wf_runs WHERE id=?').bind(run.id).first()).trigger_json).sealed,'crank-payload-v1');
    await h.post(`workflows/${w.id}/pause`);assert.equal((await sendSms(h,w,smsFields({MessageSid:sid('SM','portable-held'),Body:'synthetic-crank-1706'}))).status,200);
    const [portableHold]=await h.get(`workflows/${w.id}/holds`);assert.equal((await h.get('holds/'+portableHold.id)).items.length,1);
    const saved=await archive(h);assert.ok(!saved.includes(secret)&&!saved.includes(fields.Body));
    const subject=await h.post('./data/subject',{subject:fields.Body});assert.ok(subject.workflow_runs.some(row=>row.id===run.id));
    restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await restored.post('./data/restore',{archive:saved,confirm:'RESTORE'});
    const source=new Set(inventory(saved)),received=inventory(await archive(restored)),added=received.filter(row=>!source.has(row));
    assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==added[0]),[...source].sort());
    assert.equal((await restored.get('workflows/'+w.id)).status,'paused');assert.ok((await restored.get('connections')).every(row=>row.status==='needs_reconnect'));
    await restored.restart();await restored.tick();
    const copy={...w,callback:restored.origin+'/hooks/twilio/'+w.id};assert.notEqual((await sendSms(restored,copy)).status,200);
    await restored.post(`workflows/${w.id}/resume`,{},restored.owner,409);await restored.post(`workflows/${w.id}/publish`,{},restored.owner,422);
    assert.equal(fake.requests.length,0);
    await restored.post(`connections/${c.id}/rotate`,{secret:{secret}});await restored.post(`workflows/${w.id}/draft`,{graph:{...w.graph,trigger:{...w.graph.trigger,callback_url:copy.callback}}});
    await restored.post(`workflows/${w.id}/publish`,{},restored.owner,409);assert.equal((await restored.get('workflows/'+w.id)).status,'paused','reconnecting and editing do not adopt receiving authority');
    const review=(await restored.get('workflows/'+w.id)).restore;await restored.post(`workflows/${w.id}/publish`,{restore_snapshot:review.snapshot,restore_decisions:{}},restored.owner,201);
    await h.post(`holds/${portableHold.id}/discard`,{all:true});
    await h.post(`workflows/${w.id}/pause`);
    const hold=await h.post('./data/holds',{kind:'subject',subject:fields.Body,reason:'Preserve received SMS'},h.owner,201);
    const held=await h.post('./data/subject',{subject:fields.Body});assert.match(held.workflow_runs.find(row=>row.id===run.id).blocked,/legal hold/);
    await h.post('./data/erase',{workflow_run_id:run.id,confirm:'ERASE'},h.owner,409);assert.equal((await h.get('workflow-runs/'+run.id)).trigger.body,fields.Body);
    await h.post(`data/holds/${hold.id}/release`);await h.post('./data/erase',{workflow_run_id:run.id,confirm:'ERASE'});await h.get('workflow-runs/'+run.id,h.owner,404);
    const journal=await archive(h);assert.ok(!journal.includes(fields.Body)&&!journal.includes(fields.MessageSid));
    stale=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await stale.post('./data/restore',{archive:saved,journal,confirm:'RESTORE'},stale.owner,409);
    await h.post(`workflows/${w.id}/resume`);await h.restart();const replay=await sendSms(h,w,fields);assert.equal(replay.status,409,replay.text);assert.match(replay.text,/erased/);assert.equal((await runs(h,w)).length,0);
    const expiry=smsFields({MessageSid:sid('SM','expiry'),Body:'synthetic-crank-1704'});await sendSms(h,w,expiry);const expiring=await settled(h,(await runs(h,w))[0].id);
    const policy={payload_days:1,attachment_days:null,history_days:30},preview=await h.post('./data/retention/preview',policy);await h.post('./data/retention',{...policy,digest:preview.digest});
    await h.tick('2026-11-12T15:02:00Z');await h.restart();const expired=await h.get('workflow-runs/'+expiring.id);assert.ok(expired.payload_expired_at);assert.deepEqual(expired.trigger,{});assert.ok(expired.steps.every(step=>step.input===null&&step.output===null));
    assert.equal((await sendSms(h,w,expiry)).status,200);assert.equal((await runs(h,w)).length,1,'expiry preserves the durable source identity');assert.deepEqual((await h.get('workflow-runs/'+expiring.id)).trigger,{});
    assert.ok(!(await archive(h)).includes(expiry.Body));assert.equal(fake.requests.length,0);
  } finally {await stale?.close();await restored?.close();await h.close()}
}

/** Existing owned-installation conformance covers this receiving door without an author service. */
export async function twilioOwnership(h) {
  const c=await signing(h),w=await smsWorkflow(h,c,{steps:[mapped]});const response=await sendSms(h,w);
  assert.equal(response.status,200,response.text);const run=await settled(h,(await runs(h,w))[0].id);assert.equal(run.status,'succeeded');assert.equal(stepOf(run,'fields').output.body,smsFields().Body);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await twilioInboundJourney();await twilioAuthorityJourney();await twilioCustodyJourney();console.log('Twilio native SMS receiving, authority, sealed custody and inactive restoration PASS')}
