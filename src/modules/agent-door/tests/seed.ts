import { createAgentDoor, defineTool, operatorAuthPeople, ToolRefusal } from '../index.ts'
import type { ToolDefinition } from '../index.ts'
import { createBusinessSettings } from '../../business-settings/index.ts'
import { createOperatorAuth, createAuthHandler } from '../../operator-auth/index.mjs'

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false })
const text = { type: 'string', minLength: 1 }, idInput = object({ id: text })
const output = object({ id: text, value: text, version: { type: 'integer' } })
let time: number | null = null
let allowList: string[] | undefined
interface Env { DB: D1Database; CONFIG: string; TRUST: string; BUSINESS_TRUST: string }
export default {
  async fetch(incoming: Request, env: Env): Promise<Response> {
    const dispatch = await incoming.json() as { url: string; method: string; headers: HeadersInit; body?: string }
    const request = new Request(dispatch.url, { method: dispatch.method, headers: dispatch.headers, body: dispatch.body })
    const now = () => time ?? Date.now(), config = JSON.parse(env.CONFIG)
    if (new URL(request.url).pathname === '/__allowlist') { allowList = (await request.json() as { emails?: string[] }).emails; return Response.json({ ok: true }) }
    config.allowList = allowList
    const auth = createOperatorAuth({ db: env.DB, config, clock: now, clientIp: request => request.headers.get('CF-Connecting-IP') ?? '', mailSender: { async send(message) { await env.DB.prepare('INSERT INTO test_mail(email,body) VALUES(?,?)').bind(message.to[0],message.text).run(); return {status:'accepted',provider:'synthetic-base-1',providerMessageId:null} } } })
    const settings = createBusinessSettings({ db: env.DB, trust: env.BUSINESS_TRUST, business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } }, team: auth.businessTeam })
    const path = new URL(request.url).pathname
    if (path === '/__clock') { time = (await request.json() as { now: number }).now; return Response.json({ ok: true }) }
    const read = (id: string) => env.DB.prepare('SELECT id,value,version,exposure FROM test_records WHERE id=?').bind(id).first<{ id: string; value: string; version: number; exposure: string }>()
    const tools: ToolDefinition[] = [
      defineTool({ name: 'synthetic.records.list', title: 'Read records', description: 'Read native records.', scope: 'records:read', readOnly: true, inputSchema: object({}), outputSchema: object({ records: { type: 'array', items: { type: 'object' } }, sent: { type: 'array', items: { type: 'object' } } }), classes: ['standard'], clauses: ['BASE-AGENT-002'], classify: () => [{ class: 'standard', facts: { measure: 1 } }],
        async run() { return { result: { records: (await env.DB.prepare('SELECT * FROM test_records ORDER BY id').all()).results, sent: (await env.DB.prepare('SELECT * FROM test_sent ORDER BY rowid').all()).results } } } }),
      defineTool({ name: 'synthetic.records.write', title: 'Write record', description: 'Save native internal work.', scope: 'records:write', readOnly: false, summary: args => ({ target: { id: String(args.id) } }), inputSchema: object({ id: text, value: text }), outputSchema: output, classes: ['standard'], clauses: ['BASE-AGENT-002'], classify: () => [{ class: 'standard', facts: { measure: 1 } }],
        revision: async args => (await read(args.id as string))?.version ?? null,
        async run(args, ctx) {
          if (args.value === 'synthetic-base-refused') throw new ToolRefusal('native_refused')
          await env.DB.prepare('INSERT INTO test_contexts(kind,person,agent,actor,approvers,audit) VALUES(?,?,?,?,?,?)').bind('run',ctx.person.id,ctx.agent.id,JSON.stringify(ctx.actor),JSON.stringify(ctx.approvers),JSON.stringify((await env.DB.prepare("SELECT row FROM agent_door_audit WHERE json_extract(row,'$.outcome')='running' ORDER BY sequence DESC LIMIT 1").first()) ?? null)).run()
          const before = await read(args.id as string)
          await env.DB.prepare("INSERT INTO test_records(id,value,version,exposure) VALUES(?,?,1,'internal') ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=version+1").bind(args.id, args.value).run()
          const row = (await read(args.id as string))!; ctx.emit('record.saved', `synthetic://record/${row.id}`)
          return { result: args.value === 'synthetic-base-invalid' ? { invalid: true } : { id: row.id, value: row.value, version: row.version }, undo: before ?? { id: row.id }, resources: [{ uri: `synthetic://record/${row.id}`, name: row.id }] }
        },
        async undo(saved, ctx) { await env.DB.prepare('INSERT INTO test_contexts(kind,person,agent,actor,approvers) VALUES(?,?,?,?,?)').bind('undo',ctx.person.id,ctx.agent,JSON.stringify(ctx.actor),'[]').run(); const row = saved as { id: string; value?: string; version?: number }; if (row.value) await env.DB.prepare('UPDATE test_records SET value=?,version=? WHERE id=?').bind(row.value, row.version, row.id).run(); else await env.DB.prepare('DELETE FROM test_records WHERE id=?').bind(row.id).run(); ctx.emit('record.undone', `synthetic://record/${row.id}`) } }),
      defineTool({ name: 'synthetic.records.erase', title: 'Erase record', description: 'Delete native work.', scope: 'records:write', readOnly: false, summary: args => ({ target: { id: String(args.id) } }), inputSchema: idInput, outputSchema: idInput, classes: ['destructive'], clauses: ['BASE-AGENT-006'],
        classify: async args => [{ class: 'destructive', facts: { measure: await read(args.id as string) ? 1 : 0 } }],
        async run(args, ctx) { await env.DB.prepare('DELETE FROM test_records WHERE id=?').bind(args.id).run(); ctx.emit('record.erased', `synthetic://record/${args.id}`); return { result: { id: args.id } } } }),
      defineTool({ name: 'synthetic.records.send', title: 'Send record', description: 'External exposure is stored on the native record.', scope: 'records:write', readOnly: false, summary: args => ({ target: { id: String(args.id) } }), inputSchema: idInput, outputSchema: idInput, classes: ['external', 'sensitive'], clauses: ['BASE-AGENT-006'],
        classify: async args => [{ class: 'external', facts: { measure: 1, counterparty: (await read(args.id as string))?.exposure === 'known' ? 'known' : 'new' } }, { class: 'sensitive', facts: { measure: 1, kind: 'tax' } }],
        async run(args, ctx) { await env.DB.prepare('INSERT INTO test_sent(id) VALUES(?)').bind(args.id).run(); ctx.emit('record.sent', `synthetic://record/${args.id}`); return { result: { id: args.id } } } }),
      defineTool({ name: 'synthetic.access.change', title: 'Change authority', description: 'Change authority of a named person.', scope: 'records:write', readOnly: false, summary: args => ({ target: { id: String(args.id) }, role: String(args.role ?? 'admin') }), inputSchema: object({ id: text, role: {type:'string',enum:['admin','member']} }, ['id']), outputSchema: idInput, classes: ['access'], clauses: ['BASE-AGENT-006'], authority: async args => ({ subject: args.id as string, widens: args.role !== 'member' }), classify: (args,ctx) => { if (args.role !== 'member' && String(args.id).toLowerCase() === ctx.person.email.toLowerCase()) throw new ToolRefusal('classifier_refused'); return [{ class: 'access', facts: { measure: 1, direction: args.role === 'member' ? 'narrows' : 'widens' } }] }, async run(args) { await env.DB.prepare("UPDATE oa_operators SET role=? WHERE id=? AND role<>'owner'").bind(args.role ?? 'admin',args.id).run(); return { result: { id: args.id } } } }),
    ]
    const door = createAgentDoor({ seed: 'synthetic', name: 'Synthetic Base', specialist: 'operations', origin: config.origin, db: env.DB, trust: JSON.parse(env.TRUST), now,
      tools, limits: config.limits, people: operatorAuthPeople({ db: env.DB, allowList, session: request => auth.getSession(request) }),
      localCredentials: async request => request.headers.get('authorization') === 'Bearer synthetic-base-local' ? { sponsor: { id: (await env.DB.prepare('SELECT claim_id FROM oa_bootstrap WHERE singleton=1').first<{claim_id:string}>())!.claim_id }, agent: { id: 'synthetic-base-local', name: 'Synthetic Local' }, scopes: ['records:read','records:write','events:read'] } : null,
      resources: [{ uriTemplate: 'synthetic://record/{id}', name: 'Record', scope: config.resourceScope, classes: ['sensitive'], classify: () => [{ class: 'sensitive', facts: { measure: 1, kind: 'tax' } }], read: async uri => { const row = await read(uri.split('/').pop()!); return row && row.exposure !== 'hidden' ? { json: row, untrusted: true } : null } }],
      onEvent: async event => { await env.DB.prepare('INSERT INTO test_callbacks(id,event) VALUES(?,?)').bind(event.id, JSON.stringify(event)).run() },
    })
    if (path === '/__embedded') return Response.json(await door.invoke('synthetic.records.list', {}, { person: (await doorPerson(auth, request))!, agent: { id: 'synthetic-base-embedded', name: 'Synthetic Embedded' } }))
    if (path === '/__emit') { const person = await doorPerson(auth, request); if (!person) return new Response(null, { status: 401 }); await door.emit({ type: 'record.person', uri: 'synthetic://record/synthetic-base-1', person }); return Response.json({ ok: true }) }
    return await door.handle(request) ?? await settings.handle(request) ?? await createAuthHandler(auth)(request) ?? new Response(null, { status: 404 })
  },
}
async function doorPerson(auth: ReturnType<typeof createOperatorAuth>, request: Request) { const session = await auth.getSession(request); return session ? { id: session.operator.id, email: session.operator.email, name: session.operator.displayName, role: session.operator.role, active: true } : null }
