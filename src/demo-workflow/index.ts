import { createConnection, listConnections } from '../crank/connections/store'
import { startOfDay } from '../crank/engine/dates'
import { validateGraph } from '../crank/engine/graph'
import { canonical, digest, type Actor, type CrankEnv } from '../crank/model'
import { createHook, listHooks } from '../crank/triggers/webhook'
import { demoGraph, type DemoConnections } from './graph'
import { earlierStatements, STORIES, storyStatements, V2_PUBLISHED_AGO } from './runs'

const WORKFLOW = 'demo-workflow-stripe-books'
/** Runs today, matching the homepage counter: the eight told runs and the day's earlier ones. */
const RUNS_TODAY = 1284

/** The connections the workflow uses, created through the same door as the Connections API (secrets sealed, never shown). */
async function connections(env: CrankEnv, actor: Actor): Promise<DemoConnections> {
  const wanted = [
    ['stripe', { app: 'webhook', label: 'Stripe signing secret', auth_kind: 'signing_secret', secret: { secret: 'example-stripe-signing-secret' } }],
    ['google', { app: 'google', label: 'Google Sheets', auth_kind: 'oauth2', account_name: 'maya@bluelake.example', scopes: ['https://www.googleapis.com/auth/spreadsheets'], secret: { access_token: 'example-google-access-token' } }],
    ['slack', { app: 'slack', label: 'Slack', auth_kind: 'bearer', account_name: 'Blue Lake Supply', secret: { token: 'example-slack-bot-token' } }],
    ['quickbooks', { app: 'http', label: 'QuickBooks Online', auth_kind: 'bearer', account_name: 'Blue Lake Supply', domains: ['quickbooks.api.intuit.com'], secret: { token: 'example-quickbooks-token' } }],
  ] as const
  const existing = await listConnections(env), out: Record<string, string> = {}
  for (const [key, input] of wanted) out[key] = existing.find(c => c.label === input.label)?.id ?? (await createConnection(env, actor, { ...input } as Record<string, unknown>)).id
  return out as unknown as DemoConnections
}

async function version(env: CrankEnv, id: string, number: number, graph: unknown, owner: string, at: string, retired: string | null) {
  const { declared } = validateGraph(graph), graphJson = canonical(graph), trigger = (graph as { trigger: { type: string } }).trigger.type
  return env.DB.prepare('INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(id, WORKFLOW, number, graphJson, await digest(graphJson), JSON.stringify({ publisher: owner, published_at: at, steps: declared.steps, connections: declared.connections, trigger }), owner, at, retired)
}

/** Seeds "Stripe paid to books" once: its connections, two published versions and today's runs. */
export async function seedWorkflowDemo(env: CrankEnv, actor: Actor, now: Date) {
  if (await env.DB.prepare('SELECT 1 FROM crank_workflows WHERE id=?').bind(WORKFLOW).first()) return
  const c = await connections(env, actor), time = now.getTime(), at = (minutes: number) => new Date(time - minutes * 60000).toISOString()
  const v1 = demoGraph(c, 'amount'), v2 = demoGraph(c, 'amount_total'), ids = { workflow: WORKFLOW, v1: `${WORKFLOW}-v1`, v2: `${WORKFLOW}-v2`, owner: actor.id }
  const v1At = new Date(time - 9 * 86400000).toISOString(), v2At = at(V2_PUBLISHED_AGO)
  // The connections were made when the workflow was built, the day before version 1 went live.
  const connected = new Date(time - 10 * 86400000).toISOString()
  // The day's earlier payments, from the start of today in the workflow's timezone until shortly before the told runs.
  const end = time - (STORIES.at(-1)!.ago + 4) * 60000, dayStart = startOfDay(time, v2.settings.timezone)
  const start = end - dayStart > 3600000 ? dayStart + Math.min(6 * 3600000, (end - dayStart) / 3) : end - 12 * 3600000
  await env.DB.batch([
    env.DB.prepare(`UPDATE crank_connections SET created_at=?1,consented_at=?1 WHERE id IN (?2,?3,?4,?5)`).bind(connected, c.stripe, c.google, c.slack, c.quickbooks),
    env.DB.prepare(`INSERT INTO crank_workflows(id,name,description,folder,owner_id,draft_json,draft_updated_at,status,published_version_id,settings_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,'published',?,'{}',?,?) ON CONFLICT DO NOTHING`)
      .bind(WORKFLOW, 'Stripe paid to books', 'When a Stripe payment succeeds, log it, notify the team, and create a QuickBooks invoice.', 'Finance', actor.id, JSON.stringify(v2), v2At, ids.v2, actor.id, v1At),
    await version(env, ids.v1, 1, v1, actor.id, v1At, v2At),
    await version(env, ids.v2, 2, v2, actor.id, v2At, null),
    env.DB.prepare("INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) VALUES(?,?,?,'workflow.publish','workflow',?,?,'{}'),(?,?,?,'workflow.publish','workflow',?,?,'{}') ON CONFLICT DO NOTHING")
      .bind(`${WORKFLOW}-audit-v1`, v1At, actor.id, WORKFLOW, ids.v1, `${WORKFLOW}-audit-v2`, v2At, actor.id, WORKFLOW, ids.v2),
    ...earlierStatements(env, ids, RUNS_TODAY - STORIES.length, start, end),
    ...await storyStatements(env, ids, time, { 1: v1, 2: v2 }),
  ])
  if (!(await listHooks(env, WORKFLOW)).length) await createHook(env, actor, WORKFLOW)
}
