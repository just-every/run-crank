import { offers } from '../capabilities.mjs';
import { isDeepStrictEqual } from 'node:util';
import { classIds } from './protocol.mjs';
import { AGENT_CLASSES } from './surface.mjs';
import { targetIdentity } from './target.mjs';
import { auditRows } from './audit-rows.mjs';

export { auditRows } from './audit-rows.mjs';
export async function auditPhase(c) {
 const { rows, differs } = await auditRows(c), expected = [...c.calls];
 c.add('BASE-AGENT-009.1.count', rows.length === expected.length, `Expected exactly ${expected.length} audit rows for tool calls, resource reads and approval executions, found ${rows.length}.`);
 c.add('BASE-AGENT-009.1.unique', new Set(rows.map(row => row.id)).size === rows.length, 'Every tool call, resource read and approval execution must have its own audit ID.');
 const perAgent = new Map();
 for (const row of rows) {
  if (!perAgent.has(row.agent?.id)) perAgent.set(row.agent?.id, []);
  perAgent.get(row.agent?.id).push(row);
 }
 for (const [index, call] of expected.entries()) {
  const principal = call.principal ?? { agent: { id: c.agentId, specialist: c.surface.specialist }, consent: c.consent, sponsor: c.sponsor.id };
  const row = perAgent.get(principal.agent.id)?.shift(), decision = call.decision;
  c.add(`BASE-AGENT-009.1.call.${index}`, Boolean(row) && row.tool === call.name && row.consent === principal.consent && row.agent?.id === principal.agent.id && row.agent?.specialist === principal.agent.specialist && row.sponsor?.id === principal.sponsor && (!call.principal || row.client_id === principal.clientId && row.agent?.name === principal.agent.name) && typeof row.label === 'string' && row.label.includes(' for ') && Number.isFinite(Date.parse(row.at)) && row.door === (call.kind === 'embedded' ? 'embedded' : 'mcp'), `${call.name} lacks its complete ordered audit row.`);
  if (!row) continue;
  if (call.code === 'native_proof_required') c.add(`BASE-AGENT-004.native-proof.audit.${index}`, row.outcome === 'refused' && row.code === call.code, `${call.name} native proof challenge must retain its refused audit outcome.`);
  c.add(`BASE-AGENT-009.1.resource.${index}`, call.kind === 'resources/read' ? row.resource === call.args.uri : row.resource === null || targetIdentity(row.resource), `${call.name} audit resource must identify the requested URI or the seed-resolved native kind and id.`);
  c.add(`BASE-AGENT-009.2.link.${index}`, call.kind === 'approval/execute' ? row.id !== decision?.id && row.decision_id === decision?.id : row.decision_id === null, `${call.name} must ${call.kind === 'approval/execute' ? 'link its own execution row to the pending decision' : 'have its own call row without an approval execution link'}.`);
  const validClasses = Array.isArray(row.classes) && new Set(classIds(row.classes)).size === row.classes.length && row.classes.every(item => AGENT_CLASSES.includes(item.class) && item.facts && typeof item.facts === 'object');
  c.add(`BASE-AGENT-006.6.audit.${index}`, validClasses && (decision ? isDeepStrictEqual(classIds(row.classes), classIds(decision.classes)) && decision.classes.every(item => row.classes.some(actual => actual.class === item.class && isDeepStrictEqual(actual.facts, item.facts))) : call.kind === 'resources/read' || row.classes.length === 0), `${call.name} audit classes/facts differ from its computed decision.`);
  if (decision) c.add(`BASE-AGENT-009.2.decision.${index}`, (call.kind === 'approval/execute' || row.id === decision.id) && row.decision === decision.disposition && row.revision === decision.revision && isDeepStrictEqual(row.rules, decision.classes.map(({ class: cls, rule, do: disposition }) => ({ class: cls, rule, do: disposition }))), `${call.name} audit decision or revision differs from the response.`);
  else if (call.kind === 'resources/read') c.add(`BASE-AGENT-009.2.resource-rules.${index}`, Array.isArray(row.rules) && isDeepStrictEqual(classIds(row.rules), classIds(row.classes)) && row.rules.every(rule => typeof rule.rule === 'string' && ['autonomous', 'review', 'approval', 'blocked', 'unset'].includes(rule.do)), 'Resource audit classes must each carry the applied policy rule and disposition.');
  if (decision?.disposition === 'review') c.add(`BASE-AGENT-009.4.review.${index}`, Boolean(row.review?.id), `${call.name} was decided review without a review row.`);
  if (call.pending) c.add(`BASE-AGENT-009.2.pending.${index}`, row.outcome === 'pending' && Boolean(call.approval?.id) && row.approval?.id === call.approval.id, `${call.name} must retain its original pending audit outcome and approval handle after the approval executes.`);
  if (call.kind === 'approval/execute') c.add(`BASE-AGENT-008.5.execution.${index}`, row.approval?.id === call.approvalId && row.approval.by?.includes(c.sponsor.id) && row.outcome === 'done', `${call.name} approved execution lacks its completed row and named sponsor approval.`);
  if (call.result?._meta?.['com.runeditrun/receipt']) c.add(`BASE-AGENT-008.5.audit.${index}`, Boolean(row.approval?.id) && row.approval.by?.includes(row.sponsor.id), `${call.name} approval receipt lacks the signed-in sponsor as approver.`);
 }
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
 c.add('BASE-AGENT-009.1.events-audited', final.rows.length === c.calls.length && final.differs === 0, `events.list audit calls mismatch: ${final.rows.length} audit rows for ${c.calls.length} calls.`);
}
