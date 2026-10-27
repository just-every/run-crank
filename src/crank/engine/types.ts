import type { CrankEnv } from '../model'
import type { Scope } from './mapping'

export type Step = Record<string, unknown> & { id: string; type: string }
export type ExecutionOutcome =
  | { kind: 'completed' } | { kind: 'stopped'; reason: 'filter' | 'search' } | { kind: 'waiting'; approval: boolean }
  | { kind: 'paused'; reason: string; connectionId?: string; authority?: boolean } | { kind: 'failed'; error: unknown } | { kind: 'rejected'; reason: string }
export interface WaitSpec {
  kind: 'delay' | 'callback' | 'queue' | 'approval'
  dueAt?: string | null; expiresAt?: string | null; proposal?: unknown; reason?: string; queue?: { name: string; spacingSeconds: number }
}
export interface WaitRow {
  id: string; run_id: string; path: string; kind: WaitSpec['kind']; due_at: string | null; expires_at: string | null
  proposal_json: string | null; proposal_digest: string | null; reason: string | null; created_at: string
  resolved_at: string | null; resolution_json: string | null; decided_by: string | null
}
export type StepResult =
  | { status: 'succeeded'; output: unknown; trace?: unknown }
  | { status: 'waiting'; wait: WaitSpec }
  | { status: 'stopped'; reason: 'filter' | 'search'; trace?: unknown; output?: unknown }
  | { status: 'paused'; reason: string; connectionId?: string; output?: unknown; trace?: unknown }
  | { status: 'rejected'; reason: string }

export interface RunRow {
  grant_id?: string | null
  mode?: 'production' | 'test'; test_owner_version?: number | null
  repair_of?: string | null; repair_paths_json?: string | null
  id: string; workflow_id: string; version_id: string; trigger_kind: string; source_id: string | null; trigger_json: string
  status: string; source_time: string | null; received_at: string; started_at: string | null; finished_at: string | null
  lease_id: string | null; lease_expires_at: string | null; error_json: string | null; response_json: string | null; created_by: string; business_key: string | null
}
export interface StepContext {
  env: CrankEnv; run: RunRow; scope: Scope; path: string; operationKey: string; now: number; zone: string
  input: Record<string, unknown>
  requests: { next: number }
  retryPolicy?: Record<string, unknown>
  executeSubflow?(steps: Step[], input: Record<string,unknown>, result: Record<string,unknown>, check: () => Promise<void>): Promise<{outcome:ExecutionOutcome;output?:unknown}>
  /** Native regulated operations recheck their exact consent at physical dispatch. */
  beforeRequest?: () => Promise<void>
  /** Earlier completed decision for this step, when resuming after a wait. */
  wait?: WaitRow
  respond(response: { status: number; headers: Record<string, string>; body: unknown }): Promise<void>
}
export interface StepType {
  mutating: boolean
  /** Durable remote identity permits readback after an interrupted dispatch. */
  reconciles?: boolean
  /** Steps that name a connection must be bound to one at publish. */
  connection?: 'required' | 'optional'
  /** Inputs that must resolve to a value before any effect. */
  required?: string[]
  validate?(step: Step): void
  execute(step: Step, ctx: StepContext): Promise<StepResult>
  resume?(step: Step, ctx: StepContext & { wait: WaitRow }): Promise<StepResult>
}
