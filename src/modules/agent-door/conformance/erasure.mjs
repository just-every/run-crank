import { isDeepStrictEqual } from 'node:util';
import { auditRows } from './audit-rows.mjs';
import { classIds, errorCode } from './protocol.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const outcome = value => ({ done: 'executed', refused: 'denied', pending: 'held', running: 'held', replayed: 'executed', failed: 'failed' })[value];
export const tombstone = value => object(value) && Object.keys(value).sort().join() === 'at,erasure_id'
 && text(value.erasure_id) && Number.isFinite(Date.parse(value.at));

/** Observe original evidence through the person door before a destructive call
 * can redact it. These snapshots stay in this disposable verifier, never in the
 * installation. Final verification still checks every retained row in order. */
export async function beforeDestruction(c, name) {
 if (!c.document || c.adoptedPolicy?.paused || !c.surface.tools.find(tool => tool.name === name)?.classes.includes('destructive')) return;
 if (c.surface.tools.some(tool => tool.name === `${c.surface.seed}.events.list`)) {
  const events = await c.tool(`${c.surface.seed}.events.list`, { limit: 200 });
  if (!Array.isArray(events.result?.structuredContent?.events)) throw new Error('Pre-erasure events must be readable');
  (c.effectEvents ??= []).push(...events.result.structuredContent.events);
 }
 const snapshot = await auditRows(c), reviews = await c.personJson('/agents/api/reviews');
 if (!Array.isArray(reviews.reviews) || snapshot.differs !== 0) throw new Error('Pre-erasure audit or review evidence is invalid');
 c.erasureEvidence ??= new Map(); c.erasureReviews ??= new Map();
 for (const row of snapshot.rows) if (!row.tombstone) c.erasureEvidence.set(row.id, structuredClone(row));
 for (const review of reviews.reviews) if (review.code !== 'subject_erased' && !review.tombstone) c.erasureReviews.set(review.id, structuredClone(review));
 return new Set(snapshot.rows.map(row => row.id));
}

/** A tombstone is a different, closed evidence shape, not an exemption from
 * audit. Preserve sequence, tool, classes, decision and outcome; forbid every
 * original target, fact, person, key, trace, rule and approval/review payload. */
export function redactedAudit(row, original) {
 const keys = 'agent,approval,at,classes,code,decision,id,idempotency_key,ignored_arguments,organisation_id,outcome,replay_of,resource,review,role,rules,scopes,sequence,sponsor,tombstone,tool,trace';
 const valid = object(row) && Object.keys(row).sort().join() === keys && tombstone(row.tombstone)
  && Number.isSafeInteger(row.sequence) && row.sequence > 0 && text(row.id) && text(row.tool) && Number.isFinite(Date.parse(row.at))
  && object(row.agent) && Object.keys(row.agent).join() === 'id' && text(row.agent.id)
  && Array.isArray(row.classes) && row.classes.every(item => object(item) && Object.keys(item).join() === 'class' && text(item.class))
  && new Set(classIds(row.classes)).size === row.classes.length
  && ['executed', 'denied', 'held', 'failed'].includes(row.outcome) && text(row.decision)
  && (row.code === null || text(row.code)) && (row.role === null || text(row.role))
  && (row.organisation_id === null || text(row.organisation_id))
  && isDeepStrictEqual(row.sponsor, { id: '', name: '' }) && [row.scopes, row.rules, row.ignored_arguments].every(value => isDeepStrictEqual(value, []))
  && [row.approval, row.review, row.resource, row.idempotency_key, row.trace ?? null, row.replay_of].every(value => value === null);
 if (!valid || !original) return valid;
 return row.id === original.id && row.sequence === original.sequence && row.at === original.at && row.tool === original.tool
  && row.agent.id === original.agent.id && row.role === (original.role ?? null) && row.code === (original.code ?? null)
  && row.decision === original.decision && row.outcome === outcome(original.outcome)
  && isDeepStrictEqual(classIds(row.classes), classIds(original.classes));
}

export function redactedReview(row, original) {
 return original && Object.keys(row).sort().join() === 'agent,classes,code,id,organisation_id,outcome,role,state,tombstone,tool'
  && tombstone(row.tombstone) && row.id === original.id && row.tool === original.tool && row.code === null
  && object(row.agent) && Object.keys(row.agent).join() === 'id' && text(row.agent.id)
  && (row.role === null || text(row.role)) && (row.organisation_id === null || text(row.organisation_id))
  && Array.isArray(row.classes) && row.classes.every(text) && isDeepStrictEqual(classIds(row.classes), classIds(original.classes))
  && row.state === ({ open: 'executed', reviewed: 'executed', flagged: 'executed', undone: 'executed', undoing: 'held' })[original.state]
  // Saved review inputs carry no execution outcome. Its retained marker stays
  // held; the separate review state preserves executed/reviewed/flagged/undone.
  && row.outcome === 'held';
}

export async function erasedCall(c, before, name, marker, decision) {
 if (!before) throw new Error('Erasure needs pre-effect evidence');
 const after = await auditRows(c), added = after.rows.filter(row => !before.has(row.id));
 const row = added.length === 1 ? added[0] : undefined;
 marker ??= row?.tombstone;
 if (!row || !redactedAudit(row) || row.tool !== name || !isDeepStrictEqual(row.tombstone, marker)
  || row.agent.id !== c.agentId || row.outcome !== 'held' || row.code !== null
  || decision && (row.decision !== decision.disposition || !isDeepStrictEqual(classIds(row.classes), classIds(decision.classes)))) throw new Error('Erasure must retain exactly its ordered, value-free admission audit');
 (c.erasedAdmissions ??= new Map()).set(marker.erasure_id, row);
 return row;
}

export async function erasedAnswer(c, answer, before, name) {
 if (errorCode(answer) !== 'subject_erased') return;
 const marker = answer.result?._meta?.['com.runeditrun/error']?.tombstone;
 if (!tombstone(marker) || answer.status !== 200 || !answer.result?.isError || answer.decision != null
  || answer.result.structuredContent !== undefined || Object.keys(answer.result._meta).sort().join() !== 'com.runeditrun/decision,com.runeditrun/error'
  || Object.keys(answer.result._meta['com.runeditrun/error']).sort().join() !== 'code,tombstone'
  || !isDeepStrictEqual(answer.result.content, [{ type: 'text', text: JSON.stringify({ code: 'subject_erased', tombstone: marker }) }])) throw new Error('Erased results must expose only subject_erased and its tombstone');
 const known = c.erasedAdmissions?.get(marker.erasure_id);
 if (known) {
  const after = await auditRows(c);
  if (!before || after.rows.some(row => !before.has(row.id)) || !isDeepStrictEqual(known.tombstone, marker)) throw new Error('Erased replay must not append an audit or expose new evidence');
  answer.erasure = known;
  return false;
 }
 answer.erasure = await erasedCall(c, before, name, marker);
 return true;
}

export async function erasedStep(c, step, args, answer, phase, outputs) {
 const row = answer.erasure;
 c.add(`BASE-AGENT-006.2.${phase}.${step.id}.erased`, redactedAudit(row) && isDeepStrictEqual(classIds(row.classes), classIds(step.expect)), 'Erasure must retain exactly the computed class identifiers and no personal facts.');
 c.add(`BASE-AGENT-007.1.${phase}.${step.id}.erased`, row.decision === (phase === 'held' ? 'approval' : 'autonomous'), 'Erasure must retain the admitted policy disposition.');
 const before = await c.witness(), replay = await c.stepTool(step, args), after = await c.witness();
 c.add(`BASE-AGENT-012.1.${phase}.${step.id}.erased`, errorCode(replay) === 'subject_erased' && isDeepStrictEqual(replay.erasure?.tombstone, row.tombstone)
  && isDeepStrictEqual(before, after), 'An erased key must refuse with the same value-free tombstone and no further native effect.');
 const value = { tombstone: row.tombstone };
 outputs.set(step.id, value);
 return value;
}
