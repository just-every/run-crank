import assert from 'node:assert/strict';
import {connection,jsonResponse} from './kit.mjs';

export const recurringCases=[
 {name:'Open invoice blocks contact',invoice_status:'open',expected:'blocked'},
 {name:'Paid invoice ends the objective',invoice_status:'paid',expected:'stop'},
 {name:'Closed invoice ends the objective',invoice_status:'closed',expected:'stop'},
 {name:'Void invoice ends the objective',invoice_status:'void',expected:'stop'},
];
export async function recurringSetup(h,{invoiceId='synthetic-crank-301',realm='1234',token='synthetic-crank-302',interval=1440,expires,create=true}={}) {
 const account=await connection(h,{app:'quickbooks',label:'Harbour Workshop accounting sandbox',account_name:realm,environment:'sandbox',purpose:'test',auth_kind:'oauth2',scopes:['com.intuit.quickbooks.accounting'],secret:{access_token:token}});
 const step={id:'follow_invoice',type:'quickbooks.followup_invoice',name:'Check the connected overdue invoice',connection_id:account.id,input:{realm_id:realm,invoice_id:invoiceId}};
 const workflow=await h.post('workflows',{name:'Harbour Workshop overdue invoice follow-up',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[step]}},h.owner,201);
 const published=await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
 const grant=await h.post('grants',{label:'Read only the owner-selected overdue invoice',workflow_id:workflow.id,version_id:published.version.id,expires_at:expires??new Date(Date.now()+3600000).toISOString(),policy:{rules:[{step_id:step.id,type:step.type,connection_id:account.id,app:'quickbooks',fields:['realm_id','invoice_id'],recipients:[],max_per_minute:100}],approval:{timeout_seconds:3600,delegate_ids:[],escalate_to:[]}}},h.owner,201);
 const publication={name:'Harbour Workshop overdue invoice skill',workflow_id:workflow.id,workflow_version_id:published.version.id,instructions:'Read the exact connected invoice. Stop once paid, closed or void. Keep unavailable customer contact blocked for a person.',eval_cases:recurringCases};
 const skill=await h.post('recurring-skills',publication,h.owner,201);
 const objective={realm_id:realm,invoice_id:invoiceId,interval_minutes:interval};
 const request={name:'Follow up Harbour Workshop wholesale invoice',skill_version_id:skill.id,grant_id:grant.id,objective};
 const task=create?await h.post('recurring-tasks',request,h.owner,201):null;
 return {account,workflow,published,step,grant,publication,skill,objective,request,task};
}

export async function recurringOwnership(h,fake) {
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,url})=>{assert.equal(method,'GET');return jsonResponse({Invoice:{Id:url.pathname.split('/').at(-1),Balance:0,TxnStatus:'Paid',SyncToken:'1'}})});
 const {task}=await recurringSetup(h),started=await h.post(`recurring-tasks/${task.id}/dispatch`);
 const run=await h.get('workflow-runs/'+started.run_id);
 assert.equal(run.status,'succeeded');assert.equal(run.steps[0].output.objective_state,'satisfied');assert.equal(run.steps[0].output.invoice_state,'paid');
 assert.equal((await h.get('recurring-tasks/'+task.id)).status,'satisfied');
 return run.steps.filter(s=>s.status==='succeeded').map(s=>s.type);
}
