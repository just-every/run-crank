import type { Operator } from '../index.mjs';
export interface ScheduledPolicy {
  id: string;
  /** Bump when the job's semantics change. All bounds also belong in actions. */
  kind: string;
  parameters: Record<string, unknown>;
  maxActionsPerRun: number;
  minIntervalMinutes: number;
  actions: Array<{ action: 'operators:deactivate' | 'operators:reactivate'; scope: { roles: Array<'admin' | 'member'>; operatorIds?: string[]; inactiveDays?: number } }>;
}
export interface PolicyApproval { id: string; policyId: string; versionHash: string; ownerId: string; ownerVersion: number; approvedAt: number; revokedAt: number | null; sessionKind: string; revokeReason: string | null }
export interface PolicyAction { id: string; actor: string; action: string; createdAt: number; value: { policyId: string; versionHash: string; approvalId: string; approvedBy: string; runId: string; operatorId: string; attemptedAction?: string; error?: string } }
export interface PolicyRun { id: string; policyId: string; versionHash: string | null; approvalId: string | null; approvedBy: string | null; startedAt: number; finishedAt: number | null; status: 'running' | 'completed' | 'refused' | 'failed'; error: string | null; repeats: number; lastSeenAt: number; actions: PolicyAction[] }
export interface ScheduledPolicyDoor {
  list(request: Request): Promise<{ policies: Array<{ definition: ScheduledPolicy; versionHash: string; approval: PolicyApproval | null; state: string }>; approvals: PolicyApproval[] }>;
  runs(request: Request): Promise<{ runs: PolicyRun[]; nextCursor: string | null }>;
  approve(request: Request, input: { policyId: string; versionHash: string }): Promise<PolicyApproval>;
  revoke(request: Request, input: { approvalId: string }): Promise<void>;
  /** Trusted server-only scheduled handler. There is deliberately no HTTP adapter. */
  run(policyId: string, execute: (run: { id: string; actor: string; execute(action: ScheduledPolicy['actions'][number]['action'], operatorId: string): Promise<Operator | null> }) => Promise<void>): Promise<{ id: string }>;
}
