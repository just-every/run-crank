import { isDeepStrictEqual } from 'node:util';
import { autonomousPolicy } from './crypto.mjs';
import { errorCode } from './protocol.mjs';

export async function unsetPolicy(c, initial = false) {
 const listed = await c.mcp('tools/list');
 c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.list`, isDeepStrictEqual(listed.result?.tools, []), 'An unanswered door must list no tools.');
 if (initial) {
  const inventory = await c.personJson('/agents/api/agents');
  const sponsor = inventory.agents?.find(agent => agent.id === c.agentId)?.sponsor;
  c.add('BASE-AGENT-004.6.sponsor', typeof sponsor?.id === 'string' && sponsor.id.length > 0, 'The native person agents inventory must identify the authenticated agent sponsor.');
  if (!sponsor?.id) throw new Error('Cannot resolve native sponsor ID from the person agents door');
  c.sponsor.id = sponsor.id;
 }
 for (const step of c.surface.journey) {
  // Admission under an absent policy precedes argument use. No prior result
  // exists in this phase; references are inert, invalid record identifiers.
  const answer = await c.tool(step.tool, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.${step.id}`, errorCode(answer) === 'policy_unset', `${step.tool} must refuse with policy_unset before setup.`);
 }
}
export async function removalPhase(c) {
 await c.adopt(autonomousPolicy());
 const before = await c.witness();
 await c.adopt(null);
 await unsetPolicy(c);
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-007.2.unset-no-effect', isDeepStrictEqual(before, await c.witness()), 'Calls under the removed policy changed native state.');
}
export async function blockedPhases(c) {
 const nonstandard = [...new Set(c.surface.tools.flatMap(tool => tool.classes))].filter(cls => cls !== 'standard');
 for (const cls of nonstandard) {
  await c.adopt(autonomousPolicy());
  const outputs = new Map();
  for (const step of c.surface.journey) {
   const args = c.args(step, outputs);
   if (step.expect.some(item => item.class === cls)) {
    const policy = autonomousPolicy(); policy.rules.push({ id: `block-${cls}`, class: cls, do: 'blocked' });
    await c.adopt(policy);
    const before = await c.witness(), refused = await c.tool(step.tool, args), after = await c.witness();
    c.add(`BASE-AGENT-007.1.blocked.${cls}.${step.id}`, errorCode(refused) === 'policy_blocked' && refused.decision?.disposition === 'blocked' && refused.decision.revision === c.revision && refused.decision.classes.some(item => item.class === cls && item.do === 'blocked'), `${step.tool} must be blocked by ${cls}.`);
    c.add(`BASE-AGENT-007.1.blocked-no-effect.${cls}.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state while ${cls} was blocked.`);
    await c.adopt(autonomousPolicy());
   }
   const completed = await c.tool(step.tool, args);
   if (completed.result?.isError || completed.result?.structuredContent === undefined) throw new Error(`Could not prepare ${step.id} for the ${cls} blocked variant (${errorCode(completed) ?? completed.status})`);
   outputs.set(step.id, completed.result.structuredContent);
  }
 }
}
export async function pausePhase(c) {
 await c.adopt(autonomousPolicy());
 const before = await c.witness();
 await c.adopt(autonomousPolicy(), { paused: true });
 for (const tool of c.surface.tools) {
  const step = c.surface.journey.find(item => item.tool === tool.name);
  const paused = await c.tool(tool.name, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-011.6.pause.${tool.name}`, errorCode(paused) === 'agents_paused', `${tool.name} ran while Business Pause was set.`);
 }
 const state = await c.personJson('/agents/api/state');
 c.add('BASE-AGENT-011.6.person', state.paused?.business === true, 'The signed-in person must still read paused state.');
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-011.6.resume', isDeepStrictEqual(before, await c.witness()), 'Pause calls changed native state, or resume did not restore access.');
}
