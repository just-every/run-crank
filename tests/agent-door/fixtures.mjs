// Disposable native records, prepared through the owner's real public HTTP doors.
// No providers, credentials, direct SQL or application-only fixture routes.
import {unansweredPrompts} from './prompts-journey.mjs';

export async function prepareRecords({phase, request, origin, cookie}) {
 const post = async (path, body) => {
  const response = await request(origin + '/api/crank' + path, {
   method: 'POST', headers: {cookie, origin, 'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Native phase preparation was refused');
  return response.json();
 };
 const graph = {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {supplier: 'Harbour Workshop', status: 'received'}}]};
 const workflow = await post('/workflows', {name: 'Harbour Workshop — ' + phase, folder: 'Agent conformance fixtures', graph});
 const run = await post('/workflows/' + workflow.id + '/test', {input: {supplier: 'Harbour Workshop'}, bindings: {}});
 return {values: {run: {id: run.id}}};
}

export default async function prepare(context) {
 const {phase,request,origin,cookie}=context;
 if (phase === 'initial') await unansweredPrompts(context);
 const fixture=await prepareRecords(context);
 const grants=await request(origin+'/api/crank/agent-access',{headers:{cookie}}).then(response=>response.json());
 const access=grants.grants.find(grant=>!grant.agent_id.startsWith('crank-token:'));
 return {values: {...fixture.values, access:{...access,wider:[...access.scopes,'workflows:publish'],after_revision:access.revision+1}}};
}
