import {array, object} from './bindings.mjs';
/** Adapter capability only; this is not evidence of an executed export or restore. */
export function portableResourceCapability(plan) {
  object(plan, 'candidate plan');
  const unsupportedResources = array(plan.resources, 'resources').filter(resource => !['d1','r2','queue'].includes(resource.kind)).map(({binding,kind}) => ({binding,kind,reason:kind === 'kv' ? 'KV values and metadata are not exported or restored; the service does not assume this binding is a disposable cache.' : kind === 'analytics_engine' ? 'Analytics Engine telemetry is not exported or restored.' : 'Resource data export and restore are unsupported.'}));
  for (const {binding} of array(plan.durableObjects === undefined ? [] : plan.durableObjects, 'durableObjects')) unsupportedResources.push({binding,kind:'durable_object',reason:'Durable Object storage is not exported or restored; a same-account deployment retains storage but does not copy it to another account.'});
  const retainedProviderData = plan.resources.filter(resource => resource.kind === 'analytics_engine').map(({binding,kind}) => ({binding,kind,reason:'Stopping or disconnecting the Worker does not remove stored telemetry. Provider retention applies; RER does not claim dataset deletion.'}));
  // Email Sending is an effect, not stored data. Consumer domain/sender permission,
  // upload, inspection and preview isolation must be checked independently by P1.
  return {complete:unsupportedResources.length === 0,unsupportedResources,retainedProviderData};
}
export function assertPortableResourceSupport(plan) {
  const capability = portableResourceCapability(plan);
  if (!capability.complete) throw Error(`Complete portable export/restore unavailable for ${capability.unsupportedResources.map(row => `${row.binding} (${row.kind}): ${row.reason}`).join('; ')}`);
  return capability;
}
