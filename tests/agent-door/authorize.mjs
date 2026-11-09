import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// A native owner explicitly authorizes this disposable Business agent. Its
// credential still has to carry each scope; this ceiling never adds token scope.
export default async function authorize({agentId, request}) {
 const surface=JSON.parse(await readFile(new URL('../../agent-surface.json',import.meta.url),'utf8'));
 const response=await request('/api/crank/agent-access',{method:'POST',body:JSON.stringify({agent_id:agentId,scopes:[...new Set(surface.tools.map(tool=>tool.scope))]})});
 assert.equal(response.status,201);
}
