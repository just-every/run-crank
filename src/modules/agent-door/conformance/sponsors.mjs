import { auditRows } from './audit.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, autonomousPolicy } from './crypto.mjs';
import { createProtocol, errorCode, APPROVAL } from './protocol.mjs';

/** Additional principals use real native sessions and signed credentials. All
 * record and approval probes cross the same public doors as the main journey. */
export async function crossSponsorPhase(c, sponsors) {
 const declaration = c.surface.verification?.crossSponsor;
 if (!declaration || !Array.isArray(declaration.prepare) || !declaration.prepare.length || !declaration.read || !declaration.change) throw new Error('Multiple sponsors require verification.crossSponsor {prepare,read,change} fixtures.');
 for (const person of sponsors.slice(1)) {
  const b = createProtocol({ fetch: c.fetch, origin: c.origin, surface: c.surface, signer: c.signer, person,
   business: c.business, consent: randomUUID(), now: c.now, points: c.points, agentId: `rer-conformance-${randomUUID()}`, seq: c.seq, revision: c.revision, listed: c.listed });
  const prefix = `BASE-AGENT-004.cross-sponsor.${person.label}`;
  await c.adopt(autonomousPolicy());
  b.revision = c.revision;
  await b.mcp('tools/list');
  const inventory = await c.personJson('/agents/api/agents');
  const agent = inventory.agents?.find(item => item.id === b.agentId);
  b.sponsor.id = agent?.sponsor?.id;
  c.add(`${prefix}.binding`, typeof b.sponsor.id === 'string' && b.sponsor.id !== c.sponsor.id, 'Each labelled sponsor must resolve to a distinct active native principal.');
  const outputs = new Map(), ownOutputs = new Map();
  for (const id of declaration.prepare) {
   const step = c.surface.journey.find(item => item.id === id);
   if (!step) throw new Error('crossSponsor.prepare must name journey steps.');
   const a = await c.tool(step.tool, c.args(step, outputs));
   if (a.result?.isError || a.result?.structuredContent === undefined) throw new Error('Could not prepare private native records for cross-sponsor checks.');
   outputs.set(step.id, a.result.structuredContent);
   const own = await b.tool(step.tool, b.args(step, ownOutputs));
   if (own.result?.structuredContent !== undefined) ownOutputs.set(step.id, own.result.structuredContent);
   c.add(`${prefix}.own.${id}`, own.status === 200 && own.result?.structuredContent !== undefined && !own.result.isError, 'The second sponsor must successfully use its own signed agent credential.');
  }
  const before = await c.witness();
  for (const [kind, step] of [['read', declaration.read], ['change', declaration.change]]) {
   const answer = await b.tool(step.tool, b.args(step, outputs));
   c.add(`${prefix}.${kind}`, answer.result?.isError === true && typeof errorCode(answer) === 'string' && answer.result?.structuredContent === undefined, 'The second sponsor must not read or change the first sponsor\'s private record.');
  }
  c.add(`${prefix}.unchanged`, isDeepStrictEqual(before, await c.witness()), 'Cross-sponsor probes changed the first sponsor\'s private native state.');
  const held = autonomousPolicy(); held.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }];
  await c.adopt(held);
  const args = c.args(declaration.change, outputs), pending = await c.tool(declaration.change.tool, args), handle = pending.result?._meta?.[APPROVAL];
  c.add(`${prefix}.pending`, pending.result?.resultType === 'input_required' && typeof handle?.id === 'string', 'Cross-sponsor approval must be a real pending native action.');
  if (!handle?.id) throw new Error('No cross-sponsor approval handle.');
  const path = `/agents/api/approvals/${encodeURIComponent(handle.id)}`;
  const view = (await c.personJson(path)).approval;
  const hidden = await b.personRequest(path);
  c.add(`${prefix}.approval-private`, [403, 404].includes(hidden.status), 'Another sponsor\'s person session must not read private approval details.');
  await hidden.body?.cancel();
  const body = JSON.stringify({ revision: view.revision, summary_sha256: view.summary_sha256 });
  const rejected = await b.personRequest(`${path}/approve`, { method: 'POST', body });
  c.add(`${prefix}.approval-person`, [403, 404].includes(rejected.status), 'A second sponsor must not approve the first sponsor\'s action.');
  await rejected.body?.cancel();
  const agentAttempt = await b.request(`${path}/approve`, { method: 'POST', headers: { Origin: c.origin, Authorization: `Bearer ${await accessToken(b)}`, 'Content-Type': 'application/json' }, body });
  c.add(`${prefix}.approval-agent`, agentAttempt.status === 403, 'A second sponsor\'s agent credential cannot act as the first sponsor\'s approver.');
  await agentAttempt.body?.cancel();
  const after = (await c.personJson(path)).approval;
  c.add(`${prefix}.approval-unchanged`, after.state === 'pending' && after.approvals.length === 0, 'Cross-sponsor approval attempts changed its state.');
  await c.decideApproval(pending, 'reject');
  await c.adopt(autonomousPolicy());
  for (const principal of [c, b]) {
   const audit = await auditRows({ ...c, agentId: principal.agentId });
   const row = audit.rows?.findLast(item => item.tool === c.surface.journey.find(step => step.id === declaration.prepare[0]).tool && item.outcome === 'done');
   c.add(`${prefix}.attribution.${principal.person.label ?? 'first'}`, row?.sponsor?.id === principal.sponsor.id && row.agent?.id === principal.agentId && row.label?.includes(agentName(principal, inventory)), 'Native audit attribution must name the acting agent and its own sponsor.');
  }
 }
}
const agentName = (principal, inventory) => inventory.agents.find(item => item.id === principal.agentId)?.sponsor?.name ?? principal.person.email;
