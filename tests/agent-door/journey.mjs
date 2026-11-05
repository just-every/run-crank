import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkClasses} from '../../src/modules/agent-door/conformance/journey.mjs';

const code = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.body?.error?.data?.code;
const output = answer => { assert.equal(answer.status, 200); assert.ok(!answer.result?.isError); assert.ok(answer.result?.structuredContent); return answer.result.structuredContent; };

// The seed's extra public-door checks supplement the shared CORE harness. All
// writes use native routes and the real policy/authority/persistence pipeline.
export default async function journey({request, origin, cookie, tool}) {
 await documentationJourney({request, origin, cookie});
 const person = async (path, body) => {
  const response = await request(origin + path, {
   ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)}),
   headers: {cookie, origin, 'content-type': ['application','json'].join('/')},
  });
  assert.ok(response.ok);
  return response.json();
 };
 const args = {name: 'Harbour Workshop — reviewed supplier intake', graph: {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {supplier: 'Harbour Workshop'}}]}, idempotency_key: crypto.randomUUID()};
 const admitted = await tool('crank.workflows.create', args), created = output(admitted);
 const native = await person('/api/crank/workflows/' + created.id);
 let after = '', row;
 do {
  const audit = await person('/agents/api/audit' + (after ? '?after=' + encodeURIComponent(after) : ''));
  assert.equal(audit.differs_from_policy, 0);
  row = audit.rows.find(row => row.id === admitted.decision.id);
  if (row || !audit.cursor || audit.cursor === after) break;
  after = audit.cursor;
 } while (!row);
 assert.ok(row);
 assert.equal(native.prepared_by.agent.id, row.agent.id);
 assert.equal(native.prepared_by.for.id, row.sponsor.id);
 assert.equal(native.prepared_by.label, row.agent.name + ' for ' + row.sponsor.name);

 const conflict = await tool('crank.workflows.create', {...args, name: 'Changed supplier intake'});
 assert.equal(code(conflict), 'idempotency_conflict');
 const before = output(await tool('crank.workflows.get', {workflow_id: created.id}));
 const edit = {workflow_id: created.id, draft_digest: before.draft_digest, expected_revision: before.revision, description: 'Prepared for owner review', idempotency_key: crypto.randomUUID()};
 const updated = output(await tool('crank.workflows.update', edit));
 const stale = await tool('crank.workflows.update', {...edit, description: 'Must not apply', idempotency_key: crypto.randomUUID()});
 assert.equal(code(stale), 'revision_conflict');
 assert.deepEqual(output(await tool('crank.workflows.get', {workflow_id: created.id})), updated);

 const witness = await person('/api/crank/workflows');
 await person('/agents/api/pause', {paused: true});
 try {
  assert.equal(code(await tool('crank.workflows.create', args)), 'agents_paused');
  assert.deepEqual(await person('/api/crank/workflows'), witness);
 } finally {
  await person('/agents/api/pause', {paused: false});
 }
 assert.equal(output(await tool('crank.workflows.create', args)).id, created.id);
}


const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"})[entity]);

// One sanity journey compares actual HTTP reference representations with both MCP doors.
export async function documentationJourney({request, origin, cookie, token}) {
 if (!token) {
  const issued = await request(origin + '/api/crank/tokens', {method:'POST',headers:{cookie,origin,'content-type':['application','json'].join('/')},body:JSON.stringify({label:'synthetic-crank-documentation',scope:'agent'})});
  assert.equal(issued.status,201); token=(await issued.json()).token;
 }
 const publicPage=await request(origin+'/docs/agents');
 assert.equal(publicPage.status,200);assert.match(publicPage.headers.get('content-type'),/text.html/);
 const html=await publicPage.text();assert.ok(!html.includes('<script'));
 const response=await request(origin+'/docs/agents',{headers:{accept:['application','json'].join('/')}});
 assert.equal(response.status,200);const doc=await response.json();
 assert.equal((await request(origin+'/docs/agents',{method:'POST',body:'{}'})).status,405);
 const head=await request(origin+'/docs/agents',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const surface=JSON.parse(await readFile(new URL('../../agent-surface.json',import.meta.url),'utf8'));
 const names=doc.tools.map(item=>item.name);
 assert.deepEqual(names,surface.tools.map(item=>item.name).sort());
 assert.deepEqual([...html.matchAll(/data-tool-name="([^"]+)"/g)].map(match=>decode(match[1])).sort(),[...names].sort());
 for(const path of ['/mcp','/api/crank/v1/mcp']) {
  const rpc=async(method,params={})=>{
   const reply=await request(origin+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':['application','json'].join('/'),'mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,params})});
   assert.equal(reply.status,200,method);const body=await reply.json();assert.ok(body.result,method);return body.result;
  };
  const discovered=await rpc(['server', 'discover'].join('/')),initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-crank-reference',version:'1'}});
  assert.equal(discovered.instructions,doc.instructions);assert.equal(initialized.instructions,doc.instructions);
  assert.ok(html.includes(doc.instructions.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])));
  assert.deepEqual(discovered._meta['com.runeditrun/limits'],doc.limits);
  assert.deepEqual(discovered._meta['com.runeditrun/capabilities'].declared,doc.capabilities);
  const listed=(await rpc(['tools', 'list'].join('/'))).tools;assert.deepEqual(listed.map(item=>item.name),names);
  assert.deepEqual((await rpc(['resources', 'templates', 'list'].join('/'))).resourceTemplates,doc.resourceTemplates);
  assert.deepEqual((await rpc(['prompts', 'list'].join('/'))).prompts,doc.prompts);
  assert.deepEqual(Object.keys(discovered.capabilities),['tools']);
  const refused=await rpc(['tools','call'].join('/'),{name:'crank.runs.get',arguments:{run_id:7}});
  assert.equal(refused.isError,true);assert.ok(doc.errorCodes[refused._meta['com.runeditrun/error'].code],'the live refusal is documented');
  const limitText=decode(html.split('aria-labelledby="limits"')[1].split('</section>')[0]);
  for(const value of Object.values(discovered._meta['com.runeditrun/limits']))assert.ok(limitText.includes(String(value)),'capacity is visible on the page');
  const errors=decode(html.split('aria-labelledby="errors"')[1].split('</section>')[0]);
  for(const [code,description] of Object.entries(doc.errorCodes)){assert.ok(errors.includes(code));assert.ok(errors.includes(description));}
  const guidance=decode(html.split('aria-labelledby="guidance"')[1].split('</section>')[0]);
  for(const text of doc.guidance)assert.ok(guidance.includes(text),'specialist guidance is visible');
  for(const item of listed) {
   const documented=doc.tools.find(tool=>tool.name===item.name),{job,classificationTests,...descriptor}=documented;
   assert.deepEqual(descriptor,item,'reference uses the actual enriched descriptor');assert.ok(job);
   const article=html.split('data-tool-name="'+item.name+'"')[1].split('</article>')[0];
   const schemas=[...article.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(match=>JSON.parse(decode(match[1])));
   assert.deepEqual(schemas,[item.inputSchema,item.outputSchema]);
   const visible=decode(article);
   assert.ok(visible.includes(item._meta['com.runeditrun/scope']),'the page shows the actual tool scope');
   for(const cls of item._meta['com.runeditrun/classes'])assert.ok(visible.includes(cls),'the page shows the actual class');
   for(const reference of classificationTests)for(const value of [reference.path,reference.name,...reference.cases])assert.ok(visible.includes(value),'the page exposes each named classification case');
   const declared=surface.tools.find(tool=>tool.name===item.name);
   assert.deepEqual(classificationTests,declared.classificationTests);
   for(const cls of item._meta['com.runeditrun/classes']) {
    const reference=classificationTests.find(test=>test.class===cls);assert.ok(reference);assert.equal(reference.name,checkClasses.name);
    const source=await readFile(reference.path,'utf8');assert.ok(source.includes('export function '+reference.name+'('));
    const expected=['autonomous','held'].flatMap(phase=>surface.journey.filter(step=>step.tool===item.name&&step.expect.some(value=>value.class===cls)).map(step=>'BASE-AGENT-006.2.'+phase+'.'+step.id));
    assert.ok(expected.length);assert.deepEqual(reference.cases,expected);
   }
  }
 }
 assert.deepEqual(doc.resourceTemplates,[]);assert.deepEqual(doc.eventTypes,[]);assert.deepEqual(doc.subscriptions,[]);
 return {doc,html};
}
