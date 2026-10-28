import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {estimateHold,fakeEdge,jsonResponse,publish,runs,settled,stepOf} from './kit.mjs';

const address=(name,domain='vendor.example.test')=>[name,domain].join('@');
const mime=(major,minor)=>[major,minor].join('/');
const pdf=Buffer.from('%PDF-1.4\nsynthetic-crank-1\n%%EOF');
const messageId=(id)=>`<${address(id,'message.example.test')}>`;
export function emailFixture(to,{id='synthetic-crank-1',sender=address('purchasing'),headers=[],body='PO 4301',html='<p>PO 4301</p>',attachment=pdf}={}) {
  return [
    `From: Purchasing <${sender}>`,`To: ${to}`,`Cc: ${address('staff','buyer.example.test')}`,
    'Subject: =?UTF-8?Q?Forwarded_purchase_order?=',`Message-ID: ${messageId(id)}`,
    'MIME-Version: 1.0',...headers,`Content-Type: ${mime('multipart','mixed')}; boundary="synthetic-crank-outer"`,'',
    '--synthetic-crank-outer',`Content-Type: ${mime('multipart','alternative')}; boundary="synthetic-crank-alt"`,'',
    '--synthetic-crank-alt',`Content-Type: ${mime('text','plain')}; charset=utf-8`,'',body,
    '--synthetic-crank-alt',`Content-Type: ${mime('text','html')}; charset=utf-8`,'',html,'--synthetic-crank-alt--',
    '--synthetic-crank-outer',`Content-Type: ${mime('message','rfc822')}`,'',
    `From: ${address('original')}`,`To: ${address('orders','buyer.example.test')}`,'Subject: Vendor PO','Date: Wed, 28 Oct 2026 10:00:00 +0000',`Content-Type: ${mime('text','plain')}`,'','Original PO 4301',
    '--synthetic-crank-outer',`Content-Type: ${mime('application','pdf')}; name="order.pdf"`,'Content-Disposition: attachment; filename="order.pdf"','Content-Transfer-Encoding: base64','',attachment.toString('base64'),
    '--synthetic-crank-outer--','',
  ].join('\r\n');
}
export async function sendEmail(h,to,raw,{sender=address('purchasing'),stream=false}={}) {
  const query=new URLSearchParams({from:sender,to,format:'json'});
  const response=await h.mf.dispatchFetch(h.origin+(stream?'/__email-stream':'/cdn-cgi/local/email')+'?'+query,{method:'POST',body:raw,duplex:'half'});
  const text=await response.text();
  assert.equal(response.status,200,text);
  const value=JSON.parse(text);
  assert.notEqual(value.outcome,'exception',text);
  return stream?value.rejection:value.rejectReason??null;
}
const alias=(h,w,input={})=>h.post(`workflows/${w.id}/email-aliases`,{domain:'inbound.example.test',...input},h.owner,201);
const history=(h,w)=>h.get('./settings/email?workflow_id='+w.id);

/** Transport to native publication, admission, history and controlled destination. */
export async function inboundEmailJourney({onScreen=async()=>{},emitted=false}={}) {
  const edge=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:edge.edge,emitted,emailTransport:true});
  edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
  try {
    const graph={trigger:{type:'email',sender_allowlist:['vendor.example.test']},steps:[
      {id:'fields',type:'map',input:{sender:'{{trigger.sender}}',recipients:'{{trigger.recipients}}',subject:'{{trigger.subject}}',body:'{{trigger.text}}',html:'{{trigger.html}}',headers:'{{trigger.headers}}',forwarded:'{{trigger.forwarded}}',pdf:'{{trigger.files.attachment_0}}',envelope:'{{trigger.envelope}}'}},
      {id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/purchase-orders',body:{order:'{{trigger.text}}',file:'{{trigger.files.attachment_0}}'}}},
    ]};
    const w=await publish(h,'Forwarded purchase orders',graph),a=await alias(h,w);
    assert.equal((await h.send(`/api/crank/workflows/${w.id}/email-aliases`,{domain:'inbound.example.test'})).status,401);
    const agent=await h.post('tokens',{label:'Email preparation only',scope:'agent'},h.owner,201),authorization={authorization:'Bearer '+agent.token};
    assert.equal((await h.send(`/api/crank/workflows/${w.id}/email-aliases`,{domain:'inbound.example.test'},'',authorization)).status,403);
    assert.equal((await h.send('/api/crank/settings/email',undefined,'',authorization)).status,403);
    const opaque=await h.db.prepare('SELECT * FROM crank_email_aliases WHERE id=?').bind(a.id).first();
    assert.equal(JSON.stringify(opaque).includes(a.address),false,'only the address hash is stored');
    const raw=emailFixture(a.address);
    assert.equal(await sendEmail(h,a.address,raw),null);
    const run=await settled(h,(await runs(h,w))[0].id);assert.equal(run.status,'succeeded',JSON.stringify(run.error));
    const fields=stepOf(run,'fields').output;
    assert.equal(fields.subject,'Forwarded purchase order');assert.match(fields.sender,/Purchasing/);assert.equal(fields.recipients,a.address);assert.match(fields.body,/PO 4301/);assert.equal(fields.html,'<p>PO 4301</p>');
    assert.equal(fields.headers['message-id'],messageId('synthetic-crank-1'));assert.equal(fields.forwarded[0].sender,address('original'));assert.equal(fields.forwarded[0].subject,'Vendor PO');assert.equal(fields.forwarded[0].text,'Original PO 4301');
    assert.equal(fields.envelope.to,a.address);assert.equal(fields.pdf.name,'order.pdf');assert.equal(fields.pdf.sha256,createHash('sha256').update(pdf).digest('hex'));
    const file=await h.db.prepare('SELECT * FROM crank_files WHERE id=?').bind(fields.pdf.file_id).first();assert.equal(Buffer.from(file.content_base64,'base64').toString(),pdf.toString());
    assert.deepEqual(effects,[{order:'PO 4301',file:fields.pdf}]);
    await Promise.all([sendEmail(h,a.address,raw),sendEmail(h,a.address,raw)]);await h.restart();await sendEmail(h,a.address,raw);
    assert.equal((await runs(h,w)).length,1);assert.equal(effects.length,1);assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_files WHERE workflow_id=?').bind(w.id).first()).n,1);
    const denied=address('attacker','not-vendor.example.test');
    assert.match(await sendEmail(h,a.address,emailFixture(a.address,{id:'synthetic-crank-2'}),{sender:denied}),/Sender is not allowed/);
    assert.equal(effects.length,1,'forged From cannot override envelope sender allowlist');
    const secured=await publish(h,'Authenticated email only',{...graph,trigger:{...graph.trigger,authentication:['spf','dkim','dmarc']}}),sa=await alias(h,secured);
    assert.match(await sendEmail(h,sa.address,emailFixture(sa.address,{id:'synthetic-crank-auth',headers:['Authentication-Results: routing.example.test; spf=pass; dkim=pass; dmarc=pass','Received-SPF: pass']})),/Trusted routing authentication evidence unavailable/);
    assert.equal((await runs(h,secured)).length,0);assert.equal(effects.length,1);
    const other=await publish(h,'Another workflow',{...graph,steps:[]}),oa=await alias(h,other);
    await sendEmail(h,oa.address,emailFixture(oa.address));assert.equal((await runs(h,other)).length,1,'Message-ID is scoped to its workflow');
    const rotated=await alias(h,w,{rotate:a.id});
    assert.match(await sendEmail(h,a.address,emailFixture(a.address,{id:'synthetic-crank-old'})),/Alias revoked/);
    await sendEmail(h,rotated.address,emailFixture(rotated.address));assert.equal(effects.length,1,'rotation does not reset Message-ID identity');
    await sendEmail(h,rotated.address,emailFixture(rotated.address,{id:'synthetic-crank-rotated'}));assert.equal((await runs(h,w)).length,2);assert.equal(effects.length,2);
    const decisions=(await history(h,w)).receipts.map(r=>r.decision);for(const decision of ['admitted','duplicate','Sender is not allowed','Alias revoked or inactive'])assert.ok(decisions.includes(decision),JSON.stringify(decisions));
    await onScreen({h,w,run,state:'admission'});
    await h.post(`settings/email/${rotated.id}/revoke`);
    assert.match(await sendEmail(h,rotated.address,emailFixture(rotated.address,{id:'synthetic-crank-revoked'})),/Alias revoked/);assert.equal(effects.length,2);
    const waiting=await publish(h,'Paused inbound authority',{...graph,steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},...graph.steps]}),wa=await alias(h,waiting);
    await sendEmail(h,wa.address,emailFixture(wa.address,{id:'synthetic-crank-wait'}));
    const waitingRun=await settled(h,(await runs(h,waiting))[0].id);assert.equal(waitingRun.status,'waiting');
    await h.post(`settings/email/${wa.id}/revoke`);await h.tick(Date.now()+120000);assert.equal(effects.length,2,'revocation prevents the next dispatch of an admitted waiting run');
    const held=await publish(h,'Held inbound authority',graph),ha=await alias(h,held);
    await h.post(`workflows/${held.id}/pause`);await sendEmail(h,ha.address,emailFixture(ha.address,{id:'synthetic-crank-held'}));
    const heldReceipt=(await history(h,held)).receipts.find(r=>r.decision==='held');assert.ok(heldReceipt);assert.equal((await runs(h,held)).length,0);
    await h.post(`workflows/${held.id}/resume`);await h.post(`settings/email/${ha.id}/revoke`);
    const quote=await estimateHold(h,heldReceipt.hold_id);
    const released=await h.post(`holds/${heldReceipt.hold_id}/release`,{all:true,estimate_fingerprint:quote.estimate_fingerprint});
    assert.equal(released.runs[0].status,'paused');assert.equal((await settled(h,released.runs[0].id)).error.category,'authority');assert.equal(effects.length,2,'releasing a hold cannot bypass alias revocation');
    const draft=await h.post('workflows',{name:'Unpublished email',graph:{trigger:{type:'email'},steps:[]}},h.owner,201),da=await alias(h,draft);
    assert.match(await sendEmail(h,da.address,emailFixture(da.address)),/not published/);assert.equal((await runs(h,draft)).length,0);
    // Exact address allowlisting accepts its member and refuses a neighbour.
    const exact=await publish(h,'Exact sender',{trigger:{type:'email',sender_allowlist:[address('purchasing')]},steps:[]}),ea=await alias(h,exact);
    assert.equal(await sendEmail(h,ea.address,emailFixture(ea.address)),null);
    assert.match(await sendEmail(h,ea.address,emailFixture(ea.address,{id:'synthetic-crank-neighbour'}),{sender:address('other')}),/Sender is not allowed/);
  } finally {await h.close()}
}

/** Size limits, malformed input and a revoke while the raw stream is in flight. */
export async function inboundEmailBoundsJourney() {
  const h=await harness('http://127.0.0.1:9',{emailTransport:true});
  try {
    const w=await publish(h,'Bounded mail',{trigger:{type:'email'},steps:[]}),a=await alias(h,w),limit=25*1024*1024;
    // Multipart epilogue counts toward total size without becoming a mapped field.
    for(const size of [limit-1,limit,limit+1]) {
      const raw=emailFixture(a.address,{id:'synthetic-crank-size-'+size}),padded=raw+' '.repeat(size-Buffer.byteLength(raw));
      const refusal=await sendEmail(h,a.address,padded,{stream:true});
      if(size>limit)assert.match(refusal,/oversized/);else assert.equal(refusal,null);
    }
    assert.equal((await runs(h,w)).length,2);
    for(const raw of [
      `Message-ID: ${messageId('synthetic-crank-bad')}\r\nContent-Type: ${mime('multipart','mixed')}; boundary=x\r\n\r\n--x\r\nBroken`,
      emailFixture(a.address,{id:'synthetic-crank-transfer'}).replace(pdf.toString('base64'),'%%%invalid%%%'),
      emailFixture(a.address,{id:'synthetic-crank-big-file',attachment:Buffer.alloc(1024*1024+1)}),
      emailFixture(a.address,{id:'synthetic-crank-ambiguous',headers:[`Message-ID: ${messageId('synthetic-crank-second')}`]}),
      emailFixture(a.address,{id:'synthetic-crank-escaped',body:'\0'.repeat(250000)}),
    ])assert.match(await sendEmail(h,a.address,raw,{stream:true}),/Malformed/);
    assert.equal((await runs(h,w)).length,2);
    let resume,started;const reading=new Promise(resolve=>started=resolve);
    const raw=emailFixture(a.address,{id:'synthetic-crank-late'}),bytes=Buffer.from(raw);
    const stream=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,30));started();resume=()=>{controller.enqueue(bytes.subarray(30));controller.close()}}});
    const late=sendEmail(h,a.address,stream,{stream:true});await reading;
    await h.post(`settings/email/${a.id}/revoke`);resume();
    assert.match(await late,/authority changed|Alias revoked/);assert.equal((await runs(h,w)).length,2);
    const active=await alias(h,w);await h.db.prepare("UPDATE oa_operators SET version=version+1 WHERE role='owner'").run();
    assert.match(await sendEmail(h,active.address,emailFixture(active.address,{id:'synthetic-crank-stale-owner'}),{stream:true}),/authority changed/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_wf_runs WHERE workflow_id=?').bind(w.id).first()).n,2);
  } finally {await h.close()}
}

/** Full portable record comparison, inactive restored receiving and erase replay fences. */
export async function inboundEmailCustodyJourney() {
  const h=await harness('http://127.0.0.1:9',{emailTransport:true});let restored,destination;
  try {
    const w=await publish(h,'Private email custody',{trigger:{type:'email'},steps:[{id:'seen',type:'map',input:{file:'{{trigger.files.attachment_0}}',order:'{{trigger.text}}'}}]}),a=await alias(h,w);
    await h.post(`workflows/${w.id}/pause`);await h.post('./data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['text']});await h.post(`workflows/${w.id}/resume`);
    await sendEmail(h,a.address,emailFixture(a.address));
    const run=await settled(h,(await runs(h,w))[0].id),file=stepOf(run,'seen').output.file;
    const stored=await h.db.prepare('SELECT trigger_json FROM crank_wf_runs WHERE id=?').bind(run.id).first();assert.equal(JSON.parse(stored.trigger_json).sealed,'crank-payload-v1');
    const storedFile=await h.db.prepare('SELECT content_base64 FROM crank_files WHERE id=?').bind(file.file_id).first();assert.ok(!storedFile.content_base64.includes(pdf.toString('base64')),'attachment bytes are sealed too');
    const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200,archive.text);
    const tables=['crank_email_aliases','crank_email_receipts','crank_trigger_events','crank_files'];
    const records=text=>text.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).filter(item=>item.kind==='row'&&tables.includes(item.table)).map(item=>JSON.stringify({table:item.table,row:item.row})).sort();
    assert.ok(records(archive.text).length>=4);
    restored=await harness('http://127.0.0.1:9',{emailTransport:true});await restored.post('./data/restore',{archive:archive.text,confirm:'RESTORE'});
    const copy=await restored.send('/api/crank/data/export',{},restored.owner);assert.equal(copy.status,200);assert.deepEqual(records(copy.text),records(archive.text),'complete receiving, receipt and file records survive byte for byte');
    assert.equal((await restored.get(`workflows/${w.id}`)).status,'paused');assert.ok((await restored.get('./settings/email')).aliases.every(a=>a.active===0));
    await restored.restart();await restored.tick();assert.match(await sendEmail(restored,a.address,emailFixture(a.address)),/inactive/);
    await h.post(`workflows/${w.id}/pause`);await h.post('./data/erase',{workflow_run_id:run.id,confirm:'ERASE'});
    assert.equal(await h.db.prepare('SELECT 1 FROM crank_files WHERE id=?').bind(file.file_id).first(),null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_email_receipts WHERE run_id=?').bind(run.id).first()).n,0);
    const journal=await h.send('/api/crank/data/export',{},h.owner);
    destination=await harness('http://127.0.0.1:9',{emailTransport:true});const refused=await destination.send('/api/crank/data/restore',{archive:archive.text,journal:journal.text,confirm:'RESTORE'},destination.owner);assert.equal(refused.status,409,refused.text);
    await h.post(`workflows/${w.id}/resume`);await h.restart();assert.match(await sendEmail(h,a.address,emailFixture(a.address)),/erased/);assert.equal((await runs(h,w)).length,0);
    assert.equal(await h.db.prepare('SELECT 1 FROM crank_files WHERE id=?').bind(file.file_id).first(),null);
  } finally {await destination?.close();await restored?.close();await h.close()}
}
