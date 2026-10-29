import type { AgentEvent, Principal, Runtime } from './types.ts'
import { authenticate } from './credentials.ts'
import { decide } from './policy/decide.ts'
import { eventVisible } from './events.ts'
import { livePrincipal } from './execution.ts'
import { policyRefusal, policyState } from './policy-store.ts'
import { templateMatches } from './registry.ts'
import { answered } from './policy/document.ts'
import { rpcError, type Rpc } from './wire.ts'
import { offers } from './capabilities.mjs'

export const subscriptionLifetimeMs = 120000
export async function subscriptions(rt: Runtime, request: Request, rpc: Rpc, principal: Principal): Promise<Response> {
  const requested = rpc.params?.notifications as { toolsListChanged?: unknown; resourceSubscriptions?: unknown } | undefined
  if (Array.isArray(requested?.resourceSubscriptions) && requested.resourceSubscriptions.length && !offers(rt.options.capabilities, 'resources')) return rpcError(rpc.id, -32000, 'Capability not declared', 200, { code: 'capability_not_declared', capability: 'resources' })
  const uris: string[] = []
  for (const uri of Array.isArray(requested?.resourceSubscriptions) ? requested.resourceSubscriptions : []) {
    if (typeof uri !== 'string' || uris.includes(uri)) continue
    const resource = rt.options.resources?.find(resource => templateMatches(resource.uriTemplate, uri))
    if (resource && (!resource.scope || principal.scopes.includes(resource.scope))) {
      try { if (await resource.read(uri, { ...principal, db: rt.options.db })) uris.push(uri) } catch { /* Visibility refusals do not reveal existence. */ }
    }
  }
  const filter = { ...(requested?.toolsListChanged === true ? { toolsListChanged: true } : {}), ...(uris.length ? { resourceSubscriptions: uris } : {}) }
  const meta = { 'io.modelcontextprotocol/subscriptionId': rpc.id }
  const position = (await rt.options.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM agent_door_events').first<{ seq: number }>())!.seq
  const listed = async () => {
    const state = await policyState(rt)
    return rt.tools.filter(tool => tool.classes.every(cls => answered(state.document, cls))).map(tool => tool.name).join(',')
  }
  let cursor = position, lastTools = await listed(), stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  const started = rt.now(), encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      const notify = (method: string, params: object) => send({ jsonrpc: '2.0', method, params: { ...params, _meta: meta } })
      const close = () => {
        if (stopped) return
        stopped = true
        if (timer) clearTimeout(timer)
        try { send({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', _meta: meta } }); controller.close() } catch { /* Consumer closed its stream. */ }
      }
      request.signal.addEventListener('abort', close, { once: true })
      notify('notifications/subscriptions/acknowledged', { notifications: filter })
      const tick = async () => {
        if (stopped) return
        try {
          const state = await policyState(rt), authenticated = await authenticate(rt.options, request, state.business)
          const person = authenticated && await livePrincipal(rt, authenticated)
          if (!person || policyRefusal(rt, state, ['standard']) || rt.now() - started >= subscriptionLifetimeMs) return close()
          const decision = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: person.agent.specialist ?? null, agent: person.agent.id, classes: [{ class: 'standard', facts: { measure: 1 } }] }, usageToday: () => 0 })
          if (decision.result === 'blocked' || decision.result === 'approval') return close()
          const rows = (await rt.options.db.prepare('SELECT sequence,event FROM agent_door_events WHERE sequence>? ORDER BY sequence LIMIT 200').bind(cursor).all<{ sequence: number; event: string }>()).results
          for (const row of rows) {
            cursor = row.sequence
            const event: AgentEvent = JSON.parse(row.event)
            if (uris.includes(event.uri) && await person.scopes.includes('events:read') && await eventVisible(rt, person, event)) notify('notifications/resources/updated', { uri: event.uri })
          }
          if (filter.toolsListChanged) {
            const next = await listed()
            if (next !== lastTools) { lastTools = next; notify('notifications/tools/list_changed', {}) }
          }
          if (!stopped) timer = setTimeout(() => { void tick() }, 1000)
        } catch { close() }
      }
      timer = setTimeout(() => { void tick() }, 1000)
    },
    cancel() { stopped = true; if (timer) clearTimeout(timer) },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}
