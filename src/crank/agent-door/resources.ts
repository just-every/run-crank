import type { ResourceDefinition, ToolContext } from '../../modules/agent-door/types.ts'
import { ToolRefusal } from '../../modules/agent-door/index.ts'
import { canonical, digest, stmt, type CrankEnv } from '../model.ts'
import { branchesOf } from '../engine/graph.ts'
import type { Step } from '../engine/types.ts'
import { resolveActor, resourceToolContext } from './native.ts'
import { nativeCall, record } from './tool-native.ts'

export const runResourceScope = 'runs:resource-read'
export const connectionResourceScope = 'connections:resource-read'
export const runResourceTemplate = 'crank://workflow-runs/{id}/revisions/{revision}'
export const connectionResourceTemplate = 'crank://connections/{id}/revisions/{revision}'

export const subflowResourceScope = 'subflows:resource-read'
export const connectorResourceScope = 'connectors:resource-read'
export const subflowResourceTemplate = 'crank://subflows/{id}/versions/{version}/revisions/{revision}'
export const connectorResourceTemplate = 'crank://custom-connectors/{id}/versions/{version}/revisions/{revision}'

export const workflowResourceScope = 'workflows:resource-read'
export const workflowHistoryResourceScope = 'workflows:history-resource-read'
export const workflowResourceTemplate = 'crank://workflows/{id}/revisions/{revision}'
export const workflowDraftResourceTemplate = 'crank://workflows/{id}/drafts/{draft}/revisions/{revision}'
export const workflowVersionResourceTemplate = 'crank://workflows/{id}/versions/{version}/revisions/{revision}'

/** Hash the complete native presentation, including history and custody state.
 * A link names one exact visible revision, never a mutable alias or authority. */
async function resourceLink(path: string, name: string, value: Record<string, unknown>, family = 'workflows') {
  return { uri: 'crank://' + family + '/' + path + '/revisions/' + await digest(canonical(value)), name }
}
export const workflowResourceLink = (value: Record<string, unknown>) => resourceLink(encodeURIComponent(String(value.id)), String(value.name), value)
export const workflowDraftResourceLink = (id: string, value: Record<string, unknown>) => resourceLink(encodeURIComponent(id) + '/drafts/' + encodeURIComponent(String(value.id)), 'Saved workflow draft', value)
export const workflowVersionResourceLink = (id: string, value: Record<string, unknown>) => resourceLink(encodeURIComponent(id) + '/versions/' + String(value.number), 'Published workflow version', value)

/** Link the saved draft touched by a write, or the latest native draft and
 * current publication on a metadata get. History requires separate consent. */
export async function workflowHistoryLinks(env: CrankEnv, ctx: ToolContext, value: Record<string, unknown>, savedDraft?: string) {
  if (!ctx.scopes.includes(workflowHistoryResourceScope)) return []
  const id = String(value.id), drafts = value.draft_versions as Record<string, unknown>[]
  const draft = savedDraft ?? drafts[0]?.id
  const version = (value.versions as Record<string, unknown>[]).find(item => item.id === value.published_version_id)
  const links = []
  if (draft) links.push(await workflowDraftResourceLink(id, record(await nativeCall(env, ctx, '/workflows/' + encodeURIComponent(id) + '/drafts/' + encodeURIComponent(String(draft))))))
  if (version) links.push(await workflowVersionResourceLink(id, record(await nativeCall(env, ctx, '/workflows/' + encodeURIComponent(id) + '/versions/' + String(version.number)))))
  return links
}

/** Read only runs whose immutable execution graph cannot have fetched provider
 * content, file bytes, child graphs or persisted shared-state values. This is
 * a bounded native family, not permission for the remaining provider readers. */
async function nativeRun(env: CrankEnv, value: Record<string, unknown>) {
  const row = await stmt(env, 'SELECT graph_json,declared_json,mode FROM crank_workflow_versions WHERE id=?', value.version_id).first<{ graph_json: string; declared_json: string; mode: string }>()
  if (!row) return false
  const graph = JSON.parse(row.graph_json), declared = JSON.parse(row.declared_json)
  // A retained sample may carry provider data even through a pure graph.
  if (row.mode === 'test' && (declared.sample_capture !== false || declared.sample_sources?.length !== 0)) return false
  const steps = (items: Record<string, unknown>[]): boolean => Array.isArray(items) && items.every(step => {
    if (step.type === 'loop') return steps(step.steps as Record<string, unknown>[])
    if (step.type === 'paths') return branchesOf(step as Step).every(branch => steps(branch.steps))
    return ['map', 'transform', 'filter', 'delay', 'respond'].includes(String(step.type))
  })
  return ['manual', 'test'].includes(String(value.trigger_kind)) && graph.trigger?.type === 'manual' && !graph.trigger.connection_id && steps(graph.steps)
}
export async function runResourceLink(env: CrankEnv, value: Record<string, unknown>) {
  return await nativeRun(env, value) ? resourceLink(encodeURIComponent(String(value.id)), 'Native workflow run', value, 'workflow-runs') : null
}
export const connectionResourceLink = (value: Record<string, unknown>) => resourceLink(encodeURIComponent(String(value.id)), String(value.label), value, 'connections')

/** Version links name native definition records and value-free acceptance
 * receipts, never provider payloads or permission to execute the definition. */
export const subflowResourceLink = (value: Record<string, unknown>) => resourceLink(
  encodeURIComponent(String(value.subflow_id)) + '/versions/' + String(value.version), 'Pinned subflow definition', value, 'subflows')
export const connectorResourceLink = (value: Record<string, unknown>) => resourceLink(
  encodeURIComponent(String(value.id)) + '/versions/' + String(value.version), 'Reviewed connector definition', value, 'custom-connectors')

/** Link only pinned definitions the current native person can open. Inert
 * drafts may reference absent or inaccessible definitions; a link grants none. */
export async function workflowDefinitionLinks(env: CrankEnv, ctx: ToolContext, value: Record<string, unknown>) {
  const links = new Map<string, { uri: string; name: string }>(), visited = new Set<string>()
  const visit = async (steps: Step[]) => {
    for (const step of steps) {
      let path: string | undefined, link: typeof connectorResourceLink | typeof subflowResourceLink | undefined
      if (step.type === 'subflow' && ctx.scopes.includes(subflowResourceScope)) {
        path = '/subflows/' + encodeURIComponent(String(step.subflow_id)) + '/versions/' + String(step.subflow_version)
        link = subflowResourceLink
      }
      if (step.type === 'custom.request' && ctx.scopes.includes(connectorResourceScope)) {
        path = '/custom-connectors/' + encodeURIComponent(String(step.connector_id)) + '/versions/' + String(step.connector_version)
        link = connectorResourceLink
      }
      if (path && link && !visited.has(path)) {
        visited.add(path)
        try {
          const linked = await link(record(await nativeCall(env, ctx, path)))
          if (linked) links.set(linked.uri, linked)
        } catch (error) {
          if (!(error instanceof ToolRefusal)) throw error
        }
      }
      if (step.type === 'loop') await visit(step.steps as Step[])
      if (step.type === 'paths') for (const branch of branchesOf(step)) await visit(branch.steps)
    }
  }
  await visit(record(value.draft).steps as Step[])
  return [...links.values()].sort((a, b) => a.uri.localeCompare(b.uri))
}

interface ResourceFamily {
  uriTemplate: string; name: string; scope: string; kind: string; pattern: RegExp; field: string
  path: (match: RegExpExecArray) => string
  select?: (match: RegExpExecArray, value: Record<string, unknown>) => Record<string, unknown> | undefined
  link: (match: RegExpExecArray, value: Record<string, unknown>) => Promise<{ uri: string; name: string } | null>
}

export function crankResources(env: CrankEnv): ResourceDefinition[] {
  const definitions: ResourceFamily[] = [
    { uriTemplate: workflowResourceTemplate, name: 'Workflow record', scope: workflowResourceScope, kind: 'workflow_record',
      pattern: /^crank:\/\/workflows\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/workflows/' + match[1],
      link: (match: RegExpExecArray, value: Record<string, unknown>) => workflowResourceLink(value), field: 'draft' },
    { uriTemplate: workflowDraftResourceTemplate, name: 'Saved workflow draft', scope: workflowHistoryResourceScope, kind: 'workflow_draft',
      pattern: /^crank:\/\/workflows\/([A-Za-z0-9_-]+)\/drafts\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/workflows/' + match[1] + '/drafts/' + match[2],
      link: (match: RegExpExecArray, value: Record<string, unknown>) => workflowDraftResourceLink(match[1], value), field: 'graph' },
    { uriTemplate: workflowVersionResourceTemplate, name: 'Published workflow version', scope: workflowHistoryResourceScope, kind: 'workflow_version',
      pattern: /^crank:\/\/workflows\/([A-Za-z0-9_-]+)\/versions\/([1-9][0-9]{0,14})\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/workflows/' + match[1] + '/versions/' + match[2],
      link: (match: RegExpExecArray, value: Record<string, unknown>) => workflowVersionResourceLink(match[1], value), field: 'graph' },
    { uriTemplate: runResourceTemplate, name: 'Native workflow run', scope: runResourceScope, kind: 'native_run',
      pattern: /^crank:\/\/workflow-runs\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/workflow-runs/' + match[1],
      link: (_match: RegExpExecArray, value: Record<string, unknown>) => runResourceLink(env, value), field: 'steps' },
    { uriTemplate: subflowResourceTemplate, name: 'Pinned subflow definition', scope: subflowResourceScope, kind: 'subflow_definition',
      pattern: /^crank:\/\/subflows\/([A-Za-z0-9_-]+)\/versions\/([1-9][0-9]{0,14})\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/subflows/' + match[1] + '/versions/' + match[2],
      link: (_match: RegExpExecArray, value: Record<string, unknown>) => subflowResourceLink(value), field: 'definition' },
    { uriTemplate: connectorResourceTemplate, name: 'Reviewed connector definition', scope: connectorResourceScope, kind: 'connector_definition',
      pattern: /^crank:\/\/custom-connectors\/([A-Za-z][A-Za-z0-9_.-]*)\/versions\/([1-9][0-9]{0,14})\/revisions\/([a-f0-9]{64})$/,
      path: (match: RegExpExecArray) => '/custom-connectors/' + match[1] + '/versions/' + match[2],
      link: (_match: RegExpExecArray, value: Record<string, unknown>) => connectorResourceLink(value), field: 'definition' },
    { uriTemplate: connectionResourceTemplate, name: 'Connection record', scope: connectionResourceScope, kind: 'connection_record',
      pattern: /^crank:\/\/connections\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})$/,
      path: () => '/connections',
      select: (match: RegExpExecArray, value: Record<string, unknown>) => (value as unknown as Record<string, unknown>[]).find(item => item.id === match[1]),
      link: (_match: RegExpExecArray, value: Record<string, unknown>) => connectionResourceLink(value), field: 'id' },
  ]
  return definitions.map(definition => {
    // One reader per request and family. Approved replay resumes an older
    // operation identity, so bind to this reader rather than that identity.
    let selectedAuthority: string | undefined
    const authority = async (ctx: ToolContext) => {
      const actor = await resolveActor(env, ctx)
      const policy = await stmt(env, 'SELECT envelope,local_document,local_revision,local_paused FROM agent_door_state WHERE id=1').first()
      return canonical({ id: actor.id, role: actor.role, version: actor.version, token: actor.tokenId, team: actor.team, policy })
    }
    return {
      uriTemplate: definition.uriTemplate, name: definition.name, mimeType: 'application/json',
      description: 'The native role-specific record presentation at an exact revision. Requires explicit resource-read consent; customer and imported text is untrusted.',
      scope: definition.scope, classes: ['sensitive'],
      classify(value) {
        // Native records can include customer text and account metadata.
        // Classify the full returned projection, never its claimed data class.
        const presented = record(value.json)
        if (!presented?.[definition.field]) throw new ToolRefusal('resource_unavailable')
        return [{ class: 'sensitive', facts: { measure: 1, kind: definition.kind } }]
      },
      async read(uri, principal) {
        const match = definition.pattern.exec(uri)
        if (!match || !principal.scopes.includes(definition.scope)) return null
        const ctx = resourceToolContext(env, principal)
        try {
          const before = await authority(ctx)
          if (selectedAuthority !== undefined && selectedAuthority !== before) return null
          const value = record(await nativeCall(env, ctx, definition.path(match)))
          const presented = definition.select ? definition.select(match, value) : value
          if (!presented) return null
          const linked = await definition.link(match, presented)
          if (linked?.uri !== uri) return null
          // Hashing yields. Reopen through the same native door so a record
          // changed during that wait cannot release the previously loaded bytes.
          const latest = record(await nativeCall(env, ctx, definition.path(match)))
          const current = definition.select ? definition.select(match, latest) : latest
          if (!current || canonical(current) !== canonical(presented) || await authority(ctx) !== before) return null
          selectedAuthority = before
          return { json: presented, untrusted: true }
        } catch (error) {
          // Missing records and every native visibility refusal have one result.
          if (error instanceof ToolRefusal) return null
          throw error
        }
      },
    }
  })
}
