import assert from 'node:assert/strict';
import {harness} from '/workspace/run-crank/tests/harness.mjs';
const h=await harness('http://127.0.0.1:9',{clock:'2026-11-30T23:59:59.999Z'});
let cookie=h.owner;
try {
 const person=async(path,body,method=body===undefined?'GET':'POST')=>{
  const response=await h.mf.dispatchFetch(h.origin+path,{method,headers:{cookie,origin:h.origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal(response.status,200,await response.clone().text());return response.json();
 };
 const people=await h.send('/auth/operators',undefined,cookie),email=people.value.find(p=>p.role==='owner').email;
 const token=await h.post('tokens',{label:'Approval outcome probe',scope:'agent'},cookie,201);
 await person('/agents/api/policy',{document:{schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',spend:{none:true},rules:[{id:'native',class:'*',do:'approval',approver:['sponsor'],wait:'P1D'}]}},'PUT');
 const held=[];
 for(let index=0;index<3;index++) {
  const response=await h.send('/mcp',{jsonrpc:'2.0',id:index,method:'tools/call',params:{name:'crank.workflows.create',arguments:{name:'Outcome probe '+index,graph:{trigger:{type:'manual'},steps:[]},idempotency_key:'synthetic-crank-'+index}}},'',{authorization:'Bearer '+token.token,accept:'application/json','mcp-protocol-version':'2025-11-25'});
  assert.equal(response.status,200,response.text);assert.equal(response.value.result._meta['com.runeditrun/error'].code,'approval_required',response.text);
 }
 held.push(...(await person('/agents/api/approvals')).approvals);
 for(const [index,action] of ['approve','reject'].entries()) {
  const view=held[index];const response=await person('/agents/api/approvals/'+view.id+'/'+action,{revision:view.revision,summary_sha256:view.summary_sha256});
  assert.equal(response.approval.state,index===0?'executed':'rejected');
 }
 const resolved=(await h.get('reports/usage?month=2026-11',cookie)).agent_usage;
 await h.restart({clock:'2026-12-01T23:59:59.999Z'});
 await h.send('/auth/magic-link',{email,returnTo:'/app'});
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);cookie=signed.cookie;
 assert.equal((await person('/agents/api/approvals/'+held[2].id)).approval.state,'expired');
 const expired=(await h.get('reports/usage?month=2026-11',cookie)).agent_usage;
 const outcomes=report=>report.agents[0].decisions.map(({outcome,request_attempts})=>({outcome,request_attempts}));
 console.log(JSON.stringify({base:'184178d3ca7b499818b5982021559c472a7a56dc',after_completion_and_rejection:{totals:resolved.totals,outcomes:outcomes(resolved)},after_expiry:{totals:expired.totals,outcomes:outcomes(expired)},expected_after_expiry:{totals:{request_attempts:3,replays:0,original_operations:3},outcomes:[{outcome:'done',request_attempts:1},{outcome:'refused',request_attempts:2}]}},null,2));
 assert.deepEqual(outcomes(expired),[{outcome:'done',request_attempts:1},{outcome:'refused',request_attempts:2}],'resolved approval requests must not remain pending');
}finally{await h.close()}
