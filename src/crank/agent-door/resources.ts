import type { ResourceDefinition, ToolContext } from '../../modules/agent-door/types.ts'
import { ToolRefusal } from '../../modules/agent-door/index.ts'
import { canonical, digest, type CrankEnv } from '../model.ts'
import { resolveActor, resourceToolContext } from './native.ts'
import { nativeCall, record } from './tool-native.ts'

export const workflowResourceScope = 'workflows:resource-read'
export const workflowResourceTemplate = 'crank://workflows/{id}/revisions/{revision}'

/** Hash the complete native presentation, including history and custody state.
 * A link names one exact visible revision, never a mutable alias or authority. */
export async function workflowResourceLink(value: Record<string, unknown>) {
  return { uri: 'crank://workflows/' + encodeURIComponent(String(value.id)) + '/revisions/' + await digest(canonical(value)), name: String(value.name) }
}

export function crankResources(env: CrankEnv): ResourceDefinition[] {
  // One door is constructed per request. Retain the authority selected during
  // classification so a mid-read grant change cannot serve the same bytes.
  // Approved-read replay resumes an older operation identity. Bind to this
  // request's reader instead of that mutable continuation identity.
  let selectedAuthority: string | undefined
  const authority = async (ctx: ToolContext) => {
    const actor = await resolveActor(env, ctx)
    return canonical({ id: actor.id, role: actor.role, version: actor.version, token: actor.tokenId, team: actor.team })
  }
  return [{
    uriTemplate: workflowResourceTemplate, name: 'Workflow record', mimeType: 'application/json',
    description: 'The current native workflow presentation at an exact revision. Requires fresh resource-read consent; customer and imported text is untrusted.',
    scope: workflowResourceScope, classes: ['sensitive'],
    classify(value) {
      // This is the actual full record returned by the native UI door, with
      // arbitrary draft values, history and receiving details. A declaration of
      // data_class=none never proves those bytes non-sensitive or provider consent.
      const workflow = record(value.json)
      if (!workflow?.id || !workflow.draft) throw new ToolRefusal('resource_unavailable')
      return [{ class: 'sensitive', facts: { measure: 1, kind: 'workflow_record' } }]
    },
    async read(uri, principal) {
      const match = /^crank:\/\/workflows\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})$/.exec(uri)
      if (!match || !principal.scopes.includes(workflowResourceScope)) return null
      const ctx = resourceToolContext(env, principal)
      try {
        const before = await authority(ctx)
        if (selectedAuthority !== undefined && selectedAuthority !== before) return null
        const value = record(await nativeCall(env, ctx, '/workflows/' + encodeURIComponent(match[1])))
        if (await authority(ctx) !== before || (await workflowResourceLink(value)).uri !== uri) return null
        selectedAuthority = before
        return { json: value, untrusted: true }
      } catch (error) {
        // Missing records and every native visibility refusal have one result.
        if (error instanceof ToolRefusal) return null
        throw error
      }
    },
  }]
}
