import {recoveryJourney} from './recovery-journey.mjs';
import assert from 'node:assert/strict';
import attribution from './attribution-journey.mjs';
import namedApprovalsJourney from './named-approvals-journey.mjs';
import {readFile} from 'node:fs/promises';
import {checkClasses} from '../../src/modules/agent-door/conformance/journey.mjs';
import promptsJourney, {promptGuards} from './prompts-journey.mjs';

export async function afterStep(context) {
 if (context.step.id === 'run' && ['autonomous', 'held'].includes(context.phase)) await promptsJourney(context);
}

const code = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.body?.error?.data?.code;
const output = answer => { assert.equal(answer.status, 200); assert.ok(!answer.result?.isError); assert.ok(answer.result?.structuredContent); return answer.result.structuredContent; };

// The seed's extra public-door checks supplement the shared CORE harness. All
// writes use native routes and the real policy/authority/persistence pipeline.
export default async function journey({request, origin, cookie, tool}) {
 await recoveryJourney();
 await documentationJourney({request, origin, cookie});
 await promptGuards({request, origin, cookie});
 await namedApprovalsJourney();
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
 await attribution({request,origin,cookie,workflow:created,agent:{id:row.agent.id,name:row.agent.name},sponsor:{id:row.sponsor.id,name:row.sponsor.name}});

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
  assert.deepEqual(Object.keys(discovered.capabilities),['tools','prompts']);
  const promptText=decode(html.split('data-prompts')[1].split('</div>')[0]);
  for(const prompt of doc.prompts)for(const value of [prompt.name,prompt.title,prompt.description])assert.ok(promptText.includes(value),'the page shows each admitted prompt');
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

// Real MCP contention against the existing inert tools, with native fixture
// records and durable audit readback. No test-only tool or injected lease.
export async function contentionJourney({h: existing, observe = async () => {}} = {}) {
 const h = existing ?? await (await import('../harness.mjs')).harness('http://127.0.0.1:9', {clock: '2026-11-08T12:00:00.000Z'});
 const request = (url, init) => h.mf.dispatchFetch(url, init);
 const person = async path => {
  const response = await request(h.origin + path, {headers: {cookie: h.owner}});
  assert.equal(response.status, 200); return response.json();
 };
 const auditRows = async () => {
  const rows = []; let after = '';
  for (;;) {
   const page = await person('/agents/api/audit' + (after ? '?after=' + after : ''));
   assert.equal(page.differs_from_policy, 0); rows.push(...page.rows);
   if (!page.cursor || page.cursor === after) return rows;
   after = page.cursor;
  }
 };
 const usageIds = async () => (await h.db.prepare('SELECT decision_id FROM agent_door_usage ORDER BY decision_id').all()).results.map(row => row.decision_id);
 try {
  const fixture = await (await import('./fixtures.mjs')).default({phase: 'contention', request, origin: h.origin, cookie: h.owner});
  await (await import('./fixtures.mjs')).default({phase: 'contention-second', request, origin: h.origin, cookie: h.owner});
  const token = await h.post('tokens', {label: 'Synthetic contention preparation', scope: 'agent'}, h.owner, 201);
  const policy = await request(h.origin + '/agents/api/policy', {method: 'PUT',
   headers: {cookie: h.owner, origin: h.origin, 'content-type': 'application/json'},
   body: JSON.stringify({document: {schema: 'rer-agent-policy/1', catalogue: 'rer-agent-classes/1',
    rules: [{id: 'all', class: '*', do: 'autonomous'}], spend: {none: true}}})});
  assert.equal(policy.status, 200);
  const call = async (name, args, trace) => {
   const response = await h.send('/mcp', {jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
    params: {name, arguments: args, _meta: {traceparent: trace}}}, '', {
    authorization: 'Bearer ' + token.token, 'mcp-protocol-version': '2025-11-25'});
   return {status: response.status, body: response.value, result: response.value.result,
    decision: response.value.result?._meta?.['com.runeditrun/decision'], trace};
  };
  const baseline = await person('/api/crank/workflows');
  const baselineRuns = await person('/api/crank/workflow-runs');
  const {workflows: baselineEstimates, ...baselineNativeUsage} = await person('/api/crank/reports/usage');
  const baselineUsage = await usageIds();
  const controls = [
   await call('crank.runs.get', {run_id: fixture.values.run.id}, 'synthetic-crank-success'),
   await call('crank.runs.get', {run_id: 7}, 'synthetic-crank-invalid'),
   await call('crank.runs.get', {run_id: 'synthetic-crank-absent'}, 'synthetic-crank-inaccessible'),
   await call('crank.unknown.get', {}, 'synthetic-crank-unknown'),
   await call('crank.workflows.create', {name: 'Synthetic invalid draft', graph: {trigger: {type: 'manual'}, steps: [{id: 'invalid', type: 'synthetic-crank-unknown'}]},
    idempotency_key: 'synthetic-crank-invalid-graph'}, 'synthetic-crank-classification-refused'),
  ];
  assert.equal(output(controls[0]).id, fixture.values.run.id);
  assert.deepEqual(controls[0].decision.classes.map(({class: cls, facts}) => ({class: cls, facts})),
   [{class: 'standard', facts: {measure: 1}}]);
  assert.equal(code(controls[1]), 'invalid_arguments');
  assert.equal(code(controls[2]), 'resource_unavailable');
  assert.equal(code(controls[3]), 'tool_not_found');
  assert.equal(code(controls[4]), 'execution_failed');
  assert.equal(controls[4].status, 500, 'The native classifier rejects an invalid graph before producing classes');
  const batches = [];
  for (const kind of ['metadata', 'inert']) {
   const before = await person('/api/crank/workflows');
   const input = i => kind === 'metadata' ? {} : {name: 'Synthetic contention draft ' + i,
    graph: {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {record: 'synthetic-crank-1'}}]},
    idempotency_key: 'synthetic-crank-contention-' + i};
   const name = kind === 'metadata' ? 'crank.workflows.list' : 'crank.workflows.create';
   const answers = await Promise.all(Array.from({length: 12}, (_, i) => call(name, input(i), 'synthetic-crank-' + kind + '-' + i)));
   const refused = answers.filter(answer => code(answer) === 'decision_busy');
   const admitted = answers.filter(answer => !answer.result?.isError);
   assert.ok(refused.length > 0 && admitted.length > 0, 'Real concurrent MCP must exercise both admission and contention');
   assert.equal(refused.length + admitted.length, answers.length);
   const after = await person('/api/crank/workflows');
   const originalIds = new Set(before.map(workflow => workflow.id));
   assert.deepEqual(after.filter(workflow => originalIds.has(workflow.id)), before,
    'Concurrent calls cannot mutate existing native workflows');
   if (kind === 'metadata') assert.deepEqual(after, before);
   else {
    assert.equal(after.length, before.length + admitted.length);
    for (const answer of admitted) {
     const native = await person('/api/crank/workflows/' + output(answer).id);
     assert.equal(native.status, 'draft'); assert.equal(native.published_version_id, null);
    }
    for (const answer of refused) {
     const i = answers.indexOf(answer);
     assert.ok(!after.some(workflow => workflow.name === input(i).name),
      'A refused preparation cannot create its requested native draft');
    }
   }
   batches.push({kind, answers, expected: [{class: 'standard', facts: {measure: kind === 'metadata' ? before.length : 1}}]});
  }
  const rows = await auditRows(), byTrace = new Map(rows.map(row => [row.trace, row]));
  const usage = await usageIds(), refusedRows = [], results = [];
  for (const batch of batches) {
   for (const answer of batch.answers) {
    const row = byTrace.get(answer.trace); assert.ok(row);
    if (code(answer) !== 'decision_busy') {
     assert.deepEqual(row.classes, batch.expected);
     assert.equal(row.outcome, 'done'); assert.ok(usage.includes(row.id));
     continue;
    }
    refusedRows.push(row);
    assert.equal(answer.decision, null, 'An unevaluated call supplies no policy decision');
    assert.equal(row.decision, 'none'); assert.equal(row.decision_id, null);
    assert.deepEqual(row.rules, []); assert.equal(row.approval, null); assert.equal(row.review, null);
    assert.equal(row.outcome, 'refused'); assert.equal(row.code, 'decision_busy');
    assert.equal(row.revision, controls[0].decision.revision);
    assert.equal(row.sponsor.id, byTrace.get(controls[0].trace).sponsor.id);
    assert.equal(answer.result.structuredContent, undefined);
    for (const key of ['com.runeditrun/approval', 'com.runeditrun/review', 'com.runeditrun/receipt'])
     assert.equal(answer.result._meta[key], undefined);
    assert.deepEqual(row.scopes, byTrace.get(controls[0].trace).scopes);
    assert.ok(!usage.includes(row.id), 'A pre-decision refusal reserves no usage');
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM agent_door_calls WHERE decision_id=?').bind(row.id).first()).n, 0);
    results.push({kind: batch.kind, classes: row.classes, expected: batch.expected,
     decision: row.decision, rules: row.rules, outcome: row.outcome, code: row.code,
     usageReserved: usage.includes(row.id)});
   }
  }
  for (const answer of controls.slice(1)) {
   const row = byTrace.get(answer.trace); assert.ok(row);
   assert.deepEqual(row.classes, []); assert.deepEqual(row.rules, []);
   assert.equal(row.decision, 'none'); assert.equal(row.approval, null);
   assert.ok(!usage.includes(row.id));
  }
  const admittedCount = 1 + batches.reduce((n, batch) => n + batch.answers.filter(answer => !answer.result?.isError).length, 0);
  assert.equal(usage.length - baselineUsage.length, admittedCount, 'Only completed admitted calls reserve usage');
  assert.equal((await person('/api/crank/workflows')).length - baseline.length,
   batches.find(batch => batch.kind === 'inert').answers.filter(answer => !answer.result?.isError).length);
  assert.deepEqual(await person('/api/crank/workflow-runs'), baselineRuns);
  const nativeUsage = await person('/api/crank/reports/usage');
  const {workflows: estimates, ...accounting} = nativeUsage;
  assert.deepEqual(accounting, baselineNativeUsage,
   'Metadata reads and inert preparations reserve no native execution usage');
  const baselineIds = new Set(baselineEstimates.map(workflow => workflow.workflow_id));
  assert.deepEqual(estimates.filter(workflow => baselineIds.has(workflow.workflow_id)), baselineEstimates);
  for (const workflow of estimates.filter(workflow => !baselineIds.has(workflow.workflow_id))) {
   assert.equal(workflow.runs, 0); assert.equal(workflow.observed_steps, 0);
   assert.equal(workflow.observed_requests, 0); assert.equal(workflow.budget_accounted_usd, '0');
  }
  const nativeWorkflows = await person('/api/crank/workflows');
  await h.restart();
  assert.deepEqual(await auditRows(), rows, 'Every computed fact and refusal survives a durable restart');
  assert.deepEqual(await usageIds(), usage);
  assert.deepEqual(await person('/api/crank/workflows'), nativeWorkflows);
  assert.deepEqual(await person('/api/crank/workflow-runs'), baselineRuns);
  assert.deepEqual(await person('/api/crank/reports/usage'), nativeUsage);
  const witness = await person('/api/crank/workflows');
  await h.post('tokens/' + token.id + '/revoke', {});
  assert.equal((await call('crank.workflows.list', {}, 'synthetic-crank-revoked')).status, 401);
  assert.deepEqual(await person('/api/crank/workflows'), witness);
  await observe({status: results.every(row => JSON.stringify(row.classes) === JSON.stringify(row.expected)) ? 'pass' : 'fail',
   results, refused: refusedRows.length, admitted: admittedCount, controls: ['success', 'invalid', 'inaccessible', 'unknown', 'classification-refused', 'revoked'],
   restart: 'identical audit and usage readback', nativeEffects: 'only admitted inert drafts', usage: 'only admitted calls'});
  for (const row of results) assert.deepEqual(row.classes, row.expected, 'Contention audit retains exact completed native classification');
  const answers = new Map([...controls, ...batches.flatMap(batch => batch.answers)].map(answer => [answer.trace, answer]));
  const points = [];
  await (await import('../../src/modules/agent-door/conformance/audit.mjs')).auditPhase({
   agentId: rows[0].agent.id, surface: JSON.parse(await readFile(new URL('../../agent-surface.json', import.meta.url), 'utf8')),
   calls: rows.map(row => { const answer = answers.get(row.trace); assert.ok(answer); return {
    kind: 'tools/call', name: row.tool, decision: answer.decision, code: code(answer), result: answer.result,
    principal: {agent: row.agent, consent: row.consent, sponsor: row.sponsor.id, clientId: row.client_id},
   }; }),
   personJson: person, add: (id, ok, detail) => points.push({id, ok, detail}),
  });
  assert.deepEqual(points.filter(point => !point.ok), [], 'Shared conformance accepts completed classification only for undecided contention');

  console.log('PROBE BASE-AGENT-006 6: concurrent metadata and inert MCP calls -> computed standard facts, decision_busy, no decision, rule, approval, claim or usage reservation; durable restart readback');
  return {refused: refusedRows.length, admitted: admittedCount};
 } finally {
  if (!existing) await h.close();
 }
}
