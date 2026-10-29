import { offers } from '../capabilities.mjs';
import { isDeepStrictEqual } from 'node:util';
import { classIds } from './protocol.mjs';
import { AGENT_CLASSES } from './surface.mjs';
import { targetIdentity } from './target.mjs';
import { auditRows } from './audit-rows.mjs';

export { auditRows } from './audit-rows.mjs';

// Reuse recorded native witnesses without replaying the refused operation or
// comparing across another effect or policy/fixture round.
function refusalWitness(c, calls, index, direction) {
 const witness = c.surface.witness;
 for (let i = index + direction; i >= 0 && i < calls.length; i += direction) {
  const call = calls[i];
  if (call.decision?.revision !== calls[index].decision.revision) return;
  if (call.name === witness.tool && isDeepStrictEqual(call.args, c.resolve(witness.args))) return call.result?.isError ? undefined : call.result?.structuredContent;
  if (!c.surface.tools.find(tool => tool.name === call.name)?.readOnly && !call.code) return;
 }
}

function reviewProblem(c, calls, index, row, reviews) {
 const call = calls[index];
 if (row.outcome === 'refused') {
  if (typeof call.code !== 'string' || !call.code) return 'the returned refusal code is missing';
  if (row.code !== call.code) return 'the audit refusal code differs from the returned code';
  if (row.review !== null || call.result?._meta?.['com.runeditrun/review'] || reviews.some(review => review.decision_id === row.id)) return 'a refused call opened a review row';
  const before = refusalWitness(c, calls, index, -1), after = refusalWitness(c, calls, index, 1);
  if (before !== undefined && after !== undefined && !isDeepStrictEqual(before, after)) return 'the native witness changed across the refusal';
  return;
 }
 if (!['done', 'replayed'].includes(row.outcome)) return `the audit outcome ${row.outcome} is neither completed nor refused`;
 if (row.code != null || call.code || call.result?.isError) return 'the completed audit row contradicts the returned refusal code';
 if (!row.review?.id) return 'the completed call is missing its review row';
 if (!reviews.some(review => review.id === row.review.id && review.decision_id === (row.replay_of ?? row.id))) return 'the review row is not linked to the completed call';
}

// Only an earlier harness row can establish the origin of native work. A
// marker alone never exempts an embedded call from the ordered expectations.
function continuationRows(c, rows, differs, report = () => {}) {
 const recorded = new Map(c.calls.filter(call => call.kind !== 'approval/execute' && call.decision?.id).map(call => [call.decision.id, call]));
 const origins = new Map(), accepted = new Set(); let index = 0;
 for (const row of rows) {
  const call = recorded.get(row.id);
  if (call) {
   const principal = call.principal ?? { agent: { id: c.agentId, name: 'Agent door conformance', specialist: c.surface.specialist }, consent: c.consent, sponsor: c.sponsor.id, clientId: call.kind === 'embedded' ? null : 'rer-agent-conformance' };
   if (row.tool === call.name && row.agent?.id === principal.agent.id && row.agent?.name === principal.agent.name && row.agent?.specialist === principal.agent.specialist && row.sponsor?.id === principal.sponsor && row.consent === principal.consent && row.client_id === principal.clientId && typeof row.operation_id === 'string' && row.operation_id) {
    if (!origins.has(row.operation_id)) origins.set(row.operation_id, []);
    origins.get(row.operation_id).push(row);
   }
   continue;
  }
  if (row.continuation_item_id === undefined) continue;
  const origin = origins.get(row.operation_id)?.find(item => isDeepStrictEqual(item.agent, row.agent) && isDeepStrictEqual(item.sponsor, row.sponsor) && item.consent === row.consent && item.client_id === row.client_id);
  const dispositions = ['autonomous', 'review', 'approval', 'blocked', 'unset', 'unavailable', 'paused'];
  const classes = Array.isArray(row.classes) && row.classes.length > 0 && new Set(classIds(row.classes)).size === row.classes.length && row.classes.every(item => AGENT_CLASSES.includes(item.class) && item.facts && typeof item.facts === 'object');
  const rules = classes && Array.isArray(row.rules) && isDeepStrictEqual(classIds(row.rules), classIds(row.classes)) && row.rules.every(rule => dispositions.includes(rule.do) && (['unset', 'unavailable', 'paused'].includes(rule.do) ? rule.rule === null : typeof rule.rule === 'string' && rule.rule.length > 0));
  const valid = Boolean(origin) && row.door === 'embedded' && typeof row.continuation_item_id === 'string' && row.continuation_item_id.trim().length > 0
   && typeof row.label === 'string' && row.label.includes(' for ') && Number.isFinite(Date.parse(row.at))
   && Number.isSafeInteger(row.revision) && row.revision > 0 && rules && row.decision === dispositions[Math.max(...row.rules.map(rule => dispositions.indexOf(rule.do)))]
   && (row.outcome === 'done' && ['autonomous', 'review', 'approval'].includes(row.decision) && row.code === null || row.outcome === 'refused' && typeof row.code === 'string' && row.code.length > 0) && differs === 0;
  report(`BASE-AGENT-009.1.continuation.${index++}`, valid, 'Native continuation must link an earlier harness operation with the same agent, sponsor, consent and client, a recorded policy decision and a completed or coded refused outcome.');
  if (valid) accepted.add(row);
 }
 return accepted;
}

export async function auditPhase(c) {
 const { rows, differs } = await auditRows(c), expected = [...c.calls];
 const reviews = expected.some(call => call.decision?.disposition === 'review') ? (await c.personJson('/agents/api/reviews')).reviews : [];
 if (!Array.isArray(reviews)) throw new Error('Reviews API must return reviews');
 const continuations = continuationRows(c, rows, differs, c.add);
 c.add('BASE-AGENT-009.1.count', rows.length === expected.length + continuations.size, `Expected exactly ${expected.length} audit rows for tool calls, resource reads and approval executions plus ${continuations.size} native continuations, found ${rows.length}.`);
 c.add('BASE-AGENT-009.1.unique', new Set(rows.map(row => row.id)).size === rows.length, 'Every tool call, resource read and approval execution must have its own audit ID.');
 const perAgent = new Map(), positions = new Map(), previous = new Map();
 for (const row of rows) {
  if (continuations.has(row)) continue;
  if (!perAgent.has(row.agent?.id)) perAgent.set(row.agent?.id, []);
  positions.set(row, perAgent.get(row.agent?.id).length);
  perAgent.get(row.agent?.id).push(row);
 }
 for (const [index, call] of expected.entries()) {
  const principal = call.principal ?? { agent: { id: c.agentId, specialist: c.surface.specialist }, consent: c.consent, sponsor: c.sponsor.id };
  const candidates = perAgent.get(principal.agent.id) ?? [], decision = call.decision;
  const match = candidates.findIndex(row => call.kind === 'approval/execute' ? row.decision_id === decision?.id && row.id !== decision?.id
   : decision?.id ? row.id === decision.id : row.tool === call.name && row.decision_id === null && row.door === (call.kind === 'embedded' ? 'embedded' : 'mcp') && row.code === (call.code ?? null));
  const row = match < 0 ? undefined : candidates.splice(match, 1)[0];
  const ordered = row && positions.get(row) > (previous.get(principal.agent.id) ?? -1);
  if (row) previous.set(principal.agent.id, positions.get(row));
  c.add(`BASE-AGENT-009.1.call.${index}`, ordered && row.tool === call.name && row.consent === principal.consent && row.agent?.id === principal.agent.id && row.agent?.specialist === principal.agent.specialist && row.sponsor?.id === principal.sponsor && (!call.principal || row.client_id === principal.clientId && row.agent?.name === principal.agent.name) && typeof row.label === 'string' && row.label.includes(' for ') && Number.isFinite(Date.parse(row.at)) && row.door === (call.kind === 'embedded' ? 'embedded' : 'mcp'), `${call.name} lacks its complete ordered audit row.`);
  if (!row) continue;
  if (call.code === 'native_proof_required') c.add(`BASE-AGENT-004.native-proof.audit.${index}`, row.outcome === 'refused' && row.code === call.code, `${call.name} native proof challenge must retain its refused audit outcome.`);
  c.add(`BASE-AGENT-009.1.resource.${index}`, call.kind === 'resources/read' ? row.resource === call.args.uri : row.resource === null || targetIdentity(row.resource), `${call.name} audit resource must identify the requested URI or the seed-resolved native kind and id.`);
  c.add(`BASE-AGENT-009.2.link.${index}`, call.kind === 'approval/execute' ? row.id !== decision?.id && row.decision_id === decision?.id : row.decision_id === null, `${call.name} must ${call.kind === 'approval/execute' ? 'link its own execution row to the pending decision' : 'have its own call row without an approval execution link'}.`);
  const validClasses = Array.isArray(row.classes) && new Set(classIds(row.classes)).size === row.classes.length && row.classes.every(item => AGENT_CLASSES.includes(item.class) && item.facts && typeof item.facts === 'object');
  c.add(`BASE-AGENT-006.6.audit.${index}`, validClasses && (decision ? isDeepStrictEqual(classIds(row.classes), classIds(decision.classes)) && decision.classes.every(item => row.classes.some(actual => actual.class === item.class && isDeepStrictEqual(actual.facts, item.facts))) : call.kind === 'resources/read' || row.classes.length === 0), `${call.name} audit classes/facts differ from its computed decision.`);
  if (decision) c.add(`BASE-AGENT-009.2.decision.${index}`, (call.kind === 'approval/execute' || row.id === decision.id) && row.decision === decision.disposition && row.revision === decision.revision && isDeepStrictEqual(row.rules, decision.classes.map(({ class: cls, rule, do: disposition }) => ({ class: cls, rule, do: disposition }))), `${call.name} audit decision or revision differs from the response.`);
  else if (call.kind === 'resources/read') c.add(`BASE-AGENT-009.2.resource-rules.${index}`, Array.isArray(row.rules) && isDeepStrictEqual(classIds(row.rules), classIds(row.classes)) && row.rules.every(rule => typeof rule.rule === 'string' && ['autonomous', 'review', 'approval', 'blocked', 'unset'].includes(rule.do)), 'Resource audit classes must each carry the applied policy rule and disposition.');
  if (decision?.disposition === 'review') {
   const problem = reviewProblem(c, expected, index, row, reviews);
   c.add(`BASE-AGENT-009.4.review.${index}`, !problem, `${call.name} review audit: ${problem}.`);
  }
  if (call.pending) c.add(`BASE-AGENT-009.2.pending.${index}`, row.outcome === 'pending' && Boolean(call.approval?.id) && row.approval?.id === call.approval.id, `${call.name} must retain its original pending audit outcome and approval handle after the approval executes.`);
  if (call.kind === 'approval/execute') c.add(`BASE-AGENT-008.5.execution.${index}`, row.approval?.id === call.approvalId && row.approval.by?.includes(principal.sponsor) && row.outcome === (call.state === 'refused' ? 'refused' : 'done') && row.code === (call.code ?? null), `${call.name} approval execution must retain its returned outcome, code and named sponsor approval.`);
  if (call.result?._meta?.['com.runeditrun/receipt']) c.add(`BASE-AGENT-008.5.audit.${index}`, Boolean(row.approval?.id) && row.approval.by?.includes(row.sponsor.id), `${call.name} approval receipt lacks the signed-in sponsor as approver.`);
 }
 let extraIndex = 0;
 for (const extra of perAgent.values()) for (const row of extra) c.add(`BASE-AGENT-009.1.extra.${extraIndex++}`, false, `${row.tool} has no recorded harness call or valid native continuation.`);
 c.add('BASE-AGENT-007.7.differs-from-policy', differs === 0, `Audit evidence has ${differs} decisions that differ from the policy in force.`);
 // Audit is read before the events tool: its own call is audited as well, but
 // cannot occur in a snapshot taken before it was made.
 if (!offers(c.surface.capabilities, 'events')) return;
 const events = []; let after;
 for (let page = 0; page < 100; page++) {
  const result = await c.tool(`${c.surface.seed}.events.list`, { ...(after ? { after } : {}), limit: 200 });
  const content = result.result?.structuredContent;
  if (!Array.isArray(content?.events)) throw new Error('events.list did not return {events,cursor}');
  events.push(...content.events);
  if (content.events.length < 200 || content.cursor === after) break;
  after = content.cursor;
 }
 c.add('BASE-AGENT-010.2.events', events.length > 0 && new Set(events.map(event => event.id)).size === events.length && events.every(event => typeof event.id === 'string' && typeof event.type === 'string' && typeof event.uri === 'string' && event.actor && Number.isFinite(Date.parse(event.at))), 'Events must have stable unique ids, type, URI, actor and time.');
 for (const type of ['policy.adopted', 'approval.pending', 'approval.decided']) {
  const applicable = type === 'policy.adopted' || rows.some(row => row.approval);
  if (applicable) c.add(`BASE-AGENT-010.6.${type}`, events.some(event => event.type === type), `Missing ${type} event.`);
 }
 const writeTools = new Set(rows.filter(row => row.tool !== 'resources/read' && ['done', 'replayed'].includes(row.outcome) && c.surface.tools.find(tool => tool.name === row.tool)?.readOnly === false).map(row => row.tool));
 c.add('BASE-AGENT-010.1.effects', !writeTools.size || [...events, ...c.effectEvents ?? []].some(event => event.actor?.kind === 'agent' && !['policy.decision', 'approval.pending', 'approval.decided'].includes(event.type)), 'Completed writes must produce record-change events attributed to the agent while their native resources are readable.');
 if (events.length > 1) {
  const cursor = events[0].id;
  const replay1 = await c.tool(`${c.surface.seed}.events.list`, { after: cursor, limit: 200 });
  const replay2 = await c.tool(`${c.surface.seed}.events.list`, { after: cursor, limit: 200 });
  const ids = result => result.result?.structuredContent?.events?.map(event => event.id) ?? [];
  const first = ids(replay1), second = ids(replay2);
  c.add('BASE-AGENT-010.3.cursor', first.length > 0 && isDeepStrictEqual(first, second.slice(0, first.length)) && first[0] === events[1].id, 'Replaying one cursor must return the same retained event ids in order.');
 }
 const final = await auditRows(c);
 const finalContinuations = continuationRows(c, final.rows, final.differs);
 c.add('BASE-AGENT-009.1.events-audited', final.rows.length === c.calls.length + finalContinuations.size && final.differs === 0, `events.list audit calls mismatch: ${final.rows.length} audit rows for ${c.calls.length} calls and ${finalContinuations.size} native continuations.`);
}
