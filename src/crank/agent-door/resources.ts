import type { ResourceDefinition, ToolContext } from '../../modules/agent-door/types.ts'
import { ToolRefusal } from '../../modules/agent-door/index.ts'
import { canonical, digest, stmt, type CrankEnv } from '../model.ts'
import { resolveActor, resourceToolContext } from './native.ts'
import { nativeCall, record } from './tool-native.ts'

export const workflowResourceScope = 'workflows:resource-read'
export const workflowHistoryResourceScope = 'workflows:history-resource-read'
export const workflowResourceTemplate = 'crank://workflows/{id}/revisions/{revision}'
export const workflowDraftResourceTemplate = 'crank://workflows/{id}/drafts/{draft}/revisions/{revision}'
export const workflowVersionResourceTemplate = 'crank://workflows/{id}/versions/{version}/revisions/{revision}'

/** Hash the complete native presentation, including history and custody state.
 * A link names one exact visible revision, never a mutable alias or authority. */
async function resourceLink(path: string, name: string, value: Record<string, unknown>) {
  return { uri: 'crank://workflows/' + path + '/revisions/' + await digest(canonical(value)), name }
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

export function crankResources(env: CrankEnv): ResourceDefinition[] {
  const definitions = [
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
      description: 'The native workflow presentation at an exact revision. Requires explicit resource-read consent; customer and imported text is untrusted.',
      scope: definition.scope, classes: ['sensitive'],
      classify(value) {
        // Actual native graph content can be sensitive regardless of its
        // declared data class. Reading it proves no provider consent.
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
          const linked = await definition.link(match, value)
          if (linked.uri !== uri || await authority(ctx) !== before) return null
          selectedAuthority = before
          return { json: value, untrusted: true }
        } catch (error) {
          // Missing records and every native visibility refusal have one result.
          if (error instanceof ToolRefusal) return null
          throw error
        }
      },
    }
  })
}
