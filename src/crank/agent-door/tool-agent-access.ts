import { ToolRefusal } from '../../modules/agent-door/index'
import type { ToolContext, ToolDefinition } from '../../modules/agent-door/types'
import type { CrankEnv } from '../model'
import { attributionEnv, resolveActor } from './native'
import { grantView, narrowScopes, narrowingScope, scopeGrant, scopeList, toolScopes } from './scope-grants'
import { objectSchema, textSchema, nativeGuard } from './tool-native'

export function agentAccessTools(env: CrankEnv): ToolDefinition[] {
  const current = async (ctx: ToolContext) => { await resolveActor(env, ctx); return nativeGuard(() => scopeGrant(env, ctx.agent.id, ctx.person.id)) }
  const widening = async (args: Record<string, unknown>, ctx: ToolContext) => {
    const row = await current(ctx), retained = grantView(row).scopes
    return (args.scopes as string[]).some(scope => !retained.includes(scope))
  }
  return [{
    name: 'crank.agents.narrow', title: 'Remove my tool scopes', scope: narrowingScope, readOnly: false,
    description: 'Persistently retain only selected existing scopes for this calling agent. The owner must explicitly authorize this tool. Agent and sponsor are resolved by the server. Additions are refused; policy, roles and Pause are never changed.',
    classes: ['access'], clauses: ['BASE-AGENT-005'],
    inputSchema: objectSchema({ scopes: { type: 'array', items: textSchema, maxItems: 32, uniqueItems: true }, revision: { type: 'integer', minimum: 0 } }, ['scopes', 'revision']),
    outputSchema: objectSchema({ agent_id: textSchema, scopes: { type: 'array', items: { enum: toolScopes } }, revision: { type: 'integer', minimum: 0 }, active: { const: true } }, ['agent_id', 'scopes', 'revision', 'active']),
    revision: async (_args, ctx) => (await current(ctx)).revision,
    target: async (_args, ctx) => ({ kind: 'agent', id: (await current(ctx)).agent_id }),
    authority: async (args, ctx) => ({ subject: ctx.agent.id, widens: await widening(args, ctx) }),
    classify: async (args, ctx, completed) => { await current(ctx); return completed ? [...completed] : [{ class: 'access', facts: { measure: 1, direction: await widening(args, ctx) ? 'widens' : 'narrows' } }] },
    summary: async (args, ctx) => ({ target: { id: (await current(ctx)).agent_id }, items: ['Retain tool scopes: ' + scopeList(args.scopes).join(', ')] }),
    run: async (args, ctx) => {
      if (await widening(args, ctx)) throw new ToolRefusal('self_escalation')
      const row = await current(ctx)
      if (args.revision !== row.revision) throw new ToolRefusal('revision_conflict', 'Scope revision changed', { current_revision: row.revision })
      return { result: await nativeGuard(async () => narrowScopes(attributionEnv(env, ctx), await resolveActor(env, ctx), ctx.agent.id, args)) }
    },
  }]
}
