import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classIds, subset, errorCode, APPROVAL } from './protocol.mjs';
import { schemaErrors } from './schema.mjs';

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
  const read = await c.mcp('resources/read', { uri: link.uri });
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
   const before = needsApproval ? await c.witness() : undefined;
   let answer = await c.tool(step.tool, args);
   checkClasses(c, step, answer, phase);
   const expectedDisposition = held ? needsApproval ? 'approval' : 'review' : 'autonomous';
   c.add(`BASE-AGENT-007.1.${phase}.${step.id}`, answer.decision?.disposition === expectedDisposition && answer.decision.revision === c.revision && answer.decision.classes.every(item => item.do === (held ? item.class === 'standard' ? 'review' : 'approval' : 'autonomous')), `${step.tool} must receive ${expectedDisposition} under revision ${c.revision}.`);
   if (needsApproval) {
    const approval = answer.result?._meta?.[APPROVAL];
    c.add(`BASE-AGENT-007.5.pending.${step.id}`, answer.result?.resultType === 'input_required' && approval?.id && typeof approval.url === 'string' && new URL(approval.url, c.origin).origin === c.origin && Number.isFinite(Date.parse(approval.expires_at)), `${step.tool} must return a pending handle, URL elicitation and expiry.`);
    const after = await c.witness();
    c.add(`BASE-AGENT-007.5.no-effect.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state before approval.`);
    if (!approval?.id) continue;
    const approved = await c.decideApproval(answer);
    c.add(`BASE-AGENT-008.5.approver.${step.id}`, approved.ok, `Signed-in sponsor approval returned HTTP ${approved.status}.`);
    answer = await c.tool(step.tool, args, { requestState: answer.result.requestState });
    checkClasses(c, step, answer, `${phase}.approved`);
    c.add(`BASE-AGENT-007.5.receipt.${step.id}`, !answer.result?.isError && answer.result?.resultType !== 'input_required' && Boolean(answer.result?._meta?.['com.runeditrun/receipt']) && answer.decision?.disposition === 'approval', 'The approved retry must complete with an approval receipt.');
   }
   c.add(`BASE-AGENT-013.4.${phase}.${step.id}`, answer.status === 200 && answer.result && !answer.result.isError && answer.result.resultType !== 'input_required', `${step.tool} did not complete (${errorCode(answer) ?? answer.status}).`);
   if (answer.result?.isError || answer.result?.structuredContent === undefined) continue;
   outputs.set(step.id, answer.result.structuredContent);
   checkOutput(c, step, answer, phase);
   await checkResources(c, step, answer, phase, held);
   if (injections && step.inject) {
    const injected = { ...args, ...c.resolve(step.inject, outputs), ...(!c.surface.tools.find(tool => tool.name === step.tool)?.readOnly ? { idempotency_key: randomUUID() } : {}) };
    const checked = await c.tool(step.tool, injected);
    c.add(`BASE-AGENT-005.5.${phase}.${step.id}`, isDeepStrictEqual(checked.decision?.classes, answer.decision?.classes) && checked.decision?.disposition === answer.decision?.disposition && !checked.result?.isError, `${step.tool} changed class, facts or decision for additional arguments.`);
   }
   if (replay && !replayed && !c.surface.tools.find(tool => tool.name === step.tool)?.readOnly) {
    replayed = true;
    const beforeReplay = await c.witness(), repeated = await c.tool(step.tool, args), afterReplay = await c.witness();
    c.add(`BASE-AGENT-012.1.${phase}`, !repeated.result?.isError && isDeepStrictEqual(answer.result.structuredContent, repeated.result?.structuredContent) && isDeepStrictEqual(beforeReplay, afterReplay), `${step.tool} replay changed native state or returned a different result.`);

   }
  }
 } finally {
  if (!held) for (const step of c.surface.escalations ?? []) await c.phase(`BASE-AGENT-005.escalation.${step.id}`, async () => {
   const args = c.args(step, outputs), before = await c.witness();
   const answer = await c.tool(step.tool, args), after = await c.witness();
   c.add(`BASE-AGENT-005.1.${step.id}`, errorCode(answer) === 'self_escalation', `${step.tool} must refuse sponsor escalation with self_escalation (${errorCode(answer) ?? answer.status}).`);
   c.add(`BASE-AGENT-005.2.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state while attempting sponsor escalation.`);
  });
 }
 return outputs;
}
