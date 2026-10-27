import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

// Standalone clock proof for the clause's two-minute delay, outside push Verify.
const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge});
let rows=[],effects=[];
edge.routes.set('sheets.googleapis.com',()=>jsonResponse({values:[['Record ID','Status','Customer','Amount'],...rows]}));
edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
try {
 const c=await connection(h,{app:'google',auth_kind:'oauth2',label:'Clock proof spreadsheet',secret:{access_token:'synthetic-crank-70'}});
 const w=await publish(h,'Two-minute row settling',{trigger:{type:'app_poll',provider:'google_sheets',resource:'rows',connection_id:c.id,spreadsheet_id:'synthetic-crank-71',range:'Orders!A1:D100',key_field:'Record ID',event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Status'],changed_to:{Status:'Approved'},settle_delay:2,required_columns:['Customer','Amount']},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/clock',body:'{{trigger.properties}}'}}]});
 const tick=async()=>{
  const state=await h.get(`workflows/${w.id}/trigger`),due=Date.parse(state.poll.next_due_at);
  while(Date.now()<due){console.log('Waiting for the next real Cron minute');await pause(Math.min(15000,due-Date.now()+25))}
  await h.tick(Date.now());
 };
 await tick();rows=[['synthetic-crank-72','Approved','','']];await tick();assert.deepEqual(effects,[]);
 rows[0][2]='Complete buyer';await pause(50);rows[0][3]=450;await tick();assert.deepEqual(effects,[]);
 const observed=(await h.db.prepare('SELECT stable_since FROM crank_app_pending_rows WHERE workflow_id=?').bind(w.id).first()).stable_since;
 await h.restart();await tick();assert.deepEqual(effects,[],'one real minute after restart is still too soon');
 await tick();assert.deepEqual(effects,[{'Record ID':'synthetic-crank-72',Status:'Approved',Customer:'Complete buyer',Amount:450}]);assert.equal((await runs(h,w)).length,1);
 const elapsed=Date.now()-Date.parse(observed);assert.ok(elapsed>=120000,`released after only ${elapsed} ms`);
 const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 console.log(JSON.stringify({head,observed_at:observed,released_at:new Date().toISOString(),elapsed_ms:elapsed,runs:1,complete:true}));
} finally {await h.close()}
