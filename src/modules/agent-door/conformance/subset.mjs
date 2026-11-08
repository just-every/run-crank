import { isDeepStrictEqual } from 'node:util';
import { capabilitySet, offers } from '../capabilities.mjs';
import { errorCode } from './protocol.mjs';

export function scopedSurface(surface) {
 if (!surface || typeof surface !== 'object') return surface;
 const set = capabilitySet(surface.capabilities);
 if (set.mode === 'legacy' || !surface || typeof surface !== 'object') return surface;
 // Only the built-in event tool is optional here. Native tools, authorization,
 // proofs, provider isolation and all declared native journeys remain intact.
 const enabled = tool => tool.name !== `${surface.seed}.events.list` || offers(surface.capabilities, 'events');
 const tools = surface.tools?.filter(enabled);
 return { ...surface, tools, journey: surface.journey?.filter(step => step?.tool !== `${surface.seed}.events.list` || offers(surface.capabilities, 'events')),
  resources: offers(surface.capabilities, 'resources') ? surface.resources : [] };
}
export async function refusalPhase(c) {
 const set = capabilitySet(c.surface.capabilities);
 if (set.mode === 'legacy') return;
 const discovery = await c.mcp('server/discover');
 c.add('BASE-AGENT-subset.discovery', isDeepStrictEqual(discovery.result?._meta?.['com.runeditrun/capabilities'], set), 'Discovery must identify the exact declared, refused and unscoped capabilities.');
 const witness = await c.witness();
 for (const capability of set.refused) {
  if (['resources', 'prompts'].includes(capability)) {
   c.add(`BASE-AGENT-subset.discovery.${capability}`, !Object.hasOwn(discovery.result?.capabilities ?? {}, capability), `${capability} must be absent from discovery.`);
   const listing = await c.mcp(capability === 'resources' ? 'resources/templates/list' : 'prompts/list');
   c.add(`BASE-AGENT-subset.list.${capability}`, isDeepStrictEqual(listing.result?.[capability === 'resources' ? 'resourceTemplates' : 'prompts'], []), `${capability} must list no undeclared items.`);
  }
  if (capability === 'events') {
   const listing = await c.mcp('tools/list');
   c.add('BASE-AGENT-subset.list.events', !listing.result?.tools?.some(tool => tool.name === `${c.surface.seed}.events.list`), 'Undeclared events must not appear in tools/list.');
  }
  if (capability === 'subscriptions') c.add('BASE-AGENT-subset.discovery.subscriptions', discovery.result?.capabilities?.tools?.listChanged === false && !discovery.result?.capabilities?.resources?.subscribe, 'Undeclared subscriptions must not be advertised.');
  const answer = capability === 'events' ? await c.tool(`${c.surface.seed}.events.list`, { limit: 1 })
   : capability === 'resources' ? await c.mcp('resources/read', { uri: `${c.surface.seed}://undeclared/${crypto.randomUUID()}` })
   : capability === 'prompts' ? await c.mcp('prompts/get', { name: 'undeclared' })
   : await c.mcp('subscriptions/listen', { notifications: { toolsListChanged: true } });
  c.add(`BASE-AGENT-subset.refused.${capability}`, errorCode(answer) === 'capability_not_declared' && (answer.result?._meta?.['com.runeditrun/error']?.capability ?? answer.body?.error?.data?.capability) === capability && !answer.result?.structuredContent && !answer.result?.contents, `${capability} must return typed capability_not_declared with no content.`);
 }
 c.add('BASE-AGENT-subset.refusal-no-effect', isDeepStrictEqual(witness, await c.witness()), 'Undeclared capability calls changed native state.');
}
