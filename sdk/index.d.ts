export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Graph {
  trigger: { type: string; [key: string]: Json };
  steps: Array<{ id: string; type: string; [key: string]: Json }>;
  settings?: JsonObject;
}
export interface ClientOptions {
  /** Installation origin, for example https://crank.example. */
  baseUrl: string;
  /** Full crk_ preparation credential or crg_ execution credential, without Bearer. */
  token?: string;
  /** Node/server only: native Cookie header from your own authenticated session. */
  cookie?: string;
  fetch?: typeof globalThis.fetch;
}
export interface RequestOptions { signal?: AbortSignal }
export interface DraftWriteOptions extends RequestOptions { idempotencyKey?: string }
export interface DraftInput {
  name: string;
  graph: Graph;
  description?: string;
  folder?: string;
  settings?: JsonObject;
}
export interface DraftVersion {
  id: string;
  base_version_id: string | null;
  graph_digest: string;
  author: string;
  at: string;
}
export interface IdempotencyReceipt { replayed: boolean; workflow_id: string; draft_id: string }
export interface SavedDraft extends DraftVersion {
  workflow_id: string;
  graph: Graph;
  metadata: JsonObject;
}
export interface Workflow {
  id: string;
  name: string;
  description: string;
  folder: string;
  status: string;
  draft: Graph;
  draft_updated_at: string;
  published_version_id: string | null;
  draft_versions: DraftVersion[];
  idempotency?: IdempotencyReceipt;
  warnings?: string[];
  [key: string]: unknown;
}
export interface WorkflowSummary {
  id: string;
  name: string;
  folder: string;
  description: string;
  status: string;
  owner_id: string;
  published_version_id: string | null;
  trigger: string | null;
}
export interface Validation { ok: true; warnings: string[]; declared: JsonObject }
export interface Publication {
  workflow: Workflow;
  version: { id: string; number: number; authority: JsonObject };
  warnings: string[];
  idempotency?: { replayed: boolean; workflow_id: string; version_id: string };
}
export interface Run {
  id: string;
  workflow_id: string;
  version_id: string;
  status: string;
  business_key: string | null;
  business_outcome: string;
  received_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: Json | null;
  [key: string]: unknown;
}
export interface RunDetail extends Run {
  grant_id: string | null;
  steps: Array<{ path: string; step_id: string; type: string; status: string; input?: Json; output?: Json; [key: string]: unknown }>;
  waits: Array<{ path: string; kind: string; can_review: boolean; [key: string]: unknown }>;
  attempts: Array<Record<string, unknown>>;
}
export interface RunQuery {
  workflow?: string;
  status?: string;
  business_key?: string;
  q?: string;
  from?: string;
  to?: string;
  error?: string;
  before?: string;
  /** Positive integer, clamped to 100 by the server. */
  limit?: number;
}
export interface RunPage { runs: Run[]; next: string | null; text_search?: string }
export interface TaskInput { task_id: string; actions: Array<{ step_id: string; input: JsonObject }> }
export class CrankApiError extends Error {
  constructor(message: string, options?: { code?: string; status?: number; details?: unknown });
  readonly name: 'CrankApiError';
  readonly code: string;
  /** HTTP status, or zero when there was no confirmed HTTP response. */
  readonly status: number;
  readonly details: unknown;
  toJSON(): { name: string; message: string; code: string; status: number; details: unknown };
}
export const API_VERSION: '1';
export class CrankClient {
  constructor(options: ClientOptions);
  createDraft(input: DraftInput, options?: DraftWriteOptions): Promise<Workflow>;
  readWorkflow(workflowId: string, options?: RequestOptions): Promise<Workflow>;
  readDraft(workflowId: string, draftId: string, options?: RequestOptions): Promise<SavedDraft>;
  updateDraft(workflowId: string, input: Partial<DraftInput>, options?: DraftWriteOptions): Promise<Workflow>;
  validateDraft(workflowId: string, input?: { graph?: Graph }, options?: RequestOptions): Promise<Validation>;
  publishDraft(workflowId: string, input?: JsonObject, options?: DraftWriteOptions): Promise<Publication>;
  rollbackWorkflow(workflowId: string, version: number, options?: DraftWriteOptions): Promise<Publication>;
  listWorkflows(query?: { q?: string; folder?: string }, options?: RequestOptions): Promise<WorkflowSummary[]>;
  listRuns(query?: RunQuery, options?: RequestOptions): Promise<RunPage>;
  iterateRuns(query?: RunQuery, options?: RequestOptions): AsyncGenerator<Run, void, unknown>;
  readRun(runId: string, options?: RequestOptions): Promise<RunDetail>;
  startTask(input: TaskInput, options?: DraftWriteOptions): Promise<RunDetail>;
  readTask(runId: string, options?: RequestOptions): Promise<RunDetail>;
}
export function createCrankClient(options: ClientOptions): CrankClient;
