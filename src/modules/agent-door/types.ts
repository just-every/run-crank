import type { ClassFacts, ClassId } from './policy/catalogue.ts'
import type { PolicyDocument } from './policy/document.ts'

export type JsonSchema = boolean | { [key: string]: unknown }
export interface JsonSchemaObject { type: 'object'; properties?: Record<string, JsonSchema>; required?: string[]; [key: string]: unknown }
export interface Person { id: string; email: string; name: string; role: string; active: boolean }
export interface Agent { id: string; name: string; specialist?: string | null }
export interface Principal { person: Person; agent: Agent; scopes: string[]; consent?: string }
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
  db: D1Database; person: Person; agent: Agent; actor: PreparedBy; seed: string; origin: string
  now(): number; door: 'mcp' | 'embedded'; approvers: Array<{ id: string; name: string }>
  emit(type: string, uri: string, data?: Record<string, unknown>): void
}
export interface ApprovalSummary {
  target?: { id?: string; name?: string; email?: string }; recipients?: string[]
  amount?: { value: number; currency: string }; payee?: string; role?: string; items?: string[]
}
export type ApprovalDisplaySummary = ApprovalSummary | { arguments: Record<string, unknown> } | { uri: string }
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
  revision?(args: Record<string, unknown>, ctx: ToolContext): Promise<number | null>
  summary?(args: Record<string, unknown>, ctx: ToolContext): ApprovalSummary | Promise<ApprovalSummary>
  undo?(saved: unknown, ctx: UndoContext): Promise<void>
  authority?(args: Record<string, unknown>, ctx: ToolContext): Promise<{ subject: string; widens: boolean } | null>
  untrusted?: boolean
}
export interface ResourceDefinition {
  uriTemplate: string; name: string; description?: string; mimeType?: string; scope?: string; classes: ClassId[]
  classify(record: { json?: unknown; text?: string }, ctx: { person: Person; db: D1Database }): ClassAndFacts[] | Promise<ClassAndFacts[]>
  read(uri: string, ctx: { person: Person; db: D1Database }): Promise<{ json?: unknown; text?: string; untrusted?: boolean } | null>
}
export interface AgentDoorOptions {
  seed: string; name: string; specialist: string; version?: string; db: D1Database; origin: string; trust: Trust | null
  tools: ToolDefinition[]; resources?: ResourceDefinition[]
  prompts?: Array<{ name: string; title?: string; description: string; clauses?: string[]; messages(args: Record<string, string>): unknown[] }>
  notTools?: Array<{ clauses: string[]; reason: 'device' | 'screen' | 'connector' | 'import-door' | 'installation' }>
  people: PeopleAdapter
  localCredentials?(request: Request): Promise<{ sponsor: { id: string }; agent: Agent; scopes: string[] } | null>
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
  invoke(name: string, args: Record<string, unknown>, who: { person: Person; agent: Agent }): Promise<CallResult>
  emit(event: { type: string; uri: string; person: Person; data?: Record<string, unknown> }): Promise<void>
}
export interface PolicyState {
  business: string | null; seq: number | null; revision: number | null; paused: boolean; localPaused: boolean
  revoked: { agents: string[]; consents: string[] }; document: PolicyDocument | null; expires: number | null; iat: number | null
}
export interface Runtime {
  options: AgentDoorOptions; tools: ToolDefinition[]; now(): number
}
