import type { Capability } from './capabilities.mjs'
import type { ClassFacts, ClassId } from './policy/catalogue.ts'
import type { PolicyDocument } from './policy/document.ts'

export type JsonSchema = boolean | { [key: string]: unknown }
export interface JsonSchemaObject { type: 'object'; properties?: Record<string, JsonSchema>; required?: string[]; [key: string]: unknown }
export interface Person { id: string; email: string; name: string; role: string; active: boolean }
export interface Agent { id: string; name: string; specialist?: string | null }
export interface Principal { person: Person; agent: Agent; scopes: string[]; clientId?: string; consent?: string; nativeProof?: { kind: string; reference: string }; operationId?: string; idempotencyKey?: string | null; continuationItemId?: string }
export interface PeopleAdapter {
  sponsor(claims: { sub: string }): Promise<Person | null>
  person(id: string): Promise<Person | null>
  session(request: Request): Promise<Person | null>
  businessRole?(person: Person): 'owner' | 'editor' | null
  businessMember?(person: Person): Promise<{ id: string; role: 'owner' | 'editor' | null } | null>
}
export interface Trust { issuer: string; installationId: string; appOrigin: string; publicKeys: Record<string, JsonWebKey> }
export interface ClassAndFacts { class: ClassId; facts: ClassFacts }
export interface PreparedBy { agent: { id: string; name: string }; for: { id: string; name: string }; label: string }
export type EventActor = ({ kind: 'agent' } & PreparedBy) | { kind: 'person'; person: { id: string; name: string } } | { kind: 'business' }
export interface AgentEvent { id: string; type: string; uri: string; actor: EventActor; at: string; [key: string]: unknown }
export interface ToolContext {
  readonly db: D1Database
  readonly person: Readonly<Person>; readonly agent: Readonly<Agent>
  readonly consent?: string; readonly scopes: readonly string[]; readonly clientId?: string
  readonly operationId: string; readonly idempotencyKey: string | null
  readonly continuationItemId?: string
  readonly nativeProof?: Readonly<{ kind: string; reference: string }>
  readonly actor: { readonly agent: Readonly<PreparedBy['agent']>; readonly for: Readonly<PreparedBy['for']>; readonly label: string }
  readonly seed: string; readonly origin: string; readonly door: 'mcp' | 'embedded'
  readonly approvers: readonly Readonly<{ id: string; name: string }>[]
  readonly now: () => number
  readonly emit: (type: string, uri: string, data?: Record<string, unknown>) => void
}
export interface NativeTarget { kind: string; id: string }
export interface InvocationIdentity {
  person: Pick<Person, 'id'>; agent: Agent; scopes: readonly string[]; clientId?: string; consent?: string
  /** Resume a native queue item using its door-issued admission identity. */
  operationId?: string
}

export interface ApprovalSummary {
  target?: { id?: string; name?: string; email?: string }; recipients?: string[]
  amount?: { value: number; currency: string }; payee?: string; role?: string; items?: string[]
}
export type ApprovalDisplaySummary = (ApprovalSummary | { arguments: Record<string, unknown> } | { uri: string }) & { nativeTarget?: NativeTarget }
export interface UndoContext {
  db: D1Database; person: Person; agent: null; actor: { kind: 'person'; person: { id: string; name: string }; label: string }
  seed: string; origin: string; now(): number; door: 'mcp' | 'embedded'
  emit(type: string, uri: string, data?: Record<string, unknown>): void
}
export interface ToolDefinition {
  name: string; title: string; description: string; scope: string; readOnly: boolean
  inputSchema: JsonSchemaObject; outputSchema: JsonSchema; classes: ClassId[]; clauses: string[]
  classify(args: Record<string, unknown>, ctx: ToolContext): ClassAndFacts[] | Promise<ClassAndFacts[]>
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: unknown; resources?: Array<{ uri: string; name: string }>; undo?: unknown }>
  revisionType?: 'integer' | 'number' | 'string'
  revision?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | number | null>
  summary?(args: Record<string, unknown>, ctx: ToolContext): ApprovalSummary | Promise<ApprovalSummary>
  target?(args: Record<string, unknown>, ctx: ToolContext): NativeTarget | null | Promise<NativeTarget | null>
  /** Resolve persisted native queue identity, bound to its originating admission. */
  continuationItem?(args: Record<string, unknown>, ctx: ToolContext): { id: string; operationId: string } | null | Promise<{ id: string; operationId: string } | null>
  undo?(saved: unknown, ctx: UndoContext): Promise<void>
  authority?: 'none' | ((args: Record<string, unknown>, ctx: ToolContext) => Promise<{ subject: string; widens: boolean } | null>)
  effect?: { kind: 'record'; justification: string }
  proof?: 'native'; proofKind?: string
  widens?: false; narrowing?: { effect: 'revoke' | 'narrow'; target: string | string[] }
  untrusted?: boolean
}
export type ResourceContext = Principal & { db: D1Database }
export interface ResourceDefinition {
  uriTemplate: string; name: string; description?: string; mimeType?: string; scope?: string; classes: ClassId[]
  classify(record: { json?: unknown; text?: string }, ctx: ResourceContext): ClassAndFacts[] | Promise<ClassAndFacts[]>
  read(uri: string, ctx: ResourceContext): Promise<{ json?: unknown; text?: string; untrusted?: boolean } | null>
}
export interface AgentDoorOptions {
  seed: string; name: string; specialist: string; version?: string; db: D1Database; origin: string; trust: Trust | null
  capabilities?: readonly Capability[]
  tools: ToolDefinition[]; resources?: ResourceDefinition[]
  prompts?: Array<{ name: string; title?: string; description: string; clauses?: string[]; messages(args: Record<string, string>): unknown[] }>
  notTools?: Array<{ clauses: string[]; reason: 'device' | 'screen' | 'connector' | 'import-door' | 'installation' }>
  people: PeopleAdapter
  localCredentials?(request: Request): Promise<{ sponsor: { id: string }; agent: Agent; scopes: string[]; clientId?: string } | null>
  nativeProof?: {
    handoff(input: { kind: string; tool: string; principal: Principal }): string | Promise<string>
    verify(input: { kind: string; tool: string; args: Record<string, unknown>; principal: Principal; reference: string }): Promise<boolean>
  }
  currentScopes?(principal: Principal): Promise<string[]>
  paths?: string[]; limits?: { requestsPerMinute?: number; maxBodyBytes?: number }
  onEvent?(event: AgentEvent): void | Promise<void>; now?(): number
}
export interface DecisionMeta { id: string; disposition: string; revision: number | null; classes: Array<{ class: string; facts: object; rule: string | null; do: string }> }
export interface CallResult {
  outcome: 'done' | 'pending' | 'refused'; code?: string; result?: unknown; decision: DecisionMeta | null
  fields?: Record<string, unknown>; resources?: Array<{ uri: string; name: string }>; review?: { id: string }
  approval?: { id: string; url: string; expires_at: string }; receipt?: Record<string, unknown>; requestState?: string; untrusted?: boolean; execution_id?: string
}
export interface AgentDoor {
  handle(request: Request): Promise<Response | null>
  invoke(name: string, args: Record<string, unknown>, who: InvocationIdentity, proofReference?: string): Promise<CallResult>
  emit(event: { type: string; uri: string; person: Person; data?: Record<string, unknown> }): Promise<void>
}
export interface PolicyState {
  business: string | null; seq: number | null; revision: number | null; paused: boolean; localPaused: boolean
  revoked: { agents: string[]; consents: string[] }; document: PolicyDocument | null; expires: number | null; iat: number | null
}
export interface Runtime {
  options: AgentDoorOptions; tools: ToolDefinition[]; now(): number
}
