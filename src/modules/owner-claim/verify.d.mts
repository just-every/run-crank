import type { OwnerClaimConfig } from './index.mjs';

export type { OwnerClaim, OwnerClaimConfig } from './index.mjs';
export { OwnerClaimError, verifyOwnerClaim } from './index.mjs';
export function configureClaim(input: OwnerClaimConfig): Readonly<OwnerClaimConfig>;
