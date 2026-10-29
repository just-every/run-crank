import { auditRows } from './audit.mjs';
import { isDeepStrictEqual } from 'node:util';
import { autonomousPolicy } from './crypto.mjs';
import { errorCode } from './protocol.mjs';
import { validateAgentSurface } from './surface.mjs';

/** Normal journey phases already require security policy and native approval.
 * This phase checks the explicit no-subject contract and undeclared widening. */
export async function recordSecurityPhase(c) {
 const tools = c.surface.tools.filter(tool => tool.authority === 'none');
 if (!tools.length) return;
 await c.adopt(autonomousPolicy());
 await c.prepare('no-subject');
 const outputs = new Map();
 for (const step of c.surface.journey) {
  const prepared = c.args(step, outputs);
  const answer = await c.stepTool(step, prepared, await c.proof(step.tool, prepared, undefined, step.client));
  if (answer.result?.isError || answer.result?.structuredContent === undefined) throw new Error('Could not prepare no-subject security journey.');
  outputs.set(step.id, answer.result.structuredContent);
  if (!tools.some(tool => tool.name === step.tool)) continue;
  const prefix = `BASE-AGENT-005.no-subject.${step.id}`;
  const before = await c.witness(), args = { ...c.args(step, outputs), role: 'owner', scopes: ['*'], person_id: c.sponsor.id };
  const refused = await c.stepTool(step, args);
  c.add(`${prefix}.undeclared`, errorCode(refused) === 'undeclared_arguments' && refused.result?.structuredContent === undefined, 'A no-subject tool must refuse undeclared widening arguments.');
  c.add(`${prefix}.unchanged`, isDeepStrictEqual(before, await c.witness()), 'An undeclared authority argument changed native state.');
  const rows = await auditRows(c);
  c.add(`${prefix}.audit`, rows.rows?.some(row => row.tool === step.tool && row.authority === 'none' && row.outcome === 'done')
   && rows.rows?.some(row => row.tool === step.tool && row.authority === 'none' && row.code === 'undeclared_arguments'), 'Audit must record the explicit authority class on successful and refused calls.');
  const invalid = structuredClone(c.surface), tool = invalid.tools.find(tool => tool.name === step.tool);
  tool.inputSchema.properties.person_id = { type: 'string' };
  const validation = validateAgentSurface(invalid);
  c.add(`${prefix}.negative-declaration`, !validation.ok && validation.points.some(point => point.id.endsWith(`${step.tool}.authority-none`) && !point.ok), 'A no-subject declaration carrying a person or grant must fail static validation.');
 }
}
