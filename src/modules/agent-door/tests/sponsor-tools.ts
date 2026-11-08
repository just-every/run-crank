import { defineTool, ToolRefusal, type ToolContext, type ToolDefinition } from '../index.ts'
import { AuthError, type createOperatorAuth } from '../../operator-auth/index.mjs'

const text = { type: 'string', minLength: 1 }
const object = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false })
const idInput = object({ id: text })
const role = { type: 'string', enum: ['admin', 'member'] }
type Operator = { id: string; role: string; status: string }

/** Native record visibility and delegated administration have access effects,
 * while neither can increase an admitted sponsor's standing authority. */
export function sponsorTools(db: D1Database, auth: ReturnType<typeof createOperatorAuth>): ToolDefinition[] {
  const operator = (id: string) => db.prepare('SELECT id,role,status FROM oa_operators WHERE id=?').bind(id).first<Operator>()
  const record = (id: string) => db.prepare('SELECT id,exposure FROM test_records WHERE id=?').bind(id).first<{ id: string; exposure: string }>()
  async function authorize(ctx: ToolContext) {
    const sponsor = await operator(ctx.person.id)
    if (sponsor?.status !== 'active' || !['owner', 'admin'].includes(sponsor.role)) throw new ToolRefusal('operator_role_required')
  }
  async function teammate(args: Record<string, unknown>, ctx: ToolContext) {
    await authorize(ctx)
    const target = await operator(args.id as string)
    if (!target) throw new ToolRefusal('operator_not_found')
    if (target.id === ctx.person.id || target.role === 'owner') throw new ToolRefusal('delegated_owner_change')
    return target
  }
  return [
    defineTool({
      name: 'synthetic.records.access', title: 'Change native record visibility', description: 'Share or restrict a record without granting person authority.',
      scope: 'records:write', readOnly: false, classes: ['access'], clauses: ['BASE-AGENT-005'],
      inputSchema: object({ id: text, visibility: { type: 'string', enum: ['shared', 'internal'] } }), outputSchema: idInput,
      authority: async () => null,
      async classify(args, ctx) {
        await authorize(ctx)
        if (!await record(args.id as string)) throw new ToolRefusal('record_not_found')
        return [{ class: 'access', facts: { measure: 1, direction: args.visibility === 'shared' ? 'widens' : 'narrows' } }]
      },
      summary: args => ({ target: { id: args.id as string }, items: [args.visibility as string] }),
      async run(args, ctx) {
        await authorize(ctx)
        if (!await record(args.id as string)) throw new ToolRefusal('record_not_found')
        await db.prepare('UPDATE test_records SET exposure=?,version=version+1 WHERE id=?').bind(args.visibility, args.id).run()
        ctx.emit('record.visibility.changed', `synthetic://record/${args.id}`)
        return { result: { id: args.id } }
      },
    }),
    defineTool({
      name: 'synthetic.access.teammate', title: 'Change a teammate role', description: 'Native delegated administration changes other non-owner teammates only.',
      scope: 'records:write', readOnly: false, classes: ['access'], clauses: ['BASE-AGENT-005'], inputSchema: object({ id: text, role }), outputSchema: idInput,
      async authority(args) {
        const target = await operator(args.id as string)
        return target ? { subject: target.id, widens: target.role === 'member' && args.role === 'admin' } : null
      },
      async classify(args, ctx) {
        await teammate(args, ctx)
        return [{ class: 'access', facts: { measure: 1, direction: args.role === 'admin' ? 'widens' : 'narrows' } }]
      },
      async summary(args, ctx) { const target = await teammate(args, ctx); return { target: { id: target.id }, role: args.role as string } },
      async run(args, ctx) {
        const current = await teammate(args, ctx)
        if (current.role === args.role) throw new ToolRefusal('role_unchanged')
        try {
          await auth.delegatedAdministration({ personId: ctx.person.id, auditLabel: ctx.actor.label, agentId: ctx.agent.id }).setRole(args.id as string, args.role as 'admin' | 'member')
        } catch (cause) { if (cause instanceof AuthError) throw new ToolRefusal(cause.code); throw cause }
        ctx.emit('operator.role.changed', `synthetic://operator/${args.id}`)
        return { result: { id: args.id } }
      },
    }),
    defineTool({
      name: 'synthetic.access.snapshot', title: 'Read native authority witness', description: 'Read record visibility and operator authority without credentials.',
      scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-005'], inputSchema: object({}),
      outputSchema: object({ records: { type: 'array', items: { type: 'object' } }, operators: { type: 'array', items: { type: 'object' } }, sent: { type: 'array', items: { type: 'object' } } }),
      classify: () => [{ class: 'standard', facts: { measure: 1 } }],
      async run(_args, ctx) {
        await authorize(ctx)
        return { result: {
          records: (await db.prepare('SELECT id,exposure FROM test_records ORDER BY id').all()).results,
          operators: (await db.prepare('SELECT id,role,status FROM oa_operators ORDER BY id').all()).results,
          sent: (await db.prepare('SELECT id FROM test_sent ORDER BY rowid').all()).results,
        } }
      },
    }),
  ]
}
