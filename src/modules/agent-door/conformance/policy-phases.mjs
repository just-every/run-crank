import { isDeepStrictEqual } from 'node:util';
import { webcrypto } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { accessToken, autonomousPolicy, policyEnvelope, signJws, seconds } from './crypto.mjs';
import { errorCode } from './protocol.mjs';
import { nativeStepHook } from './step-hooks.mjs';
import { erasedStep } from './erasure.mjs';

export async function unsetPolicy(c, initial = false) {
 const listed = await c.mcp('tools/list');
 c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.list`, isDeepStrictEqual(listed.result?.tools, []), 'An unanswered door must list no tools.');
 if (initial) {
  const inventory = await c.personJson('/agents/api/agents');
  const sponsor = inventory.agents?.find(agent => agent.id === c.agentId)?.sponsor;
  c.add('BASE-AGENT-004.6.sponsor', typeof sponsor?.id === 'string' && sponsor.id.length > 0, 'The native person agents inventory must identify the authenticated agent sponsor.');
  if (!sponsor?.id) throw new Error('Cannot resolve native sponsor ID from the person agents door');
  c.sponsor.id = sponsor.id;
  await c.prepare('initial');
 }
 for (const step of c.surface.journey) {
  // No prior result exists here; unresolved references cannot identify native
  // records. Resolvable calls still retain their computed classification.
  const answer = await c.stepTool(step, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.${step.id}`, errorCode(answer) === 'policy_unset', `${step.tool} must refuse with policy_unset before setup.`);
 }
}
export async function removalPhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('removed');
 const before = await c.witness();
 await c.adopt(null);
 await unsetPolicy(c);
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-007.2.unset-no-effect', isDeepStrictEqual(before, await c.witness()), 'Calls under the removed policy changed native state.');
 await renewalRefusals(c);
}
async function renewalRefusals(c) {
 const state = await c.personJson('/agents/api/state'), approvals = await c.personJson('/agents/api/approvals'), before = await c.witness();
 const sign = payload => signJws(c.signer.privateKey, c.signer.kid, 'rer-agent-policy+jwt', payload);
 const changed = autonomousPolicy(); changed.rules = [{ id: 'all', class: '*', do: 'blocked' }];
 const foreign = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const cases = [
  ['expired', (_adopted, later) => sign({ ...later, exp: seconds(c.now) - 1 }), 'policy_invalid', 400],
  ['untrusted', (_adopted, later) => signJws(foreign.privateKey, c.signer.kid, 'rer-agent-policy+jwt', later), 'policy_invalid', 400],
  ['revision-mismatch', (_adopted, later) => sign({ ...later, document: changed }), 'policy_revision_invalid', 400],
  ['equal-iat', (adopted, later) => sign({ ...later, iat: adopted.iat }), 'policy_stale', 409],
  ['earlier-iat', (adopted, later) => sign({ ...later, iat: adopted.iat - 1 }), 'policy_stale', 409],
  ['document', (_adopted, _later, options) => policyEnvelope(c, changed, options).then(signed => signed.policy), 'policy_stale', 409],
  ['revision', (adopted, _later, options) => policyEnvelope(c, adopted.document, { ...options, revision: adopted.revision + 1 }).then(signed => signed.policy), 'policy_stale', 409],
  ['business', (adopted, _later, options) => policyEnvelope({ ...c, business: `${c.business}-other` }, adopted.document, options).then(signed => signed.policy), 'policy_stale', 409],
  ['paused', (adopted, later) => sign({ ...later, paused: !adopted.paused }), 'policy_stale', 409],
  ['revoked', (_adopted, later) => sign({ ...later, revoked: { agents: [c.agentId], consents: [c.consent] } }), 'policy_stale', 409],
  ['revision-signature', async (adopted, later) => {
   const claims = JSON.parse(Buffer.from(adopted.revision_signature.split('.')[1], 'base64url').toString());
   return sign({ ...later, revision_signature: await signJws(c.signer.privateKey, c.signer.kid, 'rer-agent-policy-revision+jwt', claims) });
  }, 'policy_stale', 409],
  ['untrusted-revision', async (adopted, later, options) => {
   const signed = await policyEnvelope({ ...c, signer: { ...c.signer, privateKey: foreign.privateKey } }, adopted.document, options);
   return sign({ ...later, revision_signature: signed.payload.revision_signature });
  }, 'policy_revision_invalid', 400],
 ];
 for (const [name, candidate, code, status] of cases) {
  await c.renewPolicy();
  const adopted = c.adoptedPolicy, later = { ...adopted, iat: adopted.iat + 1, exp: seconds(c.now) + 300 };
  const policy = await candidate(adopted, later, { seq: adopted.seq, revision: adopted.revision, iat: later.iat, exp: later.exp });
  const response = await c.request('/api/rer/agent-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) });
  const body = await response.json();
  const call = await c.tool(c.surface.witness.tool, c.resolve(c.surface.witness.args));
  // Slow requests may legitimately renew between probes. Only the verifier's
  // acknowledged renewal may change the expected expiry, never authority.
  const sameState = actual => isDeepStrictEqual({ ...state, policy: { ...state.policy, expires_at: new Date(c.adoptedPolicy.exp * 1000).toISOString() } }, actual);
  c.add(`BASE-AGENT-007.7.renew.${name}`, response.status === status && body.code === code &&
   sameState(await c.personJson('/agents/api/state')) && isDeepStrictEqual(approvals, await c.personJson('/agents/api/approvals')) &&
   !call.result?.isError && isDeepStrictEqual(before, call.result?.structuredContent), `${name} must refuse ${code} without changing policy, approvals or native state.`);
 }
}
export async function blockedPhases(c) {
 const nonstandard = [...new Set(c.surface.tools.flatMap(tool => tool.classes))].filter(cls => cls !== 'standard');
 for (const cls of nonstandard) {
  await c.adopt(autonomousPolicy());
  await c.prepare(`blocked:${cls}`);
  const outputs = new Map();
  for (const step of c.surface.journey) {
   const args = c.args(step, outputs);
   await nativeStepHook(c, 'beforeStep', `blocked:${cls}`, step, args, outputs);
   if (step.expect.some(item => item.class === cls)) {
    const policy = autonomousPolicy(); policy.rules.push({ id: `block-${cls}`, class: cls, do: 'blocked' });
    await c.adopt(policy);
    const before = await c.witness(), refused = await c.stepTool(step, args), after = await c.witness();
    c.add(`BASE-AGENT-007.1.blocked.${cls}.${step.id}`, errorCode(refused) === 'policy_blocked' && refused.decision?.disposition === 'blocked' && refused.decision.revision === c.revision && refused.decision.classes.some(item => item.class === cls && item.do === 'blocked'), `${step.tool} must be blocked by ${cls}.`);
    c.add(`BASE-AGENT-007.1.blocked-no-effect.${cls}.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state while ${cls} was blocked.`);
    await c.adopt(autonomousPolicy());
   }
   const completed = await c.stepTool(step, args, await c.proof(step.tool, args, undefined, step.client));
   if (completed.erasure) {
    const value = await erasedStep(c, step, args, completed, `blocked:${cls}`, outputs);
    await nativeStepHook(c, 'afterStep', `blocked:${cls}`, step, args, outputs, value);
    continue;
   }
   if (completed.result?.isError || completed.result?.structuredContent === undefined) throw new Error(`Could not prepare ${step.id} for the ${cls} blocked variant (${errorCode(completed) ?? completed.status})`);
   outputs.set(step.id, completed.result.structuredContent);
   await nativeStepHook(c, 'afterStep', `blocked:${cls}`, step, args, outputs, completed.result.structuredContent);
  }
 }
}
export async function pausePhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('paused');
 const before = await c.witness();
 await c.adopt(autonomousPolicy(), { paused: true });
 for (const tool of c.surface.tools) {
  const step = c.surface.journey.find(item => item.tool === tool.name);
  const paused = await c.stepTool(step, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-011.6.pause.${tool.name}`, errorCode(paused) === 'agents_paused', `${tool.name} ran while Business Pause was set.`);
 }
 const state = await c.personJson('/agents/api/state');
 c.add('BASE-AGENT-011.6.person', state.paused?.business === true, 'The signed-in person must still read paused state.');
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-011.6.resume', isDeepStrictEqual(before, await c.witness()), 'Pause calls changed native state, or resume did not restore access.');
}

export async function consentRevocationPhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('consent');
 const before = await c.witness();
 await c.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [c.consent] } });
 const step = c.surface.journey[0];
 const refused = await c.tool(step.tool, c.args(step, new Map(), { unresolved: true }));
 c.add('BASE-AGENT-004.consent-revoked', refused.status === 401, 'A revoked originating consent must refuse the next authenticated call.');
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-004.consent-no-effect', isDeepStrictEqual(before, await c.witness()), 'A call under revoked consent changed native state.');
}

/** The installation's own revocation ends an agent's Business tokens: a fresh token for the same agent is refused. */
export async function agentRevocationPhase(c, initializeAgent) {
 await c.adopt(autonomousPolicy());
 await c.prepare('revocation');
 const agentId = `rer-conformance-${randomUUID()}`, throwaway = { ...c, agentId, consent: randomUUID() };
 if (initializeAgent) {
  try { await initializeAgent({ agentId, person: c.person }); }
  catch {
   c.add('BASE-AGENT-001.agent-initializer', false, 'Native agent initialization failed; no captured mail, credentials or fixture values are logged.');
   return;
  }
 }
 const witness = { name: c.surface.witness.tool, arguments: c.resolve(c.surface.witness.args) };
 const call = async method => c.mcp(method, method === 'tools/call' ? witness : {}, { token: await accessToken(throwaway), track: false });
 const challenged = answer => answer.status === 401 && /resource_metadata="/.test(answer.headers.get('www-authenticate') ?? '');
 const admitted = await call('tools/call');
 c.add('BASE-AGENT-004.6.seed-admitted', admitted.status === 200 && admitted.result?.structuredContent !== undefined && !admitted.result.isError, 'A throwaway agent must be admitted before its revocation.');
 const before = await c.witness();
 const revoke = await c.personRequest(`/agents/api/agents/${encodeURIComponent(agentId)}/revoke`, { method: 'POST', body: '{}' });
 await revoke.body?.cancel();
 c.add('BASE-AGENT-004.6.seed-revoke', revoke.status === 200, 'The signed-in owner must be able to revoke the throwaway agent through the person door.');
 const refused = await call('tools/call'), listed = await call('tools/list');
 c.add('BASE-AGENT-004.6.seed-revoked', challenged(refused) && challenged(listed), 'After the installation revokes an agent, a fresh Business token for the same agent must receive 401 with a resource_metadata challenge on every method.');
 c.add('BASE-AGENT-004.6.seed-unchanged', isDeepStrictEqual(before, await c.witness()), 'A call under a revoked agent changed native state, or the main agent lost access.');
}
