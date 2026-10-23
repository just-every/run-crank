import type { Database, OperatorAuth } from '../operator-auth/index.mjs';
export function createDependencies<R extends string>(options: { db: Database; INSTALLATION_KEY?: string; INSTALLATION_KEY_PREVIOUS?: string; origin: string; name: string; provider?: string; local?: boolean; auth: OperatorAuth<R>; claimOwner?:(token:string)=>Promise<Response|null>; clock?: () => number; fetch?: typeof fetch; provides?:string[]; interfaces?: {interface:string;optional?:boolean;provider?:string;paths:string[]}[] }): {document():Promise<unknown>;handle(request:Request):Promise<Response|null>};
export const INTERFACE:string;
export const CALLBACK:string;
export const PATHS:string[];
export interface SqlFence {sql: string; args: unknown[]}
/** Snapshot captured before provider I/O; equality is repeated by shared code. */
export interface DependencyApproval {
  interface: string; issuer: string; callbacks: string; attempt_id: string;
  approved_by: string; approved_session: string; approved_version: number; expires_at: number;
}
export interface NativeDependencyAuthority<R extends string = string> {
  unclaimed(): Promise<boolean>;
  ownerFence(actor: import('../operator-auth/index.mjs').Session<R>, now: number): SqlFence | Promise<SqlFence>;
  /** Repeat native current-owner/session/version/proof and provider policy/pin authority. Shared code fences the exact pending attempt and actor snapshot. */
  approvalFence(input: {pending: DependencyApproval; contract: string; issuer: string; callbacks: string; now: number}): SqlFence | Promise<SqlFence>;
  /** Ordinary owner approval must never enable identity from a stale first-setup flag. */
  linkedStatements(input: {pending: DependencyApproval; contract: string; old: Record<string, unknown> | null; issuer: string; now: number}): import('../operator-auth/index.mjs').Statement[] | Promise<import('../operator-auth/index.mjs').Statement[]>;
  unlinkStatements(input: {contract: string; actor: import('../operator-auth/index.mjs').Session<R>; now: number}): import('../operator-auth/index.mjs').Statement[] | Promise<import('../operator-auth/index.mjs').Statement[]>;
  /** Atomic replay claim + pinned link/current binding checks + native session revocation/fence bump. */
  consumeLogout(input: {claims: Record<string, unknown>; link: Record<string, unknown>; now: number; fence: boolean}): Promise<boolean>;
  claimOwner?(input: {request: Request; token: string; expectedPin: {id: string; issuer: string; clientId: string; linkedAt: number}}): Promise<Response | null>;
}
