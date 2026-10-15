// Adapted from run-uptime src/domain/schedule.ts acceptanceMs at c699a67.
// One receiver, no automatic retry/canary: the claim outlives the request
// timeout plus a settlement margin. Each manual replay gets a fresh claim.
export const DELIVERY_TIMEOUT_MS = 10000
export function acceptanceMs(attempts:number,timeoutMs:number) {
  return Math.max(30000,attempts*timeoutMs+10000)
}
