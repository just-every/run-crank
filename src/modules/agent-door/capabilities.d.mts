export type Capability = 'tools' | 'policy' | 'pause' | 'audit' | 'idempotency' | 'events' | 'resources' | 'prompts' | 'subscriptions';
export const CORE_CAPABILITIES: Capability[];
export const OPTIONAL_CAPABILITIES: Capability[];
export const UNSCOPED_CAPABILITIES: string[];
export function capabilitySet(declaration?: readonly Capability[]): { mode: string; declared: Capability[]; refused: Capability[]; unscoped: string[] };
export function offers(declaration: readonly Capability[] | undefined, capability: Capability): boolean;
