import { isDeepStrictEqual } from 'node:util';
import { autonomousPolicy } from './crypto.mjs';
import { auditRows } from './audit.mjs';

/** The adapter drains serialized job input through the edition's real invoke door. */
export async function invocationPhase(c, invoke) {
 const step = c.surface.journey.find(item => !c.surface.tools.find(tool => tool.name === item.tool)?.readOnly);
 if (!step) throw new Error('Durable invocation conformance requires a mutating journey step.');
 await c.adopt(autonomousPolicy());
 await c.prepare('invocation');
 const who = { person: { id: c.sponsor.id }, agent: { id: c.agentId, name: 'Agent door conformance', specialist: c.surface.specialist }, consent: c.consent, scopes: [c.surface.tools.find(tool => tool.name === step.tool).scope] };
 const schedule = () => JSON.stringify({ name: step.tool, args: c.args(step, new Map(), { unresolved: true }), who });
 const run = async saved => {
  const job = JSON.parse(saved), result = await invoke(job.name, job.args, job.who);
  c.calls.push({ kind: 'embedded', name: job.name, args: job.args, decision: result.decision, code: result.code });
  return { job, result };
 };
 const before = await c.witness(), first = await run(schedule()), after = await c.witness();
 c.add('BASE-AGENT-012.invocation-effect', first.result.outcome === 'done' && !isDeepStrictEqual(before, after), 'A serialized invocation under live consent must complete its native effect.');
 const saved = schedule();
 await c.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [c.consent] } });
 const second = await run(saved);
 c.add('BASE-AGENT-012.invocation-revoked', second.result.outcome === 'refused' && second.result.code === 'consent_revoked', 'Final worker admission must refuse the saved originating consent with consent_revoked.');
 const { rows } = await auditRows(c);
 for (const [label, { job, result }] of [['done', first], ['refused', second]]) {
  const row = rows.find(item => item.door === 'embedded' && item.idempotency_key === job.args.idempotency_key);
  c.add(`BASE-AGENT-012.invocation-audit.${label}`, row?.consent === c.consent && row.agent?.id === who.agent.id && row.sponsor?.id === who.person.id
   && row.tool === job.name && row.outcome === result.outcome && row.code === (result.code ?? null) && Number.isFinite(Date.parse(row.at)) && Boolean(row.id)
   && (label !== 'refused' || row.revision === c.revision), 'Durable invocation audit must retain consent, agent, sponsor, tool, time, revision and outcome.');
 }
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-012.invocation-no-effect', isDeepStrictEqual(after, await c.witness()), 'A saved job under revoked consent changed native state.');
}
