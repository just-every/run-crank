import { isDeepStrictEqual } from 'node:util';
import { auditRows } from './audit-rows.mjs';
import { APPROVAL } from './protocol.mjs';

export const targetIdentity = value => value !== null && typeof value === 'object' && !Array.isArray(value)
 && Object.keys(value).sort().join() === 'id,kind' && [value.kind, value.id].every(item => typeof item === 'string' && item.trim().length);

/** A journey expectation comes from native fixture state, never tool arguments alone. */
export async function checkTarget(c, step, outputs, answer, phase, execution = false) {
 if (!step.target) return;
 const expected = c.resolve(step.target, outputs), { rows } = await auditRows(c);
 const row = execution ? rows.findLast(row => row.decision_id === answer.decision?.id) : rows.find(row => row.id === answer.decision?.id);
 c.add(`BASE-AGENT-009.target.${phase}.${step.id}${execution ? '.execution' : ''}`, targetIdentity(expected) && isDeepStrictEqual(row?.resource, expected), `${step.tool} must audit its resolved native kind and id: ${JSON.stringify(row?.resource)} != ${JSON.stringify(expected)}.`);
 const approval = answer.result?._meta?.[APPROVAL];
 if (approval?.id && !execution) {
  const view = await c.personJson(`/agents/api/approvals/${encodeURIComponent(approval.id)}`);
  c.add(`BASE-AGENT-008.target.${phase}.${step.id}`, isDeepStrictEqual(view.approval?.summary?.nativeTarget, expected), `${step.tool} must bind the resolved native target into its approval summary.`);
 }
}
