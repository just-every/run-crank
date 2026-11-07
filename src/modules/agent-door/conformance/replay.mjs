import { auditRows } from './audit.mjs';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, autonomousPolicy } from './crypto.mjs';
import { errorCode } from './protocol.mjs';

export async function replayAdmissionPhase(c, declaration) {
 if (!Array.isArray(declaration.prepare) || !declaration.prepare.length) throw new Error('replayAdmission.prepare must name preparation journey steps ending in a write.');
 await c.adopt(autonomousPolicy());
 await c.prepare('replay');
 const outputs = new Map(); let call;
 for (const id of declaration.prepare) {
  const step = c.surface.journey.find(step => step.id === id);
  if (!step) throw new Error('Unknown replay preparation step.');
  const args = c.args(step, outputs), answer = await c.stepTool(step, args);
  if (answer.result?.isError || answer.result?.structuredContent === undefined) throw new Error('Could not prepare a successful idempotent call.');
  outputs.set(id, answer.result.structuredContent); call = { step, args, answer };
 }
 if (!call.args.idempotency_key) throw new Error('Replay admission must finish preparation with a mutating tool.');
 const before = await c.witness(), repeated = await c.stepTool(call.step, call.args);
 c.add('BASE-AGENT-012.replay.current', !repeated.result?.isError && isDeepStrictEqual(repeated.result?.structuredContent, call.answer.result.structuredContent) && isDeepStrictEqual(before, await c.witness()), 'An admitted replay must return the saved result without another native effect.');
 await c.adopt(autonomousPolicy(), { paused: true });
 const paused = await c.stepTool(call.step, call.args);
 c.add('BASE-AGENT-012.replay.paused', errorCode(paused) === 'agents_paused' && paused.result?.structuredContent === undefined, 'A previously successful key must not expose cached content while agents are paused.');
 const rows = await auditRows(c);
 const row = rows.rows?.findLast(row => row.idempotency_key === call.args.idempotency_key);
 c.add('BASE-AGENT-012.replay.audit', row?.code === 'agents_paused' && row.outcome === 'refused' && row.agent?.id === (call.answer.principal?.agent.id ?? c.agentId) && row.sponsor?.id === c.sponsor.id && row.tool === call.step.tool && row.decision === 'paused' && row.revision === c.revision && Number.isFinite(Date.parse(row.at)), 'The refused replay needs its own complete audit with current attribution and policy revision.');
 const blocked = autonomousPolicy(); blocked.rules = [{ id: 'all', class: '*', do: 'blocked' }];
 await c.adopt(blocked);
 const refused = await c.stepTool(call.step, call.args);
 c.add('BASE-AGENT-012.replay.policy', errorCode(refused) === 'policy_blocked' && refused.result?.structuredContent === undefined, 'Current per-tool policy must run before replay lookup.');
 const held = autonomousPolicy(); held.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }];
 await c.adopt(held);
 const approval = await c.stepTool(call.step, call.args);
 c.add('BASE-AGENT-012.replay.approval', errorCode(approval) === 'approval_required' && approval.result?.structuredContent === undefined, 'A newly required approval cannot be satisfied by an older autonomous result.');
 await c.adopt(autonomousPolicy());
 const missing = await c.tool(call.step.tool, call.args, { token: await accessToken(c, { scope: 'events:read' }) });
 c.add('BASE-AGENT-012.replay.scope', missing.status === 403 && errorCode(missing) === 'insufficient_scope' && missing.result?.structuredContent === undefined, 'Current write scope is required even when the key has a successful outcome.');
 c.add('BASE-AGENT-012.replay.once', isDeepStrictEqual(before, await c.witness()), 'Authority changes and refused replays executed the effect again.');
}
