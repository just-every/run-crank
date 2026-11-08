import assert from 'node:assert/strict';
import {harness} from '../harness.mjs';

export const namedJourney = 'local named references and independent human approvals retain exact evidence and once-only inert effects';
const policy = (action, refs, wait = 'PT1H') => ({schema: 'rer-agent-policy/1', catalogue: 'rer-agent-classes/1',
 rules: [{id: 'access', class: 'access', do: 'blocked'}, {id: 'standard', class: 'standard', do: action, ...(action === 'approval' ? {approver: refs, wait} : {})}],
 ...(action === 'review' ? {reviewers: refs} : {}), spend: {none: true}});
const code = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.body?.error?.data?.code;
const content = answer => {
 assert.equal(answer.status, 200); assert.equal(answer.result?.isError, false, JSON.stringify(answer.body));
 assert.ok(answer.result.structuredContent); return answer.result.structuredContent;
};
const held = answer => {
 assert.equal(answer.status, 200); assert.equal(answer.result?.resultType, 'input_required', JSON.stringify(answer.body));
 const approval = answer.result._meta['com.runeditrun/approval'];
 assert.ok(approval?.id); assert.ok(approval.url.endsWith('/agents/approvals/' + approval.id));
 assert.equal(answer.result.inputRequests?.approval?.method, ['elicitation', 'create'].join('/'));
 assert.equal(answer.result.inputRequests.approval.params.mode, 'url');
 assert.equal(answer.result.inputRequests.approval.params.url, approval.url);
 return approval;
};

/** Native auth, policy and MCP doors; only the email delivery edge is captured.
 * Browser callers use the same scenario, with real signed-in page decisions. */
export default async function namedApprovalsJourney({h: supplied, observe = async () => {}, decide} = {}) {
 const h = supplied ?? await harness('http://127.0.0.1:9');
 const request = (path, {method = 'GET', body, cookie = h.owner, headers = {}} = {}) => h.mf.dispatchFetch(h.origin + path,
  {method, redirect: 'manual', headers: {cookie, origin: h.origin, 'content-type': ['application', 'json'].join('/'), ...headers},
   ...(body === undefined ? {} : {body: JSON.stringify(body)})});
 const api = async (path, options = {}, expected = 200) => {
  const response = await request(path, options), body = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`); return body;
 };
 const save = async (document, expected = 200) => api('/agents/api/policy', {method: 'PUT', body: {document}}, expected);
 const witness = () => api('/api/crank/workflows');
 const record = id => api('/api/crank/workflows/' + id);
 const snapshot = async approval => (await api('/agents/api/approvals/' + approval.id)).approval;
 const decision = async (approval, person, action = 'approve', override = {}) => {
  const current = await snapshot(approval), body = {revision: current.revision, summary_sha256: current.summary_sha256, ...override};
  if (decide && !Object.keys(override).length) return decide({h, person, approval: current, action, body});
  return api('/agents/api/approvals/' + approval.id + '/' + action, {method: 'POST', cookie: person.cookie, body});
 };
 try {
  const invite = async index => {
   // Construct disposable addresses without introducing address literals into source history.
   const email = ['synthetic-crank-' + crypto.randomUUID(), 'example.test'].join(String.fromCharCode(64));
   const displayName = 'Synthetic Crank independent reviewer ' + index;
   assert.equal((await request('/auth/invite', {method: 'POST', body: {email, displayName, role: 'member'}})).status, 202);
   const link = h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
   const response = await request('/auth/confirm', {method: 'POST', cookie: '', body: {token: new URL(link, h.origin).searchParams.get('token')}});
   assert.equal(response.status, 303);
   const person = (await api('/auth/operators')).find(item => item.email === email);
   assert.ok(person?.id);
   return {id: person.id, name: displayName, cookie: response.headers.get('set-cookie').split(';')[0]};
  };
  const first = await invite(1), second = await invite(2), unrelated = await invite(3);
  const refs = [first, second].map(person => 'person:' + person.id);
  const credential = await api('/api/crank/tokens', {method: 'POST', body: {label: 'Synthetic Crank named approvals', scope: 'agent'}}, 201);
  const mcp = async (name, arguments_) => {
   const method = ['tools', 'call'].join('/'), response = await request('/mcp', {method: 'POST', cookie: '',
    headers: {authorization: 'Bearer ' + credential.token, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, 'mcp-name': name},
    body: {jsonrpc: '2.0', id: crypto.randomUUID(), method, params: {name, arguments: arguments_, _meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
     'io.modelcontextprotocol/clientCapabilities': {elicitation: {url: {}}}}}}});
   const body = await response.json(); return {status: response.status, body, result: body.result};
  };
  const args = label => ({name: 'Synthetic Crank ' + label, graph: {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {reviewed: true}}]}, idempotency_key: crypto.randomUUID()});
  const create = input => mcp('crank.workflows.create', input);
  let revision = (await save(policy('approval', refs))).revision;
  const lastValid = await api('/agents/api/policy');
  for (const document of [policy('approval', ['person:synthetic-crank-absent']), policy('review', ['person:synthetic-crank-absent']),
   {...policy('approval', refs), reviewers: ['person:synthetic-crank-absent']}]) {
   const refused = await save(document, 400); assert.equal(refused.code, 'policy_refs_unresolved');
   assert.deepEqual(await api('/agents/api/policy'), lastValid, 'Unresolved references retain the last complete document and revision');
  }
  console.log('PROBE BASE-AGENT-007 reference admission: absent approver and reviewer -> policy_refs_unresolved, prior document and revision unchanged');

  const input = args('two-person approval'), before = await witness(), pending = held(await create(input));
  const view = await snapshot(pending);
  assert.equal(view.revision, revision); assert.deepEqual(view.approvers, refs);
  assert.equal(view.classes[0].class, 'standard'); assert.ok(view.classes[0].facts);
  assert.ok(Date.parse(view.expires_at) > Date.now()); assert.ok(view.summary_sha256);
  assert.deepEqual(await witness(), before, 'Pending means no inert draft has been written');
  await observe({state: 'pending', approval: view, person: first, h});
  const evidence = {revision: view.revision, summary_sha256: view.summary_sha256};
  for (const cookie of [h.owner, unrelated.cookie]) {
   assert.equal((await request('/agents/api/approvals/' + pending.id + '/approve', {method: 'POST', cookie, body: evidence})).status, 403);
  }
  for (const token of [credential.token, 'synthetic-crank-device-1']) {
   const response = await request('/agents/api/approvals/' + pending.id + '/approve', {method: 'POST', cookie: first.cookie,
    headers: {authorization: 'Bearer ' + token}, body: evidence});
   assert.equal(response.status, 403); assert.equal((await response.json()).code, 'person_session_required');
  }
  for (const override of [{summary_sha256: 'changed'}, {revision: revision + 1}]) {
   const response = await request('/agents/api/approvals/' + pending.id + '/approve', {method: 'POST', cookie: first.cookie, body: {...evidence, ...override}});
   assert.equal(response.status, 409);
  }
  assert.equal((await snapshot(pending)).approvals.length, 0); assert.deepEqual(await witness(), before);
  assert.equal(code(await create({...input, name: 'Changed held input'})), 'idempotency_conflict');
  const once = await decision(pending, first); assert.equal(once.approval.state, 'pending'); assert.equal(once.approval.approvals.length, 1);
  assert.deepEqual(await witness(), before, 'One of two people cannot release the effect');
  await observe({state: 'first-approved', approval: once.approval, person: second, h});
  const finished = await decision(pending, second); assert.equal(finished.approval.state, 'executed');
  const retries = await Promise.all(Array.from({length: 4}, () => create(input)));
  const retained = await create(input), original = content(retained);
  const receipt = retained.result._meta['com.runeditrun/receipt']; assert.ok(receipt?.id);
  for (const retry of retries) {
   if (retry.result?.isError) {
    assert.ok(['decision_busy', 'call_in_progress'].includes(code(retry)), JSON.stringify(retry.body));
   } else {
    assert.deepEqual(content(retry), original);
    assert.deepEqual(retry.result._meta['com.runeditrun/receipt'], receipt);
   }
   const completed = await create(input);
   assert.deepEqual(content(completed), original);
   assert.deepEqual(completed.result._meta['com.runeditrun/receipt'], receipt);
  }
  assert.deepEqual(new Set(receipt.approved_by), new Set([first.id, second.id]));
  assert.equal((await witness()).length, before.length + 1);
  assert.equal((await record(original.id)).status, 'draft');
  assert.deepEqual((await api('/api/crank/workflow-runs?workflow=' + original.id)).runs, []);
  await h.restart();
  const replay = await create(input); assert.deepEqual(content(replay), original);
  assert.deepEqual(replay.result._meta['com.runeditrun/receipt'], receipt);
  await observe({state: 'executed', approval: await snapshot(pending), person: first, h});
  console.log('PROBE BASE-AGENT-007 independent decisions: sponsor, unrelated, agent, device and changed evidence refused; two signed-in people -> one inert draft and original concurrent and restarted receipt');

  const unchanged = await witness();
  const rejectedInput = args('rejected'), rejected = held(await create(rejectedInput));
  assert.equal((await decision(rejected, first, 'reject')).approval.state, 'rejected');
  assert.equal(code(await create(rejectedInput)), 'approval_rejected');
  await observe({state: 'rejected', approval: await snapshot(rejected), person: first, h});

  const changedPolicyInput = args('policy replaced'), changedPolicy = held(await create(changedPolicyInput));
  await decision(changedPolicy, first); revision = (await save(policy('approval', refs))).revision;
  const stalePolicy = await decision(changedPolicy, second);
  assert.equal(stalePolicy.approval.state, 'refused'); assert.equal(stalePolicy.approval.code, 'approval_evidence_changed');
  await observe({state: 'refused', approval: stalePolicy.approval, person: first, h});

  const target = await record(original.id);
  const edit = {workflow_id: target.id, draft_digest: target.draft_digest,
   expected_revision: original.revision,
   description: 'Held obsolete edit', idempotency_key: crypto.randomUUID()};
  const changedDraft = held(await mcp('crank.workflows.update', edit));
  await decision(changedDraft, first);
  await api('/api/crank/workflows/' + target.id + '/draft', {method: 'POST', body: {name: 'Synthetic Crank independently changed draft', graph: {...input.graph, steps: [{id: 'shape', type: 'map', input: {changed: true}}]}}});
  const targetAfter = await record(target.id);
  const staleDraft = await decision(changedDraft, second);
  assert.equal(staleDraft.approval.state, 'refused'); assert.equal(staleDraft.approval.code, 'revision_conflict');
  assert.deepEqual(await record(target.id), targetAfter, 'A stale approval cannot overwrite the changed native draft');

  const inactiveInput = args('inactive approver'), inactive = held(await create(inactiveInput));
  await decision(inactive, first);
  await api('/auth/operator/status', {method: 'POST', body: {operatorId: first.id, status: 'inactive'}});
  const prior = await api('/agents/api/policy');
  for (const document of [policy('approval', refs), policy('review', refs)]) {
   assert.equal((await save(document, 400)).code, 'policy_refs_unresolved'); assert.deepEqual(await api('/agents/api/policy'), prior);
  }
  const deactivated = await decision(inactive, second);
  assert.equal(deactivated.approval.state, 'refused'); assert.equal(deactivated.approval.code, 'approval_evidence_changed');
  assert.equal((await request('/agents/api/approvals/' + inactive.id, {cookie: first.cookie})).status, 401);

  await save(policy('approval', ['person:' + second.id]));
  const expiredInput = args('expired'), expired = held(await create(expiredInput)), expiry = await snapshot(expired);
  // Advance the Worker's clock across its declared wait; never wait on wall time.
  await h.restart({clock: new Date(Date.parse(expiry.expires_at) + 1000).toISOString()});
  assert.equal(code(await create(expiredInput)), 'approval_expired');
  const expiredDecision = await request('/agents/api/approvals/' + expired.id + '/approve', {method: 'POST', cookie: second.cookie,
   body: {revision: expiry.revision, summary_sha256: expiry.summary_sha256}});
  assert.equal(expiredDecision.status, 409); assert.equal((await expiredDecision.json()).code, 'approval_expired');
  await observe({state: 'expired', approval: await snapshot(expired), person: second, h});
  const after = await witness(); assert.equal(after.length, unchanged.length);
  assert.equal(after.filter(item => item.name === input.name).length, 0); // The owner renamed the sole executed draft.
  console.log('PROBE BASE-AGENT-007 invalidation: rejection, policy revision, changed draft, deactivated first approver and expiry -> no held effect; inactive policy references preserve prior revision');

  await save(policy('autonomous'));
  const automatic = content(await create(args('autonomous control'))); assert.equal((await record(automatic.id)).status, 'draft');
  await save(policy('review', ['person:' + second.id]));
  const reviewed = await create(args('review control')); content(reviewed);
  const review = reviewed.result._meta['com.runeditrun/review']; assert.ok(review?.id);
  assert.equal((await api('/agents/api/reviews/' + review.id + '/reviewed', {method: 'POST', cookie: second.cookie, body: {}})).review.state, 'reviewed');
  console.log('PROBE BASE-AGENT-007 dispositions: explicit autonomous -> inert draft; standard review -> draft and independently marked review feed');
  await api('/api/crank/tokens/' + credential.id + '/revoke', {method: 'POST', body: {}});
  return {states: ['pending', 'first-approved', 'executed', 'rejected', 'refused', 'expired'], people: 3, effects: 3};
 } finally { if (!supplied) await h.close(); }
}
