/** Security duties are indivisible. Undefined preserves the legacy full door. */
export const CORE_CAPABILITIES = ['tools', 'policy', 'pause', 'audit', 'idempotency'];
export const OPTIONAL_CAPABILITIES = ['events', 'resources', 'prompts', 'subscriptions'];
export const UNSCOPED_CAPABILITIES = ['multiSponsor', 'mailEdges', 'resourceRefresh', 'timedLifecycle', 'dualHost', 'queuedLifecycle', 'ownerNativeApi'];
export function capabilitySet(declaration) {
 const all = [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES];
 if (declaration === undefined) return { mode: 'legacy', declared: all, refused: [], unscoped: [...UNSCOPED_CAPABILITIES] };
 if (!Array.isArray(declaration) || new Set(declaration).size !== declaration.length || declaration.some(name => !all.includes(name)) || CORE_CAPABILITIES.some(name => !declaration.includes(name))) throw new TypeError(`Agent capabilities must be a unique list containing ${CORE_CAPABILITIES.join(', ')}; optional: ${OPTIONAL_CAPABILITIES.join(', ')}. Other lifecycle families cannot yet be scoped.`);
 if (declaration.includes('subscriptions') && !declaration.includes('events')) throw new TypeError('subscriptions requires events');
 return { mode: 'declared', declared: [...declaration], refused: OPTIONAL_CAPABILITIES.filter(name => !declaration.includes(name)), unscoped: [...UNSCOPED_CAPABILITIES] };
}
export const offers = (declaration, capability) => declaration === undefined || declaration.includes(capability);
