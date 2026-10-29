import { offers } from '../capabilities.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classIds, subset, errorCode, APPROVAL } from './protocol.mjs';
import { grantSet, narrowingTargets } from './narrowing.mjs';
import { schemaErrors } from './schema.mjs';
import { checkTarget } from './target.mjs';
import { nativeStepHook } from './step-hooks.mjs';
import { injectionArgs } from './injection.mjs';

export function checkClasses(c, step, answer, phase) {
 const actual = answer.decision?.classes;
 c.add(`BASE-AGENT-006.2.${phase}.${step.id}`, isDeepStrictEqual(classIds(actual), classIds(step.expect)) && step.expect.every(expected => actual?.some(item => item.class === expected.class && subset(item.facts, expected.facts ?? {}))), `${step.tool} computed classes/facts differ from ${step.id}: ${JSON.stringify(actual)}.`);
}
function checkOutput(c, step, answer, phase) {
 const schema = c.listed.get(step.tool)?.outputSchema;
 const errors = schema === undefined ? ['missing outputSchema'] : schemaErrors(schema, answer.result?.structuredContent);
 c.add(`BASE-AGENT-002.2.${phase}.${step.id}`, errors.length === 0, `${step.tool} output does not validate: ${errors.slice(0, 8).join('; ')}.`);
}
async function checkResources(c, step, answer, phase, held) {
 const links = answer.result?.content?.filter(item => item.type === 'resource_link') ?? [];
 for (const [i, link] of links.entries()) {
  const read = await c.mcp('resources/read', { uri: link.uri }, step.client === undefined ? {} : { client: step.client });
  const classes = read.decision?.classes, needsApproval = held && classes?.some(item => item.class !== 'standard');
  c.add(`BASE-AGENT-006.2.resource.${phase}.${step.id}.${i}`, Array.isArray(classes) && classes.length > 0 && read.decision.revision === c.revision && classes.every(item => item.do === (held ? item.class === 'standard' ? 'review' : 'approval' : 'autonomous')), `${link.uri} must apply the policy to its computed resource classes.`);
  c.add(`BASE-AGENT-003.4.${phase}.${step.id}.${i}`, read.status === 200 && (needsApproval
   ? errorCode(read) === 'approval_required' && read.decision?.disposition === 'approval' && !read.result?.contents?.length
   : !read.message?.error && read.decision?.disposition === (held ? 'review' : 'autonomous') && Array.isArray(read.result?.contents) && read.result.contents.length > 0), `${step.tool} resource_link ${link.uri} must ${needsApproval ? 'withhold content pending approval' : 'read back under the current policy'}.`);
  if (needsApproval) {
   const pending = read.body?.error?.data?.approval;
   c.add(`BASE-AGENT-007.5.resource.${phase}.${step.id}.${i}`, pending?.id && typeof pending.url === 'string' && new URL(pending.url, c.origin).origin === c.origin && Number.isFinite(Date.parse(pending.expires_at)), `${link.uri} must expose a pending approval on the native person door.`);
   if (pending?.id) {
    const { approval } = await c.personJson(`/agents/api/approvals/${encodeURIComponent(pending.id)}`);
    c.add(`BASE-AGENT-008.5.resource-summary.${phase}.${step.id}.${i}`, approval?.id === pending.id && approval.decision_id === read.decision.id && approval.revision === c.revision && /^[a-f0-9]{64}$/.test(approval.summary_sha256), `${link.uri} pending read must expose its exact summary hash and revision.`);
   }
  }
 }
}
export async function runJourney(c, phase, { held = false, injections = false, replay = false } = {}) {
 const outputs = new Map(); let replayed = false;
 try {
  for (const step of c.surface.journey) {
   const args = c.args(step, outputs), needsApproval = held && step.expect.some(item => item.class !== 'standard');
   await nativeStepHook(c, 'beforeStep', phase, step, args, outputs);
   const narrowing = !held && c.surface.narrowings?.find(fixture => fixture.step === step.id);
   const grantsBefore = narrowing ? await grantSet(c, narrowing.witness, outputs) : null;
   const before = needsApproval ? await c.witness() : undefined;
   const declared = c.surface.tools.find(tool => tool.name === step.tool);
   let proof = {};
   if (declared.proof) {
    if (!held) {
     const original = await c.witness(), challenge = await c.stepTool(step, args), bogus = await c.stepTool(step, args, { proofReference: 'bogus-native-proof' });
     const fields = challenge.result?._meta?.['com.runeditrun/error'];
     c.add(`BASE-AGENT-004.native-proof.${step.id}.challenge`, errorCode(challenge) === 'native_proof_required' && fields?.kind === declared.proofKind && typeof fields?.handoff === 'string' && new URL(fields.handoff).origin === c.origin, `${step.tool} requires its named native proof and a local human handoff.`);
     c.add(`BASE-AGENT-004.native-proof.${step.id}.bogus`, errorCode(bogus) === 'native_proof_required' && isDeepStrictEqual(original, await c.witness()), `${step.tool} must refuse bogus proof with no native effect.`);
     proof = await c.proof(step.tool, args, fields?.handoff, step.client);
    } else proof = await c.proof(step.tool, args, undefined, step.client);
   }
   let answer = await c.stepTool(step, args, proof);
   checkClasses(c, step, answer, phase);
   await checkTarget(c, step, outputs, answer, phase);
   const expectedDisposition = held ? needsApproval ? 'approval' : 'review' : 'autonomous';
   c.add(`BASE-AGENT-007.1.${phase}.${step.id}`, answer.decision?.disposition === expectedDisposition && answer.decision.revision === c.revision && answer.decision.classes.every(item => item.do === (held ? item.class === 'standard' ? 'review' : 'approval' : 'autonomous')), `${step.tool} must receive ${expectedDisposition} under revision ${c.revision}.`);
   if (needsApproval) {
    const approval = answer.result?._meta?.[APPROVAL];
    c.add(`BASE-AGENT-007.5.pending.${step.id}`, answer.result?.resultType === 'input_required' && approval?.id && typeof approval.url === 'string' && new URL(approval.url, c.origin).origin === c.origin && Number.isFinite(Date.parse(approval.expires_at)), `${step.tool} must return a pending handle, URL elicitation and expiry.`);
    const after = await c.witness();
    c.add(`BASE-AGENT-007.5.no-effect.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state before approval.`);
    if (!approval?.id) continue;
    const heldDecision = answer.decision, approved = await c.decideApproval(answer);
    await checkTarget(c, step, outputs, answer, phase, true);
    c.add(`BASE-AGENT-008.5.approver.${step.id}`, approved.ok, `Signed-in sponsor approval returned HTTP ${approved.status}.`);
    answer = await c.stepTool(step, args, { ...proof, requestState: answer.result.requestState });
    const receipt = answer.result?._meta?.['com.runeditrun/receipt'];
    // Older receipts carry only the original id; their current decision's
    // computed facts may change after the effect.
    const hasDecision = receipt && Object.hasOwn(receipt, 'decision');
    const approvedDecision = hasDecision ? receipt.decision : answer.decision;
    const originalEvidence = hasDecision ? isDeepStrictEqual(approvedDecision, heldDecision) : receipt?.decision_id === heldDecision.id;
    checkClasses(c, step, { decision: approvedDecision }, `${phase}.approved`);
    c.add(`BASE-AGENT-007.5.receipt.${step.id}`, !answer.result?.isError && answer.result?.resultType !== 'input_required' && receipt && approvedDecision?.disposition === 'approval' && originalEvidence && answer.decision?.revision === c.revision && answer.decision?.disposition === 'approval' && isDeepStrictEqual(answer.decision.classes, approvedDecision.classes), 'The approved retry must retain its exact original approval evidence and pass current policy admission.');
   }
   c.add(`BASE-AGENT-013.4.${phase}.${step.id}`, answer.status === 200 && answer.result && !answer.result.isError && answer.result.resultType !== 'input_required', `${step.tool} did not complete (${errorCode(answer) ?? answer.status}).`);
   if (answer.result?.isError || answer.result?.structuredContent === undefined) continue;
   outputs.set(step.id, answer.result.structuredContent);
   checkOutput(c, step, answer, phase);
   await checkResources(c, step, answer, phase, held);
   if (narrowing) {
    const witnessArgs = c.resolve(narrowing.witness.args, outputs);
    c.add(`BASE-AGENT-005.narrowing.${step.tool}.target`, narrowingTargets(declared).every(target => isDeepStrictEqual(witnessArgs[target], args[target])), `${step.tool} must witness every identifier of the same targeted subject.`);
    const after = await grantSet(c, narrowing.witness, outputs);
    c.add(`BASE-AGENT-005.narrowing.${step.tool}.subset`, after.length < grantsBefore.length && after.every(grant => grantsBefore.includes(grant)), `${step.tool} must strictly reduce the targeted subject's native grant set.`);
    const beforeInjection = await c.witness();
    const smuggled = await c.stepTool(step, { ...args, idempotency_key: randomUUID(), grant_to_add: 'admin' });
    c.add(`BASE-AGENT-005.narrowing.${step.tool}.undeclared`, errorCode(smuggled) === 'invalid_arguments' && isDeepStrictEqual(beforeInjection, await c.witness()), `${step.tool} must refuse an undeclared widening argument without an effect.`);
   }
   if (offers(c.surface.capabilities, 'events') && !c.surface.tools.find(tool => tool.name === step.tool)?.readOnly) {
    const snapshot = await c.tool(`${c.surface.seed}.events.list`, { limit: 200 }, { client: step.client });
    if (!Array.isArray(snapshot.result?.structuredContent?.events)) throw new Error('Post-effect events.list must return events');
    (c.effectEvents ??= []).push(...snapshot.result.structuredContent.events);
   }
   if (injections && step.inject) {
    const injected = await injectionArgs(c, step, outputs);
    const checked = await c.stepTool(step, injected, proof);
    c.add(`BASE-AGENT-005.5.${phase}.${step.id}`, isDeepStrictEqual(checked.decision?.classes, answer.decision?.classes) && checked.decision?.disposition === answer.decision?.disposition && !checked.result?.isError, `${step.tool} changed class, facts or decision for additional arguments.`);
   }
   if (replay && !replayed && !c.surface.tools.find(tool => tool.name === step.tool)?.readOnly) {
    replayed = true;
    const beforeReplay = await c.witness(), repeated = await c.stepTool(step, args, proof), afterReplay = await c.witness();
    c.add(`BASE-AGENT-012.1.${phase}`, !repeated.result?.isError && isDeepStrictEqual(answer.result.structuredContent, repeated.result?.structuredContent) && isDeepStrictEqual(beforeReplay, afterReplay), `${step.tool} replay changed native state or returned a different result.`);

   }
   await nativeStepHook(c, 'afterStep', phase, step, args, outputs, answer.result.structuredContent);
  }
 } finally {
  if (!held) for (const step of c.surface.escalations ?? []) await c.phase(`BASE-AGENT-005.escalation.${step.id}`, async () => {
   const args = c.args(step, outputs), before = await c.witness();
   const answer = await c.stepTool(step, args), after = await c.witness();
   c.add(`BASE-AGENT-005.1.${step.id}`, errorCode(answer) === 'self_escalation', `${step.tool} must refuse sponsor escalation with self_escalation (${errorCode(answer) ?? answer.status}).`);
   c.add(`BASE-AGENT-005.2.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state while attempting sponsor escalation.`);
  });
 }
 return outputs;
}
